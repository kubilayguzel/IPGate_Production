// public/js/indexing/epats-ui-manager.js

import { PersonDataManager } from '../persons/PersonDataManager.js';
import { PortfolioDataManager } from '../portfolio/PortfolioDataManager.js';
// Supabase ve ipRecordsService import edildi
import { ipRecordsService, supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';
import Pagination from '../pagination.js';

export class EpatsUiManager {
    constructor() {
        this.personData = new PersonDataManager();
        this.portfolioData = new PortfolioDataManager();
        this.filteredRecords = [];
        this.selectedRecordIds = new Set();
        this.pagination = null;
        
        // Desteklenen Eklenti ID'leri (Hangi eklenti yüklüyse o çalışır)
        this.extensionIds = [
            "eofiokhjckpokhljndldiicngcmpcpda", // 1. ID (Mevcut)
            "hffjgcfcelfemkmgocpjjphfmjlhpdnb"  // 2. ID (Yeni)
        ];

        this.init();
    }

    async init() {
        console.log('EpatsUiManager başlatılıyor (Supabase Uyumlu)...');
        await this.loadClients();
        this.setupEventListeners();
    }

    setupEventListeners() {
        const fetchBtn = document.getElementById('btnFetchMissingDocs');
        if (fetchBtn) fetchBtn.addEventListener('click', () => this.findMissingDocuments());

        const startBtn = document.getElementById('btnStartEpatsTransfer');
        if (startBtn) startBtn.addEventListener('click', () => this.startTransfer());

        const selectAll = document.getElementById('selectAllEpats');
        if (selectAll) selectAll.addEventListener('change', (e) => this.toggleSelectAll(e.target.checked));
    }

    async loadClients() {
        const select = document.getElementById('epatsClientSelect');
        if (!select) return;

        try {
            const response = await this.personData.fetchPersons();
            if (response.success && Array.isArray(response.data)) {
                const clients = response.data.sort((a, b) => a.name.localeCompare(b.name));
                select.innerHTML = '<option value="">Müvekkil Seçiniz...</option>' + 
                    clients.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
            }
        } catch (error) {
            console.error('Müvekkil listesi hatası:', error);
            showNotification('Müvekkil listesi yüklenemedi.', 'error');
        }
    }

    async findMissingDocuments() {
        const clientId = document.getElementById('epatsClientSelect').value;
        const ipType = document.getElementById('epatsIpTypeSelect').value;
        const docType = document.getElementById('epatsDocTypeSelect').value; 

        if (!clientId) {
            showNotification('Lütfen bir müvekkil seçiniz.', 'warning');
            return;
        }

        const btn = document.getElementById('btnFetchMissingDocs');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Taranıyor...';

        console.log(`\n--- [EPATS TARAMA BAŞLADI] ---`);
        console.log(`🔎 Kriterler -> Müvekkil: ${clientId} | Varlık: ${ipType} | Evrak: ${docType}`);

        try {
            await this.portfolioData.loadInitialData();
            let allRecs = this.portfolioData.allRecords;
            
            if (!allRecs || allRecs.length === 0) {
                const { data: viewData, error: viewErr } = await supabase.from('portfolio_list_view').select('*');
                if (!viewErr && viewData) {
                    allRecs = viewData;
                }
            }

            // Aday Kayıtları Süzme İşlemi
            const candidates = allRecs.filter(r => {
                let isClientMatch = false;
                
                // 🔥 ÇÖZÜM: View'daki GERÇEK sütun adı "applicants_json" kullanıldı.
                let apps = r.applicants_json || r.applicants;
                
                if (typeof apps === 'string') {
                    try { apps = JSON.parse(apps); } catch(e) { apps = []; }
                }
                
                if (apps && Array.isArray(apps)) {
                    isClientMatch = apps.some(app => String(app.id) === String(clientId) || String(app.person_id) === String(clientId));
                } else if (r.ip_record_applicants && Array.isArray(r.ip_record_applicants)) {
                    isClientMatch = r.ip_record_applicants.some(app => String(app.person_id) === String(clientId));
                }
                
                if (!isClientMatch && String(r.client_id) === String(clientId)) {
                    isClientMatch = true;
                }
                
                // 2. Tip Eşleştirme (trademark, patent, vs.)
                const rType = String(r.ip_type || r.type || '').toLowerCase().trim();
                const expectedType = String(ipType).toLowerCase().trim();
                const isTypeMatch = (rType === expectedType) || 
                                    (expectedType === 'trademark' && rType === 'marka') || 
                                    (expectedType === 'patent' && rType === 'patent') ||
                                    (expectedType === 'design' && (rType === 'tasarım' || rType === 'tasarim'));
                
                // 3. Statü Eşleştirme (registered, tescilli vb.)
                const rStatus = String(r.status || r.portfolio_status || '').toLowerCase().trim();
                const isRegistered = ['registered', 'tescilli'].includes(rStatus);

                // 🔥 ÇÖZÜM: Menşe (Origin) Eşleştirme - Sadece TÜRKPATENT olanları filtrele
                const rOrigin = String(r.origin || '').toUpperCase().trim();
                // Veritabanında boşluklu veya Türkçe karaktersiz yazılma ihtimaline karşı esnek kontrol:
                const isOriginMatch = rOrigin.includes('TÜRKPATENT') || rOrigin.includes('TURKPATENT') || rOrigin.includes('TÜRK PATENT');

                return isClientMatch && isTypeMatch && isRegistered && isOriginMatch;
            });

            console.log(`✅ [EPATS] Kriterleri sağlayan aday kayıt sayısı: ${candidates.length}`);

            const missingDocs = [];
            const chunkSize = 10;
            
            for (let i = 0; i < candidates.length; i += chunkSize) {
                const chunk = candidates.slice(i, i + chunkSize);
                const results = await Promise.all(chunk.map(async (record) => {
                    
                    let txResult;
                    if (typeof ipRecordsService.getRecordTransactions === 'function') {
                        txResult = await ipRecordsService.getRecordTransactions(record.id);
                    } else if (typeof ipRecordsService.getTransactionsForRecord === 'function') {
                        txResult = await ipRecordsService.getTransactionsForRecord(record.id);
                    } else {
                        const { data, error } = await supabase.from('transactions').select('*').eq('ip_record_id', record.id);
                        txResult = { success: !error, data: data };
                    }

                    if (txResult && txResult.success) {
                        const txData = txResult.data || txResult.transactions || [];
                        const hasDocument = txData.some(t => {
                            const txTypeId = t.transaction_type_id || t.type;
                            return String(txTypeId) === String(docType) || (t.description && t.description.toLowerCase().includes('tescil belgesi'));
                        });

                        // Eğer evrak YOKSA (Eksikse) listeye al
                        if (!hasDocument) {
                            return record; 
                        }
                    }
                    return null;
                }));
                
                missingDocs.push(...results.filter(r => r !== null));
            }

            this.filteredRecords = missingDocs;
            this.renderTable();
            
            if (missingDocs.length === 0) {
                showNotification('Eksik belgesi olan kayıt bulunamadı.', 'success');
            } else {
                showNotification(`${missingDocs.length} adet eksik belgeli kayıt bulundu.`, 'info');
                const resultSection = document.getElementById('epatsResultsSection');
                if (resultSection) resultSection.style.display = 'block';
            }

        } catch (error) {
            console.error('❌ [EPATS TARAMA HATASI]:', error);
            showNotification('Tarama sırasında hata oluştu: ' + error.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-search mr-2"></i>Eksik Belgeleri Listele';
        }
    }

    renderTable() {
        if (this.pagination) {
            this.pagination.destroy(); 
        }

        this.pagination = new Pagination({
            containerId: 'epatsPagination',
            itemsPerPage: 10,
            showItemsPerPageSelector: true,
            onPageChange: (currentPage, itemsPerPage) => {
                const start = (currentPage - 1) * itemsPerPage;
                const end = start + itemsPerPage;
                const pageItems = this.filteredRecords.slice(start, end);
                this.renderTableRows(pageItems);
            },
            strings: {
                noResults: 'Kayıt yok',
                itemsInfo: 'Toplam {total} kayıt'
            }
        });
        
        this.pagination.update(this.filteredRecords.length);
        const initialItems = this.filteredRecords.slice(0, 10);
        this.renderTableRows(initialItems);
    }

    renderTableRows(items) {
        const tbody = document.getElementById('epatsResultsBody');
        if (!tbody) return;

        tbody.innerHTML = items.map(r => {
            const appNo = r.application_number || r.applicationNumber || '-';
            // 🔥 ŞEMA UYUMLU: Marka adı gösterimi için tam güvenlikli fallback eklendi
            const brandName = r.brand_name || r.title || r.mark_name || r.markName || '-';
            
            return `
            <tr>
                <td class="text-center">
                    <input type="checkbox" class="epats-row-check" 
                           value="${r.id}" 
                           data-appno="${appNo}"
                           ${this.selectedRecordIds.has(r.id) ? 'checked' : ''}
                           onchange="window.epatsUiManager.handleCheck(this)">
                </td>
                <td><span style="font-family:monospace; font-weight:bold;">${appNo}</span></td>
                <td>${brandName}</td>
                <td><span class="badge badge-success">Tescilli</span></td>
            </tr>
        `}).join('');
    }

    handleCheck(checkbox) {
        if (checkbox.checked) {
            this.selectedRecordIds.add(checkbox.value);
        } else {
            this.selectedRecordIds.delete(checkbox.value);
        }
        this.updateActionButtons();
    }

    toggleSelectAll(checked) {
        const checkboxes = document.querySelectorAll('.epats-row-check');
        checkboxes.forEach(cb => {
            cb.checked = checked;
            if (checked) this.selectedRecordIds.add(cb.value);
            else this.selectedRecordIds.delete(cb.value);
        });
        this.updateActionButtons();
    }

    updateActionButtons() {
        const btn = document.getElementById('btnStartEpatsTransfer');
        const countSpan = document.getElementById('selectedEpatsCount');
        
        if (btn) btn.disabled = this.selectedRecordIds.size === 0;
        if (countSpan) countSpan.textContent = this.selectedRecordIds.size;
    }

    async startTransfer() {
        const queue = [];
        this.selectedRecordIds.forEach(id => {
            const record = this.filteredRecords.find(r => r.id === id);
            if (record) {
                queue.push({
                    appNo: record.application_number || record.applicationNumber,
                    ipId: record.id,
                    docType: document.getElementById('epatsDocTypeSelect').value
                });
            }
        });

        if (queue.length === 0) return;

        // 🔥 GÜNCELLEME: YENİ SUPABASE EDGE FUNCTION URL'Sİ VE YETKİLENDİRME
        const targetUploadUrl = `${supabase.supabaseUrl}/functions/v1/save-epats-document`;
        
        // Eklentinin güvenli istek atabilmesi için Auth Token alınıyor
        const { data: { session } } = await supabase.auth.getSession();
        const authToken = session ? session.access_token : null;

        if (!authToken) {
            showNotification("Güvenlik hatası: Oturum tokeni bulunamadı. Lütfen sayfayı yenileyin.", "error");
            return;
        }

        console.log("Hedef Supabase Edge Function:", targetUploadUrl);

        // 1. Yöntem: Window Message
        window.postMessage({
            type: "EPATS_QUEUE_START",
            data: queue,
            uploadUrl: targetUploadUrl,
            token: authToken
        }, "*");

        // 2. Yöntem: Chrome Extension API
        if (window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
            this.extensionIds.forEach(extId => {
                try {
                    chrome.runtime.sendMessage(extId, {
                        action: "START_QUEUE",
                        queue: queue,
                        uploadUrl: targetUploadUrl,
                        token: authToken
                    }, (response) => {
                        if (chrome.runtime.lastError) {}
                    });
                } catch (e) {
                    console.log(`Extension mesaj hatası (${extId}):`, e);
                }
            });
        }

        showNotification(`${queue.length} adet işlem eklentiye gönderildi. EPATS açılıyor...`, 'success');
        
        this.selectedRecordIds.clear();
        this.updateActionButtons();
        document.querySelectorAll('.epats-row-check').forEach(cb => cb.checked = false);
    }
}