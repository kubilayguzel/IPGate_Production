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
        const bulletinSelector = document.getElementById('bulletinSelector');
        const runBtn = document.getElementById('btnRunCustomReport');
        const exportBtn = document.getElementById('btnExportCustomReportExcel');

        reportSelector.addEventListener('change', async (e) => {
            if (e.target.value) {
                bulletinSelector.disabled = false;
                if (this.bulletinList.length === 0) {
                    await this.loadBulletinList();
                }
            } else {
                bulletinSelector.disabled = true;
                runBtn.disabled = true;
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
            // Kullanıcıya atanan raporları çek
            const { data, error } = await supabase
                .from('client_report_configs')
                .select('id, name, report_type')
                // RLS kuralımız sayesinde bu sorgu sadece kullanıcının yetkili olduğu raporları getirecek.
                .order('created_at', { ascending: false });

            if (error) throw error;
            this.assignedReports = data || [];

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
        selector.innerHTML = '<option value="" disabled selected>Bültenler Yükleniyor...</option>';
        
        try {
            // Veritabanından unique (benzersiz) bülten numaralarını çekiyoruz
            // Not: Eğer tablonuz çok büyükse, bu sorgu yerine sadece son 50 bülteni de çekebiliriz.
            const { data, error } = await supabase
                .from('trademark_bulletin_records')
                .select('bulletin_id')
                .order('bulletin_id', { ascending: false })
                .limit(2000); // Tümü yerine güvenli limit

            if (error) throw error;

            // Benzersiz (distinct) bülten ID'lerini filtrele
            const uniqueBulletins = [...new Set(data.map(item => item.bulletin_id))].filter(Boolean);
            
            this.bulletinList = uniqueBulletins.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

            selector.innerHTML = '<option value="" disabled selected>İncelemek istediğiniz bülteni seçin...</option>';
            this.bulletinList.forEach(b => {
                selector.innerHTML += `<option value="${b}">${b}. Bülten</option>`;
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
            // Adım 1'de oluşturduğumuz PostgreSQL RPC (Stored Procedure) fonksiyonunu çağırıyoruz
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
        card.style.display = 'block';

        if (this.currentData.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">Bu bültende size ait bir kayıt bulunamadı.</td></tr>`;
            return;
        }

        this.currentData.forEach(record => {
            const imgHtml = record.image_url ? `<img src="${record.image_url}" style="max-height: 60px; object-fit: contain; border: 1px solid #eee; border-radius: 4px; padding: 2px;">` : '-';
            
            // JSON string'i (holders) ayrıştırıp düzgün bir müvekkil adı gösterelim
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

            const classes = Array.isArray(record.nice_classes) ? record.nice_classes.join(', ') : (record.nice_classes || '-');

            tbody.innerHTML += `
                <tr>
                    <td class="text-center">${imgHtml}</td>
                    <td class="font-weight-bold align-middle">${record.bulletin_id}</td>
                    <td class="align-middle">${record.application_number}</td>
                    <td class="font-weight-bold text-primary align-middle">${record.brand_name || 'İsimsiz Marka'}</td>
                    <td class="align-middle">${classes}</td>
                    <td class="align-middle"><small class="text-muted">${applicantDisplay}</small></td>
                </tr>
            `;
        });
    }

    exportToExcel() {
        if (this.currentData.length === 0) return alert('Dışa aktarılacak veri yok.');

        try {
            // Basit CSV/Excel indirme mantığı (Projedeki mevcut kütüphaneyi de kullanabilirsiniz)
            let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
            csvContent += "Bulten No;Basvuru No;Marka Adi;Siniflar;Muvekkil\n";

            this.currentData.forEach(row => {
                let applicantDisplay = '-';
                try {
                    if (row.holders) {
                        const holdersArray = typeof row.holders === 'string' ? JSON.parse(row.holders) : row.holders;
                        if (Array.isArray(holdersArray) && holdersArray.length > 0) {
                            applicantDisplay = holdersArray.map(h => h.holderName || h.clientNo).join(', ');
                        }
                    }
                } catch(e) {}
                
                const classes = Array.isArray(row.nice_classes) ? row.nice_classes.join(', ') : (row.nice_classes || '-');
                
                const rowData = [
                    row.bulletin_id,
                    row.application_number,
                    `"${(row.brand_name || '').replace(/"/g, '""')}"`,
                    `"${classes}"`,
                    `"${applicantDisplay.replace(/"/g, '""')}"`
                ];
                csvContent += rowData.join(";") + "\n";
            });

            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", `Bulten_Taramasi_${new Date().toISOString().slice(0,10)}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

        } catch (error) {
            console.error('Export hatası:', error);
            alert('Dışa aktarılırken bir hata oluştu.');
        }
    }
}