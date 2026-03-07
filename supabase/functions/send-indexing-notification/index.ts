// supabase/functions/send-indexing-notification/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { recordId, childTypeId, transactionId, tebligTarihi, sonItirazTarihi, pdfId, toList, ccList } = await req.json();

    if (!recordId) throw new Error("recordId eksik!");

    // 🔥 1. Genişletilmiş Veritabanı Sorgusu (Sınıflar ve Sahipler eklendi)
    const { data: record, error: recError } = await supabaseAdmin
        .from('ip_records')
        .select(`
            *,
            details:ip_record_trademark_details(brand_name, brand_image_url),
            applicants:ip_record_applicants(persons(name)),
            classes:ip_record_classes(class_no)
        `)
        .eq('id', recordId)
        .single();

    if (recError || !record) throw new Error("IP Kaydı bulunamadı.");

    // --- TEMEL VERİLERİ HAZIRLAMA ---
    let brandName = '-';
    const detailsObj = Array.isArray(record.details) ? record.details[0] : record.details;
    if (detailsObj && detailsObj.brand_name) brandName = detailsObj.brand_name;
    else if (record.title) brandName = record.title;

    const brandImageUrl = (detailsObj && detailsObj.brand_image_url) ? detailsObj.brand_image_url : 'https://via.placeholder.com/150?text=Gorsel+Yok';

    let taskTypeName = String(childTypeId);
    const { data: ttData } = await supabaseAdmin.from('transaction_types').select('name, alias').eq('id', childTypeId).maybeSingle();
    if (ttData) taskTypeName = ttData.alias || ttData.name || taskTypeName;

    let targetTemplateId = `tmpl_${childTypeId}_document`;
    const { data: rule } = await supabaseAdmin.from('template_rules').select('template_id').eq('id', `rule_doc_index_${childTypeId}`).maybeSingle();
    if (rule && rule.template_id) targetTemplateId = rule.template_id;

    const { data: template } = await supabaseAdmin.from('mail_templates').select('*').eq('id', targetTemplateId).maybeSingle();
    
    // --- LİSTELERİ ÇÖZÜMLEME (Sınıflar ve Başvuru Sahipleri) ---
    let applicantNames = "-";
    if (record.applicants && record.applicants.length > 0) {
        applicantNames = record.applicants.map((a: any) => a.persons?.name).filter(Boolean).join(", ");
    }

    let classNumbers = "-";
    if (record.classes && record.classes.length > 0) {
        classNumbers = record.classes.map((c: any) => c.class_no).filter(Boolean).join(", ");
    }

    // --- İTİRAZ SAHİBİ VE EPATS VERİLERİ (İz Sürme) ---
    let oppositionOwner = "-";
    if (transactionId) {
        const { data: txData } = await supabaseAdmin.from('transactions').select('opposition_owner, parent_id').eq('id', transactionId).single();
        if (txData) {
            if (txData.opposition_owner) oppositionOwner = txData.opposition_owner;
            else if (txData.parent_id) {
                const { data: pTx } = await supabaseAdmin.from('transactions').select('opposition_owner').eq('id', txData.parent_id).single();
                if (pTx && pTx.opposition_owner) oppositionOwner = pTx.opposition_owner;
            }
        }
    }

    let epatsEvrakNo = "-";
    if (pdfId) {
        const { data: docData } = await supabaseAdmin.from('incoming_documents').select('document_number').eq('id', pdfId).maybeSingle();
        if (docData && docData.document_number) epatsEvrakNo = docData.document_number;
    }

    // --- KARAR VE DAVA ANALİZİ MANTIĞI (Eski Firebase'den Birebir Kopyalandı) ---
    const isPortfolio = record.record_owner_type === 'self';
    const txType = String(childTypeId);
    
    let decisionAnalysis = {
        isLawsuitRequired: false,
        resultText: "-", statusText: "-", statusColor: "#333", 
        summaryText: "", boxColor: "#e8f0fe", boxBorder: "#0d6efd"      
    };

    if (["31", "32", "33", "34", "35", "36"].includes(txType)) {
        if (txType === "31") {
            decisionAnalysis.resultText = "BAŞVURU SAHİBİ - İTİRAZ KABUL";
            if (isPortfolio) { 
                decisionAnalysis.statusText = "LEHİMİZE (Kazanıldı)"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "Başvurumuza ilişkin yapılan itiraz kabul edilmiştir (Başvuru Sahibi lehine sonuç). Tescil süreci devam edecektir.";
            } else { 
                decisionAnalysis.statusText = "ALEYHİMİZE (Rakip Kazandı)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "Rakip başvuru lehine karar verilmiştir (Bizim itirazımız reddedilmiş gibi işlem görür). Bu karara karşı dava açılması gerekmektedir.";
            }
        } else if (txType === "32") {
            decisionAnalysis.resultText = "KISMEN KABUL"; decisionAnalysis.statusText = "KISMEN ALEYHE"; decisionAnalysis.statusColor = "#d97706"; decisionAnalysis.isLawsuitRequired = true; 
            if (isPortfolio) decisionAnalysis.summaryText = "Başvurumuz kısmen kabul edilmiş, kısmen reddedilmiştir. Reddedilen sınıflar için dava açma hakkımız doğmuştur.";
            else decisionAnalysis.summaryText = "Rakip başvuru kısmen kabul edilmiştir. Rakibin kazandığı kısımlar için dava açma hakkımız vardır.";
        } else if (txType === "33") {
            decisionAnalysis.resultText = "BAŞVURU SAHİBİ - İTİRAZ RET";
            if (isPortfolio) { 
                decisionAnalysis.statusText = "ALEYHİMİZE (Başvurumuz Reddedildi)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "Başvurumuza ilişkin itiraz süreci aleyhimize sonuçlanmış ve başvurumuz reddedilmiştir. Dava açılması gerekmektedir.";
            } else { 
                decisionAnalysis.statusText = "LEHİMİZE (Rakip Reddedildi)"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "Başvuru sahibi markasının reddedilmesine karar verilmiştir. Karar lehimizedir.";
            }
        } else if (txType === "34") {
            decisionAnalysis.resultText = "İTİRAZ SAHİBİ - İTİRAZ KABUL";
            if (isPortfolio) { 
                decisionAnalysis.statusText = "ALEYHİMİZE (Karşı Taraf Kazandı)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "İtiraz sahibi lehine karar verilmiştir (Aleyhimize). Dava açılması gerekmektedir.";
            } else { 
                decisionAnalysis.statusText = "LEHİMİZE"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "İtiraz sahibi lehine verilen karar bizim lehimizedir.";
            }
        } else if (txType === "35") {
            decisionAnalysis.resultText = "KISMEN KABUL"; decisionAnalysis.statusText = "KISMEN ALEYHE"; decisionAnalysis.statusColor = "#d97706"; decisionAnalysis.isLawsuitRequired = true;
            if (isPortfolio) decisionAnalysis.summaryText = "Karar kısmen aleyhimize sonuçlanmıştır. Kaybettiğimiz kısımlar için dava açma hakkımız vardır.";
            else decisionAnalysis.summaryText = "Karar kısmen lehimize, kısmen aleyhimizedir. Aleyhe olan kısımlar için dava açılabilir.";
        } else if (txType === "36") {
            decisionAnalysis.resultText = "İTİRAZ SAHİBİ - İTİRAZ RET";
            if (isPortfolio) { 
                decisionAnalysis.statusText = "LEHİMİZE (İtiraz Reddedildi)"; decisionAnalysis.statusColor = "#237804"; decisionAnalysis.isLawsuitRequired = false; decisionAnalysis.summaryText = "İtiraz sahibinin talebi reddedilmiştir. Karar lehimizedir.";
            } else { 
                decisionAnalysis.statusText = "ALEYHİMİZE (İtirazımız Reddedildi)"; decisionAnalysis.statusColor = "#d32f2f"; decisionAnalysis.isLawsuitRequired = true; decisionAnalysis.summaryText = "Yaptığımız itiraz nihai olarak reddedilmiştir. Karşı taraf markası için tescil süreci devam edecektir.";
            }
        }
    } else if (txType === "29") {
        decisionAnalysis = { isLawsuitRequired: true, resultText: "KISMEN KABUL", statusText: "KISMEN RET", statusColor: "#d97706", summaryText: "Karara itirazımız kısmen kabul edilmiştir.", boxColor: "#fff2f0", boxBorder: "#ff4d4f" };
    } else if (txType === "30") {
        decisionAnalysis = { isLawsuitRequired: true, resultText: "RET", statusText: "NİHAİ RET", statusColor: "#d32f2f", summaryText: "Karara itirazımız reddedilmiştir.", boxColor: "#fff2f0", boxBorder: "#ff4d4f" };
    }

    if (decisionAnalysis.isLawsuitRequired) {
        decisionAnalysis.boxColor = "#fff2f0"; decisionAnalysis.boxBorder = "#ff4d4f";
    } else {
        decisionAnalysis.boxColor = "#f6ffed"; decisionAnalysis.boxBorder = "#52c41a";
    }

    let davaSonTarihi = "-";
    if (decisionAnalysis.isLawsuitRequired && tebligTarihi) {
        try {
            const parts = tebligTarihi.split(/[.\/]/);
            let d = new Date();
            if (parts.length === 3) d = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}T12:00:00Z`);
            else d = new Date(tebligTarihi);
            
            if (!isNaN(d.getTime())) {
                d.setMonth(d.getMonth() + 2);
                if (d.getDay() === 6) d.setDate(d.getDate() + 2); // Cmt -> Pzt
                if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Paz -> Pzt
                davaSonTarihi = d.toLocaleDateString('tr-TR');
            }
        } catch(e) {}
    }

    const formatDateTR = (dStr: string) => {
        if (!dStr) return '-';
        try { 
            const parts = dStr.split(/[.\/]/);
            if (parts.length === 3) return `${parts[0].padStart(2, '0')}.${parts[1].padStart(2, '0')}.${parts[2]}`;
            const d = new Date(dStr); return isNaN(d.getTime()) ? dStr : d.toLocaleDateString('tr-TR'); 
        } catch { return dStr; }
    };

    // 🔥 2. ESKİ FİREBASE'DEKİ TÜM PARAMETRELER (TAM LİSTE)
    const placeholders: Record<string, string> = { 
      'markName': brandName, 
      'proje_adi': brandName,
      'relatedIpRecordTitle': brandName,
      'applicationNo': record.application_number || '-',
      'basvuru_no': record.application_number || '-',
      'clientName': "Değerli Müvekkilimiz",
      'muvekkil_adi': "Değerli Müvekkilimiz",
      'date': new Date().toLocaleDateString('tr-TR'),
      'teblig_tarihi': formatDateTR(tebligTarihi),
      'son_itiraz_tarihi': formatDateTR(sonItirazTarihi),
      'resmi_son_cevap_tarihi': formatDateTR(sonItirazTarihi),
      'objection_deadline': formatDateTR(sonItirazTarihi),
      'transactionDate': formatDateTR(tebligTarihi),
      'docType': taskTypeName,
      'islem_turu_adi': taskTypeName,
      'markImageUrl': brandImageUrl,
      'itiraz_sahibi': oppositionOwner,
      'son_odeme_tarihi': "-",
      'epats_evrak_no': epatsEvrakNo,
      'epats_konu': "-",
      'applicantNames': applicantNames,
      'classNumbers': classNumbers,
      'applicationDate': formatDateTR(record.application_date),
      'karar_sonucu_baslik': decisionAnalysis.resultText,
      'karar_durumu_metni': decisionAnalysis.statusText,
      'karar_durumu_renk': decisionAnalysis.statusColor,
      'aksiyon_kutusu_bg': decisionAnalysis.boxColor,
      'aksiyon_kutusu_border': decisionAnalysis.boxBorder,
      'karar_ozeti_detay': decisionAnalysis.summaryText + (decisionAnalysis.isLawsuitRequired ? "<br><br>Bu karara karşı belirtilen tarihe kadar <strong>YİDK Kararının İptali davası</strong> açma hakkınız bulunmaktadır." : "<br><br>Şu an için tarafınızca yapılması gereken bir işlem bulunmamaktadır."),
      'dava_son_tarihi': davaSonTarihi,
      'dava_son_tarihi_display_style': (davaSonTarihi && davaSonTarihi !== "-") ? "block" : "none"
    };

    let finalBody = template?.body || template?.body1 || `<p>Yeni evrak tebliğ edilmiştir. Evrak tipi: ${taskTypeName}</p>`;
    let finalSubject = template?.subject || template?.mail_subject || `Evreka IP: Yeni Evrak Bildirimi (${brandName})`;

    // 🔥 3. ESNEK REGEX: (Örn: {{ itiraz_sahibi }} içindeki boşlukları tolere eder)
    const replaceVars = (str: string) => {
        if (!str) return "";
        return str.replace(/{{\s*([\w_]+)\s*}}/g, (match, key) => {
            return placeholders[key] !== undefined ? String(placeholders[key]) : match;
        });
    };

    finalSubject = replaceVars(finalSubject);
    finalBody = replaceVars(finalBody);

    let parsedObjectionDeadline = null;
    if (sonItirazTarihi && typeof sonItirazTarihi === 'string') {
        const parts = sonItirazTarihi.split(/[.\/]/);
        if (parts.length === 3) {
            parsedObjectionDeadline = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}T12:00:00Z`).toISOString();
        }
    }

    const uniqueTo = toList || [];
    const uniqueCc = ccList || [];

    const insertObject = {
      id: crypto.randomUUID(),
      related_ip_record_id: recordId,
      subject: finalSubject,
      body: finalBody,
      to_list: uniqueTo,  
      cc_list: uniqueCc,  
      source_document_id: pdfId,
      associated_transaction_id: transactionId || null, 
      template_id: targetTemplateId,
      status: uniqueTo.length === 0 ? 'missing_info' : 'pending',
      is_draft: uniqueTo.length === 0, 
      created_at: new Date().toISOString(),
      missing_fields: uniqueTo.length === 0 ? ['to_list'] : [],
      objection_deadline: parsedObjectionDeadline,
      source: 'indexing_automation' 
    };

    const { error: insertError } = await supabaseAdmin.from('mail_notifications').insert(insertObject);
    if (insertError) throw new Error("Mail kaydı oluşturulamadı: " + insertError.message);

    return new Response(JSON.stringify({ success: true, toCount: uniqueTo.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error("🔥 Mail bildirim Edge Function hatası:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 });
  }
});