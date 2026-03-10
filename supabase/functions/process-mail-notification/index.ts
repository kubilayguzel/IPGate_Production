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

    // 🔥 DİNAMİK GÖNDERİCİ VE YANITLAMA (REPLY-TO) AYARLARI

    // 1. SMTP'ye giriş yapacak ve maili fiziksel olarak çıkaracak adres (Spam koruması için tek hesap yeterli)
    const systemEmail = "info@evrekagroup.com"; 
    
    // 2. Müşteri "Yanıtla" dediğinde cevapların HER ZAMAN düşeceği adres
    const replyToAddress = "selcanakoglu@evrekagroup.com"; 

    // 3. Müşterinin göreceği İsim (Varsayılan)
    let senderName = "IPGATE - EVREKA GROUP";

    // Eğer butona basan kişinin e-postası (senderEmail) arayüzden geldiyse, veritabanından adını bulalım
    if (senderEmail) {
        const { data: userData } = await supabaseClient
            .from('users')
            .select('display_name')
            .eq('email', senderEmail)
            .maybeSingle();

        if (userData && userData.display_name) {
            // Örn: "Kubilay Güzel | IPGATE - EVREKA GROUP"
            senderName = `${userData.display_name} | IPGATE - EVREKA GROUP`;
        } else {
            // İsmi veritabanında yoksa mailden isim üretir
            const namePart = senderEmail.split('@')[0];
            const capitalized = namePart.charAt(0).toUpperCase() + namePart.slice(1);
            senderName = `${capitalized} | IPGATE - EVREKA GROUP`;
        }
    }

    // 2. Mail Gönderim Ayarları (Sistemin çıkış kapısı)
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        // DİKKAT: info hesabından çıkış yapacaksak, info hesabının şifresini buraya girmelisiniz.
        // Daha önce kubilayguzel@.. için şifre girmiştik. info hesabı için Gmail'den yeni bir 
        // 16 haneli uygulama şifresi alıp buraya boşluksuz yapıştırmalısınız.
        user: "info@evrekagroup.com", 
        pass: "urpl kfoj idye jgyp" 
      },
    });

    console.log(`📤 Mail gönderiliyor... Görünür İsim: ${senderName} | Reply-To: ${replyToAddress}`);

    // 3. Maili Gönder
    const info = await transporter.sendMail({
      from: `"${senderName}" <${systemEmail}>`, // Görünür İsim + Gerçek Çıkış Maili
      replyTo: replyToAddress,                  // Yanıtlar her zaman Selcan Hanım'a
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