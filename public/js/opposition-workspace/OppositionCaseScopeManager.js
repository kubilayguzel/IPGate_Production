import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

const UX_PACKAGE_VERSION = '6.1.10';
const STYLE_ID = 'evreka-opposition-case-6110-styles';
const INITIAL_RESULT_LIMIT = 50;
const RESULT_LIMIT_STEP = 50;

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

        this.selectedPriorIds =
            new Set();

        this.candidateQuery = '';

        this.selectedOnly = false;

        this.resultLimit =
            INITIAL_RESULT_LIMIT;
    }


    async init() {
        if (!this.mount) {
            throw new Error(
                'Yayına itiraz case scope mount alanı bulunamadı.'
            );
        }

        this.ensureStyles();

        await this.load();

        return this.workspace;
    }


    ensureStyles() {
        if (
            document.getElementById(
                STYLE_ID
            )
        ) {
            return;
        }

        const style =
            document.createElement(
                'style'
            );

        style.id =
            STYLE_ID;

        style.textContent = `
            .opp6110-prior-stack {
                display:flex;
                flex-direction:column;
                gap:9px;
                max-height:520px;
                overflow:auto;
                padding-right:3px;
            }

            .opp6110-selected-card {
                border:1px solid #dfe5ec;
                border-radius:12px;
                background:#fff;
                padding:11px 12px;
            }

            .opp6110-selected-head {
                display:flex;
                align-items:flex-start;
                justify-content:space-between;
                gap:10px;
            }

            .opp6110-selected-name {
                color:#172033;
                font-size:13px;
                font-weight:800;
                line-height:1.3;
            }

            .opp6110-selected-meta {
                color:#667085;
                font-size:10px;
                line-height:1.45;
                margin-top:3px;
            }

            .opp6110-remove {
                border:1px solid #e4e7ec;
                border-radius:8px;
                background:#fff;
                color:#7a8493;
                padding:5px 7px;
                font-size:10px;
                cursor:pointer;
                white-space:nowrap;
            }

            .opp6110-remove:hover {
                border-color:#efb3b3;
                color:#b42318;
                background:#fff8f8;
            }

            .opp6110-goods {
                margin-top:9px;
                border:1px solid #e5e9f0;
                border-radius:9px;
                background:#fafbfc;
                overflow:hidden;
            }

            .opp6110-goods > summary {
                cursor:pointer;
                list-style:none;
                padding:8px 10px;
                color:#475467;
                font-size:10px;
                font-weight:800;
            }

            .opp6110-goods > summary::-webkit-details-marker {
                display:none;
            }

            .opp6110-goods-body {
                border-top:1px solid #e5e9f0;
                padding:9px 10px;
            }

            .opp6110-goods-class {
                padding:8px 0;
                border-bottom:1px dashed #e4e7ec;
            }

            .opp6110-goods-class:last-child {
                border-bottom:0;
            }

            .opp6110-goods-class-title {
                color:#344054;
                font-size:10px;
                font-weight:800;
                margin-bottom:4px;
            }

            .opp6110-goods-text {
                color:#667085;
                font-size:10px;
                line-height:1.5;
                white-space:pre-wrap;
            }

            .opp6110-selector {
                border:1px solid #dfe5ec;
                border-radius:14px;
                background:#fff;
                overflow:hidden;
            }

            .opp6110-selector-head {
                padding:13px 14px;
                border-bottom:1px solid #e7ebf0;
                background:#f8fafc;
            }

            .opp6110-searchrow {
                display:grid;
                grid-template-columns:minmax(0,1fr) auto auto;
                gap:8px;
                align-items:center;
            }

            .opp6110-searchwrap {
                position:relative;
            }

            .opp6110-searchwrap i {
                position:absolute;
                left:11px;
                top:50%;
                transform:translateY(-50%);
                color:#98a2b3;
                font-size:11px;
            }

            .opp6110-search {
                width:100%;
                border:1px solid #cfd8e6;
                border-radius:10px;
                background:#fff;
                padding:9px 10px 9px 32px;
                color:#172033;
                outline:none;
            }

            .opp6110-search:focus {
                border-color:#7b9be5;
                box-shadow:0 0 0 3px rgba(36,87,214,.08);
            }

            .opp6110-filterbtn {
                border:1px solid #d6dde8;
                border-radius:9px;
                background:#fff;
                color:#475467;
                padding:8px 10px;
                font-size:10px;
                font-weight:800;
                cursor:pointer;
                white-space:nowrap;
            }

            .opp6110-filterbtn.is-active {
                border-color:#9fc8ab;
                background:#f2faf4;
                color:#08742d;
            }

            .opp6110-counts {
                display:flex;
                gap:7px;
                flex-wrap:wrap;
                margin-top:9px;
            }

            .opp6110-count {
                display:inline-flex;
                align-items:center;
                gap:5px;
                border-radius:999px;
                padding:5px 8px;
                background:#eef2f7;
                color:#596579;
                font-size:9px;
                font-weight:800;
            }

            .opp6110-count.is-selected {
                background:#eaf6ee;
                color:#0b6b2b;
            }

            .opp6110-results {
                max-height:520px;
                overflow:auto;
                padding:8px;
            }

            .opp6110-result {
                display:flex;
                align-items:flex-start;
                gap:10px;
                border:1px solid transparent;
                border-radius:10px;
                padding:9px 10px;
                cursor:pointer;
                margin-bottom:4px;
            }

            .opp6110-result:hover {
                background:#f8fafc;
                border-color:#edf0f4;
            }

            .opp6110-result.is-selected {
                background:#f3faf5;
                border-color:#c6e4cf;
            }

            .opp6110-result input {
                width:16px;
                height:16px;
                margin-top:2px;
                flex:0 0 auto;
            }

            .opp6110-result-body {
                min-width:0;
                flex:1 1 auto;
            }

            .opp6110-result-name {
                color:#27364f;
                font-size:11px;
                font-weight:800;
                line-height:1.35;
            }

            .opp6110-result-meta {
                color:#7a8493;
                font-size:9px;
                line-height:1.45;
                margin-top:2px;
            }

            .opp6110-loadmore {
                width:100%;
                border:0;
                border-top:1px solid #e7ebf0;
                background:#fbfcfe;
                color:#475467;
                padding:10px;
                font-size:10px;
                font-weight:800;
                cursor:pointer;
            }

            .opp6110-empty {
                padding:20px;
                text-align:center;
                color:#98a2b3;
                font-size:11px;
            }

            .opp6110-hint {
                margin-top:9px;
                padding:9px 10px;
                border-radius:9px;
                background:#f6f8fb;
                color:#667085;
                font-size:10px;
                line-height:1.5;
            }

            @media (max-width:820px) {
                .opp6110-searchrow {
                    grid-template-columns:1fr;
                }
            }
        `;

        document.head.appendChild(
            style
        );
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

            this.initializeSelectionState();

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


    initializeSelectionState() {
        const ids =
            new Set();

        for (
            const item of
            this.workspace
                ?.priorMarks ||
            []
        ) {
            if (
                item?.ip_record_id
            ) {
                ids.add(
                    String(
                        item.ip_record_id
                    )
                );
            }
        }

        for (
            const item of
            this.workspace
                ?.candidatePriorMarks ||
            []
        ) {
            if (
                item?.selected &&
                item?.id
            ) {
                ids.add(
                    String(
                        item.id
                    )
                );
            }
        }

        this.selectedPriorIds =
            ids;

        this.candidateQuery =
            '';

        this.selectedOnly =
            false;

        this.resultLimit =
            INITIAL_RESULT_LIMIT;
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


    normalize(value) {
        return String(
            value ??
            ''
        )
            .toLocaleLowerCase(
                'tr-TR'
            )
            .replace(
                /\s+/g,
                ' '
            )
            .trim();
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


    savedPriorMap() {
        return new Map(
            (
                this.workspace
                    ?.priorMarks ||
                []
            ).map(
                item => [
                    String(
                        item.ip_record_id
                    ),
                    item
                ]
            )
        );
    }


    candidateMap() {
        return new Map(
            (
                this.workspace
                    ?.candidatePriorMarks ||
                []
            ).map(
                item => [
                    String(
                        item.id
                    ),
                    item
                ]
            )
        );
    }


    renderPriorGoods(
        classes = []
    ) {
        if (
            !Array.isArray(
                classes
            ) ||
            classes.length ===
            0
        ) {
            return `
                <div class="opp6110-hint">
                    Tam emtia listesi bu seçim kaydedildikten sonra
                    ilgili marka sicil kaydından gösterilecektir.
                </div>
            `;
        }

        return `
            <details class="opp6110-goods">
                <summary>
                    <i class="fas fa-list-ul mr-1"></i>
                    Mal / hizmet listesini göster
                    · Sınıflar:
                    ${this.escape(
                        this.renderClassSummary(
                            classes
                        )
                    )}
                </summary>

                <div class="opp6110-goods-body">
                    ${classes
                        .map(
                            cls => {
                                const items =
                                    Array.isArray(
                                        cls.items
                                    )
                                        ? cls.items
                                        : [];

                                return `
                                    <div class="opp6110-goods-class">
                                        <div class="opp6110-goods-class-title">
                                            Sınıf
                                            ${this.escape(
                                                cls.classNo ??
                                                '-'
                                            )}
                                        </div>

                                        <div class="opp6110-goods-text">
                                            ${this.escape(
                                                items.length
                                                    ? items.join('; ')
                                                    : 'Bu sınıf için emtia metni bulunamadı.'
                                            )}
                                        </div>
                                    </div>
                                `;
                            }
                        )
                        .join('')}
                </div>
            </details>
        `;
    }


    renderSelectedPriorMarks() {
        if (
            this.selectedPriorIds
                .size ===
            0
        ) {
            return `
                <div class="opp-case-empty">
                    Henüz seçili müstenit marka yok.
                </div>
            `;
        }

        const savedMap =
            this.savedPriorMap();

        const candidates =
            this.candidateMap();

        const rows =
            [
                ...this.selectedPriorIds
            ]
                .map(
                    id => {
                        const saved =
                            savedMap.get(
                                String(id)
                            );

                        if (saved) {
                            return {
                                id:
                                    String(id),
                                mark:
                                    saved.snapshot ||
                                    {},
                                saved:
                                    true
                            };
                        }

                        const candidate =
                            candidates.get(
                                String(id)
                            ) ||
                            {};

                        return {
                            id:
                                String(id),
                            mark: {
                                markText:
                                    candidate.markText,
                                applicationNo:
                                    candidate.applicationNo,
                                registrationNo:
                                    candidate.registrationNo,
                                classes:
                                    (
                                        candidate.niceClasses ||
                                        []
                                    ).map(
                                        classNo => ({
                                            classNo,
                                            items: []
                                        })
                                    )
                            },
                            saved:
                                false
                        };
                    }
                )
                .sort(
                    (a, b) =>
                        String(
                            a.mark?.markText ||
                            ''
                        ).localeCompare(
                            String(
                                b.mark?.markText ||
                                ''
                            ),
                            'tr-TR'
                        )
                );

        return `
            <div class="opp6110-prior-stack">
                ${rows
                    .map(
                        row => {
                            const mark =
                                row.mark ||
                                {};

                            return `
                                <div
                                    class="opp6110-selected-card"
                                    data-selected-prior-id="${this.escape(row.id)}"
                                >
                                    <div class="opp6110-selected-head">
                                        <div style="min-width:0;">
                                            <div class="opp6110-selected-name">
                                                ${this.escape(
                                                    mark.markText ||
                                                    '-'
                                                )}
                                            </div>

                                            <div class="opp6110-selected-meta">
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

                                            <div class="opp6110-selected-meta">
                                                Sınıflar:
                                                ${this.escape(
                                                    this.renderClassSummary(
                                                        mark.classes ||
                                                        []
                                                    )
                                                )}
                                            </div>
                                        </div>

                                        <button
                                            type="button"
                                            class="opp6110-remove"
                                            data-remove-prior="${this.escape(row.id)}"
                                        >
                                            <i class="fas fa-times mr-1"></i>
                                            Kaldır
                                        </button>
                                    </div>

                                    ${row.saved
                                        ? this.renderPriorGoods(
                                            mark.classes ||
                                            []
                                        )
                                        : `
                                            <div class="opp6110-hint">
                                                Yeni seçim. Kaydettikten sonra tam
                                                mal/hizmet listesi sicil kaydından
                                                burada açılacaktır.
                                            </div>
                                        `
                                    }
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


    getFilteredCandidates() {
        const candidates =
            this.workspace
                ?.candidatePriorMarks ||
            [];

        const query =
            this.normalize(
                this.candidateQuery
            );

        return candidates
            .filter(
                mark => {
                    const id =
                        String(
                            mark.id
                        );

                    if (
                        this.selectedOnly &&
                        !this.selectedPriorIds
                            .has(id)
                    ) {
                        return false;
                    }

                    if (!query) {
                        return true;
                    }

                    const haystack =
                        this.normalize(
                            [
                                mark.markText,
                                mark.applicationNo,
                                mark.registrationNo
                            ]
                                .filter(Boolean)
                                .join(' ')
                        );

                    return haystack
                        .includes(
                            query
                        );
                }
            )
            .sort(
                (a, b) => {
                    const aSelected =
                        this.selectedPriorIds
                            .has(
                                String(a.id)
                            );

                    const bSelected =
                        this.selectedPriorIds
                            .has(
                                String(b.id)
                            );

                    if (
                        aSelected !==
                        bSelected
                    ) {
                        return aSelected
                            ? -1
                            : 1;
                    }

                    return String(
                        a.markText ||
                        ''
                    ).localeCompare(
                        String(
                            b.markText ||
                            ''
                        ),
                        'tr-TR'
                    );
                }
            );
    }


    renderCandidateSelector() {
        const total =
            this.workspace
                ?.candidatePriorMarks
                ?.length ||
            0;

        return `
            <div class="opp6110-selector">
                <div class="opp6110-selector-head">
                    <div class="opp6110-searchrow">
                        <div class="opp6110-searchwrap">
                            <i class="fas fa-search"></i>

                            <input
                                type="search"
                                id="oppPriorSearch"
                                class="opp6110-search"
                                value="${this.escape(this.candidateQuery)}"
                                placeholder="Marka adı veya başvuru numarası ile ara..."
                                autocomplete="off"
                            >
                        </div>

                        <button
                            type="button"
                            id="oppPriorSelectedOnly"
                            class="opp6110-filterbtn ${this.selectedOnly ? 'is-active' : ''}"
                        >
                            <i class="fas fa-check-circle mr-1"></i>
                            Sadece Seçililer
                        </button>

                        <button
                            type="button"
                            id="oppPriorClearSearch"
                            class="opp6110-filterbtn"
                        >
                            Temizle
                        </button>
                    </div>

                    <div class="opp6110-counts">
                        <span
                            id="oppPriorSelectedCount"
                            class="opp6110-count is-selected"
                        >
                            <i class="fas fa-shield-alt"></i>
                            Seçili:
                            ${this.selectedPriorIds.size}
                        </span>

                        <span class="opp6110-count">
                            <i class="fas fa-folder-open"></i>
                            Portföy:
                            ${total}
                        </span>

                        <span
                            id="oppPriorFilteredCount"
                            class="opp6110-count"
                        >
                        </span>
                    </div>
                </div>

                <div
                    id="oppPriorCandidateResults"
                    class="opp6110-results"
                >
                </div>
            </div>

            <div class="opp6110-hint">
                Sistem portföyün tamamını aynı anda ekrana dökmez.
                Arama ile marka adı, başvuru numarası veya tescil numarası
                üzerinden daraltabilir; seçimlerinizi arama değişse bile
                kaybetmeden yönetebilirsiniz.
            </div>
        `;
    }


    renderCandidateResults() {
        const container =
            this.mount
                .querySelector(
                    '#oppPriorCandidateResults'
                );

        if (!container) {
            return;
        }

        const filtered =
            this.getFilteredCandidates();

        const visible =
            filtered.slice(
                0,
                this.resultLimit
            );

        const count =
            this.mount
                .querySelector(
                    '#oppPriorFilteredCount'
                );

        if (count) {
            count.innerHTML = `
                <i class="fas fa-filter"></i>
                Sonuç:
                ${filtered.length}
            `;
        }

        if (!visible.length) {
            container.innerHTML = `
                <div class="opp6110-empty">
                    Aramanıza uygun marka bulunamadı.
                </div>
            `;

            return;
        }

        container.innerHTML = `
            ${visible
                .map(
                    mark => {
                        const selected =
                            this.selectedPriorIds
                                .has(
                                    String(mark.id)
                                );

                        return `
                            <label
                                class="opp6110-result ${selected ? 'is-selected' : ''}"
                                data-candidate-id="${this.escape(mark.id)}"
                            >
                                <input
                                    type="checkbox"
                                    class="opp-prior-check"
                                    value="${this.escape(mark.id)}"
                                    ${selected ? 'checked' : ''}
                                >

                                <div class="opp6110-result-body">
                                    <div class="opp6110-result-name">
                                        ${this.escape(
                                            mark.markText ||
                                            '-'
                                        )}
                                    </div>

                                    <div class="opp6110-result-meta">
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

                                    <div style="margin-top:5px;">
                                        ${this.proofBadge(mark)}
                                    </div>
                                </div>
                            </label>
                        `;
                    }
                )
                .join('')}

            ${filtered.length > visible.length
                ? `
                    <button
                        type="button"
                        id="oppPriorLoadMore"
                        class="opp6110-loadmore"
                    >
                        <i class="fas fa-chevron-down mr-1"></i>
                        Daha Fazla Göster
                        (${visible.length}/${filtered.length})
                    </button>
                `
                : ''
            }
        `;

        this.bindCandidateResultEvents();
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
                    · UX ${UX_PACKAGE_VERSION}
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
                        <span
                            id="oppSelectedRightsTitleCount"
                            style="
                                margin-left:auto;
                                font-size:10px;
                                color:#667085;
                                font-weight:700;
                            "
                        >
                            ${this.selectedPriorIds.size} marka
                        </span>
                    </div>

                    <div id="oppSelectedPriorMarks">
                        ${this.renderSelectedPriorMarks()}
                    </div>
                </section>
            </div>

            <section
                class="opp-case-panel"
                style="margin-top:14px;"
            >
                <div class="opp-case-panel-title">
                    <i class="fas fa-search"></i>
                    Müstenit Marka Belirleme
                </div>

                <div
                    class="opp-case-meta"
                    style="margin-bottom:11px;"
                >
                    Marka adı veya başvuru numarasıyla arayın;
                    yalnız gerçekten dayanılacak hakları ekleyin.
                    1.000+ markalı portföylerde bütün listeyi ekrana
                    dökmek yerine arama ve seçili-hak görünümü kullanılır.
                </div>

                ${this.renderCandidateSelector()}
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
                    Seçili haklar ve gerekçeler kaydedildiğinde
                    hukuki analiz ekranı aynı canonical dosya
                    kapsamını kullanır.
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

        this.renderCandidateResults();

        this.bindEvents();
    }


    bindCandidateResultEvents() {
        this.mount
            .querySelectorAll(
                '.opp-prior-check'
            )
            .forEach(
                checkbox => {
                    checkbox.addEventListener(
                        'change',
                        () => {
                            const id =
                                String(
                                    checkbox.value
                                );

                            if (
                                checkbox.checked
                            ) {
                                this.selectedPriorIds
                                    .add(id);
                            } else {
                                this.selectedPriorIds
                                    .delete(id);
                            }

                            checkbox
                                .closest(
                                    '.opp6110-result'
                                )
                                ?.classList
                                .toggle(
                                    'is-selected',
                                    checkbox.checked
                                );

                            this.refreshSelectionSurfaces();
                        }
                    );
                }
            );

        this.mount
            .querySelector(
                '#oppPriorLoadMore'
            )
            ?.addEventListener(
                'click',
                () => {
                    this.resultLimit +=
                        RESULT_LIMIT_STEP;

                    this.renderCandidateResults();
                }
            );
    }


    refreshSelectionSurfaces() {
        const selectedMount =
            this.mount
                .querySelector(
                    '#oppSelectedPriorMarks'
                );

        if (selectedMount) {
            selectedMount.innerHTML =
                this.renderSelectedPriorMarks();
        }

        const count =
            this.mount
                .querySelector(
                    '#oppPriorSelectedCount'
                );

        if (count) {
            count.innerHTML = `
                <i class="fas fa-shield-alt"></i>
                Seçili:
                ${this.selectedPriorIds.size}
            `;
        }

        const titleCount =
            this.mount
                .querySelector(
                    '#oppSelectedRightsTitleCount'
                );

        if (titleCount) {
            titleCount.textContent =
                `${this.selectedPriorIds.size} marka`;
        }

        this.bindSelectedPriorEvents();

        if (
            this.selectedOnly
        ) {
            this.renderCandidateResults();
        }
    }


    bindSelectedPriorEvents() {
        this.mount
            .querySelectorAll(
                '[data-remove-prior]'
            )
            .forEach(
                button => {
                    button.addEventListener(
                        'click',
                        event => {
                            event.preventDefault();
                            event.stopPropagation();

                            const id =
                                String(
                                    button.dataset
                                        .removePrior ||
                                    ''
                                );

                            this.selectedPriorIds
                                .delete(id);

                            const checkbox =
                                this.mount
                                    .querySelector(
                                        `.opp-prior-check[value="${CSS.escape(id)}"]`
                                    );

                            if (checkbox) {
                                checkbox.checked =
                                    false;

                                checkbox
                                    .closest(
                                        '.opp6110-result'
                                    )
                                    ?.classList
                                    .remove(
                                        'is-selected'
                                    );
                            }

                            this.refreshSelectionSurfaces();
                        }
                    );
                }
            );
    }


    bindEvents() {
        this.bindSelectedPriorEvents();

        const search =
            this.mount
                .querySelector(
                    '#oppPriorSearch'
                );

        search
            ?.addEventListener(
                'input',
                () => {
                    this.candidateQuery =
                        search.value ||
                        '';

                    this.resultLimit =
                        INITIAL_RESULT_LIMIT;

                    this.renderCandidateResults();
                }
            );

        this.mount
            .querySelector(
                '#oppPriorSelectedOnly'
            )
            ?.addEventListener(
                'click',
                event => {
                    this.selectedOnly =
                        !this.selectedOnly;

                    event.currentTarget
                        .classList
                        .toggle(
                            'is-active',
                            this.selectedOnly
                        );

                    this.resultLimit =
                        INITIAL_RESULT_LIMIT;

                    this.renderCandidateResults();
                }
            );

        this.mount
            .querySelector(
                '#oppPriorClearSearch'
            )
            ?.addEventListener(
                'click',
                () => {
                    this.candidateQuery =
                        '';

                    this.selectedOnly =
                        false;

                    this.resultLimit =
                        INITIAL_RESULT_LIMIT;

                    const searchInput =
                        this.mount
                            .querySelector(
                                '#oppPriorSearch'
                            );

                    if (searchInput) {
                        searchInput.value =
                            '';
                    }

                    this.mount
                        .querySelector(
                            '#oppPriorSelectedOnly'
                        )
                        ?.classList
                        .remove(
                            'is-active'
                        );

                    this.renderCandidateResults();
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
            this.mount
                .querySelector(
                    '#oppSaveWorkspaceBtn'
                );

        const selectedPriorMarkIds =
            [
                ...this.selectedPriorIds
            ];

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
            selectedPriorMarkIds
                .length ===
            0
        ) {
            showNotification(
                'En az bir müstenit marka seçmelisiniz.',
                'warning'
            );

            return;
        }

        if (
            selectedGrounds
                .length ===
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

            this.initializeSelectionState();

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
