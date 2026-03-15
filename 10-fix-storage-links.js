const { createClient } = require('@supabase/supabase-js');

// SUPABASE BAĞLANTISI
const SUPABASE_URL = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjE3ODQ0OCwiZXhwIjoyMDg3NzU0NDQ4fQ.WUKhJrBnWNABIZnUj9EF2zKyIsan7M3DCm7Nwu1NeGQ'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const BATCH_SIZE = 20; // 🚀 Aynı anda işlenecek dosya sayısı

function getExt(name) {
    if (!name) return 'pdf';
    const parts = name.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase().substring(0, 4) : 'pdf';
}

// Diziyi paketlere (chunk) bölme yardımcı fonksiyonu
function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

// Ortak İndirme & Yükleme Motoru
async function migrateUrl(oldUrl, folder, itemId, fileName) {
    if (!oldUrl || !oldUrl.includes('firebasestorage')) return oldUrl;

    try {
        const response = await fetch(oldUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status} - ${response.statusText}`);
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const ext = getExt(fileName);
        const filePath = `${folder}/${itemId}_${Date.now()}.${ext}`;

        const { error: uploadError } = await supabase.storage.from('documents').upload(filePath, buffer, {
            contentType: response.headers.get('content-type') || `application/${ext}`,
            upsert: true
        });

        if (uploadError) throw uploadError;

        return supabase.storage.from('documents').getPublicUrl(filePath).data.publicUrl;
    } catch (error) {
        console.error(`\n❌ TAŞINAMADI! Link: ${oldUrl.substring(0, 50)}... | Hata: ${error.message}`);
        return oldUrl; // Hata alırsan eski linki koru
    }
}

async function runFixer() {
    console.log("🚀 ULTIMATE STORAGE FIXER (BATCH MODE) BAŞLIYOR...\n");

    // 1. TRANSACTION DOCUMENTS DÜZELTME
    console.log("⏳ 1. 'transaction_documents' tablosu taranıyor...");
    const { data: txDocs } = await supabase.from('transaction_documents').select('*').ilike('document_url', '%firebasestorage%');
    
    if (txDocs && txDocs.length > 0) {
        console.log(`📌 ${txDocs.length} adet İşlem Belgesi bulundu. ${BATCH_SIZE}'şerli paketlerle taşınıyor...`);
        const batches = chunkArray(txDocs, BATCH_SIZE);
        
        for (const batch of batches) {
            await Promise.all(batch.map(async (doc) => {
                const newUrl = await migrateUrl(doc.document_url, `transactions/${doc.transaction_id || 'unknown'}`, doc.id, doc.document_name);
                if (newUrl !== doc.document_url) {
                    await supabase.from('transaction_documents').update({ document_url: newUrl }).eq('id', doc.id);
                    process.stdout.write('✅');
                }
            }));
        }
        console.log("\n");
    }

    // 2. TASK DOCUMENTS DÜZELTME
    console.log("⏳ 2. 'task_documents' tablosu taranıyor...");
    const { data: tDocs } = await supabase.from('task_documents').select('*').ilike('document_url', '%firebasestorage%');
    
    if (tDocs && tDocs.length > 0) {
        console.log(`📌 ${tDocs.length} adet Görev Belgesi bulundu. ${BATCH_SIZE}'şerli paketlerle taşınıyor...`);
        const batches = chunkArray(tDocs, BATCH_SIZE);
        
        for (const batch of batches) {
            await Promise.all(batch.map(async (doc) => {
                const newUrl = await migrateUrl(doc.document_url, `tasks/${doc.task_id || 'unknown'}`, doc.id, doc.document_name);
                if (newUrl !== doc.document_url) {
                    await supabase.from('task_documents').update({ document_url: newUrl }).eq('id', doc.id);
                    process.stdout.write('✅');
                }
            }));
        }
        console.log("\n");
    }

    // 3. TASKS TABLOSU (JSONB DETAILS VE EPATS) DÜZELTME
    console.log("⏳ 3. 'tasks' tablosundaki (JSONB) gizli linkler taranıyor...");
    const { data: tasks } = await supabase.from('tasks').select('*').or('details.ilike.%firebasestorage%,epats_doc_url.ilike.%firebasestorage%');
    
    if (tasks && tasks.length > 0) {
        console.log(`📌 ${tasks.length} adet Görev'de gizli JSON linki bulundu. ${BATCH_SIZE}'şerli paketlerle taşınıyor...`);
        const batches = chunkArray(tasks, BATCH_SIZE);

        for (const batch of batches) {
            await Promise.all(batch.map(async (task) => {
                let updated = false;
                let details = task.details || {};

                // A) ePats URL Güncelleme
                if (task.epats_doc_url && task.epats_doc_url.includes('firebasestorage')) {
                    const newEpats = await migrateUrl(task.epats_doc_url, `tasks/${task.id}`, task.id, 'epats_document.pdf');
                    if (newEpats !== task.epats_doc_url) {
                        task.epats_doc_url = newEpats; 
                        updated = true;
                        process.stdout.write('📄');
                    }
                }

                // B) Details içindeki epatsDocument
                if (details.epatsDocument && details.epatsDocument.url && details.epatsDocument.url.includes('firebasestorage')) {
                    details.epatsDocument.url = await migrateUrl(details.epatsDocument.url, `tasks/${task.id}`, task.id, details.epatsDocument.name);
                    updated = true;
                }

                // C) Details içindeki documents array'i
                if (Array.isArray(details.documents)) {
                    for (let i = 0; i < details.documents.length; i++) {
                        let d = details.documents[i];
                        let oldLink = d.url || d.downloadURL || d.fileUrl;
                        if (oldLink && oldLink.includes('firebasestorage')) {
                            const newLink = await migrateUrl(oldLink, `tasks/${task.id}`, task.id, d.name || d.fileName);
                            if (newLink !== oldLink) {
                                if (d.url) d.url = newLink;
                                if (d.downloadURL) d.downloadURL = newLink;
                                if (d.fileUrl) d.fileUrl = newLink;
                                updated = true;
                                process.stdout.write('📦');
                            }
                        }
                    }
                }

                if (updated) {
                    await supabase.from('tasks').update({ 
                        epats_doc_url: task.epats_doc_url, 
                        details: details 
                    }).eq('id', task.id);
                }
            }));
        }
        console.log("\n");
    }

    console.log("🎉 TÜM TEMİZLİK BİTTİ! Konsola hızlıca aktı geçti 😎");
}

runFixer();