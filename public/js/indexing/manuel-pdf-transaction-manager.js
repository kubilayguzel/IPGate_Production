// public/js/indexing/manuel-pdf-transaction-manager.js

import { authService, ipRecordsService, supabase, taskService } from '../../supabase-config.js';
import { showNotification, debounce } from '../../utils.js';

const INCOMING_DOCS_COLLECTION = 'incoming_documents';
const STORAGE_BUCKET = 'documents';
const generateUUID = () => crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).substr(2, 16);

export class ManuelPdfTransactionManager {
    constructor() {
        this.uploadedFiles = [];
        this.currentUser = null;
        
        this.activeTab = 'manual-indexing-pane'; 
        this.unsubscribe = null;
        
        this.allRecords = [];
        this.allTransactionTypes = [];
        this.uploadedFilesMap = new Map(); 
        this.selectedRecordManual = null;
        this.currentRecordTransactions = []; 

        this._manualSearchSeq = 0;
        this._isDataLoaded = false;
        this._isLoadingData = false;

        if (typeof window !== 'undefined') {
            window.manuelPdfTransactionManager = this;
        }

        this.init();
    }

    async init() {
        try {
            const session = await authService.getCurrentSession();
            this.currentUser = session?.user || null;
            if (!this.currentUser) return;

            this.setupEventListeners();
            this.setupRealtimeListener(); 
        } catch (error) {
            console.error('Init hatası:', error);
        }
    }

    async loadAllData() {
        try {
            const recordsResult = await ipRecordsService.getRecords();
            this.allRecords = recordsResult?.data || recordsResult?.items || recordsResult || [];

            const { data: txTypes } = await supabase.from('transaction_types').select('*');
            this.allTransactionTypes = txTypes || [];
            
            this._isDataLoaded = true; 
        } catch (error) {
            showNotification('Veriler yüklenirken hata oluştu: ' + error.message, 'error');
            this._isDataLoaded = true; 
        }
    }

    setupEventListeners() {
        const uploadButton = document.getElementById('bulkFilesButton');
        const fileInput = document.getElementById('bulkFiles');

        if (uploadButton && fileInput) {
            uploadButton.addEventListener('click', () => fileInput.click());
            uploadButton.addEventListener('dragover', (e) => e.preventDefault());
            uploadButton.addEventListener('dragleave', (e) => e.preventDefault());
            uploadButton.addEventListener('drop', (e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files).filter(file => file.type === 'application/pdf');
                if (files.length > 0) this.processFiles(files);
            });
            fileInput.addEventListener('change', (e) => this.processFiles(Array.from(e.target.files)));
        }

        document.querySelectorAll('.tab-navigation .nav-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.activeTab = e.currentTarget.getAttribute('data-tab');
                this.checkFormCompleteness();
            });
        });

        document.getElementById('saveManualTransactionBtn')?.addEventListener('click', () => this.handleManualTransactionSubmit());
        
        document.getElementById('specificManualTransactionType')?.addEventListener('change', () => {
            this.updateManualChildOptions();
            this.checkFormCompleteness();
        });

        document.getElementById('manualChildTransactionType')?.addEventListener('change', () => {
            this.updateManualParentOptions();
            this.checkFormCompleteness();
        });

        document.getElementById('manualExistingParentSelect')?.addEventListener('change', () => this.checkFormCompleteness());
                 
        this.setupManualTransactionListeners();
    }

    setupManualTransactionListeners() {
        const recordSearchInput = document.getElementById('recordSearchInputManual');
        const recordSearchContainer = document.getElementById('searchResultsContainerManual');
        const clearSelectedBtn = document.getElementById('clearSelectedRecordManual');
        
        if (recordSearchInput) {
            recordSearchInput.addEventListener('focus', () => {
                if (!this._isDataLoaded && !this._isLoadingData) {
                    this._isLoadingData = true;
                    this.loadAllData().finally(() => { this._isLoadingData = false; });
                }
            }, { once: true });

            recordSearchInput.addEventListener('input', debounce((e) => this.searchRecords(e.target.value), 100));
            recordSearchInput.addEventListener('blur', () => {
                setTimeout(() => { if (recordSearchContainer) recordSearchContainer.style.display = 'none'; }, 200);
            });
        }

        clearSelectedBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            this.clearSelectedRecordManual();
        });

        const filesManual = document.getElementById('filesManual');
        const filesManualButton = document.getElementById('filesManualButton');
        
        if (filesManual) {
            filesManual.addEventListener('change', (e) => {
                this.handleFileChange(e, 'manual-indexing-pane');
            });
        }

        if (filesManualButton) {
            filesManualButton.addEventListener('click', () => filesManual?.click());
            filesManualButton.addEventListener('dragover', (e) => e.preventDefault());
            filesManualButton.addEventListener('dragleave', (e) => e.preventDefault());
            filesManualButton.addEventListener('drop', (e) => {
                e.preventDefault();
                if(e.dataTransfer.files?.length > 0 && filesManual) {
                    filesManual.files = e.dataTransfer.files;
                    filesManual.dispatchEvent(new Event('change'));
                }
            });
        }

        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.remove-uploaded-file');
            if (btn) {
                const fileId = btn.dataset.fileId;
                const tabKey = btn.dataset.tabKey;
                let files = this.uploadedFilesMap.get(tabKey) || [];
                this.uploadedFilesMap.set(tabKey, files.filter(f => f.id !== fileId));
                this.renderUploadedFilesList(tabKey);
                this.checkFormCompleteness();
            }
        });
    }

    async processFiles(files) {
        if (window.SimpleLoadingController) window.SimpleLoadingController.show({ text: 'Dosyalar Yükleniyor' });
        try {
            for (const file of files) await this.uploadFileToSupabase(file);
            if (window.SimpleLoadingController) window.SimpleLoadingController.showSuccess(`${files.length} dosya başarıyla yüklendi.`);
            
            await this.fetchManualFiles();

            const mainTabBtn = document.querySelector('[data-tab="bulk-indexing-pane"]');
            if (mainTabBtn) mainTabBtn.click();
            
            const manualSubTabBtn = document.querySelector('[data-target="manual-uploaded-tab"]');
            if (manualSubTabBtn) {
                document.querySelectorAll('.notification-tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.notification-tab-pane').forEach(p => {
                    p.classList.remove('active');
                    p.style.display = 'none';
                });
                
                manualSubTabBtn.classList.add('active');
                const targetPane = document.getElementById('manual-uploaded-tab');
                if (targetPane) {
                    targetPane.classList.add('active');
                    targetPane.style.display = 'block';
                }
            }

        } catch (error) {
            if (window.SimpleLoadingController) window.SimpleLoadingController.hide();
            showNotification('Yükleme sırasında bir hata oluştu.', 'error');
        }
    }

    extractApplicationNumber(fileName) {
        if (!fileName) return null;
        const patterns = [ /(\d{4}[-\/\s]\d+)/g, /TR(\d{4}[-\/]\d+)/gi, /(\d{6,})/g ];
        const extractedNumbers = [];
        patterns.forEach(pattern => {
            const matches = fileName.match(pattern);
            if (matches) matches.forEach(match => extractedNumbers.push(match.replace(/^(TR|EP|WO)/i, '').trim()));
        });
        return extractedNumbers.length > 0 ? extractedNumbers[0] : null;
    }

    async uploadFileToSupabase(file) {
        if (file._isProcessing) return;
        file._isProcessing = true;

        try {
            const id = generateUUID();
            const cleanName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const storagePath = `incoming_documents/${this.currentUser.id}/${Date.now()}_${cleanName}`;
            
            const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, file);
            if (uploadError) throw uploadError;

            const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
            const extractedAppNumber = this.extractApplicationNumber(file.name);
            
            const pdfData = {
                id: id,
                file_name: file.name,
                file_url: urlData.publicUrl,
                file_path: storagePath,
                document_source: 'manual', 
                status: 'pending',
                application_number: extractedAppNumber || null,
                ip_record_id: null, 
                user_id: this.currentUser.id, 
                created_at: new Date().toISOString()
            };
            
            const { error: dbError } = await supabase.from(INCOMING_DOCS_COLLECTION).insert(pdfData);
            if (dbError) throw dbError;

            return pdfData;
        } catch (error) { throw error; }
    }

    async fetchManualFiles() {
        if (!this.currentUser) return;
        const { data, error } = await supabase.from(INCOMING_DOCS_COLLECTION)
            .select('*')
            .eq('user_id', this.currentUser.id)
            .eq('document_source', 'manual')
            .order('created_at', { ascending: false });
        
        if (!error) this.processFetchedFiles(data || []);
    }

    setupRealtimeListener() {
        if (!this.currentUser) return;

        this.fetchManualFiles(); 

        this.unsubscribe = supabase.channel('incoming_documents_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: INCOMING_DOCS_COLLECTION, filter: `user_id=eq.${this.currentUser.id}` }, () => {
                this.fetchManualFiles();
            })
            .subscribe();
    }

    processFetchedFiles(data) {
        this.uploadedFiles = data.map(doc => ({
            id: doc.id, fileName: doc.file_name, fileUrl: doc.file_url, filePath: doc.file_path,
            extractedAppNumber: doc.application_number, status: doc.status
        }));
        this.updateUI();
    }

    updateUI() {
        const pendingFiles = this.uploadedFiles.filter(f => f.status === 'pending');
        const badge = document.getElementById('manualUploadedBadge');
        if (badge) badge.textContent = pendingFiles.length;
        
        const container = document.getElementById('manualUploadedList');
        if (!container) return;

        if (pendingFiles.length === 0) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:#999;">Liste boş</div>';
            return;
        }

        container.innerHTML = pendingFiles.map(file => {
            const qParam = file.extractedAppNumber ? `&q=${encodeURIComponent(file.extractedAppNumber)}` : '';
            
            return `
            <div class="pdf-list-item" style="border-left: 4px solid #0d6efd;">
                <div style="display:flex; align-items:center;">
                    <div class="pdf-icon"><i class="fas fa-file-pdf text-danger mr-3"></i></div>
                    <div class="pdf-details">
                        <div class="pdf-name" style="font-weight: bold;">${file.fileName}</div>
                        <div class="pdf-meta text-muted small">${file.extractedAppNumber ? `No: ${file.extractedAppNumber}` : 'No Bulunamadı'}</div>
                    </div>
                </div>
                <div class="pdf-actions">
                    <button class="btn btn-light btn-sm pdf-action-btn" title="Görüntüle" onclick="window.open('${file.fileUrl}', '_blank')">
                        <i class="fas fa-eye"></i>
                    </button>
                    
                    <button class="btn btn-primary btn-sm pdf-action-btn" title="İndeksle" onclick="window.location.href='indexing-detail.html?pdfId=${file.id}${qParam}'">
                        <i class="fas fa-edit"></i>
                    </button>
                    
                    <button class="btn btn-light btn-sm pdf-action-btn pdf-action-danger" title="Sil" onclick="window.manuelPdfTransactionManager.deleteFilePermanently('${file.id}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            `;
        }).join('');
    }

    async deleteFilePermanently(fileId) {
        if (!confirm('Dosyayı kalıcı olarak silmek istiyor musunuz?')) return;
        
        try {
            const fileToDelete = this.uploadedFiles.find(f => f.id === fileId);
            if (!fileToDelete) return;

            if (fileToDelete.filePath) {
                await supabase.storage.from(STORAGE_BUCKET).remove([fileToDelete.filePath]);
            }
            
            const { error } = await supabase.from(INCOMING_DOCS_COLLECTION).delete().eq('id', fileId);
            if (error) throw error;
            
            showNotification('Dosya başarıyla silindi.', 'success');

            await this.fetchManualFiles();

        } catch (error) { 
            console.error('Silme hatası:', error);
            showNotification('Silme işlemi sırasında hata oluştu.', 'error'); 
        }
    }

    async _resolveRecordImageUrl(record) {
        const potentialPath = record.imagePath || record.brandImageUrl || record.image || record.logo || record.imageUrl;
        if (!potentialPath) return null;

        if (typeof potentialPath === 'string' && (potentialPath.startsWith('http') || potentialPath.startsWith('data:'))) {
            return potentialPath;
        }

        try {
            const { data } = supabase.storage.from('brand_images').getPublicUrl(potentialPath);
            return data ? data.publicUrl : null;
        } catch (e) {
            return null;
        }
    }

    async searchRecords(queryText) {
        const container = document.getElementById('searchResultsContainerManual');
        if (!container) return;

        const rawQuery = (queryText || '').trim();
        // En az 3 karakter girmeden arama yapma
        if (rawQuery.length < 3) { 
            container.style.display = 'none'; 
            return; 
        }

        // Yükleniyor animasyonunu göster
        container.innerHTML = '<div style="padding: 15px; text-align: center; color: #4e73df; font-weight: 600;"><i class="fas fa-spinner fa-spin mr-2"></i>Kayıtlar aranıyor...</div>';
        container.style.display = 'block';

        try {
            // 1. ADIM: MÜŞTERİ PORTFÖYÜNDE (trademarks tablosu) ARA
            const { data: portfolioData, error: pError } = await supabase
                .from('portfolio_list_view')
                .select('id, application_number, brand_name, origin, status, record_owner_type, applicants_json')
                .or(`application_number.ilike.%${rawQuery}%,brand_name.ilike.%${rawQuery}%`)
                .limit(10);

            if (pError) console.error("Portföy arama hatası:", pError);

            // 2. ADIM: YAYINLANAN BÜLTENLERDE (trademark_bulletin_records) ARA
            const { data: bulletinData, error: bError } = await supabase
                .from('trademark_bulletin_records')
                .select('id, application_number, brand_name, bulletin_id, application_date, image_url')
                .or(`application_number.ilike.%${rawQuery}%,brand_name.ilike.%${rawQuery}%`)
                .limit(10);

            if (bError) console.error("Bülten arama hatası:", bError);

            // 3. ADIM: SONUÇLARI HARMANLA VE EKRANA ÇİZ
            container.innerHTML = '';
            let hasResults = false;

            // --- Portföy Sonuçlarını Çiz ---
            if (portfolioData && portfolioData.length > 0) {
                hasResults = true;
                container.innerHTML += `<div class="dropdown-header text-primary font-weight-bold bg-light border-bottom" style="padding: 8px 15px; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em;"><i class="fas fa-briefcase mr-1"></i> Müşteri Portföyü</div>`;
                
                portfolioData.forEach(record => {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';
                    item.style.cssText = `padding: 10px 15px; cursor: pointer; border-bottom: 1px solid #eee; transition: background 0.2s;`;
                    
                    const title = record.brand_name || '(İsimsiz)';
                    const appNo = record.application_number || '-';
                    const originStr = record.origin || 'TR';

                    // Tıklama efekti için hover olayı
                    item.onmouseover = () => item.style.background = '#f8f9fa';
                    item.onmouseout = () => item.style.background = 'transparent';

                    item.innerHTML = `
                        <div style="flex-grow: 1;">
                            <div style="font-weight: 600; color: #1e3c72; margin-bottom: 3px;">${appNo}</div>
                            <div style="font-size: 0.9em; color: #555;"><span class="text-truncate d-inline-block" style="max-width: 250px; vertical-align: bottom;">${title}</span> <span class="badge badge-light border ml-1">${originStr}</span></div>
                        </div>`;
                        
                    // Tıklandığında ana fonksiyonunuza seçimi gönderin
                    item.addEventListener('click', () => { 
                        this.selectRecord({
                            id: record.id,
                            title: title,
                            applicationNumber: appNo,
                            origin: originStr,
                            recordOwnerType: record.record_owner_type,
                            client_id: record.client_id,
                            applicants_json: record.applicants_json,
                            _isBulletin: false // Portföy kaydı
                        }); 
                        container.style.display = 'none'; 
                    });
                    container.appendChild(item);
                });
            }

            // --- Bülten Sonuçlarını Çiz ---
            if (bulletinData && bulletinData.length > 0) {
                hasResults = true;
                if (portfolioData && portfolioData.length > 0) container.innerHTML += `<div class="dropdown-divider my-0"></div>`;
                container.innerHTML += `<div class="dropdown-header text-danger font-weight-bold bg-light border-bottom" style="padding: 8px 15px; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em;"><i class="fas fa-newspaper mr-1"></i> TPE Bülten Kayıtları</div>`;
                
                bulletinData.forEach(record => {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';
                    item.style.cssText = `padding: 10px 15px; cursor: pointer; border-bottom: 1px solid #eee; transition: background 0.2s;`;
                    
                    const title = record.brand_name || '(İsimsiz)';
                    const appNo = record.application_number || '-';

                    item.onmouseover = () => item.style.background = '#fff5f5';
                    item.onmouseout = () => item.style.background = 'transparent';

                    item.innerHTML = `
                        <div style="flex-grow: 1;">
                            <div style="font-weight: 600; color: #e74a3b; margin-bottom: 3px;">${appNo}</div>
                            <div style="font-size: 0.9em; color: #555;"><span class="text-truncate d-inline-block" style="max-width: 200px; vertical-align: bottom;">${title}</span> <span class="badge badge-secondary ml-1 float-right mt-1">Bülten: ${record.bulletin_id || '-'}</span></div>
                        </div>`;
                        
                    // Tıklandığında bülten kaydını mevcut yapıya uygun olarak gönder
                    item.addEventListener('click', () => { 
                        this.selectRecord({
                            id: record.id,
                            title: title,
                            applicationNumber: appNo,
                            applicationDate: record.application_date,
                            imagePath: record.image_url,
                            _isBulletin: true // Tıklanınca bülteni portföye eklemesini sağlayacak tetikleyici
                        }); 
                        container.style.display = 'none'; 
                    });
                    container.appendChild(item);
                });
            }

            if (!hasResults) {
                container.innerHTML = '<div style="padding: 15px; text-align: center; color: #858796;">Bu kriterlere uygun kayıt bulunamadı.</div>';
            }

        } catch (error) {
            console.error("Arama motoru hatası:", error);
            container.innerHTML = '<div style="padding: 15px; text-align: center; color: #e74a3b;"><i class="fas fa-exclamation-circle mr-1"></i> Arama sırasında bir hata oluştu.</div>';
        }
    }

    async selectRecord(record) {
        this.selectedRecordManual = record;
        const inputElement = document.getElementById('recordSearchInputManual');
        if (inputElement) inputElement.value = ''; 

        document.getElementById('selectedRecordEmptyManual').style.display = 'none';
        document.getElementById('selectedRecordContainerManual').style.display = 'block';
        document.getElementById('selectedRecordLabelManual').textContent = record.title || record.markName || '(İsimsiz)';
        document.getElementById('selectedRecordNumberManual').textContent = record.applicationNumber || record.applicationNo || '-';

        const imgEl = document.getElementById('selectedRecordImageManual');
        const phEl = document.getElementById('selectedRecordPlaceholderManual');
        if (imgEl) { imgEl.style.display = 'none'; imgEl.src = ''; }
        if (phEl) phEl.style.display = 'flex';

        try {
            const imageUrl = await this._resolveRecordImageUrl(record);
            if (imageUrl && imgEl) {
                imgEl.src = imageUrl;
                imgEl.style.display = 'block';
                if (phEl) phEl.style.display = 'none';
            }
        } catch (err) {}

        this.populateManualTransactionTypeSelect();
        
        this.currentRecordTransactions = [];
        ipRecordsService.getRecordTransactions(record.id).then(res => {
            if(res.success) this.currentRecordTransactions = res.data || [];
        });
        this.checkFormCompleteness();
    }

    clearSelectedRecordManual() {
        this.selectedRecordManual = null;
        document.getElementById('selectedRecordContainerManual').style.display = 'none';
        document.getElementById('selectedRecordEmptyManual').style.display = 'block';
        this.checkFormCompleteness();
    }

    populateManualTransactionTypeSelect() {
        const select = document.getElementById('specificManualTransactionType');
        if (!select) return;
        select.innerHTML = '<option value="" disabled selected>İşlem türü seçin...</option>';
        this.allTransactionTypes.filter(t => t.hierarchy === 'parent' || !t.hierarchy).forEach(type => {
            const option = document.createElement('option');
            option.value = type.id; option.textContent = type.alias || type.name;
            select.appendChild(option);
        });
    }

    updateManualChildOptions() {
        const parentTypeSelect = document.getElementById('specificManualTransactionType');
        const childTypeSelect = document.getElementById('manualChildTransactionType');
        const parentContainer = document.getElementById('manualParentSelectContainer');

        childTypeSelect.innerHTML = '<option value="">-- Sadece Ana İşlem Oluştur --</option>';
        childTypeSelect.disabled = true;
        if(parentContainer) parentContainer.style.display = 'none';

        const parentTypeObj = this.allTransactionTypes.find(t => String(t.id) === parentTypeSelect.value);
        if (!parentTypeObj) return; 

        let allowedChildIds = [];
        if (Array.isArray(parentTypeObj.index_manuel) && parentTypeObj.index_manuel.length > 0) {
            allowedChildIds = parentTypeObj.index_manuel.map(String);
        } else if (Array.isArray(parentTypeObj.index_file) && parentTypeObj.index_file.length > 0) {
            allowedChildIds = parentTypeObj.index_file.map(String);
        } else if (Array.isArray(parentTypeObj.allowed_child_types)) {
            allowedChildIds = parentTypeObj.allowed_child_types.map(String);
        }

        const allowedChildTypes = this.allTransactionTypes.filter(t => allowedChildIds.includes(String(t.id)));

        if (allowedChildTypes.length > 0) {
            allowedChildTypes.forEach(type => {
                const opt = document.createElement('option');
                opt.value = type.id; opt.textContent = type.alias || type.name;
                childTypeSelect.appendChild(opt);
            });
            childTypeSelect.disabled = false;
        }
    }

    updateManualParentOptions() {
        const parentTypeSelect = document.getElementById('specificManualTransactionType');
        const childTypeSelect = document.getElementById('manualChildTransactionType');
        const parentContainer = document.getElementById('manualParentSelectContainer');
        const parentSelect = document.getElementById('manualExistingParentSelect');

        if (!childTypeSelect.value) {
            parentContainer.style.display = 'none';
            parentSelect.innerHTML = '<option value="">-- Ana İşlem Seçin --</option>';
            return;
        }

        parentContainer.style.display = 'block';
        parentSelect.innerHTML = '';

        const existingParents = this.currentRecordTransactions.filter(t => String(t.type) === parentTypeSelect.value && (t.transactionHierarchy === 'parent' || !t.transactionHierarchy));

        if (existingParents.length === 0) {
            const opt = document.createElement('option');
            opt.value = "CREATE_NEW"; opt.textContent = "⚠️ Mevcut İşlem Yok - Önce Yeni Ana İşlem Yaratıp Bağla";
            parentSelect.appendChild(opt);
        } else {
            existingParents.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id; opt.textContent = `${t.description || 'İşlem'} (${new Date(t.timestamp).toLocaleDateString('tr-TR')})`;
                parentSelect.appendChild(opt);
            });
        }
    }

    handleFileChange(event, tabKey) {
        const files = Array.from(event.target.files);
        if (!this.uploadedFilesMap.has(tabKey)) this.uploadedFilesMap.set(tabKey, []);
        
        const currentFiles = this.uploadedFilesMap.get(tabKey);
        files.forEach(file => {
            currentFiles.push({ id: `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, fileObject: file, documentDesignation: '' });
        });
        
        this.renderUploadedFilesList(tabKey);
        this.checkFormCompleteness();
    }

    renderUploadedFilesList(tabKey) {
        const container = document.getElementById('fileListManual');
        if (!container) return;
        const files = this.uploadedFilesMap.get(tabKey) || [];
        
        container.innerHTML = files.map(file => `
            <div class="file-item" style="display:flex; justify-content:space-between; border:1px solid #ccc; padding:10px; margin-bottom:5px;">
                <div><i class="fas fa-file-pdf text-danger mr-2"></i>${file.fileObject.name}</div>
                <button type="button" class="btn btn-sm btn-light remove-uploaded-file" data-file-id="${file.id}" data-tab-key="${tabKey}">
                    <i class="fas fa-times text-danger"></i>
                </button>
            </div>
        `).join('');
    }

    checkFormCompleteness() {
        if (this.activeTab !== 'manual-indexing-pane') return;
        const parentType = document.getElementById('specificManualTransactionType')?.value;
        const childType = document.getElementById('manualChildTransactionType')?.value;
        const existingParent = document.getElementById('manualExistingParentSelect')?.value;

        let canSubmit = this.selectedRecordManual !== null && parentType && parentType !== "";
        if (childType && !existingParent) canSubmit = false;
        
        const btn = document.getElementById('saveManualTransactionBtn');
        if (btn) { btn.disabled = !canSubmit; btn.style.opacity = canSubmit ? '1' : '0.6'; }
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
            transaction_date: txData.date || new Date().toISOString(),
            user_id: this.currentUser.id, 
            user_email: this.currentUser.email,
            task_id: txData.taskId || null, // 🔥 GÖREV BAĞLANTISI
            created_at: new Date().toISOString()
        };
        
        const { error } = await supabase.from('transactions').insert(payload);
        if (error) return { success: false, error: error.message };

        if (txData.documents && txData.documents.length > 0) {
            const docInserts = txData.documents.map(d => ({
                transaction_id: txId, document_name: d.name, document_url: d.url, document_type: d.type || 'application/pdf'
            }));
            await supabase.from('transaction_documents').insert(docInserts);
        }
        return { success: true, id: txId };
    }

    async handleManualTransactionSubmit() {
        const parentTypeId = document.getElementById('specificManualTransactionType')?.value;
        const childTypeId = document.getElementById('manualChildTransactionType')?.value;
        const existingParentId = document.getElementById('manualExistingParentSelect')?.value;
        const deliveryDateStr = document.getElementById('manualTransactionDeliveryDate')?.value;
        const notes = document.getElementById('manualTransactionNotes')?.value;
        const submitBtn = document.getElementById('saveManualTransactionBtn');

        if (!this.selectedRecordManual || !parentTypeId) return;
        submitBtn.disabled = true;

        try {
            if (this.selectedRecordManual._isBulletin) {
                const newRecordData = {
                    title: this.selectedRecordManual.markName || 'İsimsiz Marka',
                    applicationNumber: this.selectedRecordManual.applicationNo || '',
                    recordOwnerType: 'third_party', origin: 'TÜRKPATENT', status: 'published',
                    applicationDate: this.selectedRecordManual.applicationDate || '',
                    brandImageUrl: this.selectedRecordManual.imagePath || null,
                    createdAt: new Date().toISOString()
                };
                const recRes = await ipRecordsService.createRecordFromDataEntry(newRecordData);
                if (!recRes.success) throw new Error("Bülten portföye eklenemedi.");
                this.selectedRecordManual.id = recRes.id;
                this.selectedRecordManual._isBulletin = false; 
                await this._addTransaction(recRes.id, { type: "2", transactionHierarchy: 'parent', description: 'Başvuru', date: newRecordData.applicationDate });
            }

            const filesToUpload = this.uploadedFilesMap.get('manual-indexing-pane') || [];
            const uploadedDocuments = [];

            for (const fileItem of filesToUpload) {
                const file = fileItem.fileObject;
                const cleanName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                const storagePath = `incoming_documents/${this.currentUser.id}/${Date.now()}_${cleanName}`;
                
                await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, file);
                const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
                uploadedDocuments.push({ id: generateUUID(), name: file.name, url: urlData.publicUrl, type: 'application/pdf', path: storagePath });
            }

            let finalParentId = existingParentId === "CREATE_NEW" ? null : existingParentId;
            const isChild = !!childTypeId;

            if (isChild && !finalParentId) {
                const parentTypeObj = this.allTransactionTypes.find(t => String(t.id) === String(parentTypeId));
                const pResult = await this._addTransaction(this.selectedRecordManual.id, {
                    type: parentTypeId, transactionHierarchy: 'parent', description: parentTypeObj ? parentTypeObj.name : 'Ana İşlem'
                });
                finalParentId = pResult.id;
            }

            const targetTypeId = isChild ? childTypeId : parentTypeId;
            const typeObj = this.allTransactionTypes.find(t => String(t.id) === String(targetTypeId));
           
            let createdTaskId = null;
            
            // 🔥 GÖREV (TASK) OLUŞTURMA VE BAĞLAMA BLOĞU
            let tasksToCreate = [];
            if (typeObj && typeObj.task_triggered) {
                tasksToCreate.push(String(typeObj.task_triggered));
            }

            // MÜVEKKİL (TASK OWNER) BULMA
            let taskOwnerId = null;
            try {
                let apps = this.selectedRecordManual.applicants_json;
                if (apps) {
                    if (typeof apps === 'string') apps = JSON.parse(apps);
                    if (Array.isArray(apps) && apps.length > 0 && apps[0].id) {
                        taskOwnerId = apps[0].id;
                    }
                }
            } catch(e) { console.error("JSON parse hatası:", e); }

            if (!taskOwnerId && this.selectedRecordManual.client_id) taskOwnerId = this.selectedRecordManual.client_id;
            if (!taskOwnerId && this.selectedRecordManual.applicants && this.selectedRecordManual.applicants.length > 0) {
                const app = this.selectedRecordManual.applicants[0];
                taskOwnerId = app.id || app.person_id || (app.persons && app.persons.id);
            }

            // 🔥 66 (DEĞERLENDİRME) GÖREVİ İÇİN KONTROL (Burada yoktu, eklendi!)
            if (taskOwnerId && targetTypeId) {
                const recOwnerType = this.selectedRecordManual.recordOwnerType || this.selectedRecordManual.record_owner_type || 'self';
                let isEligibleFor66 = false;
                const cIdStr = String(targetTypeId);

                if (['30', '31', '42', '43'].includes(cIdStr)) {
                    isEligibleFor66 = true;
                } else if (recOwnerType === 'self' && ['32', '33', '34', '35', '50', '51'].includes(cIdStr)) {
                    isEligibleFor66 = true;
                } else if (recOwnerType === 'third_party' && ['51', '52', '31', '32', '35', '36'].includes(cIdStr)) {
                    isEligibleFor66 = true;
                }

                if (isEligibleFor66) {
                    try {
                        const { data: personData } = await supabase.from('persons').select('is_evaluation_required').eq('id', taskOwnerId).single();
                        if (personData && personData.is_evaluation_required && !tasksToCreate.includes("66")) {
                            tasksToCreate.push("66");
                            console.log("🎯 [SİSTEM] Müvekkil için 66 nolu Değerlendirme görevi tetiklendi!");
                        }
                    } catch (e) {}
                }
            }

            // GÖREVLERİ VERİTABANINA YAZ
            if (tasksToCreate.length > 0) {
                if (!taskOwnerId) {
                    console.error("❌ DİKKAT: task_owner_id (Müvekkil) bulunamadı! Görev tabloya yazılamayacak.");
                    showNotification("Bu evrak bir müvekkile bağlı değil. Görev oluşturulamadı!", "error");
                } else {
                    const baseDate = deliveryDateStr ? new Date(deliveryDateStr) : new Date();
                    const duePeriod = typeObj.due_period ? Number(typeObj.due_period) : 60;
                    baseDate.setDate(baseDate.getDate() + duePeriod);

                    for (const tType of tasksToCreate) {
                        console.log(`⏳ [SİSTEM] ${tType} numaralı görev oluşturuluyor...`);
                        
                        const taskResult = await taskService.createTask({
                            title: `${tType === "66" ? "Uzman Değerlendirmesi" : typeObj.name || 'Manuel İşlem'} Görevi`,
                            description: tType === "66" ? `Müvekkil değerlendirme ayarı açık olduğu için tetiklendi.` : `Manuel evrak yüklemesi sonucunda otomatik oluşturuldu.`,
                            task_type_id: String(tType),
                            status: tType === "66" ? 'open' : 'pending',
                            priority: 'medium',
                            ip_record_id: String(this.selectedRecordManual.id),
                            created_by: this.currentUser.id,
                            task_owner_id: String(taskOwnerId),
                            transaction_id: finalParentId ? String(finalParentId) : null,
                            official_due_date: baseDate.toISOString()
                        });

                        if (taskResult.success) {
                            if (tType !== "66") createdTaskId = taskResult.data.id; // Ana görevi transaction'a bağlamak için sakla
                            console.log(`✅ ${tType} Görevi BAŞARIYLA oluşturuldu! Task ID: ${taskResult.data.id}`);
                        } else {
                            console.error(`❌ ${tType} GÖREVİ YAZILAMADI! HATA:`, taskResult.error);
                        }
                    }
                }
            } else {
                console.warn(`ℹ️ [BİLGİ] Seçilen işlem tipi için görev oluşturulmadı.`);
            }

            // İŞLEMİ (TRANSACTION) KAYDET VE GÖREVİ BAĞLA
            const txResult = await this._addTransaction(this.selectedRecordManual.id, {
                type: targetTypeId,
                transactionHierarchy: isChild ? 'child' : 'parent',
                parentId: finalParentId,
                date: deliveryDateStr ? new Date(deliveryDateStr).toISOString() : null,
                description: typeObj ? typeObj.name : notes,
                notes: notes,
                taskId: createdTaskId, // 🔥 SADECE ANA GÖREV ID'Sİ GİDER (66 GİTMEZ)
                documents: uploadedDocuments
            });

            if (txResult && txResult.success) {
                const newTransactionId = txResult.id;
                
                if (uploadedDocuments.length > 0) {
                    for (const doc of uploadedDocuments) {
                        await supabase.from(INCOMING_DOCS_COLLECTION).insert({
                            id: generateUUID(),
                            file_name: doc.name,
                            file_url: doc.url,
                            file_path: doc.path, 
                            document_source: 'manual_entry',
                            status: 'indexed',
                            teblig_tarihi: deliveryDateStr ? new Date(deliveryDateStr).toISOString() : new Date().toISOString(),
                            ip_record_id: this.selectedRecordManual.id,
                            created_transaction_id: newTransactionId,
                            transaction_type_id: targetTypeId,
                            user_id: this.currentUser.id,
                            indexed_at: new Date().toISOString()
                        });
                    }
                } else {
                    await supabase.from(INCOMING_DOCS_COLLECTION).insert({
                        id: generateUUID(),
                        file_name: typeObj ? typeObj.name : 'Sisteme manuel işlem girildi',
                        document_source: 'manual_entry',
                        status: 'indexed',
                        teblig_tarihi: deliveryDateStr ? new Date(deliveryDateStr).toISOString() : new Date().toISOString(),
                        ip_record_id: this.selectedRecordManual.id,
                        created_transaction_id: newTransactionId,
                        transaction_type_id: targetTypeId,
                        user_id: this.currentUser.id,
                        indexed_at: new Date().toISOString()
                    });
                }
            }

            showNotification('İşlem başarıyla kaydedildi!', 'success');
            this.resetForm();
        } catch (error) {
            console.error(error);
            showNotification('Hata: ' + error.message, 'error');
        } finally {
            submitBtn.disabled = false;
        }
    }

    resetForm() {
        ['recordSearchInputManual', 'manualTransactionDeliveryDate', 'manualTransactionNotes'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const select = document.getElementById('specificManualTransactionType');
        if (select) select.selectedIndex = 0;
        this.clearSelectedRecordManual();
        this.uploadedFilesMap.set('manual-indexing-pane', []);
        this.renderUploadedFilesList('manual-indexing-pane');
    }
}