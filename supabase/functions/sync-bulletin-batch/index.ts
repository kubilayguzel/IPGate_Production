import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        console.log("-----------------------------------------");
        console.log("[BAŞLANGIÇ] Yeni paket isteği alındı.");
        
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        const body = await req.json();
        const { bulletinNo, bulletinDate, batch } = body;

        console.log(`[BİLGİ] Bülten No: ${bulletinNo}, Eklentiden Gelen Tarih: ${bulletinDate}, Kayıt: ${batch?.length}`);

        if (!batch || batch.length === 0) {
             console.log("[UYARI] Boş paket geldi, işlem iptal.");
             return new Response(JSON.stringify({ success: true, message: "Empty batch" }), { headers: corsHeaders });
        }

        const mainBulletinId = `bulletin_main_${bulletinNo}`;

        // -- BÜLTEN TARİHİ FORMATINI KESİNLEŞTİRME (26.12.2025 -> 2025-12-26T12:00:00.000Z) --
        let dbBulletinDate = new Date().toISOString(); // Varsayılan: Bugün
        if (bulletinDate) {
            const dateParts = bulletinDate.split('.');
            if (dateParts.length === 3) {
                // Saat farkından gün atlamaması için öğlen 12:00:00 set ediyoruz
                dbBulletinDate = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}T12:00:00Z`).toISOString();
            } else {
                dbBulletinDate = new Date(bulletinDate).toISOString();
            }
        }
        
        console.log(`[BİLGİ] Veritabanına yazılacak BÜLTEN Tarihi: ${dbBulletinDate}`);

        // 1. ANA BÜLTEN KAYDI
        console.log(`[VERİTABANI] trademark_bulletins tablosuna yazılıyor: ${mainBulletinId}`);
        const { error: bulletinError } = await supabase.from('trademark_bulletins').upsert({
            id: mainBulletinId,
            bulletin_no: bulletinNo,
            bulletin_date: dbBulletinDate
        });

        if (bulletinError) {
            console.error("[HATA - BULLETIN UPSERT]:", bulletinError);
            throw new Error(bulletinError.message);
        }

        // 2. KAYITLARI DÖNGÜYE AL
        for (let idx = 0; idx < batch.length; idx++) {
            const item = batch[idx];
            
            const appNoFormatted = item.application_number.replace('/', '_');
            const bulletinRecordId = `bull_${bulletinNo}_app_${appNoFormatted}`;

            let logoUrl = null;

            // -- RESİM YÜKLEME --
            if (item.image_base64 && item.image_base64.includes('base64,')) {
                try {
                    const base64Data = item.image_base64.replace(/^data:image\/\w+;base64,/, "");
                    const byteCharacters = atob(base64Data);
                    const byteArray = new Uint8Array(byteCharacters.length);
                    for (let i = 0; i < byteCharacters.length; i++) byteArray[i] = byteCharacters.charCodeAt(i);

                    const fileName = `bulletins/${bulletinNo}/${appNoFormatted}.jpg`;
                    const { error: uploadError } = await supabase.storage
                        .from('brand_images')
                        .upload(fileName, byteArray, { contentType: 'image/jpeg', upsert: true });

                    if (!uploadError) {
                        const { data: publicUrlData } = supabase.storage.from('brand_images').getPublicUrl(fileName);
                        logoUrl = publicUrlData.publicUrl;
                    }
                } catch (imgErr) {
                     // Sessizce geç
                }
            }

            // -- BAŞVURU TARİHİ FORMATINI DÜZELTME --
            let dbAppDate = null;
            if (item.application_date) {
                const dateParts = item.application_date.split('.');
                if (dateParts.length === 3) {
                    dbAppDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
                } else {
                    dbAppDate = item.application_date;
                }
            }

            const niceClassesArray = item.nice_classes 
                ? item.nice_classes.split('/').map((c: string) => c.trim()).filter((c: string) => c.length > 0)
                : [];

            // -- RECORDS TABLOSUNA YAZMA --
            const { error: recordError } = await supabase.from('trademark_bulletin_records').upsert({
                id: bulletinRecordId,
                bulletin_id: mainBulletinId,
                application_number: item.application_number,
                brand_name: item.brand_name,
                application_date: dbAppDate, 
                nice_classes: niceClassesArray,
                holders: item.owner_name ? [{ name: item.owner_name }] : [],
                image_url: logoUrl,
                source: 'extension_scraper'
            });

            if (recordError) {
                 console.error(`[KRİTİK HATA - RECORD UPSERT ${item.application_number}]:`, recordError);
                 continue; 
            }

            // -- GOODS TABLOSUNA YAZMA --
            if (niceClassesArray.length > 0) {
                const goodsPayload = niceClassesArray.map((cls: string) => ({
                    id: `${bulletinRecordId}_class_${cls}`,
                    bulletin_record_id: bulletinRecordId,
                    class_number: parseInt(cls, 10) || 0,
                    class_text: "PDF/ZIP motorundan güncellenecek."
                }));
                
                await supabase.from('trademark_bulletin_goods').upsert(goodsPayload);
            }
        }

        console.log(`[BİTİŞ] Paket başarıyla tamamlandı. İşlenen: ${batch.length}`);
        return new Response(JSON.stringify({ success: true, processed: batch.length }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error: any) {
        console.error("[GENEL HATA]:", error.message || error);
        return new Response(JSON.stringify({ error: error.message || "Bilinmeyen Hata" }), { status: 500, headers: corsHeaders });
    }
});