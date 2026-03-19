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

function formatTR(date: Date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}.${month}.${date.getFullYear()}`;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const payload = await req.json();
    const { record } = payload;
    
    console.log(`[HANDLE_INDEXED] 🚀 Tetiklendi! Evrak Durumu: ${record?.status}`);

    if (record?.status !== 'indexed') {
        console.log(`[HANDLE_INDEXED] ⏭️ İPTAL EDİLDİ: Evrak henüz indekslenmemiş.`);
        return new Response("İşlem atlandı.", { status: 200 });
    }
    
    console.log(`[HANDLE_INDEXED] ✅ Evrak indekslenmiş, işlem başlıyor...`);

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

    // 🔥 GÖREVLERİ (TASKS) SÜRECİN EN BAŞINDA ÇEKİYORUZ Kİ "TETİKLENDİ Mİ?" BİLELİM
    const evalTasksRes = await supabaseAdmin.from('tasks').select('id, official_due_date').eq('transaction_id', transactionId).eq('task_type_id', '66').limit(1);
    const evalTaskId = (evalTasksRes.data && evalTasksRes.data.length > 0) ? evalTasksRes.data[0].id : null;

    const { data: triggeredTasks } = await supabaseAdmin
        .from('tasks')
        .select('id, official_due_date')
        .eq('transaction_id', transactionId)
        .eq('status', 'awaiting_client_approval')
        .order('created_at', { ascending: false })
        .limit(1);

    const newTriggeredTaskId = (triggeredTasks && triggeredTasks.length > 0) ? triggeredTasks[0].id : null;
    const isTaskTriggered = evalTaskId || newTriggeredTaskId;
    
    // --- AKILLI SOYAĞACI (LINEAGE) VE İZ SÜRME ALGORİTMASI ---
    let oppositionOwner = "Belirtilmemiş";
    const lineageTxIds: string[] = []; 
    let resolvedRootTaskId = null; // Kök görev ID'si (Type 20 Task ID)

    if (transactionId) {
        let currentTxId = transactionId;
        let foundType20TaskId = null;
        let foundType19TxId = null;
        
        const { data: firstTx } = await supabaseAdmin.from('transactions').select('*').eq('id', transactionId).single();
        if (firstTx) {
            transactionData = firstTx;
            taskId = firstTx.task_id;
            if (!txTypeId) txTypeId = String(firstTx.transaction_type_id || firstTx.type || '');
        }

        // 1. AŞAMA: NORMAL TIRMANMA VE EVRAK TOPLAMA
        while (currentTxId) {
            // Evrak kuralı: Yalnızca işlem 38 veya 27 ise tüm ebeveynlerin evraklarını al
            if (currentTxId === transactionId || ['38', '27'].includes(txTypeId)) {
                if (!lineageTxIds.includes(currentTxId)) lineageTxIds.push(currentTxId);
            }

            const { data: txData } = await supabaseAdmin.from('transactions').select('id, transaction_type_id, opposition_owner, parent_id, task_id').eq('id', currentTxId).single();
            if (!txData) break;
            
            if (!taskId && txData.task_id) taskId = txData.task_id;

            if (oppositionOwner === "Belirtilmemiş" && txData.opposition_owner && txData.opposition_owner.trim() !== '') {
                oppositionOwner = txData.opposition_owner;
            }

            // Kök Görev (Root Task) Tespiti İçin Type 20 ve 19'u izle
            if (txData.transaction_type_id === '20' && !foundType20TaskId) {
                foundType20TaskId = txData.task_id;
            } else if (txData.transaction_type_id === '19' && !foundType19TxId && !foundType20TaskId) {
                foundType19TxId = txData.id;
            }

            if (txData.parent_id) {
                currentTxId = txData.parent_id;
            } else {
                break;
            }
        }

        const isPortfolio = viewData?.record_owner_type === 'self';

        // 2. AŞAMA: ÜÇÜNCÜ TARAF (RAKİP) VE GÖREVSİZ İŞLEMLER İÇİN MÜVEKKİL İZ SÜRME ALGORİTMASI
        if (!isPortfolio && !isTaskTriggered) {
            if (foundType20TaskId) {
                // Durum 1: Soyağacında zaten doğrudan Ana İşlem (Type 20) bulundu.
                resolvedRootTaskId = foundType20TaskId;
                console.log(`[HANDLE_INDEXED] 🕵️‍♂️ Doğrudan Kök Type 20 bulundu. Task ID: ${resolvedRootTaskId}`);
            } else if (foundType19TxId) {
                // Durum 2: Soyağacında Type 19 bulundu. (İstisnai Sıçrama Algoritması)
                console.log(`[HANDLE_INDEXED] 🕵️‍♂️ Type 19 tespit edildi. Sıçrama algoritması başlatılıyor...`);
                // Adım 1: Type 19'un Task'ını bul
                const { data: tx19 } = await supabaseAdmin.from('transactions').select('task_id').eq('id', foundType19TxId).single();
                if (tx19 && tx19.task_id) {
                    // Adım 2: O Task'ı tetikleyen alt işlemi (child transaction) bul
                    const { data: task19 } = await supabaseAdmin.from('tasks').select('transaction_id').eq('id', tx19.task_id).single();
                    if (task19 && task19.transaction_id) {
                        // Adım 3: O alt işlemin parent'ını (Yani Ana Type 20'yi) bul
                        const { data: triggerTx } = await supabaseAdmin.from('transactions').select('parent_id').eq('id', task19.transaction_id).single();
                        if (triggerTx && triggerTx.parent_id) {
                            // Adım 4: O Type 20'nin task_id'sini (Kök Görevi) al!
                            const { data: tx20 } = await supabaseAdmin.from('transactions').select('task_id').eq('id', triggerTx.parent_id).single();
                            if (tx20 && tx20.task_id) {
                                resolvedRootTaskId = tx20.task_id;
                                console.log(`[HANDLE_INDEXED] 🎯 Sıçrama başarılı! Ana Type 20 Görevi (Task ID: ${resolvedRootTaskId}) bulundu.`);
                            }
                        }
                    }
                }
            }
        }
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

        const ipType = viewData?.ip_type || 'trademark';

        // Müvekkili (Task Owner) öncelikle gönderilen garantili Task ID üzerinden bul
        if (currentTaskId) {
            const { data: taskData } = await supabaseAdmin.from('tasks').select('task_owner_id').eq('id', currentTaskId).maybeSingle();
            if (taskData && taskData.task_owner_id) personIds.push(String(taskData.task_owner_id));
        }

        // Eğer hala görev veya müvekkil yoksa, o zaman applicants verisine bak
        if (personIds.length === 0 && viewData?.applicants_json) {
            let parsedApplicants = [];
            try { parsedApplicants = typeof viewData.applicants_json === 'string' ? JSON.parse(viewData.applicants_json) : viewData.applicants_json; } catch(e) {}
            if (Array.isArray(parsedApplicants)) personIds = parsedApplicants.map((a: any) => String(a.id)).filter(Boolean);
        }

        if (personIds.length > 0) {
            const { data: prData } = await supabaseAdmin.from('persons_related').select('*').in('person_id', personIds);

            if (prData && prData.length > 0) {
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
            }

            if (to.length === 0) {
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
            primaryClientId: personIds.length > 0 ? personIds[0] : null
        };
    }

    // 🔥 Mail Alıcılarını Garantili Görev (Task) Üzerinden Bul
    let taskForRecipients = evalTaskId || newTriggeredTaskId || resolvedRootTaskId || taskId;
    const { to: finalTo, cc: finalCc, primaryClientId } = await getRecipients(viewData, taskForRecipients, txTypeId);

    let taskOfficialDueDate = null;
    if (triggeredTasks && triggeredTasks.length > 0 && triggeredTasks[0].official_due_date) {
        taskOfficialDueDate = triggeredTasks[0].official_due_date;
    } else if (evalTasksRes.data && evalTasksRes.data.length > 0 && evalTasksRes.data[0].official_due_date) {
        taskOfficialDueDate = evalTasksRes.data[0].official_due_date;
    } else if (taskId) {
        const { data: mainTask } = await supabaseAdmin.from('tasks').select('official_due_date').eq('id', taskId).maybeSingle();
        if (mainTask && mainTask.official_due_date) taskOfficialDueDate = mainTask.official_due_date;
    }

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

    let davaSonTarihi = "-";
    if (decisionAnalysis.isLawsuitRequired) {
        let calculatedDavaDate = new Date(tebligDate);
        calculatedDavaDate.setMonth(calculatedDavaDate.getMonth() + 2);
        let iterDava = 0;
        while ((isWeekend(calculatedDavaDate) || isHoliday(calculatedDavaDate)) && iterDava < 30) {
            calculatedDavaDate.setDate(calculatedDavaDate.getDate() + 1);
            iterDava++;
        }
        davaSonTarihi = formatTR(calculatedDavaDate);
    }

    let genelSonTarih = "-";
    if (taskOfficialDueDate) {
        const d = new Date(taskOfficialDueDate);
        if (!isNaN(d.getTime())) {
            genelSonTarih = formatTR(d);
        }
    } 
    
    if (genelSonTarih === "-") {
        let duePeriodMonths = 2; 
        if (txTypeId) {
            const { data: ttData } = await supabaseAdmin.from('transaction_types').select('due_period').eq('id', txTypeId).maybeSingle();
            if (ttData && ttData.due_period !== null) duePeriodMonths = Number(ttData.due_period);
        }
        
        let calculatedGenelDate = new Date(tebligDate);
        calculatedGenelDate.setMonth(calculatedGenelDate.getMonth() + duePeriodMonths);
        let iterGenel = 0;
        while ((isWeekend(calculatedGenelDate) || isHoliday(calculatedGenelDate)) && iterGenel < 30) {
            calculatedGenelDate.setDate(calculatedGenelDate.getDate() + 1);
            iterGenel++;
        }
        genelSonTarih = formatTR(calculatedGenelDate);
    }

    const formattedTeblig = formatTR(tebligDate);
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

    let finalStatus = finalTo.length === 0 ? "missing_info" : (evalTaskId ? "evaluation_pending" : "pending");
    const mailId = crypto.randomUUID();
    
    const mailPayload = {
        id: mailId, 
        related_ip_record_id: ipRecordId, 
        // 🔥 Sihirli Dokunuş: taskForRecipients değişkeni, View'e doğru müvekkili gösterecek!
        associated_task_id: taskForRecipients, 
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
        objection_deadline: (davaSonTarihi !== "-" ? davaSonTarihi : (genelSonTarih !== "-" ? genelSonTarih : null)), 
        notification_type: 'marka', 
        source: 'document_index', 
        is_draft: finalStatus === "missing_info", 
        missing_fields: finalTo.length === 0 ? ['recipients'] : []
    };

    const { error: mailInsertError } = await supabaseAdmin.from('mail_notifications').insert(mailPayload);
    if (mailInsertError) throw new Error(`Mail tablosuna yazılamadı: ${mailInsertError.message}`);

    console.log(`[HANDLE_INDEXED] 📎 Ekler toplanıyor...`);
    const attachmentsToInsert: any[] = [];
    const uniqueUrls = new Set();

    if (lineageTxIds.length > 0) {
        const { data: txDocs } = await supabaseAdmin
            .from('transaction_documents')
            .select('document_name, document_url')
            .in('transaction_id', lineageTxIds);

        if (txDocs && txDocs.length > 0) {
            txDocs.forEach(doc => {
                if (!uniqueUrls.has(doc.document_url)) {
                    uniqueUrls.add(doc.document_url);
                    attachmentsToInsert.push({
                        notification_id: mailId,
                        file_name: doc.document_name || "Ek_Evrak.pdf",
                        storage_path: null,
                        url: doc.document_url
                    });
                }
            });
        }
    }

    if (record.file_url && !uniqueUrls.has(record.file_url)) {
        attachmentsToInsert.push({
            notification_id: mailId, 
            file_name: record.file_name || "Tebligat.pdf", 
            storage_path: record.file_path || null, 
            url: record.file_url 
        });
    }

    if (attachmentsToInsert.length > 0) {
        await supabaseAdmin.from('mail_attachments').insert(attachmentsToInsert);
    }

    console.log(`[HANDLE_INDEXED] 🎉 İŞLEM TAMAMLANDI!`);
    return new Response(JSON.stringify({ success: true, mailId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error("❌ Evrak Endeksleme Hatası:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
  }
});