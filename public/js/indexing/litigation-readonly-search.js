// public/js/indexing/litigation-readonly-search.js
// IPGate Dava Yönetimi - AŞAMA 3
//
// Bu modül mevcut document-review-manager.js dosyasına dokunmadan,
// yalnız dava dosyalarının arama/seçim katmanını ekler.
//
// KRİTİK:
// - DAVAYA YAZMA YAPMAZ.
// - incoming_documents güncellemez.
// - transaction oluşturmaz.
// - task tetiklemez.
// - mail tetiklemez.
// - Dava seçiliyken "İndekslemeyi Tamamla" fiziksel olarak disabled olur.
// - handleSave() ayrıca ikinci güvenlik katmanı olarak engellenir.

import { DocumentReviewManager } from './document-review-manager.js';
import { SuitRecordMatcher } from './suit-record-matcher.js';
import { supabase } from '../../supabase-config.js';
import { showNotification, formatToTRDate } from '../../utils.js';

const proto = DocumentReviewManager.prototype;
const suitMatcher = new SuitRecordMatcher();

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function relationOne(value) {
    if (!value) return null;
    return Array.isArray(value) ? (value[0] || null) : value;
}

function addStage3Styles() {
    if (document.getElementById('litigationIndexingStage3Styles')) return;

    const style = document.createElement('style');
    style.id = 'litigationIndexingStage3Styles';
    style.textContent = `
        .litigation-search-section {
            padding: 7px 12px;
            background: #fff7ed;
            border-top: 1px solid #fed7aa;
            border-bottom: 1px solid #fed7aa;
            font-size: .72rem;
            font-weight: 800;
            color: #9a3412;
            letter-spacing: .04em;
            text-transform: uppercase;
        }

        .litigation-search-result {
            background: #fffbf5;
        }

        .litigation-search-result:hover {
            background: #fff3e4 !important;
        }

        .litigation-search-icon {
            width: 34px;
            height: 34px;
            border-radius: 50%;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: #fff0db;
            color: #b45309;
            flex: 0 0 34px;
        }

        .litigation-readonly-badge {
            display: inline-flex;
            align-items: center;
            padding: 4px 8px;
            border-radius: 999px;
            background: #fff7ed;
            border: 1px solid #fed7aa;
            color: #9a3412;
            font-size: .72rem;
            font-weight: 800;
            white-space: nowrap;
        }

        #litigationReadOnlyNotice {
            border-radius: 10px;
            border: 1px solid #f5c46b;
            background: #fff8e8;
            color: #7c5200;
        }

        #litigationReadonlyParentSummary {
            border-radius: 8px;
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            padding: 10px 12px;
            margin-top: 8px;
        }

        #litigationReadonlyParentSummary ul {
            padding-left: 18px;
            margin: 6px 0 0;
        }

        #litigationReadonlyParentSummary li {
            margin-bottom: 4px;
        }
    `;

    document.head.appendChild(style);
}

if (!proto.__litigationIndexingStage3Patched) {
    Object.defineProperty(proto, '__litigationIndexingStage3Patched', {
        value: true,
        writable: false,
        configurable: false,
        enumerable: false
    });

    const originalLoadAllRecords = proto.loadAllRecords;
    const originalHandleManualSearch = proto.handleManualSearch;
    const originalSelectRecord = proto.selectRecord;
    const originalRenderHeader = proto.renderHeader;
    const originalHandleSave = proto.handleSave;

    proto.loadAllRecords = async function() {
        // Mevcut IP portföy yüklemesi aynen çalışır.
        await originalLoadAllRecords.call(this);

        try {
            const { data: suits, error: suitsError } = await supabase
                .from('suits')
                .select(`
                    id,
                    title,
                    file_no,
                    court_name,
                    description,
                    suit_type,
                    status,
                    origin,
                    opening_date,
                    client_role,
                    opposing_party,
                    opposing_counsel,
                    client_id,
                    ip_record_id,
                    task_id,
                    transaction_type_id,
                    created_at,
                    updated_at
                `)
                .order('updated_at', { ascending: false });

            if (suitsError) throw suitsError;

            const rows = suits || [];

            const clientIds = [
                ...new Set(
                    rows
                        .map((row) => row.client_id)
                        .filter(Boolean)
                        .map(String)
                )
            ];

            const clientMap = new Map();

            if (clientIds.length > 0) {
                const { data: persons, error: personsError } = await supabase
                    .from('persons')
                    .select('id, name')
                    .in('id', clientIds);

                if (personsError) {
                    console.warn(
                        '[LITIGATION AŞAMA 3] Müvekkil adları okunamadı:',
                        personsError
                    );
                } else {
                    (persons || []).forEach((person) => {
                        clientMap.set(String(person.id), person.name || '-');
                    });
                }
            }

            // Taraf isimleri yalnız arama zenginleştirmesi içindir.
            const { data: parties, error: partiesError } = await supabase
                .from('suit_parties')
                .select(`
                    suit_id,
                    role,
                    person_id,
                    free_text_name,
                    persons (name)
                `);

            if (partiesError) {
                console.warn(
                    '[LITIGATION AŞAMA 3] Dava tarafları okunamadı:',
                    partiesError
                );
            }

            const partyMap = new Map();

            for (const party of (parties || [])) {
                const sid = String(party.suit_id || '');
                if (!sid) continue;

                const person = relationOne(party.persons);
                const partyName =
                    person?.name ||
                    party.free_text_name ||
                    null;

                if (!partyName) continue;

                if (!partyMap.has(sid)) partyMap.set(sid, []);

                const list = partyMap.get(sid);
                if (!list.includes(partyName)) list.push(partyName);
            }

            this.allSuits = rows.map((suit) => ({
                ...suit,
                entityType: 'suit',
                _clientName:
                    suit.client_id
                        ? (clientMap.get(String(suit.client_id)) || '-')
                        : '-',
                _partyNames: partyMap.get(String(suit.id)) || []
            }));

        } catch (error) {
            // Fail-open: dava araması çalışmazsa mevcut IP indeksleme akışı etkilenmez.
            console.warn(
                '[LITIGATION AŞAMA 3] Dava listesi yüklenemedi. Mevcut IP akışı korunuyor:',
                error
            );
            this.allSuits = [];
        }
    };

    proto.handleManualSearch = async function(query) {
        // Önce mevcut marka/patent/tasarım aramasını aynen çalıştır.
        await originalHandleManualSearch.call(this, query);

        const container = document.getElementById('manualSearchResults');
        if (!container) return;

        const rawQuery = String(query || '').trim();
        if (rawQuery.length < 3) return;

        const suitMatches = suitMatcher.findMatches(
            rawQuery,
            this.allSuits || [],
            10
        );

        if (suitMatches.length === 0) return;

        // Orijinal arama "Sonuç bulunamadı" yazdıysa, dava sonucu bulunduğu için kaldır.
        [...container.children].forEach((child) => {
            const text = String(child.textContent || '')
                .toLocaleLowerCase('tr-TR')
                .trim();

            if (text.includes('sonuç bulunamadı')) {
                child.remove();
            }
        });

        const section = document.createElement('div');
        section.className = 'litigation-search-section';
        section.innerHTML =
            '<i class="fas fa-gavel mr-1"></i>Dava Dosyaları · Salt Okunur';

        container.appendChild(section);

        for (const suit of suitMatches) {
            const item = document.createElement('div');
            item.className =
                'search-result-item litigation-search-result d-flex align-items-center';
            item.dataset.suitId = String(suit.id);

            const partyPreview = (suit._partyNames || []).slice(0, 2).join(', ');
            const clientName = suit._clientName || '-';

            item.innerHTML = `
                <span class="litigation-search-icon mr-2">
                    <i class="fas fa-gavel"></i>
                </span>

                <div class="flex-grow-1 overflow-hidden">
                    <div class="d-flex align-items-center flex-wrap" style="gap:6px;">
                        <span class="font-weight-bold text-dark">
                            ${escapeHtml(suit.file_no || suit.title || 'Dava Dosyası')}
                        </span>
                        <span class="litigation-readonly-badge">
                            <i class="fas fa-lock mr-1"></i>DAVA
                        </span>
                    </div>

                    <div class="small text-muted text-truncate">
                        ${escapeHtml(suit.court_name || 'Mahkeme belirtilmemiş')}
                        · ${escapeHtml(suit.suit_type || 'Dava')}
                    </div>

                    <div class="small text-muted text-truncate">
                        <i class="fas fa-user-tie mr-1"></i>
                        Müvekkil: ${escapeHtml(clientName)}
                        ${
                            partyPreview
                                ? ` · Taraflar: ${escapeHtml(partyPreview)}`
                                : ''
                        }
                    </div>
                </div>
            `;

            item.addEventListener('click', async () => {
                await this.selectSuitReadOnly(suit);
                container.style.display = 'none';
            });

            container.appendChild(item);
        }

        container.style.display = 'block';
    };

    proto._setSuitReadOnlyUi = function(enabled) {
        const analysisResults = document.getElementById('analysisResults');

        if (enabled) {
            if (!this._litigationStage3UiSnapshot) {
                const saveBtn = document.getElementById('saveTransactionBtn');
                const detectedDate = document.getElementById('detectedDate');
                const parentSelect = document.getElementById('parentTransactionSelect');
                const childSelect = document.getElementById('detectedType');
                const notes = document.getElementById('transactionNotes');

                this._litigationStage3UiSnapshot = {
                    saveBtn: saveBtn
                        ? {
                            html: saveBtn.innerHTML,
                            className: saveBtn.className,
                            disabled: saveBtn.disabled
                        }
                        : null,
                    detectedDateDisabled: detectedDate?.disabled ?? false,
                    parentDisabled: parentSelect?.disabled ?? false,
                    childDisabled: childSelect?.disabled ?? true,
                    notesDisabled: notes?.disabled ?? false
                };
            }

            let notice = document.getElementById('litigationReadOnlyNotice');

            if (!notice && analysisResults) {
                notice = document.createElement('div');
                notice.id = 'litigationReadOnlyNotice';
                notice.className = 'alert mb-4';
                notice.innerHTML = `
                    <i class="fas fa-lock mr-2"></i>
                    <strong>Dava dosyası seçildi.</strong><br>
                    <small>
                        Aşama 3 yalnız arama ve eşleştirme kontrolüdür.
                        Bu ekrandan davaya transaction yazma henüz kapalıdır.
                    </small>
                `;
                analysisResults.insertBefore(notice, analysisResults.firstChild);
            }

            const saveBtn = document.getElementById('saveTransactionBtn');
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.classList.remove('btn-primary', 'btn-success');
                saveBtn.classList.add('btn-secondary');
                saveBtn.innerHTML =
                    '<i class="fas fa-lock mr-2"></i>Dava İndeksleme Yazması Kapalı';
            }

            const detectedDate = document.getElementById('detectedDate');
            if (detectedDate) detectedDate.disabled = true;

            const parentSelect = document.getElementById('parentTransactionSelect');
            if (parentSelect) parentSelect.disabled = true;

            const childSelect = document.getElementById('detectedType');
            if (childSelect) {
                childSelect.disabled = true;
                childSelect.innerHTML =
                    '<option value="">-- Aşama 4\'te aktif edilecek --</option>';
            }

            const notes = document.getElementById('transactionNotes');
            if (notes) notes.disabled = true;

            const deadline = document.getElementById('calculatedDeadlineDisplay');
            if (deadline) deadline.value = '';

            const opposition = document.getElementById('oppositionSection');
            if (opposition) opposition.style.display = 'none';

            const proof = document.getElementById('proofOfUseSection');
            if (proof) proof.style.display = 'none';

            const registry = document.getElementById('registry-editor-section');
            if (registry) registry.style.display = 'none';

        } else {
            const notice = document.getElementById('litigationReadOnlyNotice');
            if (notice) notice.remove();

            const summary = document.getElementById('litigationReadonlyParentSummary');
            if (summary) summary.remove();

            const snapshot = this._litigationStage3UiSnapshot;

            if (snapshot) {
                const saveBtn = document.getElementById('saveTransactionBtn');
                if (saveBtn && snapshot.saveBtn) {
                    saveBtn.innerHTML = snapshot.saveBtn.html;
                    saveBtn.className = snapshot.saveBtn.className;
                    saveBtn.disabled = snapshot.saveBtn.disabled;
                }

                const detectedDate = document.getElementById('detectedDate');
                if (detectedDate) {
                    detectedDate.disabled = snapshot.detectedDateDisabled;
                }

                const parentSelect = document.getElementById('parentTransactionSelect');
                if (parentSelect) {
                    parentSelect.disabled = snapshot.parentDisabled;
                }

                const childSelect = document.getElementById('detectedType');
                if (childSelect) {
                    childSelect.disabled = true;
                    childSelect.innerHTML =
                        '<option value="">-- Önce Ana İşlem Seçiniz --</option>';
                }

                const notes = document.getElementById('transactionNotes');
                if (notes) {
                    notes.disabled = snapshot.notesDisabled;
                }
            } else {
                const saveBtn = document.getElementById('saveTransactionBtn');
                if (saveBtn) saveBtn.disabled = false;

                const detectedDate = document.getElementById('detectedDate');
                if (detectedDate) detectedDate.disabled = false;

                const parentSelect = document.getElementById('parentTransactionSelect');
                if (parentSelect) parentSelect.disabled = false;

                const notes = document.getElementById('transactionNotes');
                if (notes) notes.disabled = false;
            }

            this._litigationStage3UiSnapshot = null;
        }
    };

    proto.selectSuitReadOnly = async function(suit) {
        if (!suit?.id) return;

        this.matchedEntityType = 'suit';
        this.matchedSuit = suit;

        // matchedRecord yalnız mevcut header altyapısının seçim var kabul etmesi için
        // pseudo-record olarak tutulur. handleSave aşağıda ayrıca engellenir.
        this.matchedRecord = {
            id: String(suit.id),
            entityType: 'suit',
            ipType: 'suit',
            title: suit.title || suit.file_no || 'Dava Dosyası',
            applicationNumber: suit.file_no || '',
            application_number: suit.file_no || '',
            resolvedNames: suit._clientName || '-',
            court_name: suit.court_name || null,
            client_id: suit.client_id || null,
            client_role: suit.client_role || null
        };

        const searchInput = document.getElementById('manualSearchInput');
        if (searchInput) {
            searchInput.value =
                suit.file_no ||
                suit.title ||
                '';
        }

        this._setSuitReadOnlyUi(true);
        this.renderHeader();

        await this.loadSuitParentTransactionsReadOnly(String(suit.id));

        showNotification(
            `Dava dosyası seçildi: ${suit.file_no || suit.title || suit.id}. Bu aşamada salt okunur.`,
            'info'
        );

        // Bilinçli olarak "record-selected" eventi YAYINLANMAZ.
        // portfolio-update-manager bu kaydı ip_records sanmamalıdır.
    };

    proto.loadSuitParentTransactionsReadOnly = async function(suitId) {
        const parentSelect = document.getElementById('parentTransactionSelect');
        if (!parentSelect) return;

        const oldSummary = document.getElementById('litigationReadonlyParentSummary');
        if (oldSummary) oldSummary.remove();

        parentSelect.disabled = true;
        parentSelect.innerHTML =
            '<option value="">Dava işlemleri okunuyor...</option>';

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

            const parents = this.currentTransactions.filter((tx) => {
                const hierarchy = String(
                    tx.transaction_hierarchy || 'parent'
                ).toLowerCase();

                return hierarchy === 'parent';
            });

            parentSelect.innerHTML = `
                <option value="">
                    ${parents.length} ana işlem bulundu · salt okunur
                </option>
            `;

            const summary = document.createElement('div');
            summary.id = 'litigationReadonlyParentSummary';
            summary.className = 'small text-muted';

            if (parents.length === 0) {
                summary.innerHTML =
                    '<i class="fas fa-info-circle mr-1"></i>Bu dava dosyasında parent transaction bulunamadı.';
            } else {
                const listHtml = parents.map((tx) => {
                    const typeObj = (this.allTransactionTypes || []).find(
                        (type) =>
                            String(type.id) ===
                            String(tx.transaction_type_id)
                    );

                    const label =
                        typeObj?.alias ||
                        typeObj?.name ||
                        tx.description ||
                        `İşlem ${tx.transaction_type_id || ''}`;

                    const dateText = formatToTRDate(
                        tx.transaction_date || tx.created_at
                    );

                    return `
                        <li>
                            <strong>${escapeHtml(label)}</strong>
                            ${dateText ? ` · ${escapeHtml(dateText)}` : ''}
                        </li>
                    `;
                }).join('');

                summary.innerHTML = `
                    <div>
                        <i class="fas fa-folder-open mr-1"></i>
                        <strong>Mevcut dava ana işlemleri:</strong>
                    </div>
                    <ul>${listHtml}</ul>
                `;
            }

            parentSelect.insertAdjacentElement('afterend', summary);

        } catch (error) {
            console.warn(
                '[LITIGATION AŞAMA 3] Dava transaction geçmişi okunamadı:',
                error
            );

            parentSelect.innerHTML =
                '<option value="">Dava işlemleri okunamadı</option>';
        }
    };

    proto.renderHeader = function() {
        if (this.matchedEntityType !== 'suit' || !this.matchedSuit) {
            return originalRenderHeader.call(this);
        }

        const suit = this.matchedSuit;

        const fileNameDisplay = document.getElementById('fileNameDisplay');
        if (fileNameDisplay) {
            fileNameDisplay.textContent =
                this.pdfData?.fileName ||
                'Dosya yükleniyor...';
        }

        const matchInfoEl = document.getElementById('matchInfoDisplay');
        if (!matchInfoEl) return;

        const clientName = suit._clientName || '-';
        const partyPreview = (suit._partyNames || []).join(', ') || '-';

        matchInfoEl.innerHTML = `
            <div class="d-flex align-items-center w-100">
                <div
                    class="mr-3 border rounded bg-white shadow-sm d-flex align-items-center justify-content-center"
                    style="width:70px;height:70px;flex:0 0 70px;"
                >
                    <i class="fas fa-gavel fa-2x text-warning"></i>
                </div>

                <div class="flex-grow-1 overflow-hidden">
                    <div class="d-flex align-items-center flex-wrap mb-1" style="gap:7px;">
                        <h6 class="mb-0 text-dark font-weight-bold">
                            ${escapeHtml(suit.file_no || suit.title || 'Dava Dosyası')}
                        </h6>
                        <span class="litigation-readonly-badge">
                            <i class="fas fa-lock mr-1"></i>DAVA · SALT OKUNUR
                        </span>
                    </div>

                    <div class="small text-dark mb-1">
                        <strong>Mahkeme:</strong>
                        ${escapeHtml(suit.court_name || '-')}
                    </div>

                    <div class="small text-muted text-truncate">
                        <i class="fas fa-user-tie mr-1"></i>
                        Müvekkil: ${escapeHtml(clientName)}
                    </div>

                    <div class="small text-muted text-truncate" title="${escapeHtml(partyPreview)}">
                        <i class="fas fa-users mr-1"></i>
                        Taraflar: ${escapeHtml(partyPreview)}
                    </div>
                </div>

                <div class="ml-2">
                    <a
                        href="suit-detail.html?id=${encodeURIComponent(String(suit.id))}"
                        target="_blank"
                        rel="noopener"
                        class="btn btn-sm btn-outline-warning"
                    >
                        <i class="fas fa-external-link-alt mr-1"></i>
                        Dava Detayı
                    </a>
                </div>
            </div>
        `;
    };

    proto.selectRecord = async function(recordId) {
        // Dava salt-okunur modundan normal IP moduna geri dön.
        if (this.matchedEntityType === 'suit') {
            this._setSuitReadOnlyUi(false);
        }

        this.matchedEntityType = 'ip_record';
        this.matchedSuit = null;

        return originalSelectRecord.call(this, recordId);
    };

    proto.handleSave = async function(...args) {
        if (this.matchedEntityType === 'suit') {
            showNotification(
                'Aşama 3 güvenlik kilidi: Dava dosyaları bu ekranda henüz yalnızca aranıp seçilebilir. Transaction yazma Aşama 4\'te açılacaktır.',
                'warning'
            );
            return;
        }

        return originalHandleSave.apply(this, args);
    };

    // Stiller modül yüklenirken eklenir; orijinal manager çalışmazsa bile zararsızdır.
    addStage3Styles();
}
