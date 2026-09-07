import {
    authService
} from '../../supabase-config.js';

import {
    loadSharedLayout
} from '../layout-loader.js';

import {
    showNotification
} from '../../utils.js';

import {
    OppositionCaseScopeManager
} from './OppositionCaseScopeManager.js';

/*
 * Paket 6.1.8'de stabil 6.1.6 / 6.1.7 manager dosyaları
 * task-update klasöründe bırakılıyor.
 *
 * Ayrı çalışma alanı onları yeniden yazmadan tüketiyor.
 */
import {
    Smk61DecisionTreeManager
} from '../task-update/Smk61DecisionTreeManager.js';

import {
    OppositionDraftManager
} from '../task-update/OppositionDraftManager.js';


const STAGES = [
    'case',
    'analysis',
    'draft'
];


class OppositionStudioController {

    constructor() {
        this.taskId = null;

        this.caseScopeManager =
            null;

        this.analysisManager =
            null;

        this.draftManager =
            null;

        this.workspace =
            null;

        this.activeStage =
            'case';

        this.boundWorkspaceSaved =
            event =>
                this.onWorkspaceSaved(
                    event
                );

        this.boundAnalysisSaved =
            () =>
                this.refreshStageStatuses();
    }


    async init() {
        await loadSharedLayout({
            activeMenuLink:
                'my-tasks.html'
        });

        const session =
            await authService
                .getCurrentSession();

        if (!session) {
            window.location.href =
                'index.html';

            return;
        }

        this.taskId =
            new URLSearchParams(
                window.location.search
            ).get('id');

        if (!this.taskId) {
            this.renderFatal(
                'Task ID bulunamadı.'
            );

            return;
        }

        const taskDetailLink =
            document.getElementById(
                'oppStudioTaskDetailLink'
            );

        if (taskDetailLink) {
            taskDetailLink.href =
                `task-update.html?id=${encodeURIComponent(this.taskId)}`;
        }

        this.bindNavigation();

        window.addEventListener(
            'opposition-workspace-saved',
            this.boundWorkspaceSaved
        );

        window.addEventListener(
            'opposition-analysis-saved',
            this.boundAnalysisSaved
        );

        try {
            this.caseScopeManager =
                new OppositionCaseScopeManager(
                    this.taskId
                );

            this.workspace =
                await this
                    .caseScopeManager
                    .init();

            this.updateHeader();
            this.updateCaseStatus();

            await this.initAnalysis();
            await this.initDraft();

            this.refreshStageStatuses();

            const hashStage =
                window.location.hash
                    .replace(
                        '#',
                        ''
                    );

            this.setStage(
                STAGES.includes(
                    hashStage
                )
                    ? hashStage
                    : 'case',
                {
                    updateHash:
                        false
                }
            );
        } catch (error) {
            console.error(
                'Opposition Studio başlatma hatası:',
                error
            );

            this.renderFatal(
                error.message
            );
        }
    }


    bindNavigation() {
        document
            .querySelectorAll(
                '.opp-studio-nav-item'
            )
            .forEach(
                button => {
                    button.addEventListener(
                        'click',
                        () =>
                            this.setStage(
                                button.dataset
                                    .stage
                            )
                    );
                }
            );

        window.addEventListener(
            'hashchange',
            () => {
                const stage =
                    window.location.hash
                        .replace(
                            '#',
                            ''
                        );

                if (
                    STAGES.includes(
                        stage
                    )
                ) {
                    this.setStage(
                        stage,
                        {
                            updateHash:
                                false
                        }
                    );
                }
            }
        );
    }


    async initAnalysis() {
        const mount =
            document.getElementById(
                'smk61DecisionTreeMount'
            );

        if (!mount) {
            return;
        }

        mount.innerHTML = '';

        this.analysisManager =
            new Smk61DecisionTreeManager(
                this.taskId,
                this.workspace
            );

        try {
            await this
                .analysisManager
                .init();
        } catch (error) {
            console.error(
                'SMK 6/1 analiz manager başlatılamadı:',
                error
            );

            mount.innerHTML = `
                <div class="alert alert-danger mb-0">
                    Hukuki analiz ekranı başlatılamadı:
                    ${this.escape(error.message)}
                </div>
            `;
        }
    }


    async initDraft() {
        const mount =
            document.getElementById(
                'oppositionDraftMount'
            );

        if (!mount) {
            return;
        }

        mount.innerHTML = '';

        this.draftManager =
            new OppositionDraftManager(
                this.taskId
            );

        try {
            await this
                .draftManager
                .init();
        } catch (error) {
            console.error(
                'Opposition Draft Manager başlatılamadı:',
                error
            );

            mount.innerHTML = `
                <div class="alert alert-danger mb-0">
                    Dilekçe üretim motoru başlatılamadı:
                    ${this.escape(error.message)}
                </div>
            `;
        }
    }


    async onWorkspaceSaved(event) {
        if (
            String(
                event?.detail?.taskId ||
                ''
            ) !==
            String(
                this.taskId
            )
        ) {
            return;
        }

        this.workspace =
            event?.detail?.workspace ||
            this.caseScopeManager?.workspace ||
            this.workspace;

        this.updateHeader();
        this.updateCaseStatus();

        /*
         * SMK 6/1 seçimi / müstenit hak kapsamı değişmiş olabilir.
         * Decision Tree manager yeni workspace snapshot ile yeniden kurulur.
         *
         * Draft manager event'i kendisi dinlediği için status refresh
         * mevcut üretim kodu tarafından yapılır.
         */
        await this.initAnalysis();

        this.refreshStageStatuses();
    }


    setStage(
        stage,
        {
            updateHash = true
        } = {}
    ) {
        if (
            !STAGES.includes(
                stage
            )
        ) {
            return;
        }

        this.activeStage =
            stage;

        document
            .querySelectorAll(
                '.opp-studio-nav-item'
            )
            .forEach(
                button => {
                    const active =
                        button.dataset
                            .stage ===
                        stage;

                    button.classList
                        .toggle(
                            'is-active',
                            active
                        );

                    if (active) {
                        button.setAttribute(
                            'aria-current',
                            'step'
                        );
                    } else {
                        button.removeAttribute(
                            'aria-current'
                        );
                    }
                }
            );

        document
            .querySelectorAll(
                '.opp-studio-stage'
            )
            .forEach(
                panel => {
                    panel.classList
                        .toggle(
                            'is-active',
                            panel.dataset
                                .stagePanel ===
                                stage
                        );
                }
            );

        if (
            updateHash &&
            window.location.hash !==
                `#${stage}`
        ) {
            history.replaceState(
                null,
                '',
                `${window.location.pathname}${window.location.search}#${stage}`
            );
        }

        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    }


    updateHeader() {
        const ws =
            this.workspace ||
            {};

        const clientName =
            ws.client?.name ||
            'Müvekkil';

        const markText =
            ws.opponent
                ?.markText ||
            'İtiraz edilen marka';

        const applicationNo =
            ws.opponent
                ?.applicationNo ||
            '-';

        const title =
            document.getElementById(
                'oppStudioTitle'
            );

        const subtitle =
            document.getElementById(
                'oppStudioSubtitle'
            );

        const meta =
            document.getElementById(
                'oppStudioCaseMeta'
            );

        if (title) {
            title.textContent =
                `${clientName} → ${markText}`;
        }

        if (subtitle) {
            subtitle.textContent =
                `Yayıma İtiraz Çalışma Alanı · Başvuru No: ${applicationNo}`;
        }

        if (meta) {
            const dueDate =
                this.formatDate(
                    ws.task
                        ?.officialDueDate
                );

            const bulletin =
                ws.bulletin
                    ?.bulletin_no ||
                '-';

            const complexity =
                ws.case
                    ?.complexity ||
                '-';

            const caseStatus =
                ws.case
                    ?.status ||
                '-';

            meta.innerHTML = `
                <span class="opp-studio-meta-chip">
                    <i class="fas fa-hashtag"></i>
                    İş ${this.escape(ws.task?.id || this.taskId)}
                </span>

                <span class="opp-studio-meta-chip">
                    <i class="fas fa-newspaper"></i>
                    Bülten ${this.escape(bulletin)}
                </span>

                <span class="opp-studio-meta-chip is-deadline">
                    <i class="far fa-calendar-alt"></i>
                    Resmî Son Tarih:
                    ${this.escape(dueDate)}
                </span>

                <span class="opp-studio-meta-chip">
                    <i class="fas fa-layer-group"></i>
                    ${this.escape(complexity)}
                </span>

                <span class="opp-studio-meta-chip is-success">
                    <i class="fas fa-circle"></i>
                    ${this.escape(caseStatus)}
                </span>
            `;
        }

        document.title =
            `IPGATE - ${markText} Yayıma İtiraz`;
    }


    updateCaseStatus() {
        this.setStageStatus(
            'case',
            this.workspace
                ? 'Hazır'
                : '—',
            Boolean(
                this.workspace
            )
        );
    }


    refreshStageStatuses() {
        this.updateCaseStatus();

        const readiness =
            this.analysisManager
                ?.context
                ?.readiness ||
            null;

        if (readiness) {
            if (
                readiness.canDraft ===
                true
            ) {
                this.setStageStatus(
                    'analysis',
                    'Hazır',
                    true
                );
            } else {
                const blockers =
                    readiness
                        .blockers
                        ?.length ||
                    0;

                this.setStageStatus(
                    'analysis',
                    blockers
                        ? `${blockers} eksik`
                        : 'Eksik',
                    false,
                    true
                );
            }
        } else {
            this.setStageStatus(
                'analysis',
                '—',
                false
            );
        }

        const selectedDraft =
            this.draftManager
                ?.selectedVersion ||
            null;

        const qa =
            selectedDraft?.qaReport ||
            selectedDraft?.qa_report ||
            null;

        if (
            qa?.finalPass ===
            true
        ) {
            this.setStageStatus(
                'draft',
                'QA PASS',
                true
            );
        } else if (
            selectedDraft
        ) {
            this.setStageStatus(
                'draft',
                'Taslak',
                false,
                true
            );
        } else {
            this.setStageStatus(
                'draft',
                '—',
                false
            );
        }
    }


    setStageStatus(
        stage,
        text,
        ready = false,
        warning = false
    ) {
        const element =
            document.querySelector(
                `[data-stage-status="${stage}"]`
            );

        if (!element) {
            return;
        }

        element.textContent =
            text;

        element.classList
            .toggle(
                'is-ready',
                ready
            );

        element.classList
            .toggle(
                'is-warning',
                !ready &&
                warning
            );
    }


    renderFatal(message) {
        const title =
            document.getElementById(
                'oppStudioTitle'
            );

        const subtitle =
            document.getElementById(
                'oppStudioSubtitle'
            );

        const shell =
            document.querySelector(
                '.opp-studio-shell'
            );

        if (title) {
            title.textContent =
                'Yayıma İtiraz Çalışma Alanı';
        }

        if (subtitle) {
            subtitle.textContent =
                'Çalışma alanı açılamadı.';
        }

        if (shell) {
            shell.innerHTML = `
                <div style="padding:28px;">
                    <div class="alert alert-danger mb-0">
                        <div class="font-weight-bold mb-2">
                            <i class="fas fa-exclamation-triangle mr-1"></i>
                            Çalışma alanı yüklenemedi
                        </div>

                        <div>
                            ${this.escape(message)}
                        </div>

                        <div class="mt-3">
                            <a
                                href="./my-tasks.html"
                                class="btn btn-outline-danger"
                            >
                                İşlerime Dön
                            </a>
                        </div>
                    </div>
                </div>
            `;
        }

        showNotification(
            'Yayıma itiraz çalışma alanı açılamadı: ' +
            message,
            'error'
        );
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
            return String(
                value
            );
        }

        return date.toLocaleDateString(
            'tr-TR'
        );
    }
}


document.addEventListener(
    'DOMContentLoaded',
    async () => {
        const controller =
            new OppositionStudioController();

        window.__oppositionStudioController =
            controller;

        await controller.init();
    }
);
