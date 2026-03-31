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

            const taskTypeIds = [...new Set(uniqueTasks.map(t => t.task_type_id).filter(Boolean))];
            const taskIpIds = [...new Set(uniqueTasks.map(t => t.ip_record_id).filter(Boolean))];
            
            // Sadece Bülten İzleme Görevlerini (Tip: 20) Ayırıyoruz
            const bulletinTaskIds = uniqueTasks.filter(t => String(t.task_type_id) === '20').map(t => t.id);

            // 1. Temel IP Verilerini Çek (Standart / Diğer görevler için)
            const promises = [];
            if (taskIpIds.length > 0) {
                promises.push(supabase.from('ip_records').select('id, application_number, application_date').in('id', taskIpIds));
                promises.push(supabase.from('ip_record_trademark_details').select('ip_record_id, brand_name, brand_image_url').in('ip_record_id', taskIpIds));
                promises.push(supabase.from('ip_record_applicants').select('ip_record_id, person_id').in('ip_record_id', taskIpIds).eq('order_index', 0));
                promises.push(supabase.from('ip_record_classes').select('ip_record_id, class_no').in('ip_record_id', taskIpIds));
            } else {
                promises.push(Promise.resolve({data:[]}), Promise.resolve({data:[]}), Promise.resolve({data:[]}), Promise.resolve({data:[]}));
            }
            
            if (taskTypeIds.length > 0) promises.push(supabase.from('transaction_types').select('id, name, alias').in('id', taskTypeIds));
            else promises.push(Promise.resolve({data:[]}));

            // 2. 🔥 MÜKEMMEL DOKUNUŞ: Bülten Görevleri İçin SQL View'i Çağırıyoruz!
            if (bulletinTaskIds.length > 0) promises.push(supabase.from('v_client_bulletin_matches').select('*').in('task_id', bulletinTaskIds));
            else promises.push(Promise.resolve({data:[]}));

            const [ipRecordsRes, tmDetailsRes, applicantsRes, classesRes, txTypesRes, bulletinMatchesRes] = await Promise.all(promises);

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

            const ipMap = new Map(); 
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

            // View'dan gelen eşleşmeleri kolay erişim için map'e al (Task ID -> View Datası)
            const bulletinMatchesMap = new Map();
            (bulletinMatchesRes.data || []).forEach(b => bulletinMatchesMap.set(b.task_id, b));

            // ==========================================
            // 🔥 BİLGİLERİ ARAYÜZ İÇİN HAZIRLAMA VE GÜVENLİK FİLTRESİ
            // ==========================================
            const mappedTasks = uniqueTasks.map(task => {
                let parsedDetails = {};
                try { parsedDetails = typeof task.details === 'string' ? JSON.parse(task.details) : (task.details || {}); } catch(e) {}

                const typeObj = txTypesMap.get(String(task.task_type_id)) || {};
                const isBulletinTask = String(task.task_type_id) === '20';
                const bulletinData = bulletinMatchesMap.get(task.id);

                // Eğer bu bir bülten göreviyse ve View'dan data GELDİYSE (Yani Güvenlikten Geçtiyse!)
                if (isBulletinTask && bulletinData) {
                    
                    // Rakip Bilgilerini (Sağ Taraf) Arayüz için JSON'a yerleştir
                    parsedDetails.targetAppNo = bulletinData.competitor_app_no;
                    parsedDetails.competitorBrandImage = bulletinData.competitor_image_url;
                    parsedDetails.objectionTarget = bulletinData.competitor_brand_name;
                    parsedDetails.competitorAppDate = bulletinData.competitor_app_date;
                    parsedDetails.competitorClasses = bulletinData.competitor_classes ? (Array.isArray(bulletinData.competitor_classes) ? bulletinData.competitor_classes.join(', ') : bulletinData.competitor_classes) : '-';
                    
                    try {
                        let hArr = typeof bulletinData.competitor_holders === 'string' ? JSON.parse(bulletinData.competitor_holders) : bulletinData.competitor_holders;
                        if (typeof hArr === 'string') hArr = JSON.parse(hArr); 
                        if (Array.isArray(hArr) && hArr.length > 0) {
                            parsedDetails.competitorOwner = hArr.map(h => h.name || h.holderName).filter(Boolean).join(', ');
                        }
                    } catch(e) {}

                    // SQL'den gelen Başarı Şansı ve Notları yerleştir
                    parsedDetails.success_chance = bulletinData.success_chance;
                    parsedDetails.note = bulletinData.note;

                    return {
                        id: String(task.id),
                        title: task.title || '-',
                        taskType: String(task.task_type_id),
                        taskTypeDisplay: typeObj.alias || typeObj.name || 'İşlem',
                        status: task.status,
                        dueDate: task.operational_due_date || task.official_due_date,
                        officialDueDate: task.official_due_date,
                        createdAt: task.created_at,
                        
                        // 🔥 Sol Taraf (Bizim Markamız) -> View'dan SQL'in bulduğu kusursuz veriler
                        relatedIpRecordId: bulletinData.my_ip_record_id, 
                        appNo: bulletinData.my_app_no || '-',
                        appDate: bulletinData.my_app_date || '-',
                        recordTitle: bulletinData.my_brand_name || '-',
                        brandImageUrl: bulletinData.my_image_url || '',
                        applicantName: bulletinData.my_applicant_name || '-',
                        niceClasses: bulletinData.my_nice_classes || '-',
                        
                        clientId: task.task_owner_id,
                        details: parsedDetails, 
                        _relatedClientIds: [task.task_owner_id, ...clientIds].filter(Boolean)
                    };
                } 
                
                // Standart / Diğer Görevler
                const ipRecord = ipMap.get(task.ip_record_id) || {};
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
                    appDate: ipRecord.appDate || '-',
                    recordTitle: ipRecord.brandName || '-',
                    brandImageUrl: ipRecord.brandImageUrl || '',
                    applicantName: ipRecord.applicantName || '-',
                    niceClasses: ipRecord.niceClasses || '-',
                    clientId: task.task_owner_id,
                    details: parsedDetails,
                    _relatedClientIds: [task.task_owner_id, ...clientIds].filter(Boolean)
                };
            });

            // 🔥 ÇOK KRİTİK GÜVENLİK FİLTRESİ
            // Eğer görev 20 (Bülten) ise ancak SQL View'dan bize veri dönmediyse 
            // (yani başkasına aitse veya verisi bozuksa) MÜŞTERİNİN EKRANINDAN SİL!
            return mappedTasks.filter(t => {
                if (t.taskType === '20') {
                    return bulletinMatchesMap.has(t.id);
                }
                return true;
            }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        } catch (error) {
            console.error("Görevler çekilirken hata:", error);
            return [];
        }
    }
}