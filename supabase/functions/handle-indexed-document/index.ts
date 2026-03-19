import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TURKEY_HOLIDAYS = [
    "2025-01-01", "2025-03-30", "2025-03-31", "2025-04-01", "2025-04-23", "2025-05-01", "2025-05-19", "2025-06-06", "2025-06-07", "2025-06-08", "2025-06-09", "2025-07-15", "2025-08-30", "2025-10-29",
    "2026-01-01", "2026-03-19", "2026-03-20", "2026-03-21", "2026-03-22", "2026-04-23", "2026-05-01", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30", "2026-07-15", "2026-08-30", "2026-10-29"
];

function isWeekend(date: Date) { return date.getDay() === 0 || date.getDay() === 6; }
function isHoliday(date: Date) { return TURKEY_HOLIDAYS.includes(date.toISOString().split('T')[0]); }

// 🔥 TARİHLERİ %100 TÜRKİYE FORMATINA ÇEVİREN GARANTİ FONKSİYON
function formatTR(date: Date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}.${month}.${date.getFullYear()}`;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const payload = await req.json();
    const { type, record, old_record } = payload;

    const isNewIndexed = type === 'INSERT' && record.status === 'indexed';
    const isUpdatedToIndexed = type === 'UPDATE' && record.status === 'indexed' && old_record?.status !== 'indexed';

    if (!isNewIndexed && !isUpdatedToIndexed) return new Response("İşlem atlandı.", { status: 200 });

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const ipRecordId = record.ip_record_id;
    const transactionId = record.created_transaction_id;
    let txTypeId = String(record.transaction_type_id || '');

    let viewData: any = null;
    const { data: vwData } = await supabaseAdmin.from('portfolio_list_view').select('*').eq('id', ipRecordId).single();
    if (vwData) viewData = vwData;

    let transactionData = null;
    let taskId = null;
    
    // 🔥 DEĞİŞİKLİK 1: SOYAĞACI VE İTİRAZ SAHİBİ (Sadece Type 38 için ebeveyne çıkar)
    let oppositionOwner = "Belirtilmemiş";
    const lineageTxIds: string[] = []; 

    if (transactionId) {
        let currentTxId = transactionId;
        
        // İlk (tetiklenen) işlemi çek
        const { data: firstTx } = await supabaseAdmin.from('transactions').select('*').eq('id', transactionId).single();
        if (firstTx) {
            transactionData = firstTx;
            taskId = firstTx.task_id;
            if (!txTypeId) txTypeId = String(firstTx.transaction_type_id || firstTx.type || '');
        }

        while (currentTxId) {
            lineageTxIds.push(currentTxId);
            const { data: txData } = await supabaseAdmin.from('transactions').select('opposition_owner, parent_id, task_id').eq('id', currentTxId).single();
            
            if (!txData) break;
            
            // Eğer task_id yoksa ve parent'ta varsa onu da al
            if (!taskId && txData.task_id) taskId = txData.task_id;

            // İtiraz sahibini bulduğumuz an kaydet
            if (oppositionOwner === "Belirtilmemiş" && txData.opposition_owner && txData.opposition_owner.trim() !== '') {
                oppositionOwner = txData.opposition_owner;
            }

            // SADECE TYPE 38 İSE VE PARENT'I VARSA YUKARI TIRMAN! Aksi halde döngüyü kır.
            if (txTypeId === '38' && txData.parent_id) {
                currentTxId = txData.parent_id;
            } else {
                break;
            }
        }
    }

    if (taskId) {
        const { data: checkTask } = await supabaseAdmin.from('tasks').select('id').eq('id', taskId).maybeSingle();
        if (!checkTask) taskId = null;
    }

    const brandName = viewData?.brand_name || "-";
    const appNo = viewData?.application_number || viewData?.registration_number || "-";
    const applicantNames = viewData?.applicant_names || "-";
    const isPortfolio = viewData?.record_owner_type === 'self';

    let tebligDate = new Date();
    if (record.teblig_tarihi) {
        const dString = record.teblig_tarihi.split('T')[0];
        const [y, m, d] = dString.split('-');
        tebligDate = new Date(Number(y), Number(m) - 1, Number(d));
    }

    async function getRecipients(viewData: any, currentTaskId: any, currentTaskType: string) {
        const to: string[] = [];
        const cc: string[] = [];
        let personIds: string[] = [];
        let debugLog = ""; 

        const ipType = viewData?.ip_type || 'trademark';

        if (currentTaskId) {
            const { data: taskData } = await supabaseAdmin.from('tasks').select('task_owner_id').eq('id', currentTaskId).maybeSingle();
            if (taskData && taskData.task_owner_id) personIds.push(String(taskData.task_owner_id));
        }

        if (personIds.length === 0 && viewData?.applicants_json) {
            let parsedApplicants = [];
            try { parsedApplicants = typeof viewData.applicants_json === 'string' ? JSON.parse(viewData.applicants_json) : viewData.applicants_json; } catch(e) {}
            if (Array.isArray(parsedApplicants)) personIds = parsedApplicants.map((a: any) => String(a.id)).filter(Boolean);
        }
        
        debugLog += `Aranan Person IDs: ${JSON.stringify(personIds)} | IP Type: ${ipType} <br>`;

        if (personIds.length > 0) {
            const { data: prData } = await supabaseAdmin.from('persons_related').select('*').in('person_id', personIds);

            if (prData && prData.length > 0) {
                debugLog += `Bulunan Persons Related: ${JSON.stringify(prData.map((p:any)=>p.email))} <br>`;
                for (const pr of prData) {
                    if (pr.email) {
                        let isResponsible = false, notifyTo = false, notifyCc = false;

                        if (ipType === 'trademark') { isResponsible = pr.resp_trademark; notifyTo = pr.notify_trademark_to; notifyCc = pr.notify_trademark_cc; } 
                        else if (ipType === 'patent') { isResponsible = pr.resp_patent; notifyTo = pr.notify_patent_to; notifyCc = pr.notify_patent_cc; } 
                        else if (ipType === 'design') { isResponsible = pr.resp_design; notifyTo = pr.notify_design_to; notifyCc = pr.notify_design_cc; }

                        if (isResponsible) {
                            if (notifyTo) to.push(pr.email.trim());
                            if (notifyCc) cc.push(pr.email.trim());
                            if (!notifyTo && !notifyCc) to.push(pr.email.trim());
                        }
                    }
                }
            }
            
            if (to.length === 0 && cc.length > 0) {
                to.push(cc[0]);
                debugLog += `Sadece CC seçilmiş, ilk CC kişisi mecburen TO yapıldı.<br>`;
            }

            if (to.length === 0) {
                debugLog += `TO listesi hala BOŞ! Ana persons tablosuna bakılıyor...<br>`;
                const { data: pData } = await supabaseAdmin.from('persons').select('email').in('id', personIds);
                if (pData && pData.length > 0) {
                    pData.forEach((p: any) => { if (p.email) to.push(p.email.trim()); });
                }
            }
        }

        const { data: internalCcs } = await supabaseAdmin.from('evreka_mail_cc_list').select('email, transaction_types');
        if (internalCcs && internalCcs.length > 0) {
            internalCcs.forEach((internal: any) => {
                if (internal.email) {
                    const types = internal.transaction_types || [];
                    if (types.includes('All') || types.includes(currentTaskType) || types.includes(Number(currentTaskType))) {
                        cc.push(internal.email.trim().toLowerCase());
                    }
                }
            });
        }

        return { 
            to: [...new Set(to)].filter(Boolean), 
            cc: [...new Set(cc)].filter(Boolean).filter(e => !to.includes(e)), 
            primaryClientId: personIds.length > 0 ? personIds[0] : null,
            debugInfo: debugLog
        };
    }

    const { to: finalTo, cc: finalCc, primaryClientId, debugInfo } = await getRecipients(viewData, taskId, txTypeId);

    let decisionAnalysis = {
        isLawsuitRequired: false,
        resultText: "-", statusText: "-", statusColor: "#333", 
        summaryText: "Bu evrak ile ilgili tarafınızca yapılması gereken bir işlem bulunmamaktadır.", 
        boxColor: "#e8f0fe", boxBorder: "#0d6efd"      
    };

    if (["31", "32", "33", "34", "35", "36"].includes(txTypeId)) {
        if (txTypeId === "31") {
            decisionAnalysis.resultText = "BAŞVURU SAHİBİ - İTİRAZ KABUL";
            if (isPortfolio) { decisionAnalysis.statusText = "LEHİMİZE (Kazanıldı)"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "Başvurumuza ilişkin yapılan itiraz kabul edilmiştir. Tescil süreci devam edecektir."; } 
            else { decisionAnalysis.statusText = "ALEYHİMİZE (Rakip Kazandı)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "Rakip başvuru lehine karar verilmiştir. Bu karara karşı dava açılması gerekmektedir."; }
        } else if (txTypeId === "32") {
            decisionAnalysis.resultText = "KISMEN KABUL"; decisionAnalysis.statusText = "KISMEN ALEYHE"; decisionAnalysis.statusColor = "#d97706"; decisionAnalysis.isLawsuitRequired = true; 
            if (isPortfolio) decisionAnalysis.summaryText = "Başvurumuz kısmen kabul edilmiş, kısmen reddedilmiştir. Reddedilen sınıflar için dava açma hakkımız doğmuştur.";
            else decisionAnalysis.summaryText = "Rakip başvuru kısmen kabul edilmiştir. Rakibin kazandığı kısımlar için dava açma hakkımız vardır.";
        } else if (txTypeId === "33") {
            decisionAnalysis.resultText = "BAŞVURU SAHİBİ - İTİRAZ RET";
            if (isPortfolio) { decisionAnalysis.statusText = "ALEYHİMİZE (Başvurumuz Reddedildi)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "Başvurumuza ilişkin itiraz süreci aleyhimize sonuçlanmış ve başvurumuz reddedilmiştir. Dava açılması gerekmektedir."; } 
            else { decisionAnalysis.statusText = "LEHİMİZE (Rakip Reddedildi)"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "Başvuru sahibi markasının reddedilmesine karar verilmiştir. Karar lehimizedir."; }
        } else if (txTypeId === "34") {
            decisionAnalysis.resultText = "İTİRAZ SAHİBİ - İTİRAZ KABUL";
            if (isPortfolio) { decisionAnalysis.statusText = "ALEYHİMİZE (Karşı Taraf Kazandı)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "İtiraz sahibi lehine karar verilmiştir (Aleyhimize). Dava açılması gerekmektedir."; } 
            else { decisionAnalysis.statusText = "LEHİMİZE"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "İtiraz sahibi lehine verilen karar bizim lehimizedir."; }
        } else if (txTypeId === "35") {
            decisionAnalysis.resultText = "KISMEN KABUL"; decisionAnalysis.statusText = "KISMEN ALEYHE"; decisionAnalysis.statusColor = "#d97706"; decisionAnalysis.isLawsuitRequired = true;
            if (isPortfolio) decisionAnalysis.summaryText = "Karar kısmen aleyhimize sonuçlanmıştır. Kaybettiğimiz kısımlar için dava açma hakkımız vardır.";
            else decisionAnalysis.summaryText = "Karar kısmen lehimize, kısmen aleyhimizedir. Aleyhe olan kısımlar için dava açılabilir.";
        } else if (txTypeId === "36") {
            decisionAnalysis.resultText = "İTİRAZ SAHİBİ - İTİRAZ RET";
            if (isPortfolio) { decisionAnalysis.statusText = "LEHİMİZE (İtiraz Reddedildi)"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "İtiraz sahibinin talebi reddedilmiştir. Karar lehimizedir."; } 
            else { decisionAnalysis.statusText = "ALEYHİMİZE (İtirazımız Reddedildi)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "Yaptığımız itiraz nihai olarak reddedilmiştir. Dava açma hakkınız bulunmaktadır."; }
        }
    } else if (txTypeId === "29" || txTypeId === "42") { 
        decisionAnalysis = { isLawsuitRequired: true, resultText: "KISMEN KABUL", statusText: "KISMEN RET", statusColor: "#d97706", summaryText: "Karara itirazımız kısmen kabul edilmiştir.", boxColor: "#fff2f0", boxBorder: "#ff4d4f" };
    } else if (txTypeId === "30" || txTypeId === "43") { 
        decisionAnalysis = { isLawsuitRequired: true, resultText: "RET", statusText: "NİHAİ RET", statusColor: "#d32f2f", summaryText: "Karara itirazımız reddedilmiştir.", boxColor: "#fff2f0", boxBorder: "#ff4d4f" };
    }

    if (decisionAnalysis.isLawsuitRequired) { decisionAnalysis.boxColor = "#fff2f0"; decisionAnalysis.boxBorder = "#ff4d4f"; }

    let calculatedDeadlineDate = new Date(tebligDate);
    calculatedDeadlineDate.setMonth(calculatedDeadlineDate.getMonth() + 2);
    let iter = 0;
    while ((isWeekend(calculatedDeadlineDate) || isHoliday(calculatedDeadlineDate)) && iter < 30) {
        calculatedDeadlineDate.setDate(calculatedDeadlineDate.getDate() + 1);
        iter++;
    }
    
    const genelSonTarih = formatTR(calculatedDeadlineDate);
    const formattedTeblig = formatTR(tebligDate);

    let davaSonTarihi = "-";
    if (decisionAnalysis.isLawsuitRequired) {
        davaSonTarihi = genelSonTarih;
    }

    let finalSubject = "Yeni Evrak Bildirimi";
    let finalBody = "Sistemimize yeni bir evrak eklenmiştir.";
    let templateId = null;

    const { data: rule } = await supabaseAdmin.from('template_rules').select('template_id').eq('source_type', 'document').eq('sub_process_type', txTypeId).maybeSingle();

    if (rule && rule.template_id) {
        templateId = rule.template_id;
        const { data: template } = await supabaseAdmin.from('mail_templates').select('*').eq('id', templateId).maybeSingle();
        
        if (template) {
            finalSubject = template.mail_subject || template.subject || finalSubject;
            let rawBody = template.body || finalBody;

            if (!isPortfolio && template.body2) {
                rawBody = template.body2;
            } else if (isPortfolio && template.body1) {
                rawBody = template.body1;
            }

            const placeholders: Record<string, string> = {
                "{{applicationNo}}": appNo,
                "{{markName}}": brandName,
                "{{basvuru_no}}": appNo,
                "{{proje_adi}}": brandName,
                "{{teblig_tarihi}}": formattedTeblig, 
                "{{islem_turu_adi}}": record.description || txTypeId,
                "{{epats_evrak_no}}": record.document_number || "-",
                "{{applicantNames}}": applicantNames,
                "{{karar_sonucu_baslik}}": decisionAnalysis.resultText,
                "{{karar_durumu_metni}}": decisionAnalysis.statusText,
                "{{karar_durumu_renk}}": decisionAnalysis.statusColor,
                "{{aksiyon_kutusu_bg}}": decisionAnalysis.boxColor,
                "{{aksiyon_kutusu_border}}": decisionAnalysis.boxBorder,
                "{{karar_ozeti_detay}}": decisionAnalysis.summaryText + (decisionAnalysis.isLawsuitRequired ? "<br><br>Bu karara karşı belirtilen tarihe kadar <strong>YİDK Kararının İptali davası</strong> açma hakkınız bulunmaktadır." : ""),
                "{{dava_son_tarihi}}": davaSonTarihi,
                "{{dava_son_tarihi_display_style}}": decisionAnalysis.isLawsuitRequired ? "block" : "none",
                "{{markImageUrl}}": viewData?.brand_image_url || "",
                // 🔥 DEĞİŞİKLİK 2: Bulduğumuz İtiraz Sahibini Template'e yerleştiriyoruz
                "{{itiraz_sahibi}}": oppositionOwner, 
                "{{resmi_son_cevap_tarihi}}": genelSonTarih, 
                "{{son_odeme_tarihi}}": genelSonTarih,
                "{{son_itiraz_tarihi}}": genelSonTarih
            };

            for (const [k, v] of Object.entries(placeholders)) {
                finalSubject = finalSubject.replaceAll(k, String(v));
                rawBody = rawBody.replaceAll(k, String(v));
            }
            finalBody = rawBody;
        }
    }

    if (finalTo.length === 0) {
        finalBody += `<br><br><hr><p style="color:red; font-size:12px;"><b>⚠️ SİSTEM TEŞHİS BİLGİSİ (Neden Alıcı Bulunamadı?):</b><br>${debugInfo}</p>`;
    }

    const evalTasksRes = await supabaseAdmin.from('tasks').select('id').eq('transaction_id', transactionId).eq('task_type_id', '66').limit(1);
    const evalTaskId = (evalTasksRes.data && evalTasksRes.data.length > 0) ? evalTasksRes.data[0].id : null;

    const { data: triggeredTasks } = await supabaseAdmin
        .from('tasks')
        .select('id')
        .eq('transaction_id', transactionId)
        .eq('status', 'awaiting_client_approval')
        .order('created_at', { ascending: false })
        .limit(1);

    const newTriggeredTaskId = (triggeredTasks && triggeredTasks.length > 0) ? triggeredTasks[0].id : null;

    let finalStatus = finalTo.length === 0 ? "missing_info" : (evalTaskId ? "evaluation_pending" : "pending");
    const mailId = crypto.randomUUID();
    
    const mailPayload = {
        id: mailId, 
        related_ip_record_id: ipRecordId, 
        associated_task_id: evalTaskId || newTriggeredTaskId || taskId, 
        source_document_id: record.id, 
        associated_transaction_id: transactionId,
        template_id: templateId, 
        to_list: finalTo, 
        cc_list: finalCc, 
        client_id: primaryClientId, 
        subject: finalSubject, 
        body: finalBody, 
        status: finalStatus, 
        mode: "draft", 
        objection_deadline: davaSonTarihi !== "-" ? davaSonTarihi : null, 
        notification_type: 'marka', 
        source: 'document_index', 
        is_draft: finalStatus === "missing_info", 
        missing_fields: finalTo.length === 0 ? ['recipients'] : []
    };

    const { error: mailInsertError } = await supabaseAdmin.from('mail_notifications').insert(mailPayload);
    if (mailInsertError) throw new Error(`Mail tablosuna yazılamadı: ${mailInsertError.message}`);

    // 🔥 DEĞİŞİKLİK 3: EKLERİ `mail_attachments` TABLOSUNA YAZMA 
    const attachmentsToInsert: any[] = [];

    // Eğer işlemimiz Type 38 ise soy ağacından (lineageTxIds) belgeleri topla
    if (lineageTxIds.length > 0) {
        const { data: txDocs } = await supabaseAdmin
            .from('transaction_documents')
            .select('document_name, document_url')
            .in('transaction_id', lineageTxIds);

        if (txDocs && txDocs.length > 0) {
            txDocs.forEach(doc => {
                attachmentsToInsert.push({
                    notification_id: mailId,
                    file_name: doc.document_name || "Ek_Evrak.pdf",
                    storage_path: null,
                    url: doc.document_url
                });
            });
        }
    }

    // Gelen asıl tebligatı da (incoming_documents) dahil et
    if (record.file_url) {
        const alreadyAdded = attachmentsToInsert.some(a => a.url === record.file_url);
        if (!alreadyAdded) {
            attachmentsToInsert.push({
                notification_id: mailId, 
                file_name: record.file_name || "Tebligat.pdf", 
                storage_path: record.file_path || null, 
                url: record.file_url 
            });
        }
    }

    if (attachmentsToInsert.length > 0) {
        await supabaseAdmin.from('mail_attachments').insert(attachmentsToInsert);
    }

    return new Response(JSON.stringify({ success: true, mailId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error("❌ Evrak Endeksleme Hatası:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
  }
});