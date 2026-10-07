// public/js/indexing/litigation-indexing-write.js
// IPGate Dava Yönetimi - V2 Konsolide İndeksleme
// DB-driven dava indeksleme + stage/decision yönetimi.
// Ek:
// - İlk Derece -> İstinaf -> Yargıtay stage zinciri DB kurallarıyla yönetilir.
// - 59/60 parent transaction'ları aynı suits.id altında parent_id ile bağlanır.
// - Evraktan otomatik yargılama aşaması tahmini YOK.
// - suits.status indeksleme ekranında değiştirilmez.
//
// Dava kayıtları için AYRI write branch.
// Mevcut Marka / Patent / Tasarım handleSave() akışı değiştirilmez.
//
// BU AŞAMADA:
// ✅ suits.id altında child transaction oluşturulur.
// ✅ Gelen PDF transaction_documents'a bağlanır.
// ✅ incoming_documents dava kimliği + transaction ile eşleştirilir.
// ✅ incoming_documents.status = 'litigation_indexed' yapılır.
//
// BİLEREK KAPALI:
// ❌ Task tetikleme
// ❌ Son tarih üretme
// ✅ Dava status güncelleme yalnız kullanıcının açık seçimiyle yapılır
// ❌ Mail bildirimi
//
// 'litigation_indexed' statüsü geçicidir. Mevcut handle-indexed-document
// Edge Function sadece status === 'indexed' olduğunda mail motorunu çalıştırdığı
// için bu aşamada dava evrakı güvenli şekilde mail dışı tutulur.

import './smart-record-search.js';
import { DocumentReviewManager } from './document-review-manager.js';
import { supabase } from '../../supabase-config.js';
import {
    showNotification,
    formatToTRDate,
    STATUSES
} from '../../utils.js';

const proto = DocumentReviewManager.prototype;

// Gelen evraklar.
// 61-65 kullanıcı/vekil tarafından hazırlanacak işlerdir; bu dosya indeksleme
// ekranında özellikle gösterilmez.
const FIRST_INSTANCE_PARENT_TYPES = Object.freeze([
    '49',
    '54',
    '55',
    '56',
    '57',
    '58'
]);

const JUDICIAL_STAGE_TYPES = Object.freeze({
    appeal: '59',
    cassation: '60'
});

const JUDICIAL_STAGE_LABELS = Object.freeze({
    first_instance: 'İlk Derece',
    appeal: 'İstinaf',
    cassation: 'Yargıtay'
});

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function toIsoDate(raw) {
    if (!raw) return null;

    // flatpickr/native input çoğunlukla yyyy-mm-dd üretir.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
        return new Date(`${raw}T12:00:00`).toISOString();
    }

    const parts = String(raw).split(/[./]/);
    if (parts.length === 3 && parts[2]?.length === 4) {
        const [d, m, y] = parts;
        return new Date(
            `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00`
        ).toISOString();
    }

    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

function typeName(manager, typeId) {
    const obj = (manager.allTransactionTypes || []).find(
        (item) => String(item.id) === String(typeId)
    );

    return obj?.alias || obj?.name || `İşlem ${typeId}`;
}

function typeObject(manager, typeId) {
    return (manager.allTransactionTypes || []).find(
        (item) => String(item.id) === String(typeId)
    ) || null;
}

function isSuitTypeObject(obj) {
    if (!obj) return false;
    const ipType = String(obj.ip_type || obj.ipType || '').toLowerCase().trim();

    // Eski kayıt yapısında ip_type boş gelirse ID whitelist zaten ikinci güvenliktir.
    return !ipType || ipType === 'suit';
}

function isParentTransaction(tx) {
    return String(
        tx?.transaction_hierarchy ||
        'parent'
    ).toLowerCase() === 'parent';
}

function judicialStageKeyFromType(typeId) {
    const raw = String(typeId || '');

    if (raw === JUDICIAL_STAGE_TYPES.cassation) {
        return 'cassation';
    }

    if (raw === JUDICIAL_STAGE_TYPES.appeal) {
        return 'appeal';
    }

    if (FIRST_INSTANCE_PARENT_TYPES.includes(raw)) {
        return 'first_instance';
    }

    return null;
}

function judicialStageRank(typeId) {
    const key = judicialStageKeyFromType(typeId);

    if (key === 'cassation') return 3;
    if (key === 'appeal') return 2;
    if (key === 'first_instance') return 1;

    return 0;
}

function judicialStageLabelFromType(typeId) {
    const key = judicialStageKeyFromType(typeId);

    return key
        ? JUDICIAL_STAGE_LABELS[key]
        : 'Bilinmeyen Aşama';
}

function supportedStageParents(transactions) {
    return (transactions || [])
        .filter(
            (tx) =>
                isParentTransaction(tx) &&
                judicialStageRank(
                    tx.transaction_type_id
                ) > 0
        );
}

function findHighestJudicialStageParent(transactions) {
    const parents =
        supportedStageParents(
            transactions
        );

    if (parents.length === 0) {
        return null;
    }

    return [...parents]
        .sort(
            (a, b) => {
                const rankDiff =
                    judicialStageRank(
                        b.transaction_type_id
                    ) -
                    judicialStageRank(
                        a.transaction_type_id
                    );

                if (rankDiff !== 0) {
                    return rankDiff;
                }

                const da =
                    new Date(
                        a.transaction_date ||
                        a.created_at ||
                        0
                    ).getTime();

                const db =
                    new Date(
                        b.transaction_date ||
                        b.created_at ||
                        0
                    ).getTime();

                return db - da;
            }
        )[0];
}

function findDirectStageChild(
    transactions,
    parentId,
    stageTypeId
) {
    return (transactions || [])
        .find(
            (tx) =>
                isParentTransaction(tx) &&
                String(tx.parent_id || '') ===
                    String(parentId || '') &&
                String(tx.transaction_type_id || '') ===
                    String(stageTypeId || '')
        ) || null;
}

function litigationStatusOptions() {
    return Array.isArray(STATUSES?.litigation)
        ? STATUSES.litigation
        : [];
}

function litigationStatusLabel(value) {
    const raw = String(value || '').trim();

    if (!raw) {
        return 'Belirtilmemiş';
    }

    const found = litigationStatusOptions()
        .find(
            (item) =>
                String(item.value) === raw
        );

    return found?.text || raw;
}

function isValidLitigationStatus(value) {
    const raw = String(value || '').trim();

    if (!raw) {
        return true;
    }

    return litigationStatusOptions()
        .some(
            (item) =>
                String(item.value) === raw
        );
}


function parseJsonObject(raw) {
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw;

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed
                : {};
        } catch {
            return {};
        }
    }

    return {};
}

function normalizeStringArray(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.map(String).filter(Boolean);
            }
        } catch {
            return raw
                .replace(/[{}]/g, '')
                .split(',')
                .map((item) => item.replace(/^"+|"+$/g, '').trim())
                .filter(Boolean);
        }
    }

    return [];
}

function suitEventKind(typeObj) {
    return String(
        typeObj?.suit_event_kind ||
        typeObj?.suitEventKind ||
        ''
    ).toLowerCase().trim();
}

function suitStageScopes(typeObj) {
    return normalizeStringArray(
        typeObj?.suit_stage_scope ??
        typeObj?.suitStageScope
    );
}

function stageTransitionOnIndex(typeObj) {
    const value = String(
        typeObj?.stage_transition_on_index ||
        typeObj?.stageTransitionOnIndex ||
        ''
    ).toLowerCase().trim();

    return ['appeal', 'cassation'].includes(value)
        ? value
        : null;
}

function stageLabel(stageKey) {
    return JUDICIAL_STAGE_LABELS[stageKey] || 'Bilinmeyen Aşama';
}

function transitionPreviousStage(targetStage) {
    if (targetStage === 'appeal') return 'first_instance';
    if (targetStage === 'cassation') return 'appeal';
    return null;
}

function transitionTargetType(targetStage) {
    return JUDICIAL_STAGE_TYPES[targetStage] || null;
}

function mergeInitiator(currentValue, nextValue) {
    const current = String(currentValue || '').toLowerCase().trim();
    const next = String(nextValue || '').toLowerCase().trim();

    if (!current || current === 'unknown') return next || 'unknown';
    if (!next || next === 'unknown') return current;
    if (current === next) return current;

    if (
        ['client', 'opponent', 'both'].includes(current) &&
        ['client', 'opponent', 'both'].includes(next)
    ) {
        return 'both';
    }

    return current;
}

function initiatorLabel(value) {
    const normalized = String(value || '').toLowerCase().trim();

    if (normalized === 'client') return 'Müvekkil';
    if (normalized === 'opponent') return 'Karşı Taraf';
    if (normalized === 'both') return 'Her İki Taraf';
    return 'Belirtilmemiş';
}

function decisionResultLabel(value) {
    return ({
        accept: 'Kabul',
        partial_accept: 'Kısmen Kabul',
        reject: 'Ret'
    })[value] || value || '-';
}

function clientOutcomeLabel(value) {
    return ({
        favorable: 'Lehe',
        partially_favorable: 'Kısmen Lehe / Kısmen Aleyhe',
        unfavorable: 'Aleyhe'
    })[value] || value || '-';
}

function normRole(value) {
    return String(value || '')
        .toLocaleLowerCase('tr-TR')
        .trim();
}

function mapFirstInstanceClientOutcome(role, result) {
    const normalizedRole = normRole(role);
    const normalizedResult = String(result || '');

    if (normalizedResult === 'partial_accept') {
        return 'partially_favorable';
    }

    if (normalizedRole === 'davaci') {
        if (normalizedResult === 'accept') return 'favorable';
        if (normalizedResult === 'reject') return 'unfavorable';
    }

    if (normalizedRole === 'davali') {
        if (normalizedResult === 'accept') return 'unfavorable';
        if (normalizedResult === 'reject') return 'favorable';
    }

    return null;
}

function canUseIncomingType(manager, typeObj, parentTx, rows) {
    if (!typeObj || !parentTx || !isSuitTypeObject(typeObj)) {
        return false;
    }

    const hierarchy = String(typeObj.hierarchy || '')
        .toLowerCase()
        .trim();

    if (hierarchy && hierarchy !== 'child') {
        return false;
    }

    const kind = suitEventKind(typeObj);
    if (!['incoming', 'decision'].includes(kind)) {
        return false;
    }

    const currentStage =
        judicialStageKeyFromType(parentTx.transaction_type_id);

    if (!currentStage) {
        return false;
    }

    const scopes = suitStageScopes(typeObj);
    const transition = stageTransitionOnIndex(typeObj);

    if (!transition) {
        return scopes.includes(currentStage);
    }

    if (currentStage === transition) {
        return scopes.includes(currentStage);
    }

    const previousStage =
        transitionPreviousStage(transition);

    if (currentStage !== previousStage) {
        return false;
    }

    return !findDirectStageChild(
        rows,
        parentTx.id,
        transitionTargetType(transition)
    );
}

function removeElement(id) {
    document.getElementById(id)?.remove();
}

function ensureWriteStyles() {
    if (document.getElementById('litigationStage4WriteStyles')) return;

    const style = document.createElement('style');
    style.id = 'litigationStage4WriteStyles';
    style.textContent = `
        #litigationWriteNotice {
            border: 1px solid #b7dfc4;
            background: #eefbf2;
            color: #235c36;
            border-radius: 10px;
        }

        #litigationParentHelp {
            font-size: .75rem;
            color: #6b7280;
            margin-top: 7px;
            padding: 8px 10px;
            border-radius: 8px;
            border: 1px solid #e5e7eb;
            background: #f8fafc;
        }

        .litigation-write-badge {
            display: inline-flex;
            align-items: center;
            padding: 4px 8px;
            border-radius: 999px;
            background: #ecfdf3;
            border: 1px solid #a7e0b8;
            color: #176b35;
            font-size: .72rem;
            font-weight: 800;
            white-space: nowrap;
        }

        .litigation-stage4-note {
            font-size: .74rem;
            color: #856404;
            background: #fff8e1;
            border: 1px solid #ffe39a;
            padding: 7px 9px;
            border-radius: 8px;
            margin-top: 8px;
        }

        #litigationStageControl {
            border: 1px solid #d8dee9;
            background: #f8fafc;
            border-radius: 10px;
            padding: 12px 14px;
        }

        #litigationStageControl .litigation-stage-current {
            font-size: .75rem;
            color: #475467;
            margin-top: 6px;
        }

        #litigationStageControl .litigation-stage-warning {
            font-size: .72rem;
            color: #7c5d12;
            background: #fff8e1;
            border: 1px solid #f2dc8d;
            border-radius: 7px;
            padding: 7px 9px;
            margin-top: 8px;
        }


        #litigationDecisionControl {
            border: 1px solid #d8dee9;
            background: #fffdf7;
            border-radius: 10px;
            padding: 12px 14px;
            margin-bottom: 1rem;
        }

        #litigationDecisionControl .lit-decision-result {
            margin-top: 7px;
            font-size: .75rem;
            color: #475467;
        }

        #litigationDecisionControl .lit-decision-warning {
            margin-top: 8px;
            padding: 7px 9px;
            border: 1px solid #f2dc8d;
            border-radius: 7px;
            background: #fff8e1;
            color: #7c5d12;
            font-size: .72rem;
        }

        #litigationStageControl .litigation-stage-transition-note {
            margin-top: 8px;
            padding: 7px 9px;
            border: 1px solid #bfdbfe;
            border-radius: 7px;
            background: #eff6ff;
            color: #1e40af;
            font-size: .72rem;
        }

        #litigationStatusControl {
            border: 1px solid #d8dee9;
            background: #f8fafc;
            border-radius: 10px;
            padding: 12px 14px;
        }

        #litigationStatusControl .litigation-status-current {
            font-size: .75rem;
            color: #667085;
            margin-top: 6px;
        }

        #litigationStatusControl .litigation-status-warning {
            font-size: .72rem;
            color: #7c5d12;
            background: #fff8e1;
            border: 1px solid #f2dc8d;
            border-radius: 7px;
            padding: 7px 9px;
            margin-top: 8px;
        }
    `;
    document.head.appendChild(style);
}

if (!proto.__litigationIndexingStage4Patched) {
    Object.defineProperty(proto, '__litigationIndexingStage4Patched', {
        value: true,
        writable: false,
        configurable: false,
        enumerable: false
    });

    // Bu noktada smart-record-search.js prototype'u zaten patch etmiş durumdadır.
    const smartSelectSuit = proto.selectSuitReadOnly;
    const smartRenderHeader = proto.renderHeader;
    const smartHandleSave = proto.handleSave;
    const normalUpdateChildOptions = proto.updateChildTransactionOptions;
    const normalUpdateDeadline = proto.updateCalculatedDeadline;

    proto._refreshLitigationStageControl =
        function() {
            const wrapper =
                document.getElementById('litigationStageControl');

            const parentSelect =
                document.getElementById('parentTransactionSelect');

            if (!wrapper || !parentSelect) {
                return;
            }

            const parentTx =
                (this.currentTransactions || [])
                    .find(
                        (tx) =>
                            String(tx.id) ===
                            String(parentSelect.value || '')
                    ) ||
                null;

            const highest =
                findHighestJudicialStageParent(
                    this.currentTransactions
                );

            const highestKey =
                highest
                    ? judicialStageKeyFromType(
                        highest.transaction_type_id
                    )
                    : null;

            const selectedKey =
                parentTx
                    ? judicialStageKeyFromType(
                        parentTx.transaction_type_id
                    )
                    : null;

            const initiator =
                parentTx?.suit_context?.stage_initiator ||
                null;

            wrapper.innerHTML = `
                <label class="custom-label">
                    <i class="fas fa-sitemap mr-1"></i>
                    Yargılama Aşaması
                </label>

                <div class="litigation-stage-current">
                    <strong>Dosyanın en üst aşaması:</strong>
                    ${esc(stageLabel(highestKey))}
                    ${
                        selectedKey
                            ? ` · <strong>Seçili parent:</strong> ${esc(stageLabel(selectedKey))}`
                            : ''
                    }
                    ${
                        initiator
                            ? ` · <strong>Başlatan:</strong> ${esc(initiatorLabel(initiator))}`
                            : ''
                    }
                </div>

                <div class="litigation-stage-transition-note">
                    <i class="fas fa-shield-alt mr-1"></i>
                    Aşama manuel olarak değiştirilmez. Karşı tarafın
                    İstinaf/Temyiz dilekçesi indekslenirse veya EVREKA'nın
                    kanun yolu işi tamamlanırsa yeni stage oluşturulur.
                </div>
            `;
        };

    proto._ensureLitigationStageControl =
        function() {
            const parentSelect =
                document.getElementById(
                    'parentTransactionSelect'
                );

            if (!parentSelect) {
                return;
            }

            let wrapper =
                document.getElementById(
                    'litigationStageControl'
                );

            if (!wrapper) {
                wrapper =
                    document.createElement(
                        'div'
                    );

                wrapper.id =
                    'litigationStageControl';

                wrapper.className =
                    'form-group mb-4';

                const anchor =
                    parentSelect.closest(
                        '.form-group'
                    );

                if (anchor) {
                    anchor.insertAdjacentElement(
                        'afterend',
                        wrapper
                    );
                }
            }

            this
                ._refreshLitigationStageControl();
        };

    proto._ensureLitigationStatusControl =
        function() {
            document
                .getElementById('litigationStatusControl')
                ?.remove();
        };

    proto._enableSuitIndexingWriteUi = function() {
        removeElement('litigationReadOnlyNotice');
        removeElement('litigationReadonlyParentSummary');

        const analysis = document.getElementById('analysisResults');

        if (analysis && !document.getElementById('litigationWriteNotice')) {
            const notice = document.createElement('div');
            notice.id = 'litigationWriteNotice';
            notice.className = 'alert mb-4';
            notice.innerHTML = `
                <i class="fas fa-gavel mr-2"></i>
                <strong>Dava evrak indeksleme aktif.</strong><br>
                <small>
                    Bu aşamada yalnız child transaction ve belge bağlantısı oluşturulur.
                    Görev, son tarih ve müvekkil maili henüz tetiklenmez.
                </small>
            `;
            analysis.insertBefore(notice, analysis.firstChild);
        }

        const date = document.getElementById('detectedDate');
        if (date) date.disabled = false;

        const parent = document.getElementById('parentTransactionSelect');
        if (parent) parent.disabled = false;

        const notes = document.getElementById('transactionNotes');
        if (notes) notes.disabled = false;

        const child = document.getElementById('detectedType');
        if (child) child.disabled = !parent?.value;

        const save = document.getElementById('saveTransactionBtn');
        if (save) {
            save.disabled = false;
            save.classList.remove('btn-secondary', 'btn-success');
            save.classList.add('btn-primary');
            save.innerHTML =
                '<i class="fas fa-gavel mr-2"></i>Dava Evrakını İndeksle';
        }

        const deadline = document.getElementById('calculatedDeadlineDisplay');
        if (deadline) {
            deadline.value = 'Görev / son tarih aşaması henüz kapalı';
        }

        this._ensureLitigationStageControl();
        this._ensureLitigationStatusControl();

        if (
            child &&
            !child.dataset.litigationDecisionBound
        ) {
            child.dataset.litigationDecisionBound = 'true';
            child.addEventListener(
                'change',
                () => {
                    this._renderLitigationDecisionControl();
                    this.updateCalculatedDeadline();
                }
            );
        }

        this._renderLitigationDecisionControl();

        const registry = document.getElementById('registry-editor-section');
        if (registry) registry.style.display = 'none';

        const opposition = document.getElementById('oppositionSection');
        if (opposition) opposition.style.display = 'none';

        const proof = document.getElementById('proofOfUseSection');
        if (proof) proof.style.display = 'none';
    };

    // Smart-search seçimi kullanılır; sonrasında readonly kilidi yalnız kontrollü
    // dava write UI alanları için açılır.
    proto.selectSuitReadOnly = async function(suit) {
        await smartSelectSuit.call(this, suit);

        if (this.matchedEntityType !== 'suit') return;

        this._enableSuitIndexingWriteUi();
        this.renderHeader();
    };

    // Dava seçildiğinde parent transaction'lar artık seçilebilir.
    proto.loadSuitParentTransactionsReadOnly = async function(suitId) {
        const parentSelect = document.getElementById('parentTransactionSelect');
        const childSelect = document.getElementById('detectedType');

        if (!parentSelect) return;

        removeElement('litigationReadonlyParentSummary');
        removeElement('litigationParentHelp');

        parentSelect.disabled = true;
        parentSelect.innerHTML = '<option value="">Dava ana işlemleri yükleniyor...</option>';

        if (childSelect) {
            childSelect.disabled = true;
            childSelect.innerHTML =
                '<option value="">-- Önce Ana İşlem Seçiniz --</option>';
        }

        try {
            const { data, error } = await supabase
                .from('transactions')
                .select(`
                    id,
                    ip_record_id,
                    transaction_type_id,
                    transaction_hierarchy,
                    parent_id,
                    description,
                    note,
                    transaction_date,
                    created_at,
                    task_id,
                    suit_context
                `)
                .eq('ip_record_id', String(suitId))
                .order('transaction_date', { ascending: false });

            if (error) throw error;

            this.currentTransactions =
                (data || []).map(
                    (tx) => ({
                        ...tx,
                        suit_context:
                            parseJsonObject(
                                tx.suit_context
                            )
                    })
                );

            const parents =
                supportedStageParents(
                    this.currentTransactions
                )
                    .sort(
                        (a, b) => {
                            const rankDiff =
                                judicialStageRank(
                                    b.transaction_type_id
                                ) -
                                judicialStageRank(
                                    a.transaction_type_id
                                );

                            if (rankDiff !== 0) {
                                return rankDiff;
                            }

                            const da =
                                new Date(
                                    a.transaction_date ||
                                    a.created_at ||
                                    0
                                );

                            const db =
                                new Date(
                                    b.transaction_date ||
                                    b.created_at ||
                                    0
                                );

                            return (
                                db.getTime() -
                                da.getTime()
                            );
                        }
                    );

            parentSelect.innerHTML =
                '<option value="">-- Dava Ana İşlemini Seçiniz --</option>';

            for (const tx of parents) {
                const typeId = String(tx.transaction_type_id);
                const dateText = formatToTRDate(
                    tx.transaction_date || tx.created_at
                );

                const option = document.createElement('option');
                option.value = String(tx.id);
                option.textContent =
                    `${judicialStageLabelFromType(typeId).toUpperCase()} · ${typeName(this, typeId)}${dateText ? ` (${dateText})` : ''}`;

                parentSelect.appendChild(option);
            }

            if (parents.length === 0) {
                const option = document.createElement('option');
                option.value = '';
                option.disabled = true;
                option.textContent =
                    '(Desteklenen dava ana işlemi bulunamadı)';
                parentSelect.appendChild(option);
                parentSelect.disabled = true;
            } else {
                parentSelect.disabled = false;
            }

            const help = document.createElement('div');
            help.id = 'litigationParentHelp';

            if (parents.length > 0) {
                help.innerHTML = `
                    <i class="fas fa-info-circle mr-1"></i>
                    Evrakı hangi dava aşamasına bağlayacağınızı seçin.
                    ${
                        parents.length > 1
                            ? 'Bu dosyada birden fazla ana işlem bulundu.'
                            : 'Bu dosyada tek desteklenen ana işlem bulundu.'
                    }
                `;
            } else {
                help.innerHTML = `
                    <i class="fas fa-exclamation-triangle mr-1"></i>
                    Bu dava için 49, 54–60 aralığında desteklenen bir parent transaction bulunamadı.
                    Önce dava ana işlemi oluşturulmalıdır.
                `;
            }

            parentSelect.insertAdjacentElement('afterend', help);

            // Dosyanın en üst yargılama aşamasını aktif parent olarak seç.
            // 60 > 59 > ilk derece. Böylece kullanıcı mevcut aşamayı doğrudan görür.
            const activeParent =
                findHighestJudicialStageParent(
                    this.currentTransactions
                );

            if (activeParent) {
                parentSelect.value =
                    String(activeParent.id);

                this
                    ._ensureLitigationStageControl();

                this
                    .updateChildTransactionOptions();
            } else {
                this
                    ._ensureLitigationStageControl();
            }

        } catch (error) {
            console.error('[LITIGATION AŞAMA 4] Parent transaction yükleme hatası:', error);
            parentSelect.innerHTML =
                '<option value="">Dava ana işlemleri yüklenemedi</option>';
            parentSelect.disabled = true;
        }
    };

    // Normal IP akışındaki index_file/allowed_child_types mekanizması korunur.
    // Dava için ise Stage 4 kontrollü whitelist kullanılır.
    proto.updateChildTransactionOptions = function() {
        if (this.matchedEntityType !== 'suit') {
            return normalUpdateChildOptions.call(this);
        }

        const parentSelect =
            document.getElementById('parentTransactionSelect');

        const childSelect =
            document.getElementById('detectedType');

        if (!parentSelect || !childSelect) {
            return;
        }

        const parentTx =
            (this.currentTransactions || [])
                .find(
                    (tx) =>
                        String(tx.id) ===
                        String(parentSelect.value || '')
                ) ||
            null;

        if (!parentTx) {
            childSelect.disabled = true;
            childSelect.innerHTML =
                '<option value="">-- Önce Ana İşlem Seçiniz --</option>';

            this._refreshLitigationStageControl();
            this._renderLitigationDecisionControl();
            return;
        }

        const stage =
            judicialStageKeyFromType(
                parentTx.transaction_type_id
            );

        const allowedTypes =
            (this.allTransactionTypes || [])
                .filter(
                    (typeObj) =>
                        canUseIncomingType(
                            this,
                            typeObj,
                            parentTx,
                            this.currentTransactions
                        )
                )
                .sort(
                    (a, b) =>
                        Number(a.order_index ?? 0) -
                            Number(b.order_index ?? 0) ||
                        String(a.alias || a.name || '')
                            .localeCompare(
                                String(b.alias || b.name || ''),
                                'tr'
                            )
                );

        childSelect.innerHTML =
            '<option value="">-- Gelen Evrak Türünü Seçiniz --</option>';

        for (const typeObj of allowedTypes) {
            const option =
                document.createElement('option');

            option.value =
                String(typeObj.id);

            const transition =
                stageTransitionOnIndex(typeObj);

            const suffix =
                transition &&
                transition !== stage
                    ? ` → ${stageLabel(transition)} aşamasını açar`
                    : '';

            option.textContent =
                `${typeObj.alias || typeObj.name || `İşlem ${typeObj.id}`}${suffix}`;

            childSelect.appendChild(option);
        }

        childSelect.disabled =
            allowedTypes.length === 0;

        this._refreshLitigationStageControl();
        this._renderLitigationDecisionControl();

        const deadline =
            document.getElementById(
                'calculatedDeadlineDisplay'
            );

        if (deadline) {
            deadline.value =
                `Yargılama aşaması: ${stageLabel(stage)}`;
        }
    };

    proto.updateCalculatedDeadline = function() {
        if (this.matchedEntityType !== 'suit') {
            return normalUpdateDeadline.call(this);
        }

        if (
            typeof this
                ._updateLitigationAutomationDeadlinePreview ===
                'function'
        ) {
            return this
                ._updateLitigationAutomationDeadlinePreview();
        }

        const deadline =
            document.getElementById(
                'calculatedDeadlineDisplay'
            );

        if (deadline) {
            deadline.value =
                'Bu evrak için otomatik task/deadline tanımlı değil';
        }
    };

    proto.renderHeader = function() {
        const result = smartRenderHeader.call(this);

        if (this.matchedEntityType !== 'suit') {
            removeElement(
                'litigationStageControl'
            );

            removeElement(
                'litigationStatusControl'
            );

            return result;
        }

        if (this.matchedEntityType === 'suit') {
            const badge = document.querySelector(
                '#matchInfoDisplay .litigation-readonly-badge'
            );

            if (badge) {
                badge.className = 'litigation-write-badge';
                badge.innerHTML =
                    '<i class="fas fa-link mr-1"></i>DAVA · İNDEKSLEME';

                const subject = this.matchedSuit?._subjectRecord || {};
                const subjectTitle =
                    subject.title ||
                    subject.brandText ||
                    '-';

                badge.title = `Dava konusu: ${subjectTitle}`;
            }
        }

        return result;
    };

    proto._renderLitigationDecisionControl =
        function() {
            let wrapper =
                document.getElementById(
                    'litigationDecisionControl'
                );

            const childSelect =
                document.getElementById('detectedType');

            if (!childSelect) {
                return;
            }

            const childTypeId =
                String(childSelect.value || '');

            const childType =
                typeObject(this, childTypeId);

            if (
                !childType ||
                suitEventKind(childType) !== 'decision'
            ) {
                wrapper?.remove();
                return;
            }

            if (!wrapper) {
                wrapper =
                    document.createElement('div');

                wrapper.id =
                    'litigationDecisionControl';

                const statusControl =
                    document.getElementById(
                        'litigationStatusControl'
                    );

                if (statusControl) {
                    statusControl.insertAdjacentElement(
                        'beforebegin',
                        wrapper
                    );
                } else {
                    childSelect
                        .closest('.form-group')
                        ?.insertAdjacentElement(
                            'afterend',
                            wrapper
                        );
                }
            }

            const config =
                parseJsonObject(
                    childType.suit_decision_config ??
                    childType.suitDecisionConfig
                );

            const parentTxId =
                document.getElementById(
                    'parentTransactionSelect'
                )?.value ||
                '';

            const parentTx =
                (this.currentTransactions || [])
                    .find(
                        (tx) =>
                            String(tx.id) ===
                            String(parentTxId)
                    ) ||
                null;

            const stage =
                parentTx
                    ? judicialStageKeyFromType(
                        parentTx.transaction_type_id
                    )
                    : null;

            const initiator =
                parentTx?.suit_context?.stage_initiator ||
                null;

            if (
                String(config.mode) ===
                'role_mapped_first_instance'
            ) {
                const role =
                    normRole(
                        this.matchedSuit?.client_role ||
                        this.matchedSuit?.clientRole
                    );

                const knownRole =
                    ['davaci', 'davali']
                        .includes(role);

                wrapper.innerHTML = `
                    <label class="custom-label">
                        <i class="fas fa-balance-scale mr-1"></i>
                        Karar Sonucu
                    </label>

                    <select
                        id="litigationDecisionResultSelect"
                        class="form-control shadow-sm"
                    >
                        <option value="">-- Karar Sonucunu Seçiniz --</option>
                        <option value="accept">Kabul</option>
                        <option value="partial_accept">Kısmen Kabul</option>
                        <option value="reject">Ret</option>
                    </select>

                    ${
                        knownRole
                            ? `
                                <div class="lit-decision-result">
                                    <strong>Müvekkil rolü:</strong>
                                    ${role === 'davaci' ? 'Davacı' : 'Davalı'}
                                    · <strong>Müvekkil açısından:</strong>
                                    <span id="litigationComputedClientOutcome">-</span>
                                </div>
                            `
                            : `
                                <div class="lit-decision-result">
                                    Müvekkil rolü çözülemedi. Sonucu ayrıca
                                    müvekkil açısından seçin:
                                </div>

                                <select
                                    id="litigationDecisionClientOutcomeFallbackSelect"
                                    class="form-control shadow-sm mt-2"
                                >
                                    <option value="">-- Müvekkil Açısından Sonuç --</option>
                                    <option value="favorable">Lehe</option>
                                    <option value="partially_favorable">Kısmen Lehe / Kısmen Aleyhe</option>
                                    <option value="unfavorable">Aleyhe</option>
                                </select>
                            `
                    }

                    <div class="lit-decision-warning">
                        Karar sonucu kullanıcı tarafından set edilir.
                        Sistem evrak metninden karar yönü tahmin etmez.
                    </div>
                `;

                const decisionSelect =
                    document.getElementById(
                        'litigationDecisionResultSelect'
                    );

                if (decisionSelect && knownRole) {
                    decisionSelect.onchange =
                        () => {
                            const outcome =
                                mapFirstInstanceClientOutcome(
                                    role,
                                    decisionSelect.value
                                );

                            const output =
                                document.getElementById(
                                    'litigationComputedClientOutcome'
                                );

                            if (output) {
                                output.textContent =
                                    clientOutcomeLabel(outcome);
                            }

                            this.updateCalculatedDeadline();
                        };
                }

                document
                    .getElementById(
                        'litigationDecisionClientOutcomeFallbackSelect'
                    )
                    ?.addEventListener(
                        'change',
                        () => this.updateCalculatedDeadline()
                    );

                return;
            }

            wrapper.innerHTML = `
                <label class="custom-label">
                    <i class="fas fa-balance-scale mr-1"></i>
                    Kararın Müvekkil Açısından Sonucu
                </label>

                <select
                    id="litigationClientOutcomeSelect"
                    class="form-control shadow-sm"
                >
                    <option value="">-- Sonucu Seçiniz --</option>
                    <option value="favorable">Lehe</option>
                    <option value="partially_favorable">Kısmen Lehe / Kısmen Aleyhe</option>
                    <option value="unfavorable">Aleyhe</option>
                </select>

                <div class="lit-decision-result">
                    <strong>Aşama:</strong>
                    ${esc(stageLabel(stage))}
                    · <strong>Aşamayı başlatan:</strong>
                    ${esc(initiatorLabel(initiator))}
                </div>

                <div class="lit-decision-warning">
                    Sonuç müvekkil açısından kullanıcı tarafından set edilir.
                    Sistem ilam metninden otomatik sonuç çıkarmaz.
                </div>
            `;

            document
                .getElementById(
                    'litigationClientOutcomeSelect'
                )
                ?.addEventListener(
                    'change',
                    () => this.updateCalculatedDeadline()
                );
        };

    proto._getLitigationDecisionContextFromUi =
        function(
            childTypeId,
            parentTx
        ) {
            const childType =
                typeObject(this, childTypeId);

            const stage =
                parentTx
                    ? judicialStageKeyFromType(
                        parentTx.transaction_type_id
                    )
                    : null;

            const base = {
                valid: true,
                stage,
                decisionResult: null,
                clientOutcome: null,
                stageInitiator:
                    parentTx
                        ?.suit_context
                        ?.stage_initiator ||
                    null
            };

            if (
                suitEventKind(childType) !==
                'decision'
            ) {
                return base;
            }

            const config =
                parseJsonObject(
                    childType?.suit_decision_config ??
                    childType?.suitDecisionConfig
                );

            if (
                String(config.mode) ===
                'role_mapped_first_instance'
            ) {
                const result =
                    document.getElementById(
                        'litigationDecisionResultSelect'
                    )?.value ||
                    '';

                if (!result) {
                    return {
                        ...base,
                        valid: false,
                        error:
                            'Karar sonucunu seçin.'
                    };
                }

                const role =
                    normRole(
                        this.matchedSuit?.client_role ||
                        this.matchedSuit?.clientRole
                    );

                let outcome =
                    mapFirstInstanceClientOutcome(
                        role,
                        result
                    );

                if (!outcome) {
                    outcome =
                        document.getElementById(
                            'litigationDecisionClientOutcomeFallbackSelect'
                        )?.value ||
                        '';
                }

                if (!outcome) {
                    return {
                        ...base,
                        valid: false,
                        error:
                            'Kararın müvekkil açısından sonucunu seçin.'
                    };
                }

                return {
                    ...base,
                    decisionResult:
                        result,
                    clientOutcome:
                        outcome
                };
            }

            const outcome =
                document.getElementById(
                    'litigationClientOutcomeSelect'
                )?.value ||
                '';

            if (!outcome) {
                return {
                    ...base,
                    valid: false,
                    error:
                        'Kararın müvekkil açısından sonucunu seçin.'
                };
            }

            return {
                ...base,
                clientOutcome:
                    outcome
            };
        };

    proto._rollbackLitigationTransaction = async function(transactionId) {
        if (!transactionId) return;

        try {
            await supabase
                .from('transaction_documents')
                .delete()
                .eq('transaction_id', String(transactionId));
        } catch (error) {
            console.warn(
                '[LITIGATION AŞAMA 4] Transaction document rollback uyarısı:',
                error
            );
        }

        try {
            await supabase
                .from('transactions')
                .delete()
                .eq('id', String(transactionId));
        } catch (error) {
            console.warn(
                '[LITIGATION AŞAMA 4] Transaction rollback uyarısı:',
                error
            );
        }
    };

    proto._handleLitigationIndexingSave =
        async function() {
            const suit =
                this.matchedSuit;

            const suitId =
                suit?.id
                    ? String(suit.id)
                    : null;

            const parentTxId =
                document.getElementById(
                    'parentTransactionSelect'
                )?.value ||
                '';

            const childTypeId =
                document.getElementById(
                    'detectedType'
                )?.value ||
                '';

            const deliveryRaw =
                document.getElementById(
                    'detectedDate'
                )?.value ||
                '';

            const notes =
                document.getElementById(
                    'transactionNotes'
                )?.value?.trim() ||
                '';

            const selectedSuitStatus =
                document.getElementById(
                    'litigationStatusSelect'
                )?.value ||
                '';

            const previousSuitStatus =
                suit?.status ||
                null;

            if (
                selectedSuitStatus &&
                !isValidLitigationStatus(
                    selectedSuitStatus
                )
            ) {
                showNotification(
                    'Seçilen dava durumu geçerli değil.',
                    'error'
                );
                return;
            }

            if (!suitId) {
                showNotification(
                    'Dava kaydı bulunamadı.',
                    'error'
                );
                return;
            }

            if (
                !parentTxId ||
                !childTypeId ||
                !deliveryRaw
            ) {
                showNotification(
                    'Lütfen dava ana işlemini, gelen evrak türünü ve tebliğ tarihini seçin.',
                    'error'
                );
                return;
            }

            const deliveryIso =
                toIsoDate(deliveryRaw);

            if (!deliveryIso) {
                showNotification(
                    'Tebliğ tarihi geçerli değil.',
                    'error'
                );
                return;
            }

            const parentTx =
                (this.currentTransactions || [])
                    .find(
                        (tx) =>
                            String(tx.id) ===
                            String(parentTxId)
                    );

            if (!parentTx) {
                showNotification(
                    'Seçilen dava ana işlemi bulunamadı.',
                    'error'
                );
                return;
            }

            if (
                parentTx.ip_record_id &&
                String(parentTx.ip_record_id) !==
                    suitId
            ) {
                showNotification(
                    'Güvenlik kontrolü başarısız: Ana işlem başka bir kayda bağlı.',
                    'error'
                );
                return;
            }

            const childType =
                typeObject(
                    this,
                    childTypeId
                );

            if (
                !canUseIncomingType(
                    this,
                    childType,
                    parentTx,
                    this.currentTransactions
                )
            ) {
                showNotification(
                    'Seçilen evrak türü mevcut yargılama aşamasında kullanılamaz.',
                    'error'
                );
                return;
            }

            const currentStage =
                judicialStageKeyFromType(
                    parentTx.transaction_type_id
                );

            const transition =
                stageTransitionOnIndex(
                    childType
                );

            let newStageTypeId =
                null;

            let effectiveStage =
                currentStage;

            let effectiveParentTxId =
                String(parentTxId);

            let stageParentContext =
                parseJsonObject(
                    parentTx.suit_context
                );

            if (transition) {
                const previousStage =
                    transitionPreviousStage(
                        transition
                    );

                if (
                    currentStage ===
                    previousStage
                ) {
                    const targetType =
                        transitionTargetType(
                            transition
                        );

                    if (
                        findDirectStageChild(
                            this.currentTransactions,
                            parentTx.id,
                            targetType
                        )
                    ) {
                        showNotification(
                            `${stageLabel(transition)} aşaması zaten mevcut. Lütfen aktif aşamayı seçerek devam edin.`,
                            'warning'
                        );
                        return;
                    }

                    newStageTypeId =
                        targetType;

                    effectiveStage =
                        transition;

                } else if (
                    currentStage ===
                    transition
                ) {
                    effectiveStage =
                        currentStage;

                } else {
                    showNotification(
                        `Bu evrak ${stageLabel(transition)} aşamasını başlatamaz; seçili parent ${stageLabel(currentStage)} aşamasındadır.`,
                        'error'
                    );
                    return;
                }
            }

            const decision =
                this
                    ._getLitigationDecisionContextFromUi(
                        childTypeId,
                        parentTx
                    );

            if (!decision.valid) {
                showNotification(
                    decision.error ||
                        'Karar sonucu eksik.',
                    'warning'
                );
                return;
            }

            const pdfUrl =
                this.pdfData?.fileUrl ||
                this.pdfData?.file_url ||
                this.pdfData?.downloadURL ||
                this.pdfData?.download_url ||
                null;

            if (!pdfUrl) {
                showNotification(
                    'Gelen PDF bağlantısı bulunamadı. İşlem kaydedilmedi.',
                    'error'
                );
                return;
            }

            const saveBtn =
                document.getElementById(
                    'saveTransactionBtn'
                );

            if (saveBtn) {
                saveBtn.disabled =
                    true;

                saveBtn.innerHTML =
                    '<i class="fas fa-spinner fa-spin mr-2"></i>Dava Evrakı Kaydediliyor...';
            }

            let createdTransactionId =
                null;

            let createdStageParentId =
                null;

            let suitStatusChanged =
                false;

            let existingContextChanged =
                false;

            let previousExistingContext =
                null;

            try {
                const childName =
                    childType.alias ||
                    childType.name ||
                    `Dava Evrakı ${childTypeId}`;

                if (newStageTypeId) {
                    const stageResult =
                        await this
                            ._addTransaction(
                                suitId,
                                {
                                    type:
                                        String(
                                            newStageTypeId
                                        ),
                                    transactionHierarchy:
                                        'parent',
                                    parentId:
                                        String(
                                            parentTxId
                                        ),
                                    description:
                                        stageLabel(
                                            effectiveStage
                                        ),
                                    date:
                                        deliveryIso,
                                    taskId:
                                        null,
                                    notes: [
                                        `[Yargılama Aşaması Başlatıldı: ${stageLabel(effectiveStage)}]`,
                                        '[Başlatan: Karşı Taraf]',
                                        `[Kaynak Evrak: ${childName}]`,
                                        `[Önceki Parent: ${parentTxId}]`,
                                        '[Varlık Türü: suit]'
                                    ].join('\n'),
                                    documents:
                                        []
                                }
                            );

                    if (
                        !stageResult?.success ||
                        !stageResult?.id
                    ) {
                        throw new Error(
                            stageResult?.error ||
                            `${stageLabel(effectiveStage)} parent transaction oluşturulamadı.`
                        );
                    }

                    createdStageParentId =
                        String(
                            stageResult.id
                        );

                    effectiveParentTxId =
                        createdStageParentId;

                    stageParentContext = {
                        stage:
                            effectiveStage,
                        stage_initiator:
                            'opponent',
                        transition_source:
                            'opponent_filing',
                        source_document_id:
                            String(
                                this.pdfId ||
                                ''
                            ),
                        source_incoming_type:
                            String(
                                childTypeId
                            ),
                        previous_stage:
                            currentStage,
                        previous_stage_parent_id:
                            String(
                                parentTxId
                            )
                    };

                    const {
                        error:
                            stageContextError
                    } = await supabase
                        .from('transactions')
                        .update({
                            suit_context:
                                stageParentContext
                        })
                        .eq(
                            'id',
                            createdStageParentId
                        );

                    if (stageContextError) {
                        throw new Error(
                            `Yeni stage context kaydedilemedi: ${stageContextError.message}`
                        );
                    }

                } else if (
                    transition &&
                    currentStage ===
                        transition
                ) {
                    previousExistingContext =
                        parseJsonObject(
                            parentTx.suit_context
                        );

                    stageParentContext = {
                        ...previousExistingContext,
                        stage:
                            currentStage,
                        stage_initiator:
                            mergeInitiator(
                                previousExistingContext
                                    .stage_initiator,
                                'opponent'
                            ),
                        last_transition_source:
                            'opponent_filing',
                        last_source_document_id:
                            String(
                                this.pdfId ||
                                ''
                            )
                    };

                    const {
                        error:
                            parentContextError
                    } = await supabase
                        .from('transactions')
                        .update({
                            suit_context:
                                stageParentContext
                        })
                        .eq(
                            'id',
                            String(
                                parentTxId
                            )
                        );

                    if (parentContextError) {
                        throw new Error(
                            `Stage başlatan bilgisi güncellenemedi: ${parentContextError.message}`
                        );
                    }

                    existingContextChanged =
                        true;
                }

                const systemTags = [
                    `[Kaynak İşlem: ${newStageTypeId || parentTx.transaction_type_id}]`,
                    `[Yargılama Aşaması: ${stageLabel(effectiveStage)}]`,
                    '[Varlık Türü: suit]'
                ];

                if (transition) {
                    systemTags.push(
                        '[Aşama Geçiş Kaynağı: Karşı Taraf Dilekçesi]'
                    );
                }

                if (
                    decision
                        .decisionResult
                ) {
                    systemTags.push(
                        `[Karar Sonucu: ${decisionResultLabel(decision.decisionResult)}]`
                    );
                }

                if (
                    decision
                        .clientOutcome
                ) {
                    systemTags.push(
                        `[Müvekkil Açısından: ${clientOutcomeLabel(decision.clientOutcome)}]`
                    );
                }

                if (
                    selectedSuitStatus &&
                    selectedSuitStatus !==
                        previousSuitStatus
                ) {
                    systemTags.push(
                        `[Dava Statüsü: ${previousSuitStatus || '-'} -> ${selectedSuitStatus}]`
                    );
                }

                const systemNote =
                    [
                        notes,
                        ...systemTags
                    ]
                        .filter(Boolean)
                        .join('\n');

                const txResult =
                    await this
                        ._addTransaction(
                            suitId,
                            {
                                type:
                                    String(
                                        childTypeId
                                    ),
                                transactionHierarchy:
                                    'child',
                                parentId:
                                    String(
                                        effectiveParentTxId
                                    ),
                                description:
                                    childName,
                                date:
                                    deliveryIso,
                                taskId:
                                    null,
                                notes:
                                    systemNote,
                                documents: [
                                    {
                                        name:
                                            this.pdfData
                                                ?.fileName ||
                                            this.pdfData
                                                ?.file_name ||
                                            'Mahkeme Evrakı.pdf',
                                        url:
                                            pdfUrl,
                                        documentDesignation:
                                            childName
                                    }
                                ]
                            }
                        );

                if (
                    !txResult?.success ||
                    !txResult?.id
                ) {
                    throw new Error(
                        txResult?.error ||
                        'Dava child transaction kaydı oluşturulamadı.'
                    );
                }

                createdTransactionId =
                    String(
                        txResult.id
                    );

                const childContext = {
                    stage:
                        effectiveStage,
                    stage_initiator:
                        stageParentContext
                            .stage_initiator ||
                        null,
                    parent_stage_transaction_id:
                        String(
                            effectiveParentTxId
                        )
                };

                if (transition) {
                    childContext
                        .transition_source =
                            'opponent_filing';

                    childContext
                        .transition_target_stage =
                            transition;
                }

                if (
                    decision
                        .decisionResult
                ) {
                    childContext
                        .decision_result =
                            decision
                                .decisionResult;
                }

                if (
                    decision
                        .clientOutcome
                ) {
                    childContext
                        .client_outcome =
                            decision
                                .clientOutcome;
                }

                const {
                    error:
                        childContextError
                } = await supabase
                    .from('transactions')
                    .update({
                        suit_context:
                            childContext
                    })
                    .eq(
                        'id',
                        createdTransactionId
                    );

                if (childContextError) {
                    throw new Error(
                        `Dava transaction context kaydedilemedi: ${childContextError.message}`
                    );
                }

                if (
                    selectedSuitStatus &&
                    selectedSuitStatus !==
                        previousSuitStatus
                ) {
                    const {
                        error:
                            suitStatusError
                    } = await supabase
                        .from('suits')
                        .update({
                            status:
                                selectedSuitStatus,
                            updated_at:
                                new Date()
                                    .toISOString()
                        })
                        .eq(
                            'id',
                            suitId
                        );

                    if (suitStatusError) {
                        throw new Error(
                            `Dava durumu güncellenemedi: ${suitStatusError.message}`
                        );
                    }

                    suitStatusChanged =
                        true;

                    if (this.matchedSuit) {
                        this.matchedSuit.status =
                            selectedSuitStatus;
                    }
                }

                const {
                    error:
                        incomingError
                } = await supabase
                    .from(
                        'incoming_documents'
                    )
                    .update({
                        status:
                            'litigation_indexed',
                        indexed_at:
                            new Date()
                                .toISOString(),
                        created_transaction_id:
                            createdTransactionId,
                        ip_record_id:
                            suitId,
                        transaction_type_id:
                            String(
                                childTypeId
                            ),
                        teblig_tarihi:
                            deliveryIso
                    })
                    .eq(
                        'id',
                        String(
                            this.pdfId
                        )
                    );

                if (incomingError) {
                    throw new Error(
                        `Gelen evrak kaydı güncellenemedi: ${incomingError.message}`
                    );
                }

                if (this.pdfData) {
                    this.pdfData.status =
                        'litigation_indexed';

                    this.pdfData.ip_record_id =
                        suitId;

                    this.pdfData.matchedRecordId =
                        suitId;

                    this.pdfData.created_transaction_id =
                        createdTransactionId;

                    this.pdfData.transaction_type_id =
                        String(
                            childTypeId
                        );
                }

                if (saveBtn) {
                    saveBtn.disabled =
                        true;

                    saveBtn
                        .classList
                        .remove(
                            'btn-primary',
                            'btn-secondary'
                        );

                    saveBtn
                        .classList
                        .add(
                            'btn-success'
                        );

                    saveBtn.innerHTML =
                        '<i class="fas fa-check-circle mr-2"></i>Dava Evrakı İndekslendi';
                }

                const statusMessage =
                    (
                        selectedSuitStatus &&
                        selectedSuitStatus !==
                            previousSuitStatus
                    )
                        ? ` Dava durumu "${litigationStatusLabel(selectedSuitStatus)}" olarak güncellendi.`
                        : '';

                const stageMessage =
                    createdStageParentId
                        ? ` Yeni ${stageLabel(effectiveStage)} aşaması karşı taraf dilekçesi ile oluşturuldu.`
                        : '';

                const decisionMessage =
                    decision.clientOutcome
                        ? ` Karar sonucu: ${clientOutcomeLabel(decision.clientOutcome)}.`
                        : '';

                showNotification(
                    `${childName} dava dosyasına başarıyla bağlandı.${stageMessage}${decisionMessage}${statusMessage}`,
                    'success'
                );

                if (
                    existingContextChanged
                ) {
                    const localParent =
                        (this.currentTransactions || [])
                            .find(
                                (tx) =>
                                    String(tx.id) ===
                                    String(parentTxId)
                            );

                    if (localParent) {
                        localParent.suit_context =
                            stageParentContext;
                    }
                }

                const additions =
                    [];

                if (
                    createdStageParentId
                ) {
                    additions.push({
                        id:
                            createdStageParentId,
                        ip_record_id:
                            suitId,
                        transaction_type_id:
                            String(
                                newStageTypeId
                            ),
                        transaction_hierarchy:
                            'parent',
                        parent_id:
                            String(
                                parentTxId
                            ),
                        description:
                            stageLabel(
                                effectiveStage
                            ),
                        note:
                            `[Yargılama Aşaması Başlatıldı: ${stageLabel(effectiveStage)}]`,
                        transaction_date:
                            deliveryIso,
                        task_id:
                            null,
                        suit_context:
                            stageParentContext,
                        created_at:
                            new Date()
                                .toISOString()
                    });
                }

                additions.push({
                    id:
                        createdTransactionId,
                    ip_record_id:
                        suitId,
                    transaction_type_id:
                        String(
                            childTypeId
                        ),
                    transaction_hierarchy:
                        'child',
                    parent_id:
                        String(
                            effectiveParentTxId
                        ),
                    description:
                        childName,
                    note:
                        systemNote,
                    transaction_date:
                        deliveryIso,
                    task_id:
                        null,
                    suit_context:
                        childContext,
                    created_at:
                        new Date()
                            .toISOString()
                });

                this.currentTransactions = [
                    ...(
                        this.currentTransactions ||
                        []
                    ),
                    ...additions
                ];

                this
                    ._refreshLitigationStageControl();

                // Task/mail otomasyonu ayrı modülün hook'udur.
                // Hata olursa ana indeksleme rollback edilmez.
                if (
                    typeof this
                        ._afterLitigationIndexingSave ===
                        'function'
                ) {
                    try {
                        await this
                            ._afterLitigationIndexingSave();
                    } catch (automationError) {
                        console.error(
                            '[LITIGATION V2] Post-index hook hatası:',
                            automationError
                        );

                        showNotification(
                            `Dava evrakı indekslendi ancak otomatik görev/mail bildirimi tamamlanamadı: ${automationError.message || automationError}`,
                            'warning',
                            10000
                        );
                    }
                }

            } catch (error) {
                console.error(
                    '[LITIGATION V2] Save hatası:',
                    error
                );

                if (suitStatusChanged) {
                    try {
                        await supabase
                            .from('suits')
                            .update({
                                status:
                                    previousSuitStatus,
                                updated_at:
                                    new Date()
                                        .toISOString()
                            })
                            .eq(
                                'id',
                                suitId
                            );

                        if (this.matchedSuit) {
                            this.matchedSuit.status =
                                previousSuitStatus;
                        }

                    } catch (
                        rollbackError
                    ) {
                        console.warn(
                            '[LITIGATION V2] Status rollback:',
                            rollbackError
                        );
                    }
                }

                if (
                    createdTransactionId
                ) {
                    await this
                        ._rollbackLitigationTransaction(
                            createdTransactionId
                        );

                    createdTransactionId =
                        null;
                }

                if (
                    createdStageParentId
                ) {
                    await this
                        ._rollbackLitigationTransaction(
                            createdStageParentId
                        );

                    createdStageParentId =
                        null;
                }

                if (
                    existingContextChanged
                ) {
                    try {
                        await supabase
                            .from('transactions')
                            .update({
                                suit_context:
                                    previousExistingContext ||
                                    {}
                            })
                            .eq(
                                'id',
                                String(
                                    parentTxId
                                )
                            );

                    } catch (
                        rollbackError
                    ) {
                        console.warn(
                            '[LITIGATION V2] Context rollback:',
                            rollbackError
                        );
                    }
                }

                showNotification(
                    `Dava indeksleme hatası: ${error.message || error}`,
                    'error'
                );

                if (saveBtn) {
                    saveBtn.disabled =
                        false;

                    saveBtn
                        .classList
                        .remove(
                            'btn-success',
                            'btn-secondary'
                        );

                    saveBtn
                        .classList
                        .add(
                            'btn-primary'
                        );

                    saveBtn.innerHTML =
                        '<i class="fas fa-gavel mr-2"></i>Dava Evrakını İndeksle';
                }
            }
        };

    proto.handleSave = async function(...args) {
        if (this.matchedEntityType === 'suit') {
            return this._handleLitigationIndexingSave();
        }

        // Marka / Patent / Tasarım: Stage 3R -> mevcut handleSave zinciri.
        return smartHandleSave.apply(this, args);
    };

    ensureWriteStyles();
}
