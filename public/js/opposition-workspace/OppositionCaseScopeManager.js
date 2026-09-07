import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

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

export class OppositionCaseScopeManager {

    constructor(
        taskId,
        {
            mountId = 'oppositionCaseScopeMount',
            statusBadgeId = 'oppositionWorkspaceStatusBadge'
        } = {}
    ) {
        this.taskId = String(taskId);

        this.mount =
            document.getElementById(
                mountId
            );

        this.statusBadge =
            document.getElementById(
                statusBadgeId
            );

        this.workspace = null;
    }


    async init() {
        if (!this.mount) {
            throw new Error(
                'Yayına itiraz case scope mount alanı bulunamadı.'
            );
        }

        await this.load();

        return this.workspace;
    }


    async invoke(
        action,
        payload = {}
    ) {
        const {
            data,
            error
        } =
            await supabase
                .functions
                .invoke(
                    'opposition-workspace',
                    {
                        body: {
                            action,
                            taskId:
                                this.taskId,
                            payload
                        }
                    }
                );

        if (error) {
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
                await this.invoke(
                    'get'
                );

            this.render();

            return this.workspace;
        } catch (error) {
            console.error(
                'Opposition Case Scope yükleme hatası:',
                error
            );

            this.renderError(
                error.message
            );

            throw error;
        }
    }


    escape(value) {
        return String(
            value ??
            ''
        ).replace(
            /[&<>"']/g,
            char => ({
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
            return this.escape(
                value
            );
        }

        return date.toLocaleDateString(
            'tr-TR'
        );
    }


    resolveImageUrl(url) {
        if (
            !url ||
            typeof url !==
                'string'
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
        } =
            supabase
                .storage
                .from(
                    'brand_images'
                )
                .getPublicUrl(
                    url
                );

        return data?.publicUrl ||
            '';
    }


    renderLoading() {
        this.setBadge(
            'Yükleniyor',
            'opp-status-loading'
        );

        this.mount.innerHTML = `
            <div class="opp-case-loading">
                <i class="fas fa-spinner fa-spin mr-2"></i>
                Yayına itiraz dosyası hazırlanıyor...
            </div>
        `;
    }


    renderError(message) {
        this.setBadge(
            'Hata',
            'opp-status-error'
        );

        this.mount.innerHTML = `
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
                    id="oppCaseRetryBtn"
                    class="btn btn-sm btn-outline-danger mt-3"
                >
                    <i class="fas fa-redo mr-1"></i>
                    Tekrar Dene
                </button>
            </div>
        `;

        this.mount
            .querySelector(
                '#oppCaseRetryBtn'
            )
            ?.addEventListener(
                'click',
                () => this.load()
            );
    }


    setBadge(
        text,
        cssClass
    ) {
        if (!this.statusBadge) {
            return;
        }

        this.statusBadge.className =
            `opp-status-badge ${cssClass}`;

        this.statusBadge.textContent =
            text;
    }


    renderMarkImage(
        url,
        markName
    ) {
        const resolved =
            this.resolveImageUrl(
                url
            );

        if (!resolved) {
            return `
                <div class="opp-case-mark-placeholder">
                    <i class="fas fa-trademark"></i>
                </div>
            `;
        }

        return `
            <div class="opp-case-mark-image">
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
                    cls =>
                        typeof cls ===
                        'object'
                            ? cls.classNo
                            : cls
                )
                .filter(
                    value =>
                        value !== null &&
                        value !== undefined &&
                        value !== ''
                )
                .map(
                    value =>
                        String(value)
                );

        return nums.length
            ? nums.join(', ')
            : '-';
    }


    renderOpponentGoods(
        goodsByClass = []
    ) {
        if (
            !Array.isArray(
                goodsByClass
            ) ||
            goodsByClass.length ===
            0
        ) {
            return `
                <div class="opp-case-empty">
                    Tam mal/hizmet metni bulunamadı.
                </div>
            `;
        }

        return goodsByClass
            .map(
                row => `
                    <details class="opp-case-goods-row">
                        <summary>
                            Sınıf
                            ${this.escape(row.classNo ?? '-')}
                        </summary>

                        <div class="opp-case-goods-text">
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


    renderSelectedPriorMarks() {
        const priorMarks =
            this.workspace
                ?.priorMarks ||
            [];

        if (!priorMarks.length) {
            return `
                <div class="opp-case-empty">
                    Henüz seçili müstenit marka yok.
                </div>
            `;
        }

        return `
            <div class="opp-case-selected-list">
                ${priorMarks
                    .map(
                        item => {
                            const mark =
                                item.snapshot ||
                                {};

                            return `
                                <div class="opp-case-selected-right">
                                    <div class="opp-case-right-name">
                                        ${this.escape(
                                            mark.markText ||
                                            '-'
                                        )}
                                    </div>

                                    <div class="opp-case-right-meta">
                                        Başvuru:
                                        ${this.escape(
                                            mark.applicationNo ||
                                            '-'
                                        )}
                                        · Tescil:
                                        ${this.escape(
                                            mark.registrationNo ||
                                            '-'
                                        )}
                                    </div>

                                    <div class="opp-case-right-meta">
                                        Sınıflar:
                                        ${this.escape(
                                            this.renderClassSummary(
                                                mark.classes ||
                                                []
                                            )
                                        )}
                                    </div>
                                </div>
                            `;
                        }
                    )
                    .join('')}
            </div>
        `;
    }


    proofBadge(candidate) {
        if (
            candidate
                .proofOfUseCheck ===
            'likely_required'
        ) {
            return `
                <span class="opp-case-proof is-risk">
                    <i class="fas fa-exclamation-circle"></i>
                    5 yıl kontrolü gerekli
                </span>
            `;
        }

        if (
            candidate
                .proofOfUseCheck ===
            'likely_not_required'
        ) {
            return `
                <span class="opp-case-proof is-ok">
                    <i class="fas fa-check-circle"></i>
                    İlk kontrolde kullanım ispatı riski yok
                </span>
            `;
        }

        return `
            <span class="opp-case-proof">
                <i class="fas fa-question-circle"></i>
                Kullanım ispatı tarihi kontrol edilmeli
            </span>
        `;
    }


    renderCandidateRights() {
        const candidates =
            this.workspace
                ?.candidatePriorMarks ||
            [];

        if (!candidates.length) {
            return `
                <div class="opp-case-empty">
                    Bu müvekkile bağlı uygun marka kaydı bulunamadı.
                </div>
            `;
        }

        return `
            <div class="opp-case-rights-list">
                ${candidates
                    .map(
                        mark => `
                            <label
                                class="
                                    opp-case-right-option
                                    ${mark.selected ? 'is-selected' : ''}
                                "
                            >
                                <input
                                    type="checkbox"
                                    class="opp-prior-check"
                                    value="${this.escape(mark.id)}"
                                    ${mark.selected ? 'checked' : ''}
                                >

                                <div class="opp-case-right-option-body">
                                    <div class="opp-case-right-name">
                                        ${this.escape(
                                            mark.markText ||
                                            '-'
                                        )}
                                    </div>

                                    <div class="opp-case-right-meta">
                                        Başvuru:
                                        ${this.escape(
                                            mark.applicationNo ||
                                            '-'
                                        )}
                                        · Tescil:
                                        ${this.escape(
                                            mark.registrationNo ||
                                            '-'
                                        )}
                                        · Sınıflar:
                                        ${this.escape(
                                            this.renderClassSummary(
                                                mark.niceClasses ||
                                                []
                                            )
                                        )}
                                    </div>

                                    ${this.proofBadge(mark)}
                                </div>
                            </label>
                        `
                    )
                    .join('')}
            </div>
        `;
    }


    renderGrounds() {
        const selected =
            new Set(
                this.workspace
                    ?.case
                    ?.selected_grounds ||
                ['SMK_6_1']
            );

        return `
            <div class="opp-case-ground-list">
                ${GROUND_OPTIONS
                    .map(
                        ground => `
                            <label
                                class="
                                    opp-case-ground-option
                                    ${selected.has(ground.id) ? 'is-selected' : ''}
                                "
                            >
                                <input
                                    type="checkbox"
                                    class="opp-ground-check"
                                    value="${ground.id}"
                                    data-strategic="${ground.strategic ? '1' : '0'}"
                                    ${selected.has(ground.id) ? 'checked' : ''}
                                >

                                <span>
                                    ${this.escape(ground.label)}
                                </span>
                            </label>
                        `
                    )
                    .join('')}
            </div>
        `;
    }


    render() {
        const ws =
            this.workspace;

        if (!ws) {
            return;
        }

        this.setBadge(
            'Hazır',
            'opp-status-ready'
        );

        const opponent =
            ws.opponent ||
            {};

        const clientName =
            ws.client?.name ||
            'Müvekkil bilgisi bulunamadı';

        const bulletinLabel =
            ws.bulletin?.bulletin_no
                ? `${this.escape(ws.bulletin.bulletin_no)} sayılı bülten`
                : 'Bülten bilgisi yok';

        this.mount.innerHTML = `
            <div class="opp-case-topbar">
                <div>
                    <div class="opp-case-eyebrow">
                        OPPOSITION CASE
                    </div>

                    <div class="opp-case-title">
                        ${this.escape(clientName)}
                        →
                        ${this.escape(opponent.markText || '-')}
                    </div>

                    <div class="opp-case-subtitle">
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

            <div class="opp-case-grid-2">
                <section class="opp-case-panel">
                    <div class="opp-case-panel-title">
                        <i class="fas fa-bullseye"></i>
                        İtiraz Edilen Marka
                    </div>

                    <div class="opp-case-mark-head">
                        ${this.renderMarkImage(
                            opponent.imageUrl,
                            opponent.markText
                        )}

                        <div>
                            <div class="opp-case-mark-name">
                                ${this.escape(
                                    opponent.markText ||
                                    '-'
                                )}
                            </div>

                            <div class="opp-case-meta">
                                Başvuru:
                                <strong>
                                    ${this.escape(
                                        opponent.applicationNo ||
                                        '-'
                                    )}
                                </strong>
                            </div>

                            <div class="opp-case-meta">
                                Başvuru tarihi:
                                ${this.formatDate(
                                    opponent.applicationDate
                                )}
                            </div>

                            <div class="opp-case-meta">
                                Sınıflar:
                                ${this.escape(
                                    this.renderClassSummary(
                                        opponent.niceClasses ||
                                        []
                                    )
                                )}
                            </div>
                        </div>
                    </div>

                    <div class="opp-case-mini-title">
                        Bülten kapsamı
                    </div>

                    ${this.renderOpponentGoods(
                        opponent.goodsByClass ||
                        []
                    )}
                </section>

                <section class="opp-case-panel">
                    <div class="opp-case-panel-title">
                        <i class="fas fa-shield-alt"></i>
                        Seçili Müstenit Haklar
                    </div>

                    ${this.renderSelectedPriorMarks()}
                </section>
            </div>

            <section class="opp-case-panel" style="margin-top:14px;">
                <div class="opp-case-panel-title">
                    <i class="fas fa-tasks"></i>
                    Müstenit Marka Seçimi
                </div>

                <div class="opp-case-meta" style="margin-bottom:11px;">
                    Müvekkilin portföyünden gerçekten dayanılacak
                    hakları seçin. Bu seçim hukuki analiz ve
                    dilekçe motoru için canonical scope olur.
                </div>

                ${this.renderCandidateRights()}
            </section>

            <div class="opp-case-grid-2">
                <section class="opp-case-panel">
                    <div class="opp-case-panel-title">
                        <i class="fas fa-gavel"></i>
                        İtiraz Gerekçeleri
                    </div>

                    ${this.renderGrounds()}

                    <div class="opp-case-info-note">
                        6/3, 6/4, 6/5, 6/6 veya 6/9
                        seçildiğinde dosya otomatik olarak
                        stratejik dosya seviyesine çıkarılır.
                    </div>
                </section>

                <section class="opp-case-panel">
                    <div class="opp-case-panel-title">
                        <i class="fas fa-layer-group"></i>
                        Dosya Seviyesi
                    </div>

                    <label
                        class="form-label"
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
                            ${ws.case?.complexity === 'green' ? 'selected' : ''}
                        >
                            Green — Standart 6/1
                        </option>

                        <option
                            value="yellow"
                            ${ws.case?.complexity === 'yellow' ? 'selected' : ''}
                        >
                            Yellow — İleri değerlendirme
                        </option>

                        <option
                            value="red"
                            ${ws.case?.complexity === 'red' ? 'selected' : ''}
                        >
                            Red — Stratejik / delil yoğun
                        </option>
                    </select>

                    <div class="opp-case-meta-grid">
                        <div>
                            <span>Case durumu</span>
                            <strong>
                                ${this.escape(
                                    ws.case?.status ||
                                    '-'
                                )}
                            </strong>
                        </div>

                        <div>
                            <span>Resmî son tarih</span>
                            <strong>
                                ${this.formatDate(
                                    ws.task?.officialDueDate
                                )}
                            </strong>
                        </div>

                        <div>
                            <span>Task</span>
                            <strong>
                                #${this.escape(
                                    ws.task?.id ||
                                    this.taskId
                                )}
                            </strong>
                        </div>
                    </div>
                </section>
            </div>

            <div class="opp-case-save-bar">
                <div class="opp-case-save-copy">
                    Bu kayıt tamamlandığında hukuki analiz ekranı
                    aynı canonical dosya kapsamını kullanır.
                </div>

                <button
                    type="button"
                    id="oppSaveWorkspaceBtn"
                    class="btn btn-primary px-4"
                >
                    <i class="fas fa-save mr-2"></i>
                    Dosya Kapsamını Kaydet
                </button>
            </div>
        `;

        this.bindEvents();
    }


    bindEvents() {
        this.mount
            .querySelectorAll(
                '.opp-prior-check'
            )
            .forEach(
                checkbox => {
                    checkbox.addEventListener(
                        'change',
                        () => {
                            checkbox
                                .closest(
                                    '.opp-case-right-option'
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

        this.mount
            .querySelectorAll(
                '.opp-ground-check'
            )
            .forEach(
                checkbox => {
                    checkbox.addEventListener(
                        'change',
                        () => {
                            checkbox
                                .closest(
                                    '.opp-case-ground-option'
                                )
                                ?.classList
                                .toggle(
                                    'is-selected',
                                    checkbox.checked
                                );

                            if (
                                checkbox.checked &&
                                checkbox.dataset
                                    .strategic ===
                                    '1'
                            ) {
                                const complexity =
                                    this.mount
                                        .querySelector(
                                            '#oppComplexity'
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

        this.mount
            .querySelector(
                '#oppSaveWorkspaceBtn'
            )
            ?.addEventListener(
                'click',
                () => this.save()
            );
    }


    async save() {
        const button =
            this.mount.querySelector(
                '#oppSaveWorkspaceBtn'
            );

        const selectedPriorMarkIds =
            [
                ...this.mount
                    .querySelectorAll(
                        '.opp-prior-check:checked'
                    )
            ].map(
                element =>
                    element.value
            );

        const selectedGrounds =
            [
                ...this.mount
                    .querySelectorAll(
                        '.opp-ground-check:checked'
                    )
            ].map(
                element =>
                    element.value
            );

        const complexity =
            this.mount
                .querySelector(
                    '#oppComplexity'
                )
                ?.value ||
            'green';

        if (
            selectedPriorMarkIds.length ===
            0
        ) {
            showNotification(
                'En az bir müstenit marka seçmelisiniz.',
                'warning'
            );

            return;
        }

        if (
            selectedGrounds.length ===
            0
        ) {
            showNotification(
                'En az bir itiraz gerekçesi seçmelisiniz.',
                'warning'
            );

            return;
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

            window.dispatchEvent(
                new CustomEvent(
                    'opposition-workspace-saved',
                    {
                        detail: {
                            taskId:
                                this.taskId,
                            workspace:
                                this.workspace
                        }
                    }
                )
            );

            showNotification(
                'Yayına itiraz dosya kapsamı kaydedildi.',
                'success'
            );
        } catch (error) {
            console.error(
                'Opposition Case Scope kayıt hatası:',
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
                    Dosya Kapsamını Kaydet
                `;
            }
        }
    }
}
