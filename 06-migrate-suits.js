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

async function migrateStep6() {
    console.log("🚀 ADIM 6: Davalar (Suits) ve Dava Evrakları Taşınıyor...\n");

    // 1. Foreign Key doğrulama havuzlarını çek
    console.log("⏳ Supabase'den geçerli ID'ler kontrol ediliyor...");
    const [persons, ipRecords, tasks, txTypes] = await Promise.all([
        supabase.from('persons').select('id'),
        supabase.from('ip_records').select('id'),
        supabase.from('tasks').select('id'),
        supabase.from('transaction_types').select('id')
    ]);

    const validPersonIds = new Set(persons.data?.map(p => p.id) || []);
    const validIpIds = new Set(ipRecords.data?.map(i => i.id) || []);
    const validTaskIds = new Set(tasks.data?.map(t => t.id) || []);
    const validTxTypeIds = new Set(txTypes.data?.map(t => t.id) || []);

    // 2. Firestore'dan veriyi çek
    console.log("\n⏳ 'suits' koleksiyonu Firestore'dan çekiliyor...");
    const suitsSnap = await db.collection('suits').get();

    const suitsData = [];
    const suitDocsData = [];

    suitsSnap.docs.forEach(doc => {
        const s = doc.data();
        const suitId = doc.id;
        const details = s.suitDetails || {}; // Bazı veriler details objesinde tutulmuş olabilir

        // İlişkileri Çözümleme (Reference Checks)
        // subjectAsset: { id: "123", type: "ipRecord" } şeklinde de gelebiliyor, direkt string de olabiliyor
        let ipRecId = null;
        if (s.subjectAsset && typeof s.subjectAsset === 'object') ipRecId = s.subjectAsset.id;
        else if (typeof s.subjectAsset === 'string') ipRecId = s.subjectAsset;

        const finalIpRecordId = validIpIds.has(ipRecId) ? ipRecId : null;
        const finalClientId = validPersonIds.has(s.clientId || s.client_id || s.client?.id) ? (s.clientId || s.client_id || s.client?.id) : null;
        const finalTaskId = validTaskIds.has(s.relatedTaskId || s.related_task_id) ? (s.relatedTaskId || s.related_task_id) : null;
        const finalTxTypeId = validTxTypeIds.has(s.transactionTypeId || s.transaction_type_id) ? (s.transactionTypeId || s.transaction_type_id) : null;

        suitsData.push({
            id: suitId,
            title: s.title || null,
            file_no: s.fileNo || s.file_no || details.caseNo || null,
            court_name: s.courtName || s.court_name || details.court || null,
            description: s.description || details.description || null,
            suit_type: s.suitType || s.suit_type || null,
            status: s.status || s.suitStatus || 'continue',
            origin: s.origin || 'TURKEY',
            opening_date: safeDate(s.openingDate || s.opening_date || details.openingDate),
            
            client_role: s.clientRole || s.client_role || null,
            opposing_party: s.opposingParty || s.opposing_party || details.opposingParty || null,
            opposing_counsel: s.opposingCounsel || s.opposing_counsel || details.opposingCounsel || null,
            
            client_id: finalClientId,
            ip_record_id: finalIpRecordId,
            task_id: finalTaskId,
            transaction_type_id: finalTxTypeId,
            
            created_at: safeDate(s.createdAt || s.created_at) || new Date().toISOString(),
            updated_at: safeDate(s.updatedAt || s.updated_at) || new Date().toISOString()
        });

        // Dava Evraklarını Ayrıştırma
        if (Array.isArray(s.documents)) {
            s.documents.forEach(docItem => {
                const docUrl = docItem.url || docItem.downloadURL || docItem.fileUrl;
                if (docUrl) {
                    suitDocsData.push({
                        suit_id: suitId,
                        document_name: docItem.name || docItem.fileName || 'İsimsiz Dava Belgesi',
                        document_url: docUrl,
                        document_type: docItem.type || 'document',
                        uploaded_at: safeDate(docItem.uploadedAt) || new Date().toISOString()
                    });
                }
            });
        }
    });

    console.log(`\n📌 Yazılacak Veri Özeti:
    - Dava Kayıtları: ${suitsData.length}
    - Dava Evrakları: ${suitDocsData.length}`);

    await batchUpsert('suits', suitsData);
    await batchInsertNoId('suit_documents', suitDocsData);

    console.log("\n🎉 ADIM 6 BAŞARIYLA TAMAMLANDI! Hukuk ve Dava modülü SQL'e taşındı.");
}

migrateStep6().catch(console.error);