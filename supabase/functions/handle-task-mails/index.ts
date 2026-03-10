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

    // ==========================================
    // ORTAK VERİLERİ (IP RECORD & MÜŞTERİ) ÇEK
    // ==========================================
    let ipRecordData: any = null;
    let applicants: any[] = [];
    let tmDetails: any = null;

    const targetIpRecordId = record.ip_record_id || record.details?.ip_record_id || record.related_ip_record_id;

    if (targetIpRecordId) {
        const { data: ipData } = await supabaseAdmin.from('ip_records')
            .select(`*, ip_record_trademark_details(brand_name, brand_image_url), ip_record_applicants(person_id, persons(name))`)
            .eq('id', targetIpRecordId)
            .single();
        
        if (ipData) {
            ipRecordData = ipData;
            applicants = ipData.ip_record_applicants || [];
            
            // 🔥 ÇÖZÜM: İlişkinin object veya array dönmesine karşı %100 güvenli kontrol
            if (ipData.ip_record_trademark_details) {
                tmDetails = Array.isArray(ipData.ip_record_trademark_details) 
                            ? ipData.ip_record_trademark_details[0] 
                            : ipData.ip_record_trademark_details;
            }
        }
    }

    // Marka ve Başvuru Numaralarını garantili bir şekilde atıyoruz
    const rawBrandName = tmDetails?.brand_name || ipRecordData?.brand_name || ipRecordData?.title || record.details?.iprecordTitle || record.title;
    const rawAppNo = ipRecordData?.application_number || record.details?.iprecordApplicationNo || ipRecordData?.registration_number;

    const brandName = rawBrandName ? String(rawBrandName) : "-";
    const appNo = rawAppNo ? String(rawAppNo) : "-";
    const taskTypeId = String(record.task_type_id || '');

    async function getRecipients(personIds: string[], processType: string = 'trademark') {
        const to: string[] = [];
        const cc: string[] = [];
        if (!personIds || personIds.length === 0) return { to, cc };

        const { data: prData } = await supabaseAdmin.from('persons_related')
            .select('*')
            .in('person_id', personIds)
            .eq('resp_trademark', true);

        if (prData) {
            for (const pr of prData) {
                if (pr.email) {
                    if (pr.notify_trademark_to) to.push(pr.email);
                    if (pr.notify_trademark_cc) cc.push(pr.email);
                    if (!pr.notify_trademark_to && !pr.notify_trademark_cc) to.push(pr.email); 
                }
            }
        }
        return { to: [...new Set(to)].filter(Boolean), cc: [...new Set(cc)].filter(Boolean) };
    }

    // =========================================================================
    // SENARYO 0: YENİ GÖREV OLUŞTURULDU (INSERT) -> YENİLEME MAİLİ TASLAĞI
    // =========================================================================
    if (type === 'INSERT' && taskTypeId === '22' && record.status === 'awaiting_client_approval') {
        let subject = `${appNo} - "${brandName}" - Marka Yenileme İşlemi / Talimat Bekleniyor`;
        let body = record.description || "Yenileme işlemi için onayınızı rica ederiz.";
        let templateId = null;

        const { data: ruleData } = await supabaseAdmin.from('template_rules').select('template_id').eq('source_type', 'task').eq('task_type', '22').maybeSingle();

        if (ruleData && ruleData.template_id) {
            templateId = ruleData.template_id;
            const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body, body1, body2').eq('id', templateId).maybeSingle();
            
            if (tmplData) {
                subject = tmplData.mail_subject || tmplData.subject || subject;
                let rawBody = tmplData.body || body;

                let renewalDateText = "-";
                const renDate = ipRecordData?.protection_end_date || ipRecordData?.renewal_date;
                if (renDate) renewalDateText = new Date(renDate).toLocaleDateString('tr-TR');

                const params: Record<string, string> = {
                    "{{applicationNo}}": appNo,
                    "{{markName}}": brandName,
                    "{{relatedIpRecordTitle}}": brandName,
                    "{{applicantNames}}": applicants.map(a => a.persons?.name).join(', ') || "-",
                    "{{renewalDate}}": renewalDateText
                };
                
                // 🔥 ÇÖZÜM: ReplaceAll kullanarak tüm etiketlerin kesinlikle değişmesini sağlıyoruz
                for (const [k, v] of Object.entries(params)) {
                    subject = subject.replaceAll(k, v);
                    rawBody = rawBody.replaceAll(k, v);
                }
                body = rawBody;
            }
        }

        const targetIds = record.task_owner_id ? [record.task_owner_id] : applicants.map(a => a.person_id);
        let { to, cc } = await getRecipients(targetIds);
        const missingFields = [];
        if (to.length === 0 && cc.length === 0) missingFields.push("recipients");

        await supabaseAdmin.from('mail_notifications').insert({
            id: crypto.randomUUID(),
            associated_task_id: record.id,
            related_ip_record_id: record.ip_record_id,
            client_id: record.task_owner_id || (applicants[0]?.person_id || null),
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
            source: "task_renewal_auto"
        });
    }

    // =========================================================================
    // UPDATE İŞLEMLERİ 
    // =========================================================================
    if (type === 'UPDATE' && old_record) {
        
        // EPATS BELGESİ SİLİNDİ (CLEANUP)
        const hadMainEpats = !!(old_record.details?.epatsDocument);
        const hasMainEpats = !!(record.details?.epatsDocument);
        
        if (hadMainEpats && !hasMainEpats) {
            await supabaseAdmin.from('mail_notifications')
                .delete()
                .eq('associated_task_id', record.id)
                .in('status', ['draft', 'awaiting_client_approval', 'missing_info', 'pending', 'evaluation_pending']);
        }

        const becameCompleted = old_record.status !== 'completed' && record.status === 'completed';
        const wasAwaiting = ['awaiting_client_approval', 'awaiting-approval'].includes(old_record.status);
        const clientApproved = wasAwaiting && record.status === 'open';
        const clientClosed = wasAwaiting && ['client_approval_closed', 'client_no_response_closed'].includes(record.status);

        // ---------------------------------------------------------------------
        // SENARYO 1: İŞ TAMAMLANDI
        // ---------------------------------------------------------------------
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
                    const recordOwnerType = ipRecordData?.record_owner_type || 'self';
                    
                    if (templateId === 'tmpl_50_document') {
                        if (recordOwnerType === 'third_party' && tmplData.body2) body = tmplData.body2;
                        else if (recordOwnerType === 'self' && tmplData.body1) body = tmplData.body1;
                        else body = tmplData.body || body;
                    } else {
                        body = tmplData.body || body;
                    }

                    const params: Record<string, string> = {
                        "{{applicationNo}}": appNo,
                        "{{markName}}": brandName,
                        "{{is_basligi}}": record.title || "",
                        "{{relatedIpRecordTitle}}": brandName
                    };
                    
                    for (const [k, v] of Object.entries(params)) {
                        subject = subject.replaceAll(k, v);
                        body = body.replaceAll(k, v);
                    }
                }
            }

            const targetIds = record.task_owner_id ? [record.task_owner_id] : applicants.map(a => a.person_id);
            let { to, cc } = await getRecipients(targetIds);
            const missingFields = [];
            if (to.length === 0 && cc.length === 0) missingFields.push("recipients");
            if (!hasTemplate) missingFields.push("template");

            await supabaseAdmin.from('mail_notifications').insert({
                id: crypto.randomUUID(),
                associated_task_id: record.id,
                related_ip_record_id: record.ip_record_id,
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
                source: "task_completion"
            });
        }

        // ---------------------------------------------------------------------
        // SENARYO 2: MÜŞTERİ ONAYLADI 
        // ---------------------------------------------------------------------
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
                    ip_record_id: record.ip_record_id,
                    details: { 
                        parent_task_id: record.id, 
                        originalTaskType: taskTypeId,
                        iprecordApplicationNo: appNo,
                        iprecordTitle: brandName,
                        iprecordApplicantName: applicants.map(a => a.persons?.name).join(', ') || "-"
                    }
                });

                await supabaseAdmin.from('counters').upsert({ id: 'tasks_accruals', last_id: currentCount });
            } catch (accErr) {
                console.error("Tahakkuk görev hatası:", accErr);
            }

            const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body').eq('id', 'tmpl_clientInstruction_1').maybeSingle();
            let subject = tmplData?.mail_subject || tmplData?.subject || "{{relatedIpRecordTitle}} - Talimatınız Alındı";
            let body = tmplData?.body || "<p>Talimatınız alınmıştır, işlem başlatılıyor.</p>";

            subject = subject.replaceAll("{{relatedIpRecordTitle}}", brandName);
            body = body.replaceAll("{{relatedIpRecordTitle}}", brandName);

            const threadKey = `${record.ip_record_id}_${taskTypeId}`;
            const { data: threadData } = await supabaseAdmin.from('mail_threads').select('root_subject').eq('id', threadKey).maybeSingle();
            
            if (threadData && threadData.root_subject) {
                const innerSubjectHtml = `<div style="background-color: #f8f9fa; border-left: 4px solid #1a73e8; padding: 15px; margin: 0 0 20px 0; font-family: Arial, sans-serif; color: #333; font-size: 14px;"><strong style="color: #1a73e8;">KONU:</strong> ${subject}</div>`;
                subject = threadData.root_subject;
                if (body.toLowerCase().includes("<body")) body = body.replace(/<body[^>]*>/i, (match) => match + innerSubjectHtml);
                else body = innerSubjectHtml + body;
            }

            let targetIds = ipRecordData?.record_owner_type === 'third_party' ? [record.task_owner_id].filter(Boolean) : applicants.map(a => a.person_id);
            let { to, cc } = await getRecipients(targetIds);

            const missingFields = [];
            if (to.length === 0 && cc.length === 0) missingFields.push("recipients");

            await supabaseAdmin.from('mail_notifications').insert({
                id: crypto.randomUUID(),
                associated_task_id: record.id,
                related_ip_record_id: record.ip_record_id,
                to_list: to,
                cc_list: cc,
                subject: subject,
                body: body,
                status: missingFields.length > 0 ? "missing_info" : "pending",
                missing_fields: missingFields,
                notification_type: "general_notification",
                source: "auto_instruction_response",
                is_draft: false 
            });
        }

        // ---------------------------------------------------------------------
        // SENARYO 3: MÜŞTERİ REDDETTİ / DOSYA KAPANDI
        // ---------------------------------------------------------------------
        if (clientClosed) {
            const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body').eq('id', 'tmpl_clientInstruction_2').maybeSingle();
            let subject = tmplData?.mail_subject || tmplData?.subject || "{{relatedIpRecordTitle}} - Dosya Kapatıldı";
            let body = tmplData?.body || "<p>Talimatınız üzerine dosya kapatılmıştır.</p>";

            subject = subject.replaceAll("{{relatedIpRecordTitle}}", brandName);
            body = body.replaceAll("{{relatedIpRecordTitle}}", brandName);

            const threadKey = `${record.ip_record_id}_${taskTypeId}`;
            const { data: threadData } = await supabaseAdmin.from('mail_threads').select('root_subject').eq('id', threadKey).maybeSingle();
            
            if (threadData && threadData.root_subject) {
                const innerSubjectHtml = `<div style="background-color: #f8f9fa; border-left: 4px solid #1a73e8; padding: 15px; margin: 0 0 20px 0; font-family: Arial, sans-serif; color: #333; font-size: 14px;"><strong style="color: #1a73e8;">KONU:</strong> ${subject}</div>`;
                subject = threadData.root_subject;
                if (body.toLowerCase().includes("<body")) body = body.replace(/<body[^>]*>/i, (match) => match + innerSubjectHtml);
                else body = innerSubjectHtml + body;
            }

            let targetIds = ipRecordData?.record_owner_type === 'third_party' ? [record.task_owner_id].filter(Boolean) : applicants.map(a => a.person_id);
            let { to, cc } = await getRecipients(targetIds);

            const missingFields = [];
            if (to.length === 0 && cc.length === 0) missingFields.push("recipients");

            await supabaseAdmin.from('mail_notifications').insert({
                id: crypto.randomUUID(),
                associated_task_id: record.id,
                related_ip_record_id: record.ip_record_id,
                to_list: to,
                cc_list: cc,
                subject: subject,
                body: body,
                status: missingFields.length > 0 ? "missing_info" : "pending",
                missing_fields: missingFields,
                notification_type: "general_notification",
                source: "auto_instruction_response",
                is_draft: false 
            });
        }
    }

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error: any) {
    console.error("Kritik Edge Function Hatası:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
  }
});