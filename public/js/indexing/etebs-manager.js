// public/js/etebs-manager.js

import { authService, ipRecordsService, supabase } from '../../supabase-config.js';
// --- Modüller ---
import { RecordMatcher } from './record-matcher.js';
import Pagination from '../pagination.js';

// Notification Helper
function showNotification(message, type = 'info') {
    if (window.showNotification) window.showNotification(message, type);
    else console.log(`[${type}] ${message}`);
}

export class ETEBSManager {
    constructor() {
        this.currentMode = 'etebs'; // 'etebs' | 'upload'
        this.matcher = new RecordMatcher(); 
        
        // Veri Havuzları (İndekslenenler kaldırıldı)
        this.matchedDocs = [];
        this.unmatchedDocs = [];

        // Pagination Referansları
        this.paginations = { matched: null, unmatched: null };

        // Başlat
        this.init();
    }

    async init() {
        // 1. Badge'i güncelle
        await this.updateMainBadgeCount();

        // 2. Event Listener'ları kur
        this.bindEvents();

        // 3. Sayfa açılışında Supabase'den evrakları çek
        await this.loadAndProcessDocuments(true);
    }

    async fetchNotifications(isSilent = false, triggerServerSync = false) {
        if (triggerServerSync) {
            await this.triggerServerSync();
        }
        await this.loadAndProcessDocuments(isSilent);
    }

    // ============================================================
    // 1. BADGE YÖNETİMİ
    // ============================================================
    async updateMainBadgeCount() {
        try {
            const { count, error } = await supabase
                .from('incoming_documents')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'pending');
            
            if (error) throw error;

            const badge = document.querySelector('.tab-badge') || document.getElementById('totalBadge');
            if (badge) {
                badge.textContent = count || 0;
                badge.style.display = count > 0 ? 'inline-block' : 'none';
            }
        } catch (error) {
            console.warn('Badge güncelleme hatası:', error);
        }
    }

    // ============================================================
    // 2. EDGE FUNCTION SENKRONİZASYONU (SYNC)
    // ============================================================
    async triggerServerSync() {
        const input = document.getElementById('etebsTokenInput');
        const token = input ? input.value.trim() : null;
        
        const session = await authService.getCurrentSession();
        const user = session?.user;

        if (!token || !user) throw new Error('Token eksik veya oturum bulunamadı.');

        try {
            console.log('🚀 Supabase Edge Function Başlatılıyor... (etebs-fetcher)');

            // 🔥 ÇÖZÜM: Firebase Cloud Function yerine Supabase Edge Function çağrısı
            const { data, error } = await supabase.functions.invoke('etebs-fetcher', {
                body: {
                    action: 'CHECK_LIST_ONLY',
                    token: token,
                    userId: user.id // Supabase user.id formatı
                }
            });

            if (error) throw error;
            return data; 

        } catch (e) {
            console.warn("Sync hatası:", e);
            throw e;
        }
    }

    // ============================================================
    // 3. VERİ ÇEKME VE EŞLEŞTİRME (CORE LOGIC)
    // ============================================================
    async handleFetchButton() {
        const input = document.getElementById('etebsTokenInput');
        const token = input ? input.value.trim() : null;

        if (!token) {
            showNotification('Lütfen geçerli bir ETEBS Token giriniz.', 'warning');
            return;
        }

        if (window.SimpleLoadingController) {
            window.SimpleLoadingController.show({
                text: 'Evraklar İndiriliyor',
                subtext: 'TÜRKPATENT ile bağlantı kuruldu. Yeni tebligatlar çekilip işleniyor, lütfen ayrılmayın...'
            });
        }

        await new Promise(r => setTimeout(r, 200));

        try {
            const result = await this.triggerServerSync();
            if (input) input.value = '';

            if (result && result.success) {
                if (window.SimpleLoadingController) window.SimpleLoadingController.showSuccess('Tüm evraklar başarıyla indirildi ve işlendi.');
                setTimeout(() => { this.loadAndProcessDocuments(false); }, 1500);
            } else {
                throw new Error(result?.error || 'Sunucu işlemi tamamlayamadı.');
            }
        } catch (error) {
            console.error("Sorgu hatası:", error);
            if (window.SimpleLoadingController) window.SimpleLoadingController.hide();
            showNotification('Evraklar çekilirken hata oluştu: ' + error.message, 'error');
        }
    }

    async loadAndProcessDocuments(isBackgroundRefresh = false) {
        if (!isBackgroundRefresh && window.SimpleLoadingController) {
            window.SimpleLoadingController.show({ text: 'Evraklar taranıyor...', subtext: 'Veriler kontrol ediliyor...' });
        }

        try {
            const { data: snapPending, error } = await supabase
                .from('incoming_documents')
                .select('*')
                .eq('status', 'pending')
                .eq('document_source', 'etebs') 
                .limit(150);
                
            if (error) throw error;

            this.matchedDocs = [];
            this.unmatchedDocs = [];

            let needsMatching = false;
            snapPending.forEach(docSnap => {
                if (!docSnap.ip_record_id) {
                    needsMatching = true;
                }
            });

            const portfolioMap = new Map();
            if (needsMatching) {
                if (!isBackgroundRefresh && window.SimpleLoadingController) {
                    window.SimpleLoadingController.updateText('Portföy Taranıyor', 'Yeni evraklar için veritabanı inceleniyor...');
                }
                const recordsResult = await ipRecordsService.getRecords();
                const portfolioRecords = recordsResult.success ? recordsResult.data : [];
                
                portfolioRecords.forEach(record => {
                    [record.applicationNumber, record.applicationNo, record.wipoIR, record.aripoIR]
                        .filter(Boolean)
                        .forEach(num => {
                            const normalized = this.matcher._normalize(num);
                            if (normalized) portfolioMap.set(normalized, record);
                        });
                });
            }

            const updatePromises = [];

            snapPending.forEach(docSnap => {
                const docObj = this._normalizeDocData(docSnap);
                
                if (docObj.matchedRecordId) {
                    docObj.matched = true;
                    this.matchedDocs.push(docObj);
                } else {
                    const rawSearchKey = docObj.dosyaNo || docObj.applicationNo || docObj.extractedAppNumber || docObj.evrakNo;
                    const searchKey = this.matcher._normalize(rawSearchKey);
                    const match = searchKey ? portfolioMap.get(searchKey) : null;

                    if (match) {
                        docObj.matched = true;
                        docObj.matchedRecordId = match.id;
                        docObj.matchedRecordDisplay = this.matcher.getDisplayLabel(match);
                        this.matchedDocs.push(docObj);

                        // 1. Gelen Evraklar (incoming_documents) tablosunu güncelle
                        updatePromises.push(supabase.from('incoming_documents').update({
                            ip_record_id: match.id
                        }).eq('id', docSnap.id));

                        // 🔥 ÇÖZÜM: 2. Bildirim logları (etebs_notifications) tablosunu da güncelle
                        updatePromises.push(supabase.from('etebs_notifications').update({
                            ip_record_id: match.id
                        }).eq('id', docSnap.id));

                    } else {
                        docObj.matched = false;
                        this.unmatchedDocs.push(docObj);
                    }
                }
            });

            if (updatePromises.length > 0) {
                Promise.all(updatePromises).catch(err => console.error("DB Match güncelleme hatası:", err));
            }

            this.renderAllTabs();
            this.updateMainBadgeCount(); 

            if (!isBackgroundRefresh) {
                showNotification(`${this.matchedDocs.length} eşleşen, ${this.unmatchedDocs.length} bekleyen evrak listelendi.`, 'success');
            }

        } catch (error) {
            console.error('Veri yükleme hatası:', error);
            if (!isBackgroundRefresh) showNotification('Evrak listesi alınamadı.', 'error');
        } finally {
            if (!isBackgroundRefresh && window.SimpleLoadingController) window.SimpleLoadingController.hide();
        }
    }

    _normalizeDocData(data) {
        return {
            id: data.id,
            ...data,
            fileName: data.file_name || 'Belge',
            fileUrl: data.file_url,
            dosyaNo: data.application_number,
            evrakNo: data.document_number,
            matchedRecordId: data.ip_record_id,
            source: data.document_source,
            uploadedAt: this._toDate(data.created_at),
            belgeTarihi: this._toDate(data.belge_tarihi),
            tebligTarihi: this._toDate(data.teblig_tarihi)
        };
    }

    _toDate(timestamp) {
        if (!timestamp) return null;
        if (typeof timestamp.toDate === 'function') return timestamp.toDate();
        if (timestamp instanceof Date) return timestamp;
        const d = new Date(timestamp);
        return isNaN(d.getTime()) ? null : d;
    }

    // ============================================================
    // 4. UI RENDER VE PAGINATION
    // ============================================================
    renderAllTabs() {
        this._updateTabBadge('etebsMatchedBadge', this.matchedDocs.length);
        this._updateTabBadge('etebsUnmatchedBadge', this.unmatchedDocs.length);

        const sortFn = (a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0);

        this.setupPagination('matched', this.matchedDocs.sort(sortFn), 'etebsMatchedList');
        this.setupPagination('unmatched', this.unmatchedDocs.sort(sortFn), 'etebsUnmatchedList');

        this._autoSwitchTab();
    }

    _updateTabBadge(id, count) {
        const el = document.getElementById(id);
        if (el) el.textContent = count;
    }

    _autoSwitchTab() {
        const activeBtn = document.querySelector('.notification-tab-btn.active');
        if (!activeBtn) return;

        const currentTarget = activeBtn.getAttribute('data-target');
        
        if (currentTarget === 'etebs-matched-tab' && this.matchedDocs.length === 0 && this.unmatchedDocs.length > 0) {
            this.switchNotificationsTab('etebs-unmatched-tab');
        } else if (currentTarget === 'etebs-unmatched-tab' && this.unmatchedDocs.length === 0 && this.matchedDocs.length > 0) {
            this.switchNotificationsTab('etebs-matched-tab');
        }
    }

    setupPagination(type, dataList, containerId) {
        const paginationId = type === 'matched' ? 'etebsMatchedPagination' : 'etebsUnmatchedPagination';
        
        if (this.paginations[type]) { this.paginations[type].destroy?.(); }

        if (typeof Pagination !== 'undefined') {
            this.paginations[type] = new Pagination({
                containerId: paginationId,
                itemsPerPage: 10,
                showItemsPerPageSelector: true,
                onPageChange: (currentPage, itemsPerPage) => {
                    const start = (currentPage - 1) * itemsPerPage;
                    const pageItems = dataList.slice(start, start + itemsPerPage);
                    this.renderListItems(containerId, pageItems, type);
                }
            });
            this.paginations[type].update(dataList.length);
        }
        
        this.renderListItems(containerId, dataList.slice(0, 10), type);
    }

    renderListItems(containerId, items, type) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (items.length === 0) {
            container.innerHTML = `<div class="empty-state" style="padding:20px; text-align:center; color:#999;">
                <i class="fas fa-folder-open fa-2x mb-2"></i><br>Kayıt bulunamadı
            </div>`;
            return;
        }

        container.innerHTML = items.map(item => this._createItemHTML(item, type)).join('');

        container.querySelectorAll('.notification-action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this._handleItemAction(e, items));
        });
    }

    _createItemHTML(doc, type) {
        const dateStr = doc.uploadedAt ? doc.uploadedAt.toLocaleDateString('tr-TR') : '-';
        const isManual = (doc.source === 'manual' || doc.source === 'MANUEL');
        
        const sourceBadge = isManual 
            ? '<span class="badge badge-warning text-white mr-2" style="font-size:0.7em;">MANUEL</span>' 
            : '<span class="badge badge-info mr-2" style="font-size:0.7em;">ETEBS</span>';

        let statusHtml = '';
        let actionBtn = '';

        if (type === 'matched') {
            statusHtml = `<span class="text-success font-weight-bold"><i class="fas fa-link"></i> ${doc.matchedRecordDisplay || 'Eşleşti'}</span>`;
            actionBtn = `<button class="btn btn-primary btn-sm notification-action-btn" data-action="index" data-id="${doc.id}" title="İndeksle">
                            <i class="fas fa-edit"></i>
                         </button>`;
        } else if (type === 'unmatched') {
            statusHtml = `<span class="text-danger"><i class="fas fa-times"></i> Eşleşmedi</span>`;
            actionBtn = `<button class="btn btn-outline-primary btn-sm notification-action-btn" data-action="index" data-id="${doc.id}" title="Manuel İndeksle">
                            <i class="fas fa-edit"></i>
                         </button>`;
        }

        return `
            <div class="pdf-list-item ${type} p-3 mb-2 bg-white rounded border shadow-sm" style="border-left: 4px solid ${type==='matched'?'#28a745':'#dc3545'} !important;">
                <div class="d-flex align-items-center w-100">
                    <div class="pdf-icon mr-3">
                        <i class="fas fa-file-pdf fa-2x text-danger"></i>
                    </div>
                    <div style="flex:1">
                        <div class="mb-1 d-flex align-items-center">
                            ${sourceBadge} 
                            <strong class="text-dark">${doc.fileName || doc.belgeAciklamasi || 'İsimsiz Belge'}</strong>
                        </div>
                        <div class="small text-muted">
                            <i class="far fa-calendar-alt"></i> ${dateStr} • 
                            <strong>Evrak No:</strong> ${doc.evrakNo || '-'} • 
                            <strong>Dosya:</strong> ${doc.dosyaNo || '-'}
                        </div>
                        <div class="small mt-1">${statusHtml}</div>
                    </div>
                    <div class="ml-2 d-flex flex-column align-items-end">
                        <button class="btn btn-success btn-sm notification-action-btn mb-1" data-action="show" data-id="${doc.id}" title="Görüntüle">
                            <i class="fas fa-eye"></i>
                        </button>
                        ${actionBtn}
                    </div>
                </div>
            </div>
        `;
    }

    _handleItemAction(e, items) {
        const btn = e.target.closest('.notification-action-btn');
        if (!btn) return;
        e.stopPropagation();

        const action = btn.dataset.action;
        const id = btn.dataset.id;
        const doc = items.find(i => i.id === id);

        if (!doc) return;

        if (action === 'show') {
            if (doc.fileUrl) window.open(doc.fileUrl, '_blank');
            else showNotification('Dosya URL\'i bulunamadı', 'error');
        } else if (action === 'index') {
            const q = doc.dosyaNo || doc.evrakNo || '';
            const recordId = doc.matchedRecordId || '';
            
            const targetDate = doc.tebligTarihi || doc.uploadedAt;
            let dateStr = '';
            
            if (targetDate) {
                const yyyy = targetDate.getFullYear();
                const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
                const dd = String(targetDate.getDate()).padStart(2, '0');
                dateStr = `${yyyy}-${mm}-${dd}`;
            }
            
            window.location.href = `indexing-detail.html?pdfId=${encodeURIComponent(doc.id)}&q=${encodeURIComponent(q)}&recordId=${encodeURIComponent(recordId)}&deliveryDate=${encodeURIComponent(dateStr)}`;
        }
    }

    // ============================================================
    // 5. TAB, MOD VE UPLOAD YÖNETİMİ
    // ============================================================
    bindEvents() {
        const fetchBtn = document.getElementById('fetchNotificationsBtn');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.handleFetchButton();
            });
        }

        document.querySelectorAll('.notification-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.switchNotificationsTab(btn.getAttribute('data-target'));
            });
        });

        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.switchMode(e.target.dataset.mode);
            });
        });
    }

    switchNotificationsTab(targetId) {
        document.querySelectorAll('.notification-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-target') === targetId);
        });
        document.querySelectorAll('.notification-tab-pane').forEach(pane => {
            pane.classList.toggle('active', pane.id === targetId);
            if (pane.id === targetId) {
                pane.style.display = 'block';
            } else {
                pane.style.display = 'none';
            }
        });
    }

    switchMode(mode) {
        this.currentMode = mode;
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        
        const etebsContent = document.getElementById('etebs-content');
        const uploadContent = document.getElementById('upload-content');

        if(etebsContent) etebsContent.style.display = mode === 'etebs' ? 'block' : 'none';
        if(uploadContent) uploadContent.style.display = mode === 'upload' ? 'block' : 'none';
    }
}

window.ETEBSManager = ETEBSManager;