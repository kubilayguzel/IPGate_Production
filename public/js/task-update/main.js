import { authService, supabase, storageService } from '../../supabase-config.js';
import { loadSharedLayout, ensurePersonModal } from '../layout-loader.js';
import { showNotification } from '../../utils.js';

import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

import { TaskUpdateDataManager } from './TaskUpdateDataManager.js';
import { TaskUpdateUIManager } from './TaskUpdateUIManager.js';
import { OppositionWorkspaceManager } from './OppositionWorkspaceManager.js';
import { AccrualFormManager } from '../components/AccrualFormManager.js';

// --- WORD İNDİRME KÜTÜPHANELERİ ---
import PizZip from 'https://cdn.jsdelivr.net/npm/pizzip@3.1.7/+esm';
import Docxtemplater from 'https://cdn.jsdelivr.net/npm/docxtemplater@3.55.8/+esm';
import saveAs from 'https://cdn.jsdelivr.net/npm/file-saver@2.0.5/+esm';

const PETITION_REVIEW_SOURCE_TYPES = new Set(['1', '7', '19', '20', '37', '38', '39']);
const PETITION_REVIEW_TASK_TYPE = '83';

class TaskUpdateController {
    constructor() {
        this.dataManager = new TaskUpdateDataManager();
        this.uiManager = new TaskUpdateUIManager();
        this.accrualManager = null; 
        this.taskId = null;
        this.returnTarget = 'task-management.html';
        this.taskData = null;
        this.masterData = {}; 
        this.currentDocuments = [];
        this.uploadedEpatsFile = null;
        this.statusBeforeEpatsUpload = null;
        this.epatsAutoCompleted = false;
        this.epatsLifecycleKnown = false;
        this.epatsAddedThisSession = false;
        this.epatsRemovedPendingSave = false;
        this.epatsRestoreStatus = null;
        this.epatsRemovalInProgress = false;
        this.tempApplicationData = null; 
        this.selectedIpRecordId = null;
        this.selectedPersonId = null;
        this.tempRenewalData = null;
        this.suitParties = { plaintifs: [], defendants: [] };
        this.oppositionWorkspaceManager = null;
        this.petitionReviewBusy = false;
    }

    async init() {
        await loadSharedLayout();
        ensurePersonModal();

        this.uiManager.ensureApplicationDataModal();
        this.setupApplicationModalEvents();

        const queryParams = new URLSearchParams(window.location.search);
        this.taskId = queryParams.get('id');

        // Liste bağlamını koru: İşlerim'den gelindiyse İşlerim'e,
        // İş Yönetimi'nden gelindiyse İş Yönetimi'ne dön.
        // Öncelik: açık returnTo parametresi -> gerçek referrer -> task-update zincirindeki son bağlam.
        const requestedReturnTo = queryParams.get('returnTo');
        if (requestedReturnTo === 'my-tasks') {
            this.returnTarget = 'my-tasks.html';
        } else if (requestedReturnTo === 'task-management') {
            this.returnTarget = 'task-management.html';
        } else {
            let referrerPage = '';
            try {
                referrerPage = new URL(document.referrer).pathname.split('/').pop() || '';
            } catch (_) {}

            if (referrerPage === 'my-tasks.html') {
                this.returnTarget = 'my-tasks.html';
            } else if (referrerPage === 'task-management.html') {
                this.returnTarget = 'task-management.html';
            } else if (referrerPage === 'task-update.html') {
                const chainedReturnTarget = sessionStorage.getItem('taskUpdateReturnTarget');
                if (chainedReturnTarget === 'my-tasks.html' || chainedReturnTarget === 'task-management.html') {
                    this.returnTarget = chainedReturnTarget;
                }
            }
        }

        sessionStorage.setItem('taskUpdateReturnTarget', this.returnTarget);
        if (!this.taskId) return window.location.href = this.returnTarget;

        const session = await authService.getCurrentSession();
        if (!session) return window.location.href = 'index.html';
        
        try {
            this.masterData = await this.dataManager.loadAllInitialData();

            await this.refreshTaskData();

            this.setupEvents();
            this.setupAccrualModal();

            this.oppositionWorkspaceManager =
                new OppositionWorkspaceManager(
                    this.taskId,
                    this.taskData
                );

            await this.oppositionWorkspaceManager.init();
        } catch (e) {
            console.error('Başlatma hatası:', e);
            showNotification('Sayfa yüklenirken hata oluştu: ' + e.message, 'error');
        }

        this.uiManager.ensureRenewalDataModal();
        this.setupRenewalModalEvents();
    }

    generateUUID() {
        return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).substr(2, 16);
    }

    async extractEpatsInfoFromFile(file) {
        try {
            if (!window.pdfjsLib) {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
                    script.onload = () => {
                        try {
                            const workerScript = `importScripts('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js');`;
                            const workerBlob = new Blob([workerScript], { type: 'application/javascript' });
                            window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    };
                    script.onerror = () => reject(new Error("PDF.js kütüphanesi yüklenemedi."));
                    document.head.appendChild(script);
                });
            }
            const pdfjsLib = window.pdfjsLib;

            const arrayBuffer = await file.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer); 
            const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
            const pdf = await loadingTask.promise;

            let fullText = '';
            const maxPages = Math.min(pdf.numPages, 2);
            for (let i = 1; i <= maxPages; i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                const strings = content.items.map(item => item.str);
                fullText += strings.join(' ') + '\n';
            }

            const normalizedText = fullText.replace(/\s+/g, ' '); 

            let evrakNo = null;
            let documentDate = null;

            // ==========================================
            // 1. EVRAK NUMARASI BULMA MANTIĞI
            // ==========================================
            // EPATS Formatlı tüm numaraları bul (Örn: 2026-GE-123456)
            const epatsFormatRegex = /\b(20\d{2}-[A-Za-z]+-\d+)\b/g;
            const allMatches = [...normalizedText.matchAll(epatsFormatRegex)].map(m => m[1]);
            
            if (allMatches.length > 1) {
                // Kullanıcının kararı: Birden fazla evrak numarası varsa "ikincisini" al
                evrakNo = allMatches[1];
            } else if (allMatches.length === 1) {
                evrakNo = allMatches[0];
            } else {
                // Klasik etiket formatı yedeklemesi
                const regex = /Evrak\s+(?:No|Numarası)[\s:.\-,"']*([a-zA-Z0-9\-]+)/gi;
                const altMatches = [...normalizedText.matchAll(regex)].map(m => m[1].trim().replace(/-$/, ''));
                if (altMatches.length > 1) {
                    evrakNo = altMatches[1]; // İkincisini al
                } else if (altMatches.length === 1) {
                    evrakNo = altMatches[0];
                }
            }

            // ==========================================
            // 2. EVRAK TARİHİ BULMA MANTIĞI
            // ==========================================
            // EPATS Evrak Tarihleri genellikle saat bilgisi içerir (Örn: 02.07.2026 13:43:40)
            const dateTimeRegex = /\b(\d{1,2}[./-]\d{1,2}[./-]\d{4})\s+\d{2}:\d{2}(?::\d{2})?\b/g;
            const dateTimeMatches = [...normalizedText.matchAll(dateTimeRegex)].map(m => m[1]);

            if (dateTimeMatches.length > 1) {
                documentDate = this.parseDate(dateTimeMatches[1]); // İkincisini al
            } else if (dateTimeMatches.length === 1) {
                documentDate = this.parseDate(dateTimeMatches[0]);
            } else {
                // Saat bilgisi yoksa belgedeki düz tarihleri bul
                const dateRegex = /\b(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/g;
                const dateMatches = [...normalizedText.matchAll(dateRegex)].map(m => m[1]);
                
                if (dateMatches.length > 1) {
                    // Kullanıcının kararı: Birden fazla evrak tarihi varsa "ikincisini" al
                    documentDate = this.parseDate(dateMatches[1]);
                } else if (dateMatches.length === 1) {
                    documentDate = this.parseDate(dateMatches[0]);
                }
            }

            return { evrakNo, documentDate };
        } catch (e) { 
            console.error("PDF İşleme Hatası:", e);
            return null; 
        }
    }

    parseDate(dateStr) {
        if (!dateStr) return null;
        const parts = dateStr.replace(/\//g, '.').split('.');
        if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        return null;
    }

    isInheritedDocument(doc) {
        return !!(doc?.isInherited || String(doc?.name || '').startsWith('(Ana Görev)'));
    }

    getOwnDocuments() {
        return (this.currentDocuments || []).filter(doc => !this.isInheritedDocument(doc));
    }

    getOwnedEpatsDocument() {
        return (this.currentDocuments || []).find(doc =>
            doc?.type === 'epats_document' && !this.isInheritedDocument(doc)
        ) || null;
    }

    getStoragePathForDocument(doc) {
        let path = String(doc?.storagePath || '').trim();
        if (path.startsWith('documents/')) path = path.substring('documents/'.length);
        if (path) return decodeURIComponent(path);

        const url = String(doc?.url || doc?.downloadURL || '');
        const marker = '/documents/';
        const idx = url.indexOf(marker);
        if (idx >= 0) return decodeURIComponent(url.substring(idx + marker.length));
        return '';
    }

    setSaveButtonBusy(isBusy, title = '') {
        const saveBtn = document.getElementById('saveTaskChangesBtn');
        if (!saveBtn) return;
        saveBtn.disabled = !!isBusy;
        if (isBusy) {
            saveBtn.dataset.epatsBusy = '1';
            saveBtn.title = title || 'EPATS evrak işlemi tamamlanıyor.';
        } else if (saveBtn.dataset.epatsBusy === '1') {
            delete saveBtn.dataset.epatsBusy;
            saveBtn.removeAttribute('title');
        }
    }

    async refreshTaskData() {
        this.taskData = await this.dataManager.getTaskById(this.taskId);
        this.currentDocuments = this.taskData.documents || [];

        this.selectedIpRecordId = this.taskData.relatedIpRecordId || this.taskData.related_ip_record_id || null;
        
        // 🔥 ÇÖZÜM: İlgili Taraf tespiti (task_owner_id birinci öncelik)
        let ownerId = this.taskData.task_owner_id || this.taskData.taskOwnerId || this.taskData.relatedPartyId || this.taskData.related_party_id || this.taskData.opponentId || this.taskData.opponent_id;
        
        if (!ownerId) {
            let owners = this.taskData.task_owner || this.taskData.taskOwner;
            if (typeof owners === 'string') {
                try { owners = JSON.parse(owners); } catch (e) {}
            }
            if (Array.isArray(owners) && owners.length > 0) ownerId = owners[0];
        }
        this.selectedPersonId = ownerId || null;

        const typeStr = String(this.taskData.taskType || this.taskData.task_type_id);
        this.uiManager.setPetitionReviewEnabled(PETITION_REVIEW_SOURCE_TYPES.has(typeStr) && this.getPetitionReviewStatus() !== 'in_review');

        // Standart UI Doldurma İşlemleri
        this.uiManager.fillForm(this.taskData, this.masterData.users);
        this.uiManager.renderDocuments(this.currentDocuments);
        this.renderAccruals();
        this.renderPetitionReviewUi();
        
        // --- PORTFÖY (MARKA) VARLIĞI VE DAVA KARTI (TİP 49) ÇİZİMİ ---

        const existingYidkSuit = typeStr === '49'
            ? await this.dataManager.getSuitByTaskId(this.taskId)
            : null;
        // 🔥 YENİ: Veritabanından gelen eski tarafları main.js state'ine yükle
        if (existingYidkSuit && existingYidkSuit.suit_parties) {
            this.suitParties.plaintifs = existingYidkSuit.suit_parties
                .filter(p => p.role === 'davaci')
                .map(p => ({ id: p.person_id || 'free_text_' + crypto.randomUUID(), name: p.free_text_name }));
                
            this.suitParties.defendants = existingYidkSuit.suit_parties
                .filter(p => p.role === 'davali')
                .map(p => ({ id: p.person_id || 'free_text_' + crypto.randomUUID(), name: p.free_text_name }));
        }

        if (this.selectedIpRecordId) {
            let rec = this.masterData.ipRecords.find(r => String(r.id) === String(this.selectedIpRecordId));
            if (!rec) {
                rec = { 
                    id: this.selectedIpRecordId, 
                    title: this.taskData.iprecordTitle || this.taskData.relatedIpRecordTitle || 'Kayıtlı Olmayan Varlık', 
                    applicationNumber: this.taskData.iprecordApplicationNo 
                };
            }
            this.uiManager.renderSelectedIpRecord(rec);

        // Görev tipi 49 ise Dava kartını mevcut dava verisiyle çiz
            if (typeStr === '49') {
                this.uiManager.buildYidkSuitForm(this.taskData, rec, existingYidkSuit);
                // 🔥 Arayüzü güncel verilerle tetikle
                this.updateSuitPartyUI('plaintif');
                this.updateSuitPartyUI('defendant');
            }
        } else {
            // Marka verisi yoksa bile Görev tipi 49 ise Dava kartını mevcut dava verisiyle çiz
            if (typeStr === '49') {
                this.uiManager.buildYidkSuitForm(this.taskData, null, existingYidkSuit);
            }
        }

        // --- İLGİLİ TARAF (PERSON) ÇİZİMİ ---
        if (this.selectedPersonId) {
            let p = this.masterData.persons.find(x => String(x.id) === String(this.selectedPersonId));
            if (!p) {
                p = { 
                    id: this.selectedPersonId, 
                    name: this.taskData.relatedPartyName || this.taskData.related_party_name || this.taskData.opponentName || this.taskData.opponent_name || this.taskData.iprecordApplicantName || 'Kayıtlı Olmayan Taraf'
                };
            }
            this.uiManager.renderSelectedPerson(p);
        }

        const epatsDetails = this.getTaskDetails();
        this.statusBeforeEpatsUpload = epatsDetails.status_before_epats_upload || null;
        this.epatsLifecycleKnown = Object.prototype.hasOwnProperty.call(epatsDetails, 'completed_by_epats');
        this.epatsAutoCompleted = epatsDetails.completed_by_epats === true || String(epatsDetails.completed_by_epats) === 'true';
        this.epatsAddedThisSession = false;
        this.epatsRemovedPendingSave = false;
        this.epatsRestoreStatus = null;
        this.epatsRemovalInProgress = false;
        this.lockFieldsIfApplicationTask();
    }

    lockFieldsIfApplicationTask() {
        const lockedTypes = ['2'];
        const currentType = String(this.taskData.taskType || this.taskData.task_type_id || '');
        if (lockedTypes.includes(currentType)) {
            const ipSearchInput = document.getElementById('relatedIpRecordSearch');
            const ipRemoveBtn = document.querySelector('#selectedIpRecordDisplay #removeIpRecordBtn');
            if (ipSearchInput) { ipSearchInput.disabled = true; ipSearchInput.style.backgroundColor = "#e9ecef"; }
            if (ipRemoveBtn) ipRemoveBtn.style.display = 'none'; 
            
            const partySearchInput = document.getElementById('relatedPartySearch');
            const partyRemoveBtn = document.querySelector('#selectedRelatedPartyDisplay #removeRelatedPartyBtn');
            if (partySearchInput) { partySearchInput.disabled = true; partySearchInput.style.backgroundColor = "#e9ecef"; }
            if (partyRemoveBtn) partyRemoveBtn.style.display = 'none';
        }

        if (currentType === PETITION_REVIEW_TASK_TYPE) {
            const statusSelect = document.getElementById('taskStatus');
            if (statusSelect) {
                statusSelect.disabled = true;
                statusSelect.title = 'Dilekçe kontrol işi, İşlerim ekranındaki Onayla / Düzeltme İste aksiyonlarıyla sonuçlandırılır.';
            }
            const saveBtn = document.getElementById('saveTaskChangesBtn');
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.title = 'Dilekçe Kontrol işi salt okunurdur. Sonucu İşlerim ekranından kaydedin.';
            }
        }
    }
    
    // GÜVENLİ ETKİLEŞİM TANIMLAMALARI (if kontrolü ile)
    setupEvents() {
        const saveBtn = document.getElementById('saveTaskChangesBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.saveTaskChanges();
            });
        }

        const cancelBtn = document.getElementById('cancelEditBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => window.location.href = this.returnTarget);
        }

        const fileArea = document.getElementById('fileUploadArea');
        if (fileArea) {
            fileArea.addEventListener('click', () => document.getElementById('fileInput')?.click());
        }

        const fileInput = document.getElementById('fileInput');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => this.uploadDocuments(e.target.files));
        }

        const fileList = document.getElementById('fileListContainer');
        if (fileList) {
            fileList.addEventListener('change', (e) => {
                const petitionCheckbox = e.target.closest('.petition-document-checkbox');
                if (petitionCheckbox) {
                    this.togglePetitionDocument(
                        petitionCheckbox.dataset.id,
                        petitionCheckbox.checked,
                        petitionCheckbox
                    );
                }
            });
            fileList.addEventListener('click', (e) => {
                const btn = e.target.closest('.btn-remove-file');
                if (btn) this.removeDocument(btn.dataset.id);
            });
        }

        const epatsArea = document.getElementById('epatsFileUploadArea');
        if (epatsArea) {
            epatsArea.addEventListener('click', () => document.getElementById('epatsFileInput')?.click());
            
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => epatsArea.addEventListener(evt, (ev) => { ev.preventDefault(); ev.stopPropagation(); }));
            epatsArea.addEventListener('drop', (ev) => {
                const files = ev.dataTransfer?.files;
                if (!files || !files.length) return;
                this.uploadEpatsDocument(files[0]);
            });
        }

        const epatsInput = document.getElementById('epatsFileInput');
        if (epatsInput) {
            epatsInput.addEventListener('change', (e) => this.uploadEpatsDocument(e.target.files[0]));
        }

        const epatsList = document.getElementById('epatsFileListContainer');
        if (epatsList) {
            epatsList.addEventListener('click', (e) => {
                if (e.target.closest('#removeEpatsFileBtn')) this.removeEpatsDocument();
            });
        }

        const petitionReviewPanel = document.getElementById('petitionReviewStatusPanel');
        if (petitionReviewPanel) {
            petitionReviewPanel.addEventListener('click', (e) => {
                const approveBtn = e.target.closest('#petitionReviewApproveBtn');
                if (approveBtn) {
                    e.preventDefault();
                    this.completePetitionReviewFromDetail('approved', null, null, approveBtn);
                    return;
                }

                const revisionBtn = e.target.closest('#petitionReviewRevisionBtn');
                if (revisionBtn) {
                    e.preventDefault();
                    this.openPetitionReviewRevisionModal();
                }
            });
        }

        const ipSearch = document.getElementById('relatedIpRecordSearch');
        if (ipSearch) {
            ipSearch.addEventListener('input', (e) => {
                const results = this.dataManager.searchIpRecords(this.masterData.ipRecords, e.target.value);
                this.renderSearchResults(results, 'ipRecord');
            });
        }

        const partySearch = document.getElementById('relatedPartySearch');
        if (partySearch) {
            partySearch.addEventListener('input', (e) => {
                const results = this.dataManager.searchPersons(this.masterData.persons, e.target.value);
                this.renderSearchResults(results, 'person');
            });
        }

        // YİDK - Davacı ve Davalı Taraf Çoklu Seçim
        document.addEventListener('input', (e) => {
            if (e.target.id === 'suitPlaintifSearch') {
                const results = this.dataManager.searchPersons(this.masterData.persons, e.target.value);
                this.renderSuitPartyResults(results, 'plaintif');
            } else if (e.target.id === 'suitDefendantSearch') {
                const results = this.dataManager.searchPersons(this.masterData.persons, e.target.value);
                this.renderSuitPartyResults(results, 'defendant');
            }
        });

        document.addEventListener('click', (e) => {
            if (e.target.closest('.remove-suit-party-btn')) {
                const btn = e.target.closest('.remove-suit-party-btn');
                const id = btn.dataset.id;
                const role = btn.dataset.role;
                this.removeSuitParty(id, role);
            }
        });

        document.addEventListener('click', (e) => {
            // Arama sonuçlarının dışına tıklanınca kapatma
            if (!e.target.closest('#suitPlaintifSearch') && !e.target.closest('#suitPlaintifSearchResults')) {
                const res = document.getElementById('suitPlaintifSearchResults');
                if (res) res.style.display = 'none';
            }
            if (!e.target.closest('#suitDefendantSearch') && !e.target.closest('#suitDefendantSearchResults')) {
                const res = document.getElementById('suitDefendantSearchResults');
                if (res) res.style.display = 'none';
            }

            // 🔥 YENİ: Serbest Metin Ekle (+) Butonu
            if (e.target.closest('.add-suit-party-btn')) {
                const btn = e.target.closest('.add-suit-party-btn');
                const role = btn.dataset.role;
                const inputId = role === 'plaintif' ? 'suitPlaintifSearch' : 'suitDefendantSearch';
                const input = document.getElementById(inputId);
                const name = input.value.trim();
                
                if (name) {
                    this.addSuitParty({ id: 'free_text_' + Date.now(), name: name }, role);
                    input.value = '';
                    const resContainer = document.getElementById(role === 'plaintif' ? 'suitPlaintifSearchResults' : 'suitDefendantSearchResults');
                    if (resContainer) resContainer.style.display = 'none';
                }
            }
        });

        // 🔥 EXTRA: Enter tuşuna basıldığında da serbest metni (free text) eklesin
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.target.id === 'suitPlaintifSearch') {
                    e.preventDefault();
                    document.querySelector('.add-suit-party-btn[data-role="plaintif"]')?.click();
                } else if (e.target.id === 'suitDefendantSearch') {
                    e.preventDefault();
                    document.querySelector('.add-suit-party-btn[data-role="defendant"]')?.click();
                }
            }
        });

        const selIpDisplay = document.getElementById('selectedIpRecordDisplay');
        if (selIpDisplay) {
            selIpDisplay.addEventListener('click', (e) => {
                if(e.target.closest('#removeIpRecordBtn')) {
                    this.selectedIpRecordId = null; 
                    this.uiManager.renderSelectedIpRecord(null);
                }
            });
        }

        const selPartyDisplay = document.getElementById('selectedRelatedPartyDisplay');
        if (selPartyDisplay) {
            selPartyDisplay.addEventListener('click', (e) => {
                if(e.target.closest('#removeRelatedPartyBtn')) {
                    this.selectedPersonId = null; 
                    this.uiManager.renderSelectedPerson(null);
                }
            });
        }
    }

    setupApplicationModalEvents() {
        const btn = document.getElementById('btnSaveApplicationData');
        if(btn) {
            btn.onclick = (e) => {
                e.preventDefault();
                const appNo = document.getElementById('modalAppNumber').value;
                const appDate = document.getElementById('modalAppDate').value;
                if(!appNo || !appDate) return alert('Lütfen Başvuru Numarası ve Tarihi alanlarını doldurunuz.'); 
                this.tempApplicationData = { appNo, appDate };
                if(window.$) $('#applicationDataModal').modal('hide');
            };
        }
    }

    setupRenewalModalEvents() {
        const btn = document.getElementById('btnSaveRenewalData');
        if (btn) {
            btn.onclick = (e) => {
                e.preventDefault();
                const newDate = document.getElementById('modalRenewalDate').value;
                if (!newDate) return showNotification('Lütfen yeni koruma tarihini giriniz.', 'warning');
                this.tempRenewalData = newDate;
                if (window.$) $('#renewalDataModal').modal('hide');
            };
        }
    }

    handleRenewalLogic() {
        const record = this.masterData.ipRecords.find(r => String(r.id) === String(this.selectedIpRecordId));
        if (!record) return;
        if ((record.origin || '').toUpperCase() === 'TÜRKPATENT' && record.renewalDate) {
            const nextRenewalDate = new Date(record.renewalDate);
            nextRenewalDate.setFullYear(nextRenewalDate.getFullYear() + 10);
            document.getElementById('modalRenewalDate').value = nextRenewalDate.toISOString().split('T')[0];
        }
        if (window.$) $('#renewalDataModal').modal({ backdrop: 'static', keyboard: false, show: true });
    }
    
    renderSearchResults(items, type) {
        const container = type === 'ipRecord' ? this.uiManager.elements.ipResults : this.uiManager.elements.partyResults;
        if (!container) return;
        
        container.innerHTML = '';
        if (items.length === 0) return container.style.display = 'none';
        
        items.slice(0, 10).forEach(item => {
            const div = document.createElement('div');
            div.className = 'search-result-item';
            div.textContent = type === 'ipRecord' ? (item.title || item.brandName) : item.name;
            div.onclick = () => {
                if (type === 'ipRecord') {
                    this.selectedIpRecordId = item.id;
                    this.uiManager.renderSelectedIpRecord(item);
                } else {
                    this.selectedPersonId = item.id;
                    this.uiManager.renderSelectedPerson(item);
                }
                container.style.display = 'none';
            };
            container.appendChild(div);
        });
        container.style.display = 'block';
    }

    renderSuitPartyResults(items, role) {
        const isPlaintif = role === 'plaintif';
        const container = document.getElementById(isPlaintif ? 'suitPlaintifSearchResults' : 'suitDefendantSearchResults');
        const input = document.getElementById(isPlaintif ? 'suitPlaintifSearch' : 'suitDefendantSearch');
        if (!container) return;

        container.innerHTML = '';
        if (items.length === 0 || !input.value.trim()) return container.style.display = 'none';

        items.slice(0, 10).forEach(item => {
            const div = document.createElement('div');
            div.className = 'search-result-item p-2 border-bottom';
            div.style.cursor = 'pointer';
            div.textContent = item.name;
            div.onclick = () => {
                this.addSuitParty(item, role);
                container.style.display = 'none';
                input.value = '';
            };
            container.appendChild(div);
        });
        container.style.display = 'block';
    }

    addSuitParty(person, role) {
        const list = role === 'plaintif' ? this.suitParties.plaintifs : this.suitParties.defendants;
        if (!list.find(p => p.id === person.id)) {
            list.push(person);
            this.updateSuitPartyUI(role);
        }
    }

    removeSuitParty(personId, role) {
        if (role === 'plaintif') {
            this.suitParties.plaintifs = this.suitParties.plaintifs.filter(p => p.id !== personId);
        } else {
            this.suitParties.defendants = this.suitParties.defendants.filter(p => p.id !== personId);
        }
        this.updateSuitPartyUI(role);
    }

    updateSuitPartyUI(role) {
        const isPlaintif = role === 'plaintif';
        const container = document.getElementById(isPlaintif ? 'selectedSuitPlaintifsDisplay' : 'selectedSuitDefendantsDisplay');
        const list = isPlaintif ? this.suitParties.plaintifs : this.suitParties.defendants;
        if (!container) return;

        // XSS Güvenliği için basit bir escape fonksiyonu (Artık this.uiManager'a bağımlı değil)
        const escapeHtml = (text) => String(text || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));

        if (list.length === 0) {
            container.innerHTML = '<div class="text-muted small text-center mt-2">Kayıt Yok.</div>';
            return;
        }

        container.innerHTML = list.map(p => `
            <div class="d-flex justify-content-between align-items-center p-1 mb-1 border-bottom bg-white">
                <span class="small font-weight-bold text-dark"><i class="fas fa-user mr-2 text-secondary"></i> ${escapeHtml(p.name)}</span>
                <button type="button" class="btn btn-xs text-danger border-0 remove-suit-party-btn" data-id="${p.id}" data-role="${role}">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `).join('');
    }

    getTaskDetails() {
        const raw = this.taskData?.details;
        if (!raw) return {};
        if (typeof raw === 'object') return raw;
        try {
            const parsed = JSON.parse(raw);
            return typeof parsed === 'object' && parsed ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    isPetitionReviewSourceTask() {
        return PETITION_REVIEW_SOURCE_TYPES.has(String(this.taskData?.taskType || this.taskData?.task_type_id || ''));
    }

    getPetitionReviewStatus() {
        return this.getTaskDetails().petition_review_status || null;
    }

    renderPetitionReviewUi() {
        const panel = document.getElementById('petitionReviewStatusPanel');
        const options = document.getElementById('petitionUploadOptions');
        if (!panel) return;

        // Yeni akışta "Bir sonraki yüklenecek dosya dilekçedir" seçeneği kullanılmaz.
        // Belge normal yüklenir; dilekçe ise belge satırındaki Dilekçe kutusundan seçilir.
        if (options) options.style.display = 'none';

        const taskType = String(this.taskData?.taskType || this.taskData?.task_type_id || '');
        if (taskType === PETITION_REVIEW_TASK_TYPE) {
            const details = this.getTaskDetails();
            const sourceId = details.source_task_id || details.parent_task_id || details.relatedTaskId || '';
            const result = details.review_result || 'pending';
            const revisedDoc = details.revised_document || null;
            const reviewNote = details.review_note || '';
            const returnContext = this.returnTarget === 'my-tasks.html' ? 'my-tasks' : 'task-management';
            const sourceLink = sourceId
                ? `<a href="task-update.html?id=${encodeURIComponent(sourceId)}&returnTo=${encodeURIComponent(returnContext)}" target="_blank">#${this.escapeHtml(sourceId)}</a>`
                : '-';

            const fileUploadArea = document.getElementById('fileUploadArea');
            const epatsUploadArea = document.getElementById('epatsFileUploadArea');
            const addAccrualBtn = document.getElementById('addAccrualBtn');
            if (fileUploadArea) fileUploadArea.style.display = 'none';
            if (epatsUploadArea) epatsUploadArea.style.display = 'none';
            if (addAccrualBtn) addAccrualBtn.style.display = 'none';

            if (result === 'approved') {
                panel.className = 'alert alert-success mb-3';
                panel.style.display = 'block';
                panel.innerHTML = `<i class="fas fa-check-circle mr-2"></i><strong>Dilekçe Onaylandı</strong>
                    <div class="small mt-1">Kaynak iş: ${sourceLink}</div>` +
                    (reviewNote ? `<div class="mt-2" style="white-space:pre-wrap;"><strong>Kontrol Notu:</strong> ${this.escapeHtml(reviewNote)}</div>` : '') +
                    (revisedDoc?.url ? `<div class="mt-2"><a href="${this.escapeHtml(revisedDoc.url)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-primary"><i class="fas fa-file-download mr-1"></i>${this.escapeHtml(revisedDoc.name || 'Onaylı Revize Dilekçeyi Aç')}</a></div>` : '');
                return;
            }

            if (result === 'revision_requested') {
                panel.className = 'alert alert-danger mb-3';
                panel.style.display = 'block';
                panel.innerHTML = `<i class="fas fa-edit mr-2"></i><strong>Dilekçede Düzeltme İstendi</strong>
                    <div class="small mt-1">Kaynak iş: ${sourceLink}</div>` +
                    (reviewNote ? `<div class="mt-2" style="white-space:pre-wrap;"><strong>Düzeltme Notu:</strong> ${this.escapeHtml(reviewNote)}</div>` : '');
                return;
            }

            panel.className = 'alert alert-info mb-3';
            panel.style.display = 'block';
            panel.innerHTML = `<div class="d-flex flex-wrap justify-content-between align-items-center">
                    <div class="mr-3 mb-2 mb-md-0">
                        <i class="fas fa-user-check mr-2"></i><strong>Dilekçe Kontrol İşi</strong>
                        <div class="small mt-1">Kaynak iş: ${sourceLink} · Dilekçeyi inceleyip sonucu doğrudan buradan kaydedebilirsiniz.</div>
                    </div>
                    <div class="d-flex flex-wrap">
                        <button type="button" class="btn btn-success btn-sm mr-2" id="petitionReviewApproveBtn">
                            <i class="fas fa-check mr-1"></i>Onayla
                        </button>
                        <button type="button" class="btn btn-danger btn-sm" id="petitionReviewRevisionBtn">
                            <i class="fas fa-edit mr-1"></i>Düzeltme İste / Revize Et
                        </button>
                    </div>
                </div>`;
            return;
        }

        const fileUploadArea = document.getElementById('fileUploadArea');
        const epatsUploadArea = document.getElementById('epatsFileUploadArea');
        const addAccrualBtn = document.getElementById('addAccrualBtn');
        if (fileUploadArea) fileUploadArea.style.display = '';
        if (epatsUploadArea) epatsUploadArea.style.display = '';
        if (addAccrualBtn) addAccrualBtn.style.display = '';

        if (!this.isPetitionReviewSourceTask()) {
            panel.style.display = 'none';
            return;
        }

        const details = this.getTaskDetails();
        const status = details.petition_review_status || null;
        const note = details.petition_review_last_note || '';
        const reviewer = details.petition_review_last_reviewer_name || '';
        const revisedDoc = details.petition_review_revised_document || null;
        const reviewedAt = details.petition_review_last_reviewed_at
            ? new Date(details.petition_review_last_reviewed_at).toLocaleString('tr-TR')
            : '';

        const stateMap = {
            ready: ['alert-primary', 'Kontrole Gönderilebilir', 'fa-paper-plane'],
            in_review: ['alert-warning', 'Dilekçe Kontrolde', 'fa-hourglass-half'],
            approved: ['alert-success', 'Dilekçe Onaylandı', 'fa-check-circle'],
            revision_requested: ['alert-danger', 'Dilekçede Düzeltme İstendi', 'fa-edit']
        };

        if (status && stateMap[status]) {
            const [klass, label, icon] = stateMap[status];
            const noteLabel = status === 'approved' ? 'Kontrol Notu' : 'Düzeltme Notu';
            panel.className = `alert ${klass} mb-3`;
            panel.style.display = 'block';
            panel.innerHTML = `<i class="fas ${icon} mr-2"></i><strong>${label}</strong>` +
                (reviewer || reviewedAt ? `<div class="small mt-1">${reviewer ? `Kontrol eden: ${this.escapeHtml(reviewer)}` : ''}${reviewer && reviewedAt ? ' · ' : ''}${reviewedAt}</div>` : '') +
                (note ? `<div class="mt-2" style="white-space: pre-wrap;"><strong>${noteLabel}:</strong> ${this.escapeHtml(note)}</div>` : '') +
                (revisedDoc?.url
                    ? `<div class="mt-2"><a href="${this.escapeHtml(revisedDoc.url)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-primary">
                           <i class="fas fa-file-download mr-1"></i>${this.escapeHtml(revisedDoc.name || 'Revize Dilekçeyi Aç')}
                       </a></div>`
                    : '');
        } else {
            panel.className = 'alert alert-light border mb-3';
            panel.style.display = 'block';
            panel.innerHTML = '<i class="fas fa-info-circle mr-2 text-primary"></i>Dilekçeyi normal belge olarak yükleyin; ardından belge satırındaki <strong>Dilekçe</strong> kutusunu işaretleyin. Kontrole gönderilecek aktif dilekçe bu şekilde belirlenir.';
        }
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    isWordPetitionDocument(file) {
        if (!file) return false;
        const fileName = String(file.name || '').toLowerCase();
        const validExtension = fileName.endsWith('.doc') || fileName.endsWith('.docx');
        const validMimeTypes = new Set([
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            ''
        ]);
        return validExtension && validMimeTypes.has(String(file.type || '').toLowerCase());
    }

    ensurePetitionReviewRevisionModal() {
        if (document.getElementById('taskUpdatePetitionRevisionModal')) return;
        const modal = document.createElement('div');
        modal.id = 'taskUpdatePetitionRevisionModal';
        modal.className = 'modal fade';
        modal.tabIndex = -1;
        modal.setAttribute('role', 'dialog');
        modal.innerHTML = `
            <div class="modal-dialog modal-xl modal-dialog-centered" role="document" style="max-width:94vw;width:94vw;">
                <div class="modal-content shadow-lg" style="min-height:78vh;">
                    <div class="modal-header">
                        <h5 class="modal-title"><i class="fas fa-edit text-danger mr-2"></i>Dilekçe Kontrol Sonucu</h5>
                        <button type="button" class="close" data-dismiss="modal"><span>&times;</span></button>
                    </div>
                    <div class="modal-body d-flex flex-column">
                        <div class="form-group flex-grow-1 d-flex flex-column">
                            <label class="font-weight-bold" for="taskUpdatePetitionRevisionNote">Kontrol / Düzeltme Notu</label>
                            <textarea id="taskUpdatePetitionRevisionNote" class="form-control flex-grow-1" style="min-height:36vh;resize:vertical;" placeholder="Düzeltilmesi gereken hususları yazınız..."></textarea>
                            <small class="text-muted mt-1">Revize dosya yüklemezseniz düzeltme notu zorunludur ve iş düzeltme için kaynak kullanıcıya döner.</small>
                        </div>
                        <div class="form-group mb-0 border rounded p-3 bg-light">
                            <label class="font-weight-bold mb-2" for="taskUpdatePetitionRevisionFile"><i class="fas fa-file-upload mr-1 text-primary"></i>Revize Dilekçe <span class="text-muted font-weight-normal">(opsiyonel)</span></label>
                            <input type="file" id="taskUpdatePetitionRevisionFile" class="form-control-file" accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
                            <div id="taskUpdatePetitionRevisionFileName" class="small text-muted mt-2">Dosya seçilmedi.</div>
                            <small class="text-danger d-block mt-2">Revize dilekçe yüklerseniz eski dilekçe sistemden kaldırılır; yüklediğiniz belge aktif dilekçe olur ve kontrol <strong>onaylanmış</strong> sayılır.</small>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-dismiss="modal">İptal</button>
                        <button type="button" class="btn btn-danger px-4" id="taskUpdateSavePetitionRevisionBtn"><i class="fas fa-paper-plane mr-1"></i>Düzeltme İste</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(modal);

        const fileInput = document.getElementById('taskUpdatePetitionRevisionFile');
        const nameEl = document.getElementById('taskUpdatePetitionRevisionFileName');
        const saveBtn = document.getElementById('taskUpdateSavePetitionRevisionBtn');
        fileInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0] || null;
            if (file && !this.isWordPetitionDocument(file)) {
                e.target.value = '';
                if (nameEl) nameEl.textContent = 'Dosya seçilmedi.';
                if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i>Düzeltme İste';
                return showNotification('Revize dilekçe yalnızca Word belgesi (.doc veya .docx) olabilir.', 'warning');
            }
            if (nameEl) nameEl.textContent = file ? `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)` : 'Dosya seçilmedi.';
            if (saveBtn) {
                saveBtn.className = file ? 'btn btn-success px-4' : 'btn btn-danger px-4';
                saveBtn.innerHTML = file
                    ? '<i class="fas fa-check mr-1"></i>Revize Dilekçeyi Kaydet ve Onayla'
                    : '<i class="fas fa-paper-plane mr-1"></i>Düzeltme İste';
            }
        });

        saveBtn?.addEventListener('click', async (e) => {
            const note = document.getElementById('taskUpdatePetitionRevisionNote')?.value?.trim() || null;
            const file = document.getElementById('taskUpdatePetitionRevisionFile')?.files?.[0] || null;
            if (!file && !note) return showNotification('Düzeltme notu zorunludur.', 'warning');
            if (file && !this.isWordPetitionDocument(file)) return showNotification('Revize dilekçe yalnızca Word belgesi (.doc veya .docx) olabilir.', 'warning');
            const result = file ? 'approved' : 'revision_requested';
            await this.completePetitionReviewFromDetail(result, note, file, e.currentTarget);
        });
    }

    openPetitionReviewRevisionModal() {
        this.ensurePetitionReviewRevisionModal();
        const note = document.getElementById('taskUpdatePetitionRevisionNote');
        const file = document.getElementById('taskUpdatePetitionRevisionFile');
        const name = document.getElementById('taskUpdatePetitionRevisionFileName');
        const saveBtn = document.getElementById('taskUpdateSavePetitionRevisionBtn');
        if (note) note.value = '';
        if (file) file.value = '';
        if (name) name.textContent = 'Dosya seçilmedi.';
        if (saveBtn) {
            saveBtn.className = 'btn btn-danger px-4';
            saveBtn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i>Düzeltme İste';
        }
        if (window.$) $('#taskUpdatePetitionRevisionModal').modal('show');
    }

    async completePetitionReviewFromDetail(result, note = null, revisedFile = null, button = null) {
        if (this.petitionReviewBusy) return;
        if (result === 'approved' && !revisedFile && !confirm('Dilekçeyi onaylamak istediğinize emin misiniz?')) return;
        if (revisedFile && !confirm('Revize dilekçe mevcut dilekçenin yerini alacak ve dilekçe onaylanmış sayılacak. Devam edilsin mi?')) return;

        this.petitionReviewBusy = true;
        if (button) button.disabled = true;
        let uploadedPath = null;
        let revisedDocument = null;

        try {
            const details = this.getTaskDetails();
            const sourceTaskId = details.source_task_id || details.parent_task_id;
            if (!sourceTaskId) throw new Error('Kaynak iş bağlantısı bulunamadı.');

            if (revisedFile) {
                const documentId = this.generateUUID();
                const cleanFileName = revisedFile.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                uploadedPath = `tasks/${sourceTaskId}/petition-revisions/${documentId}_${cleanFileName}`;
                const uploadResult = await storageService.uploadFile('documents', uploadedPath, revisedFile);
                if (!uploadResult?.success) throw new Error(uploadResult?.error || 'Revize dilekçe yüklenemedi.');
                revisedDocument = {
                    id: documentId,
                    name: revisedFile.name,
                    url: uploadResult.url,
                    storagePath: uploadedPath
                };
            }

            const { data, error } = await supabase.rpc('complete_petition_review', {
                p_review_task_id: String(this.taskId),
                p_result: result,
                p_note: note,
                p_revised_document_id: revisedDocument?.id || null,
                p_revised_document_name: revisedDocument?.name || null,
                p_revised_document_url: revisedDocument?.url || null,
                p_revised_document_storage_path: revisedDocument?.storagePath || null
            });
            if (error) throw error;

            const replacedDocs = Array.isArray(data?.replaced_documents) ? data.replaced_documents : [];
            const oldPaths = [...new Set(replacedDocs.map(d => this.getStoragePathForDocument({ url: d?.url })).filter(Boolean))];
            if (oldPaths.length > 0) {
                const { error: cleanupError } = await supabase.storage.from('documents').remove(oldPaths);
                if (cleanupError) console.warn('Eski dilekçe storage temizliği tamamlanamadı:', cleanupError);
            }

            if (window.$) $('#taskUpdatePetitionRevisionModal').modal('hide');
            if (data?.result === 'approved' && revisedDocument) {
                showNotification('Revize dilekçe kaydedildi, eski dilekçe kaldırıldı ve dilekçe onaylandı.', 'success');
            } else if (data?.result === 'approved') {
                showNotification('Dilekçe onaylandı.', 'success');
            } else {
                showNotification('Düzeltme talebi kaynak işi yapan kullanıcıya iletildi.', 'success');
            }
            await this.refreshTaskData();
        } catch (err) {
            if (uploadedPath) {
                try { await supabase.storage.from('documents').remove([uploadedPath]); } catch (_) {}
            }
            console.error('Dilekçe kontrol sonucu kaydedilemedi:', err);
            showNotification(err.message || 'Dilekçe kontrol sonucu kaydedilemedi.', 'error');
        } finally {
            this.petitionReviewBusy = false;
            if (button && document.body.contains(button)) button.disabled = false;
        }
    }

    async syncPetitionReviewReadiness() {
        if (!this.isPetitionReviewSourceTask()) return;
        const { data, error } = await supabase.rpc('sync_petition_review_readiness', {
            p_source_task_id: String(this.taskId)
        });
        if (error) throw new Error(error.message || 'Dilekçe kontrol durumu güncellenemedi.');
        return data;
    }

    async togglePetitionDocument(documentId, shouldBePetition = null, checkboxEl = null) {
        if (!this.isPetitionReviewSourceTask()) return;
        if (this.getPetitionReviewStatus() === 'in_review') {
            if (checkboxEl) checkboxEl.checked = !checkboxEl.checked;
            return showNotification('Dilekçe şu anda kontrolde. Kontrol sonucu gelmeden dilekçe işareti değiştirilemez.', 'warning');
        }

        const doc = this.currentDocuments.find(d => String(d.id) === String(documentId));
        if (!doc || !doc.url || this.isInheritedDocument(doc)) {
            if (checkboxEl) checkboxEl.checked = !checkboxEl.checked;
            return;
        }

        const newType = shouldBePetition === null
            ? (doc.type === 'petition' ? 'task_document' : 'petition')
            : (shouldBePetition ? 'petition' : 'task_document');
        if (newType === doc.type) return;
        if (checkboxEl) checkboxEl.disabled = true;

        try {
            let obsoleteDocs = [];
            if (newType === 'petition') {
                const details = this.getTaskDetails();
                const history = Array.isArray(details.petition_review_history) ? details.petition_review_history : [];
                const lastReview = history.length ? history[history.length - 1] : null;
                const reviewedUrls = new Set(
                    Array.isArray(lastReview?.reviewed_documents)
                        ? lastReview.reviewed_documents.map(d => String(d?.url || '')).filter(Boolean)
                        : []
                );

                obsoleteDocs = this.getOwnDocuments().filter(d =>
                    String(d.id) !== String(documentId) &&
                    d.url &&
                    (['petition', 'petition_previous'].includes(d.type) || reviewedUrls.has(String(d.url)))
                );

                if (obsoleteDocs.length > 0) {
                    const ok = confirm('Bu belge aktif dilekçe yapılacak. Mevcut/eski dilekçe sürümleri sistemden kaldırılacak. Devam edilsin mi?');
                    if (!ok) {
                        if (checkboxEl) checkboxEl.checked = false;
                        return;
                    }
                }
            }

            const { error } = await supabase
                .from('task_documents')
                .update({ document_type: newType })
                .eq('task_id', String(this.taskId))
                .eq('id', doc.id);
            if (error) throw error;

            const { error: txError } = await supabase
                .from('transaction_documents')
                .update({ document_type: newType })
                .eq('document_url', doc.url);
            if (txError) console.warn('Transaction belge türü güncellenemedi:', txError);

            if (obsoleteDocs.length > 0) {
                const obsoleteUrls = [...new Set(obsoleteDocs.map(d => d.url).filter(Boolean))];
                const { error: deleteDocError } = await supabase
                    .from('task_documents')
                    .delete()
                    .eq('task_id', String(this.taskId))
                    .in('document_url', obsoleteUrls);
                if (deleteDocError) throw deleteDocError;

                const { error: deleteTxError } = await supabase
                    .from('transaction_documents')
                    .delete()
                    .in('document_url', obsoleteUrls);
                if (deleteTxError) console.warn('Eski dilekçe transaction kayıtları temizlenemedi:', deleteTxError);

                const oldPaths = [...new Set(obsoleteDocs.map(d => this.getStoragePathForDocument(d)).filter(Boolean))];
                if (oldPaths.length > 0) {
                    const { error: storageError } = await supabase.storage.from('documents').remove(oldPaths);
                    if (storageError) console.warn('Eski dilekçe storage temizliği tamamlanamadı:', storageError);
                }
            }

            await this.syncPetitionReviewReadiness();
            await this.refreshTaskData();
            showNotification(
                newType === 'petition'
                    ? (obsoleteDocs.length ? 'Yeni aktif dilekçe kaydedildi; eski dilekçe sürümleri kaldırıldı.' : 'Belge aktif dilekçe olarak kaydedildi. İşlerim ekranından kontrole gönderilebilir.')
                    : 'Belgenin dilekçe işareti kaldırıldı.',
                'success'
            );
        } catch (err) {
            console.error('Dilekçe belge türü güncelleme hatası:', err);
            try { await this.refreshTaskData(); } catch (_) {}
            showNotification('Belge türü güncellenemedi: ' + (err.message || err), 'error');
        } finally {
            if (checkboxEl && document.body.contains(checkboxEl)) checkboxEl.disabled = false;
        }
    }

    async uploadDocuments(files) {
        if (!files || !files.length) return;

        const txId = this.taskData.transaction_id || this.taskData.transactionId || this.taskData.details?.transactionId || this.taskData.details?.associated_transaction_id;
        const documentType = 'task_document';
        let successCount = 0;

        for (const file of files) {
            const id = this.generateUUID();
            const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const path = `tasks/${this.taskId}/${id}_${cleanFileName}`;

            try {
                const uploadRes = await storageService.uploadFile('documents', path, file);
                if (!uploadRes.success) throw new Error(uploadRes.error);

                const { error: taskDocError } = await supabase.from('task_documents').insert({
                    id,
                    task_id: String(this.taskId),
                    document_name: file.name,
                    document_url: uploadRes.url,
                    document_type: documentType
                });
                if (taskDocError) throw taskDocError;

                if (txId) {
                    const { error: txDocError } = await supabase.from('transaction_documents').insert({
                        id: this.generateUUID(),
                        transaction_id: String(txId),
                        document_name: file.name,
                        document_url: uploadRes.url,
                        document_type: documentType
                    });
                    if (txDocError) console.warn('Transaction belge kaydı oluşturulamadı:', txDocError);
                }

                this.currentDocuments.push({
                    id,
                    name: file.name,
                    url: uploadRes.url,
                    storagePath: path,
                    size: file.size,
                    type: documentType,
                    uploadedAt: new Date().toISOString()
                });
                successCount++;
            } catch (e) {
                console.error(e);
                showNotification('Dosya yüklenemedi: ' + e.message, 'error');
            }
        }

        this.uiManager.renderDocuments(this.currentDocuments);
        await this.refreshTaskData();
        if (successCount > 0 && this.isPetitionReviewSourceTask() && this.getPetitionReviewStatus() !== 'in_review') {
            showNotification('Dosya yüklendi. Bu belge dilekçeyse belge satırındaki Dilekçe kutusunu işaretleyin.', 'info');
        }
    }

    async removeDocument(id) {
        if (!confirm('Silmek istediğinize emin misiniz?')) return;
        const doc = this.currentDocuments.find(d => String(d.id) === String(id));
        if (!doc) return;

        if (this.isInheritedDocument(doc)) {
            return showNotification('Ana göreve ait belge bu alt iş üzerinden silinemez.', 'warning');
        }

        if (doc.type === 'petition' && this.getPetitionReviewStatus() === 'in_review') {
            return showNotification('Dilekçe şu anda kontrolde. Kontrol sonucu gelmeden bu dilekçe silinemez.', 'warning');
        }

        const wasPetition = doc.type === 'petition';

        try {
            const { error: docDeleteError } = await supabase
                .from('task_documents')
                .delete()
                .eq('id', id)
                .eq('task_id', String(this.taskId));
            if (docDeleteError) throw docDeleteError;

            if (doc.url) {
                const { error: txDeleteError } = await supabase
                    .from('transaction_documents')
                    .delete()
                    .eq('document_url', doc.url);
                if (txDeleteError) console.warn('Transaction belgesi temizlenemedi:', txDeleteError);
            }

            const storagePath = this.getStoragePathForDocument(doc);
            if (storagePath) {
                const { error: storageError } = await supabase.storage.from('documents').remove([storagePath]);
                if (storageError) console.warn('Storage belgesi temizlenemedi:', storageError);
            }
        } catch (e) {
            console.error('Belge silme hatası:', e);
            return showNotification('Belge silinemedi: ' + (e.message || e), 'error');
        }

        this.currentDocuments = this.currentDocuments.filter(d => String(d.id) !== String(id));
        this.uiManager.renderDocuments(this.currentDocuments);

        if (wasPetition) {
            try { await this.syncPetitionReviewReadiness(); } catch (err) { showNotification(err.message, 'error'); }
        }
        await this.refreshTaskData();
    }

    async uploadEpatsDocument(file) {
        if (!file) return;
        
        const existingEpats = this.getOwnedEpatsDocument();
        if (!existingEpats) {
            const statusEl = document.getElementById('taskStatus');
            this.statusBeforeEpatsUpload = statusEl ? statusEl.value : null;
        }

        let extractedEvrakNo = null;
        let extractedDate = null;

        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
            showNotification('PDF taranıyor, evrak bilgileri okunuyor...', 'info');
            try {
                // 🔥 AWAIT KULLANIMI: Okuma bitmeden dosya yüklemesini kesinlikle başlatma!
                const info = await this.extractEpatsInfoFromFile(file);
                
                if (info) {
                    const noInput = document.getElementById('turkpatentEvrakNo');
                    const dateInput = document.getElementById('epatsDocumentDate');
                    let msg = [];
                    
                    if (info.evrakNo && noInput) { 
                        extractedEvrakNo = info.evrakNo;
                        noInput.value = info.evrakNo; 
                        noInput.dispatchEvent(new Event('input', { bubbles: true })); 
                        msg.push('Evrak No'); 
                    }
                    
                    if (info.documentDate && dateInput) {
                        extractedDate = info.documentDate;
                        dateInput.value = info.documentDate;
                        if (dateInput._flatpickr) {
                            dateInput._flatpickr.setDate(info.documentDate, true);
                        } else {
                            dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        msg.push('Tarih');
                    }
                    
                    if (msg.length > 0) {
                        showNotification(`✅ PDF'ten otomatik dolduruldu: ${msg.join(', ')}`, 'success');
                    } else {
                        showNotification(`⚠️ PDF okundu ancak içinde tarih veya numara bulunamadı.`, 'warning');
                    }
                }
            } catch (err) {
                console.error("PDF Veri Çıkarma Hatası:", err);
            }
        }

        const id = this.generateUUID();
        const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const path = `tasks/${this.taskId}/epats_${id}_${cleanFileName}`;
        const txId = this.taskData.transaction_id || this.taskData.transactionId || this.taskData.details?.transactionId || this.taskData.details?.associated_transaction_id;
        
        try {
            showNotification('Evrak sisteme yükleniyor, lütfen bekleyiniz...', 'info');
            const uploadRes = await storageService.uploadFile('documents', path, file);
            if (!uploadRes.success) throw new Error(uploadRes.error);

            await supabase.from('task_documents').insert({
                id: id,
                task_id: String(this.taskId),
                document_name: file.name,
                document_url: uploadRes.url,
                document_type: 'epats_document'
            });

            if (txId) {
                await supabase.from('transaction_documents').insert({
                    id: this.generateUUID(),
                    transaction_id: String(txId),
                    document_name: file.name,
                    document_url: uploadRes.url,
                    document_type: 'epats_document',
                    document_designation: 'Resmi Yazı' 
                });
            }

            const epatsDoc = {
                id,
                isInherited: false,
                sourceTaskId: String(this.taskId), 
                name: file.name,
                url: uploadRes.url, 
                downloadURL: uploadRes.url, 
                storagePath: path, 
                size: file.size,
                uploadedAt: new Date().toISOString(), 
                type: 'epats_document',
                turkpatentEvrakNo: extractedEvrakNo, 
                documentDate: extractedDate          
            };

            // Yalnız bu işe ait eski EPATS kaydını local state'ten çıkar;
            // parent task'tan gelen salt-okunur EPATS belgeleri korunur.
            this.currentDocuments = this.currentDocuments.filter(d =>
                !(d.type === 'epats_document' && !this.isInheritedDocument(d))
            );
            this.currentDocuments.push(epatsDoc);

            this.epatsAddedThisSession = true;
            this.epatsRemovedPendingSave = false;
            this.epatsRestoreStatus = null;
            this.epatsAutoCompleted = true;
            this.epatsLifecycleKnown = true;

            this.uiManager.renderDocuments(this.currentDocuments);

            const taskType = String(this.taskData.taskType || this.taskData.task_type_id);
            const statusSelect = document.getElementById('taskStatus');

            if (statusSelect) {
                statusSelect.value = 'completed';
                statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }

            if (taskType === '49') {
                showNotification('Dava dilekçesi / tevzi formu yüklendi. İş durumu Tamamlandı olarak ayarlandı.', 'success');
            } else {
                showNotification('EPATS evrakı başarıyla yüklendi.', 'success');
            }

            if (taskType === '22') this.handleRenewalLogic();
            if (this.isApplicationTask(taskType) && typeof $ !== 'undefined') {
                this.uiManager.ensureApplicationDataModal();
                setTimeout(() => $('#applicationDataModal').modal({ backdrop: 'static', keyboard: false, show: true }), 100);
            }
        } catch (e) {
            showNotification('Dosya yüklenirken hata oluştu: ' + e.message, 'error');
        }
    }
    
    async removeEpatsDocument() {
        if (this.epatsRemovalInProgress) return;
        if (!confirm('EPATS evrakı silinecek. Emin misiniz?')) return;

        const epatsDoc = this.getOwnedEpatsDocument();
        if (!epatsDoc) {
            const inheritedEpats = (this.currentDocuments || []).find(d =>
                d?.type === 'epats_document' && this.isInheritedDocument(d)
            );
            return showNotification(
                inheritedEpats
                    ? 'Görünen EPATS evrakı ana göreve aittir; bu alt iş üzerinden silinemez.'
                    : 'Bu işe ait silinebilir bir EPATS evrakı bulunamadı.',
                'warning'
            );
        }

        const statusSelect = document.getElementById('taskStatus');
        const currentStatus = statusSelect?.value || this.taskData?.status || 'open';
        let restoreStatus;

        if (this.epatsAutoCompleted) {
            restoreStatus = this.statusBeforeEpatsUpload || 'open';
        } else if (this.epatsLifecycleKnown) {
            // EPATS varken statü kullanıcı tarafından ayrıca değiştirilmişse mevcut statüyü koru.
            restoreStatus = currentStatus || 'open';
        } else {
            // Eski kayıtlar için lifecycle bilgisi yoktur. Completed + EPATS kombinasyonunda
            // geçmiş davranışla uyumlu güvenli fallback OPEN'dır.
            restoreStatus = currentStatus === 'completed' ? 'open' : (currentStatus || 'open');
        }

        // Yarış durumunu kapat: UI/state değişimini DB/storage await'lerinden ÖNCE yap.
        this.epatsRemovalInProgress = true;
        this.epatsRemovedPendingSave = true;
        this.epatsRestoreStatus = restoreStatus;
        this.epatsAddedThisSession = false;
        this.currentDocuments = this.currentDocuments.filter(d => String(d.id) !== String(epatsDoc.id));

        if (statusSelect) {
            statusSelect.value = restoreStatus;
            statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        this.uiManager.renderDocuments(this.currentDocuments);
        this.setSaveButtonBusy(true, 'EPATS evrakı siliniyor; işlem bitince kaydedebilirsiniz.');

        try {
            // DB satırı storagePath var/yok bağımsız olarak mutlaka silinir.
            const { error: docDeleteError } = await supabase
                .from('task_documents')
                .delete()
                .eq('id', epatsDoc.id)
                .eq('task_id', String(this.taskId));
            if (docDeleteError) throw docDeleteError;

            if (epatsDoc.url) {
                const { error: txDeleteError } = await supabase
                    .from('transaction_documents')
                    .delete()
                    .eq('document_url', epatsDoc.url);
                if (txDeleteError) console.warn('EPATS transaction belgesi temizlenemedi:', txDeleteError);
            }

            const storagePath = this.getStoragePathForDocument(epatsDoc);
            if (storagePath) {
                const { error: storageError } = await supabase.storage.from('documents').remove([storagePath]);
                if (storageError) console.warn('EPATS storage temizliği tamamlanamadı:', storageError);
            }

            showNotification(`EPATS evrakı kaldırıldı. İş durumu ${restoreStatus} olarak kaydedilecek.`, 'info');
        } catch (e) {
            console.error('EPATS silme hatası:', e);
            this.epatsRemovedPendingSave = false;
            this.epatsRestoreStatus = null;
            try { await this.refreshTaskData(); } catch (_) {}
            showNotification('EPATS evrakı silinemedi: ' + (e.message || e), 'error');
        } finally {
            this.epatsRemovalInProgress = false;
            this.setSaveButtonBusy(false);
        }
    }

    isApplicationTask(taskType) { return ['2'].includes(String(taskType)); }

    // GÜVENLİ TAHAKKUK EVENTLERİ (Null Hatası Önlemleri ile)
    setupAccrualModal() {
        this.accrualManager = new AccrualFormManager('accrualFormContainer', 'taskUpdate', this.masterData.persons);
        this.accrualManager.render();
        
        const btnAdd = document.getElementById('addAccrualBtn');
        if (btnAdd) {
            btnAdd.onclick = (e) => {
                e.preventDefault();
                this.openAccrualModal(); 
            };
        }

        const accContainer = document.getElementById('accrualsContainer');
        if (accContainer) {
            accContainer.addEventListener('click', (e) => {
                if (e.target.classList.contains('edit-accrual-btn')) {
                    e.preventDefault();
                    const accId = e.target.dataset.id;
                    this.openAccrualModal(accId);
                }
            });
        }

        const btnSave = document.getElementById('saveAccrualBtn');
        if (btnSave) {
            btnSave.onclick = async () => {
                const result = this.accrualManager.getData();
                if (result.success) {
                    const data = result.data;
                    
                    let targetTaskId = this.taskId;
                    let targetTaskTitle = this.taskData.title;

                    let detailsObj = {};
                    if (this.taskData.details) {
                        if (typeof this.taskData.details === 'string') {
                            try { detailsObj = JSON.parse(this.taskData.details); } catch(e) {}
                        } else {
                            detailsObj = this.taskData.details;
                        }
                    }

                    const taskTypeStr = String(this.taskData.taskType || this.taskData.task_type_id);

                    if (taskTypeStr === '53' || (this.taskData.title || '').toLowerCase().includes('tahakkuk')) {
                        const parentId = detailsObj.relatedTaskId || this.taskData.relatedTaskId || detailsObj.parent_task_id;
                        if (parentId) {
                            targetTaskId = String(parentId);
                            try {
                                const { data: pTask } = await supabase.from('tasks').select('title').eq('id', targetTaskId).single();
                                if (pTask) targetTaskTitle = pTask.title;
                            } catch(e) {}
                        }
                    }

                    data.taskId = targetTaskId;
                    data.taskTitle = targetTaskTitle;
                    
                    const modalEl = document.getElementById('accrualModal');
                    const editingId = modalEl?.dataset?.editingId;
                    if (editingId) data.id = editingId;

                    try {
                        await this.dataManager.saveAccrual(data, !!editingId);
                        if(window.$) $('#accrualModal').modal('hide');
                        showNotification(`Tahakkuk başarıyla oluşturuldu! (Bağlı İş: #${targetTaskId})`, 'success');
                        
                        if (taskTypeStr === '53') {
                            const statusSelect = document.getElementById('taskStatus');
                            if(statusSelect && statusSelect.value !== 'completed') {
                                statusSelect.value = 'completed';
                                showNotification('Tahakkuk görevi otomatik olarak Tamamlandı yapıldı.', 'info');
                                this.saveTaskChanges(); 
                            }
                        } else {
                            this.renderAccruals();
                        }
                    } catch (error) {
                        alert('Kaydetme hatası: ' + error.message);
                    }
                } else {
                    alert(result.error);
                }
            };
        }
    }

    async renderAccruals() {
        const details = this.taskData.details || {};
        const targetTaskId = details.parent_task_id || details.parentTaskId || details.triggering_task_id || details.relatedTaskId || this.taskId;

        const accruals = await this.dataManager.getAccrualsByTaskId(targetTaskId);
        if (String(targetTaskId) !== String(this.taskId)) {
            const localAccruals = await this.dataManager.getAccrualsByTaskId(this.taskId);
            accruals.push(...localAccruals);
        }

        const container = document.getElementById('accrualsContainer');
        if (!container) return;
         
        if (!accruals || accruals.length === 0) {
            container.innerHTML = `<div class="text-center p-3 text-muted border rounded bg-light"><i class="fas fa-receipt mr-2"></i>Kayıt bulunamadı.</div>`;
            return;
        }

        container.innerHTML = `
            <div class="row w-100 m-0">
                ${accruals.map(a => {
                    const amountStr = this.formatCurrency(a.totalAmount || a.total_amount);
                    let statusColor = '#f39c12'; 
                    let statusText = 'Ödenmedi';
                    if(a.status === 'paid') { statusColor = '#27ae60'; statusText = 'Ödendi'; }
                    else if(a.status === 'cancelled') { statusColor = '#95a5a6'; statusText = 'İptal'; }

                    return `
                    <div class="col-12 mb-3 px-0">
                        <div class="card shadow-sm border-light w-100 h-100">
                            <div class="card-body">
                                <div class="d-flex justify-content-between align-items-center mb-3">
                                    <h5 class="mb-0 font-weight-bold text-dark">${amountStr}</h5>
                                    <span class="badge badge-pill text-white" style="background-color: ${statusColor}; font-size: 0.8rem;">${statusText}</span>
                                </div>
                                <div class="text-right">
                                    <button class="btn btn-sm btn-outline-primary edit-accrual-btn" data-id="${a.id}">
                                        <i class="fas fa-pen mr-1"></i>Düzenle
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>`;
                }).join('')}
            </div>`;
    }

    openAccrualModal(accId = null) {
        const modalEl = document.getElementById('accrualModal');
        if (!modalEl) return;
        
        this.accrualManager.render(); 
        if (accId) {
            modalEl.dataset.editingId = accId;
            const titleEl = document.querySelector('#accrualModal .modal-title');
            if(titleEl) titleEl.textContent = 'Tahakkuk Düzenle';
            
            this.dataManager.getAccrualsByTaskId(this.taskId).then(accruals => {
                const acc = accruals.find(a => a.id === accId);
                if (acc) {
                    // 🔥 OTOMASYON 1: Düzenlenen tahakkukun faturası kesilecek kişisi (Müvekkili) BOŞSA, işin sahibini otomatik ata!
                    if (!acc.tpInvoiceParty || !acc.tpInvoiceParty.id) {
                        if (this.selectedPersonId && this.masterData.persons) {
                            const foundPerson = this.masterData.persons.find(p => String(p.id) === String(this.selectedPersonId));
                            if (foundPerson) {
                                console.log("[OTOMASYON] Boş olan tahakkuk müvekkili işin sahibine göre dolduruldu:", foundPerson.name);
                                acc.tpInvoiceParty = foundPerson;
                            }
                        }
                    }
                    this.accrualManager.setData(acc);
                }
            });
        } else {
            delete modalEl.dataset.editingId;
            const titleEl = document.querySelector('#accrualModal .modal-title');
            if(titleEl) titleEl.textContent = 'Yeni Tahakkuk Ekle';

            // 🔥 OTOMASYON 2: YENİ (sıfırdan) tahakkuk ekleniyorsa işin sahibini formda otomatik olarak seçili hale getir!
            if (this.selectedPersonId && this.masterData.persons) {
                const foundPerson = this.masterData.persons.find(p => String(p.id) === String(this.selectedPersonId));
                if (foundPerson) {
                    console.log("[OTOMASYON] Yeni tahakkuk formu işin sahibine göre dolduruldu:", foundPerson.name);
                    
                    // Modalı render ettikten hemen sonra ufak bir gecikme ile arayüzü dolduruyoruz (Select2 vb. kütüphanelerin hazır olması için)
                    setTimeout(() => {
                        this.accrualManager.selectedTpParty = foundPerson;
                        this.accrualManager.manualSelectDisplay('taskUpdateTpInvoiceParty', foundPerson);
                        this.accrualManager.checkSasRequirement(foundPerson);
                        this.accrualManager.calculateTotal();
                    }, 50);
                }
            }
        }
        if (window.$) $('#accrualModal').modal('show');
    }

    formatCurrency(amountData) {
        if (!amountData) return '0 TRY';
        if (Array.isArray(amountData)) {
            if (amountData.length === 0) return '0 TRY';
            return amountData.map(x => `${x.amount || 0} ${x.currency || 'TRY'}`).join(' + ');
        }
        if (typeof amountData === 'object') {
            return `${amountData.amount || 0} ${amountData.currency || 'TRY'}`;
        }
        return `${amountData} TRY`;
    }

    async saveTaskChanges() {
        if (this.epatsRemovalInProgress) {
            return showNotification('EPATS evrakı silme işlemi henüz tamamlanmadı. İşlem tamamlandıktan sonra kaydedin.', 'warning');
        }

        const taskTypeStr = String(this.taskData.taskType || this.taskData.task_type_id);
        const statusSelect = document.getElementById('taskStatus');
        const isYidkSuitTask = taskTypeStr === '49';
        const ownedEpatsDoc = this.getOwnedEpatsDocument();

        let finalStatus = statusSelect?.value || this.taskData.status || 'open';
        if (this.epatsRemovedPendingSave) {
            finalStatus = this.epatsRestoreStatus || this.statusBeforeEpatsUpload || 'open';
        } else if (this.epatsAddedThisSession) {
            finalStatus = 'completed';
        }
        if (statusSelect) statusSelect.value = finalStatus;

        let epatsDocumentDateForDB = null;
        let epatsDocumentNoForDB = null;

        // YİDK iptal davasında bu alan EPATS evrakı değil, dava dilekçesi / tevzi formudur.
        if (ownedEpatsDoc && !isYidkSuitTask) {
            const evrakNo = document.getElementById('turkpatentEvrakNo')?.value;
            const evrakDate = document.getElementById('epatsDocumentDate')?.value;

            if (!evrakNo || !evrakDate) {
                return showNotification('Lütfen EPATS evrak bilgilerini (No ve Tarih) doldurunuz.', 'warning');
            }

            ownedEpatsDoc.turkpatentEvrakNo = evrakNo;
            ownedEpatsDoc.documentDate = evrakDate;
            epatsDocumentDateForDB = evrakDate;
            epatsDocumentNoForDB = evrakNo;
        }

        if (taskTypeStr === '49' && finalStatus === 'completed') {
            const courtName = document.getElementById('suitCourtName')?.value;
            const fileNo = document.getElementById('suitFileNo')?.value;
            const openingDate = document.getElementById('suitOpeningDate')?.value;
            const plaintifs = this.suitParties.plaintifs;
            const defendants = this.suitParties.defendants;

            if (!courtName || !fileNo || !openingDate || plaintifs.length === 0 || defendants.length === 0) {
                return showNotification('Lütfen Dava Açılış Bilgilerini (Mahkeme, Esas No, Dava Tarihi, Müvekkil ve Karşı Taraf) eksiksiz doldurunuz.', 'warning');
            }
            if (!ownedEpatsDoc) {
                return showNotification('Dava Dilekçesi ve Tevzi Formu (Evrak) yüklenmesi zorunludur.', 'warning');
            }

            const formattedPlaintiffs = plaintifs.map(p => ({ ...p, role: 'davaci' }));
            const formattedDefendants = defendants.map(p => ({ ...p, role: 'davali' }));
            const combinedParties = [...formattedPlaintiffs, ...formattedDefendants];

            const suitPayload = {
                ip_record_id: this.selectedIpRecordId,
                client_id: !String(plaintifs[0]?.id).startsWith('free_text') ? plaintifs[0]?.id : null,
                task_id: this.taskId,
                transaction_type_id: taskTypeStr,
                suit_type: 'YİDK Kararı İptali',
                court_name: courtName,
                file_no: fileNo,
                title: 'YİDK Kararı İptal Davası',
                status: 'continue',
                opening_date: openingDate,
                suitParties: combinedParties
            };

            const suitRes = await this.dataManager.saveSuitRecord(suitPayload);
            if (!suitRes.success) {
                return showNotification('Dava dosyası açılamadı: ' + suitRes.error, 'error');
            }

            await this.dataManager.logTransaction({
                ip_record_id: this.selectedIpRecordId,
                task_id: this.taskId,
                transaction_type_id: taskTypeStr,
                description: `YİDK Kararı İptali davası açıldı. Mahkeme: ${courtName}, Esas No: ${fileNo}`,
                user_id: (await authService.getCurrentSession())?.user?.id,
                transaction_date: new Date().toISOString()
            });

            if (suitRes.data?.id) {
                await supabase.from('suit_documents').insert({
                    suit_id: suitRes.data.id,
                    document_name: ownedEpatsDoc.name,
                    document_url: ownedEpatsDoc.url,
                    document_type: 'dava_dilekcesi'
                });
            }
        }

        // En güncel DB details/status değerini al. EPATS lifecycle metadata'sı buraya merge edilir.
        let dbTask = null;
        try {
            const { data, error } = await supabase
                .from('tasks')
                .select('status, details')
                .eq('id', String(this.taskId))
                .single();
            if (error) throw error;
            dbTask = data;
        } catch (err) {
            console.error('Görev lifecycle bilgisi okunamadı:', err);
            return showNotification('Görev kaydedilemedi: mevcut durum bilgisi okunamadı.', 'error');
        }

        let currentDetails = {};
        if (dbTask?.details) {
            if (typeof dbTask.details === 'string') {
                try { currentDetails = JSON.parse(dbTask.details); } catch (_) { currentDetails = {}; }
                if (typeof currentDetails === 'string') {
                    try { currentDetails = JSON.parse(currentDetails); } catch (_) { currentDetails = {}; }
                }
            } else if (typeof dbTask.details === 'object') {
                currentDetails = { ...dbTask.details };
            }
        }

        let detailsChanged = false;

        if (this.epatsRemovedPendingSave) {
            // Evrak yoksa eski EPATS metadata'sı da kalmamalı.
            delete currentDetails.epatsDocumentDate;
            delete currentDetails.epatsDocumentNo;
            delete currentDetails.epatsDocument;
            delete currentDetails.status_before_epats_upload;
            delete currentDetails.completed_by_epats;
            detailsChanged = true;
        } else if (ownedEpatsDoc) {
            if (!isYidkSuitTask) {
                currentDetails.epatsDocumentDate = epatsDocumentDateForDB;
                currentDetails.epatsDocumentNo = epatsDocumentNoForDB;
                detailsChanged = true;
            }

            if (this.epatsAddedThisSession) {
                // DB status bu aşamada yükleme öncesi status'tur; local değer yoksa güvenli kaynak odur.
                const previousStatus = this.statusBeforeEpatsUpload ||
                    currentDetails.status_before_epats_upload ||
                    dbTask?.status ||
                    'open';
                currentDetails.status_before_epats_upload = previousStatus;
                currentDetails.completed_by_epats = true;
                this.statusBeforeEpatsUpload = previousStatus;
                this.epatsAutoCompleted = true;
                this.epatsLifecycleKnown = true;
                detailsChanged = true;
            } else if (currentDetails.completed_by_epats === true && finalStatus !== 'completed') {
                // Kullanıcı EPATS dururken statüyü manuel değiştirdiyse artık EPATS'ın otomatik completion'ı sayılmaz.
                currentDetails.completed_by_epats = false;
                delete currentDetails.status_before_epats_upload;
                this.epatsAutoCompleted = false;
                this.epatsLifecycleKnown = true;
                detailsChanged = true;
            }
        }

        if (detailsChanged) {
            const { error: detailsError } = await supabase
                .from('tasks')
                .update({ details: currentDetails })
                .eq('id', String(this.taskId));
            if (detailsError) {
                console.error('EPATS lifecycle metadata kaydı başarısız:', detailsError);
                return showNotification('EPATS durum bilgileri kaydedilemedi: ' + detailsError.message, 'error');
            }
        }

        try {
            if (this.selectedIpRecordId && this.tempRenewalData) {
                await supabase.from('ip_records').update({ renewal_date: this.tempRenewalData }).eq('id', this.selectedIpRecordId);
            }
            if (this.selectedIpRecordId && this.tempApplicationData) {
                await supabase.from('ip_records').update({
                    application_number: this.tempApplicationData.appNo,
                    application_date: this.tempApplicationData.appDate
                }).eq('id', this.selectedIpRecordId);
            }
        } catch (err) {
            console.error('Bağlı kayıtlar güncellenirken hata oluştu:', err);
        }

        let userEmail = 'Bilinmiyor';
        try {
            const session = await authService.getCurrentSession();
            if (session) {
                const { data: profile } = await supabase.from('users').select('email').eq('id', session.user.id).single();
                userEmail = profile?.email || session.user.email;
            }
        } catch (_) {}

        const history = this.taskData.history ? [...this.taskData.history] : [];
        history.push({
            action: 'Görev güncellendi',
            timestamp: new Date().toISOString(),
            userEmail
        });

        const officialDateVal = document.getElementById('taskDueDate')?.value;
        const operationalDateVal = document.getElementById('deliveryDate')?.value;

        const updateData = {
            status: finalStatus,
            title: document.getElementById('taskTitle')?.value,
            description: document.getElementById('taskDescription')?.value,
            priority: document.getElementById('taskPriority')?.value,
            relatedIpRecordId: this.selectedIpRecordId,
            relatedPartyId: this.selectedPersonId,
            // Belgeler upload/silme/dilekçe seçimi sırasında doğrudan task_documents'a yazılır.
            // Normal görev kaydı belge tablosunu silip yeniden oluşturmamalıdır.
            documents: undefined,
            history,
            officialDueDate: officialDateVal ? new Date(officialDateVal).toISOString() : null,
            dueDate: operationalDateVal ? new Date(operationalDateVal).toISOString() : null,
            operationalDueDate: operationalDateVal ? new Date(operationalDateVal).toISOString() : null
        };

        const res = await this.dataManager.updateTask(this.taskId, updateData);
        if (!res.success) {
            return showNotification('Hata: ' + res.error, 'error');
        }

        // DB'nin nihai değerini doğrula. Böylece trigger/yarış kaynaklı sessiz status sapmaları görünür olur.
        const { data: verifiedTask, error: verifyError } = await supabase
            .from('tasks')
            .select('status, details')
            .eq('id', String(this.taskId))
            .single();

        if (verifyError) {
            console.error('Kaydetme doğrulama hatası:', verifyError);
            return showNotification('Görev kaydedildi ancak son durum doğrulanamadı. Lütfen sayfayı yenileyip kontrol edin.', 'warning');
        }

        if (verifiedTask?.status !== finalStatus) {
            console.error('[EPATS STATUS VERIFY] İstenen / DB:', finalStatus, verifiedTask?.status);
            return showNotification(
                `Durum kaydı doğrulanamadı. İstenen: ${finalStatus}, veritabanındaki: ${verifiedTask?.status || '-'}. Sayfadan ayrılmadan kontrol edin.`,
                'error'
            );
        }

        const { data: epatsRows, error: epatsVerifyError } = await supabase
            .from('task_documents')
            .select('id')
            .eq('task_id', String(this.taskId))
            .eq('document_type', 'epats_document');

        if (epatsVerifyError) {
            console.warn('EPATS belge doğrulaması yapılamadı:', epatsVerifyError);
        } else if (this.epatsRemovedPendingSave && (epatsRows || []).length > 0) {
            return showNotification('EPATS evrakı silme işlemi doğrulanamadı; görevden ayrılmadan tekrar kontrol edin.', 'error');
        } else if (ownedEpatsDoc && (epatsRows || []).length === 0) {
            return showNotification('EPATS evrak kaydı doğrulanamadı; görevden ayrılmadan tekrar kontrol edin.', 'error');
        }

        showNotification('Değişiklikler başarıyla kaydedildi.', 'success');
        localStorage.setItem('crossTabUpdatedTaskId', this.taskId);
        setTimeout(() => { window.location.href = this.returnTarget; }, 1000);
    }

    async generateAndDownloadWord(geminiItirazMetni, payload) {
        try {
            console.log("Word şablonu indiriliyor...");
            
            const templateUrl = 'https://kadxvkejzctwymzeyrrl.supabase.co/storage/v1/object/public/templates/yayina%20itiraz%20dilekce%20taslagi.docx';
            
            const response = await fetch(templateUrl);
            if (!response.ok) throw new Error("Şablon dosyası bulunamadı. URL'yi kontrol edin.");
            
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();

            const zip = new PizZip(arrayBuffer);
            const doc = new Docxtemplater(zip, {
                paragraphLoop: true,
                linebreaks: true,
            });

            // Şablondaki {etiketleri} güncel payload ile eşleştiriyoruz
            doc.render({
                itiraz_eden: payload.clientName || "Müvekkil",
                vekil_ad_soyad: "Evreka Group Danışmanlık", 
                basvuru_sahibi: payload.opponentName || "Karşı Taraf",
                basvuru_no: payload.opponentAppNo || "Belirtilmemiş",
                itiraz_edilen_marka: payload.opponentMark || "Belirtilmemiş",
                bulten_bilgisi: payload.bultenBilgisi || "İlgili Bülten", 
                itiraz_metni: geminiItirazMetni,
                tarih: new Date().toLocaleDateString('tr-TR')
            });

            const out = doc.getZip().generate({
                type: 'blob',
                mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            });
            
            const fileName = payload.opponentAppNo && payload.opponentAppNo !== "Belirtilmemiş" 
                ? `${payload.opponentAppNo}_Itiraz_Dilekcesi.docx` 
                : 'Itiraz_Dilekcesi.docx';
                
            saveAs(out, fileName);
            
            showNotification('Word belgesi başarıyla oluşturuldu ve indirildi!', 'success');
        } catch (error) {
            console.error("Word oluşturulurken hata:", error);
            showNotification('Word dosyası oluşturulurken bir hata oluştu.', 'error');
        }
    }

    // ✨ ADIM 3: FRONTEND (main.js) GÜNCELLEMESİ (Yeni Mimariye Uygun)
    setupAIPetitionEvent() {
        const aiBtn = document.getElementById('ai-petition-btn');
        if (aiBtn) {
            aiBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                
                if (!this.taskData) return;
                const details = this.taskData.details || {};

                // 1. BAŞLIKTAN RAKİP MARKAYI VE AÇIKLAMADAN MÜSTENİT MARKAYI ÇIKARMA
                let extractedOpponentMark = 'Belirtilmemiş';
                if (this.taskData.title && this.taskData.title.includes('Yayına İtiraz:')) {
                    const match = this.taskData.title.match(/Yayına İtiraz:\s*(.*?)\s*\(/);
                    extractedOpponentMark = match && match[1] ? match[1].trim() : this.taskData.title.split('Yayına İtiraz:')[1].trim();
                }

                const clientMarkText = this.taskData.iprecordTitle || details.brand_name || 
                    (this.taskData.description && this.taskData.description.includes('markamız için') 
                        ? this.taskData.description.split(' markamız')[0].replace(/"/g, '') 
                        : 'Müstenit Marka');

                // 2. SINIFLARI DÜZENLEME (Emtia listesi dizisine çevirme)
                // Not: İleride tam emtia metinlerini veritabanından çekmeniz analiz kalitesini zirveye taşıyacaktır.
                // Şimdilik sistemin hata vermemesi için numaraları diziye çeviriyoruz.
                const rawClasses = details.target_nice_classes || details.classes || 'Belirtilmemiş';
                const classArray = rawClasses.split(',').map(c => `${c.trim()}. Sınıf kapsamındaki mal ve hizmetler`);

                // 3. YENİ MİMARİ PAYLOAD (Edge Function'ın beklediği katı format)
                const payload = {
                    clientName: this.taskData.iprecordApplicantName || details.applicant_name || 'Müvekkil',
                    
                    clientMarks: [{
                        markText: clientMarkText,
                        markType: "word", 
                        goodsServices: classArray, 
                    }],

                    opponentApplication: {
                        markText: extractedOpponentMark,
                        applicationNo: details.target_app_no || details.opponent_app_no || 'Belirtilmemiş',
                        markType: "word",
                        goodsServices: classArray 
                    },
                    
                    selectedGrounds: ["SMK_6_1"]
                };

                this.uiManager.setAILoadingState(true);

                try {
                    // YENİ 4 AŞAMALI EDGE FUNCTION'A JWT(Token) İLE GÜVENLİ İSTEK
                    const session = await supabase.auth.getSession();
                    const token = session.data.session?.access_token;

                    const response = await fetch('https://kadxvkejzctwymzeyrrl.supabase.co/functions/v1/generate-petition', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(payload)
                    });

                    const result = await response.json();

                    // DURUM 1: EKSİK VERİ (Dosya Yeterlilik Kontrolüne Takıldı - 422 Hatası)
                    if (response.status === 422 && result.status === "needs_input") {
                        const eksikler = result.missingCriticalFacts.map(e => `<li>${e}</li>`).join('');
                        showNotification(`Eksik Veri! Dilekçe yazılamıyor:<br><ul class="text-left mb-0 pl-3">${eksikler}</ul>`, 'error');
                        this.uiManager.setAILoadingState(false);
                        return;
                    }

                    // DURUM 2: HUKUKİ ANALİZ OLUMSUZ (Dosya reddedildi - 200 ama needs_input)
                    if (response.status === 200 && result.status === "needs_input") {
                        showNotification(`Yapay Zeka bu dosya verileriyle itiraz yazmayı reddetti! Lütfen konsolu inceleyin.`, 'warning');
                        console.warn("Hukuki Analiz Red Gerekçesi:", result.analysis);
                        this.uiManager.setAILoadingState(false);
                        return;
                    }

                    if (!response.ok) throw new Error(result.error || "Sunucu hatası.");

                    // DURUM 3: BAŞARI (Dilekçe Üretildi ve Denetlendi)
                    if (result.petition) {
                        this.uiManager.setAIPetitionText(result.petition);
                        
                        // İçgörüleri (Insights) konsola yazdırıyoruz. (İleride bunları UI'da gösterebilirsiniz)
                        console.log("✅ Başarılı Hukuki Analiz Raporu:", result.analysis);
                        if (result.status === "completed_with_corrections") {
                            console.warn("🛠️ Düzeltilen Halüsinasyonlar / Denetim Raporu:", result.auditIssues);
                        }

                        // Word şablonu için verileri eski "Düz" formata getirip metoda gönderiyoruz
                        const wordPayload = {
                            clientName: payload.clientName,
                            opponentName: details.opposed_mark_owner || 'Karşı Taraf',
                            opponentMark: payload.opponentApplication.markText,
                            opponentAppNo: payload.opponentApplication.applicationNo,
                            bultenBilgisi: details.bulletin_date ? `${new Date(details.bulletin_date).toLocaleDateString('tr-TR')} tarihli ve ${details.bulletin_no} sayılı` : "İlgili Bülten"
                        };

                        await this.generateAndDownloadWord(result.petition, wordPayload);
                    }

                } catch (error) {
                    showNotification('Sistem Hatası: ' + error.message, 'error');
                } finally {
                    this.uiManager.setAILoadingState(false);
                }
            });
        }
    }
}

new TaskUpdateController().init();
