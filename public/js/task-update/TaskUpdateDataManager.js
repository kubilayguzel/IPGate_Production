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
    
    // 🔥 ÇÖZÜM: Dosya Yükleme (Storage) Loglu ve Güvenli Hale Getirildi
    async saveAccrual(data, isUpdate = false) {
        console.log("==================================================");
        console.log("🚀 [TASK UPDATE ACCRUAL] saveAccrual TETİKLENDİ!");
        console.log("🚀 [TASK UPDATE ACCRUAL] Formdan Gelen Ham Veri:", data);

        let uploadedFiles = [];
        
        // FormManager'dan gelen tekli PDF'i (foreignInvoiceFile) veya çoklu file listesini yakalayalım
        let filesToProcess = [];
        if (data.foreignInvoiceFile) {
            filesToProcess.push(data.foreignInvoiceFile);
        } else if (data.files && data.files.length > 0) {
            for (let i = 0; i < data.files.length; i++) {
                filesToProcess.push(data.files[i]);
            }
        }

        console.log(`🚀 [TASK UPDATE ACCRUAL] İşlenecek dosya sayısı: ${filesToProcess.length}`);

        // 1. Eğer formdan dosya geldiyse önce Storage'a yükle
        if (filesToProcess.length > 0) {
            for (let file of filesToProcess) {
                if (file) {
                    try {
                        console.log(`📦 [TASK UPDATE ACCRUAL] Dosya yükleniyor: ${file.name} (${file.size} byte)`);
                        const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                        // documents kovası altında accruals klasörü
                        const path = `accruals/${Date.now()}_${cleanFileName}`;
                        
                        const url = await this.uploadFile(file, path);
                        console.log(`✅ [TASK UPDATE ACCRUAL] Dosya başarıyla yüklendi! URL: ${url}`);
                        
                        uploadedFiles.push({
                            name: file.name,
                            url: url,
                            type: 'invoice_document' 
                        });
                    } catch (e) {
                        console.error(`❌ [TASK UPDATE ACCRUAL] Dosya yükleme DÖNGÜSÜNDE Hata:`, e);
                        throw new Error("Dosya Storage'a yüklenemedi: " + e.message);
                    }
                }
            }
        }

        // DB'ye giden nesneye formatlanmış dosyaları (url) ve Açıklamayı (description) ekle
        const dataToSave = { ...data, files: uploadedFiles };
        if (data.description) dataToSave.description = data.description; 

        console.log("🚀 [TASK UPDATE ACCRUAL] Veritabanına (AccrualService) Gidecek Son Veri:", dataToSave);

        // 2. Tahakkuku Kaydet veya Güncelle
        let result;
        if (isUpdate) {
            result = await accrualService.updateAccrual(dataToSave.id, dataToSave);
        } else {
            result = await accrualService.addAccrual(dataToSave);
        }

        console.log("✅ [TASK UPDATE ACCRUAL] Tahakkuk DB'ye eklendi/güncellendi. Sonuç:", result);

        // 3. Supabase'deki 'accrual_documents' tablosuna kayıt at
        const accrualId = isUpdate ? dataToSave.id : (result.data ? result.data.id : null);
        if (accrualId && uploadedFiles.length > 0) {
            console.log(`🚀 [TASK UPDATE ACCRUAL] ${uploadedFiles.length} adet belge accrual_documents tablosuna yazılıyor...`);
            const docsToInsert = uploadedFiles.map(f => ({
                accrual_id: String(accrualId),
                document_name: f.name,
                document_url: f.url,
                document_type: f.type
            }));
            
            const { error: docError } = await supabase.from('accrual_documents').insert(docsToInsert);
            if (docError) {
                console.error("❌ [TASK UPDATE ACCRUAL] accrual_documents tablosuna yazılamadı:", docError);
            } else {
                console.log("✅ [TASK UPDATE ACCRUAL] Belgeler accrual_documents tablosuna başarıyla yazıldı!");
            }
        }

        return result;
    }

    // 🔥 Supabase Storage - Detaylı Loglu Versiyon
    async uploadFile(file, path) {
        console.log(`📦 [STORAGE] 'documents' bucket'ına istek atılıyor. Yol: ${path}`);
        const { data, error } = await supabase.storage.from('documents').upload(path, file, { cacheControl: '3600', upsert: true });
        
        if (error) {
            console.error("❌ [STORAGE] Supabase Upload İşlemi Hata Döndürdü:", error);
            throw error;
        }
        
        console.log("✅ [STORAGE] Upload işlemi başarılı! Public URL alınıyor...");
        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(path);
        return urlData.publicUrl;
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