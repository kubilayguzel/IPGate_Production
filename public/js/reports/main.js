import { OppositionReport } from './OppositionReport.js';

class MainReportController {
    constructor() {
        this.currentStrategy = null;
        
        // SİSTEMDEKİ TÜM RAPORLAR BURAYA KAYIT EDİLİR
        this.reportStrategies = {
            'opposition_report': new OppositionReport()
        };

        this.init();
    }

    init() {
        // Dropdown değiştiğinde ilgili raporun UI'ını yükle
        document.getElementById('reportTypeSelector').addEventListener('change', (e) => {
            const reportKey = e.target.value;
            this.currentStrategy = this.reportStrategies[reportKey];
            
            if (this.currentStrategy) {
                document.getElementById('reportResultsCard').style.display = 'none';
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
        const btn = document.getElementById('btnGenerateReport');
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Üretiliyor...';
        
        try {
            await strategyInstance.fetchData();
            strategyInstance.renderTable('reportResultsCard', 'dynamicReportThead', 'dynamicReportTbody');
            document.getElementById('reportResultsCard').style.display = 'block';
        } catch (error) {
            console.error(error);
            alert("Hata: " + error.message);
        } finally {
            btn.innerHTML = '<i class="fas fa-play mr-2"></i> Raporu Üret';
        }
    }
}

// DÜZELTME: DOMContentLoaded event'ini kaldırdık. Modül yüklendiği an çalışacak.
window.MainReportController = new MainReportController();