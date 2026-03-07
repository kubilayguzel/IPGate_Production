// supabase/functions/process-mail-notification/index.ts
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
    const { notificationId, mode, attachments } = await req.json();
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

    // 🔥 DÜZELTME 1: Eski recipient stringi yerine yeni Array (to_list ve cc_list) sütunlarını kullanıyoruz
    const toList = Array.isArray(notification.to_list) ? notification.to_list : [];
    const ccList = Array.isArray(notification.cc_list) ? notification.cc_list : [];

    if (toList.length === 0) throw new Error("Kime (To) alanı boş olamaz.");

    let finalSubject = notification.subject || "";
    if (mode === 'reminder' && !finalSubject.includes('HATIRLATMA:')) {
        finalSubject = `HATIRLATMA: ${finalSubject}`;
    }

    // 🔥 DÜZELTME 2: Gelen PDF'leri URL'den indirip mail eklentisine dönüştürme
    const finalAttachments: any[] = [];
    
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
        console.log(`📎 Toplam ${attachments.length} adet evrak indiriliyor...`);
        
        for (const file of attachments) {
            try {
                if (!file.url) continue;
                
                // Supabase Storage veya dış URL üzerinden dosyayı fetch ile indiriyoruz
                const fileResponse = await fetch(file.url);
                if (!fileResponse.ok) throw new Error(`Dosya indirilemedi. HTTP Status: ${fileResponse.status}`);
                
                const arrayBuffer = await fileResponse.arrayBuffer();
                const buffer = new Uint8Array(arrayBuffer);

                // Nodemailer'ın anlayacağı formata ekle
                finalAttachments.push({
                    filename: file.name || 'Evrak.pdf',
                    content: buffer // Nodemailer Buffer/Uint8Array kabul eder
                });
                console.log(`✅ Evrak başarıyla eklendi: ${file.name}`);
            } catch (err) {
                console.error(`❌ Evrak yükleme hatası (${file.name}):`, err);
            }
        }
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

    console.log(`📤 Mail gönderiliyor... Alıcı: ${toList.join(',')}`);

    // 3. Maili Gönder (Ekleri de dahil ederek)
    const info = await transporter.sendMail({
      from: '"Evreka Patent" <info@evrekagroup.com>',
      to: [...new Set(toList)].join(','),
      cc: [...new Set(ccList)].join(','),
      subject: finalSubject,
      html: notification.body,
      attachments: finalAttachments // 🔥 İndirilen evraklar buraya ekleniyor!
    });

    console.log(`✅ Mail başarıyla iletildi! MessageID: ${info.messageId}`);

    // 4. Veritabanını Güncelle
    const updatePayload: any = { 
        status: 'sent', 
        sent_at: new Date().toISOString()
    };

    // 🔥 DÜZELTME 3: lastReminderAt json içine değil, doğrudan native sütuna yazılıyor
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