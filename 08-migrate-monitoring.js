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

const safeArray = (val) => {
    if (Array.isArray(val)) return val.map(String);
    if (typeof val === 'string') return val.split(/[,\/]/).map(s => s.trim()).filter(Boolean);
    return [];
};

async function batchUpsert(tableName, dataArray, batchSize = 1000) {
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

// 🌟 SİHİRLİ FONKSİYON: Supabase'den 1000 limitine takılmadan TÜM ID'leri çeker
async function getAllValidIpIds() {
    let allIds = new Set();
    let from = 0;
    const step = 1000;
    
    while (true) {
        const { data, error } = await supabase
            .from('ip_records')
            .select('id')
            .range(from, from + step - 1);
            
        if (error) {
            console.error("❌ IP ID'leri çekilirken hata:", error.message);
            break;
        }
        if (!data || data.length === 0) break;
        
        data.forEach(item => allIds.add(item.id));
        
        if (data.length < step) break; // Son sayfaya geldik demektir
        from += step;
    }
    
    console.log(`📌 Supabase'den toplam ${allIds.size} adet IP Record ID'si hafızaya alındı.`);
    return allIds;
}

async function migrateStep8() {
    console.log("🚀 ADIM 8: Bülten ve Marka İzleme Verileri Taşınıyor...\n");

    // 1000 limitine takılmadan tüm markaları hafızaya alıyoruz
    const validIpIds = await getAllValidIpIds();
    const appNoToRecordId = new Map();

    // ==========================================
    // A. BÜLTENLER
    // ==========================================
    console.log("⏳ 1. 'trademarkBulletins' çekiliyor...");
    const bulletinsSnap = await db.collection('trademarkBulletins').get();
    const bulletinsData = bulletinsSnap.docs.map(doc => {
        const d = doc.data();
        let sqlDate = null;
        if (d.bulletinDate && d.bulletinDate.includes('/')) {
            const parts = d.bulletinDate.split('/');
            sqlDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        return {
            id: doc.id,
            bulletin_no: d.bulletinNo || null,
            bulletin_date: sqlDate || safeDate(d.bulletinDate),
            type: d.type || 'marka',
            created_at: safeDate(d.createdAt) || new Date().toISOString()
        };
    });
    await batchUpsert('trademark_bulletins', bulletinsData);

    // ==========================================
    // B. BÜLTEN KAYITLARI (İLK 10)
    // ==========================================
    console.log("⏳ 2. 'trademarkBulletinRecords' çekiliyor (Sadece 10 limitli)...");
    
    let recordsSnap = await db.collection('trademarkBulletinRecords').limit(10).get();
    if (recordsSnap.empty) {
        recordsSnap = await db.collection('bulletinRecords').limit(10).get();
    }
    
    const recordsData = [];
    const targetAppNos = []; 

    recordsSnap.docs.forEach(doc => {
        const d = doc.data();
        const appNo = d.applicationNo || d.applicationNumber;
        if (appNo) {
            appNoToRecordId.set(appNo, doc.id);
            targetAppNos.push(appNo); 
        }

        let holdersJson = [];
        try {
            if (typeof d.holders === 'string') holdersJson = JSON.parse(d.holders);
            else if (Array.isArray(d.holders)) holdersJson = d.holders;
        } catch(e) {}

        recordsData.push({
            id: doc.id,
            bulletin_id: d.bulletinId || d.bulletin_id || null,
            application_number: appNo || null,
            application_date: safeDate(d.applicationDate),
            brand_name: d.markName || d.brandName || null,
            nice_classes: safeArray(d.niceClasses || d.classNumbers),
            holders: holdersJson,
            image_url: d.imagePath || d.imageUrl || null,
            source: d.source || null,
            created_at: safeDate(d.createdAt) || new Date().toISOString()
        });
    });
    await batchUpsert('trademark_bulletin_records', recordsData);

    // ==========================================
    // C. BÜLTEN EMTİA LİSTESİ (Garanti Döngü)
    // ==========================================
    console.log(`⏳ 3. 'trademarkBulletinGoods' çekiliyor (Hedef ${targetAppNos.length} markanın emtiaları aranıyor)...`);
    const goodsData = [];
    
    for (const appNo of targetAppNos) {
        let goodsSnap = await db.collection('trademarkBulletinGoods').where('applicationNo', '==', appNo).get();
        if (goodsSnap.empty) {
            goodsSnap = await db.collection('trademarkBulletinGoods').where('applicationNumber', '==', appNo).get();
        }

        goodsSnap.docs.forEach(doc => {
            const d = doc.data();
            const bRecordId = appNoToRecordId.get(appNo); 
            if (bRecordId) {
                goodsData.push({
                    id: doc.id,
                    bulletin_record_id: bRecordId,
                    class_number: parseInt(d.classNo || d.class_no) || null,
                    class_text: d.classText || d.class_text || null,
                    created_at: safeDate(d.createdAt) || new Date().toISOString()
                });
            }
        });
    }
    console.log(`📌 Bulunan Emtia (Goods) Sayısı: ${goodsData.length}`);
    await batchUpsert('trademark_bulletin_goods', goodsData);

    // ==========================================
    // D. İZLENEN MARKALAR (Sınırsız IP Listesi İle)
    // ==========================================
    console.log("\n⏳ 4. 'monitoringTrademarks' çekiliyor...");
    const monitoringSnap = await db.collection('monitoringTrademarks').get();
    const monitoringData = [];
    const validMonitoringIds = new Set();
    let orphanCount = 0;

    monitoringSnap.docs.forEach(doc => {
        const d = doc.data();
        const ipRecId = d.ipRecordId || d.relatedRecordId || d.id || d.ip_record_id || doc.id;        if (validIpIds.has(ipRecId)) {
            validMonitoringIds.add(doc.id);
            monitoringData.push({
                id: doc.id,
                ip_record_id: ipRecId,
                search_mark_name: d.searchMarkName || d.search_mark_name || null,
                brand_text_search: safeArray(d.brandTextSearch || d.brand_text_search),
                nice_class_search: safeArray(d.niceClassSearch || d.nice_class_search),
                created_at: safeDate(d.createdAt) || new Date().toISOString(),
                updated_at: safeDate(d.updatedAt) || new Date().toISOString()
            });
        } else {
            orphanCount++; 
        }
    });
    
    console.log(`📌 Firebase Toplam Kural: ${monitoringSnap.size} | Geçerli (Taşınan): ${monitoringData.length} | IP Kaydı Olmayan (Çöp): ${orphanCount}`);
    await batchUpsert('monitoring_trademarks', monitoringData);

    // ==========================================
    // E. YAKALANAN BENZERLİKLER (Garanti Döngü)
    // ==========================================
    console.log("\n⏳ 5. 'monitoringTrademarkRecords' çekiliyor (Hedef 10 Marka Aranıyor)...");
    const mtRecordsData = [];
    
    for (const appNo of targetAppNos) {
        let mtRecordsSnap = await db.collection('monitoringTrademarkRecords').where('similarApplicationNo', '==', appNo).get();
        if (mtRecordsSnap.empty) {
            mtRecordsSnap = await db.collection('monitoringTrademarkRecords').where('similar_application_no', '==', appNo).get();
        }

        mtRecordsSnap.docs.forEach(doc => {
            const d = doc.data();
            const monitoredId = d.monitoredTrademarkId || d.monitored_trademark_id;
            const bRecordId = appNoToRecordId.get(appNo); 

            if (validMonitoringIds.has(monitoredId) && bRecordId) {
                mtRecordsData.push({
                    id: doc.id,
                    monitored_trademark_id: monitoredId,
                    bulletin_record_id: bRecordId,
                    similarity_score: parseFloat(d.similarityScore || d.similarity_score) || 0,
                    is_earlier: d.isEarlier || d.is_earlier || false,
                    is_similar: d.isSimilar || d.is_similar || false,
                    matched_term: d.matchedTerm || d.matched_term || null,
                    success_chance: d.bsValue || d.bs_value || null,
                    note: d.note || null,
                    source: d.source || null,
                    created_at: safeDate(d.createdAt) || new Date().toISOString()
                });
            }
        });
    }
    console.log(`📌 Bulunan Benzerlik Sonucu Sayısı: ${mtRecordsData.length}`);
    await batchUpsert('monitoring_trademark_records', mtRecordsData);

    console.log("\n🎉 ADIM 8 BAŞARIYLA TAMAMLANDI!");
}

migrateStep8().catch(console.error);