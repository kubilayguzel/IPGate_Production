import { ipRecordsService, personService, taskService, transactionTypeService, supabase, commonService } from '../../supabase-config.js';

export class TaskDataManager {
    constructor() {
        this.bulletinDataCache = {};
    }

    async loadInitialData() {
        try {
            const [ipRecords, persons, users, transactionTypes, countries] = await Promise.all([
                this.fetchAllIpRecords(),
                personService.getPersons(),
                taskService.getAllUsers(),
                transactionTypeService.getTransactionTypes(),
                this.getCountries()
            ]);

            let formattedTransactionTypes = this._normalizeData(transactionTypes).map(t => ({
                ...t,
                ipType: t.ip_type || t.ipType,
                isTopLevelSelectable: t.is_top_level_selectable ?? t.isTopLevelSelectable ?? true,
                applicableToMainType: t.applicable_to_main_type || t.applicableToMainType || []
            }));

            return {
                allIpRecords: this._normalizeData(ipRecords),
                allPersons: this._normalizeData(persons),
                allUsers: this._normalizeData(users),
                allTransactionTypes: formattedTransactionTypes,
                allCountries: this._normalizeData(countries)
            };
        } catch (error) {
            console.error("Veri yükleme hatası:", error);
            throw error;
        }
    }

    async fetchAllIpRecords() {
        try {
            return await ipRecordsService.getRecords();
        } catch (e) { return []; }
    }

    async getCountries() {
        try {
            const res = await commonService.getCountries();
            return res.success ? res.data : [];
        } catch (error) { return []; }
    }

    async getCities() {
        try {
            const { data, error } = await supabase.from('common').select('data').eq('id', 'cities_TR').single();
            if (data && data.data && data.data.list) {
                const rawList = data.data.list;
                if (rawList.length > 0 && typeof rawList[0] === 'string') {
                    return rawList.map(cityName => ({ name: cityName }));
                }
                return rawList;
            }
            return [];
        } catch (error) { return []; }
    }

    async searchBulletinRecords(term) {
        if (!term || term.length < 2) return [];
        const lowerTerm = term.toLowerCase();

        try {
            // 🔥 ÇÖZÜM 1: Tablo adı 'trademark_bulletin_records' olarak düzeltildi
            const { data, error } = await supabase
                .from('trademark_bulletin_records')
                .select('*')
                .or(`brand_name.ilike.%${lowerTerm}%,application_number.ilike.%${lowerTerm}%`)
                .limit(50);
                
            if (error) {
                console.error("Bülten arama SQL hatası:", error);
                throw error;
            }

            return data.map(d => ({
                id: d.id,
                ...d,
                markName: d.brand_name,
                applicationNo: d.application_number,
                applicationDate: d.application_date,
                niceClasses: d.nice_classes,
                holders: d.holders, 
                imagePath: d.image_url,
                bulletinId: d.bulletin_id // 🔥 ÇÖZÜM 2: Detay çekmek için gerçek bülten ID'si eklendi
            }));
        } catch (err) {
            console.error('Bulletin arama hatası:', err);
            return [];
        }
    }

    // 🔥 GÜNCELLENDİ: "details" objesine bağımlılık kaldırıldı. Direkt kolonlara bakar.
    async searchSuits(searchText, allowedTypeIds = []) {
        if (!searchText || searchText.length < 2) return [];

        try {
            let query = supabase.from('suits').select('*');
            query = query.or(`file_no.ilike.%${searchText}%,court_name.ilike.%${searchText}%,plaintiff.ilike.%${searchText}%,defendant.ilike.%${searchText}%`);

            const { data, error } = await query.limit(50);
            if (error) throw error;

            return data.map(doc => {
                let validMatch = true;
                if (allowedTypeIds && allowedTypeIds.length > 0 && allowedTypeIds.length <= 10) {
                    if (!allowedTypeIds.includes(String(doc.transaction_type_id))) validMatch = false;
                }
                
                if(!validMatch) return null;

                return {
                    id: doc.id,
                    ...doc,
                    displayFileNumber: doc.file_no || '-', 
                    displayCourt: doc.court_name || 'Mahkeme Yok',
                    displayClient: doc.client_name || doc.plaintiff || '-', 
                    opposingParty: doc.opposing_party || doc.defendant || '-',
                    _source: 'suit' 
                };
            }).filter(Boolean);
        } catch (error) { return []; }
    }

    async fetchAndStoreBulletinData(bulletinId) {
        if (!bulletinId) return null;
        if (this.bulletinDataCache[bulletinId]) return this.bulletinDataCache[bulletinId];

        try {
            const { data, error } = await supabase.from('trademark_bulletins').select('*').eq('id', bulletinId).single();
            if (error || !data) return null;

            const cacheObj = {
                id: data.id,
                bulletinNo: data.bulletin_no,
                bulletinDate: data.bulletin_date,
                type: data.type
            };
            this.bulletinDataCache[bulletinId] = cacheObj;
            return cacheObj;
        } catch (e) { return null; }
    }

    async getAssignmentRule(taskTypeId) {
        if (!taskTypeId) return null;
        try {
            const { data, error } = await supabase
                .from('task_assignments')
                .select('*')
                .eq('id', String(taskTypeId))
                .single();
                
            if (error || !data) return null;

            return {
                transactionTypeId: data.id,
                assignmentType: data.assignment_type,
                assigneeIds: data.assignee_ids,
                allowManualOverride: data.allow_manual_override
            };
        } catch (e) {
            console.error('Assignment rule error:', e);
            return null;
        }
    }

    async uploadFileToStorage(file, path) {
        if (!file || !path) return null;
        try {
            // 🔥 ÇÖZÜM: 'task_documents' yerine ortak 'documents' bucket'ı kullanılıyor
            const { error } = await supabase.storage.from('documents').upload(path, file);
            if (error) throw error;
            
            const { data } = supabase.storage.from('documents').getPublicUrl(path);
            return data.publicUrl;
        } catch (error) {
            console.error("Dosya yükleme hatası:", error);
            return null;
        }
    }

    async resolveImageUrl(path) {
        if (!path) return '';
        if (typeof path === 'string' && path.startsWith('http')) return path;
        try {
            const { data } = supabase.storage.from('brand_images').getPublicUrl(path);
            return data ? data.publicUrl : '';
        } catch { return ''; }
    }

    _normalizeData(result) {
        if (!result) return [];
        return Array.isArray(result.data) ? result.data :
               Array.isArray(result.items) ? result.items :
               (Array.isArray(result) ? result : []);
    }

    async getRecordTransactions(recordId, collectionName = 'ip_records') {
        if (!recordId) return { success: false, message: 'Kayıt ID yok.' };
        try {
            const { data, error } = await supabase
                .from('transactions')
                .select('*')
                .eq('ip_record_id', String(recordId))
                .order('created_at', { ascending: false });
                
            if (error) throw error;

            const mappedData = data.map(t => ({
                id: t.id,
                ...t,
                type: String(t.transaction_type_id || ''),
                transactionTypeName: t.description || 'İşlem',
                timestamp: t.transaction_date || t.created_at
            }));

            return { success: true, data: mappedData };
        } catch (error) { 
            return { success: false, error: error }; 
        }
    }
}