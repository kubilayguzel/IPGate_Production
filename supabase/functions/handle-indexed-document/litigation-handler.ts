// supabase/functions/handle-indexed-document/litigation-handler.ts
// IPGate Dava Yönetimi - AŞAMA 6A
//
// Bu modül SADECE incoming_documents.status = 'litigation_mail_ready'
// kayıtları için çağrılır.
//
// Tasarım ilkesi:
// - Mevcut marka/patent/design mail motoruna dokunmaz.
// - Dava alıcılarını persons_related litigation alanlarından çözer.
// - İç CC listesini evreka_mail_cc_list.transaction_types üzerinden çözer.
// - template_rules + mail_templates üzerinden DB-driven şablon kullanır.
// - Aynı source_document_id + transaction için duplicate mail üretmez.
// - incoming_documents.status değerini bu aşamada 'indexed'e ÇEVİRMEZ.
// - litigation_indexed aşamasında çağrılmaz; task/status otomasyonunun bitmesini bekler.

function jsonResponse(
    payload: Record<string, unknown>,
    status: number,
    corsHeaders: Record<string, string>
) {
    return new Response(
        JSON.stringify(payload),
        {
            status,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
            }
        }
    );
}

function clean(value: unknown, fallback = '-') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function normalizeEmail(value: unknown) {
    return String(value ?? '')
        .trim()
        .toLowerCase();
}

function uniqueEmails(values: unknown[]) {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const raw of values || []) {
        const email = normalizeEmail(raw);
        if (!email || seen.has(email)) continue;

        seen.add(email);
        result.push(email);
    }

    return result;
}

function normalizeTypeArray(raw: unknown): string[] {
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

function formatDateTR(value: unknown) {
    if (!value) return '-';

    try {
        const raw = String(value);

        // ISO / YYYY-MM-DD için gün kaymasını önlemek adına tarih parçasını doğrudan kullan.
        const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);

        if (isoMatch) {
            return `${isoMatch[3]}.${isoMatch[2]}.${isoMatch[1]}`;
        }

        const date = new Date(raw);

        if (Number.isNaN(date.getTime())) {
            return '-';
        }

        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');

        return `${day}.${month}.${date.getFullYear()}`;

    } catch {
        return '-';
    }
}

function formatRole(value: unknown) {
    const role = String(value ?? '')
        .toLocaleLowerCase('tr-TR')
        .trim();

    if (role === 'davaci') return 'Davacı';
    if (role === 'davali') return 'Davalı';
    if (role === 'mudahil') return 'Müdahil';

    return clean(value);
}

function replacePlaceholders(
    input: unknown,
    placeholders: Record<string, string>
) {
    let output = String(input ?? '');

    for (const [key, value] of Object.entries(placeholders)) {
        output = output.replaceAll(key, String(value ?? ''));
    }

    return output;
}

async function getTransactionType(
    supabaseAdmin: any,
    typeId: unknown
) {
    if (!typeId) return null;

    const { data, error } = await supabaseAdmin
        .from('transaction_types')
        .select('id, name, alias, ip_type')
        .eq('id', String(typeId))
        .maybeSingle();

    if (error) {
        console.warn(
            '[HANDLE_INDEXED_LITIGATION] transaction type okunamadı:',
            error
        );
    }

    return data || null;
}

async function resolveClient(
    supabaseAdmin: any,
    suit: any
) {
    let clientId = suit?.client_id
        ? String(suit.client_id)
        : null;

    const role = String(
        suit?.client_role || ''
    )
        .toLocaleLowerCase('tr-TR')
        .trim();

    // Eski suit kayıtları için client_id fallback.
    if (!clientId && role) {
        const { data: party, error } = await supabaseAdmin
            .from('suit_parties')
            .select('person_id')
            .eq('suit_id', String(suit.id))
            .eq('role', role)
            .not('person_id', 'is', null)
            .limit(1)
            .maybeSingle();

        if (error) {
            console.warn(
                '[HANDLE_INDEXED_LITIGATION] suit_parties client fallback hatası:',
                error
            );
        }

        if (party?.person_id) {
            clientId = String(party.person_id);
        }
    }

    let clientName = '-';
    let directEmail: string | null = null;

    if (clientId) {
        const { data: person, error } = await supabaseAdmin
            .from('persons')
            .select('id, name, email')
            .eq('id', clientId)
            .maybeSingle();

        if (error) {
            console.warn(
                '[HANDLE_INDEXED_LITIGATION] persons client okuma hatası:',
                error
            );
        }

        if (person) {
            clientName = clean(person.name);
            directEmail = person.email
                ? normalizeEmail(person.email)
                : null;
        }
    }

    return {
        clientId,
        clientName,
        directEmail
    };
}

async function resolveLitigationRecipients(
    supabaseAdmin: any,
    client: {
        clientId: string | null;
        clientName: string;
        directEmail: string | null;
    },
    transactionTypeId: string
) {
    const to: string[] = [];
    const cc: string[] = [];

    if (client.clientId) {
        const { data: relatedRows, error } = await supabaseAdmin
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
            );

        if (error) {
            console.warn(
                '[HANDLE_INDEXED_LITIGATION] persons_related okunamadı:',
                error
            );
        }

        for (const row of relatedRows || []) {
            if (
                !row?.email ||
                !row?.resp_litigation
            ) {
                continue;
            }

            const email = normalizeEmail(row.email);

            if (!email) continue;

            if (row.notify_litigation_to) {
                to.push(email);
            }

            if (row.notify_litigation_cc) {
                cc.push(email);
            }

            // Mevcut marka motoruyla aynı fallback:
            // sorumlu kişi ama To/CC tercihi işaretlenmemişse To.
            if (
                !row.notify_litigation_to &&
                !row.notify_litigation_cc
            ) {
                to.push(email);
            }
        }
    }

    let finalTo = uniqueEmails(to);
    let clientCc = uniqueEmails(cc);

    // Mevcut motorla aynı davranış: yalnız CC tanımlıysa ilk CC'yi To'ya al.
    if (
        finalTo.length === 0 &&
        clientCc.length > 0
    ) {
        finalTo = [clientCc[0]];
        clientCc = clientCc.slice(1);
    }

    // Hiç litigation contact bulunamazsa doğrudan persons.email fallback.
    if (
        finalTo.length === 0 &&
        client.directEmail
    ) {
        finalTo = [
            normalizeEmail(
                client.directEmail
            )
        ];
    }

    const { data: internalRows, error: internalError } =
        await supabaseAdmin
            .from('evreka_mail_cc_list')
            .select('email, transaction_types');

    if (internalError) {
        console.warn(
            '[HANDLE_INDEXED_LITIGATION] Evreka internal CC listesi okunamadı:',
            internalError
        );
    }

    const internalCc: string[] = [];

    for (const row of internalRows || []) {
        if (!row?.email) continue;

        const types =
            normalizeTypeArray(
                row.transaction_types
            );

        if (
            types.includes('All') ||
            types.includes(
                String(transactionTypeId)
            )
        ) {
            internalCc.push(
                normalizeEmail(row.email)
            );
        }
    }

    const toSet = new Set(
        finalTo.map(normalizeEmail)
    );

    const finalCc = uniqueEmails([
        ...clientCc,
        ...internalCc
    ]).filter(
        (email) => !toSet.has(email)
    );

    return {
        to: finalTo,
        cc: finalCc
    };
}

async function resolveSubjectAsset(
    supabaseAdmin: any,
    suit: any
) {
    if (!suit?.ip_record_id) {
        return clean(suit?.title);
    }

    const { data, error } = await supabaseAdmin
        .from('portfolio_list_view')
        .select('*')
        .eq(
            'id',
            String(suit.ip_record_id)
        )
        .maybeSingle();

    if (error) {
        console.warn(
            '[HANDLE_INDEXED_LITIGATION] Dava konusu portföy okunamadı:',
            error
        );
    }

    if (!data) {
        return clean(suit?.title);
    }

    const name =
        data.brand_name ||
        data.title ||
        data.application_number ||
        data.registration_number ||
        suit?.title ||
        '-';

    const number =
        data.application_number ||
        data.registration_number ||
        null;

    return number
        ? `${name} (${number})`
        : clean(name);
}

async function resolveTriggeredTask(
    supabaseAdmin: any,
    transaction: any
) {
    let task: any = null;

    // Aşama 5/5S task'ı incoming transaction_id üzerinden oluşturur.
    const { data: sourceTask, error } = await supabaseAdmin
        .from('tasks')
        .select(`
            id,
            title,
            task_type_id,
            status,
            task_owner_id,
            official_due_date,
            operational_due_date,
            details,
            created_at
        `)
        .eq(
            'transaction_id',
            String(transaction.id)
        )
        .order(
            'created_at',
            { ascending: false }
        )
        .limit(1)
        .maybeSingle();

    if (error) {
        console.warn(
            '[HANDLE_INDEXED_LITIGATION] Trigger task aranırken hata:',
            error
        );
    }

    task = sourceTask || null;

    // Eski / ara test kayıtları için source tx.task_id fallback.
    if (
        !task &&
        transaction?.task_id &&
        transaction.task_id !== 'manual_entry'
    ) {
        const { data: linkedTask, error: linkedError } =
            await supabaseAdmin
                .from('tasks')
                .select(`
                    id,
                    title,
                    task_type_id,
                    status,
                    task_owner_id,
                    official_due_date,
                    operational_due_date,
                    details,
                    created_at
                `)
                .eq(
                    'id',
                    String(transaction.task_id)
                )
                .maybeSingle();

        if (linkedError) {
            console.warn(
                '[HANDLE_INDEXED_LITIGATION] transaction.task_id fallback hatası:',
                linkedError
            );
        }

        task = linkedTask || null;
    }

    if (!task) {
        return {
            task: null,
            taskType: null,
            taskName: '-'
        };
    }

    const taskType =
        await getTransactionType(
            supabaseAdmin,
            task.task_type_id
        );

    const taskName =
        taskType?.alias ||
        taskType?.name ||
        task.title ||
        '-';

    return {
        task,
        taskType,
        taskName
    };
}

export async function handleLitigationIndexed(
    record: any,
    supabaseAdmin: any,
    corsHeaders: Record<string, string>
) {
    console.log(
        `[HANDLE_INDEXED_LITIGATION] Başladı. incoming=${record?.id}, suit=${record?.ip_record_id}, tx=${record?.created_transaction_id}, type=${record?.transaction_type_id}`
    );

    try {
        if (record?.status !== 'litigation_mail_ready') {
            return jsonResponse(
                {
                    success: true,
                    skipped: true,
                    reason: 'status_not_litigation_mail_ready'
                },
                200,
                corsHeaders
            );
        }

        const sourceDocumentId =
            clean(record?.id, '');

        const suitId =
            clean(record?.ip_record_id, '');

        const transactionId =
            clean(
                record?.created_transaction_id,
                ''
            );

        let transactionTypeId =
            clean(
                record?.transaction_type_id,
                ''
            );

        if (
            !sourceDocumentId ||
            !suitId ||
            !transactionId
        ) {
            throw new Error(
                'Dava maili için incoming document, suit veya transaction kimliği eksik.'
            );
        }

        // Duplicate guard: aynı incoming + aynı transaction için ikinci mail yok.
        const {
            data: existingMail,
            error: duplicateError
        } = await supabaseAdmin
            .from('mail_notifications')
            .select('id, status, template_id')
            .eq(
                'source_document_id',
                sourceDocumentId
            )
            .eq(
                'associated_transaction_id',
                transactionId
            )
            .limit(1)
            .maybeSingle();

        if (duplicateError) {
            throw duplicateError;
        }

        if (existingMail) {
            console.log(
                `[HANDLE_INDEXED_LITIGATION] Duplicate önlendi. mail=${existingMail.id}`
            );

            return jsonResponse(
                {
                    success: true,
                    duplicatePrevented: true,
                    mailId: existingMail.id
                },
                200,
                corsHeaders
            );
        }

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
            .maybeSingle();

        if (
            suitError ||
            !suit
        ) {
            throw suitError ||
                new Error(
                    `Dava bulunamadı: ${suitId}`
                );
        }

        const {
            data: transaction,
            error: transactionError
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
                task_id
            `)
            .eq(
                'id',
                transactionId
            )
            .maybeSingle();

        if (
            transactionError ||
            !transaction
        ) {
            throw transactionError ||
                new Error(
                    `Dava transaction bulunamadı: ${transactionId}`
                );
        }

        if (
            String(transaction.ip_record_id || '') !==
            String(suit.id)
        ) {
            throw new Error(
                'Dava transaction / suit kimlik bütünlüğü doğrulanamadı.'
            );
        }

        if (!transactionTypeId) {
            transactionTypeId =
                clean(
                    transaction.transaction_type_id,
                    ''
                );
        }

        const incomingType =
            await getTransactionType(
                supabaseAdmin,
                transactionTypeId
            );

        if (
            incomingType?.ip_type &&
            incomingType.ip_type !== 'suit'
        ) {
            throw new Error(
                `Litigation branch'e suit dışı transaction type geldi: ${transactionTypeId}`
            );
        }

        let parentType: any = null;

        if (transaction.parent_id) {
            const {
                data: parentTx,
                error: parentTxError
            } = await supabaseAdmin
                .from('transactions')
                .select('transaction_type_id')
                .eq(
                    'id',
                    String(transaction.parent_id)
                )
                .maybeSingle();

            if (parentTxError) {
                console.warn(
                    '[HANDLE_INDEXED_LITIGATION] Parent transaction okunamadı:',
                    parentTxError
                );
            }

            if (parentTx?.transaction_type_id) {
                parentType =
                    await getTransactionType(
                        supabaseAdmin,
                        parentTx.transaction_type_id
                    );
            }
        }

        const client =
            await resolveClient(
                supabaseAdmin,
                suit
            );

        const recipients =
            await resolveLitigationRecipients(
                supabaseAdmin,
                client,
                transactionTypeId
            );

        const subjectAsset =
            await resolveSubjectAsset(
                supabaseAdmin,
                suit
            );

        const {
            task,
            taskName
        } = await resolveTriggeredTask(
            supabaseAdmin,
            transaction
        );

        const {
            data: rule,
            error: ruleError
        } = await supabaseAdmin
            .from('template_rules')
            .select('template_id')
            .eq(
                'source_type',
                'document'
            )
            .eq(
                'sub_process_type',
                transactionTypeId
            )
            .eq(
                'main_process_type',
                'suit'
            )
            .limit(1)
            .maybeSingle();

        if (ruleError) {
            throw ruleError;
        }

        if (!rule?.template_id) {
            throw new Error(
                `Dava template rule bulunamadı. transaction_type=${transactionTypeId}`
            );
        }

        const templateId =
            String(rule.template_id);

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
            .maybeSingle();

        if (
            templateError ||
            !template
        ) {
            throw templateError ||
                new Error(
                    `Dava mail template bulunamadı: ${templateId}`
                );
        }

        const incomingTypeName =
            incomingType?.alias ||
            incomingType?.name ||
            transaction.description ||
            `İşlem ${transactionTypeId}`;

        const suitTypeName =
            suit.suit_type ||
            parentType?.alias ||
            parentType?.name ||
            '-';

        const officialDeadline =
            task?.official_due_date
                ? formatDateTR(
                    task.official_due_date
                )
                : '-';

        const operationalDeadline =
            task?.operational_due_date
                ? formatDateTR(
                    task.operational_due_date
                )
                : '-';

        const hasTask =
            Boolean(task);

        const hasDeadline =
            Boolean(
                task?.official_due_date
            );

        const placeholders: Record<string, string> = {
            "{{suitFileNo}}":
                clean(
                    suit.file_no ||
                    suit.title
                ),

            "{{courtName}}":
                clean(suit.court_name),

            "{{suitType}}":
                clean(suitTypeName),

            "{{clientName}}":
                clean(client.clientName),

            "{{clientRole}}":
                formatRole(
                    suit.client_role
                ),

            "{{opposingParty}}":
                clean(
                    suit.opposing_party
                ),

            "{{subjectAsset}}":
                clean(subjectAsset),

            "{{documentType}}":
                clean(incomingTypeName),

            "{{teblig_tarihi}}":
                formatDateTR(
                    record.teblig_tarihi ||
                    transaction.transaction_date
                ),

            "{{triggeredTaskName}}":
                clean(taskName),

            "{{resmi_son_cevap_tarihi}}":
                officialDeadline,

            "{{operationalDueDate}}":
                operationalDeadline,

            "{{task_section_display}}":
                hasTask
                    ? 'display:block;'
                    : 'display:none;',

            "{{deadline_section_display}}":
                hasDeadline
                    ? 'display:block;'
                    : 'display:none;'
        };

        let finalSubject =
            replacePlaceholders(
                template.mail_subject ||
                template.subject ||
                'Dava Evrak Bildirimi',
                placeholders
            );

        let finalBody =
            replacePlaceholders(
                template.body ||
                'Dava dosyanıza yeni bir evrak eklenmiştir.',
                placeholders
            );

        // Şablonda unutulmuş dava placeholder'ı varsa logla;
        // mail oluşturmayı durdurma ki missing_info / operatör kontrolü mümkün olsun.
        const unresolved = [
            ...new Set(
                [
                    ...(finalSubject.match(/\{\{[A-Za-z0-9_]+\}\}/g) || []),
                    ...(finalBody.match(/\{\{[A-Za-z0-9_]+\}\}/g) || [])
                ]
            )
        ];

        if (unresolved.length > 0) {
            console.warn(
                '[HANDLE_INDEXED_LITIGATION] Çözülmemiş placeholder:',
                unresolved
            );
        }

        if (recipients.to.length === 0) {
            finalBody += `
                <br><br>
                <hr>
                <p style="color:red;font-size:12px;">
                    <strong>⚠️ SİSTEM TEŞHİS BİLGİSİ:</strong><br>
                    Bu dava için litigation bildirim alıcısı bulunamadı.
                    Lütfen müvekkilin Kişiler / İlgili Kişiler ayarlarında
                    resp_litigation ve notify_litigation_to/cc alanlarını kontrol ediniz.
                </p>
            `;
        }

        const mailId =
            crypto.randomUUID();

        const finalStatus =
            recipients.to.length === 0
                ? 'missing_info'
                : 'pending';

        const deadlineRaw =
            task?.official_due_date ||
            null;

        const mailPayload = {
            id:
                mailId,

            related_ip_record_id:
                String(suit.id),

            associated_task_id:
                task?.id
                    ? String(task.id)
                    : null,

            source_document_id:
                sourceDocumentId,

            associated_transaction_id:
                transactionId,

            template_id:
                templateId,

            to_list:
                recipients.to,

            cc_list:
                recipients.cc,

            client_id:
                client.clientId,

            subject:
                finalSubject,

            body:
                finalBody,

            status:
                finalStatus,

            mode:
                'draft',

            objection_deadline:
                deadlineRaw,

            dynamic_parent_context:
                JSON.stringify({
                    application_no:
                        suit.file_no ||
                        suit.title ||
                        '-',

                    mark_name:
                        subjectAsset,

                    doc_type:
                        incomingTypeName,

                    deadline:
                        officialDeadline,

                    suit_id:
                        suit.id,

                    court_name:
                        suit.court_name ||
                        null,

                    suit_type:
                        suitTypeName,

                    client_role:
                        suit.client_role ||
                        null,

                    litigation:
                        true
                }),

            notification_type:
                'dava',

            source:
                'document_index',

            is_draft:
                finalStatus ===
                'missing_info',

            missing_fields:
                recipients.to.length === 0
                    ? ['recipients']
                    : []
        };

        const {
            error: mailInsertError
        } = await supabaseAdmin
            .from('mail_notifications')
            .insert(mailPayload);

        if (mailInsertError) {
            throw new Error(
                `Dava mail_notifications kaydı oluşturulamadı: ${mailInsertError.message}`
            );
        }

        const attachments: any[] = [];
        const urls = new Set<string>();

        // AŞAMA 4 transaction_documents kaydı ana ek kaynağı.
        const {
            data: txDocs,
            error: txDocsError
        } = await supabaseAdmin
            .from('transaction_documents')
            .select(`
                document_name,
                document_url
            `)
            .eq(
                'transaction_id',
                transactionId
            );

        if (txDocsError) {
            console.warn(
                '[HANDLE_INDEXED_LITIGATION] transaction_documents okunamadı:',
                txDocsError
            );
        }

        for (const doc of txDocs || []) {
            const url =
                clean(
                    doc.document_url,
                    ''
                );

            if (
                !url ||
                urls.has(url)
            ) {
                continue;
            }

            urls.add(url);

            attachments.push({
                notification_id:
                    mailId,

                file_name:
                    clean(
                        doc.document_name,
                        'Mahkeme_Evraki.pdf'
                    ),

                storage_path:
                    null,

                url
            });
        }

        // incoming_documents.file_url fallback.
        const sourceUrl =
            clean(
                record.file_url,
                ''
            );

        if (
            sourceUrl &&
            !urls.has(sourceUrl)
        ) {
            urls.add(sourceUrl);

            attachments.push({
                notification_id:
                    mailId,

                file_name:
                    clean(
                        record.file_name,
                        'Mahkeme_Evraki.pdf'
                    ),

                storage_path:
                    record.file_path ||
                    null,

                url:
                    sourceUrl
            });
        }

        if (attachments.length > 0) {
            const {
                error: attachmentError
            } = await supabaseAdmin
                .from('mail_attachments')
                .insert(attachments);

            if (attachmentError) {
                // Mail kaydını kaybetme; operatör maili görebilsin.
                console.warn(
                    '[HANDLE_INDEXED_LITIGATION] Mail attachment eklenemedi:',
                    attachmentError
                );
            }
        }

        console.log(
            `[HANDLE_INDEXED_LITIGATION] ✅ Mail taslağı oluşturuldu. mail=${mailId}, to=${recipients.to.length}, cc=${recipients.cc.length}`
        );

        return jsonResponse(
            {
                success: true,
                litigation: true,
                mailId,
                templateId,
                toCount:
                    recipients.to.length,
                ccCount:
                    recipients.cc.length,
                taskId:
                    task?.id || null,
                status:
                    finalStatus
            },
            200,
            corsHeaders
        );

    } catch (error: any) {
        console.error(
            '[HANDLE_INDEXED_LITIGATION] ❌ Hata:',
            error?.message ||
            error
        );

        return jsonResponse(
            {
                success: false,
                litigation: true,
                error:
                    error?.message ||
                    String(error)
            },
            400,
            corsHeaders
        );
    }
}
