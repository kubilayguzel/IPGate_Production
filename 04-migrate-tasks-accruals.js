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

const parseAmount = (obj) => {
    if (!obj) return 0;
    if (typeof obj === 'number') return obj;
    if (obj.amount) return parseFloat(obj.amount) || 0;
    return parseFloat(obj) || 0;
};

const parseCurrency = (obj, defaultCurr = 'TRY') => {
    if (!obj) return defaultCurr;
    if (typeof obj === 'string') return defaultCurr; 
    if (obj.currency) return obj.currency;
    return defaultCurr;
};

const parseCurrencyArray = (obj) => {
    if (!obj) return [];
    if (Array.isArray(obj)) {
        return obj.map(item => ({
            amount: parseFloat(item.amount) || 0,
            currency: item.currency || 'TRY'
        }));
    }
    if (typeof obj === 'number') return [{ amount: obj, currency: 'TRY' }];
    if (obj.amount !== undefined) return [{ amount: parseFloat(obj.amount) || 0, currency: obj.currency || 'TRY' }];
    return [];
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

async function migrateStep4() {
    console.log("🚀 ADIM 4: Görevler (Tasks) ve Tahakkuklar (Accruals) Taşınıyor...\n");

    const [users, persons, ipRecords, transactions] = await Promise.all([
        supabase.from('users').select('id'),
        supabase.from('persons').select('id'),
        supabase.from('ip_records').select('id'),
        supabase.from('transactions').select('id')
    ]);

    const validUserIds = new Set(users.data?.map(u => u.id) || []);
    const validPersonIds = new Set(persons.data?.map(p => p.id) || []);
    const validIpIds = new Set(ipRecords.data?.map(i => i.id) || []);
    const validTxIds = new Set(transactions.data?.map(t => t.id) || []);

    // 1. GÖREVLER (TASKS)
    console.log("\n⏳ 'tasks' koleksiyonu Firestore'dan çekiliyor...");
    const tasksSnap = await db.collection('tasks').get();

    const tasksData = [];
    const taskHistoryData = [];
    const taskDocumentsData = [];
    const createdTaskIds = new Set(); 

    tasksSnap.docs.forEach(doc => {
        const d = doc.data();
        const taskId = doc.id;
        createdTaskIds.add(taskId);

        const ipRecordId = (d.relatedIpRecordId || d.relatedRecordId);
        const finalIpRecordId = validIpIds.has(ipRecordId) ? ipRecordId : null;
        const txId = validTxIds.has(d.transactionId) ? d.transactionId : null;
        
        let ownerId = null;
        let ownerArray = [];
        if (Array.isArray(d.taskOwner) && d.taskOwner.length > 0) { ownerId = d.taskOwner[0]; ownerArray = d.taskOwner; } 
        else if (typeof d.taskOwner === 'string') { ownerId = d.taskOwner; ownerArray = [d.taskOwner]; } 
        else if (d.clientId) { ownerId = d.clientId; }

        const detailsObj = d.details || {};
        if (ownerArray.length > 1) detailsObj.task_owners_array = ownerArray; 
        if (d.triggeringTransactionType) detailsObj.triggering_transaction_type = d.triggeringTransactionType;
        if (d.backupData) detailsObj.backupData = d.backupData;
        if (d.opponent) detailsObj.opponent = d.opponent;
        if (d.similarityScore) detailsObj.similarityScore = d.similarityScore;
        if (d.targetAppNo) detailsObj.targetAppNo = d.targetAppNo;
        if (d.bulletinNo) detailsObj.bulletinNo = d.bulletinNo;
        if (d.bulletinDate) detailsObj.bulletinDate = d.bulletinDate;
        
        // 🔥 YENİ EKLENEN KISIM: relatedTaskId'yi details içine alıyoruz
        if (d.relatedTaskId) detailsObj.relatedTaskId = d.relatedTaskId;
        
        // (Opsiyonel) Eski veriden kaybetmek istemediğiniz diğer başlıkları da buraya ekleyebilirsiniz:
        if (d.iprecordApplicationNo) detailsObj.iprecordApplicationNo = d.iprecordApplicationNo;

        tasksData.push({
            id: taskId,
            title: d.title || 'İsimsiz Görev',
            description: d.description || null,
            task_type_id: d.taskType || null,
            status: d.status || 'open',
            priority: d.priority || 'medium',
            ip_record_id: finalIpRecordId,
            transaction_id: txId,
            task_owner_id: validPersonIds.has(ownerId) ? ownerId : null,
            created_by: d.createdByUid || null,
            assigned_to: validUserIds.has(d.assignedToUid || d.assignedTo_uid) ? (d.assignedToUid || d.assignedTo_uid) : null,
            delivery_date: safeDate(d.deliveryDate),
            official_due_date: safeDate(d.officialDueDate),
            operational_due_date: safeDate(d.operationalDueDate) || safeDate(d.dueDate),
            details: detailsObj,
            created_at: safeDate(d.createdAt) || new Date().toISOString(),
            updated_at: safeDate(d.updatedAt) || new Date().toISOString()
        });

        if (Array.isArray(d.history)) {
            d.history.forEach(h => {
                taskHistoryData.push({
                    task_id: taskId,
                    action: h.action || h.status || 'system_update',
                    user_id: validUserIds.has(h.userId || h.uid) ? (h.userId || h.uid) : null,
                    details: h.details || {},
                    created_at: safeDate(h.timestamp || h.createdAt) || new Date().toISOString()
                });
            });
        }

        if (Array.isArray(d.documents)) {
            d.documents.forEach(docItem => {
                const docUrl = docItem.url || docItem.downloadURL || docItem.fileUrl;
                if (docUrl) {
                    taskDocumentsData.push({
                        task_id: taskId,
                        document_name: docItem.name || docItem.fileName || 'İsimsiz Belge',
                        document_url: docUrl,
                        document_type: docItem.type || 'document',
                        uploaded_at: safeDate(docItem.uploadedAt) || new Date().toISOString()
                    });
                }
            });
        }
    });

    console.log("\n⏳ 'tasks' tablosu ve alt tabloları yazılıyor...");
    await batchUpsert('tasks', tasksData);
    await batchInsertNoId('task_history', taskHistoryData);
    await batchInsertNoId('task_documents', taskDocumentsData);

    // 2. TAHAKKUKLAR (ACCRUALS)
    console.log("\n⏳ 'accruals' koleksiyonu Firestore'dan çekiliyor...");
    const accrualsSnap = await db.collection('accruals').get();

    const accrualsData = [];
    const accrualDocsData = [];

    accrualsSnap.docs.forEach(doc => {
        const a = doc.data();
        const accId = doc.id;

        const finalTaskId = createdTaskIds.has(a.taskId || a.task_id) ? (a.taskId || a.task_id) : null;

        let tpParty = null;
        if (a.tpInvoiceParty && a.tpInvoiceParty.id) tpParty = a.tpInvoiceParty.id;
        else tpParty = a.tpInvoicePartyId || a.tp_invoice_party_id;

        let srvParty = null;
        if (a.serviceInvoiceParty && a.serviceInvoiceParty.id) srvParty = a.serviceInvoiceParty.id;
        else srvParty = a.serviceInvoicePartyId || a.service_invoice_party_id;

        const creatorUid = a.createdBy_uid || a.createdByUid || a.created_by_uid;
        const accType = a.type || a.accrualType || a.accrual_type || null;

        accrualsData.push({
            id: accId,
            task_id: finalTaskId,
            status: a.status || 'unpaid',
            accrual_type: accType,
            payment_date: safeDate(a.paymentDate),
            evreka_invoice_no: a.evrekaInvoiceNo || a.evreka_invoice_no || null,
            tpe_invoice_no: a.tpeInvoiceNo || a.tpe_invoice_no || null,
            
            tp_invoice_party_id: validPersonIds.has(tpParty) ? tpParty : null,
            service_invoice_party_id: validPersonIds.has(srvParty) ? srvParty : null,
            created_by_uid: creatorUid || null,

            official_fee_amount: parseAmount(a.officialFee || a.official_fee),
            official_fee_currency: parseCurrency(a.officialFee || a.official_fee, 'TRY'),
            
            service_fee_amount: parseAmount(a.serviceFee || a.service_fee),
            service_fee_currency: parseCurrency(a.serviceFee || a.service_fee, 'TRY'),
            
            total_amount: parseCurrencyArray(a.totalAmount || a.total_amount),
            remaining_amount: parseCurrencyArray(a.remainingAmount || a.remaining_amount),

            vat_rate: parseFloat(a.vatRate || a.vat_rate) || 0,
            apply_vat_to_official_fee: a.applyVatToOfficialFee === true || a.apply_vat_to_official_fee === true,
            is_foreign_transaction: a.isForeignTransaction === true || a.is_foreign_transaction === true,
            
            // 🔥 details objesi buradan tamamen kaldırıldı!

            created_at: safeDate(a.createdAt) || new Date().toISOString(),
            updated_at: safeDate(a.updatedAt) || new Date().toISOString()
        });

        if (Array.isArray(a.files)) {
            a.files.forEach(f => {
                const fUrl = f.url || f.downloadURL || f.fileUrl;
                if (fUrl) {
                    accrualDocsData.push({
                        accrual_id: accId,
                        document_name: f.name || f.fileName || 'Fatura_Belgesi',
                        document_url: fUrl,
                        document_type: f.type || 'invoice',
                        uploaded_at: safeDate(f.uploadedAt) || new Date().toISOString()
                    });
                }
            });
        }
    });

    console.log(`\n📌 Yazılacak Veri Özeti (Finans):
    - Ana Tahakkuklar: ${accrualsData.length}
    - Tahakkuk Belgeleri: ${accrualDocsData.length}`);

    console.log("\n⏳ 'accruals' tablosu ve belgeleri yazılıyor...");
    await batchUpsert('accruals', accrualsData);
    await batchInsertNoId('accrual_documents', accrualDocsData);

    console.log("\n🎉 ADIM 4 TAMAMLANDI! Görevler ve Finans (Tahakkuk) verileri başarıyla aktarıldı.");
}

migrateStep4().catch(console.error);