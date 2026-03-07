import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// --- TATİL VE TARİH YARDIMCILARI ---
const TURKEY_HOLIDAYS = [
    "2025-01-01", "2025-03-30", "2025-03-31", "2025-04-01", "2025-04-23", "2025-05-01", "2025-05-19", "2025-06-06", "2025-06-07", "2025-06-08", "2025-06-09", "2025-07-15", "2025-08-30", "2025-10-29",
    "2026-01-01", "2026-03-19", "2026-03-20", "2026-03-21", "2026-03-22", "2026-04-23", "2026-05-01", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30", "2026-07-15", "2026-08-30", "2026-10-29"
];

function isWeekend(date: Date) { return date.getDay() === 0 || date.getDay() === 6; }
function isHoliday(date: Date) {
    const d = date.toISOString().split('T')[0];
    return TURKEY_HOLIDAYS.includes(d);
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const payload = await req.json();
    const { type, record, old_record } = payload;

    // Sadece incoming_documents tablosunda status 'indexed' olduğunda çalış
    if (type !== 'UPDATE' || old_record.status === 'indexed' || record.status !== 'indexed') {
        return new Response("İşlem atlandı. Sadece yeni indekslenen evraklar.", { status: 200 });
    }

    console.log(`🚀 [OTOMASYON] Belge Endekslendi: ${record.id}`);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // ==========================================
    // 1. GEREKLİ VERİLERİ TOPLAMA
    // ==========================================
    const ipRecordId = record.ip_record_id;
    const transactionId = record.created_transaction_id;
    const txTypeId = String(record.transaction_type_id || '');

    if (!ipRecordId) throw new Error("Evrak bir Marka/Patent kaydına bağlı değil.");

    // IP Kaydını, Sahipleri ve Müşteriyi Çek
    const { data: ipRecord } = await supabaseAdmin.from('ip_records')
        .select('*, ip_record_trademark_details(brand_name, brand_image_url), ip_record_applicants(person_id, persons(name, is_evaluation_required))')
        .eq('id', ipRecordId)
        .single();

    if (!ipRecord) throw new Error("IP Kaydı bulunamadı.");

    // İşlem (Transaction) Detayını Çek
    let transactionData = null;
    let parentTransactionData = null;
    if (transactionId) {
        const { data: tx } = await supabaseAdmin.from('transactions').select('*').eq('id', transactionId).single();
        if (tx) {
            transactionData = tx;
            if (tx.parent_id) {
                const { data: pTx } = await supabaseAdmin.from('transactions').select('*').eq('id', tx.parent_id).single();
                parentTransactionData = pTx;
            }
        }
    }

    // Temel Değişkenler
    const brandName = ipRecord.ip_record_trademark_details?.[0]?.brand_name || "-";
    const brandImageUrl = ipRecord.ip_record_trademark_details?.[0]?.brand_image_url || "";
    const appNo = ipRecord.application_number || "-";
    const isPortfolio = ipRecord.record_owner_type === 'self';
    const applicants = ipRecord.ip_record_applicants || [];
    
    // Müşteri tespiti ve Değerlendirme zorunluluğu
    const clientId = applicants.length > 0 ? applicants[0].person_id : null;
    const isEvaluationRequired = applicants.length > 0 ? applicants[0].persons?.is_evaluation_required : false;
    const applicantNames = applicants.map((a: any) => a.persons?.name).filter(Boolean).join(', ') || "-";

    const tebligDate = record.teblig_tarihi ? new Date(record.teblig_tarihi) : new Date();
    
    // ==========================================
    // 2. KARAR VE DAVA ANALİZİ MANTIĞI
    // ==========================================
    let decisionAnalysis = {
        isLawsuitRequired: false,
        resultText: "-", statusText: "-", statusColor: "#333", 
        summaryText: "Bu evrak ile ilgili tarafınızca yapılması gereken bir işlem bulunmamaktadır.", 
        boxColor: "#e8f0fe", boxBorder: "#0d6efd"      
    };

    // Tip 31-36 ve 29-30 (Karar tipleri)
    if (["31", "32", "33", "34", "35", "36"].includes(txTypeId)) {
        if (txTypeId === "31") {
            decisionAnalysis.resultText = "BAŞVURU SAHİBİ - İTİRAZ KABUL";
            if (isPortfolio) { 
                decisionAnalysis.statusText = "LEHİMİZE (Kazanıldı)"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "Başvurumuza ilişkin yapılan itiraz kabul edilmiştir. Tescil süreci devam edecektir.";
            } else { 
                decisionAnalysis.statusText = "ALEYHİMİZE (Rakip Kazandı)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "Rakip başvuru lehine karar verilmiştir. Bu karara karşı dava açılması gerekmektedir.";
            }
        } else if (txTypeId === "32") {
            decisionAnalysis.resultText = "KISMEN KABUL"; decisionAnalysis.statusText = "KISMEN ALEYHE"; decisionAnalysis.statusColor = "#d97706"; decisionAnalysis.isLawsuitRequired = true; 
            if (isPortfolio) decisionAnalysis.summaryText = "Başvurumuz kısmen kabul edilmiş, kısmen reddedilmiştir. Reddedilen sınıflar için dava açma hakkımız doğmuştur.";
            else decisionAnalysis.summaryText = "Rakip başvuru kısmen kabul edilmiştir. Rakibin kazandığı kısımlar için dava açma hakkımız vardır.";
        } else if (txTypeId === "33") {
            decisionAnalysis.resultText = "BAŞVURU SAHİBİ - İTİRAZ RET";
            if (isPortfolio) { 
                decisionAnalysis.statusText = "ALEYHİMİZE (Başvurumuz Reddedildi)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "Başvurumuza ilişkin itiraz süreci aleyhimize sonuçlanmış ve başvurumuz reddedilmiştir. Dava açılması gerekmektedir.";
            } else { 
                decisionAnalysis.statusText = "LEHİMİZE (Rakip Reddedildi)"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "Başvuru sahibi markasının reddedilmesine karar verilmiştir. Karar lehimizedir.";
            }
        } else if (txTypeId === "34") {
            decisionAnalysis.resultText = "İTİRAZ SAHİBİ - İTİRAZ KABUL";
            if (isPortfolio) { 
                decisionAnalysis.statusText = "ALEYHİMİZE (Karşı Taraf Kazandı)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "İtiraz sahibi lehine karar verilmiştir (Aleyhimize). Dava açılması gerekmektedir.";
            } else { 
                decisionAnalysis.statusText = "LEHİMİZE"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "İtiraz sahibi lehine verilen karar bizim lehimizedir.";
            }
        } else if (txTypeId === "35") {
            decisionAnalysis.resultText = "KISMEN KABUL"; decisionAnalysis.statusText = "KISMEN ALEYHE"; decisionAnalysis.statusColor = "#d97706"; decisionAnalysis.isLawsuitRequired = true;
            if (isPortfolio) decisionAnalysis.summaryText = "Karar kısmen aleyhimize sonuçlanmıştır. Kaybettiğimiz kısımlar için dava açma hakkımız vardır.";
            else decisionAnalysis.summaryText = "Karar kısmen lehimize, kısmen aleyhimizedir. Aleyhe olan kısımlar için dava açılabilir.";
        } else if (txTypeId === "36") {
            decisionAnalysis.resultText = "İTİRAZ SAHİBİ - İTİRAZ RET";
            if (isPortfolio) { 
                decisionAnalysis.statusText = "LEHİMİZE (İtiraz Reddedildi)"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "İtiraz sahibinin talebi reddedilmiştir. Karar lehimizedir.";
            } else { 
                decisionAnalysis.statusText = "ALEYHİMİZE (İtirazımız Reddedildi)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "Yaptığımız itiraz nihai olarak reddedilmiştir. Dava açma hakkınız bulunmaktadır.";
            }
        }
    } else if (txTypeId === "29") {
        decisionAnalysis = { isLawsuitRequired: true, resultText: "KISMEN KABUL", statusText: "KISMEN RET", statusColor: "#d97706", summaryText: "Karara itirazımız kısmen kabul edilmiştir.", boxColor: "#fff2f0", boxBorder: "#ff4d4f" };
    } else if (txTypeId === "30") {
        decisionAnalysis = { isLawsuitRequired: true, resultText: "RET", statusText: "NİHAİ RET", statusColor: "#d32f2f", summaryText: "Karara itirazımız reddedilmiştir.", boxColor: "#fff2f0", boxBorder: "#ff4d4f" };
    }

    if (decisionAnalysis.isLawsuitRequired) {
        decisionAnalysis.boxColor = "#fff2f0"; decisionAnalysis.boxBorder = "#ff4d4f";
    }

    // ==========================================
    // 3. DAVA SÜRESİ HESAPLAMA (+2 AY & TATİL)
    // ==========================================
    let davaSonTarihi = "-";
    let calculatedDeadlineDate = null;
    
    if (decisionAnalysis.isLawsuitRequired) {
        calculatedDeadlineDate = new Date(tebligDate);
        calculatedDeadlineDate.setMonth(calculatedDeadlineDate.getMonth() + 2);
        
        let iter = 0;
        while ((isWeekend(calculatedDeadlineDate) || isHoliday(calculatedDeadlineDate)) && iter < 30) {
            calculatedDeadlineDate.setDate(calculatedDeadlineDate.getDate() + 1);
            iter++;
        }
        davaSonTarihi = calculatedDeadlineDate.toLocaleDateString('tr-TR');
    }

    // ==========================================
    // 4. ALICILARI (TO/CC) BELİRLEME
    // ==========================================
    const toRecipients: string[] = [];
    const ccRecipients: string[] = [];

    if (clientId && isPortfolio) {
        const { data: prData } = await supabaseAdmin.from('persons_related').select('*').eq('person_id', clientId).eq('resp_trademark', true);
        if (prData) {
            prData.forEach(pr => {
                if (pr.email) {
                    if (pr.notify_trademark_to) toRecipients.push(pr.email);
                    if (pr.notify_trademark_cc) ccRecipients.push(pr.email);
                    if (!pr.notify_trademark_to && !pr.notify_trademark_cc) toRecipients.push(pr.email); 
                }
            });
        }
    } else if (!isPortfolio) {
        console.log(`⚠️ Rakip dosyası olduğu için rakibe mail atılması engellendi.`);
    }

    // Evreka CC Listesi
    const { data: ccData } = await supabaseAdmin.from('evreka_mail_cc_list').select('email').contains('transaction_types', [txTypeId]);
    if (ccData) ccData.forEach(c => ccRecipients.push(c.email));

    const finalTo = [...new Set(toRecipients)].filter(Boolean);
    const finalCc = [...new Set(ccRecipients)].filter(e => !finalTo.includes(e));

    // ==========================================
    // 5. ŞABLON EŞLEŞTİRME VE İÇERİK OLUŞTURMA
    // ==========================================
    let subject = "Yeni Evrak Bildirimi";
    let body = "Sistemimize yeni bir evrak eklenmiştir.";
    let templateId = null;

    const { data: rule } = await supabaseAdmin.from('template_rules')
        .select('template_id')
        .eq('source_type', 'document')
        .eq('sub_process_type', txTypeId)
        .maybeSingle();

    if (rule && rule.template_id) {
        templateId = rule.template_id;
        const { data: template } = await supabaseAdmin.from('mail_templates').select('*').eq('id', templateId).maybeSingle();
        
        if (template) {
            subject = template.subject || template.mail_subject || subject;
            let rawBody = template.body || body;

            // Self vs Third Party İçerik Seçimi
            if (templateId === 'tmpl_50_document') {
                if (isPortfolio && template.body1) rawBody = template.body1;
                else if (!isPortfolio && template.body2) rawBody = template.body2;
            }

            const placeholders: any = {
                "{{applicationNo}}": appNo,
                "{{markName}}": brandName,
                "{{basvuru_no}}": appNo,
                "{{proje_adi}}": brandName,
                "{{teblig_tarihi}}": tebligDate.toLocaleDateString('tr-TR'),
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
                "{{dava_son_tarihi_display_style}}": decisionAnalysis.isLawsuitRequired ? "block" : "none"
            };

            for (const [k, v] of Object.entries(placeholders)) {
                subject = subject.replace(new RegExp(k, 'g'), String(v));
                rawBody = rawBody.replace(new RegExp(k, 'g'), String(v));
            }
            body = rawBody;
        }
    }

    // ==========================================
    // 6. STATÜ BELİRLEME VE TASK 66 (DEĞERLENDİRME)
    // ==========================================
    const SENSITIVE_TASK_TYPES = ['7', '19', '49', '54'];
    const isSensitive = SENSITIVE_TASK_TYPES.includes(txTypeId); 

    let finalStatus = "missing_info";
    if (finalTo.length > 0) {
        if (isSensitive && isEvaluationRequired) {
            finalStatus = "evaluation_pending";
        } else {
            finalStatus = "awaiting_client_approval"; // Taslak olarak onaya düşer
        }
    }

    // 🔥 DB GÜNCELLEMESİ: Eksik Sütunlar Tamamlandı (client_id, mode, objection_deadline)
    const mailId = crypto.randomUUID();
    await supabaseAdmin.from('mail_notifications').insert({
        id: mailId,
        related_ip_record_id: ipRecordId,
        source_document_id: record.id,
        associated_transaction_id: transactionId,
        template_id: templateId,
        to_list: finalTo,
        cc_list: finalCc,
        client_id: clientId, // <--- Eklendi
        subject: subject,
        body: body,
        status: finalStatus,
        mode: "draft", // <--- Eklendi
        objection_deadline: davaSonTarihi !== "-" ? davaSonTarihi : null, // <--- Eklendi
        notification_type: 'marka',
        source: 'document_index',
        is_draft: true,
        missing_fields: finalTo.length === 0 ? ['recipients'] : []
    });

    // Ek Dosyayı (Attachment) Kaydet
    if (record.file_url) {
        await supabaseAdmin.from('mail_attachments').insert({
            notification_id: mailId,
            file_name: record.file_name || "Evrak.pdf",
            storage_path: record.file_path,
            url: record.file_url
        });
    }

    // Değerlendirme Görevi (Task 66) Oluşturulacak Mı?
    if (finalStatus === "evaluation_pending") {
        console.log(`⚖️ Hassas işlem tespit edildi. Task 66 (Değerlendirme) açılıyor...`);
        
        const { data: counterData } = await supabaseAdmin.from('counters').select('last_id').eq('id', 'tasks').single();
        let currentId = counterData ? Number(counterData.last_id) : 0;
        currentId++;
        const newTaskId = String(currentId);

        const { data: assignData } = await supabaseAdmin.from('task_assignments').select('assignee_ids').eq('id', '66').single();
        const assignedUid = assignData?.assignee_ids?.[0] || null;

        let taskDueDate = new Date(tebligDate);
        taskDueDate.setDate(taskDueDate.getDate() + 10);

        if (calculatedDeadlineDate && taskDueDate >= calculatedDeadlineDate) {
            taskDueDate = new Date(calculatedDeadlineDate);
            taskDueDate.setDate(taskDueDate.getDate() - 5); 
        }

        // 🔥 DB GÜNCELLEMESİ: task_owner_id eklendi
        await supabaseAdmin.from('tasks').insert({
            id: newTaskId,
            task_type_id: "66",
            status: "open",
            priority: "high",
            title: `Değerlendirme: ${subject}`,
            description: `Müvekkil hassas gruptadır. Taslağı düzenleyip onaylayın.`,
            ip_record_id: ipRecordId,
            assigned_to: assignedUid,
            task_owner_id: clientId, // <--- Eklendi
            official_due_date: taskDueDate.toISOString(),
            operational_due_date: taskDueDate.toISOString(),
            details: {
                parent_task_id: transactionData?.task_id || null, 
                iprecordApplicationNo: appNo,
                iprecordTitle: brandName,
                iprecordApplicantName: applicantNames
            }
        });

        await supabaseAdmin.from('counters').update({ last_id: currentId }).eq('id', 'tasks');
    }

    return new Response(JSON.stringify({ success: true, mailId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error("❌ Evrak Endeksleme Hatası:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
  }
});