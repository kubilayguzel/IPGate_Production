import { supabase } from '../../supabase-config.js';

export class TaskManager {
    async getTasks(clientIds, clientIpRecordIds = []) {
        if (!clientIds || clientIds.length === 0) return [];

        try {
            const allTasks = [];
            
            // 1. Görev Sahibine Göre Çek
            const { data: tasksByOwner, error: ownerError } = await supabase.from('tasks').select('*').in('task_owner_id', clientIds);
            if (ownerError) throw ownerError;
            if (tasksByOwner) allTasks.push(...tasksByOwner);
            
            // 2. Marka ID'lerine Göre Çek
            if (clientIpRecordIds.length > 0) {
                const chunkSize = 150; 
                for (let i = 0; i < clientIpRecordIds.length; i += chunkSize) {
                    const chunk = clientIpRecordIds.slice(i, i + chunkSize);
                    const { data: tasksByIp, error: ipError } = await supabase.from('tasks').select('*').in('ip_record_id', chunk);
                    if (ipError) throw ipError;
                    if (tasksByIp) allTasks.push(...tasksByIp);
                }
            }
            
            // 3. Tekrar edenleri temizle
            const uniqueTasksMap = new Map();
            allTasks.forEach(t => uniqueTasksMap.set(t.id, t));
            const uniqueTasks = Array.from(uniqueTasksMap.values());
            
            if (uniqueTasks.length === 0) return [];

            const taskIpIds = [...new Set(uniqueTasks.map(t => t.ip_record_id).filter(Boolean))];
            const taskTypeIds = [...new Set(uniqueTasks.map(t => t.task_type_id).filter(Boolean))];

            const promises = [];
            
            if (taskIpIds.length > 0) {
                promises.push(supabase.from('ip_records').select('id, application_number').in('id', taskIpIds));
                promises.push(supabase.from('ip_record_trademark_details').select('ip_record_id, brand_name, brand_image_url').in('ip_record_id', taskIpIds));
            } else {
                promises.push(Promise.resolve({ data: [] }), Promise.resolve({ data: [] }));
            }
            
            if (taskTypeIds.length > 0) {
                promises.push(supabase.from('transaction_types').select('id, name, alias').in('id', taskTypeIds));
            } else {
                promises.push(Promise.resolve({ data: [] }));
            }

            const [ipRecordsRes, tmDetailsRes, txTypesRes] = await Promise.all(promises);

            const ipMap = new Map();
            const appNosForBulletin = new Set(); 

            // ADIM 1 ve 2: ip_record_id ile ip_records tablosundan application_number'ı bulup topluyoruz
            (ipRecordsRes.data || []).forEach(ip => {
                ipMap.set(ip.id, { appNo: ip.application_number });
                if (ip.application_number) {
                    appNosForBulletin.add(String(ip.application_number).trim()); 
                }
            });

            (tmDetailsRes.data || []).forEach(tm => {
                if (ipMap.has(tm.ip_record_id)) {
                    ipMap.get(tm.ip_record_id).brandName = tm.brand_name;
                    ipMap.get(tm.ip_record_id).brandImageUrl = tm.brand_image_url;
                }
            });

            const txTypesMap = new Map();
            (txTypesRes.data || []).forEach(t => txTypesMap.set(String(t.id), t));

            // ADIM 3: Topladığımız başvuru numaralarıyla bülten tablosuna (trademark_bulletin_records) gidiyoruz
            const bulletinMap = new Map();
            const appNosArray = Array.from(appNosForBulletin);
            
            if (appNosArray.length > 0) {
                const { data: bulletinData } = await supabase.from('trademark_bulletin_records')
                    .select('application_number, brand_name, image_url, holders, nice_classes, application_date, bulletin_id')
                    .in('application_number', appNosArray);
                
                (bulletinData || []).forEach(b => {
                    if (b.application_number) bulletinMap.set(String(b.application_number).trim(), b);
                });
            }

            return uniqueTasks.map(task => {
                const ipRecord = ipMap.get(task.ip_record_id) || {};
                const typeObj = txTypesMap.get(String(task.task_type_id)) || {};
                
                let parsedDetails = {};
                try {
                    parsedDetails = typeof task.details === 'string' ? JSON.parse(task.details) : (task.details || {});
                } catch(e) { parsedDetails = {}; }

                // SONUÇ: ip_record'un application_number'ı ile bültendeki eşleşmeyi bul ve details içine yaz!
                const targetAppNo = ipRecord.appNo ? String(ipRecord.appNo).trim() : null;
                const competitorData = targetAppNo ? bulletinMap.get(targetAppNo) : null;

                if (competitorData) {
                    parsedDetails.targetAppNo = competitorData.application_number;
                    parsedDetails.competitorBrandImage = competitorData.image_url;
                    parsedDetails.objectionTarget = competitorData.brand_name;
                    parsedDetails.competitorAppDate = competitorData.application_date;
                    parsedDetails.bulletinNo = competitorData.bulletin_id;
                    
                    if (competitorData.nice_classes) {
                        parsedDetails.competitorClasses = Array.isArray(competitorData.nice_classes) ? competitorData.nice_classes.join(', ') : competitorData.nice_classes;
                    }
                    
                    if (competitorData.holders) {
                        try {
                            let hArr = typeof competitorData.holders === 'string' ? JSON.parse(competitorData.holders) : competitorData.holders;
                            if (typeof hArr === 'string') hArr = JSON.parse(hArr); 
                            if (Array.isArray(hArr) && hArr.length > 0) {
                                // Sizin DB formatınıza tam uygun: { "name": "FARUK..." }
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
                    relatedIpRecordId: task.ip_record_id,
                    appNo: ipRecord.appNo || '-',
                    recordTitle: ipRecord.brandName || '-',
                    brandImageUrl: ipRecord.brandImageUrl || '',
                    clientId: task.task_owner_id,
                    details: parsedDetails, // Bülten verileriyle dopdolu JSON!
                    _relatedClientIds: [task.task_owner_id, ...clientIds].filter(Boolean)
                };
            }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        } catch (error) {
            console.error("Görevler çekilirken hata:", error);
            return [];
        }
    }
}