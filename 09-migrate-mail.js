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
    if (Array.isArray(val)) return val.map(String).filter(Boolean);
    if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
    return [];
};

async function batchUpsert(tableName, dataArray, batchSize = 500) {
    if (!dataArray || dataArray.length === 0) {
        console.log(`ℹ️ DİKKAT: '${tableName}' için aktarılacak veri bulunamadı!`);
        return 0;
    }
    let successCount = 0;
    for (let i = 0; i < dataArray.length; i += batchSize) {
        const batch = dataArray.slice(i, i + batchSize);
        const { error } = await supabase.from(tableName).upsert(batch, { onConflict: 'id' });
        if (error) console.error(`❌ '${tableName}' aktarım hatası:`, error.message);
        else successCount += batch.length;
    }
    console.log(`✅ ${tableName}: ${successCount}/${dataArray.length} yazıldı.`);
    return successCount;
}

async function batchInsertNoId(tableName, dataArray, batchSize = 500) {
    if (!dataArray || dataArray.length === 0) {
        console.log(`ℹ️ DİKKAT: '${tableName}' için aktarılacak veri bulunamadı!`);
        return 0;
    }
    let successCount = 0;
    for (let i = 0; i < dataArray.length; i += batchSize) {
        const batch = dataArray.slice(i, i + batchSize);
        const { error } = await supabase.from(tableName).insert(batch);
        if (error) console.error(`❌ '${tableName}' aktarım hatası:`, error.message);
        else successCount += batch.length;
    }
    console.log(`✅ ${tableName}: ${successCount}/${dataArray.length} yazıldı.`);
    return successCount;
}

async function migrateStep9() {
    console.log("🚀 ADIM 9: Mail ve Bildirim Modülü Taşınıyor (İsimlendirme Zırhlı)...\n");

    const [persons, ipRecords, tasks, txs, users] = await Promise.all([
        supabase.from('persons').select('id'),
        supabase.from('ip_records').select('id'),
        supabase.from('tasks').select('id'),
        supabase.from('transactions').select('id'),
        supabase.from('users').select('id')
    ]);

    const validPersonIds = new Set(persons.data?.map(p => p.id) || []);
    const validIpIds = new Set(ipRecords.data?.map(i => i.id) || []);
    const validTaskIds = new Set(tasks.data?.map(t => t.id) || []);
    const validTxIds = new Set(txs.data?.map(t => t.id) || []);
    const validUserIds = new Set(users.data?.map(u => u.id) || []);

    // 1. Şablonlar
    console.log("⏳ 'mail_templates' çekiliyor...");
    let tmplSnap = await db.collection('mail_templates').get();
    if (tmplSnap.empty) tmplSnap = await db.collection('mailTemplates').get();
    
    const tmplData = tmplSnap.docs.map(doc => ({
        id: doc.id,
        template_id: doc.data().templateId || doc.data().template_id || null,
        subject: doc.data().subject || null,
        mail_subject: doc.data().mailSubject || doc.data().mail_subject || null,
        body: doc.data().body || null,
        body1: doc.data().body1 || null,
        body2: doc.data().body2 || null,
        created_at: safeDate(doc.data().createdAt) || new Date().toISOString(),
        updated_at: safeDate(doc.data().updatedAt) || new Date().toISOString()
    }));
    await batchUpsert('mail_templates', tmplData);
    const validTemplateIds = new Set(tmplData.map(t => t.id));

    // 2. Şablon Kuralları
    console.log("\n⏳ 'template_rules' çekiliyor...");
    let rulesSnap = await db.collection('template_rules').get();
    if (rulesSnap.empty) rulesSnap = await db.collection('templateRules').get();

    const rulesData = rulesSnap.docs.map(doc => {
        const d = doc.data();
        const tId = d.templateId || d.template_id;
        return {
            id: doc.id,
            source_type: d.sourceType || d.source_type || null,
            sub_process_type: d.subProcessType || d.sub_process_type || null,
            main_process_type: d.mainProcessType || d.main_process_type || null,
            task_type: d.taskType || d.task_type || null,
            template_id: validTemplateIds.has(tId) ? tId : null,
            description: d.description || null,
            created_at: safeDate(d.createdAt) || new Date().toISOString()
        };
    });
    await batchUpsert('template_rules', rulesData);

    // 3. Bildirimler
    console.log("\n⏳ 'mail_notifications' çekiliyor...");
    let notifSnap = await db.collection('mail_notifications').get();
    if (notifSnap.empty) notifSnap = await db.collection('mailNotifications').get();

    const notifData = notifSnap.docs.map(doc => {
        const d = doc.data();
        return {
            id: doc.id,
            status: d.status || null,
            mode: d.mode || null,
            is_draft: d.isDraft !== false,
            subject: d.subject || null,
            body: d.body || null,
            to_list: safeArray(d.toList || d.to_list),
            cc_list: safeArray(d.ccList || d.cc_list),
            missing_fields: safeArray(d.missingFields || d.missing_fields),
            notification_type: d.notificationType || d.notification_type || null,
            source: d.source || null,
            objection_deadline: d.objectionDeadline || null,
            client_id: validPersonIds.has(d.clientId) ? d.clientId : null,
            related_ip_record_id: validIpIds.has(d.relatedIpRecordId) ? d.relatedIpRecordId : null,
            associated_task_id: validTaskIds.has(d.associatedTaskId) ? d.associatedTaskId : null,
            associated_transaction_id: validTxIds.has(d.associatedTransactionId) ? d.associatedTransactionId : null,
            template_id: validTemplateIds.has(d.templateId || d.template_id) ? (d.templateId || d.template_id) : null,
            assigned_to_uid: validUserIds.has(d.assignedToUid) ? d.assignedToUid : null,
            source_document_id: d.sourceDocumentId || d.source_document_id || null,
            dynamic_parent_context: d.dynamicParentContext || null,
            gmail_message_id: d.gmailMessageId || null,
            gmail_thread_id: d.gmailThreadId || null,
            message_id: d.messageId || null,
            provider: d.provider || null,
            sent_by: validUserIds.has(d.sentBy) ? d.sentBy : null,
            sent_at: safeDate(d.sentAt || d.sent_at),
            last_reminder_at: safeDate(d.lastReminderAt || d.last_reminder_at),
            last_reminder_by: d.lastReminderBy || null,
            created_at: safeDate(d.createdAt) || new Date().toISOString()
        };
    });
    await batchUpsert('mail_notifications', notifData);

    // 4. Ekler
    console.log("\n⏳ Ekler çekiliyor...");
    let attachSnap = await db.collection('mail_notification_attachments').get();
    if (attachSnap.empty) attachSnap = await db.collection('mailNotificationAttachments').get();

    const attachData = attachSnap.docs.map(doc => {
        const d = doc.data();
        return {
            notification_id: d.notificationId || d.notification_id || null,
            file_name: d.fileName || d.file_name || 'Ek_Belgesi',
            storage_path: d.storagePath || d.storage_path || null,
            url: d.url || d.downloadURL || d.fileUrl || null
        };
    }); 
    await batchInsertNoId('mail_attachments', attachData);

    // 5. Threads & Messages
    console.log("\n⏳ 'mailThreads' çekiliyor...");
    let threadsSnap = await db.collection('mailThreads').get();
    if (threadsSnap.empty) threadsSnap = await db.collection('mail_threads').get();

    const threadsData = threadsSnap.docs.map(doc => {
        const d = doc.data();
        return {
            id: doc.id,
            thread_id: d.threadId || d.thread_id || null,
            ip_record_id: validIpIds.has(d.ipRecordId || d.ip_record_id) ? (d.ipRecordId || d.ip_record_id) : null,
            parent_context: d.parentContext || d.parent_context || null,
            last_triggering_task_id: validTaskIds.has(d.lastTriggeringTaskId) ? d.lastTriggeringTaskId : null,
            last_triggering_child_type: d.lastTriggeringChildType || null,
            first_message_id: d.firstMessageId || null,
            last_message_id: d.lastMessageId || null,
            root_subject: d.rootSubject || null,
            last_updated: safeDate(d.lastUpdated) || new Date().toISOString()
        };
    });
    await batchUpsert('mail_threads', threadsData);
    const validThreadIds = new Set(threadsData.map(t => t.id));

    console.log("\n⏳ 'mailMessages' çekiliyor...");
    let msgSnap = await db.collection('mailMessages').get();
    if (msgSnap.empty) msgSnap = await db.collection('mail_messages').get();

    const msgData = msgSnap.docs.map(doc => {
        const d = doc.data();
        const tId = d.threadId || d.thread_id;
        return {
            thread_id: validThreadIds.has(tId) ? tId : null,
            cc_emails: safeArray(d.ccEmails || d.cc_emails),
            to_emails: safeArray(d.toEmails || d.to_emails),
            from_email: d.fromEmail || d.from_email || null,
            body: d.body || d.content || null,
            subject: d.subject || null,
            gmail_id: d.gmailId || null,
            message_id: d.messageId || null,
            status: d.status || null,
            sent_at: safeDate(d.sentAt || d.sent_at),
            created_at: safeDate(d.createdAt) || new Date().toISOString()
        };
    }); 
    await batchInsertNoId('mail_messages', msgData);

// 6. Settings & Queue
    console.log("\n⏳ Ayarlar ve Kuyruk çekiliyor...");
    
    // BURAYA BÜYÜK "CC" İHTİMALİNİ EKLEDİK!
    let ccSnap = await db.collection('evrekaMailCCList').get(); 
    if (ccSnap.empty) ccSnap = await db.collection('evrekaMailCcList').get();
    if (ccSnap.empty) ccSnap = await db.collection('evreka_mail_cc_list').get();

    const ccData = ccSnap.docs.map(doc => ({
        id: doc.id,
        name: doc.data().name || null,
        email: doc.data().email || null,
        transaction_types: safeArray(doc.data().transactionTypes || doc.data().transaction_types)
    }));
    await batchUpsert('evreka_mail_cc_list', ccData);

    let settingsSnap = await db.collection('evrekaMailSettings').get();
    if (settingsSnap.empty) settingsSnap = await db.collection('evreka_mail_settings').get();
    const settingsData = settingsSnap.docs.map(doc => ({
        id: doc.id,
        cc_emails: doc.data().ccEmails || doc.data().cc_emails || [],
        updated_at: safeDate(doc.data().updatedAt) || new Date().toISOString()
    }));
    await batchUpsert('evreka_mail_settings', settingsData);

    console.log("\n🎉 GÖÇ OPERASYONU TAMAMLANDI! 🚀");
}

migrateStep9().catch(console.error);