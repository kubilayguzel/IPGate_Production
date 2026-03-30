// public/js/client-portal/main.js

import { supabase, transactionService } from '../../supabase-config.js';
import { AuthManager } from './AuthManager.js';
import { PortfolioManager } from './PortfolioManager.js';
import { TaskManager } from './TaskManager.js';
import { InvoiceManager } from './InvoiceManager.js';
import { ContractManager } from './ContractManager.js';
import { RenderHelper } from './RenderHelper.js';
import Pagination from '../pagination.js';

class ClientPortalController {
    constructor() {
        this.authManager = new AuthManager();
        this.portfolioManager = new PortfolioManager();
        this.taskManager = new TaskManager();
        this.invoiceManager = new InvoiceManager();
        this.contractManager = new ContractManager();
        
        this.state = {
            selectedClientId: 'ALL',
            linkedClients: [],
            countries: new Map(),
            transactionTypes: new Map(),
            
            portfolios: [], suits: [], tasks: [], invoices: [], contracts: [],
            filteredPortfolios: [], filteredSuits: [], filteredTasks: [], filteredInvoices: [], filteredContracts: [], filteredObjections: [],

            paginations: { portfolio: null, suit: null, task: null, invoice: null, contract: null, objection: null },
            activeColumnFilters: {},
            sortStates: {},
            selectedRecords: new Set()
        };

        this.renderHelper = new RenderHelper(this.state);
        this.exposeGlobalFunctions();
    }

    async init() {
        if (window.SimpleLoadingController) window.SimpleLoadingController.show('Portal Hazırlanıyor', 'Verileriniz güvenle getiriliyor...');

        const isAuth = await this.authManager.initSession();
        if (!isAuth) { window.location.href = 'index.html'; return; }

        await this.loadDictionaries();

        const user = this.authManager.user;
        document.getElementById('userName').textContent = user.user_metadata?.display_name || user.email;
        document.getElementById('welcomeUserName').textContent = user.user_metadata?.display_name || user.email;
        document.getElementById('userAvatar').textContent = (user.user_metadata?.display_name || user.email || 'U').charAt(0).toUpperCase();

        this.state.linkedClients = await this.authManager.getLinkedClients();
        this.renderClientSelector();
        this.initTheme();
        this.setupEventListeners();

        await this.loadAllData();
    }

    async loadDictionaries() {
        try {
            const { data: countryData } = await supabase.from('common').select('data').eq('id', 'countries').single();
            if (countryData?.data?.list) countryData.data.list.forEach(c => this.state.countries.set(c.code, c.name));
            const { data: txData } = await supabase.from('transaction_types').select('*');
            if (txData) txData.forEach(t => this.state.transactionTypes.set(String(t.id), t));
        } catch (e) { console.warn("Sözlükler yüklenemedi:", e); }
    }

    renderClientSelector() {
        const clients = this.state.linkedClients;
        if (clients.length <= 1) return;

        const dropdownMenu = document.getElementById('clientDropdownMenu');
        dropdownMenu.innerHTML = `<a class="dropdown-item" href="#" onclick="window.switchClient('ALL')"><strong>Tümü</strong></a><div class="dropdown-divider"></div>`;
        clients.forEach(c => dropdownMenu.innerHTML += `<a class="dropdown-item" href="#" onclick="window.switchClient('${c.id}')">${c.name}</a>`);
        document.getElementById('clientSelectorContainer').style.display = 'block';

        const savedClient = sessionStorage.getItem('selectedClientSession');
        if (!savedClient) {
            const modalList = document.getElementById('clientSelectionList');
            modalList.innerHTML = `<button type="button" class="list-group-item list-group-item-action font-weight-bold" onclick="window.switchClient('ALL', true)">Tüm Müşterileri Göster</button>`;
            clients.forEach(c => modalList.innerHTML += `<button type="button" class="list-group-item list-group-item-action" onclick="window.switchClient('${c.id}', true)">${c.name}</button>`);
            $('#clientSelectionModal').modal('show');
        } else {
            this.state.selectedClientId = savedClient;
            this.updateClientNameDisplay();
        }
    }

    updateClientNameDisplay() {
        let nameText = 'Tüm Müşteriler';
        if (this.state.selectedClientId !== 'ALL') {
            const client = this.state.linkedClients.find(c => c.id === this.state.selectedClientId);
            if (client) nameText = client.name;
        }
        document.getElementById('currentClientName').textContent = nameText;
    }

    async loadAllData() {
        if (window.SimpleLoadingController && !document.getElementById('simple-loading-overlay')) {
            window.SimpleLoadingController.show('Veriler Yükleniyor', 'Analizler hazırlanıyor...');
        }

        try {
            let targetIds = this.state.selectedClientId === 'ALL' ? this.state.linkedClients.map(c => c.id) : [this.state.selectedClientId];
            if (targetIds.length === 0) {
                if (window.SimpleLoadingController) window.SimpleLoadingController.hide();
                return; 
            }

            const [portfolios, suits, invoices, contracts] = await Promise.all([
                this.portfolioManager.getPortfolios(targetIds),
                this.portfolioManager.getSuits(targetIds),
                this.invoiceManager.getInvoices(targetIds),
                this.contractManager.getContracts(targetIds)
            ]);

            const tasks = await this.taskManager.getTasks(targetIds, portfolios.map(x => x.id));

            this.state.portfolios = portfolios;
            this.state.suits = suits;
            this.state.tasks = tasks;
            this.state.invoices = invoices;
            this.state.contracts = contracts;

            this.applyAllFilters();
            this.updateDashboardCounts();
            
            if ($('#portfolioTopTabs a.nav-link.active').attr('href') === '#reports') this.renderReports();

        } catch (error) {
            console.error("Veri yükleme hatası:", error);
        } finally {
            if (window.SimpleLoadingController) window.SimpleLoadingController.hide();
        }
    }

    applyAllFilters() {
        this.filterPortfolios();
        this.filterTasks();
        this.filterInvoices();
        this.filterContracts();
        this.filterSuits();
        this.prepareAndRenderObjections();
    }

    updateDashboardCounts() {
        document.getElementById('dashPortfolio').textContent = this.state.portfolios.length;
        
        let pendingApprovals = 0; 
        let renewalApprovals = 0; 
        let bulletinWatch = 0;    
        let completedTasks = 0;   
        
        let davaPending = 0;      
        let davaCompleted = 0;    
        
        let unpaidInvoices = 0;
        this.state.invoices.forEach(i => { if (i.status === 'unpaid') unpaidInvoices++; });

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        this.state.tasks.forEach(t => {
            if (String(t.taskType) === '53' || String(t.taskType) === '66') return;

            const isPending = (t.status === 'awaiting_client_approval' || t.status === 'pending');
            const isDava = String(t.taskType) === '49' || (t.title || '').toLowerCase().includes('dava');
            
            if (isDava) {
                isPending ? davaPending++ : davaCompleted++;
            } else {
                if (String(t.taskType) === '20') {
                    // 🔥 ÇÖZÜM 2: Süresi geçmiş bültenleri sayaca dahil etmiyoruz
                    let isExp = false;
                    const due = t.dueDate || t.officialDueDate;
                    if (due) {
                        const d = new Date(due);
                        d.setHours(0, 0, 0, 0);
                        if (d < today) isExp = true;
                    }
                    if (isPending && !isExp) {
                        bulletinWatch++;
                    }
                } else if (String(t.taskType) === '22') {
                    isPending ? renewalApprovals++ : completedTasks++; 
                } else {
                    isPending ? pendingApprovals++ : completedTasks++; 
                }
            }
        });

        // 🔥 ÇÖZÜM 1: Bülten İzleme sayısını Dashboard'daki Genel Onay Bekleyenler toplamına dahil ediyoruz
        const totalPendingForAll = pendingApprovals + renewalApprovals + davaPending + bulletinWatch;
        document.getElementById('dashPendingApprovals').textContent = totalPendingForAll;
        document.getElementById('dashUnpaidInvoices').textContent = unpaidInvoices;
        
        document.getElementById('taskCount-marka-total').textContent = pendingApprovals + renewalApprovals + bulletinWatch;
        document.getElementById('taskCount-dava-total').textContent = davaPending;
        
        document.getElementById('taskCount-pending-approval').textContent = pendingApprovals;
        document.getElementById('taskCount-renewal-approval').textContent = renewalApprovals;
        document.getElementById('taskCount-bulletin-watch').textContent = bulletinWatch;
        
        document.getElementById('taskCount-dava-pending').textContent = davaPending;
        document.getElementById('taskCount-dava-completed').textContent = davaCompleted;
    }

    // ==========================================
    // PORTFÖY FİLTRELEME VE RENDER (Marka, Patent, Tasarım Ayrımı)
    // ==========================================
    filterPortfolios() {
        const searchVal = (document.getElementById('portfolioSearchText')?.value || '').toLowerCase().trim();
        const statusVal = document.getElementById('portfolioDurumFilter')?.value || 'TÜMÜ';
        const menseVal = document.getElementById('menseFilter')?.value || 'HEPSI';

        let filtered = this.state.portfolios.filter(item => {
            // 🔥 ÇÖZÜM: Eğer bir parentId'si varsa bu bir yurtdışı/alt kayıttır, ana listede (ve sayfalama sayısında) tek başına sayma!
            if (item.parentId) return false;

            const originRaw = (item.origin || 'TÜRKPATENT').toUpperCase();
            // 🔥 DÜZELTME: TÜRK ve TURK kelimelerinin ikisi de kontrol ediliyor
            const isTurk = originRaw.includes('TURK') || originRaw.includes('TÜRK');
            
            if (menseVal === 'TÜRKPATENT' && !isTurk) return false;
            if (menseVal === 'YURTDISI' && isTurk) return false;

            if (searchVal) {
                const searchable = `${item.title} ${item.applicationNumber} ${item.registrationNumber}`.toLowerCase();
                if (!searchable.includes(searchVal)) return false;
            }

            if (statusVal !== 'TÜMÜ' && !(item.status || '').toLowerCase().includes(statusVal.toLowerCase())) return false;

            for (const [key, selectedValues] of Object.entries(this.state.activeColumnFilters)) {
                if (!key.startsWith('marka-list-')) continue;
                const colIdx = key.split('-').pop();
                let cellValue = '';
                if (colIdx == '1') cellValue = isTurk ? 'TÜRKPATENT' : (item.country || 'Yurtdışı');
                else if (colIdx == '3') cellValue = item.title || item.brandText || '';
                else if (colIdx == '7') cellValue = item.status || '';

                if (!selectedValues.includes(cellValue.trim())) return false;
            }
            return true;
        });

        const markaList = filtered.filter(p => !p.type || p.type.toLowerCase().includes('marka') || p.type.toLowerCase().includes('trademark'));
        const patentList = filtered.filter(p => p.type && p.type.toLowerCase().includes('patent'));
        const tasarimList = filtered.filter(p => p.type && (p.type.toLowerCase().includes('design') || p.type.toLowerCase().includes('tasarim')));

        this.state.filteredPortfolios = markaList;
        if (!this.state.paginations.portfolio) {
            this.state.paginations.portfolio = new Pagination({
                itemsPerPage: 10, containerId: 'markaPagination',
                onPageChange: (page, perPage) => {
                    const start = (page - 1) * perPage;
                    this.renderPortfolioTable(this.state.filteredPortfolios.slice(start, start + perPage), start);
                }
            });
        }
        this.state.paginations.portfolio.update(markaList.length);
        this.renderPortfolioTable(markaList.slice(0, 10), 0);

        this.renderPatentTable(patentList);
        this.renderTasarimTable(tasarimList);
    }

    renderPortfolioTable(dataSlice, startIndex) {
        const tbody = document.querySelector('#marka-list tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (dataSlice.length === 0) { 
            tbody.innerHTML = `<tr><td colspan="11" class="text-center text-muted py-4">Kayıt bulunamadı.</td></tr>`; 
            return; 
        }

        const statusTranslations = {
            'registered': 'Tescilli', 'application': 'Başvuru', 'filed': 'Başvuru', 'published': 'Yayınlandı',
            'rejected': 'Reddedildi', 'partially_rejected': 'Kısmen Reddedildi', 'partially rejected': 'Kısmen Reddedildi',
            'withdrawn': 'Geri Çekildi', 'cancelled': 'İptal Edildi', 'expired': 'Süresi Doldu', 'dead': 'Geçersiz',
            'opposition': 'İtiraz Aşamasında', 'appealed': 'Karara İtiraz', 'pending': 'İşlem Bekliyor'
        };

        dataSlice.forEach((item, index) => {
            const actualIndex = startIndex + index;
            const row = document.createElement('tr');
            
            const originDisplay = item.origin || 'TÜRKPATENT';
            const childRecords = this.state.portfolios.filter(p => p.parentId === item.id);
            const isInternational = childRecords.length > 0;
            const imgHtml = item.brandImageUrl ? `<img src="${item.brandImageUrl}" class="brand-thumb">` : '-';
            
            let badgeClass = 'secondary';
            const st = (item.status || '').toLowerCase();
            if (st.includes('tescil') || st.includes('registered')) badgeClass = 'success';
            else if (st.includes('başvuru') || st.includes('filed')) badgeClass = 'primary';
            else if (st.includes('red') || st.includes('rejected')) badgeClass = 'danger';
            else if (st.includes('itiraz') || st.includes('opposition')) badgeClass = 'warning';

            const displayStatus = statusTranslations[st] || item.status || 'Bilinmiyor';
            const isChecked = this.state.selectedRecords.has(String(item.id)) ? 'checked' : ''; // 🔥 Seçim Kontrolü

            row.innerHTML = `
                <td>
                    <div class="custom-control custom-checkbox">
                        <input type="checkbox" class="custom-control-input record-checkbox" id="chk-${item.id}" data-id="${item.id}" ${isChecked}>
                        <label class="custom-control-label" for="chk-${item.id}"></label>
                    </div>
                </td>
                <td>${isInternational ? '<i class="fas fa-chevron-right mr-2"></i>' : ''}${actualIndex + 1}</td>
                <td class="col-origin">${originDisplay}</td>
                <td class="col-sample text-center">${imgHtml}</td>
                <td style="max-width: 220px;" class="text-truncate" title="${item.title}"><a href="#" class="portfolio-detail-link" data-item-id="${item.id}">${item.title}</a></td>
                <td>${item.applicationNumber}</td>
                <td>${item.registrationNumber}</td>
                <td>${this.renderHelper.formatDate(item.applicationDate)}</td>
                <td>${this.renderHelper.formatDate(item.renewalDate)}</td> 
                <td><span class="badge badge-${badgeClass}">${displayStatus}</span></td>
                <td style="max-width: 150px;" class="text-truncate" title="${item.classes}">${item.classes}</td>
            `;

            if (isInternational) {
                row.classList.add('accordion-header-row');
                row.setAttribute('data-toggle', 'collapse');
                row.setAttribute('data-target', `#accordion-yurtdisi-${item.id}`);
            }
            tbody.appendChild(row);

            if (isInternational) {
                const detailRow = document.createElement('tr');
                const childHtml = childRecords.map((child, cIdx) => {
                    const childCountry = this.state.countries.get(child.country) || child.country || 'Bilinmiyor';
                    const cSt = (child.status || '').toLowerCase();
                    const cDisplayStatus = statusTranslations[cSt] || child.status || 'Bilinmiyor';

                    return `<tr>
                        <td></td> <td>${actualIndex+1}.${cIdx+1}</td>
                        <td>${childCountry}</td>
                        <td>${child.applicationNumber}</td>
                        <td>${this.renderHelper.formatDate(child.applicationDate)}</td>
                        <td>${this.renderHelper.formatDate(child.renewalDate)}</td>
                        <td><span class="badge badge-secondary">${cDisplayStatus}</span></td>
                        <td style="max-width: 150px;" class="text-truncate" title="${child.classes}">${child.classes}</td>
                    </tr>`;
                }).join('');
                
                detailRow.innerHTML = `<td colspan="11" class="p-0"><div class="collapse" id="accordion-yurtdisi-${item.id}"><table class="table mb-0 accordion-table bg-light"><thead><tr><th></th><th>#</th><th>Ülke</th><th>Başvuru No</th><th>Başvuru T.</th><th>Yenileme T.</th><th>Durum</th><th>Sınıflar</th></tr></thead><tbody>${childHtml}</tbody></table></div></td>`;
                tbody.appendChild(detailRow);
            }
        });
        
        const currentFilter = $("#menseFilter").val();
        if (currentFilter === 'TÜRKPATENT') $('#marka-list th.col-origin, #marka-list td.col-origin').hide();
        else $('#marka-list th.col-origin, #marka-list td.col-origin').show();
    }

    renderPatentTable(dataList) {
        const tbody = document.querySelector('#patent-list tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (dataList.length === 0) { 
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">Patent kaydı bulunamadı.</td></tr>`; 
            return; 
        }
        
        dataList.forEach((item, index) => {
            tbody.innerHTML += `<tr>
                <td>${index + 1}</td>
                <td><a href="#" class="portfolio-detail-link" data-item-id="${item.id}">${item.title}</a></td>
                <td>${item.applicationNumber}</td>
                <td><span class="badge badge-secondary">${item.status || '-'}</span></td>
                <td>${this.renderHelper.formatDate(item.applicationDate)}</td>
            </tr>`;
        });
    }

    renderTasarimTable(dataList) {
        const tbody = document.querySelector('#tasarim-list tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (dataList.length === 0) { 
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">Tasarım kaydı bulunamadı.</td></tr>`; 
            return; 
        }
        
        dataList.forEach((item, index) => {
            const imgHtml = item.brandImageUrl ? `<img src="${item.brandImageUrl}" class="brand-thumb" style="max-height:60px; object-fit:contain;">` : '-';
            tbody.innerHTML += `<tr>
                <td>${index + 1}</td>
                <td class="text-center">${imgHtml}</td>
                <td><a href="#" class="portfolio-detail-link" data-item-id="${item.id}">${item.title}</a></td>
                <td>${item.applicationNumber}</td>
                <td><span class="badge badge-secondary">${item.status || '-'}</span></td>
                <td>${item.classes}</td>
            </tr>`;
        });
    }

    filterSuits() {
        let filtered = this.state.suits.filter(item => {
            for (const [key, selectedValues] of Object.entries(this.state.activeColumnFilters)) {
                if (!key.startsWith('dava-list-')) continue;
                const colIdx = key.split('-').pop();
                let cellValue = '';
                if (colIdx == '1') cellValue = item.caseNo || '';
                else if (colIdx == '2') cellValue = item.title || '';
                else if (colIdx == '4') cellValue = item.court || '';
                else if (colIdx == '5') cellValue = item.opposingParty || '';
                else if (colIdx == '7') cellValue = item.suitStatus || '';
                if (!selectedValues.includes(cellValue.trim())) return false;
            }
            return true;
        });

        this.state.filteredSuits = filtered;
        if (!this.state.paginations.suit) {
            this.state.paginations.suit = new Pagination({
                itemsPerPage: 10, containerId: 'davaPagination',
                onPageChange: (page, perPage) => {
                    const start = (page - 1) * perPage;
                    this.renderHelper.renderDavaTable(this.state.filteredSuits.slice(start, start + perPage), start);
                }
            });
        }
        this.state.paginations.suit.update(filtered.length);
        this.renderHelper.renderDavaTable(filtered.slice(0, 10), 0);
    }

    async prepareAndRenderObjections() {
        const REQUEST_RESULT_STATUS = {
            '24': 'Eksiklik Bildirimi', '28': 'Kabul', '29': 'Kısmi Kabul', '30': 'Ret',
            '31': 'B.S - Kabul', '32': 'B.S - Kısmi Kabul','33': 'B.S - Ret',
            '34': 'İ.S - Kabul', '35': 'İ.S - Kısmi Kabul','36': 'İ.S - Ret',
            '50': 'Kabul', '51': 'Kısmi Kabul', '52': 'Ret'
        };

        const PARENT_TYPES = ['7', '19', '20'];
        const objectionTasks = this.state.tasks.filter(t => PARENT_TYPES.includes(String(t.taskType)));
        
        if (objectionTasks.length === 0) { this.renderHelper.renderObjectionTable([]); return; }

        const ipRecordIds = [...new Set(objectionTasks.map(t => t.relatedIpRecordId).filter(Boolean))];
        const { data: transactionsData } = await supabase.from('transactions').select('*, transaction_documents(*)').in('ip_record_id', ipRecordIds);
        const allTransactions = transactionsData || [];
        const rows = [];

        objectionTasks.forEach(task => {
            const ipRecord = this.state.portfolios.find(p => p.id === task.relatedIpRecordId) || {};
            const taskTxs = allTransactions.filter(tx => tx.ip_record_id === task.relatedIpRecordId);
            
            let parentTx = task.details?.triggeringTransactionId ? taskTxs.find(tx => String(tx.id) === String(task.details.triggeringTransactionId)) : taskTxs.filter(tx => String(tx.transaction_type_id) === String(task.taskType)).sort((a,b) => new Date(b.created_at) - new Date(a.created_at))[0];
            if (!parentTx) parentTx = { id: 'virt-'+task.id, transaction_type_id: task.taskType, created_at: task.createdAt, isVirtual: true };

            // Önce alt işlemleri (child) buluyoruz
            const childrenTxs = parentTx.isVirtual ? [] : taskTxs.filter(tx => tx.transaction_hierarchy === 'child' && tx.parent_id === parentTx.id);

            // 🔥 ÇÖZÜM 3: Durumu Alt İşlemlerden (Child 50, 51, 52) Kontrol Etme
            let computedStatus = 'Karar Bekleniyor', badgeColor = 'secondary';
            const decisionChild = childrenTxs.find(c => ['50', '51', '52'].includes(String(c.transaction_type_id)));
            
            if (decisionChild) {
                const tId = String(decisionChild.transaction_type_id);
                if (tId === '50') { computedStatus = 'Kabul'; badgeColor = 'success'; }
                else if (tId === '51') { computedStatus = 'Kısmen Kabul'; badgeColor = 'warning'; }
                else if (tId === '52') { computedStatus = 'Ret'; badgeColor = 'danger'; }
            } else {
                // Eğer alt karar işlemi yoksa eski yönteme (Ana işlemin sonucuna veya Onay Bekliyor durumuna) bak
                const rr = parentTx.request_result;
                if (rr && REQUEST_RESULT_STATUS[String(rr)]) {
                    computedStatus = REQUEST_RESULT_STATUS[String(rr)];
                    if (computedStatus.includes('Ret')) badgeColor = 'danger';
                    else if (computedStatus.includes('Kabul')) badgeColor = 'success';
                    else badgeColor = 'info';
                } else if ((task.status || '').includes('awaiting')) { 
                    computedStatus = 'Onay Bekliyor'; badgeColor = 'warning'; 
                }
            }

            // 🔥 ÇÖZÜM: Karşı tarafın (Bülten) markası portföyde yoksa, eksik bilgileri Görev'in (Task) JSON detayından çek!
            const originVal = ipRecord.origin || task.details?.origin || 'TÜRKPATENT';
            const imgVal = ipRecord.brandImageUrl || task.brandImageUrl || task.details?.competitorBrandImage || task.details?.brandInfo?.brandImage || '';
            const titleVal = ipRecord.title || task.recordTitle || task.details?.objectionTarget || task.details?.brandInfo?.brandName || 'İsimsiz Marka';
            const appNoVal = ipRecord.applicationNumber || task.appNo || task.details?.targetAppNo || task.details?.brandInfo?.applicationNo || '-';
            
            // 🔥 ÇÖZÜM 1: Başvuru Sahibi ("Karşı Taraf / Müvekkil" yazısını kaldırıp asıl ismi alma)
            // Sırasıyla olası yerlerden ismi ara, bulamazsan ipRecord'un kendisine (Müvekkile) bak
            let applicantVal = task.details?.competitorOwner || task.details?.brandInfo?.applicantName || task.details?.applicantName;
            if (!applicantVal && ipRecord.applicants && ipRecord.applicants.length > 0) {
                applicantVal = ipRecord.applicants.map(a => a.name).join(', ');
            }
            if (!applicantVal) applicantVal = '-'; // Hiçbiri yoksa tire koy

            const bDateVal = task.details?.brandInfo?.opposedMarkBulletinDate || task.details?.bulletinDate || '-';
            const bNoVal = task.details?.brandInfo?.opposedMarkBulletinNo || task.details?.bulletinNo || '-';

            rows.push({
                id: task.id, 
                recordId: task.relatedIpRecordId, 
                origin: originVal, 
                brandImageUrl: imgVal,
                title: titleVal, 
                transactionTypeName: task.taskTypeDisplay, 
                applicationNumber: appNoVal,
                applicantName: applicantVal, 
                bulletinDate: bDateVal,
                bulletinNo: bNoVal, 
                epatsDate: parentTx.created_at,
                statusText: computedStatus, 
                statusBadge: badgeColor, 
                allParentDocs: parentTx.transaction_documents || [],
                childrenData: childrenTxs
            });
        });

        let filtered = rows.filter(item => {
            for (const [key, selectedValues] of Object.entries(this.state.activeColumnFilters)) {
                if (!key.startsWith('dava-itiraz-list-')) continue;
                const colIdx = key.split('-').pop();
                let cellValue = '';
                if (colIdx == '3') cellValue = item.title || '';
                else if (colIdx == '4') cellValue = item.transactionTypeName || '';
                else if (colIdx == '6') cellValue = item.applicantName || '';
                else if (colIdx == '10') cellValue = item.statusText || '';
                if (!selectedValues.includes(cellValue.trim())) return false;
            }
            return true;
        });

        this.state.filteredObjections = filtered;
        if (!this.state.paginations.objection) {
            this.state.paginations.objection = new Pagination({
                itemsPerPage: 10, containerId: 'davaItirazPagination',
                onPageChange: (page, perPage) => {
                    const start = (page - 1) * perPage;
                    this.renderHelper.renderObjectionTable(this.state.filteredObjections.slice(start, start + perPage), start);
                }
            });
        }
        this.state.paginations.objection.update(filtered.length);
        this.renderHelper.renderObjectionTable(filtered.slice(0, 10), 0);
    }

    filterInvoices() {
        const searchVal = (document.getElementById('invoiceSearchText')?.value || '').toLowerCase().trim();
        const statusVal = document.getElementById('invoiceDurumFilter')?.value || 'TÜMÜ';

        let filtered = this.state.invoices.filter(inv => {
            if (searchVal && !`${inv.invoiceNo} ${inv.taskTitle} ${inv.applicationNumber}`.toLowerCase().includes(searchVal)) return false;
            if (statusVal !== 'TÜMÜ' && inv.status !== statusVal) return false;
            return true;
        });

        this.state.filteredInvoices = filtered;
        if (!this.state.paginations.invoice) {
            this.state.paginations.invoice = new Pagination({
                itemsPerPage: 10, containerId: 'invoices-pagination-container',
                onPageChange: (page, perPage) => {
                    const start = (page - 1) * perPage;
                    this.renderInvoicesTable(this.state.filteredInvoices.slice(start, start + perPage));
                }
            });
        }
        this.state.paginations.invoice.update(filtered.length);
        this.renderInvoicesTable(filtered.slice(0, 10));
    }

    renderInvoicesTable(dataSlice) {
        const tbody = document.querySelector('#invoices table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (dataSlice.length === 0) { tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted">Kayıt bulunamadı.</td></tr>`; return; }

        dataSlice.forEach(inv => {
            let statusText = inv.status, badgeClass = 'secondary';
            if (inv.status === 'paid') { statusText = 'Ödendi'; badgeClass = 'success'; }
            else if (inv.status === 'unpaid') { statusText = 'Ödenmedi'; badgeClass = 'danger'; }
            else if (inv.status === 'partially_paid') { statusText = 'Kısmen Ödendi'; badgeClass = 'warning'; }

            const formatArr = (arr) => (!arr || arr.length === 0) ? '0 TRY' : arr.map(x => `${x.amount} ${x.currency}`).join(' + ');

            tbody.innerHTML += `<tr>
                <td class="font-weight-bold">${inv.invoiceNo}</td>
                <td>#${inv.taskId}</td>
                <td>${inv.applicationNumber}</td>
                <td>${this.renderHelper.formatDate(inv.createdAt)}</td>
                <td>${inv.taskTitle}</td>
                <td>${inv.officialFee.amount} ${inv.officialFee.currency}</td>
                <td>${inv.serviceFee.amount} ${inv.serviceFee.currency}</td>
                <td class="font-weight-bold text-primary">${formatArr(inv.totalAmount)}</td>
                <td><span class="badge badge-${badgeClass}">${statusText}</span></td>
                <td><button class="btn btn-sm btn-outline-primary"><i class="fas fa-download"></i></button></td>
            </tr>`;
        });
    }

    filterContracts() {
        const searchVal = (document.getElementById('contractsSearchText')?.value || '').toLowerCase().trim();
        let filtered = this.state.contracts.filter(doc => !searchVal || `${doc.type} ${doc.countryName} ${doc.ownerName}`.toLowerCase().includes(searchVal));

        this.state.filteredContracts = filtered;
        if (!this.state.paginations.contract) {
            this.state.paginations.contract = new Pagination({
                itemsPerPage: 10, containerId: 'contractsPagination',
                onPageChange: (page, perPage) => {
                    const start = (page - 1) * perPage;
                    this.renderContractsTable(this.state.filteredContracts.slice(start, start + perPage), start);
                }
            });
        }
        this.state.paginations.contract.update(filtered.length);
        this.renderContractsTable(filtered.slice(0, 10), 0);
    }

    renderContractsTable(dataSlice, startIndex) {
        const tbody = document.getElementById('contractsTableBody');
        const noMsg = document.getElementById('noContractsMessage');
        tbody.innerHTML = '';
        if (dataSlice.length === 0) { noMsg.style.display = 'block'; return; }
        noMsg.style.display = 'none';

        dataSlice.forEach((doc, index) => {
            const btn = doc.url ? `<a href="${doc.url}" target="_blank" class="btn btn-sm btn-outline-primary"><i class="fas fa-eye"></i> İncele</a>` : `<span class="badge badge-secondary">Dosya Yok</span>`;
            tbody.innerHTML += `<tr><td>${startIndex + index + 1}</td><td class="font-weight-bold text-primary"><i class="fas fa-file-alt mr-2 text-muted"></i>${doc.type}</td><td>${doc.countryName || '-'}</td><td>${this.renderHelper.formatDate(doc.validityDate)}</td><td class="text-center">${btn}</td></tr>`;
        });
    }

    filterTasks() {
        const searchVal = (document.getElementById('taskSearchText')?.value || '').toLowerCase().trim();
        const statusVal = document.getElementById('taskStatusFilter')?.value || 'TÜMÜ';
        const activeSubCard = document.querySelector('.detail-card-link.active-list-type');
        const taskTypeFilter = activeSubCard ? activeSubCard.dataset.taskType : 'pending-approval';

        let filtered = this.state.tasks.filter(t => {
                // YENİ EKLENEN: 53 (Tahakkuk) ve 66 (Değerlendirme) tipli işleri listeye hiçbir şekilde alma
                if (String(t.taskType) === '53' || String(t.taskType) === '66') return false;

                if (statusVal !== 'TÜMÜ' && t.status !== statusVal) return false;
                if (searchVal && !`${t.title} ${t.appNo} ${t.recordTitle}`.toLowerCase().includes(searchVal)) return false;

                const isDava = String(t.taskType) === '49' || (t.title || '').toLowerCase().includes('dava');
                // DÜZELTME: Sayaçla aynı mantığı kurduk, hem pending hem awaiting dahil
                const isPending = (t.status === 'awaiting_client_approval' || t.status === 'pending');

                if (taskTypeFilter === 'pending-approval') return !isDava && isPending && String(t.taskType) !== '20' && String(t.taskType) !== '22';
                
                // DÜZELTME: Tamamlananlarda bültenleri dışarıda bırak (Kendi sekmeleri var)
                if (taskTypeFilter === 'completed-tasks') return !isDava && !isPending && String(t.taskType) !== '20'; 
                
                if (taskTypeFilter === 'bulletin-watch') return String(t.taskType) === '20';
                
                // DÜZELTME: Yenileme Onaylarında SADECE onay bekleyenleri listele, bitenleri Tamamlananlar'a at
                if (taskTypeFilter === 'renewal-approval') return String(t.taskType) === '22' && isPending; 
                
                if (taskTypeFilter === 'dava-pending') return isDava && isPending;
                if (taskTypeFilter === 'dava-completed') return isDava && !isPending;
                return true;
            });

        this.state.filteredTasks = filtered;
        this.renderHelper.renderTaskSection(filtered, 'task-list-container', taskTypeFilter);
    }

    // ==========================================
    // ETKİLEŞİMLER (EVENT LISTENERS) & FİLTRELER
    // ==========================================
    setupEventListeners() {
        document.getElementById('logoutBtn').addEventListener('click', () => { supabase.auth.signOut().then(() => window.location.href = 'index.html'); });

        // TAB DEĞİŞİMİ DİNLEYİCİSİ (Arayüz Yenilemeleri İçin)
        $('a[data-toggle="tab"]').on('shown.bs.tab', (e) => { 
            const target = $(e.target).attr("href");
            if (target === '#reports') this.renderReports(); 
            // Sekme değiştiğinde filtreleri tetikleyerek arayüzü tazeleyelim
            if (['#marka-list', '#patent-list', '#tasarim-list', '#dava-list', '#dava-itiraz-list'].includes(target)) {
                this.applyAllFilters();
            }
        });

        // DASHBOARD LİNKLERİ (Tıklanan Karta Göre İlgili Sekmeyi Açma)
        $('[data-target-tab]').on('click', (e) => {
            const target = $(e.currentTarget).data('target-tab');
            $(`#sidebar a[href="#${target}"]`).tab('show');
            
            if (target === 'portfolio-content') {
                setTimeout(() => $('#portfolioTopTabs a[href="#marka-list"]').tab('show'), 100);
            } 
            // YENİ EKLENEN KISIM: İşlerim sekmesine gelindiğinde otomatik alt listeyi aç
            else if (target === 'tasks') {
                setTimeout(() => {
                    $('.task-card-link[data-target-area="marka-tasks"]').click();
                    setTimeout(() => {
                        $('.detail-card-link[data-task-type="pending-approval"]').click();
                    }, 400); // Üst menünün açılma (slideDown) animasyon süresini bekliyoruz
                }, 100);
            }
            
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        $('#menseFilter, #portfolioDurumFilter').on('change', () => this.filterPortfolios());
        $('#portfolioSearchText').on('keyup', () => this.filterPortfolios());
        $('#invoiceDurumFilter').on('change', () => this.filterInvoices());
        $('#invoiceSearchText').on('keyup', () => this.filterInvoices());
        $('#contractsSearchText').on('keyup', () => this.filterContracts());

        $('.task-card-link').click((e) => {
            const el = e.currentTarget;
            $('.task-card-link').removeClass('active-task-area'); el.classList.add('active-task-area');
            // DÜZELTME: #task-list-details eklendi
            $('#task-detail-cards, #dava-task-detail-cards, #task-list-filters, #task-list-details').slideUp();
            $('#task-list-container').html('');
            if(el.dataset.targetArea === 'marka-tasks') $('#task-detail-cards').slideDown();
            else if(el.dataset.targetArea === 'dava-tasks') $('#dava-task-detail-cards').slideDown();
        });

        $('.detail-card-link').click((e) => {
            const el = e.currentTarget;
            $('.detail-card-link').removeClass('active-list-type'); el.classList.add('active-list-type');
            // DÜZELTME: Görev listesinin konteyneri de slideDown ile açılıyor
            $('#task-list-filters, #task-list-details').slideDown();
            this.filterTasks();
        });

        $(document).on('click', '.task-action-btn', async (e) => {
            const btn = e.currentTarget; const taskId = btn.dataset.id; const action = btn.dataset.action;
            if (action === 'approve' && confirm('Bu işi onaylamak istiyor musunuz?')) {
                await supabase.from('tasks').update({ status: 'open' }).eq('id', taskId);
                alert('İş onaylandı.'); await this.loadAllData();
            } else if (action === 'reject') {
                const reason = prompt('Lütfen ret sebebini yazınız:');
                if (reason) {
                    await supabase.from('tasks').update({ status: 'müvekkil onayı - kapatıldı', rejection_reason: reason }).eq('id', taskId);
                    alert('İş reddedildi.'); await this.loadAllData();
                }
            }
        });

        $(document).on('click', '.portfolio-detail-link', async (e) => {
            e.preventDefault();
            const item = this.state.portfolios.find(p => p.id === e.currentTarget.dataset.itemId);
            if (!item) return;

            // 🔥 ÇÖZÜM 1: Tür ve Durum Çevirileri
            const typeTranslations = { 'trademark': 'Marka', 'patent': 'Patent', 'design': 'Tasarım' };
            const statusTranslations = {
                'registered': 'Tescilli', 'application': 'Başvuru', 'filed': 'Başvuru', 'published': 'Yayınlandı',
                'rejected': 'Reddedildi', 'partially_rejected': 'Kısmen Reddedildi', 'partially rejected': 'Kısmen Reddedildi',
                'withdrawn': 'Geri Çekildi', 'cancelled': 'İptal Edildi', 'expired': 'Süresi Doldu', 'dead': 'Geçersiz',
                'opposition': 'İtiraz Aşamasında', 'appealed': 'Karara İtiraz', 'pending': 'İşlem Bekliyor'
            };
            
            const displayType = typeTranslations[item.type?.toLowerCase()] || item.type || '-';
            const displayStatus = statusTranslations[item.status?.toLowerCase()] || item.status || 'Bilinmiyor';

            document.getElementById('portfolioDetailModalLabel').textContent = item.title;
            document.getElementById('modal-img').src = item.brandImageUrl || 'https://placehold.co/150x150?text=Yok';
            document.getElementById('modal-details-card').innerHTML = `<p><strong>Tür:</strong> ${displayType}</p><p><strong>Başvuru No:</strong> ${item.applicationNumber}</p><p><strong>Sınıflar:</strong> ${item.classes}</p>`;
            document.getElementById('modal-dates-card').innerHTML = `<p><strong>Başvuru:</strong> ${this.renderHelper.formatDate(item.applicationDate)}</p><p><strong>Yenileme:</strong> ${this.renderHelper.formatDate(item.renewalDate)}</p><span class="badge badge-primary">${displayStatus}</span>`;
            
            // 🔥 ÇÖZÜM 2: Eşya Listesi Gösterimi (Veritabanından gelen items'lar)
            if (item.fullClasses && item.fullClasses.length > 0) {
                const classesHtml = item.fullClasses.map(c => `
                    <div class="mb-3">
                        <h6 class="text-primary font-weight-bold">Sınıf ${c.class_no}</h6>
                        <p style="font-size:0.85rem;" class="text-muted">${Array.isArray(c.items) ? c.items.join('; ') : (c.items || '-')}</p>
                    </div>
                `).join('<hr class="my-2">');
                document.getElementById('esyaListesiContent').innerHTML = classesHtml;
            } else {
                document.getElementById('esyaListesiContent').innerHTML = '<p class="text-muted">Eşya listesi detayı bulunamadı.</p>';
            }
            
            document.querySelector('#modal-islemler tbody').innerHTML = '<tr><td colspan="4" class="text-center"><i class="fas fa-spinner fa-spin"></i> Yükleniyor...</td></tr>';
            $('#portfolioDetailModal').modal('show'); $('#myTab a[href="#modal-islemler"]').tab('show'); 
            
            // 🔥 ÇÖZÜM 3: Güvenli İşlem Geçmişi Çekimi (Zırhlı)
            try {
                // 1. İşlemleri ve İşlem Evraklarını Çek
                const { data: txs, error: txError } = await supabase.from('transactions')
                    .select('*, transaction_types(alias, name), transaction_documents(*)')
                    .eq('ip_record_id', item.id);
                
                if (txError) {
                    console.error("İşlemler çekilirken hata:", txError);
                    throw txError;
                }

                // 2. Görevleri ve Görev Evraklarını Çek
                const { data: tasksData, error: taskError } = await supabase.from('tasks')
                    .select('*, task_documents(*)')
                    .eq('ip_record_id', item.id);
                
                if (taskError) console.warn("Görevler çekilirken hata (Önemli değil):", taskError);

                // 3. Merkezi Servisle Hiyerarşiyi Kur
                const processedTransactions = transactionService.processAndOrganizeTransactions(txs || [], tasksData || []);
                this.renderHelper.renderTransactionHistory(processedTransactions, 'modal-islemler');
                
            } catch (err) {
                console.error("Geçmiş işlem render hatası:", err);
                document.querySelector('#modal-islemler tbody').innerHTML = '<tr><td colspan="4" class="text-center text-danger">İşlemler yüklenirken bir hata oluştu veya bağlantı kurulamadı.</td></tr>';
            }
        });

        $(document).on('click', '.task-compare-goods', async (e) => {
            const btn = e.currentTarget;
            document.getElementById('monitoredGoodsContent').innerHTML = '<p class="text-muted"><i class="fas fa-spinner fa-spin"></i> Yükleniyor...</p>';
            document.getElementById('competitorGoodsContent').innerHTML = '<p class="text-muted"><i class="fas fa-spinner fa-spin"></i> Yükleniyor...</p>';
            $('#goodsComparisonModal').modal('show');
            try {
                const { data: myRecord } = await supabase.from('ip_record_classes').select('class_no, items').eq('ip_record_id', btn.dataset.ipRecordId);
                document.getElementById('monitoredGoodsContent').innerHTML = myRecord?.length > 0 ? myRecord.map(c => `<div><h6 class="text-primary font-weight-bold">Sınıf ${c.class_no}</h6><p style="font-size:0.85rem">${Array.isArray(c.items) ? c.items.join('; ') : c.items}</p></div>`).join('<hr>') : '<p class="text-muted">Sınıf verisi bulunamadı.</p>';
                const cleanAppNo = String(btn.dataset.targetAppNo).replace(/[^a-zA-Z0-9]/g, '');
                const { data: compRecord } = await supabase.from('trademark_bulletin_records').select('goods').like('application_number', `%${cleanAppNo}%`).limit(1).maybeSingle();
                document.getElementById('competitorGoodsContent').innerHTML = compRecord?.goods ? (Array.isArray(compRecord.goods) ? compRecord.goods : [compRecord.goods]).map(g => `<p style="font-size:0.85rem; margin-bottom:10px;">${g}</p>`).join('') : '<p class="text-muted">Bülten kaydı eşya listesi bulunamadı.</p>';
            } catch(err) { document.getElementById('monitoredGoodsContent').innerHTML = '<p class="text-danger">Veriler yüklenirken hata oluştu.</p>'; }
        });

        // ==========================================
        // TABLO SIRALAMA (SORT) TIKLAMASI
        // ==========================================
        $(document).on('click', 'th.sortable', (e) => {
            const th = e.currentTarget;
            const table = th.closest('table');
            let containerId = table.closest('.tab-pane').id;
            if (th.closest('#invoices')) containerId = 'invoices'; 
            if (th.closest('#contracts')) containerId = 'contracts';
            
            const index = $(th).index();
            const type = th.dataset.sort || 'text';
            this.sortTable(containerId, index, type, th);
        });

        // ==========================================
        // KOLON FİLTRELEME (HUNİ İKONU) TIKLAMASI
        // ==========================================
        $(document).on('click', '.filter-icon', (e) => {
            e.stopPropagation();
            this.toggleColumnFilter(e.currentTarget);
        });

        $(document).on('click', '.apply-col-filter', (e) => {
            const btn = e.currentTarget;
            const tableId = btn.dataset.table;
            const colIdx = btn.dataset.col;
            const container = $(btn).closest('.column-filter-dropdown');
            const selected = [];
            container.find('input:checked').each(function() { selected.push($(this).val()); });
            
            const filterKey = `${tableId}-${colIdx}`;
            if (selected.length > 0) {
                this.state.activeColumnFilters[filterKey] = selected;
                $(`#${tableId} th[data-col-idx="${colIdx}"] .filter-icon`).addClass('active').css('color', '#007bff');
            } else {
                delete this.state.activeColumnFilters[filterKey];
                $(`#${tableId} th[data-col-idx="${colIdx}"] .filter-icon`).removeClass('active').css('color', '');
            }
            container.remove();
            this.applyAllFilters();
        });

        $(document).on('click', '.clear-col-filter', (e) => {
            const btn = e.currentTarget;
            const tableId = btn.dataset.table;
            const colIdx = btn.dataset.col;
            delete this.state.activeColumnFilters[`${tableId}-${colIdx}`];
            $(`#${tableId} th[data-col-idx="${colIdx}"] .filter-icon`).removeClass('active').css('color', '');
            $(btn).closest('.column-filter-dropdown').remove();
            this.applyAllFilters();
        });

        $(document).on('click', (e) => {
            if (!$(e.target).closest('.column-filter-dropdown').length && !$(e.target).hasClass('filter-icon')) {
                $('.column-filter-dropdown').remove();
            }
        });

        // 🔥 YENİ: Checkbox Seçim İşlemleri
        const portfolioTableBody = document.getElementById('marka-list');
        if (portfolioTableBody) {
            portfolioTableBody.addEventListener('change', (e) => {
                if (e.target.classList.contains('record-checkbox')) {
                    const id = e.target.dataset.id;
                    if (e.target.checked) this.state.selectedRecords.add(String(id));
                    else this.state.selectedRecords.delete(String(id));
                    
                    const exportBtn = document.getElementById('btnExportSelected');
                    if (exportBtn) exportBtn.disabled = this.state.selectedRecords.size === 0;
                }
            });
        }

        // 🔥 YENİ: Tümünü Seç (Select All) Checkbox'ı
        $(document).on('change', '#selectAllCheckbox', (e) => {
            const isChecked = e.target.checked;
            document.querySelectorAll('.record-checkbox').forEach(cb => {
                cb.checked = isChecked;
                const id = cb.dataset.id;
                if (isChecked) this.state.selectedRecords.add(String(id));
                else this.state.selectedRecords.delete(String(id));
            });
            const exportBtn = document.getElementById('btnExportSelected');
            if (exportBtn) exportBtn.disabled = this.state.selectedRecords.size === 0;
        });

        // 🔥 YENİ: Excel ve PDF Rapor Buton Tıklamaları
        $(document).on('click', '#btnExportAllExcel', (e) => { e.preventDefault(); this.exportToExcel('all'); });
        $(document).on('click', '#btnExportSelectedExcel', (e) => { 
            e.preventDefault(); 
            if(this.state.selectedRecords.size === 0) return alert('Lütfen kayıt seçin.');
            this.exportToExcel('selected'); 
        });
        $(document).on('click', '#btnExportAllPDF', (e) => { e.preventDefault(); this.exportToPDF('all'); });
        $(document).on('click', '#btnExportSelectedPDF', (e) => { 
            e.preventDefault(); 
            if(this.state.selectedRecords.size === 0) return alert('Lütfen kayıt seçin.');
            this.exportToPDF('selected'); 
        });
    }

    toggleColumnFilter(icon) {
        const tableId = icon.dataset.table;
        const colIdx = icon.dataset.col;
        const existing = $(icon).next('.column-filter-dropdown');
        if (existing.length) { existing.remove(); return; }
        $('.column-filter-dropdown').remove();

        let sourceData = [];
        if (tableId === 'marka-list') sourceData = this.state.portfolios;
        else if (tableId === 'dava-itiraz-list') sourceData = this.state.filteredObjections || []; 
        else if (tableId === 'dava-list') sourceData = this.state.suits;

        const uniqueValues = new Set();
        sourceData.forEach(item => {
            if (item.transactionHierarchy === 'child' || item.isChild) return;
            let val = '';
            if (tableId === 'marka-list') {
                if (colIdx == 1) { 
                    const o = (item.origin||'').toUpperCase(); 
                    // 🔥 DÜZELTME
                    const isTurk = o.includes('TURK') || o.includes('TÜRK');
                    val = isTurk ? 'TÜRKPATENT' : (item.country||'Yurtdışı'); 
                }
                else if (colIdx == 3) val = item.title || item.brandText || '';
                else if (colIdx == 7) val = item.status || '';
            } else if (tableId === 'dava-itiraz-list') {
                if (colIdx == 3) val = item.title || '';
                else if (colIdx == 4) val = item.transactionTypeName || '';
                else if (colIdx == 6) val = item.applicantName || '';
                else if (colIdx == 10) val = item.statusText || '';
            } else if (tableId === 'dava-list') {
                if (colIdx == 1) val = item.caseNo || '';
                else if (colIdx == 2) val = item.title || '';
                else if (colIdx == 4) val = item.court || '';
                else if (colIdx == 5) val = item.opposingParty || '';
                else if (colIdx == 7) val = item.suitStatus || '';
            }
            if (val) uniqueValues.add(val.trim());
        });

        const sorted = Array.from(uniqueValues).sort((a, b) => a.localeCompare(b, 'tr'));
        const filterKey = `${tableId}-${colIdx}`;
        
        const optionsHtml = sorted.map(val => {
            const isChecked = (this.state.activeColumnFilters[filterKey] || []).includes(val) ? 'checked' : '';
            return `<label class="filter-option" style="display:block; cursor:pointer;"><input type="checkbox" value="${val}" ${isChecked}> ${val}</label>`;
        }).join('');

        const html = `
            <div class="column-filter-dropdown" onclick="event.stopPropagation()" style="min-width:220px;">
                <input type="text" class="filter-search-input" placeholder="Ara..." onkeyup="window.filterDropdownList(this)">
                <div class="filter-options-container">${optionsHtml}</div>
                <div class="filter-actions">
                    <button class="btn btn-xs btn-light clear-col-filter" data-table="${tableId}" data-col="${colIdx}">Temizle</button>
                    <button class="btn btn-xs btn-primary apply-col-filter" data-table="${tableId}" data-col="${colIdx}">Uygula</button>
                </div>
            </div>`;

        $(icon).parent().append(html);
        $(icon).next('.column-filter-dropdown').fadeIn(200);
        setTimeout(() => $(icon).next().find('input[type="text"]').focus(), 100);
    }

    // ==========================================
    // TABLO SIRALAMA (SORT) MANTIĞI
    // ==========================================
    sortTable(listId, columnIndex, dataType, thElement) {
        let dataObj = null; let renderFn = null; let getValueFn = null;

        if (listId === 'marka-list') {
            dataObj = this.state.filteredPortfolios;
            renderFn = (slice, start) => this.renderPortfolioTable(slice, start);
            getValueFn = (item) => {
                if (columnIndex === 1) return (item.origin || item.country || '').toLowerCase();
                if (columnIndex === 3) return (item.title || item.brandText || '').toLowerCase();
                if (columnIndex === 4) return (item.applicationNumber || '').toLowerCase();
                if (columnIndex === 5) return (item.registrationNumber || '').toLowerCase();
                if (columnIndex === 6) return item.applicationDate; 
                if (columnIndex === 7) return item.renewalDate;     
                if (columnIndex === 8) return (item.status || '').toLowerCase();
                return '';
            };
        } else if (listId === 'dava-itiraz-list') {
            dataObj = this.state.filteredObjections;
            renderFn = (slice, start) => this.renderHelper.renderObjectionTable(slice, start);
            getValueFn = (item) => {
                if (columnIndex === 1) return (item.origin || '').toLowerCase();
                if (columnIndex === 3) return (item.title || '').toLowerCase();
                if (columnIndex === 4) return (item.transactionTypeName || '').toLowerCase();
                if (columnIndex === 6) return (item.applicantName || '').toLowerCase();
                if (columnIndex === 7) return item.bulletinDate; 
                if (columnIndex === 9) return item.epatsDate;    
                if (columnIndex === 10) return (item.statusText || '').toLowerCase();
                return '';
            };
        } else if (listId === 'dava-list') {
            dataObj = this.state.filteredSuits;
            renderFn = (slice, start) => this.renderHelper.renderDavaTable(slice, start);
            getValueFn = (item) => {
                if (columnIndex === 1) return (item.caseNo || '').toLowerCase();
                if (columnIndex === 2) return (item.title || '').toLowerCase();
                if (columnIndex === 4) return (item.court || '').toLowerCase();
                if (columnIndex === 6) return item.openingDate; 
                if (columnIndex === 7) return (item.suitStatus || '').toLowerCase();
                return '';
            };
        } else if (listId === 'contracts') {
            dataObj = this.state.filteredContracts;
            renderFn = (slice, start) => this.renderContractsTable(slice, start);
            getValueFn = (item) => {
                if (columnIndex === 1) return (item.type || '').toLowerCase();
                if (columnIndex === 2) return (item.countryName || '').toLowerCase();
                if (columnIndex === 3) return item.validityDate; 
                return '';
            };
        } else if (listId === 'invoices') {
            dataObj = this.state.filteredInvoices;
            renderFn = (slice) => this.renderInvoicesTable(slice);
            getValueFn = (item) => {
                if (columnIndex === 0) return (item.invoiceNo || '').toLowerCase();
                if (columnIndex === 2) return (item.applicationNumber || '').toLowerCase();
                if (columnIndex === 3) return item.createdAt;
                if (columnIndex === 4) return (item.taskTitle || '').toLowerCase();
                const getAmt = (val) => val && typeof val === 'object' ? Number(val.amount) || 0 : Number(val) || 0;
                if (columnIndex === 5) return getAmt(item.officialFee); 
                if (columnIndex === 6) return getAmt(item.serviceFee);  
                if (columnIndex === 7) return getAmt(item.totalAmount); 
                if (columnIndex === 8) return (item.status || '').toLowerCase();
                return '';
            };
        }

        if (!dataObj || dataObj.length === 0) return;

        const isAsc = !thElement.classList.contains('sort-asc');
        const table = thElement.closest('table');
        
        table.querySelectorAll('thead th').forEach(h => {
            h.classList.remove('sort-asc', 'sort-desc');
            const icon = h.querySelector('i:not(.filter-icon)');
            if(icon) icon.className = 'fas fa-sort';
        });
        thElement.classList.add(isAsc ? 'sort-asc' : 'sort-desc');
        const activeIcon = thElement.querySelector('i:not(.filter-icon)');
        if(activeIcon) activeIcon.className = isAsc ? 'fas fa-sort-up' : 'fas fa-sort-down';

        const normalize = (val) => {
            if (val === null || val === undefined) return (dataType === 'amount' || dataType === 'number') ? 0 : '';
            if (dataType === 'date') {
                const parsed = Date.parse(val);
                return isNaN(parsed) ? 0 : parsed;
            }
            return val;
        };

        dataObj.sort((a, b) => {
            let valA = normalize(getValueFn(a));
            let valB = normalize(getValueFn(b));
            if (valA < valB) return isAsc ? -1 : 1;
            if (valA > valB) return isAsc ? 1 : -1;
            return 0;
        });

        const paginationObj = this.state.paginations[listId.replace('-list', '').replace('s', '')];
        if (paginationObj) {
            paginationObj.currentPage = 1;
            const perPage = paginationObj.itemsPerPage || 10;
            if (listId === 'invoices') renderFn(dataObj.slice(0, perPage));
            else renderFn(dataObj.slice(0, perPage), 0);
        } else {
            if (listId === 'invoices') renderFn(dataObj);
            else renderFn(dataObj, 0);
        }
    }

    // ==========================================
    // 🔥 ÜST YÖNETİM RAPORU İÇİN AKILLI EXPORT FONKSİYONU
    // ==========================================
    async exportToExcel(type) {
        const activeTabId = $('#portfolioTopTabs a.nav-link.active').attr('href');
        if (activeTabId !== '#marka-list') {
            alert('Excel dışa aktarımı şimdilik sadece Marka sekmesi için aktiftir.');
            return;
        }

        let allFilteredData = this.state.filteredPortfolios || [];
        let dataToExport = [];

        if (type === 'selected') {
            const selectedIds = this.state.selectedRecords;
            if (!selectedIds || selectedIds.size === 0) {
                alert('Lütfen tablodan en az bir kayıt seçiniz.');
                return;
            }
            dataToExport = allFilteredData.filter(item => selectedIds.has(String(item.id)));
        } else {
            dataToExport = [...allFilteredData];
        }

        if (dataToExport.length === 0) {
            alert('Aktarılacak veri bulunamadı.');
            return;
        }

        if (window.SimpleLoadingController) window.SimpleLoadingController.show('Üst Yönetim Raporu Hazırlanıyor', 'Görseller ve veriler işleniyor, lütfen bekleyin...');

        try {
            const loadScript = (src) => {
                return new Promise((resolve, reject) => {
                    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
                    const script = document.createElement('script');
                    script.src = src;
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
            };

            if (!window.ExcelJS) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js');
            if (!window.saveAs) await loadScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js');

            const sortedData = [];
            const processedIds = new Set(); 
            let parentCounter = 0;

            // 🔥 1. ADIM: Hiyerarşi ve Sıra Numarası (Index) Oluşturma (1, 1.1, 1.2 vb.)
            dataToExport.forEach(parent => {
                if (!processedIds.has(String(parent.id))) {
                    parentCounter++;
                    sortedData.push({ ...parent, exportType: 'parent', displayIndex: String(parentCounter) });
                    processedIds.add(String(parent.id));

                    // WIPO veya Yurtdışı ise alt kayıtları bul
                    const children = this.state.portfolios.filter(p => p.parentId === parent.id);
                    if (children && children.length > 0) {
                        children.forEach((child, idx) => {
                            if (!processedIds.has(String(child.id))) {
                                sortedData.push({ 
                                    ...child, 
                                    exportType: 'child', 
                                    displayIndex: `${parentCounter}.${idx + 1}`, 
                                    parentTitle: parent.title 
                                });
                                processedIds.add(String(child.id));
                            }
                        });
                    }
                }
            });

            const workbook = new window.ExcelJS.Workbook();
            // Kılavuz çizgilerini kapatıyoruz (Daha şık ve kurumsal bir PDF/Sunum görünümü verir)
            const worksheet = workbook.addWorksheet('Portföy Raporu', { views: [{ showGridLines: false }] }); 

            const excelColumns = [
                { header: 'No', key: 'displayIndex', width: 8 },
                { header: 'Menşe/Ülke', key: 'mense', width: 18 },
                { header: 'Görsel', key: 'brandImage', width: 16 },
                { header: 'Marka Adı', key: 'title', width: 45 },
                { header: 'Başvuru Sahibi', key: 'applicant', width: 35 },
                { header: 'Başvuru No', key: 'appNo', width: 18 },
                { header: 'Tescil No', key: 'regNo', width: 18 },
                { header: 'Başvuru Tarihi', key: 'appDate', width: 16 },
                { header: 'Yenileme Tarihi', key: 'renDate', width: 16 },
                { header: 'Durum', key: 'status', width: 22 },
                { header: 'Sınıflar', key: 'classes', width: 30 }
            ];

            worksheet.columns = excelColumns;

            // 🔥 4. ADIM: Üst Yönetim Raporu İçin Tasarım Makyajı
            // En üste 4 tane boş satır ekleyerek tablo başlıklarını aşağı itiyoruz.
            worksheet.spliceRows(1, 0, [], [], [], []);

            // Ana Rapor Başlığı (Row 1-2 Birleşik)
            worksheet.mergeCells('A1:K2');
            const titleCell = worksheet.getCell('A1');
            titleCell.value = 'ÜST YÖNETİM - FİKRİ MÜLKİYET PORTFÖY RAPORU';
            titleCell.font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FF1E3C72' } }; // Evreka Laciverti
            titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

            // Müvekkil Adı ve Tarih (Row 3)
            const clientName = document.getElementById('currentClientName')?.textContent || 'Müvekkil';
            const dateStrTR = new Date().toLocaleDateString('tr-TR');

            worksheet.mergeCells('A3:E3');
            worksheet.getCell('A3').value = `Müvekkil: ${clientName}`;
            worksheet.getCell('A3').font = { bold: true, size: 12, color: { argb: 'FF333333' } };
            worksheet.getCell('A3').alignment = { vertical: 'middle', horizontal: 'left' };

            worksheet.mergeCells('F3:K3');
            worksheet.getCell('F3').value = `Rapor Tarihi: ${dateStrTR}`;
            worksheet.getCell('F3').font = { italic: true, size: 11, color: { argb: 'FF555555' } };
            worksheet.getCell('F3').alignment = { vertical: 'middle', horizontal: 'right' };

            // Tablo Sütun Başlıkları (Splice sonrası 5. satıra kaydı)
            const headerRow = worksheet.getRow(5);
            headerRow.height = 35;
            headerRow.eachCell({ includeEmpty: true }, (cell) => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C72' } };
                cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
                cell.border = {
                    top: { style: 'medium', color: { argb: 'FF1E3C72' } },
                    bottom: { style: 'medium', color: { argb: 'FF1E3C72' } },
                    left: { style: 'thin', color: { argb: 'FFFFFFFF' } },
                    right: { style: 'thin', color: { argb: 'FFFFFFFF' } }
                };
            });

            // 🔥 3. ADIM: İngilizce Durumları Türkçe'ye Çeviren Sözlük
            const statusTranslations = {
                'registered': 'Tescilli', 'application': 'Başvuru', 'filed': 'Başvuru', 'published': 'Yayınlandı',
                'rejected': 'Reddedildi', 'partially_rejected': 'Kısmen Reddedildi', 'partially rejected': 'Kısmen Reddedildi',
                'withdrawn': 'Geri Çekildi', 'cancelled': 'İptal Edildi', 'expired': 'Süresi Doldu', 'dead': 'Geçersiz',
                'opposition': 'İtiraz Aşamasında', 'appealed': 'Karara İtiraz', 'pending': 'İşlem Bekliyor'
            };

            let includeImages = true;
            if (sortedData.length > 50) {
                includeImages = confirm(`${sortedData.length} adet kayıt dışa aktarılıyor.\n\nÜst yönetim raporuna MARKA GÖRSELLERİ de eklensin mi?\n\n(Dosya boyutu ve indirme süresi görsellerle birlikte artabilir.)`);
            }

            for (let i = 0; i < sortedData.length; i++) {
                const record = sortedData[i];
                
                // 🔥 2. ADIM: Menşe ve Ülke Adı Gösterimi (Kod yerine Sözlükten Adını çekme)
                let menseDisplay = 'Yurtdışı';
                if (record.exportType === 'child') {
                    menseDisplay = this.state.countries.get(record.country) || record.country || 'Bilinmiyor';
                } else {
                    const o = (record.origin || 'TÜRKPATENT').toUpperCase();
                    if (o.includes('TURK') || o.includes('TÜRK')) menseDisplay = 'TÜRKPATENT';
                    else if (o.includes('WIPO')) menseDisplay = 'WIPO';
                    else menseDisplay = this.state.countries.get(record.country) || record.country || 'Yurtdışı';
                }

                // Child (Alt) Markalar için başlığın önüne Ok işareti koyuyoruz
                let titleDisplay = record.title || '-';
                if (record.exportType === 'child') titleDisplay = `↳ ${record.title || record.parentTitle}`;

                // Durumu Türkçe yap
                const st = (record.status || '').toLowerCase();
                const displayStatus = statusTranslations[st] || record.status || '-';

                const rowData = {
                    displayIndex: record.displayIndex,
                    mense: menseDisplay,
                    brandImage: '', // Görseli sonra basacağız
                    title: titleDisplay,
                    applicant: record.applicants && record.applicants.length > 0 ? record.applicants.map(a => a.name).join(', ') : '-',
                    appNo: record.applicationNumber || '-',
                    regNo: record.registrationNumber || '-',
                    appDate: this.renderHelper.formatDate(record.applicationDate) || '-',
                    renDate: this.renderHelper.formatDate(record.renewalDate) || '-',
                    status: displayStatus,
                    classes: record.classes || '-'
                };

                const row = worksheet.addRow(rowData);

                // Tüm satırlara hafif gri alt çizgi
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    cell.border = { bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } } }; 
                    const colKey = excelColumns[colNumber - 1].key;
                    if (['title', 'applicant', 'classes'].includes(colKey)) {
                        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
                    } else {
                        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
                    }
                });

                // Hiyerarşik Vurgular (Child Satırları Gri ve İtalik, Parent Satırları Bold)
                if (record.exportType === 'child') {
                    row.eachCell(c => { 
                        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9F9F9' } }; 
                        c.font = { italic: true, color: { argb: 'FF666666' } }; 
                    });
                    const titleCell = row.getCell('title');
                    if (titleCell) titleCell.alignment = { indent: 2, vertical: 'middle', wrapText: true };
                } else {
                    const titleCell = row.getCell('title');
                    if (titleCell) titleCell.font = { bold: true, color: { argb: 'FF222222' } };
                    const indexCell = row.getCell('displayIndex');
                    if (indexCell) indexCell.font = { bold: true };
                }

                // Görsel İşleme (Base64 yerine ArrayBuffer ile daha hızlı ve stabil)
                if (includeImages && record.brandImageUrl && record.exportType !== 'child') {
                    try {
                        const response = await fetch(record.brandImageUrl, { cache: 'force-cache' });
                        if (response.ok) {
                            const buffer = await response.arrayBuffer();
                            let ext = 'png';
                            if (record.brandImageUrl.toLowerCase().includes('.jpg') || record.brandImageUrl.toLowerCase().includes('.jpeg')) ext = 'jpeg';

                            const imageId = workbook.addImage({ buffer: buffer, extension: ext });
                            // header 5. satırda, data 6. satırda başlıyor (i+5 / i+6 matematiği buradan gelir)
                            worksheet.addImage(imageId, {
                                tl: { col: 2, row: i + 5 }, // Col C (Index 2) - Görsel Kolonu
                                br: { col: 3, row: i + 6 },
                                editAs: 'oneCell'
                            });
                            row.height = 65; // Resim için satırı genişlet
                        } else { row.height = 35; }
                    } catch (err) { 
                        row.height = 35; 
                        const imgCell = row.getCell('brandImage');
                        imgCell.value = { text: 'Görsel Linki', hyperlink: record.brandImageUrl };
                        imgCell.font = { color: { argb: 'FF0000FF' }, underline: true };
                    }
                } else { 
                    row.height = 35; 
                }
            }

            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            
            const clientNameClean = (document.getElementById('currentClientName')?.textContent || 'Musteri').replace(/[^a-z0-9]/gi, '_');
            const dateStr = new Date().toISOString().slice(0,10);
            
            const fileName = type === 'selected' ? `Yonetim_Raporu_${clientNameClean}_Secili_${dateStr}.xlsx` : `Yonetim_Raporu_${clientNameClean}_Tum_Portfoy_${dateStr}.xlsx`;
            
            window.saveAs(blob, fileName);
            
        } catch (error) {
            console.error('Excel hatası:', error);
            alert('Excel oluşturulurken bir hata oluştu. Lütfen konsolu kontrol edin.');
        } finally {
            if (window.SimpleLoadingController) window.SimpleLoadingController.hide();
        }
    }
    
    // ==========================================
    // 🔥 GÖRSEL İNDİRİCİ (CORS ve Format Korumalı)
    // ==========================================
    async getBase64ImageFromUrl(url) {
        if (!url || url.length < 10) return null;
        try {
            // CORS (Erişim İzni) politikalarını aşmak için özel ayar
            const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (!response.ok) return null;
            const blob = await response.blob();
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            });
        } catch (e) { return null; }
    }

    // ==========================================
    // 🔥 ÜST YÖNETİM RAPORU İÇİN PDF EXPORT (KUSURSUZ VERSİYON)
    // ==========================================
    async exportToPDF(type) {
    const activeTabId = $('#portfolioTopTabs a.nav-link.active').attr('href');
    if (activeTabId !== '#marka-list') {
        alert('PDF dışa aktarımı şimdilik sadece Marka sekmesi için aktiftir.');
        return;
    }

    const allFilteredData = this.state.filteredPortfolios || [];
    let dataToExport = [];

    if (type === 'selected') {
        const selectedIds = this.state.selectedRecords;
        if (!selectedIds || selectedIds.size === 0) {
            alert('Lütfen tablodan en az bir kayıt seçiniz.');
            return;
        }
        dataToExport = allFilteredData.filter(item => selectedIds.has(String(item.id)));
    } else {
        dataToExport = [...allFilteredData];
    }

    if (dataToExport.length === 0) {
        alert('Aktarılacak veri bulunamadı.');
        return;
    }

    if (window.SimpleLoadingController) {
        window.SimpleLoadingController.show('Yönetici PDF Raporu', 'Portföy verileri düzenleniyor ve rapor sayfaları hazırlanıyor...');
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const marginX = 12;

        const normalizeTR = (text) => {
            if (text === null || text === undefined || text === '') return '-';
            return String(text)
                .replace(/Ğ/g, 'G').replace(/ğ/g, 'g')
                .replace(/Ü/g, 'U').replace(/ü/g, 'u')
                .replace(/Ş/g, 'S').replace(/ş/g, 's')
                .replace(/İ/g, 'I').replace(/ı/g, 'i')
                .replace(/Ö/g, 'O').replace(/ö/g, 'o')
                .replace(/Ç/g, 'C').replace(/ç/g, 'c');
        };

        const formatDateSafe = (value) => this.renderHelper.formatDate(value) || '-';
        const formatApplicant = (record) => {
            if (Array.isArray(record.applicants) && record.applicants.length > 0) {
                return record.applicants.map(a => a?.name).filter(Boolean).join(', ');
            }
            if (record.applicantNames) return record.applicantNames;
            return '-';
        };
        const formatClasses = (value) => {
            if (Array.isArray(value)) return value.join(', ');
            return value || '-';
        };
        const shortenText = (value, max = 90) => {
            const str = normalizeTR(value);
            if (str.length <= max) return str;
            return `${str.slice(0, max - 3)}...`;
        };

        const sortedData = [];
        const processedIds = new Set();
        let parentCounter = 0;

        dataToExport.forEach(parent => {
            if (processedIds.has(String(parent.id))) return;

            parentCounter += 1;
            sortedData.push({ ...parent, exportType: 'parent', displayIndex: String(parentCounter) });
            processedIds.add(String(parent.id));

            const children = (this.state.portfolios || []).filter(p => p.parentId === parent.id);
            children.forEach((child, idx) => {
                if (processedIds.has(String(child.id))) return;
                sortedData.push({
                    ...child,
                    exportType: 'child',
                    displayIndex: `${parentCounter}.${idx + 1}`,
                    parentTitle: parent.title
                });
                processedIds.add(String(child.id));
            });
        });

        const statusTranslations = {
            registered: 'Tescilli',
            application: 'Basvuru',
            filed: 'Basvuru',
            published: 'Yayinlandi',
            rejected: 'Reddedildi',
            partially_rejected: 'Kismen Reddedildi',
            'partially rejected': 'Kismen Reddedildi',
            withdrawn: 'Geri Cekildi',
            cancelled: 'Iptal Edildi',
            expired: 'Suresi Doldu',
            dead: 'Gecersiz',
            opposition: 'Itiraz Asamasinda',
            appealed: 'Karara Itiraz',
            pending: 'Islem Bekliyor'
        };

        let includeImages = true;
        if (sortedData.length > 40) {
            includeImages = confirm(`${sortedData.length} adet kayıt dışa aktarılıyor.

PDF raporuna marka görselleri de eklensin mi?

(Görseller kapatılırsa rapor daha hızlı oluşur.)`);
        }

        const imageCache = new Map();
        const getCachedImage = async (url) => {
            if (!includeImages || !url) return null;
            if (imageCache.has(url)) return imageCache.get(url);
            const base64 = await this.getBase64ImageFromUrl(url);
            imageCache.set(url, base64 || null);
            return imageCache.get(url);
        };

        const reportRows = [];
        for (const record of sortedData) {
            let menseDisplay = 'Yurtdisi';
            if (record.exportType === 'child') {
                menseDisplay = this.state.countries.get(record.country) || record.country || 'Bilinmiyor';
            } else {
                const origin = (record.origin || 'TURKPATENT').toUpperCase();
                if (origin.includes('TURK') || origin.includes('TÜRK')) menseDisplay = 'TURKPATENT';
                else if (origin.includes('WIPO')) menseDisplay = 'WIPO';
                else menseDisplay = this.state.countries.get(record.country) || record.country || 'Yurtdisi';
            }

            const statusKey = String(record.status || '').toLowerCase();
            const displayStatus = statusTranslations[statusKey] || normalizeTR(record.status) || '-';
            const titleDisplay = record.exportType === 'child'
                ? `↳ ${normalizeTR(record.title || record.parentTitle)}`
                : normalizeTR(record.title);

            reportRows.push({
                index: normalizeTR(record.displayIndex),
                mense: normalizeTR(menseDisplay),
                imageText: '',
                title: shortenText(titleDisplay, record.exportType === 'child' ? 72 : 82),
                applicant: shortenText(formatApplicant(record), 64),
                appNo: normalizeTR(record.applicationNumber),
                regNo: normalizeTR(record.registrationNumber),
                appDate: normalizeTR(formatDateSafe(record.applicationDate)),
                renDate: normalizeTR(formatDateSafe(record.renewalDate)),
                status: shortenText(displayStatus, 26),
                classes: shortenText(formatClasses(record.classes), 54),
                meta: {
                    exportType: record.exportType,
                    imageData: record.exportType !== 'child' ? await getCachedImage(record.brandImageUrl) : null,
                    imageUrl: record.brandImageUrl || null
                }
            });
        }

        const parentCount = reportRows.filter(r => r.meta.exportType !== 'child').length;
        const childCount = reportRows.length - parentCount;
        const statusCount = {};
        reportRows.forEach(r => {
            statusCount[r.status] = (statusCount[r.status] || 0) + 1;
        });
        const topStatuses = Object.entries(statusCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([label, count]) => `${label}: ${count}`)
            .join('   |   ');

        const clientName = document.getElementById('currentClientName')?.textContent || 'Müvekkil';
        const reportDateTR = new Date().toLocaleDateString('tr-TR');
        const generatedAt = new Date().toLocaleString('tr-TR');

        const drawPageHeader = (pageNumber) => {
            doc.setFillColor(30, 60, 114);
            doc.rect(0, 0, pageWidth, 16, 'F');

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(15);
            doc.setTextColor(255, 255, 255);
            doc.text('UST YONETIM PORTFOY RAPORU', marginX, 10.5);

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.text(`Sayfa ${pageNumber}`, pageWidth - marginX, 10.5, { align: 'right' });

            doc.setTextColor(45, 45, 45);
            doc.setFontSize(10);
            doc.text(`Muvekkil: ${normalizeTR(clientName)}`, marginX, 23);
            doc.text(`Rapor Tarihi: ${reportDateTR}`, pageWidth - marginX, 23, { align: 'right' });

            doc.setDrawColor(220, 226, 236);
            doc.line(marginX, 26, pageWidth - marginX, 26);
        };

        const drawPageFooter = (pageNumber) => {
            doc.setDrawColor(220, 226, 236);
            doc.line(marginX, pageHeight - 10, pageWidth - marginX, pageHeight - 10);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.setTextColor(110, 110, 110);
            doc.text(`Uretim Zamani: ${generatedAt}`, marginX, pageHeight - 5);
            doc.text(`IPGate Client Portal`, pageWidth - marginX, pageHeight - 5, { align: 'right' });
        };

        drawPageHeader(1);

        doc.setFillColor(245, 247, 251);
        doc.roundedRect(marginX, 31, pageWidth - (marginX * 2), 16, 2, 2, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(30, 60, 114);
        doc.text(`Ana Kayit: ${parentCount}`, marginX + 4, 37);
        doc.text(`Alt Kayit: ${childCount}`, marginX + 45, 37);
        doc.text(`Toplam Satir: ${reportRows.length}`, marginX + 86, 37);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(80, 80, 80);
        doc.text(shortenText(topStatuses || 'Durum özeti bulunamadi.', 115), marginX + 4, 43.5);

        doc.autoTable({
            startY: 51,
            margin: { left: marginX, right: marginX, bottom: 14 },
            tableWidth: 'auto',
            theme: 'grid',
            head: [[
                'No', 'Mense', 'Logo', 'Marka', 'Basvuru Sahibi', 'Basvuru No',
                'Tescil No', 'Basvuru T.', 'Yenileme T.', 'Durum', 'Siniflar'
            ]],
            body: reportRows.map(row => [
                row.index,
                row.mense,
                row.imageText,
                row.title,
                row.applicant,
                row.appNo,
                row.regNo,
                row.appDate,
                row.renDate,
                row.status,
                row.classes
            ]),
            styles: {
                font: 'helvetica',
                fontSize: 7,
                cellPadding: { top: 2.2, right: 1.8, bottom: 2.2, left: 1.8 },
                textColor: [55, 55, 55],
                lineColor: [225, 229, 235],
                lineWidth: 0.15,
                valign: 'middle',
                overflow: 'linebreak'
            },
            headStyles: {
                fillColor: [30, 60, 114],
                textColor: [255, 255, 255],
                fontStyle: 'bold',
                halign: 'center',
                valign: 'middle'
            },
            alternateRowStyles: { fillColor: [252, 253, 255] },
            columnStyles: {
                0: { cellWidth: 12, halign: 'center', fontStyle: 'bold' },
                1: { cellWidth: 20, halign: 'center' },
                2: { cellWidth: 16, halign: 'center', minCellHeight: 16 },
                3: { cellWidth: 38, halign: 'left' },
                4: { cellWidth: 36, halign: 'left' },
                5: { cellWidth: 19, halign: 'center' },
                6: { cellWidth: 19, halign: 'center' },
                7: { cellWidth: 18, halign: 'center' },
                8: { cellWidth: 18, halign: 'center' },
                9: { cellWidth: 24, halign: 'center' },
                10: { cellWidth: 29, halign: 'left' }
            },
            didParseCell: function (data) {
                if (data.section !== 'body') return;
                const rowMeta = reportRows[data.row.index]?.meta;
                const isChild = rowMeta?.exportType === 'child';
                if (isChild) {
                    data.cell.styles.fillColor = [247, 247, 247];
                    data.cell.styles.textColor = [105, 105, 105];
                    data.cell.styles.fontStyle = 'italic';
                }
                if (data.column.index === 2) {
                    data.cell.text = [''];
                }
                if (data.column.index === 3 && !isChild) {
                    data.cell.styles.fontStyle = 'bold';
                }
            },
            didDrawCell: function (data) {
                if (data.section !== 'body' || data.column.index !== 2) return;
                const rowMeta = reportRows[data.row.index]?.meta;
                const base64Img = rowMeta?.imageData;
                if (!base64Img || typeof base64Img !== 'string' || base64Img.length < 50) {
                    doc.setFontSize(6);
                    doc.setTextColor(160, 160, 160);
                    doc.text('-', data.cell.x + (data.cell.width / 2), data.cell.y + (data.cell.height / 2) + 1, { align: 'center' });
                    return;
                }
                try {
                    const dim = Math.min(11.5, data.cell.width - 3, data.cell.height - 3);
                    const x = data.cell.x + ((data.cell.width - dim) / 2);
                    const y = data.cell.y + ((data.cell.height - dim) / 2);
                    let format = 'PNG';
                    if (base64Img.includes('image/jpeg') || base64Img.includes('image/jpg')) format = 'JPEG';
                    doc.addImage(base64Img, format, x, y, dim, dim, undefined, 'FAST');
                } catch (e) {
                    console.error('PDF resim ekleme hatası:', e);
                }
            },
            didDrawPage: function (data) {
                const currentPage = doc.internal.getNumberOfPages();
                drawPageHeader(currentPage);
                drawPageFooter(currentPage);
                if (currentPage > 1) {
                    doc.setFont('helvetica', 'italic');
                    doc.setFontSize(8);
                    doc.setTextColor(120, 120, 120);
                    doc.text('Portfoy detaylari', marginX, 31);
                }
            }
        });

        const clientNameClean = normalizeTR(clientName).replace(/[^a-z0-9]/gi, '_');
        const dateStr = new Date().toISOString().slice(0, 10);
        const fileName = type === 'selected'
            ? `Yonetici_Raporu_${clientNameClean}_Secili_${dateStr}.pdf`
            : `Yonetici_Raporu_${clientNameClean}_Tum_Portfoy_${dateStr}.pdf`;

        doc.save(fileName);
    } catch (error) {
        console.error('PDF hatası:', error);
        alert('PDF oluşturulurken bir hata oluştu. Ayrıntı için konsolu kontrol edin.');
    } finally {
        if (window.SimpleLoadingController) window.SimpleLoadingController.hide();
    }
}

    renderReports() {
        const portfolios = this.state.portfolios;
        const legalData = [...this.state.suits, ...this.state.filteredObjections || []];
        const taskData = this.state.tasks;

        if (portfolios.length === 0 && legalData.length === 0) {
            document.getElementById('world-map-markers').innerHTML = '<div class="d-flex justify-content-center align-items-center h-100 text-muted">Bu müşteri için analiz edilecek veri bulunamadı.</div>';
            return;
        }

        let mapData = {}; let uniqueCountries = new Set(); let typeCounts = {}; let classCounts = {}; let budgetForecast = {};          
        const monthNames = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
        const now = new Date(); const nextYear = new Date(); nextYear.setFullYear(now.getFullYear() + 1);

        portfolios.forEach(item => {
            const originRaw = (item.origin || '').toUpperCase();
            // 🔥 DÜZELTME
            const isTurk = originRaw.includes('TURK') || originRaw.includes('TÜRK');
            
            let code = '';
            if (isTurk) code = 'TR';
            else if (item.country) code = item.country.toUpperCase().trim();
            
            if (code && code.length === 2) { mapData[code] = (mapData[code] || 0) + 1; uniqueCountries.add(code); }
            const t = item.type === 'trademark' ? 'Marka' : (item.type === 'patent' ? 'Patent' : 'Tasarım');
            typeCounts[t] = (typeCounts[t] || 0) + 1;
            if (item.classes && item.classes !== '-') item.classes.split(',').forEach(c => { const cleanC = c.trim(); if(cleanC) classCounts[cleanC] = (classCounts[cleanC] || 0) + 1; });
            if (item.renewalDate) {
                let rDate = new Date(item.renewalDate);
                if (rDate > now && rDate < nextYear) {
                    const key = `${rDate.getFullYear()}-${rDate.getMonth()}`; 
                    budgetForecast[key] = (budgetForecast[key] || 0) + (isTurk ? 4500 : 15000);
                }
            }
        });

        const mapContainer = document.getElementById("world-map-markers");
        mapContainer.innerHTML = ""; 
        if (Object.keys(mapData).length > 0 && window.jsVectorMap) {
            new jsVectorMap({
                selector: '#world-map-markers', map: 'world', zoomButtons: true,
                regionStyle: { initial: { fill: '#e3eaef' }, hover: { fillOpacity: 0.7 } },
                visualizeData: { scale: ['#a2cffe', '#2e59d9'], values: mapData },
                onRegionTooltipShow(e, tooltip, code) { if(mapData[code]) tooltip.text(`<strong>${tooltip.text()}</strong>: ${mapData[code]} Dosya`, true); }
            });
        }

        document.getElementById('rep-total-assets').textContent = portfolios.length;
        document.getElementById('rep-total-countries').textContent = uniqueCountries.size + ' Ülke';
        document.getElementById('rep-pending-tasks').textContent = taskData.filter(t => t.status === 'awaiting_client_approval').length;
        document.getElementById('rep-active-legal').textContent = legalData.filter(l => !(l.statusText || l.suitStatus || '').toLowerCase().includes('kapatıldı')).length;
        document.getElementById('rep-budget-est').textContent = '₺' + Object.values(budgetForecast).reduce((a,b)=>a+b, 0).toLocaleString('tr-TR');

        const stuckItems = portfolios.filter(item => (item.status || '').toLowerCase().includes('başvuru') && new Date(item.applicationDate) < new Date(now.setMonth(now.getMonth()-6))).slice(0,5);
        document.getElementById('rep-stuck-list').innerHTML = stuckItems.length === 0 ? '<tr><td colspan="4" class="text-center text-success">Sürüncemede iş yok.</td></tr>' : stuckItems.map(item => `<tr><td><b>${item.title}</b></td><td>Başvuru</td><td class="text-danger">Bekliyor</td><td>İlerleme Yok</td></tr>`).join('');

        const renderChart = (id, opts) => { const el = document.querySelector("#"+id); if(el) { el.innerHTML=""; new ApexCharts(el, {theme: {mode: 'light'}, toolbar: {show:false}, ...opts}).render(); }};
        renderChart('chart-portfolio-dist', { series: Object.values(typeCounts), labels: Object.keys(typeCounts), chart: {type: 'donut', height: 260}, colors: ['#4e73df', '#1cc88a', '#36b9cc'] });
        renderChart('chart-class-radar', { series: [{name: 'Marka', data: Object.values(classCounts).slice(0,6)}], labels: Object.keys(classCounts).slice(0,6), chart: {type: 'radar', height: 260}, colors: ['#36b9cc'] });
        renderChart('chart-budget-forecast', { series: [{name: 'Tutar', data: Object.values(budgetForecast)}], xaxis: {categories: Object.keys(budgetForecast).map(k => `${monthNames[k.split('-')[1]]} ${k.split('-')[0]}`)}, chart: {type: 'bar', height: 260}, colors: ['#4e73df'] });
    }

    initTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.body.classList.add(savedTheme + '-mode');
        document.getElementById('themeSwitch').checked = (savedTheme === 'dark');
        document.getElementById('themeSwitch').addEventListener('change', (e) => {
            const isDark = e.target.checked;
            document.body.classList.remove('light-mode', 'dark-mode');
            document.body.classList.add(isDark ? 'dark-mode' : 'light-mode');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            if ($('#portfolioTopTabs a.nav-link.active').attr('href') === '#reports') this.renderReports(); 
        });
    }

    exposeGlobalFunctions() {
        window.switchClient = (clientId, fromModal = false) => {
            if (fromModal) $('#clientSelectionModal').modal('hide');
            this.state.selectedClientId = clientId;
            sessionStorage.setItem('selectedClientSession', clientId);
            this.updateClientNameDisplay();
            this.loadAllData();
        };
        window.initReports = () => this.renderReports();
        window.exportActiveTable = (type) => this.exportActiveTable(type);
        window.triggerTpQuery = (appNo) => window.open(`https://portal.turkpatent.gov.tr/anonim/arastirma/marka/sonuc?dosyaNo=${encodeURIComponent(String(appNo).replace(/[^a-zA-Z0-9/]/g, ''))}`, '_blank');
        window.filterDropdownList = (input) => { const txt = input.value.toLowerCase(); $(input).next('.filter-options-container').find('label').each(function() { $(this).text().toLowerCase().includes(txt) ? $(this).show() : $(this).hide(); }); };
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const portal = new ClientPortalController();
    portal.init();
});