// public/js/suit-detail-enhancement.js
// IPGate Dava Yönetimi - AŞAMA 5S / TAXONOMIC TIMELINE
//
// Bu modül mevcut suit-detail.html davranışını değiştirmez.
// Sayfa ilk yüklemesini tamamladıktan sonra:
// - dava taraflarını suit_parties üzerinden gösterir,
// - dava konusu IP kaydını tıklanabilir yapar,
// - davayı doğuran task bağlantısını gösterir,
// - timeline'ı transactions.ip_record_id = suits.id standardına göre yeniden çizer,
// - transaction_documents + task_documents + suit_documents belgelerini
//   URL bazında tekilleştirerek gösterir.
//
// YAZMA İŞLEMİ YOKTUR.

import { supabase } from '../supabase-config.js';
import { formatToTRDate } from '../utils.js';

const params = new URLSearchParams(window.location.search);
const suitId = params.get('id');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function safeUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    try {
        const url = new URL(raw, window.location.origin);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        return url.href;
    } catch {
        return null;
    }
}

function addStyles() {
    if (document.getElementById('litigationStage2Styles')) return;

    const style = document.createElement('style');
    style.id = 'litigationStage2Styles';
    style.textContent = `
        .litigation-party-list {
            display: flex;
            flex-wrap: wrap;
            gap: 7px;
            margin-top: 5px;
        }

        .litigation-party-chip {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            border-radius: 999px;
            background: #f8fafc;
            border: 1px solid #dbe3ec;
            color: #334155;
            font-size: .86rem;
            font-weight: 600;
        }

        .litigation-party-chip.client {
            background: #eef6ff;
            border-color: #b8d8ff;
            color: #1e4f91;
        }

        .litigation-header-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 10px;
        }

        .litigation-header-actions a {
            white-space: nowrap;
        }

        .litigation-integrity-note {
            border-radius: 10px;
            padding: 9px 12px;
            margin-bottom: 15px;
            font-size: .84rem;
        }

        .litigation-integrity-note.ok {
            background: #ecfdf3;
            border: 1px solid #b7ebc7;
            color: #176b35;
        }

        .litigation-integrity-note.warn {
            background: #fff8e6;
            border: 1px solid #f5d98b;
            color: #7c5b00;
        }

        .timeline-item.litigation-child {
            margin-left: 18px;
        }

        .timeline-item.litigation-child::before {
            background: #6c757d;
            box-shadow: 0 0 0 2px #6c757d;
        }

        .litigation-meta-row {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 8px;
        }

        .litigation-meta-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px 7px;
            border-radius: 999px;
            font-size: .72rem;
            border: 1px solid #dbe3ec;
            background: #fff;
            color: #5f6b7a;
        }

        .litigation-docs {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid #e6e9ed;
        }

        .litigation-doc-link {
            display: flex;
            align-items: center;
            min-width: 0;
            padding: 8px 10px;
            border: 1px solid #e1e5ea;
            border-radius: 8px;
            background: #fff;
            text-decoration: none !important;
            color: #344054 !important;
            font-size: .84rem;
        }

        .litigation-doc-link:hover {
            background: #f8fafc;
            border-color: #cbd5e1;
        }

        .litigation-doc-name {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .litigation-doc-source {
            margin-left: auto;
            padding-left: 10px;
            color: #8a94a3;
            font-size: .72rem;
            white-space: nowrap;
        }

        .litigation-task-link {
            font-size: .76rem;
        }

        .litigation-subject-link {
            font-weight: 600;
            text-decoration: underline;
        }

        .litigation-case-tree {
            display: flex;
            flex-direction: column;
            gap: 14px;
        }

        .litigation-case-root {
            border: 1px solid #cfd8e6;
            background: #f8fafc;
            border-radius: 12px;
            padding: 12px 14px;
        }

        .litigation-case-root-label {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: .70rem;
            font-weight: 800;
            letter-spacing: .05em;
            color: #1e4f91;
            text-transform: uppercase;
        }

        .litigation-case-root-title {
            margin-top: 3px;
            font-size: 1rem;
            font-weight: 800;
            color: #263449;
        }

        .litigation-case-root-meta {
            margin-top: 4px;
            color: #667085;
            font-size: .78rem;
        }

        .litigation-stage-group {
            border: 1px solid #dce3ec;
            border-radius: 12px;
            overflow: hidden;
            background: #fff;
        }

        .litigation-stage-header {
            padding: 12px 14px;
            background: #f5f8fc;
            border-bottom: 1px solid #dce3ec;
        }

        .litigation-stage-kicker {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 7px;
            margin-bottom: 4px;
        }

        .litigation-stage-badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 3px 8px;
            border-radius: 999px;
            font-size: .67rem;
            font-weight: 800;
            color: #1e4f91;
            background: #eaf2ff;
            border: 1px solid #c4d8fb;
        }

        .litigation-stage-title {
            font-size: .98rem;
            font-weight: 800;
            color: #1f2937;
        }

        .litigation-stage-description {
            margin-top: 3px;
            color: #667085;
            font-size: .80rem;
        }

        .litigation-stage-children {
            position: relative;
            padding: 8px 12px 10px 28px;
        }

        .litigation-stage-children::before {
            content: '';
            position: absolute;
            top: 0;
            bottom: 12px;
            left: 17px;
            width: 2px;
            background: #e4e9f0;
        }

        .litigation-child-row {
            position: relative;
            padding: 10px 10px 10px 14px;
            margin: 3px 0;
            border-radius: 9px;
            background: #fff;
        }

        .litigation-child-row::before {
            content: '';
            position: absolute;
            left: -16px;
            top: 22px;
            width: 16px;
            height: 2px;
            background: #d7dee8;
        }

        .litigation-child-row::after {
            content: '';
            position: absolute;
            left: -19px;
            top: 18px;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #94a3b8;
            border: 2px solid #fff;
            box-shadow: 0 0 0 1px #cbd5e1;
        }

        .litigation-child-row + .litigation-child-row {
            border-top: 1px dashed #e7ebf0;
        }

        .litigation-child-topline {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 10px;
        }

        .litigation-child-title {
            font-weight: 750;
            color: #263449;
            font-size: .90rem;
        }

        .litigation-child-date {
            color: #667085;
            font-size: .73rem;
            white-space: nowrap;
        }

        .litigation-flow-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 7px;
            border-radius: 999px;
            font-size: .63rem;
            font-weight: 800;
            letter-spacing: .02em;
        }

        .litigation-flow-badge.incoming {
            background: #eef6ff;
            border: 1px solid #c8ddfa;
            color: #245a9d;
        }

        .litigation-flow-badge.work {
            background: #eefbf3;
            border: 1px solid #c5ead2;
            color: #216a3a;
        }

        .litigation-flow-badge.other {
            background: #f4f5f7;
            border: 1px solid #dfe3e8;
            color: #596273;
        }

        .litigation-empty-stage {
            padding: 12px 14px;
            color: #8a94a3;
            font-size: .80rem;
            font-style: italic;
        }

        .litigation-orphan-group {
            border: 1px solid #f1d58b;
            background: #fffaf0;
            border-radius: 12px;
            padding: 12px;
        }

        .litigation-orphan-title {
            font-weight: 800;
            color: #7c5b00;
            margin-bottom: 8px;
        }
    `;
    document.head.appendChild(style);
}

function waitForBaseTimeline() {
    return new Promise((resolve) => {
        const container = document.getElementById('timelineContainer');
        if (!container) return resolve();

        const initialText = String(container.textContent || '').trim().toLocaleLowerCase('tr-TR');
        if (initialText && !initialText.includes('yükleniyor')) {
            return resolve();
        }

        let resolved = false;
        const finish = () => {
            if (resolved) return;
            resolved = true;
            observer.disconnect();
            resolve();
        };

        const observer = new MutationObserver(() => {
            const text = String(container.textContent || '').trim().toLocaleLowerCase('tr-TR');
            if (text && !text.includes('yükleniyor')) {
                finish();
            }
        });

        observer.observe(container, {
            childList: true,
            subtree: true,
            characterData: true
        });

        // Eski yükleme akışı beklenmedik şekilde takılırsa enhancement yine devreye girsin.
        setTimeout(finish, 2500);
    });
}

function normalizeRelationOne(value) {
    if (!value) return null;
    return Array.isArray(value) ? (value[0] || null) : value;
}

function getPartyName(party) {
    const person = normalizeRelationOne(party?.persons);
    return (
        person?.name ||
        party?.free_text_name ||
        'İsimsiz Taraf'
    );
}

function formatRole(role) {
    const normalized = String(role || '').toLocaleLowerCase('tr-TR');
    const roles = {
        davaci: 'Davacı',
        davali: 'Davalı',
        mudahil: 'Müdahil',
        karsi_taraf: 'Karşı Taraf'
    };
    return roles[normalized] || role || '-';
}

function dedupeDocuments(items) {
    const seen = new Set();
    const result = [];

    for (const item of items || []) {
        if (!item) continue;

        const url = item.document_url || item.url || null;
        const name = item.document_name || item.file_name || item.name || 'Belge';

        // URL varsa ana tekilleştirme anahtarı URL'dir.
        // URL yoksa isim+source kombinasyonuna düşer.
        const key = String(
            url ||
            `${name}|${item._source || ''}`
        ).trim();

        if (!key || seen.has(key)) continue;

        seen.add(key);
        result.push({
            ...item,
            _displayName: name,
            _displayUrl: url
        });
    }

    return result;
}

function groupBy(list, key) {
    const map = new Map();

    for (const item of list || []) {
        const value = String(item?.[key] || '');
        if (!value) continue;

        if (!map.has(value)) map.set(value, []);
        map.get(value).push(item);
    }

    return map;
}

function renderPartySummary(suit, parties) {
    const clientId = suit?.client_id ? String(suit.client_id) : null;

    const existing = document.getElementById('litigationPartySummary');
    if (existing) existing.remove();

    const targetCard = document.getElementById('viewOpposingCounsel')?.closest('.section-card');
    if (!targetCard) return;

    const plaintiffs = (parties || []).filter(
        (p) => String(p.role || '').toLocaleLowerCase('tr-TR') === 'davaci'
    );

    const defendants = (parties || []).filter(
        (p) => String(p.role || '').toLocaleLowerCase('tr-TR') === 'davali'
    );

    const renderChips = (list) => {
        if (!list.length) return '<span class="text-muted">-</span>';

        return `
            <div class="litigation-party-list">
                ${list.map((party) => {
                    const isClient =
                        clientId &&
                        party.person_id &&
                        String(party.person_id) === clientId;

                    return `
                        <span class="litigation-party-chip ${isClient ? 'client' : ''}">
                            <i class="fas ${isClient ? 'fa-user-shield' : 'fa-user'}"></i>
                            ${escapeHtml(getPartyName(party))}
                            ${isClient ? '<small>(Müvekkil)</small>' : ''}
                        </span>
                    `;
                }).join('')}
            </div>
        `;
    };

    const wrapper = document.createElement('div');
    wrapper.id = 'litigationPartySummary';
    wrapper.innerHTML = `
        <div class="detail-row">
            <span class="detail-label">Davacılar:</span>
            <span class="detail-value">${renderChips(plaintiffs)}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Davalılar:</span>
            <span class="detail-value">${renderChips(defendants)}</span>
        </div>
    `;

    targetCard.appendChild(wrapper);
}

function renderHeaderLinks(suit) {
    const headerLeft = document.getElementById('suitTitleHeader')?.parentElement;
    if (!headerLeft) return;

    let actions = document.getElementById('litigationHeaderActions');

    if (!actions) {
        actions = document.createElement('div');
        actions.id = 'litigationHeaderActions';
        actions.className = 'litigation-header-actions';
        headerLeft.appendChild(actions);
    }

    const links = [];

    if (suit?.task_id) {
        links.push(`
            <a
                class="btn btn-sm btn-outline-primary"
                href="task-update.html?id=${encodeURIComponent(String(suit.task_id))}"
                target="_blank"
                rel="noopener"
            >
                <i class="fas fa-tasks mr-1"></i>
                Açılış İşine Git
            </a>
        `);
    }

    if (suit?.ip_record_id) {
        links.push(`
            <a
                class="btn btn-sm btn-outline-info"
                href="portfolio-detail.html?id=${encodeURIComponent(String(suit.ip_record_id))}"
                target="_blank"
                rel="noopener"
            >
                <i class="fas fa-briefcase mr-1"></i>
                Dava Konusu Portföye Git
            </a>
        `);
    }

    actions.innerHTML = links.join('');
}

async function renderSubjectAssetLink(suit) {
    const el = document.getElementById('viewSubjectAsset');
    if (!el || !suit?.ip_record_id) return;

    const { data: ipData, error } = await supabase
        .from('ip_records')
        .select(`
            id,
            title,
            application_number,
            ip_type,
            ip_record_trademark_details (brand_name)
        `)
        .eq('id', String(suit.ip_record_id))
        .maybeSingle();

    if (error || !ipData) return;

    const tmDetails = normalizeRelationOne(ipData.ip_record_trademark_details);

    const display =
        tmDetails?.brand_name ||
        ipData.title ||
        ipData.application_number ||
        'Portföy Kaydı';

    const metaParts = [
        ipData.application_number || null,
        ipData.ip_type || null
    ].filter(Boolean);

    el.innerHTML = `
        <a
            class="litigation-subject-link"
            href="portfolio-detail.html?id=${encodeURIComponent(String(ipData.id))}"
            target="_blank"
            rel="noopener"
        >
            ${escapeHtml(display)}
        </a>
        ${
            metaParts.length
                ? `<small class="d-block text-muted mt-1">${escapeHtml(metaParts.join(' · '))}</small>`
                : ''
        }
    `;
}

function renderIntegrityNotice(suit, transactions) {
    const container = document.getElementById('timelineContainer');
    if (!container) return;

    const existing = document.getElementById('litigationIntegrityNotice');
    if (existing) existing.remove();

    const hasOpeningTask = Boolean(suit?.task_id);
    const openingTransaction = hasOpeningTask
        ? (transactions || []).find(
            (tx) =>
                tx.task_id &&
                String(tx.task_id) === String(suit.task_id) &&
                String(tx.ip_record_id) === String(suitId)
        )
        : null;

    const notice = document.createElement('div');
    notice.id = 'litigationIntegrityNotice';

    if (!hasOpeningTask || openingTransaction) {
        notice.className = 'litigation-integrity-note ok';
        notice.innerHTML = `
            <i class="fas fa-check-circle mr-1"></i>
            Dava işlem bağlantısı tutarlı.
        `;
    } else {
        notice.className = 'litigation-integrity-note warn';
        notice.innerHTML = `
            <i class="fas fa-exclamation-triangle mr-1"></i>
            Dava açılış işi mevcut; ancak bu dava kimliğine bağlı açılış transaction'ı bulunamadı.
        `;
    }

    container.parentElement?.insertBefore(notice, container);
}

function renderDocumentList(docs) {
    if (!docs.length) return '';

    return `
        <div class="litigation-docs">
            ${docs.map((doc) => {
                const href = safeUrl(doc._displayUrl);
                const name = escapeHtml(doc._displayName || 'Belge');
                const source = escapeHtml(doc._sourceLabel || 'Belge');

                if (!href) {
                    return `
                        <div class="litigation-doc-link">
                            <i class="fas fa-file text-secondary mr-2"></i>
                            <span class="litigation-doc-name">${name}</span>
                            <span class="litigation-doc-source">${source}</span>
                        </div>
                    `;
                }

                return `
                    <a
                        href="${escapeHtml(href)}"
                        target="_blank"
                        rel="noopener"
                        class="litigation-doc-link"
                    >
                        <i class="fas fa-file-pdf text-danger mr-2"></i>
                        <span class="litigation-doc-name">${name}</span>
                        <span class="litigation-doc-source">${source}</span>
                    </a>
                `;
            }).join('')}
        </div>
    `;
}

function transactionTypeName(tx) {
    const typeRelation = normalizeRelationOne(tx?.transaction_types);

    return (
        typeRelation?.name ||
        typeRelation?.alias ||
        `İşlem ${tx?.transaction_type_id || ''}`.trim()
    );
}

function transactionDescription(tx) {
    return (
        tx?.description ||
        tx?.note ||
        'İşlem detay girilmemiş.'
    );
}

function transactionDateValue(tx) {
    const raw =
        tx?.transaction_date ||
        tx?.created_at ||
        null;

    const date = raw
        ? new Date(raw)
        : null;

    return (
        date &&
        !Number.isNaN(date.getTime())
    )
        ? date.getTime()
        : 0;
}

function childFlowType(tx) {
    const typeId =
        String(
            tx?.transaction_type_id || ''
        );

    if (
        ['70', '71', '72', '73', '74', '75', '76', '77', '78']
            .includes(typeId)
    ) {
        return {
            key: 'incoming',
            label: 'GELEN EVRAK',
            icon: 'fa-inbox'
        };
    }

    if (
        ['61', '62', '63', '64', '65']
            .includes(typeId)
    ) {
        return {
            key: 'work',
            label: 'İŞ / ÇIKTI',
            icon: 'fa-briefcase'
        };
    }

    return {
        key: 'other',
        label: 'ALT İŞLEM',
        icon: 'fa-level-down-alt'
    };
}

function collectTransactionDocuments(
    suit,
    tx,
    txDocsByTransaction,
    taskDocsByTask,
    suitDocs,
    {
        includeSuitDocs = false,
        includeTaskDocs = true
    } = {}
) {
    const docs = [];

    for (
        const doc of (
            txDocsByTransaction.get(
                String(tx.id)
            ) || []
        )
    ) {
        docs.push({
            ...doc,
            _source: 'transaction',
            _sourceLabel: 'İşlem Belgesi'
        });
    }

    if (
        includeTaskDocs &&
        tx.task_id
    ) {
        for (
            const doc of (
                taskDocsByTask.get(
                    String(tx.task_id)
                ) || []
            )
        ) {
            docs.push({
                ...doc,
                _source: 'task',
                _sourceLabel: 'İş Belgesi'
            });
        }
    }

    if (includeSuitDocs) {
        for (const doc of suitDocs || []) {
            docs.push({
                ...doc,
                _source: 'suit',
                _sourceLabel: 'Dava Ana Belgesi'
            });
        }
    }

    return dedupeDocuments(docs);
}

function renderTaskLink(tx) {
    if (
        !tx?.task_id ||
        tx.task_id === 'manual_entry'
    ) {
        return '';
    }

    return `
        <a
            href="task-update.html?id=${encodeURIComponent(String(tx.task_id))}"
            target="_blank"
            rel="noopener"
            class="litigation-task-link badge badge-light border"
        >
            <i class="fas fa-external-link-alt mr-1"></i>
            İş: ${escapeHtml(String(tx.task_id).substring(0, 8))}…
        </a>
    `;
}

function renderMetaRow(tx, extraBadge = '') {
    const userLabel =
        tx?.user_name ||
        tx?.user_email ||
        null;

    return `
        <div class="litigation-meta-row">
            ${
                tx?.transaction_type_id
                    ? `
                        <span class="litigation-meta-badge">
                            Tip: ${escapeHtml(tx.transaction_type_id)}
                        </span>
                    `
                    : ''
            }

            ${extraBadge}

            ${
                userLabel
                    ? `
                        <span class="litigation-meta-badge">
                            <i class="fas fa-user"></i>
                            ${escapeHtml(userLabel)}
                        </span>
                    `
                    : ''
            }
        </div>
    `;
}

function renderStageParent(
    suit,
    parent,
    txDocsByTransaction,
    taskDocsByTask,
    suitDocs
) {
    const isOpeningTransaction =
        suit?.task_id &&
        parent?.task_id &&
        String(suit.task_id) ===
            String(parent.task_id);

    const docs =
        collectTransactionDocuments(
            suit,
            parent,
            txDocsByTransaction,
            taskDocsByTask,
            suitDocs,
            {
                includeSuitDocs:
                    Boolean(isOpeningTransaction),
                includeTaskDocs:
                    true
            }
        );

    return `
        <div class="litigation-stage-header">
            <div class="litigation-stage-kicker">
                <span class="litigation-stage-badge">
                    <i class="fas fa-folder-open"></i>
                    ANA AŞAMA
                </span>

                <span class="litigation-meta-badge">
                    ${escapeHtml(
                        formatToTRDate(
                            parent.transaction_date ||
                            parent.created_at
                        ) || '-'
                    )}
                </span>

                ${renderTaskLink(parent)}
            </div>

            <div class="litigation-stage-title">
                ${escapeHtml(transactionTypeName(parent))}
            </div>

            <div class="litigation-stage-description">
                ${escapeHtml(transactionDescription(parent))}
            </div>

            ${renderMetaRow(
                parent,
                `
                    <span class="litigation-meta-badge">
                        <i class="fas fa-sitemap"></i>
                        Dava parent işlemi
                    </span>
                `
            )}

            ${renderDocumentList(docs)}
        </div>
    `;
}

function renderStageChild(
    suit,
    tx,
    txDocsByTransaction,
    taskDocsByTask,
    suitDocs
) {
    const flow =
        childFlowType(tx);

    // Gelen evrakta işlem belgesini; work transaction'da task belgelerini
    // öne çıkar. Aynı task belgesinin hem gelen evrakta hem iş satırında
    // iki kez görünmesini önler.
    const docs =
        collectTransactionDocuments(
            suit,
            tx,
            txDocsByTransaction,
            taskDocsByTask,
            suitDocs,
            {
                includeSuitDocs: false,
                includeTaskDocs:
                    flow.key !== 'incoming'
            }
        );

    return `
        <div class="litigation-child-row">
            <div class="litigation-child-topline">
                <div>
                    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:7px;">
                        <span class="litigation-flow-badge ${flow.key}">
                            <i class="fas ${flow.icon}"></i>
                            ${flow.label}
                        </span>

                        <span class="litigation-child-title">
                            ${escapeHtml(transactionTypeName(tx))}
                        </span>
                    </div>
                </div>

                <div class="litigation-child-date">
                    ${escapeHtml(
                        formatToTRDate(
                            tx.transaction_date ||
                            tx.created_at
                        ) || '-'
                    )}
                </div>
            </div>

            <div class="timeline-desc" style="margin-top:4px;">
                ${escapeHtml(transactionDescription(tx))}
            </div>

            <div class="d-flex justify-content-between align-items-start" style="gap:8px;flex-wrap:wrap;">
                ${renderMetaRow(
                    tx,
                    tx?.parent_id
                        ? `
                            <span class="litigation-meta-badge">
                                <i class="fas fa-level-up-alt"></i>
                                Ana aşamaya bağlı
                            </span>
                        `
                        : ''
                )}

                ${renderTaskLink(tx)}
            </div>

            ${renderDocumentList(docs)}
        </div>
    `;
}

function renderEnhancedTimeline(
    suit,
    transactions,
    transactionDocs,
    taskDocs,
    suitDocs
) {
    const container =
        document.getElementById(
            'timelineContainer'
        );

    if (!container) return;

    if (!transactions.length) {
        container.innerHTML =
            '<p class="text-muted text-center">Henüz işlem geçmişi yok.</p>';

        renderIntegrityNotice(
            suit,
            transactions
        );

        return;
    }

    const txDocsByTransaction =
        groupBy(
            transactionDocs,
            'transaction_id'
        );

    const taskDocsByTask =
        groupBy(
            taskDocs,
            'task_id'
        );

    const parents =
        transactions
            .filter(
                (tx) =>
                    String(
                        tx.transaction_hierarchy ||
                        'parent'
                    ) !== 'child'
            )
            .sort(
                (a, b) =>
                    transactionDateValue(b) -
                    transactionDateValue(a)
            );

    const parentIds =
        new Set(
            parents
                .map((tx) => String(tx.id))
        );

    const childrenByParent =
        new Map();

    const orphans = [];

    for (const tx of transactions) {
        if (
            String(
                tx.transaction_hierarchy ||
                'parent'
            ) !== 'child'
        ) {
            continue;
        }

        const parentId =
            tx.parent_id
                ? String(tx.parent_id)
                : '';

        if (
            parentId &&
            parentIds.has(parentId)
        ) {
            if (
                !childrenByParent.has(
                    parentId
                )
            ) {
                childrenByParent.set(
                    parentId,
                    []
                );
            }

            childrenByParent
                .get(parentId)
                .push(tx);

        } else {
            orphans.push(tx);
        }
    }

    for (
        const list of
        childrenByParent.values()
    ) {
        list.sort(
            (a, b) =>
                transactionDateValue(b) -
                transactionDateValue(a)
        );
    }

    orphans.sort(
        (a, b) =>
            transactionDateValue(b) -
            transactionDateValue(a)
    );

    const suitTitle =
        suit?.file_no ||
        suit?.title ||
        'Dava Dosyası';

    const rootMeta = [
        suit?.court_name || null,
        suit?.client_role
            ? `Müvekkil: ${formatRole(suit.client_role)}`
            : null
    ]
        .filter(Boolean)
        .join(' · ');

    const rootHtml = `
        <div class="litigation-case-root">
            <div class="litigation-case-root-label">
                <i class="fas fa-gavel"></i>
                DAVA DOSYASI
            </div>

            <div class="litigation-case-root-title">
                ${escapeHtml(suitTitle)}
            </div>

            ${
                rootMeta
                    ? `
                        <div class="litigation-case-root-meta">
                            ${escapeHtml(rootMeta)}
                        </div>
                    `
                    : ''
            }
        </div>
    `;

    const stagesHtml =
        parents.map((parent) => {
            const children =
                childrenByParent.get(
                    String(parent.id)
                ) || [];

            return `
                <section class="litigation-stage-group">
                    ${renderStageParent(
                        suit,
                        parent,
                        txDocsByTransaction,
                        taskDocsByTask,
                        suitDocs
                    )}

                    ${
                        children.length
                            ? `
                                <div class="litigation-stage-children">
                                    ${children.map(
                                        (child) =>
                                            renderStageChild(
                                                suit,
                                                child,
                                                txDocsByTransaction,
                                                taskDocsByTask,
                                                suitDocs
                                            )
                                    ).join('')}
                                </div>
                            `
                            : `
                                <div class="litigation-empty-stage">
                                    Bu ana aşamaya bağlı alt işlem bulunmuyor.
                                </div>
                            `
                    }
                </section>
            `;
        }).join('');

    const orphanHtml =
        orphans.length
            ? `
                <section class="litigation-orphan-group">
                    <div class="litigation-orphan-title">
                        <i class="fas fa-exclamation-triangle mr-1"></i>
                        Ana aşamaya bağlanmamış işlemler
                    </div>

                    <div class="litigation-stage-children">
                        ${orphans.map(
                            (tx) =>
                                renderStageChild(
                                    suit,
                                    tx,
                                    txDocsByTransaction,
                                    taskDocsByTask,
                                    suitDocs
                                )
                        ).join('')}
                    </div>
                </section>
            `
            : '';

    container.innerHTML = `
        <div class="litigation-case-tree">
            ${rootHtml}
            ${stagesHtml}
            ${orphanHtml}
        </div>
    `;

    renderIntegrityNotice(
        suit,
        transactions
    );

    const title = container
        .closest('.section-card')
        ?.querySelector('.section-title');

    if (title) {
        title.innerHTML = `
            <i class="fas fa-sitemap mr-2"></i>
            Dava İşlem Ağacı & Belgeler
            <span class="badge badge-light border ml-2">${transactions.length}</span>
        `;
    }
}

async function loadStage2Data() {
    const { data: suit, error: suitError } = await supabase
        .from('suits')
        .select('*')
        .eq('id', String(suitId))
        .single();

    if (suitError || !suit) {
        throw suitError || new Error('Dava bulunamadı.');
    }

    const [
        partiesResult,
        transactionsResult,
        suitDocsResult
    ] = await Promise.all([
        supabase
            .from('suit_parties')
            .select(`
                id,
                suit_id,
                role,
                person_id,
                free_text_name,
                created_at,
                persons (name)
            `)
            .eq('suit_id', String(suitId))
            .order('created_at', { ascending: true }),

        supabase
            .from('transactions')
            .select(`
                id,
                ip_record_id,
                transaction_type_id,
                transaction_hierarchy,
                parent_id,
                description,
                note,
                transaction_date,
                created_at,
                task_id,
                user_name,
                user_email,
                transaction_types (name, alias)
            `)
            .eq('ip_record_id', String(suitId))
            .order('transaction_date', { ascending: false }),

        supabase
            .from('suit_documents')
            .select('*')
            .eq('suit_id', String(suitId))
            .order('uploaded_at', { ascending: false })
    ]);

    if (partiesResult.error) {
        console.warn('[LITIGATION AŞAMA 2] Taraflar okunamadı:', partiesResult.error);
    }

    if (transactionsResult.error) {
        throw transactionsResult.error;
    }

    if (suitDocsResult.error) {
        console.warn('[LITIGATION AŞAMA 2] Dava ana belgeleri okunamadı:', suitDocsResult.error);
    }

    const parties = partiesResult.data || [];
    const transactions = transactionsResult.data || [];
    const suitDocs = suitDocsResult.data || [];

    const transactionIds = transactions
        .map((tx) => tx.id)
        .filter(Boolean)
        .map(String);

    const taskIds = [
        ...new Set(
            transactions
                .map((tx) => tx.task_id)
                .filter((id) => id && id !== 'manual_entry')
                .map(String)
        )
    ];

    let transactionDocs = [];
    let taskDocs = [];

    if (transactionIds.length) {
        const { data, error } = await supabase
            .from('transaction_documents')
            .select('*')
            .in('transaction_id', transactionIds);

        if (error) {
            console.warn(
                '[LITIGATION AŞAMA 2] Transaction belgeleri okunamadı:',
                error
            );
        } else {
            transactionDocs = data || [];
        }
    }

    if (taskIds.length) {
        const { data, error } = await supabase
            .from('task_documents')
            .select('*')
            .in('task_id', taskIds);

        if (error) {
            console.warn(
                '[LITIGATION AŞAMA 2] Task belgeleri okunamadı:',
                error
            );
        } else {
            taskDocs = data || [];
        }
    }

    return {
        suit,
        parties,
        transactions,
        suitDocs,
        transactionDocs,
        taskDocs
    };
}

async function init() {
    if (!suitId) return;

    addStyles();
    await waitForBaseTimeline();

    try {
        const data = await loadStage2Data();

        renderHeaderLinks(data.suit);
        renderPartySummary(data.suit, data.parties);
        await renderSubjectAssetLink(data.suit);

        renderEnhancedTimeline(
            data.suit,
            data.transactions,
            data.transactionDocs,
            data.taskDocs,
            data.suitDocs
        );

    } catch (error) {
        console.error('[LITIGATION AŞAMA 2] Enhancement hatası:', error);

        // Mevcut sayfanın eski timeline'ı zaten çalışmış olabilir.
        // Bu modül fail-open davranır; sayfayı bozmaz.
    }
}

init();
