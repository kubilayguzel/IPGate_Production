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
    
    async saveAccrual(data, isUpdate = false) {
        if (isUpdate) {
            return await accrualService.updateAccrual(data.id, data);
        } else {
            return await accrualService.addAccrual(data);
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

    async getSuitByTaskId(taskId) {
        try {
            const { data, error } = await supabase
                .from('suits')
                .select('*, suit_parties(*)') // 🔥 YENİ: Tarafları (Davacı/Davalı) da çekiyoruz
                .eq('task_id', String(taskId))
                .maybeSingle();

            if (error) throw error;
            return data || null;
        } catch (error) {
            console.error("Dava kaydı okunamadı:", error);
            return null;
        }
    }

    async saveSuitRecord(suitData) {
        try {
            const existingSuit = await this.getSuitByTaskId(suitData.task_id);

            // Taraflar listesini (Array) ana objeden ayır
            const { suitParties, ...cleanSuitData } = suitData;

            // Gereksiz/Eski alanları temizle (Eski tabloda kalan kalıntıları veritabanına göndermiyoruz)
            ['plaintiff', 'defendant', 'opposing_party', 'opposing_counsel', 'suit_parties'].forEach(k => delete cleanSuitData[k]);
            Object.keys(cleanSuitData).forEach(key => {
                if (cleanSuitData[key] === undefined) delete cleanSuitData[key];
            });

            let currentSuitId = existingSuit?.id;

            if (currentSuitId) {
                // Mevcut davayı güncelle
                delete cleanSuitData.id;
                const { error } = await supabase.from('suits').update(cleanSuitData).eq('id', currentSuitId);
                if (error) throw error;
            } else {
                // Yeni dava oluştur
                currentSuitId = cleanSuitData.id || crypto.randomUUID();
                cleanSuitData.id = currentSuitId;
                const { error } = await supabase.from('suits').insert([cleanSuitData]);
                if (error) throw error;
            }

            // 🔥 YENİ: Dava Tarafları Senkronizasyonu (Eskileri sil, yenileri yaz)
            if (suitParties && Array.isArray(suitParties)) {
                // Önce bu davaya ait eski tüm tarafları sil
                const { error: partiesDeleteError } = await supabase.from('suit_parties').delete().eq('suit_id', currentSuitId);
                if (partiesDeleteError) throw partiesDeleteError;

                // Sonra güncel listeyi yaz
                if (suitParties.length > 0) {
                    const partyInserts = suitParties.map(p => ({
                        suit_id: currentSuitId,
                        role: p.role, // 'davaci' veya 'davali'
                        person_id: p.id && !String(p.id).startsWith('free_text') ? p.id : null,
                        free_text_name: p.name || null
                    }));
                    
                    const { error: partyError } = await supabase.from('suit_parties').insert(partyInserts);
                    if (partyError) throw partyError;
                }
            }

            return { success: true, data: { id: currentSuitId }, updated: !!existingSuit?.id };

        } catch (error) {
            console.error("Dava kayıt/güncelleme hatası:", error);
            return { success: false, error: error.message };
        }
    }

    // Dava portfoyundeki mevcut alanlari is duzenleme ekranindan yeniden YAZMA.
    // Yalniz dava acilisinda hala bos olan alanlar tamamlanir; mevcut
    // suit_parties kayitlari silinmez veya yeniden eklenmez.
    async completeExistingSuitFields(taskId, suitPayload) {
        try {
            const existing = await this.getSuitByTaskId(taskId);
            if (!existing?.id) throw new Error('Var olan dava dosyası tekrar okunamadı.');
            const changes = {};
            for (const field of ['court_name', 'file_no', 'opening_date', 'client_id']) {
                if (!existing[field] && suitPayload[field]) changes[field] = suitPayload[field];
            }
            if (Object.keys(changes).length) {
                const { error } = await supabase.from('suits')
                    .update(changes).eq('id', String(existing.id));
                if (error) throw error;
            }
            const savedParties = existing.suit_parties || [];
            for (const role of ['davaci', 'davali']) {
                if (savedParties.some(p => p.role === role)) continue;
                const proposed = (suitPayload.suitParties || []).filter(p => p.role === role);
                if (!proposed.length) continue;
                const inserts = proposed.map(p => ({
                    suit_id: String(existing.id),
                    role,
                    person_id: p.id && !String(p.id).startsWith('free_text') ? String(p.id) : null,
                    free_text_name: String(p.name || '').trim() || null
                }));
                const { error } = await supabase.from('suit_parties').insert(inserts);
                if (error) throw error;
            }
            return { success: true, data: { id: existing.id }, updated: true };
        } catch (error) {
            console.error('Eksik dava açılış alanları kaydedilemedi:', error);
            return { success: false, error: error.message || String(error) };
        }
    }

    // 🔥 YENİ: İşlem Geçmişi (Transaction) Loglama Metodu
    async logTransaction(transactionData) {
        try {
            const { error } = await supabase.from('transactions').insert([transactionData]);
            if (error) throw error;
            return { success: true };
        } catch (error) {
            console.error("Transaction log hatası:", error);
            return { success: false, error: error.message };
        }
    }

    // ✨ YENİ: Yapay Zeka Dilekçe Üretim İsteği
    async generatePetitionWithAI(payload) {
        try {
            // 401 Hatası almamak için oturum bilgisini zorla ekliyoruz
            const { data: { session } } = await supabase.auth.getSession();
            const authHeader = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};

            const { data, error } = await supabase.functions.invoke('generate-petition', {
                headers: authHeader,
                body: payload
            });

            if (error) throw error;
            return { success: true, data: data.petition };
        } catch (error) {
            console.error("AI API Hatası:", error);
            return { success: false, error: error.message || 'Yapay zeka servisine ulaşılamadı.' };
        }
    }
}