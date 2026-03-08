const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// 🔴 1. FIREBASE BAĞLANTISI 
const serviceAccount = require('./firebase-key.json'); 
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// 🔴 2. SUPABASE BAĞLANTISI (BUNLARI KENDİ PROJENİZE GÖRE DOLDURUN)
const SUPABASE_URL = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNzg0NDgsImV4cCI6MjA4Nzc1NDQ0OH0.PFSzq8hOc14HgYwwF_ZR3v82ZzegKcoN4Vqw2wR2ZP0';
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

async function migrateStep1() {
    console.log("🚀 ADIM 1: Kişiler, Belgeler, Kullanıcılar ve İlgili Kişiler Taşınıyor...\n");

    // =========================================
    // 1. PERSONS & PERSON_DOCUMENTS
    // =========================================
    console.log("⏳ 1. 'persons' koleksiyonu çekiliyor (Evraklar Ayıklanıyor)...");
    const personsSnap = await db.collection('persons').get();
    
    const personsData = [];
    const personDocumentsData = []; // 🔥 Yeni evrak tablosu için dizi

    personsSnap.docs.forEach(doc => {
        const d = doc.data();
        let bDate = null;
        if (d.birthDate && typeof d.birthDate === 'string' && d.birthDate.includes('.')) {
            const parts = d.birthDate.split('.');
            if (parts.length === 3) bDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
        }

        // Ana Kişi Verisi
        personsData.push({
            id: doc.id,
            name: d.name || d.companyName || 'İsimsiz',
            type: d.type || 'gercek',
            tckn: d.tckn || null,
            birth_date: bDate,
            tax_office: d.taxOffice || d.tax_office || null, // 🔥 YENİ: Vergi Dairesi eklendi
            tax_no: d.taxNo || null,
            tpe_no: d.tpeNo || null,
            email: d.email || null,
            phone: d.phone || null,
            address: d.address || null,
            country_code: d.countryCode || 'TR', // country_name kaldırıldı
            province: d.province || d.city || null,
            is_evaluation_required: d.is_evaluation_required || false,
            created_at: safeDate(d.createdAt) || new Date().toISOString(),
            updated_at: safeDate(d.updatedAt) || new Date().toISOString()
        });

        // 🔥 YENİ: Evrakları (Documents) ayrı diziye topluyoruz
        if (Array.isArray(d.documents)) {
            d.documents.forEach(docItem => {
                // Sadece URL'si olan anlamlı belgeleri alıyoruz
                if (docItem.url || docItem.downloadURL) {
                    personDocumentsData.push({
                        person_id: doc.id,
                        file_name: docItem.fileName || docItem.name || 'İsimsiz Belge',
                        document_type: docItem.type || 'Diğer',
                        url: docItem.url || docItem.downloadURL,
                        country_code: docItem.countryCode || null,
                        validity_date: docItem.validityDate || null // TEXT olarak gidecek
                    });
                }
            });
        }
    });
    
    await batchUpsert('persons', personsData);
    
    // Evrakları veritabanına ekle (Bunların ID'si olmadığı için upsert yerine insert kullanıyoruz)
    if (personDocumentsData.length > 0) {
        console.log(`\n⏳ 1.1 Müvekkil Evrakları (person_documents) yazılıyor (${personDocumentsData.length} adet)...`);
        // 500'erli batch'ler halinde insert edelim
        let docCount = 0;
        for (let i = 0; i < personDocumentsData.length; i += 500) {
            const batch = personDocumentsData.slice(i, i + 500);
            const { error: docError } = await supabase.from('person_documents').insert(batch);
            if (docError) {
                console.error(`❌ person_documents aktarım hatası:`, docError.message);
            } else {
                docCount += batch.length;
                console.log(`✅ person_documents: ${docCount}/${personDocumentsData.length} evrak yazıldı.`);
            }
        }
    }

    const validPersonIds = new Set(personsData.map(p => p.id));

    // =========================================
    // 2. USERS & USER_PERSON_LINKS (YETKİLER)
    // =========================================
    console.log("\n⏳ 2. 'users' koleksiyonu çekiliyor...");
    const usersSnap = await db.collection('users').get();
    
    const usersData = [];
    const userPersonLinksData = [];

    usersSnap.docs.forEach(doc => {
        const d = doc.data();
        const role = d.role || 'user';
        const perms = d.permissions || {};
        
        const pApproval = perms.approval || false;
        const pView = perms.view !== undefined ? perms.view : true;

        usersData.push({
            id: doc.id,
            email: d.email || null,
            display_name: d.displayName || d.name || d.email?.split('@')[0] || "İsimsiz",
            role: role,
            disabled: d.disabled || false,
            created_at: safeDate(d.createdAt) || new Date().toISOString(),
            updated_at: safeDate(d.updatedAt) || new Date().toISOString()
        });

        if (role === 'client') {
            const primaryPersonId = d.personId;
            const linkedIds = Array.isArray(d.linkedPersonIds) ? d.linkedPersonIds : [];
            const processedLinks = new Set();

            if (primaryPersonId && validPersonIds.has(primaryPersonId)) {
                userPersonLinksData.push({
                    user_id: doc.id,
                    person_id: primaryPersonId,
                    is_primary: true,
                    perm_approval: pApproval,
                    perm_view: pView
                });
                processedLinks.add(primaryPersonId);
            }

            linkedIds.forEach(lId => {
                if (lId && !processedLinks.has(lId) && validPersonIds.has(lId)) {
                    userPersonLinksData.push({
                        user_id: doc.id,
                        person_id: lId,
                        is_primary: false,
                        perm_approval: pApproval,
                        perm_view: pView
                    });
                    processedLinks.add(lId);
                }
            });
        }
    });

    await batchUpsert('users', usersData);
    
    if (userPersonLinksData.length > 0) {
        console.log("\n⏳ 2.1 Kullanıcı-Müvekkil Bağlantıları (user_person_links) yazılıyor...");
        const { error: linkError } = await supabase.from('user_person_links').upsert(userPersonLinksData, { onConflict: 'user_id, person_id' });
        if (linkError) console.error(`❌ user_person_links hatası:`, linkError.message);
        else console.log(`✅ user_person_links: ${userPersonLinksData.length} kayıt yazıldı.`);
    }

    // =========================================
    // 3. PERSONS_RELATED
    // =========================================
    console.log("\n⏳ 3. 'personsRelated' koleksiyonu çekiliyor (Yassılaştırılıyor)...");
    const relatedSnap = await db.collection('personsRelated').get();
    const relatedData = [];

    relatedSnap.docs.forEach(doc => {
        const d = doc.data();
        if (d.personId && validPersonIds.has(d.personId)) {
            const resp = d.responsible || {};
            const notif = d.notify || {};

            relatedData.push({
                id: doc.id, 
                person_id: d.personId,
                name: d.name || 'İsimsiz İlgili',
                email: d.email || null,
                phone: d.phone || null,
                resp_trademark: resp.marka || false,
                resp_patent: resp.patent || false,
                resp_design: resp.tasarim || false,
                resp_litigation: resp.dava || false,
                resp_finance: resp.muhasebe || false,
                notify_trademark_to: notif.marka?.to || false,
                notify_trademark_cc: notif.marka?.cc || false,
                notify_patent_to: notif.patent?.to || false,
                notify_patent_cc: notif.patent?.cc || false,
                notify_design_to: notif.tasarim?.to || false,
                notify_design_cc: notif.tasarim?.cc || false,
                notify_finance_to: notif.muhasebe?.to || false,
                notify_finance_cc: notif.muhasebe?.cc || false,
                created_at: safeDate(d.createdAt) || new Date().toISOString()
            });
        }
    });
    
    await batchUpsert('persons_related', relatedData);

    console.log("\n🎉 ADIM 1 BAŞARIYLA TAMAMLANDI!");
}

migrateStep1().catch(console.error);