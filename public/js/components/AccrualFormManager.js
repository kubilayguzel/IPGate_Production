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
        const selectStyle = "width: 110px !important; min-width: 110px !important; flex: 0 0 110px !important; border-top-left-radius: 0; border-bottom-left-radius: 0; background-color: #f8f9fa; font-weight:600; height: 50px !important; padding: 0 10px !important; appearance: auto;";
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
                <label class="font-weight-bold text-dark">Tahakkuk Konusu / Açıklama <span class="text-danger">*</span></label>
                <input type="text" id="${p}Subject" class="form-input form-control border-primary" placeholder="Örn: Marka tescil belgesi posta masrafı..." style="${inputHeightStyle}">
            </div>
        ` : '';

        const html = `
            <div class="row mb-3">
                <div class="col-md-6">
                    <div class="form-group mb-0 p-2 bg-light border rounded">
                        <label class="font-weight-bold text-primary mb-1">Tahakkuk Türü</label>
                        <select id="${p}AccrualType" class="form-control" style="font-weight: 600; border-color: #1e3c72; height: 50px !important; padding: 0 15px !important; appearance: auto;">
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

            <div class="row">
                <div class="col-md-6">
                    <div class="form-group">
                        <label>Resmi Ücret</label>
                        <div class="input-with-currency" style="display:flex;">
                            <input type="number" id="${p}OfficialFee" class="form-input form-control" step="0.01" placeholder="0.00" style="border-top-right-radius: 0; border-bottom-right-radius: 0; ${inputHeightStyle}">
                            <select id="${p}OfficialFeeCurrency" class="currency-select form-control" style="${selectStyle}"><option value="TRY">TRY</option><option value="USD">USD</option><option value="EUR">EUR</option><option value="CHF">CHF</option><option value="GBP">GBP</option></select>
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="form-group">
                        <label>Hizmet/Masraf Ücreti</label>
                        <div class="input-with-currency" style="display:flex;">
                            <input type="number" id="${p}ServiceFee" class="form-input form-control" step="0.01" placeholder="0.00" style="border-top-right-radius: 0; border-bottom-right-radius: 0; ${inputHeightStyle}">
                            <select id="${p}ServiceFeeCurrency" class="currency-select form-control" style="${selectStyle}"><option value="TRY">TRY</option><option value="USD">USD</option><option value="EUR">EUR</option><option value="CHF">CHF</option><option value="GBP">GBP</option></select>
                        </div>
                    </div>
                </div>
            </div>

            <div class="row">
                <div class="col-md-6">
                    <div class="form-group">
                        <label>KDV Oranı (%)</label>
                        <input type="number" id="${p}VatRate" class="form-input form-control" value="20" style="${inputHeightStyle}">
                    </div>
                </div>
                <div class="col-md-6 d-flex align-items-center">
                    <label class="checkbox-label mt-4" style="cursor:pointer; display:flex; align-items:center;">
                        <input type="checkbox" id="${p}ApplyVatToOfficial" style="width:18px; height:18px; margin-right:10px;"> Resmi Ücrete KDV Ekle
                    </label>
                </div>
            </div>

            <div class="row mt-2">
                <div class="col-md-6">
                    <div class="form-group">
                        <label class="text-secondary font-weight-bold" style="font-size:0.9rem;">TPE Fatura No</label>
                        <div class="input-group">
                            <div class="input-group-prepend">
                                <span class="input-group-text bg-light"><i class="fas fa-file-invoice text-muted"></i></span>
                            </div>
                            <input type="text" id="${p}TpeInvoiceNo" class="form-input form-control" placeholder="Örn: TPE2023..." style="border-left:none; ${inputHeightStyle}">
                        </div>
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="form-group">
                        <label class="text-secondary font-weight-bold" style="font-size:0.9rem;">EVREKA Fatura No</label>
                        <div class="input-group">
                            <div class="input-group-prepend">
                                <span class="input-group-text bg-light"><i class="fas fa-file-invoice-dollar text-muted"></i></span>
                            </div>
                            <input type="text" id="${p}EvrekaInvoiceNo" class="form-input form-control" placeholder="Örn: EVR2023..." style="border-left:none; ${inputHeightStyle}">
                        </div>
                    </div>
                </div>
            </div>
            
            <div id="${p}TotalAmountDisplay" class="total-amount-display d-flex justify-content-between align-items-center" 
                 style="font-size: 1.1em; font-weight: bold; color: #1e3c72; margin-top: 15px; padding: 15px 20px; background-color: #e3f2fd; border: 1px solid #90caf9; border-radius: 10px;">
                <span class="text-uppercase text-muted" style="font-size: 0.85em; letter-spacing: 1px;">TOPLAM</span>
                <span id="${p}TotalValueContent">0.00 ₺</span>
            </div>

            <div class="form-group mt-3" id="${p}ForeignPaymentPartyContainer" style="display:none; background-color: #e3f2fd; padding: 10px; border-radius: 8px; border: 1px solid #90caf9;">
                <label class="text-primary font-weight-bold"><i class="fas fa-globe-americas mr-2"></i>Yurtdışı Ödeme Yapılacak Taraf</label>
                <div class="position-relative">
                    <input type="text" id="${p}ForeignPaymentPartySearch" class="form-input form-control" placeholder="Yurtdışı tarafı ara..." style="${inputHeightStyle}">
                    <div id="${p}ForeignPaymentPartyResults" class="search-results-list" style="display:none; max-height: 150px; overflow-y: auto; border: 1px solid #ccc; border-radius: 8px; margin-top: 5px; background:white; position:absolute; z-index:1000; width:100%; top:100%; left:0;"></div>
                </div>
                <div id="${p}ForeignPaymentPartyDisplay" class="search-result-display" style="display:none; background: #e9f5ff; border: 1px solid #bde0fe; padding: 10px; border-radius: 8px; margin-top: 10px;"></div>
            </div>

            <div class="form-group mt-3 p-3 border rounded shadow-sm" style="${this.isFreestyle ? 'border-color:#1e3c72 !important; background:#f8fbff;' : ''}">
                <label class="${this.isFreestyle ? 'text-primary font-weight-bold' : ''}">Fatura Kesilecek Kişi (Müvekkil/TP) ${this.isFreestyle ? '<span class="text-danger">*</span>' : ''}</label>
                <div class="position-relative">
                    <input type="text" id="${p}TpInvoicePartySearch" class="form-input form-control" placeholder="Kişi ara..." style="${inputHeightStyle}">
                    <div id="${p}TpInvoicePartyResults" class="search-results-list" style="display:none; max-height: 150px; overflow-y: auto; border: 1px solid #ccc; border-radius: 8px; margin-top: 5px; background:white; position:absolute; z-index:1000; width:100%; top:100%; left:0;"></div>
                </div>
                <div id="${p}TpInvoicePartyDisplay" class="search-result-display" style="display:none; background: #e9f5ff; border: 1px solid #bde0fe; padding: 10px; border-radius: 8px; margin-top: 10px;"></div>
            </div>
            
            <div class="form-group mt-3" id="${p}ForeignInvoiceContainer" style="display:none;">
                <label class="form-label">Yurtdışı Fatura/Debit (PDF)</label>
                <label for="${p}ForeignInvoiceFile" class="custom-file-upload btn btn-outline-secondary w-100" style="cursor:pointer; height: 50px; display:flex; align-items:center; justify-content:center;"><i class="fas fa-cloud-upload-alt mr-2"></i> Dosya Seçin</label>
                <input type="file" id="${p}ForeignInvoiceFile" accept="application/pdf" style="display:none;">
                <small id="${p}ForeignInvoiceFileName" class="text-muted d-block mt-1 text-center"></small>
            </div>
        `;

        this.container.innerHTML = html;
        this.setupListeners();
    }

    setupListeners() {
        const p = this.prefix;

        const calcElements = [
            `${p}OfficialFee`, `${p}ServiceFee`, `${p}VatRate`,
            `${p}ApplyVatToOfficial`, `${p}OfficialFeeCurrency`, `${p}ServiceFeeCurrency`
        ];
        
        calcElements.forEach(id => {
            const el = document.getElementById(id);
            if(el) el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => this.calculateTotal());
        });

        document.getElementById(`${p}IsForeignTransaction`)?.addEventListener('change', () => this.handleForeignToggle());

        document.getElementById(`${p}ForeignInvoiceFile`)?.addEventListener('change', (e) => {
            const nameEl = document.getElementById(`${p}ForeignInvoiceFileName`);
            if (nameEl) nameEl.textContent = e.target.files[0] ? e.target.files[0].name : '';
        });

        this.setupSearch(`${p}TpInvoiceParty`, (person) => { this.selectedTpParty = person; });
        this.setupSearch(`${p}ForeignPaymentParty`, (person) => { this.selectedForeignParty = person; });
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

    calculateTotal() {
        const p = this.prefix;
        const off = parseFloat(document.getElementById(`${p}OfficialFee`).value) || 0;
        const srv = parseFloat(document.getElementById(`${p}ServiceFee`).value) || 0;
        const vat = parseFloat(document.getElementById(`${p}VatRate`).value) || 0;
        const applyToOfficial = document.getElementById(`${p}ApplyVatToOfficial`).checked;

        const offCurr = document.getElementById(`${p}OfficialFeeCurrency`)?.value || 'TRY';
        const srvCurr = document.getElementById(`${p}ServiceFeeCurrency`)?.value || 'TRY';

        const offTotal = applyToOfficial ? off * (1 + vat / 100) : off;
        const srvTotal = srv * (1 + vat / 100);

        const totals = {};
        if (offTotal > 0) totals[offCurr] = (totals[offCurr] || 0) + offTotal;
        if (srvTotal > 0) totals[srvCurr] = (totals[srvCurr] || 0) + srvTotal;

        const displayContainer = document.getElementById(`${p}TotalAmountDisplay`);
        
        if(!document.getElementById(`${p}TotalValueContent`)) {
             displayContainer.innerHTML = `
                <span class="text-uppercase text-muted" style="font-size: 0.85em; letter-spacing: 1px;">TOPLAM</span>
                <span id="${p}TotalValueContent">0.00 ₺</span>`;
        }
        
        const valueSpan = document.getElementById(`${p}TotalValueContent`);
        const fmt = (val, curr) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val) + ' ' + curr;

        const parts = Object.entries(totals).map(([curr, amount]) => fmt(amount, curr));

        if (parts.length === 0) {
            valueSpan.innerHTML = '0.00 ₺';
        } else {
            valueSpan.innerHTML = `<span class="text-primary font-weight-bold">${parts.join(' + ')}</span>`;
        }
    }

    handleForeignToggle() {
        const p = this.prefix;
        const isForeign = document.getElementById(`${p}IsForeignTransaction`).checked;
        const foreignPartyDiv = document.getElementById(`${p}ForeignPaymentPartyContainer`);
        const fileDiv = document.getElementById(`${p}ForeignInvoiceContainer`);

        if (isForeign) {
            foreignPartyDiv.style.display = 'block';
            fileDiv.style.display = 'block';
        } else {
            foreignPartyDiv.style.display = 'none';
            fileDiv.style.display = 'none';
        }
    }

    reset() {
        const p = this.prefix;
        
        this.container.querySelectorAll('input').forEach(i => {
            if(i.type === 'checkbox') i.checked = false;
            else if(i.type !== 'hidden') i.value = '';
        });
        
        document.getElementById(`${p}AccrualType`).value = this.isFreestyle ? 'Masraf' : 'Hizmet';
        if (this.isFreestyle) document.getElementById(`${p}Subject`).value = '';

        document.getElementById(`${p}OfficialFeeCurrency`).value = 'TRY';
        document.getElementById(`${p}ServiceFeeCurrency`).value = 'TRY';
        document.getElementById(`${p}VatRate`).value = '20';
        
        document.getElementById(`${p}TpeInvoiceNo`).value = '';
        document.getElementById(`${p}EvrekaInvoiceNo`).value = '';

        const valSpan = document.getElementById(`${p}TotalValueContent`);
        if(valSpan) valSpan.innerHTML = '0.00 ₺';
        
        this.selectedTpParty = null;
        this.selectedForeignParty = null;
        
        document.getElementById(`${p}TpInvoicePartyDisplay`).innerHTML = '';
        document.getElementById(`${p}TpInvoicePartyDisplay`).style.display = 'none';
        
        document.getElementById(`${p}ForeignPaymentPartyDisplay`).innerHTML = '';
        document.getElementById(`${p}ForeignPaymentPartyDisplay`).style.display = 'none';
        
        document.getElementById(`${p}ForeignInvoiceFileName`).textContent = '';
        document.getElementById(`${p}EpatsDocumentContainer`).style.display = 'none';

        this.handleForeignToggle();
    }

    setData(data) {
        const p = this.prefix;
        if(!data) return;

        document.getElementById(`${p}AccrualType`).value = data.type || data.accrualType || (this.isFreestyle ? 'Masraf' : 'Hizmet');
        if (this.isFreestyle && data.subject) document.getElementById(`${p}Subject`).value = data.subject;

        if (data.officialFee) {
            document.getElementById(`${p}OfficialFee`).value = data.officialFee.amount || 0;
            document.getElementById(`${p}OfficialFeeCurrency`).value = data.officialFee.currency || 'TRY';
        }
        if (data.serviceFee) {
            document.getElementById(`${p}ServiceFee`).value = data.serviceFee.amount || 0;
            document.getElementById(`${p}ServiceFeeCurrency`).value = data.serviceFee.currency || 'TRY';
        }
        
        document.getElementById(`${p}VatRate`).value = data.vatRate || 20;
        document.getElementById(`${p}ApplyVatToOfficial`).checked = data.applyVatToOfficialFee ?? false;

        document.getElementById(`${p}TpeInvoiceNo`).value = data.tpeInvoiceNo || '';
        document.getElementById(`${p}EvrekaInvoiceNo`).value = data.evrekaInvoiceNo || '';

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

        document.getElementById(`${p}IsForeignTransaction`).checked = isForeign;
        this.handleForeignToggle();
        
        this.calculateTotal();
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
            subjectText = document.getElementById(`${p}Subject`).value.trim();
            if (!subjectText) return { success: false, error: 'Lütfen Serbest Tahakkuk için Konu/Açıklama girin.' };
            if (!this.selectedTpParty) return { success: false, error: 'Lütfen fatura kesilecek müvekkili (kişiyi) seçin.' };
        }

        const officialFee = parseFloat(document.getElementById(`${p}OfficialFee`).value) || 0;
        const offCurr = document.getElementById(`${p}OfficialFeeCurrency`).value;
        
        const serviceFee = parseFloat(document.getElementById(`${p}ServiceFee`).value) || 0;
        const srvCurr = document.getElementById(`${p}ServiceFeeCurrency`).value;
        
        const tpeInvoiceNo = document.getElementById(`${p}TpeInvoiceNo`).value.trim();
        const evrekaInvoiceNo = document.getElementById(`${p}EvrekaInvoiceNo`).value.trim();

        if (officialFee <= 0 && serviceFee <= 0) {
            return { success: false, error: 'En az bir ücret (Resmi veya Hizmet) girmelisiniz.' };
        }

        const vatRate = parseFloat(document.getElementById(`${p}VatRate`).value) || 0;
        const applyVatToOfficial = document.getElementById(`${p}ApplyVatToOfficial`).checked;
        const isForeign = document.getElementById(`${p}IsForeignTransaction`).checked;
        const fileInput = document.getElementById(`${p}ForeignInvoiceFile`);
        const files = fileInput.files;

        const tpParty = this.selectedTpParty ? { id: this.selectedTpParty.id, name: this.selectedTpParty.name } : null;
        let serviceParty = null;

        if (isForeign) {
            if (this.selectedForeignParty) {
                serviceParty = { id: this.selectedForeignParty.id, name: this.selectedForeignParty.name };
            }
        } else {
            serviceParty = tpParty;
        }

        const offTotal = applyVatToOfficial ? officialFee * (1 + vatRate / 100) : officialFee;
        const srvTotal = serviceFee * (1 + vatRate / 100);
        
        const totalsMap = {};
        if (offTotal > 0) totalsMap[offCurr] = (totalsMap[offCurr] || 0) + offTotal;
        if (srvTotal > 0) totalsMap[srvCurr] = (totalsMap[srvCurr] || 0) + srvTotal;

        const totalAmountArray = Object.entries(totalsMap).map(([curr, amt]) => ({
            amount: amt,
            currency: curr
        }));

        return {
            success: true,
            data: {
                type: accrualType, 
                accrualType: accrualType, // DB'ye uyum için
                subject: subjectText, 
                isFreestyle: this.isFreestyle, 
                officialFee: { amount: officialFee, currency: offCurr },
                serviceFee: { amount: serviceFee, currency: srvCurr },
                vatRate: vatRate,
                applyVatToOfficialFee: applyVatToOfficial,
                totalAmount: totalAmountArray, 
                
                // 🔥 THE FIX: Veritabanı Native Sütunları için ID'leri Gönderiyoruz!
                tpInvoicePartyId: tpParty ? tpParty.id : null,
                serviceInvoicePartyId: serviceParty ? serviceParty.id : null,
                
                // Geriye dönük uyumluluk ve arayüz okuması için (Zararı yok)
                tpInvoiceParty: tpParty,
                serviceInvoiceParty: serviceParty,
                
                isForeignTransaction: isForeign,
                tpeInvoiceNo: tpeInvoiceNo,
                evrekaInvoiceNo: evrekaInvoiceNo,
                files: files
            }
        };
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