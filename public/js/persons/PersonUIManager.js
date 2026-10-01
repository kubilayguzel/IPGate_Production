// public/js/persons/PersonUIManager.js
import { PersonDataManager } from './PersonDataManager.js';
import Pagination from '../pagination.js';

export class PersonUIManager {
    constructor() {
        this.dataManager = new PersonDataManager();
        this.allPersons = [];      
        this.filteredData = [];    

        this.sortColumn = 'name';
        this.sortDirection = 'asc';
        this.searchTerm = '';
        this.nationalityFilter = 'all';

        this.pagination = new Pagination({
            containerId: 'paginationContainer',
            itemsPerPage: 10,
            onPageChange: () => this.renderTable()
        });
    }

    async loadPersons() {
        const res = await this.dataManager.fetchPersons();
        if (res.success) {
            this.allPersons = res.data;
            this.filteredData = [...this.allPersons];

            if (this.pagination) {
                this.pagination.totalItems = this.allPersons.length;
                this.pagination.currentPage = 1;
            }

            this.applyFiltersAndSort();
        }
    }

    async deletePerson(id) {
        try {
            const tableBody = document.getElementById('personsTableBody');
            if(tableBody) tableBody.style.opacity = '0.5';

            const result = await this.dataManager.deletePerson(id);

            if (result.success) {
                await this.loadPersons();
                if(window.showNotification) window.showNotification('Kişi başarıyla silindi.', 'success');
            } else {
                alert("Silme işlemi başarısız: " + result.error);
            }
        } catch (error) {
            console.error("Silme hatası:", error);
            alert("Bir hata oluştu: " + error.message);
        } finally {
            const tableBody = document.getElementById('personsTableBody');
            if(tableBody) tableBody.style.opacity = '1';
        }
    }

    filterPersons(query) {
        this.searchTerm = String(query || '').toLocaleLowerCase('tr-TR').trim();
        this.pagination.currentPage = 1;
        this.applyFiltersAndSort();
    }

    filterNationality(value) {
        this.nationalityFilter = ['domestic', 'foreign'].includes(value) ? value : 'all';
        this.pagination.currentPage = 1;
        this.applyFiltersAndSort();
    }

    handleSort(column) {
        if (this.sortColumn === column) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortColumn = column;
            this.sortDirection = 'asc';
        }
        this.applyFiltersAndSort();
    }

    applyFiltersAndSort() {
        let sourceData = [...this.allPersons];

        if (this.searchTerm) {
            sourceData = sourceData.filter(p => {
                const nationalityText = p.nationalityType === 'foreign' ? 'yabancı yabanci foreign' : 'yerli domestic';
                return (p.name || '').toLocaleLowerCase('tr-TR').includes(this.searchTerm) ||
                    (p.email || '').toLocaleLowerCase('tr-TR').includes(this.searchTerm) ||
                    (p.tckn || p.taxNo || '').toLocaleLowerCase('tr-TR').includes(this.searchTerm) ||
                    (p.tpeNo || '').toLocaleLowerCase('tr-TR').includes(this.searchTerm) ||
                    (p.portfolioManagerName || 'Atanmadı').toLocaleLowerCase('tr-TR').includes(this.searchTerm) ||
                    nationalityText.includes(this.searchTerm);
            });
        }

        if (this.nationalityFilter !== 'all') {
            sourceData = sourceData.filter(p => (p.nationalityType || 'domestic') === this.nationalityFilter);
        }

        sourceData.sort((a, b) => {
            let valA = (a[this.sortColumn] || '').toString().toLocaleLowerCase('tr-TR');
            let valB = (b[this.sortColumn] || '').toString().toLocaleLowerCase('tr-TR');
            return valA.localeCompare(valB, 'tr-TR') * (this.sortDirection === 'asc' ? 1 : -1);
        });

        this.filteredData = sourceData;

        if (this.pagination) {
            this.pagination.update(this.filteredData.length);
        }

        this.renderTable();
    }


    sortPersonsForExport(persons) {
        return [...persons].sort((a, b) => {
            const valA = (a[this.sortColumn] || '').toString().toLocaleLowerCase('tr-TR');
            const valB = (b[this.sortColumn] || '').toString().toLocaleLowerCase('tr-TR');
            return valA.localeCompare(valB, 'tr-TR') * (this.sortDirection === 'asc' ? 1 : -1);
        });
    }

    loadExternalScript(src) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
                if (existing.dataset.loaded === 'true') {
                    resolve();
                    return;
                }
                existing.addEventListener('load', resolve, { once: true });
                existing.addEventListener('error', reject, { once: true });
                return;
            }

            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => {
                script.dataset.loaded = 'true';
                resolve();
            };
            script.onerror = () => reject(new Error(`Kütüphane yüklenemedi: ${src}`));
            document.head.appendChild(script);
        });
    }

    async exportToExcel() {
        const source = this.sortPersonsForExport(this.allPersons);

        if (!source.length) {
            if (window.showNotification) window.showNotification('Aktarılacak kişi kaydı bulunamadı.', 'warning');
            else alert('Aktarılacak kişi kaydı bulunamadı.');
            return;
        }

        const exportButton = document.getElementById('btnExportPersons');
        if (exportButton) {
            exportButton.disabled = true;
        }

        try {
            if (!window.ExcelJS) {
                await this.loadExternalScript('https://cdn.jsdelivr.net/npm/exceljs@4.3.0/dist/exceljs.min.js');
            }
            if (!window.saveAs) {
                await this.loadExternalScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js');
            }

            const workbook = new window.ExcelJS.Workbook();
            workbook.creator = 'IPGATE';
            workbook.created = new Date();

            const worksheet = workbook.addWorksheet('Kişiler', {
                views: [{ state: 'frozen', ySplit: 5, showGridLines: false }]
            });

            const columns = [
                { header: 'Sıra', key: 'rowNo', width: 8 },
                { header: 'Ad Soyad / Firma Adı', key: 'name', width: 38 },
                { header: 'Yerli / Yabancı', key: 'nationality', width: 16 },
                { header: 'Kimlik / VKN', key: 'identityNo', width: 19 },
                { header: 'TPE No', key: 'tpeNo', width: 16 },
                { header: 'E-posta', key: 'email', width: 32 },
                { header: 'Telefon', key: 'phone', width: 20 },
                { header: 'Adres', key: 'address', width: 46 },
                { header: 'İlçe', key: 'district', width: 20 },
                { header: 'İl', key: 'province', width: 20 },
                { header: 'Ülke', key: 'country', width: 22 },
                { header: 'Vergi Dairesi', key: 'taxOffice', width: 30 },
                { header: 'Portföy Yöneticisi', key: 'portfolioManager', width: 28 }
            ];

            worksheet.columns = columns;
            worksheet.spliceRows(1, 0, [], [], [], []);

            worksheet.mergeCells('A1:M2');
            const titleCell = worksheet.getCell('A1');
            titleCell.value = 'KİŞİ YÖNETİMİ - TÜM KİŞİLER';
            titleCell.font = { name: 'Montserrat', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
            titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
            titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

            worksheet.mergeCells('A3:M3');
            const subtitleCell = worksheet.getCell('A3');
            subtitleCell.value = `Oluşturulma Tarihi: ${new Date().toLocaleString('tr-TR')} | Kayıt Sayısı: ${source.length}`;
            subtitleCell.font = { name: 'Montserrat', size: 9, italic: true, color: { argb: 'FF64748B' } };
            subtitleCell.alignment = { vertical: 'middle', horizontal: 'right' };

            const headerRow = worksheet.getRow(5);
            columns.forEach((column, index) => {
                const cell = headerRow.getCell(index + 1);
                cell.value = column.header;
                cell.font = { name: 'Montserrat', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
                cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
                cell.border = {
                    bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } }
                };
            });
            headerRow.height = 28;

            source.forEach((person, index) => {
                const row = worksheet.addRow({
                    rowNo: index + 1,
                    name: person.name || '-',
                    nationality: person.nationalityType === 'foreign' ? 'Yabancı' : 'Yerli',
                    identityNo: person.tckn || person.taxNo || '-',
                    tpeNo: person.tpeNo || '-',
                    email: person.email || '-',
                    phone: person.phone || '-',
                    address: person.address || '-',
                    district: person.district || '-',
                    province: person.province || '-',
                    country: person.countryName || person.countryCode || '-',
                    taxOffice: person.taxOffice || '-',
                    portfolioManager: person.portfolioManagerName || 'Atanmadı'
                });

                row.height = 24;
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    cell.font = { name: 'Montserrat', size: 10 };
                    cell.alignment = {
                        vertical: 'middle',
                        horizontal: [1, 3, 4, 5].includes(colNumber) ? 'center' : 'left',
                        wrapText: true
                    };
                    cell.border = {
                        bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } }
                    };
                    if (index % 2 === 1) {
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
                    }
                });
            });

            worksheet.autoFilter = {
                from: { row: 5, column: 1 },
                to: { row: 5, column: columns.length }
            };

            worksheet.getColumn(1).alignment = { horizontal: 'center' };
            worksheet.getColumn(3).alignment = { horizontal: 'center' };
            worksheet.getColumn(4).alignment = { horizontal: 'center' };
            worksheet.getColumn(5).alignment = { horizontal: 'center' };

            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            });

            const datePart = new Date().toLocaleDateString('tr-TR').replace(/\./g, '_');
            window.saveAs(blob, `Kisi_Yonetimi_${datePart}.xlsx`);

            if (window.showNotification) {
                window.showNotification(`${source.length} kişi Excel dosyasına aktarıldı.`, 'success');
            }
        } catch (error) {
            console.error('Kişi Excel export hatası:', error);
            if (window.showNotification) window.showNotification('Excel oluşturulurken bir hata oluştu.', 'error');
            else alert('Excel oluşturulurken bir hata oluştu: ' + error.message);
        } finally {
            if (exportButton) {
                exportButton.disabled = false;
            }
        }
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    initializePersonInfoTooltips(tableBody) {
        if (!window.jQuery || !window.jQuery.fn?.tooltip) return;

        window.jQuery(tableBody)
            .find('[data-person-info-tooltip="true"]')
            .tooltip({
                container: 'body',
                html: false,
                boundary: 'window',
                trigger: 'hover focus',
                placement: 'top'
            });
    }

    buildPersonInfoTooltip(person) {
        const lines = [];
        const addressParts = [
            person.address,
            person.district,
            person.province,
            person.countryName || person.countryCode
        ]
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .filter((value, index, values) =>
                values.findIndex(item => item.toLocaleLowerCase('tr-TR') === value.toLocaleLowerCase('tr-TR')) === index
            );

        lines.push(`Adres: ${addressParts.length ? addressParts.join(' / ') : 'Kayıtlı adres bilgisi yok'}`);
        lines.push(`Vergi Dairesi: ${person.taxOffice || 'Kayıtlı vergi dairesi bilgisi yok'}`);

        return lines.join('\n');
    }

    renderTable() {
        const tableBody = document.getElementById('personsTableBody');
        if (!tableBody) return;

        // Yeniden render öncesinde varsa eski Bootstrap tooltip instance'larını temizle.
        if (window.jQuery && window.jQuery.fn?.tooltip) {
            window.jQuery(tableBody)
                .find('[data-person-info-tooltip="true"]')
                .tooltip('dispose');
        }

        tableBody.innerHTML = '';
        const paginatedData = this.pagination.getCurrentPageData(this.filteredData);

        if (paginatedData.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-muted">Kayıt bulunamadı.</td></tr>';
            return;
        }

        const startIndex = this.pagination.getStartIndex();

        paginatedData.forEach((p, index) => {
            const managerName = p.portfolioManagerName || 'Atanmadı';
            const managerEmail = p.portfolioManagerEmail || null;

            const safeName = this.escapeHtml(p.name || '-');
            const personInfoTooltip = this.buildPersonInfoTooltip(p);
            const safePersonInfoTooltip = this.escapeHtml(personInfoTooltip).replace(/\n/g, '&#10;');

            const row = `
                <tr>
                    <td class="text-muted small">${startIndex + index + 1}</td>
                    <td>
                        <span
                            class="font-weight-bold text-dark person-name-with-info"
                            tabindex="0"
                            data-person-info-tooltip="true"
                            data-toggle="tooltip"
                            data-placement="top"
                            title="${safePersonInfoTooltip}"
                        >${safeName}</span>
                    </td>
                    <td>
                        <span class="nationality-badge ${(p.nationalityType || 'domestic') === 'foreign' ? 'nationality-foreign' : 'nationality-domestic'}">
                            ${(p.nationalityType || 'domestic') === 'foreign' ? 'Yabancı' : 'Yerli'}
                        </span>
                    </td>
                    <td>${p.tckn || p.taxNo || '<span class="text-light">-</span>'}</td>
                    <td>${p.tpeNo || '<span class="text-light">-</span>'}</td>
                    <td class="small">${p.email || '-'}</td>
                    <td>
                        <span class="${p.portfolioManagerUserId ? 'font-weight-bold text-dark' : 'text-muted'}">${managerName}</span>
                        ${managerEmail ? `<div class="small text-muted">${managerEmail}</div>` : ''}
                    </td>
                    <td class="text-right">
                        <button class="action-btn edit-btn btn-sm mr-1" data-id="${p.id}" title="Düzenle">
                            <i class="fas fa-edit edit-btn" data-id="${p.id}"></i>
                        </button>
                        <button class="action-btn delete-btn btn-sm" data-id="${p.id}" title="Sil">
                            <i class="fas fa-trash-alt delete-btn" data-id="${p.id}"></i>
                        </button>
                    </td>
                </tr>`;
            tableBody.insertAdjacentHTML('beforeend', row);
        });

        // Bootstrap tooltip'i render tamamlandıktan sonra başlat.
        // Böylece browser'ın ham title kutusu yerine temiz, çok satırlı tooltip gösterilir.
        this.initializePersonInfoTooltips(tableBody);
    }
}