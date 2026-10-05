// supabase/functions/handle-litigation-task-mails/index.ts
// IPGate Dava Yönetimi - AŞAMA 8D-2
//
// Dava work task tamamlanma mail motoru.
//
// NEDEN AYRI FUNCTION?
// - Mevcut handle-task-mails marka/patent/design akışını bozmaz.
// - Dava task'ında tasks.ip_record_id = suits.id olduğundan
//   portfolio_list_view / resp_trademark mantığı doğru değildir.
// - Alıcılar resp_litigation / notify_litigation_to/cc üzerinden çözülür.
// - Mevcut generic task_completion mail kaydı varsa aynı ID üzerinde
//   dava mailine dönüştürülür. Böylece çift mail oluşmaz.
// - Task belgeleri mail_attachments'a bağlanır.
//
// Deploy:
// supabase functions deploy handle-litigation-task-mails --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
        'authorization, x-client-info, apikey, content-type'
}

const LITIGATION_WORK_TYPES = new Set([
    '61', '62', '63', '64', '65',
    '91', '93', '94', '96', '97'
])

const STAGE_PARENT_TYPES = new Set([
    '49', '54', '55', '56', '57', '58',
    '59', '60'
])

function jsonResponse(payload, status = 200) {
    return new Response(
        JSON.stringify(payload),
        {
            status,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
            }
        }
    )
}

function clean(value, fallback = '-') {
    const text = String(value ?? '').trim()
    return text || fallback
}

function normalizeEmail(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
}

function uniqueEmails(values) {
    const seen = new Set()
    const result = []

    for (const raw of values || []) {
        const email = normalizeEmail(raw)

        if (!email || seen.has(email)) {
            continue
        }

        seen.add(email)
        result.push(email)
    }

    return result
}

function normalizeTypeArray(raw) {
    if (Array.isArray(raw)) {
        return raw
            .map((item) => String(item))
            .filter(Boolean)
    }

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw)

            if (Array.isArray(parsed)) {
                return parsed
                    .map((item) => String(item))
                    .filter(Boolean)
            }
        } catch {
            return raw
                .replace(/[{}]/g, '')
                .split(',')
                .map((item) =>
                    item
                        .replace(/^"+|"+$/g, '')
                        .trim()
                )
                .filter(Boolean)
        }
    }

    return []
}

function parseObject(raw) {
    if (
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw)
    ) {
        return raw
    }

    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw)

            return (
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed)
            )
                ? parsed
                : {}
        } catch {
            return {}
        }
    }

    return {}
}

function formatDateTR(value) {
    if (!value) {
        return '-'
    }

    const raw = String(value)
    const iso =
        raw.match(
            /^(\d{4})-(\d{2})-(\d{2})/
        )

    if (iso) {
        return `${iso[3]}.${iso[2]}.${iso[1]}`
    }

    const date =
        new Date(raw)

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return '-'
    }

    return date
        .toLocaleDateString('tr-TR')
}

function formatRole(value) {
    const role =
        String(value ?? '')
            .toLocaleLowerCase('tr-TR')
            .trim()

    if (role === 'davaci') {
        return 'Davacı'
    }

    if (role === 'davali') {
        return 'Davalı'
    }

    if (role === 'mudahil') {
        return 'Müdahil'
    }

    return clean(value)
}

function stageKeyFromParentType(typeId) {
    const id =
        String(typeId || '')

    if (id === '60') {
        return 'cassation'
    }

    if (id === '59') {
        return 'appeal'
    }

    if (
        ['49','54','55','56','57','58']
            .includes(id)
    ) {
        return 'first_instance'
    }

    return null
}

function stageRank(typeId) {
    const key =
        stageKeyFromParentType(
            typeId
        )

    if (key === 'cassation') {
        return 3
    }

    if (key === 'appeal') {
        return 2
    }

    if (key === 'first_instance') {
        return 1
    }

    return 0
}

function stageLabel(value) {
    const key =
        String(value || '')
            .trim()

    if (key === 'cassation') {
        return 'Yargıtay'
    }

    if (key === 'appeal') {
        return 'İstinaf'
    }

    if (key === 'first_instance') {
        return 'İlk Derece'
    }

    return clean(value)
}

function initiatorLabel(value) {
    const raw =
        String(value || '')
            .toLowerCase()
            .trim()

    if (raw === 'client') {
        return 'Müvekkil'
    }

    if (raw === 'opponent') {
        return 'Karşı Taraf'
    }

    if (raw === 'both') {
        return 'Her İki Taraf'
    }

    return '-'
}

function replacePlaceholders(
    input,
    placeholders
) {
    let output =
        String(input ?? '')

    for (
        const [key, value]
        of Object.entries(placeholders)
    ) {
        output =
            output.replaceAll(
                key,
                String(value ?? '')
            )
    }

    return output
}

async function sleep(ms) {
    await new Promise(
        (resolve) =>
            setTimeout(resolve, ms)
    )
}

async function getTransactionType(
    supabaseAdmin,
    typeId
) {
    if (!typeId) {
        return null
    }

    const {
        data,
        error
    } = await supabaseAdmin
        .from('transaction_types')
        .select(`
            id,
            name,
            alias,
            ip_type,
            suit_event_kind,
            suit_stage_scope
        `)
        .eq(
            'id',
            String(typeId)
        )
        .maybeSingle()

    if (error) {
        console.warn(
            '[LITIGATION_TASK_MAIL] transaction type okunamadı:',
            error
        )
    }

    return data || null
}

async function resolveClient(
    supabaseAdmin,
    suit
) {
    let clientId =
        suit?.client_id
            ? String(suit.client_id)
            : null

    const role =
        String(
            suit?.client_role || ''
        )
            .toLocaleLowerCase('tr-TR')
            .trim()

    if (
        !clientId &&
        role
    ) {
        const {
            data: party,
            error
        } = await supabaseAdmin
            .from('suit_parties')
            .select('person_id')
            .eq(
                'suit_id',
                String(suit.id)
            )
            .eq(
                'role',
                role
            )
            .not(
                'person_id',
                'is',
                null
            )
            .limit(1)
            .maybeSingle()

        if (error) {
            console.warn(
                '[LITIGATION_TASK_MAIL] suit_parties client fallback:',
                error
            )
        }

        if (
            party?.person_id
        ) {
            clientId =
                String(
                    party.person_id
                )
        }
    }

    let clientName = '-'
    let directEmail = null

    if (clientId) {
        const {
            data: person,
            error
        } = await supabaseAdmin
            .from('persons')
            .select(
                'id, name, email'
            )
            .eq(
                'id',
                clientId
            )
            .maybeSingle()

        if (error) {
            console.warn(
                '[LITIGATION_TASK_MAIL] client person okunamadı:',
                error
            )
        }

        if (person) {
            clientName =
                clean(
                    person.name
                )

            directEmail =
                person.email
                    ? normalizeEmail(
                        person.email
                    )
                    : null
        }
    }

    return {
        clientId,
        clientName,
        directEmail
    }
}

async function resolveLitigationRecipients(
    supabaseAdmin,
    client,
    transactionTypeId
) {
    const to = []
    const cc = []

    if (client.clientId) {
        const {
            data: relatedRows,
            error
        } = await supabaseAdmin
            .from('persons_related')
            .select(`
                email,
                resp_litigation,
                notify_litigation_to,
                notify_litigation_cc
            `)
            .eq(
                'person_id',
                client.clientId
            )

        if (error) {
            console.warn(
                '[LITIGATION_TASK_MAIL] persons_related okunamadı:',
                error
            )
        }

        for (
            const row of
            relatedRows || []
        ) {
            if (
                !row?.email ||
                !row?.resp_litigation
            ) {
                continue
            }

            const email =
                normalizeEmail(
                    row.email
                )

            if (!email) {
                continue
            }

            if (
                row.notify_litigation_to
            ) {
                to.push(email)
            }

            if (
                row.notify_litigation_cc
            ) {
                cc.push(email)
            }

            if (
                !row.notify_litigation_to &&
                !row.notify_litigation_cc
            ) {
                to.push(email)
            }
        }
    }

    let finalTo =
        uniqueEmails(to)

    let clientCc =
        uniqueEmails(cc)

    if (
        finalTo.length === 0 &&
        clientCc.length > 0
    ) {
        finalTo =
            [clientCc[0]]

        clientCc =
            clientCc.slice(1)
    }

    if (
        finalTo.length === 0 &&
        client.directEmail
    ) {
        finalTo = [
            normalizeEmail(
                client.directEmail
            )
        ]
    }

    const {
        data: internalRows,
        error: internalError
    } = await supabaseAdmin
        .from(
            'evreka_mail_cc_list'
        )
        .select(
            'email, transaction_types'
        )

    if (internalError) {
        console.warn(
            '[LITIGATION_TASK_MAIL] Internal CC okunamadı:',
            internalError
        )
    }

    const internalCc = []

    for (
        const row of
        internalRows || []
    ) {
        if (!row?.email) {
            continue
        }

        const types =
            normalizeTypeArray(
                row.transaction_types
            )

        if (
            types.includes('All') ||
            types.includes(
                String(
                    transactionTypeId
                )
            )
        ) {
            internalCc.push(
                normalizeEmail(
                    row.email
                )
            )
        }
    }

    const toSet =
        new Set(
            finalTo.map(
                normalizeEmail
            )
        )

    const finalCc =
        uniqueEmails([
            ...clientCc,
            ...internalCc
        ]).filter(
            (email) =>
                !toSet.has(email)
        )

    return {
        to: finalTo,
        cc: finalCc
    }
}

async function resolveSubjectAsset(
    supabaseAdmin,
    suit
) {
    if (!suit?.ip_record_id) {
        return clean(
            suit?.title
        )
    }

    const {
        data,
        error
    } = await supabaseAdmin
        .from(
            'portfolio_list_view'
        )
        .select('*')
        .eq(
            'id',
            String(
                suit.ip_record_id
            )
        )
        .maybeSingle()

    if (error) {
        console.warn(
            '[LITIGATION_TASK_MAIL] Subject asset okunamadı:',
            error
        )
    }

    if (!data) {
        return clean(
            suit?.title
        )
    }

    const name =
        data.brand_name ||
        data.title ||
        data.application_number ||
        data.registration_number ||
        suit?.title ||
        '-'

    const number =
        data.application_number ||
        data.registration_number ||
        null

    return number
        ? `${name} (${number})`
        : clean(name)
}

async function resolveTaskWorkTransaction(
    supabaseAdmin,
    task,
    taskTypeId,
    suitId
) {
    const {
        data,
        error
    } = await supabaseAdmin
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
            task_id,
            suit_context,
            created_at
        `)
        .eq(
            'ip_record_id',
            String(suitId)
        )
        .eq(
            'task_id',
            String(task.id)
        )
        .eq(
            'transaction_type_id',
            String(taskTypeId)
        )
        .eq(
            'transaction_hierarchy',
            'child'
        )
        .order(
            'created_at',
            { ascending: false }
        )
        .limit(1)
        .maybeSingle()

    if (error) {
        console.warn(
            '[LITIGATION_TASK_MAIL] Work transaction okunamadı:',
            error
        )
    }

    if (data) {
        return data
    }

    // Ara/eski kayıt fallback:
    // task.transaction_id gerçekten aynı suit work transaction ise kullan.
    const candidateId =
        task.transaction_id ||
        task.details?.transactionId ||
        null

    if (!candidateId) {
        return null
    }

    const {
        data: fallback,
        error: fallbackError
    } = await supabaseAdmin
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
            task_id,
            suit_context,
            created_at
        `)
        .eq(
            'id',
            String(candidateId)
        )
        .maybeSingle()

    if (fallbackError) {
        console.warn(
            '[LITIGATION_TASK_MAIL] Work tx fallback okunamadı:',
            fallbackError
        )
    }

    if (
        fallback &&
        String(
            fallback.ip_record_id ||
            ''
        ) ===
            String(suitId) &&
        String(
            fallback.transaction_type_id ||
            ''
        ) ===
            String(taskTypeId)
    ) {
        return fallback
    }

    return null
}

async function resolveCurrentStage(
    supabaseAdmin,
    suitId
) {
    const {
        data,
        error
    } = await supabaseAdmin
        .from('transactions')
        .select(`
            id,
            transaction_type_id,
            parent_id,
            transaction_date,
            created_at,
            suit_context
        `)
        .eq(
            'ip_record_id',
            String(suitId)
        )
        .eq(
            'transaction_hierarchy',
            'parent'
        )
        .in(
            'transaction_type_id',
            [
                '49','54','55','56',
                '57','58','59','60'
            ]
        )

    if (error) {
        console.warn(
            '[LITIGATION_TASK_MAIL] Stage parent okunamadı:',
            error
        )

        return {
            transaction: null,
            key: null,
            label: '-',
            initiator: '-'
        }
    }

    const rows =
        [...(data || [])]
            .filter(
                (row) =>
                    STAGE_PARENT_TYPES.has(
                        String(
                            row.transaction_type_id
                        )
                    )
            )
            .sort(
                (a, b) => {
                    const rankDiff =
                        stageRank(
                            b.transaction_type_id
                        ) -
                        stageRank(
                            a.transaction_type_id
                        )

                    if (rankDiff !== 0) {
                        return rankDiff
                    }

                    return (
                        new Date(
                            b.transaction_date ||
                            b.created_at ||
                            0
                        ).getTime() -
                        new Date(
                            a.transaction_date ||
                            a.created_at ||
                            0
                        ).getTime()
                    )
                }
            )

    const highest =
        rows[0] ||
        null

    if (!highest) {
        return {
            transaction: null,
            key: null,
            label: '-',
            initiator: '-'
        }
    }

    const context =
        parseObject(
            highest.suit_context
        )

    const key =
        context.stage ||
        stageKeyFromParentType(
            highest.transaction_type_id
        )

    return {
        transaction:
            highest,

        key,

        label:
            stageLabel(key),

        initiator:
            initiatorLabel(
                context.stage_initiator
            )
    }
}

async function resolveTriggeredByUser(
    supabaseAdmin,
    task
) {
    const {
        data: history
    } = await supabaseAdmin
        .from('task_history')
        .select(
            'user_id, created_at'
        )
        .eq(
            'task_id',
            String(task.id)
        )
        .order(
            'created_at',
            { ascending: false }
        )
        .limit(1)
        .maybeSingle()

    if (
        history?.user_id
    ) {
        return history.user_id
    }

    return (
        task.created_by ||
        null
    )
}

async function resolveTemplate(
    supabaseAdmin,
    taskTypeId
) {
    const {
        data: rule,
        error: ruleError
    } = await supabaseAdmin
        .from('template_rules')
        .select('template_id')
        .eq(
            'source_type',
            'task_completion_litigation'
        )
        .eq(
            'main_process_type',
            'suit'
        )
        .eq(
            'task_type',
            String(taskTypeId)
        )
        .limit(1)
        .maybeSingle()

    if (ruleError) {
        console.warn(
            '[LITIGATION_TASK_MAIL] Template rule okunamadı:',
            ruleError
        )
    }

    const templateId =
        rule?.template_id
            ? String(
                rule.template_id
            )
            : 'tmpl_litigation_task_completion_default'

    const {
        data: template,
        error: templateError
    } = await supabaseAdmin
        .from('mail_templates')
        .select(`
            id,
            template_id,
            subject,
            mail_subject,
            body
        `)
        .eq(
            'id',
            templateId
        )
        .maybeSingle()

    if (templateError) {
        console.warn(
            '[LITIGATION_TASK_MAIL] Template okunamadı:',
            templateError
        )
    }

    return {
        templateId:
            template?.id ||
            null,

        template:
            template ||
            null
    }
}

async function findReusableGenericMail(
    supabaseAdmin,
    taskId
) {
    // Mevcut handle-task-mails yaklaşık 1sn bekliyor.
    // Biz task docs/history/generic mail'in yazılmasını bekleyerek
    // mevcut yanlış/boş row'u aynı ID üzerinde dönüştürüyoruz.
    for (
        let attempt = 0;
        attempt < 7;
        attempt++
    ) {
        const {
            data: litigationMail
        } = await supabaseAdmin
            .from('mail_notifications')
            .select(
                'id, source, status, template_id'
            )
            .eq(
                'associated_task_id',
                String(taskId)
            )
            .eq(
                'source',
                'litigation_task_completion'
            )
            .order(
                'created_at',
                { ascending: false }
            )
            .limit(1)
            .maybeSingle()

        if (litigationMail) {
            return {
                kind: 'already_litigation',
                row: litigationMail
            }
        }

        const {
            data: genericMail
        } = await supabaseAdmin
            .from('mail_notifications')
            .select(
                'id, source, status, template_id'
            )
            .eq(
                'associated_task_id',
                String(taskId)
            )
            .eq(
                'source',
                'task_completion'
            )
            .neq(
                'status',
                'sent'
            )
            .order(
                'created_at',
                { ascending: false }
            )
            .limit(1)
            .maybeSingle()

        if (genericMail) {
            return {
                kind: 'generic',
                row: genericMail
            }
        }

        await sleep(
            attempt === 0
                ? 1100
                : 300
        )
    }

    return {
        kind: 'none',
        row: null
    }
}

async function syncAttachments(
    supabaseAdmin,
    notificationId,
    taskId,
    workTransactionId
) {
    const {
        data: existing
    } = await supabaseAdmin
        .from('mail_attachments')
        .select('id, url')
        .eq(
            'notification_id',
            String(notificationId)
        )

    const known =
        new Set(
            (existing || [])
                .map(
                    (item) =>
                        clean(
                            item.url,
                            ''
                        )
                )
                .filter(Boolean)
        )

    const attachments = []

    const {
        data: taskDocs,
        error: taskDocsError
    } = await supabaseAdmin
        .from('task_documents')
        .select(`
            id,
            document_name,
            document_url,
            document_type,
            uploaded_at
        `)
        .eq(
            'task_id',
            String(taskId)
        )

    if (taskDocsError) {
        console.warn(
            '[LITIGATION_TASK_MAIL] task_documents okunamadı:',
            taskDocsError
        )
    }

    for (
        const doc of
        taskDocs || []
    ) {
        const url =
            clean(
                doc.document_url,
                ''
            )

        if (
            !url ||
            known.has(url)
        ) {
            continue
        }

        known.add(url)

        attachments.push({
            id:
                crypto.randomUUID(),

            notification_id:
                String(
                    notificationId
                ),

            file_name:
                clean(
                    doc.document_name,
                    'Dava_Evraki'
                ),

            storage_path:
                doc.document_url ||
                null,

            url
        })
    }

    if (
        workTransactionId
    ) {
        const {
            data: txDocs,
            error: txDocsError
        } = await supabaseAdmin
            .from(
                'transaction_documents'
            )
            .select(`
                document_name,
                document_url
            `)
            .eq(
                'transaction_id',
                String(
                    workTransactionId
                )
            )

        if (txDocsError) {
            console.warn(
                '[LITIGATION_TASK_MAIL] transaction_documents okunamadı:',
                txDocsError
            )
        }

        for (
            const doc of
            txDocs || []
        ) {
            const url =
                clean(
                    doc.document_url,
                    ''
                )

            if (
                !url ||
                known.has(url)
            ) {
                continue
            }

            known.add(url)

            attachments.push({
                id:
                    crypto.randomUUID(),

                notification_id:
                    String(
                        notificationId
                    ),

                file_name:
                    clean(
                        doc.document_name,
                        'Dava_Evraki'
                    ),

                storage_path:
                    doc.document_url ||
                    null,

                url
            })
        }
    }

    if (
        attachments.length > 0
    ) {
        const {
            error
        } = await supabaseAdmin
            .from('mail_attachments')
            .insert(
                attachments
            )

        if (error) {
            console.warn(
                '[LITIGATION_TASK_MAIL] Attachment insert uyarısı:',
                error
            )
        }
    }

    return {
        taskDocs:
            taskDocs || [],

        addedCount:
            attachments.length
    }
}

serve(async (req) => {
    if (
        req.method === 'OPTIONS'
    ) {
        return new Response(
            'ok',
            {
                headers:
                    corsHeaders
            }
        )
    }

    try {
        const payload =
            await req.json()

        const {
            type,
            record,
            old_record
        } = payload

        if (
            type !== 'UPDATE' ||
            !record ||
            !old_record
        ) {
            return jsonResponse({
                success: true,
                skipped: true,
                reason:
                    'not_update'
            })
        }

        const becameCompleted =
            old_record.status !==
                'completed' &&
            record.status ===
                'completed'

        if (!becameCompleted) {
            return jsonResponse({
                success: true,
                skipped: true,
                reason:
                    'not_completed_transition'
            })
        }

        const taskTypeId =
            String(
                record.task_type_id ||
                ''
            )

        if (
            !LITIGATION_WORK_TYPES.has(
                taskTypeId
            )
        ) {
            return jsonResponse({
                success: true,
                skipped: true,
                reason:
                    'not_litigation_work_type'
            })
        }

        const suitId =
            clean(
                record.ip_record_id,
                ''
            )

        if (!suitId) {
            return jsonResponse({
                success: true,
                skipped: true,
                reason:
                    'no_suit_id'
            })
        }

        const supabaseAdmin =
            createClient(
                Deno.env.get(
                    'SUPABASE_URL'
                ) ?? '',
                Deno.env.get(
                    'SUPABASE_SERVICE_ROLE_KEY'
                ) ?? ''
            )

        const {
            data: suit,
            error: suitError
        } = await supabaseAdmin
            .from('suits')
            .select(`
                id,
                title,
                file_no,
                court_name,
                description,
                suit_type,
                status,
                client_role,
                opposing_party,
                opposing_counsel,
                client_id,
                ip_record_id,
                task_id,
                transaction_type_id
            `)
            .eq(
                'id',
                suitId
            )
            .maybeSingle()

        if (
            suitError ||
            !suit
        ) {
            return jsonResponse({
                success: true,
                skipped: true,
                reason:
                    'task_not_linked_to_suit'
            })
        }

        const taskType =
            await getTransactionType(
                supabaseAdmin,
                taskTypeId
            )

        if (
            taskType?.ip_type &&
            String(
                taskType.ip_type
            ) !== 'suit'
        ) {
            return jsonResponse({
                success: true,
                skipped: true,
                reason:
                    'transaction_type_not_suit'
            })
        }

        // taskService.updateTask, status UPDATE'i yaptıktan sonra
        // task_documents ve task_history kayıtlarını yazar.
        // İlk kısa bekleme bu iki kaydın oturmasını sağlar.
        await sleep(1200)

        const taskForResolve = {
            ...record,
            details:
                parseObject(
                    record.details
                )
        }

        const workTx =
            await resolveTaskWorkTransaction(
                supabaseAdmin,
                taskForResolve,
                taskTypeId,
                suit.id
            )

        const currentStage =
            await resolveCurrentStage(
                supabaseAdmin,
                suit.id
            )

        const client =
            await resolveClient(
                supabaseAdmin,
                suit
            )

        const recipients =
            await resolveLitigationRecipients(
                supabaseAdmin,
                client,
                taskTypeId
            )

        const subjectAsset =
            await resolveSubjectAsset(
                supabaseAdmin,
                suit
            )

        const taskName =
            taskType?.alias ||
            taskType?.name ||
            record.title ||
            `Dava İşi ${taskTypeId}`

        const {
            templateId,
            template
        } = await resolveTemplate(
            supabaseAdmin,
            taskTypeId
        )

        const completionDate =
            formatDateTR(
                record.updated_at ||
                new Date()
                    .toISOString()
            )

        const placeholders = {
            "{{suitFileNo}}":
                clean(
                    suit.file_no ||
                    suit.title
                ),

            "{{courtName}}":
                clean(
                    suit.court_name
                ),

            "{{suitType}}":
                clean(
                    suit.suit_type
                ),

            "{{clientName}}":
                clean(
                    client.clientName
                ),

            "{{clientRole}}":
                formatRole(
                    suit.client_role
                ),

            "{{opposingParty}}":
                clean(
                    suit.opposing_party
                ),

            "{{subjectAsset}}":
                clean(
                    subjectAsset
                ),

            "{{completedTaskName}}":
                clean(
                    taskName
                ),

            "{{litigationStage}}":
                clean(
                    currentStage.label
                ),

            "{{stageInitiator}}":
                clean(
                    currentStage.initiator
                ),

            "{{completionDate}}":
                completionDate
        }

        const fallbackSubject =
            `${placeholders["{{suitFileNo}}"]} - ${placeholders["{{completedTaskName}}"]} Tamamlandı`

        const fallbackBody = `
<html>
<body style="font-family:Arial,Helvetica,sans-serif;color:#333;line-height:1.6;font-size:14px;">
<p>Sayın İlgili,</p>
<p><strong>${placeholders["{{suitFileNo}}"]}</strong> sayılı dava dosyasında <strong>${placeholders["{{completedTaskName}}"]}</strong> işlemi tamamlanmıştır.</p>
<div style="margin:18px 0;background:#f8fafc;border:1px solid #dbe3ec;border-radius:8px;padding:14px;">
<p><strong>Mahkeme / Merci:</strong> ${placeholders["{{courtName}}"]}</p>
<p><strong>Yargılama Aşaması:</strong> ${placeholders["{{litigationStage}}"]}</p>
<p><strong>Müvekkil:</strong> ${placeholders["{{clientName}}"]} (${placeholders["{{clientRole}}"]})</p>
<p><strong>Karşı Taraf:</strong> ${placeholders["{{opposingParty}}"]}</p>
<p><strong>Dava Konusu:</strong> ${placeholders["{{subjectAsset}}"]}</p>
<p><strong>Tamamlanma Tarihi:</strong> ${placeholders["{{completionDate}}"]}</p>
</div>
<p>İşlem kapsamında sisteme yüklenen dilekçe ve/veya belgeler mevcutsa bu bildirimin ekinde bilgilerinize sunulmuştur.</p>
<p>Saygılarımızla,<br><strong>EVREKA GROUP</strong></p>
</body>
</html>
        `.trim()

        let finalSubject =
            replacePlaceholders(
                template?.mail_subject ||
                template?.subject ||
                fallbackSubject,
                placeholders
            )

        let finalBody =
            replacePlaceholders(
                template?.body ||
                fallbackBody,
                placeholders
            )

        const unresolved = [
            ...new Set([
                ...(
                    finalSubject.match(
                        /\{\{[A-Za-z0-9_]+\}\}/g
                    ) || []
                ),
                ...(
                    finalBody.match(
                        /\{\{[A-Za-z0-9_]+\}\}/g
                    ) || []
                )
            ])
        ]

        const missingFields = []

        if (
            recipients.to.length === 0
        ) {
            missingFields.push(
                'recipients'
            )

            finalBody += `
<br><br><hr>
<p style="color:red;font-size:12px;">
<strong>⚠️ SİSTEM TEŞHİS BİLGİSİ:</strong><br>
Bu dava için litigation bildirim alıcısı bulunamadı.
Lütfen Kişiler / İlgili Kişiler ayarlarında
resp_litigation ve notify_litigation_to/cc alanlarını kontrol ediniz.
</p>
            `
        }

        if (!template) {
            // Mail gövdesi fallback ile yine doludur.
            // Operatör DB template ayarını görebilsin diye missing_info.
            missingFields.push(
                'template'
            )
        }

        if (
            unresolved.length > 0
        ) {
            console.warn(
                '[LITIGATION_TASK_MAIL] Çözülmemiş placeholder:',
                unresolved
            )

            missingFields.push(
                'template_placeholders'
            )
        }

        const finalStatus =
            missingFields.length > 0
                ? 'missing_info'
                : 'pending'

        const reuse =
            await findReusableGenericMail(
                supabaseAdmin,
                record.id
            )

        if (
            reuse.kind ===
            'already_litigation'
        ) {
            console.log(
                `[LITIGATION_TASK_MAIL] Duplicate önlendi. task=${record.id}, mail=${reuse.row.id}`
            )

            return jsonResponse({
                success: true,
                litigation: true,
                duplicatePrevented: true,
                mailId:
                    reuse.row.id
            })
        }

        const triggeredByUserId =
            await resolveTriggeredByUser(
                supabaseAdmin,
                taskForResolve
            )

        const dynamicContext =
            JSON.stringify({
                application_no:
                    suit.file_no ||
                    suit.title ||
                    '-',

                mark_name:
                    subjectAsset,

                suit_id:
                    suit.id,

                court_name:
                    suit.court_name ||
                    null,

                suit_type:
                    suit.suit_type ||
                    null,

                client_role:
                    suit.client_role ||
                    null,

                litigation_stage:
                    currentStage.key,

                litigation_stage_label:
                    currentStage.label,

                stage_initiator:
                    currentStage
                        .transaction
                        ?.suit_context
                        ?.stage_initiator ||
                    null,

                completed_task_type:
                    taskTypeId,

                completed_task_name:
                    taskName,

                work_transaction_id:
                    workTx?.id ||
                    null,

                litigation:
                    true
            })

        // Primary document id
        const {
            data: currentTaskDocs
        } = await supabaseAdmin
            .from('task_documents')
            .select(
                'id, document_type, uploaded_at'
            )
            .eq(
                'task_id',
                String(record.id)
            )
            .order(
                'uploaded_at',
                { ascending: false }
            )

        let primaryDocId =
            null

        if (
            currentTaskDocs &&
            currentTaskDocs.length > 0
        ) {
            const petition =
                currentTaskDocs.find(
                    (doc) =>
                        doc.document_type ===
                        'petition'
                )

            const epats =
                currentTaskDocs.find(
                    (doc) =>
                        doc.document_type ===
                        'epats_document'
                )

            primaryDocId =
                (
                    petition ||
                    epats ||
                    currentTaskDocs[0]
                )?.id ||
                null
        }

        const mailPayload = {
            client_id:
                client.clientId,

            associated_task_id:
                String(
                    record.id
                ),

            associated_transaction_id:
                workTx?.id
                    ? String(
                        workTx.id
                    )
                    : null,

            related_ip_record_id:
                String(
                    suit.id
                ),

            source_document_id:
                primaryDocId
                    ? String(
                        primaryDocId
                    )
                    : null,

            to_list:
                recipients.to,

            cc_list:
                recipients.cc,

            subject:
                finalSubject,

            body:
                finalBody,

            status:
                finalStatus,

            missing_fields:
                [...new Set(
                    missingFields
                )],

            is_draft:
                finalStatus ===
                'missing_info',

            mode:
                'draft',

            notification_type:
                'dava',

            template_id:
                templateId,

            source:
                'litigation_task_completion',

            triggered_by_user_id:
                triggeredByUserId,

            dynamic_parent_context:
                dynamicContext
        }

        let mailId = null

        if (
            reuse.kind ===
                'generic' &&
            reuse.row?.id
        ) {
            mailId =
                String(
                    reuse.row.id
                )

            const {
                error: updateError
            } = await supabaseAdmin
                .from(
                    'mail_notifications'
                )
                .update(
                    mailPayload
                )
                .eq(
                    'id',
                    mailId
                )

            if (updateError) {
                throw new Error(
                    `Mevcut task maili dava mailine dönüştürülemedi: ${updateError.message}`
                )
            }

            console.log(
                `[LITIGATION_TASK_MAIL] Generic mail row dava mailine dönüştürüldü. mail=${mailId}`
            )

        } else {
            mailId =
                crypto.randomUUID()

            const {
                error: insertError
            } = await supabaseAdmin
                .from(
                    'mail_notifications'
                )
                .insert({
                    id:
                        mailId,
                    ...mailPayload
                })

            if (insertError) {
                throw new Error(
                    `Dava task maili oluşturulamadı: ${insertError.message}`
                )
            }

            console.log(
                `[LITIGATION_TASK_MAIL] Yeni dava task maili oluşturuldu. mail=${mailId}`
            )
        }

        const attachmentSync =
            await syncAttachments(
                supabaseAdmin,
                mailId,
                record.id,
                workTx?.id ||
                    null
            )

        console.log(
            `[LITIGATION_TASK_MAIL] ✅ Tamamlandı. task=${record.id}, mail=${mailId}, to=${recipients.to.length}, cc=${recipients.cc.length}, attachments_added=${attachmentSync.addedCount}`
        )

        return jsonResponse({
            success: true,
            litigation: true,
            mailId,
            reusedGenericMail:
                reuse.kind ===
                'generic',

            taskId:
                record.id,

            taskTypeId,

            suitId:
                suit.id,

            workTransactionId:
                workTx?.id ||
                null,

            stage:
                currentStage.key,

            stageLabel:
                currentStage.label,

            templateId,

            toCount:
                recipients.to.length,

            ccCount:
                recipients.cc.length,

            attachmentCount:
                attachmentSync
                    .taskDocs
                    .length,

            status:
                finalStatus
        })

    } catch (error) {
        console.error(
            '[LITIGATION_TASK_MAIL] ❌ Hata:',
            error?.message ||
            error
        )

        return jsonResponse(
            {
                success: false,
                litigation: true,
                error:
                    error?.message ||
                    String(error)
            },
            400
        )
    }
})
