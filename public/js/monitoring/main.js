import { MonitoringDataManager } from './MonitoringDataManager.js';
import { MonitoringRenderer } from './MonitoringRenderer.js';
import Pagination from '../pagination.js';
import { loadSharedLayout } from '../layout-loader.js';
import { showNotification } from '../../utils.js';
import { EditCriteriaModalManager } from '../components/EditCriteriaModalManager.js';

class MonitoringController {
    constructor() {
        this.dataManager = new MonitoringDataManager();
        this.renderer = new MonitoringRenderer('monitoringTableContainer', this.dataManager);
        this.pagination = null;
        this.selectedItems = new Set();
        
        this.init();
    }

    async init() {
        await loadSharedLayout({ activeMenuLink: 'monitoring-trademarks.html' });
        this.renderer.showLoading('İzleme listeniz yükleniyor...');

        const res = await this.dataManager.init();
        if (res.success) {
            // 🔥 ÇÖZÜM 1: Veri gelirse gizli olan Filtre bölümünü görünür yap!
            if (this.dataManager.allMonitoringData.length > 0) {
                const filterSection = document.getElementById('filterSection');
                if (filterSection) filterSection.style.display = 'block';
            }

            this.setupPagination();
            this.setupFilters();
            this.setupModal();
            this.renderPage();
        } else {
            this.renderer.renderEmpty(`Veriler yüklenirken hata oluştu: ${res.error}`);
        }
        this.setupGlobalListeners();
    }

    setupPagination() {
        this.pagination = new Pagination({
            containerId: 'paginationContainer',
            itemsPerPage: 20,
            onPageChange: () => {
                this.selectedItems.clear();
                this.updateButtons();
                this.renderPage();
            }
        });
    }

    async renderPage() {
        this.renderer.showLoading('Veriler hazırlanıyor...');
        
        let filtered = this.dataManager.filterData({
            search: document.getElementById('searchFilter')?.value.toLowerCase().trim(),
            markName: document.getElementById('markNameFilter')?.value.toLowerCase().trim(),
            searchTerms: document.getElementById('searchTermsFilter')?.value.toLowerCase().trim(),
            owner: document.getElementById('ownerFilter')?.value.toLowerCase().trim(),
            niceClass: document.getElementById('niceClassFilter')?.value.trim(),
            status: document.getElementById('statusFilter')?.value || 'all' 
        });

        if (this.pagination) this.pagination.update(filtered.length);
        const pageData = this.pagination ? this.pagination.getCurrentPageData(filtered) : filtered;

        // 🔥 ÇÖZÜM 2: Veriler zaten ilk başta JOIN ile çekildiği için enrichItems'a gerek kalmadı.
        if (pageData.length === 0) {
            this.renderer.renderEmpty('Filtreleme kriterlerinize uygun kayıt bulunamadı.');
        } else {
            this.renderer.renderTable(pageData, this.selectedItems, this.dataManager.currentSort);
        }
    }

    setupFilters() {
        // 🔥 ÇÖZÜM 3: 'statusFilter' dizideki yerine eklendi ve Select box (değişim) olayları düzenlendi
        const inputs = ['searchFilter', 'markNameFilter', 'searchTermsFilter', 'statusFilter', 'niceClassFilter', 'ownerFilter'];
        let timer;
        
        inputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                const eventType = el.tagName === 'SELECT' ? 'change' : 'input';
                el.addEventListener(eventType, () => {
                    clearTimeout(timer);
                    timer = setTimeout(() => {
                        if (this.pagination) this.pagination.currentPage = 1;
                        this.renderPage();
                    }, 300);
                });
            }
        });

        document.getElementById('clearFilters')?.addEventListener('click', () => {
            inputs.forEach(id => { 
                const el = document.getElementById(id); 
                if (el) el.value = (id === 'statusFilter') ? 'all' : ''; 
            });
            this.renderPage();
        });
    }

    updateButtons() {
        const countSpan = document.getElementById('selectedCount');
        if (countSpan) countSpan.textContent = this.selectedItems.size;
        
        document.getElementById('removeSelectedBtn').disabled = this.selectedItems.size === 0;
        document.getElementById('editCriteriaBtn').disabled = this.selectedItems.size !== 1;
        
        const headerCb = document.getElementById('headerSelectAllCheckbox');
        if (headerCb) {
            const rowCbs = document.querySelectorAll('.row-checkbox');
            headerCb.checked = rowCbs.length > 0 && Array.from(rowCbs).every(cb => cb.checked);
        }
    }

    setupGlobalListeners() {
        const container = document.getElementById('monitoringTableContainer');
        
        // Tablo içi tıklamalar (Sıralama ve Checkbox)
        container.addEventListener('click', (e) => {
            const th = e.target.closest('th.sortable');
            if (th) {
                const field = th.dataset.sort;
                if (this.dataManager.currentSort.field === field) {
                    this.dataManager.currentSort.direction = this.dataManager.currentSort.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    this.dataManager.currentSort = { field, direction: 'asc' };
                }
                this.renderPage();
            }
        });

        container.addEventListener('change', (e) => {
            if (e.target.classList.contains('row-checkbox')) {
                if (e.target.checked) this.selectedItems.add(e.target.dataset.id);
                else this.selectedItems.delete(e.target.dataset.id);
                this.updateButtons();
                
                const tr = e.target.closest('tr');
                if (tr) e.target.checked ? tr.classList.add('selected-row') : tr.classList.remove('selected-row');
            }
            if (e.target.id === 'headerSelectAllCheckbox') {
                container.querySelectorAll('.row-checkbox').forEach(cb => {
                    cb.checked = e.target.checked;
                    e.target.checked ? this.selectedItems.add(cb.dataset.id) : this.selectedItems.delete(cb.dataset.id);
                    const tr = cb.closest('tr');
                    if (tr) e.target.checked ? tr.classList.add('selected-row') : tr.classList.remove('selected-row');
                });
                this.updateButtons();
            }
        });

        // Silme İşlemi
        document.getElementById('removeSelectedBtn')?.addEventListener('click', async () => {
            if (this.selectedItems.size === 0) return;
            if (confirm(`Seçilen ${this.selectedItems.size} kaydı kaldırmak istediğinize emin misiniz?`)) {
                this.renderer.showLoading('Kayıtlar kaldırılıyor...');
                const successCount = await this.dataManager.deleteRecords(Array.from(this.selectedItems));
                
                showNotification(`${successCount} kayıt başarıyla kaldırıldı.`, 'success');
                this.selectedItems.clear();
                await this.dataManager.fetchMonitoringData(); 
                this.renderPage();
            }
        });
    }

    setupModal() {
     const editBtn = document.getElementById('editCriteriaBtn');

     // Ortak bileşeni çağırıyoruz
     const criteriaModalManager = new EditCriteriaModalManager();
     criteriaModalManager.init();

     editBtn.addEventListener('click', async () => {
         if (this.selectedItems.size !== 1) return;
         const currentEditingId = Array.from(this.selectedItems)[0];
         const item = this.dataManager.allMonitoringData.find(i => i.id === currentEditingId);
         if (!item) return;

         // Ortak bileşenin anladığı formata çeviriyoruz
         const markData = {
             id: item.id,
             markName: item.title || item.markName,
             applicationNumber: item.applicationNumber,
             ownerName: item.ownerName,
             brandImageUrl: item.brandImageUrl,
             searchMarkName: item.searchMarkName,
             brandTextSearch: item.brandTextSearch,
             niceClasses: item.niceClasses,
             niceClassSearch: item.niceClassSearch
         };

         // Modalı aç ve kaydetme işleminden sonra ekranı güncelle!
         criteriaModalManager.open(markData, async (updatedData) => {
             const index = this.dataManager.allMonitoringData.findIndex(i => i.id === updatedData.id);
             if (index !== -1) {
                 this.dataManager.allMonitoringData[index].brandTextSearch = updatedData.brandTextSearch;
                 this.dataManager.allMonitoringData[index].niceClassSearch = updatedData.niceClassSearch;
                 this.dataManager.allMonitoringData[index].searchMarkName = updatedData.searchMarkName;
             }
             this.renderPage();
         });
     });
 }
}

// Başlat
new MonitoringController();