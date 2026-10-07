// public/js/indexing/litigation-indexing-write.js
// IPGate Dava Yönetimi - AŞAMA 8A
// Baz: AŞAMA 7 güvenli dava write branch.
// Ek:
// - Kullanıcı kontrollü İlk Derece -> İstinaf -> Yargıtay stage zinciri.
// - 59/60 parent transaction'ları aynı suits.id altında parent_id ile bağlanır.
// - Evraktan otomatik yargılama aşaması tahmini YOK.
// - AŞAMA 7 manuel suits.status seçimi aynen korunur.
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
const FIRST_INSTANCE_CHILDREN = ['70', '71', '72', '73', '74', '75', '76', '78'];

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

const LITIGATION_PARENT_CHILD_MAP = Object.freeze({
    // İlk derece dava parent'ları
    '49': FIRST_INSTANCE_CHILDREN,
    '54': FIRST_INSTANCE_CHILDREN,
    '55': FIRST_INSTANCE_CHILDREN,
    '56': FIRST_INSTANCE_CHILDREN,
    '57': FIRST_INSTANCE_CHILDREN,
    '58': FIRST_INSTANCE_CHILDREN,

    // İstinaf: üst derece ilamı + ara süreç evrakları
    '59': ['73', '75', '77', '78'],

    // Yargıtay: üst derece ilamı + kesinleşme
    '60': ['77', '78']
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

function stageActionTargetType(action) {
    if (action === 'start_appeal') {
        return JUDICIAL_STAGE_TYPES.appeal;
    }

    if (action === 'start_cassation') {
        return JUDICIAL_STAGE_TYPES.cassation;
    }

    return null;
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
                document.getElementById(
                    'litigationStageControl'
                );

            const parentSelect =
                document.getElementById(
                    'parentTransactionSelect'
                );

            if (
                !wrapper ||
                !parentSelect
            ) {
                return;
            }

            const parentTxId =
                String(
                    parentSelect.value ||
                    ''
                );

            const parentTx =
                (this.currentTransactions || [])
                    .find(
                        (tx) =>
                            String(tx.id) ===
                            parentTxId
                    ) ||
                null;

            const highest =
                findHighestJudicialStageParent(
                    this.currentTransactions
                );

            const highestLabel =
                highest
                    ? judicialStageLabelFromType(
                        highest.transaction_type_id
                    )
                    : 'Belirlenemedi';

            const selectedTypeId =
                parentTx
                    ? String(
                        parentTx.transaction_type_id ||
                        ''
                    )
                    : '';

            const selectedStageLabel =
                parentTx
                    ? judicialStageLabelFromType(
                        selectedTypeId
                    )
                    : '-';

            const actions = [
                {
                    value: '',
                    text:
                        'Mevcut aşamada devam et'
                }
            ];

            if (
                parentTx &&
                FIRST_INSTANCE_PARENT_TYPES
                    .includes(
                        selectedTypeId
                    ) &&
                !findDirectStageChild(
                    this.currentTransactions,
                    parentTx.id,
                    JUDICIAL_STAGE_TYPES.appeal
                )
            ) {
                actions.push({
                    value:
                        'start_appeal',

                    text:
                        'Yeni İstinaf aşaması başlat'
                });
            }

            if (
                parentTx &&
                selectedTypeId ===
                    JUDICIAL_STAGE_TYPES.appeal &&
                !findDirectStageChild(
                    this.currentTransactions,
                    parentTx.id,
                    JUDICIAL_STAGE_TYPES.cassation
                )
            ) {
                actions.push({
                    value:
                        'start_cassation',

                    text:
                        'Yeni Yargıtay aşaması başlat'
                });
            }

            const previousValue =
                document.getElementById(
                    'litigationStageActionSelect'
                )?.value ||
                '';

            wrapper.innerHTML = `
                <label class="custom-label">
                    <i class="fas fa-sitemap mr-1"></i>
                    Yargılama Aşaması
                </label>

                <select
                    id="litigationStageActionSelect"
                    class="form-control shadow-sm"
                    ${parentTx ? '' : 'disabled'}
                >
                    ${actions.map(
                        (item) => `
                            <option value="${esc(item.value)}">
                                ${esc(item.text)}
                            </option>
                        `
                    ).join('')}
                </select>

                <div class="litigation-stage-current">
                    <strong>Dosyanın en üst aşaması:</strong>
                    ${esc(highestLabel)}
                    ${
                        parentTx
                            ? ` · <strong>Seçili parent:</strong> ${esc(selectedStageLabel)}`
                            : ''
                    }
                </div>

                <div class="litigation-stage-warning">
                    <i class="fas fa-info-circle mr-1"></i>
                    Sistem evrak içeriğinden aşama tahmini yapmaz.
                    Yeni İstinaf/Yargıtay parent'ı yalnız açık seçiminizle oluşturulur.
                </div>
            `;

            const select =
                document.getElementById(
                    'litigationStageActionSelect'
                );

            if (select) {
                const stillValid =
                    actions.some(
                        (item) =>
                            item.value ===
                            previousValue
                    );

                select.value =
                    stillValid
                        ? previousValue
                        : '';

                select.onchange =
                    () => {
                        this
                            .updateChildTransactionOptions();
                    };
            }
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
            const childSelect =
                document.getElementById(
                    'detectedType'
                );

            if (!childSelect) {
                return;
            }

            let wrapper =
                document.getElementById(
                    'litigationStatusControl'
                );

            if (!wrapper) {
                wrapper =
                    document.createElement('div');

                wrapper.id =
                    'litigationStatusControl';

                wrapper.className =
                    'form-group mb-4';

                const anchor =
                    childSelect.closest(
                        '.form-group'
                    );

                if (anchor) {
                    anchor.insertAdjacentElement(
                        'afterend',
                        wrapper
                    );
                }
            }

            if (!wrapper) {
                return;
            }

            const currentStatus =
                this.matchedSuit?.status ||
                '';

            const options =
                litigationStatusOptions();

            wrapper.innerHTML = `
                <label class="custom-label">
                    <i class="fas fa-traffic-light mr-1"></i>
                    Dava Durumu
                    <span class="text-muted" style="font-weight:400;">
                        (Opsiyonel)
                    </span>
                </label>

                <select
                    id="litigationStatusSelect"
                    class="form-control shadow-sm"
                >
                    <option value="">
                        -- Statüyü Değiştirme --
                    </option>

                    ${options.map(
                        (item) => `
                            <option value="${esc(item.value)}">
                                ${esc(item.text)}
                            </option>
                        `
                    ).join('')}
                </select>

                <div class="litigation-status-current">
                    <strong>Mevcut durum:</strong>
                    ${esc(
                        litigationStatusLabel(
                            currentStatus
                        )
                    )}
                </div>

                <div class="litigation-status-warning">
                    <i class="fas fa-info-circle mr-1"></i>
                    Sistem dava durumunu evrak içeriğinden tahmin etmez.
                    Yalnız burada açıkça seçim yaparsanız dava durumu güncellenir.
                </div>
            `;

            const select =
                document.getElementById(
                    'litigationStatusSelect'
                );

            if (select) {
                select.value = '';
            }
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
                    task_id
                `)
                .eq('ip_record_id', String(suitId))
                .order('transaction_date', { ascending: false });

            if (error) throw error;

            this.currentTransactions = data || [];

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

        const parentSelect = document.getElementById('parentTransactionSelect');
        const childSelect = document.getElementById('detectedType');

        if (!parentSelect || !childSelect) return;

        childSelect.innerHTML =
            '<option value="">-- Gelen Evrak Türünü Seçiniz --</option>';
        childSelect.disabled = true;

        const parentTxId = String(parentSelect.value || '');
        if (!parentTxId) return;

        const parentTx = (this.currentTransactions || []).find(
            (tx) => String(tx.id) === parentTxId
        );

        if (!parentTx) return;

        const parentTypeId =
            String(
                parentTx.transaction_type_id ||
                ''
            );

        this
            ._ensureLitigationStageControl();

        const stageAction =
            document.getElementById(
                'litigationStageActionSelect'
            )?.value ||
            '';

        const stageTargetType =
            stageActionTargetType(
                stageAction
            );

        const effectiveParentTypeId =
            stageTargetType ||
            parentTypeId;

        const allowedIds =
            LITIGATION_PARENT_CHILD_MAP[
                effectiveParentTypeId
            ] || [];

        const allowedTypes = allowedIds
            .map((id) => typeObject(this, id))
            .filter((obj) => obj && isSuitTypeObject(obj));

        for (const type of allowedTypes) {
            const option = document.createElement('option');
            option.value = String(type.id);
            option.textContent =
                type.alias || type.name || `İşlem ${type.id}`;
            childSelect.appendChild(option);
        }

        if (allowedTypes.length > 0) {
            childSelect.disabled = false;
        }

        const deadline = document.getElementById('calculatedDeadlineDisplay');
        if (deadline) {
            const stageLabel =
                judicialStageLabelFromType(
                    effectiveParentTypeId
                );

            deadline.value =
                `Yargılama aşaması: ${stageLabel}`;
        }
    };

    proto.updateCalculatedDeadline = function() {
        if (this.matchedEntityType !== 'suit') {
            return normalUpdateDeadline.call(this);
        }

        const deadline = document.getElementById('calculatedDeadlineDisplay');
        if (deadline) {
            deadline.value = 'Görev / son tarih aşaması henüz kapalı';
        }
    };

    // Smart header'ı kullan; yalnız "salt okunur" rozetini Stage 4'e uygun hale getir.
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

    proto._handleLitigationIndexingSave = async function() {
        const suit = this.matchedSuit;
        const suitId = suit?.id ? String(suit.id) : null;

        const parentTxId =
            document.getElementById('parentTransactionSelect')?.value || '';

        const childTypeId =
            document.getElementById('detectedType')?.value || '';

        const deliveryDateRaw =
            document.getElementById('detectedDate')?.value || '';

        const notes =
            document.getElementById('transactionNotes')?.value?.trim() || '';

        const selectedSuitStatus =
            document.getElementById(
                'litigationStatusSelect'
            )?.value || '';

        const stageAction =
            document.getElementById(
                'litigationStageActionSelect'
            )?.value || '';

        const previousSuitStatus =
            suit?.status || null;

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
            showNotification('Dava kaydı bulunamadı.', 'error');
            return;
        }

        if (!parentTxId || !childTypeId || !deliveryDateRaw) {
            showNotification(
                'Lütfen dava ana işlemini, gelen evrak türünü ve tebliğ tarihini seçin.',
                'error'
            );
            return;
        }

        const deliveryIso = toIsoDate(deliveryDateRaw);

        if (!deliveryIso) {
            showNotification('Tebliğ tarihi geçerli değil.', 'error');
            return;
        }

        const parentTx = (this.currentTransactions || []).find(
            (tx) => String(tx.id) === String(parentTxId)
        );

        if (!parentTx) {
            showNotification('Seçilen dava ana işlemi bulunamadı.', 'error');
            return;
        }

        // Polymorphic kimlik güvenliği:
        // transaction parent'ı gerçekten bu suits.id altında olmalı.
        if (
            parentTx.ip_record_id &&
            String(parentTx.ip_record_id) !== suitId
        ) {
            showNotification(
                'Güvenlik kontrolü başarısız: Ana işlem başka bir kayda bağlı.',
                'error'
            );
            return;
        }

        const parentTypeId =
            String(
                parentTx.transaction_type_id ||
                ''
            );

        let newStageTypeId =
            null;

        if (stageAction === 'start_appeal') {
            if (
                !FIRST_INSTANCE_PARENT_TYPES
                    .includes(
                        parentTypeId
                    )
            ) {
                showNotification(
                    'Yeni İstinaf aşaması yalnız bir İlk Derece parent üzerinden başlatılabilir.',
                    'error'
                );
                return;
            }

            if (
                findDirectStageChild(
                    this.currentTransactions,
                    parentTx.id,
                    JUDICIAL_STAGE_TYPES.appeal
                )
            ) {
                showNotification(
                    'Bu İlk Derece aşaması altında zaten bir İstinaf parent kaydı mevcut.',
                    'warning'
                );
                return;
            }

            newStageTypeId =
                JUDICIAL_STAGE_TYPES.appeal;

        } else if (
            stageAction ===
            'start_cassation'
        ) {
            if (
                parentTypeId !==
                JUDICIAL_STAGE_TYPES.appeal
            ) {
                showNotification(
                    'Yeni Yargıtay aşaması yalnız bir İstinaf parent üzerinden başlatılabilir.',
                    'error'
                );
                return;
            }

            if (
                findDirectStageChild(
                    this.currentTransactions,
                    parentTx.id,
                    JUDICIAL_STAGE_TYPES.cassation
                )
            ) {
                showNotification(
                    'Bu İstinaf aşaması altında zaten bir Yargıtay parent kaydı mevcut.',
                    'warning'
                );
                return;
            }

            newStageTypeId =
                JUDICIAL_STAGE_TYPES.cassation;
        }

        const effectiveParentTypeId =
            newStageTypeId ||
            parentTypeId;

        const allowedChildIds =
            LITIGATION_PARENT_CHILD_MAP[
                effectiveParentTypeId
            ] || [];

        if (!allowedChildIds.includes(String(childTypeId))) {
            showNotification(
                'Seçilen evrak türü bu dava ana işlemi altında kullanılamaz.',
                'error'
            );
            return;
        }

        const childTypeObj = typeObject(this, childTypeId);

        if (!childTypeObj || !isSuitTypeObject(childTypeObj)) {
            showNotification(
                'Seçilen işlem türü geçerli bir dava işlem türü değil.',
                'error'
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

        const saveBtn = document.getElementById('saveTransactionBtn');

        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML =
                '<i class="fas fa-spinner fa-spin mr-2"></i>Dava Evrakı Kaydediliyor...';
        }

        let createdTransactionId =
            null;

        let createdStageParentId =
            null;

        try {
            const childName =
                childTypeObj.alias ||
                childTypeObj.name ||
                `Dava Evrakı ${childTypeId}`;

            let systemNote = notes;

            const effectiveStageLabel =
                judicialStageLabelFromType(
                    effectiveParentTypeId
                );

            const systemTags = [
                `[Kaynak İşlem: ${effectiveParentTypeId}]`,
                `[Yargılama Aşaması: ${effectiveStageLabel}]`,
                '[Varlık Türü: suit]'
            ];

            if (
                selectedSuitStatus &&
                selectedSuitStatus !==
                    previousSuitStatus
            ) {
                systemTags.push(
                    `[Dava Statüsü: ${previousSuitStatus || '-'} -> ${selectedSuitStatus}]`
                );
            }

            systemNote = [systemNote, ...systemTags]
                .filter(Boolean)
                .join('\n');

            let effectiveParentTxId =
                String(parentTxId);

            if (newStageTypeId) {
                const stageTypeObj =
                    typeObject(
                        this,
                        newStageTypeId
                    );

                if (
                    !stageTypeObj ||
                    !isSuitTypeObject(
                        stageTypeObj
                    )
                ) {
                    throw new Error(
                        `Yeni yargılama aşaması işlem tipi bulunamadı: ${newStageTypeId}`
                    );
                }

                const stageLabel =
                    judicialStageLabelFromType(
                        newStageTypeId
                    );

                const stageDescription =
                    stageTypeObj.alias ||
                    stageTypeObj.name ||
                    stageLabel;

                const stageNote = [
                    `[Yargılama Aşaması Başlatıldı: ${stageLabel}]`,
                    `[Önceki Aşama: ${judicialStageLabelFromType(parentTypeId)}]`,
                    `[Önceki Parent: ${parentTxId}]`,
                    '[Varlık Türü: suit]'
                ].join('\n');

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

                                // Kritik hiyerarşi:
                                // İstinaf -> İlk Derece
                                // Yargıtay -> İstinaf
                                parentId:
                                    String(
                                        parentTxId
                                    ),

                                description:
                                    stageDescription,

                                date:
                                    deliveryIso,

                                taskId:
                                    null,

                                notes:
                                    stageNote,

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
                        `${stageLabel} parent transaction oluşturulamadı.`
                    );
                }

                createdStageParentId =
                    String(
                        stageResult.id
                    );

                effectiveParentTxId =
                    createdStageParentId;
            }

            // Storage taşıma bu aşamada özellikle yapılmıyor.
            // Böylece incoming_documents update başarısız olursa dosya yolu bozulmuyor.
            const txResult = await this._addTransaction(suitId, {
                type: String(childTypeId),
                transactionHierarchy: 'child',
                parentId: String(effectiveParentTxId),
                description: childName,
                date: deliveryIso,
                taskId: null,
                notes: systemNote,
                documents: [{
                    name:
                        this.pdfData?.fileName ||
                        this.pdfData?.file_name ||
                        'Mahkeme Evrakı.pdf',
                    url: pdfUrl,
                    documentDesignation: childName
                }]
            });

            if (!txResult?.success || !txResult?.id) {
                if (createdStageParentId) {
                    await this
                        ._rollbackLitigationTransaction(
                            createdStageParentId
                        );

                    createdStageParentId =
                        null;
                }

                throw new Error(
                    txResult?.error ||
                    'Dava child transaction kaydı oluşturulamadı.'
                );
            }

            createdTransactionId = String(txResult.id);

            let suitStatusChanged =
                false;

            if (
                selectedSuitStatus &&
                selectedSuitStatus !==
                    previousSuitStatus
            ) {
                const {
                    error: suitStatusError
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

            const incomingUpdate = {
                // Geçici ve bilinçli Stage-4 statüsü:
                // Edge Function status !== indexed olduğu için mail üretmez.
                status: 'litigation_indexed',
                indexed_at: new Date().toISOString(),
                created_transaction_id: createdTransactionId,

                // transactions.ip_record_id ile aynı polymorphic root.
                ip_record_id: suitId,

                transaction_type_id: String(childTypeId),
                teblig_tarihi: deliveryIso
            };

            const { error: incomingError } = await supabase
                .from('incoming_documents')
                .update(incomingUpdate)
                .eq('id', String(this.pdfId));

            if (incomingError) {
                if (suitStatusChanged) {
                    const {
                        error: statusRollbackError
                    } = await supabase
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

                    if (statusRollbackError) {
                        console.warn(
                            '[LITIGATION AŞAMA 7] Dava statüsü rollback yapılamadı:',
                            statusRollbackError
                        );
                    } else if (this.matchedSuit) {
                        this.matchedSuit.status =
                            previousSuitStatus;
                    }
                }

                await this._rollbackLitigationTransaction(
                    createdTransactionId
                );
                createdTransactionId = null;

                if (createdStageParentId) {
                    await this
                        ._rollbackLitigationTransaction(
                            createdStageParentId
                        );

                    createdStageParentId =
                        null;
                }

                throw new Error(
                    `Gelen evrak kaydı güncellenemedi: ${incomingError.message}`
                );
            }

            // UI state'i güncelle; tekrar kayda basılmasını engelle.
            if (this.pdfData) {
                this.pdfData.status = 'litigation_indexed';
                this.pdfData.ip_record_id = suitId;
                this.pdfData.matchedRecordId = suitId;
                this.pdfData.created_transaction_id =
                    createdTransactionId;
                this.pdfData.transaction_type_id =
                    String(childTypeId);
            }

            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.classList.remove('btn-primary', 'btn-secondary');
                saveBtn.classList.add('btn-success');
                saveBtn.innerHTML =
                    '<i class="fas fa-check-circle mr-2"></i>Dava Evrakı İndekslendi';
            }

            const deadline =
                document.getElementById('calculatedDeadlineDisplay');

            if (deadline) {
                deadline.value =
                    'Transaction kaydedildi · task/mail henüz kapalı';
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
                    ? ` Yeni ${judicialStageLabelFromType(newStageTypeId)} aşaması oluşturuldu.`
                    : '';

            showNotification(
                `${childName} dava dosyasına başarıyla bağlandı.${stageMessage}${statusMessage}`,
                'success'
            );

            // Dava detay ekranında yeni child işlemin görülebilmesi için
            // currentTransactions'ı lokal olarak da güncelle.
            const currentStatusInfo =
                document.querySelector(
                    '#litigationStatusControl .litigation-status-current'
                );

            if (currentStatusInfo) {
                currentStatusInfo.innerHTML =
                    `<strong>Mevcut durum:</strong> ${esc(
                        litigationStatusLabel(
                            this.matchedSuit?.status ||
                            previousSuitStatus
                        )
                    )}`;
            }

            const statusSelect =
                document.getElementById(
                    'litigationStatusSelect'
                );

            if (statusSelect) {
                statusSelect.value = '';
            }

            const newTransactions =
                [];

            if (
                createdStageParentId &&
                newStageTypeId
            ) {
                newTransactions.push({
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
                        typeName(
                            this,
                            newStageTypeId
                        ),

                    note:
                        `[Yargılama Aşaması Başlatıldı: ${judicialStageLabelFromType(newStageTypeId)}]`,

                    transaction_date:
                        deliveryIso,

                    task_id:
                        null,

                    created_at:
                        new Date()
                            .toISOString()
                });
            }

            newTransactions.push({
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

                created_at:
                    new Date()
                        .toISOString()
            });

            this.currentTransactions = [
                ...(this.currentTransactions || []),
                ...newTransactions
            ];

            this
                ._ensureLitigationStageControl();

        } catch (error) {
            console.error('[LITIGATION AŞAMA 4] Save hatası:', error);

            if (createdTransactionId) {
                await this._rollbackLitigationTransaction(
                    createdTransactionId
                );

                createdTransactionId =
                    null;
            }

            if (createdStageParentId) {
                await this
                    ._rollbackLitigationTransaction(
                        createdStageParentId
                    );

                createdStageParentId =
                    null;
            }

            showNotification(
                `Dava indeksleme hatası: ${error.message || error}`,
                'error'
            );

            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.classList.remove('btn-success', 'btn-secondary');
                saveBtn.classList.add('btn-primary');
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

/* IPGATE: BEGIN CONSOLIDATED DB-DRIVEN LITIGATION INDEXING */
// litigation-8c2-indexing-patch.js kaldırılmıştır.
// DB-driven dava stage/decision davranışı bu ana modül içine alınmıştır.
// IIFE kullanımı, eski patch içindeki yardımcı isimlerin ana modülle çakışmasını önler.
(() => {
// public/js/indexing/litigation-8c2-indexing-patch.js
// AŞAMA 8C-2: DB-driven litigation stage/decision indexing patch.
// Stage yalnız 92/95 karşı taraf dilekçesi ile indekslemede veya 93/96 task completion DB trigger'ı ile açılır.


const proto = DocumentReviewManager.prototype;
const FIRST_INSTANCE_PARENT_TYPES = new Set(['49','54','55','56','57','58']);
const STAGE_TYPES = Object.freeze({ appeal: '59', cassation: '60' });
const STAGE_LABELS = Object.freeze({ first_instance:'İlk Derece', appeal:'İstinaf', cassation:'Yargıtay' });

function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
function toIsoDate(raw){
  if(!raw)return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) return new Date(`${raw}T12:00:00`).toISOString();
  const p=String(raw).split(/[./]/);
  if(p.length===3&&p[2]?.length===4){const [d,m,y]=p;return new Date(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T12:00:00`).toISOString();}
  const dt=new Date(raw);return Number.isNaN(dt.getTime())?null:dt.toISOString();
}
function typeObject(m,id){return (m.allTransactionTypes||[]).find(x=>String(x.id)===String(id))||null;}
function typeName(m,id){const x=typeObject(m,id);return x?.alias||x?.name||`İşlem ${id}`;}
function isSuitTypeObject(x){if(!x)return false;const t=String(x.ip_type||x.ipType||'').toLowerCase().trim();return !t||t==='suit';}
function parseJsonObject(raw){
  if(!raw)return {};
  if(typeof raw==='object'&&!Array.isArray(raw))return raw;
  if(typeof raw==='string'){try{const p=JSON.parse(raw);return p&&typeof p==='object'&&!Array.isArray(p)?p:{};}catch{return {};}}
  return {};
}
function normalizeStringArray(raw){
  if(!raw)return [];
  if(Array.isArray(raw))return raw.map(String).filter(Boolean);
  if(typeof raw==='string'){
    try{const p=JSON.parse(raw);if(Array.isArray(p))return p.map(String).filter(Boolean);}catch{
      return raw.replace(/[{}]/g,'').split(',').map(x=>x.replace(/^"+|"+$/g,'').trim()).filter(Boolean);
    }
  }
  return [];
}
function suitEventKind(x){return String(x?.suit_event_kind||x?.suitEventKind||'').toLowerCase().trim();}
function suitStageScopes(x){return normalizeStringArray(x?.suit_stage_scope??x?.suitStageScope);}
function stageTransitionOnIndex(x){const v=String(x?.stage_transition_on_index||x?.stageTransitionOnIndex||'').toLowerCase().trim();return ['appeal','cassation'].includes(v)?v:null;}
function isParentTransaction(tx){return String(tx?.transaction_hierarchy||'parent').toLowerCase()==='parent';}
function stageKeyFromParentType(id){id=String(id||'');if(id==='60')return'cassation';if(id==='59')return'appeal';if(FIRST_INSTANCE_PARENT_TYPES.has(id))return'first_instance';return null;}
function stageRankFromParentType(id){const k=stageKeyFromParentType(id);return k==='cassation'?3:k==='appeal'?2:k==='first_instance'?1:0;}
function stageLabel(k){return STAGE_LABELS[k]||'Bilinmeyen Aşama';}
function supportedStageParents(rows){return (rows||[]).filter(tx=>isParentTransaction(tx)&&stageRankFromParentType(tx.transaction_type_id)>0);}
function findHighestStageParent(rows){const a=supportedStageParents(rows);if(!a.length)return null;return [...a].sort((x,y)=>{const r=stageRankFromParentType(y.transaction_type_id)-stageRankFromParentType(x.transaction_type_id);if(r)return r;return new Date(y.transaction_date||y.created_at||0)-new Date(x.transaction_date||x.created_at||0);})[0];}
function findDirectStageChild(rows,parentId,targetType){return (rows||[]).find(tx=>isParentTransaction(tx)&&String(tx.parent_id||'')===String(parentId||'')&&String(tx.transaction_type_id||'')===String(targetType||''))||null;}
function transitionPreviousStage(target){return target==='appeal'?'first_instance':target==='cassation'?'appeal':null;}
function transitionTargetType(target){return STAGE_TYPES[target]||null;}
function mergeInitiator(a,b){a=String(a||'').toLowerCase().trim();b=String(b||'').toLowerCase().trim();if(!a||a==='unknown')return b||'unknown';if(!b||b==='unknown')return a;if(a===b)return a;if(['client','opponent','both'].includes(a)&&['client','opponent','both'].includes(b))return'both';return a;}
function initiatorLabel(v){v=String(v||'').toLowerCase().trim();return v==='client'?'Müvekkil':v==='opponent'?'Karşı Taraf':v==='both'?'Her İki Taraf':'Belirtilmemiş';}
function decisionResultLabel(v){return ({accept:'Kabul',partial_accept:'Kısmen Kabul',reject:'Ret'})[v]||v||'-';}
function clientOutcomeLabel(v){return ({favorable:'Lehe',partially_favorable:'Kısmen Lehe / Kısmen Aleyhe',unfavorable:'Aleyhe'})[v]||v||'-';}
function normRole(v){return String(v||'').toLocaleLowerCase('tr-TR').trim();}
function mapFirstInstanceClientOutcome(role,result){role=normRole(role);result=String(result||'');if(result==='partial_accept')return'partially_favorable';if(role==='davaci'){if(result==='accept')return'favorable';if(result==='reject')return'unfavorable';}if(role==='davali'){if(result==='accept')return'unfavorable';if(result==='reject')return'favorable';}return null;}
function litigationStatusLabel(v){v=String(v||'').trim();if(!v)return'Belirtilmemiş';return (STATUSES?.litigation||[]).find(x=>String(x.value)===v)?.text||v;}
function isValidLitigationStatus(v){v=String(v||'').trim();return !v||(STATUSES?.litigation||[]).some(x=>String(x.value)===v);}

function canUseIncomingType(manager,typeObj,parentTx,rows){
  if(!typeObj||!parentTx||!isSuitTypeObject(typeObj))return false;
  const hierarchy=String(typeObj.hierarchy||'').toLowerCase().trim();if(hierarchy&&hierarchy!=='child')return false;
  const kind=suitEventKind(typeObj);if(!['incoming','decision'].includes(kind))return false;
  const currentStage=stageKeyFromParentType(parentTx.transaction_type_id);if(!currentStage)return false;
  const scopes=suitStageScopes(typeObj);const transition=stageTransitionOnIndex(typeObj);
  if(!transition)return scopes.includes(currentStage);
  if(currentStage===transition)return scopes.includes(currentStage);
  const previous=transitionPreviousStage(transition);if(currentStage!==previous)return false;
  return !findDirectStageChild(rows,parentTx.id,transitionTargetType(transition));
}

function ensurePatchStyles(){
  if(document.getElementById('litigation8C2Styles'))return;
  const s=document.createElement('style');s.id='litigation8C2Styles';s.textContent=`
  #litigationDecisionControl{border:1px solid #d8dee9;background:#fffdf7;border-radius:10px;padding:12px 14px;margin-bottom:1rem}
  #litigationDecisionControl .lit-decision-result{margin-top:7px;font-size:.75rem;color:#475467}
  #litigationDecisionControl .lit-decision-warning{margin-top:8px;padding:7px 9px;border:1px solid #f2dc8d;border-radius:7px;background:#fff8e1;color:#7c5d12;font-size:.72rem}
  #litigationStageControl .litigation-stage-transition-note{margin-top:8px;padding:7px 9px;border:1px solid #bfdbfe;border-radius:7px;background:#eff6ff;color:#1e40af;font-size:.72rem}`;
  document.head.appendChild(s);
}

if(!proto.__litigationStage8C2Patched){
  Object.defineProperty(proto,'__litigationStage8C2Patched',{value:true,writable:false,configurable:false,enumerable:false});
  ensurePatchStyles();
  const baseEnableSuitUi=proto._enableSuitIndexingWriteUi;
  const baseUpdateChildOptions=proto.updateChildTransactionOptions;

  // HOTFIX: suits.status indeksleme ekranında yönetilmez.
  // Status değerleri yalnız dava kayıt/güncelleme ekranında kullanılacaktır.
  proto._ensureLitigationStatusControl=function(){
    document.getElementById('litigationStatusControl')?.remove();
  };

  const baseLoadParents=proto.loadSuitParentTransactionsReadOnly;

  proto._enableSuitIndexingWriteUi=function(...args){
    const r=baseEnableSuitUi?.apply(this,args);
    document.getElementById('litigationStatusControl')?.remove();
    const child=document.getElementById('detectedType');
    if(child&&!child.dataset.litigation8c2DecisionBound){
      child.dataset.litigation8c2DecisionBound='true';
      child.addEventListener('change',()=>this._renderLitigationDecisionControl());
    }
    this._renderLitigationDecisionControl();return r;
  };

  proto._refreshLitigationStageControl=function(){
    const w=document.getElementById('litigationStageControl');const p=document.getElementById('parentTransactionSelect');if(!w||!p)return;
    const parent=(this.currentTransactions||[]).find(tx=>String(tx.id)===String(p.value||''))||null;
    const highest=findHighestStageParent(this.currentTransactions);
    const highKey=highest?stageKeyFromParentType(highest.transaction_type_id):null;
    const selectedKey=parent?stageKeyFromParentType(parent.transaction_type_id):null;
    const initiator=parent?.suit_context?.stage_initiator||null;
    w.innerHTML=`<label class="custom-label"><i class="fas fa-sitemap mr-1"></i>Yargılama Aşaması</label>
      <div class="litigation-stage-current"><strong>Dosyanın en üst aşaması:</strong> ${esc(stageLabel(highKey))}${selectedKey?` · <strong>Seçili parent:</strong> ${esc(stageLabel(selectedKey))}`:''}${initiator?` · <strong>Başlatan:</strong> ${esc(initiatorLabel(initiator))}`:''}</div>
      <div class="litigation-stage-transition-note"><i class="fas fa-shield-alt mr-1"></i>Aşama manuel olarak değiştirilmez. Karşı tarafın İstinaf/Temyiz dilekçesi indekslenirse veya EVREKA'nın kanun yolu işi tamamlanırsa yeni stage oluşturulur.</div>`;
  };

  proto.loadSuitParentTransactionsReadOnly=async function(suitId){
    await baseLoadParents.call(this,suitId);
    const {data,error}=await supabase.from('transactions').select('id, suit_context').eq('ip_record_id',String(suitId));
    if(!error){const m=new Map((data||[]).map(r=>[String(r.id),parseJsonObject(r.suit_context)]));this.currentTransactions=(this.currentTransactions||[]).map(tx=>({...tx,suit_context:m.get(String(tx.id))||parseJsonObject(tx.suit_context)}));}
    this._refreshLitigationStageControl();this.updateChildTransactionOptions();
  };

  proto.updateChildTransactionOptions=function(){
    if(this.matchedEntityType!=='suit')return baseUpdateChildOptions.call(this);
    const p=document.getElementById('parentTransactionSelect');const c=document.getElementById('detectedType');if(!p||!c)return;
    const parent=(this.currentTransactions||[]).find(tx=>String(tx.id)===String(p.value||''))||null;
    if(!parent){c.disabled=true;c.innerHTML='<option value="">-- Önce Ana İşlem Seçiniz --</option>';this._refreshLitigationStageControl();this._renderLitigationDecisionControl();return;}
    const stage=stageKeyFromParentType(parent.transaction_type_id);
    const allowed=(this.allTransactionTypes||[]).filter(t=>canUseIncomingType(this,t,parent,this.currentTransactions)).sort((a,b)=>Number(a.order_index??0)-Number(b.order_index??0)||String(a.alias||a.name||'').localeCompare(String(b.alias||b.name||''),'tr'));
    c.innerHTML='<option value="">-- Gelen Evrak Türünü Seçiniz --</option>';
    for(const t of allowed){const o=document.createElement('option');o.value=String(t.id);const tr=stageTransitionOnIndex(t);const suffix=tr&&tr!==stage?` → ${stageLabel(tr)} aşamasını açar`:'';o.textContent=`${t.alias||t.name||`İşlem ${t.id}`}${suffix}`;c.appendChild(o);}
    c.disabled=allowed.length===0;this._refreshLitigationStageControl();this._renderLitigationDecisionControl();
    const d=document.getElementById('calculatedDeadlineDisplay');if(d)d.value=`Yargılama aşaması: ${stageLabel(stage)}`;
  };

  proto._renderLitigationDecisionControl=function(){
    let w=document.getElementById('litigationDecisionControl');const child=document.getElementById('detectedType');if(!child)return;
    const id=String(child.value||'');const t=typeObject(this,id);if(!t||suitEventKind(t)!=='decision'){w?.remove();return;}
    if(!w){w=document.createElement('div');w.id='litigationDecisionControl';const s=document.getElementById('litigationStatusControl');if(s)s.insertAdjacentElement('beforebegin',w);else child.closest('.form-group')?.insertAdjacentElement('afterend',w);}
    const cfg=parseJsonObject(t.suit_decision_config??t.suitDecisionConfig);
    const pid=document.getElementById('parentTransactionSelect')?.value||'';const parent=(this.currentTransactions||[]).find(tx=>String(tx.id)===String(pid))||null;
    const stage=parent?stageKeyFromParentType(parent.transaction_type_id):null;const initiator=parent?.suit_context?.stage_initiator||null;
    if(String(cfg.mode)==='role_mapped_first_instance'){
      const role=normRole(this.matchedSuit?.client_role || this.matchedSuit?.clientRole);const known=['davaci','davali'].includes(role);
      w.innerHTML=`<label class="custom-label"><i class="fas fa-balance-scale mr-1"></i>Karar Sonucu</label>
        <select id="litigationDecisionResultSelect" class="form-control shadow-sm"><option value="">-- Karar Sonucunu Seçiniz --</option><option value="accept">Kabul</option><option value="partial_accept">Kısmen Kabul</option><option value="reject">Ret</option></select>
        ${known?`<div class="lit-decision-result"><strong>Müvekkil rolü:</strong> ${role==='davaci'?'Davacı':'Davalı'} · <strong>Müvekkil açısından:</strong> <span id="litigationComputedClientOutcome">-</span></div>`:`<div class="lit-decision-result">Müvekkil rolü çözülemedi. Sonucu ayrıca müvekkil açısından seçin:</div><select id="litigationDecisionClientOutcomeFallbackSelect" class="form-control shadow-sm mt-2"><option value="">-- Müvekkil Açısından Sonuç --</option><option value="favorable">Lehe</option><option value="partially_favorable">Kısmen Lehe / Kısmen Aleyhe</option><option value="unfavorable">Aleyhe</option></select>`}
        <div class="lit-decision-warning">Karar sonucu kullanıcı tarafından set edilir. Sistem evrak metninden karar yönü tahmin etmez.</div>`;
      const ds=document.getElementById('litigationDecisionResultSelect');if(ds&&known)ds.onchange=()=>{const o=mapFirstInstanceClientOutcome(role,ds.value);const e=document.getElementById('litigationComputedClientOutcome');if(e)e.textContent=clientOutcomeLabel(o);this.updateCalculatedDeadline();};
      document.getElementById('litigationDecisionClientOutcomeFallbackSelect')?.addEventListener('change',()=>this.updateCalculatedDeadline());return;
    }
    w.innerHTML=`<label class="custom-label"><i class="fas fa-balance-scale mr-1"></i>Kararın Müvekkil Açısından Sonucu</label>
      <select id="litigationClientOutcomeSelect" class="form-control shadow-sm"><option value="">-- Sonucu Seçiniz --</option><option value="favorable">Lehe</option><option value="partially_favorable">Kısmen Lehe / Kısmen Aleyhe</option><option value="unfavorable">Aleyhe</option></select>
      <div class="lit-decision-result"><strong>Aşama:</strong> ${esc(stageLabel(stage))} · <strong>Aşamayı başlatan:</strong> ${esc(initiatorLabel(initiator))}</div>
      <div class="lit-decision-warning">Sonuç müvekkil açısından kullanıcı tarafından set edilir. Sistem ilam metninden otomatik sonuç çıkarmaz.</div>`;
    document.getElementById('litigationClientOutcomeSelect')?.addEventListener('change',()=>this.updateCalculatedDeadline());
  };

  proto._getLitigationDecisionContextFromUi=function(childTypeId,parentTx){
    const t=typeObject(this,childTypeId);const stage=parentTx?stageKeyFromParentType(parentTx.transaction_type_id):null;const base={valid:true,stage,decisionResult:null,clientOutcome:null,stageInitiator:parentTx?.suit_context?.stage_initiator||null};
    if(suitEventKind(t)!=='decision')return base;
    const cfg=parseJsonObject(t?.suit_decision_config??t?.suitDecisionConfig);
    if(String(cfg.mode)==='role_mapped_first_instance'){
      const result=document.getElementById('litigationDecisionResultSelect')?.value||'';if(!result)return{...base,valid:false,error:'Karar sonucunu seçin.'};
      const role=normRole(this.matchedSuit?.client_role || this.matchedSuit?.clientRole);let outcome=mapFirstInstanceClientOutcome(role,result);if(!outcome)outcome=document.getElementById('litigationDecisionClientOutcomeFallbackSelect')?.value||'';
      if(!outcome)return{...base,valid:false,error:'Kararın müvekkil açısından sonucunu seçin.'};return{...base,decisionResult:result,clientOutcome:outcome};
    }
    const outcome=document.getElementById('litigationClientOutcomeSelect')?.value||'';if(!outcome)return{...base,valid:false,error:'Kararın müvekkil açısından sonucunu seçin.'};return{...base,clientOutcome:outcome};
  };

  proto._handleLitigationIndexingSave=async function(){
    const suit=this.matchedSuit;const suitId=suit?.id?String(suit.id):null;const parentTxId=document.getElementById('parentTransactionSelect')?.value||'';const childTypeId=document.getElementById('detectedType')?.value||'';const deliveryRaw=document.getElementById('detectedDate')?.value||'';const notes=document.getElementById('transactionNotes')?.value?.trim()||'';const selectedSuitStatus=document.getElementById('litigationStatusSelect')?.value||'';const previousSuitStatus=suit?.status||null;
    if(selectedSuitStatus&&!isValidLitigationStatus(selectedSuitStatus)){showNotification('Seçilen dava durumu geçerli değil.','error');return;}
    if(!suitId){showNotification('Dava kaydı bulunamadı.','error');return;}
    if(!parentTxId||!childTypeId||!deliveryRaw){showNotification('Lütfen dava ana işlemini, gelen evrak türünü ve tebliğ tarihini seçin.','error');return;}
    const deliveryIso=toIsoDate(deliveryRaw);if(!deliveryIso){showNotification('Tebliğ tarihi geçerli değil.','error');return;}
    const parent=(this.currentTransactions||[]).find(tx=>String(tx.id)===String(parentTxId));if(!parent){showNotification('Seçilen dava ana işlemi bulunamadı.','error');return;}
    if(parent.ip_record_id&&String(parent.ip_record_id)!==suitId){showNotification('Güvenlik kontrolü başarısız: Ana işlem başka bir kayda bağlı.','error');return;}
    const childType=typeObject(this,childTypeId);if(!canUseIncomingType(this,childType,parent,this.currentTransactions)){showNotification('Seçilen evrak türü mevcut yargılama aşamasında kullanılamaz.','error');return;}
    const currentStage=stageKeyFromParentType(parent.transaction_type_id);const transition=stageTransitionOnIndex(childType);let newStageTypeId=null;let effectiveStage=currentStage;let effectiveParentTxId=String(parentTxId);let stageParentContext=parseJsonObject(parent.suit_context);
    if(transition){const previous=transitionPreviousStage(transition);if(currentStage===previous){const target=transitionTargetType(transition);if(findDirectStageChild(this.currentTransactions,parent.id,target)){showNotification(`${stageLabel(transition)} aşaması zaten mevcut. Lütfen aktif aşamayı seçerek devam edin.`,'warning');return;}newStageTypeId=target;effectiveStage=transition;}else if(currentStage===transition){effectiveStage=currentStage;}else{showNotification(`Bu evrak ${stageLabel(transition)} aşamasını başlatamaz; seçili parent ${stageLabel(currentStage)} aşamasındadır.`,'error');return;}}
    const decision=this._getLitigationDecisionContextFromUi(childTypeId,parent);if(!decision.valid){showNotification(decision.error||'Karar sonucu eksik.','warning');return;}
    const pdfUrl=this.pdfData?.fileUrl||this.pdfData?.file_url||this.pdfData?.downloadURL||this.pdfData?.download_url||null;if(!pdfUrl){showNotification('Gelen PDF bağlantısı bulunamadı. İşlem kaydedilmedi.','error');return;}
    const saveBtn=document.getElementById('saveTransactionBtn');if(saveBtn){saveBtn.disabled=true;saveBtn.innerHTML='<i class="fas fa-spinner fa-spin mr-2"></i>Dava Evrakı Kaydediliyor...';}
    let createdTx=null,createdStage=null,statusChanged=false,existingContextChanged=false,previousExistingContext=null;
    try{
      const childName=childType.alias||childType.name||`Dava Evrakı ${childTypeId}`;
      if(newStageTypeId){
        const stageResult=await this._addTransaction(suitId,{type:String(newStageTypeId),transactionHierarchy:'parent',parentId:String(parentTxId),description:stageLabel(effectiveStage),date:deliveryIso,taskId:null,notes:[`[Yargılama Aşaması Başlatıldı: ${stageLabel(effectiveStage)}]`,'[Başlatan: Karşı Taraf]',`[Kaynak Evrak: ${childName}]`,`[Önceki Parent: ${parentTxId}]`,'[Varlık Türü: suit]'].join('\n'),documents:[]});
        if(!stageResult?.success||!stageResult?.id)throw new Error(stageResult?.error||`${stageLabel(effectiveStage)} parent transaction oluşturulamadı.`);
        createdStage=String(stageResult.id);effectiveParentTxId=createdStage;stageParentContext={stage:effectiveStage,stage_initiator:'opponent',transition_source:'opponent_filing',source_document_id:String(this.pdfId||''),source_incoming_type:String(childTypeId),previous_stage:currentStage,previous_stage_parent_id:String(parentTxId)};
        const {error}=await supabase.from('transactions').update({suit_context:stageParentContext}).eq('id',createdStage);if(error)throw new Error(`Yeni stage context kaydedilemedi: ${error.message}`);
      }else if(transition&&currentStage===transition){
        previousExistingContext=parseJsonObject(parent.suit_context);stageParentContext={...previousExistingContext,stage:currentStage,stage_initiator:mergeInitiator(previousExistingContext.stage_initiator,'opponent'),last_transition_source:'opponent_filing',last_source_document_id:String(this.pdfId||'')};
        const {error}=await supabase.from('transactions').update({suit_context:stageParentContext}).eq('id',String(parentTxId));if(error)throw new Error(`Stage başlatan bilgisi güncellenemedi: ${error.message}`);existingContextChanged=true;
      }
      const tags=[`[Kaynak İşlem: ${newStageTypeId||parent.transaction_type_id}]`,`[Yargılama Aşaması: ${stageLabel(effectiveStage)}]`,'[Varlık Türü: suit]'];if(transition)tags.push('[Aşama Geçiş Kaynağı: Karşı Taraf Dilekçesi]');if(decision.decisionResult)tags.push(`[Karar Sonucu: ${decisionResultLabel(decision.decisionResult)}]`);if(decision.clientOutcome)tags.push(`[Müvekkil Açısından: ${clientOutcomeLabel(decision.clientOutcome)}]`);if(selectedSuitStatus&&selectedSuitStatus!==previousSuitStatus)tags.push(`[Dava Statüsü: ${previousSuitStatus||'-'} -> ${selectedSuitStatus}]`);const systemNote=[notes,...tags].filter(Boolean).join('\n');
      const txResult=await this._addTransaction(suitId,{type:String(childTypeId),transactionHierarchy:'child',parentId:String(effectiveParentTxId),description:childName,date:deliveryIso,taskId:null,notes:systemNote,documents:[{name:this.pdfData?.fileName||this.pdfData?.file_name||'Mahkeme Evrakı.pdf',url:pdfUrl,documentDesignation:childName}]});
      if(!txResult?.success||!txResult?.id)throw new Error(txResult?.error||'Dava child transaction kaydı oluşturulamadı.');createdTx=String(txResult.id);
      const childContext={stage:effectiveStage,stage_initiator:stageParentContext.stage_initiator||null,parent_stage_transaction_id:String(effectiveParentTxId)};if(transition){childContext.transition_source='opponent_filing';childContext.transition_target_stage=transition;}if(decision.decisionResult)childContext.decision_result=decision.decisionResult;if(decision.clientOutcome)childContext.client_outcome=decision.clientOutcome;
      {const {error}=await supabase.from('transactions').update({suit_context:childContext}).eq('id',createdTx);if(error)throw new Error(`Dava transaction context kaydedilemedi: ${error.message}`);}
      if(selectedSuitStatus&&selectedSuitStatus!==previousSuitStatus){const {error}=await supabase.from('suits').update({status:selectedSuitStatus,updated_at:new Date().toISOString()}).eq('id',suitId);if(error)throw new Error(`Dava durumu güncellenemedi: ${error.message}`);statusChanged=true;if(this.matchedSuit)this.matchedSuit.status=selectedSuitStatus;}
      {const {error}=await supabase.from('incoming_documents').update({status:'litigation_indexed',indexed_at:new Date().toISOString(),created_transaction_id:createdTx,ip_record_id:suitId,transaction_type_id:String(childTypeId),teblig_tarihi:deliveryIso}).eq('id',String(this.pdfId));if(error)throw new Error(`Gelen evrak kaydı güncellenemedi: ${error.message}`);}
      if(this.pdfData){this.pdfData.status='litigation_indexed';this.pdfData.ip_record_id=suitId;this.pdfData.matchedRecordId=suitId;this.pdfData.created_transaction_id=createdTx;this.pdfData.transaction_type_id=String(childTypeId);}
      if(saveBtn){saveBtn.disabled=true;saveBtn.classList.remove('btn-primary','btn-secondary');saveBtn.classList.add('btn-success');saveBtn.innerHTML='<i class="fas fa-check-circle mr-2"></i>Dava Evrakı İndekslendi';}
      const statusMsg=selectedSuitStatus&&selectedSuitStatus!==previousSuitStatus?` Dava durumu "${litigationStatusLabel(selectedSuitStatus)}" olarak güncellendi.`:'';const stageMsg=createdStage?` Yeni ${stageLabel(effectiveStage)} aşaması karşı taraf dilekçesi ile oluşturuldu.`:'';const decisionMsg=decision.clientOutcome?` Karar sonucu: ${clientOutcomeLabel(decision.clientOutcome)}.`:'';showNotification(`${childName} dava dosyasına başarıyla bağlandı.${stageMsg}${decisionMsg}${statusMsg}`,'success');
      if(existingContextChanged){const lp=(this.currentTransactions||[]).find(tx=>String(tx.id)===String(parentTxId));if(lp)lp.suit_context=stageParentContext;}
      const adds=[];if(createdStage)adds.push({id:createdStage,ip_record_id:suitId,transaction_type_id:String(newStageTypeId),transaction_hierarchy:'parent',parent_id:String(parentTxId),description:stageLabel(effectiveStage),note:`[Yargılama Aşaması Başlatıldı: ${stageLabel(effectiveStage)}]`,transaction_date:deliveryIso,task_id:null,suit_context:stageParentContext,created_at:new Date().toISOString()});adds.push({id:createdTx,ip_record_id:suitId,transaction_type_id:String(childTypeId),transaction_hierarchy:'child',parent_id:String(effectiveParentTxId),description:childName,note:systemNote,transaction_date:deliveryIso,task_id:null,suit_context:childContext,created_at:new Date().toISOString()});this.currentTransactions=[...(this.currentTransactions||[]),...adds];this._refreshLitigationStageControl();
    }catch(error){
      console.error('[LITIGATION AŞAMA 8C-2] Save hatası:',error);
      if(statusChanged){try{await supabase.from('suits').update({status:previousSuitStatus,updated_at:new Date().toISOString()}).eq('id',suitId);if(this.matchedSuit)this.matchedSuit.status=previousSuitStatus;}catch(e){console.warn('[LITIGATION 8C-2] Status rollback:',e);}}
      if(createdTx){await this._rollbackLitigationTransaction(createdTx);createdTx=null;}
      if(createdStage){await this._rollbackLitigationTransaction(createdStage);createdStage=null;}
      if(existingContextChanged){try{await supabase.from('transactions').update({suit_context:previousExistingContext||{}}).eq('id',String(parentTxId));}catch(e){console.warn('[LITIGATION 8C-2] Context rollback:',e);}}
      showNotification(`Dava indeksleme hatası: ${error.message||error}`,'error');if(saveBtn){saveBtn.disabled=false;saveBtn.classList.remove('btn-success','btn-secondary');saveBtn.classList.add('btn-primary');saveBtn.innerHTML='<i class="fas fa-gavel mr-2"></i>Dava Evrakını İndeksle';}
    }
  };
}
ensurePatchStyles();
console.log('[LITIGATION AŞAMA 8C-2] DB-driven stage/decision indexing patch aktif.');
})();
/* IPGATE: END CONSOLIDATED DB-DRIVEN LITIGATION INDEXING */

