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
                console.log(`[TEST] ${item.application_number} için EPATS'a istek atılıyor...`);
                
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
                        // DİKKAT: Yeni ve güncel Cookie değerini buraya yapıştırın
                        "Cookie": "JSESSIONID=444AD658B0242957DD92547836E58AF1; TS01249912=0187428d3194ed97ade148b75d30f4afb9f00cf74cacdc42e5dedf4ecd9ee6071bbb3a07f2789333a0e9bdef99ddfb551cf5aa6b5046b96a6e8cfebc925d1d1c13ba143bfb; _ga=GA1.1.810903385.1765797994; _ga_RSBG2H3YFV=GS2.1.s1773235707$o153$g1$t1773235712$j55$l0$h0; access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZTY3ZjgyMy1lNDBjLTRkNDAtYTM4OS1lZWYzMDE2NjI1ZjgiLCJyb2xlcyI6WyJQQVRFTlRfVFJBQ0tFUiIsIlRSQURFTUFSS19TRUFSQ0hFUiJdLCJpYXQiOjE3NzMyMzU4OTAsImV4cCI6MTc3MzIzODU5MH0.JH0xZmiIBwZZX-5mW3zAOmzQsxwECdDimheVS2KzqA0; TS01777e0b=0187428d31bc1df41587659a1b43b4cc7fdc33377262eb9a5bc485fb0c6e26737b266421ea1d45ec56ed1de68a745699aa6137bffbeb2affe960f16009e709522df141a963", 
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    },
                    body: JSON.stringify({
                        applicationNo: item.application_number,
                        documentNo: "", internationalRegistrationNo: "", registrationNo: ""
                    })
                });

                const status = epatsRes.status;
                const rawText = await epatsRes.text(); 
                console.log(`[EPATS YANITI] HTTP Status: ${status}`);

                if (status !== 200) {
                    throw new Error(`EPATS ${status} hatası döndürdü.`);
                }

                let responseJson;
                try {
                    responseJson = JSON.parse(rawText);
                } catch(e) {
                    throw new Error("EPATS'tan dönen veri JSON formatında değil. Muhtemelen Cookie süresi doldu ve giriş sayfasına yönlendirdi.");
                }
                
                const markInfo = responseJson?.data?.markInformation;

                if (!markInfo || !markInfo.markName) {
                    throw new Error("Veri çekildi ama markName bulunamadı.");
                }

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

                // 🔥 ÇÖZÜM: 'ip_records' tablosundaki 'id' kolonu 'text' formatında ve null olamaz. 
                // Bu yüzden rastgele benzersiz bir UUID'yi metin olarak üretiyoruz.
                const generatedId = crypto.randomUUID();

                // 1. Ana Portföy Kaydı
                const { error: ipError } = await supabase.from('ip_records').insert({
                    id: generatedId, // Üretilen metin tabanlı ID
                    application_number: item.application_number,
                    application_date: markInfo.applicationDate,
                    record_owner_type: 'other', 
                    status: 'published',
                    ip_type: 'trademark'
                });

                if (ipError) throw ipError;

                // 2. Marka Detayları Kaydı
                const { error: detailError } = await supabase.from('ip_record_trademark_details').insert({
                    ip_record_id: generatedId, // Aynı ID ile bağlıyoruz
                    brand_name: markInfo.markName,
                    brand_type: markInfo.markType || 'Ticaret-Hizmet',
                    brand_image_url: logoUrl
                });
                
                if (detailError) throw detailError;

                // 3. Bülten Bilgilerini Kaydetme
                const { error: bulletinError } = await supabase.from('ip_record_bulletins').insert({
                    id: crypto.randomUUID(), // Bu tablo da text ID istiyor
                    ip_record_id: generatedId, // Aynı ID ile bağlıyoruz
                    bulletin_no: markInfo.bulletinNumber || item.bulletin_no,
                    bulletin_date: markInfo.bulletinDate || null
                });
                
                if (bulletinError) throw bulletinError;
                
                await supabase.from('bulletin_fetch_queue').update({ status: 'completed' }).eq('id', item.id);
                successCount++;
                console.log(`✔️ ${item.application_number} başarıyla kaydedildi!`);

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


