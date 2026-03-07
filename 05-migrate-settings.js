const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

// 🔴 1. FIREBASE BAĞLANTISI 
const serviceAccount = require('./firebase-key.json');
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// 🔴 2. SUPABASE BAĞLANTISI
const supabaseUrl = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNzg0NDgsImV4cCI6MjA4Nzc1NDQ0OH0.PFSzq8hOc14HgYwwF_ZR3v82ZzegKcoN4Vqw2wR2ZP0';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Yardımcı Fonksiyonlar
const safeDate = (val) => {
    if (!val) return null;
    try {
        const d = val.toDate ? val.toDate() : new Date(val);
        return isNaN(d.getTime()) ? null : d.toISOString();
    } catch { return null; }
};

const safeBool = (val) => val === true || val === 'true';
const safeArray = (val) => Array.isArray(val) ? val.filter(Boolean).map(String) : [];

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

async function migrateStep5() {
    console.log("🚀 ADIM 5: Sistem Ayarları, Kurallar ve Sabit Tablolar Taşınıyor...\n");

    // Foreign Key Doğrulaması için Persons listesini çekelim
    const { data: personsData } = await supabase.from('persons').select('id');
    const validPersonIds = new Set(personsData?.map(p => p.id) || []);

    // 1. COMMON
    console.log("⏳ 1. 'common' (Ülkeler, Şehirler vb.) çekiliyor...");
    const commonSnap = await db.collection('common').get();
    const commonData = commonSnap.docs.map(doc => ({
        id: doc.id,
        data: doc.data().data || doc.data() || {}
    }));
    await batchUpsert('common', commonData);

    // 2. TRANSACTION TYPES
    console.log("⏳ 2. 'transactionTypes' çekiliyor...");
    const txTypesSnap = await db.collection('transactionTypes').get();
    const txTypesData = txTypesSnap.docs.map(doc => {
        const d = doc.data();
        return {
            id: doc.id,
            name: d.name || null,
            alias: d.alias || null,
            ip_type: d.ipType || d.ip_type || null,
            hierarchy: d.hierarchy || null,
            applicable_to_main_type: safeArray(d.applicableToMainType || d.applicable_to_main_type),
            document_designation_default: d.documentDesignationDefault || d.document_designation_default || null,
            order_index: parseInt(d.orderIndex || d.order_index) || 0,
            is_top_level_selectable: safeBool(d.isTopLevelSelectable || d.is_top_level_selectable),
            allowed_child_types: safeArray(d.allowedChildTypes || d.allowed_child_types),
            index_file: safeArray(d.indexFile || d.index_file),
            index_bulk: safeArray(d.indexBulk || d.index_bulk),
            index_manuel: safeArray(d.indexManuel || d.index_manuel),
            task_triggered: d.taskTriggered || d.task_triggered || null,
            due_period: parseFloat(d.duePeriod || d.due_period) || 0,
            created_at: safeDate(d.createdAt) || new Date().toISOString(),
            updated_at: safeDate(d.updatedAt) || new Date().toISOString()
        };
    });
    await batchUpsert('transaction_types', txTypesData);

    // 3. TASK ASSIGNMENTS
    console.log("⏳ 3. 'taskAssignments' çekiliyor...");
    const assignmentsSnap = await db.collection('taskAssignments').get();
    const assignmentsData = assignmentsSnap.docs.map(doc => {
        const d = doc.data();
        return {
            id: doc.id,
            assignment_type: d.assignmentType || d.assignment_type || null,
            assignee_ids: safeArray(d.assigneeIds || d.assignee_ids),
            allow_manual_override: d.allowManualOverride !== false,
            updated_by: d.updatedBy || d.updated_by || null,
            created_at: safeDate(d.createdAt) || new Date().toISOString(),
            updated_at: safeDate(d.updatedAt) || new Date().toISOString()
        };
    });
    await batchUpsert('task_assignments', assignmentsData);

    // 4. NICE CLASSES
    console.log("⏳ 4. 'niceClasses' çekiliyor...");
    const classesSnap = await db.collection('niceClassification').get();
    const classesData = classesSnap.docs.map(doc => {
        const d = doc.data();
        return {
            id: doc.id,
            class_number: parseInt(d.classNumber || d.class_number) || null,
            class_title: d.classTitle || d.class_title || null,
            sub_classes: d.subClasses || d.sub_classes || [],
            created_at: safeDate(d.createdAt) || new Date().toISOString()
        };
    });
    await batchUpsert('nice_classes', classesData);

    // 5. COUNTERS
    console.log("⏳ 5. 'counters' çekiliyor...");
    const countersSnap = await db.collection('counters').get();
    const countersData = countersSnap.docs.map(doc => ({
        id: doc.id,
        last_id: parseFloat(doc.data().lastId || doc.data().count || 0)
    }));
    await batchUpsert('counters', countersData);
    console.log("\n🎉 ADIM 5 BAŞARIYLA TAMAMLANDI! Sistem ayarları ve sabit tablolar SQL'e aktarıldı.");
}

migrateStep5().catch(console.error);