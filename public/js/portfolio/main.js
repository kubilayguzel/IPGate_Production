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
            onPageChange: (page) => {
                this.state.currentPage = page;
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

        if (btnExportSelected) {
            btnExportSelected.addEventListener('click', (e) => { e.preventDefault(); this.exportToExcel('selected'); });
        }
        if (btnExportAll) {
            btnExportAll.addEventListener('click', (e) => { e.preventDefault(); this.exportToExcel('all'); });
        }

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
                    if (res.success) successCount++;
                }
            }
            showNotification(`${successCount} kayıt izlemeye eklendi.`, 'success');
            this.state.selectedRecords.clear();
            this.updateActionButtons();
            this.render();
        } catch (e) { showNotification('Hata: ' + e.message, 'error'); }
        finally { this.renderer.showLoading(false); }
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
                const tr = this.renderer.renderStandardRow(item, this.state.activeTab === 'trademark', isSelected);
                frag.appendChild(tr);

                if ((item.origin === 'WIPO' || item.origin === 'ARIPO') && item.transactionHierarchy === 'parent') {
                    // 🔥 ÇÖZÜM 1: Artık irNo değil, doğrudan ana kaydın ID'si ile çocukları çekiyoruz
                    const children = this.dataManager.getWipoChildren(item.id);
                    if (children && children.length > 0) {
                        children.forEach(child => {
                            const childIsSelected = this.state.selectedRecords.has(String(child.id));
                            const childTr = this.renderer.renderStandardRow(child, this.state.activeTab === 'trademark', childIsSelected);
                            
                            childTr.classList.add('child-row');
                            childTr.dataset.parentId = item.id; // 🔥 irNo yerine ana kaydın ID'sini bağlıyoruz
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
            columns.push({ key: 'country', label: 'Ülke', sortable: true, width: '130px' });
        }

        columns.push(
            { key: 'applicationNumber', label: 'Başvuru No', sortable: true, filterable: true, width: '140px' },
            { key: 'formattedApplicationDate', label: 'Başvuru Tar.', sortable: true, width: '140px', filterable: true, inputType: 'date' },
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

            const sortedData = [];
            const processedIds = new Set(); 

            dataToExport.forEach(parent => {
                if (!processedIds.has(String(parent.id))) {
                    sortedData.push(parent);
                    processedIds.add(String(parent.id));

                    if ((parent.origin === 'WIPO' || parent.origin === 'ARIPO') && parent.transactionHierarchy === 'parent') {
                        // 🔥 ÇÖZÜM 2: Excel'e aktarırken de irNo yerine parent.id'yi kullanıyoruz
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

            const workbook = new window.ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Portföy Listesi');

            const screenColumns = this.getColumns(this.state.activeTab);
            const excludeKeys = ['selection', 'toggle', 'actions', 'documents', 'index']; 
            
            const excelColumns = [];
            let imageColumnIndex = -1; 

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

            worksheet.columns = excelColumns;

            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C72' } };
            headerRow.height = 30;
            headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

            for (let i = 0; i < sortedData.length; i++) {
                const record = sortedData[i];
                const rowData = {};

                excelColumns.forEach(col => {
                    if (col.key === 'brandImage') {
                        rowData[col.key] = ''; 
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

                if (imageColumnIndex !== -1 && record.brandImageUrl) {
                    try {
                        const response = await fetch(record.brandImageUrl);
                        if (response.ok) {
                            const buffer = await response.arrayBuffer();
                            let ext = 'png';
                            if (record.brandImageUrl.toLowerCase().includes('.jpg') || record.brandImageUrl.toLowerCase().includes('.jpeg')) ext = 'jpeg';

                            const imageId = workbook.addImage({ buffer: buffer, extension: ext });
                            worksheet.addImage(imageId, {
                                tl: { col: imageColumnIndex, row: i + 1 }, 
                                br: { col: imageColumnIndex + 1, row: i + 2 },
                                editAs: 'oneCell'
                            });
                            row.height = 50; 
                        } else { row.height = 30; }
                    } catch (err) { row.height = 30; }
                } else { row.height = 30; }
            }

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
            
        } catch (error) {
            console.error('Excel hatası:', error);
            if(typeof showNotification === 'function') showNotification('Excel oluşturulurken bir hata oluştu.', 'error');
        } finally {
            this.renderer.showLoading(false);
        }
    }
}

new PortfolioController();