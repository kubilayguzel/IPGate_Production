import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

import { ProfessionalOppositionDocument } from './ProfessionalOppositionDocument.js';


export class OppositionDraftManager {

    constructor(taskId) {

        this.taskId =
            String(taskId);

        this.mount =
            document.getElementById(
                'oppositionDraftMount'
            );

        this.status =
            null;

        this.selectedVersion =
            null;

        this.transientDraft =
            null;

        this.transientQa =
            null;

        this.documentGenerator =
            new ProfessionalOppositionDocument();

        this.boundRefresh =
            () => this.loadStatus();
    }


    async init() {

        if (!this.mount) {
            return;
        }


        if (
            window.__oppositionDraftManager &&
            window.__oppositionDraftManager !== this
        ) {
            window
                .__oppositionDraftManager
                .destroy?.();
        }


        window.__oppositionDraftManager =
            this;


        window.addEventListener(
            'opposition-analysis-saved',
            this.boundRefresh
        );


        window.addEventListener(
            'opposition-workspace-saved',
            this.boundRefresh
        );


        await this.loadStatus();
    }


    destroy() {

        window.removeEventListener(
            'opposition-analysis-saved',
            this.boundRefresh
        );


        window.removeEventListener(
            'opposition-workspace-saved',
            this.boundRefresh
        );
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


    async invoke(action) {

        const {
            data,
            error
        } = await supabase
            .functions
            .invoke(
                'opposition-draft',
                {
                    body: {
                        action,
                        taskId:
                            this.taskId
                    }
                }
            );


        if (error) {
            throw new Error(
                error.message ||
                'Dilekçe servisine ulaşılamadı.'
            );
        }


        if (!data?.success) {
            throw new Error(
                data?.error ||
                'Dilekçe işlemi başarısız oldu.'
            );
        }


        return data;
    }


    async loadStatus() {

        this.renderLoading();


        try {

            const result =
                await this.invoke(
                    'status'
                );


            this.status =
                result.status;


            this.transientDraft =
                null;


            this.transientQa =
                null;


            this.selectedVersion =
                this.status
                    ?.drafts
                    ?.[0]
                    ?.version_no ??
                null;


            this.render();

        } catch (error) {

            console.error(
                'Opposition draft status hatası:',
                error
            );


            this.renderError(
                error.message
            );
        }
    }


    renderLoading() {

        this.mount.innerHTML = `
            <div class="oppdraft-card">

                <div class="oppdraft-loading">

                    <i class="fas fa-spinner fa-spin"></i>

                    <span>
                        Dilekçe motoru durumu kontrol ediliyor...
                    </span>

                </div>

            </div>
        `;
    }


    renderError(message) {

        this.mount.innerHTML = `
            <div class="oppdraft-card">

                <div class="alert alert-danger mb-0">

                    <strong>
                        Dilekçe motoru yüklenemedi.
                    </strong>

                    <br>

                    ${this.escape(message)}

                    <div class="mt-3">

                        <button
                            type="button"
                            id="oppDraftRetryBtn"
                            class="btn btn-sm btn-outline-danger"
                        >

                            <i class="fas fa-redo mr-1"></i>

                            Tekrar Dene

                        </button>

                    </div>

                </div>

            </div>
        `;


        document
            .getElementById(
                'oppDraftRetryBtn'
            )
            ?.addEventListener(
                'click',
                () => this.loadStatus()
            );
    }


    currentDraftObject() {

        const drafts =
            this.status?.drafts ||
            [];


        if (
            this.selectedVersion !== null
        ) {

            const selected =
                drafts.find(
                    d =>
                        Number(d.version_no) ===
                        Number(this.selectedVersion)
                );


            if (selected) {
                return selected;
            }
        }


        return drafts[0] ||
            null;
    }


    readinessHtml() {

        if (
            this.status?.canGenerate
        ) {

            return `
                <div class="oppdraft-ready is-ready">

                    <div>

                        <i class="fas fa-check-circle mr-2"></i>

                        <strong>
                            AI dilekçe üretimine hazır
                        </strong>

                    </div>

                    <span>
                        Server-side doğrulandı
                    </span>

                </div>
            `;
        }


        const blockers =
            this.status?.blockers ||
            [];


        return `
            <div class="oppdraft-ready is-blocked">

                <div class="font-weight-bold mb-2">

                    <i class="fas fa-ban mr-2"></i>

                    Dilekçe üretimi henüz açılamaz

                </div>

                <ul class="mb-0">

                    ${
                        blockers
                            .map(
                                item =>
                                    `<li>${this.escape(item)}</li>`
                            )
                            .join('')
                    }

                </ul>

            </div>
        `;
    }


    versionsHtml() {

        const drafts =
            this.status?.drafts ||
            [];


        if (!drafts.length) {

            return `
                <span class="text-muted small">
                    Henüz kaydedilmiş taslak yok.
                </span>
            `;
        }


        return `
            <label class="mb-0 mr-2 small font-weight-bold">
                Versiyon:
            </label>

            <select
                id="oppDraftVersionSelect"
                class="
                    form-control
                    form-control-sm
                    oppdraft-version-select
                "
            >

                ${
                    drafts.map(
                        draft => `
                            <option
                                value="${draft.version_no}"
                                ${
                                    Number(draft.version_no) ===
                                    Number(this.selectedVersion)
                                        ? 'selected'
                                        : ''
                                }
                            >
                                V${draft.version_no}
                                ·
                                ${this.escape(draft.stage || 'generated')}
                                ·
                                ${
                                    new Date(
                                        draft.created_at
                                    ).toLocaleString(
                                        'tr-TR'
                                    )
                                }
                            </option>
                        `
                    ).join('')
                }

            </select>
        `;
    }


    render() {

        const current =
            this.currentDraftObject();


        const text =
            this.transientDraft ||
            current?.content ||
            this.status?.currentDraft ||
            '';


        const hasDraft =
            Boolean(text);


        const buttonLabel =
            hasDraft
                ? 'Yeni Versiyon Üret'
                : 'Dilekçe Taslağı Oluştur';


        this.mount.innerHTML = `
            <div class="oppdraft-card">

                <div class="oppdraft-header">

                    <div>

                        <div class="oppdraft-eyebrow">
                            EVREKA DRAFT ENGINE
                        </div>

                        <h4 class="oppdraft-title mb-1">
                            Yayıma İtiraz Dilekçe Taslağı
                        </h4>

                        <div class="oppdraft-subtitle">
                            Vaka verileri tarayıcıdan üretilmez;
                            server-side Opposition Case +
                            lawyer findings kullanılır.
                        </div>

                    </div>


                    <div class="oppdraft-version-badge">

                        V${
                            this.status
                                ?.currentVersion ||
                            0
                        }

                    </div>

                </div>


                ${
                    this.readinessHtml()
                }


                <div class="oppdraft-actions mt-3">

                    <div
                        class="
                            d-flex
                            align-items-center
                            flex-wrap
                        "
                    >

                        ${
                            this.versionsHtml()
                        }

                    </div>


                    <div
                        class="
                            d-flex
                            align-items-center
                            flex-wrap
                            oppdraft-btn-group
                        "
                    >

                        <button
                            type="button"
                            id="oppDraftRefreshBtn"
                            class="
                                btn
                                btn-sm
                                btn-outline-secondary
                            "
                        >

                            <i class="fas fa-sync-alt mr-1"></i>

                            Durumu Yenile

                        </button>


                        <button
                            type="button"
                            id="oppDraftGenerateBtn"
                            class="btn btn-primary"
                            ${
                                this.status?.canGenerate
                                    ? ''
                                    : 'disabled'
                            }
                        >

                            <i class="fas fa-magic mr-2"></i>

                            ${buttonLabel}

                        </button>


                        <button
                            type="button"
                            id="oppDraftWordBtn"
                            class="btn btn-success"
                            ${
                                hasDraft
                                    ? ''
                                    : 'disabled'
                            }
                        >

                            <i class="fas fa-file-word mr-2"></i>

                            Profesyonel Word Oluştur

                        </button>

                    </div>

                </div>


                ${
                    hasDraft
                        ? `
                            <div class="mt-3">

                                <label class="form-label">
                                    Taslak Metin
                                </label>

                                <textarea
                                    id="oppDraftEditor"
                                    class="
                                        form-control
                                        oppdraft-editor
                                    "
                                    rows="22"
                                >${this.escape(text)}</textarea>

                                <small
                                    class="
                                        text-muted
                                        d-block
                                        mt-2
                                    "
                                >
                                    Bu alan inceleme içindir.
                                    Burada yaptığınız manuel
                                    değişiklikler henüz DB'ye
                                    kaydedilmez; Word çıktısı
                                    ekrandaki güncel metni kullanır.
                                </small>

                            </div>
                        `
                        : `
                            <div class="oppdraft-empty mt-3">

                                <i class="fas fa-file-alt"></i>

                                <div>
                                    Henüz dilekçe taslağı üretilmedi.
                                </div>

                            </div>
                        `
                }


                ${
                    this.qaHtml(current)
                }

                ${
                    this.sourcesHtml(current)
                }

                ${
                    this.costHtml(current)
                }

            </div>
        `;


        this.bindEvents();
    }


    qaHtml(current) {

        const qa =
            this.transientQa ||
            current?.qa_report;


        if (!qa) {
            return '';
        }


        const blockers =
            qa?.deterministic
                ?.blockers ||
            [];


        const warnings =
            qa?.deterministic
                ?.warnings ||
            [];


        const aiIssues =
            qa?.aiAuditIssues ||
            [];


        return `
            <details class="oppdraft-qa mt-3">

                <summary>

                    <strong>
                        QA Raporu
                    </strong>

                    ·
                    ${
                        qa.finalPass
                            ? 'PASS'
                            : 'FAIL'
                    }

                    ·
                    ${blockers.length}
                    blocker

                    ·
                    ${
                        warnings.length +
                        aiIssues.length
                    }
                    uyarı/AI düzeltmesi

                </summary>


                <div class="oppdraft-qa-body">

                    ${
                        blockers.length
                            ? `
                                <div>

                                    <strong>
                                        Blocker:
                                    </strong>

                                    <ul>

                                        ${
                                            blockers
                                                .map(
                                                    x =>
                                                        `<li>${this.escape(x)}</li>`
                                                )
                                                .join('')
                                        }

                                    </ul>

                                </div>
                            `
                            : ''
                    }


                    ${
                        warnings.length
                            ? `
                                <div>

                                    <strong>
                                        Uyarı:
                                    </strong>

                                    <ul>

                                        ${
                                            warnings
                                                .map(
                                                    x =>
                                                        `<li>${this.escape(x)}</li>`
                                                )
                                                .join('')
                                        }

                                    </ul>

                                </div>
                            `
                            : ''
                    }


                    ${
                        aiIssues.length
                            ? `
                                <div>

                                    <strong>
                                        AI Audit:
                                    </strong>

                                    <ul>

                                        ${
                                            aiIssues
                                                .map(
                                                    x =>
                                                        `<li>${this.escape(x.problem || x)}</li>`
                                                )
                                                .join('')
                                        }

                                    </ul>

                                </div>
                            `
                            : ''
                    }

                </div>

            </details>
        `;
    }


    formatTokenCount(value) {

        const number =
            Number(
                value ??
                0
            );


        return Number.isFinite(number)
            ? number.toLocaleString(
                'tr-TR'
            )
            : '0';
    }


    formatUsd(value) {

        const number =
            Number(
                value
            );


        if (
            !Number.isFinite(number)
        ) {

            return '—';
        }


        const digits =
            number < 0.01
                ? 5
                : 3;


        return new Intl
            .NumberFormat(
                'en-US',
                {
                    style:
                        'currency',

                    currency:
                        'USD',

                    minimumFractionDigits:
                        digits,

                    maximumFractionDigits:
                        digits
                }
            )
            .format(number);
    }


    formatTry(value) {

        const number =
            Number(
                value
            );


        if (
            !Number.isFinite(number)
        ) {

            return '';
        }


        return new Intl
            .NumberFormat(
                'tr-TR',
                {
                    style:
                        'currency',

                    currency:
                        'TRY',

                    minimumFractionDigits:
                        2,

                    maximumFractionDigits:
                        2
                }
            )
            .format(number);
    }


    costStageRow(
        label,
        stage
    ) {

        if (!stage) {
            return '';
        }


        const skipped =
            stage.skipped ===
            true;


        const model =
            stage.model ||
            '—';


        const promptTokens =
            this.formatTokenCount(
                stage.promptTokenCount
            );


        const outputTokens =
            this.formatTokenCount(
                (
                    Number(
                        stage.candidatesTokenCount ??
                        0
                    ) +
                    Number(
                        stage.thoughtsTokenCount ??
                        0
                    )
                )
            );


        const cost =
            skipped
                ? 'CACHE / ÇAĞRI YOK'
                : this.formatUsd(
                    stage.estimatedUsd
                );


        return `
            <tr>

                <td>
                    <strong>
                        ${this.escape(label)}
                    </strong>
                </td>

                <td>
                    ${this.escape(model)}
                </td>

                <td class="text-right">
                    ${
                        skipped
                            ? '—'
                            : promptTokens
                    }
                </td>

                <td class="text-right">
                    ${
                        skipped
                            ? '—'
                            : outputTokens
                    }
                </td>

                <td class="text-right">
                    ${
                        skipped
                            ? `
                                <span
                                    class="
                                        badge
                                        badge-success
                                    "
                                >
                                    ${cost}
                                </span>
                            `
                            : this.escape(cost)
                    }
                </td>

            </tr>
        `;
    }


    sourceTypeLabel(
        value
    ) {

        const labels = {

            official_guideline:
                'Resmî İnceleme Kılavuzu',

            statute:
                'Kanun',

            regulation:
                'Yönetmelik / Düzenleme',

            court_decision:
                'Mahkeme / Yargıtay Kararı',

            yidk_decision:
                'YİDK Kararı',

            eu_case:
                'AB / EUIPO İçtihadı',

            academic:
                'Akademik Kaynak',

            internal_paragraph_bank:
                'EVREKA İç Paragraf Bankası',

            legacy_knowledge:
                'Legacy İç Bilgi',

            other:
                'Hukukî Kaynak',
        };


        return labels[
            String(
                value ||
                'other'
            )
        ] ||
        'Hukukî Kaynak';
    }


    sourcesHtml(current) {

        const context =
            current
                ?.generation_context ||
            {};


        const sources =
            Array.isArray(
                context.legalSources
            )

                ? context.legalSources

                : [];


        const citationAudit =
            context
                ?.citationAudit ||
            current
                ?.qa_report
                ?.citationAudit ||
            null;


        if (
            !sources.length &&
            !citationAudit
        ) {

            return '';
        }


        const citedIds =
            new Set(
                citationAudit
                    ?.citedSourceIds ||
                []
            );


        const citableCount =
            sources.filter(
                source =>
                    source?.citable ===
                    true &&
                    source?.verified ===
                    true
            ).length;


        const citedCount =
            sources.filter(
                source =>
                    citedIds.has(
                        String(
                            source?.sourceId ||
                            ''
                        )
                    )
            ).length;


        const blockers =
            citationAudit
                ?.blockers ||
            [];


        const warnings =
            citationAudit
                ?.warnings ||
            [];


        const rows =
            sources
                .map(
                    source => {

                        const id =
                            String(
                                source
                                    ?.sourceId ||
                                ''
                            );


                        const isCited =
                            citedIds.has(id);


                        const pageFrom =
                            Number(
                                source
                                    ?.page_from ||
                                source
                                    ?.page_number ||
                                0
                            );


                        const pageTo =
                            Number(
                                source
                                    ?.page_to ||
                                source
                                    ?.page_number ||
                                0
                            );


                        const pageText =
                            pageFrom > 0

                                ? (
                                    pageTo > 0 &&
                                    pageTo !==
                                    pageFrom

                                        ? `s. ${pageFrom}-${pageTo}`

                                        : `s. ${pageFrom}`
                                )

                                : '';


                        const location =
                            [
                                source
                                    ?.section_title,
                                pageText,
                            ]
                                .filter(Boolean)
                                .join(' · ');


                        const similarity =
                            Number(
                                source
                                    ?.similarity ||
                                0
                            );


                        const similarityText =
                            similarity > 0

                                ? `%${Math.round(
                                    similarity *
                                    100
                                )}`

                                : '';


                        return `
                            <div
                                style="
                                    padding: 10px 12px;
                                    border: 1px solid #e5e7eb;
                                    border-radius: 8px;
                                    margin-top: 8px;
                                    background: ${
                                        isCited
                                            ? '#f0fdf4'
                                            : '#ffffff'
                                    };
                                "
                            >
                                <div
                                    class="
                                        d-flex
                                        justify-content-between
                                        align-items-start
                                        flex-wrap
                                    "
                                >
                                    <div style="min-width: 0; flex: 1;">

                                        <div
                                            style="
                                                font-weight: 600;
                                                color: #1f2937;
                                            "
                                        >
                                            ${
                                                this.escape(
                                                    source
                                                        ?.citation_label ||
                                                    source
                                                        ?.document_title ||
                                                    source
                                                        ?.title ||
                                                    'Hukukî kaynak'
                                                )
                                            }
                                        </div>

                                        <div
                                            class="text-muted"
                                            style="
                                                font-size: 12px;
                                                margin-top: 3px;
                                            "
                                        >
                                            ${
                                                this.escape(
                                                    this.sourceTypeLabel(
                                                        source
                                                            ?.source_type ||
                                                        source
                                                            ?.document_type
                                                    )
                                                )
                                            }
                                            ${
                                                location
                                                    ? ` · ${this.escape(location)}`
                                                    : ''
                                            }
                                            ${
                                                similarityText
                                                    ? ` · eşleşme ${this.escape(similarityText)}`
                                                    : ''
                                            }
                                        </div>

                                    </div>

                                    <div
                                        style="
                                            margin-left: 10px;
                                            white-space: nowrap;
                                        "
                                    >
                                        ${
                                            source?.verified === true
                                                ? `
                                                    <span class="badge badge-success">
                                                        DOĞRULANDI
                                                    </span>
                                                `
                                                : `
                                                    <span class="badge badge-secondary">
                                                        İÇ BAĞLAM
                                                    </span>
                                                `
                                        }

                                        ${
                                            isCited
                                                ? `
                                                    <span class="badge badge-primary">
                                                        DİLEKÇEDE KULLANILDI
                                                    </span>
                                                `
                                                : (
                                                    source?.citable === true
                                                        ? `
                                                            <span class="badge badge-light">
                                                                ATIF YAPILABİLİR
                                                            </span>
                                                        `
                                                        : ''
                                                )
                                        }
                                    </div>

                                </div>
                            </div>
                        `;
                    }
                )
                .join('');


        const issueHtml =
            [
                ...blockers.map(
                    item => `
                        <li style="color:#b91c1c;">
                            ${this.escape(item)}
                        </li>
                    `
                ),
                ...warnings.map(
                    item => `
                        <li style="color:#92400e;">
                            ${this.escape(item)}
                        </li>
                    `
                ),
            ]
                .join('');


        return `
            <details
                class="oppdraft-qa mt-3"
                ${
                    citationAudit &&
                    citationAudit.pass === false
                        ? 'open'
                        : ''
                }
            >

                <summary>
                    <strong>
                        Kullanılan Hukukî Kaynaklar
                    </strong>

                    <span class="ml-2 text-muted">
                        ${citedCount} atıf · ${citableCount} doğrulanmış kaynak
                    </span>

                    ${
                        citationAudit
                            ? (
                                citationAudit.pass
                                    ? `
                                        <span class="badge badge-success ml-2">
                                            CITATION QA PASS
                                        </span>
                                    `
                                    : `
                                        <span class="badge badge-danger ml-2">
                                            CITATION QA BLOCK
                                        </span>
                                    `
                            )
                            : ''
                    }
                </summary>

                <div class="mt-3">

                    ${
                        rows ||
                        `
                            <div class="text-muted">
                                Bu versiyonda kaynak snapshot'ı bulunmuyor.
                            </div>
                        `
                    }

                    ${
                        issueHtml
                            ? `
                                <div
                                    class="mt-3"
                                    style="
                                        padding: 10px 12px;
                                        background: #fffbeb;
                                        border-radius: 8px;
                                    "
                                >
                                    <strong>
                                        Kaynak denetimi notları
                                    </strong>

                                    <ul class="mb-0 mt-2">
                                        ${issueHtml}
                                    </ul>
                                </div>
                            `
                            : ''
                    }

                </div>

            </details>
        `;
    }


    costHtml(current) {

        const qa =
            this.transientQa ||
            current?.qa_report;


        const telemetry =
            qa?.aiTelemetry;


        if (!telemetry) {
            return '';
        }


        const cacheHit =
            telemetry
                ?.cache
                ?.hit ===
            true;


        const totalUsd =
            telemetry
                ?.total
                ?.estimatedUsd;


        const totalTry =
            telemetry
                ?.total
                ?.estimatedTry;


        const tryRate =
            telemetry
                ?.total
                ?.usdTryRate;


        const rag =
            telemetry.rag ||
            {};


        const stages =
            telemetry.stages ||
            {};


        const totalTryHtml =
            Number.isFinite(
                Number(totalTry)
            )
                ? `
                    <span class="ml-2">
                        ≈
                        ${this.escape(
                            this.formatTry(
                                totalTry
                            )
                        )}
                    </span>
                `
                : '';


        const rateNote =
            Number.isFinite(
                Number(tryRate)
            )
                ? `
                    <div
                        class="
                            text-muted
                            small
                            mt-2
                        "
                    >
                        TRY tahmini için
                        1 USD =
                        ${this.escape(tryRate)}
                        TRY oranı kullanıldı.
                        Google faturası ve vergi/kur
                        farkları nedeniyle gerçek tutar
                        değişebilir.
                    </div>
                `
                : `
                    <div
                        class="
                            text-muted
                            small
                            mt-2
                        "
                    >
                        USD tutarı API usage metadata ve
                        model fiyat tarifesine göre
                        tahminidir. TRY karşılığı Google'ın
                        faturalama kuru/vergi uygulamasına
                        göre değişebilir.
                    </div>
                `;


        return `
            <details
                class="
                    oppdraft-qa
                    mt-3
                "
            >

                <summary>

                    <strong>
                        AI Kullanım / Maliyet
                    </strong>

                    ·

                    ${
                        cacheHit
                            ? 'CACHE HIT'
                            : 'CACHE MISS'
                    }

                    ·

                    ${
                        this.escape(
                            this.formatUsd(
                                totalUsd
                            )
                        )
                    }

                    ${totalTryHtml}

                </summary>


                <div class="oppdraft-qa-body">

                    <div
                        class="
                            alert
                            ${
                                cacheHit
                                    ? 'alert-success'
                                    : 'alert-light'
                            }
                            py-2
                        "
                    >

                        ${
                            cacheHit
                                ? `
                                    <strong>
                                        Analiz cache kullanıldı.
                                    </strong>

                                    RAG embedding ve hukuki analiz
                                    API çağrıları tekrar edilmedi.
                                `
                                : `
                                    <strong>
                                        Yeni hukuki analiz yapıldı.
                                    </strong>

                                    Bu versiyon sonraki aynı
                                    Decision Tree girdileri için
                                    cache oluşturur.
                                `
                        }

                    </div>


                    <div
                        class="
                            table-responsive
                            mt-2
                        "
                    >

                        <table
                            class="
                                table
                                table-sm
                                mb-0
                            "
                        >

                            <thead>

                                <tr>

                                    <th>
                                        Aşama
                                    </th>

                                    <th>
                                        Model
                                    </th>

                                    <th
                                        class="text-right"
                                    >
                                        Input
                                    </th>

                                    <th
                                        class="text-right"
                                    >
                                        Output + Thinking
                                    </th>

                                    <th
                                        class="text-right"
                                    >
                                        Tahmini
                                    </th>

                                </tr>

                            </thead>


                            <tbody>

                                ${
                                    this.costStageRow(
                                        'Embedding / RAG',
                                        stages.embedding
                                    )
                                }

                                ${
                                    this.costStageRow(
                                        'Hukuki Analiz',
                                        stages.analysis
                                    )
                                }

                                ${
                                    this.costStageRow(
                                        'Dilekçe Yazımı',
                                        stages.draft
                                    )
                                }

                                ${
                                    this.costStageRow(
                                        'AI Audit',
                                        stages.audit
                                    )
                                }

                            </tbody>

                        </table>

                    </div>


                    <div
                        class="
                            d-flex
                            flex-wrap
                            justify-content-between
                            mt-3
                        "
                    >

                        <div class="small">

                            <strong>
                                RAG:
                            </strong>

                            ${
                                this.escape(
                                    rag.sourcesRetrieved ??
                                    0
                                )
                            }
                            kaynak bulundu /

                            ${
                                this.escape(
                                    rag.sourcesUsed ??
                                    0
                                )
                            }
                            kaynak dilekçe aşamasına taşındı

                        </div>


                        <div>

                            <strong>
                                Tahmini API toplamı:
                            </strong>

                            ${
                                this.escape(
                                    this.formatUsd(
                                        totalUsd
                                    )
                                )
                            }

                            ${totalTryHtml}

                        </div>

                    </div>


                    ${rateNote}

                </div>

            </details>
        `;
    }


    bindEvents() {

        document
            .getElementById(
                'oppDraftRefreshBtn'
            )
            ?.addEventListener(
                'click',
                () => this.loadStatus()
            );


        document
            .getElementById(
                'oppDraftGenerateBtn'
            )
            ?.addEventListener(
                'click',
                () => this.generate()
            );


        document
            .getElementById(
                'oppDraftWordBtn'
            )
            ?.addEventListener(
                'click',
                () => this.generateWord()
            );


        document
            .getElementById(
                'oppDraftVersionSelect'
            )
            ?.addEventListener(
                'change',
                event => {

                    this.selectedVersion =
                        Number(
                            event.target.value
                        );


                    this.transientDraft =
                        null;


                    this.transientQa =
                        null;


                    this.render();
                }
            );
    }


    async generate() {

        const button =
            document.getElementById(
                'oppDraftGenerateBtn'
            );


        if (button) {

            button.disabled =
                true;


            button.innerHTML = `
                <i class="fas fa-spinner fa-spin mr-2"></i>
                Dilekçe hazırlanıyor...
            `;
        }


        try {

            const result =
                await this.invoke(
                    'generate'
                );


            const generation =
                result.generation ||
                {};


            this.status =
                result.status;


            this.selectedVersion =
                this.status
                    ?.drafts
                    ?.[0]
                    ?.version_no ??
                null;


            if (
                generation
                    .generationStatus ===
                'needs_input'
            ) {

                this.transientDraft =
                    null;


                this.transientQa =
                    null;


                showNotification(
                    'AI hukuki analiz aşaması ek veri istedi: ' +
                    (
                        generation
                            .missingCriticalFacts ||
                        []
                    ).join(' | '),
                    'warning'
                );


                this.render();

                return;
            }


            if (
                generation
                    .generationStatus ===
                'qa_failed'
            ) {

                this.transientDraft =
                    generation.petition ||
                    null;


                this.transientQa =
                    generation.qaReport ||
                    null;


                showNotification(
                    'Taslak üretildi ancak deterministik QA geçmedi; DB’ye nihai taslak olarak kaydedilmedi.',
                    'error'
                );


                this.render();

                return;
            }


            this.transientDraft =
                null;


            this.transientQa =
                null;


            showNotification(
                `Dilekçe V${generation.versionNo} üretildi, denetlendi ve kaydedildi.`,
                'success'
            );


            this.render();

        } catch (error) {

            console.error(
                'Dilekçe üretim hatası:',
                error
            );


            showNotification(
                'Dilekçe üretim hatası: ' +
                error.message,
                'error'
            );


            if (button) {

                button.disabled =
                    false;


                button.innerHTML = `
                    <i class="fas fa-magic mr-2"></i>
                    Dilekçe Taslağı Oluştur
                `;
            }
        }
    }


    async generateWord() {

        const button =
            document.getElementById(
                'oppDraftWordBtn'
            );


        const editor =
            document.getElementById(
                'oppDraftEditor'
            );


        const petitionText =
            editor
                ?.value
                ?.trim();


        if (!petitionText) {

            return showNotification(
                'Word oluşturulacak taslak metin bulunamadı.',
                'warning'
            );
        }


        const currentDraft =
            this.currentDraftObject();


        if (!currentDraft) {

            return showNotification(
                'Profesyonel Word yalnız kaydedilmiş ve QA kontrolünden geçmiş bir dilekçe versiyonundan oluşturulabilir.',
                'warning'
            );
        }


        const qaReport =
            this.transientDraft
                ? this.transientQa
                : currentDraft
                    ?.qa_report;


        const qaVersion =
            Number(
                qaReport
                    ?.version ??
                0
            );


        if (
            !qaReport ||
            qaReport.finalPass !==
            true ||
            !Number.isFinite(
                qaVersion
            ) ||
            qaVersion <
            3 ||
            String(
                qaReport
                    ?.packageVersion ??
                ''
            ) !==
            '4.2'
        ) {

            return showNotification(
                'Seçili dilekçe güncel filing-safety QA kontrolünü geçmemiştir. Paket 5.1 Word export için önce Paket 4.2 veya daha yeni güvenli bir dilekçe versiyonu üretin.',
                'warning'
            );
        }


        if (
            this.transientDraft &&
            this.transientQa
                ?.finalPass !==
            true
        ) {

            return showNotification(
                'Ekrandaki geçici taslak QA kontrolünü geçmediği için Word oluşturulamaz.',
                'warning'
            );
        }


        const snapshot =
            currentDraft
                ?.generation_context
                ?.documentDataSnapshot ||
            null;


        const currentDocumentData =
            this.status
                ?.documentData ||
            null;


        const versionFingerprint =
            currentDraft
                ?.generation_context
                ?.sourceFingerprint ||
            null;


        const currentFingerprint =
            currentDocumentData
                ?.sourceFingerprint ||
            null;


        if (
            !snapshot &&
            versionFingerprint &&
            currentFingerprint &&
            versionFingerprint !==
            currentFingerprint
        ) {

            return showNotification(
                'Seçili dilekçe versiyonunun belge snapshot’ı yok ve güncel analiz verileri değişmiş. Yanlış kapsamla Word oluşturmamak için işlem durduruldu. Önce yeni bir dilekçe versiyonu üretin.',
                'warning'
            );
        }


        const documentData =
            snapshot ||
            currentDocumentData ||
            null;


        if (!documentData) {

            return showNotification(
                'Profesyonel Word için doğrulanmış belge verisi bulunamadı.',
                'warning'
            );
        }


        if (button) {

            button.disabled =
                true;


            button.innerHTML = `
                <i class="fas fa-spinner fa-spin mr-2"></i>
                Profesyonel Word hazırlanıyor...
            `;
        }


        try {

            const applicationNo =
                documentData
                    ?.opponent
                    ?.applicationNo ||
                this.status
                    ?.wordData
                    ?.opponentAppNo ||
                '';


            const fileName =
                applicationNo

                    ? `${
                        String(
                            applicationNo
                        )
                            .replace(
                                /[\\/]/g,
                                '-'
                            )
                    }_Yayima_Itiraz_Dilekcesi.docx`

                    : 'Yayima_Itiraz_Dilekcesi.docx';


            const result =
                await this
                    .documentGenerator
                    .generate({
                        documentData,
                        petitionText,
                        qaReport,
                        fileName,
                    });


            const imageSummary =
                `${
                    result.priorImageCount
                } müstenit görsel` +
                (
                    result.opponentImageIncluded
                        ? ' + rakip görsel'
                        : ''
                );


            showNotification(
                `Profesyonel Word belgesi oluşturuldu (${imageSummary}).`,
                'success'
            );


        } catch (error) {

            console.error(
                'Profesyonel Word oluşturma hatası:',
                error
            );


            showNotification(
                'Profesyonel Word oluşturma hatası: ' +
                error.message,
                'error'
            );


        } finally {

            if (button) {

                button.disabled =
                    !this.status
                        ?.canGenerate &&
                    !Boolean(
                        petitionText
                    );


                button.innerHTML = `
                    <i class="fas fa-file-word mr-2"></i>
                    Profesyonel Word Oluştur
                `;
            }
        }
    }}
