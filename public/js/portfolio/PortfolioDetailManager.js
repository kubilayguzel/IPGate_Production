// public/js/portfolio/PortfolioDetailManager.js
import { TransactionHelper } from './TransactionHelper.js';
import { loadSharedLayout } from '../layout-loader.js';
import { ipRecordsService, transactionTypeService, personService, commonService, waitForAuthUser, redirectOnLogout } from '../../supabase-config.js';
import { STATUSES } from '../../utils.js';
import '../simple-loading.js';

export class PortfolioDetailManager {
    constructor() {
        this.recordId = new URLSearchParams(location.search).get('id');
        this.currentRecord = null;
        this.transactionTypesMap = new Map();
        this.countriesMap = new Map();
        
        this.loader = window.SimpleLoadingController || (window.SimpleLoading ? new window.SimpleLoading() : null);

        this.initElements();
        this.init();
    }

    initElements() {
        this.elements = {
            heroTitle: document.getElementById('heroTitle'),
            brandImage: document.getElementById('brandImage'),
            heroCard: document.getElementById('heroCard'),
            heroKv: document.getElementById('heroKv'),
            goodsContainer: document.getElementById('goodsContainer'),
            txAccordion: document.getElementById('txAccordion'),
            docsTbody: document.getElementById('documentsTbody'),
            addDocForm: document.getElementById('addDocForm'),
            applicantName: document.getElementById('applicantName'),
            applicantAddress: document.getElementById('applicantAddress'),
            tpQueryBtn: document.getElementById('tpQueryBtn'),
            loadingStatic: document.getElementById('loading'),
            detailRoot: document.getElementById('detail-root')
        };
    }

    async init() {
        try {
            this.toggleLoading(true);
            await waitForAuthUser(); 

            const [recordRes, countriesRes, txTypesRes] = await Promise.all([
                ipRecordsService.getRecordById(this.recordId),
                commonService.getCountries(),
                transactionTypeService.getTransactionTypes().catch(() => ({ success: false, data: [] }))
            ]);

            if (!recordRes || !recordRes.success || !recordRes.data) throw new Error("Kayıt bulunamadı.");

            if (countriesRes.success && Array.isArray(countriesRes.data)) {
                countriesRes.data.forEach(c => this.countriesMap.set(String(c.code), c.name));
            }
            if (txTypesRes.success && Array.isArray(txTypesRes.data)) {
                txTypesRes.data.forEach(t => {
                    this.transactionTypesMap.set(String(t.id), t.alias || t.name);
                    if (t.code) this.transactionTypesMap.set(String(t.code), t.alias || t.name);
                });
            }

            this.currentRecord = recordRes.data;
            await this.renderAll();

            if (typeof loadSharedLayout === 'function') loadSharedLayout();
            this.setupEventListeners();
            redirectOnLogout();

        } catch (e) {
            console.error("❌ Başlatma hatası:", e);
            this.showError(e.message);
        } finally {
            this.toggleLoading(false);
        }
    }

    async renderAll() {
        this.renderHero();
        this.renderGoodsList();
        this.renderDocuments();
        
        await Promise.all([
            this.renderApplicants(),
            this.renderTransactions()
        ]);
    }

    renderHero() {
        const r = this.currentRecord;
        if (!r) return;

        this.elements.heroTitle.textContent = r.title || r.brandName || r.brandText || '-';
        
        if (this.elements.heroCard) {
            this.elements.heroCard.classList.remove('d-none');
            this.elements.heroCard.style.display = 'flex';
        }

        const imgSrc = r.brandImageUrl || r.brandImage;
        const imgWrap = this.elements.brandImage?.closest('.hero-img-wrap');
        if (imgSrc && this.elements.brandImage) {
            this.elements.brandImage.src = imgSrc;
            if (imgWrap) imgWrap.style.display = 'block';
        } else {
            if (imgWrap) imgWrap.style.display = 'none'; 
        }

        const isTP = this.checkIfTurkPatentOrigin(r);
        const countryName = this.countriesMap.get(String(r.countryCode || r.country)) || r.countryCode || '-';
        const regNo = r.registrationNumber || r.wipoIR || '-';

        let classesStr = '-';
        if (r.goodsAndServicesByClass && r.goodsAndServicesByClass.length > 0) {
            classesStr = r.goodsAndServicesByClass.map(c => c.classNo).join(', ');
        } else if (r.niceClasses) {
            classesStr = r.niceClasses.join(', ');
        }

        if (this.elements.heroKv) {
            this.elements.heroKv.innerHTML = `
                <div class="kv-item"><div class="label">Başvuru No</div><div class="value">${r.applicationNumber || '-'}</div></div>
                <div class="kv-item"><div class="label">Tescil No</div><div class="value">${regNo}</div></div>
                <div class="kv-item"><div class="label">Durum</div><div class="value">${this.getStatusText(r.type, r.status)}</div></div>
                <div class="kv-item"><div class="label">Başvuru Tarihi</div><div class="value">${this.formatDate(r.applicationDate)}</div></div>
                <div class="kv-item"><div class="label">Tescil Tarihi</div><div class="value">${this.formatDate(r.registrationDate)}</div></div>
                <div class="kv-item"><div class="label">Yenileme Tarihi</div><div class="value">${this.formatDate(r.renewalDate)}</div></div>
                
                ${(!isTP) ? `
                    <div style="grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 15px; border-top: 1px solid #eee; padding-top: 10px; margin-top: 5px;">
                        <div class="kv-item" style="border:none; padding:0;"><div class="label">Ülke</div><div class="value">${countryName}</div></div>
                        <div class="kv-item" style="border:none; padding:0;"><div class="label">Orijin</div><div class="value">${r.origin || '-'}</div></div>
                    </div>` : ''}

                <div class="kv-item" style="grid-column: 1 / -1; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #e0e0e0;">
                    <div class="label" style="margin-bottom: 4px;">Sınıflar (Nice)</div>
                    <div class="value text-primary" style="font-weight: 700;">${classesStr}</div>
                </div>
            `;
        }

        if (this.elements.tpQueryBtn) {
            this.elements.tpQueryBtn.style.display = isTP ? 'inline-block' : 'none';
        }
    }

    renderGoodsList() {
        const container = this.elements.goodsContainer;
        if (!container) return;
        const gsbc = this.currentRecord.goodsAndServicesByClass || [];
        if (gsbc.length === 0) { container.innerHTML = '<div class="text-muted p-3">Eşya listesi yok.</div>'; return; }

        container.innerHTML = [...gsbc].sort((a,b) => Number(a.classNo) - Number(b.classNo)).map(entry => {
            const listHtml = this.formatNiceClassContent(entry.classNo, entry.items || []);
            return `
                <div class="goods-group border rounded p-3 mb-2 bg-white">
                    <div class="font-weight-bold text-primary mb-2">Nice ${entry.classNo}</div>
                    <ul class="pl-3 mb-0 goods-items">${listHtml}</ul>
                </div>`
        }).join('');
    }

    formatNiceClassContent(classNo, items) {
        if (!items || !items.length) return '';
        if (String(classNo) === '35') {
            let html = '', isIndentedSection = false;
            const triggerPhrase = "satın alması için", startPhrase = "müşterilerin malları";
            items.forEach(t => {
                const text = String(t || ''), lowerText = text.toLowerCase();
                if (!isIndentedSection && lowerText.includes(startPhrase) && lowerText.includes(triggerPhrase)) {
                    const match = text.match(new RegExp(`(${triggerPhrase})`, 'i'));
                    if (match) {
                        const splitIndex = match.index + match[1].length;
                        html += `<li class="font-weight-bold list-unstyled mt-2" style="list-style:none;">${text.substring(0, splitIndex)}</li>`;
                        if (text.substring(splitIndex).trim()) html += `<li class="ml-4" style="list-style-type:circle;">${text.substring(splitIndex)}</li>`;
                        isIndentedSection = true; return;
                    }
                }
                html += isIndentedSection ? `<li class="ml-4" style="list-style-type:circle;">${text}</li>` : `<li>${text}</li>`;
            });
            return html;
        }
        return items.map(item => `<li>${item}</li>`).join('');
    }

    async renderTransactions() {
        const accordion = this.elements.txAccordion;
        if (!accordion) return;

        const res = await ipRecordsService.getRecordTransactions(this.recordId);
        const transactions = res.success ? res.data : [];

        if (transactions.length === 0) {
            accordion.innerHTML = '<div class="p-3 text-muted">İşlem geçmişi bulunamadı.</div>';
            return;
        }

        const { parents, childrenMap } = TransactionHelper.organizeTransactions(transactions);
        const enrichQueue = [];

        accordion.innerHTML = parents.map(parent => {
            const typeName = this.transactionTypesMap.get(String(parent.type)) || `İşlem ${parent.type}`;
            const children = childrenMap[parent.id] || [];
            const pId = this.safeDomId(`txdocs-${parent.id}`);

            const pDirectDocs = TransactionHelper.getDirectDocuments(parent);
            const pIcons = pDirectDocs.map((d, i) => this.createDocIcon(d, i === 0)).join(' ');

            let pDocsHtml = pIcons || '';
            
            pDocsHtml += `<span class="tx-docs-loading text-muted small ml-2"><i class="fas fa-spinner fa-spin"></i> PDF aranıyor...</span>`;
            enrichQueue.push({ tx: parent, containerId: pId, hasAnyDirect: pDirectDocs.length > 0 });

            const childrenHtml = children.length === 0 ? '' : `
                <div class="accordion-transaction-children" style="display:none;">
                    ${children.map(child => {
                        const cTypeName = this.transactionTypesMap.get(String(child.type)) || `İşlem ${child.type}`;
                        const cId = this.safeDomId(`txdocs-${child.id}`);
                        const cDirectDocs = TransactionHelper.getDirectDocuments(child);
                        const cIcons = cDirectDocs.map((d, i) => this.createDocIcon(d, i === 0)).join(' ');
                        
                        let cDocsHtml = cIcons || '';
                        
                        cDocsHtml += `<span class="tx-docs-loading text-muted small ml-2"><i class="fas fa-spinner fa-spin"></i> PDF aranıyor...</span>`;
                        enrichQueue.push({ tx: child, containerId: cId, hasAnyDirect: cDirectDocs.length > 0 });

                        return `
                        <div class="child-transaction-item d-flex justify-content-between align-items-center p-2 border-top bg-light ml-4" style="border-left: 3px solid #f39c12;">
                            <div><small class="text-muted">↳ ${cTypeName}</small><span class="text-muted ml-2 small">${this.formatDate(child.timestamp || child.date || child.created_at, true)}</span></div>
                            <div id="${cId}">${cDocsHtml || '-'}</div>
                        </div>`;
                    }).join('')}
                </div>`;

            return `
                <div class="accordion-transaction-item border-bottom">
                    <div class="accordion-transaction-header d-flex justify-content-between align-items-center p-3" style="cursor:pointer; background: #fff;">
                        <div class="d-flex align-items-center">
                            <i class="fas fa-chevron-right mr-2 text-muted transition-icon ${children.length ? 'has-child-indicator' : ''}"></i>
                            <div class="d-flex flex-column">
                                <span class="font-weight-bold" data-tx-type="${parent.type}">${typeName}</span>
                                <small class="text-muted">${this.formatDate(parent.timestamp || parent.date || parent.created_at, true)}</small>
                            </div>
                        </div>
                        <div class="d-flex align-items-center" id="${pId}">
                            ${pDocsHtml || '-'}
                            ${children.length ? `<span class="badge badge-light border ml-2">${children.length} alt</span>` : ''}
                        </div>
                    </div>
                    ${childrenHtml}
                </div>`;
        }).join('');

        this.setupAccordionEvents();
        this.populateTaskDocsAsync(enrichQueue).catch(e => console.warn(e));
    }

    safeDomId(raw) { return String(raw).replace(/[^a-zA-Z0-9_-]/g, '_'); }

    async populateTaskDocsAsync(queue) {
        if (!queue.length) return;
        const worker = async (item) => {
            const { tx, containerId, hasAnyDirect } = item;
            const container = document.getElementById(containerId);
            if (!container) return;
            const taskDocs = await TransactionHelper.getTaskDocuments(tx);
            container.querySelector('.tx-docs-loading')?.remove();
            if (!taskDocs || taskDocs.length === 0) {
                if (!hasAnyDirect && container.innerText.trim() === '') container.innerHTML = '<span class="text-muted small">-</span>';
                return;
            }
            const existing = new Set(Array.from(container.querySelectorAll('a')).map(a => a.getAttribute('href')));
            const icons = taskDocs.filter(d => d?.url && !existing.has(d.url)).map((d, i) => this.createDocIcon(d, i === 0 && existing.size === 0)).join(' ');
            if (icons) container.insertAdjacentHTML('beforeend', icons);
        };
        for (const item of queue) { await worker(item); }
    }

    createDocIcon(doc, isFirst) {
        const color = (doc.source === 'task') ? 'text-info' : 'text-danger'; 
        
        let iconClass = 'fa-file-pdf';
        if (doc.type) {
            const t = doc.type.toLowerCase();
            if (t.includes('image') || t.includes('jpg') || t.includes('jpeg') || t.includes('png')) iconClass = 'fa-file-image';
            else if (t.includes('word') || t.includes('doc')) iconClass = 'fa-file-word';
            else if (t.includes('epats')) iconClass = 'fa-file-invoice';
        }

        return `<a href="${doc.url}" target="_blank" class="mx-1 ${color}" title="${doc.name || 'Belge'}"><i class="fas ${iconClass} fa-lg"></i></a>`;
    }

    toggleLoading(show) {
        if (show) {
            if (this.elements.loadingStatic) this.elements.loadingStatic.style.display = 'none'; 
            if (this.elements.detailRoot) this.elements.detailRoot.classList.add('d-none');
            if (this.loader) this.loader.show({ text: 'Yükleniyor', subtext: 'Kayıt detayları hazırlanıyor...' });
        } else {
            if (this.loader) this.loader.hide();
            if (this.elements.detailRoot) this.elements.detailRoot.classList.remove('d-none');
        }
    }

    async renderApplicants() {
        const r = this.currentRecord;
        if (!this.elements.applicantName) return;
        let names = [], addresses = [];
        
        // 🔥 ÇÖZÜM: Yeni SQL yapımızda veriler JOIN ile geldiği için "N+1" ekstra sorguları tamamen kaldırıldı. Işık hızında çalışacak!
        if (Array.isArray(r.applicants) && r.applicants.length > 0) {
            r.applicants.forEach(app => {
                names.push(app.name || '-');
                if (app.address) addresses.push(app.address);
            });
        } else {
            names = [r.applicantName || '-']; 
            addresses = [r.applicantAddress || '-'];
        }
        
        this.elements.applicantName.innerHTML = names.join('<br>') || '-';
        if (this.elements.applicantAddress) {
            this.elements.applicantAddress.innerHTML = addresses.length > 0 ? addresses.join('<br>') : '-';
        }
    }

    renderDocuments() {
        // 🔥 ÇÖZÜM: SQL tablosundan (veya yedek JSON'dan) gelen belgeler SQL isimlendirmeleriyle (document_url, document_name vb.) okundu
        const docs = this.currentRecord.documents || [];
        if (this.elements.docsTbody) {
            this.elements.docsTbody.innerHTML = docs.length ? docs.map(d => `
                <tr>
                    <td>${d.name || d.fileName || d.document_name || 'İsimsiz Belge'}</td>
                    <td>${d.documentDesignation || d.document_type || '-'}</td>
                    <td>${this.formatDate(d.uploadedAt || d.date || d.created_at)}</td>
                    <td class="text-right">
                        <i class="fas fa-eye text-primary cursor-pointer" onclick="window.open('${d.url || d.fileUrl || d.document_url}','_blank')"></i>
                    </td>
                </tr>`).join('') : '<tr><td colspan="4" class="text-center">Belge yok.</td></tr>';
        }
    }

    setupAccordionEvents() {
        this.elements.txAccordion.querySelectorAll('.accordion-transaction-header').forEach(header => {
            header.onclick = (e) => {
                if (e.target.closest('a')) return;
                const container = header.parentElement.querySelector('.accordion-transaction-children');
                const icon = header.querySelector('.transition-icon');
                if (container) {
                    const isVisible = container.style.display !== 'none';
                    container.style.display = isVisible ? 'none' : 'block';
                    if (icon) icon.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(90deg)';
                }
            };
        });
    }

    formatDate(d, withTime = false) {
        if (!d || d === '-') return '-';
        try {
            const dateObj = new Date(d);
            if (isNaN(dateObj.getTime())) return '-';
            return dateObj.toLocaleDateString('tr-TR', withTime ? { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit', year:'numeric'} : {});
        } catch { return String(d); }
    }

    getStatusText(type, status) {
        const list = STATUSES[type] || [];
        const found = list.find(s => s.value === status);
        return found ? found.text : status;
    }

    checkIfTurkPatentOrigin(rec) {
        const c = [rec?.origin, rec?.source].map(s => (s||'').toUpperCase());
        return c.some(s => s.includes('TURKPATENT') || s.includes('TÜRKPATENT') || s.includes('TR'));
    }

    setupEventListeners() {
        this.elements.tpQueryBtn?.addEventListener('click', () => {
             const appNo = this.currentRecord.applicationNumber;
             if(window.triggerTpQuery) window.triggerTpQuery(appNo);
             else window.open(`https://opts.turkpatent.gov.tr/trademark#bn=${encodeURIComponent(appNo)}`, '_blank');
        });
    }

    showError(msg) {
        if (this.loader) this.loader.hide();
        if (this.elements.loadingStatic) {
            this.elements.loadingStatic.style.display = 'block';
            this.elements.loadingStatic.innerHTML = `<div class="alert alert-danger m-3">${msg}</div>`;
        }
    }
}

window.manager = new PortfolioDetailManager();