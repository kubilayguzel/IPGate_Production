// public/js/accrual-management/AccrualDataManager.js

import { 
    authService, taskService, personService, 
    transactionTypeService, supabase, ipRecordsService 
} from '../../supabase-config.js';

const generateUUID = () => crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).substr(2, 16);

export class AccrualDataManager {
    constructor() {
        this.allAccruals = [];
        this.allTasks = {};         
        this.allIpRecords = [];     
        this.ipRecordsMap = {};     
        this.allPersons = [];
        this.allUsers = [];
        this.allTransactionTypes = [];
        this.processedData = [];
    }

    async fetchAllData() {
        try {
            // 🔥 ÇÖZÜM 1: Belgeleri getirmek için accrual_documents(*) JOIN eklendi!
            const accPromise = supabase.from('accruals').select('*, accrual_documents(*)').limit(10000).order('created_at', { ascending: false });

            const [accRes, usersRes, typesRes, personsRes] = await Promise.all([
                accPromise,
                taskService.getAllUsers(),
                transactionTypeService.getTransactionTypes(),
                personService.getPersons() 
            ]);

            this.allPersons = personsRes?.success ? (personsRes.data || []) : [];
            this.allUsers = usersRes?.success ? (usersRes.data || []) : [];
            this.allTransactionTypes = typesRes?.success ? (typesRes.data || []).map(t => ({
                ...t, ipType: t.ip_type || t.details?.ipType || t.ipType,
                isTopLevelSelectable: t.is_top_level_selectable ?? t.details?.isTopLevelSelectable ?? t.isTopLevelSelectable
            })) : [];

            const getPersonName = (id) => {
                if (!id) return null;
                const p = this.allPersons.find(x => x.id === id);
                return p ? p.name : null;
            };

            this.allAccruals = accRes.data ? accRes.data.map(row => {
                const d = row.details || {};
                return {
                    ...d,
                    id: String(row.id),
                    taskId: row.task_id || d.taskId,
                    taskTitle: row.task_title || d.taskTitle,
                    type: row.accrual_type || row.type || d.type,
                    status: row.status || d.status,
                    createdAt: row.created_at ? new Date(row.created_at) : new Date(0),
                    updatedAt: row.updated_at || d.updatedAt,
                    isForeignTransaction: row.is_foreign_transaction ?? d.isForeignTransaction ?? false,
                    tpeInvoiceNo: row.tpe_invoice_no || d.tpeInvoiceNo,
                    evrekaInvoiceNo: row.evreka_invoice_no || d.evrekaInvoiceNo,
                    description: row.description || d.description || '', 
                    
                    // 🔥 ÇÖZÜM 2: Gelen belgeler (documents) UI'ın anladığı 'files' dizisine dönüştürülüyor
                    files: row.accrual_documents && row.accrual_documents.length > 0 
                        ? row.accrual_documents.map(doc => ({
                            id: doc.id, name: doc.document_name, url: doc.document_url, type: doc.document_type
                        })) 
                        : (row.files || d.files || []),
                    
                    officialFee: { amount: row.official_fee_amount || 0, currency: row.official_fee_currency || 'TRY' },
                    serviceFee: { amount: row.service_fee_amount || 0, currency: row.service_fee_currency || 'TRY' },
                    totalAmount: Array.isArray(row.total_amount) ? row.total_amount : (d.totalAmount || []),
                    remainingAmount: Array.isArray(row.remaining_amount) ? row.remaining_amount : (d.remainingAmount || []),
                    vatRate: row.vat_rate || d.vatRate || 20,
                    applyVatToOfficialFee: row.apply_vat_to_official_fee ?? d.applyVatToOfficialFee ?? false,
                    paymentDate: row.payment_date || d.paymentDate || null,
                    tpInvoiceParty: row.tp_invoice_party_id ? { id: row.tp_invoice_party_id, name: getPersonName(row.tp_invoice_party_id) } : d.tpInvoiceParty,
                    serviceInvoiceParty: row.service_invoice_party_id ? { id: row.service_invoice_party_id, name: getPersonName(row.service_invoice_party_id) } : d.serviceInvoiceParty,
                };
            }) : [];

            await this._fetchTasksInBatches();
            await this._fetchIpRecordsInBatches();
            this._buildSearchStrings();
            this.processedData = [...this.allAccruals];
            return true;
        } catch (error) {
            console.error("❌ Veri yükleme hatası:", error);
            throw error;
        }
    }

    async _fetchTasksInBatches() {
        const rawIds = this.allAccruals.map(a => a.taskId);
        const validIds = [...new Set(rawIds.filter(id => id && id !== 'null' && id !== 'undefined'))];
        this.allTasks = {}; 
        
        if (validIds.length === 0) return;
        const { data, error } = await supabase.from('tasks').select('*').in('id', validIds);
        if (error) throw new Error("Görevler çekilemedi: " + error.message);

        data.forEach(row => {
            const d = row.details || {};
            let epats = row.epats_document || d.epatsDocument || (d.details && d.details.epatsDocument) || null;
            if (typeof epats === 'string') { try { epats = JSON.parse(epats); } catch(e) {} }

            this.allTasks[String(row.id)] = {
                id: String(row.id),
                title: String(row.title || d.title || 'İsimsiz İş'),
                taskType: String(row.task_type_id || row.task_type || d.taskType || ''),
                relatedIpRecordId: row.ip_record_id ? String(row.ip_record_id) : null,
                assignedTo_uid: row.assigned_to ? String(row.assigned_to) : null,
                epatsDocument: epats
            };
        });
    }

    async _fetchIpRecordsInBatches() {
        const rawIds = Object.values(this.allTasks).map(t => t.relatedIpRecordId);
        const validIds = [...new Set(rawIds.filter(id => id && id !== 'null' && id !== 'undefined'))];
        this.allIpRecords = [];
        this.ipRecordsMap = {};

        if (validIds.length === 0) return;

        const [ipRes, suitRes] = await Promise.all([
            supabase.from('ip_records').select('*, ip_record_trademark_details(*)').in('id', validIds),
            supabase.from('suits').select('*').in('id', validIds)
        ]);

        const mapRecords = (rows, type) => {
            if (!rows) return;
            rows.forEach(row => {
                const tmDetails = row.ip_record_trademark_details ? row.ip_record_trademark_details[0] : {};
                const item = {
                    id: String(row.id),
                    applicationNumber: String(row.application_number || row.file_no || '-'),
                    markName: String(tmDetails?.brand_name || row.title || row.court_name || '-')
                };
                this.allIpRecords.push(item);
                this.ipRecordsMap[item.id] = item;
            });
        };

        mapRecords(ipRes.data, 'ip');
        mapRecords(suitRes.data, 'suit');
    }

    _buildSearchStrings() {
        this.allAccruals.forEach(acc => {
            let searchTerms = [
                acc.id, acc.status === 'paid' ? 'ödendi' : (acc.status === 'unpaid' ? 'ödenmedi' : 'kısmen'),
                acc.tpInvoiceParty?.name, acc.serviceInvoiceParty?.name
            ];

            const task = this.allTasks[String(acc.taskId)];
            if (task) {
                searchTerms.push(task.title); 
                const typeObj = this.allTransactionTypes.find(t => t.id === task.taskType);
                if(typeObj) searchTerms.push(typeObj.alias || typeObj.name);

                if (task.relatedIpRecordId) {
                    const ipRec = this.ipRecordsMap[task.relatedIpRecordId]; 
                    if(ipRec) searchTerms.push(ipRec.applicationNumber);
                }
            } else {
                searchTerms.push(acc.taskTitle);
            }

            acc.searchString = searchTerms.filter(Boolean).join(' ').toLowerCase();
        });
    }

    filterAndSort(criteria, sort) {
        const { tab, filters } = criteria;
        if (!this.allAccruals || this.allAccruals.length === 0) return [];

        let data = this.allAccruals;

        if (tab === 'foreign') data = data.filter(item => item.isForeignTransaction === true);

        if (filters) {
            if (filters.startDate) {
                const start = new Date(filters.startDate).getTime();
                data = data.filter(item => { const itemDate = item.createdAt ? new Date(item.createdAt).getTime() : 0; return itemDate >= start; });
            }
            if (filters.endDate) {
                const end = new Date(filters.endDate); end.setHours(23, 59, 59, 999); 
                const endTime = end.getTime();
                data = data.filter(item => { const itemDate = item.createdAt ? new Date(item.createdAt).getTime() : 0; return itemDate <= endTime; });
            }
            if (filters.status && filters.status !== 'all') {
                data = data.filter(item => item.status === filters.status);
            }
            if (filters.field) {
                const searchVal = filters.field.toLowerCase();
                data = data.filter(item => {
                    const task = this.allTasks[String(item.taskId)];
                    const typeObj = task ? this.allTransactionTypes.find(t => String(t.id) === String(task.taskType)) : null;
                    const itemField = typeObj ? (typeObj.ipType || '') : '';
                    return itemField.toLowerCase().includes(searchVal);
                });
            }
            if (filters.party) {
                const searchVal = filters.party.toLowerCase();
                data = data.filter(item => {
                    const p1 = (item.tpInvoiceParty?.name || '').toLowerCase();
                    const p2 = (item.serviceInvoiceParty?.name || '').toLowerCase();
                    return p1.includes(searchVal) || p2.includes(searchVal);
                });
            }
            if (filters.fileNo) {
                const searchVal = filters.fileNo.toLowerCase();
                data = data.filter(item => {
                    const task = this.allTasks[String(item.taskId)];
                    const ipRec = task?.relatedIpRecordId ? this.ipRecordsMap[task.relatedIpRecordId] : null;
                    return (ipRec?.applicationNumber || '').toLowerCase().includes(searchVal);
                });
            }
            if (filters.subject) {
                const searchVal = filters.subject.toLowerCase();
                data = data.filter(item => {
                    const task = this.allTasks[String(item.taskId)];
                    const ipRec = task?.relatedIpRecordId ? this.ipRecordsMap[task.relatedIpRecordId] : null;
                    return (ipRec?.markName || '').toLowerCase().includes(searchVal);
                });
            }
            if (filters.task) {
                const searchVal = filters.task.toLowerCase();
                data = data.filter(item => {
                    const task = this.allTasks[String(item.taskId)];
                    const typeObj = task ? this.allTransactionTypes.find(t => t.id === task.taskType) : null;
                    const taskName = typeObj ? (typeObj.alias || typeObj.name) : (task?.title || item.taskTitle || '');
                    return taskName.toLowerCase().includes(searchVal);
                });
            }
        }

        if (sort && sort.column) {
            data.sort((a, b) => {
                let valA = a[sort.column]; let valB = b[sort.column];
                if (sort.column === 'taskTitle') { valA = a.taskTitle || ''; valB = b.taskTitle || ''; } 
                else if (sort.column === 'subject') { valA = String(valA || ''); valB = String(valB || ''); }

                if (valA < valB) return sort.direction === 'asc' ? -1 : 1;
                if (valA > valB) return sort.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }
        return data;
    }

    async getFreshTaskDetail(taskId) {
        if (!taskId) return null;
        try {
            const { data, error } = await supabase.from('tasks').select('*').eq('id', String(taskId)).single();
            
            if (data && !error) {
                const d = data.details || {};
                let epats = data.epats_document || d.epatsDocument || (d.details && d.details.epatsDocument) || null;
                
                if (typeof epats === 'string') {
                    try { epats = JSON.parse(epats); } catch(e) {}
                }

                // 🔥 YENİ ŞEMAYA UYUMLU OLARAK EŞLEŞTİRİLDİ
                const task = { 
                    ...data, 
                    id: String(data.id),
                    taskType: String(data.task_type_id || data.task_type || d.taskType || ''),
                    relatedIpRecordId: String(data.ip_record_id || d.relatedIpRecordId || ''),
                    assignedTo_uid: String(data.assigned_to || data.assigned_to_user_id || d.assignedTo_uid || ''),
                    title: String(data.title || d.title || ''),
                    epatsDocument: epats
                };
                
                this.allTasks[String(taskId)] = task; 
                return task;
            }
            return this.allTasks[String(taskId)] || null;
        } catch (e) { return null; }
    }

    async createFreestyleAccrual(formData, fileToUpload) {
        const payload = {
            ...formData,
            files: fileToUpload ? [fileToUpload] : formData.files
        };
        const res = await accrualService.addAccrual(payload);
        if (!res.success) throw new Error(res.error);
        await this.fetchAllData(); 
    }

    async updateAccrual(accrualId, formData, fileToUpload) {
        const currentAccrual = this.allAccruals.find(a => a.id === accrualId);
        if (!currentAccrual) throw new Error("Tahakkuk bulunamadı.");

        const payload = {
            ...formData,
            files: fileToUpload ? [fileToUpload] : formData.files
        };
        const res = await accrualService.updateAccrual(accrualId, payload);
        if (!res.success) throw new Error(res.error);
        await this.fetchAllData(); 
    }

    async savePayment(selectedIds, paymentData) {
        const { date, receiptFiles, singlePaymentDetails } = paymentData;
        const ids = Array.from(selectedIds);

        const promises = ids.map(async (id) => {
            const acc = this.allAccruals.find(a => a.id === id);
            if (!acc) return;

            let updates = {};

            if (ids.length === 1 && singlePaymentDetails) {
                updates.paymentDate = date;
                const { payFullOfficial, payFullService, manualOfficial, manualService } = singlePaymentDetails;
                const vatMultiplier = 1 + ((acc.vatRate || 0) / 100);

                const offTarget = acc.applyVatToOfficialFee ? (acc.officialFee?.amount || 0) * vatMultiplier : (acc.officialFee?.amount || 0);
                const newPaidOff = payFullOfficial ? offTarget : (parseFloat(manualOfficial) || 0);

                const srvTarget = (acc.serviceFee?.amount || 0) * vatMultiplier;
                const newPaidSrv = payFullService ? srvTarget : (parseFloat(manualService) || 0);

                const remOff = Math.max(0, offTarget - newPaidOff);
                const remSrv = Math.max(0, srvTarget - newPaidSrv);

                const remMap = {};
                if (remOff > 0.01) remMap[acc.officialFee?.currency || 'TRY'] = (remMap[acc.officialFee?.currency] || 0) + remOff;
                if (remSrv > 0.01) remMap[acc.serviceFee?.currency || 'TRY'] = (remMap[acc.serviceFee?.currency] || 0) + remSrv;
                
                // 🔥 Yeni Dizi (Array) olarak kaydediyoruz
                updates.remainingAmount = Object.entries(remMap).map(([c, a]) => ({ amount: a, currency: c }));

                if (updates.remainingAmount.length === 0) updates.status = 'paid';
                else if (newPaidOff > 0 || newPaidSrv > 0) updates.status = 'partially_paid';
                else updates.status = 'unpaid';
            }
            else {
                updates.status = 'paid';
                updates.remainingAmount = [];
                updates.paymentDate = date;
            }
            return accrualService.updateAccrual(id, updates);
        });

        await Promise.all(promises);
        await this.fetchAllData();
    }

    async batchUpdateStatus(selectedIds, newStatus) {
        const ids = Array.from(selectedIds);
        const promises = ids.map(async (id) => {
            const acc = this.allAccruals.find(a => a.id === id);
            if (!acc) return;
            const updates = { status: newStatus };
            if (newStatus === 'unpaid') {
                updates.paymentDate = null;
                updates.remainingAmount = acc.totalAmount; // Array olarak geri yüklüyoruz
            }
            return accrualService.updateAccrual(id, updates);
        });

        await Promise.all(promises);
        await this.fetchAllData();
    }

    async deleteAccrual(id) {
        await supabase.from('accruals').delete().eq('id', id);
        await this.fetchAllData();
    }
}