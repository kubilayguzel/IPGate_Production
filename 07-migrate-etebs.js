const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

// 🔴 1. FIREBASE BAĞLANTISI 
const serviceAccount = require('./firebase-key.json');
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// 🔴 2. SUPABASE BAĞLANTISI
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
        if (error) console.error(`❌ ${tableName} aktarım hatası:`, error.message);
        else {
            successCount += batch.length;
            console.log(`✅ ${tableName}: ${successCount}/${dataArray.length} yazıldı.`);
        }
    }
    return successCount;
}

async function batchInsertNoId(tableName, dataArray, batchSize = 500) {
    if (dataArray.length === 0) return 0;
    let successCount = 0;
    for (let i = 0; i < dataArray.length; i += batchSize) {
        const batch = dataArray.slice(i, i + batchSize);
        const { error } = await supabase.from(tableName).insert(batch);
        if (error) console.error(`❌ ${tableName} aktarım hatası:`, error.message);
        else {
            successCount += batch.length;
            console.log(`✅ ${tableName}: ${successCount}/${dataArray.length} yazıldı.`);
        }
    }
    return successCount;
}

async function migrateStep7() {
    console.log("🚀 ADIM 7: ETEBS ve Evrak İndeksleme Verileri Taşınıyor...\n");

    console.log("⏳ Supabase'den geçerli ID'ler kontrol ediliyor...");
    const [ipRecords, txTypes, users, transactions] = await Promise.all([
        supabase.from('ip_records').select('id'),
        supabase.from('transaction_types').select('id'),
        supabase.from('users').select('id'),
        supabase.from('transactions').select('id')
    ]);

    const validIpIds = new Set(ipRecords.data?.map(i => i.id) || []);
    const validTxTypeIds = new Set(txTypes.data?.map(t => t.id) || []);
    const validUserIds = new Set(users.data?.map(u => u.id) || []);
    const validTxIds = new Set(transactions.data?.map(t => t.id) || []);

    const incomingDocsData = [];

    // ==========================================
    // 1A. unindexed_pdfs ÇEKİLİYOR
    // ==========================================
    console.log("\n⏳ 'unindexed_pdfs' koleksiyonu Firestore'dan çekiliyor...");
    const unindexedSnap = await db.collection('unindexed_pdfs').get();

    unindexedSnap.docs.forEach(doc => {
        const d = doc.data();
        const ipRecId = d.matchedRecordId || d.matched_record_id || d.ipRecordId;
        const txId = d.finalTransactionId || d.final_transaction_id;
        const userId = d.userId || d.user_id;

        incomingDocsData.push({
            id: doc.id,
            file_name: d.fileName || d.file_name || null,
            file_url: d.fileUrl || d.file_url || d.downloadURL || null,
            file_path: d.filePath || d.file_path || null,
            document_source: d.source || (d.isEtebs || d.is_etebs ? 'etebs' : 'manual'),
            status: d.status || 'pending',
            evrak_no: d.evrakNo || d.evrak_no || null,
            dosya_no: d.dosyaNo || d.dosya_no || null,
            belge_tarihi: safeDate(d.belgeTarihi || d.belge_tarihi),
            teblig_tarihi: safeDate(d.tebligTarihi || d.teblig_tarihi),
            ip_record_id: validIpIds.has(ipRecId) ? ipRecId : null,
            created_transaction_id: validTxIds.has(txId) ? txId : null,
            user_id: validUserIds.has(userId) ? userId : null,
            is_auto_processed: d.autoProcessed || d.auto_processed || d.matched || false,
            indexed_at: safeDate(d.indexedAt || d.indexed_at),
            created_at: safeDate(d.createdAt || d.created_at || d.uploadedAt || d.uploaded_at) || new Date().toISOString()
        });
    });

    // ==========================================
    // 1B. indexed_documents ÇEKİLİYOR (Birleştiriliyor)
    // ==========================================
    console.log("⏳ 'indexed_documents' koleksiyonu Firestore'dan çekiliyor ve birleştiriliyor...");
    const indexedSnap = await db.collection('indexed_documents').get();

    indexedSnap.docs.forEach(doc => {
        const d = doc.data();
        const ipRecId = d.ipRecordId || d.ip_record_id;
        const userId = d.userId || d.user_id;
        const txTypeId = d.transactionTypeId || d.transaction_type_id;

        // Aynı evrak (ID) unindexed_pdfs'de varsa onu ezer (günceller), yoksa yeni satır açar.
        incomingDocsData.push({
            id: doc.id,
            file_name: d.fileName || d.file_name || 'İndekslenmiş Evrak',
            file_url: d.fileUrl || d.file_url || d.downloadURL || null,
            document_source: d.documentSource || d.document_source || 'manual',
            status: d.status || 'indexed',
            evrak_no: d.etebsEvrakNo || d.etebs_evrak_no || null,
            dosya_no: d.etebsDosyaNo || d.etebs_dosya_no || null,
            ip_record_id: validIpIds.has(ipRecId) ? ipRecId : null,
            transaction_type_id: validTxTypeIds.has(txTypeId) ? txTypeId : null,
            user_id: validUserIds.has(userId) ? userId : null,
            description: d.description || null,
            is_auto_processed: d.autoProcessed || d.auto_processed || false,
            created_at: safeDate(d.createdAt || d.created_at || d.documentDate) || new Date().toISOString()
        });
    });

    console.log(`📌 Yazılacak Birleştirilmiş Evrak (incoming_documents) Sayısı: ${incomingDocsData.length}`);
    await batchUpsert('incoming_documents', incomingDocsData);

    // ==========================================
    // 2. ETEBS NOTIFICATIONS (Ham API Verileri JSONB içine)
    // ==========================================
    console.log("\n⏳ 'etebs_notifications' çekiliyor...");
    const etebsNotifSnap = await db.collection('etebs_notifications').get();
    const etebsNotifData = [];

    etebsNotifSnap.docs.forEach(doc => {
        const d = doc.data();
        const ipRecId = d.matchedRecordId || d.matched_record_id;
        
        // JSONB Paketi: Karmaşık/nadiren sorgulanan API verileri
        const rawData = {
            tebellugeden: d.tebellugeden,
            ilgili_vekil: d.ilgiliVekil || d.ilgili_vekil,
            belge_aciklamasi: d.belgeAciklamasi || d.belge_aciklamasi,
            dosya_turu: d.dosyaTuru || d.dosya_turu,
            uygulama_konma_tarihi: safeDate(d.uygulamaKonmaTarihi || d.uygulama_konma_tarihi),
            match_confidence: d.matchConfidence || d.match_confidence
        };

        etebsNotifData.push({
            id: doc.id,
            evrak_no: d.evrakNo || d.evrak_no || null,
            ip_record_id: validIpIds.has(ipRecId) ? ipRecId : null,
            token_used: d.tokenUsed || d.token_used || null,
            status: d.processStatus || d.process_status || null,
            belge_tarihi: safeDate(d.belgeTarihi || d.belge_tarihi),
            teblig_tarihi: safeDate(d.tebligTarihi || d.teblig_tarihi),
            raw_data: rawData,
            fetched_at: safeDate(d.fetchedAt || d.fetched_at) || new Date().toISOString(),
            processed_at: safeDate(d.processedAt || d.processed_at)
        });
    });
    await batchUpsert('etebs_notifications', etebsNotifData);

    // ==========================================
    // 3. ETEBS LOGS
    // ==========================================
    console.log("\n⏳ 'etebs_logs' çekiliyor...");
    const logsSnap = await db.collection('etebsLogs').get(); // Koleksiyon adı Firebase'de etebsLogs veya etebs_logs olabilir
    const etebsLogsSnap = logsSnap.empty ? await db.collection('etebs_logs').get() : logsSnap;
    const logsData = [];

    etebsLogsSnap.docs.forEach(doc => {
        const d = doc.data();
        const userId = d.userId || d.user_id;

        logsData.push({
            // id: UUID otomatik verilecek
            action: d.action || null,
            status: d.status || null,
            error_message: d.errorMessage || d.error_message || null,
            user_id: validUserIds.has(userId) ? userId : null,
            context: d.context || {},
            created_at: safeDate(d.createdAt || d.created_at || d.timestamp) || new Date().toISOString()
        });
    });
    await batchInsertNoId('etebs_logs', logsData);

    // ==========================================
    // 4. ETEBS TOKENS
    // ==========================================
    console.log("\n⏳ 'etebs_tokens' çekiliyor...");
    const tokensSnap = await db.collection('etebsTokens').get();
    const etebsTokensSnap = tokensSnap.empty ? await db.collection('etebs_tokens').get() : tokensSnap;
    const tokensData = [];

    etebsTokensSnap.docs.forEach(doc => {
        const d = doc.data();
        const userId = d.userId || d.user_id;
        // Firebase'de document ID token'ın kendisiyse doc.id'yi token olarak alalım, değilse d.token
        const tokenStr = d.token || doc.id;

        tokensData.push({
            token: tokenStr,
            user_id: validUserIds.has(userId) ? userId : null,
            is_active: d.isActive !== false, // Default true
            usage_stats: d.usageCount || d.usage_count || {},
            expires_at: safeDate(d.expiresAt || d.expires_at),
            last_used_at: safeDate(d.lastUsedAt || d.last_used_at),
            created_at: safeDate(d.createdAt || d.created_at) || new Date().toISOString()
        });
    });
    await batchInsertNoId('etebs_tokens', tokensData);

    console.log("\n🎉 ADIM 7 BAŞARIYLA TAMAMLANDI! Otomasyon ve ETEBS modülü SQL'e aktarıldı.");
}

migrateStep7().catch(console.error);