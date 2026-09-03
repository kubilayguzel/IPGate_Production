import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';
import { Smk61DecisionTreeManager } from './Smk61DecisionTreeManager.js';
import { OppositionDraftManager } from './OppositionDraftManager.js';

const GROUND_OPTIONS = [
    {
        id: 'SMK_6_1',
        label: 'SMK 6/1 — Karıştırılma ihtimali',
        strategic: false
    },
    {
        id: 'SMK_6_3',
        label: 'SMK 6/3 — Önceki kullanım / gerçek hak sahipliği',
        strategic: true
    },
    {
        id: 'SMK_6_4',
        label: 'SMK 6/4 — Paris Sözleşmesi anlamında tanınmış marka',
        strategic: true
    },
    {
        id: 'SMK_6_5',
        label: 'SMK 6/5 — Türkiye’de tanınmışlık / itibar',
        strategic: true
    },
    {
        id: 'SMK_6_6',
        label: 'SMK 6/6 — Diğer fikri / şahsi haklar',
        strategic: true
    },
    {
        id: 'SMK_6_9',
        label: 'SMK 6/9 — Kötü niyet',
        strategic: true
    }
];

export class OppositionWorkspaceManager {

    constructor(taskId, taskData) {
        this.taskId = String(taskId);
        this.taskData = taskData;

        this.workspace = null;
        this.smk61DecisionTreeManager = null;
        this.oppositionDraftManager = null;

        this.card =
            document.getElementById(
                'oppositionWorkspaceCard'
            );

        this.container =
            document.getElementById(
                'oppositionWorkspaceContainer'
            );

        this.statusBadge =
            document.getElementById(
                'oppositionWorkspaceStatusBadge'
            );
    }


    isOppositionTask() {
        return String(
            this.taskData?.taskType ||
            this.taskData?.task_type_id ||
            ''
        ) === '20';
    }


    async init() {

        if (!this.card || !this.container) {
            return;
        }

        if (!this.isOppositionTask()) {
            this.card.style.display = 'none';
            return;
        }

        this.card.style.display = 'block';

        await this.load();
    }


    async invoke(action, payload = {}) {

        const {
            data,
            error
        } = await supabase.functions.invoke(
            'opposition-workspace',
            {
                body: {
                    action,
                    taskId: this.taskId,
                    payload
                }
            }
        );

        if (error) {

            console.error(
                'Opposition Workspace invoke error:',
                error
            );

            throw new Error(
                error.message ||
                'Opposition Workspace servisine ulaşılamadı.'
            );
        }

        if (!data?.success) {

            throw new Error(
                data?.error ||
                'Opposition Workspace işlemi başarısız oldu.'
            );
        }

        return data.workspace;
    }


    async load() {

        this.renderLoading();

        try {

            this.workspace =
                await this.invoke('get');

            this.render();

        } catch (error) {

            console.error(
                'Opposition Workspace yükleme hatası:',
                error
            );

            this.renderError(
                error.message
            );
        }
    }


    escape(value) {

        return String(
            value ?? ''
        ).replace(
            /[&<>"']/g,
            (char) => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            }[char])
        );
    }


    formatDate(value) {

        if (!value) {
            return '-';
        }

        const date =
            new Date(value);

        if (
            Number.isNaN(
                date.getTime()
            )
        ) {
            return this.escape(value);
        }

        return date.toLocaleDateString(
            'tr-TR'
        );
    }


    resolveImageUrl(url) {

        if (
            !url ||
            typeof url !== 'string'
        ) {
            return '';
        }

        if (
            /^(https?:|data:|blob:)/i
                .test(url)
        ) {
            return url;
        }

        const {
            data
        } = supabase.storage
            .from('brand_images')
            .getPublicUrl(url);

        return data?.publicUrl || '';
    }


    renderLoading() {

        if (!this.container) {
            return;
        }

        if (this.statusBadge) {

            this.statusBadge.className =
                'opp-status-badge opp-status-loading';

            this.statusBadge.textContent =
                'Yükleniyor';
        }

        this.container.innerHTML = `
            <div class="opp-loading-state">
                <i class="fas fa-spinner fa-spin"></i>
                <span>
                    Yayına itiraz dosyası hazırlanıyor...
                </span>
            </div>
        `;
    }


    renderError(message) {

        if (this.statusBadge) {

            this.statusBadge.className =
                'opp-status-badge opp-status-error';

            this.statusBadge.textContent =
                'Hata';
        }

        this.container.innerHTML = `
            <div class="alert alert-danger mb-0">

                <div class="font-weight-bold mb-1">
                    <i class="fas fa-exclamation-triangle mr-1"></i>
                    Çalışma alanı yüklenemedi
                </div>

                <div>
                    ${this.escape(message)}
                </div>

                <button
                    type="button"
                    id="oppRetryBtn"
                    class="btn btn-sm btn-outline-danger mt-3"
                >
                    <i class="fas fa-redo mr-1"></i>
                    Tekrar Dene
                </button>

            </div>
        `;

        document
            .getElementById('oppRetryBtn')
            ?.addEventListener(
                'click',
                () => this.load()
            );
    }


    renderMarkImage(
        url,
        markName
    ) {

        const resolved =
            this.resolveImageUrl(url);

        if (!resolved) {

            return `
                <div class="opp-mark-placeholder">
                    <i class="fas fa-trademark"></i>
                </div>
            `;
        }

        return `
            <div class="opp-mark-image">

                <img
                    src="${this.escape(resolved)}"
                    alt="${this.escape(markName || 'Marka')}"
                    loading="lazy"
                >

            </div>
        `;
    }


    renderClassSummary(
        classes = []
    ) {

        const nums =
            classes
                .map(
                    (c) =>
                        typeof c === 'object'
                            ? c.classNo
                            : c
                )
                .filter(
                    (n) =>
                        n !== null &&
                        n !== undefined &&
                        n !== ''
                )
                .map(
                    (n) => String(n)
                );

        return nums.length
            ? nums.join(', ')
            : '-';
    }


    renderGoodsByClass(
        goodsByClass = []
    ) {

        if (
            !Array.isArray(
                goodsByClass
            ) ||
            goodsByClass.length === 0
        ) {

            return `
                <div class="opp-empty-note">
                    Tam mal/hizmet metni bulunamadı.
                </div>
            `;
        }

        return goodsByClass
            .map(
                (row) => `
                    <details class="opp-goods-row">

                        <summary>
                            Sınıf ${this.escape(row.classNo ?? '-')}
                        </summary>

                        <div class="opp-goods-text">
                            ${this.escape(
                                row.text ||
                                'Metin bulunamadı.'
                            )}
                        </div>

                    </details>
                `
            )
            .join('');
    }


    renderPriorGoods(
        classes = []
    ) {

        if (
            !Array.isArray(classes) ||
            classes.length === 0
        ) {

            return `
                <div class="opp-empty-note">
                    Tam mal/hizmet metni bulunamadı.
                </div>
            `;
        }

        return classes
            .map(
                (row) => {

                    const items =
                        Array.isArray(row.items)
                            ? row.items
                            : [];

                    return `
                        <details class="opp-goods-row">

                            <summary>
                                Sınıf ${this.escape(row.classNo ?? '-')}

                                <span class="text-muted">
                                    (${items.length} kalem)
                                </span>
                            </summary>

                            <div class="opp-goods-text">

                                ${
                                    items.length
                                        ? `
                                            <ul>
                                                ${
                                                    items
                                                        .map(
                                                            (item) =>
                                                                `<li>${this.escape(item)}</li>`
                                                        )
                                                        .join('')
                                                }
                                            </ul>
                                        `
                                        : 'Emtia kalemi bulunamadı.'
                                }

                            </div>

                        </details>
                    `;
                }
            )
            .join('');
    }


    renderProofBadge(
        candidate
    ) {

        if (
            candidate.proofOfUseCheck ===
            'likely_required'
        ) {

            return `
                <span class="opp-proof-badge opp-proof-risk">

                    <i class="fas fa-exclamation-circle mr-1"></i>

                    5 yıl kontrolü gerekli

                </span>
            `;
        }

        if (
            candidate.proofOfUseCheck ===
            'likely_not_required'
        ) {

            return `
                <span class="opp-proof-badge opp-proof-ok">

                    <i class="fas fa-check-circle mr-1"></i>

                    İlk kontrolde kullanım ispatı riski yok

                </span>
            `;
        }

        return `
            <span class="opp-proof-badge opp-proof-unknown">

                <i class="fas fa-question-circle mr-1"></i>

                Kullanım ispatı tarihi kontrol edilmeli

            </span>
        `;
    }


    renderSelectedPriorMarks() {

        const priorMarks =
            this.workspace
                ?.priorMarks || [];

        if (!priorMarks.length) {

            return `
                <div class="opp-empty-note">
                    Henüz seçili müstenit marka yok.
                </div>
            `;
        }

        return priorMarks
            .map(
                (item) => {

                    const mark =
                        item.snapshot || {};

                    return `
                        <div class="opp-prior-detail-card">

                            <div class="opp-mark-head">

                                ${
                                    this.renderMarkImage(
                                        mark.imageUrl,
                                        mark.markText
                                    )
                                }

                                <div>

                                    <div class="opp-mark-name">
                                        ${this.escape(mark.markText || '-')}
                                    </div>

                                    <div class="opp-mark-meta">

                                        Başvuru:
                                        <strong>
                                            ${this.escape(mark.applicationNo || '-')}
                                        </strong>

                                        · Tescil:

                                        <strong>
                                            ${this.escape(mark.registrationNo || '-')}
                                        </strong>

                                    </div>

                                    <div class="opp-mark-meta">

                                        Başvuru tarihi:
                                        ${this.formatDate(mark.applicationDate)}

                                        · Tescil tarihi:
                                        ${this.formatDate(mark.registrationDate)}

                                    </div>

                                </div>

                            </div>


                            <div class="mt-3">

                                <div class="opp-section-mini-title">
                                    Müstenit kapsam
                                </div>

                                ${
                                    this.renderPriorGoods(
                                        mark.classes || []
                                    )
                                }

                            </div>

                        </div>
                    `;
                }
            )
            .join('');
    }


    renderCandidateRights() {

        const candidates =
            this.workspace
                ?.candidatePriorMarks || [];

        if (!candidates.length) {

            return `
                <div class="opp-empty-note">
                    Bu müvekkile bağlı uygun marka kaydı bulunamadı.
                </div>
            `;
        }

        return candidates
            .map(
                (mark) => `
                    <label
                        class="opp-right-option ${
                            mark.selected
                                ? 'is-selected'
                                : ''
                        }"
                    >

                        <input
                            type="checkbox"
                            class="opp-prior-check"
                            value="${this.escape(mark.id)}"
                            ${
                                mark.selected
                                    ? 'checked'
                                    : ''
                            }
                        >

                        <div class="opp-right-option-body">

                            <div
                                class="
                                    d-flex
                                    justify-content-between
                                    align-items-start
                                    flex-wrap
                                "
                            >

                                <div>

                                    <div class="opp-right-name">
                                        ${this.escape(mark.markText || '-')}
                                    </div>

                                    <div class="opp-right-meta">

                                        Başvuru:
                                        ${this.escape(mark.applicationNo || '-')}

                                        · Tescil:
                                        ${this.escape(mark.registrationNo || '-')}

                                        · Sınıflar:
                                        ${
                                            this.escape(
                                                this.renderClassSummary(
                                                    mark.niceClasses || []
                                                )
                                            )
                                        }

                                    </div>

                                </div>


                                ${
                                    this.renderProofBadge(
                                        mark
                                    )
                                }

                            </div>

                        </div>

                    </label>
                `
            )
            .join('');
    }


    renderGrounds() {

        const selected =
            new Set(
                this.workspace
                    ?.case
                    ?.selected_grounds ||
                ['SMK_6_1']
            );

        return GROUND_OPTIONS
            .map(
                (ground) => `
                    <label
                        class="opp-ground-option ${
                            selected.has(ground.id)
                                ? 'is-selected'
                                : ''
                        }"
                    >

                        <input
                            type="checkbox"
                            class="opp-ground-check"
                            value="${ground.id}"
                            data-strategic="${
                                ground.strategic
                                    ? '1'
                                    : '0'
                            }"
                            ${
                                selected.has(ground.id)
                                    ? 'checked'
                                    : ''
                            }
                        >

                        <span>
                            ${this.escape(ground.label)}
                        </span>

                    </label>
                `
            )
            .join('');
    }


    render() {

        const ws =
            this.workspace;

        if (
            !ws ||
            !this.container
        ) {
            return;
        }


        if (this.statusBadge) {

            this.statusBadge.className =
                'opp-status-badge opp-status-ready';

            this.statusBadge.textContent =
                'Analiz';
        }


        const opponent =
            ws.opponent || {};


        const clientName =
            ws.client?.name ||
            'Müvekkil bilgisi bulunamadı';


        const bulletinLabel =
            ws.bulletin?.bulletin_no
                ? `${this.escape(ws.bulletin.bulletin_no)} sayılı bülten`
                : 'Bülten bilgisi yok';


        this.container.innerHTML = `

            <div class="opp-workspace-topbar">

                <div>

                    <div class="opp-eyebrow">
                        OPPOSITION CASE
                    </div>

                    <h4 class="opp-workspace-title mb-1">

                        ${this.escape(clientName)}

                        →

                        ${this.escape(opponent.markText || '-')}

                    </h4>

                    <div class="opp-workspace-subtitle">

                        ${bulletinLabel}

                        · Başvuru No:

                        ${this.escape(opponent.applicationNo || '-')}

                    </div>

                </div>


                <div class="opp-case-id">

                    Case:

                    ${this.escape(ws.case?.id || '-')}

                </div>

            </div>


            <div class="opp-grid-2 mt-4">


                <section class="opp-panel">

                    <div class="opp-panel-title">

                        <i class="fas fa-bullseye mr-2"></i>

                        İtiraz Edilen Marka

                    </div>


                    <div class="opp-mark-head">

                        ${
                            this.renderMarkImage(
                                opponent.imageUrl,
                                opponent.markText
                            )
                        }


                        <div>

                            <div class="opp-mark-name">
                                ${this.escape(opponent.markText || '-')}
                            </div>


                            <div class="opp-mark-meta">

                                Başvuru No:

                                <strong>
                                    ${this.escape(opponent.applicationNo || '-')}
                                </strong>

                            </div>


                            <div class="opp-mark-meta">

                                Başvuru tarihi:

                                ${this.formatDate(opponent.applicationDate)}

                            </div>


                            <div class="opp-mark-meta">

                                Sınıflar:

                                ${
                                    this.escape(
                                        this.renderClassSummary(
                                            opponent.niceClasses || []
                                        )
                                    )
                                }

                            </div>

                        </div>

                    </div>


                    <div class="mt-3">

                        <div class="opp-section-mini-title">
                            Bülten kapsamı
                        </div>

                        ${
                            this.renderGoodsByClass(
                                opponent.goodsByClass || []
                            )
                        }

                    </div>

                </section>



                <section class="opp-panel">

                    <div class="opp-panel-title">

                        <i class="fas fa-shield-alt mr-2"></i>

                        Seçili Müstenit Haklar

                    </div>

                    ${
                        this.renderSelectedPriorMarks()
                    }

                </section>


            </div>



            <section class="opp-panel mt-4">

                <div
                    class="
                        d-flex
                        justify-content-between
                        align-items-center
                        flex-wrap
                        mb-3
                    "
                >

                    <div>

                        <div class="opp-panel-title mb-1">

                            <i class="fas fa-tasks mr-2"></i>

                            Müstenit Marka Seçimi

                        </div>


                        <div class="text-muted small">

                            Müvekkilin portföyünden gerçekten
                            dayanılacak hakları seç.

                        </div>

                    </div>


                    <span class="opp-count-badge">

                        ${
                            (
                                ws.candidatePriorMarks ||
                                []
                            ).length
                        }

                        marka

                    </span>

                </div>


                <div class="opp-rights-list">

                    ${
                        this.renderCandidateRights()
                    }

                </div>

            </section>



            <div class="opp-grid-2 mt-4">


                <section class="opp-panel">

                    <div class="opp-panel-title">

                        <i class="fas fa-gavel mr-2"></i>

                        İtiraz Gerekçeleri

                    </div>


                    <div class="opp-ground-list">

                        ${
                            this.renderGrounds()
                        }

                    </div>


                    <div class="opp-info-note mt-3">

                        6/3, 6/4, 6/5, 6/6 veya 6/9
                        seçildiğinde dosya otomatik olarak
                        stratejik dosya seviyesine çıkarılır.

                    </div>

                </section>



                <section class="opp-panel">

                    <div class="opp-panel-title">

                        <i class="fas fa-layer-group mr-2"></i>

                        Dosya Seviyesi

                    </div>


                    <label
                        class="form-label mt-2"
                        for="oppComplexity"
                    >
                        Karmaşıklık
                    </label>


                    <select
                        id="oppComplexity"
                        class="form-select"
                    >

                        <option
                            value="green"
                            ${
                                ws.case?.complexity ===
                                'green'
                                    ? 'selected'
                                    : ''
                            }
                        >
                            Green — Standart 6/1
                        </option>


                        <option
                            value="yellow"
                            ${
                                ws.case?.complexity ===
                                'yellow'
                                    ? 'selected'
                                    : ''
                            }
                        >
                            Yellow — İleri değerlendirme
                        </option>


                        <option
                            value="red"
                            ${
                                ws.case?.complexity ===
                                'red'
                                    ? 'selected'
                                    : ''
                            }
                        >
                            Red — Stratejik / delil yoğun
                        </option>

                    </select>


                    <div class="opp-case-meta mt-3">

                        <div>

                            <span>
                                Case durumu
                            </span>

                            <strong>
                                ${this.escape(ws.case?.status || '-')}
                            </strong>

                        </div>


                        <div>

                            <span>
                                Resmî son tarih
                            </span>

                            <strong>
                                ${this.formatDate(ws.task?.officialDueDate)}
                            </strong>

                        </div>


                        <div>

                            <span>
                                Task
                            </span>

                            <strong>
                                #${this.escape(ws.task?.id || '-')}
                            </strong>

                        </div>

                    </div>

                </section>


            </div>



            <div class="opp-save-bar mt-4">

            <div class="text-muted small">

                Bu aşamada dosya kapsamı,
                müstenit haklar ve hukuki gerekçeler
                kaydedilir.

            </div>


            <button
                type="button"
                id="oppSaveWorkspaceBtn"
                class="btn btn-primary px-4"
            >

                <i class="fas fa-save mr-2"></i>

                Çalışma Alanını Kaydet

            </button>

        </div>


        <!-- =====================================================
            SMK 6/1 HUKUKİ DECISION TREE
            ===================================================== -->
        <div
            id="smk61DecisionTreeMount"
            class="mt-4"
        ></div>


        <div
            id="oppositionDraftMount"
            class="mt-4"
        ></div>
        `;


        this.bindEvents();
        this.initSmk61DecisionTree();
    }


    bindEvents() {

        document
            .querySelectorAll(
                '.opp-prior-check'
            )
            .forEach(
                (checkbox) => {

                    checkbox
                        .addEventListener(
                            'change',
                            () => {

                                checkbox
                                    .closest(
                                        '.opp-right-option'
                                    )
                                    ?.classList
                                    .toggle(
                                        'is-selected',
                                        checkbox.checked
                                    );
                            }
                        );
                }
            );


        document
            .querySelectorAll(
                '.opp-ground-check'
            )
            .forEach(
                (checkbox) => {

                    checkbox
                        .addEventListener(
                            'change',
                            () => {

                                checkbox
                                    .closest(
                                        '.opp-ground-option'
                                    )
                                    ?.classList
                                    .toggle(
                                        'is-selected',
                                        checkbox.checked
                                    );


                                if (
                                    checkbox.checked &&
                                    checkbox.dataset.strategic ===
                                    '1'
                                ) {

                                    const complexity =
                                        document.getElementById(
                                            'oppComplexity'
                                        );

                                    if (complexity) {
                                        complexity.value =
                                            'red';
                                    }
                                }
                            }
                        );
                }
            );


        document
            .getElementById(
                'oppSaveWorkspaceBtn'
            )
            ?.addEventListener(
                'click',
                () => this.save()
            );
    }

    async initSmk61DecisionTree() {

    try {

        this.smk61DecisionTreeManager =
            new Smk61DecisionTreeManager(
                this.taskId,
                this.workspace
            );


        await this
            .smk61DecisionTreeManager
            .init();

    } catch (error) {

        console.error(
            'SMK 6/1 Decision Tree başlatılamadı:',
            error
        );


        const mount =
            document.getElementById(
                'smk61DecisionTreeMount'
            );


        if (mount) {

            mount.innerHTML = `
                <div class="alert alert-danger">

                    SMK 6/1 hukuki analiz ekranı
                    başlatılamadı:

                    ${this.escape(error.message)}

                </div>
            `;
        }
    }


    try {

        this.oppositionDraftManager =
            new OppositionDraftManager(
                this.taskId
            );


        await this
            .oppositionDraftManager
            .init();

    } catch (error) {

        console.error(
            'Opposition Draft Manager başlatılamadı:',
            error
        );


        const mount =
            document.getElementById(
                'oppositionDraftMount'
            );


        if (mount) {

            mount.innerHTML = `
                <div class="alert alert-danger">

                    Dilekçe üretim motoru
                    başlatılamadı:

                    ${this.escape(error.message)}

                </div>
            `;
        }
    }
}

    async save() {

        const button =
            document.getElementById(
                'oppSaveWorkspaceBtn'
            );


        const selectedPriorMarkIds =
            [
                ...document.querySelectorAll(
                    '.opp-prior-check:checked'
                )
            ].map(
                (el) => el.value
            );


        const selectedGrounds =
            [
                ...document.querySelectorAll(
                    '.opp-ground-check:checked'
                )
            ].map(
                (el) => el.value
            );


        const complexity =
            document
                .getElementById(
                    'oppComplexity'
                )
                ?.value ||
            'green';


        if (
            selectedPriorMarkIds
                .length === 0
        ) {

            return showNotification(
                'En az bir müstenit marka seçmelisiniz.',
                'warning'
            );
        }


        if (
            selectedGrounds.length === 0
        ) {

            return showNotification(
                'En az bir itiraz gerekçesi seçmelisiniz.',
                'warning'
            );
        }


        if (button) {

            button.disabled =
                true;

            button.innerHTML = `
                <i class="fas fa-spinner fa-spin mr-2"></i>
                Kaydediliyor...
            `;
        }


        try {

            this.workspace =
                await this.invoke(
                    'save',
                    {
                        selectedPriorMarkIds,
                        selectedGrounds,
                        complexity
                    }
                );


            this.render();


            showNotification(
                'Yayına itiraz çalışma alanı kaydedildi.',
                'success'
            );

        } catch (error) {

            console.error(
                'Opposition Workspace kayıt hatası:',
                error
            );


            showNotification(
                'Kayıt hatası: ' +
                error.message,
                'error'
            );


            if (button) {

                button.disabled =
                    false;

                button.innerHTML = `
                    <i class="fas fa-save mr-2"></i>
                    Çalışma Alanını Kaydet
                `;
            }
        }
    }
}