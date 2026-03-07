// public/js/nice-classification.js - Final Professional Version (Supabase Entegreli)
import { showNotification } from '../utils.js';
import { supabase } from '../supabase-config.js';

function injectNiceStyles() {
    const styleId = 'nice-classification-styles';
    const oldStyle = document.getElementById(styleId);
    if (oldStyle) oldStyle.remove();

    const css = `
        :root {
            --nice-bg: #ffffff;
            --nice-bg-alt: #f4f4f5;      
            --nice-border: #e4e4e7;      
            --nice-text-main: #27272a;   
            --nice-text-muted: #52525b;  
            --nice-text-light: #a1a1aa;  
            --nice-brand: #059669;       
            --nice-brand-hover: #047857; 
            --nice-brand-light: #d1fae5; 
            --nice-brand-bg: #ecfdf5;    
            --nice-danger: #dc2626;      
            --nice-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            --nice-modal-z: 99999; 
        }

        .nice-container { 
            font-family: 'Inter', system-ui, -apple-system, sans-serif; 
            color: var(--nice-text-main); 
            font-size: 14px;
            line-height: 1.5;
        }

        .nice-class-group {
            background: var(--nice-bg);
            border: 1px solid var(--nice-border);
            margin-bottom: 8px;
            border-radius: 8px;
            overflow: hidden;
            transition: all 0.2s ease;
        }
        .nice-class-group:hover { border-color: #a1a1aa; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        
        .nice-class-group.has-selection {
            border-color: var(--nice-brand);
            box-shadow: 0 0 0 1px var(--nice-brand);
        }
        .nice-class-group.has-selection .nice-class-header { background-color: var(--nice-brand-bg); }
        .nice-class-group.has-selection .nice-badge { background-color: var(--nice-brand); color:white; }

        .nice-class-header {
            padding: 10px 14px; background: var(--nice-bg-alt);
            cursor: pointer; display: flex; align-items: center; justify-content: space-between;
            border-bottom: 1px solid transparent; user-select: none;
        }
        
        .nice-header-left { display: flex; align-items: center; gap: 10px; flex: 1; }
        
        .nice-badge {
            background: #52525b; color: #fff; font-size: 11px; font-weight: 700;
            padding: 2px 8px; border-radius: 4px; min-width: 28px; text-align: center;
            transition: background 0.2s;
        }
        
        .nice-title { font-weight: 600; color: var(--nice-text-main); font-size: 13px; }
        .nice-icon-chevron { color: var(--nice-text-light); transition: transform 0.2s; font-size: 12px; }
        .nice-class-group.open .nice-icon-chevron { transform: rotate(180deg); color: var(--nice-text-main); }

        .nice-btn-select-all {
            background: #fff; border: 1px solid var(--nice-border); 
            color: var(--nice-text-muted); border-radius: 4px; 
            padding: 2px 8px; font-size: 11px; margin-right: 10px; 
            transition: all 0.2s; cursor: pointer;
        }
        .nice-btn-select-all:hover { border-color: var(--nice-brand); color: var(--nice-brand); }

        .nice-sub-list { display: none; background: #fff; border-top: 1px solid var(--nice-border); }
        .nice-sub-list.open { display: block; animation: niceSlideDown 0.15s ease-out; }

        .nice-sub-item {
            padding: 8px 14px 8px 45px; border-bottom: 1px solid var(--nice-border);
            cursor: pointer; display: flex; align-items: flex-start; gap: 10px;
            transition: background 0.1s;
        }
        .nice-sub-item:last-child { border-bottom: none; }
        .nice-sub-item:hover { background: var(--nice-bg-alt); }
        .nice-sub-item.selected { background-color: var(--nice-brand-bg); }
        .nice-sub-item.selected .nice-label { color: var(--nice-brand-hover); font-weight: 600; }

        .nice-checkbox { width: 15px; height: 15px; accent-color: var(--nice-brand); margin-top: 3px; cursor: pointer; }
        .nice-label { font-size: 13px; color: var(--nice-text-muted); line-height: 1.4; cursor: pointer; flex: 1; margin: 0; }

        .selected-group-card {
            background: #fff; border: 1px solid var(--nice-border); border-radius: 8px;
            margin-bottom: 10px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        .selected-group-header {
            background: var(--nice-bg-alt); padding: 6px 12px; font-weight: 600;
            color: var(--nice-text-main); border-bottom: 1px solid var(--nice-border);
            font-size: 12px; display: flex; align-items: center;
        }
        .selected-group-header::before {
            content: ''; display: inline-block; width: 6px; height: 6px;
            background: var(--nice-brand); border-radius: 50%; margin-right: 8px;
        }
        .selected-item-row {
            padding: 8px 12px; border-bottom: 1px solid var(--nice-border);
            display: flex; align-items: flex-start; gap: 10px;
        }
        .selected-item-row:hover { background: #fafafa; }
        .selected-code-badge {
            background: var(--nice-bg-alt); color: var(--nice-text-main); font-size: 11px;
            font-weight: 700; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--nice-border);
            white-space: nowrap; font-family: monospace;
        }
        .btn-remove-item { color: var(--nice-text-light); border: none; background: none; padding: 2px; cursor: pointer; }
        .btn-remove-item:hover { color: var(--nice-danger); }

        .nice-modal-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); backdrop-filter: blur(2px);
            z-index: var(--nice-modal-z); display: flex; align-items: center; justify-content: center;
            opacity: 0; animation: niceFadeIn 0.2s forwards;
        }
        
        .nice-modal-container {
            background: #fff; width: 90%; max-width: 1100px; height: 85vh;
            border-radius: 12px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            display: flex; flex-direction: column; overflow: hidden;
            transform: scale(0.95); opacity: 0; animation: niceZoomIn 0.2s 0.1s forwards;
        }

        .nice-modal-header {
            padding: 16px 24px; border-bottom: 1px solid var(--nice-border);
            display: flex; justify-content: space-between; align-items: center;
            background: #fff;
        }
        .nice-modal-title { font-size: 18px; font-weight: 700; color: #18181b; display: flex; align-items: center; gap: 10px; }
        .nice-modal-close { background: none; border: none; font-size: 24px; color: #a1a1aa; cursor: pointer; line-height: 1; }
        .nice-modal-close:hover { color: #18181b; }

        .nice-modal-body { flex: 1; overflow: hidden; display: flex; background: var(--nice-bg-alt); }
        .nice-modal-col-left { flex: 2; padding: 20px; display: flex; flex-direction: column; border-right: 1px solid var(--nice-border); }
        .nice-modal-col-right { flex: 1; padding: 20px; display: flex; flex-direction: column; background: #fff; }

        .nice-modal-list-box {
            background: #fff; border: 1px solid var(--nice-border); border-radius: 8px;
            flex: 1; overflow-y: auto; padding: 10px; margin-top: 10px;
        }

        .nice-modal-footer {
            padding: 16px 24px; border-top: 1px solid var(--nice-border);
            background: #fff; display: flex; justify-content: flex-end; gap: 12px;
        }

        .nice-input {
            width: 100%; padding: 8px 12px; border: 1px solid var(--nice-border);
            border-radius: 6px; font-size: 14px; outline: none; transition: all 0.2s;
        }
        .nice-input:focus { border-color: var(--nice-brand); box-shadow: 0 0 0 2px var(--nice-brand-light); }

        .nice-btn-primary {
            background: var(--nice-brand); color: white; border: none;
            padding: 8px 16px; border-radius: 6px; font-size: 14px; font-weight: 500;
            cursor: pointer; transition: background 0.2s;
        }
        .nice-btn-primary:hover { background: var(--nice-brand-hover); }
        
        .nice-btn-secondary {
            background: #fff; border: 1px solid var(--nice-border); color: var(--nice-text-main);
            padding: 8px 16px; border-radius: 6px; font-size: 14px; cursor: pointer;
        }
        .nice-btn-secondary:hover { background: var(--nice-bg-alt); }

        .nice-btn-danger-outline {
            background: #fff; border: 1px solid #fecaca; color: var(--nice-danger);
            padding: 6px 12px; border-radius: 6px; font-size: 12px; width: 100%; cursor: pointer;
        }
        .nice-btn-danger-outline:hover { background: #fef2f2; }

        @keyframes niceFadeIn { to { opacity: 1; } }
        @keyframes niceZoomIn { to { opacity: 1; transform: scale(1); } }
        @keyframes niceSlideDown { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
    `;
    const style = document.createElement('style');
    style.id = styleId; style.textContent = css; document.head.appendChild(style);
}

class Class35_5Manager {
    constructor(parentManager) {
        this.parent = parentManager; 
        this.modalData = []; 
        this.selectedItems = {}; 
        this.modalId = 'nice-custom-modal-35-5';
    }

    async open() {
        this.modalData = this.parent.allData.filter(cls => cls.classNumber >= 1 && cls.classNumber <= 34);
        this.selectedItems = {}; 
        this.renderModal();
        this.setupEvents();
    }

    renderModal() {
        const modalHTML = `
        <div id="${this.modalId}" class="nice-modal-overlay">
            <div class="nice-modal-container">
                <div class="nice-modal-header">
                    <div class="nice-modal-title">
                        <span class="nice-badge" style="background: var(--nice-brand); font-size: 14px;">35-5</span> 
                        Müşterilerin Malları (Perakende)
                    </div>
                    <button class="nice-modal-close" data-action="close">&times;</button>
                </div>

                <div class="nice-modal-body">
                    <div class="nice-modal-col-left">
                        <input type="text" class="nice-input" id="c35-search" placeholder="🔍 Mal sınıfı ara (örn: ilaç, giysi)...">
                        <div class="nice-modal-list-box nice-container" id="c35-list-container">
                            ${this._generateListHTML()}
                        </div>
                        <div style="margin-top: 15px; display: flex; gap: 10px;">
                            <input type="text" id="c35-custom-input" class="nice-input" placeholder="Listede olmayan özel bir mal...">
                            <button class="nice-btn-primary" id="c35-add-custom">Ekle</button>
                        </div>
                    </div>

                    <div class="nice-modal-col-right">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid #e4e4e7;">
                            <span style="font-weight:600; color:#3f3f46; font-size:13px;">SEÇİLENLER</span>
                            <span class="nice-badge" id="c35-count">0</span>
                        </div>
                        <div style="flex:1; overflow-y:auto;" id="c35-selected-container"></div>
                        <div style="margin-top:15px;">
                            <button class="nice-btn-danger-outline" id="c35-clear">Tümünü Temizle</button>
                        </div>
                    </div>
                </div>

                <div class="nice-modal-footer">
                    <button class="nice-btn-secondary" data-action="close">İptal</button>
                    <button class="nice-btn-primary" id="c35-save">Kaydet ve Ekle</button>
                </div>
            </div>
        </div>`;

        const oldModal = document.getElementById(this.modalId);
        if (oldModal) oldModal.remove();

        document.body.insertAdjacentHTML('beforeend', modalHTML);
        this.updateSelectedUI();
    }

    _generateListHTML() {
        return this.modalData.map(cls => `
            <div class="nice-class-group c35-group" data-class="${cls.classNumber}">
                <div class="nice-class-header c35-header">
                    <div class="nice-header-left">
                        <span class="nice-badge">${cls.classNumber}</span>
                        <span class="nice-title">${cls.classTitle}</span>
                    </div>
                    <i class="fas fa-chevron-down nice-icon-chevron"></i>
                </div>
                <div class="nice-sub-list" id="c35-sub-${cls.classNumber}">
                    ${cls.subClasses.map((sub, idx) => {
                        const code = `${cls.classNumber}-${idx + 1}`;
                        return `
                        <div class="nice-sub-item c35-item-row" data-code="${code}" data-text="${sub.subClassDescription}">
                            <input type="checkbox" class="nice-checkbox" id="chk-${code}" value="${code}">
                            <label class="nice-label ml-2" for="chk-${code}">
                                <span style="color:#a1a1aa; font-size:11px;">(${code})</span> ${sub.subClassDescription}
                            </label>
                        </div>`;
                    }).join('')}
                </div>
            </div>
        `).join('');
    }

    setupEvents() {
        const modal = document.getElementById(this.modalId);
        
        modal.addEventListener('click', (e) => {
            const target = e.target;
            if (target.dataset.action === 'close') return this.close();
            if (target === modal) return this.close();

            const header = target.closest('.c35-header');
            if (header) {
                const group = header.parentElement;
                const content = group.querySelector('.nice-sub-list');
                const isOpen = content.classList.contains('open');
                
                if (isOpen) { content.classList.remove('open'); group.classList.remove('open'); }
                else { content.classList.add('open'); group.classList.add('open'); }
                return;
            }

            const itemRow = target.closest('.c35-item-row');
            if (itemRow && target.tagName !== 'INPUT' && target.tagName !== 'LABEL') {
                const checkbox = itemRow.querySelector('input[type="checkbox"]');
                checkbox.checked = !checkbox.checked;
                this.toggleItem(checkbox.value, itemRow.dataset.text, checkbox.checked);
            }
            
            if (target.tagName === 'INPUT' && target.type === 'checkbox') {
                const itemRow = target.closest('.c35-item-row');
                this.toggleItem(target.value, itemRow.dataset.text, target.checked);
            }
        });

        document.getElementById('c35-search').addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            modal.querySelectorAll('.c35-group').forEach(group => {
                const title = group.querySelector('.nice-title').innerText.toLowerCase();
                const items = group.querySelectorAll('.c35-item-row');
                let match = false;
                
                items.forEach(item => {
                    if(item.innerText.toLowerCase().includes(term)) { item.style.display = 'flex'; match = true; } 
                    else { item.style.display = 'none'; }
                });

                if (title.includes(term) || match) {
                    group.style.display = 'block';
                    if (term.length > 2) {
                        group.classList.add('open');
                        group.querySelector('.nice-sub-list').classList.add('open');
                    }
                } else {
                    group.style.display = 'none';
                }
            });
        });

        document.getElementById('c35-save').addEventListener('click', () => {
            const items = Object.values(this.selectedItems);
            if (items.length === 0) return alert('Lütfen en az bir mal seçin.');
            
            const combinedText = `Müşterilerin malları elverişli bir şekilde görüp satın alabilmeleri için ${items.join(', ')} mallarının bir araya getirilmesi hizmetleri (belirtilen hizmetler perakende satış mağazaları, toptan satış mağazaları, elektronik ortamlar, katalog ve benzeri diğer yöntemler ile sağlanabilir)`;
            
            this.parent.addSelection('35-5', '35', combinedText);
            this.close();
        });

        document.getElementById('c35-add-custom').addEventListener('click', () => {
            const input = document.getElementById('c35-custom-input');
            const val = input.value.trim();
            if(!val) return;
            const customCode = `99-${Date.now()}`;
            this.toggleItem(customCode, val, true);
            input.value = '';
        });

        document.getElementById('c35-clear').onclick = () => { 
            this.selectedItems = {}; 
            this.updateSelectedUI(); 
            modal.querySelectorAll('input').forEach(i=>i.checked=false); 
        };
    }

    toggleItem(code, text, isSelected) {
        if (isSelected) this.selectedItems[code] = text;
        else delete this.selectedItems[code];
        this.updateSelectedUI();
    }

    updateSelectedUI() {
        const container = document.getElementById('c35-selected-container');
        document.getElementById('c35-count').innerText = Object.keys(this.selectedItems).length;
        container.innerHTML = Object.entries(this.selectedItems).map(([k,v]) => 
            `<div class="selected-item-row">
                <span class="selected-code-badge">${k}</span>
                <span class="selected-text">${v}</span>
                <button class="btn-remove-item" onclick="document.getElementById('chk-${k}').click()">&times;</button>
            </div>`
        ).join('');
    }

    close() { 
        const modal = document.getElementById(this.modalId);
        if (modal) modal.remove();
    }
}

class NiceClassificationManager {
    constructor() {
        this.allData = [];
        this.selectedClasses = {};
        this.elements = {}; 
        this.class35Manager = new Class35_5Manager(this);
        this.classTexts = {};
        
        // 🔥 YENİ: Çift yüklemeyi engelleyen güvenlik kilidi
        this.isInitialized = false; 
    }

    async init() {
        // 🔥 YENİ: Eğer zaten başlatıldıysa işlemi atla (Performans artışı)
        if (this.isInitialized) return;

        this.elements = {
            listContainer: document.getElementById('niceClassificationList'),
            selectedContainer: document.getElementById('selectedNiceClasses') || document.getElementById('nice-classes-accordion'),
            searchInput: document.getElementById('niceClassSearch'),
            selectedCountBadge: document.getElementById('selectedClassCount'),
            customInput: document.getElementById('customClassInput'),
            customAddBtn: document.getElementById('addCustomClassBtn'),
            customCharCount: document.getElementById('customClassCharCount')
        };

        if (!this.elements.listContainer && !this.elements.selectedContainer) return;

        try {
            injectNiceStyles();
            
            const { data, error } = await supabase
                .from('nice_classes')
                .select('*')
                .order('class_number', { ascending: true });
                
            if (error) throw error;

            this.allData = data.map(doc => ({ 
                classNumber: parseInt(doc.class_number),
                classTitle: doc.class_title,
                subClasses: doc.sub_classes || []
            }));

            if (this.elements.listContainer) this.renderList();
            
            this.setupEventListeners();
            this.updateSelectionUI();

            // 🔥 YENİ: Başarıyla başlatıldığını işaretle
            this.isInitialized = true;

        } catch (error) {
            console.error("Nice error:", error);
        }
    }

    renderList() {
        let html = '<div class="nice-container">';
        this.allData.forEach(cls => {
            html += `
            <div class="nice-class-group" data-class-num="${cls.classNumber}" data-search="${(cls.classNumber + ' ' + cls.classTitle).toLowerCase()}">
                <div class="nice-class-header toggle-sublist">
                    <div class="nice-header-left">
                        <span class="nice-badge">${cls.classNumber}</span>
                        <span class="nice-title">${cls.classTitle}</span>
                    </div>
                    <div class="d-flex align-items-center">
                        <button class="nice-btn-select-all mr-2" title="Tümünü Seç">Tümü</button>
                        <i class="fas fa-chevron-down nice-icon-chevron"></i>
                    </div>
                </div>
                <div class="nice-sub-list">
                    ${cls.subClasses.map((sub, idx) => {
                        const code = `${cls.classNumber}-${idx + 1}`;
                        const is35_5 = code === '35-5';
                        const extraClass = is35_5 ? 'bg-light font-weight-bold' : '';
                        const icon = is35_5 ? '<i class="fas fa-shopping-cart text-muted mr-2"></i>' : '';
                        
                        return `
                        <div class="nice-sub-item sub-item ${extraClass}" data-code="${code}" data-text="${sub.subClassDescription}">
                            <input type="checkbox" class="nice-checkbox class-checkbox" id="chk-main-${code}" value="${code}">
                            <label class="nice-label ml-2" for="chk-main-${code}">
                                ${icon}<span class="text-muted small mr-1">(${code})</span> ${sub.subClassDescription}
                            </label>
                        </div>`;
                    }).join('')}
                </div>
            </div>`;
        });
        html += '</div>';
        this.elements.listContainer.innerHTML = html;
    }

    setupEventListeners() {
        if (this.elements.listContainer) {
            this.elements.listContainer.addEventListener('click', (e) => {
                const target = e.target;

                if (target.closest('.nice-btn-select-all')) {
                    e.stopPropagation();
                    this.toggleWholeClass(parseInt(target.closest('.nice-class-group').dataset.classNum));
                    return;
                }

                if (target.closest('.nice-class-header')) {
                    const group = target.closest('.nice-class-header').parentElement;
                    const list = group.querySelector('.nice-sub-list');
                    const isOpen = list.classList.contains('open');
                    if (isOpen) { list.classList.remove('open'); group.classList.remove('open'); }
                    else { list.classList.add('open'); group.classList.add('open'); }
                    return;
                }

                const subItem = target.closest('.sub-item');
                if (subItem) {
                    const checkbox = subItem.querySelector('.class-checkbox');
                    
                    if(subItem.dataset.code === '35-5') {
                        if (target.tagName === 'INPUT') target.checked = !target.checked; 
                        this.class35Manager.open();
                        return;
                    }
                    
                    if (target.tagName !== 'INPUT' && target.tagName !== 'LABEL') {
                        checkbox.checked = !checkbox.checked;
                        this.handleCheckboxAction(checkbox.value, subItem.dataset.text, checkbox.checked);
                    } else if (target.tagName === 'INPUT') {
                        this.handleCheckboxAction(target.value, subItem.dataset.text, target.checked);
                    }
                }
            });
        }

        if (this.elements.selectedContainer) {
            this.elements.selectedContainer.addEventListener('input', (e) => {
                if (e.target.classList.contains('class-items-textarea')) {
                    const classNum = e.target.dataset.classNum;
                    this.classTexts[classNum] = e.target.value;
                }
            });
        }

        if (this.elements.searchInput) {
            this.elements.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        }

        if (this.elements.customAddBtn) {
            this.elements.customAddBtn.addEventListener('click', () => {
                const val = this.elements.customInput.value.trim();
                if(val) {
                    this.addSelection(`99-${Date.now()}`, '99', val);
                    this.elements.customInput.value = '';
                }
            });
        }
    }

    handleCheckboxAction(code, text, isChecked) {
        if (code === '35-5') this.class35Manager.open();
        else if (isChecked) this.addSelection(code, code.split('-')[0], text);
        else this.removeSelection(code);
    }

    addSelection(code, classNum, text) {
        this.selectedClasses[code] = { classNum: String(classNum), text };
        
        if (!this.classTexts[classNum]) {
            this.classTexts[classNum] = text;
        } else {
            const existingItems = this.classTexts[classNum].split('\n').map(i => i.trim());
            if (!existingItems.includes(text.trim())) {
                this.classTexts[classNum] += '\n' + text.trim();
            }
        }
        
        this.updateSelectionUI();
    }

    removeSelection(code) {
        delete this.selectedClasses[code];
        this.updateSelectionUI();
    }

    toggleWholeClass(classNum) {
        const classData = this.allData.find(c => c.classNumber === classNum);
        if (!classData) return;
        const subCodes = classData.subClasses.map((_, i) => `${classNum}-${i+1}`).filter(c => c !== '35-5');
        const allSelected = subCodes.every(c => this.selectedClasses[c]);
        
        if (allSelected) subCodes.forEach(c => this.removeSelection(c));
        else {
            classData.subClasses.forEach((sub, i) => {
                const c = `${classNum}-${i+1}`;
                if (c !== '35-5') this.addSelection(c, classNum, sub.subClassDescription);
            });
        }
    }

    handleSearch(term) {
        term = term.toLowerCase();
        const groups = this.elements.listContainer.querySelectorAll('.nice-class-group');
        
        groups.forEach(group => {
            const searchText = group.dataset.search;
            const items = group.querySelectorAll('.nice-sub-item');
            let match = false;

            items.forEach(item => {
                if (item.innerText.toLowerCase().includes(term) || item.dataset.code.includes(term)) {
                    item.style.display = 'flex'; match = true;
                } else {
                    item.style.display = 'none';
                }
            });

            if (searchText.includes(term) || match) {
                group.style.display = 'block';
                if (term.length > 2) {
                    group.classList.add('open');
                    group.querySelector('.nice-sub-list').classList.add('open');
                }
            } else {
                group.style.display = 'none';
            }
        });
    }

    updateSelectionUI() {
        if (!this.elements.selectedContainer) return;

        if (this.elements.listContainer) {
            const allGroups = this.elements.listContainer.querySelectorAll('.nice-class-group');
            allGroups.forEach(g => g.classList.remove('has-selection'));

            const allCheckboxes = this.elements.listContainer.querySelectorAll('.class-checkbox');
            allCheckboxes.forEach(chk => {
                const isSelected = !!this.selectedClasses[chk.value];
                chk.checked = isSelected;
                
                const row = chk.closest('.nice-sub-item');
                if (row) {
                    isSelected ? row.classList.add('selected') : row.classList.remove('selected');
                }

                if (isSelected) {
                    const group = chk.closest('.nice-class-group');
                    if (group) group.classList.add('has-selection');
                }
            });
        }

        const count = Object.keys(this.selectedClasses).length;
        if (this.elements.selectedCountBadge) this.elements.selectedCountBadge.textContent = count;

        if (count === 0) {
            this.elements.selectedContainer.innerHTML = `<div class="text-center text-muted py-4"><p>Henüz sınıf seçilmedi.</p></div>`;
            return;
        }

        const grouped = {};
        Object.entries(this.selectedClasses).forEach(([code, val]) => {
            if (!grouped[val.classNum]) grouped[val.classNum] = [];
            grouped[val.classNum].push({code, text: val.text});
        });

        let html = '';
        Object.keys(grouped).sort((a,b) => Number(a)-Number(b)).forEach(num => {
            html += `
            <div class="selected-group-card mb-3 border rounded shadow-sm bg-white">
                <div class="selected-group-header bg-light p-2 font-weight-bold border-bottom d-flex justify-content-between align-items-center">
                    <span>Nice Sınıfı ${num}</span>
                    <button type="button" class="btn btn-outline-danger btn-sm border-0" onclick="window.clearClassSelection('${num}')">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
                <div class="p-2">
                    <textarea class="form-control class-items-textarea" 
                            data-class-num="${num}" 
                            rows="6" style="font-size: 13px; line-height: 1.4;">${this.classTexts[num] || ''}</textarea>
                </div>
            </div>`;
        });

        this.elements.selectedContainer.innerHTML = html;
    }

    getSelectedData() {
        const selectedNums = [...new Set(Object.values(this.selectedClasses).map(v => String(v.classNum)))];
        return selectedNums.sort((a,b) => Number(a)-Number(b)).map(num => {
            const text = this.classTexts[num] || "";
            return `(${num}-1) ${text}`; 
        });
    }

    setSelectedData(arr) {
        this.selectedClasses = {};
        this.classTexts = {}; 
        if (Array.isArray(arr)) {
            arr.forEach(s => {
                const m = s.match(/^\((\d+(?:-\d+)?)\)\s*([\s\S]*)$/);
                if (m) this.addSelection(m[1], m[1].split('-')[0], m[2]);
            });
        }
        this.updateSelectionUI();
    }

    clearAll() { this.selectedClasses = {}; this.updateSelectionUI(); }
}

const niceManager = new NiceClassificationManager(); 

export async function initializeNiceClassification() { await niceManager.init(); }
export function getSelectedNiceClasses() { return niceManager.getSelectedData(); }
export function setSelectedNiceClasses(classes) { niceManager.setSelectedData(classes); }
export function clearAllSelectedClasses() { niceManager.clearAll(); }

window.clearAllSelectedClasses = () => niceManager.clearAll();

window.clearClassSelection = (classNum) => {
    if (!confirm(`Sınıf ${classNum} silinecek. Emin misiniz?`)) return;
    const codesToRemove = Object.keys(niceManager.selectedClasses).filter(code => code.split('-')[0] === String(classNum));
    codesToRemove.forEach(code => delete niceManager.selectedClasses[code]);
    if (niceManager.classTexts) delete niceManager.classTexts[classNum];

    niceManager.updateSelectionUI();
    if (typeof showNotification === 'function') showNotification(`Sınıf ${classNum} kaldırıldı.`, 'info');
};

window.clearNiceSearch = () => {
    const input = document.getElementById('niceClassSearch');
    if(input) { input.value = ''; input.dispatchEvent(new Event('input')); }
};