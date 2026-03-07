// public/js/client-portal/main.js

import { supabase } from '../../supabase-config.js';
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
            sortStates: {} 
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
        let pendingTasks = 0, unpaidInvoices = 0;
        this.state.tasks.forEach(t => { if (t.status === 'awaiting_client_approval' || t.status === 'pending') pendingTasks++; });
        this.state.invoices.forEach(i => { if (i.status === 'unpaid') unpaidInvoices++; });

        document.getElementById('dashPendingApprovals').textContent = pendingTasks;
        document.getElementById('dashUnpaidInvoices').textContent = unpaidInvoices;
        document.getElementById('taskCount-marka-total').textContent = pendingTasks;
        document.getElementById('taskCount-pending-approval').textContent = pendingTasks;
        
        let davaPending = 0, davaCompleted = 0;
        this.state.tasks.forEach(t => {
            if (String(t.taskType) === '49' || (t.title || '').toLowerCase().includes('dava')) {
                t.status === 'awaiting_client_approval' ? davaPending++ : davaCompleted++;
            }
        });
        document.getElementById('taskCount-dava-total').textContent = davaPending;
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
            if (item.transactionHierarchy === 'child') return false;

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
            tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted py-4">Kayıt bulunamadı.</td></tr>`; 
            return; 
        }

        dataSlice.forEach((item, index) => {
            const actualIndex = startIndex + index;
            const row = document.createElement('tr');
            
            const originRaw = (item.origin || 'TÜRKPATENT').toUpperCase();
            // 🔥 DÜZELTME
            const isTurk = originRaw.includes('TURK') || originRaw.includes('TÜRK');
            const originDisplay = isTurk ? 'TÜRKPATENT' : (item.country || 'Yurtdışı');
            
            const childRecords = this.state.portfolios.filter(p => p.parentId === item.id);
            const isInternational = childRecords.length > 0;

            const imgHtml = item.brandImageUrl ? `<img src="${item.brandImageUrl}" class="brand-thumb">` : '-';
            
            let badgeClass = 'secondary';
            const st = (item.status || '').toLowerCase();
            if (st.includes('tescil') || st.includes('registered')) badgeClass = 'success';
            else if (st.includes('başvuru') || st.includes('filed')) badgeClass = 'primary';
            else if (st.includes('red') || st.includes('rejected')) badgeClass = 'danger';
            else if (st.includes('itiraz')) badgeClass = 'warning';

            row.innerHTML = `
                <td>${isInternational ? '<i class="fas fa-chevron-right mr-2"></i>' : ''}${actualIndex + 1}</td>
                <td class="col-origin">${originDisplay}</td>
                <td class="col-sample text-center">${imgHtml}</td>
                <td><a href="#" class="portfolio-detail-link" data-item-id="${item.id}">${item.title}</a></td>
                <td>${item.applicationNumber}</td>
                <td>${item.registrationNumber}</td>
                <td>${this.renderHelper.formatDate(item.applicationDate)}</td>
                <td>${this.renderHelper.formatDate(item.renewalDate)}</td> 
                <td><span class="badge badge-${badgeClass}">${item.status || 'Bilinmiyor'}</span></td>
                <td>${item.classes}</td>
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
                    return `<tr><td>${actualIndex+1}.${cIdx+1}</td><td>${childCountry}</td><td>${child.applicationNumber}</td><td>${this.renderHelper.formatDate(child.applicationDate)}</td><td>${this.renderHelper.formatDate(child.renewalDate)}</td><td><span class="badge badge-secondary">${child.status || 'Bilinmiyor'}</span></td><td>${child.classes}</td></tr>`;
                }).join('');
                detailRow.innerHTML = `<td colspan="10" class="p-0"><div class="collapse" id="accordion-yurtdisi-${item.id}"><table class="table mb-0 accordion-table bg-light"><thead><tr><th>#</th><th>Ülke</th><th>Başvuru No</th><th>Başvuru T.</th><th>Yenileme T.</th><th>Durum</th><th>Sınıflar</th></tr></thead><tbody>${childHtml}</tbody></table></div></td>`;
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

            let computedStatus = 'Karar Bekleniyor', badgeColor = 'secondary';
            const rr = parentTx.request_result;
            
            if (rr && REQUEST_RESULT_STATUS[String(rr)]) {
                computedStatus = REQUEST_RESULT_STATUS[String(rr)];
                if (computedStatus.includes('Ret')) badgeColor = 'danger';
                else if (computedStatus.includes('Kabul')) badgeColor = 'success';
                else badgeColor = 'info';
            } else if ((task.status || '').includes('awaiting')) { computedStatus = 'Onay Bekliyor'; badgeColor = 'warning'; }

            rows.push({
                id: task.id, recordId: task.relatedIpRecordId, origin: ipRecord.origin, brandImageUrl: ipRecord.brandImageUrl,
                title: ipRecord.title || task.recordTitle, transactionTypeName: task.taskTypeDisplay, applicationNumber: ipRecord.applicationNumber,
                applicantName: task.details?.applicantName || 'Müvekkil', bulletinDate: task.details?.brandInfo?.opposedMarkBulletinDate,
                bulletinNo: task.details?.brandInfo?.opposedMarkBulletinNo, epatsDate: parentTx.created_at,
                statusText: computedStatus, statusBadge: badgeColor, allParentDocs: parentTx.transaction_documents || [],
                childrenData: parentTx.isVirtual ? [] : taskTxs.filter(tx => tx.transaction_hierarchy === 'child' && tx.parent_id === parentTx.id)
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
            if (statusVal !== 'TÜMÜ' && t.status !== statusVal) return false;
            if (searchVal && !`${t.title} ${t.appNo} ${t.recordTitle}`.toLowerCase().includes(searchVal)) return false;

            const isDava = String(t.taskType) === '49' || (t.title || '').toLowerCase().includes('dava');
            if (taskTypeFilter === 'pending-approval') return !isDava && t.status === 'awaiting_client_approval' && String(t.taskType) !== '20' && String(t.taskType) !== '22';
            if (taskTypeFilter === 'completed-tasks') return !isDava && t.status !== 'awaiting_client_approval';
            if (taskTypeFilter === 'bulletin-watch') return String(t.taskType) === '20';
            if (taskTypeFilter === 'renewal-approval') return String(t.taskType) === '22';
            if (taskTypeFilter === 'dava-pending') return isDava && t.status === 'awaiting_client_approval';
            if (taskTypeFilter === 'dava-completed') return isDava && t.status !== 'awaiting_client_approval';
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
            $('#task-detail-cards, #dava-task-detail-cards, #task-list-filters').slideUp();
            $('#task-list-container').html('');
            if(el.dataset.targetArea === 'marka-tasks') $('#task-detail-cards').slideDown();
            else if(el.dataset.targetArea === 'dava-tasks') $('#dava-task-detail-cards').slideDown();
        });

        $('.detail-card-link').click((e) => {
            const el = e.currentTarget;
            $('.detail-card-link').removeClass('active-list-type'); el.classList.add('active-list-type');
            $('#task-list-filters').slideDown();
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

            document.getElementById('portfolioDetailModalLabel').textContent = item.title;
            document.getElementById('modal-img').src = item.brandImageUrl || 'https://placehold.co/150x150?text=Yok';
            document.getElementById('modal-details-card').innerHTML = `<p><strong>Tür:</strong> ${item.type}</p><p><strong>Başvuru No:</strong> ${item.applicationNumber}</p><p><strong>Sınıflar:</strong> ${item.classes}</p>`;
            document.getElementById('modal-dates-card').innerHTML = `<p><strong>Başvuru:</strong> ${this.renderHelper.formatDate(item.applicationDate)}</p><p><strong>Yenileme:</strong> ${this.renderHelper.formatDate(item.renewalDate)}</p><span class="badge badge-primary">${item.status}</span>`;
            document.getElementById('esyaListesiContent').innerHTML = item.classes && item.classes !== '-' ? `<div><b>Kayıtlı Sınıflar</b>: ${item.classes}</div>` : '<p class="text-muted">Veri yok.</p>';
            
            document.querySelector('#modal-islemler tbody').innerHTML = '<tr><td colspan="4" class="text-center"><i class="fas fa-spinner fa-spin"></i> Yükleniyor...</td></tr>';
            $('#portfolioDetailModal').modal('show'); $('#myTab a[href="#modal-islemler"]').tab('show'); 
            
            const { data: txs } = await supabase.from('transactions').select('*, transaction_types(alias, name), transaction_documents(*)').eq('ip_record_id', item.id).order('created_at', { ascending: false });
            this.renderHelper.renderTransactionHistory(txs || [], 'modal-islemler');
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
    // EXPORT FONKSİYONLARI (EXCEL/PDF)
    // ==========================================
    async exportActiveTable(type) {
        const activeTabId = $('#portfolioTopTabs a.nav-link.active').attr('href');
        let dataToExport = [];
        
        if (activeTabId !== '#marka-list') {
            alert('Bu özellik şimdilik sadece Marka sekmesi için aktiftir.');
            return;
        }

        const rawData = this.state.filteredPortfolios;
        const btnIcon = type === 'excel' ? '.fa-file-excel' : '.fa-file-pdf';
        const originalBtnHtml = $(btnIcon).parent().html();
        $(btnIcon).parent().html('<i class="fas fa-spinner fa-spin"></i>').prop('disabled', true);

        try {
            for (const item of rawData) {
                let base64Image = null;
                const imgUrl = item.brandImageUrl;
                if (imgUrl) base64Image = await this.imageUrlToBase64(imgUrl);

                const originRaw = (item.origin || 'TÜRKPATENT').toUpperCase();
                // 🔥 DÜZELTME
                const isTurk = originRaw.includes('TURK') || originRaw.includes('TÜRK');
                const originDisplay = isTurk ? 'TÜRKPATENT' : (item.country || 'Yurtdışı');
                
                dataToExport.push({
                    type: 'parent',
                    mense: originDisplay,
                    base64Image: base64Image,
                    originalImageUrl: imgUrl,
                    markaAdi: item.title || '-',
                    basvuruNo: item.applicationNumber || '-',
                    tescilNo: item.registrationNumber || '-',
                    basvuruTarihi: this.renderHelper.formatDate(item.applicationDate),
                    yenilemeTarihi: this.renderHelper.formatDate(item.renewalDate),
                    durum: item.status || '-',
                    siniflar: item.classes || '-'
                });

                const children = this.state.portfolios.filter(p => p.parentId === item.id);
                children.forEach((child, idx) => {
                    const childCountry = this.state.countries.get(child.country) || child.country || 'Bilinmiyor';
                    dataToExport.push({
                        type: 'child', mense: childCountry, base64Image: null, originalImageUrl: null,
                        markaAdi: `   ↳ ${idx+1}. ${item.title || ''}`, basvuruNo: child.applicationNumber || '-',
                        tescilNo: '-', basvuruTarihi: this.renderHelper.formatDate(child.applicationDate),
                        yenilemeTarihi: this.renderHelper.formatDate(child.renewalDate), durum: child.status || '-', siniflar: child.classes || '-'
                    });
                });
            }

            const headers = [
                { key: 'mense', title: 'Menşe', width: 15 }, { key: 'base64Image', title: 'Görsel', width: 15 },
                { key: 'markaAdi', title: 'Marka Adı', width: 30 }, { key: 'basvuruNo', title: 'Başvuru No', width: 20 },
                { key: 'tescilNo', title: 'Tescil No', width: 20 }, { key: 'basvuruTarihi', title: 'Başvuru T.', width: 15 },
                { key: 'yenilemeTarihi', title: 'Yenileme T.', width: 15 }, { key: 'durum', title: 'Durum', width: 15 },
                { key: 'siniflar', title: 'Sınıflar', width: 15 }
            ];

            const finalFileName = `Marka_Portfoy_Raporu_${new Date().toISOString().slice(0,10)}`;
            if (type === 'excel') await this.generateExcelWithImages(dataToExport, headers, finalFileName);
            else if (type === 'pdf') await this.generatePDF(dataToExport, headers, finalFileName);
            
        } catch (e) {
            console.error("Export Hatası:", e);
            alert('Veri hazırlanırken hata oluştu.');
        } finally {
            $(btnIcon).parent().html(originalBtnHtml).prop('disabled', false);
        }
    }

    async imageUrlToBase64(url) {
        if (!url || url.length < 10) return null;
        try {
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

    async generateExcelWithImages(data, headers, filename) {
        const workbook = new window.ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Marka Listesi');
        sheet.columns = headers.map(h => ({ header: h.title, key: h.key, width: h.width }));

        data.forEach((item, index) => {
            const row = sheet.addRow({ ...item, base64Image: '' });
            if (item.type === 'child') {
                row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } }; c.font = { italic: true, color: { argb: 'FF555555' } }; });
            } else {
                row.height = 90;
                row.eachCell(c => c.alignment = { vertical: 'middle', wrapText: true });
                if (!item.base64Image && item.originalImageUrl) {
                    const cell = row.getCell(2);
                    cell.value = { text: 'Görsel Linki', hyperlink: item.originalImageUrl };
                    cell.font = { color: { argb: 'FF0000FF' }, underline: true };
                }
            }
        });

        data.forEach((item, i) => {
            if (item.base64Image) {
                const imageId = workbook.addImage({ base64: item.base64Image, extension: 'png' });
                sheet.addImage(imageId, { tl: { col: 1, row: i + 1 }, br: { col: 2, row: i + 2 }, editAs: 'oneCell' });
            }
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        window.saveAs(blob, `${filename}.xlsx`);
    }

    async generatePDF(data, headers, filename) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('l', 'mm', 'a4');
        
        doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(41, 128, 185);
        doc.text("Marka Portfoy Raporu", 14, 15);
        doc.setFontSize(10); doc.setTextColor(100);
        doc.text(`Olusturulma Tarihi: ${new Date().toLocaleDateString('tr-TR')}`, 14, 22);

        doc.autoTable({
            head: [headers.map(h => h.title)],
            body: data.map(row => { const r = headers.map(h => row[h.key]); r.raw = row; return r; }),
            startY: 28, theme: 'grid',
            styles: { fontSize: 8, valign: 'middle', cellPadding: 3 },
            headStyles: { fillColor: [41, 128, 185], textColor: 255, fontStyle: 'bold', halign: 'center' },
            columnStyles: { 0: { cellWidth: 25 }, 1: { cellWidth: 22, minCellHeight: 22 }, 2: { cellWidth: 45 } },
            didParseCell: function(d) {
                if (d.section === 'body' && d.row.raw.raw.type === 'child') {
                    d.cell.styles.fillColor = [248, 249, 250];
                    if (d.column.index === 2) { d.cell.styles.fontStyle = 'italic'; d.cell.styles.cellPadding = { left: 10 }; }
                }
            },
            didDrawCell: function(d) {
                if (d.section === 'body' && d.column.index === 1 && d.row.raw.raw.base64Image) {
                    try {
                        const dim = Math.min(d.cell.width, d.cell.height) - 4;
                        const x = d.cell.x + (d.cell.width - dim) / 2;
                        const y = d.cell.y + (d.cell.height - dim) / 2;
                        doc.addImage(d.row.raw.raw.base64Image, 'PNG', x, y, dim, dim);
                    } catch(e){}
                }
            }
        });
        doc.save(`${filename}.pdf`);
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