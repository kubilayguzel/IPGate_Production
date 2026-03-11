import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    // Tarayıcıdan gelen tetikleme isteğine onay ver
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 1. Kuyruktan 10 tane beklemede olan kaydı al
        const { data: queueItems } = await supabase
            .from('bulletin_fetch_queue')
            .select('*')
            .eq('status', 'pending')
            .limit(10);

        if (!queueItems || queueItems.length === 0) {
            return new Response(JSON.stringify({ success: true, message: "Kuyruk boş" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // 2. Başkası almasın diye hemen işlemde (processing) olarak işaretle
        const ids = queueItems.map(q => q.id);
        await supabase.from('bulletin_fetch_queue').update({ status: 'processing' }).in('id', ids);

        let successCount = 0;

        // 3. Her bir kayıt için EPATS'a istek at
        for (const item of queueItems) {
            try {
                console.log(`[TEST] ${item.application_number} için EPATS'a istek atılıyor...`);
                
                // 🔥 EPATS İSTEĞİ (KİMLİK BİLGİLERİ VE TAM BROWSER KİMLİĞİ İLE)
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
                        // DİKKAT: Kopyaladığınız uzun Cookie değerini buraya yapıştırmayı unutmayın!
                        "Cookie": "JSESSIONID=444AD658B0242957DD92547836E58AF1; TS01249912=0187428d3194ed97ade148b75d30f4afb9f00cf74cacdc42e5dedf4ecd9ee6071bbb3a07f2789333a0e9bdef99ddfb551cf5aa6b5046b96a6e8cfebc925d1d1c13ba143bfb; _ga=GA1.1.810903385.1765797994; _ga_RSBG2H3YFV=GS2.1.s1773235707$o153$g1$t1773235712$j55$l0$h0; access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZTY3ZjgyMy1lNDBjLTRkNDAtYTM4OS1lZWYzMDE2NjI1ZjgiLCJyb2xlcyI6WyJQQVRFTlRfVFJBQ0tFUiIsIlRSQURFTUFSS19TRUFSQ0hFUiJdLCJpYXQiOjE3NzMyMzU4OTAsImV4cCI6MTc3MzIzODU5MH0.JH0xZmiIBwZZX-5mW3zAOmzQsxwECdDimheVS2KzqA0; TS01777e0b=0187428d31bc1df41587659a1b43b4cc7fdc33377262eb9a5bc485fb0c6e26737b266421ea1d45ec56ed1de68a745699aa6137bffbeb2affe960f16009e709522df141a963", 
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    },
                    body: JSON.stringify({
                        applicationNo: item.application_number,
                        documentNo: "", internationalRegistrationNo: "", registrationNo: ""
                    })
                });

                // 🔥 DETAYLI LOGLAMA: EPATS'tan gelen ham cevabı görelim
                const status = epatsRes.status;
                const rawText = await epatsRes.text(); 
                console.log(`[EPATS YANITI] HTTP Status: ${status}`);
                console.log(`[EPATS YANITI] Gövde: ${rawText.substring(0, 150)}...`);

                if (status !== 200) {
                    throw new Error(`EPATS ${status} hatası döndürdü.`);
                }

                // Gelen metni JSON'a çevirmeyi deniyoruz
                let responseJson;
                try {
                    responseJson = JSON.parse(rawText);
                } catch(e) {
                    throw new Error("EPATS'tan dönen veri JSON formatında değil. Muhtemelen giriş sayfasına yönlendirdi.");
                }
                
                // 🔥 ÇÖZÜM: 'data' -> 'markInformation' yolunu izleyerek asıl veriyi alıyoruz
                const markInfo = responseJson?.data?.markInformation;

                if (!markInfo || !markInfo.markName) {
                    throw new Error("Veri çekildi ama markName bulunamadı (JSON yolu yanlış olabilir).");
                }

                let logoUrl = null;
                // Logoyu (Base64'ten çevirerek) Supabase Storage'a yüklüyoruz
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

                // 🔥 VERİTABANI KAYITLARI

                // 1. Ana Portföy Kaydı (bulletin_no buradan kaldırıldı)
                const { data: newIpRecord, error: ipError } = await supabase.from('ip_records').insert({
                    application_number: item.application_number,
                    application_date: markInfo.applicationDate,
                    record_owner_type: 'other', 
                    status: 'published',
                    ip_type: 'trademark'
                }).select().single();

                if (ipError) throw ipError;

                // 2. Marka Detayları Kaydı (isim, tip ve logo)
                await supabase.from('ip_record_trademark_details').insert({
                    ip_record_id: newIpRecord.id,
                    brand_name: markInfo.markName,
                    brand_type: markInfo.markType || 'Ticaret-Hizmet',
                    brand_image_url: logoUrl
                });

                // 3. Bülten Bilgilerini Doğru Tabloya Kaydetme (ip_record_bulletins)
                await supabase.from('ip_record_bulletins').insert({
                    ip_record_id: newIpRecord.id,
                    bulletin_no: markInfo.bulletinNumber || item.bulletin_no,
                    bulletin_date: markInfo.bulletinDate || null
                });
                
                // İşlem başarılı! Kuyrukta 'completed' olarak işaretle
                await supabase.from('bulletin_fetch_queue').update({ status: 'completed' }).eq('id', item.id);
                successCount++;

            } catch (err: any) {
                console.error(`[HATA - ${item.application_number}]:`, err.message);
                // İşlem hatalıysa kuyrukta 'failed' olarak işaretle
                await supabase.from('bulletin_fetch_queue').update({ status: 'failed', error_message: err.message }).eq('id', item.id);
            }
        }

        return new Response(JSON.stringify({ success: true, processed: successCount }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error: any) {
        console.error("[GENEL HATA]:", error.message);
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
});