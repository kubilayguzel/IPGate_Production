const { createClient } = require('@supabase/supabase-js');

// 🔴 1. BURAYA KENDİ BİLGİLERİNİZİ GİRİN
const SUPABASE_URL = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjE3ODQ0OCwiZXhwIjoyMDg3NzU0NDQ4fQ.WUKhJrBnWNABIZnUj9EF2zKyIsan7M3DCm7Nwu1NeGQ'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function getExtension(url) {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const parts = pathname.split('.');
        if (parts.length > 1) {
            const ext = parts.pop().split('?')[0]; 
            if (ext.length <= 4) return ext;
        }
        return 'png'; 
    } catch {
        return 'png';
    }
}

async function processItem(item) {
    const response = await fetch(item.brand_image_url);
    if (!response.ok) throw new Error(`Firebase İndirme Başarısız: ${response.statusText}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const ext = getExtension(item.brand_image_url);
    const filePath = `${item.ip_record_id}/logo.${ext}`;

    // Dosyayı Supabase Storage'a Yükle
    const { error: uploadError } = await supabase.storage
        .from('brand_images')
        .upload(filePath, buffer, {
            contentType: response.headers.get('content-type') || `image/${ext}`,
            upsert: true
        });

    if (uploadError) throw new Error(`Supabase Yükleme Hatası: ${uploadError.message}`);

    // Yeni Public URL'yi al
    const { data: publicUrlData } = supabase.storage
        .from('brand_images')
        .getPublicUrl(filePath);

    // Veritabanını Yeni Link ile Güncelle
    const { error: updateError } = await supabase
        .from('ip_record_trademark_details')
        .update({ brand_image_url: publicUrlData.publicUrl })
        .eq('ip_record_id', item.ip_record_id);

    if (updateError) throw new Error(`Veritabanı Güncelleme Hatası: ${updateError.message}`);
}

async function migrateBrandImages() {
    console.log("🚀 Storage Göçü Başlıyor: Marka Logoları HIZLANDIRILMIŞ MOD...\n");

    let totalProcessed = 0;
    
    // 1000 limitini aşmak için döngü kuruyoruz
    while (true) {
        const { data: details, error } = await supabase
            .from('ip_record_trademark_details')
            .select('ip_record_id, brand_image_url')
            .ilike('brand_image_url', '%firebasestorage%')
            .limit(1000); // Tek seferde 1000 çeker, bittikçe sıradakine geçer

        if (error) {
            console.error("❌ Veri çekme hatası:", error);
            return;
        }

        if (!details || details.length === 0) {
            console.log(`\n🎉 BÜTÜN LOGOLAR BAŞARIYLA TAŞINDI! Toplam taşınan: ${totalProcessed}`);
            break;
        }

        console.log(`\n📌 Kalanlardan ${details.length} adet Firebase linkli logo çekildi. Paketleniyor...`);

        let successCount = 0;
        let errorCount = 0;
        const BATCH_SIZE = 20; 

        for (let i = 0; i < details.length; i += BATCH_SIZE) {
            const batch = details.slice(i, i + BATCH_SIZE);
            
            const promises = batch.map(async (item) => {
                try {
                    await processItem(item);
                    successCount++;
                } catch (err) {
                    errorCount++;
                    // Hatayı gizlemiyoruz, doğrudan ekrana basıyoruz ki sorunu görelim
                    console.log(`\n❌ Hata [${item.ip_record_id}]:`, err.message);
                }
            });

            await Promise.all(promises);
            process.stdout.write(`\r⏳ İşlenen: ${successCount + errorCount}/${details.length} | Başarılı: ${successCount} | Hata: ${errorCount}`);
        }
        
        totalProcessed += successCount;
    }
}

migrateBrandImages();