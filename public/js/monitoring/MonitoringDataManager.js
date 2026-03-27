// public/js/monitoring/MonitoringDataManager.js
import { supabase, ipRecordsService } from '../../supabase-config.js';

export class MonitoringDataManager {
    constructor() {
        this.allMonitoringData = [];
        this.filteredData = [];
        this.allPersons = [];
        this.ipRecordCache = new Map();
        this.currentSort = { field: 'applicationDate', direction: 'desc' };
    }

    async init() {
        await this.fetchPersons();
        return await this.fetchMonitoringData();
    }

    async fetchPersons() {
        try {
            const { data } = await supabase.from('persons').select('*');
            if (data) this.allPersons = data;
        } catch (e) { console.error("Kişiler çekilemedi:", e); }
    }

    async fetchMonitoringData() {
        try {
            // 1. URL'den belirli bir markaya (Göz ikonuna) tıklanıp gelinmiş mi kontrol et
            const urlParams = new URLSearchParams(window.location.search);
            const filterId = urlParams.get('filterId');

            // 2. SADECE monitoring tablosunu çekiyoruz (Hata veren SQL JOIN'leri tamamen kaldırıldı)
            let query = supabase
                .from('monitoring_trademarks')
                .select('*')
                .order('created_at', { ascending: false });

            if (filterId) {
                query = query.eq('ip_record_id', String(filterId));
            }

            const { data: monitoringData, error } = await query;
            if (error) throw error;

            // 3. ✨ SİHİRLİ DOKUNUŞ: Karmaşık verileri zaten hazırlayan ve önbellekleyen servisi kullanıyoruz!
            const recordsRes = await ipRecordsService.getRecords();
            const allIpRecords = recordsRes.success ? recordsRes.data : [];

            // Hızlı eşleştirme için Map (Sözlük) oluştur
            const ipRecordsMap = new Map();
            allIpRecords.forEach(r => ipRecordsMap.set(r.id, r));

            const ensureArray = (val) => {
                if (!val) return [];
                if (Array.isArray(val)) return val;
                if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
                return [val];
            };

            // 4. Verileri JavaScript tarafında saniyeler içinde birleştir
            this.allMonitoringData = monitoringData.map(d => {
                // İlgili ana marka kaydını servisten gelen verilerin içinden bul
                const ipRecord = ipRecordsMap.get(d.ip_record_id) || {};
                
                const bts = ensureArray(d.brand_text_search);

                return {
                    id: d.id,
                    ipRecordId: d.ip_record_id,
                    title: ipRecord.title || d.mark_name || '-',
                    markName: ipRecord.title || d.mark_name || '-',
                    applicationNumber: ipRecord.applicationNumber || d.application_no || '-',
                    applicationDate: ipRecord.applicationDate || null,
                    status: ipRecord.status || 'unknown',
                    brandImageUrl: ipRecord.brandImageUrl || d.image_path || '',
                    ownerName: ipRecord.applicantName || '-',
                    niceClasses: ipRecord.niceClasses || [],
                    brandTextSearch: bts,
                    // 🔥 ÇÖZÜM: Veritabanındaki 'search_mark_name' verisine EN YÜKSEK önceliği verdik!
                    searchMarkName: d.search_mark_name || ipRecord.title || d.mark_name || '',
                    niceClassSearch: ensureArray(d.nice_class_search),
                    createdAt: d.created_at,
                    applicants: ipRecord.applicants || []
                };
            });

            this.filteredData = [...this.allMonitoringData];
            return { success: true, data: this.allMonitoringData };
        } catch (err) {
            console.error("Supabase fetch hatası:", err);
            return { success: false, error: err.message };
        }
    }
    
    // Eski SQL sorgusu yerine bu da servise bağlandı
    async fetchIpRecordByIdCached(recordId) {
        if (!recordId) return null;
        if (this.ipRecordCache.has(recordId)) return this.ipRecordCache.get(recordId);
        
        try {
            // Ayrı SQL yazmak yerine merkezi servisi kullanıyoruz
            const res = await ipRecordsService.getRecordById(recordId);
            
            if (!res.success || !res.data) return null;
            
            const data = res.data;
            const rec = {
                ...data,
                markName: data.title || '-',
                ownerName: data.applicantName || '-',
            };
            
            this.ipRecordCache.set(recordId, rec);
            return rec;
        } catch (e) {
            return null;
        }
    }

    getOwnerNames(item) {
        // Zaten ipRecordsService 'applicantName' formatını mükemmel ayarlıyor
        if (item.ownerName && item.ownerName !== '-') {
            return item.ownerName;
        }
        return '-';
    }

    filterData(filters) {
        this.filteredData = this.allMonitoringData.filter(item => {
            if (filters.search) {
                const markName = (item.title || item.markName || '').toLowerCase();
                const owner = this.getOwnerNames(item).toLowerCase();
                const applicationNo = (item.applicationNumber || item.applicationNo || '').toLowerCase();
                const sTerms = [...(item.brandTextSearch || []), item.searchMarkName].filter(Boolean).join(' ').toLowerCase();

                if (!markName.includes(filters.search) && !owner.includes(filters.search) && !applicationNo.includes(filters.search) && !sTerms.includes(filters.search)) return false;
            }
            if (filters.markName && !(item.title || item.markName || '').toLowerCase().includes(filters.markName)) return false;
            if (filters.searchTerms) {
                const allTerms = [...(item.brandTextSearch || []), item.searchMarkName].filter(Boolean).join(' ').toLowerCase();
                if (!allTerms.includes(filters.searchTerms)) return false;
            }
            if (filters.owner && !this.getOwnerNames(item).toLowerCase().includes(filters.owner)) return false;
            if (filters.niceClass) {
                const searchClasses = filters.niceClass.split(/[,\s]+/).filter(c => c !== '');
                const allClassSources = [...(item.niceClasses || []), ...(item.niceClassSearch || [])].filter(c => c !== null).map(String);
                const hasMatch = searchClasses.some(sClass => allClassSources.includes(sClass));
                if (!hasMatch) return false;
            }
            
            // Durum (Status) filtrelemesi
            if (filters.status && filters.status !== 'all') {
                const itemStatusVal = this.getNormalizedStatus(item.status);
                if (itemStatusVal !== filters.status) return false;
            }

            return true;
        });
        return this.sortData();
    }

    getNormalizedStatus(status) {
        if (!status) return 'unknown';
        const s = String(status).toLowerCase();
        if (['registered', 'approved', 'active', 'tescilli', 'kabul'].includes(s)) return 'registered';
        if (['filed', 'application', 'başvuru'].includes(s)) return 'application';
        if (['published', 'yayında', 'pending', 'decision_pending', 'karar bekleniyor'].includes(s)) return 'pending';
        if (['rejected', 'refused', 'cancelled', 'reddedildi', 'iptal', 'hükümsüz'].includes(s)) return 'rejected';
        if (['objection', 'itiraz'].includes(s)) return 'objection';
        if (['litigation', 'dava'].includes(s)) return 'litigation';
        return 'unknown';
    }

    sortData() {
        return this.filteredData.sort((a, b) => {
            let valA, valB;
            switch (this.currentSort.field) {
                case 'markName':
                    valA = (a.title || a.markName || '').toLowerCase();
                    valB = (b.title || b.markName || '').toLowerCase();
                    break;
                case 'owner':
                    valA = this.getOwnerNames(a).toLowerCase(); valB = this.getOwnerNames(b).toLowerCase();
                    break;
                case 'applicationDate':
                    valA = new Date(a.applicationDate || 0).getTime(); valB = new Date(b.applicationDate || 0).getTime();
                    break;
                default: return 0;
            }
            if (valA < valB) return this.currentSort.direction === 'asc' ? -1 : 1;
            if (valA > valB) return this.currentSort.direction === 'asc' ? 1 : -1;
            return 0;
        });
    }

    async updateCriteria(id, searchMarkNameValue, brandTextArray, niceClassArray) {
        const { error } = await supabase.from('monitoring_trademarks').update({
            brand_text_search: brandTextArray,
            nice_class_search: niceClassArray,
            search_mark_name: searchMarkNameValue
        }).eq('id', id);

        if (error) throw error;

        const index = this.allMonitoringData.findIndex(item => item.id === id);
        if (index !== -1) {
            this.allMonitoringData[index].brandTextSearch = brandTextArray;
            this.allMonitoringData[index].niceClassSearch = niceClassArray;
            this.allMonitoringData[index].searchMarkName = searchMarkNameValue;
        }
    }

    async deleteRecords(idsArray) {
        let successful = 0;
        for (const id of idsArray) {
            const { error } = await supabase.from('monitoring_trademarks').delete().eq('id', id);
            if (!error) successful++;
        }
        return successful;
    }
}