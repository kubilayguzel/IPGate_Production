// public/js/components/AccrualFormManager.js

export class AccrualFormManager {
    constructor(containerId, prefix, allPersons = [], options = {}) {
        this.container = document.getElementById(containerId);
        this.prefix = prefix;
        this.allPersons = allPersons;
        this.isFreestyle = options.isFreestyle || false; 
        
        this.onAutoCalc = options.onAutoCalc || null;
        
        this.selectedTpParty = null;
        this.selectedForeignParty = null;
        this.currentData = null;
    }

    render() {
        if (!this.container) return;

        const modalContent = this.container.closest('.modal-content');
        if (modalContent) {
            modalContent.style.setProperty('max-width', '1400px', 'important');
            modalContent.style.setProperty('width', '95vw', 'important');
        }

        const p = this.prefix;
        const inputHeightStyle = "height: 50px !important;";

        const typeOptions = `
            <option value="Hizmet" selected>Hizmet</option>
            <option value="Masraf">Masraf</option>
            <option value="Kur Farkı">Kur Farkı</option>
            <option value="Resmi Ücret Farkı">Resmi Ücret Farkı</option>
            <option value="SWIFT Maliyeti">SWIFT Maliyeti</option>
            <option value="Diğer">Diğer</option>
        `;

        const subjectHtml = this.isFreestyle ? `
            <div class="form-group p-3 bg-white border rounded shadow-sm mb-3">
                <label class="font-weight-bold text-dark">Tahakkuk Konusu / Başlığı <span class="text-danger">*</span></label>
                <input type="text" id="${p}Subject" class="form-control border-primary" placeholder="Örn: Marka tescil belgesi posta masrafı..." style="${inputHeightStyle}">
            </div>
        ` : '';

        // 🔥 YENİ: Sadece Serbest Tahakkukta Çıkacak Olan Tekrarlayan Seçenekleri
        const recursiveHtml = this.isFreestyle ? `
            <div class="row mb-3 pb-3 border-bottom bg-light rounded pt-3 px-2 shadow-sm" style="border: 2px dashed #1e3c72 !important;">
                <div class="col-md-12 form-group">
                    <label class="font-weight-bold text-primary small">Tahakkuk Yapısı <span class="text-danger">*</span></label>
                    <select class="custom-select w-100 shadow-sm" id="${p}Structure" style="height: 45px; font-size: 14px; font-weight: 600; cursor: pointer;" required>
                        <option value="single">Tekil Tahakkuk (Sadece 1 kez oluşturulur)</option>
                        <option value="recursive">Tekrarlayan Tahakkuk (Seçilen periyotlarda otomatik oluşturulur)</option>
                    </select>
                </div>
                <div class="col-md-6 form-group ${p}recursive-field" style="display: none;">
                    <label class="font-weight-bold text-primary small">Tekrarlama Dönemi / Periyot <span class="text-danger">*</span></label>
                    <select class="custom-select w-100 shadow-sm" id="${p}Period" style="height: 45px; font-size: 14px; cursor: pointer;">
                        <option value="monthly">Aylık</option>
                        <option value="quarterly">3 Aylık</option>
                        <option value="biannually">6 Aylık</option>
                        <option value="annually">Yıllık</option>
                    </select>
                </div>
                <div class="col-md-6 form-group ${p}recursive-field" style="display: none;">
                    <label class="font-weight-bold text-primary small">İlk Başlama Tarihi <span class="text-danger">*</span></label>
                    <input type="date" class="form-control w-100 shadow-sm" id="${p}StartDate" style="height: 45px; font-size: 14px;">
                </div>
            </div>
        ` : '';

        const html = `
            ${recursiveHtml}
            <div class="row mb-3">
                <div class="col-md-4">
                    <div class="form-group mb-0 p-2 bg-light border rounded">
                        <label class="font-weight-bold text-primary mb-1">Tahakkuk Birimi</label>
                        <select id="${p}Department" class="form-control" style="font-weight: 600; border-color: #1e3c72; height: 50px !important; padding: 0 15px !important;">
                            <option value="EVREKA" selected>EVREKA (Marka/Patent)</option>
                            <option value="HUKUK">HUKUK Departmanı</option>
                        </select>
                    </div>
                </div>
                <div class="col-md-4">
                    <div class="form-group mb-0 p-2 bg-light border rounded">
                        <label class="font-weight-bold text-primary mb-1">Tahakkuk Türü</label>
                        <select id="${p}AccrualType" class="form-control" style="font-weight: 600; border-color: #1e3c72; height: 50px !important; padding: 0 15px !important;">
                            ${typeOptions}
                        </select>
                    </div>
                </div>
                <div class="col-md-4 d-flex flex-column justify-content-center">
                    <div class="form-group mb-0 p-2 w-100">
                        <label class="checkbox-label mb-2 font-weight-bold text-primary" style="cursor:pointer; display:flex; align-items:center;">
                            <input type="checkbox" id="${p}IsForeignTransaction" style="width:18px; height:18px; margin-right:10px;"> Yurtdışı İşlem
                        </label>
                        <label class="checkbox-label mb-0 font-weight-bold text-danger" style="cursor:pointer; display:flex; align-items:center;" title="Vekalet ücreti, avans iadesi vb. e-fatura kesilmeyecek işlemler için işaretleyin">
                            <input type="checkbox" id="${p}NotInvoiceable" style="width:18px; height:18px; margin-right:10px;"> Faturaya Tabi Değil
                        </label>
                    </div>
                </div>
            </div>

            ${subjectHtml}

            <div class="form-group mt-4 mb-4 p-3 border rounded shadow-sm" style="background-color: #fcfcfc;">
                <div class="d-flex justify-content-between align-items-center mb-3 border-bottom pb-2">
                    <label class="font-weight-bold text-primary mb-0" style="font-size: 1.1em;"><i class="fas fa-list-ol mr-2"></i>Fatura / Tahakkuk Kalemleri</label>
                    
                    <div class="d-flex align-items-center">
                        <button type="button" class="btn btn-sm btn-outline-primary mr-2 d-flex align-items-center justify-content-center" id="${p}AutoCalcBtn" style="${this.onAutoCalc ? '' : 'display:none;'} height: 34px; padding: 0 15px; font-weight: 600;">
                            <i class="fas fa-magic mr-2"></i>Otomatik Hesapla
                        </button>
                        <button type="button" class="btn btn-sm btn-success d-flex align-items-center justify-content-center" id="${p}AddLineItemBtn" style="height: 34px; padding: 0 15px; font-weight: 600;">
                            <i class="fas fa-plus mr-2"></i>Kalem Ekle
                        </button>
                    </div>
                </div>
                <div class="table-responsive" style="overflow-x: visible;">
                    <table class="table table-sm table-bordered mb-0">
                        <thead class="bg-light text-muted">
                            <tr>
                                <th style="width: 220px;">Türü</th>
                                <th>Kalem Açıklaması</th>
                                <th style="width: 70px;">Adet</th>
                                <th style="width: 110px;" id="${p}UnitPriceHeader">Birim Fiyat</th>
                                <th style="width: 90px;">KDV(%)</th>
                                <th style="width: 80px;">Birim</th>
                                <th style="width: 140px;" class="text-right">Toplam</th>
                                <th style="width: 50px;"></th>
                            </tr>
                        </thead>
                        <tbody id="${p}LineItemsBody">
                            </tbody>
                    </table>
                </div>
            </div>

            <div class="row mt-2 mb-3">
                <div class="col-md-6">
                    <div class="form-group">
                        <label class="text-secondary font-weight-bold" style="font-size:0.9rem;"><i class="fas fa-edit mr-2"></i>Tahakkuk Notu <small>(İç Bilgi)</small></label>
                        <textarea id="${p}AccrualDescription" class="form-control bg-light" rows="3" placeholder="Sadece sistemde görünür, faturaya yazılmaz."></textarea>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="form-group">
                        <label class="text-primary font-weight-bold" style="font-size:0.9rem;"><i class="fas fa-file-invoice mr-2"></i>Fatura Açıklaması <small>(Müşteriye Gider)</small></label>
                        <textarea id="${p}InvoiceDescription" class="form-control border-primary" rows="3" placeholder="Doğrudan faturada alt açıklama olarak yer alacak metin."></textarea>
                    </div>
                </div>
            </div>

            <div id="${p}EpatsDocumentContainer" class="alert alert-secondary align-items-center justify-content-between mb-4" style="display:none; border-left: 4px solid #1e3c72;">
                <div class="d-flex align-items-center">
                    <div class="icon-box mr-3 text-center" style="width: 40px;"><i class="fas fa-file-pdf text-danger fa-2x"></i></div>
                    <div>
                        <h6 class="mb-0 font-weight-bold text-dark" id="${p}EpatsDocName">Belge Adı</h6>
                        <small class="text-muted">İlgili EPATS Evrakı</small>
                    </div>
                </div>
                <a id="${p}EpatsDocLink" href="#" target="_blank" class="btn btn-sm btn-outline-primary shadow-sm"><i class="fas fa-external-link-alt mr-1"></i> Belgeyi Aç</a>
            </div>

            <div class="row mt-2">
                <div class="col-md-6">
                    <div class="form-group">
                        <label class="text-secondary font-weight-bold" style="font-size:0.9rem;">TPE Fatura No</label>
                        <input type="text" id="${p}TpeInvoiceNo" class="form-control" placeholder="Örn: TPE2023..." style="${inputHeightStyle}">
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="form-group">
                        <label class="text-secondary font-weight-bold" style="font-size:0.9rem;">EVREKA Fatura No</label>
                        <input type="text" id="${p}EvrekaInvoiceNo" class="form-control" placeholder="Örn: EVR2023..." style="${inputHeightStyle}">
                    </div>
                </div>
            </div>

            <div class="row mt-2" id="${p}OrderCodeContainer" style="display:none;">
                <div class="col-md-12">
                    <div class="form-group mb-0 p-3 bg-white border border-info rounded shadow-sm">
                        <label class="font-weight-bold text-info" style="font-size:0.9rem;">
                            <i class="fas fa-shopping-cart mr-2"></i>Sipariş Kodu / SAS No
                        </label>
                        <input type="text" id="${p}OrderCode" class="form-control border-info" placeholder="Müvekkilden gelen sipariş numarasını buraya girebilirsiniz..." style="${inputHeightStyle}">
                        <small class="text-muted italic">Bu müvekkil için fatura aşamasında SAS kodu istenmektedir.</small>
                    </div>
                </div>
            </div>
            
            <div id="${p}NetTotalDisplay" class="d-flex justify-content-between align-items-center mb-2 px-3" 
                 style="font-size: 1.0em; font-weight: 600; color: #475569; margin-top: 15px;">
                <span class="text-uppercase text-muted" style="font-size: 0.85em; letter-spacing: 1px;">ARA TOPLAM (KDV'SİZ)</span>
                <span id="${p}NetTotalValueContent">0.00 ₺</span>
            </div>

            <div id="${p}TotalAmountDisplay" class="d-flex justify-content-between align-items-center" 
                 style="font-size: 1.1em; font-weight: bold; color: #1e3c72; padding: 15px 20px; background-color: #e3f2fd; border: 1px solid #90caf9; border-radius: 10px;">
                <span class="text-uppercase text-muted" style="font-size: 0.85em; letter-spacing: 1px;">GENEL TOPLAM (KDV DAHİL)</span>
                <span id="${p}TotalValueContent">0.00 ₺</span>
            </div>

            <div class="form-group mt-3" id="${p}ForeignPaymentPartyContainer" style="display:none; background-color: #e3f2fd; padding: 10px; border-radius: 8px; border: 1px solid #90caf9;">
                <label class="text-primary font-weight-bold"><i class="fas fa-globe-americas mr-2"></i>Yurtdışı Ödeme Yapılacak Taraf</label>
                <div class="position-relative">
                    <input type="text" id="${p}ForeignPaymentPartySearch" class="form-control" placeholder="Yurtdışı tarafı ara..." style="${inputHeightStyle}">
                    <div id="${p}ForeignPaymentPartyResults" class="search-results-list" style="display:none; position:absolute; z-index:1000; width:100%; top:100%; left:0; background:white; border:1px solid #ccc; max-height:150px; overflow-y:auto;"></div>
                </div>
                <div id="${p}ForeignPaymentPartyDisplay" class="search-result-display" style="display:none; background:#e9f5ff; border:1px solid #bde0fe; padding:10px; margin-top:10px;"></div>
            </div>

            <div class="form-group mt-3 p-3 border rounded shadow-sm" style="${this.isFreestyle ? 'border-color:#1e3c72 !important; background:#f8fbff;' : ''}">
                <label class="${this.isFreestyle ? 'text-primary font-weight-bold' : ''}">Fatura Kesilecek Kişi (Müvekkil/TP) ${this.isFreestyle ? '<span class="text-danger">*</span>' : ''}</label>
                <div class="position-relative">
                    <input type="text" id="${p}TpInvoicePartySearch" class="form-control" placeholder="Kişi ara..." style="${inputHeightStyle}">
                    <div id="${p}TpInvoicePartyResults" class="search-results-list" style="display:none; position:absolute; z-index:1000; width:100%; top:100%; left:0; background:white; border:1px solid #ccc; max-height:150px; overflow-y:auto;"></div>
                </div>
                <div id="${p}TpInvoicePartyDisplay" class="search-result-display" style="display:none; background:#e9f5ff; border:1px solid #bde0fe; padding:10px; margin-top:10px;"></div>
            </div>
            
            <div class="form-group mt-3" id="${p}ForeignInvoiceContainer" style="display:none;">
                <label class="form-label font-weight-bold text-primary" id="${p}ForeignInvoiceTitleLabel"><i class="fas fa-file-pdf mr-2"></i>Yurtdışı Fatura/Debit (PDF)</label>
                <label for="${p}ForeignInvoiceFile" id="${p}ForeignInvoiceBtnLabel" class="custom-file-upload btn btn-outline-primary w-100" style="cursor:pointer; height: 50px; display:flex; align-items:center; justify-content:center; border-style: dashed; border-width: 2px;"><i class="fas fa-cloud-upload-alt mr-2"></i> Fatura PDF Seç / Değiştir</label>
                <input type="file" id="${p}ForeignInvoiceFile" accept="application/pdf" style="display:none;">
                <small id="${p}ForeignInvoiceFileName" class="text-primary font-weight-bold d-block mt-2 text-center"></small>
            </div>
        `;

        this.container.innerHTML = html;
        this.setupListeners();
    }

    setupListeners() {
        const p = this.prefix;

        // 🔥 YENİ: Tekrarlayan Tahakkuk Form Dinleyicisi
        if (this.isFreestyle) {
            const structureSelect = document.getElementById(`${p}Structure`);
            const recursiveFields = document.querySelectorAll(`.${p}recursive-field`);
            if (structureSelect) {
                structureSelect.addEventListener('change', (e) => {
                    const isRec = e.target.value === 'recursive';
                    recursiveFields.forEach(el => el.style.display = isRec ? 'block' : 'none');
                    
                    const startDateInput = document.getElementById(`${p}StartDate`);
                    if (isRec && startDateInput && !startDateInput.value) {
                        startDateInput.value = new Date().toISOString().split('T')[0];
                    }
                });
            }
        }

        const deptEl = document.getElementById(`${p}Department`);
        if (deptEl) {
            deptEl.addEventListener('change', (e) => {
                this.updateLineItemTypes(e.target.value);
                this.handleForeignToggle(); 
                this.updatePriceHeader(); // 🔥 Başlık Kontrolü
            });
        }
        
        const typeEl = document.getElementById(`${p}AccrualType`);
        if (typeEl) {
            typeEl.addEventListener('change', () => {
                this.handleForeignToggle(); 
                this.updatePriceHeader(); // 🔥 Başlık Kontrolü
            });
        }

        document.getElementById(`${p}IsForeignTransaction`)?.addEventListener('change', () => {
            this.handleForeignToggle();
            this.recalculateAllRows();
        });
        document.getElementById(`${p}ForeignInvoiceFile`)?.addEventListener('change', (e) => {
            const nameEl = document.getElementById(`${p}ForeignInvoiceFileName`);
            if (nameEl) nameEl.textContent = e.target.files[0] ? e.target.files[0].name : '';
        });

        document.getElementById(`${p}AddLineItemBtn`)?.addEventListener('click', () => this.addLineItem());
        const autoCalcBtn = document.getElementById(`${p}AutoCalcBtn`);
        if (autoCalcBtn) {
            autoCalcBtn.addEventListener('click', () => {
                if (this.onAutoCalc) {
                    this.onAutoCalc();
                } else {
                    const currentFormData = this.getData();
                    const activeFormData = currentFormData.success ? currentFormData.data : null;
                    
                    document.dispatchEvent(new CustomEvent('accrual-auto-calc-request', { 
                        detail: { 
                            accrualData: this.currentData,
                            formData: activeFormData 
                        } 
                    }));
                }
            });
        }

        this.setupSearch(`${p}TpInvoiceParty`, (person) => { 
            this.selectedTpParty = person; 
            this.checkSasRequirement(person);
            this.recalculateAllRows();
        });
        this.setupSearch(`${p}ForeignPaymentParty`, (person) => { 
            this.selectedForeignParty = person; 
            this.recalculateAllRows();
        });
    }

    updateLineItemTypes(department) {
        const p = this.prefix;
        const tbody = document.getElementById(`${p}LineItemsBody`);
        if (!tbody) return;

        let optionsHtml = '';
        if (department === 'HUKUK') {
            optionsHtml = `
                <option value="Hukuk Danışmanlık">Hukuk Danışmanlık Bedeli</option>
                <option value="Masraf">Masraf / Gider</option>
                <option value="Kur Farkı">Kur Farkı</option>
            `;
        } else {
            optionsHtml = `
                <option value="Hizmet">EVREKA Hizmeti</option>
                <option value="TP Harç">TP Harç</option>
                <option value="TP Hizmet">TP Hizmet</option>
                <option value="Masraf">Masraf / Diğer</option>
                <option value="Yurtdışı Maliyet">Yurtdışı Maliyet</option>
            `;
        }

        tbody.querySelectorAll('.item-type').forEach(selectEl => {
            selectEl.innerHTML = optionsHtml;
            selectEl.dispatchEvent(new Event('change'));
        });
    }

    updatePriceHeader() {
        const p = this.prefix;
        const dept = document.getElementById(`${p}Department`)?.value;
        const type = document.getElementById(`${p}AccrualType`)?.value;
        const headerEl = document.getElementById(`${p}UnitPriceHeader`);
        
        if (headerEl) {
            if (dept === 'HUKUK' && type === 'Hizmet') {
                headerEl.textContent = 'Net Tutar';
            } else {
                headerEl.textContent = 'Birim Fiyat';
            }
        }
    }

    checkSasRequirement(person) {
        const container = document.getElementById(`${this.prefix}OrderCodeContainer`);
        if (!container) return;

        if (person) {
            let pDetails = {};
            if (person.details) {
                pDetails = typeof person.details === 'string' ? JSON.parse(person.details) : person.details;
            }

            const requiresSAS = 
                person.requires_sas_code === true || 
                pDetails?.requires_sas_code === true || 
                pDetails?.sas_check === 'yes' || 
                pDetails?.sas_check === true;
            
            container.style.display = requiresSAS ? 'block' : 'none';
        } else {
            container.style.display = 'none';
        }
    }

    setCalculatedItems(items) {
        const tbody = document.getElementById(`${this.prefix}LineItemsBody`);
        if (!tbody) return;
        
        tbody.innerHTML = ''; 
        if (items && items.length > 0) items.forEach(item => this.addLineItem(item));
        else this.addLineItem(); 
        
        this.calculateTotal(); 
    }

    addLineItem(item = {}) {
        const tbody = document.getElementById(`${this.prefix}LineItemsBody`);
        const tr = document.createElement('tr');
        
        // 🔥 ÇÖZÜM: Çift tırnak ve tek tırnak işaretlerinin HTML'i bozmasını engelliyoruz (Encode işlemi)
        const safeItemName = (item.item_name || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        
        tr.innerHTML = `
            <td>
                <select class="form-control form-control-sm item-type font-weight-bold border-0 bg-transparent" style="height: 35px !important; padding: 4px 8px !important; font-size: 0.9rem;">
                    ${(document.getElementById(`${this.prefix}Department`)?.value === 'HUKUK') 
                        ? `
                            <option value="Hukuk Danışmanlık" ${item.fee_type === 'Hukuk Danışmanlık' ? 'selected' : ''}>Hukuk Danışmanlık Bedeli</option>
                            <option value="Masraf" ${item.fee_type === 'Masraf' ? 'selected' : ''}>Masraf / Gider</option>
                            <option value="Kur Farkı" ${item.fee_type === 'Kur Farkı' ? 'selected' : ''}>Kur Farkı</option>
                        ` 
                        : `
                            <option value="Hizmet" ${item.fee_type === 'Hizmet' ? 'selected' : ''}>EVREKA Hizmeti</option>
                            <option value="TP Harç" ${item.fee_type === 'TP Harç' ? 'selected' : ''}>TP Harç</option>
                            <option value="TP Hizmet" ${item.fee_type === 'TP Hizmet' ? 'selected' : ''}>TP Hizmet</option>
                            <option value="Masraf" ${item.fee_type === 'Masraf' ? 'selected' : ''}>Masraf/Diğer</option>
                            <option value="Yurtdışı Maliyet" ${item.fee_type === 'Yurtdışı Maliyet' ? 'selected' : ''}>Yurtdışı Maliyet</option>
                        `
                    }
                </select>
            </td>
            <td><input type="text" class="form-control form-control-sm item-name" value="${safeItemName}" placeholder="Açıklama giriniz..."></td>
            <td><input type="number" class="form-control form-control-sm item-qty text-center" value="${item.quantity || 1}" min="0.1" step="0.1"></td>
            <td><input type="number" class="form-control form-control-sm item-price text-right" value="${item.unit_price || 0}" min="0" step="0.01"></td>
            <td><input type="number" class="form-control form-control-sm item-vat text-center" value="${item.vat_rate !== undefined ? item.vat_rate : 20}" min="0" step="1"></td>
            <td>
                <select class="form-control form-control-sm item-currency" style="height: 35px !important; padding: 4px 8px !important;">
                    <option value="TRY" ${item.currency === 'TRY' ? 'selected' : ''}>TRY</option>
                    <option value="USD" ${item.currency === 'USD' ? 'selected' : ''}>USD</option>
                    <option value="EUR" ${item.currency === 'EUR' ? 'selected' : ''}>EUR</option>
                    <option value="CHF" ${item.currency === 'CHF' ? 'selected' : ''}>CHF</option>
                    <option value="GBP" ${item.currency === 'GBP' ? 'selected' : ''}>GBP</option>
                </select>
            </td>
            <td class="font-weight-bold text-right item-total align-middle text-dark">0.00</td>
            <td class="text-center align-middle">
                <button type="button" class="btn btn-sm btn-link text-danger p-0 delete-row-btn" title="Satırı Sil"><i class="fas fa-trash-alt"></i></button>
            </td>
        `;
        
        tbody.appendChild(tr);

        const updateRowStyle = () => {
            const type = tr.querySelector('.item-type').value;
            if (type === 'Hizmet' || type === 'Hukuk Danışmanlık') {
                tr.style.backgroundColor = '#f0fff4'; 
                tr.querySelector('.item-type').style.color = '#276749';
            } else if (type === 'TP Harç' || type === 'TP Hizmet') {
                tr.style.backgroundColor = '#ebf8ff'; 
                tr.querySelector('.item-type').style.color = '#2b6cb0';
            } else if (type === 'Yurtdışı Maliyet') {
                tr.style.backgroundColor = '#fff5f5'; 
                tr.querySelector('.item-type').style.color = '#c53030';
            } else {
                tr.style.backgroundColor = '#ffffff'; 
                tr.querySelector('.item-type').style.color = '#4a5568';
            }
        };

        const calcRow = () => {
            const qty = parseFloat(tr.querySelector('.item-qty').value) || 0;
            const price = parseFloat(tr.querySelector('.item-price').value) || 0;
            const vat = parseFloat(tr.querySelector('.item-vat').value) || 0;
            const currency = tr.querySelector('.item-currency').value;
            const type = tr.querySelector('.item-type').value;
            const dept = document.getElementById(`${this.prefix}Department`)?.value;
            
            let total = 0;
            let grossPrice = price; // Varsayılan olarak brüt = net kabul edilir

            // 🔥 SMM (Hukuk) Net -> Brüt Hesaplaması
            if (dept === 'HUKUK' && (type === 'Hukuk Danışmanlık' || type === 'Hizmet')) {
                const isForeign = document.getElementById(`${this.prefix}IsForeignTransaction`)?.checked || false;
                const activeParty = isForeign && this.selectedForeignParty ? this.selectedForeignParty : this.selectedTpParty;
                
                // Varsayılanı kurumsal (%20 stopaj) kabul ediyoruz. Müşteri TCKN ise (11 hane) bireyseldir, stopaj olmaz.
                let isCorporate = true; 
                if (activeParty) {
                    const taxNo = activeParty.taxNo || activeParty.tax_no || activeParty.tckn || '';
                    if (taxNo.length === 11) isCorporate = false;
                }

                if (isCorporate) {
                    grossPrice = price / 0.8; // Netten Brüte çevrim (Örn: 44.000 / 0.8 = 55.000)
                    // SMM Net Ödenecek = Brüt + KDV - Stopaj (%20)
                    total = (qty * grossPrice) * (1 + (vat / 100) - 0.20); 
                } else {
                    total = (qty * price) * (1 + (vat / 100)); // Bireyselde stopaj yok
                }
            } else {
                // Standart EVREKA veya Masraf Hesaplaması
                total = (qty * price) * (1 + vat / 100);
            }

            total = Number(total.toFixed(2));
            tr.querySelector('.item-total').textContent = new Intl.NumberFormat('tr-TR', {minimumFractionDigits: 2, maximumFractionDigits:2}).format(total);
            
            tr.dataset.rawQty = qty;
            tr.dataset.rawPrice = price; // Arayüzde yazan saf net rakam
            tr.dataset.grossPrice = grossPrice; // Hukuk için arka planda hesaplanan brüt matrah
            tr.dataset.calculatedTotal = total; // Satırın genel toplamı
            tr.dataset.rawVat = vat;
            tr.dataset.currency = currency;
            tr.dataset.type = type;
            
            this.calculateTotal(); 
            updateRowStyle(); 
        };

        tr.querySelectorAll('input, select').forEach(inp => inp.addEventListener('input', calcRow));
        tr.querySelector('.item-type').addEventListener('change', () => { 
            updateRowStyle(); 
            this.handleForeignToggle(); // Kalem türü değiştiğinde PDF yükleme alanını kontrol et
        }); 
        tr.querySelector('.delete-row-btn').addEventListener('click', () => { 
            tr.remove(); 
            this.calculateTotal(); 
            this.handleForeignToggle(); // Kalem silindiğinde PDF yükleme alanını kontrol et
        });
        
        calcRow(); 
        updateRowStyle();
    }

    recalculateAllRows() {
        const tbody = document.getElementById(`${this.prefix}LineItemsBody`);
        if (tbody) {
            tbody.querySelectorAll('tr').forEach(tr => {
                const qtyInp = tr.querySelector('.item-qty');
                if (qtyInp) qtyInp.dispatchEvent(new Event('input'));
            });
        }
    }

    calculateTotal() {
        const p = this.prefix;
        const tbody = document.getElementById(`${p}LineItemsBody`);
        const totalsMap = {}; 
        const netTotalsMap = {}; // 🔥 YENİ: KDV'siz net tutarları toplayacağımız obje

        // 🔥 ÇÖZÜM 2: Tevkifatı satırlarda değil, sadece Genel Toplamda (Listede) uyguluyoruz!
        const isForeign = document.getElementById(`${p}IsForeignTransaction`)?.checked || false;
        let activeParty = isForeign && this.selectedForeignParty ? this.selectedForeignParty : this.selectedTpParty;
        let isTevkifatli = activeParty ? (activeParty.has_tevkifat === true) : false;
        let hasTevkifatApplied = false;

        tbody.querySelectorAll('tr').forEach(tr => {
            const qty = parseFloat(tr.dataset.rawQty) || 0;
            const price = parseFloat(tr.dataset.rawPrice) || 0; // Formdaki Net rakam
            const grossPrice = parseFloat(tr.dataset.grossPrice) || price; // Hukuk için arka plandaki Brüt rakam
            const rowCalculatedTotal = parseFloat(tr.dataset.calculatedTotal) || 0; 
            const vat = parseFloat(tr.dataset.rawVat) || 0;
            const curr = tr.dataset.currency || 'TRY';
            const type = tr.dataset.type || 'Hizmet';
            const dept = document.getElementById(`${p}Department`)?.value;
            
            let actualAccrualTotal = rowCalculatedTotal;
            let netAmount = qty * grossPrice; // KDV'siz Ara Toplam (Matrah) SMM/Hukuk'ta her zaman Brüt üzerinden görünmelidir!

            // Tevkifat İndirimi SADECE Evreka departmanındaki hizmetlerde olur. (Hukuk'ta SMM stopajı kullanıldığı için tevkifat uygulanmaz)
            if (dept !== 'HUKUK') {
                let effectiveVat = vat;
                if (isTevkifatli && (type === 'Hizmet' || type === 'Hukuk Danışmanlık')) {
                    effectiveVat = vat * 0.1; // 9/10 kesinti
                    hasTevkifatApplied = true;
                    actualAccrualTotal = Number(((qty * price) * (1 + effectiveVat / 100)).toFixed(2));
                } else {
                    actualAccrualTotal = Number(((qty * price) * (1 + vat / 100)).toFixed(2));
                }
            } 

            if (netAmount > 0) {
                netTotalsMap[curr] = (netTotalsMap[curr] || 0) + netAmount;
            }

            if (actualAccrualTotal > 0) {
                totalsMap[curr] = (totalsMap[curr] || 0) + actualAccrualTotal;
            }
        });

        // 1. GENEL TOPLAMI (KDV DAHİL) YAZDIR
        const valueSpan = document.getElementById(`${p}TotalValueContent`);
        if (valueSpan) {
            const parts = Object.entries(totalsMap).map(([curr, amount]) => {
                return new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + ' ' + curr;
            });

            let noteHtml = hasTevkifatApplied ? ' <small class="text-danger ml-2" style="font-size: 0.65em;">(Tevkifatlı Tahsilat)</small>' : '';

            if (parts.length === 0) {
                valueSpan.innerHTML = '0.00 TRY';
            } else {
                valueSpan.innerHTML = `<span class="text-primary font-weight-bold">${parts.join(' + ')}</span>${noteHtml}`;
            }
        }

        // 🔥 YENİ: 2. KDV'SİZ ARA TOPLAMI YAZDIR
        const netValueSpan = document.getElementById(`${p}NetTotalValueContent`);
        if (netValueSpan) {
            const netParts = Object.entries(netTotalsMap).map(([curr, amount]) => {
                return new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + ' ' + curr;
            });

            if (netParts.length === 0) {
                netValueSpan.innerHTML = '0.00 TRY';
            } else {
                netValueSpan.innerHTML = netParts.join(' + ');
            }
        }
    }

    setupSearch(baseId, onSelect) {
        const input = document.getElementById(`${baseId}Search`);
        const results = document.getElementById(`${baseId}Results`);
        const display = document.getElementById(`${baseId}Display`);

        if (!input || !results || !display) return;

        input.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            if (query.length < 2) { results.style.display = 'none'; return; }

            const filtered = this.allPersons.filter(p => 
                (p.name && p.name.toLowerCase().includes(query)) || 
                (p.email && p.email.toLowerCase().includes(query))
            ).slice(0, 10);

            if (filtered.length === 0) {
                results.innerHTML = '<div style="padding:10px; color:#999;">Sonuç bulunamadı</div>';
            } else {
                results.innerHTML = filtered.map(person => `
                    <div class="search-result-item" style="padding:10px; cursor:pointer; border-bottom:1px solid #eee;" data-id="${person.id}">
                        <strong>${person.name}</strong><br><small>${person.email || ''}</small>
                    </div>
                `).join('');

                results.querySelectorAll('.search-result-item').forEach(item => {
                    item.addEventListener('click', () => {
                        const pid = item.dataset.id;
                        const person = this.allPersons.find(p => String(p.id) === String(pid));
                        
                        onSelect(person);
                        
                        input.value = '';
                        results.style.display = 'none';
                        display.innerHTML = `
                            <div class="d-flex justify-content-between align-items-center">
                                <span><i class="fas fa-check-circle text-success mr-2"></i> ${person.name}</span>
                                <span class="remove-selection text-danger" style="cursor:pointer; font-weight:bold;">&times;</span>
                            </div>`;
                        display.style.display = 'block';

                        display.querySelector('.remove-selection').addEventListener('click', () => {
                            onSelect(null);
                            display.style.display = 'none';
                            display.innerHTML = '';
                        });
                    });
                });
            }
            results.style.display = 'block';
        });

        document.addEventListener('click', (e) => {
            if (!results.contains(e.target) && e.target !== input) {
                results.style.display = 'none';
            }
        });
    }

    handleForeignToggle() {
        const p = this.prefix;
        const isForeign = document.getElementById(`${p}IsForeignTransaction`)?.checked || false;
        
        // 🔥 HUKUK Departmanı ve Masraf seçilme durumunu kontrol et
        const deptVal = document.getElementById(`${p}Department`)?.value || '';
        const typeVal = document.getElementById(`${p}AccrualType`)?.value || '';

        // 1. KURAL: Evreka ve Masraf seçildiyse
        const isEvrekaMasraf = (deptVal === 'EVREKA' && typeVal === 'Masraf');

        // 2. KURAL: Kalemlerde 'Masraf' seçildiyse
        let hasMasrafItem = false;
        const tbody = document.getElementById(`${p}LineItemsBody`);
        if (tbody) {
            tbody.querySelectorAll('.item-type').forEach(select => {
                if (select.value === 'Masraf') hasMasrafItem = true;
            });
        }

        // Masraf Dekontu Yükleme Alanı Gösterim Şartı
        const showMasrafDekontu = isEvrekaMasraf || hasMasrafItem;

        const foreignPartyDiv = document.getElementById(`${p}ForeignPaymentPartyContainer`);
        const fileDiv = document.getElementById(`${p}ForeignInvoiceContainer`);
        
        const titleLabel = document.getElementById(`${p}ForeignInvoiceTitleLabel`);
        const btnLabel = document.getElementById(`${p}ForeignInvoiceBtnLabel`);

        if (foreignPartyDiv) {
            foreignPartyDiv.style.display = isForeign ? 'block' : 'none';
        }

        if (fileDiv) {
            if (isForeign || showMasrafDekontu) {
                fileDiv.style.display = 'block';
                
                if (showMasrafDekontu && !isForeign) {
                    if (titleLabel) titleLabel.innerHTML = '<i class="fas fa-file-invoice-dollar mr-2 text-warning"></i>Masraf Dekontu (PDF)';
                    if (btnLabel) btnLabel.innerHTML = '<i class="fas fa-cloud-upload-alt mr-2"></i> Dekont PDF Seç / Değiştir';
                } else {
                    if (titleLabel) titleLabel.innerHTML = '<i class="fas fa-file-pdf mr-2"></i>Yurtdışı Fatura/Debit (PDF)';
                    if (btnLabel) btnLabel.innerHTML = '<i class="fas fa-cloud-upload-alt mr-2"></i> Fatura PDF Seç / Değiştir';
                }
            } else {
                fileDiv.style.display = 'none';
            }
        }
    }

    reset() {
        this.originalRemainingAmount = null;
        const p = this.prefix;
        
        this.container.querySelectorAll('input').forEach(i => {
            if(i.type === 'checkbox') i.checked = false;
            else if(i.type !== 'hidden') i.value = '';
        });
        
        // 🔥 YENİ: Tekrarlayan ayarlarını sıfırla
        if (this.isFreestyle && document.getElementById(`${p}Structure`)) {
            document.getElementById(`${p}Structure`).value = 'single';
            document.getElementById(`${p}Structure`).dispatchEvent(new Event('change'));
        }

        document.getElementById(`${p}AccrualType`).value = this.isFreestyle ? 'Masraf' : 'Hizmet';
        
        if (document.getElementById(`${p}Department`)) {
            document.getElementById(`${p}Department`).value = 'EVREKA';
            this.updateLineItemTypes('EVREKA'); 
        }

        if (this.isFreestyle && document.getElementById(`${p}Subject`)) document.getElementById(`${p}Subject`).value = '';

        document.getElementById(`${p}LineItemsBody`).innerHTML = '';
        this.addLineItem(); 

        document.getElementById(`${p}TpeInvoiceNo`).value = '';
        document.getElementById(`${p}EvrekaInvoiceNo`).value = '';
        if (document.getElementById(`${p}OrderCode`)) document.getElementById(`${p}OrderCode`).value = '';
        if (document.getElementById(`${p}OrderCodeContainer`)) document.getElementById(`${p}OrderCodeContainer`).style.display = 'none';
        
        if (document.getElementById(`${p}AccrualDescription`)) document.getElementById(`${p}AccrualDescription`).value = '';
        if (document.getElementById(`${p}InvoiceDescription`)) document.getElementById(`${p}InvoiceDescription`).value = '';

        this.selectedTpParty = null;
        this.selectedForeignParty = null;
        
        if (document.getElementById(`${p}TpInvoicePartyDisplay`)) {
            document.getElementById(`${p}TpInvoicePartyDisplay`).innerHTML = '';
            document.getElementById(`${p}TpInvoicePartyDisplay`).style.display = 'none';
        }
        
        if (document.getElementById(`${p}ForeignPaymentPartyDisplay`)) {
            document.getElementById(`${p}ForeignPaymentPartyDisplay`).innerHTML = '';
            document.getElementById(`${p}ForeignPaymentPartyDisplay`).style.display = 'none';
        }
        
        if (document.getElementById(`${p}ForeignInvoiceFileName`)) document.getElementById(`${p}ForeignInvoiceFileName`).textContent = '';
        if (document.getElementById(`${p}EpatsDocumentContainer`)) document.getElementById(`${p}EpatsDocumentContainer`).style.display = 'none';
        if (document.getElementById(`${p}NotInvoiceable`)) document.getElementById(`${p}NotInvoiceable`).checked = false;

        this.handleForeignToggle();
        this.updatePriceHeader();
        this.calculateTotal();
        this.setReadOnlyState(false);
    }

    setData(data) {
        const p = this.prefix;
        if(!data) return;
        
        this.currentData = data; 
        this.originalRemainingAmount = data.remainingAmount || null;

        if (this.isFreestyle && document.getElementById(`${p}Structure`)) {
            document.getElementById(`${p}Structure`).value = data.structure || 'single';
            document.getElementById(`${p}Structure`).dispatchEvent(new Event('change'));
            if (data.period) document.getElementById(`${p}Period`).value = data.period;
            if (data.startDate) document.getElementById(`${p}StartDate`).value = data.startDate;
        }

        document.getElementById(`${p}AccrualType`).value = data.type || data.accrualType || (this.isFreestyle ? 'Masraf' : 'Hizmet');
        
        if (document.getElementById(`${p}Department`)) {
            const dept = data.department || 'EVREKA';
            document.getElementById(`${p}Department`).value = dept;
            this.updateLineItemTypes(dept); 
        }

        if (this.isFreestyle && data.subject && document.getElementById(`${p}Subject`)) document.getElementById(`${p}Subject`).value = data.subject;

        document.getElementById(`${p}TpeInvoiceNo`).value = data.tpeInvoiceNo || '';
        document.getElementById(`${p}EvrekaInvoiceNo`).value = data.evrekaInvoiceNo || '';
        if (document.getElementById(`${p}OrderCode`)) document.getElementById(`${p}OrderCode`).value = data.orderCode || data.order_code || '';

        const descInput = document.getElementById(`${p}AccrualDescription`);
        if (descInput) descInput.value = data.description || data.foreignDescription || '';
        
        // 🔥 YENİ EKLENEN
        const invDescInput = document.getElementById(`${p}InvoiceDescription`);
        if (invDescInput) invDescInput.value = data.invoice_description || data.invoiceDescription || '';

        const tbody = document.getElementById(`${p}LineItemsBody`);
        tbody.innerHTML = '';
        
        if (data.items && data.items.length > 0) {
            data.items.forEach(item => this.addLineItem(item));
        } else {
            let hasRows = false;
            if (data.officialFee && data.officialFee.amount > 0) {
                this.addLineItem({
                    fee_type: 'TP Harç', item_name: 'Resmi Harç / Ücret',
                    quantity: 1, unit_price: data.officialFee.amount, 
                    vat_rate: data.applyVatToOfficialFee ? (data.vatRate || 20) : 0, currency: data.officialFee.currency
                });
                hasRows = true;
            }
            if (data.serviceFee && data.serviceFee.amount > 0) {
                this.addLineItem({
                    fee_type: 'Hizmet', item_name: 'Hizmet / Danışmanlık Bedeli',
                    quantity: 1, unit_price: data.serviceFee.amount, 
                    vat_rate: data.vatRate || 20, currency: data.serviceFee.currency
                });
                hasRows = true;
            }
            if (!hasRows) this.addLineItem(); 
        }

        const nameEl = document.getElementById(`${p}ForeignInvoiceFileName`);
        if (data.files && data.files.length > 0) {
            const f = data.files[0];
            if (nameEl) {
                nameEl.innerHTML = `
                    <a href="${f.url}" target="_blank" class="text-primary font-weight-bold" style="text-decoration: underline;">
                        <i class="fas fa-file-pdf text-danger mr-1"></i> ${f.name}
                    </a>
                    <br><small class="text-muted font-weight-normal">(Yeni dosya seçerseniz mevcut dosyanın üzerine yazılır)</small>
                `;
            }
        } else {
            if (nameEl) nameEl.innerHTML = '';
        }

        if (data.tpInvoiceParty) {
            // 🔥 ÇÖZÜM 1: Sadece ismini değil, müşterinin tevkifatlı olup olmadığı bilgisini de ana hafızadan çekiyoruz!
            const fullPerson = this.allPersons.find(p => String(p.id) === String(data.tpInvoiceParty.id));
            this.selectedTpParty = fullPerson || data.tpInvoiceParty; 
            this.manualSelectDisplay(`${p}TpInvoiceParty`, data.tpInvoiceParty);
            this.checkSasRequirement(this.selectedTpParty);
        }
        
        let isForeign = false;
        if (data.serviceInvoiceParty && (!data.tpInvoiceParty || data.serviceInvoiceParty.id !== data.tpInvoiceParty.id)) {
            isForeign = true;
            const fullForeignPerson = this.allPersons.find(p => String(p.id) === String(data.serviceInvoiceParty.id));
            this.selectedForeignParty = fullForeignPerson || data.serviceInvoiceParty; 
            this.manualSelectDisplay(`${p}ForeignPaymentParty`, data.serviceInvoiceParty);
        } else if (data.isForeignTransaction) {
            isForeign = true;
        }

        if (document.getElementById(`${p}IsForeignTransaction`)) {
            document.getElementById(`${p}IsForeignTransaction`).checked = isForeign;
        }

        if (document.getElementById(`${p}NotInvoiceable`)) {
            document.getElementById(`${p}NotInvoiceable`).checked = (data.requiresInvoice === false);
        }
        
        this.handleForeignToggle();
        this.updatePriceHeader();
        this.recalculateAllRows();
        this.calculateTotal();
        this.setReadOnlyState(data.status === 'paid');
    }

    manualSelectDisplay(baseId, person) {
        const display = document.getElementById(`${baseId}Display`);
        const input = document.getElementById(`${baseId}Search`);
        if(!display) return;
        
        input.value = '';
        display.innerHTML = `
            <div class="d-flex justify-content-between align-items-center">
                <span><i class="fas fa-check-circle text-success mr-2"></i> ${person.name}</span>
                <span class="remove-selection text-danger" style="cursor:pointer; font-weight:bold;">&times;</span>
            </div>`;
        display.style.display = 'block';
        
        display.querySelector('.remove-selection').addEventListener('click', () => {
            if(baseId.includes('Tp')) this.selectedTpParty = null;
            else this.selectedForeignParty = null;
            display.style.display = 'none';
            display.innerHTML = '';
        });
    }

    getData() {
        const p = this.prefix;
        
        const accrualType = document.getElementById(`${p}AccrualType`).value;
        const department = document.getElementById(`${p}Department`)?.value || 'EVREKA';
        let subjectText = '';

        // 🔥 YENİ: Tekrarlayan Seçenekleri Kaydetme
        const structure = document.getElementById(`${p}Structure`)?.value || 'single';
        const period = document.getElementById(`${p}Period`)?.value || null;
        const startDate = document.getElementById(`${p}StartDate`)?.value || null;

        if (this.isFreestyle) {
            subjectText = document.getElementById(`${p}Subject`)?.value.trim() || '';
            if (!subjectText) return { success: false, error: 'Lütfen Serbest Tahakkuk için Konu/Başlık girin.' };
            if (!this.selectedTpParty) return { success: false, error: 'Lütfen fatura kesilecek müvekkili (kişiyi) seçin.' };
        }

        const tpeInvoiceNo = document.getElementById(`${p}TpeInvoiceNo`).value.trim();
        const evrekaInvoiceNo = document.getElementById(`${p}EvrekaInvoiceNo`).value.trim();
        const orderCode = document.getElementById(`${p}OrderCode`)?.value.trim() || null;

        const items = [];
        let fallbackOffAmount = 0; 
        let fallbackSrvAmount = 0;
        const totalsMap = {};

        // 🔥 YENİ: Tevkifat kontrolü için aktif müşteriyi belirliyoruz
        const isForeignForData = document.getElementById(`${p}IsForeignTransaction`)?.checked || false;
        const tpPartyForData = this.selectedTpParty;
        const servicePartyForData = isForeignForData && this.selectedForeignParty ? this.selectedForeignParty : tpPartyForData;
        let isTevkifatliData = servicePartyForData ? (servicePartyForData.has_tevkifat === true) : false;

        document.querySelectorAll(`#${p}LineItemsBody tr`).forEach(tr => {
            const fee_type = tr.querySelector('.item-type').value;
            const item_name = tr.querySelector('.item-name').value.trim();
            const quantity = parseFloat(tr.querySelector('.item-qty').value) || 0;
            const unit_price = parseFloat(tr.querySelector('.item-price').value) || 0;
            const vat_rate = parseFloat(tr.querySelector('.item-vat').value) || 0;
            const currency = tr.querySelector('.item-currency').value;

            if (item_name && quantity > 0) {
                // Fatura kalemleri için normal KDV'li (örn: %20) toplam tutar kaydedilir
                const item_normal_total = Number(((quantity * unit_price) * (1 + vat_rate / 100)).toFixed(2));
                
                // Tahakkuk Listesi Genel Toplamı için Tevkifatlı (örn: %2) tutar hesaplanır
                let effectiveVat = vat_rate;
                if (isTevkifatliData && (fee_type === 'Hizmet' || fee_type === 'Hukuk Danışmanlık')) {
                    effectiveVat = vat_rate * 0.1; 
                }
                const accrual_actual_total = Number(((quantity * unit_price) * (1 + effectiveVat / 100)).toFixed(2));
                
                // 🔥 ÇÖZÜM 3: Satırlarda normal_total gösterilir
                items.push({ fee_type, item_name, quantity, unit_price, vat_rate, total_amount: item_normal_total, currency });
                
                // Ana listede (totalsMap) gerçek tahsil edilecek tutar gösterilir
                totalsMap[currency] = (totalsMap[currency] || 0) + accrual_actual_total;

                const preVatAmount = quantity * unit_price;
                if (fee_type.includes('Harç') || fee_type === 'Yurtdışı Maliyet') fallbackOffAmount += preVatAmount;
                else fallbackSrvAmount += preVatAmount;
            }
        });

        if (items.length === 0) {
            return { success: false, error: 'Fatura oluşturabilmek için en az 1 tane geçerli kalem (satır) girmelisiniz.' };
        }

        const isForeign = document.getElementById(`${p}IsForeignTransaction`)?.checked || false;
        const isNotInvoiceable = document.getElementById(`${p}NotInvoiceable`)?.checked || false;
        const accrualDesc = document.getElementById(`${p}AccrualDescription`)?.value.trim() || '';
        const invoiceDesc = document.getElementById(`${p}InvoiceDescription`)?.value.trim() || ''; // 🔥 Eklendi
        
        const fileInput = document.getElementById(`${p}ForeignInvoiceFile`);
        const files = fileInput?.files;
        const foreignFile = fileInput && fileInput.files.length > 0 ? fileInput.files[0] : null;

        const tpParty = this.selectedTpParty ? { id: this.selectedTpParty.id, name: this.selectedTpParty.name } : null;
        let serviceParty = null;

        if (isForeign && this.selectedForeignParty) {
            serviceParty = { id: this.selectedForeignParty.id, name: this.selectedForeignParty.name };
        } else {
            serviceParty = tpParty;
        }

        const totalAmountArray = Object.entries(totalsMap).map(([curr, amt]) => ({ amount: amt, currency: curr }));

        // 🔥 ÇÖZÜM 2: Eğer tahakkuk henüz hiç ödenmediyse, fiyattaki (Tevkifat) değişikliği doğrudan Kalan Tutara da (Listeye) yansıt!
        let finalRemaining = this.originalRemainingAmount || totalAmountArray;
        if (!this.currentData || this.currentData.status === 'unpaid') {
            finalRemaining = totalAmountArray;
        }

        return {
            success: true,
            data: {
                structure: structure,    
                period: period,          
                startDate: startDate,    

                type: accrualType, 
                accrualType: accrualType, 
                department: department,
                subject: subjectText, 
                isFreestyle: this.isFreestyle, 
                
                items: items, 
                
                officialFee: { amount: fallbackOffAmount, currency: 'TRY' },
                serviceFee: { amount: fallbackSrvAmount, currency: 'TRY' },
                vatRate: items.length > 0 ? items[0].vat_rate : 20, 
                applyVatToOfficialFee: false, 
                
                totalAmount: totalAmountArray, 
                remainingAmount: finalRemaining,
                
                tpInvoicePartyId: tpParty ? tpParty.id : null,
                serviceInvoicePartyId: serviceParty ? serviceParty.id : null,
                tpInvoiceParty: tpParty,
                serviceInvoiceParty: serviceParty,
                isForeignTransaction: isForeign,
                requiresInvoice: !isNotInvoiceable,
                tpeInvoiceNo: tpeInvoiceNo,
                evrekaInvoiceNo: evrekaInvoiceNo,
                orderCode: orderCode,
                description: accrualDesc,    
                invoice_description: invoiceDesc,       
                foreignInvoiceFile: foreignFile,    
                files: files                        
            }
        };
    }

    setReadOnlyState(isPaid) {
        const p = this.prefix;
        
        const elementsToToggle = [
            `${p}Structure`, `${p}Period`, `${p}StartDate`, // 🔥 YENİ EKLENDİ
            `${p}Department`,
            `${p}AccrualType`, `${p}IsForeignTransaction`, `${p}Subject`, `${p}AccrualDescription`, `${p}InvoiceDescription`,
            `${p}TpInvoicePartySearch`, `${p}ForeignPaymentPartySearch`, `${p}ForeignInvoiceFile`,
            `${p}AddLineItemBtn`, `${p}AutoCalcBtn`, `${p}OrderCode`
        ];

        elementsToToggle.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.disabled = isPaid;
                if (el.type !== 'checkbox' && !el.id.includes('Btn')) {
                    el.style.backgroundColor = isPaid ? '#e9ecef' : ''; 
                }
            }
        });

        const tbody = document.getElementById(`${p}LineItemsBody`);
        if (tbody) {
            tbody.querySelectorAll('input, select, button').forEach(el => {
                el.disabled = isPaid;
            });
        }

        const fileLabel = this.container.querySelector(`label[for="${p}ForeignInvoiceFile"]`);
        if (fileLabel) {
            fileLabel.style.pointerEvents = isPaid ? 'none' : 'auto';
            fileLabel.style.opacity = isPaid ? '0.5' : '1';
        }

        const removeBtns = this.container.querySelectorAll('.remove-selection');
        removeBtns.forEach(btn => {
            btn.style.display = isPaid ? 'none' : 'inline-block';
        });
        
        let warningMsg = document.getElementById(`${p}PaidWarningMessage`);
        if (isPaid) {
            if (!warningMsg) {
                warningMsg = document.createElement('div');
                warningMsg.id = `${p}PaidWarningMessage`;
                warningMsg.className = 'alert alert-warning p-2 text-center mb-3 font-weight-bold';
                warningMsg.innerHTML = '<i class="fas fa-lock mr-2"></i> Bu tahakkuk ödendiği için sadece <u>Fatura Numaraları</u> güncellenebilir.';
                this.container.prepend(warningMsg);
            }
            warningMsg.style.display = 'block';
        } else {
            if (warningMsg) warningMsg.style.display = 'none';
        }
    }
    
    showEpatsDoc(docOrTask) {
        const p = this.prefix;
        const container = document.getElementById(`${p}EpatsDocumentContainer`);
        if (!container) return;

        const nameEl = document.getElementById(`${p}EpatsDocName`);
        const linkEl = document.getElementById(`${p}EpatsDocLink`);

        let finalDoc = null;

        if (docOrTask && (docOrTask.url || docOrTask.downloadURL || docOrTask.fileUrl)) {
            finalDoc = docOrTask;
        } 
        else if (docOrTask) {
            if (docOrTask.details && Array.isArray(docOrTask.details.documents)) {
                finalDoc = docOrTask.details.documents.find(d => d.type === 'epats_document');
            }
            if (!finalDoc && Array.isArray(docOrTask.documents)) {
                finalDoc = docOrTask.documents.find(d => d.type === 'epats_document');
            }
            if (!finalDoc && docOrTask.details && docOrTask.details.epatsDocument) {
                finalDoc = docOrTask.details.epatsDocument;
            }
            if (!finalDoc && docOrTask.epatsDocument) {
                finalDoc = docOrTask.epatsDocument;
            }
        }

        if (!finalDoc || (!finalDoc.url && !finalDoc.downloadURL && !finalDoc.fileUrl)) {
            container.style.setProperty('display', 'none', 'important');
            if (nameEl) nameEl.textContent = 'Belge Adı';
            if (linkEl) linkEl.href = '#';
            return;
        }

        const fileUrl = finalDoc.url || finalDoc.downloadURL || finalDoc.fileUrl;
        if (nameEl) nameEl.textContent = finalDoc.name || finalDoc.fileName || 'EPATS Belgesi';
        if (linkEl) linkEl.href = fileUrl;
        
        container.style.setProperty('display', 'flex', 'important');
    }
}