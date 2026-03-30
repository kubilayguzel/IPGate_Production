import { supabase } from '../../supabase-config.js';

export class TaskManager {
    async getTasks(clientIds, clientIpRecordIds = []) {
        if (!clientIds || clientIds.length === 0) return [];

        try {
            const allTasks = [];
            
            const { data: tasksByOwner, error: ownerError } = await supabase.from('tasks').select('*').in('task_owner_id', clientIds);
            if (ownerError) throw ownerError;
            if (tasksByOwner) allTasks.push(...tasksByOwner);
            
            if (clientIpRecordIds.length > 0) {
                const chunkSize = 150; 
                for (let i = 0; i < clientIpRecordIds.length; i += chunkSize) {
                    const chunk = clientIpRecordIds.slice(i, i + chunkSize);
                    const { data: tasksByIp, error: ipError } = await supabase.from('tasks').select('*').in('ip_record_id', chunk);
                    if (ipError) throw ipError;
                    if (tasksByIp) allTasks.push(...tasksByIp);
                }
            }
            
            const uniqueTasksMap = new Map();
            allTasks.forEach(t => uniqueTasksMap.set(t.id, t));
            const uniqueTasks = Array.from(uniqueTasksMap.values());
            
            if (uniqueTasks.length === 0) return [];

            const taskIpIds = [...new Set(uniqueTasks.map(t => t.ip_record_id).filter(Boolean))];
            const taskTypeIds = [...new Set(uniqueTasks.map(t => t.task_type_id).filter(Boolean))];

            // ==========================================
            // 🔥 ADIM 1: task_ip_record_id -> ip_records (Rakip başvuru no'yu bul)
            // ==========================================
            let initialIpRecords = [];
            if (taskIpIds.length > 0) {
                const { data } = await supabase.from('ip_records').select('id, application_number').in('id', taskIpIds);
                if (data) initialIpRecords = data;
            }
            
            const initialIpMap = new Map(); // task.ip_record_id -> rakip_basvuru_no
            const opponentAppNos = [];
            initialIpRecords.forEach(r => {
                if (r.application_number) {
                    const cleanNo = String(r.application_number).trim();
                    initialIpMap.set(r.id, cleanNo);
                    opponentAppNos.push(cleanNo);
                }
            });

            // ==========================================
            // 🔥 ADIM 2: Rakip Başvuru No -> trademark_bulletin_records (Bülten ID ve Rakip Verileri)
            // ==========================================
            let bulletinRecords = [];
            if (opponentAppNos.length > 0) {
                const { data } = await supabase.from('trademark_bulletin_records')
                    .select('id, application_number, brand_name, image_url, holders, nice_classes, application_date, bulletin_id')
                    .in('application_number', [...new Set(opponentAppNos)]);
                if (data) bulletinRecords = data;
            }

            const bulletinAppNoMap = new Map(); // app_no -> bulletin record (Sağ Taraf İçin)
            const bulletinIds = [];
            bulletinRecords.forEach(b => {
                const appNo = String(b.application_number).trim();
                bulletinAppNoMap.set(appNo, b);
                bulletinIds.push(b.id);
            });

            // ==========================================
            // 🔥 ADIM 3: Bülten ID -> monitoring_trademark_records (monitored_trademark_id bul)
            // ==========================================
            let monitoringRecords = [];
            if (bulletinIds.length > 0) {
                const { data } = await supabase.from('monitoring_trademark_records')
                    .select('monitored_trademark_id, bulletin_record_id')
                    .in('bulletin_record_id', [...new Set(bulletinIds)]);
                if (data) monitoringRecords = data;
            }

            const bullIdToMonitoredTmIdMap = new Map();
            const monitoredTmIds = [];
            monitoringRecords.forEach(m => {
                if (m.bulletin_record_id && m.monitored_trademark_id) {
                    bullIdToMonitoredTmIdMap.set(m.bulletin_record_id, m.monitored_trademark_id);
                    monitoredTmIds.push(m.monitored_trademark_id);
                }
            });

            // ==========================================
            // 🔥 ADIM 4: monitored_trademark_id -> monitoring_trademarks (ASIL BİZİM ip_record_id'miz)
            // ==========================================
            let monitoringTms = [];
            if (monitoredTmIds.length > 0) {
                const { data } = await supabase.from('monitoring_trademarks')
                    .select('id, ip_record_id')
                    .in('id', [...new Set(monitoredTmIds)]);
                if (data) monitoringTms = data;
            }

            const monitoredTmIdToOurIpIdMap = new Map();
            const ourTrueIpIds = new Set();
            monitoringTms.forEach(mt => {
                if (mt.ip_record_id) {
                    monitoredTmIdToOurIpIdMap.set(mt.id, mt.ip_record_id);
                    ourTrueIpIds.add(mt.ip_record_id);
                }
            });

            // ==========================================
            // 🔥 ADIM 5: Tüm Gerçek Markalarımızın Detaylarını Çek (Sol Taraf İçin)
            // ==========================================
            const allIpIdsToFetch = Array.from(new Set([...taskIpIds, ...Array.from(ourTrueIpIds)]));

            const promises = [];
            if (allIpIdsToFetch.length > 0) {
                promises.push(supabase.from('ip_records').select('id, application_number, application_date').in('id', allIpIdsToFetch));
                promises.push(supabase.from('ip_record_trademark_details').select('ip_record_id, brand_name, brand_image_url').in('ip_record_id', allIpIdsToFetch));
                promises.push(supabase.from('ip_record_applicants').select('ip_record_id, person_id').in('ip_record_id', allIpIdsToFetch).eq('order_index', 0));
                promises.push(supabase.from('ip_record_classes').select('ip_record_id, class_no').in('ip_record_id', allIpIdsToFetch));
            } else {
                promises.push(Promise.resolve({data:[]}), Promise.resolve({data:[]}), Promise.resolve({data:[]}), Promise.resolve({data:[]}));
            }
            
            if (taskTypeIds.length > 0) promises.push(supabase.from('transaction_types').select('id, name, alias').in('id', taskTypeIds));
            else promises.push(Promise.resolve({data:[]}));

            const [ipRecordsRes, tmDetailsRes, applicantsRes, classesRes, txTypesRes] = await Promise.all(promises);

            const personIds = (applicantsRes.data || []).map(a => a.person_id).filter(Boolean);
            let personsMap = new Map();
            if (personIds.length > 0) {
                const { data: persons } = await supabase.from('persons').select('id, name').in('id', [...new Set(personIds)]);
                (persons || []).forEach(p => personsMap.set(p.id, p.name));
            }
            
            const ipApplicantMap = new Map();
            (applicantsRes.data || []).forEach(a => ipApplicantMap.set(a.ip_record_id, personsMap.get(a.person_id) || '-'));

            const ipClassMap = new Map();
            (classesRes.data || []).forEach(c => {
                if (!ipClassMap.has(c.ip_record_id)) ipClassMap.set(c.ip_record_id, []);
                ipClassMap.get(c.ip_record_id).push(c.class_no);
            });

            const ipMap = new Map(); // ID -> BİZİM VERİLERİMİZ (SOL TARAF)
            (ipRecordsRes.data || []).forEach(ip => {
                ipMap.set(ip.id, { 
                    appNo: ip.application_number, 
                    appDate: ip.application_date,
                    applicantName: ipApplicantMap.get(ip.id) || '-',
                    niceClasses: ipClassMap.has(ip.id) ? ipClassMap.get(ip.id).join(', ') : '-'
                });
            });
            (tmDetailsRes.data || []).forEach(tm => {
                if (ipMap.has(tm.ip_record_id)) {
                    ipMap.get(tm.ip_record_id).brandName = tm.brand_name;
                    ipMap.get(tm.ip_record_id).brandImageUrl = tm.brand_image_url;
                }
            });

            const txTypesMap = new Map();
            (txTypesRes.data || []).forEach(t => txTypesMap.set(String(t.id), t));

            // ==========================================
            // 🔥 BİLGİLERİ ARAYÜZ (RENDERHELPER) İÇİN HAZIRLAMA
            // ==========================================
            return uniqueTasks.map(task => {
                let parsedDetails = {};
                try { parsedDetails = typeof task.details === 'string' ? JSON.parse(task.details) : (task.details || {}); } catch(e) {}

                let actualMyIpRecordId = task.ip_record_id; 
                let competitorData = null;

                // Zinciri Yürütüp Eşleştirmeyi Yapıyoruz
                const oppAppNo = initialIpMap.get(task.ip_record_id);
                if (oppAppNo) {
                    const bullRecord = bulletinAppNoMap.get(oppAppNo);
                    if (bullRecord) {
                        competitorData = bullRecord; // Sağ Taraf (Rakip)
                        
                        const monTmId = bullIdToMonitoredTmIdMap.get(bullRecord.id);
                        if (monTmId) {
                            const trueIpId = monitoredTmIdToOurIpIdMap.get(monTmId);
                            if (trueIpId) {
                                actualMyIpRecordId = trueIpId; // Sol Taraf (Bizim Markamız)
                            }
                        }
                    }
                }

                const ipRecord = ipMap.get(actualMyIpRecordId) || {};
                const typeObj = txTypesMap.get(String(task.task_type_id)) || {};

                // Sağ Taraf Rakip Bilgilerini JSON İçine Hazırla
                if (competitorData) {
                    parsedDetails.targetAppNo = competitorData.application_number;
                    parsedDetails.competitorBrandImage = competitorData.image_url;
                    parsedDetails.objectionTarget = competitorData.brand_name;
                    parsedDetails.competitorAppDate = competitorData.application_date;
                    parsedDetails.bulletinNo = competitorData.bulletin_id || parsedDetails.bulletinNo;
                    
                    if (competitorData.nice_classes) {
                        parsedDetails.competitorClasses = Array.isArray(competitorData.nice_classes) ? competitorData.nice_classes.join(', ') : competitorData.nice_classes;
                    }
                    if (competitorData.holders) {
                        try {
                            let hArr = typeof competitorData.holders === 'string' ? JSON.parse(competitorData.holders) : competitorData.holders;
                            if (typeof hArr === 'string') hArr = JSON.parse(hArr); 
                            if (Array.isArray(hArr) && hArr.length > 0) {
                                parsedDetails.competitorOwner = hArr.map(h => h.name || h.holderName).filter(Boolean).join(', ');
                            }
                        } catch(e) {}
                    }
                }

                return {
                    id: String(task.id),
                    title: task.title || '-',
                    taskType: String(task.task_type_id),
                    taskTypeDisplay: typeObj.alias || typeObj.name || 'İşlem',
                    status: task.status,
                    dueDate: task.operational_due_date || task.official_due_date,
                    officialDueDate: task.official_due_date,
                    createdAt: task.created_at,
                    relatedIpRecordId: actualMyIpRecordId, // 🔥 SOL TARAF İÇİN GERÇEK BİZİM ID'MİZ
                    appNo: ipRecord.appNo || '-',
                    appDate: ipRecord.appDate || '-',
                    recordTitle: ipRecord.brandName || '-',
                    brandImageUrl: ipRecord.brandImageUrl || '',
                    applicantName: ipRecord.applicantName || '-',
                    niceClasses: ipRecord.niceClasses || '-',
                    clientId: task.task_owner_id,
                    details: parsedDetails, // 🔥 SAĞ TARAF İÇİN RAKİP VERİSİ
                    _relatedClientIds: [task.task_owner_id, ...clientIds].filter(Boolean)
                };
            }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        } catch (error) {
            console.error("Görevler çekilirken hata:", error);
            return [];
        }
    }
}