// public/js/indexing/litigation-indexing-write.js
// IPGate Dava Yönetimi - AŞAMA 7
// Baz: AŞAMA 4 güvenli dava write branch.
// Ek: indeksleme sırasında kullanıcı kontrollü dava statüsü seçimi.
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

            const parents = this.currentTransactions
                .filter((tx) => {
                    const hierarchy = String(
                        tx.transaction_hierarchy || 'parent'
                    ).toLowerCase();

                    const typeId = String(tx.transaction_type_id || '');

                    return (
                        hierarchy === 'parent' &&
                        Object.prototype.hasOwnProperty.call(
                            LITIGATION_PARENT_CHILD_MAP,
                            typeId
                        )
                    );
                })
                .sort((a, b) => {
                    const da = new Date(a.transaction_date || a.created_at || 0);
                    const db = new Date(b.transaction_date || b.created_at || 0);
                    return db.getTime() - da.getTime();
                });

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
                    `${typeName(this, typeId)}${dateText ? ` (${dateText})` : ''}`;

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

            // Tek parent varsa kullanıcı deneyimi için otomatik seç.
            if (parents.length === 1) {
                parentSelect.value = String(parents[0].id);
                this.updateChildTransactionOptions();
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

        const parentTypeId = String(parentTx.transaction_type_id || '');
        const allowedIds = LITIGATION_PARENT_CHILD_MAP[parentTypeId] || [];

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
            deadline.value = 'Görev / son tarih aşaması henüz kapalı';
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

        const parentTypeId = String(parentTx.transaction_type_id || '');
        const allowedChildIds =
            LITIGATION_PARENT_CHILD_MAP[parentTypeId] || [];

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

        let createdTransactionId = null;

        try {
            const childName =
                childTypeObj.alias ||
                childTypeObj.name ||
                `Dava Evrakı ${childTypeId}`;

            let systemNote = notes;

            const systemTags = [
                `[Kaynak İşlem: ${parentTypeId}]`,
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

            // Storage taşıma bu aşamada özellikle yapılmıyor.
            // Böylece incoming_documents update başarısız olursa dosya yolu bozulmuyor.
            const txResult = await this._addTransaction(suitId, {
                type: String(childTypeId),
                transactionHierarchy: 'child',
                parentId: String(parentTxId),
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

            showNotification(
                `${childName} dava dosyasına başarıyla bağlandı.${statusMessage}`,
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

            this.currentTransactions = [
                ...(this.currentTransactions || []),
                {
                    id: createdTransactionId,
                    ip_record_id: suitId,
                    transaction_type_id: String(childTypeId),
                    transaction_hierarchy: 'child',
                    parent_id: String(parentTxId),
                    description: childName,
                    note: systemNote,
                    transaction_date: deliveryIso,
                    task_id: null,
                    created_at: new Date().toISOString()
                }
            ];

        } catch (error) {
            console.error('[LITIGATION AŞAMA 4] Save hatası:', error);

            if (createdTransactionId) {
                await this._rollbackLitigationTransaction(
                    createdTransactionId
                );
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
