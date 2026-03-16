import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const payload = await req.json();
    const { type, record, old_record } = payload;

    if (!['INSERT', 'UPDATE'].includes(type) || !record) {
      return new Response("İlgisiz işlem, atlandı.", { status: 200 });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    let viewData: any = null;
    const targetIpRecordId = record.ip_record_id || record.details?.relatedIpRecordId || record.details?.ip_record_id || record.related_ip_record_id;

    // 🔥 YENİ EKLENEN KISIM: İşlemi Tetikleyen Kullanıcıyı Bul
    let triggeredByUserId = null;
    const associatedTxId = record.transaction_id || record.details?.transactionId || record.details?.associated_transaction_id;
    
    if (associatedTxId) {
        const { data: txData } = await supabaseAdmin.from('transactions').select('user_id').eq('id', associatedTxId).maybeSingle();
        if (txData && txData.user_id) triggeredByUserId = txData.user_id;
    }
    if (!triggeredByUserId && record.created_by) {
        triggeredByUserId = record.created_by;
    }


    if (targetIpRecordId) {
        const { data } = await supabaseAdmin.from('portfolio_list_view').select('*').eq('id', targetIpRecordId).single();
        if (data) viewData = data;
    }

    const brandName = viewData?.brand_name || record.details?.iprecordTitle || record.title || "-";
    const appNo = viewData?.application_number || viewData?.registration_number || record.details?.iprecordApplicationNo || record.details?.applicationNo || "-";
    const applicantNames = viewData?.applicant_names || "-";
    const taskTypeId = String(record.task_type_id || '');
    
    let renewalDateText = "-";
    if (viewData?.renewal_date) {
        renewalDateText = new Date(viewData.renewal_date).toLocaleDateString('tr-TR');
    }

    const transactionDate = new Date().toLocaleDateString('tr-TR');

    const imgUrl = viewData?.brand_image_url || record.details?.brandImageUrl || "";

    const emailParams: Record<string, string> = {
        "{{applicationNo}}": appNo,
        "{{markName}}": brandName,
        "{{is_basligi}}": record.title || "",
        "{{relatedIpRecordTitle}}": brandName,
        "{{applicantNames}}": applicantNames,
        "{{transactionDate}}": transactionDate,
        "{{renewalDate}}": renewalDateText,
        "{{markImageUrl}}": imgUrl 
    };

    // 🔥 ÇÖZÜM: Evreka İçi CC Listesi (evreka_mail_cc_list) koda dahil edildi
    async function getRecipients(viewData: any, record: any, currentTaskType: string) {
        const to: string[] = [];
        const cc: string[] = [];
        let personIds: string[] = [];
        
        if (viewData?.record_owner_type === 'third_party' && record.task_owner_id) {
            personIds = [record.task_owner_id];
        } else if (viewData?.applicants_json) {
            personIds = viewData.applicants_json.map((a: any) => a.id).filter(Boolean);
        }
        
        // 1. Müşteri (Client) Tarafındaki Alıcılar (TO ve CC)
        if (personIds && personIds.length > 0) {
            const { data: prData } = await supabaseAdmin.from('persons_related').select('*').in('person_id', personIds).eq('resp_trademark', true);
            if (prData) {
                for (const pr of prData) {
                    if (pr.email) {
                        if (pr.notify_trademark_to) to.push(pr.email);
                        if (pr.notify_trademark_cc) cc.push(pr.email);
                        if (!pr.notify_trademark_to && !pr.notify_trademark_cc) to.push(pr.email); 
                    }
                }
            }
        }

        // 2. Evreka İçi Otomatik CC Listesi (evreka_mail_cc_list)
        const { data: internalCcs } = await supabaseAdmin.from('evreka_mail_cc_list').select('email, transaction_types');
        if (internalCcs && internalCcs.length > 0) {
            internalCcs.forEach((internal: any) => {
                if (internal.email) {
                    const types = internal.transaction_types || [];
                    // Görev tipi eşleşiyorsa veya "All" ise CC'ye ekle
                    if (types.includes('All') || types.includes(currentTaskType) || types.includes(Number(currentTaskType))) {
                        cc.push(internal.email.trim().toLowerCase());
                    }
                }
            });
        }

        // Tekilleştirme: Aynı kişi iki kere yazılmasın ve TO listesinde olan biri CC'de gözükmesin
        const finalTo = [...new Set(to)].filter(Boolean);
        const finalCc = [...new Set(cc)].filter(Boolean).filter(e => !finalTo.includes(e));

        return { to: finalTo, cc: finalCc };
    }

    // YENİ GÖREV (INSERT)
    if (type === 'INSERT' && taskTypeId === '22' && record.status === 'awaiting_client_approval') {
        let subject = `${appNo} - "${brandName}" - Marka Yenileme İşlemi / Talimat Bekleniyor`;
        let body = record.description || "Yenileme işlemi için onayınızı rica ederiz.";
        let templateId = null;

        const { data: ruleData } = await supabaseAdmin.from('template_rules').select('template_id').eq('source_type', 'task').eq('task_type', '22').maybeSingle();
        if (ruleData && ruleData.template_id) {
            templateId = ruleData.template_id;
            const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body').eq('id', templateId).maybeSingle();
            if (tmplData) {
                subject = tmplData.mail_subject || tmplData.subject || subject;
                let rawBody = tmplData.body || body;
                for (const [k, v] of Object.entries(emailParams)) {
                    subject = subject.replaceAll(k, String(v));
                    rawBody = rawBody.replaceAll(k, String(v));
                }
                body = rawBody;
            }
        }

        let { to, cc } = await getRecipients(viewData, record, taskTypeId);
        const missingFields = [];
        if (to.length === 0 && cc.length === 0) missingFields.push("recipients");

        await supabaseAdmin.from('mail_notifications').insert({
            id: crypto.randomUUID(),
            associated_task_id: record.id,
            associated_transaction_id: record.transaction_id || record.details?.transactionId || record.details?.associated_transaction_id || null,
            related_ip_record_id: targetIpRecordId,
            client_id: record.task_owner_id || (viewData?.applicants_json?.[0]?.id || null),
            to_list: to,
            cc_list: cc,
            subject: subject,
            body: body,
            status: missingFields.length > 0 ? "missing_info" : "awaiting_client_approval",
            missing_fields: missingFields,
            is_draft: true,
            mode: "draft",
            notification_type: "marka",
            template_id: templateId,
            source: "task_renewal_auto",
            triggered_by_user_id: triggeredByUserId
        });
    }

    // GÜNCELLEME (UPDATE)
    if (type === 'UPDATE' && old_record) {
        const hadMainEpats = !!(old_record.details?.epatsDocument);
        const hasMainEpats = !!(record.details?.epatsDocument);
        
        if (hadMainEpats && !hasMainEpats) {
            await supabaseAdmin.from('mail_notifications').delete().eq('associated_task_id', record.id).in('status', ['draft', 'awaiting_client_approval', 'missing_info', 'pending', 'evaluation_pending']);
        }

        const becameCompleted = old_record.status !== 'completed' && record.status === 'completed';
        const wasAwaiting = ['awaiting_client_approval', 'awaiting-approval'].includes(old_record.status);
        const clientApproved = wasAwaiting && record.status === 'open';
        const clientClosed = wasAwaiting && ['client_approval_closed', 'client_no_response_closed'].includes(record.status);

        if (becameCompleted && !['53', '66'].includes(taskTypeId)) {
            let templateId = null;
            const { data: ruleData } = await supabaseAdmin.from('template_rules').select('template_id').eq('source_type', 'task_completion_epats').eq('task_type', taskTypeId).maybeSingle();
            if (ruleData) templateId = ruleData.template_id;

            let subject = "İşleminiz Tamamlandı";
            let body = "İlgili görev tamamlanmıştır.";
            let hasTemplate = false;

            if (templateId) {
                const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body, body1, body2').eq('id', templateId).maybeSingle();
                if (tmplData) {
                    hasTemplate = true;
                    subject = tmplData.mail_subject || tmplData.subject || subject;
                    const recordOwnerType = viewData?.record_owner_type || 'self';
                    
                    if (templateId === 'tmpl_50_document') {
                        if (recordOwnerType === 'third_party' && tmplData.body2) body = tmplData.body2;
                        else if (recordOwnerType === 'self' && tmplData.body1) body = tmplData.body1;
                        else body = tmplData.body || body;
                    } else {
                        body = tmplData.body || body;
                    }

                    for (const [k, v] of Object.entries(emailParams)) {
                        subject = subject.replaceAll(k, String(v));
                        body = body.replaceAll(k, String(v));
                    }
                }
            }

            let { to, cc } = await getRecipients(viewData, record, taskTypeId);
            const missingFields = [];
            if (to.length === 0) missingFields.push("recipients"); // 🔥 CC kontrolü kaldırıldı
            if (!hasTemplate) missingFields.push("template");

            await supabaseAdmin.from('mail_notifications').insert({
                id: crypto.randomUUID(),
                associated_task_id: record.id,
                associated_transaction_id: record.transaction_id || record.details?.transactionId || record.details?.associated_transaction_id || null,
                related_ip_record_id: targetIpRecordId,
                to_list: to,
                cc_list: cc,
                subject: subject,
                body: body,
                status: missingFields.length > 0 ? "missing_info" : "pending",
                missing_fields: missingFields,
                is_draft: false,
                mode: "draft",
                notification_type: "marka",
                template_id: templateId,
                source: "task_completion",
                triggered_by_user_id: triggeredByUserId
            });
        }

        if (clientApproved) {
            try {
                const { data: counterData } = await supabaseAdmin.from('counters').select('last_id').eq('id', 'tasks_accruals').single();
                let currentCount = counterData ? Number(counterData.last_id) : 0;
                currentCount++;
                const newAccrualId = `T-${currentCount}`;
                const { data: assignData } = await supabaseAdmin.from('task_assignments').select('assignee_ids').eq('id', '53').single();
                const assignedUid = assignData?.assignee_ids?.[0] || null;

                await supabaseAdmin.from('tasks').insert({
                    id: newAccrualId,
                    task_type_id: "53",
                    title: `Tahakkuk Oluşturma: ${record.title || ''}`,
                    description: `"${record.title || ''}" işi onaylandı. Lütfen finansal kaydı oluşturun.`,
                    priority: 'high',
                    status: 'pending',
                    assigned_to: assignedUid,
                    task_owner_id: record.task_owner_id,
                    ip_record_id: targetIpRecordId,
                    details: { 
                        parent_task_id: record.id, 
                        originalTaskType: taskTypeId,
                        iprecordApplicationNo: appNo,
                        iprecordTitle: brandName,
                        iprecordApplicantName: applicantNames
                    }
                });
                await supabaseAdmin.from('counters').upsert({ id: 'tasks_accruals', last_id: currentCount });
            } catch (accErr) { console.error("Tahakkuk görev hatası:", accErr); }

            const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body').eq('id', 'tmpl_clientInstruction_1').maybeSingle();
            let subject = tmplData?.mail_subject || tmplData?.subject || "{{relatedIpRecordTitle}} - Talimatınız Alındı";
            let body = tmplData?.body || "<p>Talimatınız alınmıştır, işlem başlatılıyor.</p>";

            for (const [k, v] of Object.entries(emailParams)) {
                subject = subject.replaceAll(k, String(v));
                body = body.replaceAll(k, String(v));
            }

            let { to, cc } = await getRecipients(viewData, record, taskTypeId);
            await supabaseAdmin.from('mail_notifications').insert({
                id: crypto.randomUUID(),
                associated_task_id: record.id,
                related_ip_record_id: targetIpRecordId,
                to_list: to,
                cc_list: cc,
                subject: subject,
                body: body,
                status: "pending",
                notification_type: "general_notification",
                source: "auto_instruction_response",
                is_draft: false,
                triggered_by_user_id: triggeredByUserId
            });
        }

        if (clientClosed) {
            const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body').eq('id', 'tmpl_clientInstruction_2').maybeSingle();
            let subject = tmplData?.mail_subject || tmplData?.subject || "{{relatedIpRecordTitle}} - Dosya Kapatıldı";
            let body = tmplData?.body || "<p>Talimatınız üzerine dosya kapatılmıştır.</p>";

            for (const [k, v] of Object.entries(emailParams)) {
                subject = subject.replaceAll(k, String(v));
                body = body.replaceAll(k, String(v));
            }

            let { to, cc } = await getRecipients(viewData, record, taskTypeId);
            await supabaseAdmin.from('mail_notifications').insert({
                id: crypto.randomUUID(),
                associated_task_id: record.id,
                related_ip_record_id: targetIpRecordId,
                to_list: to,
                cc_list: cc,
                subject: subject,
                body: body,
                status: "pending",
                notification_type: "general_notification",
                source: "auto_instruction_response",
                is_draft: false,
                triggered_by_user_id: triggeredByUserId
            });
        }
    }
    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
  }
});