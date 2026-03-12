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

        const { data: queueItems } = await supabase
            .from('bulletin_fetch_queue')
            .select('*')
            .eq('status', 'pending')
            .limit(10);

        if (!queueItems || queueItems.length === 0) {
            return new Response(JSON.stringify({ success: true, message: "Kuyruk boş" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const ids = queueItems.map(q => q.id);
        await supabase.from('bulletin_fetch_queue').update({ status: 'processing' }).in('id', ids);

        let successCount = 0;

        for (const item of queueItems) {
            try {
                console.log(`[TEST] ${item.application_number} YENİ ŞEMA için sorgulanıyor...`);
                
                // EPATS İSTEĞİ (Güvenlik Duvarı Aşma Başlıklarıyla)
                const epatsRes = await fetch("https://opts.turkpatent.gov.tr/api/trademark-search/mark", {
                    method: "POST",
                    headers: { 
                        "Accept": "application/json, text/plain, */*",
                        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
                        "Content-Type": "application/json",
                        "Origin": "https://opts.turkpatent.gov.tr",
                        "Referer": "https://opts.turkpatent.gov.tr/trademark",
                        "Sec-Fetch-Dest": "empty",
                        "Sec-Fetch-Mode": "cors",
                        "Sec-Fetch-Site": "same-origin",
                        // DİKKAT: EPATS'tan aldığınız güncel Cookie'yi buraya yapıştırın:
                        "Cookie": "JSESSIONID=D1AAEBC5C13313773BE5F74FECAD995D; TS01249912=0187428d31851f723addcdf8ae0834afea9b9908a5f3b805b849877af5b30a578052e23c910809dc8dca3c4acaa4d3da8bf885144a194edb068d9a25bd9c184ebc14f30728; _ga=GA1.1.810903385.1765797994; _ga_RSBG2H3YFV=GS2.1.s1773303164$o155$g0$t1773303164$j60$l0$h0; access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZTY3ZjgyMy1lNDBjLTRkNDAtYTM4OS1lZWYzMDE2NjI1ZjgiLCJyb2xlcyI6WyJQQVRFTlRfVFJBQ0tFUiIsIlRSQURFTUFSS19TRUFSQ0hFUiJdLCJpYXQiOjE3NzMzMDMxOTAsImV4cCI6MTc3MzMwNTg5MH0.zEGiS4r49u1TIJy9K2dKXiN7D02P9G1sW7q25t64lpE; TS01777e0b=0187428d319534fbe3acda051da39f6766fde30bb8f3b805b849877af5b30a578052e23c915d6066059fedd7f74f8ebaf0398b30cc484a9ac4dfd121c9bdfec7b20595d3dd", 
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    },
                    body: JSON.stringify({
                        applicationNo: item.application_number,
                        documentNo: "", internationalRegistrationNo: "", registrationNo: ""
                    })
                });

                const status = epatsRes.status;
                const rawText = await epatsRes.text(); 

                if (status !== 200) throw new Error(`EPATS ${status} hatası döndürdü.`);

                let responseJson;
                try {
                    responseJson = JSON.parse(rawText);
                } catch(e) {
                    throw new Error("EPATS'tan dönen veri JSON formatında değil. (Cookie süresi bitmiş olabilir).");
                }
                
                const markInfo = responseJson?.data?.markInformation;
                if (!markInfo || !markInfo.markName) throw new Error("Veri çekildi ama markName bulunamadı.");

                // 1. Logoyu Storage'a Kaydet
                let logoUrl = null;
                if (markInfo.figure) {
                    const base64Data = markInfo.figure.replace(/^data:image\/\w+;base64,/, "");
                    const byteCharacters = atob(base64Data);
                    const byteArray = new Uint8Array(byteCharacters.length);
                    for (let i = 0; i < byteCharacters.length; i++) byteArray[i] = byteCharacters.charCodeAt(i);

                    const fileName = `${item.application_number.replace('/', '_')}.jpg`;
                    const { error: uploadError } = await supabase.storage
                        .from('brand_images')
                        .upload(`bulletins/${fileName}`, byteArray, { contentType: 'image/jpeg', upsert: true });

                    if (!uploadError) {
                        const { data: publicUrlData } = supabase.storage.from('brand_images').getPublicUrl(`bulletins/${fileName}`);
                        logoUrl = publicUrlData.publicUrl;
                    }
                }

                // --- YENİ ŞEMA İÇİN VERİ HAZIRLIĞI ---
                const bulletinNo = markInfo.bulletinNumber || item.bulletin_no || 'BILINMIYOR';
                const mainBulletinId = `bulletin_main_${bulletinNo}`;
                const appNoFormatted = item.application_number.replace('/', '_');
                const bulletinRecordId = `bull_${bulletinNo}_app_${appNoFormatted}`;

                // "29 / 30 / " formatını diziye çevir: ["29", "30"]
                const niceClassesArray = markInfo.niceClasses 
                    ? markInfo.niceClasses.split('/').map((c: string) => c.trim()).filter((c: string) => c.length > 0)
                    : [];

                // Sahipleri JSONB nesnesine çevir
                const holdersArray = markInfo.holdName ? [{ name: markInfo.holdName }] : [];

                // 2. trademark_bulletins Tablosuna Ekle (Ana Bülten)
                const { error: bulletinError } = await supabase.from('trademark_bulletins').upsert({
                    id: mainBulletinId,
                    bulletin_no: bulletinNo,
                    bulletin_date: markInfo.bulletinDate || null
                });
                if (bulletinError) throw bulletinError;

                // 3. trademark_bulletin_records Tablosuna Ekle (Marka Kaydı)
                const { error: recordError } = await supabase.from('trademark_bulletin_records').upsert({
                    id: bulletinRecordId,
                    bulletin_id: mainBulletinId,
                    application_number: item.application_number,
                    brand_name: markInfo.markName,
                    application_date: markInfo.applicationDate,
                    nice_classes: niceClassesArray,
                    holders: holdersArray,
                    image_url: logoUrl,
                    source: 'turkpatent_api' // Orijinal bültenlerden ayırmak için etiket
                });
                if (recordError) throw recordError;

                // 4. trademark_bulletin_goods Tablosuna Ekle (Sınıflar)
                if (niceClassesArray.length > 0) {
                    const goodsPayload = niceClassesArray.map((cls: string) => ({
                        id: `${bulletinRecordId}_class_${cls}`,
                        bulletin_record_id: bulletinRecordId,
                        class_number: cls,
                        class_text: "Eşya listesi EPATS API'den çekilmedi." // İleride doldurulabilir
                    }));

                    const { error: goodsError } = await supabase.from('trademark_bulletin_goods').upsert(goodsPayload);
                    if (goodsError) throw goodsError;
                }
                
                // Tamamlandı işaretle
                await supabase.from('bulletin_fetch_queue').update({ status: 'completed' }).eq('id', item.id);
                successCount++;

            } catch (err: any) {
                console.error(`[HATA - ${item.application_number}]:`, err.message);
                await supabase.from('bulletin_fetch_queue').update({ status: 'failed', error_message: err.message }).eq('id', item.id);
            }
        }

        return new Response(JSON.stringify({ success: true, processed: successCount }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error: any) {
        console.error("[GENEL HATA]:", error.message);
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
});