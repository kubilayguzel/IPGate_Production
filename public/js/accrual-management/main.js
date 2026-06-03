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
                filters: { department: '', type: '', startDate: '', endDate: '', status: 'all', invoiceStatus: 'all', field: '', party: '', fileNo: '', subject: '', task: '', description: '' },
                sort: { column: 'createdAt', direction: 'desc' },
                selectedIds: new Set(),
                itemsPerPage: 50 
            };
            this.editingRecursiveId = null;
            this.pagination = null;
            this.uploadedPaymentReceipts = []; 
            this.filterDebounceTimer = null; 
        }

        async init() {
            this.initPagination();
            this.setupEventListeners();
            await this.loadData();
            await this.loadRecursiveData();
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

        async loadRecursiveData() {
            if (!this.uiManager.recursiveTableBody) return;
            const res = await this.dataManager.getRecursiveAccruals();
            if (res.success) {
                this.uiManager.renderRecursiveTable(res.data, this.dataManager.allPersons);
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
                // 1. Canlı Kur Çekimi (Merkez Bankası / Global API)
                let exchangeRates = { TRY: 1, USD: 34.5, EUR: 38.2, GBP: 45.5, CHF: 40.8 };
                let isLiveRate = false;
                
                try {
                    const response = await fetch('https://api.exchangerate-api.com/v4/latest/TRY');
                    if (response.ok) {
                        const data = await response.json();
                        exchangeRates = {
                            TRY: 1, USD: 1 / data.rates.USD, EUR: 1 / data.rates.EUR,
                            GBP: 1 / data.rates.GBP, CHF: 1 / data.rates.CHF
                        };
                        isLiveRate = true;
                    }
                } catch (e) {
                    console.warn("Canlı kurlar alınamadı, yedek kurlar kullanılacak.");
                }

                // 2. ExcelJS Kütüphanesini Yükle
                const loadScript = (src) => new Promise((resolve, reject) => {
                    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
                    const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = reject; document.head.appendChild(script);
                });

                if (!window.ExcelJS) await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.3.0/dist/exceljs.min.js');
                if (!window.saveAs) await loadScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js');

                const ExcelJS = window.ExcelJS;
                const workbook = new ExcelJS.Workbook();
                // Kılavuz çizgilerini kapatarak tertemiz bir A4 kağıdı / Dashboard görünümü elde ediyoruz.
                const worksheet = workbook.addWorksheet('Mali Rapor', { views: [{ showGridLines: false }] });

                // Sınıf: Finansal Rakam Toplayıcı (Sadece Raw Number tutar, Excel'in kendi formatına bırakır)
                class CurrencyTracker {
                    constructor(rates) { 
                        this.totalTRY = 0; 
                        this.rates = rates; 
                        this.original = {}; // 🔥 Dövize göre ayrı toplamları tutacağımız obje
                    }
                    add(amount, currency) {
                        const curr = currency || 'TRY';
                        const amt = parseFloat(amount) || 0;
                        const rate = this.rates[curr] || 1;
                        this.totalTRY += (amt * rate);
                        
                        // 🔥 Orijinal döviz cinsinden ayrı ayrı topla
                        if (!this.original[curr]) this.original[curr] = 0;
                        this.original[curr] += amt;
                    }
                    getRaw() { return this.totalTRY; }
                    formatStr() { return new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(this.totalTRY) + ' ₺'; }
                    
                    // 🔥 YENİ: Döviz cinsinden toplanmış rakamları yan yana formatlı string olarak verir (Örn: 1.500,00 EUR + 200,00 USD)
                    getOriginalTotalsStr() {
                        const parts = [];
                        for (const [curr, amt] of Object.entries(this.original)) {
                            if (Math.abs(amt) > 0.01) { // 0 olanları gizle
                                parts.push(new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amt) + ' ' + curr);
                            }
                        }
                        return parts.length > 0 ? parts.join(' + ') : '0 TRY';
                    }
                }

                const grandTotals = {
                    official: new CurrencyTracker(exchangeRates), service: new CurrencyTracker(exchangeRates),
                    vat: new CurrencyTracker(exchangeRates), total: new CurrencyTracker(exchangeRates), remaining: new CurrencyTracker(exchangeRates)
                };
                
                let unpaidCount = 0; let paidCount = 0;
                const groupedData = {};

                // 3. Veri Analizi ve Toplam Hesaplamaları
                dataToExport.forEach(acc => {
                    const dateObj = acc.createdAt instanceof Date ? acc.createdAt : new Date(acc.createdAt || 0);
                    const monthYear = dateObj.toLocaleDateString('tr-TR', { year: 'numeric', month: 'long' }).toUpperCase();
                    if (!groupedData[monthYear]) groupedData[monthYear] = [];
                    groupedData[monthYear].push(acc);

                    if (acc.status === 'unpaid' || acc.status === 'partial') unpaidCount++;
                    else if (acc.status === 'paid') paidCount++;

                    const officialAmt = acc.officialFee?.amount || 0; const officialCurr = acc.officialFee?.currency || 'TRY';
                    const serviceAmt = acc.serviceFee?.amount || 0; const serviceCurr = acc.serviceFee?.currency || 'TRY';
                    const vatRate = acc.vatRate || 0;
                    const baseForVat = serviceAmt + (acc.applyVatToOfficialFee ? officialAmt : 0);
                    const vatAmt = baseForVat * (vatRate / 100);

                    grandTotals.official.add(officialAmt, officialCurr);
                    grandTotals.service.add(serviceAmt, serviceCurr);
                    grandTotals.vat.add(vatAmt, serviceCurr);

                    const totalArr = Array.isArray(acc.totalAmount) ? acc.totalAmount : [{amount: acc.totalAmount || 0, currency: 'TRY'}];
                    const remArr = acc.status === 'paid' ? [] : (Array.isArray(acc.remainingAmount) ? acc.remainingAmount : [{amount: acc.remainingAmount || acc.totalAmount || 0, currency: 'TRY'}]);

                    totalArr.forEach(t => grandTotals.total.add(t.amount, t.currency));
                    remArr.forEach(r => grandTotals.remaining.add(r.amount, r.currency));
                });

                // 4. Excel Sütun Tanımları ve Hücre Tipleri (Para birimleri native 'Number' formatında)
                worksheet.columns = [
                    { header: 'İşlem ID', key: 'id', width: 12, style: { alignment: { horizontal: 'center', vertical: 'middle' } } },
                    { header: 'Kayıt Tarihi', key: 'createdAt', width: 16, style: { alignment: { horizontal: 'center', vertical: 'middle' } } },
                    { header: 'Tür', key: 'type', width: 18, style: { alignment: { vertical: 'middle' } } },
                    { header: 'Durum', key: 'status', width: 16, style: { alignment: { horizontal: 'center', vertical: 'middle' } } },
                    { header: 'Alan', key: 'field', width: 15, style: { alignment: { horizontal: 'center', vertical: 'middle' } } },
                    { header: 'Dosya No', key: 'fileNo', width: 20, style: { alignment: { vertical: 'middle' } } },
                    { header: 'Konu / Marka', key: 'subject', width: 35, style: { alignment: { vertical: 'middle' } } },
                    { header: 'İlgili İş', key: 'taskTitle', width: 35, style: { alignment: { vertical: 'middle' } } },
                    { header: 'Firma / Müşteri', key: 'party', width: 35, style: { alignment: { vertical: 'middle' } } },
                    { header: 'TPE Fatura', key: 'tpeInvoiceNo', width: 16, style: { alignment: { horizontal: 'center', vertical: 'middle' } } },
                    { header: 'Evreka Fatura', key: 'evrekaInvoiceNo', width: 16, style: { alignment: { horizontal: 'center', vertical: 'middle' } } }, 
                    { header: 'Resmi Ücret', key: 'officialFee', width: 18, style: { numFmt: '#,##0.00', alignment: { horizontal: 'right', vertical: 'middle' } } }, 
                    { header: 'PB', key: 'officialFeeCurr', width: 8, style: { alignment: { horizontal: 'center', vertical: 'middle' } } }, 
                    { header: 'Hizmet Bedeli', key: 'serviceFee', width: 18, style: { numFmt: '#,##0.00', alignment: { horizontal: 'right', vertical: 'middle' } } }, 
                    { header: 'PB', key: 'serviceFeeCurr', width: 8, style: { alignment: { horizontal: 'center', vertical: 'middle' } } }, 
                    { header: 'KDV Tutarı', key: 'vatAmount', width: 18, style: { numFmt: '#,##0.00', alignment: { horizontal: 'right', vertical: 'middle' } } }, 
                    { header: 'PB', key: 'vatCurr', width: 8, style: { alignment: { horizontal: 'center', vertical: 'middle' } } },
                    { header: 'TOPLAM (TRY)', key: 'totalAmount', width: 22, style: { numFmt: '#,##0.00 "₺"', font: { bold: true }, alignment: { horizontal: 'right', vertical: 'middle' } } }, 
                    { header: 'AÇIK BAKİYE (TRY)', key: 'remainingAmount', width: 22, style: { numFmt: '#,##0.00 "₺"', font: { bold: true }, alignment: { horizontal: 'right', vertical: 'middle' } } }
                ];

                // Tüm çalışma sayfasına prestijli "Montserrat" fontunu uygula
                worksheet.columns.forEach(col => { col.font = { name: 'Montserrat', size: 10 }; });

                // Üst kısma Dashboard için 8 boş satır açıyoruz
                worksheet.spliceRows(1, 0, [], [], [], [], [], [], [], []);

                // --- BÖLÜM 1: YÖNETİCİ ÖZETİ (DASHBOARD) ---
                worksheet.mergeCells('A1:S2');
                const titleCell = worksheet.getCell('A1');
                titleCell.value = 'YÖNETİM KURULU MALİ DURUM VE TAHAKKUK RAPORU';
                titleCell.font = { name: 'Montserrat', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
                titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } }; // Gece Mavisi
                titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

                worksheet.mergeCells('A3:S3');
                const subtitleCell = worksheet.getCell('A3');
                subtitleCell.value = `Oluşturulma Tarihi: ${new Date().toLocaleDateString('tr-TR')} | Kur Durumu: ${isLiveRate ? '🔴 Canlı / Güncel' : '⚪ Sabit'}`;
                subtitleCell.font = { name: 'Montserrat', size: 10, italic: true, color: { argb: 'FF64748B' } };
                subtitleCell.alignment = { vertical: 'middle', horizontal: 'right' };

                const createBox = (range, cellRef, title, value, bgColor, textColor, valueColor) => {
                    worksheet.mergeCells(range);
                    const box = worksheet.getCell(cellRef);
                    box.value = { richText: [ { font: { bold: true, size: 10, color: { argb: textColor } }, text: title + '\n' }, { font: { bold: true, size: 14, color: { argb: valueColor } }, text: value } ] };
                    box.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
                    box.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
                    box.border = { top: {style:'thin', color:{argb:'FFCBD5E1'}}, left: {style:'thin', color:{argb:'FFCBD5E1'}}, bottom: {style:'thin', color:{argb:'FFCBD5E1'}}, right: {style:'thin', color:{argb:'FFCBD5E1'}} };
                };

                // Dashboard Kutuları
                createBox('B5:D7', 'B5', 'İŞLEM ÖZETİ', `Toplam: ${dataToExport.length}\nÖdenen: ${paidCount} | Bekleyen: ${unpaidCount}`, 'FFF1F5F9', 'FF475569', 'FF0F172A');
                createBox('F5:J7', 'F5', 'GENEL CİRO (KESİLEN FATURALAR)', grandTotals.total.formatStr(), 'FFF0FDF4', 'FF166534', 'FF15803D'); // Yeşilimsi
                createBox('L5:P7', 'L5', 'TAHSİLAT BEKLEYEN (AÇIK BAKİYE)', grandTotals.remaining.formatStr(), 'FFFFF1F2', 'FF991B1B', 'FFDC2626'); // Kırmızımsı
                
                const rateText = `USD: ${exchangeRates.USD.toFixed(2)} ₺ | EUR: ${exchangeRates.EUR.toFixed(2)} ₺\nGBP: ${exchangeRates.GBP.toFixed(2)} ₺ | CHF: ${exchangeRates.CHF.toFixed(2)} ₺`;
                createBox('R5:S7', 'R5', 'KULLANILAN KURLAR', rateText, 'FFF8FAFC', 'FF334155', 'FF1E293B');

                // --- BÖLÜM 2: TABLO BAŞLIKLARI ---
                const headerRow = worksheet.getRow(9);
                headerRow.height = 25;
                headerRow.eachCell((cell) => {
                    cell.font = { name: 'Montserrat', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }; // Dark Slate
                    cell.alignment = { vertical: 'middle', horizontal: 'center' };
                    cell.border = { bottom: { style: 'medium', color: { argb: 'FF0F172A' } } };
                });
                worksheet.autoFilter = 'A9:S9';

                // --- BÖLÜM 3: VERİ DÖKÜMÜ ---
                let isAlternate = false;

                for (const [monthYear, records] of Object.entries(groupedData)) {
                    
                    const monthTotals = { total: new CurrencyTracker(exchangeRates), remaining: new CurrencyTracker(exchangeRates) };

                    records.forEach(acc => {
                        const dateObj = acc.createdAt instanceof Date ? acc.createdAt : new Date(acc.createdAt || 0);
                        
                        const task = this.dataManager.allTasks[String(acc.taskId)];
                        const typeObj = task ? this.dataManager.allTransactionTypes.find(t => t.id === task.taskType) : null;
                        const ipRec = task?.relatedIpRecordId ? this.dataManager.ipRecordsMap[task.relatedIpRecordId] : null;

                        let fieldText = '-';
                        if (typeObj?.ipType) fieldText = { 'trademark': 'Marka', 'patent': 'Patent', 'design': 'Tasarım', 'suit': 'Dava' }[typeObj.ipType] || typeObj.ipType;

                        const officialAmt = acc.officialFee?.amount || 0; const officialCurr = acc.officialFee?.currency || 'TRY';
                        const serviceAmt = acc.serviceFee?.amount || 0; const serviceCurr = acc.serviceFee?.currency || 'TRY';
                        const vatAmt = (serviceAmt + (acc.applyVatToOfficialFee ? officialAmt : 0)) * ((acc.vatRate || 0) / 100);

                        const totalArr = Array.isArray(acc.totalAmount) ? acc.totalAmount : [{amount: acc.totalAmount || 0, currency: 'TRY'}];
                        const remArr = acc.status === 'paid' ? [] : (Array.isArray(acc.remainingAmount) ? acc.remainingAmount : [{amount: acc.remainingAmount || acc.totalAmount || 0, currency: 'TRY'}]);

                        totalArr.forEach(t => monthTotals.total.add(t.amount, t.currency));
                        remArr.forEach(r => monthTotals.remaining.add(r.amount, r.currency));

                        // Diziyi Matematiksel Excel Sayısına Çeviren Yardımcı (Metin Değil!)
                        const getRawTRY = (arr) => {
                            if (!Array.isArray(arr) || arr.length === 0) return 0;
                            return arr.reduce((sum, x) => sum + ((parseFloat(x.amount) || 0) * (exchangeRates[x.currency || 'TRY'] || 1)), 0);
                        };

                        const newRow = worksheet.addRow({
                            id: `#${acc.id}`, createdAt: dateObj.toLocaleDateString('tr-TR'), type: acc.type || 'Hizmet', 
                            status: acc.status === 'paid' ? 'Ödendi' : (acc.status === 'unpaid' ? 'Ödenmedi' : 'Kısmen'),
                            field: fieldText, fileNo: ipRec ? (ipRec.applicationNumber || ipRec.applicationNo || '-') : '-',
                            subject: ipRec ? (ipRec.markName || ipRec.title || ipRec.name || '-') : (acc.subject || '-'),
                            taskTitle: typeObj ? (typeObj.alias || typeObj.name) : (acc.taskTitle || '-'),
                            party: acc.paymentParty || acc.tpInvoiceParty?.name || acc.serviceInvoiceParty?.name || '-', 
                            tpeInvoiceNo: acc.tpeInvoiceNo || '', evrekaInvoiceNo: acc.evrekaInvoiceNo || '',
                            officialFee: officialAmt, officialFeeCurr: officialCurr, 
                            serviceFee: serviceAmt, serviceFeeCurr: serviceCurr, 
                            vatAmount: vatAmt, vatCurr: serviceCurr,
                            totalAmount: getRawTRY(totalArr), 
                            remainingAmount: getRawTRY(remArr)
                        });

                        newRow.height = 20;

                        // Stil ve Durum Renklendirme
                        newRow.eachCell((cell, colNumber) => {
                            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isAlternate ? 'FFF8FAFC' : 'FFFFFFFF' } }; // Soft gri ve Beyaz
                            cell.border = { bottom: { style: 'thin', color: {argb: 'FFF1F5F9'} } };
                            
                            // Durum Sütunu (4. Sütun) Renklendirmesi
                            if (colNumber === 4) {
                                if (acc.status === 'paid') cell.font = { name: 'Montserrat', size: 10, bold: true, color: { argb: 'FF15803D' } }; // Yeşil
                                else if (acc.status === 'unpaid') cell.font = { name: 'Montserrat', size: 10, bold: true, color: { argb: 'FFDC2626' } }; // Kırmızı
                                else cell.font = { name: 'Montserrat', size: 10, bold: true, color: { argb: 'FFB45309' } }; // Turuncu
                            }
                        });
                        isAlternate = !isAlternate;
                    });

                    // --- AYLIK ALT TOPLAM (DÖVİZ CİNSİNDEN) ---
                    const originalSubtotalRow = worksheet.addRow({
                        party: `${monthYear} DÖVİZ TOPLAMLARI:`,
                        totalAmount: monthTotals.total.getOriginalTotalsStr(),
                        remainingAmount: monthTotals.remaining.getOriginalTotalsStr()
                    });
                    
                    originalSubtotalRow.height = 20;
                    originalSubtotalRow.eachCell((cell, colNumber) => {
                        cell.font = { name: 'Montserrat', size: 9, bold: true, color: { argb: 'FF334155' }, italic: true };
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }; // Çok açık mavi/gri
                        cell.border = { top: { style: 'thin', color: {argb: 'FFCBD5E1'} } };
                        if (colNumber > 1) cell.alignment = { horizontal: 'right', vertical: 'middle' };
                    });

                    // --- AYLIK ALT TOPLAM (TL KARŞILIĞI) ---
                    const subtotalRow = worksheet.addRow({
                        party: `${monthYear} TL KARŞILIĞI:`,
                        totalAmount: monthTotals.total.getRaw(),
                        remainingAmount: monthTotals.remaining.getRaw()
                    });
                    
                    subtotalRow.height = 22;
                    subtotalRow.eachCell((cell) => {
                        cell.font = { name: 'Montserrat', size: 10, bold: true, color: { argb: 'FF0F172A' } };
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; // Koyu Gri Zemin
                        cell.border = { bottom: { style: 'medium', color: {argb: 'FF94A3B8'} } };
                    });
                    worksheet.addRow({}); // Aylar arasına nefes boşluğu
                }

                // --- BÖLÜM 4: GENEL TOPLAM (GRAND TOTAL) ---
                const originalGrandTotalRow = worksheet.addRow({
                    party: 'GENEL DÖVİZ TOPLAMLARI:',
                    totalAmount: grandTotals.total.getOriginalTotalsStr(),
                    remainingAmount: grandTotals.remaining.getOriginalTotalsStr()
                });
                
                originalGrandTotalRow.height = 22;
                originalGrandTotalRow.eachCell((cell, colNumber) => {
                    cell.font = { name: 'Montserrat', size: 10, bold: true, color: { argb: 'FF065F46' }, italic: true };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }; // Açık yeşil arka plan
                    if (colNumber > 1) cell.alignment = { horizontal: 'right', vertical: 'middle' };
                });

                const grandTotalRow = worksheet.addRow({
                    party: 'GENEL TOPLAM RAPORU (TL KARŞILIĞI):',
                    totalAmount: grandTotals.total.getRaw(),
                    remainingAmount: grandTotals.remaining.getRaw()
                });
                
                grandTotalRow.height = 25;
                grandTotalRow.eachCell((cell) => {
                    cell.font = { name: 'Montserrat', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } }; // Zümrüt Yeşili
                });


                // ==============================================================================
                // 🔥 --- 5. BÖLÜM: EVREKA İŞLERİ SEKME YAPISI (Detaylı Kalem Kırılımlı) ---
                // ==============================================================================
                const wsEvreka = workbook.addWorksheet('Evreka İşleri', { views: [{ showGridLines: true }] });
                
                // Başlık Grubu (Mavi Tema)
                wsEvreka.mergeCells('A1:K1');
                const evrekaTitle = wsEvreka.getCell('A1');
                evrekaTitle.value = "IPGate - Evreka Birimi Detaylı Kalem Raporu";
                evrekaTitle.font = { name: 'Montserrat', size: 16, bold: true, color: { argb: 'FF1E3A8A' } };
                wsEvreka.getRow(1).height = 40;

                wsEvreka.mergeCells('A2:K2');
                const evrekaSub = wsEvreka.getCell('A2');
                evrekaSub.value = `Rapor Tarihi: ${new Date().toLocaleDateString('tr-TR')} | Sadece EVREKA Departmanına Ait Kalem (Item) Kırılımlı Kayıtlar`;
                evrekaSub.font = { name: 'Montserrat', size: 10, italic: true, color: { argb: 'FF6B7280' } };
                wsEvreka.getRow(2).height = 20;

                // Tablo Kolon Tanımlamaları (KALEM BAZLI DETAY)
                wsEvreka.columns = [
                    { header: 'Tahakkuk No', key: 'id', width: 15 },
                    { header: 'Müvekkil / Taraf', key: 'party', width: 35 },
                    { header: 'Tahakkuk Türü', key: 'type', width: 18 },
                    { header: 'Kalem Adı / Detay', key: 'itemName', width: 45 },
                    { header: 'Ücret Tipi', key: 'feeType', width: 20 },
                    { header: 'Miktar', key: 'qty', width: 10 },
                    { header: 'Birim Fiyat', key: 'unitPrice', width: 15, style: { numFmt: '#,##0.00' } },
                    { header: 'KDV %', key: 'vat', width: 10 },
                    { header: 'Toplam Tutar', key: 'total', width: 18, style: { numFmt: '#,##0.00' } },
                    { header: 'Para Birimi', key: 'curr', width: 12 },
                    { header: 'Fatura Durumu', key: 'status', width: 18 }
                ];

                // Başlık Satırı Stili (Mavi)
                wsEvreka.getRow(4).height = 28;
                wsEvreka.getRow(4).eachCell((cell) => {
                    cell.font = { name: 'Montserrat', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } }; // Koyu Mavi
                    cell.alignment = { vertical: 'middle', horizontal: 'center' };
                });

                // Verileri Filtrele ve Yaz (Tahakkuk bazlı değil, KALEM bazlı döngü)
                const evrekaList = dataToExport.filter(a => a.department === 'EVREKA');
                let evrekaSumMap = {};

                evrekaList.forEach(acc => {
                    const items = acc.items || [];
                    items.forEach(item => {
                        const itemCurr = item.currency || acc.currency || 'TRY';
                        const itemTotal = Number(item.total_amount) || 0;

                        if (!evrekaSumMap[itemCurr]) evrekaSumMap[itemCurr] = 0;
                        evrekaSumMap[itemCurr] += itemTotal;

                        const r = wsEvreka.addRow({
                            id: acc.id,
                            party: acc.paymentParty || acc.tpInvoiceParty?.name || acc.serviceInvoiceParty?.name || '-',
                            type: acc.type || '-',
                            itemName: item.item_name || '-',
                            feeType: item.fee_type || '-',
                            qty: Number(item.quantity) || 1,
                            unitPrice: Number(item.unit_price) || 0,
                            vat: Number(item.vat_rate) || 0,
                            total: itemTotal,
                            curr: itemCurr,
                            status: acc.status === 'invoiced' ? 'Fatura Kesildi' : (acc.status === 'sent' ? 'Gönderildi' : 'Taslak')
                        });
                        r.height = 22;
                        r.eachCell(cell => {
                            cell.font = { name: 'Montserrat', size: 10 };
                            cell.border = { top: { style: 'thin', color: { argb: 'FFE5E7EB' } }, bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
                        });
                    });
                });

                // Evreka Döviz Bazlı Özet Tablosu
                wsEvreka.addRow([]); 
                Object.keys(evrekaSumMap).forEach(cur => {
                    const smRow = wsEvreka.addRow({
                        party: `${cur} TOPLAM YEKÜN`,
                        total: evrekaSumMap[cur],
                        curr: cur
                    });
                    smRow.height = 24;
                    smRow.eachCell(cell => {
                        cell.font = { name: 'Montserrat', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }; // Parlak Mavi
                    });
                });

                // ==============================================================================
                // 🔥 --- 6. BÖLÜM: HUKUK İŞLERİ SEKME YAPISI (Detaylı Kalem Kırılımlı) ---
                // ==============================================================================
                const wsHukuk = workbook.addWorksheet('Hukuk İşleri', { views: [{ showGridLines: true }] });
                
                // Başlık Grubu (Mor Tema)
                wsHukuk.mergeCells('A1:K1');
                const hukukTitle = wsHukuk.getCell('A1');
                hukukTitle.value = "IPGate - Hukuk Birimi Detaylı Kalem Raporu";
                hukukTitle.font = { name: 'Montserrat', size: 16, bold: true, color: { argb: 'FF4C1D95' } };
                wsHukuk.getRow(1).height = 40;

                wsHukuk.mergeCells('A2:K2');
                const hukukSub = wsHukuk.getCell('A2');
                hukukSub.value = `Rapor Tarihi: ${new Date().toLocaleDateString('tr-TR')} | Sadece HUKUK Departmanına Ait Kalem (Item) Kırılımlı Kayıtlar`;
                hukukSub.font = { name: 'Montserrat', size: 10, italic: true, color: { argb: 'FF6B7280' } };
                wsHukuk.getRow(2).height = 20;

                // Tablo Kolon Tanımlamaları (Aynı Kırılımlar)
                wsHukuk.columns = wsEvreka.columns;

                // Başlık Satırı Stili (Mor)
                wsHukuk.getRow(4).height = 28;
                wsHukuk.getRow(4).eachCell((cell) => {
                    cell.font = { name: 'Montserrat', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6D28D9' } }; // Koyu Mor
                    cell.alignment = { vertical: 'middle', horizontal: 'center' };
                });

                // Verileri Filtrele ve Yaz (Tahakkuk bazlı değil, KALEM bazlı döngü)
                const hukukList = dataToExport.filter(a => a.department === 'HUKUK');
                let hukukSumMap = {};

                hukukList.forEach(acc => {
                    const items = acc.items || [];
                    items.forEach(item => {
                        const itemCurr = item.currency || acc.currency || 'TRY';
                        const itemTotal = Number(item.total_amount) || 0;

                        if (!hukukSumMap[itemCurr]) hukukSumMap[itemCurr] = 0;
                        hukukSumMap[itemCurr] += itemTotal;

                        const r = wsHukuk.addRow({
                            id: acc.id,
                            party: acc.paymentParty || acc.tpInvoiceParty?.name || acc.serviceInvoiceParty?.name || '-',
                            type: acc.type || '-',
                            itemName: item.item_name || '-',
                            feeType: item.fee_type || '-',
                            qty: Number(item.quantity) || 1,
                            unitPrice: Number(item.unit_price) || 0,
                            vat: Number(item.vat_rate) || 0,
                            total: itemTotal,
                            curr: itemCurr,
                            status: acc.status === 'invoiced' ? 'Fatura Kesildi' : (acc.status === 'sent' ? 'Gönderildi' : 'Taslak')
                        });
                        r.height = 22;
                        r.eachCell(cell => {
                            cell.font = { name: 'Montserrat', size: 10 };
                            cell.border = { top: { style: 'thin', color: { argb: 'FFE5E7EB' } }, bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
                        });
                    });
                });

                // Hukuk Döviz Bazlı Özet Tablosu
                wsHukuk.addRow([]); 
                Object.keys(hukukSumMap).forEach(cur => {
                    const smRow = wsHukuk.addRow({
                        party: `${cur} TOPLAM YEKÜN`,
                        total: hukukSumMap[cur],
                        curr: cur
                    });
                    smRow.height = 24;
                    smRow.eachCell(cell => {
                        cell.font = { name: 'Montserrat', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8B5CF6' } }; // Parlak Mor
                    });
                });

                // Dosyayı Dışa Aktar
                const buffer = await workbook.xlsx.writeBuffer();
                const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                window.saveAs(blob, `Mali_Durum_Raporu_${new Date().toLocaleDateString('tr-TR').replace(/\./g, '_')}.xlsx`);

                showNotification(`${dataToExport.length} kayıt başarıyla profesyonel formata aktarıldı!`, 'success');
            } catch (error) { 
                showNotification('Excel oluşturulurken hata: ' + error.message, 'error'); 
                console.error(error);
            } 
            finally { this.uiManager.toggleLoading(false); }
        }

        setupEventListeners() {
            // 🔥 YENİ: Fatura durumu ve açıklama alanları dinleyicilere eklendi
        const filterInputs = ['filterDepartment', 'filterType', 'filterStartDate', 'filterEndDate', 'filterStatus', 'filterInvoiceStatus', 'filterField', 'filterParty', 'filterFileNo', 'filterSubject', 'filterTask', 'filterDescription'];
        
        const handleFilterChange = () => {
            this.state.filters.department = document.getElementById('filterDepartment').value;
            this.state.filters.type = document.getElementById('filterType').value;
            this.state.filters.startDate = document.getElementById('filterStartDate').value;
            this.state.filters.endDate = document.getElementById('filterEndDate').value;
            this.state.filters.status = document.getElementById('filterStatus').value;
            this.state.filters.invoiceStatus = document.getElementById('filterInvoiceStatus').value; // 🔥 Eklendi
            this.state.filters.field = document.getElementById('filterField').value;
            this.state.filters.party = document.getElementById('filterParty').value.trim();
            this.state.filters.fileNo = document.getElementById('filterFileNo').value.trim();
            this.state.filters.subject = document.getElementById('filterSubject').value.trim();
            this.state.filters.task = document.getElementById('filterTask').value.trim();
            this.state.filters.description = document.getElementById('filterDescription').value.trim(); // 🔥 Eklendi
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
                if (el) { 
                    if(el.tagName === 'SELECT') {
                        // Durum ve Fatura Durumu 'all' olarak sıfırlanmalı
                        el.value = (id === 'filterStatus' || id === 'filterInvoiceStatus') ? 'all' : ''; 
                    } else { 
                        el.value = ''; 
                    } 
                }
            });
            this.state.filters = { department: '', type: '', startDate: '', endDate: '', status: 'all', invoiceStatus: 'all', field: '', party: '', fileNo: '', subject: '', task: '', description: '' };
            this.renderPage();
        });

            // 🔥 2. ADIM EKLENTİSİ: MERKEZİ MOTORU ÇAĞIRAN YENİ DİNLEYİCİ
            document.addEventListener('accrual-auto-calc-request', async (e) => {
                const { accrualData, formData } = e.detail;
                
                if (!accrualData || (!accrualData.taskId || accrualData.taskId === 'null')) {
                    showNotification("Bu tahakkukun bağlı olduğu bir görev bulunamadı.", "warning");
                    return;
                }

                this.uiManager.toggleLoading(true);
                try {
                    const { supabase, feeCalculationService } = await import('../../supabase-config.js');
                    
                    // 1. Görev ve Portföy verilerini çek
                    const { data: taskData } = await supabase.from('tasks').select('*').eq('id', accrualData.taskId).single();
                    if (!taskData) throw new Error("Görev bulunamadı.");

                    let ipRecordData = {};
                    if (taskData.ip_record_id) {
                        const { data: ipData } = await supabase.from('ip_records').select('*').eq('id', taskData.ip_record_id).single();
                        if (ipData) ipRecordData = ipData;
                    }

                    // 🔥 ÇÖZÜM 2: Formda (ekranda) seçili olan güncel müvekkili al (öncelikli), yoksa veritabanındakine bak
                    let activeClientId = null;
                    if (formData && formData.tpInvoicePartyId) {
                        activeClientId = formData.tpInvoicePartyId;
                    } else if (formData && formData.serviceInvoicePartyId) {
                        activeClientId = formData.serviceInvoicePartyId;
                    } else {
                        activeClientId = taskData.task_owner_id;
                    }

                    // 2. SUPABASE-CONFIG.JS'DEKİ MERKEZİ MOTORU ÇAĞIR
                    const calculatedItems = await feeCalculationService.calculateAccrualItems({
                        taskTypeId: taskData.task_type_id,
                        clientId: activeClientId, // 🔥 Artık formdaki YÖRSAN id'si buraya gidiyor!
                        recordId: taskData.ip_record_id,
                        extraParams: { task: taskData, ipRecord: ipRecordData }
                    });

                    if (!calculatedItems || calculatedItems.length === 0) {
                        showNotification("Bu işlem için tanımlanmış bir tarife bulunamadı.", "warning");
                        return;
                    }

                    // 3. Kalemleri Forma Bas
                    if (this.uiManager.editFormManager) {
                        this.uiManager.editFormManager.setCalculatedItems(calculatedItems);
                        showNotification("Fatura kalemleri başarıyla hesaplandı.", "success");
                    }

                } catch (error) {
                    console.error("Otomatik hesaplama hatası:", error);
                    showNotification("Hesaplama hatası: " + error.message, "error");
                } finally {
                    this.uiManager.toggleLoading(false);
                }
            });

            $('a[data-toggle="tab"]').on('shown.bs.tab', (e) => {
                const targetHref = $(e.target).attr("href");
                const sendAdvisorBtn = document.getElementById('bulkSendAdvisorBtn');
                
                // 🔥 YENİ: Filtre ve sayfalama alanlarını seçiyoruz
                const paginationControls = document.getElementById('paginationControls');
                const filterSection = document.querySelector('.filter-section');

                // Sekme değiştiğinde filtre ve sayfalamayı varsayılan olarak geri getiriyoruz
                if (paginationControls) paginationControls.style.display = 'flex';
                if (filterSection) filterSection.style.display = 'block';

                if (targetHref === '#content-foreign') {
                    this.state.activeTab = 'foreign';
                    if(sendAdvisorBtn) sendAdvisorBtn.style.display = 'inline-block';
                }
                else if (targetHref === '#content-invoices') {
                    this.state.activeTab = 'invoices';
                    if(sendAdvisorBtn) sendAdvisorBtn.style.display = 'none';
                }
                else if (targetHref === '#content-recursive') {
                    this.state.activeTab = 'recursive';
                    if(sendAdvisorBtn) sendAdvisorBtn.style.display = 'none';
                    
                    // 🔥 ÇÖZÜM: Tekrarlayan sekmesinde genel sayfalamayı ve filtreyi tamamen gizle!
                    if (paginationControls) paginationControls.style.display = 'none';
                    if (filterSection) filterSection.style.display = 'none';
                    
                    this.state.selectedIds.clear();
                    this.loadRecursiveData();
                    return; // renderPage'in çalışmasını engelleyerek hatalı sayfalama yüklenmesini durdur
                }
                else {
                    this.state.activeTab = 'main';
                    if(sendAdvisorBtn) sendAdvisorBtn.style.display = 'none';
                }
                
                this.state.selectedIds.clear(); 
                this.renderPage();
            });

            // 🔥 ÇÖZÜM: 'th[data-sort]' yerine genel '[data-sort]' arıyoruz, böylece div'ler de tıklanabilir oluyor
            document.querySelectorAll('[data-sort]').forEach(el => {
                el.style.cursor = 'pointer';
                el.addEventListener('click', (e) => {
                    // Kullanıcı bazen div'in kendisine değil içindeki ikona/yazıya tıklayabilir, bu yüzden closest ile kapsayıcıyı alıyoruz
                    const targetEl = e.target.closest('[data-sort]');
                    if (!targetEl) return;
                    
                    const column = targetEl.dataset.sort;
                    this.state.sort = this.state.sort.column === column 
                        ? { column, direction: this.state.sort.direction === 'asc' ? 'desc' : 'asc' } 
                        : { column, direction: 'asc' };
                        
                    // Ekrandaki tüm ikonları sıfırla
                    document.querySelectorAll('.sort-icon').forEach(i => i.className = 'fas fa-sort sort-icon text-muted');
                    
                    // Sadece tıklanan filtrenin ikonunu aktif et
                    const icon = targetEl.querySelector('i');
                    if(icon) {
                        icon.className = `fas fa-sort-${this.state.sort.direction === 'asc' ? 'up' : 'down'} sort-icon text-primary`;
                    }
                    
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

            // YENİ: INVOICE SILME (İPTAL) BUTONU DİNLEYİCİSİ
            const handleInvoiceActionClick = async (e) => {
                const cancelBtn = e.target.closest('.cancel-invoice-btn');
                if (cancelBtn) {
                    e.preventDefault();
                    const invoiceId = cancelBtn.dataset.id;
                    
                    if (confirm('Bu faturayı KolayBi ve sistem üzerinden kalıcı olarak silmek istediğinize emin misiniz?\\n\\n(Faturaya bağlı tahakkuklar serbest kalacaktır.)')) {
                        this.uiManager.toggleLoading(true);
                        try {
                            const { supabase } = await import('../../supabase-config.js');
                            const { data, error } = await supabase.functions.invoke('create-kolaybi-invoice', {
                                body: { action: 'delete', invoiceId: invoiceId }
                            });

                            if (error) throw new Error(error.message);
                            if (!data.success) throw new Error(data.error);

                            showNotification('Fatura başarıyla silindi ve tahakkuklar serbest bırakıldı.', 'success');
                            await this.dataManager.fetchAllData(); 
                            this.renderPage(); 
                        } catch (err) {
                            showNotification('Fatura silinemedi: ' + err.message, 'error');
                        } finally {
                            this.uiManager.toggleLoading(false);
                        }
                    }
                }
            };
            
            if(this.uiManager.invoicesTableBody) this.uiManager.invoicesTableBody.addEventListener('click', handleInvoiceActionClick);

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
                        // 🔥 YENİ EKLENDİ (this.state.activeTab === 'foreign')
                        await this.dataManager.batchUpdateStatus(this.state.selectedIds, 'unpaid', this.state.activeTab === 'foreign');
                        this.state.selectedIds.clear(); 
                        this.renderPage();
                        showNotification('Güncellendi', 'success');
                    } catch (e) { showNotification('Hata: ' + e.message, 'error'); } 
                    finally { this.uiManager.toggleLoading(false); }
                }
            });

            // YENİ: KolayBi Fatura Kes Butonu Dinleyicisi
            const bulkCreateInvoiceBtn = document.getElementById('bulkCreateInvoiceBtn');
            if (bulkCreateInvoiceBtn) {
                bulkCreateInvoiceBtn.addEventListener('click', async () => {
                    if (this.state.selectedIds.size === 0) return;

                    // 1. Seçilen Tahakkuk Objelerini Bul
                    const selectedAccruals = Array.from(this.state.selectedIds)
                        .map(id => this.dataManager.allAccruals.find(a => a.id === id))
                        .filter(Boolean);

                    // 2. KONTROL: Zaten Faturalandırılmış mı?
                    const alreadyInvoiced = selectedAccruals.some(acc => acc.invoiceId || acc.invoice_id);
                    if (alreadyInvoiced) {
                        showNotification('Hata: Seçilen tahakkuklardan bazıları zaten faturalandırılmış!', 'error');
                        return;
                    }

                    // 3. KONTROL: Müşteriler (Cari Hesaplar) Aynı mı?
                    const getPartyId = (acc) => acc.serviceInvoicePartyId || acc.service_invoice_party_id || acc.tpInvoicePartyId || acc.tp_invoice_party_id;
                    const firstPartyId = getPartyId(selectedAccruals[0]);
                    const hasDifferentParties = selectedAccruals.some(acc => getPartyId(acc) !== firstPartyId);
                    
                    if (hasDifferentParties) {
                        showNotification('Hata: Farklı müşterilere ait tahakkukları tek faturada birleştiremezsiniz. Lütfen aynı müşteriye ait işlemleri seçin.', 'error');
                        return;
                    }

                    // 4. KONTROL: Döviz Cinsleri Aynı mı? (Opsiyonel ama önerilir)
                    const getCurrency = (acc) => acc.currency || (acc.officialFee && acc.officialFee.currency) || 'TRY';
                    const firstCurrency = getCurrency(selectedAccruals[0]);
                    const hasDifferentCurrencies = selectedAccruals.some(acc => getCurrency(acc) !== firstCurrency);

                    if (hasDifferentCurrencies) {
                        showNotification('Hata: Farklı döviz cinslerindeki (TL, USD, EUR) tahakkukları tek faturada birleştiremezsiniz.', 'error');
                        return;
                    }

                    // ONAY
                    const msg = this.state.selectedIds.size > 1 
                        ? `${this.state.selectedIds.size} adet tahakkuk birleştirilerek KolayBi'de TEK BİR e-Fatura oluşturulacak. Onaylıyor musunuz?`
                        : `Bu tahakkuk için KolayBi'de e-Fatura oluşturulacak. Onaylıyor musunuz?`;

                    if (!confirm(msg)) return;

                    this.uiManager.toggleLoading(true);
                    try {
                        let response = await this.dataManager.createKolaybiInvoice(this.state.selectedIds);
                        
                        // 🔥 YENİ: Backend "Kararsız Kaldım, Kullanıcıya Sor" Derse
                        if (response.requireMergeDecision) {
                            this.uiManager.toggleLoading(false); // Bekleme ekranını kaldır ki popup görünsün
                            
                            const userChoice = await Swal.fire({
                                title: 'Farklı Döviz Kurları Tespit Edildi!',
                                html: `Seçtiğiniz tahakkuklarda <b>${response.currencies.join(' ve ')}</b> kalemleri karışık olarak bulunuyor.<br><br>Bu faturaları KolayBi'ye nasıl göndermek istersiniz?`,
                                icon: 'warning',
                                showCancelButton: true,
                                confirmButtonText: '<i class="fas fa-compress-arrows-alt"></i> Hepsini TRY Yap (TCMB Satış Kuru)',
                                cancelButtonText: '<i class="fas fa-layer-group"></i> Ayrı Döviz Faturaları Kes',
                                confirmButtonColor: '#3085d6',
                                cancelButtonColor: '#28a745',
                                width: '35em',
                                allowOutsideClick: false
                            });

                            if (userChoice.isConfirmed) {
                                // Kullanıcı TRY istedi
                                this.uiManager.toggleLoading(true);
                                response = await this.dataManager.createKolaybiInvoice(this.state.selectedIds, 'merge_try');
                            } else if (userChoice.dismiss === Swal.DismissReason.cancel) {
                                // Kullanıcı ayrı ayrı döviz faturası kesilsin istedi
                                this.uiManager.toggleLoading(true);
                                response = await this.dataManager.createKolaybiInvoice(this.state.selectedIds, 'separate');
                            } else {
                                // İptal'e basıldı
                                return;
                            }
                        }

                        // İşlem tamamsa ve başarılıysa
                        if (response.success) {
                            this.state.selectedIds.clear(); 
                            await this.loadData(); 
                            showNotification(response.message || `Başarılı! KolayBi Faturası oluşturuldu.`, 'success');
                        } else {
                            throw new Error(response.error || response.message || "Beklenmeyen bir hata oluştu.");
                        }

                    } catch (error) {
                        showNotification(`Hata: ${error.message}`, 'error');
                    } finally {
                        this.uiManager.toggleLoading(false);
                    }
                });
            }

            // 🔥 YENİ: ZIP OLUŞTURMA, İNDİRME VE MÜŞAVİRE MAİL GÖNDERME
            const bulkSendAdvisorBtn = document.getElementById('bulkSendAdvisorBtn');
            if (bulkSendAdvisorBtn) {
                bulkSendAdvisorBtn.addEventListener('click', async () => {
                    if (this.state.selectedIds.size === 0) return;

                    // 1. Seçilen tahakkukları filtrele (Belgesi olan Yurtdışı Ödemeleri)
                    const selectedAccruals = Array.from(this.state.selectedIds)
                        .map(id => this.dataManager.allAccruals.find(a => a.id === id))
                        .filter(a => a && a.isForeignTransaction && a.files && a.files.length > 0);

                    if (selectedAccruals.length === 0) {
                        showNotification('Seçilen ödemelerde ekli "Ödeme Belgesi/Dekont" bulunmamaktadır!', 'warning');
                        return;
                    }

                    if (!confirm(`${selectedAccruals.length} adet dekont ZIP olarak bilgisayarınıza indirilecek ve Mali Müşavire e-posta olarak gönderilecektir. Onaylıyor musunuz?`)) return;

                    this.uiManager.toggleLoading(true);
                    try {
                        const { supabase } = await import('../../supabase-config.js');

                        // 2. Kütüphaneleri Dinamik Yükle
                        const loadScript = (src) => new Promise((resolve, reject) => {
                            if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
                            const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = reject; document.head.appendChild(script);
                        });
                        
                        if (!window.JSZip) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
                        if (!window.saveAs) await loadScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js');

                        const zip = new window.JSZip();
                        let addedCount = 0;

                        // 3. Dosyaları Fetch ile Çek ve ZIP'e Ekle
                        for (const acc of selectedAccruals) {
                            const file = acc.files[acc.files.length - 1]; // Son eklenen belgeyi al
                            const url = file.url || file.content;
                            
                            try {
                                const response = await fetch(url);
                                const blob = await response.blob();
                                
                                const ext = file.name.split('.').pop() || 'pdf';
                                const safeName = (acc.serviceInvoiceParty?.name || 'Cari').replace(/[^a-zA-Z0-9]/g, '_');
                                const fileName = `Tahakkuk_${acc.id}_${safeName}.${ext}`;
                                
                                zip.file(fileName, blob);
                                addedCount++;
                            } catch (err) {
                                console.error(`Dosya indirilemedi (Tahakkuk: ${acc.id}):`, url);
                            }
                        }

                        if (addedCount === 0) throw new Error("Hiçbir dosya sunucudan çekilemedi.");

                        // 4. ZIP'i Oluştur
                        const zipContent = await zip.generateAsync({ type: 'blob' });
                        const zipFileName = `Yurtdisi_Odeme_Dekontlari_${new Date().toLocaleDateString('tr-TR').replace(/\./g, '_')}.zip`;
                        
                        // A) Bilgisayara İndir
                        window.saveAs(zipContent, zipFileName);

                        // B) Supabase Storage'a Yükle (Mail Linki İçin)
                        const storagePath = `advisor_exports/${Date.now()}_${zipFileName}`;
                        const { error: uploadError } = await supabase.storage.from('documents').upload(storagePath, zipContent, { contentType: 'application/zip' });
                        if (uploadError) throw uploadError;

                        const { data: publicUrlData } = supabase.storage.from('documents').getPublicUrl(storagePath);
                        const publicZipUrl = publicUrlData.publicUrl;

                        // 5. E-Postayı mail_notifications Tablosuna Yaz ve Edge Function ile ANINDA GÖNDER
                        const advisorEmail = 'uslumusavirlik@hotmail.com'; // TO (Müşavirin maili)
                        const ccEmails = ['belirguven@evrekagroup.com', 'kubilayguzel@evrekagroup.com', 'alikucuksahin@evrekagroup.com']; // CC (Bilgi verilecek mailler, virgülle çoğaltabilirsiniz)
                        
                        const mailHtml = `
                            <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                                <h3 style="color: #1e3c72;">Yurtdışı Ödemeleri Dekont Raporu</h3>
                                <p>Merhaba,</p>
                                <p>Ekteki bağlantıda şirketimizin yurtdışı ödemelerine ait <strong>${addedCount} adet</strong> dekont (alış faturası) bulunmaktadır.</p>
                                <p>Tüm dekontları tek bir paket (ZIP) halinde indirmek için aşağıdaki butona tıklayabilirsiniz:</p>
                                <br>
                                <a href="${publicZipUrl}" style="background-color:#17a2b8; color:white; padding:12px 20px; text-decoration:none; border-radius:6px; font-weight:bold;">Tüm Dekontları İndir (ZIP)</a>
                                <br><br>
                                <p>Söz konusu belgelerin <strong>muhasebe kayıtlarına işlenmesini</strong> ve bu e-postanın tarafınıza ulaştığına dair <strong>teyit dönüşü yapmanızı</strong> rica ederiz.</p>
                                <p>İyi çalışmalar.</p>
                            </div>
                        `;

                        // 🔥 ÇÖZÜM: Yeni ve benzersiz bir ID oluşturuluyor
                        const newNotificationId = crypto.randomUUID ? crypto.randomUUID() : 'mail-' + Math.random().toString(36).substr(2, 9);

                        // a) Kaydı mail_notifications tablosuna taslak OLMAYACAK şekilde ekle
                        const { data: newNotif, error: notifErr } = await supabase.from('mail_notifications').insert({
                            id: newNotificationId, // 🔥 ID veritabanına zorunlu olarak iletiliyor
                            to_list: [advisorEmail],
                            cc_list: ccEmails,
                            subject: 'Yeni Yurtdışı Ödeme Dekontları',
                            body: mailHtml,
                            status: 'pending',
                            is_draft: false, // Taslak değil, gönderime hazır
                            notification_type: 'advisor_export',
                            source: 'accruals'
                        }).select().single();

                        if (notifErr) throw notifErr;

                        // b) Kayıt başarılıysa, mail gönderme motorunu (Edge Function) otomatik tetikle
                        if (newNotif) {
                            try {
                                await supabase.functions.invoke('process-mail-notification', {
                                    body: { notificationId: newNotif.id, action: 'send' }
                                });
                                // Gönderim Edge Function'a iletildikten sonra statüyü manuel olarak 'sent' yapıyoruz
                                await supabase.from('mail_notifications')
                                    .update({ status: 'sent', sent_at: new Date().toISOString() })
                                    .eq('id', newNotif.id);
                            } catch (err) {
                                console.warn("Mail gönderim motoru (Edge Function) tetiklenemedi:", err);
                            }
                        }

                        // 6. DB Durumunu "Evet" (sent_to_advisor: true) Yap
                        await this.dataManager.markAsSentToAdvisor(selectedAccruals.map(a => a.id));

                        this.state.selectedIds.clear();
                        await this.loadData();
                        showNotification(`Başarılı! ${addedCount} belge ZIP yapıldı, indirildi ve mali müşavire mail olarak gönderildi.`, 'success');

                    } catch (error) {
                        console.error("Müşavir Rapor Hatası:", error);
                        showNotification(`İşlem sırasında hata: ${error.message}`, 'error');
                    } finally {
                        this.uiManager.toggleLoading(false);
                    }
                });
            }

            document.getElementById('saveAccrualChangesBtn').addEventListener('click', async () => {
                const formResult = this.uiManager.getEditFormData();
                if (!formResult.success) { showNotification(formResult.error, 'error'); return; }
                this.uiManager.toggleLoading(true);
                try {
                    await this.dataManager.updateAccrual(document.getElementById('editAccrualId').value, formResult.data, (formResult.data.files||[])[0]);
                    this.uiManager.closeModal('editAccrualModal');
                    await this.loadData(); // 🔥 YENİ: Veritabanından departman güncellemelerini de tazeleyerek çek
                    showNotification('Güncellendi', 'success');
                }
                catch (e) { showNotification(e.message, 'error'); } 
                finally { this.uiManager.toggleLoading(false); }
            });

            document.getElementById('confirmMarkPaidBtn').addEventListener('click', async () => {
                const date = document.getElementById('paymentDate').value;
                if(!date) { showNotification('Tarih seçiniz', 'error'); return; }

                let singleDetails = null;
                if (this.state.selectedIds.size === 1) {
                     if (this.state.activeTab === 'foreign') {
                        const isFull = document.getElementById('payFullForeign')?.checked;
                        
                        // 🔥 ÇÖZÜM: Alanlar dinamik oluştuğu için ekranda var olup olmadıklarına (null check) bakarak okuyoruz.
                        const offEl = document.getElementById('manualForeignOfficial');
                        const srvEl = document.getElementById('manualForeignService');
                        
                        singleDetails = { 
                            isForeignMode: true, 
                            payFullOfficial: isFull, 
                            payFullService: isFull, 
                            manualOfficial: offEl ? offEl.value : 0, 
                            manualService: srvEl ? srvEl.value : 0 
                        };
                     } else {
                        singleDetails = { isForeignMode: false, payFullOfficial: document.getElementById('payFullOfficial').checked, payFullService: document.getElementById('payFullService').checked, manualOfficial: document.getElementById('manualOfficialAmount').value, manualService: document.getElementById('manualServiceAmount').value };
                     }
                }

                this.uiManager.toggleLoading(true);
                try {
                    await this.dataManager.savePayment(this.state.selectedIds, { date, receiptFiles: this.uploadedPaymentReceipts, singlePaymentDetails: singleDetails, isForeignTab: this.state.activeTab === 'foreign' });
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
                        modalFreestyle.style.display = 'block'; // 🔥 ÇÖZÜM BURADA: Modalı görünür hale getiriyoruz!
                    } catch (error) { showNotification('Form yüklenirken hata oluştu.', 'error'); } 
                    finally { this.uiManager.toggleLoading(false); }
                });

                document.getElementById('cancelFreestyleAccrualBtn').addEventListener('click', () => { modalFreestyle.classList.remove('show'); modalFreestyle.style.display = 'none'; });
                document.getElementById('closeFreestyleAccrualModal').addEventListener('click', () => { modalFreestyle.classList.remove('show'); modalFreestyle.style.display = 'none'; });
                document.getElementById('saveFreestyleAccrualBtn').addEventListener('click', async () => {
                    const formResult = this.freestyleFormManager.getData();
                    if (!formResult.success) { showNotification(formResult.error, 'error'); return; }

                    this.uiManager.toggleLoading(true);
                    try {
                        const newAccrualData = formResult.data;
                        const structure = newAccrualData.structure || 'single';

                        if (structure === 'recursive') {
                            // --- TEKRARLAYAN TAHAKKUK KAYDETME ---
                            const period = newAccrualData.period;
                            const startDate = newAccrualData.startDate;
                            
                            if (!period || !startDate) {
                                showNotification('Lütfen periyot ve başlama tarihini seçin.', 'error');
                                this.uiManager.toggleLoading(false); return;
                            }

                            // Dinamik diziden ilk parayı alıyoruz
                            let finalAmount = 0, finalCurrency = 'TRY';
                            if (Array.isArray(newAccrualData.totalAmount) && newAccrualData.totalAmount.length > 0) {
                                finalAmount = newAccrualData.totalAmount[0].amount;
                                finalCurrency = newAccrualData.totalAmount[0].currency;
                            } else if (newAccrualData.officialFee?.amount > 0) {
                                finalAmount = newAccrualData.officialFee.amount;
                                finalCurrency = newAccrualData.officialFee.currency;
                            } else if (newAccrualData.serviceFee?.amount > 0) {
                                finalAmount = newAccrualData.serviceFee.amount;
                                finalCurrency = newAccrualData.serviceFee.currency;
                            }

                            // --- TEKRARLAYAN TAHAKKUK KAYDETME/GÜNCELLEME ---
                            const recursivePayload = {
                                personId: newAccrualData.tpInvoicePartyId || newAccrualData.serviceInvoicePartyId,
                                type: newAccrualData.type || 'Masraf',
                                department: newAccrualData.department || 'EVREKA', // 🔥 Bölümü kaydet
                                amount: finalAmount,
                                currency: finalCurrency,
                                period: period,
                                startDate: startDate,
                                description: newAccrualData.description,
                                items: newAccrualData.items // 🔥 Tam kalem detaylarını (KDV, miktar, net fiyat) kaydet
                            };

                            if (this.editingRecursiveId) {
                                await this.dataManager.updateRecursiveAccrual(this.editingRecursiveId, recursivePayload);
                                showNotification('Tekrarlayan Tahakkuk başarıyla güncellendi!', 'success');
                            } else {
                                await this.dataManager.createRecursiveAccrual(recursivePayload);
                                showNotification('Abonelik / Tekrarlayan Tahakkuk başarıyla oluşturuldu!', 'success');
                            }
                            
                            this.editingRecursiveId = null; // İşlem bitince ID'yi sıfırla
                            modalFreestyle.classList.remove('show');
                            modalFreestyle.style.display = 'none'; // 🔥 EKLENDİ
                            await this.loadRecursiveData();

                        } else {
                            // --- MEVCUT TEKİL TAHAKKUK KAYDETME ---
                            const fileToUpload = (newAccrualData.files || [])[0];
                            await this.dataManager.createFreestyleAccrual(newAccrualData, fileToUpload);
                            modalFreestyle.classList.remove('show');
                            modalFreestyle.style.display = 'none'; // 🔥 EKLENDİ
                            await this.loadData();
                            showNotification('Serbest tahakkuk başarıyla oluşturuldu!', 'success');
                        }
                    }
                    catch (e) { showNotification('Tahakkuk kaydedilemedi: ' + e.message, 'error'); } 
                    finally { this.uiManager.toggleLoading(false); }
                });
            } // <-- Bu parantez if (btnFreestyle && modalFreestyle) bloğunu kapatıyor

            // --- FATURA SENKRONİZE VE GÖRÜNTÜLEME EVENTLERİ ---
            document.addEventListener('invoice-sync-request', async (e) => {
                try {
                    this.uiManager.toggleLoading(true);
                    const res = await this.dataManager.syncKolaybiInvoice(e.detail.id);
                    
                    // 🔥 LOG İÇİN EKLENDİ: Kolaybiden dönen saf veriyi konsola bas
                    console.log("🚨 KOLAYBİ'DEN GELEN HAM VERİ (RAW):", res.raw_kolaybi_data);
                    console.log("🛠️ SİSTEMİN YAPTIĞI GÜNCELLEME (UPDATES):", res.data);
                    
                    showNotification("Senkronizasyon tamam. Lütfen F12 (Konsol) ekranına bakın!", "success");
                    await this.loadData(); 
                } catch (err) {
                    showNotification("Senkronizasyon Hatası: " + err.message, "error");
                } finally {
                    this.uiManager.toggleLoading(false);
                }
            });

            // --- FATURA GÖRÜNTÜLEME EVENTİ (GÜNCELLENDİ) ---
            document.addEventListener('invoice-view-request', async (e) => {
                const viewerWindow = window.open('', '_blank');
                viewerWindow.document.write("<div style='font-family:sans-serif; padding: 20px; text-align:center;'><h3>Fatura Hazırlanıyor...</h3><p>Lütfen bekleyiniz, belge oluşturuluyor.</p></div>");

                try {
                    this.uiManager.toggleLoading(true);
                    const res = await this.dataManager.viewKolaybiInvoice(e.detail.id);
                    
                    const payload = res.data; // Fonksiyondan dönen veri
                    
                    // 1. Durum: Doğrudan HTML gelmişse (E-Arşiv Görünümü)
                    if (typeof payload === 'string' && payload.toLowerCase().includes('<html')) {
                        viewerWindow.document.open();
                        viewerWindow.document.write(payload);
                        viewerWindow.document.close();
                    } 
                    // 2. Durum: Base64 PDF verisi gelmişse (data.src veya data.content içinde)
                    else if (payload && payload.data && (payload.data.src || payload.data.content)) {
                        const base64Data = payload.data.src || payload.data.content;
                        viewerWindow.document.open();
                        viewerWindow.document.write(`
                            <title>Fatura Görüntüle</title>
                            <body style="margin:0; padding:0; overflow:hidden;">
                                <iframe width="100%" height="100%" style="border:none;" 
                                    src="data:application/pdf;base64,${base64Data}">
                                </iframe>
                            </body>
                        `);
                        viewerWindow.document.close();
                    } 
                    // 3. Durum: Doğrudan bir URL gelmişse
                    else if (payload && payload.data && payload.data.url) {
                        viewerWindow.location.href = payload.data.url;
                    } 
                    // 4. Durum: Diğer (Hata Payı Bırakıyoruz)
                    else {
                        viewerWindow.document.open();
                        viewerWindow.document.write(`<div style="padding:20px;"><h3>Belge Formatı Tanınamadı</h3><pre>${JSON.stringify(payload)}</pre></div>`);
                        viewerWindow.document.close();
                    }
                } catch (err) {
                    viewerWindow.document.open();
                    viewerWindow.document.write(`<div style="font-family:sans-serif; color:red; padding:20px; text-align:center;"><h3>Hata:</h3><p>${err.message}</p></div>`);
                    viewerWindow.document.close();
                } finally {
                    this.uiManager.toggleLoading(false);
                }
            });

                // --- MANUEL TOPLU SENKRONİZASYON BUTONU ---
            const btnSyncAllInvoices = document.getElementById('btnSyncAllInvoices');
            if (btnSyncAllInvoices) {
                btnSyncAllInvoices.addEventListener('click', async () => {
                    try {
                        this.uiManager.toggleLoading(true);

                        // 🔥 GÜNCELLEME: Tüm nihai kelimeler (Kabul, Red, İptal) İngilizce ve Türkçe olarak eklendi
                        const finalKeywords = ['approved', 'rejected', 'cancelled', 'failed', 'accept', 'decline', 'kabul', 'red', 'iptal'];

                        const pendingIds = this.dataManager.allInvoices
                            .filter(inv => {
                                const kId = String(inv.kolaybiInvoiceId);
                                if (!inv.kolaybiInvoiceId || kId === 'undefined' || kId === 'null') return false;
                                
                                const s = (inv.status || '').toLowerCase().trim();
                                const ks = (inv.kolaybiStatus || '').toLowerCase().trim();
                                
                                // Eğer faturanın sistem VEYA kolaybi statüsünde bu kesin kelimeler geçiyorsa listeye ALMA!
                                const isFinal = finalKeywords.some(word => s.includes(word) || ks.includes(word));
                                if (isFinal) return false;

                                return true; // Diğer belirsiz durumları (sent, waiting vb.) sorgula
                            })
                            .map(inv => inv.id);
                        
                        if(pendingIds.length === 0) {
                            showNotification("Tüm faturalar güncel (Kabul/Red/İptal) durumda. Güncellenecek fatura bulunmuyor.", "warning");
                            return;
                        }
                        
                        await this.dataManager.syncBulkKolaybiInvoices(pendingIds);
                        await this.loadData(); 
                        showNotification(`${pendingIds.length} adet bekleyen faturanın durumu başarıyla güncellendi!`, "success");
                    } catch (err) {
                        showNotification("Toplu Senkronizasyon Hatası: " + err.message, "error");
                    } finally {
                        this.uiManager.toggleLoading(false);
                    }
                });
            }

            // --- ARKA PLAN AJANI (OTO-SYNC) ---
            // Sayfa yüklendikten 1 saniye sonra arkadan kontrol eder
            setTimeout(async () => {
                if (this.dataManager && typeof this.dataManager.autoSyncPendingInvoices === 'function') {
                    const hasUpdates = await this.dataManager.autoSyncPendingInvoices();
                    if (hasUpdates) {
                        await this.loadData(); 
                        console.log("[OTO-SYNC] Arka plan taraması tamamlandı, arayüz güncellendi.");
                    }
                }
            }, 1000);

            // YENİ: Tekrarlayan Tahakkuk Tablosu İşlem Butonları (Silme ve Düzenleme)
            if (this.uiManager.recursiveTableBody) {
                this.uiManager.recursiveTableBody.addEventListener('click', async (e) => {
                    const deleteBtn = e.target.closest('.delete-recursive-btn');
                    const editBtn = e.target.closest('.edit-recursive-btn');

                    if (deleteBtn) {
                        if (!confirm('Bu abonelik/tekrarlayan tahakkuk şablonunu silmek istediğinize emin misiniz?')) return;
                        this.uiManager.toggleLoading(true);
                        try {
                            const res = await this.dataManager.deleteRecursiveAccrual(deleteBtn.dataset.id);
                            if (res.success) {
                                showNotification('Şablon başarıyla silindi.', 'success');
                                await this.loadRecursiveData();
                            }
                        } catch(err) { showNotification('Hata: ' + err.message, 'error'); }
                        finally { this.uiManager.toggleLoading(false); }
                    }

                    if (editBtn) {
                        const id = editBtn.dataset.id;
                        this.editingRecursiveId = id;
                        
                        // İlgili kaydı bul ve formu doldur
                        const res = await this.dataManager.getRecursiveAccruals();
                        const record = res.data.find(r => r.id === id);
                        
                        if (record) {
                            const person = this.dataManager.allPersons.find(p => p.id === record.person_id);
                            
                            const formData = {
                                structure: 'recursive',
                                period: record.period,
                                startDate: record.start_date,
                                type: record.type,
                                department: record.department || 'EVREKA', // 🔥 DB'den bölümü al
                                description: record.description,
                                tpInvoiceParty: person,
                                // 🔥 Kalemleri doğrudan DB'den, kaydedildiği orjinal haliyle yüklüyoruz
                                items: record.items && record.items.length > 0 ? record.items : [{
                                    // Eğer eski (kalemsiz) bir kayıtsa hata vermemesi için varsayılan fallback
                                    fee_type: record.type,
                                    item_name: record.description || 'Abonelik Bedeli',
                                    quantity: 1,
                                    unit_price: record.amount,
                                    vat_rate: 20, 
                                    currency: record.currency
                                }]
                            };
                            
                            // 🔥 YENİ: Form ilk kez açılıyorsa Manager'i başlat
                            if (!this.freestyleFormManager) {
                                this.freestyleFormManager = new (await import('../components/AccrualFormManager.js')).AccrualFormManager(
                                    'freestyleAccrualFormContainer', 'freestyle', this.dataManager.allPersons, { isFreestyle: true }
                                );
                                this.freestyleFormManager.render();
                            } else {
                                this.freestyleFormManager.persons = this.dataManager.allPersons;
                            }

                            this.freestyleFormManager.setData(formData);
                            document.getElementById('freestyleAccrualModal').classList.add('show');
                            document.getElementById('freestyleAccrualModal').style.display = 'block';
                        }
                    }
                });
            }

            // Modal kapanırken düzenleme ID'sini sıfırla ve pencereyi gizle
            document.getElementById('closeFreestyleAccrualModal')?.addEventListener('click', () => { 
                this.editingRecursiveId = null; 
                const mod = document.getElementById('freestyleAccrualModal');
                if (mod) { mod.classList.remove('show'); mod.style.display = 'none'; }
            });
            document.getElementById('cancelFreestyleAccrualBtn')?.addEventListener('click', () => { 
                this.editingRecursiveId = null; 
                const mod = document.getElementById('freestyleAccrualModal');
                if (mod) { mod.classList.remove('show'); mod.style.display = 'none'; }
            });
            // YENİ: Modal içindeki Tekil/Tekrarlayan seçim dinleyicilerini başlat
            if (typeof this.uiManager.setupRecursiveFormListeners === 'function') {
                this.uiManager.setupRecursiveFormListeners();
            }

        } // <--- İŞTE BU PARANTEZ 'setupEventListeners' FONKSİYONUNUN GERÇEK KAPANIŞIDIR

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
    } // <--- Bu parantez 'AccrualsController' sınıfını kapatıyor

    new AccrualsController().init();
}); // <--- Bu parantez 'DOMContentLoaded' olayını kapatıyor