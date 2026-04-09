// public/js/components/AccrualFormManager.js

export class AccrualFormManager {
    constructor(containerId, prefix, allPersons = [], options = {}) {
        this.container = document.getElementById(containerId);
        this.prefix = prefix;
        this.allPersons = allPersons;
        this.isFreestyle = options.isFreestyle || false; 
        
        this.selectedTpParty = null;
        this.selectedForeignParty = null;
    }

    render() {
        if (!this.container) return;

        const p = this.prefix;
        const inputHeightStyle = "height: 50px !important;";

        const typeOptions = this.isFreestyle ? `
            <option value="Masraf" selected>Masraf</option>
            <option value="Kur Farkı">Kur Farkı</option>
            <option value="Resmi Ücret Farkı">Resmi Ücret Farkı</option>
            <option value="SWIFT Maliyeti">SWIFT Maliyeti</option>
            <option value="Diğer">Diğer</option>
        ` : `
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

        const html = `
            <div class="row mb-3">
                <div class="col-md-6">
                    <div class="form-group mb-0 p-2 bg-light border rounded">
                        <label class="font-weight-bold text-primary mb-1">Tahakkuk Türü</label>
                        <select id="${p}AccrualType" class="form-control" style="font-weight: 600; border-color: #1e3c72; height: 50px !important; padding: 0 15px !important;">
                            ${typeOptions}
                        </select>
                    </div>
                </div>
                <div class="col-md-6 d-flex align-items-center">
                    <div class="form-group mb-0 p-2 w-100">
                        <label class="checkbox-label mb-0 font-weight-bold text-primary" style="cursor:pointer; display:flex; align-items:center;">
                            <input type="checkbox" id="${p}IsForeignTransaction" style="width:18px; height:18px; margin-right:10px;"> Yurtdışı İşlem
                        </label>
                    </div>
                </div>
            </div>

            ${subjectHtml}

            <div class="form-group mt-4 mb-4 p-3 border rounded shadow-sm" style="background-color: #fcfcfc;">
                <div class="d-flex justify-content-between align-items-center mb-3 border-bottom pb-2">
                    <label class="font-weight-bold text-primary mb-0" style="font-size: 1.1em;"><i class="fas fa-list-ol mr-2"></i>Fatura / Tahakkuk Kalemleri</label>
                    <div>
                        <button type="button" class="btn btn-sm btn-outline-primary mr-2" id="${p}AutoCalcBtn" style="display:none;"><i class="fas fa-magic mr-1"></i>Otomatik Hesapla</button>
                        <button type="button" class="btn btn-sm btn-success" id="${p}AddLineItemBtn"><i class="fas fa-plus mr-1"></i>Kalem Ekle</button>
                    </div>
                </div>
                <div class="table-responsive">
                    <table class="table table-sm table-bordered bg-white mb-0">
                        <thead class="bg-light text-muted">
                            <tr>
                                <th style="width: 130px;">Türü</th>
                                <th>Kalem Açıklaması</th>
                                <th style="width: 80px;">Adet</th>
                                <th style="width: 120px;">Birim Fiyat</th>
                                <th style="width: 80px;">KDV(%)</th>
                                <th style="width: 100px;">Para Birimi</th>
                                <th style="width: 120px;" class="text-right">Toplam</th>
                                <th style="width: 40px;"></th>
                            </tr>
                        </thead>
                        <tbody id="${p}LineItemsBody">
                            </tbody>
                    </table>
                </div>
            </div>

            <div class="form-group mt-2 mb-3">
                <label class="text-secondary font-weight-bold" style="font-size:0.9rem;"><i class="fas fa-edit mr-2"></i>Tahakkuk Açıklaması / Notu</label>
                <textarea id="${p}AccrualDescription" class="form-control" rows="2" placeholder="Detaylı notlar veya referans bilgisi giriniz..."></textarea>
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
            
            <div id="${p}TotalAmountDisplay" class="d-flex justify-content-between align-items-center" 
                 style="font-size: 1.1em; font-weight: bold; color: #1e3c72; margin-top: 15px; padding: 15px 20px; background-color: #e3f2fd; border: 1px solid #90caf9; border-radius: 10px;">
                <span class="text-uppercase text-muted" style="font-size: 0.85em; letter-spacing: 1px;">GENEL TOPLAM</span>
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
                <label class="form-label font-weight-bold text-primary"><i class="fas fa-file-pdf mr-2"></i>Yurtdışı Fatura/Debit (PDF)</label>
                <label for="${p}ForeignInvoiceFile" class="custom-file-upload btn btn-outline-primary w-100" style="cursor:pointer; height: 50px; display:flex; align-items:center; justify-content:center; border-style: dashed; border-width: 2px;"><i class="fas fa-cloud-upload-alt mr-2"></i> Fatura PDF Seç / Değiştir</label>
                <input type="file" id="${p}ForeignInvoiceFile" accept="application/pdf" style="display:none;">
                <small id="${p}ForeignInvoiceFileName" class="text-primary font-weight-bold d-block mt-2 text-center"></small>
            </div>
        `;

        this.container.innerHTML = html;
        this.setupListeners();
    }

    setupListeners() {
        const p = this.prefix;

        document.getElementById(`${p}IsForeignTransaction`)?.addEventListener('change', () => this.handleForeignToggle());

        document.getElementById(`${p}ForeignInvoiceFile`)?.addEventListener('change', (e) => {
            const nameEl = document.getElementById(`${p}ForeignInvoiceFileName`);
            if (nameEl) nameEl.textContent = e.target.files[0] ? e.target.files[0].name : '';
        });

        // 🔥 YENİ: Kalem Ekleme Butonu
        document.getElementById(`${p}AddLineItemBtn`)?.addEventListener('click', () => this.addLineItem());

        this.setupSearch(`${p}TpInvoiceParty`, (person) => { this.selectedTpParty = person; });
        this.setupSearch(`${p}ForeignPaymentParty`, (person) => { this.selectedForeignParty = person; });
    }

    // 🔥 YENİ: Tabloya Dinamik Satır Ekleme Fonksiyonu
    addLineItem(item = {}) {
        const tbody = document.getElementById(`${this.prefix}LineItemsBody`);
        const tr = document.createElement('tr');
        
        tr.innerHTML = `
            <td>
                <select class="form-control form-control-sm item-type">
                    <option value="Hizmet" ${item.fee_type === 'Hizmet' ? 'selected' : ''}>Hizmet Bedeli</option>
                    <option value="TP Harç" ${item.fee_type === 'TP Harç' ? 'selected' : ''}>TP Harç</option>
                    <option value="TP Hizmet" ${item.fee_type === 'TP Hizmet' ? 'selected' : ''}>TP Hizmet</option>
                </select>
            </td>
            <td>
                <input type="text" class="form-control form-control-sm item-name" value="${item.item_name || ''}" placeholder="Açıklama giriniz...">
            </td>
            <td>
                <input type="number" class="form-control form-control-sm item-qty text-center" value="${item.quantity || 1}" min="0.1" step="0.1">
            </td>
            <td>
                <input type="number" class="form-control form-control-sm item-price text-right" value="${item.unit_price || 0}" min="0" step="0.01">
            </td>
            <td>
                <input type="number" class="form-control form-control-sm item-vat text-center" value="${item.vat_rate !== undefined ? item.vat_rate : 20}" min="0" step="1">
            </td>
            <td>
                <select class="form-control form-control-sm item-currency">
                    <option value="TRY" ${item.currency === 'TRY' ? 'selected' : ''}>TRY</option>
                    <option value="USD" ${item.currency === 'USD' ? 'selected' : ''}>USD</option>
                    <option value="EUR" ${item.currency === 'EUR' ? 'selected' : ''}>EUR</option>
                    <option value="GBP" ${item.currency === 'GBP' ? 'selected' : ''}>GBP</option>
                </select>
            </td>
            <td class="font-weight-bold text-right item-total align-middle text-primary">0.00 ₺</td>
            <td class="text-center align-middle">
                <button type="button" class="btn btn-sm btn-link text-danger p-0 delete-row-btn" title="Satırı Sil"><i class="fas fa-trash-alt"></i></button>
            </td>
        `;
        
        tbody.appendChild(tr);

        // Satır İçi Hesaplama (Miktar * Fiyat + KDV)
        const calcRow = () => {
            const qty = parseFloat(tr.querySelector('.item-qty').value) || 0;
            const price = parseFloat(tr.querySelector('.item-price').value) || 0;
            const vat = parseFloat(tr.querySelector('.item-vat').value) || 0;
            const currency = tr.querySelector('.item-currency').value;
            
            const total = (qty * price) * (1 + vat / 100);
            
            tr.querySelector('.item-total').textContent = new Intl.NumberFormat('tr-TR', {minimumFractionDigits: 2, maximumFractionDigits:2}).format(total) + ' ' + currency;
            tr.dataset.rawTotal = total;
            tr.dataset.currency = currency;
            
            this.calculateTotal(); // Genel Toplamı Güncelle
        };

        // Dinleyiciler
        tr.querySelectorAll('input, select').forEach(inp => inp.addEventListener('input', calcRow));
        tr.querySelector('.delete-row-btn').addEventListener('click', () => { tr.remove(); this.calculateTotal(); });
        
        calcRow(); // İlk açıldığında hesapla
    }

    // 🔥 YENİ: Genel Toplamı (Fatura Altı) Hesaplama
    calculateTotal() {
        const p = this.prefix;
        const tbody = document.getElementById(`${p}LineItemsBody`);
        const totalsMap = {}; // Kurlara göre gruplama (Örn: { TRY: 5000, USD: 100 })

        tbody.querySelectorAll('tr').forEach(tr => {
            const total = parseFloat(tr.dataset.rawTotal) || 0;
            const curr = tr.dataset.currency || 'TRY';
            if (total > 0) {
                totalsMap[curr] = (totalsMap[curr] || 0) + total;
            }
        });

        const valueSpan = document.getElementById(`${p}TotalValueContent`);
        if (!valueSpan) return;

        const parts = Object.entries(totalsMap).map(([curr, amount]) => {
            return new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + ' ' + curr;
        });

        if (parts.length === 0) {
            valueSpan.innerHTML = '0.00 TRY';
        } else {
            valueSpan.innerHTML = `<span class="text-primary font-weight-bold">${parts.join(' + ')}</span>`;
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
        const isForeign = document.getElementById(`${p}IsForeignTransaction`)?.checked;
        const foreignPartyDiv = document.getElementById(`${p}ForeignPaymentPartyContainer`);
        const fileDiv = document.getElementById(`${p}ForeignInvoiceContainer`);

        if (isForeign) {
            if (foreignPartyDiv) foreignPartyDiv.style.display = 'block';
            if (fileDiv) fileDiv.style.display = 'block';
        } else {
            if (foreignPartyDiv) foreignPartyDiv.style.display = 'none';
            if (fileDiv) fileDiv.style.display = 'none';
        }
    }

    reset() {
        this.originalRemainingAmount = null;
        const p = this.prefix;
        
        this.container.querySelectorAll('input').forEach(i => {
            if(i.type === 'checkbox') i.checked = false;
            else if(i.type !== 'hidden') i.value = '';
        });
        
        document.getElementById(`${p}AccrualType`).value = this.isFreestyle ? 'Masraf' : 'Hizmet';
        if (this.isFreestyle && document.getElementById(`${p}Subject`)) document.getElementById(`${p}Subject`).value = '';

        document.getElementById(`${p}LineItemsBody`).innerHTML = ''; // Tabloyu temizle
        this.addLineItem(); // Boş bir satır ekle

        document.getElementById(`${p}TpeInvoiceNo`).value = '';
        document.getElementById(`${p}EvrekaInvoiceNo`).value = '';

        if (document.getElementById(`${p}AccrualDescription`)) document.getElementById(`${p}AccrualDescription`).value = '';
        
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

        this.handleForeignToggle();
        this.calculateTotal();
        this.setReadOnlyState(false);
    }

    setData(data) {
        const p = this.prefix;
        if(!data) return;

        this.originalRemainingAmount = data.remainingAmount || null;
        document.getElementById(`${p}AccrualType`).value = data.type || data.accrualType || (this.isFreestyle ? 'Masraf' : 'Hizmet');
        if (this.isFreestyle && data.subject && document.getElementById(`${p}Subject`)) document.getElementById(`${p}Subject`).value = data.subject;

        document.getElementById(`${p}TpeInvoiceNo`).value = data.tpeInvoiceNo || '';
        document.getElementById(`${p}EvrekaInvoiceNo`).value = data.evrekaInvoiceNo || '';

        const descInput = document.getElementById(`${p}AccrualDescription`);
        if (descInput) descInput.value = data.description || data.foreignDescription || '';

        // 🔥 YENİ: Kalemleri (Items) Tabloya Doldur
        const tbody = document.getElementById(`${p}LineItemsBody`);
        tbody.innerHTML = '';
        
        if (data.items && data.items.length > 0) {
            // Eğer yeni şema verisi (accrual_items) varsa onları çiz
            data.items.forEach(item => this.addLineItem(item));
        } else {
            // Geriye Dönük Uyumluluk (Legacy Data): Eski officialFee ve serviceFee verilerini satıra dönüştür
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
            // Hiç tutar yoksa 1 tane boş satır at
            if (!hasRows) this.addLineItem(); 
        }

        // Fatura PDF Linki Geriye Dönük Uyumluluk
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

        // Kişi Eşleştirmeleri
        if (data.tpInvoiceParty) {
            this.selectedTpParty = data.tpInvoiceParty;
            this.manualSelectDisplay(`${p}TpInvoiceParty`, data.tpInvoiceParty);
        }
        
        let isForeign = false;
        if (data.serviceInvoiceParty && (!data.tpInvoiceParty || data.serviceInvoiceParty.id !== data.tpInvoiceParty.id)) {
            isForeign = true;
            this.selectedForeignParty = data.serviceInvoiceParty;
            this.manualSelectDisplay(`${p}ForeignPaymentParty`, data.serviceInvoiceParty);
        } else if (data.isForeignTransaction) {
            isForeign = true;
        }

        if (document.getElementById(`${p}IsForeignTransaction`)) {
            document.getElementById(`${p}IsForeignTransaction`).checked = isForeign;
        }
        
        this.handleForeignToggle();
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
        let subjectText = '';

        if (this.isFreestyle) {
            subjectText = document.getElementById(`${p}Subject`)?.value.trim() || '';
            if (!subjectText) return { success: false, error: 'Lütfen Serbest Tahakkuk için Konu/Başlık girin.' };
            if (!this.selectedTpParty) return { success: false, error: 'Lütfen fatura kesilecek müvekkili (kişiyi) seçin.' };
        }

        const tpeInvoiceNo = document.getElementById(`${p}TpeInvoiceNo`).value.trim();
        const evrekaInvoiceNo = document.getElementById(`${p}EvrekaInvoiceNo`).value.trim();

        // 🔥 YENİ: Tablodaki Verileri Oku (Items Array)
        const items = [];
        let fallbackOffAmount = 0; // Eski sistem bozulmasın diye
        let fallbackSrvAmount = 0;
        const totalsMap = {};

        document.querySelectorAll(`#${p}LineItemsBody tr`).forEach(tr => {
            const fee_type = tr.querySelector('.item-type').value;
            const item_name = tr.querySelector('.item-name').value.trim();
            const quantity = parseFloat(tr.querySelector('.item-qty').value) || 0;
            const unit_price = parseFloat(tr.querySelector('.item-price').value) || 0;
            const vat_rate = parseFloat(tr.querySelector('.item-vat').value) || 0;
            const currency = tr.querySelector('.item-currency').value;

            if (item_name && quantity > 0) {
                const total_amount = (quantity * unit_price) * (1 + vat_rate / 100);
                
                items.push({ fee_type, item_name, quantity, unit_price, vat_rate, total_amount, currency });
                
                totalsMap[currency] = (totalsMap[currency] || 0) + total_amount;

                // Eski kodlar patlamasın diye yalancı toplam (Fallback)
                if (fee_type.includes('Harç')) fallbackOffAmount += total_amount;
                else fallbackSrvAmount += total_amount;
            }
        });

        if (items.length === 0) {
            return { success: false, error: 'Fatura oluşturabilmek için en az 1 tane geçerli kalem (satır) girmelisiniz.' };
        }

        const isForeign = document.getElementById(`${p}IsForeignTransaction`)?.checked || false;
        const accrualDesc = document.getElementById(`${p}AccrualDescription`)?.value.trim() || '';
        
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

        return {
            success: true,
            data: {
                type: accrualType, 
                accrualType: accrualType, 
                subject: subjectText, 
                isFreestyle: this.isFreestyle, 
                
                items: items, // 🔥 YENİ SİSTEM
                
                // Geriye Dönük Uyumluluk (Legacy)
                officialFee: { amount: fallbackOffAmount, currency: 'TRY' },
                serviceFee: { amount: fallbackSrvAmount, currency: 'TRY' },
                vatRate: items.length > 0 ? items[0].vat_rate : 20, 
                applyVatToOfficialFee: false, 
                
                totalAmount: totalAmountArray, 
                remainingAmount: this.originalRemainingAmount || totalAmountArray,
                
                tpInvoicePartyId: tpParty ? tpParty.id : null,
                serviceInvoicePartyId: serviceParty ? serviceParty.id : null,
                tpInvoiceParty: tpParty,
                serviceInvoiceParty: serviceParty,
                isForeignTransaction: isForeign,
                tpeInvoiceNo: tpeInvoiceNo,
                evrekaInvoiceNo: evrekaInvoiceNo,
                description: accrualDesc,           
                foreignInvoiceFile: foreignFile,    
                files: files                        
            }
        };
    }

    setReadOnlyState(isPaid) {
        const p = this.prefix;
        
        const elementsToToggle = [
            `${p}AccrualType`, `${p}IsForeignTransaction`, `${p}Subject`, `${p}AccrualDescription`,
            `${p}TpInvoicePartySearch`, `${p}ForeignPaymentPartySearch`, `${p}ForeignInvoiceFile`,
            `${p}AddLineItemBtn`, `${p}AutoCalcBtn`
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

        // Tablodaki inputları kilitle
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