const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

// 🔴 1. FIREBASE BAĞLANTISI 
const serviceAccount = require('./firebase-key.json');
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// 🔴 2. SUPABASE BAĞLANTISI (Kendi bilgilerinizi girin)
const SUPABASE_URL = 'https://guicrctynauzxhyfpdfe.supabase.co'; 
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1aWNyY3R5bmF1enhoeWZwZGZlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTcwNDcyNywiZXhwIjoyMDg3MjgwNzI3fQ.Wop3lCBK3XvauYXOEg33TVxv4Cb6KQ8bK28N-sEgu08'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const safeDate = (val) => {
    if (!val) return null;
    try {
        const d = val.toDate ? val.toDate() : new Date(val);
        return isNaN(d.getTime()) ? null : d.toISOString();
    } catch { return null; }
};

async function batchUpsert(tableName, dataArray, batchSize = 500) {
    if (dataArray.length === 0) return 0;
    let successCount = 0;
    for (let i = 0; i < dataArray.length; i += batchSize) {
        const batch = dataArray.slice(i, i + batchSize);
        const { error } = await supabase.from(tableName).upsert(batch, { onConflict: 'id' });
        if (error) {
            console.error(`❌ ${tableName} aktarım hatası (${i}-${i + batch.length}):`, error.message);
        } else {
            successCount += batch.length;
            console.log(`✅ ${tableName}: ${successCount}/${dataArray.length} yazıldı.`);
        }
    }
    return successCount;
}

async function migrateStep3() {
    console.log("🚀 ADIM 3: İşlem Geçmişi (Transactions) ve Dosyalar Taşınıyor...\n");

    console.log("⏳ 1. Supabase'den geçerli Marka/Patent (ip_records) ID'leri kontrol ediliyor...");
    const { data: ipRecordsData, error: ipError } = await supabase.from('ip_records').select('id');
    if (ipError) throw ipError;
    const validIpIds = new Set(ipRecordsData.map(p => p.id));
    console.log(`ℹ️ ${validIpIds.size} geçerli ana kayıt bulundu.`);

    // 🌟 YENİ: Geçerli Kullanıcı (User) ID'lerini Çekelim
    console.log("\n⏳ 1.5. Supabase'den geçerli Kullanıcı (Users) ID'leri kontrol ediliyor...");
    // Not: Tablonuzun adı 'users' veya 'profiles' olabilir. Eğer farklıysa aşağıyı değiştirin.
    // Auth şemasındaki asıl kullanıcılar public şemada bir tabloya yansıyorsa oradan alıyoruz.
    // Varsayılan olarak 'profiles' tablosunu deneyelim (Supabase'de genelde böyledir).
    // Eğer sizde users ise 'users' yapın. Hata alırsanız doğrudan auth.users tablosuna admin yetkisiyle de bakabiliriz.
    // Şimdilik 'profiles' tablosunu varsayıyorum, hata verirse bunu değiştirmemiz gerekebilir.
    let validUserIds = new Set();
    const { data: usersData, error: usersError } = await supabase.from('users').select('id'); // 'profiles' tablosu varsayıldı
    
    if (usersError) {
         console.warn("⚠️ 'profiles' tablosundan kullanıcılar çekilemedi. Tablo adınız farklı olabilir (Örn: 'users'). Hata:", usersError.message);
         // Hata alsak bile devam etsin, en kötü hepsi null olur.
    } else if (usersData) {
         validUserIds = new Set(usersData.map(u => u.id));
         console.log(`ℹ️ ${validUserIds.size} geçerli kullanıcı bulundu.`);
    }

    // =========================================================================
    // A) ESKİ GEÇMİŞ (oldTransactions) -> ip_records.old_transactions JSONB GÜNCELLEMESİ
    // =========================================================================
    console.log("\n⏳ 2. 'oldTransactions' (Eski geçmiş) toparlanıp ip_records tablosuna JSONB olarak güncelleniyor...");
    const ipSnap = await db.collection('ipRecords').get();
    const oldTxUpdates = [];

    ipSnap.docs.forEach(doc => {
        const d = doc.data();
        if (validIpIds.has(doc.id) && Array.isArray(d.oldTransactions) && d.oldTransactions.length > 0) {
            oldTxUpdates.push({ id: doc.id, old_transactions: d.oldTransactions });
        }
    });

    console.log(`📌 ${oldTxUpdates.length} kayıtta old_transactions bulundu. Güncelleniyor...`);
    let oldTxSuccessCount = 0;
    for (let i = 0; i < oldTxUpdates.length; i += 100) {
        const batch = oldTxUpdates.slice(i, i + 100);
        const promises = batch.map(u => 
            supabase.from('ip_records').update({ old_transactions: u.old_transactions }).eq('id', u.id)
        );
        await Promise.all(promises);
        oldTxSuccessCount += batch.length;
        console.log(`✅ ip_records (old_transactions): ${oldTxSuccessCount}/${oldTxUpdates.length} güncellendi.`);
    }

    // =========================================================================
    // B) DİNAMİK SUBCOLLECTION (transactions) AKTARIMI
    // =========================================================================
    const parentTransactions = [];
    const childTransactions = [];
    const transactionDocuments = [];

    console.log("\n⏳ 3. 'transactions' alt koleksiyonları çekiliyor...");
    const txSnap = await db.collectionGroup('transactions').get();

    txSnap.docs.forEach(doc => {
        const d = doc.data();
        const parentRef = doc.ref.parent.parent;
        if (!parentRef) return; 
        
        const ipRecordId = parentRef.id;

        if (validIpIds.has(ipRecordId)) {
            // 🌟 YENİ: user_id doğrulama
            let safeUserId = d.userId;
            if (safeUserId && !validUserIds.has(safeUserId)) {
                safeUserId = null; // Geçersizse null atıyoruz
            }

            const txObj = {
                id: doc.id,
                ip_record_id: ipRecordId,
                transaction_type_id: d.type || d.transactionTypeId || null,
                transaction_hierarchy: d.transactionHierarchy || 'parent',
                parent_id: d.parentId || null,
                description: d.description || d.designation || null,
                note: d.note || null,
                transaction_date: safeDate(d.date || d.timestamp) || null,
                user_id: safeUserId, // 🌟 Kontrol edilmiş ID
                user_email: d.userEmail || null,
                user_name: d.userName || null,
                task_id: d.taskId || null,
                opposition_owner: d.oppositionOwner || null,
                opposition_petition_file_url: d.oppositionPetitionFileUrl || null,
                opposition_epats_petition_file_url: d.oppositionEpatsPetitionFileUrl || null,
                mail_notification_id: d.mailNotificationId || null,
                created_at: safeDate(d.createdAt || d.timestamp) || new Date().toISOString()
            };

            if (txObj.parent_id && txObj.transaction_hierarchy === 'child') {
                childTransactions.push(txObj);
            } else {
                parentTransactions.push(txObj);
            }

            if (Array.isArray(d.documents)) {
                d.documents.forEach(docItem => {
                    const docUrl = docItem.url || docItem.downloadURL || docItem.fileUrl;
                    if (docUrl) {
                        transactionDocuments.push({
                            transaction_id: doc.id,
                            document_name: docItem.name || docItem.fileName || 'İsimsiz Belge',
                            document_url: docUrl,
                            document_type: docItem.type || null,
                            document_designation: docItem.documentDesignation || null,
                            uploaded_at: safeDate(docItem.uploadedAt) || new Date().toISOString()
                        });
                    }
                });
            }
        }
    });

    console.log(`\n📌 Yazılacak Veri Özeti:
    - Ebeveyn (Parent) İşlemler: ${parentTransactions.length}
    - Alt (Child) İşlemler: ${childTransactions.length}
    - İşlem Dosyaları (Documents): ${transactionDocuments.length}`);

    console.log("\n⏳ 4. Ebeveyn (Parent) İşlemler yazılıyor...");
    await batchUpsert('transactions', parentTransactions);

    console.log("\n⏳ 5. Alt (Child) İşlemler yazılıyor...");
    const validParentIds = new Set(parentTransactions.map(p => p.id));
    const validChildTxs = childTransactions.filter(c => validParentIds.has(c.parent_id));
    await batchUpsert('transactions', validChildTxs);

    console.log("\n⏳ 6. İşlem Dosyaları (Documents) aktarılıyor...");
    validParentIds.forEach(id => validChildTxs.push({id})); 
    const allValidTxIds = new Set([...parentTransactions.map(p => p.id), ...validChildTxs.map(c => c.id)]);
    
    const validDocs = transactionDocuments.filter(d => allValidTxIds.has(d.transaction_id));
    
    if (validDocs.length > 0) {
        let docsSuccess = 0;
        for (let i = 0; i < validDocs.length; i += 500) {
            const batch = validDocs.slice(i, i + 500);
            const { error } = await supabase.from('transaction_documents').insert(batch);
            if (error) {
                console.error(`❌ Belgeler aktarım hatası:`, error.message);
            } else {
                docsSuccess += batch.length;
                console.log(`✅ transaction_documents: ${docsSuccess}/${validDocs.length} yazıldı.`);
            }
        }
    } else {
        console.log("ℹ️ Aktarılacak belge bulunamadı.");
    }

    console.log("\n🎉 ADIM 3 BAŞARIYLA TAMAMLANDI! İşlem Geçmişiniz (eski JSONB formatında ve yeni tablolar halinde) Supabase'e taşındı.");
}

migrateStep3().catch(console.error);