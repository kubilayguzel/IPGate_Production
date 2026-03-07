const { createClient } = require('@supabase/supabase-js');

// SUPABASE BAĞLANTISI 
const supabaseUrl = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNzg0NDgsImV4cCI6MjA4Nzc1NDQ0OH0.PFSzq8hOc14HgYwwF_ZR3v82ZzegKcoN4Vqw2wR2ZP0';
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

// 🚀 İşlemi yapan ana fonksiyon (Paralel çalışacak)
async function processItem(item) {
    const response = await fetch(item.brand_image_url);
    if (!response.ok) throw new Error(`İndirme başarısız: ${response.statusText}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const ext = getExtension(item.brand_image_url);
    const filePath = `${item.ip_record_id}/logo.${ext}`;

    const { error: uploadError } = await supabase.storage
        .from('brand_images')
        .upload(filePath, buffer, {
            contentType: response.headers.get('content-type') || `image/${ext}`,
            upsert: true
        });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase.storage
        .from('brand_images')
        .getPublicUrl(filePath);

    const { error: updateError } = await supabase
        .from('ip_record_trademark_details')
        .update({ brand_image_url: publicUrlData.publicUrl })
        .eq('ip_record_id', item.ip_record_id);

    if (updateError) throw updateError;
}

async function migrateBrandImages() {
    console.log("🚀 Storage Göçü Başlıyor: Marka Logoları HIZLANDIRILMIŞ MOD...\n");

    const { data: details, error } = await supabase
        .from('ip_record_trademark_details')
        .select('ip_record_id, brand_image_url')
        .ilike('brand_image_url', '%firebasestorage%');

    if (error) {
        console.error("❌ Veri çekme hatası:", error);
        return;
    }

    if (!details || details.length === 0) {
        console.log("✅ Taşınacak Firebase linkli logo bulunamadı.");
        return;
    }

    console.log(`📌 Taşınacak ${details.length} adet marka görseli bulundu. 20'şerli paketler halinde aktarılıyor...\n`);

    let successCount = 0;
    let errorCount = 0;
    const BATCH_SIZE = 20; // Aynı anda işlenecek resim sayısı (Çok artırırsak RAM şişebilir, 20-30 idealdir)

    for (let i = 0; i < details.length; i += BATCH_SIZE) {
        const batch = details.slice(i, i + BATCH_SIZE);
        
        // 20'li paketi aynı anda başlatıyoruz
        const promises = batch.map(async (item) => {
            try {
                await processItem(item);
                successCount++;
            } catch (err) {
                errorCount++;
                // Sadece kırık link hatalarını görmek isterseniz alt satırı aktif edebilirsiniz
                // console.log(`\n❌ Hata [${item.ip_record_id}]:`, err.message);
            }
        });

        // Paketteki 20 işlemin de bitmesini bekle ve ekrana yazdır
        await Promise.all(promises);
        process.stdout.write(`\r✅ İşlenen: ${successCount + errorCount}/${details.length} | Başarılı: ${successCount} | Hata: ${errorCount}`);
    }

    console.log("\n\n🎉 LOGO STORAGE TAŞIMA İŞLEMİ BİTTİ!");
}

migrateBrandImages();