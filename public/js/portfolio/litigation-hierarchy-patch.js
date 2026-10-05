// public/js/portfolio/litigation-hierarchy-patch.js
// IPGate Dava Yönetimi - AŞAMA 8B
//
// Amaç:
// - Portföy > Davalar ekranında gerçek transaction zincirinden yargılama aşamasını göstermek.
// - Aktif aşamayı parent, önceki aşamaları nested child olarak göstermek.
// - Her aşamanın kendi gelen evrak / iş işlemlerini kendi altında göstermek.
//
// DB yapısı (AŞAMA 8A):
// İlk Derece parent (49/54/55/56/57/58)
//   └─ 59 İstinaf parent
//        └─ 60 Yargıtay parent
//
// Ekran yapısı ters yönde, aktif aşama üstte:
// YARGITAY
//   └─ İSTİNAF
//        └─ İLK DERECE
//
// suits.status yalnız "Durum" rozetidir.
// Yargılama aşaması transaction ağacından hesaplanır.

import { PortfolioDataManager } from './PortfolioDataManager.js';
import { PortfolioRenderer } from './PortfolioRenderer.js';
import { supabase } from '../../supabase-config.js';
import { STATUSES, formatToTRDate } from '../../utils.js';

const FIRST_INSTANCE_PARENT_TYPES = new Set([
    '49',
    '54',
    '55',
    '56',
    '57',
    '58'
]);

const APPEAL_TYPE = '59';
const CASSATION_TYPE = '60';

const INCOMING_TYPES = new Set([
    '70', '71', '72', '73', '74',
    '75', '76', '77', '78'
]);

const WORK_TYPES = new Set([
    '61', '62', '63', '64', '65'
]);

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function stageRank(typeId) {
    const value = String(typeId || '');

    if (value === CASSATION_TYPE) return 3;
    if (value === APPEAL_TYPE) return 2;
    if (FIRST_INSTANCE_PARENT_TYPES.has(value)) return 1;

    return 0;
}

function stageKey(typeId) {
    const rank = stageRank(typeId);

    if (rank === 3) return 'cassation';
    if (rank === 2) return 'appeal';
    if (rank === 1) return 'first_instance';

    return 'unknown';
}

function stageLabel(typeId) {
    const key = stageKey(typeId);

    if (key === 'cassation') return 'Yargıtay';
    if (key === 'appeal') return 'İstinaf';
    if (key === 'first_instance') return 'İlk Derece';

    return 'Aşama Tanımsız';
}

function stageBadgeClass(typeId) {
    const key = stageKey(typeId);

    if (key === 'cassation') return 'lit-stage-cassation';
    if (key === 'appeal') return 'lit-stage-appeal';
    if (key === 'first_instance') return 'lit-stage-first';

    return 'lit-stage-unknown';
}

function isParentTransaction(tx) {
    return String(
        tx?.transaction_hierarchy ||
        'parent'
    ).toLowerCase() === 'parent';
}

function isStageTransaction(tx) {
    return (
        isParentTransaction(tx) &&
        stageRank(
            tx?.transaction_type_id
        ) > 0
    );
}

function txDateValue(tx) {
    const raw =
        tx?.transaction_date ||
        tx?.created_at ||
        null;

    if (!raw) return 0;

    const time = new Date(raw).getTime();
    return Number.isFinite(time) ? time : 0;
}

function typeInfo(manager, typeId) {
    return manager
        ?.transactionTypesMap
        ?.get(
            String(typeId || '')
        ) || null;
}

function txLabel(manager, tx) {
    const info =
        typeInfo(
            manager,
            tx?.transaction_type_id
        );

    return (
        info?.alias ||
        info?.name ||
        tx?.description ||
        `İşlem ${tx?.transaction_type_id || '-'}`
    );
}

function normalizeDocuments(tx) {
    const seen = new Set();
    const docs = [];

    for (
        const doc of
        (tx?.transaction_documents || [])
    ) {
        const url =
            doc?.document_url ||
            doc?.url ||
            null;

        if (!url || seen.has(url)) {
            continue;
        }

        seen.add(url);

        docs.push({
            name:
                doc.document_name ||
                doc.document_designation ||
                'Belge',

            url,

            type:
                doc.document_type ||
                'document'
        });
    }

    return docs;
}

function eventCategory(typeId) {
    const id =
        String(typeId || '');

    if (INCOMING_TYPES.has(id)) {
        return {
            key: 'incoming',
            label: 'GELEN EVRAK',
            icon: 'fa-file-import'
        };
    }

    if (WORK_TYPES.has(id)) {
        return {
            key: 'work',
            label: 'İŞ / ÇIKTI',
            icon: 'fa-briefcase'
        };
    }

    return {
        key: 'transaction',
        label: 'İŞLEM',
        icon: 'fa-stream'
    };
}

function normalizedTransaction(
    manager,
    tx
) {
    return {
        ...tx,

        _typeName:
            txLabel(
                manager,
                tx
            ),

        _documents:
            normalizeDocuments(
                tx
            ),

        _eventCategory:
            eventCategory(
                tx?.transaction_type_id
            )
    };
}

function findActiveStage(stages) {
    if (!stages.length) {
        return null;
    }

    return [...stages]
        .sort(
            (a, b) => {
                const rankDiff =
                    stageRank(
                        b.transaction_type_id
                    ) -
                    stageRank(
                        a.transaction_type_id
                    );

                if (rankDiff !== 0) {
                    return rankDiff;
                }

                return (
                    txDateValue(b) -
                    txDateValue(a)
                );
            }
        )[0];
}

function buildHierarchy(
    manager,
    transactions
) {
    const txs =
        (transactions || [])
            .map(
                (tx) =>
                    normalizedTransaction(
                        manager,
                        tx
                    )
            );

    const byId =
        new Map(
            txs.map(
                (tx) => [
                    String(tx.id),
                    tx
                ]
            )
        );

    const stages =
        txs.filter(
            isStageTransaction
        );

    const active =
        findActiveStage(
            stages
        );

    if (!active) {
        return {
            activeStageKey:
                'unknown',

            activeStageLabel:
                'Aşama Tanımsız',

            activeStageRank:
                0,

            root:
                null,

            otherTransactions:
                [...txs]
                    .sort(
                        (a, b) =>
                            txDateValue(a) -
                            txDateValue(b)
                    ),

            transactionCount:
                txs.length,

            searchText:
                txs
                    .map(
                        (tx) =>
                            `${tx._typeName} ${tx.description || ''}`
                    )
                    .join(' ')
                    .toLowerCase()
        };
    }

    // DB yönü:
    // İlk Derece -> İstinaf -> Yargıtay
    //
    // Ekran yönü için active'den parent_id ile geriye doğru zinciri buluyoruz:
    // Yargıtay -> İstinaf -> İlk Derece
    const chain = [];
    const visited =
        new Set();

    let current =
        active;

    while (
        current &&
        !visited.has(
            String(current.id)
        )
    ) {
        chain.push(
            current
        );

        visited.add(
            String(current.id)
        );

        const parentId =
            current.parent_id
                ? String(
                    current.parent_id
                )
                : null;

        if (!parentId) {
            break;
        }

        const parent =
            byId.get(
                parentId
            );

        if (
            !parent ||
            !isStageTransaction(
                parent
            )
        ) {
            break;
        }

        current =
            parent;
    }

    const represented =
        new Set(
            chain.map(
                (stage) =>
                    String(stage.id)
            )
        );

    const makeStageNode =
        (index) => {
            if (
                index >=
                chain.length
            ) {
                return null;
            }

            const stage =
                chain[index];

            const directEvents =
                txs
                    .filter(
                        (tx) =>
                            String(
                                tx.parent_id ||
                                ''
                            ) ===
                                String(
                                    stage.id
                                ) &&
                            !isStageTransaction(
                                tx
                            )
                    )
                    .sort(
                        (a, b) =>
                            txDateValue(a) -
                            txDateValue(b)
                    );

            directEvents
                .forEach(
                    (tx) =>
                        represented.add(
                            String(tx.id)
                        )
                );

            return {
                nodeId:
                    `stage:${stage.id}`,

                transaction:
                    stage,

                stageKey:
                    stageKey(
                        stage.transaction_type_id
                    ),

                stageLabel:
                    stageLabel(
                        stage.transaction_type_id
                    ),

                stageRank:
                    stageRank(
                        stage.transaction_type_id
                    ),

                typeName:
                    stage._typeName,

                events:
                    directEvents,

                previous:
                    makeStageNode(
                        index + 1
                    )
            };
        };

    const root =
        makeStageNode(0);

    const others =
        txs
            .filter(
                (tx) =>
                    !represented.has(
                        String(tx.id)
                    )
            )
            .sort(
                (a, b) =>
                    txDateValue(a) -
                    txDateValue(b)
            );

    return {
        activeStageKey:
            stageKey(
                active.transaction_type_id
            ),

        activeStageLabel:
            stageLabel(
                active.transaction_type_id
            ),

        activeStageRank:
            stageRank(
                active.transaction_type_id
            ),

        root,

        otherTransactions:
            others,

        transactionCount:
            txs.length,

        searchText:
            [
                ...txs.map(
                    (tx) =>
                        `${tx._typeName} ${tx.description || ''}`
                ),

                stageLabel(
                    active.transaction_type_id
                )
            ]
                .join(' ')
                .toLowerCase()
    };
}

async function loadSuitTransactions(
    suitIds
) {
    if (!suitIds.length) {
        return [];
    }

    const uniqueIds =
        [
            ...new Set(
                suitIds.map(
                    String
                )
            )
        ];

    const CHUNK_SIZE =
        100;

    const chunks = [];

    for (
        let i = 0;
        i < uniqueIds.length;
        i += CHUNK_SIZE
    ) {
        chunks.push(
            uniqueIds.slice(
                i,
                i + CHUNK_SIZE
            )
        );
    }

    const results =
        await Promise.all(
            chunks.map(
                async (ids) => {
                    const {
                        data,
                        error
                    } =
                        await supabase
                            .from(
                                'transactions'
                            )
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
                                transaction_documents (
                                    id,
                                    document_name,
                                    document_url,
                                    document_type,
                                    document_designation,
                                    uploaded_at
                                )
                            `)
                            .in(
                                'ip_record_id',
                                ids
                            )
                            .limit(
                                10000
                            );

                    if (error) {
                        throw error;
                    }

                    return (
                        data || []
                    );
                }
            )
        );

    return results.flat();
}

function ensureStyles() {
    if (
        document.getElementById(
            'litigationPortfolioHierarchyStyles'
        )
    ) {
        return;
    }

    const style =
        document.createElement(
            'style'
        );

    style.id =
        'litigationPortfolioHierarchyStyles';

    style.textContent = `
        .litigation-suit-row {
            cursor: pointer;
        }

        .litigation-suit-row:hover td {
            background: #fffaf5 !important;
        }

        .litigation-root-caret,
        .litigation-node-caret {
            display: inline-block;
            width: 16px;
            text-align: center;
            margin-right: 6px;
            color: #9a3412;
            transition: transform .15s ease;
        }

        .litigation-stage-badge {
            display: inline-flex;
            align-items: center;
            border-radius: 999px;
            padding: 2px 8px;
            margin-top: 5px;
            font-size: .67rem;
            line-height: 1.3;
            font-weight: 800;
            letter-spacing: .02em;
            border: 1px solid currentColor;
        }

        .lit-stage-first {
            color: #475569;
            background: #f8fafc;
        }

        .lit-stage-appeal {
            color: #1d4ed8;
            background: #eff6ff;
        }

        .lit-stage-cassation {
            color: #7e22ce;
            background: #faf5ff;
        }

        .lit-stage-unknown {
            color: #6b7280;
            background: #f9fafb;
        }

        .litigation-hierarchy-detail-row > td {
            padding: 0 !important;
            border-bottom: 1px solid #edf0f4 !important;
            white-space: normal !important;
            overflow: visible !important;
            text-overflow: clip !important;
        }

        .litigation-stage-card {
            display: flex;
            align-items: center;
            gap: 10px;
            min-height: 46px;
            padding: 9px 14px;
            background: #f8fafc;
            border-left: 4px solid #64748b;
        }

        .litigation-stage-card.stage-appeal {
            background: #f4f8ff;
            border-left-color: #2563eb;
        }

        .litigation-stage-card.stage-cassation {
            background: #fbf7ff;
            border-left-color: #9333ea;
        }

        .litigation-stage-card.stage-first_instance {
            background: #f8fafc;
            border-left-color: #64748b;
        }

        .litigation-stage-title {
            font-size: .83rem;
            font-weight: 800;
            color: #263449;
        }

        .litigation-stage-meta {
            margin-top: 2px;
            font-size: .72rem;
            color: #667085;
        }

        .litigation-active-chip {
            display: inline-flex;
            align-items: center;
            margin-left: 7px;
            padding: 1px 7px;
            border-radius: 999px;
            background: #ecfdf3;
            border: 1px solid #86efac;
            color: #166534;
            font-size: .62rem;
            font-weight: 800;
        }

        .litigation-event-card {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            min-height: 42px;
            padding: 8px 14px;
            background: #fff;
            border-left: 3px solid #e2e8f0;
        }

        .litigation-event-main {
            min-width: 0;
            flex: 1;
        }

        .litigation-event-title {
            font-size: .79rem;
            color: #334155;
            font-weight: 700;
        }

        .litigation-event-meta {
            margin-top: 2px;
            font-size: .69rem;
            color: #7c8798;
        }

        .litigation-event-chip {
            display: inline-flex;
            align-items: center;
            padding: 1px 6px;
            margin-right: 6px;
            border-radius: 999px;
            font-size: .59rem;
            font-weight: 800;
            border: 1px solid #cbd5e1;
            color: #475569;
            background: #f8fafc;
        }

        .litigation-event-chip.incoming {
            color: #075985;
            border-color: #7dd3fc;
            background: #f0f9ff;
        }

        .litigation-event-chip.work {
            color: #9a3412;
            border-color: #fdba74;
            background: #fff7ed;
        }

        .litigation-event-actions {
            flex: 0 0 auto;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .litigation-event-actions a {
            text-decoration: none !important;
        }

        .litigation-other-card {
            background: #fffdf5;
            border-left: 4px solid #eab308;
        }

        .litigation-empty-hierarchy {
            padding: 12px 16px;
            color: #7c8798;
            font-size: .76rem;
            background: #fafafa;
            border-left: 4px solid #d1d5db;
        }
    `;

    document.head
        .appendChild(
            style
        );
}

function formatDateSafe(value) {
    if (!value) {
        return '-';
    }

    try {
        return (
            formatToTRDate(value) ||
            '-'
        );
    } catch {
        return '-';
    }
}

function buildDocumentLinks(
    documents
) {
    const docs =
        documents || [];

    if (!docs.length) {
        return '';
    }

    return docs
        .map(
            (doc) => `
                <a
                    href="${esc(doc.url)}"
                    target="_blank"
                    rel="noopener"
                    title="${esc(doc.name)}"
                    class="text-danger"
                >
                    <i class="fas fa-file-pdf"></i>
                </a>
            `
        )
        .join('');
}

function createStageRow(
    node,
    parentNodeId,
    depth,
    isActive
) {
    const tr =
        document.createElement(
            'tr'
        );

    tr.className =
        'litigation-hierarchy-detail-row litigation-hierarchy-toggle';

    tr.style.display =
        'none';

    tr.dataset.litigationNodeId =
        node.nodeId;

    tr.dataset.litigationParentNodeId =
        parentNodeId;

    tr.setAttribute(
        'aria-expanded',
        'false'
    );

    const hasChildren =
        Boolean(
            node.previous ||
            node.events?.length
        );

    tr.dataset.litigationHasChildren =
        hasChildren
            ? 'true'
            : 'false';

    const stageDate =
        formatDateSafe(
            node.transaction
                ?.transaction_date ||
            node.transaction
                ?.created_at
        );

    const indent =
        18 +
        depth * 28;

    tr.innerHTML = `
        <td colspan="10">
            <div
                class="litigation-stage-card stage-${esc(node.stageKey)}"
                style="padding-left:${indent}px;"
            >
                <span class="litigation-node-caret">
                    ${
                        hasChildren
                            ? '<i class="fas fa-chevron-right"></i>'
                            : '<i class="fas fa-circle" style="font-size:6px;opacity:.45;"></i>'
                    }
                </span>

                <div class="flex-grow-1">
                    <div class="litigation-stage-title">
                        ${esc(node.stageLabel)}
                        ${
                            isActive
                                ? '<span class="litigation-active-chip">AKTİF AŞAMA</span>'
                                : ''
                        }
                    </div>

                    <div class="litigation-stage-meta">
                        ${esc(node.typeName)}
                        · ${esc(stageDate)}
                    </div>
                </div>
            </div>
        </td>
    `;

    return tr;
}

function createEventRow(
    tx,
    parentNodeId,
    depth
) {
    const tr =
        document.createElement(
            'tr'
        );

    tr.className =
        'litigation-hierarchy-detail-row litigation-event-row';

    tr.style.display =
        'none';

    tr.dataset.litigationParentNodeId =
        parentNodeId;

    const category =
        tx._eventCategory ||
        eventCategory(
            tx.transaction_type_id
        );

    const date =
        formatDateSafe(
            tx.transaction_date ||
            tx.created_at
        );

    const docs =
        buildDocumentLinks(
            tx._documents
        );

    const taskLink =
        tx.task_id
            ? `
                <a
                    href="task-update.html?id=${encodeURIComponent(String(tx.task_id))}"
                    target="_blank"
                    rel="noopener"
                    title="İşi Aç"
                    class="text-primary"
                >
                    <i class="fas fa-tasks"></i>
                </a>
            `
            : '';

    const indent =
        48 +
        depth * 28;

    tr.innerHTML = `
        <td colspan="10">
            <div
                class="litigation-event-card"
                style="padding-left:${indent}px;"
            >
                <div class="litigation-event-main">
                    <div class="litigation-event-title">
                        <span
                            class="litigation-event-chip ${esc(category.key)}"
                        >
                            <i class="fas ${esc(category.icon)} mr-1"></i>
                            ${esc(category.label)}
                        </span>

                        ${esc(tx._typeName)}
                    </div>

                    <div class="litigation-event-meta">
                        ${esc(date)}
                        ${
                            tx.description &&
                            tx.description !==
                                tx._typeName
                                ? ` · ${esc(tx.description)}`
                                : ''
                        }
                    </div>
                </div>

                <div class="litigation-event-actions">
                    ${docs}
                    ${taskLink}
                </div>
            </div>
        </td>
    `;

    return tr;
}

function appendStageTree(
    fragment,
    node,
    parentNodeId,
    depth = 0,
    isActive = false
) {
    if (!node) {
        return;
    }

    const stageRow =
        createStageRow(
            node,
            parentNodeId,
            depth,
            isActive
        );

    fragment.appendChild(
        stageRow
    );

    // Kullanıcının istediği görsel mantık:
    // aktif aşama parent, önceki derece onun child'ı.
    if (node.previous) {
        appendStageTree(
            fragment,
            node.previous,
            node.nodeId,
            depth + 1,
            false
        );
    }

    for (
        const tx of
        (node.events || [])
    ) {
        fragment.appendChild(
            createEventRow(
                tx,
                node.nodeId,
                depth + 1
            )
        );
    }
}

function appendOtherTransactions(
    fragment,
    row,
    parentNodeId,
    transactions
) {
    if (!transactions?.length) {
        return;
    }

    const nodeId =
        `other:${row.id}`;

    const tr =
        document.createElement(
            'tr'
        );

    tr.className =
        'litigation-hierarchy-detail-row litigation-hierarchy-toggle';

    tr.style.display =
        'none';

    tr.dataset.litigationNodeId =
        nodeId;

    tr.dataset.litigationParentNodeId =
        parentNodeId;

    tr.dataset.litigationHasChildren =
        'true';

    tr.setAttribute(
        'aria-expanded',
        'false'
    );

    tr.innerHTML = `
        <td colspan="10">
            <div class="litigation-stage-card litigation-other-card">
                <span class="litigation-node-caret">
                    <i class="fas fa-chevron-right"></i>
                </span>

                <div class="flex-grow-1">
                    <div class="litigation-stage-title">
                        Diğer / Zincir Dışı İşlemler
                    </div>

                    <div class="litigation-stage-meta">
                        ${transactions.length} işlem
                    </div>
                </div>
            </div>
        </td>
    `;

    fragment.appendChild(
        tr
    );

    for (
        const tx of
        transactions
    ) {
        fragment.appendChild(
            createEventRow(
                tx,
                nodeId,
                1
            )
        );
    }
}

function directChildren(
    tbody,
    nodeId
) {
    return [
        ...tbody.querySelectorAll(
            'tr[data-litigation-parent-node-id]'
        )
    ].filter(
        (row) =>
            row.dataset
                .litigationParentNodeId ===
            nodeId
    );
}

function collapseNode(
    tbody,
    row
) {
    const nodeId =
        row.dataset
            .litigationNodeId;

    if (!nodeId) {
        return;
    }

    row.setAttribute(
        'aria-expanded',
        'false'
    );

    const icon =
        row.querySelector(
            '.litigation-root-caret i, .litigation-node-caret i'
        );

    if (icon) {
        icon.className =
            'fas fa-chevron-right';
    }

    const children =
        directChildren(
            tbody,
            nodeId
        );

    for (
        const child of
        children
    ) {
        child.style.display =
            'none';

        if (
            child.dataset
                .litigationNodeId
        ) {
            collapseNode(
                tbody,
                child
            );
        }
    }
}

function toggleNode(row) {
    const tbody =
        row.closest(
            'tbody'
        );

    const nodeId =
        row.dataset
            .litigationNodeId;

    if (
        !tbody ||
        !nodeId ||
        row.dataset
            .litigationHasChildren !==
            'true'
    ) {
        return;
    }

    const expanded =
        row.getAttribute(
            'aria-expanded'
        ) === 'true';

    if (expanded) {
        collapseNode(
            tbody,
            row
        );

        return;
    }

    row.setAttribute(
        'aria-expanded',
        'true'
    );

    const icon =
        row.querySelector(
            '.litigation-root-caret i, .litigation-node-caret i'
        );

    if (icon) {
        icon.className =
            'fas fa-chevron-down';
    }

    const children =
        directChildren(
            tbody,
            nodeId
        );

    for (
        const child of
        children
    ) {
        child.style.display =
            'table-row';
    }
}

function installAccordionHandler() {
    if (
        window
            .__ipgateLitigationHierarchyHandler
    ) {
        return;
    }

    window
        .__ipgateLitigationHierarchyHandler =
        true;

    document.addEventListener(
        'click',
        (event) => {
            const row =
                event.target
                    ?.closest(
                        'tr.litigation-hierarchy-toggle'
                    );

            if (!row) {
                return;
            }

            // Evrak / task / detay butonları normal çalışsın.
            if (
                event.target.closest(
                    'a, button, input, select, textarea, .action-btn'
                )
            ) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            toggleNode(
                row
            );
        },
        true
    );
}

if (
    !PortfolioDataManager
        .prototype
        .__litigationHierarchyStage8B
) {
    Object.defineProperty(
        PortfolioDataManager.prototype,
        '__litigationHierarchyStage8B',
        {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false
        }
    );

    const originalLoadLitigationData =
        PortfolioDataManager
            .prototype
            .loadLitigationData;

    const originalFilterRecords =
        PortfolioDataManager
            .prototype
            .filterRecords;

    PortfolioDataManager
        .prototype
        .loadLitigationData =
        async function(...args) {
            const rows =
                await originalLoadLitigationData
                    .apply(
                        this,
                        args
                    );

            const litigationRows =
                Array.isArray(rows)
                    ? rows
                    : [];

            const suitIds =
                litigationRows
                    .map(
                        (row) =>
                            row?.id
                    )
                    .filter(Boolean)
                    .map(String);

            if (
                suitIds.length === 0
            ) {
                return litigationRows;
            }

            try {
                const transactions =
                    await loadSuitTransactions(
                        suitIds
                    );

                const bySuit =
                    new Map();

                for (
                    const tx of
                    transactions
                ) {
                    const suitId =
                        String(
                            tx.ip_record_id ||
                            ''
                        );

                    if (!suitId) {
                        continue;
                    }

                    if (
                        !bySuit.has(
                            suitId
                        )
                    ) {
                        bySuit.set(
                            suitId,
                            []
                        );
                    }

                    bySuit
                        .get(
                            suitId
                        )
                        .push(
                            tx
                        );
                }

                for (
                    const row of
                    litigationRows
                ) {
                    const hierarchy =
                        buildHierarchy(
                            this,
                            bySuit.get(
                                String(row.id)
                            ) || []
                        );

                    row._litigationHierarchy =
                        hierarchy;

                    row.activeJudicialStage =
                        hierarchy
                            .activeStageKey;

                    row.activeJudicialStageText =
                        hierarchy
                            .activeStageLabel;

                    row.activeJudicialStageRank =
                        hierarchy
                            .activeStageRank;

                    const statusObj =
                        (STATUSES.litigation || [])
                            .find(
                                (item) =>
                                    String(item.value) ===
                                    String(row.status || '')
                            );

                    row.statusText =
                        statusObj?.text ||
                        row.status ||
                        '-';

                    row.litigationSearchText =
                        hierarchy
                            .searchText ||
                        '';
                }

            } catch (error) {
                console.error(
                    '[LITIGATION AŞAMA 8B] Transaction hierarchy yüklenemedi:',
                    error
                );

                // Suit listesi yine çalışmaya devam etsin.
                for (
                    const row of
                    litigationRows
                ) {
                    row._litigationHierarchy = {
                        activeStageKey:
                            'unknown',

                        activeStageLabel:
                            'Aşama Yüklenemedi',

                        activeStageRank:
                            0,

                        root:
                            null,

                        otherTransactions:
                            [],

                        transactionCount:
                            0,

                        searchText:
                            ''
                    };

                    row.activeJudicialStage =
                        'unknown';

                    row.activeJudicialStageText =
                        'Aşama Yüklenemedi';

                    row.activeJudicialStageRank =
                        0;
                }
            }

            return litigationRows;
        };

    PortfolioDataManager
        .prototype
        .filterRecords =
        function(
            typeFilter,
            searchTerm,
            columnFilters = {},
            subTab = null
        ) {
            if (
                typeFilter !==
                'litigation'
            ) {
                return originalFilterRecords
                    .call(
                        this,
                        typeFilter,
                        searchTerm,
                        columnFilters,
                        subTab
                    );
            }

            // Mevcut kolon filtreleme mantığını koru,
            // global aramayı stage/transaction içerikleriyle genişlet.
            const base =
                originalFilterRecords
                    .call(
                        this,
                        typeFilter,
                        null,
                        columnFilters,
                        subTab
                    );

            const query =
                String(
                    searchTerm ||
                    ''
                )
                    .toLocaleLowerCase(
                        'tr-TR'
                    )
                    .trim();

            if (!query) {
                return base;
            }

            return base.filter(
                (item) => {
                    const text = `
                        ${item.title || ''}
                        ${item.suitType || ''}
                        ${item.caseNo || ''}
                        ${item.court || ''}
                        ${item.client?.name || ''}
                        ${item.opposingParty || ''}
                        ${item.statusText || ''}
                        ${item.activeJudicialStageText || ''}
                        ${item.litigationSearchText || ''}
                    `
                        .toLocaleLowerCase(
                            'tr-TR'
                        );

                    return text.includes(
                        query
                    );
                }
            );
        };
}

if (
    !PortfolioRenderer
        .prototype
        .__litigationHierarchyStage8B
) {
    Object.defineProperty(
        PortfolioRenderer.prototype,
        '__litigationHierarchyStage8B',
        {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false
        }
    );

    const originalRenderLitigationRow =
        PortfolioRenderer
            .prototype
            .renderLitigationRow;

    PortfolioRenderer
        .prototype
        .renderLitigationRow =
        function(
            row,
            index
        ) {
            ensureStyles();

            const fragment =
                document.createDocumentFragment();

            const rootRow =
                originalRenderLitigationRow
                    .call(
                        this,
                        row,
                        index
                    );

            const hierarchy =
                row?._litigationHierarchy ||
                null;

            const hasHierarchy =
                Boolean(
                    hierarchy?.root ||
                    hierarchy
                        ?.otherTransactions
                        ?.length
                );

            rootRow.classList.add(
                'litigation-suit-row'
            );

            if (hasHierarchy) {
                rootRow.classList.add(
                    'litigation-hierarchy-toggle'
                );

                rootRow.dataset.litigationNodeId =
                    `suit:${row.id}`;

                rootRow.dataset.litigationHasChildren =
                    'true';

                rootRow.setAttribute(
                    'aria-expanded',
                    'false'
                );

                const firstCell =
                    rootRow.children[0];

                if (firstCell) {
                    firstCell.insertAdjacentHTML(
                        'afterbegin',
                        `
                            <span class="litigation-root-caret">
                                <i class="fas fa-chevron-right"></i>
                            </span>
                        `
                    );
                }
            }

            // Ana satırda yargılama aşamasını görünür kıl.
            const titleCell =
                rootRow.children[1];

            if (titleCell) {
                const typeForBadge =
                    hierarchy?.root
                        ?.transaction
                        ?.transaction_type_id ||
                    null;

                titleCell.insertAdjacentHTML(
                    'beforeend',
                    `
                        <br>
                        <span class="litigation-stage-badge ${stageBadgeClass(typeForBadge)}">
                            <i class="fas fa-sitemap mr-1"></i>
                            ${esc(
                                hierarchy
                                    ?.activeStageLabel ||
                                'Aşama Tanımsız'
                            )}
                        </span>
                    `
                );
            }

            fragment.appendChild(
                rootRow
            );

            const suitNodeId =
                `suit:${row.id}`;

            if (hierarchy?.root) {
                appendStageTree(
                    fragment,
                    hierarchy.root,
                    suitNodeId,
                    0,
                    true
                );
            }

            appendOtherTransactions(
                fragment,
                row,
                suitNodeId,
                hierarchy
                    ?.otherTransactions ||
                []
            );

            if (
                !hasHierarchy
            ) {
                const empty =
                    document.createElement(
                        'tr'
                    );

                empty.className =
                    'litigation-hierarchy-detail-row';

                empty.style.display =
                    'none';

                empty.dataset
                    .litigationParentNodeId =
                    suitNodeId;

                empty.innerHTML = `
                    <td colspan="10">
                        <div class="litigation-empty-hierarchy">
                            Bu dava için desteklenen yargılama aşaması transaction'ı bulunamadı.
                        </div>
                    </td>
                `;
            }

            return fragment;
        };
}

ensureStyles();
installAccordionHandler();

console.log(
    '[LITIGATION AŞAMA 8B] Portföy nested yargılama aşaması patch aktif.'
);
