const { createClient } = require('@supabase/supabase-js');

// SUPABASE BAĞLANTISI 
const SUPABASE_URL = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNzg0NDgsImV4cCI6MjA4Nzc1NDQ0OH0.PFSzq8hOc14HgYwwF_ZR3v82ZzegKcoN4Vqw2wR2ZP0';
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
    const response = await fetch(item.document_url);
    if (!response.ok) throw new Error(`İndirme başarısız: ${response.statusText}`);
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 🌟 GÜNCELLEME: Klasör yapısı 'transactions/islem_id/' şeklinde ayarlandı
    const ext = getExtension(item.document_url, item.document_name);
    const filePath = `transactions/${item.transaction_id}/doc_${item.id.substring(0,8)}.${ext}`;

    // 🌟 GÜNCELLEME: 'documents' kovasına yüklüyoruz
    const { error: uploadError } = await supabase.storage
        .from('documents')
        .upload(filePath, buffer, {
            contentType: response.headers.get('content-type') || `application/${ext}`,
            upsert: true
        });

    if (uploadError) throw uploadError;

    // 'documents' kovasından linki alıyoruz
    const { data: publicUrlData } = supabase.storage
        .from('documents')
        .getPublicUrl(filePath);

    const { error: updateError } = await supabase
        .from('transaction_documents')
        .update({ document_url: publicUrlData.publicUrl })
        .eq('id', item.id);

    if (updateError) throw updateError;
}

async function migrateTransactionDocuments() {
    console.log("🚀 Storage Göçü Başlıyor: İşlem Belgeleri ('documents' kovasına)...\n");

    const { data: documents, error } = await supabase
        .from('transaction_documents')
        .select('id, transaction_id, document_url, document_name')
        .ilike('document_url', '%firebasestorage%');

    if (error) {
        console.error("❌ Veri çekme hatası:", error);
        return;
    }

    if (!documents || documents.length === 0) {
        console.log("✅ Taşınacak Firebase linkli belge bulunamadı.");
        return;
    }

    console.log(`📌 Taşınacak ${documents.length} adet belge bulundu. 20'şerli paketler halinde aktarılıyor...\n`);

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

    console.log("\n\n🎉 İŞLEM BELGELERİ STORAGE TAŞIMA İŞLEMİ BİTTİ!");
}

migrateTransactionDocuments();