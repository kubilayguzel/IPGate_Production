import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
            .limit(20); // 🔥 OTOMASYON İÇİN 20'YE ÇIKARILDI

        if (!queueItems || queueItems.length === 0) {
            return new Response(JSON.stringify({ success: true, message: "Kuyruk boş" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const ids = queueItems.map(q => q.id);
        await supabase.from('bulletin_fetch_queue').update({ status: 'processing' }).in('id', ids);

        let successCount = 0;

        for (const item of queueItems) {
            try {
                console.log(`[HAYALET MOD] ${item.application_number} çekiliyor...`);
                
                const epatsRes = await fetch("https://opts.turkpatent.gov.tr/api/trademark-search/mark", {
                    method: "POST",
                    headers: { 
                        "Accept": "application/json, text/plain, */*",
                        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
                        "Content-Type": "application/json",
                        "Origin": "https://opts.turkpatent.gov.tr",
                        "Referer": "https://opts.turkpatent.gov.tr/trademark",
                        "sec-ch-ua": "\"Not_A Brand\";v=\"8\", \"Chromium\";v=\"120\", \"Google Chrome\";v=\"120\"",
                        "sec-ch-ua-mobile": "?0",
                        "sec-ch-ua-platform": "\"Windows\"",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-origin",
                        "Connection": "keep-alive",
                        // DİKKAT: Geçerli Cookie'nizi buraya yapıştırın.
                        "Cookie": "JSESSIONID=BBDAB0E8FEFC8954CFE380F2DD447A05; TS01249912=0187428d31fa9357fb13a0836815415c3af9495418f3b805b849877af5b30a578052e23c910809dc8dca3c4acaa4d3da8bf885144a8e9900ebfbd03650cb56f3c01d3d0d4c; _ga=GA1.1.810903385.1765797994; _ga_RSBG2H3YFV=GS2.1.s1773303164$o155$g1$t1773305761$j51$l0$h0; access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZTY3ZjgyMy1lNDBjLTRkNDAtYTM4OS1lZWYzMDE2NjI1ZjgiLCJyb2xlcyI6WyJQQVRFTlRfVFJBQ0tFUiIsIlRSQURFTUFSS19TRUFSQ0hFUiJdLCJpYXQiOjE3NzMzMDYyNTUsImV4cCI6MTc3MzMwODk1NX0.eguOYzkCA1yYGda68GX0-_cJJw1-wlsKs7WMt0U-9Fs; TS01777e0b=0187428d31ac757ca3a3a105c1a48b8699969a57997353c28e39909a2fad806d49fca9d5bf73a6670c640642e3200c873768dd99213b0c27e33410e3f9f1b9de1205291ebb", 
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    },
                    body: JSON.stringify({
                        applicationNo: item.application_number,
                        documentNo: "", internationalRegistrationNo: "", registrationNo: ""
                    })
                });

                if (epatsRes.status !== 200) throw new Error(`EPATS ${epatsRes.status} hatası döndürdü.`);

                const rawText = await epatsRes.text(); 
                let responseJson;
                try {
                    responseJson = JSON.parse(rawText);
                } catch(e) {
                    console.error(`[WAF ENGELİ - ${item.application_number}]:`, rawText.substring(0, 500));
                    throw new Error("WAF Engeli veya Cookie Süresi Doldu.");
                }
                
                const markInfo = responseJson?.data?.markInformation;
                const niceInfoArray = responseJson?.data?.niceInformation || [];

                if (!markInfo || !markInfo.markName) throw new Error("Veri çekildi ama markName bulunamadı.");

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

                const bulletinNo = markInfo.bulletinNumber || item.bulletin_no || 'BILINMIYOR';
                const mainBulletinId = `bulletin_main_${bulletinNo}`;
                const appNoFormatted = item.application_number.replace('/', '_');
                const bulletinRecordId = `bull_${bulletinNo}_app_${appNoFormatted}`;

                const niceClassesArray = markInfo.niceClasses 
                    ? markInfo.niceClasses.split('/').map((c: string) => c.trim()).filter((c: string) => c.length > 0)
                    : [];

                const holdersArray = markInfo.holdName ? [{ name: markInfo.holdName }] : [];

                const { error: bulletinError } = await supabase.from('trademark_bulletins').upsert({
                    id: mainBulletinId,
                    bulletin_no: bulletinNo,
                    bulletin_date: markInfo.bulletinDate || null
                });
                if (bulletinError) throw bulletinError;

                const { error: recordError } = await supabase.from('trademark_bulletin_records').upsert({
                    id: bulletinRecordId,
                    bulletin_id: mainBulletinId,
                    application_number: item.application_number,
                    brand_name: markInfo.markName,
                    application_date: markInfo.applicationDate,
                    nice_classes: niceClassesArray,
                    holders: holdersArray,
                    image_url: logoUrl,
                    source: 'turkpatent_api'
                });
                if (recordError) throw recordError;

                if (niceInfoArray.length > 0) {
                    const goodsPayload = niceInfoArray.map((info: any, index: number) => {
                        // 🔥 ÇÖZÜM: niceCode ve niceDescription eklendi
                        let cNum = parseInt(info.niceCode || info.classNo || info.niceClass || info.classNumber || info.no, 10);
                        if (isNaN(cNum)) cNum = parseInt(niceClassesArray[index], 10);
                        if (isNaN(cNum)) cNum = 0;

                        return {
                            id: `${bulletinRecordId}_class_${cNum}`,
                            bulletin_record_id: bulletinRecordId,
                            class_number: cNum,
                            class_text: info.niceDescription || info.goodsAndServices || info.description || info.className || "Açıklama bulunamadı."
                        };
                    });

                    const { error: goodsError } = await supabase.from('trademark_bulletin_goods').upsert(goodsPayload);
                    if (goodsError) throw goodsError;

                } else if (niceClassesArray.length > 0) {
                    const goodsPayload = niceClassesArray.map((cls: string) => {
                        let cNum = parseInt(cls, 10);
                        return {
                            id: `${bulletinRecordId}_class_${cNum}`,
                            bulletin_record_id: bulletinRecordId,
                            class_number: isNaN(cNum) ? 0 : cNum,
                            class_text: "Eşya listesi detayı EPATS API'den çekilemedi."
                        };
                    });

                    const { error: goodsError } = await supabase.from('trademark_bulletin_goods').upsert(goodsPayload);
                    if (goodsError) throw goodsError;
                }
                
                await supabase.from('bulletin_fetch_queue').update({ status: 'completed' }).eq('id', item.id);
                successCount++;

                const randomDelay = Math.floor(Math.random() * 1000) + 1000;
                console.log(`[BEKLEME] WAF'ı atlatmak için ${randomDelay}ms bekleniyor...`);
                await sleep(randomDelay);

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