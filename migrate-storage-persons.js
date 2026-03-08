const { createClient } = require('@supabase/supabase-js');

// SUPABASE BAĞLANTISI
const SUPABASE_URL = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjE3ODQ0OCwiZXhwIjoyMDg3NzU0NDQ4fQ.WUKhJrBnWNABIZnUj9EF2zKyIsan7M3DCm7Nwu1NeGQ'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function migratePersonDocuments() {
    console.log("🚀 Storage Göçü Başlıyor: person_documents...\n");

    // 1. Sadece URL içinde 'firebasestorage' geçen eski kayıtları çek
    const { data: docs, error } = await supabase
        .from('person_documents')
        .select('*')
        .ilike('url', '%firebasestorage%');

    if (error) {
        console.error("❌ Veri çekme hatası:", error);
        return;
    }

    if (!docs || docs.length === 0) {
        console.log("✅ Taşınacak Firebase linkli evrak bulunamadı. (Belki hepsi zaten taşınmıştır)");
        return;
    }

    console.log(`📌 Taşınacak ${docs.length} adet evrak bulundu. İndirilip yükleniyor...\n`);

    let successCount = 0;

    for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        try {
            // 2. Dosyayı Firebase'den indir (Hafızaya / RAM'e al)
            const response = await fetch(doc.url);
            if (!response.ok) throw new Error(`İndirme başarısız: ${response.statusText}`);
            
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // 3. Supabase Storage Path (Yol) Oluştur: "persons/kisi_id/dosya_id.pdf" formatında
            // Dosya adı çakışmasını önlemek için ID'yi kullanıyoruz
            const ext = doc.file_name?.split('.').pop() || 'pdf'; 
            const filePath = `persons/${doc.person_id}/${doc.id}.${ext}`;

            // 4. Supabase Storage'a Yükle
            const { data: uploadData, error: uploadError } = await supabase.storage
                .from('documents') // Az önce açtığımız kova adı
                .upload(filePath, buffer, {
                    contentType: response.headers.get('content-type') || 'application/pdf',
                    upsert: true
                });

            if (uploadError) throw uploadError;

            // 5. Yeni Public URL'i Al
            const { data: publicUrlData } = supabase.storage
                .from('documents')
                .getPublicUrl(filePath);

            const newUrl = publicUrlData.publicUrl;

            // 6. Veritabanını Yeni URL ile Güncelle
            const { error: updateError } = await supabase
                .from('person_documents')
                .update({ url: newUrl })
                .eq('id', doc.id);

            if (updateError) throw updateError;

            successCount++;
            console.log(`✅ [${successCount}/${docs.length}] Taşındı: ${doc.file_name}`);

        } catch (err) {
            console.error(`❌ Hata [${doc.id}]:`, err.message);
        }
    }

    console.log("\n🎉 STORAGE TAŞIMA İŞLEMİ BİTTİ! Tüm müvekkil evrakları yeni evinde.");
}

migratePersonDocuments();