import { PortfolioDataManager } from './PortfolioDataManager.js';
import { PortfolioRenderer } from './PortfolioRenderer.js';
import { authService, monitoringService, waitForAuthUser, redirectOnLogout } from '../../supabase-config.js';
import { loadSharedLayout } from '../layout-loader.js';
import { showNotification } from '../../utils.js';
import Pagination from '../pagination.js';

class PortfolioController {
    constructor() {
        this.dataManager = new PortfolioDataManager();
        this.renderer = new PortfolioRenderer('portfolioTableBody', this.dataManager);
        this.pagination = null;
        this.ITEMS_PER_PAGE = 50;
        
        this.state = {
            activeTab: 'trademark',
            subTab: 'turkpatent',
            searchQuery: '',
            columnFilters: {},
            sort: { column: 'applicationDate', direction: 'desc' },
            currentPage: 1,
            selectedRecords: new Set(),
            updatedRecordId: null // Güncellenen kaydı yeşil yakmak için
        };
        this.filterDebounceTimer = null;
        this.init();
    }

    async init() {
        const user = await waitForAuthUser({ requireAuth: true, redirectTo: 'index.html', graceMs: 1200 });
        if (!user) return; 

        redirectOnLogout('index.html', 1200);

        await loadSharedLayout({ activeMenuLink: 'portfolio.html' });
        this.renderer.showLoading(true);

        // Düzenleme ekranından dönüldüyse eski state'i (filtreleri vs.) yükle
        const savedStateStr = sessionStorage.getItem('portfolioState');
        let restoredState = null;
        if (savedStateStr) {
            try {
                restoredState = JSON.parse(savedStateStr);
                this.state.activeTab = restoredState.activeTab || 'trademark';
                this.state.subTab = restoredState.subTab || 'turkpatent';
                this.state.searchQuery = restoredState.searchQuery || '';
                this.state.columnFilters = restoredState.columnFilters || {};
                this.state.sort = restoredState.sort || { column: 'applicationDate', direction: 'desc' };
                this.state.currentPage = restoredState.currentPage || 1;
                
                setTimeout(() => {
                    const searchInput = document.getElementById('searchBar');
                    if (searchInput && this.state.searchQuery) searchInput.value = this.state.searchQuery;
                }, 100);
            } catch (e) { console.error("State parse hatası:", e); }
            sessionStorage.removeItem('portfolioState'); 
        }

        if (!restoredState) {
            const urlParams = new URLSearchParams(window.location.search);
            const tabParam = urlParams.get('activeTab');
            if (tabParam && ['all', 'trademark', 'patent', 'design', 'litigation', 'objections'].includes(tabParam)) {
                this.state.activeTab = tabParam;
            }
        }

        const tabButtons = document.querySelectorAll('.tab-button');
        if (tabButtons.length > 0) {
            tabButtons.forEach(btn => btn.classList.remove('active'));
            const activeBtn = document.querySelector(`.tab-button[data-type="${this.state.activeTab}"]`);
            if (activeBtn) activeBtn.classList.add('active');
        }

        try {
            const recordsPromise = this.dataManager.loadRecords(); // hemen başlat, bekleme
            await this.dataManager.loadInitialData();               // countries + txTypes bekle
            await recordsPromise;                                   // büyük ihtimalle çoktan bitmiş

            if (this.state.activeTab === 'litigation') {
                await this.dataManager.loadLitigationData();
            } else if (this.state.activeTab === 'objections') {
                await this.dataManager.loadObjectionRows();
            }

            this.setupPagination();
            if (this.pagination) {
                this.pagination.currentPage = this.state.currentPage;
            }

            const columns = this.getColumns(this.state.activeTab);
            this.renderer.renderHeaders(columns, this.state.columnFilters);
            this.updateSortIcons(); 

            const subMenu = document.getElementById('trademarkSubMenu');
            if (subMenu) {
                if (this.state.activeTab === 'trademark') {
                    subMenu.style.display = 'flex';
                    this.updateSubTabUI(); 
                } else {
                    subMenu.style.display = 'none';
                }
            }
            
            this.render();

            setTimeout(() => {
                const updatedId = sessionStorage.getItem('updatedRecordId');
                if (updatedId) {
                    this.state.updatedRecordId = updatedId; 
                    this.highlightUpdatedRow(updatedId, true); 
                    sessionStorage.removeItem('updatedRecordId'); 
                }
            }, 800);

            // 🔥 ÇÖZÜM: Yeni Sekmede (data-entry) kayıt eklendiğinde/güncellendiğinde burayı tazelemek
            window.addEventListener('storage', async (e) => {
                if (e.key === 'crossTabUpdatedRecordId' && e.newValue) {
                    this.state.updatedRecordId = e.newValue;
                    
                    this.dataManager.clearCache(); // Önbelleği (RAM'i) boşalt

                    // Aktif sekmeye göre veriyi Supabase'den taze çek
                    if (this.state.activeTab === 'litigation') {
                        await this.dataManager.loadLitigationData();
                    } else if (this.state.activeTab === 'objections') {
                        await this.dataManager.loadObjectionRows(true);
                    } else {
                        await this.dataManager.loadRecords(); 
                    }

                    this.render();

                    setTimeout(() => {
                        this.highlightUpdatedRow(e.newValue, false);
                    }, 500); 
                    
                    localStorage.removeItem('crossTabUpdatedRecordId');
                }
            });

            this.setupEventListeners();
            this.setupFilterListeners();
            this.setupImageHover();

        } catch (e) {
            console.error('Init hatası:', e);
            showNotification('Veriler yüklenirken hata oluştu', 'error');
        } finally {
            this.renderer.showLoading(false);
        }
    }

    setupImageHover() {
        let previewEl = document.getElementById('floating-preview');
        if (!previewEl) {
            previewEl = document.createElement('img');
            previewEl.id = 'floating-preview';
            previewEl.className = 'floating-trademark-preview';
            document.body.appendChild(previewEl);
        }

        const tableBody = document.getElementById('portfolioTableBody');
        if (!tableBody) return;
        
        tableBody.addEventListener('mouseover', (e) => {
            if (e.target.classList.contains('trademark-image-thumbnail')) {
                const src = e.target.src;
                if (src && src.length > 10) {
                    previewEl.src = src;
                    const rect = e.target.getBoundingClientRect();
                    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
                    const leftPos = rect.right + 15;
                    const topPos = rect.top + scrollTop - 50;
                    previewEl.style.left = leftPos + 'px';
                    previewEl.style.top = topPos + 'px';
                    previewEl.style.display = 'block';
                    previewEl.style.opacity = '1';
                }
            }
        });
        
        tableBody.addEventListener('mouseout', (e) => {
            if (e.target.classList.contains('trademark-image-thumbnail')) {
                previewEl.style.display = 'none';
                previewEl.style.opacity = '0';
            }
        });
    }
    
    setupFilterListeners() {
        const thead = document.querySelector('.portfolio-table thead');
        if (thead) {
            thead.addEventListener('input', (e) => {
                if (e.target.classList.contains('column-filter')) {
                    const key = e.target.dataset.key;
                    const value = e.target.value;
                    clearTimeout(this.filterDebounceTimer);
                    this.filterDebounceTimer = setTimeout(() => {
                        this.state.columnFilters[key] = value;
                        this.state.currentPage = 1;
                        this.render();
                    }, 300);
                }
            });
        }
    }

    setupPagination() {
        const container = document.getElementById('paginationContainer');
        if (!container) return;

        this.pagination = new Pagination({
            containerId: 'paginationContainer',
            itemsPerPage: this.ITEMS_PER_PAGE,
            itemsPerPageOptions: [10, 20, 50, 100, 500, 1000],
            // 🔥 ÇÖZÜM 2: Parametreye newItemsPerPage eklendi ve class değişkenine eşitlendi
            onPageChange: (page, newItemsPerPage) => {
                this.state.currentPage = page;
                if (newItemsPerPage) {
                    this.ITEMS_PER_PAGE = newItemsPerPage;
                }
                this.render(); 
                this.updateSelectAllCheckbox();
                document.querySelector('.portfolio-table-container')?.scrollIntoView({ behavior: 'smooth' });
            }
        });
    }

    updateSortIcons() {
        document.querySelectorAll('.portfolio-table thead th.sortable-header').forEach(th => {
            th.classList.remove('asc', 'desc', 'inactive');
            if (th.dataset.column === this.state.sort.column) {
                th.classList.add(this.state.sort.direction);
            } else {
                th.classList.add('inactive');
            }
        });
    }

    setupEventListeners() {
        const thead = document.querySelector('.portfolio-table thead');
        if (thead) {
            thead.addEventListener('click', (e) => {
                const th = e.target.closest('th.sortable-header');
                if (!th) return;

                const column = th.dataset.column;
                if (!column) return;

                if (this.state.sort.column === column) {
                    this.state.sort.direction = this.state.sort.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    this.state.sort.column = column;
                    this.state.sort.direction = 'asc';
                }

                this.updateSortIcons();
                this.render();
            });
        }

        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if (this.isTabLoading) return;

                document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));

                const targetBtn = e.target.closest('.tab-button');
                if (targetBtn) {
                    targetBtn.classList.add('active');
                    this.state.activeTab = targetBtn.dataset.type;
                }

                const subMenu = document.getElementById('trademarkSubMenu');
                if (subMenu) {
                    if (this.state.activeTab === 'trademark') {
                        subMenu.style.display = 'flex';
                        this.state.subTab = 'turkpatent'; 
                        this.updateSubTabUI();
                    } else {
                        subMenu.style.display = 'none';
                        this.state.subTab = null;
                    }
                }

                this.isTabLoading = true;
                this.renderer.showLoading(true);

                try {
                    if (this.state.activeTab === 'litigation' && this.dataManager.litigationRows.length === 0) {
                        await this.dataManager.loadLitigationData();
                    } else if (this.state.activeTab === 'objections') {
                        if (this.dataManager.objectionRows.length === 0) {
                            await this.dataManager.loadObjectionRows();
                        }
                        setTimeout(async () => {
                            await this.dataManager.loadObjectionRows(true);
                            if (this.state.activeTab === 'objections') {
                                this.render();
                                this.updateSelectAllCheckbox();
                            }
                        }, 500); 
                    }
                } catch (err) {
                    console.error("Sekme verisi yüklenemedi:", err);
                } finally {
                    this.isTabLoading = false;
                }

                this.state.currentPage = 1;
                this.state.searchQuery = '';
                this.state.columnFilters = {};
                this.state.selectedRecords.clear();

                const searchInput = document.getElementById('searchInput');
                if (searchInput) searchInput.value = '';

                const columns = this.getColumns(this.state.activeTab);
                this.renderer.renderHeaders(columns, this.state.columnFilters);

                this.renderer.clearTable();
                this.render();
            });
        });

        const subTabButtons = document.querySelectorAll('#trademarkSubMenu button');
        if (subTabButtons) {
            subTabButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    subTabButtons.forEach(b => b.classList.remove('active'));
                    const clickedBtn = e.target.closest('button');
                    clickedBtn.classList.add('active');

                    this.state.subTab = clickedBtn.dataset.sub;
                    this.state.currentPage = 1;
                    this.state.selectedRecords.clear();

                    // 🔥 ÇÖZÜM 1: Alt sekmeye tıklandığında başlıkların da güncellenmesini sağlıyoruz
                    const columns = this.getColumns(this.state.activeTab);
                    this.renderer.renderHeaders(columns, this.state.columnFilters);

                    this.render();
                });
            });
        }

        const searchInput = document.getElementById('searchBar');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                if (this.searchTimeout) clearTimeout(this.searchTimeout);
                this.searchTimeout = setTimeout(() => {
                    this.state.searchQuery = e.target.value.trim();
                    this.state.currentPage = 1;
                    this.render();
                }, 300);
            });
        }

        const clearFiltersBtn = document.getElementById('clearFilters');
        if (clearFiltersBtn) {
            clearFiltersBtn.addEventListener('click', () => {
                this.state.searchQuery = '';
                this.state.columnFilters = {};
                if (searchInput) searchInput.value = '';
                document.querySelectorAll('.column-filter-input').forEach(input => input.value = '');
                this.render();
            });
        }

        const btnExportSelected = document.getElementById('btnExportSelected');
        const btnExportAll = document.getElementById('btnExportAll');
        const exportPdfBtn = document.getElementById('exportPdfBtn');

        // 🔥 KESİN ÇÖZÜM: addEventListener silindi, onclick ile üst üste binme engellendi!
        if (btnExportSelected) btnExportSelected.onclick = (e) => { e.preventDefault(); this.exportToExcel('selected'); };
        if (btnExportAll) btnExportAll.onclick = (e) => { e.preventDefault(); this.exportToExcel('all'); };
        if (exportPdfBtn) exportPdfBtn.onclick = (e) => { e.preventDefault(); this.exportToPdf(); };

        const portfolioTableBody = document.getElementById('portfolioTableBody');
        if (portfolioTableBody) {
            portfolioTableBody.addEventListener('change', (e) => {
                if (e.target.classList.contains('record-checkbox')) {
                    const id = e.target.dataset.id;
                    if (e.target.checked) {
                        this.state.selectedRecords.add(String(id));
                    } else {
                        this.state.selectedRecords.delete(String(id));
                    }
                    this.updateActionButtons();
                }
            });

            portfolioTableBody.addEventListener('click', (e) => {
                const caret = e.target.closest('.row-caret') ||
                    (e.target.closest('tr.group-header') && !e.target.closest('button, a, input, .action-btn'));

                if (caret) {
                    this.toggleAccordion(e.target.closest('tr') || caret);
                    return;
                }

                const btn = e.target.closest('.action-btn');
                if (btn) {
                    e.stopPropagation();
                    const id = btn.dataset.id;
                    if (!id) return;

                    if (btn.classList.contains('view-btn')) {
                        if (this.state.activeTab === 'litigation') {
                            window.open(`suit-detail.html?id=${id}`, '_blank');
                        } else {
                            const record = this.dataManager.getRecordById(id);
                            if (record) {
                                const isTP = [record.origin, record.source].map(s => (s||'').toUpperCase()).some(s => s.includes('TURKPATENT') || s.includes('TÜRKPATENT'));
                                const appNo = record.applicationNumber;

                                if (isTP && appNo) {
                                    if (window.triggerTpQuery) {
                                        window.triggerTpQuery(appNo);
                                    } else {
                                        window.open(`https://opts.turkpatent.gov.tr/trademark#bn=${encodeURIComponent(appNo)}`, '_blank');
                                    }
                                } else {
                                    window.open(`portfolio-detail.html?id=${id}`, '_blank', 'noopener');
                                }
                            } else {
                                window.open(`portfolio-detail.html?id=${id}`, '_blank', 'noopener');
                            }
                        }
                    } else if (btn.classList.contains('edit-btn')) {
                        const stateToSave = {
                            activeTab: this.state.activeTab,
                            subTab: this.state.subTab,
                            searchQuery: this.state.searchQuery,
                            columnFilters: this.state.columnFilters,
                            sort: this.state.sort,
                            currentPage: this.state.currentPage
                        };
                        sessionStorage.setItem('portfolioState', JSON.stringify(stateToSave));

                        if (this.state.activeTab === 'litigation') {
                            window.open(`suit-detail.html?id=${id}`, '_blank');
                        } else {
                            window.open(`data-entry.html?id=${id}`, '_blank');
                        }
                    } else if (btn.classList.contains('delete-btn')) {
                        this.handleDelete(id);
                    }
                }
            });
        }

        const selectAllCheckbox = document.getElementById('selectAllCheckbox');
        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                const checkboxes = document.querySelectorAll('.record-checkbox');

                checkboxes.forEach(cb => {
                    cb.checked = isChecked;
                    const id = cb.dataset.id;
                    if (isChecked) {
                        this.state.selectedRecords.add(String(id));
                    } else {
                        this.state.selectedRecords.delete(String(id));
                    }
                });
                this.updateActionButtons(); 
            });
        }

        const toggleStatusBtn = document.getElementById('toggleRecordStatusBtn');
        if (toggleStatusBtn) {
            toggleStatusBtn.addEventListener('click', () => this.handleBulkStatusChange());
        }

        const addToMonitoringBtn = document.getElementById('addToMonitoringBtn');
        if (addToMonitoringBtn) {
            addToMonitoringBtn.addEventListener('click', () => this.handleBulkMonitoring());
        }

        document.getElementById('refreshPortfolioBtn')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const icon = btn.querySelector('i');
            icon.classList.add('fa-spin'); 
            
            try {
                if (window.localCache) await window.localCache.remove('ip_records_cache');
                
                // RAM'deki veriyi de temizle ki Supabase'e gitsin
                this.dataManager.clearCache();
                
                await this.init(); 
            } catch (err) {
                console.error("Yenileme hatası:", err);
            } finally {
                icon.classList.remove('fa-spin');
            }
        });
    }

    updateActionButtons() {
        const count = this.state.selectedRecords.size;
        const hasSelection = count > 0;

        const statusBtn = document.getElementById('toggleRecordStatusBtn');
        if (statusBtn) {
            statusBtn.disabled = !hasSelection;
            statusBtn.textContent = hasSelection ? `Pasifle (${count})` : 'Pasifle';
        }

        const monitorBtn = document.getElementById('addToMonitoringBtn');
        if (monitorBtn) {
            monitorBtn.disabled = !hasSelection;
            monitorBtn.textContent = hasSelection ? `İzlemeye Ekle (${count})` : 'İzlemeye Ekle';
        }
        
        const exportSelectedBtn = document.getElementById('btnExportSelected');
        if (exportSelectedBtn) {
            if (!hasSelection) exportSelectedBtn.classList.add('disabled');
            else exportSelectedBtn.classList.remove('disabled');
        }

        // 🔥 YENİ: Tekil Seçim (Hızlı Aksiyon) Butonu Mantığı
        // Önce sayfadaki var olan tüm hızlı butonları temizle (birden fazla seçim olursa kaybolması için)
        document.querySelectorAll('.quick-monitor-btn').forEach(btn => btn.remove());

        // Eğer SADECE 1 TANE marka seçiliyse ve Markalar sekmesindeysek
        if (count === 1 && this.state.activeTab === 'trademark') {
            const selectedId = Array.from(this.state.selectedRecords)[0];
            const isAlreadyMonitored = this.dataManager.isRecordMonitored(selectedId);
            
            // Eğer marka zaten izleme listesinde DEĞİLSE butonu oluştur
            if (!isAlreadyMonitored) {
                const tr = document.querySelector(`tr[data-id="${selectedId}"]`);
                if (tr) {
                    const titleCell = tr.querySelector('.record-title-cell');
                    if (titleCell) {
                        const quickBtn = document.createElement('button');
                        quickBtn.className = 'btn btn-sm btn-success quick-monitor-btn ml-3 shadow-sm';
                        quickBtn.style.padding = '2px 10px';
                        quickBtn.style.fontSize = '0.75rem';
                        quickBtn.style.borderRadius = '12px';
                        quickBtn.innerHTML = '<i class="fas fa-plus mr-1"></i>Hemen İzlemeye Al';
                        
                        // Tıklanınca tekil ekleme fonksiyonunu çalıştır
                        quickBtn.onclick = (e) => {
                            e.stopPropagation();
                            this.handleSingleMonitoring(selectedId);
                        };
                        titleCell.appendChild(quickBtn);
                    }
                }
            }
        }
    }

    getCurrentPageRecords() {
        let filtered = this.dataManager.filterRecords(this.state.activeTab, this.state.searchQuery, this.state.columnFilters,this.state.subTab);
        filtered = this.dataManager.sortRecords(filtered, this.state.sort.column, this.state.sort.direction);
        return this.pagination ? this.pagination.getCurrentPageData(filtered) : filtered;
    }

    updateSelectAllCheckbox() {
        const selectAllCb = document.getElementById('selectAllCheckbox');
        if (!selectAllCb) return;
        const pageRecords = this.getCurrentPageRecords();
        if (pageRecords.length === 0) { selectAllCb.checked = false; return; }
        selectAllCb.checked = pageRecords.every(r => this.state.selectedRecords.has(r.id));
    }

    toggleAccordion(target) {
        const tr = target.closest('tr');
        if (tr && tr.dataset.groupId) {
            const groupId = tr.dataset.groupId;
            const isExpanded = tr.getAttribute('aria-expanded') === 'true';
            tr.setAttribute('aria-expanded', !isExpanded);
            const icon = tr.querySelector('.row-caret');
            if(icon) icon.className = !isExpanded ? 'fas fa-chevron-down row-caret' : 'fas fa-chevron-right row-caret';
            const children = document.querySelectorAll(`tr.child-row[data-parent-id="${groupId}"]`);
            children.forEach(child => child.style.display = !isExpanded ? 'table-row' : 'none');
        }
    }

    async handleBulkStatusChange() {
        if (this.state.selectedRecords.size === 0) return;
        if (!confirm(`${this.state.selectedRecords.size} kaydın durumu değiştirilecek. Emin misiniz?`)) return;
        try {
            this.renderer.showLoading(true);
            await this.dataManager.toggleRecordsStatus(Array.from(this.state.selectedRecords));
            showNotification('Kayıtların durumu güncellendi.', 'success');
            this.state.selectedRecords.clear();
            this.updateActionButtons();
            
            // 🔥 ÇÖZÜM: İşlem bitince RAM'i temizle ve taze veriyi çek
            this.dataManager.clearCache();
            await this.dataManager.loadRecords(); 
            this.render();
        } catch (e) { showNotification('Hata: ' + e.message, 'error'); } 
        finally { this.renderer.showLoading(false); }
    }

    async handleBulkMonitoring() {
        if (this.state.selectedRecords.size === 0) return;
        try {
            this.renderer.showLoading(true);
            const ids = Array.from(this.state.selectedRecords);
            let successCount = 0;
            for (const id of ids) {
                const record = this.dataManager.getRecordById(id);
                if (!record || record.type !== 'trademark') continue;
                const monitoringData = this.dataManager.prepareMonitoringData(record);
                if(monitoringData) {
                    const res = await monitoringService.addMonitoringItem(monitoringData);
                    if (res.success) {
                        successCount++;
                        // 🔥 YENİ: Anında listeye dahil et (Sayfa yenilemeden yeşil olması için)
                        this.dataManager.monitoredRecordIds.add(String(id));
                    }
                }
            }
            if(typeof showNotification === 'function') {
                showNotification(`${successCount} kayıt izlemeye eklendi.`, 'success');
            }
            this.state.selectedRecords.clear();
            this.updateActionButtons();
            this.render();
        } catch (e) { 
            if(typeof showNotification === 'function') {
                showNotification('Hata: ' + e.message, 'error'); 
            }
        }
        finally { this.renderer.showLoading(false); }
    }

    // 🔥 YENİ: Satır içindeki butona tıklandığında sadece o markayı izlemeye alır
    async handleSingleMonitoring(id) {
        try {
            this.renderer.showLoading(true);
            const record = this.dataManager.getRecordById(id);
            if (!record || record.type !== 'trademark') return;
            
            const monitoringData = this.dataManager.prepareMonitoringData(record);
            if (monitoringData) {
                const res = await monitoringService.addMonitoringItem(monitoringData);
                if (res.success) {
                    // RAM'e ekle (sayfa yenilenmeden yeşil olması için)
                    this.dataManager.monitoredRecordIds.add(String(id));
                    if(typeof showNotification === 'function') {
                        showNotification('Marka başarıyla izlemeye eklendi.', 'success');
                    }
                    // İşlem bitince kutucuğun seçimini kaldır ve sayfayı tekrar çiz
                    this.state.selectedRecords.clear(); 
                    this.updateActionButtons();
                    this.render(); 
                } else {
                    throw new Error("Ekleme işlemi başarısız oldu.");
                }
            }
        } catch (e) { 
            if(typeof showNotification === 'function') {
                showNotification('Hata: ' + e.message, 'error'); 
            }
        } finally { 
            this.renderer.showLoading(false); 
        }
    }

    async handleDelete(id) {
        if (!confirm('Bu kaydı silmek istediğinize emin misiniz?')) return;
        try {
            this.renderer.showLoading(true);
            await this.dataManager.deleteRecord(id);
            showNotification('Kayıt silindi.', 'success');
            
            this.dataManager.clearCache();
            if (this.state.activeTab === 'litigation') {
                await this.dataManager.loadLitigationData();
            } else if (this.state.activeTab === 'objections') {
                await this.dataManager.loadObjectionRows();
            } else {
                await this.dataManager.loadRecords();
            }
            
            this.render();
        } catch (e) { showNotification('Silme hatası: ' + e.message, 'error'); }
        finally { this.renderer.showLoading(false); }
    }

    updateSubTabUI() {
        const subBtns = document.querySelectorAll('#trademarkSubMenu button');
        if (subBtns) {
            subBtns.forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.sub === this.state.subTab) {
                    btn.classList.add('active');
                }
            });
        }
    }
    
    async render() {
        if (this.isTabLoading) return;
        this.renderer.showLoading(true);
        this.renderer.clearTable();

        let filtered = this.dataManager.filterRecords(
            this.state.activeTab, 
            this.state.searchQuery, 
            this.state.columnFilters,
            this.state.subTab 
        );

        filtered = this.dataManager.sortRecords(filtered, this.state.sort.column, this.state.sort.direction);
        this.state.filteredData = filtered;

        const totalItems = filtered.length;
        if (this.pagination) {
            this.pagination.update(totalItems);
        }

        if (totalItems === 0) {
            this.renderer.renderEmptyState();
            this.renderer.showLoading(false);
            return;
        }

        const startIndex = (this.state.currentPage - 1) * this.ITEMS_PER_PAGE;
        const endIndex = startIndex + this.ITEMS_PER_PAGE;
        const pageData = filtered.slice(startIndex, endIndex);
        const frag = document.createDocumentFragment();

        pageData.forEach((item, index) => {
            const globalIndex = startIndex + index + 1;

            if (this.state.activeTab === 'objections') {
                const tr = this.renderer.renderObjectionRow(item, item.children && item.children.length > 0, false);
                frag.appendChild(tr);

                if (item.children && item.children.length > 0) {
                    item.children.forEach(childItem => {
                        const childTr = this.renderer.renderObjectionRow(childItem, false, true);
                        childTr.style.display = 'none'; 
                        frag.appendChild(childTr);
                    });
                }
            } else if (this.state.activeTab === 'litigation') {
                if (this.renderer.renderLitigationRow) {
                    frag.appendChild(this.renderer.renderLitigationRow(item, globalIndex));
                }
            } else {
                const isSelected = this.state.selectedRecords.has(String(item.id));
                const isMonitored = this.dataManager.isRecordMonitored(item.id); // 🔥 İZLEME KONTROLÜ
                
                // Parametre olarak subTab ve isMonitored eklendi
                const tr = this.renderer.renderStandardRow(item, this.state.activeTab === 'trademark', isSelected, this.state.subTab, isMonitored);
                frag.appendChild(tr);

                if ((item.origin === 'WIPO' || item.origin === 'ARIPO') && item.transactionHierarchy === 'parent') {
                    const children = this.dataManager.getWipoChildren(item.id);
                    if (children && children.length > 0) {
                        children.forEach(child => {
                            const childIsSelected = this.state.selectedRecords.has(String(child.id));
                            const childIsMonitored = this.dataManager.isRecordMonitored(child.id); // 🔥 ALT KAYIT İÇİN İZLEME KONTROLÜ
                            
                            const childTr = this.renderer.renderStandardRow(child, this.state.activeTab === 'trademark', childIsSelected, this.state.subTab, childIsMonitored);
                            
                            childTr.classList.add('child-row');
                            childTr.dataset.parentId = item.id; 
                            childTr.style.display = 'none'; 
                            childTr.style.backgroundColor = '#ffffff'; 
                            
                            const toggleCell = childTr.querySelector('.toggle-cell');
                            if(toggleCell) toggleCell.innerHTML = ''; 
                            
                            frag.appendChild(childTr);
                        });
                    }
                }
            }
        });

        if (this.renderer.tbody) {
            this.renderer.tbody.appendChild(frag);
        } else {
            const fallbackBody = document.getElementById('portfolioTableBody');
            if (fallbackBody) fallbackBody.appendChild(frag);
        }
        
        if(typeof $ !== 'undefined' && $.fn.tooltip) {
            $('[data-toggle="tooltip"]').tooltip();
        }

        if (this.state.updatedRecordId) {
            this.highlightUpdatedRow(this.state.updatedRecordId, false);
        }

        this.renderer.showLoading(false);
    }

    getColumns(tab) {
        if (tab === 'objections') {
             return [
                { key: 'toggle', width: '40px' },
                { key: 'title', label: 'Başlık', sortable: true, width: '200px' },
                { key: 'transactionTypeName', label: 'İşlem Tipi', sortable: true, width: '150px' },
                { key: 'applicationNumber', label: 'Başvuru No', sortable: true, width: '110px' },
                { key: 'applicantName', label: 'Başvuru Sahibi', sortable: true, width: '200px' },
                { key: 'opponent', label: 'Karşı Taraf', sortable: true, width: '200px' },
                { key: 'bulletinDate', label: 'Bülten Tar.', sortable: true, width: '110px' },
                { key: 'bulletinNo', label: 'Bülten No', sortable: true, width: '80px' },
                { key: 'epatsDate', label: 'İşlem Tar.', sortable: true, width: '110px' },
                { key: 'statusText', label: 'Durum', sortable: true, width: '150px' },
                { key: 'documents', label: 'Evraklar', width: '80px' }
            ];
        }
        if (tab === 'litigation') {
            return [
                { key: 'index', label: '#', width: '50px' },
                { key: 'title', label: 'Konu Varlık', sortable: true, width: '250px' },
                { key: 'suitType', label: 'Dava Türü', sortable: true, width: '150px' },
                { key: 'caseNo', label: 'Dosya No', sortable: true, width: '120px' },
                { key: 'court', label: 'Mahkeme', sortable: true, width: '180px' },
                { key: 'client', label: 'Müvekkil', sortable: true, width: '150px' },
                { key: 'opposingParty', label: 'Karşı Taraf', sortable: true, width: '150px' },
                { key: 'openedDate', label: 'Açılış Tarihi', sortable: true, width: '110px' },
                { key: 'status', label: 'Durum', sortable: true, width: '120px' }, 
                { key: 'actions', label: 'İşlemler', width: '140px' }
            ];
        }

        const columns = [
            { key: 'selection', isCheckbox: true, width: '40px' },
            { key: 'toggle', width: '40px' }
        ];

        if (tab !== 'trademark') {
            columns.push({ key: 'type', label: 'Tür', sortable: true, width: '130px' });
        }

        columns.push({ key: 'title', label: 'Başlık', sortable: true, width: '200px', filterable: true });

        if (tab === 'trademark') {
            columns.push({ key: 'brandImage', label: 'Görsel', width: '90px' });
            columns.push({ key: 'origin', label: 'Menşe', sortable: true, width: '140px' });
            // 🔥 ÇÖZÜM: Sadece alt sekme TÜRKPATENT "değilse" ülke kolonunu göster
            if (this.state.subTab !== 'turkpatent') {
                columns.push({ key: 'country', label: 'Ülke', sortable: true, width: '130px' });
            }
        }

        columns.push(
            { key: 'applicationNumber', label: 'Başvuru No', sortable: true, filterable: true, width: '140px' },
            { key: 'formattedApplicationDate', label: 'Başvuru Tar.', sortable: true, width: '140px', filterable: true, inputType: 'date' }
        );

        // 🔥 ÇÖZÜM 1 & 2: Yurtdışı sekmesi ise eksik olan Yenileme Tarihi başlığını ekliyoruz. Bu kolon kaymasını tamamen çözer!
        if (tab === 'trademark' && this.state.subTab !== 'turkpatent') {
            // 🔥 ÇÖZÜM 2: Ekranda formatlı görünmesi için key değerini güncelledik
            columns.push({ key: 'formattedRenewalDate', label: 'Yenileme Tar.', sortable: true, width: '140px', filterable: true, inputType: 'date' });
        }

        columns.push(
            { key: 'statusText', label: 'Başvuru Durumu', sortable: true, width: '130px', filterable: true },
            { key: 'formattedApplicantName', label: 'Başvuru Sahibi', sortable: true, filterable: true, width: '200px' }, 
            { key: 'formattedNiceClasses', label: 'Nice', sortable: true, width: '140px', filterable: true },
            { key: 'actions', label: 'İşlemler', width: '280px' }
        );

        return columns;
    }

    highlightUpdatedRow(id, shouldScroll = true) {
        const row = document.querySelector(`tr[data-id="${id}"]`);
        
        if (row) {
            if (row.classList.contains('child-row') && row.dataset.parentId) {
                const parentId = row.dataset.parentId;
                const parentRow = document.querySelector(`tr[data-group-id="${parentId}"]`);
                
                if (parentRow && parentRow.getAttribute('aria-expanded') !== 'true') {
                    parentRow.setAttribute('aria-expanded', 'true');
                    const icon = parentRow.querySelector('.row-caret');
                    if (icon) icon.className = 'fas fa-chevron-down row-caret';
                    
                    const children = document.querySelectorAll(`tr.child-row[data-parent-id="${parentId}"]`);
                    children.forEach(child => child.style.display = 'table-row');
                }
            }

            row.classList.add('recently-updated');
            
            if (shouldScroll) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }

    async exportToExcel(type) {
        let allFilteredData = this.dataManager.filterRecords(
            this.state.activeTab, 
            this.state.searchQuery, 
            this.state.columnFilters,
            this.state.subTab
        );
        allFilteredData = this.dataManager.sortRecords(allFilteredData, this.state.sort.column, this.state.sort.direction);

        let dataToExport = [];

        if (type === 'selected') {
            const selectedIds = this.state.selectedRecords;
            if (!selectedIds || selectedIds.size === 0) {
                if(typeof showNotification === 'function') showNotification('Lütfen en az bir kayıt seçiniz.', 'warning');
                return;
            }
            dataToExport = allFilteredData.filter(item => selectedIds.has(String(item.id)));
        } else {
            dataToExport = [...allFilteredData];
        }

        if (dataToExport.length === 0) {
            if(typeof showNotification === 'function') showNotification('Aktarılacak veri bulunamadı.', 'warning');
            return;
        }

        this.renderer.showLoading(true);

        try {
            const loadScript = (src) => {
                return new Promise((resolve, reject) => {
                    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
                    const script = document.createElement('script');
                    script.src = src;
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
            };

            if (!window.ExcelJS) await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.3.0/dist/exceljs.min.js');
            if (!window.saveAs) await loadScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js');

            // 🔥 ÇÖZÜM 1: Kütüphane değişkenini garanti altına al
            const ExcelJS = window.ExcelJS;
            
            const sortedData = [];
            const processedIds = new Set(); 

            dataToExport.forEach(parent => {
                if (!processedIds.has(String(parent.id))) {
                    sortedData.push(parent);
                    processedIds.add(String(parent.id));

                    if ((parent.origin === 'WIPO' || parent.origin === 'ARIPO') && parent.transactionHierarchy === 'parent') {
                        const children = this.dataManager.getWipoChildren(parent.id);
                        if (children && children.length > 0) {
                            children.forEach(child => {
                                if (!processedIds.has(String(child.id))) {
                                    sortedData.push(child);
                                    processedIds.add(String(child.id));
                                }
                            });
                        }
                    }
                    
                    if (this.state.activeTab === 'objections' && parent.children && parent.children.length > 0) {
                        parent.children.forEach(child => {
                            if (!processedIds.has(String(child.id))) {
                                sortedData.push(child);
                                processedIds.add(String(child.id));
                            }
                        });
                    }
                }
            });

            // 🔥 ÇÖZÜM 2: Sabitlenmiş ExcelJS değişkenini kullan
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Portföy Listesi');

            const screenColumns = this.getColumns(this.state.activeTab);
            const excludeKeys = ['selection', 'toggle', 'actions', 'documents', 'index']; 
            
            const excelColumns = [];
            let imageColumnIndex = -1; 

            // Ekranda görünen kolonları al
            screenColumns.forEach((col) => {
                if (!excludeKeys.includes(col.key)) {
                    let colWidth = 20; 
                    
                    if (col.key === 'title') colWidth = 40;
                    if (col.key === 'formattedApplicantName' || col.key === 'applicantName' || col.key === 'opponent' || col.key === 'client') colWidth = 35;
                    if (col.key === 'brandImage') { colWidth = 12; imageColumnIndex = excelColumns.length; }

                    excelColumns.push({
                        header: col.label || 'Sütun',
                        key: col.key,
                        width: colWidth
                    });
                }
            });

            // 🔥 YENİ: Sadece Excel Raporuna Özel "Yenileme Tarihi" Kolonu Ekleme
            if (['trademark', 'patent', 'design'].includes(this.state.activeTab)) {
                excelColumns.push({
                    header: 'Yenileme Tarihi',
                    key: 'renewalDate',
                    width: 20
                });
            }

            worksheet.columns = excelColumns;

            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C72' } };
            headerRow.height = 30;
            headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

            let includeImages = true;
            if (imageColumnIndex !== -1 && sortedData.length > 100) {
                includeImages = confirm(`${sortedData.length} adet kayıt dışa aktarılıyor.\n\nExcel dosyasına MARKA GÖRSELLERİ de eklensin mi?\n\n(İPTAL derseniz görselsiz olarak anında indirilir. TAMAM derseniz işlem birkaç dakika sürebilir ve dosya boyutu büyük olur.)`);
            }

            // 🔥 GÜNCELLEME: İlerleme (Progress) göstergesinin ekrana yansıması için zorunlu Repaint molası
            const delay = ms => new Promise(res => setTimeout(res, ms));
            let processedImageCount = 0; 
            
            for (let i = 0; i < sortedData.length; i++) {
                
                // 🔥 1. ÇÖZÜM: Her 5 kayıtta bir metni güncelleyip tarayıcıya ekranı çizmesi için zaman tanıyoruz
                if (i % 5 === 0) {
                    const msg = `Excel oluşturuluyor... ${i} / ${sortedData.length} kayıt işlendi. Lütfen bekleyiniz.`;
                    const progressIndicator = document.querySelector('.simple-loading-subtext') || document.querySelector('.sl-subtext');
                    
                    if (progressIndicator) {
                        progressIndicator.textContent = msg;
                    } else if (window.SimpleLoadingController) {
                        window.SimpleLoadingController.show('Rapor Hazırlanıyor', msg);
                    }
                    
                    // Tarayıcının donmasını engelleyip metni ekrana basması (DOM Repaint) için 15ms mola!
                    await delay(15); 
                }

                const record = sortedData[i];
                const rowData = {};

                excelColumns.forEach(col => {
                    if (col.key === 'brandImage') {
                        rowData[col.key] = ''; 
                        // 🔥 ÇÖZÜM 3: Excel'de hem formatlı key'i hem ham key'i yakalayıp garantili yazdırıyoruz
                    } else if (col.key === 'renewalDate' || col.key === 'formattedRenewalDate') {
                        let val = record.renewalDate || record.renewal_date;
                        if (val && val !== '-') {
                            try {
                                const d = new Date(val);
                                if (!isNaN(d.getTime())) val = d.toLocaleDateString('tr-TR');
                            } catch(e) {}
                        }
                        rowData[col.key] = (val === null || val === undefined || val === '') ? '-' : val;
                    } else {
                        let val = record[col.key];
                        if (col.key === 'country' && record.formattedCountryName) val = record.formattedCountryName;
                        if (Array.isArray(val)) val = val.join(', ');
                        rowData[col.key] = (val === null || val === undefined || val === '') ? '-' : val;
                    }
                });

                const row = worksheet.addRow(rowData);

                if (record.transactionHierarchy === 'child' || record.isChild) {
                    const titleCell = row.getCell('title');
                    if (titleCell) {
                        titleCell.alignment = { indent: 2, vertical: 'middle' };
                        titleCell.font = { italic: true, color: { argb: 'FF555555' } };
                    }
                } else {
                    const titleCell = row.getCell('title');
                    if (titleCell) {
                        titleCell.alignment = { indent: 0, vertical: 'middle', wrapText: true };
                        titleCell.font = { bold: true };
                    }
                }

                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    const colKey = excelColumns[colNumber - 1].key;
                    if (colKey !== 'title' && !colKey.toLowerCase().includes('name') && !colKey.toLowerCase().includes('opponent') && !colKey.toLowerCase().includes('client')) {
                        cell.alignment = { vertical: 'middle', horizontal: 'center' };
                    } else if (!cell.alignment) {
                        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
                    }
                });

                if (includeImages && imageColumnIndex !== -1 && record.brandImageUrl) {
                    
                    if (processedImageCount > 0 && processedImageCount % 40 === 0) {
                        const pauseMsg = `Sunucu limitleri korunuyor... ${i} / ${sortedData.length} kayıt işlendi. Kısa bir mola verildi.`;
                        const progressIndicator = document.querySelector('.simple-loading-subtext') || document.querySelector('.sl-subtext');
                        
                        if (progressIndicator) {
                            progressIndicator.textContent = pauseMsg;
                        } else if (window.SimpleLoadingController) {
                            window.SimpleLoadingController.show('Rapor Hazırlanıyor', pauseMsg);
                        }
                        
                        await delay(4000); // 4 saniye mola
                    }
                    
                    processedImageCount++;
                    let success = false;
                    let retries = 1; 
                    
                    while (retries > 0 && !success) {
                        try {
                            const url = record.brandImageUrl.trim();
                            const response = await fetch(url, { cache: 'force-cache' });
                            
                            if (response.ok) {
                                const buffer = await response.arrayBuffer();
                                let ext = 'png';
                                if (url.toLowerCase().includes('.jpg') || url.toLowerCase().includes('.jpeg')) ext = 'jpeg';

                                const imageId = workbook.addImage({ buffer: buffer, extension: ext });
                                worksheet.addImage(imageId, {
                                    tl: { col: imageColumnIndex, row: i + 1 }, 
                                    br: { col: imageColumnIndex + 1, row: i + 2 },
                                    editAs: 'oneCell'
                                });
                                row.height = 50; 
                                success = true;
                            } else {
                                // 🔥 ÇÖZÜM 3: Response ok DEĞİLSE bile 400 vb hatalarda sonsuz döngüye girmesini engelle
                                if (response.status === 429) {
                                    await delay(1500); 
                                    retries--;
                                } else {
                                    success = false;
                                    break; 
                                }
                            }
                        } catch (err) { 
                            await delay(500); 
                            retries--;
                        }
                    }
                    
                    if (!success) {
                        row.height = 30; 
                        const imgColName = excelColumns.find(c => c.key === 'brandImage')?.key || 'brandImage';
                        const imgCell = row.getCell(imgColName);
                        if (imgCell) {
                            imgCell.value = 'Görsel Yok'; 
                            imgCell.font = { color: { argb: 'FF999999' }, italic: true }; 
                            imgCell.alignment = { vertical: 'middle', horizontal: 'center' };
                        }
                    }
                } else { 
                    row.height = 30; 
                }
            }
            
            // 🔥 2. ÇÖZÜM: Bitiş metnini yazdır ve hemen inmesini bekle
            const endMsg = `Tüm kayıtlar işlendi. Excel dosyası indiriliyor...`;
            const finalIndicator = document.querySelector('.simple-loading-subtext') || document.querySelector('.sl-subtext');
            if (finalIndicator) {
                finalIndicator.textContent = endMsg;
            } else if (window.SimpleLoadingController) {
                window.SimpleLoadingController.show('Rapor Hazırlanıyor', endMsg);
            }
            await delay(100);

            // (Döngü bittikten sonraki kısım)
            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            
            const dateStr = new Date().toISOString().slice(0,10);
            
            const tabNames = { 
                trademark: 'Markalar', 
                patent: 'Patentler', 
                design: 'Tasarimlar', 
                litigation: 'Davalar', 
                objections: 'Itirazlar' 
            };
            const currentTabName = tabNames[this.state.activeTab] || 'Portfoy';
            const fileName = type === 'selected' ? `Secili_${currentTabName}_${dateStr}.xlsx` : `Tum_${currentTabName}_${dateStr}.xlsx`;
            
            window.saveAs(blob, fileName);
            if(typeof showNotification === 'function') showNotification('Excel raporu başarıyla indirildi.', 'success');
            
        } catch (error) {
            console.error('Excel hatası:', error);
            if(typeof showNotification === 'function') showNotification('Excel oluşturulurken bir hata oluştu.', 'error');
        } finally {
            // 🔥 GÜNCELLEME: Yükleme ekranını GÜVENLİ ve KESİN olarak kapatıp metni sıfırlıyoruz
            
            // 1. Ekrandaki metni varsayılan haline döndür
            const finalIndicator = document.querySelector('.simple-loading-subtext') || document.querySelector('.sl-subtext');
            if (finalIndicator) {
                finalIndicator.textContent = 'Lütfen bekleyiniz, kayıtlar taranıyor...';
            }
            
            // 2. Portföy sayfası yükleyicisini kapat
            if (this.renderer && typeof this.renderer.showLoading === 'function') {
                this.renderer.showLoading(false);
            }
            
            // 3. (Eğer varsa) Client Portal yükleyicisini kapat
            if (window.SimpleLoadingController) {
                window.SimpleLoadingController.hide();
            }
            
            // 4. Standart Bootstrap Spinner'ı zorla gizle
            const defaultSpinner = document.getElementById('loadingIndicator');
            if (defaultSpinner) defaultSpinner.style.display = 'none';
        }
    }

    async exportToPdf() {
        let allFilteredData = this.dataManager.filterRecords(
            this.state.activeTab, 
            this.state.searchQuery, 
            this.state.columnFilters,
            this.state.subTab
        );
        allFilteredData = this.dataManager.sortRecords(allFilteredData, this.state.sort.column, this.state.sort.direction);

        let dataToExport = [...allFilteredData];

        if (dataToExport.length === 0) {
            if(typeof showNotification === 'function') showNotification('Aktarılacak veri bulunamadı.', 'warning');
            return;
        }

        this.renderer.showLoading(true);

        try {
            // 1. Kütüphaneleri Dinamik ve Garantili Yükleme
            if (typeof window.jspdf === 'undefined') {
                await new Promise((resolve) => {
                    const s = document.createElement('script');
                    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
                    s.onload = resolve;
                    document.head.appendChild(s);
                });
            }
            window.jsPDF = window.jsPDF || window.jspdf.jsPDF; 
            
            if (typeof window.jspdf.autoTable === 'undefined' && typeof window.autoTable === 'undefined' && typeof window.jsPDF.API.autoTable === 'undefined') {
                await new Promise((resolve) => {
                    const s = document.createElement('script');
                    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.28/jspdf.plugin.autotable.min.js';
                    s.onload = resolve;
                    document.head.appendChild(s);
                });
            }

            const doc = new window.jsPDF('landscape', 'mm', 'a4'); 
            const delay = ms => new Promise(res => setTimeout(res, ms));

            // 2. TÜRKÇE FONT ENTEGRASYONU
            const progressIndicator = document.querySelector('.simple-loading-subtext') || document.querySelector('.sl-subtext');
            if (progressIndicator) progressIndicator.textContent = 'Türkçe font paketleri yükleniyor...';
            
            const fontRes = await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.1.66/fonts/Roboto/Roboto-Regular.ttf');
            const fontBuffer = await fontRes.arrayBuffer();
            let fontBase64 = '';
            const fontBytes = new Uint8Array(fontBuffer);
            const chunk = 8192;
            for (let i = 0; i < fontBytes.length; i += chunk) {
                fontBase64 += String.fromCharCode.apply(null, fontBytes.subarray(i, Math.min(i + chunk, fontBytes.length)));
            }
            fontBase64 = btoa(fontBase64);
            
            doc.addFileToVFS('Roboto-Regular.ttf', fontBase64);
            doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
            doc.setFont('Roboto');

            // 3. IPGATE KURUMSAL LOGO ENTEGRASYONU
            let logoBase64 = null;
            let logoW = 67.5; 
            let logoH = 22.5;
            try {
                const logoRes = await fetch('./logo.png');
                if (logoRes.ok) {
                    const logoBlob = await logoRes.blob();
                    logoBase64 = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.readAsDataURL(logoBlob);
                    });
                    
                    await new Promise((resolve) => {
                        const img = new Image();
                        img.onload = () => {
                            const ratio = img.width / img.height;
                            logoH = 22.5; 
                            logoW = logoH * ratio; 
                            resolve();
                        };
                        img.onerror = resolve;
                        img.src = logoBase64;
                    });
                }
            } catch(e) { console.error("Logo yüklenemedi:", e); }

            const sortedData = [];
            const processedIds = new Set(); 
            dataToExport.forEach(parent => {
                if (!processedIds.has(String(parent.id))) {
                    sortedData.push(parent);
                    processedIds.add(String(parent.id));
                    if ((parent.origin === 'WIPO' || parent.origin === 'ARIPO') && parent.transactionHierarchy === 'parent') {
                        const children = this.dataManager.getWipoChildren(parent.id);
                        if (children && children.length > 0) {
                            children.forEach(child => {
                                if (!processedIds.has(String(child.id))) sortedData.push(child);
                            });
                        }
                    }
                }
            });

            // 4. MARKA ÖRNEKLERİ İNDİRME VE BOYUT ANALİZİ
            let includeImages = this.state.activeTab === 'trademark';
            if (includeImages && sortedData.length > 60) {
                includeImages = confirm(`${sortedData.length} adet kayıt işleniyor.\n\nPDF raporuna marka görselleri de eklensin mi?`);
            }

            if (includeImages) {
                for (let i = 0; i < sortedData.length; i++) {
                    if (i % 5 === 0) {
                        if (progressIndicator) progressIndicator.textContent = `Marka görselleri indiriliyor: ${i} / ${sortedData.length}`;
                        await delay(10);
                    }
                    const record = sortedData[i];
                    if (record.brandImageUrl) {
                        try {
                            const res = await fetch(record.brandImageUrl.trim(), { cache: 'force-cache' });
                            if (res.ok) {
                                const blob = await res.blob();
                                const base64Data = await new Promise((resolve) => {
                                    const reader = new FileReader();
                                    reader.onloadend = () => resolve(reader.result);
                                    reader.readAsDataURL(blob);
                                });
                                
                                await new Promise((resolve) => {
                                    const img = new Image();
                                    img.onload = () => {
                                        record._pdfImage = {
                                            base64: base64Data,
                                            w: img.width,
                                            h: img.height
                                        };
                                        resolve();
                                    };
                                    img.onerror = resolve;
                                    img.src = base64Data;
                                });
                            }
                        } catch (e) { console.error("Görsel indirme hatası:", e); }
                    }
                }
            }

            // 5. Sütun Ayarları ve Sıra No Ekleme
            const screenColumns = this.getColumns(this.state.activeTab);
            const excludeKeys = ['selection', 'toggle', 'actions', 'documents', 'index']; 
            if (!includeImages) excludeKeys.push('brandImage'); 

            // 🔥 YENİ: Başlıkların en başına "Sıra No" eklendi
            const dynamicHeaders = screenColumns.filter(c => !excludeKeys.includes(c.key)).map(c => {
                if (c.key === 'title' && this.state.activeTab === 'trademark') return 'Marka adı';
                return c.label || '';
            });
            const head = [['Sıra No', ...dynamicHeaders]];

            const keys = screenColumns.filter(c => !excludeKeys.includes(c.key)).map(c => c.key);
            
            // "Sıra No" eklendiği için tablodaki sütun indekslerini 1 kaydırıyoruz
            const imageColIdx = keys.indexOf('brandImage') !== -1 ? keys.indexOf('brandImage') + 1 : -1; 
            const titleColIdx = keys.indexOf('title') !== -1 ? keys.indexOf('title') + 1 : -1;

            // 🔥 YENİ: Her satırın en başına (index + 1) olarak sıra numarası eklendi
            const body = sortedData.map((record, index) => {
                const rowValues = keys.map(key => {
                    if (key === 'brandImage') return ''; 
                    let val = record[key];
                    if (key === 'country' && record.formattedCountryName) val = record.formattedCountryName;
                    if (key === 'renewalDate' || key === 'formattedRenewalDate') {
                        let rd = record.renewalDate || record.renewal_date;
                        if(rd && rd !== '-') { try{ val = new Date(rd).toLocaleDateString('tr-TR'); }catch(e){}}
                    }
                    if (key === 'statusText') val = record.statusText || record.status || '-';
                    if (Array.isArray(val)) val = val.join(', ');
                    return (val === null || val === undefined || val === '') ? '-' : String(val);
                });
                return [String(index + 1), ...rowValues];
            });

            // Antet Alanı Çizimi
            if (logoBase64) {
                doc.addImage(logoBase64, 'PNG', 14, 6, logoW, logoH); 
            }
            doc.setFontSize(15);
            doc.setTextColor(30, 60, 114);
            doc.text("FİKRİ MÜLKİYET PORTFÖY RAPORU", 283, 15, { align: 'right' });
            
            doc.setFontSize(9.5);
            doc.setTextColor(100, 116, 139);
            const categoryName = this.state.activeTab === 'trademark' ? `Marka (${this.state.subTab === 'turkpatent' ? 'TÜRKPATENT' : 'Yurtdışı'})` : this.state.activeTab.toUpperCase();
            doc.text(`Kategori: ${categoryName}  |  Üretim Tarihi: ${new Date().toLocaleDateString('tr-TR')}`, 283, 22, { align: 'right' });

            // 🔥 YENİ: Sütun stili objesi indekslere göre tanımlandı
            const customColumnStyles = {
                0: { cellWidth: 12, halign: 'center' } // Sıra No sütunu genişliği ve ortalaması
            };
            if (imageColIdx !== -1) customColumnStyles[imageColIdx] = { cellWidth: 39 };
            if (titleColIdx !== -1) customColumnStyles[titleColIdx] = { fontStyle: 'bold' };

            // Tablo Seçenekleri
            const tableOptions = {
                head: head,
                body: body,
                startY: 34,
                rowPageBreak: 'avoid', // 🔥 KESİN ÇÖZÜM: Satırların ortadan bölünerek sayfaya sarkmasını önler!
                styles: { font: 'Roboto', fontSize: 8, valign: 'middle' },
                headStyles: { fillColor: [30, 60, 114], textColor: 255, fontStyle: 'bold' },
                bodyStyles: { minCellHeight: includeImages ? 30 : 8 },
                columnStyles: customColumnStyles,
                didDrawCell: function(data) {
                    if (data.column.index === imageColIdx && data.cell.section === 'body') {
                        const record = sortedData[data.row.index];
                        if (record && record._pdfImage) {
                            const cell = data.cell;
                            const marginX = 1.0;
                            const marginY = 1.0;
                            const maxW = cell.width - (marginX * 2);
                            const maxH = cell.height - (marginY * 2);
                            
                            if (maxW > 0 && maxH > 0) {
                                const ratio = Math.min(maxW / record._pdfImage.w, maxH / record._pdfImage.h);
                                const finalW = record._pdfImage.w * ratio;
                                const finalH = record._pdfImage.h * ratio;
                                
                                const posX = cell.x + (cell.width - finalW) / 2;
                                const posY = cell.y + (cell.height - finalH) / 2;
                                
                                let imgFormat = 'PNG';
                                const b64 = record._pdfImage.base64;
                                if (b64.includes('image/jpeg') || b64.includes('image/jpg')) {
                                    imgFormat = 'JPEG';
                                } else if (b64.includes('image/webp')) {
                                    imgFormat = 'WEBP';
                                }
                                
                                doc.addImage(b64, imgFormat, posX, posY, finalW, finalH);
                            }
                        }
                    }
                }
            };

            if (typeof doc.autoTable === 'function') {
                doc.autoTable(tableOptions);
            } else if (typeof window.jspdf.autoTable === 'function') {
                window.jspdf.autoTable(doc, tableOptions);
            } else if (typeof window.autoTable === 'function') {
                window.autoTable(doc, tableOptions);
            } else {
                throw new Error("AutoTable eklentisi bulunamadı!");
            }

            const dateStr = new Date().toISOString().slice(0,10);
            doc.save(`IPGATE_Portfoy_Raporu_${dateStr}.pdf`);
            if(typeof showNotification === 'function') showNotification('PDF raporu başarıyla indirildi.', 'success');
            
        } catch (error) {
            console.error('PDF üretilirken hata oluştu:', error);
            if(typeof showNotification === 'function') showNotification('PDF oluşturulurken bir hata oluştu.', 'error');
        } finally {
            this.renderer.showLoading(false);
        }
    }
}

new PortfolioController();