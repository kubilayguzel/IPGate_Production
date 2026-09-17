/*
 * EVREKA Opposition / Response Studio Launcher
 * Replacement for public/js/task-update/OppositionWorkspaceManager.js
 *
 * Keeps the existing class/import contract used by task-update/main.js.
 * Type 20 -> existing Opposition Studio (unchanged)
 * Type 38 -> new Opposition Response Studio
 */

const LAUNCHER_PACKAGE_VERSION = 'response-studio-1.0.2';

export class OppositionWorkspaceManager {
    constructor(taskId, taskData) {
        this.taskId = String(taskId);
        this.taskData = taskData || {};
        this.card = document.getElementById('oppositionWorkspaceCard');
        this.container = document.getElementById('oppositionWorkspaceContainer');
        this.statusBadge = document.getElementById('oppositionWorkspaceStatusBadge');
    }

    taskType() {
        return String(
            this.taskData?.taskType ||
            this.taskData?.task_type_id ||
            ''
        );
    }

    isSupportedTask() {
        return ['20', '38'].includes(this.taskType());
    }

    isResponseTask() {
        return this.taskType() === '38';
    }

    async init() {
        if (!this.card || !this.container) return;

        if (!this.isSupportedTask()) {
            this.card.style.display = 'none';
            return;
        }

        this.card.style.display = 'block';
        const headerLabel = this.card.querySelector('.card-header-custom > span:first-child');
        if (headerLabel) {
            headerLabel.innerHTML = this.isResponseTask()
                ? '<i class="fas fa-balance-scale mr-2"></i> İtiraza Karşı Görüş Çalışma Alanı'
                : '<i class="fas fa-balance-scale mr-2"></i> Yayına İtiraz Çalışma Alanı';
        }
        this.renderLauncher();
    }

    config() {
        if (this.isResponseTask()) {
            return {
                eyebrow: 'EVREKA · OPPOSITION RESPONSE STUDIO',
                title: 'İtiraza Karşı Görüş Çalışma Alanı',
                description:
                    'Kurum tebligatı, karşı taraf dilekçesi ve EPATS resmî itiraz belgesi birlikte okunur; taraflar, mesnet markalar ve iddialar otomatik çıkarılır. Savunma bulguları, doğrulanmış authority research, Strict QA ve profesyonel Word çıktısı ayrı Response Studio ekranında yürütülür.',
                badge: 'Response Studio',
                button: "Response Studio'yu Aç",
                baseUrl: 'opposition-response-workspace.html',
                color: '#2457d6',
                soft: '#edf3ff',
                stages: [
                    ['sources', '1', 'Kaynak Dosya', 'Tebligat · EPATS · karşı taraf dilekçesi'],
                    ['claims', '2', 'İtiraz Analizi', 'Taraflar · mesnet markalar · iddia haritası'],
                    ['findings', '3', 'Savunma Bulguları', 'Sparse ve bağlayıcı avukat bulguları'],
                    ['draft', '4', 'Karşı Görüş', 'Authority · Sol · QA · Word'],
                ],
            };
        }

        return {
            eyebrow: 'EVREKA · OPPOSITION STUDIO',
            title: 'Yayıma İtiraz Çalışma Alanı',
            description:
                'Yayına itirazın dosya kapsamı, SMK 6/1 hukuki analizi ve dilekçe üretimi ayrı Opposition Studio ekranında yürütülmektedir.',
            badge: 'Opposition Studio',
            button: "Opposition Studio'yu Aç",
            baseUrl: 'opposition-workspace.html',
            color: '#118a3a',
            soft: '#eef6f0',
            stages: [
                ['case', '1', 'Dosya ve Kapsam', 'Rakip başvuru · müstenit haklar'],
                ['analysis', '2', 'Hukuki Analiz', 'SMK 6/1 karar ağacı'],
                ['draft', '3', 'Dilekçe', 'Taslak · QA · Word'],
            ],
        };
    }

    workspaceUrl(stage) {
        const cfg = this.config();
        const allowed = new Set(cfg.stages.map(x => x[0]));
        const safeStage = allowed.has(stage) ? stage : cfg.stages[0][0];
        return `${cfg.baseUrl}?id=${encodeURIComponent(this.taskId)}#${safeStage}`;
    }

    setStatusBadge(label, color) {
        if (!this.statusBadge) return;
        this.statusBadge.className = 'opp-status-badge opp-status-ready';
        this.statusBadge.textContent = label;
        this.statusBadge.style.background = color;
        this.statusBadge.style.color = '#fff';
    }

    taskLabel() {
        return (
            this.taskData?.title ||
            this.taskData?.taskTitle ||
            this.taskData?.task_title ||
            `İş #${this.taskId}`
        );
    }

    renderLauncher() {
        const cfg = this.config();
        this.setStatusBadge(cfg.badge, cfg.color);

        const taskLabel = this.taskLabel();
        const firstStage = cfg.stages[0][0];

        this.container.innerHTML = `
            <div class="evreka-studio-launcher" style="border:1px solid #dfe5ec;border-radius:14px;background:linear-gradient(135deg,#fbfcff 0%,#ffffff 70%);padding:18px;">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap;">
                    <div style="min-width:0;flex:1 1 520px;">
                        <div style="color:${this.escape(cfg.color)};font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:5px;">
                            ${this.escape(cfg.eyebrow)}
                        </div>
                        <div style="color:#172033;font-size:17px;font-weight:800;line-height:1.3;">
                            ${this.escape(cfg.title)}
                        </div>
                        <div style="color:#667085;font-size:12px;line-height:1.5;margin-top:6px;">
                            ${this.escape(cfg.description)}
                        </div>
                        <div style="color:#475467;font-size:11px;font-weight:700;margin-top:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${this.attr(taskLabel)}">
                            <i class="fas fa-briefcase mr-1"></i>${this.escape(taskLabel)}
                        </div>
                    </div>
                    <a href="${this.attr(this.workspaceUrl(firstStage))}" target="_blank" rel="noopener" class="btn" style="min-width:210px;font-weight:700;background:${this.escape(cfg.color)};color:#fff;">
                        <i class="fas fa-external-link-alt mr-2"></i>${this.escape(cfg.button)}
                    </a>
                </div>

                <div class="evreka-studio-stage-links" style="display:grid;grid-template-columns:repeat(${cfg.stages.length},minmax(0,1fr));gap:8px;margin-top:15px;">
                    ${cfg.stages.map(stage => this.stageLink(cfg, ...stage)).join('')}
                </div>

                <div style="margin-top:12px;padding-top:11px;border-top:1px solid #edf0f3;color:#98a2b3;font-size:10px;">
                    <i class="fas fa-shield-alt mr-1"></i>
                    ${this.isResponseTask()
                        ? 'Type 38 · kaynak-belge merkezli savunma akışı · mevcut Opposition Studio değiştirilmez'
                        : 'Type 20 · mevcut Opposition Studio akışı korunur'}
                    · ${this.escape(LAUNCHER_PACKAGE_VERSION)}
                </div>
            </div>
            <style>
                @media (max-width: 960px) {
                    .evreka-studio-stage-links { grid-template-columns:1fr !important; }
                }
            </style>
        `;
    }

    stageLink(cfg, stage, number, title, subtitle) {
        return `
            <a href="${this.attr(this.workspaceUrl(stage))}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:9px;min-width:0;padding:10px 11px;border:1px solid #e1e6ec;border-radius:10px;background:#fff;color:#344054;text-decoration:none;">
                <span style="display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;width:27px;height:27px;border-radius:50%;background:${this.escape(cfg.soft)};color:${this.escape(cfg.color)};font-size:10px;font-weight:800;">${this.escape(number)}</span>
                <span style="min-width:0;">
                    <strong style="display:block;font-size:11px;color:#344054;">${this.escape(title)}</strong>
                    <small style="display:block;margin-top:2px;overflow:hidden;color:#7a8493;font-size:9px;text-overflow:ellipsis;white-space:nowrap;">${this.escape(subtitle)}</small>
                </span>
            </a>
        `;
    }

    escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        }[char]));
    }

    attr(value) {
        return this.escape(value);
    }
}
