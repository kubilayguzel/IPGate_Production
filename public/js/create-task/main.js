import { loadSharedLayout } from '../layout-loader.js';
import { initializeNiceClassification, getSelectedNiceClasses } from '../nice-classification.js';
import { TASK_IDS } from './TaskConstants.js';
import { PersonModalManager } from '../components/PersonModalManager.js';

// 🔥 YENİ: Firebase yerine Supabase Auth bağlantıları eklendi
import { waitForAuthUser, authService } from '../../supabase-config.js';

// Modüller
import { TaskDataManager } from './TaskDataManager.js';
import { TaskUIManager } from './TaskUIManager.js';
import { TaskValidator } from './TaskValidator.js';
import { TaskSubmitHandler } from './TaskSubmitHandler.js';
import { AccrualFormManager } from '../components/AccrualFormManager.js';

function initTaskDatePickers(root = document) {
    if (window.EvrekaDatePicker) window.EvrekaDatePicker.refresh(root);
}

class CreateTaskController {
    constructor() {
        this.dataManager = new TaskDataManager();
        this.uiManager = new TaskUIManager();
        this.validator = new TaskValidator();
        this.submitHandler = new TaskSubmitHandler(this.dataManager, this.uiManager);
        this.accrualFormManager = null;

        this.state = {
            currentUser: null, allIpRecords: [], allPersons: [], allUsers: [], allTransactionTypes: [], allCountries: [],
            selectedIpRecord: null, selectedTaskType: null, selectedRelatedParties: [], selectedRelatedParty: null,
            selectedTpInvoiceParty: null, selectedServiceInvoiceParty: null, selectedApplicants: [], priorities: [],
            selectedCountries: [], uploadedFiles: [], selectedOwners: [],
            isWithdrawalTask: false, searchSource: 'portfolio', isNiceClassificationInitialized: false, selectedWipoAripoChildren: []
        };
        this.personModal = new PersonModalManager();
    }

    async init() {
        try {
            // 🔥 YENİ: Supabase Oturum Kontrolü
            const user = await waitForAuthUser({ requireAuth: true, redirectTo: 'index.html', graceMs: 1200 });
            if (!user) return;
            
            this.state.currentUser = user;
            
            // DİKKAT: Buradaki await loadSharedLayout(...) satırını SİLDİK!

            const initialData = await this.dataManager.loadInitialData();
            Object.assign(this.state, initialData);
            this.setupEventListeners();
            this.setupIpRecordSearch();

            const mainSelect = document.getElementById('mainIpType');
            if (mainSelect && mainSelect.value) {
                mainSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) { 
            console.error('Init hatası:', e); 
        }
    }

    setupEventListeners() {
        if (this._eventsBound) return;
        this._eventsBound = true;
        
        document.getElementById('mainIpType')?.addEventListener('change', (e) => this.handleMainTypeChange(e));
        document.getElementById('specificTaskType')?.addEventListener('change', (e) => this.handleSpecificTypeChange(e));
        
        const originSelect = document.getElementById('originSelect');
        if (originSelect) originSelect.addEventListener('change', (e) => this.handleOriginChange(e.target.value));

        document.addEventListener('input', (e) => {
            if (!e.target) { this.validator.checkCompleteness(this.state); return; }
            if (['officialFee', 'serviceFee', 'vatRate'].includes(e.target.id)) this.calculateTotalAmount();
            this.validator.checkCompleteness(this.state);
        });
                
        document.addEventListener('change', (e) => {
            if (e.target.id === 'applyVatToOfficialFee') this.calculateTotalAmount();
            this.validator.checkCompleteness(this.state);
        });

        document.addEventListener('click', (e) => {
            // 💾 KAYDET BUTONU
            if (e.target.id === 'saveTaskBtn' || e.target.closest('#saveTaskBtn')) {
                const btn = e.target.closest('#saveTaskBtn') || e.target;
                if (btn.disabled) return;
                
                let accrualData = null;
                const isFree = document.getElementById('isFreeTransaction')?.checked;
                
                if (!isFree && this.accrualFormManager) {
                    const result = this.accrualFormManager.getData();
                    const isFormVisible = document.getElementById('accrualToggleWrapper')?.style.display !== 'none';
                    if (isFormVisible && !result.success) { alert(result.error); return; }
                    if (result.success) accrualData = result.data;
                }
                this.state.accrualData = accrualData; 
                this.state.isFreeTransaction = isFree;
                this.submitHandler.handleFormSubmit(e, this.state);
            }

            if (e.target.id === 'cancelBtn') {
                if (confirm('İşlem iptal edilsin mi? Girilen veriler kaybolacak.')) window.location.href = 'task-management.html';
            }

            if (e.target.id === 'nextTabBtn') this.handleNextTab();

            if (e.target.closest('#clearSelectedIpRecord')) {
                this.state.selectedIpRecord = null;
                document.getElementById('selectedIpRecordContainer').style.display = 'none';
                document.getElementById('ipRecordSearch').value = '';
                const imgEl = document.getElementById('selectedIpRecordImage');
                if(imgEl) imgEl.src = '';
                this.uiManager.unlockAndClearLawsuitFields();
                this.state.selectedRelatedParties = [];
                this.state.selectedWipoAripoChildren = [];
                this.state.selectedOwners = []; 
                this.uiManager.renderWipoAripoChildRecords([]);
                this.uiManager.renderSelectedOwners([]); 
                const oSelect = document.getElementById('originSelect');
                const mSelect = document.getElementById('mainIpType');
                if (oSelect) oSelect.disabled = false;
                if (mSelect) mSelect.disabled = false;
                this.validator.checkCompleteness(this.state);
            }

            const removePartyBtn = e.target.closest('.remove-party');
            if (removePartyBtn) {
                const id = removePartyBtn.dataset.id;
                this.state.selectedRelatedParties = this.state.selectedRelatedParties.filter(p => String(p.id) !== String(id));
                this.uiManager.renderSelectedRelatedParties(this.state.selectedRelatedParties);
                this.validator.checkCompleteness(this.state);
            }

            const removeOwnerBtn = e.target.closest('.remove-owner-btn');
            if (removeOwnerBtn) {
                const id = removeOwnerBtn.dataset.id;
                if (this.state.selectedOwners) {
                    this.state.selectedOwners = this.state.selectedOwners.filter(p => String(p.id) !== String(id));
                    this.uiManager.renderSelectedOwners(this.state.selectedOwners);
                    this.validator.checkCompleteness(this.state);
                }
            }

            const removeListItemBtn = e.target.closest('.remove-selected-item-btn');
            if (removeListItemBtn) {
                const id = removeListItemBtn.dataset.id;
                if (this.state.selectedApplicants.some(a=>a.id === id)) {
                    this.state.selectedApplicants = this.state.selectedApplicants.filter(p => String(p.id) !== String(id));
                    this.uiManager.renderSelectedApplicants(this.state.selectedApplicants);
                }
                this.validator.checkCompleteness(this.state);
            }

            const removeWipoBtn = e.target.closest('.remove-wipo-child-btn');
            if (removeWipoBtn) {
                const id = removeWipoBtn.dataset.id;
                this.state.selectedWipoAripoChildren = this.state.selectedWipoAripoChildren.filter(c => String(c.id) !== String(id));
                this.uiManager.renderWipoAripoChildRecords(this.state.selectedWipoAripoChildren);
                this.validator.checkCompleteness(this.state);
            }

            if (e.target.closest('#addNewPersonBtn') || e.target.closest('#addNewApplicantBtn') || e.target.closest('#addNewOwnerBtn')) {
                const isApplicant = e.target.closest('#addNewApplicantBtn'); 
                const isOwner = e.target.closest('#addNewOwnerBtn');

                this.personModal.open(null, (newPerson) => { 
                    this.state.allPersons.push(newPerson); 
                    if (isApplicant) {
                        if(!this.state.selectedApplicants.some(a => a.id === newPerson.id)) {
                            this.state.selectedApplicants.push(newPerson);
                            this.uiManager.renderSelectedApplicants(this.state.selectedApplicants);
                        }
                    } else if (isOwner) {
                        this.handlePersonSelection(newPerson, 'owner');
                    } else {
                        this.handlePersonSelection(newPerson, 'relatedParty'); 
                    }
                    this.validator.checkCompleteness(this.state);
                });
            }
            
            if (e.target.id === 'toggleAccrualFormBtn' || e.target.closest('#toggleAccrualFormBtn')) {
                const wrapper = document.getElementById('accrualToggleWrapper'); 
                const btn = document.getElementById('toggleAccrualFormBtn');
                if (wrapper && wrapper.style.display === 'none') {
                    if (window.$) $(wrapper).slideDown(300); else wrapper.style.display = 'block';
                    btn.innerHTML = '<i class="fas fa-chevron-up mr-1"></i> Tahakkuk Formunu Gizle';
                    btn.classList.replace('btn-outline-primary', 'btn-outline-secondary');
                } else if (wrapper) {
                    if (window.$) $(wrapper).slideUp(300); else wrapper.style.display = 'none';
                    btn.innerHTML = '<i class="fas fa-chevron-down mr-1"></i> Tahakkuk Formu Aç';
                    btn.classList.replace('btn-outline-secondary', 'btn-outline-primary');
                }
            }

            if (e.target.id === 'isFreeTransaction') {
                const isChecked = e.target.checked;
                const btn = document.getElementById('toggleAccrualFormBtn');
                const wrapper = document.getElementById('accrualToggleWrapper');
                if (isChecked) {
                    if(wrapper) wrapper.style.display = 'none';
                    if(btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-chevron-down mr-1"></i> Tahakkuk Formu Aç'; }
                    if (this.accrualFormManager) this.accrualFormManager.reset();
                } else {
                    if(btn) btn.disabled = false;
                }
            }
        });
        
        document.addEventListener('parentTransactionSelected', (e) => {
            this.submitHandler.selectedParentTransactionId = e.detail.id;
            this.uiManager.hideParentSelectionModal();
            alert('Geri çekilecek işlem seçildi.');
        });
        
        const closeModalBtns = document.querySelectorAll('#selectParentModal .close, #selectParentModal .btn-secondary');
        closeModalBtns.forEach(btn => btn.addEventListener('click', () => this.uiManager.hideParentSelectionModal()));

        document.addEventListener('change', (e) => {
            if (e.target && e.target.id === 'courtName') {
                const customInput = document.getElementById('customCourtInput');
                if (customInput) {
                    if (e.target.value === 'other') {
                        customInput.style.display = 'block'; customInput.focus(); customInput.setAttribute('required', 'true');
                    } else {
                        customInput.style.display = 'none'; customInput.value = ''; customInput.removeAttribute('required');
                    }
                }
            }
            if (e.target.id === 'suitDocument') {
                const newFiles = Array.from(e.target.files);
                this.state.uploadedFiles = [...(this.state.uploadedFiles || []), ...newFiles];
                this.uiManager.renderUploadedFiles(this.state.uploadedFiles);
                e.target.value = ''; 
            }
        });

        if (window.$) {
            $(document).on('shown.bs.tab', '#myTaskTabs a', async (e) => {
                const allTabs = document.querySelectorAll('#myTaskTabs .nav-link');
                const activeTab = e.target;
                const isLastTab = (allTabs[allTabs.length - 1] === activeTab);
                this.uiManager.updateButtonsAndTabs(isLastTab);
                const targetTabId = e.target.getAttribute('href').substring(1);
                
                if (targetTabId === 'goods-services' && !this.state.isNiceClassificationInitialized) {
                    if (typeof initializeNiceClassification === 'function') {
                         await initializeNiceClassification();
                         this.state.isNiceClassificationInitialized = true;
                    }
                }
                if (targetTabId === 'applicants') this.uiManager.renderSelectedApplicants(this.state.selectedApplicants);
                if (targetTabId === 'priority') {
                    const prioSelect = document.getElementById('priorityCountry');
                    if (prioSelect && prioSelect.options.length <= 1) this.uiManager.populateDropdown('priorityCountry', this.state.allCountries, 'code', 'name');
                    this.uiManager.renderPriorities(this.state.priorities);
                }
                if (targetTabId === 'summary') this.uiManager.renderSummaryTab(this.state);
                this.validator.checkCompleteness(this.state);
            });
        }
        
        document.addEventListener('focusin', (e) => {
            if (e.target.id === 'brandExampleText') e.target.oninput = () => this.validator.checkCompleteness(this.state);
        });

        this.setupBrandExample();
    }

    setupNiceListObserver() {
        const niceListContainer = document.getElementById('selectedNiceClasses');
        if (niceListContainer) {
            const niceListObserver = new MutationObserver(() => this.validator.checkCompleteness(this.state));
            niceListObserver.observe(niceListContainer, { childList: true, subtree: true });
        }
    }

    handleNextTab() {
        const activeTab = document.querySelector('#myTaskTabs .nav-link.active');
        if (!activeTab) return;
        const nextLi = activeTab.parentElement.nextElementSibling;
        if (nextLi) {
            const nextLink = nextLi.querySelector('.nav-link');
            if (nextLink) $(nextLink).tab('show');
        }
    }

    handleMainTypeChange(e) {
        const mainType = e.target.value;
        const specificSelect = document.getElementById('specificTaskType');

        this.uiManager.clearContainer();
        this.resetSelections();
        specificSelect.innerHTML = '<option value="">Seçiniz...</option>';

        if (mainType) {
            const mt = String(mainType).toLowerCase().trim();

            const filtered = this.state.allTransactionTypes.filter(t => {
                // Hem eski Firebase Cache verisini hem yeni Supabase JSONB yapısını kucaklıyoruz
                const d = t.details || t;

                const hierarchy = String(t.hierarchy || d.hierarchy || 'parent').toLowerCase();
                
                // applicableToMainType listesini güvenli bir şekilde al
                let applicable = t.applicableToMainType || t.applicable_to_main_type || d.applicableToMainType || [];
                if (typeof applicable === 'string') applicable = [applicable];
                if (!Array.isArray(applicable)) applicable = [];
                applicable = applicable.map(x => String(x).toLowerCase().trim());

                // 🔥 Cache'de ip_type yoksa applicable array'inin ilk elemanından türet
                const rawIpType = t.ip_type || t.ipType || d.ip_type || d.ipType || (applicable.length > 0 ? applicable[0] : '');
                const ipType = String(rawIpType).toLowerCase().trim();
                
                const isTopLevel = t.is_top_level_selectable ?? t.isTopLevelSelectable ?? d.isTopLevelSelectable ?? true;

                // 1. KURAL: Ana işlemler (parent)
                const isParentMatch = (hierarchy === 'parent' && ipType === mt);
                
                // 2. KURAL: Alt işlemler (child)
                const isChildMatch = (hierarchy === 'child' && isTopLevel === true && 
                                     (applicable.includes(mt) || applicable.includes('all')));

                return isParentMatch || isChildMatch;
            }).sort((a, b) => {
                const orderA = a.details?.order ?? a.order ?? 999;
                const orderB = b.details?.order ?? b.order ?? 999;
                return orderA - orderB;
            });

            filtered.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = t.alias || t.name;
                specificSelect.appendChild(opt);
            });
            specificSelect.disabled = false;
        } else {
            specificSelect.disabled = true;
        }

        // Menşe Ayarları
        this.uiManager.populateDropdown('originSelect',
            (mainType === 'suit' ? [{value:'TURKEY', text:'Türkiye'}, {value:'FOREIGN_NATIONAL', text:'Yurtdışı'}] :
            [{value:'TÜRKPATENT', text:'TÜRKPATENT'}, {value:'WIPO', text:'WIPO'}, {value:'EUIPO', text:'EUIPO'}, {value:'ARIPO', text:'ARIPO'}, {value:'Yurtdışı Ulusal', text:'Yurtdışı Ulusal'}]),
            'value', 'text', 'Seçiniz...'
        );

        if (mainType === 'suit') { document.getElementById('originSelect').value = 'TURKEY'; this.handleOriginChange('TURKEY'); }
        else { document.getElementById('originSelect').value = 'TÜRKPATENT'; this.handleOriginChange('TÜRKPATENT'); }

        const tmSubCards = document.getElementById('trademarkSubCards');
        if (mainType === 'trademark') {
            tmSubCards.style.display = 'block';
            const appCard = document.getElementById('card-tm-application');
            const transCard = document.getElementById('card-tm-transfer');

            const hasApplication = Array.from(specificSelect.options).some(opt => opt.value === 'trademark_application' || opt.value === '2');
            const hasTransfer = Array.from(specificSelect.options).some(opt => opt.value === 'trademark_transfer_process' || opt.value === '5');

            const toggleCardState = (card, isActive) => {
                if (!card) return;
                if (isActive) {
                    card.style.opacity = '1'; card.style.pointerEvents = 'auto'; card.style.cursor = 'pointer'; card.classList.remove('card-disabled');
                } else {
                    card.style.opacity = '0.5'; card.style.pointerEvents = 'none'; card.style.cursor = 'default'; card.classList.add('card-disabled');
                }
            };
            toggleCardState(appCard, hasApplication);
            toggleCardState(transCard, hasTransfer);
            document.querySelector('label[for="specificTaskType"]').textContent = 'Diğer Marka İşlemleri';
        } else {
            tmSubCards.style.display = 'none';
            document.querySelector('label[for="specificTaskType"]').textContent = 'Spesifik İş Tipi';
        }
    }

    toggleAssetSearchVisibility(originValue) {
        const typeId = String(this.state.selectedTaskType?.id || '');
        const container = document.getElementById('assetSearchContainer');
        if (container && ['79', '80', '82'].includes(typeId)) {
            if (originValue === 'TÜRKPATENT') container.style.display = 'none';
            else container.style.display = 'block';
        } else if (container) {
            container.style.display = 'block';
        }
    }

    async handleSpecificTypeChange(e) {
        const typeId = e.target.value;
        const selectedType = this.state.allTransactionTypes.find(t => String(t.id) === String(typeId));
        this.state.selectedTaskType = selectedType;
        
        if (!selectedType) { this.uiManager.clearContainer(); return; }

        const tIdStr = String(typeId);
        this.state.isWithdrawalTask = (tIdStr === '21' || tIdStr === '8' || tIdStr === '37');
        
        if (['79', '80', '81', '82'].includes(tIdStr)) {
            this.uiManager.renderOtherTaskForm(selectedType);
            if (tIdStr === '82') {
                this.uiManager.populateDropdown('newAddressCountry', this.state.allCountries, 'code', 'name');
                if (!this.state.allCities || this.state.allCities.length === 0) {
                    try { this.state.allCities = await this.dataManager.getCities(); } catch (err) { this.state.allCities = []; }
                }
                const countrySelect = document.getElementById('newAddressCountry');
                const citySelect = document.getElementById('newAddressCity');
                if (countrySelect && citySelect) {
                    if (!countrySelect.dataset.cityListenerAdded) {
                        countrySelect.addEventListener('change', (ev) => {
                            const val = ev.target.value;
                            const isTurkey = ['TR', 'TUR', 'Turkey', 'Türkiye'].includes(val);
                            if (isTurkey) {
                                citySelect.disabled = false;
                                let citiesToRender = this.state.allCities || [];
                                if (citiesToRender.length > 0 && typeof citiesToRender[0] === 'string') {
                                    citiesToRender = citiesToRender.map(c => ({ name: c }));
                                }
                                this.uiManager.populateDropdown('newAddressCity', citiesToRender, 'name', 'name', 'Şehir Seçiniz...');
                            } else {
                                citySelect.disabled = true;
                                citySelect.innerHTML = '<option value="">Önce Ülke Seçiniz...</option>';
                                citySelect.value = '';
                            }
                            this.validator.checkCompleteness(this.state);
                        });
                        countrySelect.dataset.cityListenerAdded = 'true';
                    }
                }
            }
            
            if (document.getElementById('createTaskAccrualContainer')) {
                this.accrualFormManager = new AccrualFormManager('createTaskAccrualContainer', 'createTaskAcc', this.state.allPersons);
                this.accrualFormManager.render();
            }
            this.setupMultiAssetSearch(tIdStr);
            this.applyAssignmentRule(await this.dataManager.getAssignmentRule(typeId));
            this.dedupeActionButtons();
            
            const currentOrigin = document.getElementById('originSelect')?.value || 'TÜRKPATENT';
            if (this.toggleAssetSearchVisibility) this.toggleAssetSearchVisibility(currentOrigin);
            this.setupPersonSearchListeners();
            setTimeout(() => initTaskDatePickers(), 100);
            
            const newInputs = ['newTitleInput', 'newTypeInput', 'taxNumberInput', 'searchKeywordInput', 'newAddressText', 'newAddressCountry', 'newAddressCity'];
            newInputs.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('input', () => this.validator.checkCompleteness(this.state));
                    el.addEventListener('change', () => this.validator.checkCompleteness(this.state));
                }
            });
            this.validator.checkCompleteness(this.state);
            return; 
        }

        const isMarkaBasvuru = selectedType.alias === 'Başvuru' && selectedType.ipType === 'trademark';
        
        if (isMarkaBasvuru) {
            this.uiManager.renderTrademarkApplicationForm();
            setTimeout(() => this.setupNiceListObserver(), 100);
        } else {
            this.uiManager.renderBaseForm(selectedType.alias || selectedType.name, selectedType.id, selectedType.ipType === 'suit', this.state.allTransactionTypes);
        }
        
        const assetSource = selectedType.relatedAssetSource || 'ipRecords';
        this.state.searchSource = assetSource; 
        this.state.targetSuitTypes = selectedType.targetSuitTypes || []; 
        
        this.uiManager.updateAssetSearchLabel(assetSource);

        if (document.getElementById('createTaskAccrualContainer')) {
            this.accrualFormManager = new AccrualFormManager('createTaskAccrualContainer', 'createTaskAcc', this.state.allPersons);
            this.accrualFormManager.render();
        }

        setTimeout(() => { initTaskDatePickers(); this.setupBrandExample(); }, 100);
        this.setupIpRecordSearch();
        
        if (!isMarkaBasvuru) this.setupPersonSearchListeners();
        else { this.setupApplicantListeners(); this.handleOriginChange(document.getElementById('originSelect').value); }

        const rule = await this.dataManager.getAssignmentRule(typeId);
        this.applyAssignmentRule(rule);
        
        this.dedupeActionButtons();
        this.validator.checkCompleteness(this.state);
    }

    handleOriginChange(val, keepSelections = false) {
        if (!keepSelections) {
            this.resetSelections();
            this.uiManager.unlockAndClearLawsuitFields();
            const ipRecordContainer = document.getElementById('selectedIpRecordContainer');
            if(ipRecordContainer) ipRecordContainer.style.display = 'none';
        }

        this.toggleAssetSearchVisibility(val);

        const container = document.getElementById('countrySelectionContainer');
        const singleWrapper = document.getElementById('singleCountrySelectWrapper');
        const multiWrapper = document.getElementById('multiCountrySelectWrapper');
        const title = document.getElementById('countrySelectionTitle');
        
        if (!container || !singleWrapper || !multiWrapper) return;

        container.style.display = 'none'; singleWrapper.style.display = 'none'; multiWrapper.style.display = 'none';

        const t = this.state.selectedTaskType;
        const isApplication = (t && (t.alias === 'Başvuru' || t.name === 'Başvuru'));
        const isSuit = (t && t.ipType === 'suit') || (document.getElementById('mainIpType')?.value === 'suit');

        if (!isApplication && !isSuit) return; 

        if (['Yurtdışı Ulusal', 'FOREIGN_NATIONAL'].includes(val)) {
            container.style.display = 'block'; singleWrapper.style.display = 'block';
            if(title) title.textContent = 'Menşe Ülke Seçimi';
            this.uiManager.populateDropdown('countrySelect', this.state.allCountries, 'code', 'name');
        } 
        else if (['WIPO', 'ARIPO'].includes(val)) {
            container.style.display = 'block'; multiWrapper.style.display = 'block';
            if(title) title.textContent = `Seçim Yapılacak Ülkeler (${val})`;
            this.setupMultiCountrySelect(); 
        }
    }

    setupMultiCountrySelect() {
        const input = document.getElementById('countriesMultiSelectInput');
        const results = document.getElementById('countriesMultiSelectResults');
        const list = document.getElementById('selectedCountriesList');
        
        if (!input || !results) return;

        input.oninput = (e) => {
            const term = e.target.value.toLowerCase();
            if (term.length < 2) { results.style.display = 'none'; return; }
            const filtered = this.state.allCountries.filter(c => c.name.toLowerCase().includes(term) || c.code.toLowerCase().includes(term));
            this.renderCountrySearchResults(filtered);
        };

        results.onclick = (e) => {
            const item = e.target.closest('.search-result-item');
            if (item) {
                const code = item.dataset.code;
                const name = item.dataset.name;
                if (!this.state.selectedCountries.some(c => c.code === code)) {
                    this.state.selectedCountries.push({ code, name });
                    this.renderSelectedCountries();
                }
                input.value = ''; results.style.display = 'none'; this.validator.checkCompleteness(this.state);
            }
        };

        list.onclick = (e) => {
            const btn = e.target.closest('.remove-selected-item-btn');
            if (btn) {
                const code = btn.dataset.code;
                this.state.selectedCountries = this.state.selectedCountries.filter(c => c.code !== code);
                this.renderSelectedCountries(); this.validator.checkCompleteness(this.state);
            }
        };

        this.renderSelectedCountries(); 
    }

    renderCountrySearchResults(items) {
        const results = document.getElementById('countriesMultiSelectResults');
        if (!results) return;
        if (items.length === 0) results.innerHTML = '<div class="p-2 text-muted">Sonuç yok</div>';
        else results.innerHTML = items.map(c => `<div class="search-result-item p-2 border-bottom" style="cursor:pointer;" data-code="${c.code}" data-name="${c.name}">${c.name} (${c.code})</div>`).join('');
        results.style.display = 'block';
    }

    renderSelectedCountries() {
        const list = document.getElementById('selectedCountriesList');
        const badge = document.getElementById('selectedCountriesCount');
        if (!list) return;

        if (badge) badge.textContent = this.state.selectedCountries.length;

        if (this.state.selectedCountries.length === 0) {
            list.innerHTML = '<div class="empty-state"><i class="fas fa-flag fa-2x text-muted mb-2"></i><p class="text-muted">Henüz ülke eklenmedi.</p></div>';
            return;
        }

        list.innerHTML = this.state.selectedCountries.map(c => `
            <div class="selected-item d-flex justify-content-between align-items-center p-2 mb-2 border rounded">
                <span>${c.name} (${c.code})</span>
                <button type="button" class="btn btn-sm btn-danger remove-selected-item-btn" data-code="${c.code}">&times;</button>
            </div>`).join('');
    }

    dedupeActionButtons() {
        const saves = Array.from(document.querySelectorAll('#saveTaskBtn'));
        if (saves.length > 1) saves.slice(0, -1).forEach(b => b.closest('.form-actions')?.remove());
        const cancels = Array.from(document.querySelectorAll('#cancelBtn'));
        if (cancels.length > 1) cancels.slice(0, -1).forEach(b => b.closest('.form-actions')?.remove());
    }

    setupBrandExample() {
        const dropZone = document.getElementById('brand-example-drop-zone');
        const input = document.getElementById('brandExample');
        if(!dropZone || !input) return;

        dropZone.addEventListener('click', () => input.click());
        input.addEventListener('change', (e) => this.handleBrandFile(e.target.files[0]));
        
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => {
            dropZone.addEventListener(e, (ev) => { ev.preventDefault(); ev.stopPropagation(); });
        });
        dropZone.addEventListener('drop', (e) => this.handleBrandFile(e.dataTransfer.files[0]));
        
        document.getElementById('removeBrandExampleBtn')?.addEventListener('click', () => {
            this.state.uploadedFiles = [];
            document.getElementById('brandExamplePreviewContainer').style.display = 'none';
            input.value = '';
        });
    }

    async handleBrandFile(file) {
        if (!file) return;
        if (!file.type.startsWith('image/')) { alert('Lütfen resim seçin (PNG, JPG)'); this.state.uploadedFiles = []; return; }

        const img = new Image();
        img.src = URL.createObjectURL(file);
        
        img.onload = async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 591; canvas.height = 591;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, 591, 591);
            
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
            const newFile = new File([blob], 'brand-example.jpg', { type: 'image/jpeg' });
            
            this.state.uploadedFiles = [newFile];
            
            const previewImg = document.getElementById('brandExamplePreview');
            const container = document.getElementById('brandExamplePreviewContainer');
            if(previewImg) previewImg.src = URL.createObjectURL(blob);
            if(container) container.style.display = 'block';
        };
    }

    setupIpRecordSearch() {
        const input = document.getElementById('ipRecordSearch');
        const results = document.getElementById('ipRecordSearchResults');
        if (!input || !results) return;
        
        const typeId = String(this.state.selectedTaskType?.id || '');
        const selectedType = this.state.selectedTaskType;

        if (selectedType && selectedType.relatedAssetSource === 'suits') {
            this.state.searchSource = 'suits';
            this.state.targetSuitTypes = selectedType.targetSuitTypes || [];
        } else {
            const isBulletinOnly = ['1'].includes(typeId);
            const isHybrid = ['20', 'trademark_publication_objection', TASK_IDS.ITIRAZ_YAYIN, '19', 'trademark_reconsideration_of_publication_objection', TASK_IDS.YAYIMA_ITIRAZIN_YENIDEN_INCELENMESI, '8', TASK_IDS.KARARA_ITIRAZ_GERI_CEKME, '21', TASK_IDS.YAYINA_ITIRAZI_GERI_CEKME].includes(typeId);

            if (isBulletinOnly) this.state.searchSource = 'bulletin';
            else if (isHybrid) this.state.searchSource = 'hybrid'; 
            else this.state.searchSource = 'portfolio';
        }
        
        const newInput = input.cloneNode(true);
        input.parentNode.replaceChild(newInput, input);
        let timer;
        const normalize = (val) => String(val || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

        newInput.addEventListener('input', (e) => {
            const term = e.target.value.trim();
            clearTimeout(timer);
            if (term.length < 2) { results.style.display = 'none'; return; }
            
            timer = setTimeout(async () => {
                let items = [];
                try {
                    if (this.state.searchSource === 'suits') {
                        items = await this.dataManager.searchSuits(term, this.state.targetSuitTypes);
                    } else if (this.state.searchSource === 'bulletin') {
                        const res = await this.dataManager.searchBulletinRecords(term);
                        items = res.map(x => ({ ...x, _source: 'bulletin' }));
                    } else if (this.state.searchSource === 'hybrid') {
                        const [bulletinRes, portfolioRes] = await Promise.all([
                            this.dataManager.searchBulletinRecords(term),
                            this._searchPortfolioLocal(term)
                        ]);
                        const pItems = portfolioRes.map(x => ({ ...x, _source: 'portfolio' }));
                        const existingAppNos = new Set(pItems.map(p => normalize(p.applicationNumber || p.applicationNo)));
                        const uniqueBItems = bulletinRes.map(x => ({ ...x, _source: 'bulletin' })).filter(b => !existingAppNos.has(normalize(b.applicationNo || b.applicationNumber)));
                        items = [...pItems, ...uniqueBItems];
                    } else {
                        const res = this._searchPortfolioLocal(term);
                        items = res.map(x => ({ ...x, _source: 'portfolio' }));
                    }
                    
                    this.uiManager.renderAssetSearchResults(items, async (record, source) => {
                        if (source === 'bulletin') {
                            const details = await this.dataManager.fetchAndStoreBulletinData(record.id);
                            if(details) record = {...record, ...details};
                        }
                        record._source = source;
                        this.selectIpRecord(record); 
                        document.getElementById('ipRecordSearch').value = ''; 
                    }, this.state.searchSource);

                } catch (err) { console.error('Arama hatası:', err); }
            }, 300);
        });
        
        document.addEventListener('click', (e) => {
            if (!results.contains(e.target) && e.target !== newInput) results.style.display = 'none';
        });
    }

    setupMultiAssetSearch(typeId) {
        if (typeId === '81') this.uiManager.updateAssetSearchLabel('research');
        else this.uiManager.updateAssetSearchLabel('portfolio');

        this.state.searchSource = 'portfolio'; 
        this.setupIpRecordSearch();
        
        const newInputs = ['newTitleInput', 'newTypeInput', 'searchKeywordInput'];
        newInputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => this.validator.checkCompleteness(this.state));
        });
    }

    renderIpSearchResults(items, container) {
        if (items.length === 0) {
            container.innerHTML = '<div class="p-2 text-muted">Sonuç bulunamadı.</div>';
        } else {
            container.innerHTML = items.map(item => {
                let badge = '', title = '', subTitle = '';

                if (item._source === 'suit') {
                    badge = '<span class="badge badge-primary float-right" style="font-size: 10px;">Dava</span>';
                    title = item.court || 'Mahkeme Bilgisi Yok';
                    subTitle = `Dosya: <b>${item.fileNumber || '-'}</b>`;
                } else {
                    const isThirdParty = String(item.recordOwnerType || '').toLowerCase() === 'third_party';
                    if (item._source === 'bulletin' || isThirdParty) badge = '<span class="badge badge-warning float-right" style="font-size: 10px;">Bülten</span>';
                    else badge = '<span class="badge badge-info float-right" style="font-size: 10px;">Portföy</span>';
                    title = item.title || item.markName || '-';
                    subTitle = item.applicationNumber || item.applicationNo || '-';
                }

                return `<div class="search-result-item p-2 border-bottom" style="cursor:pointer;" data-id="${item.id}" data-source="${item._source}">${badge}<strong>${title}</strong><br><small>${subTitle}</small></div>`;
            }).join('');
            
            container.querySelectorAll('.search-result-item').forEach(el => {
                el.addEventListener('click', async () => {
                    const id = el.dataset.id;
                    const source = el.dataset.source;
                    let record = items.find(i => i.id === id);
                    if (source === 'bulletin') {
                         const details = await this.dataManager.fetchAndStoreBulletinData(record.id);
                         if(details) record = {...record, ...details};
                    }
                    record._source = source;
                    this.selectIpRecord(record);
                    container.style.display = 'none'; document.getElementById('ipRecordSearch').value = '';
                });
            });
        }
        container.style.display = 'block';
    }

    _searchPortfolioLocal(term) {
        if (!this.state.allIpRecords) return [];
        const typeId = String(this.state.selectedTaskType?.id || '');
        const isThirdPartyOnly = ['1', '20', '37', TASK_IDS.ITIRAZ_YAYIN].includes(typeId);
        const allowThirdPartyMixed = ['19', '8', '21', TASK_IDS.YAYIMA_ITIRAZIN_YENIDEN_INCELENMESI, TASK_IDS.KARARA_ITIRAZ_GERI_CEKME, TASK_IDS.YAYINA_ITIRAZI_GERI_CEKME].includes(typeId);
        const lowerTerm = term.toLowerCase();
        
        return this.state.allIpRecords.filter(r => {
            const ownerType = String(r.recordOwnerType || 'self').toLowerCase();
            if (isThirdPartyOnly) { if (ownerType !== 'third_party') return false; }
            else if (!allowThirdPartyMixed) { if (ownerType === 'third_party') return false; }
            
            return (
                (r.title || '').toLowerCase().includes(lowerTerm) || (r.markName || '').toLowerCase().includes(lowerTerm) ||
                (r.applicationNumber || '').includes(term) || (r.applicationNo || '').includes(term)
            );
        }).slice(0, 20);
    }

    async selectIpRecord(record) {
        this.state.selectedIpRecord = record;
        
        if (record._source === 'suit') {
            const displayCourt = record.displayCourt || record.suitDetails?.court || record.court || 'Mahkeme Yok';
            const displayFile = record.displayFileNumber || record.suitDetails?.caseNo || record.fileNumber || '-';
            const clientName = record.displayClient || record.client?.name || record.client || '-';

            const labelEl = document.getElementById('selectedIpRecordLabel');
            if (labelEl) { labelEl.textContent = displayCourt; labelEl.style.fontSize = '1.3rem'; labelEl.className = 'mb-1 font-weight-bold text-primary'; }

            const numberEl = document.getElementById('selectedIpRecordNumber');
            if (numberEl) {
                numberEl.innerHTML = `
                    <div style="font-size: 1.1rem; margin-bottom: 5px;">Dosya No: <span class="text-dark font-weight-bold">${displayFile}</span></div>
                    <div style="font-size: 1rem; color: #555;"><i class="fas fa-user-tie mr-1"></i> Müvekkil: <b>${clientName}</b></div>
                    <div class="mt-2"><span class="badge badge-secondary p-2" style="font-size: 0.9rem;">${record.typeId || 'Dava'}</span></div>
                `;
            }

            const imgEl = document.getElementById('selectedIpRecordImage');
            const phEl = document.getElementById('selectedIpRecordPlaceholder');
            if(imgEl) imgEl.style.display = 'none';
            if(phEl) { phEl.style.display = 'flex'; phEl.style.width = '80px'; phEl.style.height = '80px'; phEl.innerHTML = '<i class="fas fa-gavel" style="font-size: 32px; color: #555;"></i>'; }

            document.getElementById('selectedIpRecordContainer').style.display = 'block';
            this.uiManager.fillAndLockLawsuitFields(record);
            if (record.client) { this.state.selectedRelatedParties = [record.client]; } 
            else if (record.clientName) { this.state.selectedRelatedParties = [{ id: 'auto', name: record.clientName }]; }

            this.validator.checkCompleteness(this.state);
            return;
        }

        const title = record.title || record.markName || record.name || 'İsimsiz Kayıt';
        const appNo = record.applicationNumber || record.applicationNo || '-';

        const labelEl = document.getElementById('selectedIpRecordLabel');
        const numEl = document.getElementById('selectedIpRecordNumber');
        if (labelEl) { labelEl.textContent = title; labelEl.style.fontSize = ''; labelEl.className = ''; }
        if (numEl) numEl.textContent = appNo;

        const originSelect = document.getElementById('originSelect');
        const mainIpTypeSelect = document.getElementById('mainIpType');
        const recordOrigin = record.origin || 'TÜRKPATENT';
        
        if (originSelect) {
            if (originSelect.value !== recordOrigin) { 
                originSelect.value = recordOrigin; 
                this.handleOriginChange(recordOrigin, true); // 🔥 BURAYA true EKLENDİ
            }
            originSelect.disabled = true;
        }
        if (mainIpTypeSelect) mainIpTypeSelect.disabled = true;

        const imgEl = document.getElementById('selectedIpRecordImage');
        const phEl = document.getElementById('selectedIpRecordPlaceholder');
        if(phEl) { phEl.style.width = '60px'; phEl.style.height = '60px'; }

        if(imgEl) { imgEl.style.display = 'none'; imgEl.src = ''; }
        if(phEl) { phEl.style.display = 'flex'; phEl.innerHTML = '<i class="fas fa-image" style="font-size: 24px;"></i>'; }

        let finalImageUrl = null;
        const potentialPath = record.imagePath || record.brandImageUrl || record.image || record.logo || record.imageUrl;

        try {
            if (potentialPath) {
                if (potentialPath.startsWith('http') || potentialPath.startsWith('data:')) finalImageUrl = potentialPath;
                else finalImageUrl = await this.dataManager.resolveImageUrl(potentialPath);
            }
        } catch (err) { console.warn('Görsel hatası:', err); }

        if (finalImageUrl) {
            if(imgEl) { imgEl.src = finalImageUrl; imgEl.style.display = 'block'; }
            if(phEl) phEl.style.display = 'none';
        }
        
        document.getElementById('selectedIpRecordContainer').style.display = 'block';

        if (this.state.isWithdrawalTask) {
            const sourceCollection = record._source === 'suit' ? 'suits' : 'ipRecords';
            let txResult = await this.dataManager.getRecordTransactions(record.id, sourceCollection);
            let combinedTransactions = txResult.success ? txResult.data : [];

            if (sourceCollection === 'ipRecords' && combinedTransactions.length === 0 && (record.wipoIR || record.aripoIR)) {
                const irNumber = record.wipoIR || record.aripoIR;
                const relatives = this.state.allIpRecords.filter(r => (r.wipoIR === irNumber || r.aripoIR === irNumber) && r.id !== record.id);
                for (const rel of relatives) {
                    const relResult = await this.dataManager.getRecordTransactions(rel.id, 'ipRecords');
                    if (relResult.success && relResult.data.length > 0) combinedTransactions = [...combinedTransactions, ...relResult.data];
                }
            }

            if (combinedTransactions.length > 0) {
                record.transactions = combinedTransactions;
                this.processParentTransactions(record);
            } else {
                alert('Bu varlık üzerinde geri çekilebilecek uygun bir işlem (İtiraz vb.) bulunamadı.');
            }
        }

        if (record.wipoIR || record.aripoIR) {
            const ir = record.wipoIR || record.aripoIR;
            this.state.selectedWipoAripoChildren = this.state.allIpRecords.filter(c => c.transactionHierarchy === 'child' && (c.wipoIR === ir || c.aripoIR === ir));
            this.uiManager.renderWipoAripoChildRecords(this.state.selectedWipoAripoChildren);
        }

        this.validator.checkCompleteness(this.state);
    }

    processParentTransactions(record) {
        const currentTaskTypeId = String(this.state.selectedTaskType?.id);
        let parentTypes = [];

        if (currentTaskTypeId === '21') parentTypes = ['20', 'trademark_publication_objection'];
        else if (currentTaskTypeId === '8') parentTypes = ['7', '19', 'trademark_decision_objection', 'trademark_reconsideration_of_publication_objection'];
        else if (currentTaskTypeId === '37' || currentTaskTypeId === 'ITIRAZA_EK_BELGE') parentTypes = ['7', '19', '20', 'trademark_decision_objection', 'trademark_reconsideration_of_publication_objection', 'trademark_publication_objection'];

        const parents = (record.transactions || []).filter(t => parentTypes.includes(String(t.type)));
        
        if (parents.length > 1) {
            const enrichedParents = parents.map(p => ({ ...p, transactionTypeName: this.getTransactionTypeName(p.type) }));
            const modalTitle = currentTaskTypeId === '37' ? 'Belgenin Ekleneceği İtirazı Seçin' : 'Geri Çekilecek İşlemi Seçin';
            this.uiManager.showParentSelectionModal(enrichedParents, modalTitle);
        } else if (parents.length === 1) {
            this.submitHandler.selectedParentTransactionId = parents[0].id;
        } else {
            const actionName = currentTaskTypeId === '37' ? 'ek belge sunulabilecek' : 'geri çekilebilecek';
            alert(`Bu varlık üzerinde ${actionName} uygun bir ana işlem (İtiraz vb.) bulunamadı.`);
            this.state.selectedIpRecord = null; 
            document.getElementById('selectedIpRecordContainer').style.display = 'none';
        }
    }

    getTransactionTypeName(typeId) {
        const t = this.state.allTransactionTypes.find(x => String(x.id) === String(typeId));
        return t ? (t.alias || t.name) : 'Bilinmeyen İşlem';
    }

    setupPersonSearchListeners() {
        const inputs = {
            'personSearchInput': 'relatedParty',
            'tpInvoicePartySearch': 'tpInvoiceParty',
            'serviceInvoicePartySearch': 'serviceInvoiceParty',
            'ownerSearchInput': 'owner' 
        };

        for (const [iid, role] of Object.entries(inputs)) {
            const inp = document.getElementById(iid);
            if (!inp) continue;

            let resId = 'personSearchResults'; 
            if (role === 'tpInvoiceParty') resId = 'tpInvoicePartyResults';
            if (role === 'serviceInvoiceParty') resId = 'serviceInvoicePartyResults';
            if (role === 'owner') resId = 'ownerSearchResults'; 

            const resDiv = document.getElementById(resId);
            if (!resDiv) continue; 

            inp.addEventListener('input', (e) => {
                const term = e.target.value.toLowerCase();
                if (term.length < 2) { resDiv.style.display = 'none'; return; }

                const found = this.state.allPersons.filter(p => p.name.toLowerCase().includes(term)).slice(0, 10);
                resDiv.innerHTML = found.map(p => `<div class="search-result-item p-2 border-bottom" data-id="${p.id}" style="cursor:pointer;">${p.name}</div>`).join('');
                resDiv.style.display = 'block';

                resDiv.querySelectorAll('.search-result-item').forEach(el => {
                    el.addEventListener('click', () => {
                        const selectedPerson = this.state.allPersons.find(p => String(p.id) === String(el.dataset.id));
                        if (selectedPerson) {
                            this.handlePersonSelection(selectedPerson, role);
                            inp.value = ''; resDiv.style.display = 'none';
                        }
                    });
                });
            });

            document.addEventListener('click', (e) => {
                if (resDiv.style.display === 'block' && e.target !== inp && !resDiv.contains(e.target)) {
                    resDiv.style.display = 'none';
                }
            });
        }
    }

    handlePersonSelection(person, role) {
        if (role === 'relatedParty') {
            if (!this.state.selectedRelatedParties.some(p => p.id === person.id)) {
                this.state.selectedRelatedParties.push(person);
                this.state.selectedRelatedParty = person; 
                this.uiManager.renderSelectedRelatedParties(this.state.selectedRelatedParties);
            }
        } 
        else if (role === 'owner') { 
            if (!this.state.selectedOwners) this.state.selectedOwners = [];
            if (!this.state.selectedOwners.some(p => p.id === person.id)) {
                this.state.selectedOwners.push(person);
                this.uiManager.renderSelectedOwners(this.state.selectedOwners);
            }
        }
        else if (role === 'tpInvoiceParty') {
            this.state.selectedTpInvoiceParty = person;
            const disp = document.getElementById('selectedTpInvoicePartyDisplay');
            if(disp) { disp.textContent = person.name; disp.style.display = 'block'; }
        } 
        else if (role === 'serviceInvoiceParty') {
            this.state.selectedServiceInvoiceParty = person;
            const disp = document.getElementById('selectedServiceInvoicePartyDisplay');
            if(disp) { disp.textContent = person.name; disp.style.display = 'block'; }
        }
        
        this.validator.checkCompleteness(this.state);
    }
    
    setupApplicantListeners() {
        const inp = document.getElementById('applicantSearchInput');
        if(inp) inp.addEventListener('input', (e) => {
             const term = e.target.value.toLowerCase();
             const resDiv = document.getElementById('applicantSearchResults');
             if(term.length<2) { resDiv.style.display='none'; return; }
             const found = this.state.allPersons.filter(p => p.name.toLowerCase().includes(term)).slice(0,10);
             resDiv.innerHTML = found.map(p => `<div class="search-result-item p-2" data-id="${p.id}">${p.name}</div>`).join('');
             resDiv.style.display='block';
             resDiv.querySelectorAll('.search-result-item').forEach(el => {
                 el.addEventListener('click', () => {
                     const p = this.state.allPersons.find(x=>x.id===el.dataset.id);
                     if(!this.state.selectedApplicants.some(a=>a.id===p.id)) this.state.selectedApplicants.push(p);
                     this.uiManager.renderSelectedApplicants(this.state.selectedApplicants);
                     resDiv.style.display='none';
                     this.validator.checkCompleteness(this.state);
                 });
             });
        });
        
        document.addEventListener('click', (e) => {
            if(e.target.closest('.remove-selected-item-btn')) {
                const id = e.target.closest('.remove-selected-item-btn').dataset.id;
                this.state.selectedApplicants = this.state.selectedApplicants.filter(a=>a.id!==id);
                this.uiManager.renderSelectedApplicants(this.state.selectedApplicants);
            }
            if(e.target.closest('.remove-party')) {
                 const id = e.target.closest('.remove-party').dataset.id;
                 this.state.selectedRelatedParties = this.state.selectedRelatedParties.filter(p=>p.id!==id);
                 this.uiManager.renderSelectedRelatedParties(this.state.selectedRelatedParties);
                 this.validator.checkCompleteness(this.state);
            }
            if(e.target.closest('.remove-priority-btn')) {
                const id = e.target.closest('.remove-priority-btn').dataset.id;
                this.state.priorities = this.state.priorities.filter(p=>p.id!==id);
                this.uiManager.renderPriorities(this.state.priorities);
            }
        });

        const addPrioBtn = document.getElementById('addPriorityBtn');
        if(addPrioBtn) addPrioBtn.addEventListener('click', () => {
             const p = {
                 id: Date.now().toString(),
                 type: document.getElementById('priorityType').value,
                 date: document.getElementById('priorityDate').value,
                 country: document.getElementById('priorityCountry').value,
                 number: document.getElementById('priorityNumber').value
             };
             if(p.date && p.country && p.number) {
                 this.state.priorities.push(p);
                 this.uiManager.renderPriorities(this.state.priorities);
                 document.getElementById('priorityDate').value = '';
                 document.getElementById('priorityCountry').value = '';
                 document.getElementById('priorityNumber').value = '';
             }
        });
    }

    applyAssignmentRule(rule) {
        const select = document.getElementById('assignedTo');
        if (!select) return;
        
        select.innerHTML = '<option value="">Seçiniz...</option>';
        let usersToShow = this.state.allUsers;

        if (rule && rule.assigneeIds && rule.assigneeIds.length > 0) {
            usersToShow = this.state.allUsers.filter(u => rule.assigneeIds.includes(u.id));
            if (rule.allowManualOverride === false) select.disabled = true;
        }

        usersToShow.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u.id;
            opt.textContent = u.displayName || u.email;
            select.appendChild(opt);
        });
        
        if (usersToShow.length === 1) {
            select.value = usersToShow[0].id;
            select.disabled = true;
        }
    }

    calculateTotalAmount() {
        const off = parseFloat(document.getElementById('officialFee')?.value || 0);
        const srv = parseFloat(document.getElementById('serviceFee')?.value || 0);
        const vat = parseFloat(document.getElementById('vatRate')?.value || 20);
        const apply = document.getElementById('applyVatToOfficialFee')?.checked;
        
        let total = apply ? (off + srv) * (1 + vat/100) : off + (srv * (1 + vat/100));
        document.getElementById('totalAmountDisplay').textContent = total.toFixed(2) + ' TRY';
    }

    renderSummary() {
        this.uiManager.renderSummaryTab(this.state);
    }

    resetSelections() {
        this.state.selectedIpRecord = null;
        this.state.selectedRelatedParties = [];
        this.state.selectedApplicants = [];
        this.state.selectedOwners = [];
        this.state.uploadedFiles = [];
        this.state.priorities = [];
        this.state.selectedWipoAripoChildren = [];
        this.state.selectedCountries = [];
    }
}

// 🔥 YENİ: Sayfa HTML'i tamamen hazır olduğunda menüyü ve modülü güvenle başlat
document.addEventListener('DOMContentLoaded', () => {
    // 1. Sol menüyü ve üst barı yükle
    loadSharedLayout({ activeMenuLink: 'create-task.html' }).catch(console.error);
    
    // 2. Modülü başlat
    const controller = new CreateTaskController();
    controller.init();
});