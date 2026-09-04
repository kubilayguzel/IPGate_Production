import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

const GOODS_SIMILARITY_OPTIONS = [
    ['', 'Seçiniz...'],
    ['identical', 'Aynı / özdeş'],
    ['high', 'Yüksek derecede benzer'],
    ['medium', 'Benzer'],
    ['low', 'Düşük derecede benzer'],
    ['none', 'Benzer değil']
];

const GOODS_CRITERIA_OPTIONS = [
    ['nature', 'Nitelik / özellik'],
    ['purpose', 'Amaç'],
    ['use_method', 'Kullanım biçimi'],
    ['complementary', 'Tamamlayıcılık'],
    ['competitive', 'Rekabet / ikame'],
    ['distribution_channels', 'Dağıtım / satış kanalları'],
    ['relevant_public', 'İlgili tüketici kesimi']
];

const DISTINCTIVENESS_OPTIONS = [
    ['', 'Seçiniz...'],
    ['high', 'Yüksek ayırt edicilik'],
    ['normal', 'Normal ayırt edicilik'],
    ['weak', 'Zayıf ayırt edicilik'],
    ['descriptive', 'Tanımlayıcı nitelikte'],
    ['non_distinctive', 'Ayırt edici değil']
];


const ELEMENT_DISTINCTIVENESS_OPTIONS = [
    ['', 'Seçiniz...'],
    ['high', 'Yüksek ayırt edicilik'],
    ['normal', 'Normal ayırt edicilik'],
    ['weak', 'Zayıf ayırt edicilik'],
    ['descriptive', 'Tanımlayıcı nitelikte'],
    ['non_distinctive', 'Ayırt edici değil'],

    [
        'not_assessed',
        'Bu unsur hakkında ayırt edicilik tespiti yapmıyorum'
    ],

    [
        'not_applicable',
        'Uygulanamaz / ek unsur yok'
    ]
];


const ADDITIONAL_ROLE_OPTIONS = [
    ['', 'Seçiniz...'],
    ['negligible', 'İhmal edilebilir / tali'],
    ['secondary_distinctive', 'İkincil fakat ayırt edici'],
    ['co_dominant', 'Birlikte baskın'],
    ['dominant', 'Baskın unsur'],

    [
        'not_assessed',
        'Bu unsurun rolü hakkında tespit yapmıyorum'
    ],

    [
        'not_applicable',
        'Uygulanamaz / ek unsur yok'
    ]
];

const INDEPENDENT_ROLE_OPTIONS = [
    ['', 'Seçiniz...'],
    ['yes', 'Evet'],
    ['no', 'Hayır'],
    ['uncertain', 'Sınırda / ayrıca değerlendirme gerekli'],
    ['not_applicable', 'Uygulanamaz']
];

const SIGN_SIMILARITY_OPTIONS = [
    ['', 'Seçiniz...'],
    ['high', 'Yüksek'],
    ['medium', 'Orta'],
    ['low', 'Düşük'],
    ['none', 'Benzerlik yok / farklı'],
    ['no_comparison', 'Anlamsal karşılaştırma yapılamıyor']
];

const PUBLIC_TYPE_OPTIONS = [
    ['', 'Seçiniz...'],
    ['general', 'Genel tüketici'],
    ['professional', 'Profesyonel / uzman tüketici'],
    ['mixed', 'Karma tüketici grubu']
];

const ATTENTION_OPTIONS = [
    ['', 'Seçiniz...'],
    ['low', 'Düşük dikkat'],
    ['normal', 'Normal dikkat'],
    ['high', 'Yüksek dikkat']
];

const GLOBAL_OPTIONS = [
    ['', 'Seçiniz...'],
    ['exists', 'Karıştırılma ihtimali var'],
    ['borderline', 'Sınırda / tartışmalı'],
    ['does_not_exist', 'Karıştırılma ihtimali yok']
];

const ASSOCIATION_OPTIONS = [
    ['', 'Seçiniz...'],
    ['exists', 'İlişkilendirilme ihtimali var'],
    ['borderline', 'Sınırda / tartışmalı'],
    ['does_not_exist', 'İlişkilendirilme ihtimali yok']
];

export class Smk61DecisionTreeManager {

    constructor(taskId, workspace) {
        this.taskId = String(taskId);
        this.workspace = workspace;
        this.mount = document.getElementById('smk61DecisionTreeMount');
        this.context = null;
    }

    async init() {
        if (!this.mount) return;

        const grounds = this.workspace?.case?.selected_grounds || [];

        if (!grounds.includes('SMK_6_1')) {
            this.mount.innerHTML = `
                <div class="opp61-disabled-note">
                    <i class="fas fa-info-circle mr-2"></i>
                    SMK 6/1 seçili olmadığı için 6/1 hukuki analiz ağacı gösterilmiyor.
                </div>
            `;
            return;
        }

        await this.load();
    }

    async invoke(action, payload = {}) {
        const { data, error } = await supabase.functions.invoke(
            'opposition-analysis',
            {
                body: {
                    action,
                    taskId: this.taskId,
                    payload
                }
            }
        );

        if (error) {
            throw new Error(error.message || '6/1 analiz servisine ulaşılamadı.');
        }

        if (!data?.success) {
            throw new Error(data?.error || '6/1 analiz işlemi başarısız oldu.');
        }

        return data.context;
    }

    async load() {
        this.renderLoading();

        try {
            this.context = await this.invoke('get');
            this.render();
        } catch (error) {
            console.error('SMK 6/1 analiz yükleme hatası:', error);
            this.renderError(error.message);
        }
    }

    escape(value) {
        return String(value ?? '').replace(
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

    optionList(options, selectedValue) {
        return options.map(([value, label]) => `
            <option value="${this.escape(value)}" ${value === selectedValue ? 'selected' : ''}>
                ${this.escape(label)}
            </option>
        `).join('');
    }

    renderLoading() {
        this.mount.innerHTML = `
            <div class="opp61-card">
                <div class="opp61-loading">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span>SMK 6/1 hukuki analiz ağacı hazırlanıyor...</span>
                </div>
            </div>
        `;
    }

    renderError(message) {
        this.mount.innerHTML = `
            <div class="opp61-card">
                <div class="alert alert-danger mb-0">
                    <strong>6/1 analiz motoru yüklenemedi.</strong><br>
                    ${this.escape(message)}
                    <div class="mt-3">
                        <button type="button" id="opp61RetryBtn" class="btn btn-sm btn-outline-danger">
                            <i class="fas fa-redo mr-1"></i>Tekrar Dene
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('opp61RetryBtn')?.addEventListener('click', () => this.load());
    }

    readinessHtml() {
        const readiness = this.context?.readiness || {};
        const blockers = readiness.blockers || [];
        const warnings = readiness.warnings || [];

        const statusClass = readiness.canDraft ? 'is-ready' : 'is-incomplete';
        const statusText = readiness.canDraft ? 'Dilekçe üretimine hazır' : 'Analiz tamamlanmadı';
        const statusIcon = readiness.canDraft ? 'fa-check-circle' : 'fa-exclamation-circle';

        return `
            <div class="opp61-readiness ${statusClass}">
                <div class="opp61-readiness-head">
                    <div>
                        <i class="fas ${statusIcon} mr-2"></i>
                        <strong>${statusText}</strong>
                    </div>
                    <div class="opp61-readiness-counts">
                        <span>${blockers.length} eksik/hata</span>
                        <span>${warnings.length} uyarı</span>
                    </div>
                </div>

                ${this.context?.stale ? `
                    <div class="opp61-stale-alert">
                        <i class="fas fa-sync-alt mr-1"></i>
                        Müstenit haklar veya rakip kapsam son kayıt sonrasında değişmiş. Analizi güncelleyip yeniden kaydetmelisiniz.
                    </div>
                ` : ''}

                ${blockers.length ? `
                    <details class="opp61-readiness-details" open>
                        <summary>Eksik / engelleyici noktalar</summary>
                        <ul>
                            ${blockers.map(item => `<li>${this.escape(item)}</li>`).join('')}
                        </ul>
                    </details>
                ` : ''}

                ${warnings.length ? `
                    <details class="opp61-readiness-details">
                        <summary>Uyarılar</summary>
                        <ul>
                            ${warnings.map(item => `<li>${this.escape(item)}</li>`).join('')}
                        </ul>
                    </details>
                ` : ''}
            </div>
        `;
    }

    priorRightsReviewHtml() {
        const rights = this.context?.priorRights || [];
        const reviewRows = this.context?.formData?.priorRightsReview || [];

        if (!rights.length) {
            return `<div class="opp-empty-note">Seçili müstenit hak bulunmuyor.</div>`;
        }

        return rights.map(right => {
            const review = reviewRows.find(row => String(row.ipRecordId) === String(right.id)) || {};
            const blockers = right.autoChecks?.blockers || [];
            const warnings = right.autoChecks?.warnings || [];

            return `
                <div class="opp61-prior-review" data-prior-id="${this.escape(right.id)}">
                    <div class="opp61-prior-review-head">
                        <div>
                            <div class="opp61-prior-title">${this.escape(right.markText || '-')}</div>
                            <div class="opp61-meta-line">
                                Başvuru: ${this.escape(right.applicationNo || '-')} ·
                                Tescil: ${this.escape(right.registrationNo || '-')} ·
                                Statü: ${this.escape(right.status || '-')}
                            </div>
                        </div>

                        <label class="opp61-confirm-toggle">
                            <input
                                type="checkbox"
                                class="opp61-prior-confirm"
                                ${review.confirmedEligible ? 'checked' : ''}
                            >
                            <span>Müstenit hak uygunluğu teyit edildi</span>
                        </label>
                    </div>

                    ${blockers.length ? `
                        <div class="opp61-auto-check opp61-auto-blocker">
                            ${blockers.map(item => `<div><i class="fas fa-times-circle mr-1"></i>${this.escape(item)}</div>`).join('')}
                        </div>
                    ` : ''}

                    ${warnings.length ? `
                        <div class="opp61-auto-check opp61-auto-warning">
                            ${warnings.map(item => `<div><i class="fas fa-exclamation-triangle mr-1"></i>${this.escape(item)}</div>`).join('')}
                        </div>
                    ` : ''}

                    <textarea
                        class="form-control opp61-prior-note mt-2"
                        rows="2"
                        placeholder="Bu hak bakımından gerekiyorsa kısa not..."
                    >${this.escape(review.note || '')}</textarea>
                </div>
            `;
        }).join('');
    }

    priorClassOptionsHtml(selectedKeys = []) {
        const selected = new Set(selectedKeys || []);
        const rights = this.context?.priorRights || [];

        return rights.map(right => `
            <div class="opp61-prior-class-group">
                <div class="opp61-prior-class-title">
                    ${this.escape(right.markText || right.applicationNo || right.id)}
                </div>

                <div class="opp61-prior-class-list">
                    ${(right.classes || []).map(cls => {
                        const key = `${right.id}:${Number(cls.classNo)}`;
                        return `
                            <label class="opp61-mini-check">
                                <input
                                    type="checkbox"
                                    class="opp61-prior-class-check"
                                    value="${this.escape(key)}"
                                    ${selected.has(key) ? 'checked' : ''}
                                >
                                <span>Sınıf ${this.escape(cls.classNo)}</span>
                            </label>
                        `;
                    }).join('')}
                </div>
            </div>
        `).join('');
    }

    criteriaHtml(selectedCriteria = []) {
        const selected = new Set(selectedCriteria || []);

        return GOODS_CRITERIA_OPTIONS.map(([value, label]) => `
            <label class="opp61-mini-check">
                <input
                    type="checkbox"
                    class="opp61-criteria-check"
                    value="${this.escape(value)}"
                    ${selected.has(value) ? 'checked' : ''}
                >
                <span>${this.escape(label)}</span>
            </label>
        `).join('');
    }

        goodsAssessmentHtml() {

        const rows =
            this.context
                ?.formData
                ?.goodsAssessments ||
            [];


        if (!rows.length) {

            return `
                <div class="opp-empty-note">
                    Rakip başvurunun tam mal/hizmet kapsamı bulunamadı.
                </div>
            `;
        }


        return rows.map(row => `

            <div
                class="opp61-goods-card"
                data-opponent-class="${this.escape(row.opponentClassNo)}"
            >

                <div class="opp61-goods-head">

                    <div>

                        <div class="opp61-class-chip">
                            Rakip Sınıf ${this.escape(row.opponentClassNo)}
                        </div>

                        <div class="opp61-goods-caption">
                            İtiraz edilen kapsam
                        </div>

                    </div>


                    <label class="opp61-refusal-toggle">

                        <input
                            type="checkbox"
                            class="opp61-refusal-check"
                            ${row.requestedRefusal ? 'checked' : ''}
                        >

                        <span>
                            Bu sınıf bakımından ret talep et
                        </span>

                    </label>

                </div>


                <details class="opp61-opponent-goods">

                    <summary>
                        Rakip sınıfın tam mal/hizmet metnini göster
                    </summary>

                    <div>
                        ${
                            this.escape(
                                row.opponentText ||
                                'Metin bulunamadı.'
                            )
                        }
                    </div>

                </details>


                <div class="opp61-field-grid mt-3">

                    <div>

                        <label class="form-label">
                            Benzerlik Derecesi
                        </label>

                        <select
                            class="form-select opp61-similarity-select"
                        >

                            ${
                                this.optionList(
                                    GOODS_SIMILARITY_OPTIONS,
                                    row.similarityLevel ===
                                    'not_assessed'
                                        ? ''
                                        : row.similarityLevel
                                )
                            }

                        </select>

                    </div>


                    <div>

                        <label class="form-label">
                            Dayanılan Müstenit Sınıf(lar)
                        </label>

                        <div class="opp61-prior-class-box">

                            ${
                                this.priorClassOptionsHtml(
                                    row.matchedPriorClasses ||
                                    []
                                )
                            }

                        </div>

                    </div>

                </div>


                <div class="mt-3">

                    <label class="form-label">
                        Mal/Hizmet Benzerliği Kriterleri
                    </label>

                    <div class="opp61-criteria-box">

                        ${
                            this.criteriaHtml(
                                row.criteria ||
                                []
                            )
                        }

                    </div>

                </div>


                <!-- ========================================
                     EXACT REFUSAL SCOPE
                     ======================================== -->

                <div
                    class="
                        opp61-refusal-scope
                        mt-3
                        ${row.requestedRefusal ? '' : 'd-none'}
                    "
                >

                    <div class="opp61-guidance-note mb-2">

                        <i class="fas fa-shield-alt mr-1"></i>

                        <strong>
                            Exact ret kapsamı:
                        </strong>

                        “Sınıf ${this.escape(row.opponentClassNo)}
                        reddedilsin” demek artık yeterli değildir.

                        Sınıfın tamamı mı, yoksa sınıf
                        içindeki belirli mal/hizmetler mi
                        reddedilecek, açıkça seçin.

                    </div>


                    <label class="form-label">
                        Ret Kapsamı
                    </label>


                    <select
                        class="
                            form-select
                            opp61-refusal-scope-mode
                        "
                    >

                        <option value="">
                            Seçiniz...
                        </option>


                        <option
                            value="full_class"
                            ${
                                row.refusalScopeMode ===
                                'full_class'
                                    ? 'selected'
                                    : ''
                            }
                        >
                            Bu sınıfın tamamı
                        </option>


                        <option
                            value="partial"
                            ${
                                row.refusalScopeMode ===
                                'partial'
                                    ? 'selected'
                                    : ''
                            }
                        >
                            Bu sınıf içinde kısmi kapsam
                        </option>

                    </select>


                    <div
                        class="
                            opp61-partial-scope-box
                            mt-2
                            ${
                                row.refusalScopeMode ===
                                'partial'
                                    ? ''
                                    : 'd-none'
                            }
                        "
                    >

                        <label class="form-label">

                            Reddini istediğimiz exact
                            mal/hizmet metni

                        </label>


                        <textarea
                            class="
                                form-control
                                opp61-refusal-scope-text
                            "
                            rows="6"
                            placeholder="Rakip başvurunun yukarıdaki resmi mal/hizmet metninden, reddini istediğiniz kısmı değiştirmeden buraya kopyalayın."
                        >${this.escape(row.refusalScopeText || '')}</textarea>


                        <small class="text-muted d-block mt-1">

                            Metni yeniden yazmayın veya
                            özetlemeyin.

                            Rakip başvurunun resmi kapsamından
                            aynen kopyalayın.

                            Birden fazla bölüm varsa satır sonu
                            veya “;” ile ayırabilirsiniz.

                        </small>

                    </div>


                    <div
                        class="
                            opp61-full-scope-note
                            mt-2
                            ${
                                row.refusalScopeMode ===
                                'full_class'
                                    ? ''
                                    : 'd-none'
                            }
                        "
                    >

                        <small class="text-muted">

                            Sistem ret kapsamını rakip
                            Sınıf ${this.escape(row.opponentClassNo)}
                            için kayıtlı tam mal/hizmet
                            metninden otomatik alacaktır.

                        </small>

                    </div>

                </div>


                <div class="mt-3">

                    <label class="form-label">

                        Kısa Dosya Notu

                        <span class="text-muted text-lowercase">
                            (opsiyonel)
                        </span>

                    </label>


                    <textarea
                        class="form-control opp61-goods-note"
                        rows="2"
                        placeholder="Örn: hizmetlerin aynı dağıtım kanalından sunulması ve aynı ticari kaynağa atfedilmesi..."
                    >${this.escape(row.note || '')}</textarea>

                </div>

            </div>

        `).join('');
    }

        signAssessmentHtml() {

        const sign =
            this.context
                ?.formData
                ?.signAssessment ||
            {};


        return `

            <div class="opp61-field-grid">


                <div>

                    <label class="form-label">
                        Ortak Unsur(lar)
                    </label>

                    <input
                        type="text"
                        id="opp61CommonElements"
                        class="form-input"
                        value="${this.escape(sign.commonElements || '')}"
                        placeholder="Örn: Z"
                    >

                </div>


                <div>

                    <label class="form-label">
                        Farklı Unsur(lar)
                    </label>

                    <input
                        type="text"
                        id="opp61Differences"
                        class="form-input"
                        value="${this.escape(sign.differences || '')}"
                        placeholder="Örn: şarj / premium cars. Yoksa 'yok' yazın."
                    >

                </div>


                <div>

                    <label class="form-label">
                        Ortak Unsurun Ayırt Ediciliği
                    </label>

                    <select
                        id="opp61Distinctiveness"
                        class="form-select"
                    >

                        ${
                            this.optionList(
                                DISTINCTIVENESS_OPTIONS,
                                sign.commonElementDistinctiveness ||
                                ''
                            )
                        }

                    </select>

                </div>


                <div>

                    <label class="form-label">
                        Ortak Unsurun Bağımsız Ayırt Edici Rolü
                    </label>

                    <select
                        id="opp61IndependentRole"
                        class="form-select"
                    >

                        ${
                            this.optionList(
                                INDEPENDENT_ROLE_OPTIONS,
                                sign.independentDistinctiveRole ||
                                ''
                            )
                        }

                    </select>

                </div>


                <div>

                    <label class="form-label">
                        Müstenit Markanın Baskın /
                        Ayırt Edici Unsuru
                    </label>

                    <input
                        type="text"
                        id="opp61ClientDominant"
                        class="form-input"
                        value="${this.escape(sign.clientDominantElements || '')}"
                        placeholder="Somut kanaatinizi yazın."
                    >

                </div>


                <div>

                    <label class="form-label">
                        Rakip Markanın Baskın /
                        Ayırt Edici Unsuru
                    </label>

                    <input
                        type="text"
                        id="opp61OpponentDominant"
                        class="form-input"
                        value="${this.escape(sign.opponentDominantElements || '')}"
                        placeholder="Somut kanaatinizi yazın."
                    >

                </div>

            </div>


            <!-- ==========================================
                 ELEMENT QUALIFICATION LOCK
                 ========================================== -->

            <div class="opp61-element-lock-grid mt-3">


                <div class="opp61-element-lock-card">

                    <div class="opp61-element-lock-title">
                        Müstenit markadaki ek unsur(lar)
                    </div>


                    <div class="mb-2">

                        <label class="form-label">
                            Ek unsur metni
                        </label>

                        <input
                            type="text"
                            id="opp61ClientAdditionalElements"
                            class="form-input"
                            value="${this.escape(sign.clientAdditionalElements || '')}"
                            placeholder="Örn: şarj. Ek unsur yoksa 'yok' yazın."
                        >

                    </div>


                    <div class="mb-2">

                        <label class="form-label">
                            Ayırt edicilik
                        </label>

                        <select
                            id="opp61ClientAdditionalDistinctiveness"
                            class="form-select"
                        >

                            ${
                                this.optionList(
                                    ELEMENT_DISTINCTIVENESS_OPTIONS,
                                    sign.clientAdditionalDistinctiveness ||
                                    ''
                                )
                            }

                        </select>

                    </div>


                    <div>

                        <label class="form-label">
                            Rol
                        </label>

                        <select
                            id="opp61ClientAdditionalRole"
                            class="form-select"
                        >

                            ${
                                this.optionList(
                                    ADDITIONAL_ROLE_OPTIONS,
                                    sign.clientAdditionalRole ||
                                    ''
                                )
                            }

                        </select>

                    </div>

                </div>


                <div class="opp61-element-lock-card">

                    <div class="opp61-element-lock-title">
                        Rakip markadaki ek unsur(lar)
                    </div>


                    <div class="mb-2">

                        <label class="form-label">
                            Ek unsur metni
                        </label>

                        <input
                            type="text"
                            id="opp61OpponentAdditionalElements"
                            class="form-input"
                            value="${this.escape(sign.opponentAdditionalElements || '')}"
                            placeholder="Örn: premium cars. Ek unsur yoksa 'yok' yazın."
                        >

                    </div>


                    <div class="mb-2">

                        <label class="form-label">
                            Ayırt edicilik
                        </label>

                        <select
                            id="opp61OpponentAdditionalDistinctiveness"
                            class="form-select"
                        >

                            ${
                                this.optionList(
                                    ELEMENT_DISTINCTIVENESS_OPTIONS,
                                    sign.opponentAdditionalDistinctiveness ||
                                    ''
                                )
                            }

                        </select>

                    </div>


                    <div>

                        <label class="form-label">
                            Rol
                        </label>

                        <select
                            id="opp61OpponentAdditionalRole"
                            class="form-select"
                        >

                            ${
                                this.optionList(
                                    ADDITIONAL_ROLE_OPTIONS,
                                    sign.opponentAdditionalRole ||
                                    ''
                                )
                            }

                        </select>

                    </div>

                </div>

            </div>


            <div class="opp61-field-grid mt-3">


                <div>

                    <label class="form-label">
                        Görsel Benzerlik
                    </label>

                    <select
                        id="opp61Visual"
                        class="form-select"
                    >

                        ${
                            this.optionList(
                                SIGN_SIMILARITY_OPTIONS,
                                sign.visualSimilarity ||
                                ''
                            )
                        }

                    </select>

                </div>


                <div>

                    <label class="form-label">
                        İşitsel Benzerlik
                    </label>

                    <select
                        id="opp61Aural"
                        class="form-select"
                    >

                        ${
                            this.optionList(
                                SIGN_SIMILARITY_OPTIONS,
                                sign.auralSimilarity ||
                                ''
                            )
                        }

                    </select>

                </div>


                <div>

                    <label class="form-label">
                        Kavramsal Benzerlik / Farklılık
                    </label>

                    <select
                        id="opp61Conceptual"
                        class="form-select"
                    >

                        ${
                            this.optionList(
                                SIGN_SIMILARITY_OPTIONS,
                                sign.conceptualSimilarity ||
                                ''
                            )
                        }

                    </select>

                </div>


                <div>

                    <label class="form-label">
                        Genel İzlenim Benzerliği
                    </label>

                    <select
                        id="opp61Overall"
                        class="form-select"
                    >

                        ${
                            this.optionList(
                                SIGN_SIMILARITY_OPTIONS,
                                sign.overallSimilarity ||
                                ''
                            )
                        }

                    </select>

                </div>

            </div>


            <div class="mt-3">

                <label class="form-label">

                    İşaret Analizi Notu

                    <span class="text-muted text-lowercase">
                        (opsiyonel)
                    </span>

                </label>

                <textarea
                    id="opp61SignNote"
                    class="form-control"
                    rows="3"
                >${this.escape(sign.note || '')}</textarea>

            </div>
        `;
    }

    publicAssessmentHtml() {
        const value = this.context?.formData?.publicAssessment || {};

        return `
            <div class="opp61-field-grid">
                <div>
                    <label class="form-label">İlgili Tüketici Kesimi</label>
                    <select id="opp61PublicType" class="form-select">
                        ${this.optionList(PUBLIC_TYPE_OPTIONS, value.publicType || '')}
                    </select>
                </div>

                <div>
                    <label class="form-label">Dikkat Düzeyi</label>
                    <select id="opp61Attention" class="form-select">
                        ${this.optionList(ATTENTION_OPTIONS, value.attentionLevel || '')}
                    </select>
                </div>
            </div>

            <div class="mt-3">
                <label class="form-label">Tüketici / Dikkat Düzeyi Notu <span class="text-muted text-lowercase">(opsiyonel)</span></label>
                <textarea id="opp61PublicNote" class="form-control" rows="2">${this.escape(value.note || '')}</textarea>
            </div>
        `;
    }

    globalAssessmentHtml() {
        const value = this.context?.formData?.globalAssessment || {};
        const refusalClasses = (this.context?.formData?.goodsAssessments || [])
            .filter(row => row.requestedRefusal)
            .map(row => row.opponentClassNo);

        return `
            <div class="opp61-field-grid">
                <div>
                    <label class="form-label">Global 6/1 Sonucu</label>
                    <select id="opp61GlobalConclusion" class="form-select">
                        ${this.optionList(GLOBAL_OPTIONS, value.conclusion || '')}
                    </select>
                </div>

                <div>
                    <label class="form-label">İlişkilendirilme İhtimali</label>
                    <select id="opp61Association" class="form-select">
                        ${this.optionList(ASSOCIATION_OPTIONS, value.associationLikelihood || '')}
                    </select>
                </div>
            </div>

            <div class="opp61-refusal-summary mt-3">
                <strong>Seçili ret kapsamı:</strong>
                ${refusalClasses.length
                    ? refusalClasses.map(no => `<span>Sınıf ${this.escape(no)}</span>`).join('')
                    : '<em>Henüz ret talep edilen sınıf seçilmedi.</em>'}
            </div>

            <div class="mt-3">
                <label class="form-label">Avukatın Dosyaya Özgü Kısa Değerlendirmesi</label>
                <textarea
                    id="opp61LawyerMerits"
                    class="form-control"
                    rows="6"
                    placeholder="Yaklaşık 3–8 cümle. Dosyada gerçekten kritik olan noktaları yazın; AI daha sonra bu teşhisi standart EVREKA metnine dönüştürecek."
                >${this.escape(value.lawyerMerits || '')}</textarea>
            </div>
        `;
    }

    render() {
        if (!this.context?.enabled) {
            this.mount.innerHTML = `
                <div class="opp61-disabled-note">
                    SMK 6/1 gerekçesi artık seçili değil. Çalışma alanını kaydedip sayfayı yenileyin.
                </div>
            `;
            return;
        }

        this.mount.innerHTML = `
            <div class="opp61-card">
                <div class="opp61-header">
                    <div>
                        <div class="opp61-eyebrow">SMK 6/1 DECISION TREE</div>
                        <h4 class="opp61-title mb-1">Karıştırılma İhtimali Hukuki Analizi</h4>
                        <div class="opp61-subtitle">
                            Avukat hukuki teşhisi verir; AI yalnızca kaydedilmiş teşhisi standardize ederek yazıya dönüştürür.
                        </div>
                    </div>

                    <div class="opp61-version-badge">v1</div>
                </div>

                ${this.readinessHtml()}

                <details class="opp61-section" open>
                    <summary>
                        <span><strong>A.</strong> Müstenit Hakların Hukuki Uygunluğu</span>
                        <small>${(this.context.priorRights || []).length} hak</small>
                    </summary>
                    <div class="opp61-section-body">
                        ${this.priorRightsReviewHtml()}
                    </div>
                </details>

                <details class="opp61-section" open>
                    <summary>
                        <span><strong>B.</strong> Mal / Hizmet Benzerliği ve Ret Kapsamı</span>
                        <small>${(this.context?.opponent?.goodsByClass || []).length} rakip sınıf</small>
                    </summary>
                    <div class="opp61-section-body">
                        <div class="opp61-guidance-note mb-3">
                            <i class="fas fa-info-circle mr-1"></i>
                            Nice sınıf numarası tek başına benzerlik sonucu değildir. Her rakip sınıf için tam kapsamı, dayanılan müstenit sınıfı ve benzerlik kriterlerini ayrıca işaretleyin.
                        </div>
                        ${this.goodsAssessmentHtml()}
                    </div>
                </details>

                <details class="opp61-section" open>
                    <summary>
                        <span><strong>C.</strong> İşaret Benzerliği</span>
                        <small>görsel · işitsel · kavramsal</small>
                    </summary>
                    <div class="opp61-section-body">
                        ${this.signAssessmentHtml()}
                    </div>
                </details>

                <details class="opp61-section" open>
                    <summary>
                        <span><strong>D.</strong> İlgili Tüketici ve Dikkat Düzeyi</span>
                        <small>relevant public</small>
                    </summary>
                    <div class="opp61-section-body">
                        ${this.publicAssessmentHtml()}
                    </div>
                </details>

                <details class="opp61-section" open>
                    <summary>
                        <span><strong>E.</strong> Bütüncül Değerlendirme ve Sonuç</span>
                        <small>global assessment</small>
                    </summary>
                    <div class="opp61-section-body">
                        ${this.globalAssessmentHtml()}
                    </div>
                </details>

                <div class="opp61-save-bar">
                    <div>
                        <div class="font-weight-bold">6/1 hukuki analiz kaydı</div>
                        <div class="text-muted small">
                            Kaydetme sonrasında sistem eksik alanları deterministik olarak yeniden denetler.
                        </div>
                    </div>

                    <button type="button" id="opp61SaveBtn" class="btn btn-primary px-4">
                        <i class="fas fa-check-double mr-2"></i>
                        6/1 Analizini Kaydet ve Kontrol Et
                    </button>
                </div>
            </div>
        `;

        this.bindEvents();
    }

        bindEvents() {

        document
            .querySelectorAll(
                '.opp61-refusal-check'
            )
            .forEach(input => {

                input.addEventListener(
                    'change',
                    event => {

                        const card =
                            event.target.closest(
                                '.opp61-goods-card'
                            );


                        this.syncRefusalScopeUi(
                            card
                        );


                        this.refreshLocalRefusalSummary();
                    }
                );
            });


        document
            .querySelectorAll(
                '.opp61-refusal-scope-mode'
            )
            .forEach(select => {

                select.addEventListener(
                    'change',
                    event => {

                        const card =
                            event.target.closest(
                                '.opp61-goods-card'
                            );


                        this.syncRefusalScopeUi(
                            card
                        );


                        this.refreshLocalRefusalSummary();
                    }
                );
            });


        document
            .getElementById(
                'opp61SaveBtn'
            )
            ?.addEventListener(
                'click',
                () => this.save()
            );
    }


    syncRefusalScopeUi(card) {

        if (!card) {
            return;
        }


        const requested =
            card
                .querySelector(
                    '.opp61-refusal-check'
                )
                ?.checked === true;


        const scopeContainer =
            card.querySelector(
                '.opp61-refusal-scope'
            );


        const mode =
            card
                .querySelector(
                    '.opp61-refusal-scope-mode'
                )
                ?.value || '';


        const partialBox =
            card.querySelector(
                '.opp61-partial-scope-box'
            );


        const fullNote =
            card.querySelector(
                '.opp61-full-scope-note'
            );


        scopeContainer
            ?.classList
            .toggle(
                'd-none',
                !requested
            );


        partialBox
            ?.classList
            .toggle(
                'd-none',
                !requested ||
                mode !== 'partial'
            );


        fullNote
            ?.classList
            .toggle(
                'd-none',
                !requested ||
                mode !== 'full_class'
            );
    }


    refreshLocalRefusalSummary() {

        const summary =
            document.querySelector(
                '.opp61-refusal-summary'
            );


        if (!summary) {
            return;
        }


        const rows =
            [
                ...document.querySelectorAll(
                    '.opp61-goods-card'
                )
            ]
                .filter(
                    card =>
                        card
                            .querySelector(
                                '.opp61-refusal-check'
                            )
                            ?.checked
                )
                .map(card => {

                    const classNo =
                        card.dataset
                            .opponentClass;


                    const mode =
                        card
                            .querySelector(
                                '.opp61-refusal-scope-mode'
                            )
                            ?.value || '';


                    return {
                        classNo,
                        mode
                    };
                });


        summary.innerHTML = `
            <strong>
                Seçili ret kapsamı:
            </strong>

            ${
                rows.length

                    ? rows.map(
                        row => `
                            <span>

                                Sınıf
                                ${this.escape(row.classNo)}

                                ${
                                    row.mode ===
                                    'full_class'

                                        ? '· tamamı'

                                        : row.mode ===
                                          'partial'

                                            ? '· kısmi kapsam'

                                            : '· kapsam seçilmedi'
                                }

                            </span>
                        `
                    ).join('')

                    : `
                        <em>
                            Henüz ret talep edilen
                            kapsam seçilmedi.
                        </em>
                    `
            }
        `;
    }

    collectPayload() {
        const priorRightsReview = [...document.querySelectorAll('.opp61-prior-review')].map(card => ({
            ipRecordId: card.dataset.priorId,
            confirmedEligible: card.querySelector('.opp61-prior-confirm')?.checked === true,
            note: card.querySelector('.opp61-prior-note')?.value || ''
        }));

                const goodsAssessments =
            [
                ...document.querySelectorAll(
                    '.opp61-goods-card'
                )
            ].map(card => ({

                opponentClassNo:
                    Number(
                        card.dataset.opponentClass
                    ),

                similarityLevel:
                    card
                        .querySelector(
                            '.opp61-similarity-select'
                        )
                        ?.value ||
                    'not_assessed',

                matchedPriorClasses:
                    [
                        ...card.querySelectorAll(
                            '.opp61-prior-class-check:checked'
                        )
                    ].map(
                        el => el.value
                    ),

                criteria:
                    [
                        ...card.querySelectorAll(
                            '.opp61-criteria-check:checked'
                        )
                    ].map(
                        el => el.value
                    ),

                requestedRefusal:
                    card
                        .querySelector(
                            '.opp61-refusal-check'
                        )
                        ?.checked === true,

                refusalScopeMode:
                    card
                        .querySelector(
                            '.opp61-refusal-scope-mode'
                        )
                        ?.value || '',

                refusalScopeText:
                    card
                        .querySelector(
                            '.opp61-refusal-scope-text'
                        )
                        ?.value || '',

                note:
                    card
                        .querySelector(
                            '.opp61-goods-note'
                        )
                        ?.value || ''
            }));

        return {
            priorRightsReview,
            goodsAssessments,
            signAssessment: {
                commonElements: document.getElementById('opp61CommonElements')?.value || '',
                differences: document.getElementById('opp61Differences')?.value || '',
                commonElementDistinctiveness: document.getElementById('opp61Distinctiveness')?.value || '',
                                clientDominantElements:
                    document
                        .getElementById(
                            'opp61ClientDominant'
                        )
                        ?.value || '',

                opponentDominantElements:
                    document
                        .getElementById(
                            'opp61OpponentDominant'
                        )
                        ?.value || '',


                clientAdditionalElements:
                    document
                        .getElementById(
                            'opp61ClientAdditionalElements'
                        )
                        ?.value || '',

                clientAdditionalDistinctiveness:
                    document
                        .getElementById(
                            'opp61ClientAdditionalDistinctiveness'
                        )
                        ?.value || '',

                clientAdditionalRole:
                    document
                        .getElementById(
                            'opp61ClientAdditionalRole'
                        )
                        ?.value || '',


                opponentAdditionalElements:
                    document
                        .getElementById(
                            'opp61OpponentAdditionalElements'
                        )
                        ?.value || '',

                opponentAdditionalDistinctiveness:
                    document
                        .getElementById(
                            'opp61OpponentAdditionalDistinctiveness'
                        )
                        ?.value || '',

                opponentAdditionalRole:
                    document
                        .getElementById(
                            'opp61OpponentAdditionalRole'
                        )
                        ?.value || '',


                independentDistinctiveRole:
                    document
                        .getElementById(
                            'opp61IndependentRole'
                        )
                        ?.value || '',
                
                visualSimilarity: document.getElementById('opp61Visual')?.value || '',
                auralSimilarity: document.getElementById('opp61Aural')?.value || '',
                conceptualSimilarity: document.getElementById('opp61Conceptual')?.value || '',
                overallSimilarity: document.getElementById('opp61Overall')?.value || '',
                note: document.getElementById('opp61SignNote')?.value || ''
            },
            publicAssessment: {
                publicType: document.getElementById('opp61PublicType')?.value || '',
                attentionLevel: document.getElementById('opp61Attention')?.value || '',
                note: document.getElementById('opp61PublicNote')?.value || ''
            },
            globalAssessment: {
                conclusion: document.getElementById('opp61GlobalConclusion')?.value || '',
                associationLikelihood: document.getElementById('opp61Association')?.value || '',
                lawyerMerits: document.getElementById('opp61LawyerMerits')?.value || ''
            }
        };
    }

    async save() {
        const button = document.getElementById('opp61SaveBtn');
        const payload = this.collectPayload();

        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Analiz kontrol ediliyor...';
        }

        try {
                    this.context =
            await this.invoke(
                'save',
                payload
            );


        this.render();


        window.dispatchEvent(
            new CustomEvent(
                'opposition-analysis-saved',
                {
                    detail: {
                        taskId:
                            this.taskId
                    }
                }
            )
        );


        const readiness =
            this.context?.readiness ||
            {};

            if (readiness.canDraft) {
                showNotification(
                    'SMK 6/1 analizi tamamlandı. Dosya dilekçe üretimine hazır.',
                    'success'
                );
            } else {
                showNotification(
                    `SMK 6/1 analizi kaydedildi; ${readiness.blockers?.length || 0} eksik/hata kaldı.`,
                    'warning'
                );
            }
        } catch (error) {
            console.error('SMK 6/1 analiz kayıt hatası:', error);
            showNotification('6/1 analiz kayıt hatası: ' + error.message, 'error');

            if (button) {
                button.disabled = false;
                button.innerHTML = '<i class="fas fa-check-double mr-2"></i>6/1 Analizini Kaydet ve Kontrol Et';
            }
        }
    }
}