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

            // YENİ EKLENDİ: Otomatik Hesapla Butonu Dinleyicisi
            document.addEventListener('accrual-auto-calc-request', async (e) => {
                const { accrualData } = e.detail;
                
                if (!accrualData || (!accrualData.taskId || accrualData.taskId === 'null')) {
                    showNotification("Bu tahakkukun bağlı olduğu bir görev bulunamadı. Lütfen kalemleri manuel ekleyiniz.", "warning");
                    return;
                }

                this.uiManager.toggleLoading(true);
                try {
                    const { supabase } = await import('../../supabase-config.js');
                    
                    // 1. Önce bu tahakkukun doğrudan bağlı olduğu işi çekiyoruz
                    const { data: taskData, error: taskError } = await supabase
                        .from('tasks')
                        .select('task_type_id, details')
                        .eq('id', accrualData.taskId)
                        .single();

                    if (taskError || !taskData) throw new Error("Görev veritabanında bulunamadı.");

                    let targetTaskTypeId = taskData.task_type_id;

                    // 2. details içinde parent_task_id varsa, asıl işlemi bul
                    if (taskData.details) {
                        let parsedDetails = typeof taskData.details === 'string' ? JSON.parse(taskData.details) : taskData.details;
                        
                        if (parsedDetails.parent_task_id) {
                            const { data: parentTask, error: parentError } = await supabase
                                .from('tasks')
                                .select('task_type_id')
                                .eq('id', parsedDetails.parent_task_id)
                                .single();
                                
                            if (parentTask && !parentError) {
                                targetTaskTypeId = parentTask.task_type_id; 
                            }
                        }
                    }

                    // 3. İşlem tipini (transaction rule) bul
                    const rule = this.dataManager.allTransactionTypes.find(t => String(t.id) === String(targetTaskTypeId));

                    if (!rule || (!rule.official_fee && !rule.service_fee)) {
                        showNotification("Bu işlem tipi için tanımlanmış otomatik bir hesaplama kuralı bulunamadı.", "warning");
                        return;
                    }

                    // 4. Kural bulunduysa kalemleri oluştur
                    const items = [];
                    const isForeign = accrualData.isForeignTransaction; 

                    if (rule.official_fee > 0) {
                        items.push({ 
                            fee_type: isForeign ? 'Yurtdışı Maliyet' : 'TP Harç', 
                            item_name: 'Resmi Harç / Maliyet', 
                            quantity: 1, 
                            unit_price: rule.official_fee, 
                            vat_rate: 0, 
                            currency: rule.currency || 'TRY' 
                        });
                    }
                    
                    if (rule.service_fee > 0) {
                        items.push({ 
                            fee_type: 'Hizmet', 
                            item_name: 'Hizmet / Danışmanlık Bedeli', 
                            quantity: 1, 
                            unit_price: rule.service_fee, 
                            vat_rate: 20, 
                            currency: rule.currency || 'TRY' 
                        });
                    }

                    // 5. Oluşturulan kalemleri forma bas
                    if (this.uiManager.editFormManager) {
                        this.uiManager.editFormManager.setCalculatedItems(items);
                        showNotification("Kalemler asıl işleme göre otomatik hesaplandı.", "success");
                    }

                } catch (error) {
                    console.error("Otomatik hesaplama hatası:", error);
                    showNotification("Hesaplama yapılırken bir hata oluştu: " + error.message, "error");
                } finally {
                    this.uiManager.toggleLoading(false);
                }
            });

            $('a[data-toggle="tab"]').on('shown.bs.tab', (e) => {
                const targetHref = $(e.target).attr("href");
                if (targetHref === '#content-foreign') this.state.activeTab = 'foreign';
                else if (targetHref === '#content-invoices') this.state.activeTab = 'invoices';
                else this.state.activeTab = 'main';
                
                this.state.selectedIds.clear(); // Sekme değişince seçimleri temizlemek iyi bir pratiktir
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
                        await this.dataManager.batchUpdateStatus(this.state.selectedIds, 'unpaid');
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

                    if (!confirm(`${this.state.selectedIds.size} adet tahakkuk için KolayBi'de e-Fatura oluşturulacak. Onaylıyor musunuz?`)) {
                        return;
                    }

                    this.uiManager.toggleLoading(true);
                    try {
                        const result = await this.dataManager.createKolaybiInvoice(this.state.selectedIds);
                        
                        this.state.selectedIds.clear(); // Seçimleri temizle
                        this.renderPage(); // Tabloyu yenile
                        
                        showNotification(`Başarılı! KolayBi Faturası oluşturuldu.`, 'success');
                    } catch (error) {
                        showNotification(`Hata: ${error.message}`, 'error');
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