// public/js/client-portal/InvoiceManager.js
import { supabase } from '../../supabase-config.js';

export class InvoiceManager {
    async getInvoices(clientIds) {
        if (!clientIds || clientIds.length === 0) return [];

        try {
            // 1. Faturaları Çek
            const { data: accruals, error } = await supabase
                .from('accruals')
                .select('*')
                .in('service_invoice_party_id', clientIds)
                .order('created_at', { ascending: false });

            if (error) throw error;
            if (!accruals || accruals.length === 0) return [];

            // 2. Faturalara bağlı Task ID'lerini topla ve ilişkileri manuel kur
            const taskIds = [...new Set(accruals.map(a => a.task_id).filter(Boolean))];
            
            let tasksMap = new Map();
            let ipRecordsMap = new Map();

            if (taskIds.length > 0) {
                // Taskları çek
                const { data: tasksData } = await supabase.from('tasks').select('id, title, ip_record_id').in('id', taskIds);
                
                if (tasksData) {
                    const ipIds = [...new Set(tasksData.map(t => t.ip_record_id).filter(Boolean))];
                    
                    // Marka numarası ve isimlerini çek
                    if (ipIds.length > 0) {
                        const [ipData, tmData] = await Promise.all([
                            supabase.from('ip_records').select('id, application_number').in('id', ipIds),
                            supabase.from('ip_record_trademark_details').select('ip_record_id, brand_name').in('ip_record_id', ipIds)
                        ]);

                        (ipData.data || []).forEach(ip => ipRecordsMap.set(ip.id, { appNo: ip.application_number }));
                        (tmData.data || []).forEach(tm => {
                            if (ipRecordsMap.has(tm.ip_record_id)) ipRecordsMap.get(tm.ip_record_id).brandName = tm.brand_name;
                        });
                    }

                    tasksData.forEach(t => tasksMap.set(t.id, t));
                }
            }

            // 3. UI Formatına dönüştür
            return accruals.map(acc => {
                const task = tasksMap.get(acc.task_id) || {};
                const ipRecord = ipRecordsMap.get(task.ip_record_id) || {};

                return {
                    id: acc.id,
                    invoiceNo: acc.evreka_invoice_no || acc.tpe_invoice_no || acc.id.substring(0, 8).toUpperCase(),
                    taskId: acc.task_id,
                    taskTitle: task.title || acc.accrual_type || 'Hizmet Bedeli',
                    applicationNumber: ipRecord.appNo || '-',
                    brandName: ipRecord.brandName || '-',
                    createdAt: acc.created_at,
                    status: acc.status,
                    officialFee: { amount: acc.official_fee_amount, currency: acc.official_fee_currency },
                    serviceFee: { amount: acc.service_fee_amount, currency: acc.service_fee_currency },
                    totalAmount: acc.total_amount, 
                    remainingAmount: acc.remaining_amount, 
                    serviceInvoicePartyId: acc.service_invoice_party_id
                };
            });
        } catch (error) {
            console.error("Faturalar çekilirken hata:", error);
            return [];
        }
    }
}