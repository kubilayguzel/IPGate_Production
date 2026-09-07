import {
    supabase
} from '../../supabase-config.js';


const TASK_TYPE_OPPOSITION =
    '20';

const scannedTaskTypes =
    new Map();

let scanTimer =
    null;


function taskIdFromRow(row) {
    return (
        row
            .querySelector(
                '.task-checkbox'
            )
            ?.value ||
        row
            .querySelector(
                '[data-id]'
            )
            ?.dataset
            ?.id ||
        ''
    );
}


function actionStripFromRow(row) {
    return (
        row.querySelector(
            '.dropdown-menu .d-flex'
        ) ||
        row.querySelector(
            '.dropdown-menu'
        )
    );
}


function openWorkspace(taskId) {
    const url =
        `opposition-workspace.html?id=${encodeURIComponent(taskId)}#case`;

    window.open(
        url,
        '_blank',
        'noopener'
    );
}


function ensureButton(
    row,
    taskId
) {
    if (
        row.querySelector(
            '.opposition-workspace-launch-btn'
        )
    ) {
        return;
    }

    const actionStrip =
        actionStripFromRow(
            row
        );

    if (!actionStrip) {
        return;
    }

    const button =
        document.createElement(
            'button'
        );

    button.type =
        'button';

    button.className =
        [
            'btn',
            'btn-sm',
            'btn-light',
            'text-success',
            'opposition-workspace-launch-btn'
        ].join(' ');

    button.dataset.id =
        taskId;

    button.title =
        'Yayıma İtiraz Çalışma Alanını Aç';

    button.setAttribute(
        'aria-label',
        'Yayıma İtiraz Çalışma Alanını Aç'
    );

    button.innerHTML = `
        <i
            class="fas fa-balance-scale"
            style="pointer-events:none;"
        ></i>
    `;

    button.addEventListener(
        'click',
        event => {
            event.preventDefault();
            event.stopPropagation();

            openWorkspace(
                taskId
            );
        }
    );

    /*
     * İlk ikon olarak ekliyoruz.
     * Kullanıcı yayıma itiraz işinde hukuki çalışma alanına
     * en kısa yoldan ulaşsın.
     */
    actionStrip.prepend(
        button
    );
}


function applyCachedButtons() {
    document
        .querySelectorAll(
            '#myTasksTableBody tr'
        )
        .forEach(
            row => {
                const taskId =
                    taskIdFromRow(
                        row
                    );

                if (!taskId) {
                    return;
                }

                if (
                    scannedTaskTypes.get(
                        taskId
                    ) ===
                    TASK_TYPE_OPPOSITION
                ) {
                    ensureButton(
                        row,
                        taskId
                    );
                }
            }
        );
}


async function scanVisibleRows() {
    const rows =
        [
            ...document.querySelectorAll(
                '#myTasksTableBody tr'
            )
        ];

    if (!rows.length) {
        return;
    }

    const unresolvedIds =
        [
            ...new Set(
                rows
                    .map(
                        row =>
                            taskIdFromRow(
                                row
                            )
                    )
                    .filter(
                        taskId =>
                            taskId &&
                            !scannedTaskTypes.has(
                                taskId
                            )
                    )
            )
        ];

    if (
        unresolvedIds.length
    ) {
        try {
            const {
                data,
                error
            } =
                await supabase
                    .from(
                        'tasks'
                    )
                    .select(
                        'id, task_type_id'
                    )
                    .in(
                        'id',
                        unresolvedIds
                    );

            if (error) {
                throw error;
            }

            const returned =
                new Set();

            for (
                const task
                of data ||
                []
            ) {
                const id =
                    String(
                        task.id
                    );

                returned.add(
                    id
                );

                scannedTaskTypes.set(
                    id,
                    String(
                        task.task_type_id ??
                        ''
                    )
                );
            }

            /*
             * RLS nedeniyle görünmeyen / silinmiş bir ID varsa
             * tekrar tekrar sorgulanmasın.
             */
            unresolvedIds
                .filter(
                    id =>
                        !returned.has(
                            String(id)
                        )
                )
                .forEach(
                    id =>
                        scannedTaskTypes.set(
                            String(id),
                            ''
                        )
                );
        } catch (error) {
            console.warn(
                'Yayıma itiraz workspace ikon kontrolü yapılamadı:',
                error
            );

            return;
        }
    }

    applyCachedButtons();
}


function scheduleScan() {
    window.clearTimeout(
        scanTimer
    );

    scanTimer =
        window.setTimeout(
            () =>
                scanVisibleRows(),
            60
        );
}


function initLauncher() {
    const tbody =
        document.getElementById(
            'myTasksTableBody'
        );

    if (!tbody) {
        return;
    }

    const observer =
        new MutationObserver(
            () =>
                scheduleScan()
        );

    observer.observe(
        tbody,
        {
            childList:
                true,
            subtree:
                true
        }
    );

    scheduleScan();
}


if (
    document.readyState ===
    'loading'
) {
    document.addEventListener(
        'DOMContentLoaded',
        initLauncher
    );
} else {
    initLauncher();
}
