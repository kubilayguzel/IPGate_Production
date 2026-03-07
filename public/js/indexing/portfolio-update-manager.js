// public/js/indexing/portfolio-update-manager.js

import { supabase, ipRecordsService } from '../../supabase-config.js';
import { showNotification, STATUSES } from '../../utils.js';
// 🔥 GÜNCELLEME: initializeNiceClassification eklendi
import { initializeNiceClassification, getSelectedNiceClasses, setSelectedNiceClasses } from '../nice-classification.js';

export class PortfolioUpdateManager {
    constructor() {
        this.state = {
            selectedRecordId: null,
            recordData: null,
            currentTransactions: [],
            niceClasses: [],
            goodsAndServicesMap: {},
            bulletins: []
        };
        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.populateStatusDropdown();
    }

    populateStatusDropdown() {
        const select = document.getElementById('registry-status') || document.getElementById('status');
        if (!select || select.options.length > 1) return; 
        
        select.innerHTML = '<option value="">-- Durum Seçin --</option>';
        const statuses = STATUSES.trademark || [];
        statuses.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.value; 
            opt.textContent = s.text;
            select.appendChild(opt);
        });
    }

    setupEventListeners() {
        document.addEventListener('record-selected', (e) => {
            if (e.detail && e.detail.recordId) {
                this.handleExternalRecordSelection(e.detail.recordId);
            }
        });

        document.addEventListener('click', (e) => {
            const saveBtn = e.target.closest('#save-portfolio-btn');
            if (saveBtn) {
                e.preventDefault();
                this.handleSave();
            }
        });

        document.addEventListener('change', (e) => {
            if (e.target && (e.target.id === 'detectedType' || e.target.id === 'childTransactionType')) {
                this.checkVisibility();
            }
        });
    }

    async handleExternalRecordSelection(recordId) {
        if (!recordId) return;
        try {
            const result = await ipRecordsService.getRecordById(recordId);
            if (result.success && result.data) {
                this.selectRecord(result.data);
            }
        } catch (e) {
            console.error('Kayıt detayları alınamadı:', e);
        }
    }

    async selectRecord(record) {
        if (!record) return;

        this.state.selectedRecordId = record.id;
        this.state.recordData = record;

        this.populateStatusDropdown();

        const regNoEl = document.getElementById('registry-registration-no');
        const regDateEl = document.getElementById('registry-registration-date');
        const statusEl = document.getElementById('registry-status') || document.getElementById('status');

        if (regNoEl) regNoEl.value = record.registration_number || record.registrationNumber || '';
        if (regDateEl) {
            const rDate = record.registration_date || record.registrationDate || '';
            regDateEl.value = rDate;
            if (regDateEl._flatpickr && rDate) {
                regDateEl._flatpickr.setDate(rDate, false);
            }
        }
        if (statusEl) {
            statusEl.value = record.status || record.portfolio_status || '';
        }

        let loadedClasses = [];
        let loadedGS = [];

        try {
            const { data: classData, error } = await supabase
                .from('ip_record_classes')
                .select('*')
                .eq('ip_record_id', record.id);

            if (!error && classData && classData.length > 0) {
                loadedClasses = classData.map(c => c.class_no);
                loadedGS = classData.map(c => ({
                    classNo: c.class_no,
                    items: c.items || []
                }));
            } else {
                const details = record.details || {};
                loadedClasses = record.niceClasses || record.nice_classes || details.niceClasses || [];
                loadedGS = record.goodsAndServicesByClass || record.goods_and_services_by_class || details.goodsAndServicesByClass || [];
            }
        } catch (err) {
            console.error("Eşya listesi çekilemedi:", err);
        }

        if (typeof loadedClasses === 'string') {
            try { loadedClasses = JSON.parse(loadedClasses); } catch(e) { loadedClasses = []; }
        }
        if (typeof loadedGS === 'string') {
            try { loadedGS = JSON.parse(loadedGS); } catch(e) { loadedGS = []; }
        }

        this.state.niceClasses = loadedClasses;
        this.state.goodsAndServicesMap = {};
        
        if (Array.isArray(loadedGS)) {
            loadedGS.forEach(g => {
                if (g && (g.classNo !== undefined || g.class_no !== undefined)) {
                    const cNo = g.classNo !== undefined ? g.classNo : g.class_no;
                    this.state.goodsAndServicesMap[cNo] = Array.isArray(g.items) ? g.items : [];
                    
                    if (!loadedClasses.includes(cNo) && !loadedClasses.includes(String(cNo))) {
                        loadedClasses.push(cNo);
                    }
                }
            });
        }

        this.state.bulletins = record.bulletins || (record.details && record.details.bulletins) || [];
        this.checkVisibility();

        // 🔥 ÇÖZÜM: Önce Sınıf Modalını UYANDIR, sonra veriyi bas.
        setTimeout(async () => {
            try {
                if (typeof initializeNiceClassification === 'function') {
                    await initializeNiceClassification(); // UI Başlatılır (SQL'den sınıflar çekilir)
                }

                if (typeof setSelectedNiceClasses === 'function') {
                    const formatted = [];
                    Object.keys(this.state.goodsAndServicesMap).forEach(cNo => {
                        const items = this.state.goodsAndServicesMap[cNo];
                        const itemsStr = items.join('\n');
                        formatted.push(`(${cNo}-1) ${itemsStr}`);
                    });
                    
                    setSelectedNiceClasses(formatted); // Formatlanmış veri basılır
                }
            } catch(e) {
                console.error("Sınıf başlatma hatası:", e);
            }
        }, 500);
    }

    checkVisibility() {
        const childSelect = document.getElementById('detectedType') || document.getElementById('childTransactionType');
        const childVal = childSelect ? String(childSelect.value) : '';
        const selectedOption = childSelect && childSelect.selectedIndex > -1 ? childSelect.options[childSelect.selectedIndex] : null;
        const childText = selectedOption ? selectedOption.text.toLowerCase() : '';

        let isVisible = false;
        if (childVal === '45' || childText.includes('tescil belgesi') || childVal === '40') {
            isVisible = true;
        }

        const registryEditorSection = document.getElementById('registry-editor-section');
        if (registryEditorSection) {
            registryEditorSection.style.display = isVisible ? 'block' : 'none';
        }
    }

    async handleSave() {
        if (!this.state.selectedRecordId) {
            showNotification('Lütfen önce bir kayıt seçin.', 'warning');
            return;
        }

        const regNo = document.getElementById('registry-registration-no')?.value.trim() || '';
        const regDate = document.getElementById('registry-registration-date')?.value || '';
        const statusSelect = document.getElementById('registry-status') || document.getElementById('status');
        const statusVal = statusSelect?.value || '';

        let rawNiceClasses = [];
        if (typeof getSelectedNiceClasses === 'function') {
            rawNiceClasses = getSelectedNiceClasses() || [];
        }

        let niceClasses = [];
        let goodsAndServicesByClass = [];

        rawNiceClasses.forEach(item => {
            const match = item.match(/^\((\d+)(?:-\d+)?\)\s*([\s\S]*)$/);
            if (match) {
                const classNo = parseInt(match[1]);
                const rawText = match[2].trim();
                
                if (!niceClasses.includes(classNo)) niceClasses.push(classNo);
                
                let classObj = goodsAndServicesByClass.find(obj => obj.classNo === classNo);
                if (!classObj) {
                    classObj = { classNo, items: [] };
                    goodsAndServicesByClass.push(classObj);
                }
                
                if (rawText) {
                    const lines = rawText.split(/[\n]/).map(l => l.trim()).filter(Boolean);
                    lines.forEach(line => {
                        const cleanLine = line.replace(/^\)+|\)+$/g, '').trim(); 
                        if (cleanLine && !classObj.items.includes(cleanLine)) {
                            classObj.items.push(cleanLine);
                        }
                    });
                }
            }
        });

        const saveBtn = document.getElementById('save-portfolio-btn');
        let originalContent = '';
        if (saveBtn) {
            originalContent = saveBtn.innerHTML;
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Kaydediliyor...';
        }

        try {
            const updates = {
                registration_number: regNo || null,
                registration_date: regDate || null,
                status: statusVal || null
            };

            Object.keys(updates).forEach(key => {
                if (updates[key] === undefined) delete updates[key];
            });

            if (Object.keys(updates).length > 0) {
                await ipRecordsService.updateRecord(this.state.selectedRecordId, updates);
            }

            try {
                await supabase.from('ip_record_classes').delete().eq('ip_record_id', this.state.selectedRecordId);
                
                if (goodsAndServicesByClass.length > 0) {
                    const classInserts = goodsAndServicesByClass.map(g => ({
                        id: crypto.randomUUID(),
                        ip_record_id: this.state.selectedRecordId,
                        class_no: g.classNo,
                        items: g.items
                    }));
                    await supabase.from('ip_record_classes').insert(classInserts);
                }
            } catch (classErr) {}
            
            showNotification('Tescil bilgileri ve eşya listesi başarıyla güncellendi.', 'success');

        } catch (error) {
            console.error('Kaydetme hatası:', error);
            showNotification('Kaydetme sırasında hata oluştu: ' + error.message, 'error');
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = originalContent || '<i class="fas fa-save mr-2"></i>Portföyü Güncelle';
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.portfolioUpdateManager = new PortfolioUpdateManager();
});