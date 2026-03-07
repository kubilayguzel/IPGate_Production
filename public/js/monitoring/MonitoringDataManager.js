import { supabase } from '../../supabase-config.js';

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
            // 🔥 ÇÖZÜM 1: Tüm verileri tek bir dev JOIN sorgusuyla en baştan çekiyoruz!
            const { data, error } = await supabase
                .from('monitoring_trademarks')
                .select(`
                    *,
                    ip_records (
                        *,
                        ip_record_trademark_details (*),
                        ip_record_applicants ( persons ( name ) ),
                        ip_record_classes ( class_no )
                    )
                `)
                .order('created_at', { ascending: false });

            if (error) throw error;

            const ensureArray = (val) => {
                if (!val) return [];
                if (Array.isArray(val)) return val;
                if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
                return [val];
            };

            this.allMonitoringData = data.map(d => {
                const ip = d.ip_records || {};
                
                let tmDetails = ip.ip_record_trademark_details || {};
                if (Array.isArray(tmDetails)) tmDetails = tmDetails.length > 0 ? tmDetails[0] : {};

                let applicantsArray = ip.ip_record_applicants
                    ? ip.ip_record_applicants.filter(rel => rel && rel.persons).map(rel => ({ name: rel.persons.name })) : [];
                let resolvedOwnerName = applicantsArray.map(a => a.name).join(', ') || '-';

                let classesArray = ip.ip_record_classes ? ip.ip_record_classes.map(c => parseInt(c.class_no)).filter(n => !isNaN(n)) : [];

                let imageUrl = tmDetails.brand_image_url || d.image_path;
                if (!imageUrl || imageUrl.trim() === '') {
                    imageUrl = ip.id ? `https://guicrctynauzxhyfpdfe.supabase.co/storage/v1/object/public/brand_images/${ip.id}/logo.png` : '';
                }

                const bts = ensureArray(d.brand_text_search);

                return {
                    id: d.id,
                    ipRecordId: d.ip_record_id,
                    title: tmDetails.brand_name || ip.title || d.mark_name || '-',
                    markName: tmDetails.brand_name || ip.title || d.mark_name || '-',
                    applicationNumber: ip.application_number || d.application_no || '-',
                    applicationDate: ip.application_date,
                    status: ip.status || 'unknown',
                    brandImageUrl: imageUrl,
                    ownerName: resolvedOwnerName,
                    niceClasses: classesArray,
                    brandTextSearch: bts,
                    searchMarkName: bts.length > 0 ? bts[0] : (d.mark_name || ''),
                    niceClassSearch: ensureArray(d.nice_class_search),
                    createdAt: d.created_at,
                    applicants: applicantsArray
                };
            });

            this.filteredData = [...this.allMonitoringData];
            return { success: true, data: this.allMonitoringData };
        } catch (err) {
            console.error("Supabase fetch hatası:", err);
            return { success: false, error: err.message };
        }
    }
    
    async fetchIpRecordByIdCached(recordId) {
        if (!recordId) return null;
        if (this.ipRecordCache.has(recordId)) return this.ipRecordCache.get(recordId);
        
        try {
            const { data, error } = await supabase.from('ip_records').select(`
                *,
                ip_record_trademark_details (*),
                ip_record_applicants ( persons ( name ) ),
                ip_record_classes ( class_no )
            `).eq('id', recordId).single();
            
            if (error || !data) return null;
            
            let tmDetails = data.ip_record_trademark_details || {};
            if (Array.isArray(tmDetails)) tmDetails = tmDetails.length > 0 ? tmDetails[0] : {};

            let applicantsArray = data.ip_record_applicants
                ? data.ip_record_applicants.filter(rel => rel.persons).map(rel => ({ name: rel.persons.name })) : [];

            let resolvedOwnerName = applicantsArray.map(a => a.name).join(', ') || '-';
            let classesArray = data.ip_record_classes ? data.ip_record_classes.map(c => parseInt(c.class_no)).filter(n => !isNaN(n)) : [];

            let imageUrl = tmDetails.brand_image_url;
            if (!imageUrl || imageUrl.trim() === '') imageUrl = `https://guicrctynauzxhyfpdfe.supabase.co/storage/v1/object/public/brand_images/${data.id}/logo.png`;

            const rec = {
                ...data,
                title: tmDetails.brand_name || data.title || '-',
                markName: tmDetails.brand_name || data.title || '-',
                applicationNumber: data.application_number || '-',
                applicationDate: data.application_date,
                brandImageUrl: imageUrl,
                applicants: applicantsArray,
                ownerName: resolvedOwnerName,
                status: data.status || 'unknown',
                niceClasses: classesArray
            };
            
            this.ipRecordCache.set(recordId, rec);
            return rec;
        } catch (e) {
            return null;
        }
    }

    getOwnerNames(item) {
        try {
            if (item.ownerName && typeof item.ownerName === 'string' && item.ownerName.trim() !== '' && item.ownerName.trim() !== '-') {
                return item.ownerName;
            }
            if (item.applicants && Array.isArray(item.applicants) && item.applicants.length > 0) {
                return item.applicants.map(applicant => {
                    if (typeof applicant === 'object' && applicant.id) {
                        const match = this.allPersons.find(p => p.id === applicant.id);
                        return match ? match.name : applicant.name || '';
                    }
                    if (typeof applicant === 'object' && applicant.name) return applicant.name;
                    return String(applicant);
                }).filter(name => name && name.trim() !== '').join(', ');
            }
        } catch (error) { console.error('getOwnerNames hatası:', error); }
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
            
            // 🔥 ÇÖZÜM 4: Durum (Status) filtrelemesi sisteme dahil edildi
            if (filters.status && filters.status !== 'all') {
                const itemStatusVal = this.getNormalizedStatus(item.status);
                if (itemStatusVal !== filters.status) return false;
            }

            return true;
        });
        return this.sortData();
    }

    // Durumları veritabanı kelimelerinden HTML select value'larına çevirir
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