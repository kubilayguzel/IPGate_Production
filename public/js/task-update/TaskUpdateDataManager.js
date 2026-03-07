// public/js/task-update/TaskUpdateDataManager.js

import { taskService, ipRecordsService, personService, accrualService, transactionTypeService, supabase } from '../../supabase-config.js';

export class TaskUpdateDataManager {
    
    async loadAllInitialData() {
        const [ipRecords, persons, users, transactionTypes] = await Promise.all([
            ipRecordsService.getRecords(),
            personService.getPersons(),
            taskService.getAllUsers(),
            transactionTypeService.getTransactionTypes()
        ]);
        
        return {
            ipRecords: ipRecords.data || [],
            persons: persons.data || [],
            users: users.data || [],
            transactionTypes: transactionTypes.data || []
        };
    }

    async getTaskById(taskId) {
        const result = await taskService.getTaskById(taskId);
        if (!result.success) throw new Error(result.error);
        return result.data;
    }

    async updateTask(taskId, data) {
        return await taskService.updateTask(taskId, data);
    }

    async getAccrualsByTaskId(taskId) {
        const result = await accrualService.getAccrualsByTaskId(taskId);
        return result.success ? result.data : [];
    }
    
    // 🔥 SORUN 2 ÇÖZÜMÜ: Dosya Yükleme (Storage) ve accrual_documents Tablosuna Bağlama
    async saveAccrual(data, isUpdate = false) {
        let uploadedFiles = [];
        
        // 1. Eğer formdan dosya geldiyse önce Storage'a yükle
        if (data.files && data.files.length > 0) {
            for (let file of data.files) {
                if (file instanceof File) {
                    const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                    // documents kovası altında accruals klasörü
                    const path = `accruals/${Date.now()}_${cleanFileName}`;
                    
                    const url = await this.uploadFile(file, path);
                    uploadedFiles.push({
                        name: file.name,
                        url: url,
                        type: 'invoice_document' 
                    });
                }
            }
        }

        // DB'ye giden nesneye formatlanmış dosyaları (url) ekle
        const dataToSave = { ...data, files: uploadedFiles };

        // 2. Tahakkuku Kaydet veya Güncelle
        let result;
        if (isUpdate) {
            result = await accrualService.updateAccrual(dataToSave.id, dataToSave);
        } else {
            result = await accrualService.addAccrual(dataToSave);
        }

        // 3. Supabase'deki 'accrual_documents' tablosuna kayıt at
        const accrualId = isUpdate ? dataToSave.id : (result.data ? result.data.id : null);
        if (accrualId && uploadedFiles.length > 0) {
            const docsToInsert = uploadedFiles.map(f => ({
                accrual_id: String(accrualId),
                document_name: f.name,
                document_url: f.url,
                document_type: f.type
            }));
            const { error: docError } = await supabase.from('accrual_documents').insert(docsToInsert);
            if (docError) console.error("Accrual belgesi kaydedilemedi:", docError);
        }

        return result;
    }

    // 🔥 Firebase Storage yerine Supabase Storage
    async uploadFile(file, path) {
        // Hedef kova her zaman 'documents'
        const { error } = await supabase.storage.from('documents').upload(path, file);
        if (error) throw error;
        const { data } = supabase.storage.from('documents').getPublicUrl(path);
        return data.publicUrl;
    }

    async deleteFileFromStorage(path) {
        if (!path) return;
        let cleanPath = decodeURIComponent(path);
        if (cleanPath.startsWith('documents/')) {
            cleanPath = cleanPath.replace('documents/', '');
        }
        try {
            await supabase.storage.from('documents').remove([cleanPath]);
            console.log("Dosya Storage'dan silindi:", cleanPath);
        } catch (error) {
            console.warn("Dosya silme hatası:", error);
        }
    }

    searchIpRecords(allRecords, query) {
        if (!query || query.length < 3) return [];
        const lower = query.toLowerCase();
        return allRecords.filter(r => {
            const title = (r.title || r.brandName || r.brand_name || '').toLowerCase();
            const appNo = (r.applicationNumber || r.application_number || '').toLowerCase();
            return title.includes(lower) || appNo.includes(lower);
        });
    }

    searchPersons(allPersons, query) {
        if (!query || query.length < 2) return [];
        const lower = query.toLowerCase();
        return allPersons.filter(p => 
            (p.name || '').toLowerCase().includes(lower) || 
            (p.email || '').toLowerCase().includes(lower)
        );
    }

    async updateIpRecord(recordId, data) {
        return await ipRecordsService.updateRecord(recordId, data);
    }

    async findTransactionIdByTaskId(recordId, taskId) {
        try {
            const { data } = await supabase.from('transactions').select('id').eq('task_id', String(taskId)).maybeSingle();
            return data ? data.id : null;
        } catch (error) {
            return null;
        }
    }

    async updateTransaction(recordId, transactionId, data) {
        try {
            const { error } = await supabase.from('transactions').update(data).eq('id', transactionId);
            if (error) throw error;
            return true;
        } catch(err) {
            console.error("Transaction update error:", err);
            return false;
        }
    }
}