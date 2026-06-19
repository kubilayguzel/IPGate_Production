// public/js/accrual-management/AccrualDataManager.js

import { 
    authService, taskService, personService, 
    transactionTypeService, supabase, ipRecordsService, accrualService
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
        this.allInvoices = [];
    }

    async fetchAllData() {
        try {
            // SADECE accrual ve kalemlerini çekiyoruz.
            const accPromise = supabase.from('accruals').select('*, accrual_documents(*), accrual_items(*)').limit(10000).order('created_at', { ascending: false });
            
            // 🔥 ÇÖZÜM: 'accruals(*)' İLİŞKİSİNİ SİLDİK (Ambiguous Join hatasını engellemek için)
            // Faturaları yalın halde çekiyoruz.
            const invPromise = supabase.from('invoices').select('*').limit(5000).order('created_at', { ascending: false });
            
            const [accRes, invRes, usersRes, typesRes, personsRes] = await Promise.all([
                accPromise,
                invPromise,
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
                    department: row.department || 'EVREKA', // 🔥 YENİ EKLENDİ (Önyüzün rozeti doğru görebilmesi için)
                    status: row.status || d.status,
                    createdAt: row.created_at ? new Date(row.created_at) : new Date(0),
                    updatedAt: row.updated_at || d.updatedAt,
                    isForeignTransaction: row.is_foreign_transaction ?? d.isForeignTransaction ?? false,
                    foreignStatus: row.foreign_status || 'unpaid', // 🔥 ÇÖZÜM: Hatalı kelime silindi, veritabanı köprüsü onarıldı
                    tpeInvoiceNo: row.tpe_invoice_no || d.tpeInvoiceNo,
                    evrekaInvoiceNo: row.evreka_invoice_no || d.evrekaInvoiceNo,
                    orderCode: row.order_code || d.orderCode || null,
                    description: row.description || d.description || '', 
                    invoiceDescription: row.invoice_description || d.invoice_description || '', // 🔥 YENİ
                    items: row.accrual_items || d.items || [],
                    sentToAdvisor: row.sent_to_advisor || false,
                    
                    // 🔥 EŞLEŞTİRME İÇİN EKLENEN KISIM: Her iki Fatura ID'sini de JS objesine alıyoruz
                    invoiceId: row.invoice_id || null,
                    invoiceId2: row.invoice_id_2 || null,
                    subject: row.subject || d.subject || '',

                    files: [
                        ...(row.files || d.files || []),
                        ...(row.accrual_documents ? row.accrual_documents.map(doc => ({
                            id: doc.id, name: doc.document_name, url: doc.document_url, type: doc.document_type
                        })) : [])
                    ],
                    
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

            // 🔥 FATURALARI VE TAHAKKUKLARI JAVASCRIPT İLE BİRLEŞTİRİYORUZ
            this.allInvoices = invRes.data ? invRes.data.map(row => ({
                id: String(row.id),
                kolaybiInvoiceId: row.kolaybi_invoice_id,
                invoiceNo: row.invoice_no || '-',
                invoiceDate: row.invoice_date || null, // YENİ
                kolaybiStatus: row.kolaybi_status || null, // YENİ
                kolaybiUuid: row.kolaybi_uuid || null, // YENİ
                status: row.status || 'draft',
                totalAmount: row.total_amount || 0,
                currency: row.currency || 'TRY',
                clientId: row.client_id,
                clientName: getPersonName(row.client_id) || 'Bilinmiyor',
                createdAt: row.created_at ? new Date(row.created_at) : new Date(0),
                
                accruals: this.allAccruals
                    // 🔥 DÜZELTME 2.1: invoiceId2 içinde birden fazla fatura ID'si (virgülle ayrılmış) olabileceği için includes kullanıyoruz
                    .filter(a => String(a.invoiceId) === String(row.id) || (a.invoiceId2 && String(a.invoiceId2).includes(String(row.id))))
                    .map(a => ({ ...a, task_title: a.taskTitle, total_amount: a.totalAmount }))
            })) : [];
            // 🔥 KESİN ÇÖZÜM: Tahakkuka bağlı olan tüm faturaları (invoice_id ve invoice_id_2) bul ve numaralarını birleştir
            this.allAccruals.forEach(acc => {
                const linkedInvoices = this.allInvoices.filter(inv => 
                    // 🔥 DÜZELTME 2.2: includes ile 3 veya daha fazla faturayı da kusursuz yakalıyoruz
                    inv.id === String(acc.invoiceId) || (acc.invoiceId2 && String(acc.invoiceId2).includes(inv.id))
                );

                if (linkedInvoices.length > 0) {
                    // Tüm bağlı faturaların numaralarını topla (GIB No varsa onu al, yoksa sistem no'yu al)
                    const nos = linkedInvoices.map(inv => {
                        // 🔥 GÜNCELLEME: Sadece resmî "invoiceNo" verisini (Örn: GİB...) alıyoruz
                        return (inv.invoiceNo && inv.invoiceNo !== '-') ? inv.invoiceNo : null;
                    }).filter(Boolean); // Boş veya null olanları temizle

                    if (nos.length > 0) {
                        // Numaraları virgül ile birleştirerek tabloya gönder (Örn: GIB...12, GIB...13)
                        acc.evrekaInvoiceNo = nos.join(', '); 
                    }
                }
            });

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

        // 🔥 YENİ: Eğer aktif sekme faturalar ise, accruals yerine faturaları döndür ve filtrele
        if (tab === 'invoices') {
            let invData = [...(this.allInvoices || [])];
            
            if (filters) {
                // 1. Fatura Durumu Filtresi
                if (filters.invoiceStatus && filters.invoiceStatus !== 'all') {
                    const searchStatus = filters.invoiceStatus.toLowerCase();
                    
                    // 🔥 YENİ: Faturalar sekmesinde "Fatura Kesilmedi" filtresi seçilirse sonuç boş döner 
                    if (searchStatus === 'not_invoiced') {
                        invData = [];
                    } else {
                        invData = invData.filter(inv => {
                            const s = (inv.kolaybiStatus || inv.status || 'draft').toLowerCase();
                            let normalized = s;
                            if (['taslak', 'draft', 'hazır', 'ready', 'preparing', 'ready_to_send'].some(k=>s.includes(k))) normalized = 'draft';
                            if (['processing', 'queued', 'waiting', 'bekliyor', 'in_queue', 'sending', 'işleniyor'].some(k=>s.includes(k))) normalized = 'waiting';
                            if (['ulaştı', 'işlendi', 'kabul', 'onay', 'accept', 'approv', 'processed'].some(k=>s.includes(k))) normalized = 'approved';
                            if (['red', 'reject', 'decline'].some(k=>s.includes(k))) normalized = 'rejected';
                            if (['iptal', 'cancel'].some(k=>s.includes(k))) normalized = 'cancelled';
                            if (['error', 'fail', 'hata'].some(k=>s.includes(k))) normalized = 'failed';
                            if (['gönderildi', 'sent', 'provider', 'qnb'].some(k=>s.includes(k))) normalized = 'sent';
                            return normalized === searchStatus;
                        });
                    }
                }
                
                // 2. Müşteri (Cari) Arama
                if (filters.party) {
                    const searchVal = filters.party.toLowerCase();
                    invData = invData.filter(inv => (inv.clientName || '').toLowerCase().includes(searchVal));
                }
                
                // 3. Fatura No / ID Arama
                if (filters.fileNo) {
                    const searchVal = filters.fileNo.toLowerCase();
                    invData = invData.filter(inv => 
                        (inv.invoiceNo || '').toLowerCase().includes(searchVal) || 
                        (inv.kolaybiInvoiceId || '').toLowerCase().includes(searchVal) ||
                        (inv.id || '').toLowerCase().includes(searchVal)
                    );
                }
            }
            return invData;
        }

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
            // 🔥 YENİ: Departman Filtresi
            if (filters.department && filters.department !== '') {
                data = data.filter(item => (item.department || 'EVREKA') === filters.department);
            }
            
            // 🔥 YENİ: Tür Filtresi
            if (filters.type && filters.type !== '') {
                data = data.filter(item => {
                    const currentType = item.type || item.accrualType || 'Hizmet';
                    return currentType === filters.type;
                });
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
            // Sizin Mevcut "İlgili İş (Task)" Filtreniz (Buna dokunmuyoruz)
            if (filters.task) {
                const searchVal = filters.task.toLowerCase();
                data = data.filter(item => {
                    const task = this.allTasks[String(item.taskId)];
                    const typeObj = task ? this.allTransactionTypes.find(t => t.id === task.taskType) : null;
                    const taskName = typeObj ? (typeObj.alias || typeObj.name) : (task?.title || item.taskTitle || '');
                    return taskName.toLowerCase().includes(searchVal);
                });
            }

            if (filters.invoiceStatus && filters.invoiceStatus !== 'all') {
                const searchStatus = filters.invoiceStatus.toLowerCase();
                data = data.filter(item => {
                    const linkedInvoices = this.allInvoices.filter(inv => 
                        // 🔥 DÜZELTME 2.3: Filtreleme yaparken de çoklu faturaları kaçırmamak için
                        inv.id === String(item.invoiceId) || (item.invoiceId2 && String(item.invoiceId2).includes(inv.id))
                    );
                    
                    // 🔥 YENİ: Fatura Kesilmedi Opsiyonu (Akıllı Kontrol)
                    if (searchStatus === 'not_invoiced') {
                        // Eğer hiç faturası yoksa doğrudan listele
                        if (linkedInvoices.length === 0) return true;
                        
                        // Faturası var ama Tümü "İptal", "Red" veya "Hatalı" ise yine listele (Yeniden kesilmesi lazım demektir)
                        const hasActiveInvoice = linkedInvoices.some(inv => {
                            const s = (inv.status || '').toLowerCase();
                            const ks = (inv.kolaybiStatus || '').toLowerCase();
                            
                            const isDeclined = ks === 'declined' || s === 'declined' || ks.includes('decline');
                            const isRejected = ks === 'rejected' || s === 'rejected' || ks.includes('red') || s.includes('red');
                            const isCancelled = ks === 'cancelled' || s === 'cancelled' || ks.includes('iptal') || s.includes('iptal');
                            const isFailed = ks === 'failed' || s === 'failed' || ks.includes('hata') || s.includes('hata');
                            
                            return !(isDeclined || isRejected || isCancelled || isFailed);
                        });
                        
                        return !hasActiveInvoice;
                    }

                    if (linkedInvoices.length === 0) return false;

                    return linkedInvoices.some(inv => {
                        const s = (inv.kolaybiStatus || inv.status || 'draft').toLowerCase();
                        let normalized = s;
                        if (['taslak', 'draft', 'hazır', 'ready', 'preparing', 'ready_to_send'].some(k=>s.includes(k))) normalized = 'draft';
                        if (['processing', 'queued', 'waiting', 'bekliyor', 'in_queue', 'sending', 'işleniyor'].some(k=>s.includes(k))) normalized = 'waiting';
                        if (['ulaştı', 'işlendi', 'kabul', 'onay', 'accept', 'approv', 'processed'].some(k=>s.includes(k))) normalized = 'approved';
                        if (['red', 'reject', 'decline'].some(k=>s.includes(k))) normalized = 'rejected';
                        if (['iptal', 'cancel'].some(k=>s.includes(k))) normalized = 'cancelled';
                        if (['error', 'fail', 'hata'].some(k=>s.includes(k))) normalized = 'failed';
                        if (['gönderildi', 'sent', 'provider', 'qnb'].some(k=>s.includes(k))) normalized = 'sent';
                        return normalized === searchStatus;
                    });
                });
            }

            // 🔥 YENİ: Açıklama Filtresi (HEMEN ALTINA EKLİYORUZ)
            if (filters.description) {
                const searchVal = filters.description.toLowerCase();
                data = data.filter(item => {
                    const desc1 = (item.description || '').toLowerCase();
                    const desc2 = (item.invoiceDescription || '').toLowerCase();
                    return desc1.includes(searchVal) || desc2.includes(searchVal);
                });
            }
        }

        if (sort && sort.column) {
            data.sort((a, b) => {
                let valA = a[sort.column]; let valB = b[sort.column];
                
                // 🔥 ÇÖZÜM: 0. Tahakkuk No Sıralaması (Metin değil, gerçek SAYI olarak)
                if (sort.column === 'id') {
                    valA = Number(a.id) || 0;
                    valB = Number(b.id) || 0;
                }
                
                // 1. Müvekkil / Taraf Sıralaması
                else if (sort.column === 'party') {
                    const getP = (item) => item.tpInvoiceParty?.name || item.serviceInvoiceParty?.name || '';
                    valA = getP(a).toLowerCase();
                    valB = getP(b).toLowerCase();
                }
                
                // 2. İş Detayı / Konu Sıralaması
                else if (sort.column === 'subject') {
                    const getS = (item) => {
                        const task = this.allTasks[String(item.taskId)];
                        if (task && task.relatedIpRecordId) {
                            const ipRec = this.ipRecordsMap[String(task.relatedIpRecordId)];
                            if (ipRec) return ipRec.markName || '';
                        }
                        return item.subject || '';
                    };
                    valA = getS(a).toLowerCase();
                    valB = getS(b).toLowerCase();
                }

                // 3. Genel Toplam Tutar Sıralaması
                else if (sort.column === 'totalAmount') {
                    const getT = (item) => {
                        if (Array.isArray(item.totalAmount)) return item.totalAmount.reduce((sum, x) => sum + (Number(x.amount)||0), 0);
                        return Number(item.totalAmount) || 0;
                    };
                    valA = getT(a);
                    valB = getT(b);
                }

                // 4. Kalan Bakiye Sıralaması
                else if (sort.column === 'remainingAmount') {
                    const getR = (item) => {
                        let rem = item.remainingAmount;
                        if (item.status === 'unpaid' && (!rem || (Array.isArray(rem) && rem.length === 0))) rem = item.totalAmount;
                        if (Array.isArray(rem)) return rem.reduce((sum, x) => sum + (Number(x.amount)||0), 0);
                        return Number(rem) || 0;
                    };
                    valA = getR(a);
                    valB = getR(b);
                }

                // 5. Hizmet ve Yansıtma Tutarları Sıralaması (Yeni)
                else if (sort.column === 'serviceFee') {
                    const getSrv = (item) => {
                        if (item.type !== 'Hizmet') return 0;
                        const srvItems = (item.items || []).filter(i => i.fee_type === 'Hizmet' || i.fee_type === 'Hukuk Danışmanlık');
                        return srvItems.reduce((sum, i) => sum + (Number(i.total_amount) || 0), 0);
                    };
                    valA = getSrv(a);
                    valB = getSrv(b);
                }
                else if (sort.column === 'officialFee') {
                    const getOff = (item) => {
                        let offItems = (item.items || []);
                        if (item.type === 'Hizmet') offItems = offItems.filter(i => i.fee_type !== 'Hizmet' && i.fee_type !== 'Hukuk Danışmanlık');
                        return offItems.reduce((sum, i) => sum + (Number(i.total_amount) || 0), 0);
                    };
                    valA = getOff(a);
                    valB = getOff(b);
                }
                
                else {
                    if (typeof valA === 'string') valA = valA.toLowerCase();
                    if (typeof valB === 'string') valB = valB.toLowerCase();
                }

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

        const newAccrualId = String(await accrualService._getNextAccrualId());
        const session = await authService.getCurrentSession();
        const dbUser = this.allUsers.find(u => u.email === session?.user?.email);

        const finalAccrual = {
            id: newAccrualId,
            task_id: null, // Serbest tahakkuklarda task_id olmaz
            status: 'unpaid',
            department: formData.department || 'EVREKA', // 🔥 ÇÖZÜM: Departman bilgisi veritabanına eklendi!
            accrual_type: formData.type || 'Masraf',
            tp_invoice_party_id: formData.tpInvoicePartyId || null,
            service_invoice_party_id: formData.serviceInvoicePartyId || null,
            created_by_uid: dbUser ? dbUser.id : null,
            official_fee_amount: formData.officialFee?.amount || 0,
            official_fee_currency: formData.officialFee?.currency || 'TRY',
            service_fee_amount: formData.serviceFee?.amount || 0,
            service_fee_currency: formData.serviceFee?.currency || 'TRY',
            total_amount: formData.totalAmount || [],
            remaining_amount: formData.totalAmount || [], 
            vat_rate: formData.vatRate || 20,
            apply_vat_to_official_fee: formData.applyVatToOfficialFee || false,
            is_foreign_transaction: formData.isForeignTransaction || false,
            description: formData.subject ? `Konu: ${formData.subject}\nNot: ${formData.description || ''}` : (formData.description || null),
            invoice_description: formData.invoice_description || formData.invoiceDescription || null, 
            tpe_invoice_no: formData.tpeInvoiceNo || null,
            evreka_invoice_no: formData.evrekaInvoiceNo || null,
            order_code: formData.orderCode || null,
        };

        const { error: accError } = await supabase.from('accruals').insert(finalAccrual);
        if (accError) throw accError;

        // 🔥 DOĞRU ÇÖZÜM: Tahakkuk kalemlerini accrual_items tablosuna kaydediyoruz
        if (formData.items && formData.items.length > 0) {
            const itemsToInsert = formData.items.map(item => ({
                accrual_id: String(newAccrualId),
                fee_type: item.fee_type,
                item_name: item.item_name,
                quantity: item.quantity,
                unit_price: item.unit_price,
                vat_rate: item.vat_rate,
                total_amount: item.total_amount,
                currency: item.currency
            }));
            await supabase.from('accrual_items').insert(itemsToInsert);
        }

        const filesToProcess = fileToUpload ? [fileToUpload] : formData.files;
        if (filesToProcess && filesToProcess.length > 0) {
            const docInserts = [];
            for (const fileObj of filesToProcess) {
                const file = fileObj.file || fileObj;
                const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                const cleanPath = `accruals/${newAccrualId}/${Date.now()}_${cleanFileName}`;

                const { error: uploadError } = await supabase.storage
                    .from('documents')
                    .upload(cleanPath, file, { cacheControl: '3600', upsert: true });

                if (!uploadError) {
                    const { data: urlData } = supabase.storage.from('documents').getPublicUrl(cleanPath);
                    if (urlData && urlData.publicUrl) {
                        docInserts.push({
                            accrual_id: String(newAccrualId),
                            document_name: file.name,
                            document_url: urlData.publicUrl,
                            document_type: file.type || 'other'
                        });
                    }
                }
            }
            if (docInserts.length > 0) {
                await supabase.from('accrual_documents').insert(docInserts);
            }
        }
        await this.fetchAllData(); 
    }

    async updateAccrual(accrualId, formData, fileToUpload) {
        const currentAccrual = this.allAccruals.find(a => a.id === accrualId);
        if (!currentAccrual) throw new Error("Tahakkuk bulunamadı.");

        // 🔥 YENİ ÇÖZÜM: Ücretler düzenlendiğinde eski "tek döviz cinsi" hesaplamasını pas geçip, 
        // formdan gelen KDV'si zaten hesaplanmış çoklu kur Array'ini (formData.totalAmount) doğrudan alıyoruz.
        let newTotalArray = currentAccrual.totalAmount || [];
        
        if (formData.items && formData.items.length > 0) {
            const sumsMap = {};
            formData.items.forEach(item => {
                const amt = Number(item.total_amount) || 0;
                const curr = item.currency || 'TRY';
                if (!sumsMap[curr]) sumsMap[curr] = 0;
                sumsMap[curr] += amt;
            });
            newTotalArray = Object.entries(sumsMap).map(([c, a]) => ({ amount: a, currency: c }));
        } else if (formData.totalAmount && formData.totalAmount.length > 0) {
            newTotalArray = formData.totalAmount;
        }

        const payload = {
            ...formData,
            description: formData.description || null, 
            invoice_description: formData.invoice_description || formData.invoiceDescription || null, // 🔥 ÇÖZÜM: Veri eşleştirme hatası giderildi
            tpe_invoice_no: formData.tpeInvoiceNo || null,
            evreka_invoice_no: formData.evrekaInvoiceNo || null,
            order_code: formData.orderCode || null,
            totalAmount: newTotalArray,
            // Eğer statü 'unpaid' (ödenmedi) ise Kalan Tutar, Toplam Tutar'a eşittir.
            // Eğer 'paid' (ödendi) ise Kalan Tutar boş dizi [] olmalıdır.
            remainingAmount: (formData.status || currentAccrual.status) === 'unpaid' ? newTotalArray : ((formData.status || currentAccrual.status) === 'paid' ? [] : currentAccrual.remainingAmount),
            files: fileToUpload ? [fileToUpload] : formData.files
        };

        const res = await accrualService.updateAccrual(accrualId, payload);
        if (!res.success) throw new Error(res.error);
        // 🔥 DOĞRU ÇÖZÜM: Düzenleme modunda eski kalemleri silip yenilerini ekliyoruz
        if (formData.items) {
            await supabase.from('accrual_items').delete().eq('accrual_id', String(accrualId));
            
            if (formData.items.length > 0) {
                const itemsToInsert = formData.items.map(item => ({
                    accrual_id: String(accrualId),
                    fee_type: item.fee_type,
                    item_name: item.item_name,
                    quantity: item.quantity,
                    unit_price: item.unit_price,
                    vat_rate: item.vat_rate,
                    total_amount: item.total_amount,
                    currency: item.currency
                }));
                await supabase.from('accrual_items').insert(itemsToInsert);
            }
        }
        await this.fetchAllData(); 
    }

    async savePayment(selectedIds, paymentData) {
        const { date, receiptFiles, singlePaymentDetails, isForeignTab } = paymentData;
        const ids = Array.from(selectedIds);

        // Tarih formatını (GG.AA.YYYY) PostgreSQL formatına (YYYY-MM-DD) çeviriyoruz
        let formattedDate = null;
        if (date) {
            const parts = date.split('.');
            if (parts.length === 3) formattedDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
            else formattedDate = date; 
        }

        // 🔥 ÇÖZÜM 1: Eşzamanlı (.map) yerine Sıralı (for...of) işlem yapıyoruz. 
        // Böylece aynı dekontu birden fazla tahakkuka eklerken Storage akışı çökmez.
        for (const id of ids) {
            const acc = this.allAccruals.find(a => a.id === id);
            if (!acc) continue;

            let updates = {};

            // 1. Statü ve Bakiye Güncellemeleri
            if (isForeignTab) {
                updates.foreign_status = 'paid';
                if (formattedDate) updates.paymentDate = formattedDate;
            } else {
                if (ids.length === 1 && singlePaymentDetails) {
                    updates.paymentDate = formattedDate;
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
                    
                    updates.remainingAmount = Object.entries(remMap).map(([c, a]) => ({ amount: a, currency: c }));

                    if (updates.remainingAmount.length === 0) updates.status = 'paid';
                    else if (newPaidOff > 0 || newPaidSrv > 0) updates.status = 'partially_paid';
                    else updates.status = 'unpaid';
                }
                else {
                    updates.status = 'paid';
                    updates.remainingAmount = [];
                    updates.paymentDate = formattedDate;
                }
            }

            // 2. Dekont Yükleme ve Kaydetme İşlemi (Hata denetimli)
            if (receiptFiles && receiptFiles.length > 0) {
                const docInserts = [];
                
                for (const fileObj of receiptFiles) {
                    const file = fileObj.file || fileObj;
                    const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                    const cleanPath = `accruals/${id}/${Date.now()}_${cleanFileName}`;

                    // Supabase Storage Yüklemesi
                    const { error: uploadError } = await supabase.storage
                        .from('documents')
                        .upload(cleanPath, file, { cacheControl: '3600', upsert: true });

                    // Eğer yükleme başarısız olursa SESSİZ KALMA, ekrana hata fırlat!
                    if (uploadError) {
                        console.error('Dekont storage yükleme hatası:', uploadError);
                        throw new Error('Dekont sunucuya yüklenemedi: ' + uploadError.message);
                    }

                    const { data: urlData } = supabase.storage.from('documents').getPublicUrl(cleanPath);
                    if (urlData && urlData.publicUrl) {
                        docInserts.push({
                            accrual_id: String(id),
                            document_name: file.name,
                            document_url: urlData.publicUrl,
                            document_type: 'Ödeme Dekontu'
                        });
                    }
                }
                
                // Veritabanı (Tablo) Kaydı
                if (docInserts.length > 0) {
                    const { error: dbError } = await supabase.from('accrual_documents').insert(docInserts);
                    if (dbError) {
                        console.error('Dekont DB kayıt hatası:', dbError);
                        throw new Error('Dekont veritabanına kaydedilemedi: ' + dbError.message);
                    }
                }
            }

            // 3. Tahakkuk Güncellemesi
            const res = await accrualService.updateAccrual(id, updates);
            if (!res.success) throw new Error('Tahakkuk statüsü güncellenemedi: ' + res.error);
        }

        // Tüm satırlar sorunsuz bittiyse verileri tazele
        await this.fetchAllData();
    }

    async batchUpdateStatus(selectedIds, newStatus, isForeignTab = false) {
        const ids = Array.from(selectedIds);
        const promises = ids.map(async (id) => {
            const acc = this.allAccruals.find(a => a.id === id);
            if (!acc) return;
            
            const updates = {};
            if (isForeignTab) {
                // 🔥 Yurtdışı sekmesinden gelirse sadece yurtdışı statüsünü güncelle
                updates.foreign_status = newStatus;
                if (newStatus === 'unpaid') {
                    updates.payment_date = null; // Ödenmedi yapıldığında eski tarihi temizle
                }
            } else {
                updates.status = newStatus;
                if (newStatus === 'unpaid') {
                    updates.paymentDate = null;
                    updates.remainingAmount = acc.totalAmount;
                }
            }
            return accrualService.updateAccrual(id, updates);
        });

        await Promise.all(promises);
        await this.fetchAllData();
    }

    async deleteAccrual(id) {
        // 🔥 YENİ: Tahakkuk silinmeden önce bağlı evrakları Storage'dan fiziksel olarak sil
        const { data: docs } = await supabase.from('accrual_documents').select('document_url').eq('accrual_id', String(id));
        if (docs && docs.length > 0) {
            for (const doc of docs) {
                if (doc.document_url && doc.document_url.includes('/documents/')) {
                    let filePath = doc.document_url.split('/documents/')[1];
                    await supabase.storage.from('documents').remove([decodeURIComponent(filePath)]);
                }
            }
        }
        
        // Tahakkuku DB'den sil
        await supabase.from('accruals').delete().eq('id', id);
        await this.fetchAllData();
    }

    // Tahakkukun içindeki spesifik bir belgeyi silme fonksiyonu
    async deleteDocument(documentId, fileUrl) {
        return await accrualService.deleteDocumentFully(documentId, fileUrl);
    }

    // 🔥 YENİ: Müşavire gönderim durumunu güncelleme
    async markAsSentToAdvisor(accrualIds) {
        if (!accrualIds || accrualIds.length === 0) return;
        
        const promises = accrualIds.map(id => 
            supabase.from('accruals').update({ sent_to_advisor: true }).eq('id', String(id))
        );
        
        await Promise.all(promises);
    }

// 🔥 GÜNCEL: mergeStrategy parametresi eklendi ve "Karar Bekleniyor" durumu hatadan muaf tutuldu
    async createKolaybiInvoice(selectedIds, mergeStrategy = null) {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) throw new Error("Fatura kesmek için tahakkuk seçmelisiniz.");

        try {
            const { data, error } = await supabase.functions.invoke('create-kolaybi-invoice', {
                body: { action: 'create', accrualIds: ids, mergeStrategy }
            });

            if (error) {
                console.error("Supabase Fonksiyon Hatası:", error);
                throw new Error(error.message || "Fatura oluşturulurken bir hata oluştu.");
            }

            // Eğer success false ise ama sebebi Karar Beklenmesi ise HATA FIRLATMA!
            if (!data.success && !data.requireMergeDecision) {
                throw new Error(data.error || data.message || "Beklenmeyen bir hata oluştu.");
            }

            // Verileri tazelemeyi şimdilik atlıyoruz, main.js'de başarılı olunca tazeleyeceğiz
            return data;

        } catch (error) {
            console.error("KolayBi Fatura Hatası:", error);
            throw error;
        }
    }

    async syncKolaybiInvoice(invoiceId) {
        const { data, error } = await supabase.functions.invoke('create-kolaybi-invoice', {
            body: { action: 'sync', invoiceId }
        });
        if (error || !data.success) throw new Error(error?.message || data?.error || data?.message || "Senkronizasyon başarısız.");
        return data;
    }

    async viewKolaybiInvoice(invoiceId) {
        const { data, error } = await supabase.functions.invoke('create-kolaybi-invoice', {
            body: { action: 'view', invoiceId }
        });
        if (error || !data.success) throw new Error(error?.message || data?.error || data?.message || "Görüntüleme başarısız.");
        return data;
    }

    async syncBulkKolaybiInvoices(invoiceIds) {
        const { data, error } = await supabase.functions.invoke('create-kolaybi-invoice', {
            body: { action: 'sync_bulk', invoiceIds }
        });
        if (error || !data.success) throw new Error(error?.message || data?.error || "Toplu senkronizasyon başarısız.");
        return data;
    }

    async autoSyncPendingInvoices() {
        if (!this.allInvoices || this.allInvoices.length === 0) return false;

        // 🔥 GÜNCELLEME: Tüm nihai kelimeler (Kabul, Red, İptal) İngilizce ve Türkçe olarak eklendi
        const finalKeywords = ['approved', 'rejected', 'cancelled', 'failed', 'accept', 'decline', 'kabul', 'red', 'iptal'];

        const pendingIds = this.allInvoices
            .filter(inv => {
                const kId = String(inv.kolaybiInvoiceId);
                if (!inv.kolaybiInvoiceId || kId === 'undefined' || kId === 'null') return false;
                
                const s = (inv.status || '').toLowerCase().trim();
                const ks = (inv.kolaybiStatus || '').toLowerCase().trim();
                
                // Eğer faturanın sistem VEYA kolaybi statüsünde bu kesin kelimeler geçiyorsa sorgulama!
                const isFinal = finalKeywords.some(word => s.includes(word) || ks.includes(word));
                if (isFinal) return false;

                return true; // Diğer belirsiz durumları sorgula
            })
            .map(inv => inv.id);

        if (pendingIds.length > 0) {
            console.log(`[OTO-SYNC] Sorgulanacak ${pendingIds.length} adet fatura var. Limit kaldırıldı.`);
            try {
                await this.syncBulkKolaybiInvoices(pendingIds);
                await this.fetchAllData(); 
                return true; 
            } catch (e) {
                console.error("[OTO-SYNC] Otomatik güncelleme hatası:", e);
            }
        } else {
            console.log("[OTO-SYNC] Tüm faturalar nihai durumda. Güncellenecek fatura yok.");
        }
        return false;
    }

    async createRecursiveAccrual(accrualData) {
        try {
            const { data, error } = await supabase
                .from('accruals_recursive')
                .insert([{
                    person_id: accrualData.personId,
                    type: accrualData.type,
                    department: accrualData.department, // 🔥 YENİ
                    amount: accrualData.amount,
                    currency: accrualData.currency,
                    period: accrualData.period,
                    start_date: accrualData.startDate,
                    next_trigger_date: accrualData.startDate,
                    description: accrualData.description,
                    is_active: true,
                    items: accrualData.items // 🔥 YENİ
                }])
                .select();
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) { throw new Error(error.message); }
    }

    async getRecursiveAccruals() {
        try {
            const { data, error } = await supabase
                .from('accruals_recursive')
                .select('*')
                .order('created_at', { ascending: false });
                
            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Tekrarlayan tahakkukları getirme hatası:', error);
            return { success: false, error: error.message };
        }
    }

    async deleteRecursiveAccrual(id) {
        try {
            const { error } = await supabase.from('accruals_recursive').delete().eq('id', id);
            if (error) throw error;
            return { success: true };
        } catch (error) {
            console.error('Tekrarlayan tahakkuk silme hatası:', error);
            return { success: false, error: error.message };
        }
    }

    async updateRecursiveAccrual(id, accrualData) {
        try {
            const { data, error } = await supabase
                .from('accruals_recursive')
                .update({
                    person_id: accrualData.personId,
                    type: accrualData.type,
                    department: accrualData.department, // 🔥 YENİ
                    amount: accrualData.amount,
                    currency: accrualData.currency,
                    period: accrualData.period,
                    start_date: accrualData.startDate,
                    description: accrualData.description,
                    items: accrualData.items // 🔥 YENİ
                })
                .eq('id', id)
                .select();
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) { throw new Error(error.message); }
    }
}