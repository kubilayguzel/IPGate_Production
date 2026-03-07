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

const safeDate = (val) => {
    if (!val) return null;
    try {
        const d = val.toDate ? val.toDate() : new Date(val);
        return isNaN(d.getTime()) ? null : d.toISOString();
    } catch { return null; }
};

async function patchTaskHistory() {
    console.log("🚀 YAMA İŞLEMİ: Görev Geçmişi (Task History) JSONB Olarak Düzeltiliyor...\n");

    // 1. Supabase'den geçerli user ID'leri çekelim (Foreign Key hatası almamak için)
    const { data: usersData } = await supabase.from('users').select('id');
    const validUserIds = new Set(usersData?.map(u => u.id) || []);

    // 2. Mevcut (eksik aktarılan) Task History kayıtlarını temizleyelim
    console.log("⏳ 1. Eski task_history kayıtları temizleniyor...");
    const { error: deleteError } = await supabase.from('task_history').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (deleteError) {
        console.error("❌ Temizleme hatası:", deleteError.message);
        return;
    }
    console.log("✅ Eski kayıtlar başarıyla silindi.");

    // 3. Firebase'den görevleri tekrar çekip detayları paketleyelim
    console.log("\n⏳ 2. Firebase 'tasks' koleksiyonu taranıyor ve geçmiş verileri paketleniyor...");
    const tasksSnap = await db.collection('tasks').get();
    const taskHistoryData = [];

    tasksSnap.docs.forEach(doc => {
        const d = doc.data();
        const taskId = doc.id;

        if (Array.isArray(d.history)) {
            d.history.forEach(h => {
                // Temel kolonları ayırıyoruz
                const actionVal = h.action || h.status || 'system_update';
                const userIdVal = validUserIds.has(h.userId || h.uid) ? (h.userId || h.uid) : null;
                const createdAtVal = safeDate(h.timestamp || h.createdAt) || new Date().toISOString();

                // 🌟 SİHİRLİ KISIM: Geri kalan TÜM dağınık verileri JSONB'ye paketliyoruz
                const { action, status, userId, uid, timestamp, createdAt, details, ...otherProperties } = h;
                const baseDetails = h.details || {};
                
                // baseDetails (varsa) ile diğer tüm dışarıda kalmış Firebase verilerini birleştiriyoruz
                const finalDetailsJsonb = { ...baseDetails, ...otherProperties };

                taskHistoryData.push({
                    task_id: taskId,
                    action: actionVal,
                    user_id: userIdVal,
                    details: finalDetailsJsonb, // Tüm extra veriler artık burada!
                    created_at: createdAtVal
                });
            });
        }
    });

    console.log(`📌 Yeniden yazılacak tam donanımlı geçmiş kaydı sayısı: ${taskHistoryData.length}`);

    // 4. Yeni verileri Supabase'e yazalım
    console.log("\n⏳ 3. Yeni veriler Supabase'e yazılıyor...");
    let successCount = 0;
    const batchSize = 500;
    
    for (let i = 0; i < taskHistoryData.length; i += batchSize) {
        const batch = taskHistoryData.slice(i, i + batchSize);
        const { error } = await supabase.from('task_history').insert(batch);
        
        if (error) {
            console.error(`❌ Yazma hatası (${i}-${i + batch.length}):`, error.message);
        } else {
            successCount += batch.length;
            console.log(`✅ task_history: ${successCount}/${taskHistoryData.length} başarıyla yazıldı.`);
        }
    }

    console.log("\n🎉 YAMA TAMAMLANDI! Artık tüm esnek log verileriniz 'details' JSONB kolonu içinde güvende.");
}

patchTaskHistory().catch(console.error);