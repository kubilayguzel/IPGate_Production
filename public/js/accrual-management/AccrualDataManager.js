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
        this.accrualInvoicesLinks = []; // 🔥 YENİ: Köprü tablosu verileri
    }

    async fetchAllData() {
        try {
            const accPromise = supabase.from('accruals').select('*, accrual_documents(*), accrual_items(*)').limit(10000).order('created_at', { ascending: false });
            const invPromise = supabase.from('invoices').select('*').limit(5000).order('created_at', { ascending: false });
            // 🔥 ÇÖZÜM 1: Artık yeni kurduğumuz köprü tablosunu (accrual_invoices) çekiyoruz!
            const linksPromise = supabase.from('accrual_invoices').select('*').limit(50000); 
            
            const [accRes, invRes, linksRes, usersRes, typesRes, personsRes] = await Promise.all([
                accPromise,
                invPromise,
                linksPromise,
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
            
            this.accrualInvoicesLinks = linksRes?.data || []; // 🔥 Köprü verileri hafızaya alındı

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
                    department: row.department || 'EVREKA',
                    status: row.status || d.status,
                    createdAt: row.created_at ? new Date(row.created_at) : new Date(0),
                    updatedAt: row.updated_at || d.updatedAt,
                    isForeignTransaction: row.is_foreign_transaction ?? d.isForeignTransaction ?? false,
                    foreignStatus: row.foreign_status || 'unpaid', 
                    tpeInvoiceNo: row.tpe_invoice_no || d.tpeInvoiceNo,
                    evrekaInvoiceNo: row.evreka_invoice_no || d.evrekaInvoiceNo,
                    orderCode: row.order_code || d.orderCode || null,
                    description: row.description || d.description || '', 
                    invoiceDescription: row.invoice_description || d.invoice_description || '', 
                    items: row.accrual_items || d.items || [],
                    sentToAdvisor: row.sent_to_advisor || false,
                    subject: row.subject || d.subject || '',
                    requiresInvoice: row.requires_invoice ?? true,
                    // 🔥 ESKİ 'invoiceId' VE 'invoiceId2' ALANLARI SİLİNDİ, BUNLARIN YERİNE KÖPRÜ TABLOSU KULLANILACAK

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
                    foreignTotalAmount: Array.isArray(row.foreign_total_amount) ? row.foreign_total_amount : [],
                    foreignRemainingAmount: Array.isArray(row.foreign_remaining_amount) ? row.foreign_remaining_amount : [],
                    vatRate: row.vat_rate || d.vatRate || 20,
                    applyVatToOfficialFee: row.apply_vat_to_official_fee ?? d.applyVatToOfficialFee ?? false,
                    paymentDate: row.payment_date || d.paymentDate || null,
                    foreignPaymentDate: row.foreign_payment_date || null, 
                    tpInvoiceParty: row.tp_invoice_party_id ? { id: row.tp_invoice_party_id, name: getPersonName(row.tp_invoice_party_id) } : d.tpInvoiceParty,
                    serviceInvoiceParty: row.service_invoice_party_id ? { id: row.service_invoice_party_id, name: getPersonName(row.service_invoice_party_id) } : d.serviceInvoiceParty,
                    linkedInvoices: [] // Yeni köprü eşleştirmesi için boş alan
                };
            }) : [];

            await this._fetchTasksInBatches();
            await this._fetchIpRecordsInBatches();

            // 🔥 ÇÖZÜM 2: Faturaları tahakkuklarla YENİ KÖPRÜ TABLOSU üzerinden bağlıyoruz
            this.allInvoices = invRes.data ? invRes.data.map(row => {
                const myAccrualIds = this.accrualInvoicesLinks
                    .filter(l => String(l.invoice_id) === String(row.id))
                    .map(l => String(l.accrual_id));

                return {
                    id: String(row.id),
                    kolaybiInvoiceId: row.kolaybi_invoice_id,
                    invoiceNo: row.invoice_no || '-',
                    invoiceDate: row.invoice_date || null,
                    kolaybiStatus: row.kolaybi_status || null, 
                    kolaybiUuid: row.kolaybi_uuid || null, 
                    status: row.status || 'draft',
                    totalAmount: row.total_amount || 0,
                    currency: row.currency || 'TRY',
                    clientId: row.client_id,
                    clientName: getPersonName(row.client_id) || 'Bilinmiyor',
                    createdAt: row.created_at ? new Date(row.created_at) : new Date(0),
                    
                    accruals: this.allAccruals
                        .filter(a => myAccrualIds.includes(String(a.id)))
                        .map(a => ({ ...a, task_title: a.taskTitle, total_amount: a.totalAmount }))
                };
            }) : [];

            // 🔥 ÇÖZÜM 3: Tahakkuklara bağlı olan fatura numaralarını yazdırıyoruz
            this.allAccruals.forEach(acc => {
                const myInvoiceIds = this.accrualInvoicesLinks
                    .filter(l => String(l.accrual_id) === String(acc.id))
                    .map(l => String(l.invoice_id));

                acc.linkedInvoices = this.allInvoices.filter(inv => myInvoiceIds.includes(String(inv.id)));

                if (acc.linkedInvoices.length > 0) {
                    const nos = acc.linkedInvoices.map(inv => {
                        return (inv.invoiceNo && inv.invoiceNo !== '-') ? inv.invoiceNo : null;
                    }).filter(Boolean); 

                    if (nos.length > 0) {
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
                // 🔥 YENİ KOD: Marka detayı diziyse ilk elemanı, objeyse doğrudan kendini alır (Hata önleyici)
                const tmDetails = row.ip_record_trademark_details ? (Array.isArray(row.ip_record_trademark_details) ? row.ip_record_trademark_details[0] : row.ip_record_trademark_details) : {};
                
                const item = {
                    id: String(row.id),
                    applicationNumber: String(row.application_number || row.file_no || '-'),
                    // 🔥 YENİ KOD: Sizin ilettiğiniz JSON formatındaki "brand_name" değerini burada yakalar
                    markName: String(row.brand_name || row.mark_name || tmDetails?.brand_name || row.title || row.court_name || '-')
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

        if (tab === 'invoices') {
            let invData = [...(this.allInvoices || [])];
            
            if (filters) {
                if (filters.invoiceStatus && filters.invoiceStatus !== 'all') {
                    const searchStatus = filters.invoiceStatus.toLowerCase();
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
                if (filters.party) {
                    const searchVal = filters.party.toLowerCase();
                    invData = invData.filter(inv => (inv.clientName || '').toLowerCase().includes(searchVal));
                }
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
            if (filters.department && filters.department !== '') {
                data = data.filter(item => (item.department || 'EVREKA') === filters.department);
            }
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
                    // 🔥 ÇÖZÜM 4: Filtrelemede yeni köprü objesini kullanıyoruz
                    const linkedInvoices = item.linkedInvoices || [];
                    
                    if (searchStatus === 'not_invoiced') {
                        if (linkedInvoices.length === 0) return true;
                        
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

            if (filters.description) {
                const searchVal = filters.description.toLowerCase();
                data = data.filter(item => {
                    const desc1 = (item.description || '').toLowerCase();
                    const desc2 = (item.invoiceDescription || '').toLowerCase();
                    return desc1.includes(searchVal) || desc2.includes(searchVal);
                });
            }

            // 🔥 YENİ: YURTDIŞI ÖDEME BELGESİ FİLTRESİ
            if (filters.foreignReceipt && filters.foreignReceipt !== 'all') {
                data = data.filter(item => {
                    const hasPdf = item.files && item.files.some(f => f.type === 'application/pdf');
                    return filters.foreignReceipt === 'yes' ? hasPdf : !hasPdf;
                });
            }

            // 🔥 YENİ: MÜŞAVİRE GÖNDERİM FİLTRESİ
            if (filters.foreignAdvisor && filters.foreignAdvisor !== 'all') {
                data = data.filter(item => {
                    const isSent = item.sentToAdvisor === true;
                    return filters.foreignAdvisor === 'yes' ? isSent : !isSent;
                });
            }
        }

        if (sort && sort.column) {
            data.sort((a, b) => {
                let valA = a[sort.column]; let valB = b[sort.column];
                
                if (sort.column === 'id') {
                    valA = Number(a.id) || 0;
                    valB = Number(b.id) || 0;
                }
                else if (sort.column === 'party') {
                    const getP = (item) => item.tpInvoiceParty?.name || item.serviceInvoiceParty?.name || '';
                    valA = getP(a).toLowerCase();
                    valB = getP(b).toLowerCase();
                }
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
                else if (sort.column === 'totalAmount') {
                    const getT = (item) => {
                        if (Array.isArray(item.totalAmount)) return item.totalAmount.reduce((sum, x) => sum + (Number(x.amount)||0), 0);
                        return Number(item.totalAmount) || 0;
                    };
                    valA = getT(a);
                    valB = getT(b);
                }
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
            task_id: null, 
            status: 'unpaid',
            department: formData.department || 'EVREKA', 
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
            requires_invoice: formData.requiresInvoice !== false,
            description: formData.subject ? `Konu: ${formData.subject}\nNot: ${formData.description || ''}` : (formData.description || null),
            invoice_description: formData.invoice_description || formData.invoiceDescription || null, 
            tpe_invoice_no: formData.tpeInvoiceNo || null,
            evreka_invoice_no: formData.evrekaInvoiceNo || null,
            order_code: formData.orderCode || null,
        };

        const { error: accError } = await supabase.from('accruals').insert(finalAccrual);
        if (accError) throw accError;

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
            invoice_description: formData.invoice_description || formData.invoiceDescription || null,
            tpe_invoice_no: formData.tpeInvoiceNo || null,
            evreka_invoice_no: formData.evrekaInvoiceNo || null,
            order_code: formData.orderCode || null,
            totalAmount: newTotalArray,
            remainingAmount: (formData.status || currentAccrual.status) === 'unpaid' ? newTotalArray : ((formData.status || currentAccrual.status) === 'paid' ? [] : currentAccrual.remainingAmount),
            files: fileToUpload ? [fileToUpload] : formData.files
        };

        const res = await accrualService.updateAccrual(accrualId, payload);
        if (!res.success) throw new Error(res.error);
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

        let formattedDate = null;
        if (date) {
            const parts = date.split('.');
            if (parts.length === 3) formattedDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
            else formattedDate = date; 
        }

        for (const id of ids) {
            const acc = this.allAccruals.find(a => a.id === id);
            if (!acc) continue;

            let updates = {};

            if (isForeignTab) {
                if (ids.length === 1 && singlePaymentDetails) {
                    const { payFullForeign, manualPayments } = singlePaymentDetails;

                    // 1. Yeni Kolondan Kalanı Al (Eğer eski bir kayıt ise veya ilk defa giriliyorsa geçmişten hesapla)
                    let currentRemaining = Array.isArray(acc.foreignRemainingAmount) && acc.foreignRemainingAmount.length > 0 
                                            ? acc.foreignRemainingAmount 
                                            : [];

                    if (currentRemaining.length === 0 && acc.foreignStatus !== 'paid') {
                        let expectedForeignTotals = {};
                        let foreignItems = (acc.items || []).filter(i => i.fee_type === 'Yurtdışı Maliyet');
                        if (foreignItems.length === 0) foreignItems = (acc.items || []).filter(i => i.fee_type !== 'Hizmet');

                        if (foreignItems.length > 0) {
                            foreignItems.forEach(i => {
                                const c = i.currency || 'EUR';
                                const amt = Number(i.total_amount) || 0;
                                const vatMult = acc.applyVatToOfficialFee ? (1 + (Number(i.vat_rate || acc.vatRate || 0) / 100)) : 1;
                                expectedForeignTotals[c] = (expectedForeignTotals[c] || 0) + (amt * vatMult);
                            });
                        } else {
                            const c = acc.officialFee?.currency || 'EUR';
                            const amt = parseFloat(acc.officialFee?.amount) || 0;
                            const vatMult = acc.applyVatToOfficialFee ? (1 + (acc.vatRate || 0) / 100) : 1;
                            if (amt > 0) expectedForeignTotals[c] = amt * vatMult;
                        }
                        Object.entries(expectedForeignTotals).forEach(([c, a]) => {
                            currentRemaining.push({ amount: a, currency: c });
                        });
                    }

                    // 2. Kolay matematik için Map'e çevir
                    let newRemainingMap = {};
                    currentRemaining.forEach(r => newRemainingMap[r.currency] = parseFloat(r.amount) || 0);

                    if (payFullForeign) {
                        // Tamamını ödediyse borçları sıfırla
                        Object.keys(newRemainingMap).forEach(c => newRemainingMap[c] = 0);
                        updates.foreign_status = 'paid';
                    } else {
                        // Kısmi Ödeme yapılıyorsa bakiyeden tek tek düş
                        manualPayments.forEach(mp => {
                            if (newRemainingMap[mp.curr] !== undefined) {
                                newRemainingMap[mp.curr] = Math.max(0, newRemainingMap[mp.curr] - mp.amount);
                            }
                        });
                        updates.foreign_status = 'unpaid'; 
                    }

                    // 3. Map'i tekrar veritabanı formatına (JSON Array) Çevir
                    updates.foreignRemainingAmount = [];
                    Object.entries(newRemainingMap).forEach(([c, a]) => {
                        if (a > 0.01) updates.foreignRemainingAmount.push({ amount: Number(a.toFixed(2)), currency: c });
                    });

                    // 4. Genel Statüyü Kalan Bakiyeye Göre Akıllıca Belirle
                    if (updates.foreignRemainingAmount.length === 0) {
                        updates.foreign_status = 'paid'; 
                    } else {
                        let originalTotal = 0, currentRemTotal = 0;
                        currentRemaining.forEach(x => originalTotal += Number(x.amount) || 0);
                        updates.foreignRemainingAmount.forEach(x => currentRemTotal += Number(x.amount) || 0);

                        if (currentRemTotal < originalTotal && currentRemTotal > 0.01) updates.foreign_status = 'partially_paid';
                        else if (currentRemTotal <= 0.01) updates.foreign_status = 'paid';
                        else updates.foreign_status = 'unpaid';
                    }
                    
                    if (formattedDate && (updates.foreign_status === 'paid' || updates.foreign_status === 'partially_paid')) {
                        updates.foreign_payment_date = formattedDate;
                    }
                    
                } else {
                    updates.foreign_status = 'paid';
                    updates.foreignRemainingAmount = [];
                    if (formattedDate) updates.foreign_payment_date = formattedDate;
                }
            } else {
                // Yurtiçi (Müşteri) Mantığı Aynen Korunuyor...
                if (ids.length === 1 && singlePaymentDetails) {
                    updates.paymentDate = formattedDate;
                    const { payFullOfficial, payFullService, manualOfficial, manualService } = singlePaymentDetails;
                    
                    const partyId = acc.tpInvoiceParty?.id || acc.tp_invoice_party_id;
                    const person = partyId ? this.allPersons.find(p => String(p.id) === String(partyId)) : null;
                    const isTevkifatli = person ? (person.has_tevkifat === true) : false;
                    const taxNo = person ? (person.taxNo || person.tax_no || person.tckn || '') : '';
                    const isCorporate = taxNo.length !== 11;

                    // Orijinal hedefleri hesapla
                    let dynamicOffTarget = 0;
                    let dynamicSrvTarget = 0;

                    const items = acc.items || [];
                    if (items.length > 0) {
                        items.forEach(i => {
                            const qty = Number(i.quantity) || 1;
                            const price = Number(i.unit_price) || 0;
                            const vat = Number(i.vat_rate) || 0;
                            const feeType = i.fee_type || '';
                            let amt = 0;

                            if (acc.department === 'HUKUK' && (feeType === 'Hukuk Danışmanlık' || feeType === 'Hizmet')) {
                                if (isCorporate) {
                                    const grossPrice = price / 0.8; 
                                    amt = (qty * grossPrice) * (1 + (vat / 100) - 0.20); 
                                } else {
                                    amt = (qty * price) * (1 + (vat / 100)); 
                                }
                            } else if (isTevkifatli && (feeType === 'Hizmet' || feeType === 'Hukuk Danışmanlık')) {
                                amt = (qty * price) * (1 + (vat * 0.1) / 100); 
                            } else {
                                amt = (qty * price) * (1 + (vat / 100)); 
                            }

                            if (feeType === 'Hizmet' || feeType === 'Hukuk Danışmanlık') {
                                dynamicSrvTarget += amt;
                            } else {
                                dynamicOffTarget += amt;
                            }
                        });
                    } else {
                        const vatMultiplier = 1 + ((acc.vatRate || 0) / 100);
                        dynamicOffTarget = acc.applyVatToOfficialFee ? (acc.officialFee?.amount || 0) * vatMultiplier : (acc.officialFee?.amount || 0);
                        dynamicSrvTarget = (acc.serviceFee?.amount || 0) * vatMultiplier;
                    }

                    // 🔥 ÇÖZÜM: MEVCUT (KALAN) HEDEFLERİ BELİRLE
                    let currentRemOff = dynamicOffTarget;
                    let currentRemSrv = dynamicSrvTarget;

                    if (acc.status === 'partially_paid' && Array.isArray(acc.remainingAmount) && acc.remainingAmount.length > 0) {
                        const remData = acc.remainingAmount[0];
                        if (remData.remOff !== undefined && remData.remSrv !== undefined) {
                            currentRemOff = remData.remOff;
                            currentRemSrv = remData.remSrv;
                        } else {
                            // Eski kayıtlar için fallback
                            const totalRem = Number(remData.amount) || 0;
                            if (totalRem < dynamicSrvTarget) {
                                currentRemSrv = totalRem;
                                currentRemOff = 0;
                            } else {
                                currentRemSrv = dynamicSrvTarget;
                                currentRemOff = Math.max(0, totalRem - dynamicSrvTarget);
                            }
                        }
                    }

                    // ŞİMDİ YAPILAN ÖDEME TUTARI (Artık orijinal değil, güncel kalan hedeflere göre bakılıyor)
                    const newPaidOff = payFullOfficial ? currentRemOff : (parseFloat(manualOfficial) || 0);
                    const newPaidSrv = payFullService ? currentRemSrv : (parseFloat(manualService) || 0);

                    // YENİ KALAN BAKİYE
                    const remOff = Math.max(0, currentRemOff - newPaidOff);
                    const remSrv = Math.max(0, currentRemSrv - newPaidSrv);

                    const remMap = {};
                    const offCurr = acc.officialFee?.currency || 'TRY';
                    const srvCurr = acc.serviceFee?.currency || 'TRY';

                    if (remOff > 0.01) {
                        if (!remMap[offCurr]) remMap[offCurr] = { amount: 0, remOff: 0, remSrv: 0 };
                        remMap[offCurr].amount += remOff;
                        remMap[offCurr].remOff += remOff;
                    }
                    if (remSrv > 0.01) {
                        if (!remMap[srvCurr]) remMap[srvCurr] = { amount: 0, remOff: 0, remSrv: 0 };
                        remMap[srvCurr].amount += remSrv;
                        remMap[srvCurr].remSrv += remSrv;
                    }

                    // JSON formatını güncelliyoruz: Sadece total amount değil, remOff ve remSrv detaylarını da DB'ye yazıyoruz
                    updates.remainingAmount = Object.entries(remMap).map(([c, data]) => ({ 
                        amount: Number(data.amount.toFixed(2)), 
                        currency: c,
                        remOff: Number(data.remOff.toFixed(2)),
                        remSrv: Number(data.remSrv.toFixed(2))
                    }));

                    if (updates.remainingAmount.length === 0) updates.status = 'paid';
                    else if (newPaidOff > 0 || newPaidSrv > 0 || acc.status === 'partially_paid') updates.status = 'partially_paid';
                    else updates.status = 'unpaid';
                }
                else {
                    updates.status = 'paid';
                    updates.remainingAmount = [];
                    updates.paymentDate = formattedDate;
                }
            }

            // Dekont Yükleme...
            if (receiptFiles && receiptFiles.length > 0) {
                const docInserts = [];
                for (const fileObj of receiptFiles) {
                    const file = fileObj.file || fileObj;
                    const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                    const cleanPath = `accruals/${id}/${Date.now()}_${cleanFileName}`;

                    const { error: uploadError } = await supabase.storage.from('documents').upload(cleanPath, file, { cacheControl: '3600', upsert: true });
                    if (!uploadError) {
                        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(cleanPath);
                        if (urlData && urlData.publicUrl) {
                            // Dosya adının başına ödeme yapılan tarihi ekleyerek şık bir görünüm sağlıyoruz
                            const displayDate = date ? date : new Date().toLocaleDateString('tr-TR');
                            const displayName = `${displayDate} Ödemesi - ${file.name}`;
                            
                            docInserts.push({ 
                                accrual_id: String(id), 
                                document_name: displayName, 
                                document_url: urlData.publicUrl, 
                                document_type: 'Ödeme Dekontu' 
                            });
                        }
                    }
                }
                if (docInserts.length > 0) await supabase.from('accrual_documents').insert(docInserts);
            }

            // VERİTABANINA KAYDETME
            if (isForeignTab) {
                const dbPayload = { 
                    foreign_status: updates.foreign_status,
                    foreign_remaining_amount: updates.foreignRemainingAmount // 🔥 EKLENDİ
                };
                if (updates.foreign_payment_date) dbPayload.foreign_payment_date = updates.foreign_payment_date;

                const { error: dbUpdateError } = await supabase.from('accruals').update(dbPayload).eq('id', id);
                if (dbUpdateError) throw new Error('Güncelleme hatası: ' + dbUpdateError.message);
            } else {
                const res = await accrualService.updateAccrual(id, updates);
                if (!res.success) throw new Error('Tahakkuk statüsü güncellenemedi: ' + res.error);
            }
        }

        await this.fetchAllData();
    }

    async batchUpdateStatus(selectedIds, newStatus, isForeignTab = false) {
        const ids = Array.from(selectedIds);
        const promises = ids.map(async (id) => {
            const acc = this.allAccruals.find(a => a.id === id);
            if (!acc) return;
            
            if (isForeignTab) {
                const payload = { foreign_status: newStatus };
                // 🔥 1. ÇÖZÜM: Ödenmedi yapılıyorsa kalan tutar dizisini sıfırla. 
                // Sistem boş diziyi görünce otomatik olarak faturanın orijinal "Tam Tutarına" dönecektir.
                if (newStatus === 'unpaid') {
                    payload.foreign_payment_date = null; 
                    payload.foreign_remaining_amount = []; 
                }
                
                return supabase.from('accruals').update(payload).eq('id', id);
            } else {
                const updates = { status: newStatus };
                if (newStatus === 'unpaid') {
                    updates.paymentDate = null;
                    updates.remainingAmount = acc.totalAmount;
                }
                return accrualService.updateAccrual(id, updates);
            }
        });

        await Promise.all(promises);
        await this.fetchAllData();
    }

    async deleteAccrual(id) {
        const { data: docs } = await supabase.from('accrual_documents').select('document_url').eq('accrual_id', String(id));
        if (docs && docs.length > 0) {
            for (const doc of docs) {
                if (doc.document_url && doc.document_url.includes('/documents/')) {
                    let filePath = doc.document_url.split('/documents/')[1];
                    await supabase.storage.from('documents').remove([decodeURIComponent(filePath)]);
                }
            }
        }
        
        await supabase.from('accruals').delete().eq('id', id);
        await this.fetchAllData();
    }

    async deleteDocument(documentId, fileUrl) {
        return await accrualService.deleteDocumentFully(documentId, fileUrl);
    }

    async markAsSentToAdvisor(accrualIds) {
        if (!accrualIds || accrualIds.length === 0) return;
        
        const promises = accrualIds.map(id => 
            supabase.from('accruals').update({ sent_to_advisor: true }).eq('id', String(id))
        );
        
        await Promise.all(promises);
    }

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

            if (!data.success && !data.requireMergeDecision) {
                throw new Error(data.error || data.message || "Beklenmeyen bir hata oluştu.");
            }

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

        const finalKeywords = ['approved', 'rejected', 'cancelled', 'failed', 'accept', 'decline', 'kabul', 'red', 'iptal'];

        const pendingIds = this.allInvoices
            .filter(inv => {
                const kId = String(inv.kolaybiInvoiceId);
                if (!inv.kolaybiInvoiceId || kId === 'undefined' || kId === 'null') return false;
                
                const s = (inv.status || '').toLowerCase().trim();
                const ks = (inv.kolaybiStatus || '').toLowerCase().trim();
                
                const isFinal = finalKeywords.some(word => s.includes(word) || ks.includes(word));
                if (isFinal) return false;

                return true; 
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
                    department: accrualData.department, 
                    amount: accrualData.amount,
                    currency: accrualData.currency,
                    period: accrualData.period,
                    start_date: accrualData.startDate,
                    next_trigger_date: accrualData.startDate,
                    description: accrualData.description,
                    is_active: true,
                    items: accrualData.items 
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
                    department: accrualData.department, 
                    amount: accrualData.amount,
                    currency: accrualData.currency,
                    period: accrualData.period,
                    start_date: accrualData.startDate,
                    description: accrualData.description,
                    items: accrualData.items 
                })
                .eq('id', id)
                .select();
            if (error) throw error;
            return { success: true, data: data[0] };
        } catch (error) { throw new Error(error.message); }
    }
}