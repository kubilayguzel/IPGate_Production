import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        const { bulletinNo, batch } = await req.json();

        if (!batch || batch.length === 0) {
             return new Response(JSON.stringify({ success: true, message: "Empty batch" }), { headers: corsHeaders });
        }

        const mainBulletinId = `bulletin_main_${bulletinNo}`;

        // 1. Ana Bülten Kaydını (Yoksa) Oluştur
        await supabase.from('trademark_bulletins').upsert({
            id: mainBulletinId,
            bulletin_no: bulletinNo,
            bulletin_date: new Date().toISOString() // API'den tarih gelmediği için bugünü atıyoruz, PDF'ten güncellenebilir
        });

        // 2. Her Bir Kaydı İşle
        for (const item of batch) {
            const appNoFormatted = item.application_number.replace('/', '_');
            const bulletinRecordId = `bull_${bulletinNo}_app_${appNoFormatted}`;

            let logoUrl = null;

            // Base64 Görseli Storage'a Yükleme
            if (item.image_base64 && item.image_base64.includes('base64,')) {
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
            }

            // Sınıfları Ayıkla ("29 / 30 / 35 / " formatından)
            const niceClassesArray = item.nice_classes 
                ? item.nice_classes.split('/').map((c: string) => c.trim()).filter((c: string) => c.length > 0)
                : [];

            // Ana Tabloya Yaz
            await supabase.from('trademark_bulletin_records').upsert({
                id: bulletinRecordId,
                bulletin_id: mainBulletinId,
                application_number: item.application_number,
                brand_name: item.brand_name,
                application_date: item.application_date,
                nice_classes: niceClassesArray,
                holders: item.owner_name ? [{ name: item.owner_name }] : [],
                image_url: logoUrl,
                source: 'extension_scraper'
            });

            // Eşyalar Tablosuna "Placeholder (Yer Tutucu)" Yaz (Sonra PDF ile Yamalanacak)
            if (niceClassesArray.length > 0) {
                const goodsPayload = niceClassesArray.map((cls: string) => ({
                    id: `${bulletinRecordId}_class_${cls}`,
                    bulletin_record_id: bulletinRecordId,
                    class_number: parseInt(cls, 10) || 0,
                    class_text: "PDF/ZIP motorundan güncellenecek." // 🔥 Eşya yaması için yer tutucu!
                }));
                await supabase.from('trademark_bulletin_goods').upsert(goodsPayload);
            }
        }

        return new Response(JSON.stringify({ success: true, processed: batch.length }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error: any) {
        console.error("[HATA]:", error.message);
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
});