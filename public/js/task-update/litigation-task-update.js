// public/js/task-update/litigation-task-update.js
// IPGate Dava Yönetimi - AŞAMA 8D-3
//
// Amaç:
// - Yalnız mevcut bir suits kaydına bağlı dava work task'larında
//   task-update ekranını litigation mode'a çevirir.
// - Normal Marka/Patent/Tasarım task ekranına dokunmaz.
// - EPATS/TÜRKPATENT alanlarını dava işlerinde gizler.
// - Dava dosyası / mahkeme / taraflar / aktif stage bilgisini gösterir.
// - Genel belge alanını dava iş tipine göre yeniden adlandırır.
// - Veri modeli korunur: dosyalar mevcut task_documents akışında kalır.
//
// Not:
// Dava açılış tipi 49 mevcut özel akışında bırakılır.
// Bu modül yalnız suit_event_kind='work' olan mevcut dava işleri için çalışır.

import { supabase } from '../../supabase-config.js';

const STAGE_PARENT_TYPES = new Set([
    '49', '54', '55', '56', '57', '58',
    '59', '60'
]);

const TASK_DOCUMENT_LABELS = Object.freeze({
    '61': {
        title: 'Cevap Dilekçesi ve Ekleri',
        upload: 'Cevap Dilekçesi / Ek Yükle',
        note: 'Mahkemeye sunulacak cevap dilekçesi ve eklerini bu bölümden yönetin.'
    },
    '62': {
        title: 'Cevaba Cevap Dilekçesi ve Ekleri',
        upload: 'Cevaba Cevap Dilekçesi / Ek Yükle',
        note: 'Cevaba cevap dilekçesi ve ilgili ekleri bu bölümde tutulur.'
    },
    '63': {
        title: 'İkinci Cevap Dilekçesi ve Ekleri',
        upload: 'İkinci Cevap Dilekçesi / Ek Yükle',
        note: 'İkinci cevap dilekçesi ve ilgili ekleri bu bölümde tutulur.'
    },
    '64': {
        title: 'Delil Listesi / Beyan Evrakları',
        upload: 'Delil / Beyan Evrakı Yükle',
        note: 'Delil listesi, delil ekleri ve beyan evraklarını bu bölümden yönetin.'
    },
    '65': {
        title: 'Bilirkişi Raporuna Beyan / İtiraz Evrakları',
        upload: 'Beyan / İtiraz Dilekçesi Yükle',
        note: 'Bilirkişi raporuna ilişkin beyan, itiraz ve eklerini bu bölümden yönetin.'
    },
    '91': {
        title: 'Beyan / Talep Dilekçesi ve Ekleri',
        upload: 'Beyan / Talep Dilekçesi Yükle',
        note: 'Mahkemeye sunulacak beyan veya talep dilekçesi ve ekleri bu bölümde tutulur.'
    },
    '93': {
        title: 'İstinaf Başvuru Dilekçesi ve Ekleri',
        upload: 'İstinaf Dilekçesi / Ek Yükle',
        note: 'İstinaf başvuru dilekçesi ve eklerini yükleyin. İş tamamlandığında İstinaf aşaması sistem tarafından açılır.'
    },
    '94': {
        title: 'İstinafa Cevap Dilekçesi ve Ekleri',
        upload: 'İstinafa Cevap Dilekçesi / Ek Yükle',
        note: 'Karşı tarafın istinafına verilecek cevap dilekçesi ve eklerini bu bölümde yönetin.'
    },
    '96': {
        title: 'Temyiz Başvuru Dilekçesi ve Ekleri',
        upload: 'Temyiz Dilekçesi / Ek Yükle',
        note: 'Temyiz başvuru dilekçesi ve eklerini yükleyin. İş tamamlandığında Yargıtay aşaması sistem tarafından açılır.'
    },
    '97': {
        title: 'Temyize Cevap Dilekçesi ve Ekleri',
        upload: 'Temyize Cevap Dilekçesi / Ek Yükle',
        note: 'Karşı tarafın temyizine verilecek cevap dilekçesi ve eklerini bu bölümde yönetin.'
    }
});

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function parseObject(raw) {
    if (
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw)
    ) {
        return raw;
    }

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return (
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed)
            )
                ? parsed
                : {};
        } catch {
            return {};
        }
    }

    return {};
}

function stageKey(typeId) {
    const id = String(typeId || '');

    if (id === '60') return 'cassation';
    if (id === '59') return 'appeal';
    if (['49','54','55','56','57','58'].includes(id)) {
        return 'first_instance';
    }

    return null;
}

function stageRank(typeId) {
    const key = stageKey(typeId);
    if (key === 'cassation') return 3;
    if (key === 'appeal') return 2;
    if (key === 'first_instance') return 1;
    return 0;
}

function stageLabel(key) {
    if (key === 'cassation') return 'Yargıtay';
    if (key === 'appeal') return 'İstinaf';
    if (key === 'first_instance') return 'İlk Derece';
    return 'Belirlenemedi';
}

function initiatorLabel(value) {
    const raw = String(value || '').toLowerCase().trim();

    if (raw === 'client') return 'Müvekkil';
    if (raw === 'opponent') return 'Karşı Taraf';
    if (raw === 'both') return 'Her İki Taraf';

    return '-';
}

function roleLabel(value) {
    const raw = String(value || '')
        .toLocaleLowerCase('tr-TR')
        .trim();

    if (raw === 'davaci') return 'Davacı';
    if (raw === 'davali') return 'Davalı';
    if (raw === 'mudahil') return 'Müdahil';

    return value || '-';
}

function formatDate(value) {
    if (!value) return '-';

    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);

    return d.toLocaleDateString('tr-TR');
}

function injectStyles() {
    if (document.getElementById('litigationTaskUpdateStyles')) {
        return;
    }

    const style = document.createElement('style');
    style.id = 'litigationTaskUpdateStyles';
    style.textContent = `
        .lit-task-context-card {
            border-left: 5px solid #1e3c72 !important;
            overflow: hidden;
        }

        .lit-task-context-head {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 18px;
            flex-wrap: wrap;
        }

        .lit-task-stage-badge {
            display: inline-flex;
            align-items: center;
            padding: 6px 11px;
            border-radius: 999px;
            font-size: .72rem;
            font-weight: 800;
            background: #eef4ff;
            color: #1e3c72;
            border: 1px solid #bfd1f3;
            white-space: nowrap;
        }

        .lit-task-context-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 12px;
            margin-top: 15px;
        }

        .lit-task-context-item {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 11px;
            padding: 11px 12px;
            min-width: 0;
        }

        .lit-task-context-item span {
            display: block;
            color: #64748b;
            font-size: .7rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: .03em;
            margin-bottom: 3px;
        }

        .lit-task-context-item strong {
            display: block;
            color: #1f2937;
            font-size: .86rem;
            overflow-wrap: anywhere;
        }

        .lit-task-subject-box {
            margin-top: 12px;
            padding: 11px 12px;
            background: #fffaf0;
            border: 1px solid #fde3a7;
            border-radius: 11px;
            color: #5f4a16;
            font-size: .82rem;
        }

        .lit-task-doc-note {
            margin: 0 0 12px;
            padding: 10px 12px;
            border: 1px solid #bfdbfe;
            border-radius: 9px;
            background: #eff6ff;
            color: #1e40af;
            font-size: .78rem;
        }

        .lit-task-legacy-docs {
            margin-bottom: 12px;
            padding: 10px 12px;
            border: 1px solid #fde68a;
            border-radius: 9px;
            background: #fffbeb;
        }

        .lit-task-legacy-docs-title {
            color: #92400e;
            font-size: .76rem;
            font-weight: 800;
            margin-bottom: 6px;
        }

        .lit-task-legacy-docs a {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            margin: 3px 6px 3px 0;
            font-size: .75rem;
            font-weight: 700;
        }

        body.litigation-task-mode #oppositionWorkspaceCard {
            display: none !important;
        }

        @media (max-width: 900px) {
            .lit-task-context-grid {
                grid-template-columns: 1fr;
            }
        }
    `;
    document.head.appendChild(style);
}

class LitigationTaskUpdateView {
    constructor() {
        this.taskId = null;
        this.task = null;
        this.suit = null;
        this.taskType = null;
        this.stage = null;
        this.subjectAsset = null;
        this.client = null;
        this.taskDocuments = [];
        this.active = false;
    }

    async init() {
        injectStyles();

        const params = new URLSearchParams(
            window.location.search
        );

        this.taskId = params.get('id');

        if (!this.taskId) {
            return;
        }

        const task = await this.loadTask();

        if (!task) {
            return;
        }

        const suitId = String(
            task.ip_record_id ||
            task.relatedIpRecordId ||
            ''
        );

        if (!suitId) {
            return;
        }

        const suit = await this.loadSuit(
            suitId
        );

        if (!suit) {
            return;
        }

        const taskTypeId = String(
            task.task_type_id ||
            task.taskType ||
            ''
        );

        const taskType =
            await this.loadTaskType(
                taskTypeId
            );

        // Yeni dava dosyası açılış task'ları mevcut özel ekranında kalır.
        // 8D-3 yalnız mevcut suit üzerindeki work child task'larını dönüştürür.
        if (
            String(
                taskType?.suit_event_kind ||
                ''
            ) !== 'work'
        ) {
            return;
        }

        this.task = task;
        this.suit = suit;
        this.taskType = taskType;
        this.stage =
            await this.loadCurrentStage(
                suit.id
            );
        this.subjectAsset =
            await this.loadSubjectAsset(
                suit.ip_record_id
            );
        this.client =
            await this.loadClient(
                suit.client_id
            );
        this.taskDocuments =
            await this.loadTaskDocuments();

        this.active = true;

        await this.waitForTaskForm();

        this.applyLitigationMode();
    }

    async loadTask() {
        const { data, error } =
            await supabase
                .from('tasks')
                .select(`
                    id,
                    title,
                    description,
                    status,
                    priority,
                    task_type_id,
                    ip_record_id,
                    task_owner_id,
                    assigned_to,
                    official_due_date,
                    operational_due_date,
                    transaction_id,
                    details,
                    created_at,
                    updated_at
                `)
                .eq(
                    'id',
                    String(this.taskId)
                )
                .maybeSingle();

        if (error) {
            console.warn(
                '[8D-3] Task okunamadı:',
                error
            );
            return null;
        }

        return data || null;
    }

    async loadSuit(suitId) {
        const { data, error } =
            await supabase
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
                    transaction_type_id
                `)
                .eq(
                    'id',
                    String(suitId)
                )
                .maybeSingle();

        if (error) {
            console.warn(
                '[8D-3] Suit okunamadı:',
                error
            );
            return null;
        }

        return data || null;
    }

    async loadTaskType(typeId) {
        if (!typeId) return null;

        const { data, error } =
            await supabase
                .from('transaction_types')
                .select(`
                    id,
                    name,
                    alias,
                    ip_type,
                    suit_event_kind,
                    suit_stage_scope,
                    stage_transition_on_completion
                `)
                .eq(
                    'id',
                    String(typeId)
                )
                .maybeSingle();

        if (error) {
            console.warn(
                '[8D-3] Transaction type okunamadı:',
                error
            );
        }

        return data || null;
    }

    async loadCurrentStage(suitId) {
        const { data, error } =
            await supabase
                .from('transactions')
                .select(`
                    id,
                    transaction_type_id,
                    parent_id,
                    transaction_date,
                    created_at,
                    suit_context
                `)
                .eq(
                    'ip_record_id',
                    String(suitId)
                )
                .eq(
                    'transaction_hierarchy',
                    'parent'
                )
                .in(
                    'transaction_type_id',
                    [
                        '49','54','55','56',
                        '57','58','59','60'
                    ]
                );

        if (error) {
            console.warn(
                '[8D-3] Stage okunamadı:',
                error
            );
            return null;
        }

        const rows = [...(data || [])]
            .filter(
                (row) =>
                    STAGE_PARENT_TYPES.has(
                        String(
                            row.transaction_type_id
                        )
                    )
            )
            .sort(
                (a, b) => {
                    const rankDiff =
                        stageRank(
                            b.transaction_type_id
                        ) -
                        stageRank(
                            a.transaction_type_id
                        );

                    if (rankDiff !== 0) {
                        return rankDiff;
                    }

                    return (
                        new Date(
                            b.transaction_date ||
                            b.created_at ||
                            0
                        ).getTime() -
                        new Date(
                            a.transaction_date ||
                            a.created_at ||
                            0
                        ).getTime()
                    );
                }
            );

        const highest = rows[0] || null;

        if (!highest) {
            return null;
        }

        const ctx = parseObject(
            highest.suit_context
        );

        return {
            ...highest,
            stageKey:
                ctx.stage ||
                stageKey(
                    highest.transaction_type_id
                ),
            stageInitiator:
                ctx.stage_initiator ||
                null
        };
    }

    async loadSubjectAsset(ipRecordId) {
        if (!ipRecordId) {
            return null;
        }

        const { data, error } =
            await supabase
                .from('portfolio_list_view')
                .select('*')
                .eq(
                    'id',
                    String(ipRecordId)
                )
                .maybeSingle();

        if (error) {
            console.warn(
                '[8D-3] Subject asset okunamadı:',
                error
            );
        }

        return data || null;
    }

    async loadClient(clientId) {
        if (!clientId) {
            return null;
        }

        const { data, error } =
            await supabase
                .from('persons')
                .select(
                    'id, name, email'
                )
                .eq(
                    'id',
                    String(clientId)
                )
                .maybeSingle();

        if (error) {
            console.warn(
                '[8D-3] Client okunamadı:',
                error
            );
        }

        return data || null;
    }

    async loadTaskDocuments() {
        const { data, error } =
            await supabase
                .from('task_documents')
                .select(`
                    id,
                    document_name,
                    document_url,
                    document_type,
                    uploaded_at
                `)
                .eq(
                    'task_id',
                    String(this.taskId)
                )
                .order(
                    'uploaded_at',
                    { ascending: true }
                );

        if (error) {
            console.warn(
                '[8D-3] Task documents okunamadı:',
                error
            );
        }

        return data || [];
    }

    async waitForTaskForm() {
        for (
            let attempt = 0;
            attempt < 40;
            attempt++
        ) {
            const form =
                document.getElementById(
                    'taskDetailForm'
                );

            const taskIdField =
                document.getElementById(
                    'taskIdDisplay'
                );

            if (
                form &&
                taskIdField &&
                (
                    taskIdField.value ||
                    attempt > 12
                )
            ) {
                return;
            }

            await new Promise(
                (resolve) =>
                    setTimeout(
                        resolve,
                        100
                    )
            );
        }
    }

    subjectAssetText() {
        const row = this.subjectAsset;

        if (!row) {
            return this.suit.title || '-';
        }

        const title =
            row.brand_name ||
            row.title ||
            row.application_number ||
            row.registration_number ||
            '-';

        const number =
            row.application_number ||
            row.registration_number ||
            null;

        return number
            ? `${title} (${number})`
            : String(title);
    }

    workLabelConfig() {
        const id = String(
            this.task?.task_type_id ||
            ''
        );

        return (
            TASK_DOCUMENT_LABELS[id] ||
            {
                title: 'Dava Evrakları ve Dosyalar',
                upload: 'Dava Evrakı Yükle',
                note: 'Bu işe ilişkin dilekçe, beyan ve ekleri bu bölümden yönetin.'
            }
        );
    }

    hideGenericCards() {
        const ipCard =
            document
                .getElementById(
                    'relatedIpRecordSearch'
                )
                ?.closest(
                    '.premium-card'
                );

        const partyCard =
            document
                .getElementById(
                    'relatedPartySearch'
                )
                ?.closest(
                    '.premium-card'
                );

        const epatsCard =
            document
                .getElementById(
                    'epatsFileUploadArea'
                )
                ?.closest(
                    '.premium-card'
                );

        for (
            const card of
            [
                ipCard,
                partyCard,
                epatsCard
            ]
        ) {
            if (card) {
                card.style
                    .setProperty(
                        'display',
                        'none',
                        'important'
                    );
            }
        }

        const petitionOptions =
            document.getElementById(
                'petitionUploadOptions'
            );

        const petitionPanel =
            document.getElementById(
                'petitionReviewStatusPanel'
            );

        if (petitionOptions) {
            petitionOptions.style
                .setProperty(
                    'display',
                    'none',
                    'important'
                );
        }

        if (petitionPanel) {
            petitionPanel.style
                .setProperty(
                    'display',
                    'none',
                    'important'
                );
        }
    }

    renderContextCard() {
        if (
            document.getElementById(
                'litigationTaskContextCard'
            )
        ) {
            return;
        }

        const genericIpCard =
            document
                .getElementById(
                    'relatedIpRecordSearch'
                )
                ?.closest(
                    '.premium-card'
                );

        if (!genericIpCard) {
            return;
        }

        const workName =
            this.taskType?.alias ||
            this.taskType?.name ||
            this.task.title ||
            '-';

        const stage =
            stageLabel(
                this.stage?.stageKey
            );

        const clientName =
            this.client?.name ||
            '-';

        const html = `
            <div
                id="litigationTaskContextCard"
                class="premium-card section-card lit-task-context-card"
            >
                <div class="card-header-custom section-title">
                    <div class="lit-task-context-head">
                        <span>
                            <i class="fas fa-gavel mr-2 text-primary"></i>
                            Dava Dosyası
                        </span>

                        <span class="lit-task-stage-badge">
                            <i class="fas fa-sitemap mr-1"></i>
                            ${esc(stage)}
                        </span>
                    </div>
                </div>

                <div class="card-body-custom">
                    <div class="lit-task-context-grid">
                        <div class="lit-task-context-item">
                            <span>İşlem</span>
                            <strong>${esc(workName)}</strong>
                        </div>

                        <div class="lit-task-context-item">
                            <span>Dosya No</span>
                            <strong>${esc(this.suit.file_no || '-')}</strong>
                        </div>

                        <div class="lit-task-context-item">
                            <span>Mahkeme / Merci</span>
                            <strong>${esc(this.suit.court_name || '-')}</strong>
                        </div>

                        <div class="lit-task-context-item">
                            <span>Dava Türü</span>
                            <strong>${esc(this.suit.suit_type || '-')}</strong>
                        </div>

                        <div class="lit-task-context-item">
                            <span>Müvekkil</span>
                            <strong>
                                ${esc(clientName)}
                                · ${esc(roleLabel(this.suit.client_role))}
                            </strong>
                        </div>

                        <div class="lit-task-context-item">
                            <span>Karşı Taraf</span>
                            <strong>${esc(this.suit.opposing_party || '-')}</strong>
                        </div>

                        <div class="lit-task-context-item">
                            <span>Aşama Başlatan</span>
                            <strong>
                                ${esc(
                                    initiatorLabel(
                                        this.stage?.stageInitiator
                                    )
                                )}
                            </strong>
                        </div>

                        <div class="lit-task-context-item">
                            <span>Dava Açılış Tarihi</span>
                            <strong>
                                ${esc(
                                    formatDate(
                                        this.suit.opening_date
                                    )
                                )}
                            </strong>
                        </div>

                        <div class="lit-task-context-item">
                            <span>Dava Durumu</span>
                            <strong>${esc(this.suit.status || '-')}</strong>
                        </div>
                    </div>

                    <div class="lit-task-subject-box">
                        <strong>
                            <i class="fas fa-link mr-1"></i>
                            Dava Konusu:
                        </strong>
                        ${esc(this.subjectAssetText())}

                        <a
                            href="suit-detail.html?id=${encodeURIComponent(String(this.suit.id))}"
                            target="_blank"
                            rel="noopener"
                            class="btn btn-sm btn-outline-primary ml-2"
                        >
                            <i class="fas fa-external-link-alt mr-1"></i>
                            Dava Dosyasını Aç
                        </a>
                    </div>
                </div>
            </div>
        `;

        genericIpCard
            .insertAdjacentHTML(
                'beforebegin',
                html
            );
    }

    renderDocumentArea() {
        const fileArea =
            document.getElementById(
                'fileUploadArea'
            );

        if (!fileArea) {
            return;
        }

        const card =
            fileArea.closest(
                '.premium-card'
            );

        if (!card) {
            return;
        }

        const config =
            this.workLabelConfig();

        card.classList.add(
            'litigation-documents-card'
        );

        const headerSpan =
            card.querySelector(
                '.card-header-custom .section-title span, .card-header-custom span'
            );

        if (headerSpan) {
            headerSpan.innerHTML = `
                <i class="fas fa-file-signature mr-2 text-primary"></i>
                ${esc(config.title)}
                <small
                    class="text-muted ml-2"
                    style="font-size:.7em;font-weight:500;"
                >
                    Dava işi belgeleri
                </small>
            `;
        }

        const body =
            card.querySelector(
                '.card-body-custom'
            );

        if (
            body &&
            !document.getElementById(
                'litigationDocumentGuidance'
            )
        ) {
            const note = `
                <div
                    id="litigationDocumentGuidance"
                    class="lit-task-doc-note"
                >
                    <i class="fas fa-info-circle mr-1"></i>
                    ${esc(config.note)}
                    Bu alandaki belgeler task_documents üzerinde tutulur
                    ve iş tamamlanma bildirimine eklenir.
                </div>
            `;

            body.insertAdjacentHTML(
                'afterbegin',
                note
            );
        }

        const uploadText =
            fileArea.querySelector(
                '.upload-text'
            );

        const uploadSubtext =
            fileArea.querySelector(
                '.upload-subtext'
            );

        if (uploadText) {
            uploadText.textContent =
                config.upload;
        }

        if (uploadSubtext) {
            uploadSubtext.textContent =
                'PDF, Word veya ek dosyaları seçmek için tıklayın';
        }

        const legacyDocs =
            this.taskDocuments
                .filter(
                    (doc) =>
                        String(
                            doc.document_type ||
                            ''
                        ) ===
                        'epats_document'
                );

        if (
            legacyDocs.length > 0 &&
            body &&
            !document.getElementById(
                'litigationLegacyEpatsDocs'
            )
        ) {
            const links =
                legacyDocs
                    .map(
                        (doc) => `
                            <a
                                href="${esc(doc.document_url)}"
                                target="_blank"
                                rel="noopener"
                                class="btn btn-sm btn-outline-warning"
                            >
                                <i class="fas fa-file-pdf mr-1"></i>
                                ${esc(doc.document_name || 'Eski Dava Evrakı')}
                            </a>
                        `
                    )
                    .join('');

            const box = `
                <div
                    id="litigationLegacyEpatsDocs"
                    class="lit-task-legacy-docs"
                >
                    <div class="lit-task-legacy-docs-title">
                        <i class="fas fa-history mr-1"></i>
                        Önceki sürümde “EPATS Evrakı” türünde kaydedilmiş dava belgeleri
                    </div>

                    ${links}
                </div>
            `;

            const fileList =
                document.getElementById(
                    'fileListContainer'
                );

            if (fileList) {
                fileList.insertAdjacentHTML(
                    'beforebegin',
                    box
                );
            }
        }
    }

    updatePageHeader() {
        const title =
            document.querySelector(
                '.page-header .page-title'
            );

        const subtitle =
            document.querySelector(
                '.page-header .page-subtitle'
            );

        if (title) {
            title.textContent =
                'Dava İşi Detayı ve Düzenleme';
        }

        if (subtitle) {
            const workName =
                this.taskType?.alias ||
                this.taskType?.name ||
                this.task.title ||
                'Dava İşi';

            subtitle.textContent =
                `${workName} · ${this.suit.file_no || this.suit.title || ''}`;
        }

        document.title =
            `Dava İşi - ${this.suit.file_no || this.task.title || 'IPGATE'}`;
    }

    applyLitigationMode() {
        if (!this.active) {
            return;
        }

        document.body.classList.add(
            'litigation-task-mode'
        );

        this.updatePageHeader();
        this.renderContextCard();
        this.hideGenericCards();
        this.renderDocumentArea();

        console.log(
            '[AŞAMA 8D-3] Litigation task-update mode aktif.',
            {
                taskId:
                    this.task.id,
                taskTypeId:
                    this.task.task_type_id,
                suitId:
                    this.suit.id,
                stage:
                    this.stage?.stageKey
            }
        );
    }
}

const boot =
    new LitigationTaskUpdateView();

boot.init().catch(
    (error) => {
        console.error(
            '[AŞAMA 8D-3] Litigation task-update init hatası:',
            error
        );
    }
);
