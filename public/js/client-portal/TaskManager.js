// public/js/client-portal/TaskManager.js
import { supabase } from '../../supabase-config.js';

export class TaskManager {
    async getTasks(clientIds, clientIpRecordIds = []) {
        if (!clientIds || clientIds.length === 0) return [];

        try {
            const allTasks = [];
            
            // 1. Görev Sahibine (task_owner_id) Göre Çek
            const { data: tasksByOwner, error: ownerError } = await supabase
                .from('tasks')
                .select('*')
                .in('task_owner_id', clientIds);
                
            if (ownerError) throw ownerError;
            if (tasksByOwner) allTasks.push(...tasksByOwner);
            
            // 2. Marka ID'lerine (ip_record_id) Göre Çek (Parçalı / Chunked - URL Too Long hatasını önler)
            if (clientIpRecordIds.length > 0) {
                const chunkSize = 150; 
                for (let i = 0; i < clientIpRecordIds.length; i += chunkSize) {
                    const chunk = clientIpRecordIds.slice(i, i + chunkSize);
                    const { data: tasksByIp, error: ipError } = await supabase
                        .from('tasks')
                        .select('*')
                        .in('ip_record_id', chunk);
                        
                    if (ipError) throw ipError;
                    if (tasksByIp) allTasks.push(...tasksByIp);
                }
            }
            
            // 3. Tekrar eden (Deduplicate) kayıtları temizle
            const uniqueTasksMap = new Map();
            allTasks.forEach(t => uniqueTasksMap.set(t.id, t));
            const uniqueTasks = Array.from(uniqueTasksMap.values());
            
            if (uniqueTasks.length === 0) return [];

            // 4. Bağlantılı Tabloları (Foreign Key Olmadan) Manuel Çek ve Eşleştir
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

            // Marka Haritasını Oluştur
            const ipMap = new Map();
            (ipRecordsRes.data || []).forEach(ip => ipMap.set(ip.id, { appNo: ip.application_number }));
            (tmDetailsRes.data || []).forEach(tm => {
                if (ipMap.has(tm.ip_record_id)) {
                    ipMap.get(tm.ip_record_id).brandName = tm.brand_name;
                    ipMap.get(tm.ip_record_id).brandImageUrl = tm.brand_image_url;
                }
            });

            // İşlem Tipi Haritasını Oluştur
            const txTypesMap = new Map();
            (txTypesRes.data || []).forEach(t => txTypesMap.set(String(t.id), t));

            // 5. Arayüzün (UI) beklediği son formata dönüştür
            return uniqueTasks.map(task => {
                const ipRecord = ipMap.get(task.ip_record_id) || {};
                const typeObj = txTypesMap.get(String(task.task_type_id)) || {};

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
                    details: typeof task.details === 'string' ? JSON.parse(task.details) : (task.details || {}),
                    _relatedClientIds: [task.task_owner_id, ...clientIds].filter(Boolean)
                };
            }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        } catch (error) {
            console.error("Görevler çekilirken hata:", error);
            return [];
        }
    }
}