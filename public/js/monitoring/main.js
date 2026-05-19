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
        
        this.monitoredCountriesList = new Set(); 
        
        // 🔥 YENİ: Veritabanından gelen ülke listesini tutacak değişken
        this.allCountriesFromDB = []; 

        window.monitoringApp = this; 
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
        this.setupInternationalListeners();
        this.fetchCountries();
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
    // 🔥 YENİ: Ülkeleri common tablosundan çek ve hafızaya al
    async fetchCountries() {
        try {
            const { data, error } = await supabase
                .from('common')
                .select('data')
                .eq('id', 'countries')
                .single();
                
            if (!error && data && data.data && data.data.list) {
                // data.data.list bize [{"code": "DE", "name": "Almanya"}, ...] dizisini verir
                this.allCountriesFromDB = data.data.list;
            }
        } catch(e) {
            console.error("Ülkeler çekilemedi:", e);
        }
    }

 // 🔥 YENİ: Sekme Değiştirme ve Arayüzü Güncelleme
    switchTab(tabName, clickedElement) {
        // Nav link aktif sınıfını güncelle
        document.querySelectorAll('#monitoringTabs .nav-link').forEach(el => el.classList.remove('active'));
        if (clickedElement) clickedElement.classList.add('active');

        // Manager'da sekmeyi değiştir
        this.dataManager.setTab(tabName);
        
        // Manuel Ekle butonunu sadece Yurtdışındayken göster
        const btnContainer = document.getElementById('manualAddBtnContainer');
        if (btnContainer) {
            btnContainer.style.display = tabName === 'international' ? 'block' : 'none';
        }
        
        // Tabloyu ve Pagination'ı sıfırlayıp yeniden çiz
        this.selectedItems.clear();
        this.updateButtons();
        if (this.pagination) this.pagination.currentPage = 1;
        this.renderPage();
    }

    // 🔥 YENİ: Ülke Seçme, Silme ve Rozet Çizme Metodları
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
            badge.className = 'badge badge-primary p-2 d-flex align-items-center';
            badge.style.fontSize = '0.85rem';
            badge.innerHTML = `${country} <i class="fas fa-times ml-2" style="cursor:pointer;" onclick="window.monitoringApp.removeCountryFromMonitoring('${country}')"></i>`;
            container.appendChild(badge);
        });
        // Validasyon için dizi formatını stringe çevirip hidden input'a koy
        hiddenInput.value = Array.from(this.monitoredCountriesList).join(',');
    }

    // 🔥 YENİ: Dinamik Ülke Arama ve Görsel Yüklme Dinleyicileri
    setupInternationalListeners() {
        // 🔥 YENİ: Görsel Önizleme (Preview) Mantığı
        const imageInput = document.getElementById('manBrandImage');
        const previewContainer = document.getElementById('imagePreviewContainer');
        const previewImg = document.getElementById('brandImagePreview');
        const removeBtn = document.getElementById('removeImageBtn');

        imageInput?.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = function(eResult) {
                    previewImg.src = eResult.target.result;
                    previewContainer.style.display = 'block';
                    imageInput.style.display = 'none'; // Dosya seçici input'u gizle
                }
                reader.readAsDataURL(file);
            }
        });

        removeBtn?.addEventListener('click', function() {
            imageInput.value = ''; // Input hafızasını sıfırla
            previewImg.src = '';
            previewContainer.style.display = 'none';
            imageInput.style.display = 'inline-block'; // Dosya seçici input'u geri getir
        });
        const countryInput = document.getElementById('countrySearchInput');
        const countryDropdown = document.getElementById('countryDropdown');
        let searchTimeout;

        // Ülke Arama Mantığı (Hafızadaki diziden)
        countryInput?.addEventListener('input', (e) => {
            const val = e.target.value.trim().toLocaleLowerCase('tr-TR'); // Türkçe karakter duyarlılığı
            
            if(val.length < 2) {
                countryDropdown.style.display = 'none';
                return;
            }

            // Hafızadaki ülke objeleri içinde (name alanına göre) arama yap
            const filteredCountries = this.allCountriesFromDB.filter(countryObj => 
                countryObj.name.toLocaleLowerCase('tr-TR').includes(val) ||
                countryObj.code.toLocaleLowerCase('tr-TR').includes(val) // İsteğe bağlı: Koda göre (örn TR, US) de arayabilsin
            ).slice(0, 10); // En fazla 10 sonuç göster

            if (filteredCountries.length > 0) {
                // item.name parametresini addCountryToMonitoring metoduna yolluyoruz
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

        // Dropdown harici bir yere tıklanınca kapat
        document.addEventListener('click', (e) => {
            if (countryInput && !countryInput.contains(e.target) && !countryDropdown.contains(e.target)) {
                countryDropdown.style.display = 'none';
            }
        });

        // Kaydet Butonu (Görsel Yükleme Entegrasyonu)
        document.getElementById('saveManualBtn')?.addEventListener('click', async () => {
            const saveBtn = document.getElementById('saveManualBtn');
            
            const payload = {
                markName: document.getElementById('manMarkName').value.trim(),
                applicantName: document.getElementById('manApplicantName').value.trim(),
                applicationNo: document.getElementById('manAppNo').value.trim(),
                niceClasses: document.getElementById('manClasses').value.split(',').map(s=>s.trim()).filter(Boolean),
                countries: Array.from(this.monitoredCountriesList), // Set'ten al
                startDate: document.getElementById('manStartDate').value,
                endDate: document.getElementById('manEndDate').value,
                imagePath: null // Başlangıçta null
            };
            
            if(!payload.markName || payload.countries.length === 0 || !payload.startDate || !payload.endDate) {
                showNotification('Lütfen Marka Adı, İzlenecek Ülkeler ve Tarih alanlarını eksiksiz doldurun.', 'error');
                return;
            }
            
            try {
                // UI'ı kitle ve yükleniyor göster
                saveBtn.disabled = true;
                saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Yükleniyor...';
                this.renderer.showLoading('Kayıt oluşturuluyor...');

                // 1) EĞER GÖRSEL SEÇİLDİYSE SUPABASE'E YÜKLE
                const imageFile = document.getElementById('manBrandImage').files[0];
                if (imageFile) {
                    const fileExt = imageFile.name.split('.').pop();
                    const fileName = `manual_monitoring_${Date.now()}.${fileExt}`;
                    
                    // 🔥 DÜZELTME: 'brands' yerine sistemin orijinal 'brand_images' bucket'ını kullanıyoruz
                    const { error: uploadError } = await supabase.storage
                        .from('brand_images')
                        .upload(`monitoring/${fileName}`, imageFile);
                        
                    if (uploadError) {
                        console.warn("Görsel yüklenemedi:", uploadError);
                        showNotification('Görsel yüklenirken bir sorun oluştu, ancak kayda devam ediliyor.', 'warning');
                    } else {
                        // 🔥 DÜZELTME: Public URL'yi de 'brand_images' bucket'ından çekiyoruz
                        const { data: publicUrlData } = supabase.storage
                            .from('brand_images')
                            .getPublicUrl(`monitoring/${fileName}`);
                            
                        payload.imagePath = publicUrlData.publicUrl;
                    }
                }

                // 2) VERİTABANINA KAYDET
                await this.dataManager.addManualRecord(payload);
                
                // Formu Sıfırla ve Modalı Kapat
                $('#manualAddModal').modal('hide');
                document.getElementById('manualAddForm').reset();
                this.monitoredCountriesList.clear(); // Ülke listesini temizle
                this.renderMonitoredCountries();

                // 🔥 YENİ: Önizlemeyi sıfırla
                const prevContainer = document.getElementById('imagePreviewContainer');
                const imgInput = document.getElementById('manBrandImage');
                const prevImg = document.getElementById('brandImagePreview');
                if(prevContainer) {
                    prevContainer.style.display = 'none';
                    imgInput.style.display = 'inline-block';
                    prevImg.src = '';
                }
                
                showNotification('Yurtdışı marka başarıyla eklendi!', 'success');
                
                // Tabloyu Güncelle
                await this.dataManager.fetchMonitoringData();
                this.renderPage();
            } catch(e) {
                console.error(e);
                showNotification('Kayıt eklenirken hata: ' + e.message, 'error');
                this.renderPage();
            } finally {
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<i class="fas fa-save mr-1"></i> Kaydet';
            }
        });
    }
}

// Başlat
new MonitoringController();