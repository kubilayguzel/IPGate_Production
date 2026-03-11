import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);

serve(async (req) => {
    // 1. Kuyruktan bekleyen 10 adet numarayı al (Timeout olmaması için 10'ar 10'ar yapıyoruz)
    const { data: queueItems } = await supabase
        .from('bulletin_fetch_queue')
        .select('*')
        .eq('status', 'pending')
        .limit(10);

    if (!queueItems || queueItems.length === 0) {
        return new Response("Kuyruk boş.", { status: 200 });
    }

    // Aldıklarımızın statüsünü hemen 'processing' (işleniyor) yapalım ki başka tetikleme bunları tekrar almasın
    const ids = queueItems.map(q => q.id);
    await supabase.from('bulletin_fetch_queue').update({ status: 'processing' }).in('id', ids);

    // 2. EPATS API'sine tek tek istek at
    for (const item of queueItems) {
        try {
            const epatsRes = await fetch("https://opts.turkpatent.gov.tr/api/trademark-search/mark", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    applicationNo: item.application_number,
                    documentNo: "", internationalRegistrationNo: "", registrationNo: ""
                })
            });

            const data = await epatsRes.json();
            
            // Eğer veri gelmediyse
            if (!data || !data.markName) {
                await supabase.from('bulletin_fetch_queue').update({ status: 'failed', error_message: 'EPATS veri döndürmedi' }).eq('id', item.id);
                continue;
            }

            let logoUrl = null;
            // 3. Logo (Base64) varsa Supabase Storage'a yükle
            if (data.figure) {
                // Base64 formatındaki veriyi (data:image/jpeg;base64,....) temizle ve Buffera çevir
                const base64Data = data.figure.replace(/^data:image\/\w+;base64,/, "");
                const byteCharacters = atob(base64Data);
                const byteArray = new Uint8Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) byteArray[i] = byteCharacters.charCodeAt(i);

                const fileName = `${item.application_number.replace('/', '_')}.jpg`;
                const { data: uploadData, error: uploadError } = await supabase.storage
                    .from('brand_images')
                    .upload(`bulletins/${fileName}`, byteArray, { contentType: 'image/jpeg', upsert: true });

                if (uploadData) {
                    const { data: publicUrlData } = supabase.storage.from('brand_images').getPublicUrl(`bulletins/${fileName}`);
                    logoUrl = publicUrlData.publicUrl;
                }
            }

            // 4. Veritabanına (Portföy) Kaydet
            // Ana IP_RECORDS Tablosu
            const { data: newIpRecord, error: ipError } = await supabase.from('ip_records').insert({
                application_number: item.application_number,
                application_date: data.applicationDate,
                record_owner_type: 'other',
                status: 'published', // Yayınlanmış
                ip_type: 'trademark'
            }).select().single();

            if (newIpRecord) {
                // Marka Detayları Tablosu
                await supabase.from('ip_record_trademark_details').insert({
                    ip_record_id: newIpRecord.id,
                    brand_name: data.markName,
                    brand_type: data.markType,
                    brand_image_url: logoUrl
                });

                // Başvuru Sahibi Tablosu
                if (data.holderName) {
                    // Not: Gerçek senaryoda persons tablosuna ekleyip ID'sini bağlamanız gerekir. 
                    // Basitlik adına şimdilik pas geçiyoruz veya doğrudan metin olarak bir alana yazabilirsiniz.
                }
            }

            // İşlem başarıyla bitti!
            await supabase.from('bulletin_fetch_queue').update({ status: 'completed' }).eq('id', item.id);

        } catch (err) {
            // Hata olursa kuyruğa yaz
            await supabase.from('bulletin_fetch_queue').update({ status: 'failed', error_message: err.message }).eq('id', item.id);
        }
    }

    return new Response(JSON.stringify({ success: true, processed: queueItems.length }), { headers: { "Content-Type": "application/json" } });
});