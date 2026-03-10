// public/js/accrual-management/main.js

import { waitForAuthUser, redirectOnLogout } from '../../supabase-config.js';
import { loadSharedLayout } from '../layout-loader.js';
import Pagination from '../pagination.js'; 
import { showNotification } from '../../utils.js';

import { AccrualDataManager } from './AccrualDataManager.js';
import { AccrualUIManager } from './AccrualUIManager.js';

document.addEventListener('DOMContentLoaded', async () => {
    const user = await waitForAuthUser({ requireAuth: true, redirectTo: 'index.html', graceMs: 1200 });
    if (!user) return;
    
    redirectOnLogout('index.html', 1200);

    await loadSharedLayout({ activeMenuLink: 'accruals.html' });

    class AccrualsController {
        constructor() {
            this.dataManager = new AccrualDataManager();
            this.uiManager = new AccrualUIManager();
            this.freestyleFormManager = null;
            this.state = {
                activeTab: 'main',       
                filters: { startDate: '', endDate: '', status: 'all', field: '', party: '', fileNo: '', subject: '', task: '' },
                sort: { column: 'createdAt', direction: 'desc' },
                selectedIds: new Set(),
                itemsPerPage: 50 
            };
            this.pagination = null;
            this.uploadedPaymentReceipts = []; 
            this.filterDebounceTimer = null; 
        }

        async init() {
            this.initPagination();
            this.setupEventListeners();
            await this.loadData();
        }

        initPagination() {
            if (typeof Pagination === 'undefined') { console.error("Pagination kütüphanesi eksik."); return; }
            this.pagination = new Pagination({
                containerId: 'paginationControls', 
                itemsPerPage: this.state.itemsPerPage,
                itemsPerPageOptions: [10, 25, 50, 100],
                onPageChange: () => this.renderPage() 
            });
        }

        async loadData() {
            this.uiManager.toggleLoading(true);
            try {
                await this.dataManager.fetchAllData();
                this.renderPage();
            } catch (error) {
                showNotification('Veriler yüklenirken hata oluştu.', 'error');
            } finally {
                this.uiManager.toggleLoading(false);
            }
        }

        renderPage() {
            const criteria = { tab: this.state.activeTab, filters: this.state.filters };
            const allFilteredData = this.dataManager.filterAndSort(criteria, this.state.sort);

            if (this.pagination) this.pagination.update(allFilteredData.length);
            const pageData = this.pagination ? this.pagination.getCurrentPageData(allFilteredData) : allFilteredData;

            const lookups = {
                tasks: this.dataManager.allTasks,
                transactionTypes: this.dataManager.allTransactionTypes,
                ipRecords: this.dataManager.allIpRecords,
                ipRecordsMap: this.dataManager.ipRecordsMap,
                selectedIds: this.state.selectedIds
            };

            this.uiManager.renderTable(pageData, lookups, this.state.activeTab);
            this.uiManager.updateTaskDetailError(''); 
        }

        async exportToExcel(type) {
            const criteria = { tab: this.state.activeTab, filters: this.state.filters };
            // Verileri tarihe göre sıralı çekiyoruz ki gruplama düzgün olsun
            let allFilteredData = this.dataManager.filterAndSort(criteria, { column: 'createdAt', direction: 'asc' });
            let dataToExport = [];

            if (type === 'selected') {
                if (this.state.selectedIds.size === 0) { showNotification('Lütfen en az bir kayıt seçiniz.', 'warning'); return; }
                dataToExport = allFilteredData.filter(item => this.state.selectedIds.has(item.id));
            } else {
                dataToExport = [...allFilteredData];
            }

            if (dataToExport.length === 0) { showNotification('Aktarılacak veri bulunamadı.', 'warning'); return; }

            this.uiManager.toggleLoading(true);

            try {
                const loadScript = (src) => new Promise((resolve, reject) => {
                    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
                    const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = reject; document.head.appendChild(script);
                });

                if (!window.ExcelJS) await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.3.0/dist/exceljs.min.js');
                if (!window.saveAs) await loadScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js');

                const ExcelJS = window.ExcelJS;
                const workbook = new ExcelJS.Workbook();
                const worksheet = workbook.addWorksheet('Mali Durum Raporu');

                // Sütun tanımlamaları
                worksheet.columns = [
                    { header: 'ID', key: 'id', width: 10 }, { header: 'Tarih', key: 'createdAt', width: 15 },
                    { header: 'Tür', key: 'type', width: 15 }, { header: 'Durum', key: 'status', width: 15 },
                    { header: 'Alan', key: 'field', width: 15 }, { header: 'İlgili Dosya', key: 'fileNo', width: 20 },
                    { header: 'Konu', key: 'subject', width: 30 }, { header: 'İlgili İş', key: 'taskTitle', width: 30 },
                    { header: 'Taraf / Müşteri', key: 'party', width: 30 }, { header: 'TPE Fatura No', key: 'tpeInvoiceNo', width: 15 },
                    { header: 'Evreka Fatura No', key: 'evrekaInvoiceNo', width: 15 }, 
                    { header: 'Resmi Ücret', key: 'officialFee', width: 20 }, { header: 'R.Ü. PB', key: 'officialFeeCurr', width: 8 }, 
                    { header: 'Hizmet Ücreti', key: 'serviceFee', width: 20 }, { header: 'H.Ü. PB', key: 'serviceFeeCurr', width: 8 }, 
                    { header: 'KDV Oranı (%)', key: 'vatRate', width: 12 }, { header: 'KDV Tutarı', key: 'vatAmount', width: 20 }, 
                    { header: 'KDV PB', key: 'vatCurr', width: 8 },
                    { header: 'Toplam Tutar', key: 'totalAmountStr', width: 25 }, 
                    { header: 'Kalan Tutar (Ödenecek)', key: 'remainingAmountStr', width: 25 }
                ];

                const headerRow = worksheet.getRow(1);
                headerRow.eachCell((cell) => {
                    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C72' } };
                    cell.alignment = { vertical: 'middle', horizontal: 'center' };
                    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                });

                // --- PARA BİRİMİ TOPLAYICI YARDIMCI SINIFI ---
                class CurrencyTracker {
                    constructor() { this.totals = {}; }
                    add(amount, currency) {
                        const curr = currency || 'TRY';
                        const amt = parseFloat(amount) || 0;
                        if (!this.totals[curr]) this.totals[curr] = 0;
                        this.totals[curr] += amt;
                    }
                    format() {
                        const entries = Object.entries(this.totals).filter(([_, amt]) => Math.abs(amt) > 0.01);
                        if (entries.length === 0) return '0.00 TRY';
                        return entries.map(([curr, amt]) => `${new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amt)} ${curr}`).join(' + ');
                    }
                }

                const grandTotals = {
                    official: new CurrencyTracker(), service: new CurrencyTracker(),
                    vat: new CurrencyTracker(), total: new CurrencyTracker(), remaining: new CurrencyTracker()
                };

                // Verileri Aylara Göre Gruplama
                const groupedData = {};
                dataToExport.forEach(acc => {
                    const dateObj = acc.createdAt instanceof Date ? acc.createdAt : new Date(acc.createdAt || 0);
                    const monthYear = dateObj.toLocaleDateString('tr-TR', { year: 'numeric', month: 'long' }).toUpperCase();
                    if (!groupedData[monthYear]) groupedData[monthYear] = [];
                    groupedData[monthYear].push(acc);
                });

                // Gruplanmış verileri Excel'e yazma
                for (const [monthYear, records] of Object.entries(groupedData)) {
                    
                    const monthTotals = {
                        official: new CurrencyTracker(), service: new CurrencyTracker(),
                        vat: new CurrencyTracker(), total: new CurrencyTracker(), remaining: new CurrencyTracker()
                    };

                    records.forEach(acc => {
                        const dateObj = acc.createdAt instanceof Date ? acc.createdAt : new Date(acc.createdAt || 0);
                        const formattedDate = dateObj.toLocaleDateString('tr-TR');

                        const task = this.dataManager.allTasks[String(acc.taskId)];
                        const typeObj = task ? this.dataManager.allTransactionTypes.find(t => t.id === task.taskType) : null;
                        const ipRec = task?.relatedIpRecordId ? this.dataManager.ipRecordsMap[task.relatedIpRecordId] : null;

                        let fieldText = '-';
                        if (typeObj?.ipType) fieldText = { 'trademark': 'Marka', 'patent': 'Patent', 'design': 'Tasarım', 'suit': 'Dava' }[typeObj.ipType] || typeObj.ipType;

                        const partyName = acc.paymentParty || (acc.tpInvoiceParty?.name) || (acc.serviceInvoiceParty?.name) || '-';

                        const officialAmt = acc.officialFee?.amount || 0;
                        const officialCurr = acc.officialFee?.currency || 'TRY';
                        const serviceAmt = acc.serviceFee?.amount || 0;
                        const serviceCurr = acc.serviceFee?.currency || 'TRY';
                        const vatRate = acc.vatRate || 0;
                        const baseForVat = serviceAmt + (acc.applyVatToOfficialFee ? officialAmt : 0);
                        const vatAmt = baseForVat * (vatRate / 100);
                        const vatCurr = serviceCurr; 

                        // Toplamlara Ekle
                        monthTotals.official.add(officialAmt, officialCurr);
                        monthTotals.service.add(serviceAmt, serviceCurr);
                        monthTotals.vat.add(vatAmt, vatCurr);
                        grandTotals.official.add(officialAmt, officialCurr);
                        grandTotals.service.add(serviceAmt, serviceCurr);
                        grandTotals.vat.add(vatAmt, vatCurr);

                        const totalArr = Array.isArray(acc.totalAmount) ? acc.totalAmount : [{amount: acc.totalAmount || 0, currency: 'TRY'}];
                        const remArr = acc.status === 'paid' ? [] : (Array.isArray(acc.remainingAmount) ? acc.remainingAmount : [{amount: acc.remainingAmount || acc.totalAmount || 0, currency: 'TRY'}]);

                        totalArr.forEach(t => { monthTotals.total.add(t.amount, t.currency); grandTotals.total.add(t.amount, t.currency); });
                        remArr.forEach(r => { monthTotals.remaining.add(r.amount, r.currency); grandTotals.remaining.add(r.amount, r.currency); });

                        const formatArray = (arr) => {
                            if (!Array.isArray(arr) || arr.length === 0) return '0 TRY';
                            return arr.map(x => `${new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2 }).format(x.amount)} ${x.currency}`).join(' + ');
                        };

                        worksheet.addRow({
                            id: acc.id, createdAt: formattedDate, type: acc.type || 'Hizmet', 
                            status: acc.status === 'paid' ? 'Ödendi' : (acc.status === 'unpaid' ? 'Ödenmedi' : 'Kısmen'),
                            field: fieldText, fileNo: ipRec ? (ipRec.applicationNumber || ipRec.applicationNo || '-') : '-',
                            subject: ipRec ? (ipRec.markName || ipRec.title || ipRec.name || '-') : (acc.subject || '-'),
                            taskTitle: typeObj ? (typeObj.alias || typeObj.name) : (acc.taskTitle || '-'),
                            party: partyName, tpeInvoiceNo: acc.tpeInvoiceNo || '', evrekaInvoiceNo: acc.evrekaInvoiceNo || '',
                            officialFee: officialAmt, officialFeeCurr: officialCurr, serviceFee: serviceAmt,
                            serviceFeeCurr: serviceCurr, vatRate: vatRate, vatAmount: vatAmt, vatCurr: vatCurr,
                            totalAmountStr: formatArray(totalArr), remainingAmountStr: formatArray(remArr)
                        });
                    });

                    // --- AYLIK ARA TOPLAM SATIRI ---
                    const subtotalRow = worksheet.addRow({
                        party: `${monthYear} TOPLAMI:`,
                        officialFee: monthTotals.official.format(),
                        serviceFee: monthTotals.service.format(),
                        vatAmount: monthTotals.vat.format(),
                        totalAmountStr: monthTotals.total.format(),
                        remainingAmountStr: monthTotals.remaining.format()
                    });
                    
                    subtotalRow.eachCell((cell) => {
                        cell.font = { bold: true, color: { argb: 'FF000000' } };
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } }; // Açık Sarı
                        cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
                    });
                    
                    worksheet.addRow({}); // Aylar arasına boş satır
                }

                // --- GENEL TOPLAM SATIRI ---
                const grandTotalRow = worksheet.addRow({
                    party: 'GENEL TOPLAM:',
                    officialFee: grandTotals.official.format(),
                    serviceFee: grandTotals.service.format(),
                    vatAmount: grandTotals.vat.format(),
                    totalAmountStr: grandTotals.total.format(),
                    remainingAmountStr: grandTotals.remaining.format()
                });
                
                grandTotalRow.eachCell((cell) => {
                    cell.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C72' } }; // Koyu Mavi
                    cell.border = { top: { style: 'medium' }, bottom: { style: 'medium' } };
                });

                const buffer = await workbook.xlsx.writeBuffer();
                const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                window.saveAs(blob, `Mali_Durum_Raporu_${new Date().toLocaleDateString('tr-TR').replace(/\./g, '_')}.xlsx`);

                showNotification(`${dataToExport.length} kayıt başarıyla raporlandı!`, 'success');
            } catch (error) { 
                showNotification('Excel oluşturulurken hata oluştu: ' + error.message, 'error'); 
                console.error(error);
            } 
            finally { this.uiManager.toggleLoading(false); }
        }

        setupEventListeners() {
            const filterInputs = ['filterStartDate', 'filterEndDate', 'filterStatus', 'filterField', 'filterParty', 'filterFileNo', 'filterSubject', 'filterTask'];
            const handleFilterChange = () => {
                this.state.filters.startDate = document.getElementById('filterStartDate').value;
                this.state.filters.endDate = document.getElementById('filterEndDate').value;
                this.state.filters.status = document.getElementById('filterStatus').value;
                this.state.filters.field = document.getElementById('filterField').value;
                this.state.filters.party = document.getElementById('filterParty').value.trim();
                this.state.filters.fileNo = document.getElementById('filterFileNo').value.trim();
                this.state.filters.subject = document.getElementById('filterSubject').value.trim();
                this.state.filters.task = document.getElementById('filterTask').value.trim();
                this.renderPage();
            };

            const debouncedFilter = () => { clearTimeout(this.filterDebounceTimer); this.filterDebounceTimer = setTimeout(handleFilterChange, 300); };
            filterInputs.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.addEventListener((el.type === 'date' || el.tagName === 'SELECT') ? 'change' : 'input', debouncedFilter);
            });

            document.getElementById('btnClearFilters')?.addEventListener('click', () => {
                filterInputs.forEach(id => {
                    const el = document.getElementById(id);
                    if (el) { if(el.tagName === 'SELECT') el.value = (id === 'filterStatus' ? 'all' : ''); else el.value = ''; }
                });
                this.state.filters = { startDate: '', endDate: '', status: 'all', field: '', party: '', fileNo: '', subject: '', task: '' };
                this.renderPage();
            });

            $('a[data-toggle="tab"]').on('shown.bs.tab', (e) => {
                this.state.activeTab = $(e.target).attr("href") === '#content-foreign' ? 'foreign' : 'main';
                this.renderPage();
            });

            document.querySelectorAll('th[data-sort]').forEach(th => {
                th.style.cursor = 'pointer';
                th.addEventListener('click', () => {
                    const column = th.dataset.sort;
                    this.state.sort = this.state.sort.column === column ? { column, direction: this.state.sort.direction === 'asc' ? 'desc' : 'asc' } : { column, direction: 'asc' };
                    document.querySelectorAll('.sort-icon').forEach(i => i.className = 'fas fa-sort sort-icon text-muted');
                    th.querySelector('i').className = `fas fa-sort-${this.state.sort.direction === 'asc' ? 'up' : 'down'} sort-icon`;
                    this.renderPage();
                });
            });

            const toggleSelection = (checked, id) => {
                 if(checked) this.state.selectedIds.add(id); else this.state.selectedIds.delete(id);
                 this.uiManager.updateBulkActionsVisibility(this.state.selectedIds.size > 0);
            };

            const selectAll = (checked) => { document.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = checked; toggleSelection(checked, cb.dataset.id); }); };
            document.getElementById('selectAllCheckbox')?.addEventListener('change', e => selectAll(e.target.checked));
            document.getElementById('selectAllCheckboxForeign')?.addEventListener('change', e => selectAll(e.target.checked));

            [this.uiManager.tableBody, this.uiManager.foreignTableBody].forEach(body => {
                if(!body) return;
                body.addEventListener('change', e => { if (e.target.classList.contains('row-checkbox')) toggleSelection(e.target.checked, e.target.dataset.id); });
            });

            document.getElementById('payFullOfficial')?.addEventListener('change', (e) => { document.getElementById('officialAmountInputContainer').style.display = e.target.checked ? 'none' : 'block'; });
            document.getElementById('payFullService')?.addEventListener('change', (e) => { document.getElementById('serviceAmountInputContainer').style.display = e.target.checked ? 'none' : 'block'; });
            document.getElementById('payFullForeign')?.addEventListener('change', (e) => { document.getElementById('foreignSplitInputs').style.display = e.target.checked ? 'none' : 'block'; });

            const handleActionClick = async (e) => {
                const link = e.target.closest('.task-detail-link');
                if (link) { e.preventDefault(); this.openTaskDetail(link.dataset.taskId); return; }

                const btn = e.target.closest('.action-btn');
                if (!btn) return; e.preventDefault(); const id = btn.dataset.id;

                if (btn.classList.contains('view-btn')) {
                    this.uiManager.showViewDetailModal(this.dataManager.allAccruals.find(a => a.id === id));
                } else if (btn.classList.contains('edit-btn')) {
                    this.uiManager.toggleLoading(true);
                    try {
                        const acc = this.dataManager.allAccruals.find(a => a.id === id);
                        const task = await this.dataManager.getFreshTaskDetail(acc.taskId);
                        
                        const findEpats = (obj) => {
                            if (!obj || typeof obj !== 'object') return null;
                            if (obj.url && obj.name && (obj.turkpatentEvrakNo || obj.documentDate || obj.name.includes('.pdf'))) {
                                return obj;
                            }
                            for (let key in obj) {
                                let found = findEpats(obj[key]);
                                if (found) return found;
                            }
                            return null;
                        };

                        let epatsDoc = findEpats(task);
                        if (typeof epatsDoc === 'string') {
                            try { epatsDoc = JSON.parse(epatsDoc); } catch(e) {}
                        }

                        this.uiManager.initEditModal(acc, this.dataManager.allPersons, epatsDoc);
                    } catch (err) {
                        console.error("Düzenle Modal Hatası:", err);
                    } finally {
                        this.uiManager.toggleLoading(false);
                    }
                } else if (btn.classList.contains('delete-btn')) {
                    if (confirm('Bu tahakkuku silmek istediğinize emin misiniz?')) {
                        this.uiManager.toggleLoading(true);
                        await this.dataManager.deleteAccrual(id);
                        this.renderPage();
                        this.uiManager.toggleLoading(false);
                        showNotification('Silindi', 'success');
                    }
                }
            };

            if(this.uiManager.tableBody) this.uiManager.tableBody.addEventListener('click', handleActionClick);
            if(this.uiManager.foreignTableBody) this.uiManager.foreignTableBody.addEventListener('click', handleActionClick);

            document.getElementById('bulkMarkPaidBtn').addEventListener('click', () => {
                const selected = Array.from(this.state.selectedIds).map(id => this.dataManager.allAccruals.find(a => a.id === id)).filter(Boolean);
                this.uploadedPaymentReceipts = []; 
                this.uiManager.showPaymentModal(selected, this.state.activeTab); 
            });

            document.getElementById('bulkMarkUnpaidBtn')?.addEventListener('click', async () => {
                if (this.state.selectedIds.size === 0) return;
                if (confirm(`${this.state.selectedIds.size} adet kaydı "Ödenmedi" durumuna getirmek istiyor musunuz?`)) {
                    this.uiManager.toggleLoading(true);
                    try {
                        await this.dataManager.batchUpdateStatus(this.state.selectedIds, 'unpaid');
                        this.state.selectedIds.clear(); 
                        this.renderPage(); 
                        showNotification('Güncellendi', 'success');
                    } catch (e) { showNotification('Hata: ' + e.message, 'error'); } 
                    finally { this.uiManager.toggleLoading(false); }
                }
            });

            document.getElementById('saveAccrualChangesBtn').addEventListener('click', async () => {
                const formResult = this.uiManager.getEditFormData();
                if (!formResult.success) { showNotification(formResult.error, 'error'); return; }
                this.uiManager.toggleLoading(true);
                try {
                    await this.dataManager.updateAccrual(document.getElementById('editAccrualId').value, formResult.data, (formResult.data.files||[])[0]);
                    this.uiManager.closeModal('editAccrualModal');
                    this.renderPage();
                    showNotification('Güncellendi', 'success');
                } catch (e) { showNotification(e.message, 'error'); } 
                finally { this.uiManager.toggleLoading(false); }
            });

            document.getElementById('confirmMarkPaidBtn').addEventListener('click', async () => {
                const date = document.getElementById('paymentDate').value;
                if(!date) { showNotification('Tarih seçiniz', 'error'); return; }

                let singleDetails = null;
                if (this.state.selectedIds.size === 1) {
                     if (this.state.activeTab === 'foreign') {
                        const isFull = document.getElementById('payFullForeign').checked;
                        singleDetails = { isForeignMode: true, payFullOfficial: isFull, payFullService: isFull, manualOfficial: document.getElementById('manualForeignOfficial').value, manualService: document.getElementById('manualForeignService').value };
                     } else {
                        singleDetails = { isForeignMode: false, payFullOfficial: document.getElementById('payFullOfficial').checked, payFullService: document.getElementById('payFullService').checked, manualOfficial: document.getElementById('manualOfficialAmount').value, manualService: document.getElementById('manualServiceAmount').value };
                     }
                }

                this.uiManager.toggleLoading(true);
                try {
                    await this.dataManager.savePayment(this.state.selectedIds, { date, receiptFiles: this.uploadedPaymentReceipts, singlePaymentDetails: singleDetails });
                    this.uiManager.closeModal('markPaidModal');
                    this.state.selectedIds.clear();
                    this.renderPage();
                    showNotification('Ödeme işlendi', 'success');
                } catch(e) { showNotification(e.message, 'error'); }
                finally { this.uiManager.toggleLoading(false); }
            });

            document.querySelectorAll('.close-modal-btn, #cancelEditAccrualBtn, #cancelMarkPaidBtn').forEach(b => {
                b.addEventListener('click', e => this.uiManager.closeModal(e.target.closest('.modal').id));
            });

             document.getElementById('btnExportSelectedAccruals')?.addEventListener('click', () => this.exportToExcel('selected'));
             document.getElementById('btnExportAllAccruals')?.addEventListener('click', () => this.exportToExcel('all'));

             const area = document.getElementById('paymentReceiptFileUploadArea');
             if(area) {
                 area.addEventListener('click', () => document.getElementById('paymentReceiptFile').click());
                 document.getElementById('paymentReceiptFile').addEventListener('change', e => {
                     Array.from(e.target.files).forEach(f => this.uploadedPaymentReceipts.push({id: Date.now().toString(), name: f.name, type: f.type, file: f}));
                     document.getElementById('paymentReceiptFileList').innerHTML = this.uploadedPaymentReceipts.map(f => `<div class="small">${f.name} (Hazır)</div>`).join('');
                 });
             }

            const btnFreestyle = document.getElementById('btnCreateFreestyleAccrual');
            const modalFreestyle = document.getElementById('freestyleAccrualModal');
            
            if (btnFreestyle && modalFreestyle) {
                btnFreestyle.addEventListener('click', async () => {
                    this.uiManager.toggleLoading(true);
                    try {
                        if (!this.dataManager.allPersons || this.dataManager.allPersons.length === 0) {
                            const { personService } = await import('../../supabase-config.js');
                            const res = await personService.getPersons();
                            this.dataManager.allPersons = res.success ? res.data : [];
                        }

                        if (!this.freestyleFormManager) {
                            this.freestyleFormManager = new (await import('../components/AccrualFormManager.js')).AccrualFormManager(
                                'freestyleAccrualFormContainer', 'freestyle', this.dataManager.allPersons, { isFreestyle: true }
                            );
                            this.freestyleFormManager.render();
                        } else {
                            this.freestyleFormManager.persons = this.dataManager.allPersons;
                        }

                        this.freestyleFormManager.reset();
                        modalFreestyle.classList.add('show');
                    } catch (error) { showNotification('Form yüklenirken hata oluştu.', 'error'); } 
                    finally { this.uiManager.toggleLoading(false); }
                });

                document.getElementById('cancelFreestyleAccrualBtn').addEventListener('click', () => modalFreestyle.classList.remove('show'));
                document.getElementById('closeFreestyleAccrualModal').addEventListener('click', () => modalFreestyle.classList.remove('show'));

                document.getElementById('saveFreestyleAccrualBtn').addEventListener('click', async () => {
                    const formResult = this.freestyleFormManager.getData();
                    if (!formResult.success) { showNotification(formResult.error, 'error'); return; }

                    this.uiManager.toggleLoading(true);
                    try {
                        const newAccrualData = formResult.data;
                        const fileToUpload = (newAccrualData.files || [])[0];
                        await this.dataManager.createFreestyleAccrual(newAccrualData, fileToUpload);
                        modalFreestyle.classList.remove('show');
                        this.renderPage(); 
                        showNotification('Serbest tahakkuk başarıyla oluşturuldu!', 'success');
                    } catch (e) { showNotification('Tahakkuk kaydedilemedi: ' + e.message, 'error'); } 
                    finally { this.uiManager.toggleLoading(false); }
                });
            }
        }

        async openTaskDetail(taskId) {
            this.uiManager.taskDetailModal.classList.add('show');
            document.getElementById('modalTaskTitle').textContent = 'Yükleniyor...';
            this.uiManager.taskDetailManager.showLoading();
            try {
                const task = await this.dataManager.getFreshTaskDetail(taskId);
                if(!task) throw new Error("İş bulunamadı");
                
                const ipRecord = task.relatedIpRecordId ? this.dataManager.ipRecordsMap[task.relatedIpRecordId] : null;
                const transactionType = this.dataManager.allTransactionTypes.find(t => t.id === task.taskType);
                const assignedUser = this.dataManager.allUsers.find(u => u.id === task.assignedTo_uid);
                const relatedAccruals = this.dataManager.allAccruals.filter(acc => String(acc.taskId) === String(task.id));

                this.uiManager.taskDetailManager.render(task, { ipRecord, transactionType, assignedUser, accruals: relatedAccruals });
            } catch(e) {
                this.uiManager.taskDetailManager.showError('İş detayı yüklenemedi.');
            }
        }
    }

    new AccrualsController().init();
});