// js/data-entry/data-entry.js

import { initializeNiceClassification, getSelectedNiceClasses, setSelectedNiceClasses } from '../nice-classification.js';
import { loadSharedLayout } from '../layout-loader.js';
import { PersonModalManager } from '../components/PersonModalManager.js';
import { personService, ipRecordsService, transactionTypeService, commonService, supabase, waitForAuthUser, redirectOnLogout } from '../../supabase-config.js';
import { STATUSES, ORIGIN_TYPES } from '../../utils.js';

// Yerel Modüller
import { FormTemplates } from './form-templates.js';
import { TrademarkStrategy, PatentStrategy, DesignStrategy, SuitStrategy } from './strategies.js';

class DataEntryModule {
    
    constructor() {
        this.ipTypeSelect = document.getElementById('ipTypeSelect');
        this.dynamicFormContainer = document.getElementById('dynamicFormContainer');
        this.saveBtn = document.getElementById('savePortfolioBtn');
        this.recordOwnerTypeSelect = document.getElementById('recordOwnerType');
        
        this.currentIpType = null;
        this.editingRecordId = null;
        this.uploadedBrandImage = null;
        this.isNiceInitialized = false;
        this.currentTransactionHierarchy = 'parent';
        
        this.allPersons = [];
        this.allCountries = [];
        this.allTransactionTypes = []; 
        this.selectedApplicants = [];
        this.priorities = [];
        this.selectedCountries = [];
        
        this.suitClientPerson = null;
        this.suitSpecificTaskType = null;
        this.suitSubjectAsset = null;

        this.personModal = new PersonModalManager();
        
        this.strategies = {
            'trademark': new TrademarkStrategy(),
            'patent': new PatentStrategy(),
            'design': new DesignStrategy(),
            'suit': new SuitStrategy()
        };
    }

    async init() {
        console.log('🚀 Data Entry Module (Supabase) başlatılıyor...');
        try {
            await waitForAuthUser();
            await this.loadAllData();
            
            this.currentIpType = this.ipTypeSelect.value || 'trademark';
            this.populateOriginDropdown('originSelect', 'TÜRKPATENT', this.currentIpType);
            this.handleOriginChange(document.getElementById('originSelect')?.value);

            this.setupEventListeners();
            this.setupModalCloseButtons();

            await this.loadRecordForEditing();
            redirectOnLogout();
        } catch (error) {
            console.error('Data Entry Module init hatası:', error);
        }
    }

    async loadAllData() {
        try {
            const [personsResult, countriesResult, transactionTypesResult] = await Promise.all([
                personService.getPersons(),
                this.getCountries(),
                this.getTaskTypes(),
            ]);
            
            this.allPersons = personsResult.success ? personsResult.data : [];
            this.allCountries = countriesResult; 
        } catch (error) {
            console.error('Veriler yüklenirken hata:', error);
        }
    }

    async loadRecordForEditing() {
        const urlParams = new URLSearchParams(window.location.search);
        this.editingRecordId = urlParams.get('id');
        const formTitle = document.getElementById('formTitle');
        
        if (this.editingRecordId) {
            if (formTitle) formTitle.textContent = 'Kayıt Düzenle';
            try {
                const recordResult = await ipRecordsService.getRecordById(this.editingRecordId);
                if (recordResult.success) {
                    this.populateFormFields(recordResult.data);
                } else {
                    // Belki bir dava dosyasıdır
                    const { data: suitData } = await supabase.from('suits').select('*').eq('id', this.editingRecordId).single();
                    if (suitData) this.populateFormFields({ id: suitData.id, ...suitData.details, ...suitData });
                }
            } catch (error) {
                console.error('Kayıt yükleme hatası:', error);
            }
        } else {
            if (formTitle) formTitle.textContent = 'Yeni Kayıt Ekle';
            this.currentIpType = this.ipTypeSelect.value;
            this.handleIPTypeChange(this.currentIpType);
        }
    }

    setupEventListeners() {
        if (this.ipTypeSelect) this.ipTypeSelect.addEventListener('change', (e) => this.handleIPTypeChange(e.target.value));
        const originSelect = document.getElementById('originSelect');
        if(originSelect) originSelect.addEventListener('change', (e) => this.handleOriginChange(e.target.value));
        const specificTaskType = document.getElementById('specificTaskType');
        if (specificTaskType) specificTaskType.addEventListener('change', (e) => this.handleSpecificTaskTypeChange(e));
        if (this.saveBtn) this.saveBtn.addEventListener('click', () => this.handleSavePortfolio());
        if (this.recordOwnerTypeSelect) this.recordOwnerTypeSelect.addEventListener('change', () => this.updateSaveButtonState());

        document.addEventListener('change', (e) => {
            if (e.target && e.target.id === 'suitCourt') {
                const customInput = document.getElementById('customCourtInput');
                if (customInput) {
                    if (e.target.value === 'other') {
                        customInput.style.display = 'block'; customInput.required = true; customInput.focus();
                    } else {
                        customInput.style.display = 'none'; customInput.value = ''; customInput.required = false;
                    }
                }
            }
            if (e.target && e.target.id === 'suitDocument') {
                const label = e.target.nextElementSibling;
                const files = e.target.files;
                if (label) {
                    if (files && files.length > 0) {
                        label.textContent = files.length === 1 ? files[0].name : `${files.length} dosya seçildi`;
                        label.classList.add('text-primary'); label.style.fontWeight = 'bold';
                    } else {
                        label.textContent = 'Dosya Seçiniz...';
                        label.classList.remove('text-primary'); label.style.fontWeight = 'normal';
                    }
                }
            }
        });
    }

    handleIPTypeChange(ipType) {
        this.currentIpType = ipType;
        const isSuit = ipType === 'suit';
        const ownerCard = document.getElementById('ownerCard');
        const specificTaskTypeWrapper = document.getElementById('specificTaskTypeWrapper');
        const originSelectWrapper = document.getElementById('originSelectWrapper');
        const suitSpecificFieldsCard = document.getElementById('suitSpecificFieldsCard');
        const dynamicFormContainer = document.getElementById('dynamicFormContainer');
        const clientSection = document.querySelector('.card[id="clientSection"]'); 
        
        dynamicFormContainer.innerHTML = '';
        if (clientSection) clientSection.remove();
        document.getElementById('countrySelectionContainer').style.display = 'none';

        if (ownerCard) ownerCard.style.display = isSuit ? 'none' : 'block';

        if (isSuit) {
            specificTaskTypeWrapper.style.display = 'block';
            originSelectWrapper.style.display = 'block';
            if (suitSpecificFieldsCard) {
                suitSpecificFieldsCard.className = ''; 
                suitSpecificFieldsCard.style.display = 'block';
                suitSpecificFieldsCard.innerHTML = '';
            }
            this.renderSuitClientSection(); 
            this.populateOriginDropdown('originSelect', 'TURKEY_NATIONAL', ipType); 
            this.populateSpecificTaskTypeDropdown(ipType);
        } else {
            specificTaskTypeWrapper.style.display = 'none';
            originSelectWrapper.style.display = 'block'; 
            if(suitSpecificFieldsCard) suitSpecificFieldsCard.style.display = 'none';
            dynamicFormContainer.style.display = 'block';
            switch(ipType) {
                case 'trademark': this.renderTrademarkForm(); break;
                case 'patent': this.renderPatentForm(); break;
                case 'design': this.renderDesignForm(); break;
            }
            this.populateOriginDropdown('originSelect', 'TÜRKPATENT', ipType);
            this.handleOriginChange(document.getElementById('originSelect')?.value);
        }
        this.updateSaveButtonState();
    }

    handleOriginChange(originType) {
        this.updateRegistrationInputUI(originType);
        const countrySelectionContainer = document.getElementById('countrySelectionContainer');
        const singleSelectWrapper = document.getElementById('singleCountrySelectWrapper');
        const multiSelectWrapper = document.getElementById('multiCountrySelectWrapper');
        const title = document.getElementById('countrySelectionTitle');

        if (!countrySelectionContainer) return;

        const ipType = document.getElementById('ipTypeSelect')?.value;
        const isLawsuit = ipType === 'suit';

        this.selectedCountries = [];
        countrySelectionContainer.style.display = 'none';
        singleSelectWrapper.style.display = 'none';
        multiSelectWrapper.style.display = 'none';

        if (isLawsuit && originType === 'FOREIGN_NATIONAL' || (originType === 'Yurtdışı Ulusal' && ipType !== 'suit')) {
            title.textContent = isLawsuit ? 'Menşe Ülke Seçimi (Dava)' : 'Menşe Ülke Seçimi';
            countrySelectionContainer.style.display = 'block';
            singleSelectWrapper.style.display = 'block';
            this.populateCountriesDropdown('countrySelect');
        } 
        else if ((originType === 'WIPO' || originType === 'ARIPO') && ipType !== 'suit') {
            title.textContent = `Seçim Yapılacak Ülkeler (${originType})`;
            countrySelectionContainer.style.display = 'block';
            multiSelectWrapper.style.display = 'block';
            this.setupMultiCountrySelect();
        }
    }

    updateRegistrationInputUI(origin) {
        const regLabel = document.getElementById('registrationNumberLabel');
        const regInput = document.getElementById('registrationNumber');
        if (!regLabel || !regInput) return;
        if (origin === 'WIPO') { regLabel.textContent = 'WIPO IR Numarası'; regInput.placeholder = 'WIPO IR Numarasını girin...'; }
        else if (origin === 'ARIPO') { regLabel.textContent = 'ARIPO IR Numarası'; regInput.placeholder = 'ARIPO IR Numarasını girin...'; }
        else { regLabel.textContent = 'Tescil Numarası'; regInput.placeholder = 'Tescil numarasını girin'; }
    }

    handleSpecificTaskTypeChange(e) {
        const taskTypeId = e.target.value;
        this.suitSpecificTaskType = this.allTransactionTypes.find(t => t.id === taskTypeId);
        const container = document.getElementById('suitSpecificFieldsCard');

        if (this.suitSpecificTaskType && container) {
            container.innerHTML = this.renderSuitFields(this.suitSpecificTaskType.alias || this.suitSpecificTaskType.name);
            this.setupSuitPersonSearchSelectors(); 
            this.setupDynamicFormListeners(); 
            this._populateSuitStatusDropdown(); 
        } else if (container) {
            container.innerHTML = '';
        }
        this.updateSaveButtonState();
    }

    renderTrademarkForm() {
        this.dynamicFormContainer.innerHTML = FormTemplates.getTrademarkForm();
        this._populateStatusDropdown('trademark');
        this.setupDynamicFormListeners();
        this.setupBrandExampleUploader();
        this.setupClearClassesButton();
        this.populateCountriesDropdown('priorityCountry');
        this.updateSaveButtonState();
    }
    renderPatentForm() { this.dynamicFormContainer.innerHTML = FormTemplates.getPatentForm(); this.populateCountriesDropdown('priorityCountry'); this.updateSaveButtonState(); }
    renderDesignForm() { this.dynamicFormContainer.innerHTML = FormTemplates.getDesignForm(); this.populateCountriesDropdown('priorityCountry'); this.updateSaveButtonState(); }
    renderSuitFields(taskName) { return FormTemplates.getSuitFields(taskName); }

    _populateSuitStatusDropdown() {
        const el = document.getElementById('suitStatusSelect');
        const list = STATUSES.litigation || []; 
        if (el) el.innerHTML = '<option value="">Seçiniz...</option>' + list.map(s => `<option value="${s.value}">${s.text}</option>`).join('');
    }

    _populateStatusDropdown(type) {
        const stSel = document.getElementById(`${type}Status`);
        if (stSel && STATUSES[type]) {
            stSel.innerHTML = '<option value="">Durum Seçiniz...</option>' + STATUSES[type].map(s => `<option value="${s.value}">${s.text}</option>`).join('');
            if (!this.editingRecordId) stSel.value = '';
        }
    }

    setupDynamicFormListeners() {
        document.querySelectorAll('#portfolioTabs a[data-toggle="tab"]').forEach(tabLink => {
            tabLink.addEventListener('shown.bs.tab', (e) => this.handleTabChange(e.target.getAttribute('href')));
            tabLink.addEventListener('click', (e) => setTimeout(() => this.handleTabChange(e.target.getAttribute('href')), 200));
        });

        const applicantSearch = document.getElementById('applicantSearch');
        if (applicantSearch) applicantSearch.addEventListener('input', (e) => this.searchPersons(e.target.value, 'applicant'));
        
        const addApplicantBtn = document.getElementById('addApplicantBtn');
        if (addApplicantBtn) {
            addApplicantBtn.addEventListener('click', () => {
                this.personModal.open(null, (newPerson) => {
                    this.allPersons.push(newPerson);
                    this.addSelectedPerson(newPerson, 'applicant');
                });
            });
        }

        const addPriorityBtn = document.getElementById('addPriorityBtn');
        if (addPriorityBtn) addPriorityBtn.addEventListener('click', () => this.addPriority());
        
        const priorityType = document.getElementById('priorityType');
        if (priorityType) priorityType.addEventListener('change', (e) => this.handlePriorityTypeChange(e.target.value));

        const addedPrioritiesList = document.getElementById('addedPrioritiesList');
        if (addedPrioritiesList) {
            addedPrioritiesList.addEventListener('click', (e) => {
                const removeBtn = e.target.closest('.remove-priority-btn');
                if (removeBtn) this.removePriority(removeBtn.dataset.id);
            });
        }

        this.dynamicFormContainer.addEventListener('input', () => this.updateSaveButtonState());
        this.initializeDatePickers();
    }

    initializeDatePickers() {
        if (window.EvrekaDatePicker) window.EvrekaDatePicker.refresh(this.dynamicFormContainer);
    }

    async handleSavePortfolio() {
        const ipType = this.ipTypeSelect.value;
        const strategy = this.strategies[ipType];

        if (!strategy) return alert('Geçersiz IP Türü');

        // 1. Stratejiden (Formdan) Spesifik Verileri Topla
        const recordData = strategy.collectData(this) || {};

        // 2. Ortak Form Verilerini Birleştir
        recordData.ipType = ipType;
        recordData.origin = document.getElementById('originSelect')?.value;
        recordData.applicants = this.selectedApplicants;
        recordData.priorities = this.priorities;

        if (this.currentIpType === 'trademark') {
            const selectedNiceData = getSelectedNiceClasses(); 
            const tempMap = {};
            selectedNiceData.forEach(str => {
                const match = str.match(/^\((\d+)(?:-\d+)?\)\s*([\s\S]*)$/);
                if (match) {
                    const classNo = match[1];
                    if (!tempMap[classNo]) tempMap[classNo] = [];
                    tempMap[classNo].push(...match[2].split('\n').map(l => l.trim()).filter(l => l !== ''));
                }
            });
            recordData.goodsAndServicesByClass = Object.entries(tempMap).map(([num, items]) => ({
                classNo: Number(num), items: [...new Set(items)]
            })).sort((a, b) => a.classNo - b.classNo);
            recordData.niceClasses = Object.keys(tempMap).sort((a, b) => Number(a) - Number(b));
        }

        if (recordData.applicants && Array.isArray(recordData.applicants)) {
            recordData.applicantIds = recordData.applicants.map(app => app.id).filter(Boolean);
        } else {
            recordData.applicantIds = [];
        }

        // 3. Verileri Doğrula
        const error = strategy.validate(recordData, this);
        if (error) return alert(error);

        recordData.recordOwnerType = this.recordOwnerTypeSelect?.value || 'self';
        if (!this.editingRecordId) recordData.createdAt = new Date().toISOString(); 
        recordData.updatedAt = new Date().toISOString(); 

        try {
            this.saveBtn.disabled = true;
            this.saveBtn.textContent = 'İşleniyor...';

            // 4. Dava İse Direkt Strategy.save() Çalışır
            if (strategy.save) {
                if (this.editingRecordId) recordData.id = this.editingRecordId;
                await strategy.save(recordData);
                alert(this.editingRecordId ? 'Kayıt güncellendi.' : 'Dava kaydı ve işlem geçmişi başarıyla oluşturuldu.');
                if (this.editingRecordId) localStorage.setItem('crossTabUpdatedRecordId', this.editingRecordId);
                if (window.opener) { window.close(); } else { window.location.href = 'portfolio.html'; }
                return; 
            }

            // 5. Marka/Patent vb. İse Resim Yükleme İşlemi
            if (ipType === 'trademark' && this.uploadedBrandImage instanceof File) {
                this.saveBtn.textContent = 'Resim Yükleniyor...';
                // 🔥 SUPABASE STORAGE
                const downloadURL = await this.uploadFileToStorage(this.uploadedBrandImage);
                if (downloadURL) recordData.brandImageUrl = downloadURL;
            } else if (typeof this.uploadedBrandImage === 'string') {
                recordData.brandImageUrl = this.uploadedBrandImage;
            }

            this.saveBtn.textContent = 'Kaydediliyor...';

            // 6. Mevcut Kaydı Güncelle
            if (this.editingRecordId) {
                if (recordData.origin === 'WIPO') recordData.wipoIR = recordData.internationalRegNumber || recordData.registrationNumber;
                else if (recordData.origin === 'ARIPO') recordData.aripoIR = recordData.internationalRegNumber || recordData.registrationNumber;

                if ((recordData.origin === 'WIPO' || recordData.origin === 'ARIPO') && this.currentTransactionHierarchy === 'parent') {
                    if (this.selectedCountries && this.selectedCountries.length > 0) recordData.countries = this.selectedCountries.map(c => c.code);
                }

                const result = await ipRecordsService.updateRecord(this.editingRecordId, recordData);
                if (!result.success) throw new Error(result.error || 'Güncelleme başarısız.');
                
                if ((recordData.origin === 'WIPO' || recordData.origin === 'ARIPO') && this.currentTransactionHierarchy === 'parent') {
                    await this.syncAndCreateMissingChildren(this.editingRecordId, recordData);
                    await this.propagateUpdatesToChildren(this.editingRecordId, recordData);
                }

                alert('Kayıt başarıyla güncellendi.');
                localStorage.setItem('crossTabUpdatedRecordId', this.editingRecordId); 

            } 
            // 7. Yeni Kayıt Ekle
            else {
                await this.saveIpRecordWithStrategy(recordData); 
            }

            if (window.opener) { window.close(); } else { window.location.href = 'portfolio.html'; }

        } catch (error) {
            console.error('Kaydetme hatası:', error);
            alert('Bir hata oluştu: ' + error.message);
        } finally {
            if (this.saveBtn) { this.saveBtn.disabled = false; this.saveBtn.textContent = 'Kaydet'; }
        }
    }

    async saveIpRecordWithStrategy(data) {
        const isInternational = (data.origin === 'WIPO' || data.origin === 'ARIPO');
        const hasCountries = this.selectedCountries && this.selectedCountries.length > 0;

        if (isInternational && hasCountries) {
            const parentData = { ...data, transactionHierarchy: 'parent', countries: this.selectedCountries.map(c => c.code) };
            delete parentData.wipoIR; delete parentData.aripoIR;
            const irNumber = data.internationalRegNumber || data.registrationNumber;
            if (data.origin === 'WIPO') parentData.wipoIR = irNumber;
            else if (data.origin === 'ARIPO') parentData.aripoIR = irNumber;

            const parentRes = await ipRecordsService.createRecordFromDataEntry(parentData);
            if (!parentRes.success) throw new Error(parentRes.error);
            const parentId = parentRes.id;

            const promises = this.selectedCountries.map(async (country) => {
                try {
                    const childData = { ...data };
                    ['applicationNumber', 'registrationNumber', 'internationalRegNumber', 'countries', 'wipoIR', 'aripoIR'].forEach(k => delete childData[k]);
                    childData.transactionHierarchy = 'child'; childData.parentId = parentId; childData.country = country.code; childData.createdFrom = 'wipo_child_generation';
                    if (parentData.wipoIR) childData.wipoIR = parentData.wipoIR;
                    if (parentData.aripoIR) childData.aripoIR = parentData.aripoIR;

                    const res = await ipRecordsService.createRecordFromDataEntry(childData);
                    if(res.success) await this.addTransactionForNewRecord(res.id, data.ipType, 'child');
                } catch (e) { console.error('Child hata:', e); }
            });

            await Promise.all(promises);
            await this.addTransactionForNewRecord(parentId, data.ipType, 'parent');

        } else {
            if (['TÜRKPATENT', 'Yurtdışı Ulusal', 'TURKEY_NATIONAL'].includes(data.origin)) {
                 delete data.wipoIR; delete data.aripoIR; delete data.internationalRegNumber;
            }
            if (data.origin === 'Yurtdışı Ulusal' && !data.country) {
                const cSelect = document.getElementById('countrySelect');
                if (cSelect) data.country = cSelect.value;
            }

            const res = await ipRecordsService.createRecordFromDataEntry(data);
            if (!res.success) throw new Error(res.error);
            await this.addTransactionForNewRecord(res.id, data.ipType, 'parent');
        }
    }

    async syncAndCreateMissingChildren(parentId, parentData) {
        try {
            const { data: children } = await supabase.from('ip_records')
                .select('country_code').eq('parent_id', parentId).eq('transaction_hierarchy', 'child');
                
            const existingCountryCodes = children ? children.map(c => String(c.country_code).trim()) : [];
            const countriesToCreate = this.selectedCountries.filter(c => !existingCountryCodes.includes(String(c.code).trim()));

            if (countriesToCreate.length === 0) return;

            const promises = countriesToCreate.map(async (country) => {
                try {
                    const childData = { ...parentData };
                    ['applicationNumber', 'registrationNumber', 'internationalRegNumber', 'countries', 'wipoIR', 'aripoIR', 'id'].forEach(k => delete childData[k]);

                    childData.transactionHierarchy = 'child';
                    childData.parentId = parentId;
                    childData.country = country.code;
                    childData.createdFrom = 'wipo_update_sync'; 

                    const irNumber = parentData.internationalRegNumber || parentData.registrationNumber;
                    if (parentData.origin === 'WIPO') childData.wipoIR = irNumber;
                    else if (parentData.origin === 'ARIPO') childData.aripoIR = irNumber;

                    const res = await ipRecordsService.createRecordFromDataEntry(childData);
                    if (res.success) await this.addTransactionForNewRecord(res.id, parentData.ipType, 'child');
                } catch (err) { console.error(`Child oluşturma hatası:`, err); }
            });

            await Promise.all(promises);
        } catch (error) { console.error('Senkronizasyon ana hatası:', error); }
    }

    // Parent'taki değişiklikleri Child'lara aktarır
    async propagateUpdatesToChildren(parentId, parentData) {
        console.log('🔄 Child Güncelleme (Propagation) başlatılıyor...');
        try {
            // Sadece bu ana kayda bağlı alt dosyaların (child) ID'lerini çekiyoruz
            const { data: children, error: fetchErr } = await supabase.from('ip_records')
                .select('id')
                .eq('parent_id', parentId)
                .eq('transaction_hierarchy', 'child');
                
            if (fetchErr) throw fetchErr;

            if (!children || children.length === 0) {
                console.log('⚠️ Güncellenecek child kayıt bulunamadı.');
                return;
            }

            const irNumber = parentData.wipoIR || parentData.wipo_ir || parentData.aripoIR || parentData.aripo_ir || parentData.internationalRegNumber || parentData.registrationNumber;

            // 🔥 1. ADIM: SADECE ip_records TABLOSUNDA VAR OLAN SÜTUNLAR (Crash önlendi)
            const ipRecordUpdates = {
                portfolio_status: parentData.status || null,
                application_date: parentData.applicationDate || null,
                registration_date: parentData.registrationDate || null,
                renewal_date: parentData.renewalDate || null,
                updated_at: new Date().toISOString()
            };

            if (parentData.origin === 'WIPO' && irNumber) {
                ipRecordUpdates.wipo_ir = irNumber;
            } else if (parentData.origin === 'ARIPO' && irNumber) {
                ipRecordUpdates.aripo_ir = irNumber;
            }

            Object.keys(ipRecordUpdates).forEach(key => {
                if (ipRecordUpdates[key] === undefined) delete ipRecordUpdates[key];
            });

            // 🔥 2. ADIM: SADECE ip_record_trademark_details TABLOSUNDA VAR OLAN SÜTUNLAR
            const trademarkDetailsUpdates = {
                brand_name: parentData.title || parentData.brandText || null,
                brand_image_url: parentData.brandImageUrl || null,
                description: parentData.description || null
            };

            Object.keys(trademarkDetailsUpdates).forEach(key => {
                if (trademarkDetailsUpdates[key] === undefined) delete trademarkDetailsUpdates[key];
            });

            // 3. ADIM: Child'ları doğru tablolara güncelliyoruz
            for (const child of children) {
                // Ana verileri (WIPO IR dahil) ip_records tablosuna yaz
                if (Object.keys(ipRecordUpdates).length > 0) {
                    await supabase.from('ip_records').update(ipRecordUpdates).eq('id', child.id);
                }
                
                // Marka detaylarını ilişkili tabloya yaz
                if (Object.keys(trademarkDetailsUpdates).length > 0) {
                    await supabase.from('ip_record_trademark_details')
                                  .update(trademarkDetailsUpdates)
                                  .eq('ip_record_id', child.id);
                }
            }

            console.log(`✅ ${children.length} adet child kayda WIPO/ARIPO IR başarıyla işlendi.`);
        } catch (error) { 
            console.error('❌ Child güncelleme hatası:', error); 
        }
    }

    async addTransactionForNewRecord(recordId, ipType, hierarchy = 'parent') {
        const TX_IDS = { trademark: '2', patent: '5', design: '8', suit: '14' };
        try {
            const txPayload = {
                id: crypto.randomUUID(), // 🔥 ÇÖZÜM: Zorunlu ID eklendi
                ip_record_id: String(recordId),
                transaction_type_id: String(TX_IDS[ipType] || '2'),
                description: hierarchy === 'child' ? 'Ülke başvurusu işlemi.' : 'Başvuru işlemi.',
                transaction_hierarchy: hierarchy,
                transaction_date: new Date().toISOString(), // 🔥 ÇÖZÜM: Zorunlu işlem tarihi eklendi
                created_at: new Date().toISOString()
            };

            const { error } = await supabase.from('transactions').insert(txPayload);
            
            if (error) {
                console.error("🔴 Transaction Ekleme Hatası:", error.message);
            } else {
                console.log("✅ İlk Transaction başarıyla oluşturuldu!");
            }
        } catch (error) { 
            console.error(`Transaction yakalanan hata:`, error); 
        }
    }

    populateOriginDropdown(dropdownId, selectedValue = 'TÜRKPATENT', ipType) {
        const dropdown = document.getElementById(dropdownId);
        if (!dropdown) return;
        let filteredOrigins = ORIGIN_TYPES;
        if (ipType === 'suit') {
            filteredOrigins = ORIGIN_TYPES.filter(o => o.value === 'TÜRKPATENT' || o.value === 'Yurtdışı Ulusal')
                .map(o => o.value === 'TÜRKPATENT' ? { value: 'TURKEY_NATIONAL', text: 'TÜRKİYE' } : { value: 'FOREIGN_NATIONAL', text: 'Yurtdışı' });
            selectedValue = selectedValue === 'TÜRKPATENT' ? 'TURKEY_NATIONAL' : selectedValue;
        }
        dropdown.innerHTML = '<option value="">Seçiniz...</option>';
        filteredOrigins.forEach(origin => {
            const option = document.createElement('option');
            option.value = origin.value; option.textContent = origin.text;
            if (origin.value === selectedValue) option.selected = true;
            dropdown.appendChild(option);
        });
        dropdown.dispatchEvent(new Event('change'));
    }

    async getCountries() {
        const res = await commonService.getCountries();
        return res.success ? res.data : [];
    }

    populateCountriesDropdown(dropdownId) {
        const dropdown = document.getElementById(dropdownId);
        if (dropdown) dropdown.innerHTML = this.allCountries.map(c => `<option value="${c.code}">${c.name}</option>`).join('');
    }

    async getTaskTypes() {
        try {
            const r = await transactionTypeService.getTransactionTypes();
            this.allTransactionTypes = Array.isArray(r?.data) ? r.data : [];
            return this.allTransactionTypes;
        } catch (error) { return []; }
    }

    populateSpecificTaskTypeDropdown(mainType) {
        const dropdown = document.getElementById('specificTaskType');
        if (!dropdown || !this.allTransactionTypes) return;
        dropdown.innerHTML = '<option value="">Seçiniz...</option>';
        const filtered = this.allTransactionTypes.filter(t => t.ipType === mainType && t.hierarchy === 'parent').sort((a, b) => (a.order || 999) - (b.order || 999));
        filtered.forEach(t => dropdown.innerHTML += `<option value="${t.id}">${t.alias || t.name}</option>`);
    }

    searchPersons(searchTerm, type) {
        const resultsContainer = document.getElementById(`${type}SearchResults`);
        if (!resultsContainer || searchTerm.length < 2) { if(resultsContainer) resultsContainer.style.display = 'none'; return; }
        const filtered = this.allPersons.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()));
        if (filtered.length === 0) {
            resultsContainer.innerHTML = '<div class="no-results-message">Sonuç bulunamadı</div>';
        } else {
            resultsContainer.innerHTML = filtered.map(p => `<div class="search-result-item" data-person-id="${p.id}"><strong>${p.name}</strong></div>`).join('');
            resultsContainer.querySelectorAll('.search-result-item').forEach(item => {
                item.addEventListener('click', () => {
                    const person = this.allPersons.find(p => p.id === item.dataset.personId);
                    if (person) {
                        if(type === 'applicant') this.addSelectedPerson(person, type);
                        else if(type === 'suitClient') this.selectSuitClient(person);
                        document.getElementById(`${type}Search`).value = '';
                        resultsContainer.style.display = 'none';
                    }
                });
            });
        }
        resultsContainer.style.display = 'block';
    }

    selectSuitClient(person) {
        this.suitClientPerson = person;
        const displayDiv = document.getElementById('selectedSuitClient');
        const searchInput = document.getElementById('suitClientSearch'); 
        if (person) {
            document.getElementById('selectedSuitClientName').textContent = person.name;
            if (displayDiv) { displayDiv.classList.remove('d-none'); displayDiv.classList.add('d-flex'); displayDiv.style.display = 'flex'; }
            if (searchInput) searchInput.style.display = 'none';
        }
        this.updateSaveButtonState();
    }

    addSelectedPerson(person, type) {
        if (type === 'applicant') {
            if (this.selectedApplicants.find(p => p.id === person.id)) return alert('Zaten seçili');
            this.selectedApplicants.push(person);
            this.renderSelectedApplicants();
        }
        this.updateSaveButtonState();
    }

    renderSelectedApplicants() {
        const container = document.getElementById('selectedApplicantsContainer');
        if (!container) return;
        if (this.selectedApplicants.length === 0) {
            container.innerHTML = '<div class="empty-state text-center py-4"><p class="text-muted">Seçim yok</p></div>';
        } else {
            container.innerHTML = this.selectedApplicants.map(p => `<div class="selected-item"><span>${p.name}</span><button type="button" class="remove-selected-item-btn" data-person-id="${p.id}">&times;</button></div>`).join('');
            container.querySelectorAll('.remove-selected-item-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.selectedApplicants = this.selectedApplicants.filter(p => p.id !== btn.dataset.personId);
                    this.renderSelectedApplicants();
                    this.updateSaveButtonState();
                });
            });
        }
    }

    setupModalCloseButtons() {
        document.getElementById('cancelPersonBtn')?.addEventListener('click', () => this.hideAddPersonModal());
        document.getElementById('savePersonBtn')?.addEventListener('click', () => this.saveNewPerson());
    }

    hideAddPersonModal() {
        document.getElementById('personModal')?.classList.remove('show');
        document.body.classList.remove('modal-open');
    }

    setupMultiCountrySelect() {
        const input = document.getElementById('countriesMultiSelectInput');
        const resultsContainer = document.getElementById('countriesMultiSelectResults');
        const selectedList = document.getElementById('selectedCountriesList');
        
        this.renderSelectedCountries();
        
        input.oninput = (e) => {
            const query = e.target.value.toLowerCase();
            if (query.length < 2) { resultsContainer.style.display = 'none'; return; }
            const filtered = this.allCountries.filter(c => c.name.toLowerCase().includes(query) || c.code.toLowerCase().includes(query));
            resultsContainer.innerHTML = filtered.map(c => `<div class="search-result-item" data-code="${c.code}" data-name="${c.name}">${c.name} (${c.code})</div>`).join('');
            resultsContainer.style.display = filtered.length ? 'block' : 'none';
        };

        resultsContainer.onclick = (e) => {
            const item = e.target.closest('.search-result-item');
            if (item) {
                const code = item.dataset.code;
                if (!this.selectedCountries.find(c => c.code === code)) {
                    this.selectedCountries.push({ code, name: item.dataset.name });
                    this.renderSelectedCountries();
                    this.updateSaveButtonState();
                }
                input.value = ''; resultsContainer.style.display = 'none';
            }
        };

        selectedList.onclick = (e) => {
            const btn = e.target.closest('.remove-selected-item-btn');
            if (btn) {
                this.selectedCountries = this.selectedCountries.filter(c => c.code !== btn.dataset.code);
                this.renderSelectedCountries();
                this.updateSaveButtonState();
            }
        };
    }

    renderSelectedCountries() {
        const list = document.getElementById('selectedCountriesList');
        const badge = document.getElementById('selectedCountriesCount');
        if (!list || !badge) return;

        badge.textContent = this.selectedCountries.length;
        if (this.selectedCountries.length === 0) list.innerHTML = '<div class="empty-state"><p>Henüz ülke eklenmedi.</p></div>';
        else list.innerHTML = this.selectedCountries.map(c => `<div class="selected-item d-flex justify-content-between"><span>${c.name} (${c.code})</span><button class="remove-selected-item-btn" data-code="${c.code}">&times;</button></div>`).join('');
    }

    // 🔥 SUPABASE STORAGE DOSYA YÜKLEME FONKSİYONU
    async uploadFileToStorage(file) {
        if (!file) return null;
        try {
            const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const finalPath = `${Date.now()}_${cleanFileName}`;
            
            const { error } = await supabase.storage.from('brand_images').upload(finalPath, file);
            if (error) throw error;
            
            const { data } = supabase.storage.from('brand_images').getPublicUrl(finalPath);
            return data.publicUrl;
        } catch (error) { 
            console.error("Upload hatası:", error); 
            return null; 
        }
    }

    setupBrandExampleUploader() {
        const area = document.getElementById('brandExampleUploadArea');
        const input = document.getElementById('brandExample');
        if (!area || !input) return;

        area.onclick = () => input.click();
        input.onchange = (e) => { if (e.target.files.length) this.handleBrandExampleFile(e.target.files[0]); };
        
        const removeBtn = document.getElementById('removeBrandExampleBtn');
        if (removeBtn) {
            removeBtn.onclick = () => {
                this.uploadedBrandImage = null;
                document.getElementById('brandExamplePreviewContainer').style.display = 'none';
                document.getElementById('brandExamplePreview').src = '';
                input.value = '';
                this.updateSaveButtonState();
            };
        }
    }

    handleBrandExampleFile(file) {
        if (!file.type.startsWith('image/')) return alert('Sadece resim dosyası seçiniz.');
        const reader = new FileReader();
        reader.onload = (e) => {
            document.getElementById('brandExamplePreview').src = e.target.result;
            document.getElementById('brandExamplePreviewContainer').style.display = 'block';
            this.uploadedBrandImage = file;
            this.updateSaveButtonState();
        };
        reader.readAsDataURL(file);
    }

    handleTabChange(targetTab) {
        if (targetTab === '#goods-services' && !this.isNiceInitialized) {
            this.isNiceInitialized = true;
            initializeNiceClassification().then(() => {
                this.setupClearClassesButton();
                if (this.storedNiceClasses) setSelectedNiceClasses(this.storedNiceClasses);
            });
        }
    }

    setupClearClassesButton() {
        document.getElementById('clearAllClassesBtn')?.addEventListener('click', () => {
            if (confirm('Emin misiniz?')) window.clearAllSelectedClasses && window.clearAllSelectedClasses();
        });
    }

    renderSuitClientSection() {
        const card = document.getElementById('suitSpecificFieldsCard');
        if (card) {
            card.insertAdjacentHTML('beforebegin', FormTemplates.getClientSection());
            this.renderSuitSubjectAssetSection();
            document.getElementById('addNewPersonBtn')?.addEventListener('click', () => {
                this.personModal.open(null, (newPerson) => {
                    this.allPersons.push(newPerson);
                    this.selectSuitClient(newPerson);
                });
            });
            this.setupSuitPersonSearchSelectors();
        }
    }
    
    setupSuitPersonSearchSelectors() {
        const input = document.getElementById('suitClientSearch');
        const clearBtn = document.getElementById('clearSuitClient');
        if (input) input.oninput = (e) => this.searchPersons(e.target.value, 'suitClient');
        if (clearBtn) clearBtn.onclick = () => {
            this.suitClientPerson = null;
            document.getElementById('selectedSuitClient').style.display = 'none';
            input.style.display = 'block'; input.value = '';
            this.updateSaveButtonState();
        };
    }

    renderSuitSubjectAssetSection() {
        document.getElementById('suitSpecificFieldsCard')?.insertAdjacentHTML('beforebegin', FormTemplates.getSubjectAssetSection());
        this.setupSuitSubjectAssetSearchSelectors();
    }

    setupSuitSubjectAssetSearchSelectors() {
        const input = document.getElementById('subjectAssetSearch');
        const results = document.getElementById('subjectAssetSearchResults');
        const clearBtn = document.getElementById('clearSubjectAsset');
        const displayDiv = document.getElementById('selectedSubjectAsset');
        let debounceTimer;

        if (input) {
            input.addEventListener('input', (e) => {
                const term = e.target.value.trim().toLowerCase();
                clearTimeout(debounceTimer);

                if (term.length < 2) { if (results) results.style.display = 'none'; return; }

                debounceTimer = setTimeout(async () => {
                    try {
                        const { data: ipData } = await supabase.from('ip_records')
                            .select('id, brand_name, application_number, ip_type, details')
                            .neq('portfolio_status', 'inactive')
                            .or(`brand_name.ilike.%${term}%,application_number.ilike.%${term}%`)
                            .limit(10);

                        const { data: suitData } = await supabase.from('suits')
                            .select('*')
                            .neq('status', 'closed')
                            .or(`court_name.ilike.%${term}%,file_no.ilike.%${term}%,plaintiff.ilike.%${term}%,defendant.ilike.%${term}%,subject.ilike.%${term}%`)
                            .limit(10);

                        let matches = [];

                        (ipData || []).forEach(d => {
                            matches.push({ 
                                id: d.id, ...d.details, 
                                _source: 'ipRecord', 
                                displayType: 'Marka/Patent',
                                displayTitle: d.brand_name || d.details?.title,
                                displayNumber: d.application_number
                            });
                        });

                        (suitData || []).forEach(d => {
                            matches.push({ 
                                id: d.id, ...d.details,
                                title: d.court_name || d.subject, 
                                applicationNumber: d.file_no || '-', 
                                _source: 'suit',
                                displayType: 'Dava Dosyası',
                                displayTitle: d.court_name || d.subject,
                                displayNumber: d.file_no,
                                extraInfo: `<div class="d-flex justify-content-between mt-1" style="font-size:0.85em; color:#666;">
                                    <span><i class="fas fa-user mr-1"></i>${d.plaintiff || 'Belirsiz'}</span>
                                    <span><i class="fas fa-user-shield mr-1"></i>${d.defendant || '-'}</span>
                                </div>`
                            });
                        });

                        if (results) {
                            if (matches.length === 0) {
                                results.innerHTML = '<div class="p-2 text-muted">Sonuç bulunamadı.</div>';
                            } else {
                                results.innerHTML = matches.map(rec => {
                                    const badgeClass = rec._source === 'suit' ? 'badge-primary' : 'badge-success';
                                    const icon = rec._source === 'suit' ? '<i class="fas fa-gavel mr-1"></i>' : '<i class="fas fa-certificate mr-1"></i>';
                                    return `
                                    <div class="search-result-item p-2 border-bottom" style="cursor:pointer;" data-id="${rec.id}">
                                        <div class="d-flex justify-content-between align-items-center">
                                            <span class="font-weight-bold text-dark">${rec.displayTitle || '-'}</span>
                                            <span class="badge ${badgeClass}" style="font-size:10px;">${icon}${rec.displayType}</span>
                                        </div>
                                        <div class="small text-muted">${rec.displayNumber || 'No Yok'}</div>
                                        ${rec.extraInfo || ''}
                                    </div>`;
                                }).join('');

                                results.querySelectorAll('.search-result-item').forEach(item => {
                                    item.addEventListener('click', () => {
                                        this.selectSuitSubjectAsset(matches.find(m => m.id === item.dataset.id));
                                        results.style.display = 'none'; input.value = '';
                                    });
                                });
                            }
                            results.style.display = 'block';
                        }
                    } catch (err) { console.error('Arama hatası:', err); }
                }, 300);
            });
        }

        if (clearBtn) {
            clearBtn.onclick = () => {
                this.suitSubjectAsset = null;
                if(displayDiv) { displayDiv.classList.remove('d-flex'); displayDiv.classList.add('d-none'); }
                if(input) { input.style.display = 'block'; input.value = ''; input.focus(); }
                this.updateSaveButtonState();
            };
        }
    }

    selectSuitSubjectAsset(asset) {
        this.suitSubjectAsset = asset;
        const displayDiv = document.getElementById('selectedSubjectAsset');
        const input = document.getElementById('subjectAssetSearch');
        if (asset) {
            document.getElementById('selectedSubjectAssetName').textContent = asset.displayTitle || asset.title || asset.markName;
            document.getElementById('selectedSubjectAssetType').textContent = asset.displayType || asset.type;
            document.getElementById('selectedSubjectAssetNumber').textContent = asset.displayNumber || asset.applicationNumber || '-';
            if (displayDiv) { displayDiv.classList.remove('d-none'); displayDiv.classList.add('d-flex'); displayDiv.style.display = 'flex'; }
            if (input) input.style.display = 'none';
        }
        this.updateSaveButtonState();
    }

    addPriority() {
        const type = document.getElementById('priorityType')?.value;
        const date = document.getElementById('priorityDate')?.value;
        const country = document.getElementById('priorityCountry')?.value;
        const num = document.getElementById('priorityNumber')?.value;
        if (!date || !country || !num) return alert('Eksik bilgi.');
        this.priorities.push({ id: Date.now().toString(), type, date, country, number: num });
        this.renderPriorities();
        ['priorityDate', 'priorityCountry', 'priorityNumber'].forEach(id => document.getElementById(id).value = '');
    }

    removePriority(id) {
        this.priorities = this.priorities.filter(p => p.id !== id);
        this.renderPriorities();
    }

    renderPriorities() {
        const container = document.getElementById('addedPrioritiesList');
        if (container) container.innerHTML = this.priorities.length ? this.priorities.map(p => `
            <div class="selected-item p-2 mb-2 border rounded d-flex justify-content-between">
               <span>${p.type} | ${p.date} | ${p.country} | ${p.number}</span>
               <button class="btn btn-sm btn-danger remove-priority-btn" data-id="${p.id}"><i class="fas fa-trash-alt"></i></button>
            </div>`).join('') : '<div class="empty-state text-center py-4">Rüçhan yok</div>';
    }

    updateSaveButtonState() {
        const ipType = this.ipTypeSelect?.value;
        let isComplete = false;
        
        if (ipType === 'trademark') {
            const txt = document.getElementById('brandExampleText')?.value;
            const hasApp = this.selectedApplicants.length > 0;
            const origin = document.getElementById('originSelect')?.value;
            const isInt = (origin === 'WIPO' || origin === 'ARIPO');
            
            if (this.editingRecordId) {
                // 🔥 ÇÖZÜM: Düzenleme modundayken katı kuralları esnetiyoruz.
                // Sadece marka adının (txt) boş olmaması kaydetmek için yeterlidir.
                // Böylece WIPO kayıtlarında ülke seçimi vs. eksik görünse bile güncelleme yapılabilir.
                isComplete = !!txt; 
            } else {
                // Yeni kayıt eklerken kurallar geçerli
                isComplete = txt && hasApp && (!isInt || this.selectedCountries.length > 0);
            }
        } else if (ipType === 'suit') {
            if (this.editingRecordId) {
                isComplete = true; // Dava güncellemesinde de kilidi açıyoruz
            } else {
                isComplete = !!this.suitClientPerson && !!this.suitSpecificTaskType;
            }
        } else {
            isComplete = !!document.getElementById(`${ipType}Title`)?.value;
        }
        
        if (this.saveBtn) this.saveBtn.disabled = !isComplete;
    }

    populateFormFields(recordData) {
        if (!recordData) return;
        this.currentTransactionHierarchy = recordData.transactionHierarchy || 'parent';
        const ipType = recordData.type || recordData.ipType || 'trademark';
        this.ipTypeSelect.value = ipType;
        this.handleIPTypeChange(ipType);
        
        if (this.recordOwnerTypeSelect) this.recordOwnerTypeSelect.value = recordData.recordOwnerType || 'self';

        setTimeout(() => {
                const titleEl = document.getElementById('formTitle');
                if(titleEl) titleEl.textContent = 'Kayıt Düzenle';

                const setVal = (id, val) => { 
                    const el = document.getElementById(id); 
                    if(el) {
                        el.value = val || ''; 
                        if (el._flatpickr) {
                            if (val) el._flatpickr.setDate(val, true); 
                            else el._flatpickr.clear(); 
                        }
                    } 
                };
                
            setVal('applicationNumber', recordData.applicationNumber);
            setVal('registrationNumber', recordData.registrationNumber || recordData.wipoIR || recordData.aripoIR);
            setVal('applicationDate', recordData.applicationDate);
            setVal('registrationDate', recordData.registrationDate);
            setVal('renewalDate', recordData.renewalDate);
            
            const originSelect = document.getElementById('originSelect');
            if (originSelect && recordData.origin) {
                this.populateOriginDropdown('originSelect', recordData.origin, ipType);
                this.updateRegistrationInputUI(recordData.origin);
                
                if ((recordData.origin === 'WIPO' || recordData.origin === 'ARIPO') && recordData.transactionHierarchy === 'child') {
                    this.selectedCountries = recordData.country ? [{code: recordData.country, name: recordData.country}] : [];
                    this.renderSelectedCountries();
                    const container = document.getElementById('multiCountrySelectWrapper');
                    if(container) {
                        container.style.display = 'block';
                        document.getElementById('countriesMultiSelectInput').style.display = 'none';
                        document.getElementById('countrySelectionTitle').textContent = 'Ülke (Değiştirilemez)';
                    }
                } 
                else if (['WIPO', 'ARIPO'].includes(recordData.origin)) {
                    this.handleOriginChange(recordData.origin);
                    if (Array.isArray(recordData.countries)) {
                        this.selectedCountries = recordData.countries.map(c => ({code: c, name: c}));
                        this.renderSelectedCountries();
                    }
                }
                else if (recordData.origin === 'Yurtdışı Ulusal') {
                    this.handleOriginChange(recordData.origin);
                    setTimeout(() => setVal('countrySelect', recordData.country), 100);
                }
            }

            if (ipType === 'trademark') {
                setVal('brandType', recordData.brandType);
                setVal('brandCategory', recordData.brandCategory);
                setVal('brandExampleText', recordData.title || recordData.brandText);
                setVal('brandDescription', recordData.description);
                setVal('trademarkStatus', recordData.status);
                
                if (recordData.brandImageUrl) {
                    this.uploadedBrandImage = recordData.brandImageUrl;
                    document.getElementById('brandExamplePreview').src = recordData.brandImageUrl;
                    document.getElementById('brandExamplePreviewContainer').style.display = 'block';
                }

                if (recordData.goodsAndServicesByClass && typeof setSelectedNiceClasses === 'function') {
                     const formatted = recordData.goodsAndServicesByClass.map(g => `(${g.classNo}-1) ${g.items ? g.items.join('\n') : ''}`);
                     this.storedNiceClasses = formatted;
                     setSelectedNiceClasses(formatted);
                }
            } else {
                setVal(`${ipType}Title`, recordData.title);
                setVal(`${ipType}ApplicationNumber`, recordData.applicationNumber);
                setVal(`${ipType}Description`, recordData.description);
            }

            if (recordData.applicants && recordData.applicants.length > 0) {
                this.selectedApplicants = recordData.applicants.map(applicant => {
                    const personFromList = this.allPersons.find(p => p.id === applicant.id);
                    return { id: applicant.id, name: applicant.name || (personFromList ? personFromList.name : 'İsimsiz Kişi'), email: applicant.email || (personFromList ? personFromList.email : '') };
                });
                this.renderSelectedApplicants();
            }
            if (recordData.priorities) { this.priorities = recordData.priorities; this.renderPriorities(); }

            if (this.ipTypeSelect) this.ipTypeSelect.disabled = true;
            if (originSelect) originSelect.disabled = true;

            this.updateSaveButtonState();

        }, 500);
    }
}

export default DataEntryModule;

document.addEventListener('DOMContentLoaded', () => {
  loadSharedLayout({ activeMenuLink: 'data-entry.html' }).catch(console.error);
  let started = false;
  const boot = () => { if (started) return; started = true; new DataEntryModule().init(); };
  boot();
});