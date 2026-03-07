// public/js/indexing/document-review-manager.js

import { 
    authService, 
    ipRecordsService, 
    transactionTypeService, 
    taskService,
    supabase,
    mailService
} from '../../supabase-config.js';

import { 
    showNotification, 
    debounce, 
    addMonthsToDate, 
    findNextWorkingDay, 
    isWeekend, 
    isHoliday, 
    TURKEY_HOLIDAYS,
    generateUUID,
    formatToTRDate
} from '../../utils.js';
import '../simple-loading.js';

const INCOMING_DOCS_COLLECTION = 'incoming_documents';
const STORAGE_BUCKET = 'documents';

// ⚠️ LÜTFEN DİKKAT: Eski Firebase UID'si (dqk6...) Supabase'de ÇALIŞMAZ. 
// Görevlerin (Task) doğru kişiye atanması için Selcan Hanım'ın Supabase'deki yeni UUID'sini buraya yapıştırın.
const SELCAN_UID = 'dqk6yRN7Kwgf6HIJldLt9Uz77RU2'; 
const SELCAN_EMAIL = 'selcanakoglu@evrekapatent.com';

export class DocumentReviewManager {
    constructor() {
        this.pdfId = new URLSearchParams(window.location.search).get('pdfId');
        const params = new URLSearchParams(window.location.search);
        this.prefillRecordId = params.get('recordId');     
        this.prefillQuery = params.get('q');               
        this.prefillDeliveryDate = params.get('deliveryDate'); 
        this.currentUser = null;
        this.pdfData = null;
        this.matchedRecord = null;
        this.analysisResult = null;
        this.currentTransactions = []; 
        this.allTransactionTypes = []; 
        this.countryMap = new Map();
        this.init();
    }

    toYMD(raw) {
        if (!raw) return '';
        let d = raw;

        if (typeof d === 'string') {
            if (d.includes('T')) d = d.split('T')[0]; 
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
            
            const parts = d.split(/[\.\/]/);
            if (parts.length === 3) {
                return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
            }
        }

        if (!(d instanceof Date)) d = new Date(d);
        if (isNaN(d.getTime())) return '';

        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    async init() {
        const params = new URLSearchParams(window.location.search);
        this.pdfId = params.get('pdfId');
        this.prefillRecordId = params.get('recordId');
        this.prefillQuery = params.get('q');
        this.prefillDeliveryDate = params.get('deliveryDate');

        this.matchedRecord = null;
        this.pdfData = null;
        this.currentTransactions = [];
        this.analysisResult = null;

        const searchInput = document.getElementById('manualSearchInput');
        if (searchInput) {
            searchInput.value = '';
            searchInput.removeAttribute('data-temp');
        }

        if (!this.pdfId) {
            console.error("PDF ID bulunamadı.");
            return;
        }

        const session = await authService.getCurrentSession();
        this.currentUser = session?.user || null;

        if (!this.currentUser) {
            console.error("Oturum bulunamadı, işlem durduruldu.");
            return;
        }

        this.setupEventListeners();
        if (window.EvrekaDatePicker) window.EvrekaDatePicker.refresh();
        await this.loadCountriesOnly();
        await this.loadTransactionTypes();
        await this.loadAllRecords(); 
        await this.loadData();
    }

    async loadAllRecords() {
        try {
            const recordsResult = await ipRecordsService.getRecords();
            this.allRecords = recordsResult?.data || recordsResult?.items || recordsResult || [];
        } catch (error) {
            console.error('Kayıtlar yüklenirken hata oluştu:', error);
        }
    }

    async loadCountriesOnly() {
        try {
            const { data, error } = await supabase.from('common').select('data').eq('id', 'countries').single();
            if (!error && data && data.data && data.data.list) {
                data.data.list.forEach(c => this.countryMap.set(c.code, c.name));
            }
        } catch (e) { console.error("Ülke listesi yüklenemedi:", e); }
    }

    async loadTransactionTypes() {
        try {
            const { data: txTypes, error } = await supabase.from('transaction_types').select('*');
            if (error) throw error;
            this.allTransactionTypes = txTypes || [];
        } catch (error) { 
            console.error('İşlem tipleri yüklenemedi:', error); 
        }
    }

    async extractTextFromPDF(url) {
        try {
            if (!window.pdfjsLib) {
                console.warn('PDF.js kütüphanesi bulunamadı.');
                return null;
            }

            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

            const loadingTask = pdfjsLib.getDocument(url);
            const pdf = await loadingTask.promise;
            let fullText = '';

            const maxPages = Math.min(pdf.numPages, 3);
            for (let i = 1; i <= maxPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                fullText += pageText + ' ';
            }

            return fullText;
        } catch (error) {
            console.error('PDF metin okuma hatası:', error);
            return null;
        }
    }

    findRegistrationDate(text) {
        if (!text) return null;
        const regex = /(\d{1,2}[\.\/]\d{1,2}[\.\/]\d{4})\s+tarihinde\s+tescil\s+edilmiştir/i;
        const match = text.match(regex);
        if (match && match[1]) return match[1]; 
        return null;
    }

    findRegistrationNumber(text) {
        if (!text) return null;
        const regex = /No\s*[:.]?\s*(\d{4}[\s\d]+)/i;
        const match = text.match(regex);
        if (match && match[1]) return match[1].trim(); 
        return null;
    }

    setupEventListeners() {
        const saveBtn = document.getElementById('saveTransactionBtn');
        if (saveBtn) {
            const newSaveBtn = saveBtn.cloneNode(true);
            saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
            newSaveBtn.addEventListener('click', (e) => { e.preventDefault(); this.handleSave(); });
        }

        const searchInput = document.getElementById('manualSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', debounce((e) => this.handleManualSearch(e.target.value), 300));
            document.addEventListener('click', (e) => {
                const searchResults = document.getElementById('manualSearchResults');
                if (searchResults && !searchInput.contains(e.target) && !searchResults.contains(e.target)) {
                    searchResults.style.display = 'none';
                }
            });
        }

        const parentSelect = document.getElementById('parentTransactionSelect');
        if (parentSelect) parentSelect.addEventListener('change', () => this.updateChildTransactionOptions());

        const childSelect = document.getElementById('detectedType');
        const dateInput = document.getElementById('detectedDate');
        
        if (childSelect) {
            childSelect.addEventListener('change', () => {
                this.checkSpecialFields();      
                this.updateCalculatedDeadline(); 
            });
        }
        
        if (dateInput) {
            dateInput.addEventListener('change', () => {
                this.updateCalculatedDeadline(); 
            });
        }

        this._setupPdfDropzone('oppositionPetitionDropzone', 'oppositionPetitionFile', 'oppositionPetitionFileName');
        this._setupPdfDropzone('oppositionEpatsDropzone', 'oppositionEpatsPetitionFile', 'oppositionEpatsFileName');
    }

    _setupPdfDropzone(dropzoneId, inputId, filenameLabelId) {
        const dz = document.getElementById(dropzoneId);
        const input = document.getElementById(inputId);
        const fileLabel = document.getElementById(filenameLabelId);
        if (!dz || !input) return;

        const setFilename = (name) => {
            if (fileLabel) fileLabel.textContent = name || 'Dosya seçilmedi';
        };

        dz.addEventListener('click', () => input.click());
        dz.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
        });

        input.addEventListener('change', () => {
            const f = input.files && input.files[0];
            setFilename(f ? f.name : 'Dosya seçilmedi');
        });

        const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };

        ['dragenter', 'dragover'].forEach(evt => dz.addEventListener(evt, (e) => { prevent(e); dz.classList.add('drag-over'); }));
        ['dragleave', 'drop'].forEach(evt => dz.addEventListener(evt, (e) => { prevent(e); dz.classList.remove('drag-over'); }));

        dz.addEventListener('drop', (e) => {
            const files = e.dataTransfer?.files;
            if (!files || !files.length) return;
            const file = files[0];
            if (files.length > 1) showNotification('Birden fazla dosya bırakıldı. İlk dosya seçildi.', 'warning');
            
            if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
                showNotification('Lütfen sadece PDF dosyası yükleyin.', 'error');
                return;
            }
            try {
                const dt = new DataTransfer();
                dt.items.add(file);
                input.files = dt.files;
            } catch (err) {}
            setFilename(file.name);
        });
    }

    updateCalculatedDeadline() {
        const dateVal = document.getElementById('detectedDate')?.value;
        const typeId = document.getElementById('detectedType')?.value;
        const displayInput = document.getElementById('calculatedDeadlineDisplay');
        
        if (!dateVal || !typeId || !displayInput) {
            if(displayInput) displayInput.value = "";
            return;
        }

        const typeObj = this.allTransactionTypes.find(t => String(t.id) === String(typeId));
        let duePeriod = typeObj ? (typeObj.due_period !== undefined ? typeObj.due_period : typeObj.duePeriod) : 0;
        duePeriod = Number(duePeriod) || 0;

        if (!typeObj || duePeriod === 0) {
            displayInput.value = "Son Süre Hesaplanmaz";
            return;
        }

        const deliveryDate = new Date(dateVal);
        let officialDate = addMonthsToDate(deliveryDate, duePeriod);
        officialDate = findNextWorkingDay(officialDate, TURKEY_HOLIDAYS);
        
        displayInput.value = officialDate.toLocaleDateString('tr-TR');
    }

    async loadData() {
        if (window.SimpleLoadingController && typeof window.SimpleLoadingController.show === 'function') {
            window.SimpleLoadingController.show({ text: 'PDF yükleniyor', subtext: 'Belge hazırlanıyor, lütfen bekleyin...' });
        }

        try {
            const { data: docSnap, error } = await supabase.from(INCOMING_DOCS_COLLECTION).select('*').eq('id', String(this.pdfId)).single();
            if (error || !docSnap) throw new Error('PDF kaydı bulunamadı.');
            
            this.pdfData = { 
                id: docSnap.id, 
                ...docSnap,
                fileName: docSnap.file_name,
                fileUrl: docSnap.file_url,
                matchedRecordId: docSnap.ip_record_id,
                tebligTarihi: docSnap.teblig_tarihi 
            };

            if (this.pdfData.fileUrl || this.pdfData.downloadURL) {
                const pdfUrl = this.pdfData.fileUrl || this.pdfData.downloadURL;
                this.extractTextFromPDF(pdfUrl).then(text => {
                    if (text) {
                        const regNo = this.findRegistrationNumber(text);
                        if (regNo) {
                            this.extractedRegNo = regNo;
                            const regNoInput = document.getElementById('registry-registration-no');
                            if (regNoInput && regNoInput.offsetParent !== null) {
                                regNoInput.value = regNo;
                                regNoInput.dispatchEvent(new Event('input'));
                            }
                        }

                        const regDate = this.findRegistrationDate(text);
                        if (regDate) {
                            this.extractedRegDate = regDate;
                            const regDateInput = document.getElementById('registry-registration-date');
                            if (regDateInput && regDateInput.offsetParent !== null) { 
                                regDateInput.value = regDate;
                                if(regDateInput._flatpickr) regDateInput._flatpickr.setDate(regDate, true);
                                showNotification(`Tescil tarihi ve numarası belgeden okundu.`, 'info');
                            }
                        }
                    }
                });
            } 

            const dateInput = document.getElementById('detectedDate');
            if (dateInput) {
                const ymd = this.prefillDeliveryDate || this.toYMD(this.pdfData.tebligTarihi);
                if (ymd) {
                    dateInput.value = ymd;
                    if (dateInput._flatpickr) dateInput._flatpickr.setDate(ymd, true);
                } else {
                    dateInput.value = '';
                    if (dateInput._flatpickr) dateInput._flatpickr.clear();
                }
            }

            const searchInput = document.getElementById('manualSearchInput');
            if (searchInput && this.prefillQuery) {
                searchInput.value = this.prefillQuery;
                await this.handleManualSearch(this.prefillQuery);
            }

            const pdfViewerEl = document.getElementById('pdfViewer');
            if (pdfViewerEl) {
                const onLoaded = () => {
                    if (window.SimpleLoadingController && typeof window.SimpleLoadingController.hide === 'function') {
                        window.SimpleLoadingController.hide();
                    }
                    pdfViewerEl.removeEventListener('load', onLoaded);
                };
                pdfViewerEl.addEventListener('load', onLoaded);

                const pdfUrl = this.pdfData.fileUrl || this.pdfData.downloadURL;
                if (pdfUrl) pdfViewerEl.src = pdfUrl;
                else {
                    if (window.SimpleLoadingController) window.SimpleLoadingController.hide();
                }
            } else {
                if (window.SimpleLoadingController) window.SimpleLoadingController.hide();
            }
     
            if (this.prefillRecordId) {
                await this.selectRecord(this.prefillRecordId);
            } else if (this.pdfData.matchedRecordId) {
                await this.selectRecord(this.pdfData.matchedRecordId);
            } else {
                this.renderHeader();
            }

            if (this.pdfData.status === 'indexed') {
                showNotification('⚠️ DİKKAT: Bu belge daha önce indekslenmiş!', 'warning');
            }

        } catch (error) {
            console.error('Veri yükleme hatası:', error);
            showNotification('Veri yükleme hatası: ' + error.message, 'error');
            if (window.SimpleLoadingController) window.SimpleLoadingController.hide();
        }
    }

    async selectRecord(recordId) {
        try {
            const result = await ipRecordsService.getRecordById(recordId);
            if (result.success) {
                this.matchedRecord = result.data;

                const manualSearchInput = document.getElementById('manualSearchInput');
                if (manualSearchInput) {
                    manualSearchInput.value = this.matchedRecord.applicationNumber || this.matchedRecord.application_number || '';
                }

                let namesList = [];
                const rawApps = this.matchedRecord.applicants || this.matchedRecord.owners || [];
                
                for (const app of rawApps) {
                    if (typeof app === 'string') {
                        namesList.push(app);
                    } else if (app && typeof app === 'object') {
                        if (app.name || app.applicantName) {
                            namesList.push(app.name || app.applicantName);
                        } else if (app.id) {
                            try {
                                const { data: pData } = await supabase.from('persons').select('*').eq('id', String(app.id)).single();
                                if (pData) namesList.push(pData.name || pData.company_name || pData.details?.companyName || '-');
                            } catch (e) {}
                        }
                    }
                }
                
                this.matchedRecord.resolvedNames = namesList.length > 0 ? namesList.join(', ') : '-';
                this.renderHeader(); 
                await this.loadParentTransactions(recordId);
                showNotification('Kayıt seçildi: ' + this.matchedRecord.title, 'success');

                document.dispatchEvent(new CustomEvent('record-selected', { detail: { recordId: recordId } }));
            }
        } catch (error) { console.error('Kayıt seçim hatası:', error); }
    }

    async loadParentTransactions(recordId) {
        const parentSelect = document.getElementById('parentTransactionSelect');
        if (!parentSelect) return;
        
        parentSelect.innerHTML = '<option value="">Yükleniyor...</option>';
        
        try {
            const transactionsResult = await ipRecordsService.getRecordTransactions(recordId);
            this.currentTransactions = transactionsResult.success ? transactionsResult.data : [];
            
            parentSelect.innerHTML = '<option value="">-- Ana İşlem Seçiniz --</option>';
            
            if (this.currentTransactions.length === 0) {
                const opt = document.createElement('option');
                opt.textContent = "(Kayıtlı işlem geçmişi yok)";
                opt.disabled = true;
                parentSelect.appendChild(opt);
                return;
            }

            const resolveDate = (item) => {
                try {
                    if (item.transaction_date) return new Date(item.transaction_date);
                    if (item.timestamp) return new Date(item.timestamp);
                    if (item.creationDate) return new Date(item.creationDate);
                    if (item.created_at) return new Date(item.created_at);
                    if (item.createdAt) return new Date(item.createdAt);
                } catch (e) { return null; }
                return null;
            };

            const parentTransactions = this.currentTransactions
                .filter(t => {
                    const h = t.transaction_hierarchy || t.transactionHierarchy;
                    return h === 'parent' || !h;
                })
                .sort((a, b) => {
                    const dateA = resolveDate(a);
                    const dateB = resolveDate(b);
                    return (dateB ? dateB.getTime() : 0) - (dateA ? dateA.getTime() : 0); 
                });

            for (const t of parentTransactions) {
                const typeId = t.transaction_type_id || t.type;
                const typeObj = this.allTransactionTypes.find(type => String(type.id) === String(typeId));
                let label = typeObj ? (typeObj.alias || typeObj.name) : (t.description || 'İşlem');
                
                const typeIdStr = String(typeId);
                const oppOwner = t.opposition_owner || t.oppositionOwner;

                if (typeIdStr === '20' || typeIdStr === '19' || oppOwner) {
                    let opponentName = null;

                    if (oppOwner) {
                        opponentName = oppOwner;
                    } else if (t.taskId || t.triggeringTaskId || t.task_id) {
                        const targetTaskId = t.taskId || t.triggeringTaskId || t.task_id;
                        try {
                            const taskResult = await taskService.getTaskById(targetTaskId);
                            if (taskResult.success && taskResult.data) {
                                const taskOwner = taskResult.data.taskOwner || taskResult.data.task_owner;
                                const ownerId = Array.isArray(taskOwner) ? taskOwner[0] : taskOwner;
                                
                                if (ownerId) {
                                    const { data: pData } = await supabase.from('persons').select('*').eq('id', String(ownerId)).single();
                                    if (pData) opponentName = pData.name || pData.company_name || null;
                                }
                            }
                        } catch (err) {}
                    }
                    if (opponentName) label += ` [İtiraz Eden: ${opponentName}]`;
                }

                const dateObj = resolveDate(t);
                const dateStr = formatToTRDate(dateObj);
                
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = `${label} (${dateStr})`;
                parentSelect.appendChild(opt);
            }
        } catch (error) {
            console.error('Transaction yükleme hatası:', error);
            parentSelect.innerHTML = '<option value="">Hata: İşlemler yüklenemedi</option>';
        }
    }

    updateChildTransactionOptions() {
        const parentSelect = document.getElementById('parentTransactionSelect');
        const childSelect = document.getElementById('detectedType');
        const selectedParentTxId = parentSelect.value;
        
        childSelect.innerHTML = '<option value="">-- İşlem Türü Seçiniz --</option>';
        childSelect.disabled = true;
        
        if (!selectedParentTxId) return;
        
        const selectedParentTx = this.currentTransactions.find(t => String(t.id) === String(selectedParentTxId));
        const parentTypeId = selectedParentTx?.transaction_type_id || selectedParentTx?.type;
        
        const parentTypeObj = this.allTransactionTypes.find(t => String(t.id) === String(parentTypeId));
        
        if (!parentTypeObj) return;
        
        let allowedChildIds = [];
        if (Array.isArray(parentTypeObj.index_file) && parentTypeObj.index_file.length > 0) {
            allowedChildIds = parentTypeObj.index_file.map(String);
        } else if (Array.isArray(parentTypeObj.indexFile) && parentTypeObj.indexFile.length > 0) {
            allowedChildIds = parentTypeObj.indexFile.map(String);
        } else if (Array.isArray(parentTypeObj.allowed_child_types) && parentTypeObj.allowed_child_types.length > 0) {
            allowedChildIds = parentTypeObj.allowed_child_types.map(String);
        }

        const allowedChildTypes = this.allTransactionTypes
            .filter(t => allowedChildIds.includes(String(t.id)))
            .sort((a, b) => (a.order_index || a.order || 999) - (b.order_index || b.order || 999));
            
        allowedChildTypes.forEach(type => {
            const opt = document.createElement('option');
            opt.value = type.id;
            opt.textContent = type.alias || type.name;
            childSelect.appendChild(opt);
        });
        
        if (allowedChildTypes.length > 0) {
            childSelect.disabled = false;
        }
    }

    checkSpecialFields() {
        const childSelect = document.getElementById('detectedType');
        const parentSelect = document.getElementById('parentTransactionSelect');
        if (!childSelect || !parentSelect) return;

        const childTypeId = String(childSelect.value);
        const parentTxId = String(parentSelect.value);

        const oppositionSection = document.getElementById('oppositionSection');
        if (oppositionSection) {
            oppositionSection.style.display = (childTypeId === '27') ? 'block' : 'none';
        }

        const registrationSection = document.getElementById('registry-editor-section'); 
        if (registrationSection) {
            let showRegistration = false;
            
            const selectedOption = childSelect.options[childSelect.selectedIndex];
            const childText = selectedOption ? selectedOption.text.toLowerCase() : '';

            if (childTypeId === '45' || childText.includes('tescil belgesi')) {
                showRegistration = true;
            } else if (childTypeId === '40') {
                if (this.currentTransactions && parentTxId) {
                    const parentTx = this.currentTransactions.find(t => String(t.id) === parentTxId);
                    if (parentTx) {
                        const parentType = String(parentTx.transaction_type_id || parentTx.type);
                        if (parentType === '6' || parentType === '17') showRegistration = true;
                    }
                }
            }
            
            registrationSection.style.display = showRegistration ? 'block' : 'none';
            
            const savePortfolioBtn = document.getElementById('save-portfolio-btn'); 
            const indexBtn = document.getElementById('saveTransactionBtn'); 

            if (showRegistration) {
                if (this.extractedRegNo) {
                    const regNoInput = document.getElementById('registry-registration-no');
                    if (regNoInput && !regNoInput.value) {
                        regNoInput.value = this.extractedRegNo;
                        regNoInput.dispatchEvent(new Event('input'));
                    }
                }
                if (this.extractedRegDate) {
                    const regDateInput = document.getElementById('registry-registration-date');
                    if (regDateInput && !regDateInput.value) {
                        regDateInput.value = this.extractedRegDate;
                        if (regDateInput._flatpickr) regDateInput._flatpickr.setDate(this.extractedRegDate, true);
                    }
                }
                
                const statusSelect = document.getElementById('registry-status') || document.getElementById('status');
                if (statusSelect) {
                    statusSelect.value = 'registered'; 
                    if (statusSelect.selectedIndex === -1) {
                        for (let i = 0; i < statusSelect.options.length; i++) {
                            if (statusSelect.options[i].text.toLowerCase().includes('tescilli')) {
                                statusSelect.selectedIndex = i;
                                break;
                            }
                        }
                    }
                    statusSelect.dispatchEvent(new Event('change'));
                }

                if (savePortfolioBtn && indexBtn) {
                    savePortfolioBtn.style.display = 'none'; 
                    indexBtn.innerHTML = '<i class="fas fa-save mr-2"></i>Kaydet ve İndeksle';
                    indexBtn.classList.remove('btn-primary');
                    indexBtn.classList.add('btn-success');
                }
            } else {
                if (savePortfolioBtn && indexBtn) {
                    savePortfolioBtn.style.display = 'inline-block'; 
                    indexBtn.innerHTML = '<i class="fas fa-check mr-2"></i>İndeksle';
                    indexBtn.classList.remove('btn-success');
                    indexBtn.classList.add('btn-primary');
                }
            }
        }
    }

    async _addTransaction(recordId, txData) {
        const txId = generateUUID();
        const payload = {
            id: txId,
            ip_record_id: recordId,
            transaction_type_id: String(txData.type),
            transaction_hierarchy: txData.transactionHierarchy || 'parent',
            parent_id: txData.parentId || null,
            description: txData.description || '',
            note: txData.notes || null,
            opposition_owner: txData.oppositionOwner || null,
            task_id: txData.taskId || null,
            transaction_date: txData.date || txData.timestamp || new Date().toISOString(),
            user_id: txData.userId || this.currentUser?.id, 
            user_email: txData.userEmail || this.currentUser?.email,
            user_name: txData.userName || this.currentUser?.user_metadata?.name || this.currentUser?.email,
            created_at: new Date().toISOString()
        };
        
        const { error } = await supabase.from('transactions').insert(payload);
        if (error) return { success: false, error: error.message };

        if (txData.documents && txData.documents.length > 0) {
            const docInserts = txData.documents.map(d => ({
                transaction_id: txId,
                document_name: d.name,
                document_url: d.url || d.downloadURL,
                document_type: d.type || 'application/pdf',
                document_designation: d.documentDesignation || 'Evrak',
                uploaded_at: d.uploadedAt || new Date().toISOString()
            }));
            await supabase.from('transaction_documents').insert(docInserts);
        }
        return { success: true, id: txId };
    }

    async handleSave() {
        if (!this.matchedRecord) { alert('Lütfen önce bir kayıt ile eşleştirin.'); return; }
        const parentTxId = document.getElementById('parentTransactionSelect').value;
        const childTypeId = document.getElementById('detectedType').value;
        const deliveryDateStr = document.getElementById('detectedDate').value;
        const notes = document.getElementById('transactionNotes').value;

        if (!parentTxId || !childTypeId || !deliveryDateStr) {
            showNotification('Lütfen tüm zorunlu alanları doldurun.', 'error');
            return;
        }

        // 🔥 ÇÖZÜM: IP Records güncellenirken "details" json'ı yerine sadece NATIVE SÜTUNLARA kayıt yapılır
        const regSection = document.getElementById('registry-editor-section');
        if (regSection && regSection.style.display !== 'none' && this.matchedRecord) {
            try {
                const regNoVal = document.getElementById('registry-registration-no')?.value;
                const regDateVal = document.getElementById('registry-registration-date')?.value;
                const statusVal = document.getElementById('registry-status')?.value || document.getElementById('status')?.value;

                const nativeUpdates = {};

                if (regNoVal) nativeUpdates.registration_number = regNoVal;
                if (regDateVal) nativeUpdates.registration_date = regDateVal;
                if (statusVal) nativeUpdates.status = statusVal;

                if (Object.keys(nativeUpdates).length > 0) {
                    await supabase.from('ip_records').update(nativeUpdates).eq('id', this.matchedRecord.id);
                    showNotification('Kayıt bilgileri güncellendi.', 'success');
                }
            } catch (err) {
                console.error("Kayıt güncelleme hatası:", err);
            }
        }

        const saveBtn = document.getElementById('saveTransactionBtn');
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> İşleniyor...';

        try {
            const childTypeObj = this.allTransactionTypes.find(t => String(t.id) === String(childTypeId));
            const parentTx = this.currentTransactions.find(t => String(t.id) === String(parentTxId));
            const parentTypeObj = this.allTransactionTypes.find(t => String(t.id) === String(parentTx?.transaction_type_id || parentTx?.type));

            let newParentTxId = null;
            let oppositionFileUrl = null;
            let oppositionFileName = null;
            let oppositionEpatsFileUrl = null;
            let oppositionEpatsFileName = null;

            if (String(childTypeId) === '27') { 
                const ownerInput = document.getElementById('oppositionOwnerInput').value;
                const fileInput = document.getElementById('oppositionPetitionFile').files[0];
                const epatsFileInput = document.getElementById('oppositionEpatsPetitionFile')?.files?.[0] || null;
                if (!ownerInput || !fileInput) throw new Error('İtiraz Sahibi ve PDF zorunludur.');

                const storagePath = `incoming_documents/${this.matchedRecord.id}/${Date.now()}_${fileInput.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                const { error: upErr } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, fileInput);
                if (upErr) throw upErr;
                const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
                oppositionFileUrl = urlData.publicUrl;
                oppositionFileName = fileInput.name;

                if (epatsFileInput) {
                    const epatsPath = `incoming_documents/${this.matchedRecord.id}/${Date.now()}_${epatsFileInput.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                    await supabase.storage.from(STORAGE_BUCKET).upload(epatsPath, epatsFileInput);
                    const { data: epatsUrlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(epatsPath);
                    oppositionEpatsFileUrl = epatsUrlData.publicUrl;
                    oppositionEpatsFileName = epatsFileInput.name;
                }

                let newParentTypeId = '20'; 
                let newParentDesc = 'Yayına İtiraz (Otomatik)';
                const parentAlias = parentTypeObj?.alias || parentTypeObj?.name || '';
                if (parentAlias.includes('İtiraz') || String(parentTypeObj?.id) === '20') {
                    newParentTypeId = '19'; 
                    newParentDesc = 'Yayına İtirazın Yeniden İncelenmesi (Otomatik)';
                }

                const parentDocsToSave = [
                    {
                        name: oppositionFileName,
                        url: oppositionFileUrl,
                        documentDesignation: 'İtiraz Dilekçesi'
                    }
                ];

                if (oppositionEpatsFileUrl) {
                    parentDocsToSave.push({
                        name: oppositionEpatsFileName,
                        url: oppositionEpatsFileUrl,
                        documentDesignation: 'EPATS Evrakı'
                    });
                }

                const newParentData = {
                    type: newParentTypeId,
                    description: newParentDesc,
                    transactionHierarchy: 'parent',
                    oppositionOwner: ownerInput,
                    documents: parentDocsToSave,
                    timestamp: new Date().toISOString()
                };
                
                const newParentResult = await this._addTransaction(this.matchedRecord.id, newParentData);
                if (newParentResult.success) newParentTxId = newParentResult.id;
            }

            const finalParentId = newParentTxId || parentTxId;

            let finalPdfUrl = this.pdfData.fileUrl || this.pdfData.download_url;
            let finalPdfPath = this.pdfData.file_path || (this.pdfData.details && this.pdfData.details.file_path) || finalPdfUrl;

            if (finalPdfPath && !finalPdfPath.includes('incoming_documents/indexed/')) {
                let sourcePath = finalPdfPath;
                if (sourcePath.startsWith('http')) {
                    const splitKeyword = `/object/public/${STORAGE_BUCKET}/`;
                    if (sourcePath.includes(splitKeyword)) {
                        sourcePath = sourcePath.split(splitKeyword)[1]; 
                    }
                }
                
                const cleanName = (this.pdfData.fileName || 'evrak.pdf').replace(/[^a-zA-Z0-9.\-_]/g, '_');
                const targetPath = `incoming_documents/indexed/${this.matchedRecord.id}/${Date.now()}_${cleanName}`;
                
                const { error: moveError } = await supabase.storage.from(STORAGE_BUCKET).move(sourcePath, targetPath);
                
                if (!moveError) {
                    finalPdfPath = targetPath;
                    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(targetPath);
                    finalPdfUrl = urlData.publicUrl;
                }
            }

            const transactionData = {
                type: childTypeId,
                transactionHierarchy: 'child',
                parentId: finalParentId,
                description: childTypeObj.alias || childTypeObj.name,
                date: deliveryDateStr ? new Date(deliveryDateStr).toISOString() : new Date().toISOString(),
                documents: [{
                    name: this.pdfData.fileName || 'Resmi Yazı.pdf',
                    url: finalPdfUrl,
                    documentDesignation: 'Resmi Yazı'
                }]
            };

            const txResult = await this._addTransaction(this.matchedRecord.id, transactionData);
            const childTransactionId = txResult.id;

            let shouldTriggerTask = false;
            const recordType = (this.matchedRecord.recordOwnerType === 'self') ? 'Portföy' : '3. Taraf';
            const pTypeIdStr = String(parentTx?.transaction_type_id || parentTx?.type || ''); 
            const childTypeIdStr = String(childTypeId);
            
            const taskTriggerMatrix = {
                "20": { "Portföy": ["50", "51"], "3. Taraf": ["51", "52"] },
                "19": { "Portföy": ["32", "33", "34", "35"], "3. Taraf": ["31", "32", "35", "36"] }
            };
            let skipFallback = false;

            if (taskTriggerMatrix[pTypeIdStr]) {
                const allGovernedChildren = [
                    ...(taskTriggerMatrix[pTypeIdStr]["Portföy"] || []),
                    ...(taskTriggerMatrix[pTypeIdStr]["3. Taraf"] || [])
                ];

                if (allGovernedChildren.includes(childTypeIdStr)) {
                    skipFallback = true; 
                    if (taskTriggerMatrix[pTypeIdStr][recordType] && taskTriggerMatrix[pTypeIdStr][recordType].includes(childTypeIdStr)) {
                        shouldTriggerTask = true;
                    }
                }
            }

            if (!shouldTriggerTask && !skipFallback) {
                if (childTypeObj.taskTriggered || childTypeObj.task_triggered) shouldTriggerTask = true;
            }

            // 🔥 YENİ: finalTaskOwnerId artık en dışarıda tanımlanıyor ki e-posta bloğu da ulaşabilsin
            let finalTaskOwnerId = null;
            let relatedPartyData = null;

            // --- MÜVEKKİL (TASK OWNER) ŞELALE STRATEJİSİ ---
            // 1. Önce Ebeveyn İşlemden (Parent Transaction) gelen eski Görevin sahibini bul
            let targetTaskId = parentTx ? (parentTx.task_id || parentTx.taskId) : null;
            
            if (!targetTaskId && parentTx && parentTx.parent_id) {
                try {
                    const { data: pTx } = await supabase.from('transactions').select('task_id').eq('id', parentTx.parent_id).maybeSingle();
                    if (pTx && pTx.task_id) targetTaskId = pTx.task_id;
                } catch(e) {}
            }

            if (targetTaskId) {
                try {
                    // 🔥 ÇÖZÜM 1: .single() yerine .maybeSingle() ile 406 hatası kökünden engellendi
                    const { data: prevTask } = await supabase.from('tasks').select('task_owner_id, details').eq('id', targetTaskId).maybeSingle();
                    if (prevTask && prevTask.task_owner_id) {
                        finalTaskOwnerId = String(prevTask.task_owner_id);
                        relatedPartyData = { id: finalTaskOwnerId, name: prevTask.details?.related_party_name || "Müvekkil" };
                    }
                } catch (e) {}
            }

            // 🔥 ÇÖZÜM 2 (Deep Fallback): Eski görev bulunamadıysa, bu IP Record'a bağlı "Sahibi olan EN SON görevi" bul. (Rakip dosyalar için %100 kesin çözümdür)
            if (!finalTaskOwnerId && this.matchedRecord && this.matchedRecord.id) {
                try {
                    const { data: fallbackTask } = await supabase
                        .from('tasks')
                        .select('task_owner_id, details')
                        .eq('ip_record_id', this.matchedRecord.id)
                        .not('task_owner_id', 'is', null)
                        .order('created_at', { ascending: false })
                        .limit(1)
                        .maybeSingle();

                    if (fallbackTask && fallbackTask.task_owner_id) {
                        finalTaskOwnerId = String(fallbackTask.task_owner_id);
                        relatedPartyData = { id: finalTaskOwnerId, name: fallbackTask.details?.related_party_name || "Müvekkil" };
                        console.log(`[INDEXING] Sahip fallback ile bulundu: ${finalTaskOwnerId}`);
                    }
                } catch (e) {}
            }

            // 3. Hala yoksa normal portföy başvuru sahiplerine bak
            if (!finalTaskOwnerId && this.matchedRecord) {
                if (this.matchedRecord.client_id) {
                    finalTaskOwnerId = String(this.matchedRecord.client_id);
                    relatedPartyData = { id: finalTaskOwnerId, name: this.matchedRecord.client?.name || 'Müvekkil' };
                } else if (this.matchedRecord.applicants && this.matchedRecord.applicants.length > 0) {
                    const app = this.matchedRecord.applicants[0];
                    const appId = app.id || app.person_id || (app.persons && app.persons.id);
                    const appName = app.name || (app.persons && app.persons.name);
                    if (appId) {
                        finalTaskOwnerId = String(appId);
                        relatedPartyData = { id: finalTaskOwnerId, name: appName || 'Başvuru Sahibi' };
                    }
                }
            }

            if (shouldTriggerTask) {
                const deliveryDate = new Date(deliveryDateStr);
                let duePeriod = Number(childTypeObj.duePeriod || childTypeObj.due_period || 0);
                
                let officialDueDate = addMonthsToDate(deliveryDate, duePeriod);
                officialDueDate = findNextWorkingDay(officialDueDate, TURKEY_HOLIDAYS);
                let taskDueDate = new Date(officialDueDate);
                taskDueDate.setDate(taskDueDate.getDate() - 3);
                while (isWeekend(taskDueDate) || isHoliday(taskDueDate, TURKEY_HOLIDAYS)) {
                    taskDueDate.setDate(taskDueDate.getDate() - 1);
                }

                let tasksToCreate = [];
                if (childTypeObj.taskTriggered || childTypeObj.task_triggered) tasksToCreate.push(String(childTypeObj.taskTriggered || childTypeObj.task_triggered));

                const currentChildIdStr = String(childTypeId);
                const recOwnerType = this.matchedRecord.recordOwnerType;
                let isEligibleFor66 = false;

                if (['30', '31'].includes(currentChildIdStr)) {
                    isEligibleFor66 = true;
                } else if (recOwnerType === 'self' && ['32', '33', '34', '35', '50', '51'].includes(currentChildIdStr)) {
                    isEligibleFor66 = true;
                } else if (recOwnerType === 'third_party' && ['51', '52', '31', '32', '35', '36'].includes(currentChildIdStr)) {
                    isEligibleFor66 = true;
                }

                if (finalTaskOwnerId && isEligibleFor66) {
                    try {
                        const { data: personData } = await supabase.from('persons').select('is_evaluation_required').eq('id', finalTaskOwnerId).single();
                        if (personData && personData.is_evaluation_required && !tasksToCreate.includes("66")) {
                            tasksToCreate.push("66");
                        }
                    } catch (e) {}
                }

                let ipAppNo = this.matchedRecord.applicationNumber || this.matchedRecord.application_number || "-";
                let ipTitle = this.matchedRecord.title || this.matchedRecord.mark_name || "-";
                let ipAppName = relatedPartyData ? relatedPartyData.name : "-";

                for (const tType of tasksToCreate) {
                    let taskDesc = notes || `İndeksleme işlemi ile otomatik oluşturulan görev.`;
                    let taskStatus = 'awaiting_client_approval';
                    let currentAssignedUser = { uid: SELCAN_UID, email: SELCAN_EMAIL }; 

                    if (String(tType) === "66") {
                        taskDesc = "Müvekkil değerlendirme ayarı açık olduğu için ek olarak tetiklendi.";
                        taskStatus = 'open'; 
                        try {
                            const { data: assignmentRule } = await supabase.from('task_assignments').select('assignee_ids').eq('id', '66').single();
                            if (assignmentRule && assignmentRule.assignee_ids && assignmentRule.assignee_ids.length > 0) {
                                const targetUid = assignmentRule.assignee_ids[0]; 
                                const { data: userData } = await supabase.from('users').select('email').eq('id', targetUid).single();
                                currentAssignedUser = { uid: targetUid, email: userData ? userData.email : 'bilinmiyor@evreka.com' };
                            }
                        } catch (err) {}
                    }

                    const taskData = {
                        title: `${childTypeObj.alias || childTypeObj.name} - ${this.matchedRecord.title || this.matchedRecord.brand_name || ipTitle}`,
                        description: taskDesc,
                        task_type_id: String(tType), 
                        ip_record_id: this.matchedRecord.id,
                        transaction_id: childTransactionId,
                        task_owner_id: finalTaskOwnerId, // 🔥 ID ATANDI
                        assigned_to: currentAssignedUser.uid,
                        status: taskStatus,
                        priority: 'medium',
                        details: {
                            related_party: relatedPartyData,
                            related_party_name: relatedPartyData?.name || null,
                            assigned_to_email: currentAssignedUser.email,
                            iprecord_application_no: ipAppNo,
                            iprecord_title: ipTitle,
                            iprecord_applicant_name: ipAppName,
                            triggering_transaction_type: childTypeId,
                            history: [{ action: 'İndeksleme işlemi ile otomatik oluşturuldu.', timestamp: new Date().toISOString(), userEmail: this.currentUser.email }]
                        },
                        official_due_date: officialDueDate.toISOString(),
                        operational_due_date: taskDueDate.toISOString(),
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    };

                    const taskResult = await taskService.createTask(taskData);
                    
                    if (taskResult.success) {
                        const createdTaskId = taskResult.data?.id || taskResult.id;
                        
                        if (String(tType) !== "66" && createdTaskId) {
                            await supabase.from('transactions').update({ task_id: String(createdTaskId) }).eq('id', childTransactionId);

                            const triggeredTypeObj = this.allTransactionTypes.find(t => String(t.id) === String(tType));
                            const triggeredTypeName = triggeredTypeObj ? (triggeredTypeObj.alias || triggeredTypeObj.name) : 'Otomatik İşlem';
                            const targetHierarchy = triggeredTypeObj?.hierarchy || 'child'; 

                            const triggeredTransactionData = {
                                type: tType,
                                description: `${triggeredTypeName} (Otomatik)`,
                                transactionHierarchy: targetHierarchy,
                                taskId: createdTaskId ? String(createdTaskId) : null,
                                timestamp: new Date().toISOString()
                            };
                            if (targetHierarchy === 'child') triggeredTransactionData.parentId = finalParentId;
                            
                            await this._addTransaction(this.matchedRecord.id, triggeredTransactionData);
                        }
                    }
                }
            }

            if (finalParentId && childTypeId) {
                try {
                    const { data: pTx } = await supabase.from('transactions').select('note').eq('id', finalParentId).single();
                    const existingNote = pTx?.note || '';
                    const newNote = existingNote ? `${existingNote}\n[Sonuç İşlemi: ${childTypeId}]` : `[Sonuç İşlemi: ${childTypeId}]`;
                    await supabase.from('transactions').update({ note: newNote }).eq('id', finalParentId);
                } catch (err) {}
            }

            await supabase.from(INCOMING_DOCS_COLLECTION).update({
                status: 'indexed',
                file_url: finalPdfUrl, 
                file_path: finalPdfPath, 
                indexed_at: new Date().toISOString(),
                created_transaction_id: childTransactionId,
                ip_record_id: this.matchedRecord.id
            }).eq('id', String(this.pdfId));

            try {
                const tebligTarihiStr = document.getElementById('detectedDate').value; 
                const sonItirazTarihiStr = document.getElementById('calculatedDeadlineDisplay')?.value || '';

                console.log(`[INDEXING] Posta alıcıları merkezden hesaplanıyor... TaskOwnerID:`, finalTaskOwnerId);
                
                // 🔥 ÇÖZÜM 3: Artık finalTaskOwnerId dolu ve ulaşılabiliyor
                const mailRecipients = await mailService.resolveMailRecipients(
                    this.matchedRecord.id, 
                    childTypeId, 
                    finalTaskOwnerId
                );

                await supabase.functions.invoke('send-indexing-notification', {
                    body: {
                        recordId: this.matchedRecord.id, 
                        childTypeId: childTypeId,
                        transactionId: childTransactionId,
                        tebligTarihi: tebligTarihiStr,
                        sonItirazTarihi: sonItirazTarihiStr,
                        pdfId: this.pdfId,
                        toList: mailRecipients.to, 
                        ccList: mailRecipients.cc  
                    }
                });
            } catch (notifyErr) {
                console.error("Mail bildirim Edge Function hatası:", notifyErr);
            }
            
            showNotification('İşlem başarıyla tamamlandı!', 'success');
            setTimeout(() => window.location.href = 'bulk-indexing-page.html', 1500);

        } catch (error) {
            console.error('Kaydetme hatası:', error);
            showNotification('Hata: ' + error.message, 'error');
            saveBtn.disabled = false;
        }
    }

    renderHeader() {
        if (document.getElementById('fileNameDisplay')) {
            document.getElementById('fileNameDisplay').textContent = this.pdfData?.fileName || 'Dosya yükleniyor...';
        }
        
        const matchInfoEl = document.getElementById('matchInfoDisplay');
        if (!matchInfoEl) return;

        if (this.matchedRecord) {
            // 🔥 ÇÖZÜM: Var olan yerel resminiz (tp-icon.png) kullanıldı
            const imgUrl = this.matchedRecord.brandImageUrl || this.matchedRecord.trademarkImage || this.matchedRecord.publicImageUrl || './tp-icon.png';
            const applicantNames = this.matchedRecord.resolvedNames || '-';

            matchInfoEl.innerHTML = `
                <div class="d-flex align-items-center">
                    <div class="mr-3 border rounded bg-white p-1 shadow-sm" style="width: 70px; height: 70px; overflow: hidden;">
                        <img src="${imgUrl}" class="img-fluid w-100 h-100" style="object-fit: contain;" onerror="this.onerror=null; this.src='./tp-icon.png';">
                    </div>
                    <div class="flex-grow-1 overflow-hidden">
                        <h6 class="mb-1 text-primary font-weight-bold text-truncate" title="${this.matchedRecord.title}">
                            ${this.matchedRecord.title}
                        </h6>
                        <div class="d-flex small text-dark mb-1">
                            <span class="mr-3"><strong>No:</strong> ${this.matchedRecord.applicationNumber || '-'}</span>
                        </div>
                        <div class="small text-muted text-truncate" title="${applicantNames}">
                            <i class="fas fa-user-tie mr-1"></i>${applicantNames}
                        </div>
                    </div>
                    <div class="ml-2">
                        <span class="badge badge-success badge-pill px-3 py-2"><i class="fas fa-check mr-1"></i>Bağlandı</span>
                    </div>
                </div>`;
        } else {
            matchInfoEl.innerHTML = `
                <div class="d-flex align-items-center justify-content-center h-100 py-3">
                    <div class="text-warning font-weight-bold"><i class="fas fa-exclamation-circle mr-2"></i>Eşleşen Kayıt Bulunmuyor</div>
                </div>`;
        }
    }

    async handleManualSearch(query) {
        const container = document.getElementById('manualSearchResults');
        if (!query || query.length < 3) { container.style.display = 'none'; return; }
        
        const lowerQuery = query.toLowerCase();
        
        const filteredData = this.allRecords.filter(r => {
            const title = (r.title || r.markName || r.brand_name || '').toLowerCase();
            const appNo = String(r.applicationNumber || r.application_number || r.wipo_ir || r.aripo_ir || '').toLowerCase();
            return title.includes(lowerQuery) || appNo.includes(lowerQuery);
        }).slice(0, 15);
            
        if (filteredData.length === 0) {
            container.innerHTML = '<div class="p-2 text-muted italic">Sonuç bulunamadı.</div>';
            container.style.display = 'block';
            return;
        }

        container.innerHTML = filteredData.map(r => {
            const countryName = this.countryMap.get(r.country_code || r.country) || r.country_code || r.country || '-';
            const detailText = `${r.applicationNumber || r.application_number || r.wipo_ir || '-'} • ${r.origin || 'WIPO'} • ${countryName}`;
            
            return `
                <div class="search-result-item p-2 border-bottom" style="cursor:pointer" data-id="${r.id}">
                    <div class="font-weight-bold text-primary" style="font-size:0.9rem;">${r.title || r.markName || r.brand_name || '(İsimsiz)'}</div>
                    <div class="small text-muted" style="font-size:0.75rem;">${detailText}</div>
                </div>`;
        }).join('');
            
        container.querySelectorAll('.search-result-item').forEach(el => {
            el.onclick = () => {
                const selected = filteredData.find(rec => rec.id === el.dataset.id);
                if (selected) this.selectRecordWithHierarchy(selected);
                container.style.display = 'none';
            };
        });
        container.style.display = 'block';
    }

    // 🔥 ÇÖZÜM: WIPO alt kayıtlarını (children) ararken eski details objesi yerine native sütunlara bakar
    async selectRecordWithHierarchy(record) {
        if (!record) return;

        const origin = (record.origin || '').toUpperCase();
        const hierarchy = (record.transactionHierarchy || record.transaction_hierarchy || 'parent').toLowerCase();
        const isInternational = ['WIPO', 'ARIPO', 'WO', 'AP'].some(o => origin.includes(o));
        const isParent = hierarchy === 'parent';

        if (isInternational && isParent) {
            if (window.SimpleLoadingController) window.SimpleLoadingController.show({ text: 'Alt dosyalar ve ulusal kayıtlar aranıyor...' });
            
            try {
                const parentId = record.id;
                const parentIR = String(record.internationalRegNumber || record.wipo_ir || record.aripo_ir || '').replace(/\D/g, '');
                
                const { data: childrenData } = await supabase.from('ip_records')
                                        .select(`
                                            *,
                                            details:ip_record_trademark_details(brand_name)
                                        `)
                                        .eq('transaction_hierarchy', 'child');

                const children = (childrenData || []).filter(child => {
                    const childIR = String(child.wipo_ir || child.aripo_ir || '').replace(/\D/g, '');
                    return (child.parent_id === parentId) || (parentIR !== "" && childIR === parentIR);
                });

                if (window.SimpleLoadingController) window.SimpleLoadingController.hide();

                if (children.length > 0) {
                    this._openWipoSelectionModal(record, children);
                    return;
                }
            } catch (err) {
                if (window.SimpleLoadingController) window.SimpleLoadingController.hide();
            }
        }
        await this.selectRecord(record.id);
    }

    _openWipoSelectionModal(parent, children) {
        const listEl = document.getElementById('wipoSelectionList');
        if (!listEl) return;

        listEl.innerHTML = '';
        [parent, ...children].forEach(rec => {
            const isParent = rec.id === parent.id;
            
            const country = isParent ? 'Uluslararası' : (this.countryMap.get(rec.country_code) || rec.country_code || '-');
            const originStr = rec.origin || '-';
            
            // Marka adı join edilmiş tablodan (details) gelebilir veya mevcut recordda olabilir
            const titleStr = rec.brand_name || rec.title || (rec.details && rec.details.brand_name) || '(İsimsiz)';
            const irStr = rec.wipo_ir || rec.aripo_ir || '-';
            
            const item = document.createElement('button');
            item.className = "list-group-item list-group-item-action d-flex justify-content-between align-items-center mb-2 border rounded shadow-sm";
            item.innerHTML = `
                <div class="d-flex align-items-center">
                    <i class="fas ${isParent ? 'fa-globe-americas text-primary' : 'fa-flag text-danger'} fa-lg mr-3"></i>
                    <div>
                        <div class="font-weight-bold">${titleStr}</div>
                        <div class="small text-muted">${irStr} • ${originStr} • ${country}</div>
                    </div>
                </div>
                <span class="badge ${isParent ? 'badge-primary' : 'badge-light border'} px-2 py-1">${isParent ? 'ANA KAYIT' : 'ULUSAL'}</span>
            `;
            item.onclick = () => {
                this.selectRecord(rec.id);
                if (typeof $ !== 'undefined') $('#wipoSelectionModal').modal('hide');
            };
            listEl.appendChild(item);
        });
        if (typeof $ !== 'undefined') $('#wipoSelectionModal').modal('show');
    }
}

export async function resolveApprovalStateAssignee() { return { uid: null, email: null }; }

document.addEventListener('DOMContentLoaded', () => { new DocumentReviewManager(); });