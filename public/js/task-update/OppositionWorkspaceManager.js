/*
 * EVREKA Paket 6.1.9
 * Legacy Task Update Opposition Workspace Cleanup
 *
 * Bu manager artık task-update.html içine:
 * - dosya/kapsam formu,
 * - SMK 6/1 Decision Tree,
 * - dilekçe üretim alanı
 * render ETMEZ.
 *
 * Task Type 20 için yalnız kompakt Opposition Studio launcher gösterir.
 *
 * Asıl çalışma alanı:
 * public/opposition-workspace.html?id=<TASK_ID>
 *
 * Not:
 * Class adı ve dosya yolu bilerek korunmuştur.
 * Böylece public/js/task-update/main.js dosyasına dokunmadan
 * mevcut import/init sözleşmesi korunur.
 */

const CLEANUP_PACKAGE_VERSION = '6.1.9';


export class OppositionWorkspaceManager {

    constructor(
        taskId,
        taskData
    ) {
        this.taskId =
            String(
                taskId
            );

        this.taskData =
            taskData ||
            {};

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

        if (
            !this.card ||
            !this.container
        ) {
            return;
        }

        if (
            !this.isOppositionTask()
        ) {
            this.card.style.display =
                'none';

            return;
        }

        this.card.style.display =
            'block';

        this.renderLauncher();
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


    workspaceUrl(
        stage = 'case'
    ) {
        const safeStage =
            [
                'case',
                'analysis',
                'draft'
            ].includes(
                stage
            )
                ? stage
                : 'case';

        return (
            `opposition-workspace.html?id=` +
            `${encodeURIComponent(this.taskId)}` +
            `#${safeStage}`
        );
    }


    setStatusBadge() {

        if (
            !this.statusBadge
        ) {
            return;
        }

        this.statusBadge.className =
            [
                'opp-status-badge',
                'opp-status-ready'
            ].join(' ');

        this.statusBadge.textContent =
            'Opposition Studio';
    }


    taskLabel() {
        return (
            this.taskData?.title ||
            this.taskData?.taskTitle ||
            this.taskData?.task_title ||
            `Yayına İtiraz İş #${this.taskId}`
        );
    }


    renderLauncher() {

        this.setStatusBadge();

        const taskLabel =
            this.taskLabel();

        this.container.innerHTML = `
            <div
                class="opp619-launcher"
                style="
                    border:1px solid #dfe5ec;
                    border-radius:14px;
                    background:
                        linear-gradient(
                            135deg,
                            #fbfdfb 0%,
                            #ffffff 70%
                        );
                    padding:18px;
                "
            >
                <div
                    style="
                        display:flex;
                        align-items:flex-start;
                        justify-content:space-between;
                        gap:18px;
                        flex-wrap:wrap;
                    "
                >
                    <div
                        style="
                            min-width:0;
                            flex:1 1 520px;
                        "
                    >
                        <div
                            style="
                                color:#118a3a;
                                font-size:10px;
                                font-weight:800;
                                letter-spacing:.08em;
                                text-transform:uppercase;
                                margin-bottom:5px;
                            "
                        >
                            EVREKA · OPPOSITION STUDIO
                        </div>

                        <div
                            style="
                                color:#172033;
                                font-size:17px;
                                font-weight:800;
                                line-height:1.3;
                            "
                        >
                            Yayıma İtiraz Çalışma Alanı
                        </div>

                        <div
                            style="
                                color:#667085;
                                font-size:12px;
                                line-height:1.5;
                                margin-top:6px;
                            "
                        >
                            Yayına itirazın dosya kapsamı, SMK 6/1
                            hukuki analizi ve dilekçe üretimi artık
                            ayrı Opposition Studio ekranında yürütülmektedir.
                        </div>

                        <div
                            style="
                                color:#475467;
                                font-size:11px;
                                font-weight:700;
                                margin-top:9px;
                                overflow:hidden;
                                text-overflow:ellipsis;
                                white-space:nowrap;
                            "
                            title="${this.escape(taskLabel)}"
                        >
                            <i class="fas fa-briefcase mr-1"></i>
                            ${this.escape(taskLabel)}
                        </div>
                    </div>

                    <a
                        href="${this.escape(this.workspaceUrl('case'))}"
                        target="_blank"
                        rel="noopener"
                        class="btn btn-success"
                        style="
                            min-width:210px;
                            font-weight:700;
                        "
                    >
                        <i class="fas fa-external-link-alt mr-2"></i>
                        Opposition Studio'yu Aç
                    </a>
                </div>

                <div
                    style="
                        display:grid;
                        grid-template-columns:
                            repeat(
                                3,
                                minmax(0,1fr)
                            );
                        gap:8px;
                        margin-top:15px;
                    "
                    class="opp619-stage-links"
                >
                    ${this.stageLink(
                        'case',
                        '1',
                        'Dosya ve Kapsam',
                        'Rakip başvuru · müstenit haklar'
                    )}

                    ${this.stageLink(
                        'analysis',
                        '2',
                        'Hukuki Analiz',
                        'SMK 6/1 karar ağacı'
                    )}

                    ${this.stageLink(
                        'draft',
                        '3',
                        'Dilekçe',
                        'Taslak · QA · Word'
                    )}
                </div>

                <div
                    style="
                        margin-top:12px;
                        padding-top:11px;
                        border-top:1px solid #edf0f3;
                        color:#98a2b3;
                        font-size:10px;
                    "
                >
                    <i class="fas fa-broom mr-1"></i>
                    Legacy gömülü çalışma alanı kaldırıldı ·
                    Cleanup ${CLEANUP_PACKAGE_VERSION}
                </div>
            </div>

            <style>
                @media (max-width: 820px) {
                    .opp619-stage-links {
                        grid-template-columns:
                            1fr !important;
                    }
                }
            </style>
        `;
    }


    stageLink(
        stage,
        number,
        title,
        subtitle
    ) {
        return `
            <a
                href="${this.escape(this.workspaceUrl(stage))}"
                target="_blank"
                rel="noopener"
                style="
                    display:flex;
                    align-items:center;
                    gap:9px;
                    min-width:0;
                    padding:10px 11px;
                    border:1px solid #e1e6ec;
                    border-radius:10px;
                    background:#ffffff;
                    color:#344054;
                    text-decoration:none;
                "
            >
                <span
                    style="
                        display:inline-flex;
                        flex:0 0 auto;
                        align-items:center;
                        justify-content:center;
                        width:27px;
                        height:27px;
                        border-radius:50%;
                        background:#eef6f0;
                        color:#118a3a;
                        font-size:10px;
                        font-weight:800;
                    "
                >
                    ${this.escape(number)}
                </span>

                <span
                    style="
                        min-width:0;
                    "
                >
                    <strong
                        style="
                            display:block;
                            font-size:11px;
                            color:#344054;
                        "
                    >
                        ${this.escape(title)}
                    </strong>

                    <small
                        style="
                            display:block;
                            margin-top:2px;
                            overflow:hidden;
                            color:#7a8493;
                            font-size:9px;
                            text-overflow:ellipsis;
                            white-space:nowrap;
                        "
                    >
                        ${this.escape(subtitle)}
                    </small>
                </span>
            </a>
        `;
    }
}
