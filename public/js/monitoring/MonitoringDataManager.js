import { supabase, ipRecordsService } from '../../supabase-config.js';

export class MonitoringDataManager {
    constructor() {
        this.allMonitoringData = [];
        this.filteredData = [];
        this.allPersons = [];
        this.ipRecordCache = new Map();
        this.currentSort = { field: 'applicationDate', direction: 'desc' };
        this.currentTab = 'domestic'; 
    }

    setTab(tabName) {
        this.currentTab = tabName;
        this.filterData({}); 
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
            const { data: domesticData, error: domError } = await supabase
                .from('monitoring_trademarks')
                .select('*')
                .order('created_at', { ascending: false });

            const { data: intlData, error: intlError } = await supabase
                .from('international_monitoring')
                .select('*')
                .order('created_at', { ascending: false });

            if (domError) throw domError;

            const recordsRes = await ipRecordsService.getRecords();
            const allIpRecords = recordsRes.success ? recordsRes.data : [];
            const ipRecordsMap = new Map();
            allIpRecords.forEach(r => ipRecordsMap.set(r.id, r));

            const ensureArray = (val) => {
                if (!val) return [];
                if (Array.isArray(val)) return val;
                if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
                return [val];
            };

            const mappedDomestic = domesticData.map(d => {
                const ipRecord = ipRecordsMap.get(d.ip_record_id) || {};
                return {
                    id: d.id,
                    ipRecordId: d.ip_record_id,
                    title: ipRecord.title || '-',
                    markName: ipRecord.title || '-',
                    applicationNumber: ipRecord.applicationNumber || '-',
                    applicationDate: ipRecord.applicationDate || null,
                    status: ipRecord.status || 'unknown',
                    brandImageUrl: ipRecord.brandImageUrl || '',
                    ownerName: ipRecord.applicantName || '-',
                    niceClasses: ipRecord.niceClasses || [],
                    brandTextSearch: ensureArray(d.brand_text_search),
                    searchMarkName: d.search_mark_name || ipRecord.title || '',
                    niceClassSearch: ensureArray(d.nice_class_search),
                    createdAt: d.created_at,
                    monitoringType: 'domestic'
                };
            });

            const mappedIntl = (intlData || []).map(d => ({
                id: d.id,
                ipRecordId: null,
                title: d.mark_name || '-',
                markName: d.mark_name || '-',
                applicationNumber: d.application_no || '-',
                applicationDate: null,
                status: 'unknown',
                brandImageUrl: d.image_path || '',
                ownerName: d.applicant_name || '-',
                niceClasses: ensureArray(d.nice_classes),
                brandTextSearch: [],
                searchMarkName: d.mark_name || '',
                niceClassSearch: [],
                createdAt: d.created_at,
                monitoringType: 'international',
                monitoredCountries: ensureArray(d.countries),
                monitoringStartDate: d.start_date || null,
                monitoringEndDate: d.end_date || null
            }));

            this.allMonitoringData = [...mappedDomestic, ...mappedIntl];
            this.filterData({});
            
            return { success: true, data: this.allMonitoringData };
        } catch (err) {
            console.error("Supabase fetch hatası:", err);
            return { success: false, error: err.message };
        }
    }

    getOwnerNames(item) {
        if (item.ownerName && item.ownerName !== '-') return item.ownerName;
        return '-';
    }

    filterData(filters = {}, columnFilters = {}) {
        this.filteredData = this.allMonitoringData.filter(item => {
            if (item.monitoringType !== this.currentTab) return false;

            // 1. Genel Arama Kutusu (Mevcut)
            if (filters.search) {
                const markName = (item.title || item.markName || '').toLowerCase();
                const owner = this.getOwnerNames(item).toLowerCase();
                const applicationNo = (item.applicationNumber || '').toLowerCase();
                const sTerms = [...(item.brandTextSearch || []), item.searchMarkName].filter(Boolean).join(' ').toLowerCase();
                if (!markName.includes(filters.search) && !owner.includes(filters.search) && !applicationNo.includes(filters.search) && !sTerms.includes(filters.search)) return false;
            }
            
            // 2. Durum Filtresi (Mevcut)
            if (filters.status && filters.status !== 'all') {
                const itemStatusVal = this.getNormalizedStatus(item.status);
                if (itemStatusVal !== filters.status) return false;
            }

            // 🔥 3. YENİ: Kolon Bazlı Aramalar (Marka Adı, Sahip, Başvuru No)
            if (columnFilters.markName) {
                const markName = (item.title || item.markName || '').toLowerCase();
                if (!markName.includes(columnFilters.markName.toLowerCase())) return false;
            }
            if (columnFilters.owner) {
                const owner = this.getOwnerNames(item).toLowerCase();
                if (!owner.includes(columnFilters.owner.toLowerCase())) return false;
            }
            if (columnFilters.applicationNumber) {
                const applicationNo = (item.applicationNumber || '').toLowerCase();
                if (!applicationNo.includes(columnFilters.applicationNumber.toLowerCase())) return false;
            }

            return true;
        });
        return this.sortData();
    }

    getNormalizedStatus(status) {
        if (!status) return 'unknown';
        const s = String(status).toLowerCase();
        if (['registered', 'approved', 'active', 'tescilli'].includes(s)) return 'registered';
        if (['filed', 'application', 'başvuru'].includes(s)) return 'application';
        if (['published', 'yayında'].includes(s)) return 'pending';
        if (['rejected', 'refused', 'cancelled', 'iptal'].includes(s)) return 'rejected';
        return 'unknown';
    }

    sortData() {
        return this.filteredData.sort((a, b) => {
            let valA, valB;
            switch (this.currentSort.field) {
                case 'markName':
                    valA = (a.title || a.markName || '').toLowerCase(); valB = (b.title || b.markName || '').toLowerCase(); break;
                case 'owner':
                    valA = this.getOwnerNames(a).toLowerCase(); valB = this.getOwnerNames(b).toLowerCase(); break;
                case 'applicationDate':
                    valA = new Date(a.applicationDate || 0).getTime(); valB = new Date(b.applicationDate || 0).getTime(); break;
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
    }

    async addManualRecord(recordData) {
        const payload = {
            mark_name: recordData.markName,
            applicant_name: recordData.applicantName,
            application_no: recordData.applicationNo,
            nice_classes: recordData.niceClasses,
            countries: recordData.countries,
            start_date: recordData.startDate,
            end_date: recordData.endDate,
            image_path: recordData.imagePath || null
        };
        const { data, error } = await supabase.from('international_monitoring').insert([payload]).select();
        if (error) throw error;
        return data;
    }

    // 🔥 YENİ: Yurtdışı kaydını güncelleme metodu
    async updateManualRecord(id, recordData) {
        const payload = {
            mark_name: recordData.markName,
            applicant_name: recordData.applicantName,
            application_no: recordData.applicationNo,
            nice_classes: recordData.niceClasses,
            countries: recordData.countries,
            start_date: recordData.startDate,
            end_date: recordData.endDate
        };
        // Yalnızca görsel silindiyse veya yenisi yüklendiyse payload'a ekle
        if (recordData.imagePath !== undefined) {
            payload.image_path = recordData.imagePath;
        }
        
        const { data, error } = await supabase.from('international_monitoring').update(payload).eq('id', id).select();
        if (error) throw error;
        return data;
    }

    async deleteRecords(idsArray) {
        let successful = 0;
        for (const id of idsArray) {
            const record = this.allMonitoringData.find(r => r.id === id);
            if (!record) continue;
            const targetTable = record.monitoringType === 'international' ? 'international_monitoring' : 'monitoring_trademarks';
            const { error } = await supabase.from(targetTable).delete().eq('id', id);
            if (!error) successful++;
        }
        return successful;
    }
}