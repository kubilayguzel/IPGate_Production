import { RELATED_PARTY_REQUIRED, TASK_IDS, asId } from './TaskConstants.js';
// ✅ EKLENDİ: Sınıf verisini doğrudan çeken fonksiyonu import ediyoruz
import { getSelectedNiceClasses } from '../nice-classification.js';

export class TaskValidator {
    constructor() {
        this.saveBtn = document.getElementById('saveTaskBtn');
    }

    checkCompleteness(state) {
        // Butonu her seferinde taze seçelim
        this.saveBtn = document.getElementById('saveTaskBtn');
        if (!this.saveBtn) return;

        // state içinden selectedOwners'ı da alıyoruz
        const { selectedTaskType, selectedOwners } = state || {};
        const isPortfolioManagerAssignment = state?.assignmentRule?.assignmentType === 'portfolio_manager';
        
        // Marka Başvurusu olup olmadığını anla
        const brandInputExists = !!document.getElementById('brandExampleText');
        const isTrademarkApp = (selectedTaskType?.alias === 'Başvuru' && selectedTaskType?.ipType === 'trademark') || brandInputExists;

        let isComplete = false;
        let checks = {}; // Konsol raporu için

            // --- SENARYO 1: MARKA BAŞVURUSU ---
            if (isTrademarkApp) {
                
                // 1. Marka Adı
                const brandText = document.getElementById('brandExampleText')?.value?.trim();
            
                // 2. Sınıf Seçimi (GÜNCELLENDİ)
                // DOM saymak yerine doğrudan veriyi kontrol ediyoruz
                let hasClasses = false;
                try {
                    const classes = getSelectedNiceClasses ? getSelectedNiceClasses() : [];
                    hasClasses = Array.isArray(classes) && classes.length > 0;
                } catch (e) {
                    console.warn("Sınıf kontrol hatası:", e);
                    // Fallback: DOM kontrolü (Daha geniş kapsamlı)
                    const container = document.getElementById('selectedNiceClasses');
                    hasClasses = container && container.children.length > 0 && !container.querySelector('.empty-state');
                }
                
                // 3. Başvuru Sahibi
                const applicantContainer = document.getElementById('selectedApplicantsList');
                const domApplicantCount = applicantContainer 
                    ? applicantContainer.querySelectorAll('.selected-item, .search-result-item, .list-group-item').length 
                    : 0;
                
                // 4. Menşe/Ülke Kontrolü
                const originType = document.getElementById('originSelect')?.value;
                let hasCountrySelection = true;
                
                if (originType === 'Yurtdışı Ulusal' || originType === 'FOREIGN_NATIONAL') {
                    hasCountrySelection = !!document.getElementById('countrySelect')?.value;
                } 
                else if (['WIPO', 'ARIPO'].includes(originType)) {
                    // 🔥 ÇÖZÜM 1: Yeni arayüzdeki ülke listesini (State veya DOM üzerinden) kontrol et
                    const hasStateCountries = state && state.selectedCountries && state.selectedCountries.length > 0;
                    const domList = document.getElementById('selectedCountriesList');
                    const hasDomCountries = domList ? domList.querySelectorAll('.selected-item').length > 0 : false;
                    
                    hasCountrySelection = hasStateCountries || hasDomCountries;
                }

                // 5. Atanan Kişi
                const assignedTo = document.getElementById('assignedTo')?.value;

                checks = {
                    'Atanan Kişi': isPortfolioManagerAssignment || !!assignedTo,
                    'Marka Adı': !!brandText,
                    'Sınıf Seçimi': hasClasses, // ✅ Güncellendi
                    'Başvuru Sahibi': domApplicantCount > 0,
                    'Menşe/Ülke': hasCountrySelection
                };

                isComplete = Object.values(checks).every(val => val === true);
            
            } 
            // --- SENARYO 2: YURTDIŞI MARKA İZLEME TALEBİ (86) ---
            else if (asId(selectedTaskType?.id) === TASK_IDS.MARKA_IZLEME_TALEBI) {
                const assignedTo = document.getElementById('assignedTo')?.value;
                const mode = state?.monitoringMode || 'existing';
                const selectedRecord = state?.selectedInternationalMonitoring;
                const newMarkName = document.getElementById('monitoringNewMarkName')?.value?.trim();
                const newApplicantName = document.getElementById('monitoringNewApplicantName')?.value?.trim();
                const ownerName = mode === 'existing' ? selectedRecord?.applicantName : newApplicantName;
                const classes = state?.monitoringSelectedClasses || [];
                const countries = state?.monitoringSelectedCountries || [];
                const startDate = document.getElementById('monitoringStartDate')?.value;
                const endDate = document.getElementById('monitoringEndDate')?.value;
                const validDateRange = !!startDate && !!endDate && new Date(endDate) >= new Date(startDate);

                checks = {
                    'Atanan Kişi': isPortfolioManagerAssignment || !!assignedTo,
                    'Marka': mode === 'existing' ? !!selectedRecord : !!newMarkName,
                    'Marka Sahibi': !!String(ownerName || '').trim(),
                    'Nice Sınıfı': classes.length > 0,
                    'Ülke': countries.length > 0,
                    'İzleme Tarihleri': validDateRange
                };

                isComplete = Object.values(checks).every(val => val === true);
            }
            // --- SENARYO 3: DİĞER İŞLEMLER ---
            else {
                const taskTitle = document.getElementById('taskTitle')?.value?.trim() || selectedTaskType?.alias;
                
                // 🔥 GÜVENLİK YAMASI: Seçili varlık state üzerinden tam doğrulukla çekiliyor
                const hasIpRecord = (state && state.selectedIpRecord) ? true : false;
                const assignedTo = document.getElementById('assignedTo')?.value;
                
                const tIdStr = asId(selectedTaskType?.id);
                const isSpecialTask = ['79', '80', '82'].includes(tIdStr);
                
                const hasOwner = state && state.selectedOwners && state.selectedOwners.length > 0;
                const isAssetOrOwnerValid = isSpecialTask ? (hasIpRecord || hasOwner) : hasIpRecord;
                
                const needsRelated = RELATED_PARTY_REQUIRED.has(tIdStr);
                
                const partyContainer = document.getElementById('relatedPartyList');
                const domRelatedCount = partyContainer ? partyContainer.querySelectorAll('.selected-item').length : 0;
                const hasRelated = domRelatedCount > 0;

                checks = {
                    'Atanan Kişi': isPortfolioManagerAssignment || !!assignedTo,
                    'İş Başlığı': !!taskTitle,
                    'Varlık/Sahip Seçimi': isAssetOrOwnerValid,
                    'İlgili Taraf': !needsRelated || hasRelated
                };

                isComplete = Object.values(checks).every(val => val === true);
            }

        // Sonucu uygula
        this.saveBtn.disabled = !isComplete;

        // --- DEBUG RAPORU ---
        if (!isComplete) {
            console.warn('🔒 BUTON KİLİTLİ - Eksik Alanlar:', checks); 
        } else {
            if (this.saveBtn.getAttribute('data-log-sent') !== 'true') {
                console.log('✅ TÜM KOŞULLAR SAĞLANDI. BUTON AÇIK.');
                this.saveBtn.setAttribute('data-log-sent', 'true');
            }
        }
    }
}