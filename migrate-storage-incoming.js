const { createClient } = require('@supabase/supabase-js');

// SUPABASE BAĞLANTISI 
const SUPABASE_URL = 'https://guicrctynauzxhyfpdfe.supabase.co'; 
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1aWNyY3R5bmF1enhoeWZwZGZlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTcwNDcyNywiZXhwIjoyMDg3MjgwNzI3fQ.Wop3lCBK3XvauYXOEg33TVxv4Cb6KQ8bK28N-sEgu08'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function getExtension(url, docName) {
    try {
        if (docName && docName.includes('.')) {
            const ext = docName.split('.').pop().toLowerCase();
            if (ext.length <= 4) return ext;
        }
        const urlObj = new URL(url);
        const parts = urlObj.pathname.split('.');
        if (parts.length > 1) {
            const ext = parts.pop().split('?')[0].toLowerCase(); 
            if (ext.length <= 4) return ext;
        }
        return 'pdf'; 
    } catch {
        return 'pdf';
    }
}

async function processDocument(item) {
    // 🌟 URL kolonumuz bu tabloda 'file_url' olarak geçiyor
    const response = await fetch(item.file_url);
    if (!response.ok) throw new Error(`İndirme başarısız: ${response.statusText}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Gelen evraklar için klasör yapısı: incoming_documents/doc_12345.pdf
    const ext = getExtension(item.file_url, item.file_name);
    const filePath = `incoming_documents/doc_${item.id.substring(0,8)}.${ext}`;

    const { error: uploadError } = await supabase.storage
        .from('documents')
        .upload(filePath, buffer, {
            contentType: response.headers.get('content-type') || `application/${ext}`,
            upsert: true
        });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase.storage
        .from('documents')
        .getPublicUrl(filePath);

    // Tabloyu yeni Public URL ile güncelle
    const { error: updateError } = await supabase
        .from('incoming_documents')
        .update({ file_url: publicUrlData.publicUrl })
        .eq('id', item.id);

    if (updateError) throw updateError;
}

async function migrateIncomingDocuments() {
    console.log("🚀 Storage Göçü Başlıyor: Gelen Evraklar ('documents' kovasına)...\n");

    const { data: documents, error } = await supabase
        .from('incoming_documents')
        .select('id, file_url, file_name')
        .ilike('file_url', '%firebasestorage%');

    if (error) {
        console.error("❌ Veri çekme hatası:", error);
        return;
    }

    if (!documents || documents.length === 0) {
        console.log("✅ Taşınacak Firebase linkli gelen evrak bulunamadı.");
        return;
    }

    console.log(`📌 Taşınacak ${documents.length} adet evrak bulundu. 20'şerli paketler halinde aktarılıyor...\n`);

    let successCount = 0;
    let errorCount = 0;
    const BATCH_SIZE = 20; 

    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        const batch = documents.slice(i, i + BATCH_SIZE);
        
        const promises = batch.map(async (item) => {
            try {
                await processDocument(item);
                successCount++;
            } catch (err) {
                errorCount++;
            }
        });

        await Promise.all(promises);
        process.stdout.write(`\r✅ İşlenen: ${successCount + errorCount}/${documents.length} | Başarılı: ${successCount} | Hata: ${errorCount}`);
    }

    console.log("\n\n🎉 GELEN EVRAKLAR STORAGE TAŞIMA İŞLEMİ BİTTİ!");
}

migrateIncomingDocuments();