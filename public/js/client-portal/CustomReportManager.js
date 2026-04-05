// public/js/client-portal/CustomReportManager.js
import { supabase } from '../../supabase-config.js';

export class CustomReportManager {
    constructor(authManager) {
        this.authManager = authManager;
        this.assignedReports = [];
        this.bulletinList = [];
        this.currentData = [];
    }

    async init() {
        this.bindEvents();
        await this.loadAssignedReports();
    }

    bindEvents() {
        const reportSelector = document.getElementById('customReportSelector');
        const bulletinContainer = document.getElementById('dynamicBulletinContainer');
        const bulletinSelector = document.getElementById('bulletinSelector');
        const runBtn = document.getElementById('btnRunCustomReport');
        const exportBtn = document.getElementById('btnExportCustomReportExcel');

        reportSelector.addEventListener('change', async (e) => {
            const selectedReportId = e.target.value;
            const selectedReport = this.assignedReports.find(r => r.id === selectedReportId);
            
            // Eğer seçilen raporun tipi bülten sorgusu ise, bülten dropdown'ını ekranda göster
            if (selectedReport && selectedReport.report_type === 'bulletin_search') {
                $(bulletinContainer).slideDown(200);
                
                if (this.bulletinList.length === 0) {
                    await this.loadBulletinList();
                }
                runBtn.disabled = !bulletinSelector.value;
            } else {
                // Başka bir rapor türü seçildiyse bülten alanını gizle
                $(bulletinContainer).slideUp(200);
                bulletinSelector.value = "";
                runBtn.disabled = false;
            }
        });

        bulletinSelector.addEventListener('change', (e) => {
            runBtn.disabled = !e.target.value;
        });

        runBtn.addEventListener('click', () => this.runReport());
        
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportToExcel());
        }
    }

    async loadAssignedReports() {
        const selector = document.getElementById('customReportSelector');
        try {
            const { data, error } = await supabase
                .from('client_report_assignments')
                .select(`
                    user_id,
                    report_id,
                    client_report_configs (
                        id,
                        name,
                        report_type
                    )
                `);

            if (error) throw error;

            this.assignedReports = (data || [])
                .map(item => item.client_report_configs)
                .filter(report => report !== null);

            selector.innerHTML = '<option value="" disabled selected>Bir rapor seçiniz...</option>';
            
            if (this.assignedReports.length === 0) {
                selector.innerHTML = '<option value="" disabled selected>Size atanmış özel rapor bulunmuyor.</option>';
                return;
            }

            this.assignedReports.forEach(report => {
                selector.innerHTML += `<option value="${report.id}">${report.name}</option>`;
            });

        } catch (error) {
            console.error('Raporlar yüklenemedi:', error);
            selector.innerHTML = '<option value="" disabled selected>Raporlar yüklenirken hata oluştu!</option>';
        }
    }

    async loadBulletinList() {
        const selector = document.getElementById('bulletinSelector');
        selector.innerHTML = '<option value="" disabled selected>Bültenler yükleniyor...</option>';
        
        try {
            const { data, error } = await supabase
                .from('trademark_bulletins')
                .select('bulletin_no, bulletin_date')
                .order('bulletin_no', { ascending: false });

            if (error) throw error;

            // 1. FİLTRELEME: Bülten numarası 486 ve büyük olanları al
            this.bulletinList = (data || []).filter(b => {
                const no = parseInt(b.bulletin_no, 10);
                return !isNaN(no) && no >= 486;
            });

            selector.innerHTML = '<option value="" disabled selected>Bir bülten seçiniz...</option>';
            
            this.bulletinList.forEach(b => {
                let dateDisplay = "";
                
                // 2. TARİH FORMATLAMA: YYYY-MM-DD -> DD.MM.YYYY
                if (b.bulletin_date) {
                    try {
                        const datePart = b.bulletin_date.split('T')[0];
                        const parts = datePart.split('-');
                        if (parts.length === 3) {
                            dateDisplay = `${parts[2]}.${parts[1]}.${parts[0]}`;
                        } else {
                            dateDisplay = b.bulletin_date;
                        }
                    } catch (e) {
                        dateDisplay = b.bulletin_date;
                    }
                }
                
                const optionText = dateDisplay ? `${b.bulletin_no} - ${dateDisplay}` : b.bulletin_no;
                selector.innerHTML += `<option value="${b.bulletin_no}">${optionText}</option>`;
            });

        } catch (error) {
            console.error('Bülten listesi yüklenemedi:', error);
            selector.innerHTML = '<option value="" disabled selected>Bültenler yüklenemedi!</option>';
        }
    }

    async runReport() {
        const reportId = document.getElementById('customReportSelector').value;
        const bulletinId = document.getElementById('bulletinSelector').value;
        const btn = document.getElementById('btnRunCustomReport');

        if (!reportId || !bulletinId) return;

        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Taranıyor...';
        btn.disabled = true;
        document.getElementById('customReportResultsCard').style.display = 'none';

        try {
            const { data, error } = await supabase.rpc('get_client_bulletin_report', {
                p_report_id: reportId,
                p_bulletin_id: bulletinId
            });

            if (error) throw error;

            this.currentData = data || [];
            this.renderTable();

        } catch (error) {
            console.error('Rapor sorgu hatası:', error);
            alert('Rapor oluşturulurken bir hata oluştu: ' + error.message);
        } finally {
            btn.innerHTML = '<i class="fas fa-play mr-2"></i> Raporla';
            btn.disabled = false;
        }
    }

    renderTable() {
        const tbody = document.getElementById('customReportTableBody');
        const card = document.getElementById('customReportResultsCard');
        
        tbody.innerHTML = '';
        $(card).slideDown(300);

        if (this.currentData.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4"><i class="fas fa-info-circle mr-2"></i> Bu kriterlere uygun kayıt bulunamadı.</td></tr>`;
            return;
        }

        this.currentData.forEach(record => {
            const imgHtml = record.image_url 
                ? `<img src="${record.image_url}" class="shadow-sm" style="max-height: 135px; max-width: 160px; object-fit: contain; border-radius: 4px; border: 1px solid #eaeaea;">` 
                : '<span class="text-muted small">Yok</span>';
            
            let applicantDisplay = '-';
            try {
                if (record.holders) {
                    const holdersArray = typeof record.holders === 'string' ? JSON.parse(record.holders) : record.holders;
                    if (Array.isArray(holdersArray) && holdersArray.length > 0) {
                        applicantDisplay = holdersArray.map(h => h.holderName || h.clientNo).join(', ');
                    }
                }
            } catch(e) {
                applicantDisplay = 'Bilinmiyor';
            }

            let appDateDisplay = '-';
            if (record.application_date) {
                const d = new Date(record.application_date);
                appDateDisplay = isNaN(d) ? record.application_date : d.toLocaleDateString('tr-TR');
            }

            tbody.innerHTML += `
                <tr>
                    <td class="text-center align-middle">${imgHtml}</td>
                    <td class="align-middle text-dark font-weight-bold">${record.application_number || '-'}</td>
                    <td class="align-middle font-weight-bold text-primary">${record.brand_name || 'İsimsiz Marka'}</td>
                    <td class="align-middle text-dark" style="max-width: 250px;"><div class="text-truncate" title="${applicantDisplay}">${applicantDisplay}</div></td>
                    <td class="align-middle text-dark">${appDateDisplay}</td>
                </tr>
            `;
        });
    }

    async exportToExcel() {
        if (this.currentData.length === 0) return alert('Dışa aktarılacak veri yok.');

        const btn = document.getElementById('btnExportCustomReportExcel');
        const originalBtnHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Rapor Hazırlanıyor...';
        btn.disabled = true;

        try {
            // ExcelJS ve FileSaver Kütüphanelerini Yükle (Eğer yoksa)
            const loadScript = (src) => new Promise((resolve, reject) => {
                if (document.querySelector(`script[src="${src}"]`)) return resolve();
                const s = document.createElement('script');
                s.src = src; s.onload = resolve; s.onerror = reject;
                document.head.appendChild(s);
            });
            
            if (!window.ExcelJS) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js');
            if (!window.saveAs) await loadScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js');

            const workbook = new window.ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Bülten Tarama Sonuçları', { views: [{ showGridLines: false }] });

            // Kolon Ayarları
            const columns = [
                { header: 'No', key: 'index', width: 8 },
                { header: 'Görsel', key: 'image', width: 22 },
                { header: 'Başvuru No', key: 'appNo', width: 18 },
                { header: 'Marka Adı', key: 'brand', width: 35 },
                { header: 'Sahip Unvanı', key: 'applicant', width: 45 },
                { header: 'Başvuru Tarihi', key: 'appDate', width: 18 }
            ];
            worksheet.columns = columns;

            // 1. Ana Başlık Alanı
            worksheet.spliceRows(1, 0, [], []);
            worksheet.mergeCells('A1:F2');
            const titleCell = worksheet.getCell('A1');
            titleCell.value = 'MÜVEKKİL ÖZEL BÜLTEN TARAMA RAPORU';
            titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF1E3C72' } }; // Kurumsal Lacivert
            titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

            // 2. Alt Bilgi Alanı (Bülten No ve Tarih)
            const selectedBulletin = document.getElementById('bulletinSelector').options[document.getElementById('bulletinSelector').selectedIndex].text;
            worksheet.mergeCells('A3:C3');
            worksheet.getCell('A3').value = `Taranan Bülten: ${selectedBulletin}`;
            worksheet.getCell('A3').font = { bold: true, size: 11, color: { argb: 'FF333333' } };
            
            worksheet.mergeCells('D3:F3');
            worksheet.getCell('D3').value = `Oluşturulma Tarihi: ${new Date().toLocaleDateString('tr-TR')}`;
            worksheet.getCell('D3').font = { italic: true, size: 10, color: { argb: 'FF555555' } };
            worksheet.getCell('D3').alignment = { horizontal: 'right' };

            // 3. Tablo Başlıkları Stili
            const headerRow = worksheet.getRow(5);
            headerRow.height = 30;
            headerRow.eachCell({ includeEmpty: true }, (cell) => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C72' } };
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
                cell.border = { top: { style: 'medium', color: { argb: 'FF1E3C72' } }, bottom: { style: 'medium', color: { argb: 'FF1E3C72' } } };
            });

            // 4. Verileri Doldurma ve Resimleri Ekleme
            for (let i = 0; i < this.currentData.length; i++) {
                const rowData = this.currentData[i];
                
                // Sahip Formatı
                let applicantDisplay = '-';
                try {
                    if (rowData.holders) {
                        const holdersArray = typeof rowData.holders === 'string' ? JSON.parse(rowData.holders) : rowData.holders;
                        if (Array.isArray(holdersArray) && holdersArray.length > 0) applicantDisplay = holdersArray.map(h => h.holderName || h.clientNo).join(', ');
                    }
                } catch(e) {}
                
                // Tarih Formatı
                let appDateDisplay = '-';
                if (rowData.application_date) {
                    const d = new Date(rowData.application_date);
                    appDateDisplay = isNaN(d) ? rowData.application_date : d.toLocaleDateString('tr-TR');
                }

                // Satırı Ekle
                const row = worksheet.addRow({
                    index: i + 1,
                    image: '', // Resim ayrıca eklenecek
                    appNo: rowData.application_number || '-',
                    brand: rowData.brand_name || '-',
                    applicant: applicantDisplay,
                    appDate: appDateDisplay
                });
                
                row.height = 100; // Resimlerin sığması için yüksek satır

                // Satır Stilleri ve Ortalamalar
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    cell.border = { bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } } };
                    cell.alignment = { vertical: 'middle', horizontal: colNumber === 4 || colNumber === 5 ? 'left' : 'center', wrapText: true };
                });

                // Görseli Excel'e Gömme İşlemi
                if (rowData.image_url) {
                    try {
                        const response = await fetch(rowData.image_url, { cache: 'force-cache' });
                        if (response.ok) {
                            const buffer = await response.arrayBuffer();
                            let ext = rowData.image_url.toLowerCase().includes('.png') ? 'png' : 'jpeg';
                            const imageId = workbook.addImage({ buffer: buffer, extension: ext });
                            
                            // Resmin Pozisyonu (0 tabanlı dizin. Kolon 1 = B Sütunu, Satır i+5 = Veri satırı)
                            worksheet.addImage(imageId, {
                                tl: { col: 1, row: i + 5 }, 
                                br: { col: 2, row: i + 6 },
                                editAs: 'oneCell'
                            });
                        }
                    } catch(e) {
                        console.error("Resim yüklenemedi", e);
                    }
                }
            }

            // Dosyayı İndir
            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            
            // Seçili Raporun Adını Dosya Adı Yapalım
            const reportName = document.getElementById('customReportSelector').options[document.getElementById('customReportSelector').selectedIndex].text;
            const cleanName = reportName.replace(/[^a-z0-9]/gi, '_');
            
            window.saveAs(blob, `${cleanName}_${new Date().toISOString().slice(0,10)}.xlsx`);

        } catch (error) {
            console.error('Export hatası:', error);
            alert('Dışa aktarılırken bir hata oluştu: ' + error.message);
        } finally {
            btn.innerHTML = originalBtnHtml;
            btn.disabled = false;
        }
    }
}