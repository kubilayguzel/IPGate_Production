// public/js/indexing/litigation-task-trigger.js
// IPGate Dava Yönetimi - AŞAMA 5S
//
// AŞAMA 4'ün güvenli dava write branch'inin ÜZERİNE eklenir.
// Marka / Patent / Tasarım indeksleme akışına dokunmaz.
//
// Amaç:
// 1) Dava task tetiklerini transaction_types.task_triggered_rules üzerinden okumak.
// 2) Müvekkili suits.client_id üzerinden task_owner_id olarak bağlamak.
// 3) Süreyi transaction_types.due_period + due_period_unit üzerinden hesaplamak.
// 4) Aynı source transaction için duplicate task oluşmasını önlemek.
// 5) Tetiklenen task'a karşılık work transaction oluşturmak.
// 6) 76 Karar / 78 Kesinleşme Şerhi için deterministic suit.status güncellemek.
//
// Mail hala kapalıdır:
// incoming_documents.status: litigation_indexed -> task/status automation -> litigation_mail_ready.

import './litigation-indexing-write.js';

import {
    DocumentReviewManager
} from './document-review-manager.js';

import {
    supabase,
    taskService
} from '../../supabase-config.js';

import {
    showNotification,
    formatToTRDate,
    addMonthsToDate,
    findNextWorkingDay,
    isWeekend,
    isHoliday,
    TURKEY_HOLIDAYS
} from '../../utils.js';

const proto = DocumentReviewManager.prototype;


const SUIT_STATUS_BY_INCOMING_TYPE = Object.freeze({
    '76': 'decision',
    '78': 'finalized'
});

function normRole(value) {
    return String(value || '')
        .toLocaleLowerCase('tr-TR')
        .trim();
}

function normalizeDateInput(raw) {
    if (!raw) return null;

    if (raw instanceof Date) {
        return Number.isNaN(raw.getTime())
            ? null
            : new Date(raw);
    }

    const s = String(raw).trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return new Date(`${s}T12:00:00`);
    }

    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    const parts = s.split(/[./]/);

    if (parts.length === 3 && parts[2]?.length === 4) {
        const [day, month, year] = parts;

        const d = new Date(
            Number(year),
            Number(month) - 1,
            Number(day),
            12,
            0,
            0,
            0
        );

        return Number.isNaN(d.getTime()) ? null : d;
    }

    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

function setSafeNoon(date) {
    const d = new Date(date);
    d.setHours(12, 0, 0, 0);
    return d;
}

function calculateOfficialDeadlineFromType(
    manager,
    transactionTypeId,
    deliveryDate
) {
    const delivery = normalizeDateInput(deliveryDate);
    if (!delivery) {
        return {
            date: null,
            error: 'invalid_delivery_date'
        };
    }

    const typeObj = txTypeObject(
        manager,
        transactionTypeId
    );

    const period = Number(
        typeObj?.due_period ??
        typeObj?.duePeriod ??
        0
    );

    const unit = String(
        typeObj?.due_period_unit ??
        typeObj?.duePeriodUnit ??
        ''
    )
        .toLowerCase()
        .trim();

    if (!Number.isFinite(period) || period <= 0) {
        return {
            date: null,
            error: 'missing_due_period',
            period,
            unit
        };
    }

    if (!unit) {
        return {
            date: null,
            error: 'missing_due_period_unit',
            period,
            unit
        };
    }

    let rawDue = new Date(delivery);

    if (unit === 'day' || unit === 'days') {
        rawDue.setDate(
            rawDue.getDate() + period
        );

    } else if (
        unit === 'week' ||
        unit === 'weeks'
    ) {
        rawDue.setDate(
            rawDue.getDate() +
            (period * 7)
        );

    } else if (
        unit === 'month' ||
        unit === 'months'
    ) {
        rawDue = addMonthsToDate(
            rawDue,
            period
        );

    } else {
        return {
            date: null,
            error: 'unsupported_due_period_unit',
            period,
            unit
        };
    }

    const adjusted = findNextWorkingDay(
        rawDue,
        TURKEY_HOLIDAYS
    );

    return {
        date: setSafeNoon(adjusted),
        error: null,
        period,
        unit
    };
}

function calculateOperationalDeadline(officialDueDate) {
    if (!officialDueDate) return null;

    // Mevcut IPGate indeksleme yaklaşımıyla uyumlu:
    // resmî tarihten 3 takvim günü önce; tatil/hafta sonu ise geriye
    // doğru ilk çalışma günü.
    const operational = new Date(officialDueDate);
    operational.setDate(operational.getDate() - 3);

    while (
        isWeekend(operational) ||
        isHoliday(operational, TURKEY_HOLIDAYS)
    ) {
        operational.setDate(
            operational.getDate() - 1
        );
    }

    return setSafeNoon(operational);
}

function txTypeObject(manager, id) {
    return (manager.allTransactionTypes || [])
        .find(
            (type) =>
                String(type.id) === String(id)
        ) || null;
}

function txTypeName(manager, id) {
    const obj = txTypeObject(manager, id);

    return (
        obj?.alias ||
        obj?.name ||
        `İşlem ${id}`
    );
}

function parseTriggerRules(raw) {
    if (!raw) return [];

    if (Array.isArray(raw)) {
        return raw;
    }

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed)
                ? parsed
                : (parsed ? [parsed] : []);
        } catch {
            return [];
        }
    }

    if (typeof raw === 'object') {
        return [raw];
    }

    return [];
}

function normalizeStringArray(raw) {
    if (!raw) return [];

    if (Array.isArray(raw)) {
        return raw
            .map((item) => String(item))
            .filter(Boolean);
    }

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);

            if (Array.isArray(parsed)) {
                return parsed
                    .map((item) => String(item))
                    .filter(Boolean);
            }
        } catch {
            return raw
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
        }
    }

    return [];
}

function resolveAutomationRule(
    manager,
    {
        incomingTypeId,
        clientRole,
        parentTypeId
    }
) {
    const incoming = String(
        incomingTypeId || ''
    );

    const parent = String(
        parentTypeId || ''
    );

    const role = normRole(clientRole);

    const sourceType =
        txTypeObject(
            manager,
            incoming
        );

    if (!sourceType) {
        return null;
    }

    const rules =
        parseTriggerRules(
            sourceType.task_triggered_rules ??
            sourceType.taskTriggeredRules
        )
        .filter(
            (rule) =>
                rule &&
                rule.enabled !== false
        )
        .sort(
            (a, b) =>
                Number(a.priority ?? 100) -
                Number(b.priority ?? 100)
        );

    for (const rule of rules) {
        const requiredRole =
            normRole(
                rule.client_role ??
                rule.clientRole ??
                ''
            );

        if (
            requiredRole &&
            requiredRole !== role
        ) {
            continue;
        }

        const allowedParents =
            normalizeStringArray(
                rule.parent_type_ids ??
                rule.parentTypeIds ??
                rule.parent_transaction_type_ids ??
                rule.parentTransactionTypeIds
            );

        if (
            allowedParents.length > 0 &&
            !allowedParents.includes(parent)
        ) {
            continue;
        }

        const taskTypeId =
            rule.task_type_id ??
            rule.taskTypeId ??
            rule.target_task_type_id ??
            rule.targetTaskTypeId;

        if (!taskTypeId) {
            continue;
        }

        return {
            taskTypeId:
                String(taskTypeId),

            legalBasis:
                rule.legal_basis ??
                rule.legalBasis ??
                null,

            deadlineMode:
                rule.deadline_mode ??
                rule.deadlineMode ??
                'transaction_type_due_period',

            ruleId:
                rule.id ??
                rule.rule_id ??
                null
        };
    }

    // Geriye dönük uyumluluk:
    // task_triggered scalar alanı koşulsuz tek task tanımları için çalışmaya devam eder.
    const legacyTask =
        sourceType.task_triggered ??
        sourceType.taskTriggered ??
        null;

    if (legacyTask) {
        return {
            taskTypeId:
                String(legacyTask),

            legalBasis:
                null,

            deadlineMode:
                'transaction_type_due_period',

            ruleId:
                'legacy_task_triggered'
        };
    }

    return null;
}

if (!proto.__litigationTaskAutomationStage5Patched) {
    Object.defineProperty(
        proto,
        '__litigationTaskAutomationStage5Patched',
        {
            value: true,
            writable: false,
            configurable: false,
            enumerable: false
        }
    );

    const previousLitigationSave =
        proto._handleLitigationIndexingSave;

    const stage4UpdateCalculatedDeadline =
        proto.updateCalculatedDeadline;

    proto._loadLitigationAutomationContext =
        async function({
            suitId,
            sourceTransactionId
        }) {
            const [
                suitResult,
                txResult
            ] = await Promise.all([
                supabase
                    .from('suits')
                    .select(`
                        id,
                        title,
                        file_no,
                        court_name,
                        client_id,
                        client_role,
                        ip_record_id,
                        status
                    `)
                    .eq(
                        'id',
                        String(suitId)
                    )
                    .maybeSingle(),

                supabase
                    .from('transactions')
                    .select(`
                        id,
                        ip_record_id,
                        transaction_type_id,
                        parent_id,
                        task_id,
                        transaction_date
                    `)
                    .eq(
                        'id',
                        String(sourceTransactionId)
                    )
                    .maybeSingle()
            ]);

            if (suitResult.error) {
                throw suitResult.error;
            }

            if (txResult.error) {
                throw txResult.error;
            }

            const suit = suitResult.data;
            const sourceTx = txResult.data;

            if (!suit || !sourceTx) {
                throw new Error(
                    'Dava veya kaynak transaction bulunamadı.'
                );
            }

            const {
                data: parentTx,
                error: parentError
            } = await supabase
                .from('transactions')
                .select(`
                    id,
                    transaction_type_id,
                    ip_record_id
                `)
                .eq(
                    'id',
                    String(sourceTx.parent_id || '')
                )
                .maybeSingle();

            if (parentError) {
                throw parentError;
            }

            return {
                suit,
                sourceTx,
                parentTx
            };
        };

    proto._resolveLitigationClient =
        async function(suit) {
            if (!suit) {
                return {
                    clientId: null,
                    clientRole: null,
                    resolution: 'missing_suit'
                };
            }

            let clientId =
                suit.client_id
                    ? String(suit.client_id)
                    : null;

            let clientRole =
                normRole(suit.client_role);

            // Eski suit kayıtları için client_role boşsa,
            // client_id'nin suit_parties içindeki rolünden tamamla.
            if (
                clientId &&
                !['davaci', 'davali']
                    .includes(clientRole)
            ) {
                const {
                    data: party
                } = await supabase
                    .from('suit_parties')
                    .select(
                        'person_id, role'
                    )
                    .eq(
                        'suit_id',
                        String(suit.id)
                    )
                    .eq(
                        'person_id',
                        clientId
                    )
                    .limit(1)
                    .maybeSingle();

                if (party?.role) {
                    clientRole =
                        normRole(party.role);
                }
            }

            // Eski suit kayıtları için client_id boşsa;
            // client_role biliniyor ve o rolde gerçek person_id varsa fallback.
            if (
                !clientId &&
                ['davaci', 'davali']
                    .includes(clientRole)
            ) {
                const {
                    data: party
                } = await supabase
                    .from('suit_parties')
                    .select(
                        'person_id, role'
                    )
                    .eq(
                        'suit_id',
                        String(suit.id)
                    )
                    .eq(
                        'role',
                        clientRole
                    )
                    .not(
                        'person_id',
                        'is',
                        null
                    )
                    .limit(1)
                    .maybeSingle();

                if (party?.person_id) {
                    clientId =
                        String(party.person_id);
                }
            }

            return {
                clientId,
                clientRole:
                    ['davaci', 'davali']
                        .includes(clientRole)
                        ? clientRole
                        : null,
                resolution:
                    clientId
                        ? 'resolved'
                        : 'missing_client'
            };
        };

    proto._findExistingLitigationTask =
        async function({
            sourceTransactionId,
            taskTypeId
        }) {
            const {
                data,
                error
            } = await supabase
                .from('tasks')
                .select('id')
                .eq(
                    'transaction_id',
                    String(sourceTransactionId)
                )
                .eq(
                    'task_type_id',
                    String(taskTypeId)
                )
                .limit(1);

            if (error) throw error;

            return data?.[0]?.id || null;
        };

    proto._ensureLitigationWorkTransaction =
        async function({
            suitId,
            parentTransactionId,
            taskId,
            taskTypeId,
            sourceTransactionId
        }) {
            const {
                data: existing,
                error
            } = await supabase
                .from('transactions')
                .select('id')
                .eq(
                    'ip_record_id',
                    String(suitId)
                )
                .eq(
                    'task_id',
                    String(taskId)
                )
                .eq(
                    'transaction_type_id',
                    String(taskTypeId)
                )
                .limit(1);

            if (error) {
                throw error;
            }

            if (existing?.length) {
                return existing[0].id;
            }

            const taskTypeLabel =
                txTypeName(
                    this,
                    taskTypeId
                );

            const result =
                await this._addTransaction(
                    String(suitId),
                    {
                        type:
                            String(
                                taskTypeId
                            ),
                        transactionHierarchy:
                            'child',
                        parentId:
                            String(
                                parentTransactionId
                            ),
                        description:
                            taskTypeLabel,
                        taskId:
                            String(taskId),
                        notes:
                            `[Otomatik Dava Görevi]\n` +
                            `[Kaynak Transaction: ${sourceTransactionId}]`,
                        timestamp:
                            new Date()
                                .toISOString()
                    }
                );

            if (!result?.success) {
                throw new Error(
                    result?.error ||
                    'Görev transaction kaydı oluşturulamadı.'
                );
            }

            return result.id;
        };

    proto._applyDeterministicSuitStatus =
        async function({
            suitId,
            incomingTypeId
        }) {
            const targetStatus =
                SUIT_STATUS_BY_INCOMING_TYPE[
                    String(
                        incomingTypeId || ''
                    )
                ];

            if (!targetStatus) {
                return false;
            }

            const {
                error
            } = await supabase
                .from('suits')
                .update({
                    status:
                        targetStatus,
                    updated_at:
                        new Date()
                            .toISOString()
                })
                .eq(
                    'id',
                    String(suitId)
                );

            if (error) {
                console.warn(
                    '[LITIGATION AŞAMA 5] Suit status güncellenemedi:',
                    error
                );

                return false;
            }

            if (
                this.matchedSuit &&
                String(this.matchedSuit.id) ===
                    String(suitId)
            ) {
                this.matchedSuit.status =
                    targetStatus;
            }

            return true;
        };

    proto._createLitigationTriggeredTask =
        async function({
            incomingDocument,
            context,
            client,
            rule
        }) {
            const suit =
                context.suit;

            const sourceTx =
                context.sourceTx;

            const parentTx =
                context.parentTx;

            const sourceTransactionId =
                String(sourceTx.id);

            const existingTaskId =
                await this
                    ._findExistingLitigationTask({
                        sourceTransactionId,
                        taskTypeId:
                            rule.taskTypeId
                    });

            if (existingTaskId) {
                await this
                    ._ensureLitigationWorkTransaction({
                        suitId:
                            suit.id,
                        parentTransactionId:
                            sourceTx.parent_id,
                        taskId:
                            existingTaskId,
                        taskTypeId:
                            rule.taskTypeId,
                        sourceTransactionId
                    });

                return {
                    taskId:
                        existingTaskId,
                    duplicatePrevented:
                        true
                };
            }

            const deliveryDate =
                incomingDocument
                    .teblig_tarihi ||
                sourceTx.transaction_date;

            const deadlineConfig =
                calculateOfficialDeadlineFromType(
                    this,
                    sourceTx.transaction_type_id,
                    deliveryDate
                );

            const officialDue =
                deadlineConfig.date;

            const operationalDue =
                calculateOperationalDeadline(
                    officialDue
                );

            if (!officialDue) {
                throw new Error(
                    `İşlem türü ${sourceTx.transaction_type_id} için DB deadline konfigürasyonu eksik/geçersiz (${deadlineConfig.error || 'unknown'}).`
                );
            }

            const taskTypeLabel =
                txTypeName(
                    this,
                    rule.taskTypeId
                );

            const incomingTypeLabel =
                txTypeName(
                    this,
                    sourceTx.transaction_type_id
                );

            const suitLabel =
                suit.file_no ||
                suit.title ||
                String(suit.id);

            const now =
                new Date()
                    .toISOString();

            // client_id çözülemezse görevi yine kaybetmiyoruz:
            // status=pending seçilerek taskService'in mevcut kullanıcıya
            // fallback ataması korunur.
            const taskStatus =
                client.clientId
                    ? 'open'
                    : 'pending';

            const taskPayload = {
                title:
                    `${taskTypeLabel} - ${suitLabel}`,

                description:
                    `${incomingTypeLabel} evrakının dava dosyasına indekslenmesi ile otomatik oluşturuldu.`,

                task_type_id:
                    String(
                        rule.taskTypeId
                    ),

                status:
                    taskStatus,

                priority:
                    'medium',

                ip_record_id:
                    String(suit.id),

                task_owner_id:
                    client.clientId ||
                    null,

                transaction_id:
                    sourceTransactionId,

                official_due_date:
                    officialDue
                        .toISOString(),

                operational_due_date:
                    operationalDue
                        ?.toISOString() ||
                    officialDue
                        .toISOString(),

                details: {
                    litigation_auto_trigger:
                        true,

                    source_document_id:
                        String(
                            this.pdfId ||
                            incomingDocument.id ||
                            ''
                        ),

                    suit_id:
                        String(
                            suit.id
                        ),

                    suit_file_no:
                        suit.file_no ||
                        null,

                    court_name:
                        suit.court_name ||
                        null,

                    client_role:
                        client.clientRole ||
                        null,

                    owner_resolution:
                        client.resolution,

                    triggering_transaction_type:
                        String(
                            sourceTx.transaction_type_id
                        ),

                    triggered_task_type:
                        String(
                            rule.taskTypeId
                        ),

                    source_transaction_id:
                        sourceTransactionId,

                    parent_transaction_id:
                        sourceTx.parent_id
                            ? String(
                                sourceTx.parent_id
                            )
                            : null,

                    parent_transaction_type:
                        parentTx
                            ?.transaction_type_id
                            ? String(
                                parentTx.transaction_type_id
                            )
                            : null,

                    legal_basis:
                        rule.legalBasis,

                    trigger_rule_id:
                        rule.ruleId ||
                        null,

                    deadline_mode:
                        rule.deadlineMode,

                    due_period:
                        deadlineConfig.period,

                    due_period_unit:
                        deadlineConfig.unit,

                    operational_buffer_days:
                        3,

                    deadline_extension_applied:
                        false
                },

                history: [
                    {
                        action:
                            `${incomingTypeLabel} indekslendi; ${taskTypeLabel} görevi otomatik oluşturuldu.`,
                        timestamp:
                            now,
                        userEmail:
                            this.currentUser
                                ?.email ||
                            null
                    }
                ]
            };

            const result =
                await taskService
                    .createTask(
                        taskPayload
                    );

            if (!result?.success) {
                throw new Error(
                    result?.error
                        ?.message ||
                    result?.error ||
                    'Dava görevi oluşturulamadı.'
                );
            }

            const taskId =
                result.data?.id ||
                result.id;

            if (!taskId) {
                throw new Error(
                    'Görev oluşturuldu fakat task id alınamadı.'
                );
            }

            // Kaynak gelen evrak transaction'ına task bağını koy.
            const {
                error: sourceTxUpdateError
            } = await supabase
                .from('transactions')
                .update({
                    task_id:
                        String(taskId)
                })
                .eq(
                    'id',
                    sourceTransactionId
                );

            if (
                sourceTxUpdateError
            ) {
                console.warn(
                    '[LITIGATION AŞAMA 5] Kaynak transaction task_id güncellenemedi:',
                    sourceTxUpdateError
                );
            }

            // 61/62/63/65 transaction placeholder'ı.
            let workTransactionId =
                null;

            try {
                workTransactionId =
                    await this
                        ._ensureLitigationWorkTransaction({
                            suitId:
                                suit.id,

                            parentTransactionId:
                                sourceTx.parent_id,

                            taskId:
                                String(taskId),

                            taskTypeId:
                                rule.taskTypeId,

                            sourceTransactionId
                        });

            } catch (error) {
                console.warn(
                    '[LITIGATION AŞAMA 5] Work transaction oluşturulamadı; task korunuyor:',
                    error
                );
            }

            return {
                taskId:
                    String(taskId),

                workTransactionId,

                officialDue,
                operationalDue,

                ownerMissing:
                    !client.clientId,

                duplicatePrevented:
                    false
            };
        };

    proto._markLitigationMailReady =
        async function() {
            if (!this.pdfId) {
                throw new Error(
                    'Mail-ready için incoming document id bulunamadı.'
                );
            }

            const {
                data,
                error
            } = await supabase
                .from('incoming_documents')
                .update({
                    status:
                        'litigation_mail_ready'
                })
                .eq(
                    'id',
                    String(this.pdfId)
                )
                .eq(
                    'status',
                    'litigation_indexed'
                )
                .select('id, status')
                .maybeSingle();

            if (error) {
                throw error;
            }

            if (data?.status === 'litigation_mail_ready') {
                console.log(
                    '[LITIGATION AŞAMA 6B] Mail-ready statüsü yazıldı:',
                    data.id
                );

                return true;
            }

            // Idempotent retry: zaten mail-ready ise başarılı kabul et.
            const {
                data: current,
                error: currentError
            } = await supabase
                .from('incoming_documents')
                .select('id, status')
                .eq(
                    'id',
                    String(this.pdfId)
                )
                .maybeSingle();

            if (currentError) {
                throw currentError;
            }

            if (
                current?.status ===
                    'litigation_mail_ready'
            ) {
                return true;
            }

            throw new Error(
                `Dava evrakı mail-ready durumuna alınamadı. Mevcut status: ${current?.status || 'bulunamadı'}`
            );
        };

    proto._runLitigationPostIndexAutomation =
        async function() {
            if (
                this.matchedEntityType !==
                'suit'
            ) {
                return {
                    readyForMail: false,
                    reason: 'not_suit'
                };
            }

            const suitId =
                this.matchedSuit?.id ||
                this.matchedRecord?.id;

            if (
                !suitId ||
                !this.pdfId
            ) {
                return {
                    readyForMail: false,
                    reason: 'missing_suit_or_pdf'
                };
            }

            const {
                data: incomingDocument,
                error: incomingError
            } = await supabase
                .from('incoming_documents')
                .select(`
                    id,
                    status,
                    ip_record_id,
                    created_transaction_id,
                    transaction_type_id,
                    teblig_tarihi
                `)
                .eq(
                    'id',
                    String(this.pdfId)
                )
                .maybeSingle();

            if (
                incomingError ||
                !incomingDocument
            ) {
                console.error(
                    '[LITIGATION AŞAMA 6B] incoming_document okunamadı:',
                    incomingError
                );

                throw (
                    incomingError ||
                    new Error(
                        'incoming_document bulunamadı.'
                    )
                );
            }

            // AŞAMA 4 başarılı olmadan hiçbir otomasyon çalışmasın.
            if (
                incomingDocument.status !==
                    'litigation_indexed' ||
                !incomingDocument
                    .created_transaction_id ||
                String(
                    incomingDocument
                        .ip_record_id
                ) !== String(suitId)
            ) {
                return {
                    readyForMail: false,
                    reason:
                        'incoming_not_ready_for_post_index'
                };
            }

            const context =
                await this
                    ._loadLitigationAutomationContext({
                        suitId:
                            String(suitId),

                        sourceTransactionId:
                            String(
                                incomingDocument
                                    .created_transaction_id
                            )
                    });

            // Deterministic dava durumları task'tan bağımsız.
            await this
                ._applyDeterministicSuitStatus({
                    suitId:
                        String(suitId),

                    incomingTypeId:
                        incomingDocument
                            .transaction_type_id
                });

            const client =
                await this
                    ._resolveLitigationClient(
                        context.suit
                    );

            const rule =
                resolveAutomationRule(
                    this,
                    {
                    incomingTypeId:
                        incomingDocument
                            .transaction_type_id,

                    clientRole:
                        client.clientRole,

                    parentTypeId:
                        context.parentTx
                            ?.transaction_type_id
                    }
                );

            if (!rule) {
                // Bilerek otomatik task üretmeyen evrak.
                // 70+davacı veya 73-78 gibi senaryolarda mail yine hazırlanabilir.
                return {
                    readyForMail: true,
                    taskCreated: false,
                    taskId: null,
                    reason: 'no_task_rule'
                };
            }

            const result =
                await this
                    ._createLitigationTriggeredTask({
                        incomingDocument,
                        context,
                        client,
                        rule
                    });

            const taskLabel =
                txTypeName(
                    this,
                    rule.taskTypeId
                );

            const deadlineEl =
                document.getElementById(
                    'calculatedDeadlineDisplay'
                );

            if (
                deadlineEl &&
                result.officialDue
            ) {
                deadlineEl.value =
                    `${taskLabel} · Resmî: ${formatToTRDate(result.officialDue)} · Operasyonel: ${formatToTRDate(result.operationalDue)}`;
            }

            if (
                result.duplicatePrevented
            ) {
                showNotification(
                    `${taskLabel} görevi zaten mevcut; duplicate oluşturulmadı.`,
                    'info',
                    5000
                );

                return {
                    readyForMail: true,
                    taskCreated: false,
                    taskId: result.taskId,
                    duplicatePrevented: true
                };
            }

            if (result.ownerMissing) {
                showNotification(
                    `${taskLabel} görevi oluşturuldu; ancak dava müvekkili çözülemediği için görev Beklemede durumunda mevcut kullanıcıya bırakıldı.`,
                    'warning',
                    9000
                );

                return {
                    readyForMail: true,
                    taskCreated: true,
                    taskId: result.taskId,
                    ownerMissing: true
                };
            }

            showNotification(
                `${taskLabel} görevi otomatik oluşturuldu. Resmî son tarih: ${formatToTRDate(result.officialDue)}.`,
                'success',
                7000
            );

            return {
                readyForMail: true,
                taskCreated: true,
                taskId: result.taskId,
                duplicatePrevented: false
            };
        };

    // AŞAMA 4 write başarıyla tamamlandıktan sonra task/status otomasyonu.
    // Otomasyon tamamen bittikten sonra mail-ready statüsüne geçilir.
    proto._handleLitigationIndexingSave =
        async function(...args) {
            await previousLitigationSave.apply(
                this,
                args
            );

            try {
                const automationResult =
                    await this
                        ._runLitigationPostIndexAutomation();

                if (
                    automationResult
                        ?.readyForMail
                ) {
                    await this
                        ._markLitigationMailReady();

                    console.log(
                        '[LITIGATION AŞAMA 6B] Task/status otomasyonu tamamlandı; mail-ready tetiklendi.',
                        automationResult
                    );
                }

            } catch (error) {
                // Transaction ve incoming_document AŞAMA 4'te başarıyla
                // kaydedilmiş olabilir; task/mail-ready hatası nedeniyle onları rollback etmiyoruz.
                // Kritik güvenlik: hata halinde status litigation_indexed kalır ve eksik mail üretilmez.
                console.error(
                    '[LITIGATION AŞAMA 6B] Post-index / mail-ready otomasyon hatası:',
                    error
                );

                showNotification(
                    `Dava evrakı indekslendi ancak otomatik görev/mail bildirimi tamamlanamadı: ${error.message || error}`,
                    'warning',
                    10000
                );
            }
        };

    // Dava ekranında kaydetmeden önce task/deadline önizlemesi.
    proto.updateCalculatedDeadline =
        function() {
            if (
                this.matchedEntityType !==
                'suit'
            ) {
                return stage4UpdateCalculatedDeadline
                    .call(this);
            }

            const deadlineEl =
                document.getElementById(
                    'calculatedDeadlineDisplay'
                );

            if (!deadlineEl) {
                return;
            }

            const parentTxId =
                document.getElementById(
                    'parentTransactionSelect'
                )?.value || '';

            const childTypeId =
                document.getElementById(
                    'detectedType'
                )?.value || '';

            const deliveryRaw =
                document.getElementById(
                    'detectedDate'
                )?.value || '';

            if (
                !parentTxId ||
                !childTypeId
            ) {
                deadlineEl.value =
                    'Otomatik görev kuralı için parent ve evrak türünü seçin';
                return;
            }

            const parentTx =
                (this.currentTransactions || [])
                    .find(
                        (tx) =>
                            String(tx.id) ===
                            String(parentTxId)
                    );

            const clientRole =
                this.matchedSuit
                    ?.client_role ||
                null;

            const rule =
                resolveAutomationRule(
                    this,
                    {
                        incomingTypeId:
                            childTypeId,

                        clientRole,

                        parentTypeId:
                            parentTx
                                ?.transaction_type_id
                    }
                );

            if (!rule) {
                if (
                    SUIT_STATUS_BY_INCOMING_TYPE[
                        String(childTypeId)
                    ]
                ) {
                    deadlineEl.value =
                        'Task yok · dava statüsü otomatik güncellenecek';
                } else {
                    deadlineEl.value =
                        'Bu evrak için otomatik task/deadline tanımlı değil';
                }

                return;
            }

            const taskLabel =
                txTypeName(
                    this,
                    rule.taskTypeId
                );

            if (!deliveryRaw) {
                const typeObj =
                    txTypeObject(
                        this,
                        childTypeId
                    );

                const period =
                    typeObj?.due_period ??
                    typeObj?.duePeriod ??
                    0;

                const unit =
                    typeObj?.due_period_unit ??
                    typeObj?.duePeriodUnit ??
                    '-';

                deadlineEl.value =
                    `${taskLabel} · DB süre: ${period} ${unit}`;
                return;
            }

            const deadlineConfig =
                calculateOfficialDeadlineFromType(
                    this,
                    childTypeId,
                    deliveryRaw
                );

            const official =
                deadlineConfig.date;

            const operational =
                calculateOperationalDeadline(
                    official
                );

            if (!official) {
                deadlineEl.value =
                    `${taskLabel} · DB süre konfigürasyonu eksik (${deadlineConfig.error || 'unknown'})`;
                return;
            }

            deadlineEl.value =
                `${taskLabel} · Resmî: ${formatToTRDate(official)} · Operasyonel: ${formatToTRDate(operational)}`;
        };
}
