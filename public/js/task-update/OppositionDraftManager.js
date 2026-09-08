import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

import { ProfessionalOppositionDocument } from './ProfessionalOppositionDocument.js';

const OPPOSITION_DRAFT_UX_PATCH_VERSION = '6.1.8.3';


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

        this.isGenerating =
            false;

        this.generationMessage =
            '';

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
            char => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            }[char])
        );
    }


    async invoke(action, extra = {}) {

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
                            this.taskId,
                        ...extra
                    }
                }
            );

        if (error) {

            let body =
                null;

            const httpStatus =
                Number(
                    error?.context?.status ??
                    error?.status ??
                    0
                ) ||
                null;

            if (error.context) {

                try {

                    body =
                        await error
                            .context
                            .clone()
                            .json();

                } catch (_) {}
            }

            const wrappedError =
                new Error(
                    body?.error ||
                    error.message ||
                    'Dilekçe servisine ulaşılamadı.'
                );

            wrappedError.httpStatus =
                httpStatus;

            wrappedError.uxPatchVersion =
                OPPOSITION_DRAFT_UX_PATCH_VERSION;

            throw wrappedError;
        }

        if (!data?.success) {

            throw new Error(
                data?.error ||
                'Dilekçe işlemi başarısız oldu.'
            );
        }

        return data;
    }


    isTransientGatewayError(error) {

        return [
            502,
            503,
            504
        ].includes(
            Number(
                error?.httpStatus ??
                0
            )
        );
    }


    async invokeGenerateStartWithRecovery() {

        try {

            return await this.invoke(
                'generate_start'
            );

        } catch (error) {

            if (
                !this.isTransientGatewayError(
                    error
                )
            ) {
                throw error;
            }

            this.setGenerationMessage(
                'Sunucu zaman aşımı sonrası üretim durumu yeniden bağlanıyor...'
            );

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        3000
                    )
            );

            /*
             * Backend recent-active-run guard aynı task için
             * başlamış reasoning run varsa onu reuse eder.
             * Bu nedenle tek kontrollü retry duplicate üretmez.
             */
            return await this.invoke(
                'generate_start'
            );
        }
    }


    async loadStatus() {

        if (!this.mount) {
            return;
        }

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
                    item =>
                        Number(
                            item.version_no
                        ) ===
                        Number(
                            this.selectedVersion
                        )
                );

            if (selected) {
                return selected;
            }
        }

        return drafts[0] ||
            null;
    }


    currentQa() {

        if (
            this.transientDraft
        ) {
            return this.transientQa;
        }

        return this
            .currentDraftObject()
            ?.qa_report ||
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
                            EVREKA 6.1 üretimine hazır
                        </strong>
                    </div>

                    <span>
                        Decision Tree + verified legal intelligence
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
                class="form-control form-control-sm oppdraft-version-select"
            >

                ${
                    drafts
                        .map(
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
                                    ${
                                        this.escape(
                                            draft
                                                ?.generation_context
                                                ?.enginePackageVersion ||
                                            draft.stage ||
                                            'generated'
                                        )
                                    }
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
                        )
                        .join('')
                }

            </select>
        `;
    }


    qaHtml(current) {

        const qa =
            this.transientQa ||
            current?.qa_report;

        if (!qa) {
            return '';
        }

        const blockers =
            qa
                ?.deterministic
                ?.blockers ||
            [];

        const citationBlockers =
            qa
                ?.citationAudit
                ?.blockers ||
            [];

        const warnings =
            qa
                ?.deterministic
                ?.warnings ||
            [];

        const allBlockers = [
            ...new Set([
                ...blockers,
                ...citationBlockers
            ])
        ];

        return `
            <details
                class="oppdraft-qa mt-3"
                ${
                    qa.finalPass
                        ? ''
                        : 'open'
                }
            >

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
                    ${allBlockers.length}
                    blocker

                    ·
                    ${warnings.length}
                    uyarı

                    ${
                        qa
                            ?.enginePackageVersion
                            ? `· ${this.escape(qa.enginePackageVersion)}`
                            : ''
                    }

                </summary>

                <div class="oppdraft-qa-body">

                    ${
                        allBlockers.length
                            ? `
                                <div>

                                    <strong>
                                        Blocker:
                                    </strong>

                                    <ul>

                                        ${
                                            allBlockers
                                                .map(
                                                    item =>
                                                        `<li>${this.escape(item)}</li>`
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
                                                    item =>
                                                        `<li>${this.escape(item)}</li>`
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

        if (!sources.length) {
            return '';
        }

        const citationAudit =
            context
                ?.citationAudit ||
            current
                ?.qa_report
                ?.citationAudit ||
            null;

        const cited =
            new Set(
                citationAudit
                    ?.citedSourceIds ||
                []
            );

        const unique = [];
        const seen = new Set();

        for (
            const source of
            sources
        ) {

            const label =
                String(
                    source
                        ?.citation_label ||
                    source
                        ?.document_title ||
                    ''
                ).trim();

            if (!label) {
                continue;
            }

            const key =
                label.toLocaleLowerCase(
                    'tr-TR'
                );

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            unique.push(source);
        }

        return `
            <details class="oppdraft-qa mt-3">

                <summary>

                    <strong>
                        Doğrulanmış Hukukî Kaynaklar
                    </strong>

                    ·
                    ${unique.length}
                    authority

                    ${
                        citationAudit?.pass === true
                            ? '· CITATION QA PASS'
                            : ''
                    }

                </summary>

                <div class="oppdraft-qa-body">

                    ${
                        unique
                            .map(
                                source => {

                                    const id =
                                        String(
                                            source
                                                ?.sourceId ||
                                            ''
                                        );

                                    const used =
                                        cited.has(id) ||
                                        source?.used === true;

                                    return `
                                        <div
                                            style="
                                                padding:8px 10px;
                                                border-bottom:1px solid #e5e7eb;
                                            "
                                        >

                                            <strong>
                                                ${
                                                    this.escape(
                                                        source
                                                            ?.citation_label ||
                                                        source
                                                            ?.document_title ||
                                                        'Hukukî kaynak'
                                                    )
                                                }
                                            </strong>

                                            ${
                                                used
                                                    ? `
                                                        <span class="badge badge-success ml-2">
                                                            KULLANILDI
                                                        </span>
                                                    `
                                                    : ''
                                            }

                                        </div>
                                    `;
                                }
                            )
                            .join('')
                    }

                </div>

            </details>
        `;
    }


    costHtml(current) {

        const telemetry =
            (
                this.transientQa ||
                current?.qa_report
            )
                ?.aiTelemetry;

        if (!telemetry) {
            return '';
        }

        const reasoningUsd =
            Number(
                telemetry
                    ?.reasoning
                    ?.estimatedUsd ??
                0
            );

        const draftUsd =
            Number(
                telemetry
                    ?.draft
                    ?.estimatedUsd ??
                0
            );

        const totalUsd =
            Number(
                telemetry
                    ?.total
                    ?.estimatedUsd ??
                (
                    reasoningUsd +
                    draftUsd
                )
            );

        const usd =
            value =>
                Number.isFinite(
                    Number(value)
                )
                    ? new Intl
                        .NumberFormat(
                            'en-US',
                            {
                                style:
                                    'currency',
                                currency:
                                    'USD',
                                minimumFractionDigits:
                                    3,
                                maximumFractionDigits:
                                    3
                            }
                        )
                        .format(
                            Number(value)
                        )
                    : '—';

        return `
            <details class="oppdraft-qa mt-3">

                <summary>
                    <strong>
                        AI Kullanım / Maliyet
                    </strong>
                    ·
                    ${usd(totalUsd)}
                </summary>

                <div class="oppdraft-qa-body">

                    <div>
                        Sol Legal Reasoning:
                        <strong>
                            ${usd(reasoningUsd)}
                        </strong>
                    </div>

                    <div class="mt-1">
                        Sol Final Petition:
                        <strong>
                            ${usd(draftUsd)}
                        </strong>
                    </div>

                    <div class="mt-2">
                        Toplam:
                        <strong>
                            ${usd(totalUsd)}
                        </strong>
                    </div>

                </div>

            </details>
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

        const qa =
            this.currentQa();

        const wordEligible =
            Boolean(
                hasDraft &&
                current &&
                !this.transientDraft &&
                qa?.finalPass === true &&
                String(
                    qa
                        ?.enginePackageVersion ||
                    ''
                ) ===
                '6.1.6'
            );

        const buttonLabel =
            hasDraft
                ? 'Yeni 6.1 Versiyon Üret'
                : '6.1 Dilekçe Taslağı Oluştur';

        this.mount.innerHTML = `
            <div class="oppdraft-card">

                <div class="oppdraft-header">

                    <div>

                        <div class="oppdraft-eyebrow">
                            EVREKA LEGAL INTELLIGENCE
                        </div>

                        <h4 class="oppdraft-title mb-1">
                            Yayıma İtiraz Dilekçe Taslağı
                        </h4>

                        <div class="oppdraft-subtitle">
                            Deep Legal Research → Sol Legal Reasoning →
                            Sol Final Petition → Strict QA
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

                ${this.readinessHtml()}

                <div class="oppdraft-actions mt-3">

                    <div
                        class="
                            d-flex
                            align-items-center
                            flex-wrap
                        "
                    >
                        ${this.versionsHtml()}
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
                            class="btn btn-sm btn-outline-secondary"
                            ${
                                this.isGenerating
                                    ? 'disabled'
                                    : ''
                            }
                        >
                            <i class="fas fa-sync-alt mr-1"></i>
                            Durumu Yenile
                        </button>

                        <button
                            type="button"
                            id="oppDraftGenerateBtn"
                            class="btn btn-primary"
                            ${
                                (
                                    this.status
                                        ?.canGenerate &&
                                    !this.isGenerating
                                )
                                    ? ''
                                    : 'disabled'
                            }
                        >
                            ${
                                this.isGenerating
                                    ? `
                                        <i class="fas fa-spinner fa-spin mr-2"></i>
                                        İşlem devam ediyor...
                                    `
                                    : `
                                        <i class="fas fa-magic mr-2"></i>
                                        ${buttonLabel}
                                    `
                            }
                        </button>

                        <button
                            type="button"
                            id="oppDraftWordBtn"
                            class="btn btn-success"
                            ${
                                wordEligible
                                    ? ''
                                    : 'disabled'
                            }
                            title="${
                                wordEligible
                                    ? 'Strict QA PASS — Word oluşturulabilir'
                                    : 'Word yalnız 6.1.6 strict QA PASS kaydedilmiş versiyondan oluşturulur'
                            }"
                        >
                            <i class="fas fa-file-word mr-2"></i>
                            Profesyonel Word Oluştur
                        </button>

                    </div>

                </div>

                ${
                    this.isGenerating
                        ? `
                            <div
                                id="oppDraftGenerationStatus"
                                class="alert alert-info mt-3 mb-0"
                            >
                                <i class="fas fa-spinner fa-spin mr-2"></i>
                                ${this.escape(this.generationMessage)}
                            </div>
                        `
                        : ''
                }

                ${
                    hasDraft
                        ? `
                            <div class="mt-3">

                                <label class="form-label">
                                    Taslak Metin
                                </label>

                                <textarea
                                    id="oppDraftEditor"
                                    class="form-control oppdraft-editor"
                                    rows="24"
                                >${this.escape(text)}</textarea>

                                <small class="text-muted d-block mt-2">
                                    Manuel değişiklikler DB’ye kaydedilmez.
                                    Word çıktısı yalnız strict QA PASS kaydedilmiş
                                    6.1.6 versiyonunda aktiftir.
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

                ${this.qaHtml(current)}
                ${this.sourcesHtml(current)}
                ${this.costHtml(current)}

            </div>
        `;

        this.bindEvents();
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


    setGenerationMessage(message) {

        this.generationMessage =
            String(message || '');

        const mount =
            document.getElementById(
                'oppDraftGenerationStatus'
            );

        if (mount) {

            mount.innerHTML = `
                <i class="fas fa-spinner fa-spin mr-2"></i>
                ${this.escape(this.generationMessage)}
            `;
        }
    }


    async generate() {

        if (this.isGenerating) {
            return;
        }

        this.isGenerating =
            true;

        this.generationMessage =
            'Legal Reasoning başlatılıyor...';

        this.render();

        try {

            const start =
                await this
                    .invokeGenerateStartWithRecovery();

            let generation =
                start.generation ||
                {};

            const reasoningRunId =
                generation
                    ?.reasoningRunId;

            if (!reasoningRunId) {

                throw new Error(
                    'reasoningRunId oluşmadı.'
                );
            }

            let draftRunId =
                generation
                    ?.draftRunId ||
                null;

            const startedAt =
                Date.now();

            const maxWaitMs =
                15 * 60 * 1000;

            while (
                Date.now() -
                startedAt <
                maxWaitMs
            ) {

                const stage =
                    generation
                        ?.stage;

                this.setGenerationMessage(
                    stage ===
                    'drafting'
                        ? 'Sol Final Petition hazırlanıyor...'
                        : 'Sol Legal Reasoning devam ediyor...'
                );

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            8000
                        )
                );

                const poll =
                    await this.invoke(
                        'generate_status',
                        {
                            reasoningRunId,
                            draftRunId
                        }
                    );

                generation =
                    poll.generation ||
                    {};

                draftRunId =
                    generation
                        ?.draftRunId ||
                    draftRunId;

                if (
                    generation
                        ?.generationStatus ===
                    'pending'
                ) {
                    continue;
                }

                if (
                    generation
                        ?.generationStatus ===
                    'qa_failed'
                ) {

                    this.transientDraft =
                        generation
                            ?.petition ||
                        null;

                    this.transientQa =
                        generation
                            ?.qaReport ||
                        null;

                    showNotification(
                        '6.1.6 taslak üretildi ancak strict QA geçmedi. DB’ye kaydedilmedi; Word export kapalı.',
                        'error'
                    );

                    return;
                }

                if (
                    generation
                        ?.generationStatus ===
                    'completed'
                ) {

                    this.status =
                        poll.status ||
                        this.status;

                    this.transientDraft =
                        null;

                    this.transientQa =
                        null;

                    this.selectedVersion =
                        this.status
                            ?.drafts
                            ?.[0]
                            ?.version_no ??
                        generation
                            ?.versionNo ??
                        null;

                    const advisoryCount =
                        (
                            generation
                                ?.reasoningValidationAdvisory ||
                            []
                        ).length;

                    showNotification(
                        `EVREKA 6.1.6 V${generation.versionNo} üretildi, strict QA geçti ve kaydedildi.${
                            advisoryCount
                                ? ` (${advisoryCount} reasoning advisory)`
                                : ''
                        }`,
                        'success'
                    );

                    return;
                }

                throw new Error(
                    'Bilinmeyen generationStatus: ' +
                    String(
                        generation
                            ?.generationStatus ||
                        ''
                    )
                );
            }

            throw new Error(
                '15 dakikalık üretim süresi doldu. Background run devam ediyor olabilir.'
            );

        } catch (error) {

            console.error(
                '6.1.6 dilekçe üretim hatası:',
                error
            );

            showNotification(
                'Dilekçe üretim hatası: ' +
                error.message,
                'error'
            );

        } finally {

            this.isGenerating =
                false;

            this.generationMessage =
                '';

            this.render();
        }
    }


    async generateWord() {

        const currentDraft =
            this.currentDraftObject();

        const editor =
            document.getElementById(
                'oppDraftEditor'
            );

        const petitionText =
            editor
                ?.value
                ?.trim();

        if (
            !currentDraft ||
            !petitionText
        ) {

            return showNotification(
                'Word oluşturulacak kaydedilmiş dilekçe versiyonu bulunamadı.',
                'warning'
            );
        }

        const qaReport =
            currentDraft
                ?.qa_report;

        if (
            qaReport
                ?.finalPass !==
            true ||
            String(
                qaReport
                    ?.enginePackageVersion ||
                ''
            ) !==
            '6.1.6'
        ) {

            return showNotification(
                'Profesyonel Word yalnız EVREKA 6.1.6 strict QA PASS kaydedilmiş versiyondan oluşturulabilir.',
                'warning'
            );
        }

        if (
            /\[(?:S|K)\d{1,3}\]/i.test(
                petitionText
            ) ||
            /⟦[^⟧]*⟧/.test(
                petitionText
            ) ||
            /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(
                petitionText
            )
        ) {

            return showNotification(
                'Dilekçe metninde internal marker/UUID bulundu. Word export durduruldu.',
                'error'
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
                'Seçili dilekçe versiyonunun belge snapshot’ı yok ve güncel analiz verileri değişmiş. Önce yeni 6.1 versiyonu üretin.',
                'warning'
            );
        }

        const documentData =
            snapshot ||
            currentDocumentData;

        if (!documentData) {

            return showNotification(
                'Profesyonel Word için belge verisi bulunamadı.',
                'warning'
            );
        }

        const button =
            document.getElementById(
                'oppDraftWordBtn'
            );

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
                        fileName
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
                `Profesyonel Word oluşturuldu (${imageSummary}).`,
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
                    false;

                button.innerHTML = `
                    <i class="fas fa-file-word mr-2"></i>
                    Profesyonel Word Oluştur
                `;
            }
        }
    }
}
