import { MonitoringDataManager } from './MonitoringDataManager.js';
import { MonitoringRenderer } from './MonitoringRenderer.js';
import Pagination from '../pagination.js';
import { loadSharedLayout } from '../layout-loader.js';
import { showNotification } from '../../utils.js';
import { EditCriteriaModalManager } from '../components/EditCriteriaModalManager.js';
import { supabase } from '../../supabase-config.js'; 

class MonitoringController {
    constructor() {
        this.dataManager = new MonitoringDataManager();
        this.renderer = new MonitoringRenderer('monitoringTableContainer', this.dataManager);
        this.pagination = null;
        this.selectedItems = new Set();
        
        this.monitoredCountriesList = new Set(); 
        this.allCountriesFromDB = []; 

        // 🔥 YENİ: Düzenleme Durumu ve Görsel Kontrolü
        this.editingRecordId = null;
        this.imageRemoved = false; 

        window.monitoringApp = this; 
        this.init();
    }

    async init() {
        await loadSharedLayout({ activeMenuLink: 'monitoring-trademarks.html' });
        this.renderer.showLoading('İzleme listeniz yükleniyor...');
        
        this.fetchCountries(); 

        const res = await this.dataManager.init();
        if (res.success) {
            this.setupPagination();
            this.renderPage();
            this.setupGlobalListeners();
            this.setupInternationalListeners();
        } else {
            this.renderer.renderEmpty('Veriler yüklenirken hata oluştu: ' + res.error);
        }
    }

    async fetchCountries() {
        try {
            const { data, error } = await supabase.from('common').select('data').eq('id', 'countries').single();
            if (!error && data && data.data && data.data.list) {
                this.allCountriesFromDB = data.data.list;
            }
        } catch(e) { console.error("Ülkeler çekilemedi:", e); }
    }

    switchTab(tabName, clickedElement) {
        document.querySelectorAll('#monitoringTabs .nav-link').forEach(el => el.classList.remove('active'));
        if (clickedElement) clickedElement.classList.add('active');

        this.dataManager.setTab(tabName);
        
        const btnContainer = document.getElementById('manualAddBtnContainer');
        if (btnContainer) {
            btnContainer.style.display = tabName === 'international' ? 'block' : 'none';
        }
        
        // Yurtdışındayken "Seçilenleri Sil" butonunu gizle
        const bulkDeleteBtn = document.getElementById('deleteBtn');
        if (bulkDeleteBtn) {
            bulkDeleteBtn.style.display = tabName === 'international' ? 'none' : 'inline-block';
        }
        
        this.selectedItems.clear();
        this.updateButtons();
        if (this.pagination) this.pagination.currentPage = 1;
        this.renderPage();
    }

    addCountryToMonitoring(e, countryName) {
        e.preventDefault();
        this.monitoredCountriesList.add(countryName);
        this.renderMonitoredCountries();
        document.getElementById('countrySearchInput').value = '';
        document.getElementById('countryDropdown').style.display = 'none';
    }

    removeCountryFromMonitoring(countryName) {
        this.monitoredCountriesList.delete(countryName);
        this.renderMonitoredCountries();
    }

    renderMonitoredCountries() {
        const container = document.getElementById('selectedCountriesContainer');
        const hiddenInput = document.getElementById('manCountries');
        if(!container) return;
        
        container.innerHTML = '';
        this.monitoredCountriesList.forEach(country => {
            const badge = document.createElement('span');
            badge.className = 'badge badge-primary p-2 d-flex align-items-center mb-1';
            badge.style.fontSize = '0.85rem';
            badge.innerHTML = `${country} <i class="fas fa-times ml-2" style="cursor:pointer;" onclick="window.monitoringApp.removeCountryFromMonitoring('${country}')"></i>`;
            container.appendChild(badge);
        });
        hiddenInput.value = Array.from(this.monitoredCountriesList).join(',');
    }

    setupInternationalListeners() {
        const imageInput = document.getElementById('manBrandImage');
        const previewContainer = document.getElementById('imagePreviewContainer');
        const previewImg = document.getElementById('brandImagePreview');
        const removeBtn = document.getElementById('removeImageBtn');

        // Modal Kapanınca Verileri Sıfırla (Düzenleme & Yeni Kayıt Karmaşasını Önler)
        $('#manualAddModal').on('hidden.bs.modal', () => {
            this.editingRecordId = null;
            this.imageRemoved = false;
            document.getElementById('manualAddForm').reset();
            this.monitoredCountriesList.clear();
            this.renderMonitoredCountries();
            document.querySelector('#manualAddModal .modal-title').innerHTML = '<i class="fas fa-globe text-primary mr-2"></i> Yurtdışı Marka İzleme Kaydı Ekle';
            
            if(previewContainer) {
                previewContainer.style.display = 'none';
                imageInput.style.display = 'inline-block';
                previewImg.src = '';
            }
        });

        imageInput?.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = function(eResult) {
                    previewImg.src = eResult.target.result;
                    previewContainer.style.display = 'block';
                    imageInput.style.display = 'none';
                }
                reader.readAsDataURL(file);
            }
        });

        removeBtn?.addEventListener('click', () => {
            imageInput.value = '';
            previewImg.src = '';
            previewContainer.style.display = 'none';
            imageInput.style.display = 'inline-block';
            this.imageRemoved = true; // Düzenlemedeyken görselin silindiğini tutar
        });

        const countryInput = document.getElementById('countrySearchInput');
        const countryDropdown = document.getElementById('countryDropdown');
        
        countryInput?.addEventListener('input', (e) => {
            const val = e.target.value.trim().toLocaleLowerCase('tr-TR');
            if(val.length < 2) {
                countryDropdown.style.display = 'none';
                return;
            }
            
            const filteredCountries = this.allCountriesFromDB.filter(c => 
                c.name.toLocaleLowerCase('tr-TR').includes(val) || 
                c.code.toLocaleLowerCase('tr-TR').includes(val)
            ).slice(0, 10);

            if (filteredCountries.length > 0) {
                countryDropdown.innerHTML = filteredCountries.map(item => 
                    `<a class="dropdown-item py-2" href="#" onclick="window.monitoringApp.addCountryToMonitoring(event, '${item.name}')">
                        <i class="fas fa-map-marker-alt text-muted mr-2"></i> ${item.name} <span class="text-muted small ml-1">(${item.code})</span>
                    </a>`
                ).join('');
            } else {
                countryDropdown.innerHTML = '<span class="dropdown-item text-muted py-2">Sonuç bulunamadı</span>';
            }
            countryDropdown.style.display = 'block';
        });

        document.addEventListener('click', (e) => {
            if (countryInput && !countryInput.contains(e.target) && !countryDropdown.contains(e.target)) {
                countryDropdown.style.display = 'none';
            }
        });

        document.getElementById('saveManualBtn')?.addEventListener('click', async () => {
            const saveBtn = document.getElementById('saveManualBtn');
            const payload = {
                markName: document.getElementById('manMarkName').value.trim(),
                applicantName: document.getElementById('manApplicantName').value.trim(),
                applicationNo: document.getElementById('manAppNo').value.trim(),
                niceClasses: document.getElementById('manClasses').value.split(',').map(s=>s.trim()).filter(Boolean),
                countries: Array.from(this.monitoredCountriesList),
                startDate: document.getElementById('manStartDate').value,
                endDate: document.getElementById('manEndDate').value
            };
            
            if(!payload.markName || payload.countries.length === 0 || !payload.startDate || !payload.endDate) {
                showNotification('Lütfen Marka Adı, Ülkeler ve Tarih alanlarını eksiksiz doldurun.', 'error');
                return;
            }
            
            try {
                saveBtn.disabled = true;
                saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Kaydediliyor...';
                
                const imageFile = imageInput.files[0];
                if (imageFile) {
                    const fileExt = imageFile.name.split('.').pop();
                    const fileName = `manual_monitoring_${Date.now()}.${fileExt}`;
                    const { error: uploadError } = await supabase.storage.from('brand_images').upload(`monitoring/${fileName}`, imageFile);
                    if (!uploadError) {
                        const { data } = supabase.storage.from('brand_images').getPublicUrl(`monitoring/${fileName}`);
                        payload.imagePath = data.publicUrl; // Yeni görsel eklendi
                    }
                } else if (this.imageRemoved) {
                    payload.imagePath = null; // Görsel kasti olarak kaldırıldıysa DB'de de sıfırla
                }

                // Düzenleme mi Yoksa Yeni Kayıt mı Kontrolü
                if (this.editingRecordId) {
                    await this.dataManager.updateManualRecord(this.editingRecordId, payload);
                    showNotification('Yurtdışı marka başarıyla güncellendi!', 'success');
                } else {
                    await this.dataManager.addManualRecord(payload);
                    showNotification('Yurtdışı marka başarıyla eklendi!', 'success');
                }
                
                $('#manualAddModal').modal('hide');
                
                await this.dataManager.fetchMonitoringData();
                this.renderPage();
            } catch(e) {
                showNotification('İşlem sırasında hata: ' + e.message, 'error');
            } finally {
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<i class="fas fa-save mr-1"></i> Kaydet';
            }
        });
    }

    setupPagination() {
        if (!this.pagination) {
            this.pagination = new Pagination('paginationContainer', 10, (pageData) => {
                this.renderer.renderTable(pageData, this.selectedItems, this.dataManager.currentSort);
            });
        }
    }

    renderPage() {
        if (this.pagination) {
            this.pagination.updateData(this.dataManager.filteredData);
        } else {
            this.renderer.renderTable(this.dataManager.filteredData, this.selectedItems, this.dataManager.currentSort);
        }
        this.updateButtons();
    }
    
    updateButtons() {
        const delBtn = document.getElementById('deleteBtn');
        if (delBtn) delBtn.disabled = this.selectedItems.size === 0;
    }
    
    setupGlobalListeners() {
        const tableContainer = document.getElementById('monitoringTableContainer');
        if (tableContainer) {
            tableContainer.addEventListener('click', async (e) => {
                
                // 🔥 YENİ: Yurtdışı Silme Butonu
                const deleteIntlBtn = e.target.closest('.delete-intl-btn');
                if (deleteIntlBtn) {
                    const id = deleteIntlBtn.dataset.id;
                    if (!confirm('Bu yurtdışı izleme kaydını silmek istediğinize emin misiniz?')) return;
                    try {
                        this.renderer.showLoading('Siliniyor...');
                        await this.dataManager.deleteRecords([id]);
                        showNotification('Kayıt başarıyla silindi.', 'success');
                        await this.dataManager.fetchMonitoringData();
                        this.renderPage();
                    } catch(err) {
                        showNotification('Silme hatası: ' + err.message, 'error');
                        this.renderPage(); 
                    }
                    return;
                }

                // 🔥 YENİ: Yurtdışı Düzenle Butonu (Modalı dolu açar)
                const editIntlBtn = e.target.closest('.edit-intl-btn');
                if (editIntlBtn) {
                    const id = editIntlBtn.dataset.id;
                    this.editingRecordId = id;
                    this.imageRemoved = false;
                    
                    const record = this.dataManager.allMonitoringData.find(r => r.id === id);
                    if (record) {
                        document.getElementById('manMarkName').value = record.markName !== '-' ? record.markName : '';
                        document.getElementById('manApplicantName').value = record.ownerName !== '-' ? record.ownerName : '';
                        document.getElementById('manAppNo').value = record.applicationNumber !== '-' ? record.applicationNumber : '';
                        document.getElementById('manClasses').value = record.niceClasses.join(', ');
                        
                        this.monitoredCountriesList = new Set(record.monitoredCountries);
                        this.renderMonitoredCountries();

                        document.getElementById('manStartDate').value = record.monitoringStartDate || '';
                        document.getElementById('manEndDate').value = record.monitoringEndDate || '';

                        const prevContainer = document.getElementById('imagePreviewContainer');
                        const imgInput = document.getElementById('manBrandImage');
                        const prevImg = document.getElementById('brandImagePreview');
                        
                        if (record.brandImageUrl) {
                            let imageUrl = record.brandImageUrl;
                            if (!imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
                                const { data } = supabase.storage.from('brand_images').getPublicUrl(imageUrl);
                                imageUrl = data.publicUrl || imageUrl;
                            }
                            prevImg.src = imageUrl;
                            prevContainer.style.display = 'block';
                            imgInput.style.display = 'none';
                        } else {
                            prevContainer.style.display = 'none';
                            imgInput.style.display = 'inline-block';
                            prevImg.src = '';
                        }

                        document.querySelector('#manualAddModal .modal-title').innerHTML = '<i class="fas fa-globe text-primary mr-2"></i> Yurtdışı Marka İzleme Kaydı Düzenle';
                        $('#manualAddModal').modal('show');
                    }
                    return;
                }
            });

            // Tablodaki checkbox işlemleri (Sadece Yurtiçi Sekmesinde Görünür)
            tableContainer.addEventListener('change', (e) => {
                if (e.target.id === 'headerSelectAllCheckbox') {
                    const isChecked = e.target.checked;
                    const pageData = this.pagination ? this.pagination.getCurrentPageData() : this.dataManager.filteredData;
                    if (isChecked) {
                        pageData.forEach(r => this.selectedItems.add(r.id));
                    } else {
                        pageData.forEach(r => this.selectedItems.delete(r.id));
                    }
                    this.renderPage();
                } else if (e.target.classList.contains('row-checkbox')) {
                    const id = e.target.dataset.id;
                    if (e.target.checked) this.selectedItems.add(id);
                    else this.selectedItems.delete(id);
                    this.updateButtons();
                    const tr = e.target.closest('tr');
                    if(tr) {
                        if(e.target.checked) tr.classList.add('selected-row');
                        else tr.classList.remove('selected-row');
                    }
                }
            });
        }

        const delBtn = document.getElementById('deleteBtn');
        if (delBtn) {
            delBtn.addEventListener('click', async () => {
                if (this.selectedItems.size === 0) return;
                if (!confirm(`Seçili ${this.selectedItems.size} kaydı izleme listesinden silmek istediğinize emin misiniz?`)) return;
                try {
                    this.renderer.showLoading('Siliniyor...');
                    const idsArray = Array.from(this.selectedItems);
                    const successful = await this.dataManager.deleteRecords(idsArray);
                    this.selectedItems.clear();
                    showNotification(`${successful} kayıt başarıyla silindi.`, 'success');
                    await this.dataManager.fetchMonitoringData();
                    this.renderPage();
                } catch(e) {
                    showNotification('Silme hatası: ' + e.message, 'error');
                }
            });
        }

        const executeSearch = () => {
            const searchVal = document.getElementById('searchInput')?.value.trim().toLowerCase() || '';
            const statusVal = document.getElementById('statusFilter')?.value || 'all';
            this.selectedItems.clear();
            this.dataManager.filterData({ search: searchVal, status: statusVal });
            if (this.pagination) this.pagination.currentPage = 1;
            this.renderPage();
        };

        document.getElementById('searchBtn')?.addEventListener('click', executeSearch);
        document.getElementById('searchInput')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') executeSearch();
        });
        document.getElementById('statusFilter')?.addEventListener('change', executeSearch);
        
        document.getElementById('clearFiltersBtn')?.addEventListener('click', () => {
            if(document.getElementById('searchInput')) document.getElementById('searchInput').value = '';
            if(document.getElementById('statusFilter')) document.getElementById('statusFilter').value = 'all';
            executeSearch();
        });
    }
}

new MonitoringController();