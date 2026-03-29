// public/js/components/EditCriteriaModalManager.js
import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

let instance = null; // Singleton yapısı (Sayfa değişse de olayların çakışmaması için)

export class EditCriteriaModalManager {
    constructor() {
        if (instance) return instance;
        this.onSaveCallback = null;
        this.currentMarkId = null;
        this.isInitialized = false;
        instance = this;
    }

    init() {
        if (this.isInitialized) return;
        this.setupListeners();
        this.isInitialized = true;
    }

    open(markData, onSaveCallback) {
        this.onSaveCallback = onSaveCallback;
        this.currentMarkId = markData.id;

        this.generateNiceClassBoxes();

        document.getElementById('modalTrademarkName').textContent = markData.markName || '-';
        document.getElementById('modalApplicationNo').textContent = markData.applicationNumber || '-';
        document.getElementById('modalOwner').textContent = markData.ownerName || '-';
        
        const imgEl = document.getElementById('modalTrademarkImage');
        if(imgEl) {
            imgEl.src = this._normalizeImageSrc(markData.brandImageUrl || '');
            imgEl.style.display = markData.brandImageUrl ? 'block' : 'none';
        }

        const searchInput = document.getElementById('searchMarkNameInput');
        if (searchInput) searchInput.value = markData.searchMarkName || '';

        let safeBrandTextSearch = markData.brandTextSearch || [];
        if (markData.searchMarkName && markData.markName) {
            safeBrandTextSearch = safeBrandTextSearch.filter(t => t.toLowerCase() !== markData.markName.toLowerCase());
        }
        this.populateList(document.getElementById('brandTextSearchList'), safeBrandTextSearch, []);
        
        this.populateNiceClassBoxes(markData.niceClassSearch || [], (markData.niceClasses || []).map(String));

        $('#editCriteriaModal').modal('show');
    }

    _normalizeImageSrc(u) {
        if (!u || typeof u !== 'string') return '';
        if (/^(https?:|data:|blob:)/i.test(u)) return u;
        if (/^[A-Za-z0-9+/=]+$/.test(u.slice(0, 100))) return 'data:image/png;base64,' + u;
        const { data } = supabase.storage.from('brand_images').getPublicUrl(u);
        return data.publicUrl;
    }

    generateNiceClassBoxes() {
        const container = document.getElementById('niceClassSelectionContainer');
        if (container && container.innerHTML.trim() === '') {
            let html = '';
            for (let i = 1; i <= 45; i++) {
                html += `<div class="nice-class-box" data-class-no="${i}">${i}</div>`;
            }
            container.innerHTML = html;
        }
    }

    addListItem(listElement, text, isPermanent = false) {
        if (!listElement) return;
        const cleanText = String(text).trim();
        if (!cleanText) return;
        const existing = Array.from(listElement.querySelectorAll('.list-item-text')).map(el => el.textContent.trim());
        if (existing.includes(cleanText)) return;
        
        const li = document.createElement('li'); 
        li.className = `list-group-item d-flex justify-content-between align-items-center ${isPermanent ? 'permanent-item' : ''}`;
        li.style.cssText = "border-radius: 8px; margin-bottom: 5px;";
        li.innerHTML = `<span class="list-item-text">${cleanText}</span><button type="button" class="btn btn-sm btn-outline-danger remove-item" style="border-radius: 50%; width: 28px; height: 28px; padding: 0; line-height: 1;">&times;</button>`;
        listElement.appendChild(li);
    }

    populateList(listElement, items, permanentItems = []) {
        if (!listElement) return;
        listElement.innerHTML = '';
        const cleanItems = items.map(i => String(i).trim()).filter(Boolean);
        const cleanPermanent = permanentItems.map(i => String(i).trim()).filter(Boolean);
        const all = new Set([...cleanItems, ...cleanPermanent]);
        all.forEach(item => this.addListItem(listElement, item, cleanPermanent.includes(item)));
    }

    populateNiceClassBoxes(selectedClasses, permanentClasses = []) {
        document.querySelectorAll('.nice-class-box').forEach(b => { b.classList.remove('selected', 'permanent-item'); });
        const cleanClass = val => String(parseInt(String(val).replace(/\D/g, ''), 10));
        const validSelected = selectedClasses.map(cleanClass).filter(c => !isNaN(c) && Number(c) >= 1 && Number(c) <= 45);
        const validPermanent = permanentClasses.map(cleanClass).filter(c => !isNaN(c) && Number(c) >= 1 && Number(c) <= 45);
        
        const all = new Set([...validSelected, ...validPermanent]);
        const niceClassSearchList = document.getElementById('niceClassSearchList');
        
        this.populateList(niceClassSearchList, [], validPermanent);
        
        all.forEach(cls => {
            const box = document.querySelector(`.nice-class-box[data-class-no="${cls}"]`);
            if (box) { 
                box.classList.add('selected'); 
                if (validPermanent.includes(cls)) {
                    box.classList.add('permanent-item'); 
                } else {
                    this.addListItem(niceClassSearchList, cls, false);
                }
            }
        });
    }

    replaceNode(id) {
        const el = document.getElementById(id);
        if (!el) return null;
        const clone = el.cloneNode(true);
        el.parentNode.replaceChild(clone, el);
        return clone;
    }

    setupListeners() {
        const newNiceContainer = this.replaceNode('niceClassSelectionContainer');
        if (newNiceContainer) {
            newNiceContainer.addEventListener('click', (e) => {
                if (e.target.classList.contains('nice-class-box')) {
                    if (e.target.classList.contains('permanent-item')) {
                        return showNotification('Orijinal sınıflar kaldırılamaz.', 'warning');
                    }
                    e.target.classList.toggle('selected');
                    const list = document.getElementById('niceClassSearchList');
                    if (e.target.classList.contains('selected')) {
                        this.addListItem(list, e.target.dataset.classNo);
                    } else {
                        if (list) {
                            const items = list.querySelectorAll('li'); 
                            items.forEach(i => { if(i.querySelector('.list-item-text').textContent === e.target.dataset.classNo) i.remove(); });
                        }
                    }
                }
            });
        }

        const newAddBrandBtn = this.replaceNode('addBrandTextBtn');
        if (newAddBrandBtn) {
            newAddBrandBtn.addEventListener('click', () => {
                const input = document.getElementById('brandTextSearchInput');
                if (input.value.trim()) {
                    this.addListItem(document.getElementById('brandTextSearchList'), input.value.trim());
                    input.value = '';
                }
            });
        }

        const setupListRemoval = (listId) => {
            const list = this.replaceNode(listId);
            if (!list) return;
            list.addEventListener('click', (e) => {
                const li = e.target.closest('li');
                if (li && e.target.classList.contains('remove-item')) {
                    if (li.classList.contains('permanent-item')) return;
                    const txt = li.querySelector('.list-item-text').textContent; 
                    li.remove();
                    if (listId === 'niceClassSearchList') {
                        document.querySelector(`.nice-class-box[data-class-no="${txt}"]`)?.classList.remove('selected');
                    }
                }
            });
        };
        setupListRemoval('brandTextSearchList');
        setupListRemoval('niceClassSearchList');

        const newSaveBtn = this.replaceNode('saveCriteriaBtn');
        if (newSaveBtn) {
            newSaveBtn.addEventListener('click', async () => {
                if (!this.currentMarkId) return;
                
                newSaveBtn.disabled = true;
                newSaveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Kaydediliyor...';

                const terms = Array.from(document.querySelectorAll('#brandTextSearchList .list-item-text')).map(el => el.textContent);
                let classes = [];
                const niceList = document.getElementById('niceClassSearchList');
                if (niceList) {
                    classes = Array.from(niceList.querySelectorAll('.list-item-text')).map(el => el.textContent);
                } else {
                    classes = Array.from(document.querySelectorAll('.nice-class-box.selected')).map(el => el.dataset.classNo);
                }
                
                const searchMarkNameValue = document.getElementById('searchMarkNameInput')?.value.trim() || '';

                try {
                    const { error } = await supabase.from('monitoring_trademarks').update({ 
                        search_mark_name: searchMarkNameValue,
                        brand_text_search: terms, 
                        nice_class_search: classes.map(String) 
                    }).eq('id', this.currentMarkId);

                    if (error) throw error;

                    showNotification('Kriterler başarıyla güncellendi.', 'success');
                    $('#editCriteriaModal').modal('hide');
                    
                    // İşlem bittikten sonra çağıran sayfaya "Veriler bunlar, arayüzünü güncelle" diyoruz!
                    if (this.onSaveCallback) {
                        await this.onSaveCallback({
                            id: this.currentMarkId,
                            searchMarkName: searchMarkNameValue,
                            brandTextSearch: terms,
                            niceClassSearch: classes.map(String)
                        });
                    }
                } catch (err) {
                    showNotification('Hata: ' + err.message, 'error');
                } finally {
                    newSaveBtn.disabled = false;
                    newSaveBtn.innerHTML = '<i class="fas fa-save mr-1"></i> Kaydet';
                }
            });
        }
    }
}