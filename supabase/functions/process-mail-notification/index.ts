import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'
import nodemailer from "npm:nodemailer" 

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apiKey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // 🔥 YENİ: Arayüzden gönderilen 'senderEmail' bilgisini yakalıyoruz
    const { notificationId, mode, attachments, senderEmail } = await req.json();
    if (!notificationId) throw new Error("Bildirim ID'si eksik.");

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // 1. Bildirimi veritabanından çek
    const { data: notification, error: fetchErr } = await supabaseClient
      .from('mail_notifications')
      .select('*')
      .eq('id', notificationId)
      .single();

    if (fetchErr || !notification) throw new Error("Bildirim bulunamadı.");

    // DAVA ISI GUVENLIGI: Bildirim arayuzu, genel gorev eklerini de
    // iletebilir. Kullanici girdisi ve mail_attachments listesi dava isi
    // bildirimleri icin yetkili bir belge kaynagi OLAMAZ.
    const litigationTaskTypes = new Set([
      '49', '54', '55', '56', '57', '58', '59', '60',
      '61', '62', '63', '64', '65', '91', '93', '94', '96', '97'
    ]);
    let task: {task_type_id?: string | number | null} | null = null;
    // Generic mail, dava ozel motoru donusturmeden once goruntulenirse
    // bile is turune bakarak yanlis ekleri engelle.
    if (notification.associated_task_id &&
        (notification.source === 'litigation_task_completion' ||
         notification.source === 'task_completion')) {
      const { data: taskData, error: taskError } = await supabaseClient
        .from('tasks')
        .select('task_type_id')
        .eq('id', String(notification.associated_task_id))
        .maybeSingle();
      if (taskError || !taskData) {
        throw new Error('Tamamlanan isin turu dogrulanamadi; bildirim gonderimi durduruldu.');
      }
      task = taskData;
    }
    const isLitigationCompletion =
      notification.source === 'litigation_task_completion' ||
      (notification.source === 'task_completion' &&
       litigationTaskTypes.has(String(task?.task_type_id || '')));

    let rawAttachments: Array<{name: string; url: string}> = [];
    if (isLitigationCompletion) {
      const taskId = notification.associated_task_id;
      if (!taskId || !task) {
        throw new Error('Dava bildiriminde bagli is bulunamadigi icin ekler dogrulanamadi.');
      }

      // Tip 49 dava acilisi: Mahkemeye Sunulan Dava Dilekcesi / Tevzi PDF
      // (epats_document). Diger dava work isleri: mahkemeye sunulmus
      // resmi PDF (court_filed_pdf). Belgeler & Dosyalar: task_document,
      // petition, petition_previous vb. ASLA mail eki olamaz.
      const taskType = String(task.task_type_id || '');
      const officialType = taskType === '49'
        ? 'epats_document'
        : 'court_filed_pdf';

      const { data: filedDocs, error: filedError } = await supabaseClient
        .from('task_documents')
        .select('document_name, document_url, document_type')
        .eq('task_id', String(taskId))
        .eq('document_type', officialType);
      if (filedError) {
        throw new Error('Mahkemeye sunulan resmi PDF kaydi okunamadi; bildirim gonderilmedi.');
      }

      // Yalnizca yukaridaki ayrilmis resmi evrak alanindan kaydedilen
      // dosyalari kabul ediyoruz. Daha onceden yanlis eklenmis kayitlar,
      // arayuzden gelen URL'ler ve transaction_documents dahil DEGIL.
      rawAttachments = (filedDocs || [])
        .filter((doc: any) => Boolean(doc.document_url))
        .map((doc: any) => ({
          name: doc.document_name || 'Mahkemeye_Sunulan_PDF.pdf',
          url: doc.document_url
        }));

      // Eski (henuz gonderilmemis) bildirimlerde kalan yanlis
      // mail_attachments iliskilerini de temizle. Kaynak task_documents
      // veya Supabase Storage dosyalarina DOKUNULMAZ.
      const allowedUrls = new Set(rawAttachments.map(doc => doc.url));
      const { data: existing, error: existingError } = await supabaseClient
        .from('mail_attachments')
        .select('id, url')
        .eq('notification_id', notificationId);
      if (existingError) {
        throw new Error('Dava bildiriminin mevcut ekleri denetlenemedi; gonderim durduruldu.');
      }
      const staleIds = (existing || [])
        .filter((doc: any) => !allowedUrls.has(doc.url))
        .map((doc: any) => doc.id);
      if (staleIds.length > 0) {
        const { error: cleanupError } = await supabaseClient
          .from('mail_attachments')
          .delete()
          .eq('notification_id', notificationId)
          .in('id', staleIds);
        if (cleanupError) {
          throw new Error('Dava bildiriminin izinsiz ekleri temizlenemedi; gonderim durduruldu.');
        }
      }
      console.log(`[LITIGATION_MAIL] task=${taskId}, tip=${taskType}, izinli_pdf=${rawAttachments.length}, temizlenen_ek=${staleIds.length}`);
    } else {
      // Dava olmayan tum bildirimlerin eski davranisi aynen korunur.
      const { data: dbAttachments, error: dbError } = await supabaseClient
        .from('mail_attachments')
        .select('file_name, url')
        .eq('notification_id', notificationId);
      if (dbError) throw new Error('Bildirim ekleri okunamadi: ' + dbError.message);
      rawAttachments = Array.isArray(attachments) ? [...attachments] : [];
      if (dbAttachments?.length) {
        rawAttachments.push(...dbAttachments.map((doc: any) => ({
          name: doc.file_name,
          url: doc.url
        })));
      }
    }

    // 🔥 ÇÖZÜM: Mükerrer ek sorununu önlemek için URL bazlı tekilleştirme (Deduplication) yapıyoruz
    const allAttachments: any[] = [];
    const seenUrls = new Set();

    for (const att of rawAttachments) {
        if (att.url && !seenUrls.has(att.url)) {
            seenUrls.add(att.url);
            allAttachments.push(att);
        }
    }

    const toList = Array.isArray(notification.to_list) ? notification.to_list : [];
    const ccList = Array.isArray(notification.cc_list) ? notification.cc_list : [];

    if (toList.length === 0) throw new Error("Kime (To) alanı boş olamaz.");

    let finalSubject = notification.subject || "";
    if (mode === 'reminder' && !finalSubject.includes('HATIRLATMA:')) {
        finalSubject = `HATIRLATMA: ${finalSubject}`;
    }

    // 🔥 ÇÖZÜM: Ekleri indirip hazırlama ve AKILLI BOYUT KONTROLÜ
    const finalAttachments: any[] = [];
    let totalAttachmentSize = 0;
    const MAX_SAFE_SIZE = 15 * 1024 * 1024; // 15 MB (Base64 çevrimi için bırakılan güvenli sınır)
    let extraLinksHtml = "";

    if (allAttachments && Array.isArray(allAttachments) && allAttachments.length > 0) {
        console.log(`📎 Toplam ${allAttachments.length} adet evrak indiriliyor...`);
        for (const file of allAttachments) {
            try {
                if (!file.url) continue;
                const fileResponse = await fetch(file.url);
                if (!fileResponse.ok) throw new Error(`Dosya indirilemedi. HTTP Status: ${fileResponse.status}`);
                
                const arrayBuffer = await fileResponse.arrayBuffer();
                const fileSize = arrayBuffer.byteLength;

                // Eğer toplam boyut 15MB'ı aşarsa, dosyayı ek yapmak yerine link olarak ayır
                if (totalAttachmentSize + fileSize > MAX_SAFE_SIZE) {
                    console.log(`⚠️ ${file.name} limiti aşıyor, e-postaya link olarak eklenecek.`);
                    const sizeInMb = (fileSize / (1024 * 1024)).toFixed(2);
                    extraLinksHtml += `<li style="margin-bottom: 8px;"><a href="${file.url}" style="color: #0056b3; font-weight: bold; text-decoration: none;">📄 ${file.name || 'Evrak.pdf'}</a> <span style="color: #6c757d; font-size: 12px;">(${sizeInMb} MB)</span></li>`;
                } else {
                    totalAttachmentSize += fileSize;
                    const buffer = new Uint8Array(arrayBuffer);
                    finalAttachments.push({
                        filename: file.name || 'Evrak.pdf',
                        content: buffer 
                    });
                }
            } catch (err) {
                console.error(`❌ Evrak yükleme hatası (${file.name}):`, err);
                if (isLitigationCompletion) {
                    throw new Error('Mahkemeye sunulan PDF eklenemedi; eksik evrakla bildirim gonderilmedi.');
                }
            }
        }
    }

    // Eğer boyutu aştığı için linke dönüşen dosyalar varsa, HTML gövdesinin en altına şık bir kutuyla ekle
    let finalBodyHtml = notification.body;
    if (extraLinksHtml !== "") {
        finalBodyHtml += `
            <br><hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; border: 1px solid #e9ecef;">
                <h4 style="margin-top: 0; color: #495057; font-family: Arial, sans-serif;">📎 E-Posta Boyut Sınırını Aşan Ekler</h4>
                <p style="font-size: 13px; color: #6c757d; font-family: Arial, sans-serif;">Aşağıdaki dosyalar e-posta güvenlik sınırlarını aştığı için güvenli bağlantı (link) olarak sunulmuştur. Tıklayarak indirebilirsiniz:</p>
                <ul style="list-style-type: none; padding-left: 0; font-family: Arial, sans-serif;">
                    ${extraLinksHtml}
                </ul>
            </div>
        `;
    }

    // 🔥 DİNAMİK GÖNDERİCİ VE YANITLAMA (REPLY-TO) AYARLARI
    const systemEmail = "info@evrekagroup.com"; 
    const replyToAddress = "selcanakoglu@evrekagroup.com"; 
    let senderName = "IPGATE - EVREKA GROUP";

    if (senderEmail) {
        const { data: userData } = await supabaseClient
            .from('users')
            .select('display_name')
            .eq('email', senderEmail)
            .maybeSingle();

        if (userData && userData.display_name) {
            senderName = `${userData.display_name} | IPGATE - EVREKA GROUP`;
        } else {
            const namePart = senderEmail.split('@')[0];
            const capitalized = namePart.charAt(0).toUpperCase() + namePart.slice(1);
            senderName = `${capitalized} | IPGATE - EVREKA GROUP`;
        }
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "info@evrekagroup.com", 
        pass: "urpl kfoj idye jgyp" 
      },
    });

    console.log(`📤 Mail gönderiliyor... Görünür İsim: ${senderName} | Reply-To: ${replyToAddress}`);

    // 3. Maili Gönder
    const info = await transporter.sendMail({
      from: `"${senderName}" <${systemEmail}>`, 
      replyTo: replyToAddress,                  
      to: [...new Set(toList)].join(','),
      cc: [...new Set(ccList)].join(','),
      subject: finalSubject,
      html: finalBodyHtml, // 🔥 Artık linklerin de gömülü olduğu yeni HTML'i kullanıyoruz!
      attachments: finalAttachments 
    });

    console.log(`✅ Mail başarıyla iletildi! MessageID: ${info.messageId}`);

    // 4. Veritabanını Güncelle
    const updatePayload: any = { 
        status: 'sent', 
        sent_at: new Date().toISOString()
    };

    if (mode === 'reminder') {
        updatePayload.last_reminder_at = new Date().toISOString(); 
    }

    await supabaseClient
      .from('mail_notifications')
      .update(updatePayload)
      .eq('id', notificationId);

    return new Response(JSON.stringify({ success: true, messageId: info.messageId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    });

  } catch (error: any) {
    console.error("❌ Gönderim Hatası:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400
    });
  }
});