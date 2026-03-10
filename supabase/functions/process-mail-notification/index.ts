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

    const toList = Array.isArray(notification.to_list) ? notification.to_list : [];
    const ccList = Array.isArray(notification.cc_list) ? notification.cc_list : [];

    if (toList.length === 0) throw new Error("Kime (To) alanı boş olamaz.");

    let finalSubject = notification.subject || "";
    if (mode === 'reminder' && !finalSubject.includes('HATIRLATMA:')) {
        finalSubject = `HATIRLATMA: ${finalSubject}`;
    }

    // Ekleri (PDF vb.) URL'den indirip hazırlama
    const finalAttachments: any[] = [];
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
        console.log(`📎 Toplam ${attachments.length} adet evrak indiriliyor...`);
        for (const file of attachments) {
            try {
                if (!file.url) continue;
                const fileResponse = await fetch(file.url);
                if (!fileResponse.ok) throw new Error(`Dosya indirilemedi. HTTP Status: ${fileResponse.status}`);
                
                const arrayBuffer = await fileResponse.arrayBuffer();
                const buffer = new Uint8Array(arrayBuffer);

                finalAttachments.push({
                    filename: file.name || 'Evrak.pdf',
                    content: buffer 
                });
            } catch (err) {
                console.error(`❌ Evrak yükleme hatası (${file.name}):`, err);
            }
        }
    }

    // 🔥 DİNAMİK GÖNDERİCİ (REPLY-TO) AYARLARI
    const senderName = "IPGATE - EVREKA GROUP"; // İsim hep sabit ve kurumsal kalır
    const systemEmail = Deno.env.get('SMTP_USER') || 'info@evrekagroup.com'; // Ana gönderici adres
    let replyToAddress = systemEmail; // Varsayılan yanıt adresi

    if (senderEmail) {
        replyToAddress = senderEmail; // Müşteri yanıtla dediğinde mail doğrudan uzmana (size) gelir
    }

    // 2. Mail Gönderim Ayarları
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: Deno.env.get('SMTP_USER'),
        pass: Deno.env.get('SMTP_PASS'),
      },
    });

    console.log(`📤 Mail gönderiliyor... Görünür İsim: ${senderName} | Reply-To: ${replyToAddress}`);

    // 3. Maili Gönder (Dinamik Gönderici ve Reply-To eklendi)
    const info = await transporter.sendMail({
      from: `"${senderName}" <${systemEmail}>`, // 🔥 Spam koruması için sistem maili
      replyTo: replyToAddress,                  // 🔥 Müşteri yanıtla dediğinde uzmana gidecek adres
      to: [...new Set(toList)].join(','),
      cc: [...new Set(ccList)].join(','),
      subject: finalSubject,
      html: notification.body,
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