const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');
const serviceAccount = require('./firebase-key.json');

// 🔴 1. FIREBASE BAĞLANTISI 
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// 🔴 2. SUPABASE BAĞLANTISI
const supabaseUrl = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNzg0NDgsImV4cCI6MjA4Nzc1NDQ0OH0.PFSzq8hOc14HgYwwF_ZR3v82ZzegKcoN4Vqw2wR2ZP0';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const safeDate = (val) => {
    if (!val) return null;
    try {
        const d = val.toDate ? val.toDate() : new Date(val);
        return isNaN(d.getTime()) ? null : d.toISOString();
    } catch { return null; }
};

const safeBoolean = (val) => {
    if (val === true || val === 'true' || val === 'evet' || val === 'var') return true;
    return false;
};

async function batchUpsert(tableName, dataArray, conflictKey = 'id', batchSize = 500) {
    if (dataArray.length === 0) return 0;
    let successCount = 0;
    for (let i = 0; i < dataArray.length; i += batchSize) {
        const batch = dataArray.slice(i, i + batchSize);
        const { error } = await supabase.from(tableName).upsert(batch, { onConflict: conflictKey });
        if (error) {
            console.error(`❌ ${tableName} aktarım hatası (${i}-${i + batch.length}):`, error.message);
        } else {
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

async function migrateStep2() {
    console.log("🚀 ADIM 2: Portföy (IP Records) ve İlişkili Tablolar Taşınıyor...\n");

    console.log("⏳ 1. Supabase'den geçerli kişiler (persons) kontrol ediliyor...");
    const { data: personsData, error: personError } = await supabase.from('persons').select('id');
    if (personError) throw personError;
    const validPersonIds = new Set(personsData.map(p => p.id));
    console.log(`ℹ️ ${validPersonIds.size} geçerli kişi (müvekkil/aktör) bulundu.`);

    console.log("\n⏳ 2. 'ipRecords' koleksiyonu Firebase'den çekiliyor...");
    const ipRecordsSnap = await db.collection('ipRecords').get();

    const parentRecords = [];
    const childRecords = [];
    const trademarkDetails = [];
    const applicantsData = [];
    const classesData = [];
    const bulletinsData = [];
    const prioritiesData = [];

    ipRecordsSnap.docs.forEach(doc => {
        const d = doc.data();
        const recordId = doc.id;
        const ipType = d.type || d.ipType || 'trademark';

        // --- 1. ANA TABLO VERİSİ ---
        const recordObj = {
            id: recordId,
            ip_type: ipType,
            origin: d.origin || 'TÜRKPATENT',
            portfolio_status: d.portfoyStatus || 'active',
            status: d.status || 'filed',
            record_owner_type: d.recordOwnerType || 'self',
            application_number: d.applicationNumber || d.applicationNo || null,
            application_date: safeDate(d.applicationDate),
            registration_number: d.registrationNumber || null,
            registration_date: safeDate(d.registrationDate),
            renewal_date: safeDate(d.renewalDate),
            country_code: d.countryCode || d.country || null,
            parent_id: d.parentId || null,
            transaction_hierarchy: d.transactionHierarchy || 'parent',
            created_from: d.createdFrom || null,
            wipo_ir: d.wipoIR || null,
            aripo_ir: d.aripoIR || null,
            created_at: safeDate(d.createdAt) || new Date().toISOString(),
            updated_at: safeDate(d.updatedAt) || new Date().toISOString()
        };

        if (recordObj.parent_id && recordObj.transaction_hierarchy === 'child') {
            childRecords.push(recordObj);
        } else {
            parentRecords.push(recordObj);
        }

        // --- 2. MARKA DETAYLARI TABLOSU ---
        if (ipType === 'trademark') {
            trademarkDetails.push({
                ip_record_id: recordId,
                // 🔥 YENİ: details.brandInfo içindeki ad ve görseller de alındı
                brand_name: d.brandName || d.title || d.brandText || d.details?.brandInfo?.brandExampleText || d.details?.brandInfo?.markName || null,
                brand_type: d.brandType || d.details?.brandInfo?.brandType || null,
                brand_category: d.brandCategory || d.details?.brandInfo?.brandCategory || null,
                brand_image_url: d.brandImageUrl || d.imageUrl || d.details?.brandInfo?.brandImage || null,
                description: d.description || null,
                non_latin_alphabet: safeBoolean(d.nonLatinAlphabet || d.details?.brandInfo?.nonLatinAlphabet),
                consent_request: d.consentRequest || null,
                cover_letter_request: d.coverLetterRequest || null,
                has_registration_cert: safeBoolean(d.hasRegistrationCert)
            });
        }

        // --- 3. BAŞVURU SAHİPLERİ ---
        if (Array.isArray(d.applicants)) {
            d.applicants.forEach((app, index) => {
                const pId = app.id || app.personId;
                if (pId && validPersonIds.has(pId)) {
                    applicantsData.push({
                        ip_record_id: recordId,
                        person_id: pId,
                        order_index: index,
                        is_invoice_client: false
                    });
                }
            });
        } else if (d.clientId && validPersonIds.has(d.clientId)) {
            applicantsData.push({
                ip_record_id: recordId,
                person_id: d.clientId,
                order_index: 0,
                is_invoice_client: true
            });
        }

        // --- 4. SINIFLAR ---
        // Normal sınıflar
        if (Array.isArray(d.goodsAndServicesByClass)) {
            d.goodsAndServicesByClass.forEach(gsc => {
                if (gsc.classNo) {
                    classesData.push({
                        id: `${recordId}_${gsc.classNo}`, 
                        ip_record_id: recordId,
                        class_no: parseInt(gsc.classNo, 10),
                        items: Array.isArray(gsc.items) ? gsc.items : []
                    });
                }
            });
        }
        // 🔥 YENİ: details.brandInfo içindeki 3. taraf sınıfları eklendi
        if (Array.isArray(d.details?.brandInfo?.goodsAndServices)) {
            d.details.brandInfo.goodsAndServices.forEach(gsc => {
                const cNo = gsc.niceClass || gsc.classNo;
                if (cNo) {
                    classesData.push({
                        id: `${recordId}_${cNo}`, 
                        ip_record_id: recordId,
                        class_no: parseInt(cNo, 10),
                        items: Array.isArray(gsc.items) ? gsc.items : []
                    });
                }
            });
        }

        // --- 5. BÜLTENLER ---
        // Normal Bültenler
        if (Array.isArray(d.bulletins)) {
            d.bulletins.forEach(bul => {
                if (bul.bulletinNo || bul.bulletinDate) {
                    bulletinsData.push({
                        id: `${recordId}_bul_${bul.bulletinNo || Date.now()}`,
                        ip_record_id: recordId,
                        bulletin_no: bul.bulletinNo || null,
                        bulletin_date: safeDate(bul.bulletinDate)
                    });
                }
            });
        }
        // 🔥 YENİ: details.brandInfo altındaki opposedMarkBulletinNo ve opposedMarkBulletinDate eklendi
        const oppBulNo = d.details?.brandInfo?.opposedMarkBulletinNo || d.details?.opposedMarkBulletinNo;
        const oppBulDate = d.details?.brandInfo?.opposedMarkBulletinDate || d.details?.opposedMarkBulletinDate;

        if (oppBulNo || oppBulDate) {
            bulletinsData.push({
                id: `${recordId}_opp_bul_${oppBulNo || Date.now()}`,
                ip_record_id: recordId,
                bulletin_no: oppBulNo ? String(oppBulNo) : null,
                bulletin_date: safeDate(oppBulDate)
            });
        }

        // --- 6. RÜÇHANLAR ---
        if (Array.isArray(d.priorities)) {
            d.priorities.forEach((p, idx) => {
                if (p.priorityCountry || p.priorityNumber) {
                    prioritiesData.push({
                        id: `${recordId}_prio_${idx}`,
                        ip_record_id: recordId,
                        priority_country: p.priorityCountry || null,
                        priority_date: safeDate(p.priorityDate),
                        priority_number: p.priorityNumber || null
                    });
                }
            });
        }
    });

    console.log(`\n📌 Yazılacak Veri Özeti:
    - Ebeveyn Kayıtlar (Base): ${parentRecords.length}
    - Çocuk (WIPO vb) Kayıtlar (Base): ${childRecords.length}
    - Marka Detayları (Extension): ${trademarkDetails.length}
    - Başvuru Sahipleri: ${applicantsData.length}
    - Mal/Hizmet Sınıfları: ${classesData.length}
    - Bülten Geçmişleri: ${bulletinsData.length}
    - Rüçhanlar: ${prioritiesData.length}`);

    // --- YAZMA İŞLEMLERİ ---
    console.log("\n⏳ 3. Ebeveyn Portföy Kayıtları (Base) yazılıyor...");
    await batchUpsert('ip_records', parentRecords, 'id');

    console.log("\n⏳ 4. Alt (Çocuk) Portföy Kayıtları (Base) yazılıyor...");
    const validParentIds = new Set(parentRecords.map(p => p.id));
    const validChildRecords = childRecords.filter(c => validParentIds.has(c.parent_id));
    await batchUpsert('ip_records', validChildRecords, 'id');

    const allValidIpRecordIds = new Set([...parentRecords.map(p => p.id), ...validChildRecords.map(c => c.id)]);

    console.log("\n⏳ 5. Marka Detayları (Trademark Details) yazılıyor...");
    await batchUpsert('ip_record_trademark_details', trademarkDetails.filter(t => allValidIpRecordIds.has(t.ip_record_id)), 'ip_record_id');

    console.log("\n⏳ 6. Başvuru Sahipleri (Applicants) ilişkileri kuruluyor...");
    await batchInsertNoId('ip_record_applicants', applicantsData.filter(a => allValidIpRecordIds.has(a.ip_record_id)));

    console.log("\n⏳ 7. Mal/Hizmet Sınıfları ekleniyor...");
    await batchUpsert('ip_record_classes', classesData.filter(c => allValidIpRecordIds.has(c.ip_record_id)), 'id');

    console.log("\n⏳ 8. Bülten Geçmişleri ekleniyor...");
    await batchUpsert('ip_record_bulletins', bulletinsData.filter(b => allValidIpRecordIds.has(b.ip_record_id)), 'id');

    console.log("\n⏳ 9. Rüçhan (Priority) bilgileri ekleniyor...");
    await batchUpsert('ip_record_priorities', prioritiesData.filter(p => allValidIpRecordIds.has(p.ip_record_id)), 'id');

    console.log("\n🎉 ADIM 2 BAŞARIYLA TAMAMLANDI!");
}

migrateStep2().catch(console.error);