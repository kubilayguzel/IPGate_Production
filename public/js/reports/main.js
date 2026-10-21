import { OppositionReport } from './OppositionReport.js';
import { ClientTasksReport } from './ClientTasksReport.js';
// YENİ EKLENEN IMPORT:
import { ClientReportAdminManager } from './ClientReportAdminManager.js';

class MainReportController {
    constructor() {
        this.currentStrategy = null;
        this._generationId = 0;
        
        // SİSTEMDEKİ TÜM RAPORLAR BURAYA KAYIT EDİLİR
        this.reportStrategies = {
            'opposition_report': new OppositionReport(),
            'client_tasks_report': new ClientTasksReport()
        };

        this.init();
        
        // YENİ EKLENEN: Müvekkil Özel Rapor Yöneticisini Başlat
        this.clientReportAdminManager = new ClientReportAdminManager();
    }

    init() {
        // Dropdown değiştiğinde ilgili raporun UI'ını yükle
        document.getElementById('reportTypeSelector').addEventListener('change', (e) => {
            this._generationId += 1; // Eski raporun geç gelen sonucunu iptal et
            const reportKey = e.target.value;
            this.currentStrategy = this.reportStrategies[reportKey];
            
            if (this.currentStrategy) {
                document.getElementById('reportResultsCard').style.display = 'none';
                document.getElementById('clientTasksPager')?.remove();
                document.getElementById('oppReportTabs')?.remove();
                document.getElementById('dynamicFilterArea').style.display = 'flex';
                this.currentStrategy.renderFilters('dynamicFilterArea');
            }
        });

        // Çıktı Butonları
        document.getElementById('btnExportExcel').addEventListener('click', () => {
            if (this.currentStrategy) this.currentStrategy.exportExcel();
        });
        document.getElementById('btnExportPDF').addEventListener('click', () => {
            if (this.currentStrategy) this.currentStrategy.exportPDF();
        });
    }

    // Seçili stratejideki "Üret" butonuna basıldığında tetiklenir
    async executeReport(strategyInstance) {
        const generationId = ++this._generationId;
        const btn = document.getElementById('btnGenerateReport');
        if(!btn) return; // Buton yoksa hata vermesin
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Üretiliyor...';
        
        try {
            await strategyInstance.fetchData();
            if (generationId !== this._generationId || this.currentStrategy !== strategyInstance) return;
            strategyInstance.renderTable('reportResultsCard', 'dynamicReportThead', 'dynamicReportTbody');
            document.getElementById('reportResultsCard').style.display = 'block';
        } catch (error) {
            console.error(error);
            if (generationId === this._generationId && this.currentStrategy === strategyInstance) alert("Hata: " + error.message);
        } finally {
            if (generationId === this._generationId && this.currentStrategy === strategyInstance) {
              btn.disabled = false;
              btn.innerHTML = strategyInstance instanceof ClientTasksReport ? 'Üret' : '<i class="fas fa-play mr-2"></i> Raporu Üret';
            }
        }
    }
}

window.MainReportController = new MainReportController();