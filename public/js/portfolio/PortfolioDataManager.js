import { ipRecordsService, transactionTypeService, personService, commonService, suitService, transactionService, supabase } from '../../supabase-config.js';
import { STATUSES } from '../../utils.js';

export class PortfolioDataManager {
    constructor() {
        this.allRecords = [];
        this.objectionRows = [];
        this.litigationRows = [];
        
        this.transactionTypesMap = new Map();
        this.personsMap = new Map(); 
        this.statusMap = new Map();  
        this.countriesMap = new Map();
        
        this.allCountries = [];  
        this.wipoGroups = { parents: new Map(), children: new Map() };

        this._buildStatusMap();
    }

    // 🔥 HIZ OPTİMİZASYONU 1: RAM şişiren kopya objeler yaratmak yerine, doğrudan var olan veriyi günceller.
    async _mapRawToProcessed(rawData) {
        for (let i = 0; i < rawData.length; i++) {
            const record = rawData[i];
            record.applicationDateTs = this._parseDate(record.applicationDate);
            record.formattedApplicantName = (record.applicantName && record.applicantName !== '-')
                ? record.applicantName
                : this._resolveApplicantName(record);
            record.formattedApplicationDate = this._fmtDate(record.applicationDate);
            record.formattedNiceClasses = this._formatNiceClasses(record);
            record.statusText = this._resolveStatusText(record);
            record.formattedCountryName = this.getCountryName(record.country || record.countryCode);
            
            // 🔥 HIZ OPTİMİZASYONU 2: Arama motoru için önceden indekslenmiş tek bir string oluşturur.
            record.searchString = `${record.title || ''} ${record.brandText || ''} ${record.applicationNumber || ''} ${record.formattedApplicantName || ''} ${record.formattedCountryName || ''} ${record.statusText || ''} ${record.formattedNiceClasses || ''} ${record.registrationNumber || ''}`.toLowerCase();
        }
        return rawData;
    }

    async loadInitialData() {
        this.loadPersons(); // Arkada sessizce başlar, arayüzü kilitlemez
        await Promise.all([
            this.loadTransactionTypes(),
            this.loadCountries()
        ]);
        return this.allRecords;
    }

    async loadTransactionTypes() {
        const result = await transactionTypeService.getTransactionTypes();
        if (result.success) {
            result.data.forEach(type => {
                this.transactionTypesMap.set(String(type.id), type);
                if (type.code) this.transactionTypesMap.set(String(type.code), type);
            });
        }
    }

    async loadPersons() {
        const result = await personService.getPersons();
        if (result.success) {
            this.personsMap.clear();
            (result.data || []).forEach(p => { if(p.id) this.personsMap.set(p.id, p); });
        }
    }

    async loadCountries() {
        try {
            const result = await commonService.getCountries();
            if (result.success) {
                this.allCountries = result.data;
                this.countriesMap = new Map(this.allCountries.map(c => [c.code, c.name]));
            }
        } catch (e) {
            console.error("Ülke listesi hatası:", e);
        }
    }

    _buildStatusMap() {
        this.statusMap.clear();
        for (const type in STATUSES) {
            if (Array.isArray(STATUSES[type])) {
                STATUSES[type].forEach(s => {
                    this.statusMap.set(s.value, s.text);
                });
            }
        }
    }

    // 🔥 RİSKLİ CACHE İPTALİ: forceRefresh istenirse veritabanına gider, aksi halde RAM'deki hazır veriyi anında döner.
    async loadRecords({ type = null, forceRefresh = false } = {}) {
        if (!forceRefresh && this.allRecords.length > 0) {
            return this.allRecords;
        }

        const result = type 
            ? await ipRecordsService.getRecordsByType(type, forceRefresh) 
            : await ipRecordsService.getRecords(forceRefresh);            
        
        if (result.success) {
            const rawData = Array.isArray(result.data) ? result.data : [];
            this.allRecords = await this._mapRawToProcessed(rawData);
            this._buildWipoGroups();
        }
        return this.allRecords;
    }

    startListening(onDataReceived, { type = null } = {}) {
        this.loadRecords({ type }).then(records => {
            if (onDataReceived) onDataReceived(records);
        });
        return () => {}; 
    }

    _resolveApplicantName(record) {
        if (Array.isArray(record.applicants) && record.applicants.length > 0) {
            const names = record.applicants.map(app => {
                if (typeof app === 'object' && app.name) return app.name;
                const personId = typeof app === 'object' ? app.id : app;
                if (personId && this.personsMap.has(personId)) {
                    return this.personsMap.get(personId).name;
                }
                return '';
            }).filter(Boolean);
            
            if (names.length > 0) return names.join(', ');
        }
        return record.applicantName || '-';
    }

    _resolveStatusText(record) {
        const rawStatus = record.status;
        if (!rawStatus) return '-';
        if (this.statusMap.has(rawStatus)) return this.statusMap.get(rawStatus);
        return rawStatus;
    }

    getRecordById(id) {
        return this.allRecords.find(r => r.id === id);
    }

    _buildWipoGroups() {
        this.wipoGroups = { parents: new Map(), children: new Map() };
        this.allRecords.forEach(r => {
            if (r.origin === 'WIPO' || r.origin === 'ARIPO') {
                // 🔥 ÇÖZÜM: Artık irNo (WIPO Numarası) yerine doğrudan kayıtların veritabanı ID'lerini (id ve parentId) kullanıyoruz!
                if (r.transactionHierarchy === 'parent') {
                    this.wipoGroups.parents.set(r.id, r);
                } else if (r.transactionHierarchy === 'child' && r.parentId) {
                    if (!this.wipoGroups.children.has(r.parentId)) {
                        this.wipoGroups.children.set(r.parentId, []);
                    }
                    this.wipoGroups.children.get(r.parentId).push(r);
                }
            }
        });
    }

    getWipoChildren(irNo) {
        return this.wipoGroups.children.get(irNo) || [];
    }

    clearCache() {
        this.allRecords = []; 
        this.objectionRows = [];
        this.litigationRows = [];
        if (window.localCache) window.localCache.remove('ip_records_cache');
    }

    async loadLitigationData() {
        try {
            const result = await suitService.getSuits();
            if (result.success) {
                this.litigationRows = result.data;
                this.litigationRows.sort((a, b) => this._parseDate(b.openedDate) - this._parseDate(a.openedDate));
            } else {
                this.litigationRows = [];
            }
            return this.litigationRows;
        } catch (e) {
            console.error("Davalar hatası:", e);
            return [];
        }
    }

    prefetchObjectionData() {
        const PARENT_TYPES = ['7', '19', '20'];
        return {
            parentPromise: supabase.from('transactions').select('*, transaction_documents(*), tasks(*, task_documents(*))').in('transaction_type_id', PARENT_TYPES).limit(10000),
            childPromise: supabase.from('transactions').select('*, transaction_documents(*), tasks(*, task_documents(*))').eq('transaction_hierarchy', 'child').limit(10000)
        };
    }

    async buildObjectionRows(prefetchPromise = null, forceRefresh = false) {
        if (!forceRefresh && this.objectionRows.length > 0) return this.objectionRows;

        try {
            const prefetch = prefetchPromise || this.prefetchObjectionData();
            const [parentRes, childRes] = await Promise.all([prefetch.parentPromise, prefetch.childPromise]);
            
            const parentsData = parentRes.data || [];
            const childrenData = childRes.data || [];

            if (parentsData.length === 0) {
                this.objectionRows = [];
                return [];
            }

            const parentIds = new Set();
            const parents = parentsData.map(p => { 
                parentIds.add(String(p.id)); 
                return p; 
            });

            const childrenMap = {};
            childrenData.forEach(child => {
                const pId = String(child.parent_id);
                if (pId && parentIds.has(pId)) {
                    if (!childrenMap[pId]) childrenMap[pId] = [];
                    childrenMap[pId].push(child);
                }
            });

            const recordsMap = new Map(this.allRecords.map(r => [String(r.id), r]));
            
            const localRows = parents.map(parent => {
                const recId = String(parent.ip_record_id);
                let record = recordsMap.get(recId) || { id: recId, isMissing: true };
                
                const children = childrenMap[String(parent.id)] || [];
                const typeInfo = this.transactionTypesMap.get(String(parent.transaction_type_id));

                const parentRow = this._createObjectionRowDataFast(record, parent, typeInfo, true, children.length > 0);
                parentRow.children = [];

                for (const child of children) {
                    const childTypeInfo = this.transactionTypesMap.get(String(child.transaction_type_id));
                    parentRow.children.push(this._createObjectionRowDataFast(record, child, childTypeInfo, false, false, parent.id));
                }
                
                parentRow.children.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
                return parentRow;
            });

            this.objectionRows = localRows.filter(Boolean);
            return this.objectionRows;

        } catch (error) {
            console.error("İtirazlar yüklenirken hata:", error);
            return [];
        }
    }

    async loadObjectionRows(forceRefresh = false) {
        return this.buildObjectionRows(null, forceRefresh);
    }

    _createObjectionRowDataFast(record, tx, typeInfo, isParent, hasChildren, parentId = null) {
        let docs = [];
        const seenUrls = new Set();
        
        const addDoc = (d) => {
            if (!d) return;
            const url = d.document_url || d.url || d.fileUrl || d.downloadURL || d.path;
            if (url && !seenUrls.has(url)) {
                seenUrls.add(url);
                docs.push({
                    fileName: d.document_name || d.name || d.document_designation || 'Belge',
                    fileUrl: url,
                    type: d.document_type || d.type || d.document_designation || 'standard'
                });
            }
        };

        if (Array.isArray(tx.transaction_documents)) tx.transaction_documents.forEach(addDoc);

        const taskData = Array.isArray(tx.tasks) ? tx.tasks[0] : tx.tasks; 
        if (taskData) {
            if (Array.isArray(taskData.task_documents)) taskData.task_documents.forEach(addDoc);
            if (taskData.details && Array.isArray(taskData.details.documents)) taskData.details.documents.forEach(addDoc);
            if (taskData.details && taskData.details.epatsDocument) addDoc(taskData.details.epatsDocument);
        }

        const details = tx.details || {};
        if (details.relatedPdfUrl) addDoc({ name: 'Resmi Yazı', url: details.relatedPdfUrl, type: 'official_document' });
        if (details.oppositionEpatsPetitionFileUrl) addDoc({ name: 'ePATS İtiraz Evrakı', url: details.oppositionEpatsPetitionFileUrl, type: 'epats_document' });
        if (!isParent && details.oppositionPetitionFileUrl) addDoc({ name: 'İtiraz Dilekçesi', url: details.oppositionPetitionFileUrl, type: 'opposition_petition' });

        const isOwnRecord = !(
            record.portfoyStatus === 'third_party' || record.portfoyStatus === 'published_in_bulletin' ||
            record.recordOwnerType === 'third_party'
        );
        
        if (isOwnRecord && String(tx.transaction_type_id) === '20') docs = docs.filter(d => d.type === 'epats_document');
        else if (isParent) docs = docs.filter(d => d.type !== 'opposition_petition');

        let opponentText = tx.opposition_owner || '-';
        if (opponentText === '-' && details.oppositionOwner) opponentText = details.oppositionOwner;
        if (opponentText === '-' && record.opponent) opponentText = record.opponent;
        if (opponentText === '-' && record.recordOwnerType === 'third_party') opponentText = record.formattedApplicantName;

        let bNo = '-';
        let bDate = '-';
        if (Array.isArray(record.bulletins) && record.bulletins.length > 0) {
            bNo = record.bulletins[0].bulletinNo || record.bulletins[0].bulletin_no || '-';
            bDate = record.bulletins[0].bulletinDate || record.bulletins[0].bulletin_date || '-';
        } else if (record.bulletinNo || details.bulletinNo) {
            bNo = record.bulletinNo || details.bulletinNo;
            bDate = record.bulletinDate || details.bulletinDate;
        }

        const epatsDoc = docs.find(d => d.type === 'epats_document' || (d.fileName && d.fileName.toLowerCase().includes('epats')));
        let eDate = tx.transaction_date || tx.created_at;
        if (epatsDoc && epatsDoc.documentDate) eDate = epatsDoc.documentDate;
        else if (details.epatsDocument && details.epatsDocument.documentDate) eDate = details.epatsDocument.documentDate;

        return {
            id: tx.id,
            recordId: record.id,
            parentId: parentId,
            isChild: !isParent,
            hasChildren: hasChildren,
            isOwnRecord: isOwnRecord, 
            portfoyStatus: record.portfoyStatus || record.portfolio_status,
            recordStatus: record.status,
            title: record.title || record.brandText || record.brand_name || '-',
            transactionTypeName: typeInfo?.alias || typeInfo?.name || `İşlem ${tx.transaction_type_id}`,
            applicationNumber: record.applicationNumber || record.application_number || '-',
            applicantName: record.formattedApplicantName || record.applicantName || '-',
            opponent: opponentText,
            bulletinNo: bNo,
            bulletinDate: this._fmtDate(bDate),
            epatsDate: this._fmtDate(eDate),
            statusText: this._resolveStatusText(record) || '-', 
            timestamp: tx.created_at || tx.transaction_date,
            documents: docs
        };
    }

    async deleteRecord(id) { 
        return await ipRecordsService.deleteParentWithChildren(id); 
    }

    async toggleRecordsStatus(ids) {
        const records = ids.map(id => this.getRecordById(id)).filter(Boolean);
        if(!records.length) return;
        await Promise.all(records.map(r => 
            ipRecordsService.updateRecord(r.id, { portfoyStatus: 'inactive' })
        ));
    }

    _formatObjectionStatus(code) {
        if (!code) return 'Karar Bekleniyor';
        const typeInfo = this.transactionTypesMap.get(String(code));
        return typeInfo ? (typeInfo.alias || typeInfo.name) : 'Karar Bekleniyor';
    }

    _formatNiceClasses(record) {
        const classes = new Set();
        if (Array.isArray(record.niceClasses)) {
            record.niceClasses.forEach(c => {
                const num = parseInt(c);
                if (!isNaN(num)) classes.add(num);
            });
        }
        if (Array.isArray(record.goodsAndServicesByClass)) {
            record.goodsAndServicesByClass.forEach(item => { 
                const num = parseInt(item.classNo);
                if (!isNaN(num)) classes.add(num);
            });
        }
        
        if (classes.size === 0) return '-';
        return Array.from(classes).sort((a, b) => a - b).map(c => c < 10 ? `0${c}` : c).join(', ');
    }

    _fmtDate(val) {
        if(!val) return '-';
        try {
            let d = new Date(val);
            if(isNaN(d.getTime())) return '-';
            return d.toLocaleDateString('tr-TR');
        } catch { return '-'; }
    }

    _parseDate(val) {
        if (!val || val === '-') return 0;
        if (val instanceof Date) return val.getTime();
        if (typeof val === 'string' && val.includes('.')) {
            const parts = val.split('.');
            if (parts.length === 3) return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
        }
        const parsed = new Date(val).getTime();
        return isNaN(parsed) ? 0 : parsed;
    }

    getCountryName(code) {
        return this.countriesMap.get(code) || code || '-';
    }

    // 🔥 HIZ OPTİMİZASYONU 3: Filtreleme esnasında sadece önceden hazırlanan searchString'e bakar.
    filterRecords(typeFilter, searchTerm, columnFilters = {}, subTab = null) {
        const s = searchTerm ? searchTerm.toLowerCase() : null;
        
        const activeFilters = [];
        for (const key in columnFilters) {
            if (columnFilters[key]) {
                let filterVal = columnFilters[key].toLowerCase();
                if (key === 'formattedApplicationDate' && filterVal.includes('-')) {
                    const parts = filterVal.split('-'); 
                    if (parts.length === 3) filterVal = `${parts[2]}.${parts[1]}.${parts[0]}`;
                }
                activeFilters.push({ key, val: filterVal });
            }
        }

        let sourceData = [];

        if (typeFilter === 'litigation') {
            sourceData = this.litigationRows.filter(r => r.portfoyStatus !== 'inactive' && r.recordStatus !== 'pasif');
        } else if (typeFilter === 'objections') {
            sourceData = this.objectionRows.filter(r => r.portfoyStatus !== 'inactive' && r.recordStatus !== 'pasif');
        } else {
            sourceData = this.allRecords.filter(r => {
                if (r.recordOwnerType === 'third_party') return false;
                const isThirdPartyOrBulletin = ['third_party', 'published_in_bulletin'].includes(r.portfoyStatus || r.status);
                const isInactive = ['inactive', 'pasif'].includes(r.portfoyStatus || r.status);
                
                if (isInactive || isThirdPartyOrBulletin) return false;
                if ((r.origin === 'WIPO' || r.origin === 'ARIPO') && r.transactionHierarchy === 'child') return false;
                
                if (typeFilter === 'all') return true;
                if (typeFilter === 'trademark') {
                    if (r.type !== 'trademark') return false;
                    const isTP = ['TÜRKPATENT', 'TR'].includes(r.origin) || r.country === 'TR';
                    if (subTab === 'turkpatent') return isTP;
                    if (subTab === 'foreign') return !isTP;
                    return true;
                }
                return r.type === typeFilter;
            });
        }

        if (!s && activeFilters.length === 0) return sourceData;

        return sourceData.filter(item => {
            if (s) {
                if (typeFilter === 'objections') {
                    const matchParent = ((item.transactionTypeName || '').toLowerCase().includes(s) || (item.title || '').toLowerCase().includes(s) || (item.opponent || '').toLowerCase().includes(s) || String(item.bulletinNo || '').includes(s) || (item.applicantName || '').toLowerCase().includes(s) || String(item.applicationNumber || '').includes(s) || (item.statusText || '').toLowerCase().includes(s));
                    let matchChild = false;
                    if (item.children && item.children.length > 0) {
                        matchChild = item.children.some(c => (c.transactionTypeName || '').toLowerCase().includes(s) || (c.statusText || '').toLowerCase().includes(s) || (c.opponent || '').toLowerCase().includes(s));
                    }
                    if (!matchParent && !matchChild) return false;
                } else if (typeFilter === 'litigation') {
                     const searchStr = `${item.title || ''} ${item.suitType || ''} ${item.caseNo || ''} ${item.court || ''} ${item.client?.name || ''} ${item.opposingParty || ''} ${item.statusText || ''}`.toLowerCase();
                     if (!searchStr.includes(s)) return false;
                } else {
                    if (!item.searchString || !item.searchString.includes(s)) return false;
                }
            }
            
            for (let i = 0; i < activeFilters.length; i++) {
                const f = activeFilters[i];
                const itemVal = String(item[f.key] || '').toLowerCase();
                if (!itemVal.includes(f.val)) return false;
            }
            return true;
        });
    }

    // 🔥 HIZ OPTİMİZASYONU 4: Yavaş Intl.Collator iptal edildi, ham string karşılaştırması kullanılıyor. (100 Kat Hızlı)
    sortRecords(data, column, direction) {
        const isDate = String(column).toLowerCase().includes('date') || String(column).toLowerCase().includes('tarih');
        const isAppDate = column === 'applicationDate' || column === 'formattedApplicationDate';

        return [...data].sort((a, b) => {
            let valA = column === 'country' ? (a.formattedCountryName || a[column]) : a[column];
            let valB = column === 'country' ? (b.formattedCountryName || b[column]) : b[column];
                   
            if (!valA && !valB) return 0;
            if (!valA) return direction === 'asc' ? 1 : -1;
            if (!valB) return direction === 'asc' ? -1 : 1;
            
            if (isDate) {
                const timeA = isAppDate ? (a.applicationDateTs || 0) : this._parseDate(valA);
                const timeB = isAppDate ? (b.applicationDateTs || 0) : this._parseDate(valB);
                return direction === 'asc' ? timeA - timeB : timeB - timeA;
            }
            
            const strA = String(valA).toLowerCase();
            const strB = String(valB).toLowerCase();
            if (strA < strB) return direction === 'asc' ? -1 : 1;
            if (strA > strB) return direction === 'asc' ? 1 : -1;
            return 0;
        });
    }

    prepareMonitoringData(record) {
        return {
            ip_record_id: record.id,
            mark_name: record.title || record.brandText || 'İsimsiz Marka',
            application_number: record.applicationNumber || '-',
            owner_name: record.applicantName || '-',
            nice_classes: record.niceClasses || [],
            image_path: record.brandImageUrl || null
        };
    }
}