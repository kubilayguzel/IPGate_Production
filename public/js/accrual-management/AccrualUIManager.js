// public/js/accrual-management/AccrualUIManager.js

import { AccrualFormManager } from '../components/AccrualFormManager.js';
import { TaskDetailManager } from '../components/TaskDetailManager.js';
import { supabase } from '../../supabase-config.js';

export class AccrualUIManager {
    constructor() {
        this.tableBody = document.getElementById('accrualsTableBody');
        this.foreignTableBody = document.getElementById('foreignTableBody');
        this.invoicesTableBody = document.getElementById('invoicesTableBody');
        this.recursiveTableBody = document.getElementById('recursiveTableBody');
        this.noRecordsMessage = document.getElementById('noRecordsMessage');
        this.bulkActions = document.getElementById('bulkActions');
        this.loadingIndicator = document.getElementById('loadingIndicator');
        
        this.editModal = document.getElementById('editAccrualModal');
        this.viewModal = document.getElementById('viewAccrualDetailModal');
        this.paymentModal = document.getElementById('markPaidModal');
        this.taskDetailModal = document.getElementById('taskDetailModal');

        this.editFormManager = null;
        this.taskDetailManager = new TaskDetailManager('modalBody');

        this.currentData = [];
        this._bindInternalEvents();
    }

    _bindInternalEvents() {
        const handleTableClick = (e) => {
            const viewBtn = e.target.closest('.view-btn');
            if (viewBtn) {
                e.preventDefault();
                const id = viewBtn.dataset.id;
                const item = this.currentData.find(x => String(x.id) === String(id));
                if (item) this.showViewDetailModal(item);
                return;
            }

            // 🔥 YENİ: Fatura Numarasına Tıklanınca Resmi Belgeyi Aç
            const viewInvoiceBtn = e.target.closest('.view-invoice-btn');
            if (viewInvoiceBtn) {
                e.preventDefault();
                const id = viewInvoiceBtn.dataset.id; // Fatura UUID'si
                document.dispatchEvent(new CustomEvent('invoice-view-request', { detail: { id } }));
                return;
            }

            // 🔥 YENİ: Tahakkuklar sekmesinde Fatura Numarasına tıklanınca veritabanından faturayı bul ve aç
            const viewAccrualInvoiceBtn = e.target.closest('.view-accrual-invoice-btn');
            if (viewAccrualInvoiceBtn) {
                e.preventDefault();
                const invoiceNo = viewAccrualInvoiceBtn.dataset.invoiceNo;
                
                // Kullanıcıya arama yapıldığını göstermek için ikonu spinner yap
                const icon = viewAccrualInvoiceBtn.querySelector('i');
                if (icon) icon.className = 'fas fa-spinner fa-spin mr-1';

                // Invoices (Faturalar) tablosunda bu numarayı ara
                supabase.from('invoices').select('id')
                    .eq('invoice_no', invoiceNo)
                    .limit(1)
                    .then(({data, error}) => {
                        if (data && data.length > 0) {
                            if (icon) icon.className = 'fas fa-file-invoice mr-1';
                            // Gerçek Fatura ID'sini bulduk, Faturalar sekmesinin mevcut görüntüleme eventini tetikliyoruz
                            document.dispatchEvent(new CustomEvent('invoice-view-request', { detail: { id: data[0].id } }));
                        } else {
                            // invoice_no alanında bulamazsa, kolaybi_invoice_id alanında şansını denesin
                            supabase.from('invoices').select('id').eq('kolaybi_invoice_id', invoiceNo).limit(1)
                            .then(({data: data2}) => {
                                if (icon) icon.className = 'fas fa-file-invoice mr-1';
                                if (data2 && data2.length > 0) {
                                    document.dispatchEvent(new CustomEvent('invoice-view-request', { detail: { id: data2[0].id } }));
                                } else {
                                    alert('Bu fatura numarasına ait resmi kayıt sistemde (Faturalar sekmesinde) bulunamadı.');
                                }
                            });
                        }
                    })
                    .catch(err => {
                        if (icon) icon.className = 'fas fa-file-invoice mr-1';
                        console.error('Fatura aranırken hata:', err);
                        alert('Fatura aranırken bir hata oluştu.');
                    });
                return;
            }

            // 🔥 YENİ: Fatura Senkronizasyon (Sync) Butonu
            const syncBtn = e.target.closest('.sync-invoice-btn');
            if (syncBtn) {
                e.preventDefault();
                const id = syncBtn.dataset.id;
                document.dispatchEvent(new CustomEvent('invoice-sync-request', { detail: { id } }));
                return;
            }

            const editBtn = e.target.closest('.edit-btn');
            if (editBtn && !editBtn.classList.contains('disabled')) {
                const id = editBtn.dataset.id;
                document.dispatchEvent(new CustomEvent('accrual-edit-request', { detail: { id } }));
                return;
            }

            const deleteBtn = e.target.closest('.delete-btn');
            if (deleteBtn) {
                 const id = deleteBtn.dataset.id;
                 document.dispatchEvent(new CustomEvent('accrual-delete-request', { detail: { id } }));
                 return;
            }
        };

        if (this.tableBody) this.tableBody.addEventListener('click', handleTableClick);
        if (this.foreignTableBody) this.foreignTableBody.addEventListener('click', handleTableClick);
        if (this.invoicesTableBody) this.invoicesTableBody.addEventListener('click', handleTableClick);
        if (this.recursiveTableBody) this.recursiveTableBody.addEventListener('click', handleTableClick);
    }

    setupRecursiveFormListeners() {
        const structureSelect = document.getElementById('accrualStructure');
        const recursiveFields = document.querySelectorAll('.recursive-field');
        
        // Form alanını kapsayan div (Müvekkil, para, kdv vb. burada yükleniyor)
        const freestyleFormContainer = document.getElementById('freestyleAccrualFormContainer'); 

        if (structureSelect) {
            structureSelect.addEventListener('change', (e) => {
                const isRecursive = e.target.value === 'recursive';
                
                // Seçime göre periyot ve tarih alanlarını gizle/göster
                recursiveFields.forEach(el => el.style.display = isRecursive ? 'block' : 'none');
                
                // Tekrarlayan seçildiğinde tarihi bugüne kur (eğer boşsa)
                const recStartDateInput = document.getElementById('recStartDate');
                if (isRecursive && recStartDateInput && !recStartDateInput.value) {
                    recStartDateInput.value = new Date().toISOString().split('T')[0];
                }

                // 🔥 ÇÖZÜM BURADA: Alttaki formun gizlenmesini engelle
                if (freestyleFormContainer) {
                    freestyleFormContainer.style.display = 'block'; 
                }
            });
        }

        // Modal kapandığında formu sıfırla (Bir sonraki açılışta temiz gelsin)
        $('#freestyleAccrualModal').on('hidden.bs.modal', () => {
            if (structureSelect) structureSelect.value = 'single';
            recursiveFields.forEach(el => el.style.display = 'none');
            const recStartDateInput = document.getElementById('recStartDate');
            if (recStartDateInput) recStartDateInput.value = '';
        });
    }

    renderTable(data, lookups, activeTab = 'main') {
        this.currentData = data || [];

        const { tasks, transactionTypes, ipRecordsMap, selectedIds } = lookups;
        let targetBody = this.tableBody;
        if (activeTab === 'foreign') targetBody = this.foreignTableBody;
        else if (activeTab === 'invoices') targetBody = this.invoicesTableBody;
        
        if (targetBody) targetBody.innerHTML = '';
        if (!data || data.length === 0) {
            if (this.noRecordsMessage) this.noRecordsMessage.style.display = 'block';
            return;
        }
        if (this.noRecordsMessage) this.noRecordsMessage.style.display = 'none';

        const rowsHtml = data.map((acc, index) => {
            try {
                const isSelected = selectedIds.has(acc.id);
                
                // 🔥 TEK TİP STATÜ: Artık foreignStatus yok, her şey acc.status üzerinden yürüyor.
                let sTxt = 'Bilinmiyor', sCls = 'badge-secondary';
                if (acc.status === 'paid') { sTxt = 'Ödendi'; sCls = 'status-paid bg-success text-white'; }
                else if (acc.status === 'unpaid') { sTxt = 'Ödenmedi'; sCls = 'status-unpaid bg-danger text-white'; }
                else if (acc.status === 'partially_paid') { sTxt = 'K.Ödendi'; sCls = 'status-partially-paid bg-warning text-dark'; }

                const dateStr = acc.createdAt ? new Date(acc.createdAt).toLocaleDateString('tr-TR') : '-';
                
                const accType = acc.type || 'Hizmet';
                let typeBadgeClass = 'badge-primary'; 
                if (accType === 'Masraf') typeBadgeClass = 'badge-warning text-dark';
                else if (accType === 'Kur Farkı') typeBadgeClass = 'badge-info';
                else if (accType === 'Resmi Ücret Farkı') typeBadgeClass = 'badge-danger';
                else if (accType === 'SWIFT Maliyeti') typeBadgeClass = 'badge-secondary';
                else if (accType === 'Diğer') typeBadgeClass = 'badge-dark';

                // 🔥 YENİ: Departman Rozetini Oluştur
                const deptBadge = acc.department === 'HUKUK' 
                    ? `<span class="badge badge-dark mt-1 shadow-sm"><i class="fas fa-balance-scale mr-1"></i> HUKUK</span>` 
                    : `<span class="badge badge-primary mt-1 shadow-sm"><i class="fas fa-trademark mr-1"></i> EVREKA</span>`;

                // İkisini alt alta birleştir
                const typeHtml = `<span class="badge ${typeBadgeClass}">${accType}</span><br>${deptBadge}`;

                let taskDisplay = '-', relatedFileDisplay = '-', fieldDisplay = '-', fullSubject = '-';
                const task = tasks[String(acc.taskId)];
                
                if (task) {
                    const typeObj = transactionTypes.find(t => String(t.id) === String(task.taskType));
                    taskDisplay = typeObj ? (typeObj.alias || typeObj.name) : (task.title || '-');
                    
                    if (activeTab === 'main' && task.relatedIpRecordId) {
                        const ipRec = ipRecordsMap[String(task.relatedIpRecordId)];
                        if (ipRec) {
                            relatedFileDisplay = ipRec.applicationNumber || '-';
                            fullSubject = ipRec.markName || '-';
                        }
                    }

                    if (typeObj && typeObj.ipType) {
                        const ipTypeMap = { 'trademark': 'Marka', 'patent': 'Patent', 'design': 'Tasarım', 'suit': 'Dava' };
                        fieldDisplay = ipTypeMap[typeObj.ipType] || typeObj.ipType.toUpperCase();
                    }
                } else { 
                    // 🔥 ÇÖZÜM: Bağımsız (Otomatik/Serbest) tahakkuklar için gelişmiş gösterim
                    taskDisplay = acc.taskTitle || (acc.isForeignTransaction ? 'Yurtdışı İşlemi' : 'Serbest Tahakkuk'); 
                    // Eğer konu boşsa açıklamayı konu yerine göster
                    fullSubject = acc.subject || acc.description || '-';
                    // Tasarımın bozulmaması için alt satıra geçişleri temizleyelim
                    fullSubject = fullSubject.replace(/\n/g, ' - ');
                }

                // Konu/İş detayı için limiti 40 karaktere çıkardık
                let shortSubject = fullSubject.length > 40 ? fullSubject.substring(0, 40) + '..' : fullSubject;
                const subjectHtml = `<span title="${fullSubject}" style="cursor:help;">${shortSubject}</span>`;

                // 🔥 ÇÖZÜM: Müvekkil adı tespit kuralını genişlettik (Ücret koşulu olmadan)
                let fullPartyName = acc.tpInvoiceParty?.name || acc.serviceInvoiceParty?.name || acc.paymentParty || '-';
                // Müvekkil adı için limiti 35 karaktere çıkardık (yerimiz bol)
                let shortPartyName = fullPartyName.length > 35 ? fullPartyName.substring(0, 35) + '..' : fullPartyName;
                const partyHtml = `<span title="${fullPartyName}" style="cursor:help;">${shortPartyName}</span>`;

                // 🔥 KESİN ÇÖZÜM: Değişkenler tablonun en başında, doğru yerde tanımlanıyor
                let tfn = acc.tpeInvoiceNo || '-';
                if (tfn.length > 15) tfn = tfn.substring(0, 12) + '...';

                // 🔥 YENİ: EVREKA Fatura No için Akıllı ve Veritabanı Uyumlu Link Oluşturucu
                let efnHtml = '-';
                if (acc.evrekaInvoiceNo && acc.evrekaInvoiceNo !== '-') {
                    // Fatura numaralarını virgülle ayırıp temizle
                    const efnArray = acc.evrekaInvoiceNo.split(',').map(s => s.trim()).filter(s => s !== '');

                    const efnBadges = efnArray.map(displayEfn => {
                        let shortEfn = displayEfn;
                        if (shortEfn.length > 35) shortEfn = shortEfn.substring(0, 32) + '...';

                        // Metni küçük harfe çevirerek analiz et
                        const lowerEfn = displayEfn.toLowerCase();
                        
                        // Fatura numarası OLMAYAN durumları tespit et (kesilmeyecek, yok, iptal vb. kelimeler geçiyorsa veya metinde hiç rakam yoksa)
                        const isNotInvoice = lowerEfn.includes('kesil') || 
                                             lowerEfn.includes('yok') || 
                                             lowerEfn.includes('iptal') || 
                                             lowerEfn.includes('bekliyor') ||
                                             lowerEfn.includes('muaf') || 
                                             !/\d/.test(lowerEfn); // İçinde hiç rakam (\d) yoksa

                        if (isNotInvoice) {
                            // Fatura numarası değilse: Gri ve tıklanamaz rozet (Badge Secondary)
                            return `<span class="badge badge-secondary p-2 shadow-sm mb-1" style="display: inline-block;">
                                        <i class="fas fa-info-circle mr-1"></i> ${shortEfn}
                                    </span>`;
                        } else {
                            // Gerçek bir fatura numarasıysa: Yeşil ve tıklanabilir link (Badge Success)
                            return `<a href="#" class="badge badge-success p-2 shadow-sm text-white mb-1 view-accrual-invoice-btn" data-invoice-no="${displayEfn}" style="text-decoration: none; display: inline-block;" title="Resmi Faturayı Görüntüle">
                                        <i class="fas fa-file-invoice mr-1" style="pointer-events: none;"></i> ${shortEfn}
                                    </a>`;
                        }
                    });

                    // Rozetleri dikey (alt alta) hizalayarak birleştir
                    efnHtml = `<div class="d-flex flex-column align-items-start">${efnBadges.join('')}</div>`;
                }

                const items = acc.items || [];
                
                let srvItems = [];
                let offItems = [];

                // 🔥 ÇÖZÜM: Tahakkuk Türü "Hizmet" ise kalemleri tiplerine göre ayır.
                // Eğer "Hizmet" DEĞİLSE (Örn: Masraf, Kur Farkı), içindeki hiçbir şey Hizmet olamaz, hepsi Yansıtma'ya gider!
                if (accType === 'Hizmet') {
                    srvItems = items.filter(i => i.fee_type === 'Hizmet' || i.fee_type === 'Hukuk Danışmanlık');
                    offItems = items.filter(i => i.fee_type !== 'Hizmet' && i.fee_type !== 'Hukuk Danışmanlık');
                } else {
                    srvItems = []; // Hizmet ücreti sıfırlanır
                    offItems = items; // Tüm kalemler (içinde ne olursa olsun) Yansıtma'ya atılır
                }

                // 1. Hizmet Ücreti Toplamı
                const srvMap = {};
                srvItems.forEach(i => {
                    const curr = i.currency || 'TRY';
                    srvMap[curr] = (srvMap[curr] || 0) + (Number(i.total_amount) || 0);
                });
                const serviceStr = Object.keys(srvMap).length > 0 
                    ? Object.entries(srvMap).map(([c, a]) => this._formatMoney(a, c)).join(' + ') 
                    : '-';

                // 2. Yansıtma / Resmi Ücret Toplamı
                const offMap = {};
                offItems.forEach(i => {
                    const curr = i.currency || 'TRY';
                    offMap[curr] = (offMap[curr] || 0) + (Number(i.total_amount) || 0);
                });
                const officialStr = Object.keys(offMap).length > 0 
                    ? Object.entries(offMap).map(([c, a]) => this._formatMoney(a, c)).join(' + ') 
                    : '-';

                // Artık ödenmiş olanlar da düzenlenebilecek, o yüzden disabled kilidini kaldırıyoruz
                const editBtnClass = 'btn btn-sm btn-light text-warning edit-btn action-btn';
                const editBtnStyle = 'cursor: pointer;';
                const editTitle = acc.status === 'paid' ? 'Fatura Bilgilerini Düzenle' : 'Düzenle';

                const actionMenuHtml = `
                    <div class="dropdown">
                        <button class="btn btn-sm btn-light text-secondary rounded-circle" type="button" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;">
                            <i class="fas fa-ellipsis-v" style="pointer-events: none;"></i>
                        </button>
                        <div class="dropdown-menu dropdown-menu-right shadow-sm border-0 p-2" style="min-width: auto;">
                            <div class="d-flex justify-content-center align-items-center" style="gap: 5px;">
                                <button class="btn btn-sm btn-light text-primary view-btn action-btn" data-id="${acc.id}" title="Görüntüle">
                                    <i class="fas fa-eye" style="pointer-events: none;"></i>
                                </button>
                                <button class="${editBtnClass}" data-id="${acc.id}" style="${editBtnStyle}" title="${editTitle}">
                                    <i class="fas fa-edit" style="pointer-events: none;"></i>
                                </button>
                                <button class="btn btn-sm btn-light text-danger delete-btn action-btn" data-id="${acc.id}" title="Sil">
                                    <i class="fas fa-trash-alt" style="pointer-events: none;"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                `;

                // Ortak Dizi (Array) Kalan Tutar Hesaplaması
                let rem = acc.remainingAmount;
                
                // 🔥 ÇÖZÜM: Eğer status 'unpaid' ise ve remainingAmount boş ise, kalan tutar doğrudan totalAmount'tur.
                if (acc.status === 'unpaid' && (!rem || (Array.isArray(rem) && rem.length === 0))) {
                    rem = acc.totalAmount;
                }

                // Sadece statüsü 'paid' olanlar tam ödenmiş sayılır
                const isFullyPaid = acc.status === 'paid';

                let remainingHtml = '-';
                if (!isFullyPaid) {
                    remainingHtml = `<span class="text-danger font-weight-bold">${this._formatMoney(rem)}</span>`;
                } else {
                    remainingHtml = `<span class="text-success font-weight-bold">Tamamlandı</span>`;
                }

                if (activeTab === 'invoices') {
                    // 🔥 ÇÖZÜM 1: Kesim Tarihi (Sisteme kayıt) ve Fatura Tarihi (Resmi) olarak 2'ye ayrıldı
                    const kesimTarihi = acc.createdAt ? new Date(acc.createdAt).toLocaleDateString('tr-TR') : '-';
                    const faturaTarihi = acc.invoiceDate ? new Date(acc.invoiceDate).toLocaleDateString('tr-TR') : '-'; 
                    const invTotal = this._formatMoney(acc.totalAmount, acc.currency);
                    
                    // Fatura No'yu belirle
                    const displayInvoiceNo = acc.invoiceNo && acc.invoiceNo !== '-' ? acc.invoiceNo : (acc.kolaybiInvoiceId && acc.kolaybiInvoiceId !== 'undefined' ? acc.kolaybiInvoiceId : '-');
                    
                    // Durum Belirleme: Gelişmiş Akıllı Eşleştirme (KolayBi Sözlüğü)
                    let sysStatus = (acc.status || '').toLowerCase().trim(); 
                    let kStatus = (acc.kolaybiStatus || '').toLowerCase().trim(); 

                    let invStatusText = acc.kolaybiStatus || acc.status || 'Bilinmiyor';
                    let invStatusClass = 'badge-secondary';

                    const statusDictionary = {
                        'ready': 'Gönderime Hazır',
                        'preparing': 'Hazırlanıyor',
                        'in_queue': 'Kuyrukta İşleniyor',
                        'sending': 'GİB\'e Gönderiliyor',
                        'sent_to_qnb': 'Entegratöre (QNB) Gönderildi',
                        'sent_to_provider': 'Entegratöre İletildi',
                        'sent to provider': 'Entegratöre İletildi',
                        'sent_to_gib': 'GİB\'e Gönderildi',
                        'processed_in_gib': 'GİB Tarafından İşlendi',
                        'sent_to_receiver': 'Alıcıya Ulaştı',
                        'waiting_gib': 'GİB Onayı Bekleniyor',
                        'awaiting': 'Durum Bekleniyor',
                        'failed': 'İşlem Başarısız',
                        'sending_failed': 'Gönderim Başarısız',
                        'processing_failed': 'GİB İşleme Hatası',
                        'queue_failed': 'Kuyruk Hatası',
                        'cancelled': 'İptal Edildi',
                        'rejected': 'Karşı Taraf Reddetti',
                        'declined': 'Karşı Taraf Reddetti',
                        'approved': 'Kabul Edildi',
                        'accepted': 'Kabul Edildi',
                        'draft': 'Taslak',
                        'ready_to_send': 'Gönderime Hazır'
                    };

                    // Kelimelerin içinde geçip geçmediğini kontrol eden esnek yardımcı fonksiyon
                    const isMatch = (str, keywords) => keywords.some(k => str.includes(k));

                    // 1. İPTAL ve RED
                    if (isMatch(sysStatus, ['reject', 'decline', 'red']) || isMatch(kStatus, ['reject', 'decline', 'red'])) {
                        invStatusText = '<i class="fas fa-times-circle mr-1"></i> Reddedildi';
                        invStatusClass = 'badge-danger';
                    } 
                    else if (isMatch(sysStatus, ['cancel', 'iptal']) || isMatch(kStatus, ['cancel', 'iptal'])) {
                        invStatusText = '<i class="fas fa-ban mr-1"></i> İptal Edildi';
                        invStatusClass = 'badge-danger';
                    } 
                    // 2. BAŞARILI İŞLEMLER
                    else if (isMatch(sysStatus, ['approv', 'accept', 'kabul', 'onay']) || isMatch(kStatus, ['approv', 'accept', 'kabul', 'onay'])) {
                        invStatusText = '<i class="fas fa-check-circle mr-1"></i> Kabul Edildi';
                        invStatusClass = 'badge-success';
                    } 
                    else if (isMatch(kStatus, ['ulaştı', 'sent_to_receiver', 'delivered'])) {
                        invStatusText = '<i class="fas fa-check-double mr-1"></i> Alıcıya Ulaştı';
                        invStatusClass = 'badge-info text-white'; // 🔥 GÜNCELLEME: Rengi mavi/turkuaz yapıldı
                    } 
                    else if (isMatch(kStatus, ['işlendi', 'processed_in_gib', 'processed'])) {
                        invStatusText = '<i class="fas fa-check mr-1"></i> GİB\'de İşlendi';
                        invStatusClass = 'badge-success';
                    }
                    // 3. SÜRECİ DEVAM EDENLER
                    else if (isMatch(kStatus, ['gönderildi', 'sent_to_gib', 'sent_to_qnb', 'provider']) || sysStatus === 'sent') {
                        let txt = (kStatus.includes('qnb') || kStatus.includes('provider')) ? 'Entegratöre İletildi' : 'GİB\'e Gönderildi';
                        invStatusText = `<i class="fas fa-paper-plane mr-1"></i> ${txt}`;
                        invStatusClass = 'badge-primary';
                    } 
                    else if (isMatch(kStatus, ['bekliyor', 'waiting', 'awaiting'])) {
                        invStatusText = '<i class="fas fa-hourglass-half mr-1"></i> GİB Cevabı Bekleniyor';
                        invStatusClass = 'badge-info text-white';
                    } 
                    else if (isMatch(kStatus, ['kuyruk', 'hazır', 'queue', 'preparing', 'ready']) || sysStatus === 'ready_to_send') {
                        invStatusText = '<i class="fas fa-spinner fa-spin mr-1"></i> İşleniyor / Kuyrukta';
                        invStatusClass = 'badge-warning text-dark';
                    } 
                    // 4. TASLAK ve HATALAR
                    else if (sysStatus === 'draft') {
                        invStatusText = '<i class="fas fa-file-alt mr-1"></i> Taslak';
                        invStatusClass = 'badge-secondary';
                    } 
                    else if (isMatch(kStatus, ['hata', 'fail', 'error']) || isMatch(sysStatus, ['fail', 'error'])) {
                        invStatusText = '<i class="fas fa-exclamation-triangle mr-1"></i> Gönderim Hatası';
                        invStatusClass = 'badge-dark';
                    } 
                    else {
                        // Eğer hiçbir şarta uymadıysa SÖZLÜKTEN (Dictionary) direkt Türkçesini al
                        let translated = statusDictionary[kStatus] || statusDictionary[sysStatus] || (kStatus || sysStatus);
                        translated = translated.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                        invStatusText = `<i class="fas fa-info-circle mr-1"></i> ${translated}`;
                        invStatusClass = 'badge-light border text-dark';
                    }

                    // Fatura No Linki (Tıklanabilir olması için view-invoice-btn sınıfı var)
                    let invoiceNoHtml = `<span class="font-weight-bold text-primary">${displayInvoiceNo}</span>`;
                    if (acc.kolaybiUuid) {
                        invoiceNoHtml = `<a href="#" class="font-weight-bold text-success view-invoice-btn" data-id="${acc.id}" title="Resmi Faturayı Görüntüle" style="text-decoration: underline;">${displayInvoiceNo} <i class="fas fa-external-link-alt ml-1" style="font-size: 0.8em;"></i></a>`;
                    }

                    // Tahakkuk İçeriği (İlişkili Tahakkuklar)
                    let linkedAccrualsHtml = '<span class="text-muted">-</span>';
                    if (acc.accruals && acc.accruals.length > 0) {
                        const accList = acc.accruals.map(a => `<li class="mb-1 border-bottom pb-1"><strong>#${a.id}</strong> - ${a.task_title || a.subject || 'İşlem'} <br><small class="text-success">${this._formatMoney(a.total_amount || 0, a.currency)}</small></li>`).join('');
                        linkedAccrualsHtml = `<div class="dropdown"><button class="btn btn-sm btn-outline-info dropdown-toggle font-weight-bold" type="button" data-toggle="dropdown"><i class="fas fa-layer-group mr-1"></i> ${acc.accruals.length} İşlem</button><div class="dropdown-menu p-3 shadow" style="min-width: 300px; max-height: 250px; overflow-y: auto; white-space: normal;"><h6 class="dropdown-header px-0 text-primary border-bottom mb-2">Fatura İçeriği</h6><ul class="list-unstyled mb-0" style="font-size: 0.85em;">${accList}</ul></div></div>`;
                    }

                    // İşlem Menüsü
                    const viewKolaybiBtn = acc.kolaybiInvoiceId && acc.kolaybiInvoiceId !== 'undefined' ? `<a href="https://ofis.kolaybi.com/sales/invoices/sale_invoice/edit/${acc.kolaybiInvoiceId}" target="_blank" class="dropdown-item text-info"><i class="fas fa-external-link-alt mr-2"></i> KolayBi Panelinde Aç</a>` : '';
                    const syncBtn = `<a href="#" class="dropdown-item text-primary sync-invoice-btn" data-id="${acc.id}"><i class="fas fa-sync-alt mr-2"></i> Durumu Güncelle (Sync)</a>`;
                    const cancelBtn = acc.status === 'draft' ? `<a href="#" class="dropdown-item text-danger cancel-invoice-btn" data-id="${acc.id}"><i class="fas fa-trash-alt mr-2"></i> Faturayı Sil / İptal Et</a>` : `<span class="dropdown-item text-muted"><i class="fas fa-lock mr-2"></i> Sadece Taslaklar Silinebilir</span>`;
                    const actionMenuHtml = `<div class="dropdown"><button class="btn btn-sm btn-light text-secondary rounded-circle" type="button" data-toggle="dropdown"><i class="fas fa-ellipsis-v"></i></button><div class="dropdown-menu dropdown-menu-right shadow-sm border-0">${viewKolaybiBtn}${syncBtn}<div class="dropdown-divider"></div>${cancelBtn}</div></div>`;

                    const serialNumber = index + 1;

                    // 🔥 ÇÖZÜM 2: HTML Tablosundaki 10 başlığa denk gelecek 10 adet <td> hücresi eklendi!
                    return `
                    <tr>
                        <td><input type="checkbox" class="row-checkbox" data-id="${acc.id}" ${isSelected ? 'checked' : ''}></td>
                        <td class="font-weight-bold text-muted">${serialNumber}</td>
                        <td>${kesimTarihi}</td>
                        <td>${faturaTarihi}</td>
                        <td>${invoiceNoHtml}</td> 
                        <td><span class="font-weight-bold">${acc.clientName}</span></td>
                        <td>${linkedAccrualsHtml}</td>
                        <td><span class="badge ${invStatusClass}">${invStatusText}</span></td>
                        <td><span class="font-weight-bold text-success">${invTotal}</span></td>
                        <td class="text-center" style="overflow:visible;">${actionMenuHtml}</td>
                    </tr>`;
                }
                else if (activeTab === 'main') {
                    // Departman ve Tür rozetlerini yan yana ve şık almak için yeniden düzenledik
                    const deptBadgeInline = acc.department === 'HUKUK' 
                        ? `<span class="badge badge-dark shadow-sm"><i class="fas fa-balance-scale mr-1"></i> HUKUK</span>` 
                        : `<span class="badge badge-primary shadow-sm"><i class="fas fa-trademark mr-1"></i> EVREKA</span>`;
                    
                    const efnDisplay = efnHtml !== '-' ? efnHtml : `<span class="text-muted" style="font-size: 0.85em;"><i class="fas fa-file-invoice"></i> Fatura Kesilmedi</span>`;
                    const tfnDisplay = tfn !== '-' ? `<span class="text-muted ml-2" style="font-size: 0.8em;" title="TÜRKPATENT Fatura No"><i class="fas fa-receipt"></i> TP: ${tfn}</span>` : '';

                    return `
                    <tr class="align-middle border-bottom">
                        <td class="align-middle"><input type="checkbox" class="row-checkbox" data-id="${acc.id}" ${isSelected ? 'checked' : ''}></td>
                        
                        <td class="align-middle">
                            <div class="font-weight-bold text-dark" style="font-size: 1.05em;">#${acc.id}</div>
                            <div class="text-muted mt-1" style="font-size: 0.85em;"><i class="far fa-calendar-alt"></i> ${dateStr}</div>
                        </td>

                        <td class="align-middle">
                            <div class="d-flex align-items-center mb-1" style="gap: 5px;">
                                <span class="font-weight-bold text-dark" style="font-size: 1.05em;">${partyHtml}</span>
                                ${deptBadgeInline}
                                <span class="badge ${typeBadgeClass} shadow-sm">${accType}</span>
                            </div>
                            <div class="text-muted d-flex align-items-center flex-wrap" style="font-size: 0.85em; gap: 5px;">
                                <span class="badge badge-light border text-secondary" title="İşlem Alanı">${fieldDisplay}</span>
                                <a href="#" class="task-detail-link text-info font-weight-bold" data-task-id="${acc.taskId}" title="Bağlı İş/Görev">${taskDisplay}</a> 
                                <span>| ${relatedFileDisplay !== '-' ? relatedFileDisplay + ' - ' : ''}${subjectHtml}</span>
                            </div>
                        </td>

                        <td class="align-middle">
                            <div class="font-weight-bold text-primary mb-1" style="font-size: 1.15em;">
                                ${this._formatMoney(acc.totalAmount)}
                            </div>
                            <div class="d-flex flex-column text-muted" style="font-size: 0.8em; gap: 2px;">
                                <span><i class="fas fa-briefcase text-secondary" style="width:14px"></i> Hizm: <span class="font-weight-bold">${serviceStr}</span></span>
                                <span><i class="fas fa-university text-secondary" style="width:14px"></i> Yans: <span class="font-weight-bold">${officialStr}</span></span>
                            </div>
                        </td>

                        <td class="align-middle">
                            <div class="d-flex align-items-center mb-2" style="gap: 8px;">
                                <span class="badge ${sCls} p-1 px-2" style="font-size:0.85em">${sTxt}</span>
                                <div style="font-size: 0.85em;">${remainingHtml}</div>
                            </div>
                            <div class="d-flex align-items-center">
                                ${efnDisplay}
                                ${tfnDisplay}
                            </div>
                        </td>

                        <td class="align-middle text-center">${actionMenuHtml}</td>
                    </tr>`;
                } else {
                    // Yurtdışı (Foreign) Sekmesi İçin Çizim
                    let paymentParty = acc.serviceInvoiceParty?.name || '-';
                    let documentHtml = '-';
                    if (acc.files && acc.files.length > 0) {
                        const lastFile = acc.files[acc.files.length - 1];
                        const link = lastFile.url || lastFile.content;
                        documentHtml = `<a href="${link}" target="_blank" class="text-secondary" title="${lastFile.name}"><i class="fas fa-file-contract fa-lg hover-primary"></i></a>`;
                    }

                    let advisorStatusHtml = acc.sentToAdvisor 
                        ? '<span class="badge badge-success">Evet</span>' 
                        : '<span class="badge badge-secondary">Hayır</span>';

                    // 🔥 YURTDIŞI ÖDEMEYE ÖZEL DURUM VE KALAN TUTAR HESAPLAMASI
                    let expectedForeignTotals = {}; 
                    let remainingForeignTotals = {};
                    let isFullyPaidForeign = true;
                    let hasAnyForeignDebt = false;

                    // 1. KURAL: Doğrudan "Yurtdışı Maliyet" türündeki kalemleri ara
                    let foreignItems = (acc.items || []).filter(i => i.fee_type === 'Yurtdışı Maliyet');
                    
                    // 2. KURAL: Eğer "Yurtdışı Maliyet" yoksa, SADECE "Hizmet" olmayan kalemleri topla (Para birimi ne olursa olsun)
                    if (foreignItems.length === 0) {
                        foreignItems = (acc.items || []).filter(i => i.fee_type !== 'Hizmet');
                    }
                    
                    if (foreignItems.length > 0) {
                        // 3. Bu kalemleri kendi para birimlerine göre topla
                        foreignItems.forEach(i => {
                            const c = i.currency || 'EUR';
                            const amt = Number(i.total_amount) || 0;
                            const vatMult = acc.applyVatToOfficialFee ? (1 + (Number(i.vat_rate || acc.vatRate || 0) / 100)) : 1;
                            expectedForeignTotals[c] = (expectedForeignTotals[c] || 0) + (amt * vatMult);
                        });
                    } else {
                        // Geriye dönük uyumluluk: Çok eski kayıtlarda items yoksa resmi ücreti baz al
                        const c = acc.officialFee?.currency || 'EUR';
                        const amt = parseFloat(acc.officialFee?.amount) || 0;
                        const vatMult = acc.applyVatToOfficialFee ? (1 + (acc.vatRate || 0) / 100) : 1;
                        if(amt > 0) expectedForeignTotals[c] = amt * vatMult;
                    }

                    // 4. Beklenen yurt dışı ödemeleri ile güncel kalan bakiyeyi kıyasla
                    Object.keys(expectedForeignTotals).forEach(curr => {
                        const expAmt = expectedForeignTotals[curr];
                        let remAmt = 0;

                        if (acc.status === 'unpaid') {
                            remAmt = expAmt; // Hiç ödenmediyse tamamı duruyor
                        } else if (acc.status === 'paid') {
                            remAmt = 0; // Tamamı ödendiyse 0
                        } else if (acc.status === 'partially_paid') {
                            // Kısmen ödendiyse, genel kalanın içinden bu dövize ait olanı bul
                            const remObj = Array.isArray(acc.remainingAmount) ? acc.remainingAmount.find(r => r.currency === curr) : null;
                            remAmt = remObj ? parseFloat(remObj.amount) : 0;
                            if (remAmt > expAmt) remAmt = expAmt;
                        }

                        remainingForeignTotals[curr] = remAmt;
                        if (remAmt > 0.01) {
                            isFullyPaidForeign = false;
                            hasAnyForeignDebt = true;
                        }
                    });

                    // 5. Saf Yurtdışı Statüsü
                    // 🔥 YENİ: Tamamen Bağımsız Yurtdışı Statüsü (Müşteriden bağımsız)
                    let fStatusTxt = 'Ödenmedi';
                    let fStatusCls = 'status-unpaid bg-danger text-white';
                    
                    if (acc.foreignStatus === 'paid') {
                        fStatusTxt = 'Ödendi';
                        fStatusCls = 'status-paid bg-success text-white';
                    }

                    const foreignStatusHtml = `<span class="badge ${fStatusCls}">${fStatusTxt}</span>`;
                    
                    // 🔥 YENİ: Kalan Tutar HTML'i (Bizim yurtdışına olan borcumuz, Sadece ödenmediyse göster)
                    const remTexts = [];
                    if (acc.foreignStatus !== 'paid') {
                        Object.entries(expectedForeignTotals).forEach(([c, a]) => {
                            if (a > 0.01) remTexts.push(this._formatMoney(a, c)); 
                        });
                    }

                    const foreignRemainingHtml = (acc.foreignStatus === 'paid' || remTexts.length === 0)
                        ? `<span class="text-success font-weight-bold">Tamamlandı</span>` 
                        : `<span class="text-danger font-weight-bold">${remTexts.join(' + ')}</span>`;

                    return `
                    <tr>
                        <td><input type="checkbox" class="row-checkbox" data-id="${acc.id}" ${isSelected ? 'checked' : ''}></td>
                        <td>${acc.id}</td>
                        <td>${foreignStatusHtml}</td>
                        <td><a href="#" class="task-detail-link" data-task-id="${acc.taskId}">${taskDisplay}</a></td>
                        <td>${paymentParty}</td>
                        <td>${officialStr}</td>
                        <td>${foreignRemainingHtml}</td>
                        <td>${documentHtml}</td>
                        <td class="text-center">${advisorStatusHtml}</td>
                    </tr>`;
                }

            } catch (err) {
                console.error(`Satır çizim hatası (ID: ${acc.id}):`, err);
                return `<tr><td colspan="15" class="text-danger text-center font-weight-bold">⚠️ Hatalı Veri Formatı (ID: ${acc.id})</td></tr>`;
            }
        }).join('');

        if (targetBody) targetBody.innerHTML = rowsHtml;
        this.updateBulkActionsVisibility(selectedIds.size > 0);
    }

    initEditModal(accrual, personList, epatsDocument = null) {
        if (!accrual) return;

        if (!this.editFormManager) {
            this.editFormManager = new AccrualFormManager('editAccrualFormContainer', 'edit', personList);
            this.editFormManager.render();
        } else {
            this.editFormManager.persons = personList;
            this.editFormManager.render(); 
        }

        document.getElementById('editAccrualId').value = accrual.id;
        document.getElementById('editAccrualTaskTitleDisplay').value = accrual.taskTitle || '';
        
        this.editFormManager.reset();
        this.editFormManager.setData(accrual);
        
        // 🔥 LOGLU YAPI
        console.log(`\n[DEBUG-DOC] --- BELGE ARAMA BAŞLADI ---`);
        console.log(`[DEBUG-DOC] Tahakkuk Objyesi:`, accrual);

        if (epatsDocument) {
            console.log(`[DEBUG-DOC] ✅ Belge zaten parametre olarak gelmiş, gösteriliyor.`);
            this.editFormManager.showEpatsDoc(epatsDocument);
        } else if (accrual.taskId && accrual.taskId !== 'null' && accrual.taskId !== 'undefined') {
            
            console.log(`[DEBUG-DOC] 1. Supabase'den tahakkuk görevi (ID: ${accrual.taskId}) çekiliyor...`);
            
        supabase.from('tasks').select('details').eq('id', accrual.taskId).single()
            .then(({data, error}) => {
                if (error) {
                    console.error("[DEBUG-DOC] ❌ Tahakkuk işi çekilirken hata:", error.message);
                    return;
                }
                
                if (data && data.details) {
                    let pDetails = typeof data.details === 'string' ? JSON.parse(data.details) : data.details;
                    const targetTaskId = pDetails.parent_task_id || pDetails.relatedTaskId || accrual.taskId;
                    
                    console.log(`[DEBUG-DOC] 3. Aranacak Asıl Görev ID'si (Target Task ID): ${targetTaskId}`);
                    
                    // 🔥 ÇÖZÜM 1: Önce Parent Task'ın kendisine (JSON içine) bakıyoruz, yoksa task_documents tablosuna iniyoruz!
                    supabase.from('tasks').select('details, documents').eq('id', targetTaskId).single()
                    .then(({data: pTask}) => {
                        let epatsDoc = null;
                        
                        if (pTask) {
                            // 1. documents array'inde ara
                            if (pTask.documents && Array.isArray(pTask.documents)) {
                                epatsDoc = pTask.documents.find(d => d.type === 'epats_document');
                            }
                            // 2. details JSON'ında ara
                            if (!epatsDoc && pTask.details) {
                                let pd = typeof pTask.details === 'string' ? JSON.parse(pTask.details) : pTask.details;
                                if (pd.documents && Array.isArray(pd.documents)) {
                                    epatsDoc = pd.documents.find(d => d.type === 'epats_document');
                                }
                            }
                        }

                        // JSON içinde bulduysak gönder
                        if (epatsDoc) {
                            console.log(`[DEBUG-DOC] ✅ JSON'dan EPATS Belgesi Bulundu:`, epatsDoc);
                            this.editFormManager.showEpatsDoc(epatsDoc);
                        } else {
                            // JSON'da yoksa eski task_documents tablosuna bak
                            console.log(`[DEBUG-DOC] 4. task_documents tablosunda aranıyor...`);
                            supabase.from('task_documents')
                                .select('document_name, document_url, document_type')
                                .eq('task_id', targetTaskId)
                                .order('uploaded_at', { ascending: false })
                            .then(({data: docData, error: docError}) => {
                                if (docData && docData.length > 0) {
                                    const targetDoc = docData.find(d => d.document_type === 'epats_document') || docData[0];
                                    console.log(`[DEBUG-DOC] ✅ task_documents tablosundan Belge Seçildi:`, targetDoc);
                                    this.editFormManager.showEpatsDoc({
                                        url: targetDoc.document_url,
                                        name: targetDoc.document_name
                                    });
                                } else {
                                    console.warn(`[DEBUG-DOC] ⚠️ EPATS hiçbir yerde bulunamadı!`);
                                    this.editFormManager.showEpatsDoc(null);
                                }
                            });
                        }
                    });
                }
            }).catch(err => console.error("[DEBUG-DOC] ❌ Yakalanamayan hata:", err));
        } else {
             console.log(`[DEBUG-DOC] ⚠️ Tahakkuk kaydında taskId yok veya geçersiz!`);
        }

        this.editModal.classList.add('show');
    }

    showViewDetailModal(accrual) {
        if (!accrual) return;

        const body = this.viewModal.querySelector('.modal-body-content');
        const title = document.getElementById('viewAccrualTitle');
        if(title) title.style.display = 'none';

        const dFmt = (d) => { try { return d ? new Date(d).toLocaleDateString('tr-TR') : '-'; } catch{return '-'} };
        
        let statusText = 'Bilinmiyor', statusBadge = 'badge-secondary';
        if(accrual.status === 'paid') { statusText = 'Ödendi'; statusBadge = 'badge-success'; }
        else if(accrual.status === 'unpaid') { statusText = 'Ödenmedi'; statusBadge = 'badge-danger'; }
        else if(accrual.status === 'partially_paid') { statusText = 'Kısmen Ödendi'; statusBadge = 'badge-warning text-dark'; }

        let filesHtml = '';
        if (accrual.files && accrual.files.length > 0) {
            filesHtml = accrual.files.map(f => `
                <div class="d-flex align-items-center justify-content-between p-2 mb-2 border rounded bg-light">
                    <div class="d-flex align-items-center">
                        <i class="fas fa-file-pdf text-danger fa-lg mr-3"></i>
                        <span class="text-dark font-weight-bold" style="font-size: 0.95em;">${f.name}</span>
                    </div>
                    <a href="${f.content || f.url}" target="_blank" class="btn btn-sm btn-outline-primary"><i class="fas fa-download mr-1"></i> İndir</a>
                </div>
            `).join('');
        } else {
            filesHtml = '<span class="text-muted small">Ekli belge bulunmamaktadır.</span>';
        }

        const tfn = accrual.tpeInvoiceNo || '-';
        const efn = accrual.evrekaInvoiceNo || '-';
        const description = accrual.description || '-';
        const orderCode = accrual.orderCode || '-'; // 🔥 YENİ
        const tpParty = accrual.tpInvoiceParty?.name || '-';
        const foreignParty = accrual.serviceInvoiceParty?.name || '-';
        const applyVatToOfficial = accrual.applyVatToOfficialFee ? 'Evet' : 'Hayır';

        const offFeeStr = accrual.officialFee ? this._formatMoney(accrual.officialFee) : '0 TRY';
        const srvFeeStr = accrual.serviceFee ? this._formatMoney(accrual.serviceFee) : '0 TRY';
        const totalStr = this._formatMoney(accrual.totalAmount);
        const remainingStr = this._formatMoney(accrual.remainingAmount);

        let itemsHtml = '';
        if (accrual.items && accrual.items.length > 0) {
            itemsHtml = accrual.items.map(i => {
                const qty = Number(i.quantity) || 1;
                const unitPrice = Number(i.unit_price) || 0;
                const vat = Number(i.vat_rate) || 0;
                const total = Number(i.total_amount) || 0;
                const curr = i.currency || 'TRY';
                
                return `
                <div class="d-flex justify-content-between mb-2 pb-2 border-bottom" style="font-size: 0.9em;">
                    <div class="d-flex flex-column">
                        <span class="font-weight-bold text-dark">${i.item_name || '-'} <span class="badge badge-light text-muted ml-1 border">${i.fee_type || '-'}</span></span>
                        <span class="text-muted" style="font-size: 0.85em;">${qty} x ${this._formatMoney(unitPrice, curr)} (KDV: %${vat})</span>
                    </div>
                    <strong class="text-dark align-self-center">${this._formatMoney(total, curr)}</strong>
                </div>`;
            }).join('');
        } else {
            // Eğer çok eski bir tahakkuksa ve içinde item yoksa eski görünümü koru
            itemsHtml = `
                <div class="d-flex justify-content-between mb-3 pb-2 border-bottom">
                    <span class="text-secondary">Resmi Ücret:</span>
                    <strong class="text-dark">${offFeeStr}</strong>
                </div>
                <div class="d-flex justify-content-between mb-3 pb-2 border-bottom">
                    <span class="text-secondary">Hizmet/Masraf:</span>
                    <strong class="text-dark">${srvFeeStr}</strong>
                </div>
                <div class="d-flex justify-content-between mb-3 pb-2 border-bottom">
                    <span class="text-secondary">KDV Oranı:</span>
                    <strong class="text-dark">%${accrual.vatRate || 0} <small class="text-muted font-weight-normal">(Resmiye Dahil: ${applyVatToOfficial})</small></strong>
                </div>
            `;
        }

        body.innerHTML = `
            <div class="container-fluid p-0" style="font-size: 0.95rem; color: #333;">
                
                <div class="d-flex justify-content-between align-items-center mb-4 border-bottom pb-3">
                    <h4 class="m-0 font-weight-bold text-dark">Tahakkuk Özeti <span class="text-muted ml-2" style="font-size: 0.6em; font-weight: normal;">#${accrual.id}</span></h4>
                    <span class="badge ${statusBadge} p-2 px-3" style="font-size: 0.9rem;">${statusText}</span>
                </div>

                <div class="row">
                    <div class="col-md-7">
                        <div class="card mb-4 shadow-sm border-0" style="border: 1px solid #e0e0e0 !important;">
                            <div class="card-header bg-light font-weight-bold text-dark border-bottom">
                                <i class="fas fa-info-circle mr-2 text-primary"></i>Genel Bilgiler
                            </div>
                            <div class="card-body p-3">
                                <p class="mb-3"><strong>İlgili İş/Konu:</strong> <span class="ml-2">${accrual.taskTitle || accrual.subject || '-'}</span></p>
                                <p class="mb-3"><strong>Tür:</strong> <span class="ml-2 text-uppercase text-secondary">${accrual.type || 'Hizmet'}</span> ${accrual.isForeignTransaction ? '<span class="badge badge-danger ml-2">Yurtdışı İşlem</span>' : ''}</p>
                                <p class="mb-3"><strong>Müvekkil/TP Kişisi:</strong> <span class="ml-2">${tpParty}</span></p>
                                ${accrual.isForeignTransaction ? `<p class="mb-3"><strong>Yurtdışı Ödeme Tarafı:</strong> <span class="ml-2 text-primary font-weight-bold">${foreignParty}</span></p>` : ''}
                                <div class="row border-top pt-3 mt-1">
                                    <div class="col-4"><p class="mb-0"><strong>Sipariş No/SAS:</strong> ${orderCode}</p></div>
                                    <div class="col-4"><p class="mb-0"><strong>TPE Fatura No:</strong> ${tfn}</p></div>
                                    <div class="col-4"><p class="mb-0"><strong>EVREKA Fatura:</strong> ${efn}</p></div>
                                </div>
                            </div>
                        </div>

                        <div class="card mb-4 shadow-sm border-0" style="border: 1px solid #e0e0e0 !important;">
                            <div class="card-header bg-light font-weight-bold text-dark border-bottom">
                                <i class="fas fa-edit mr-2 text-warning"></i>Tahakkuk Açıklaması / Notu
                            </div>
                            <div class="card-body p-3">
                                <p class="mb-0 text-dark" style="white-space: pre-wrap; line-height: 1.6;">${description}</p>
                            </div>
                        </div>
                        
                        <div class="card mb-4 shadow-sm border-0" style="border: 1px solid #e0e0e0 !important;">
                            <div class="card-header bg-light font-weight-bold text-dark border-bottom">
                                <i class="fas fa-folder-open mr-2 text-info"></i>Ekli Belgeler
                            </div>
                            <div class="card-body p-3">
                                ${filesHtml}
                            </div>
                        </div>
                    </div>

                    <div class="col-md-5">
                        <div class="card mb-4 shadow-sm border-0" style="border: 1px solid #e0e0e0 !important;">
                            <div class="card-header bg-light font-weight-bold text-dark border-bottom">
                                <i class="fas fa-coins mr-2 text-success"></i>Finansal Detaylar
                            </div>
                            <div class="card-body p-3">
                                <div class="mb-3">
                                    <h6 class="text-secondary font-weight-bold border-bottom pb-2 mb-3">Kalem Detayları</h6>
                                    ${itemsHtml}
                                </div>
                                <div class="d-flex justify-content-between mb-3 pt-2">
                                    <span class="font-weight-bold text-primary">GENEL TOPLAM:</span>
                                    <strong class="text-primary" style="font-size: 1.2em;">${totalStr}</strong>
                                </div>
                                <div class="d-flex justify-content-between p-3 mt-3 rounded ${accrual.status === 'paid' ? 'bg-success text-white' : 'bg-warning text-dark'}">
                                    <span class="font-weight-bold">KALAN TUTAR (ÖDENECEK):</span>
                                    <strong style="font-size: 1.25em;">${remainingStr}</strong>
                                </div>
                            </div>
                        </div>
                        
                        <div class="card mb-4 shadow-sm border-0" style="border: 1px solid #e0e0e0 !important;">
                            <div class="card-header bg-light font-weight-bold text-dark border-bottom">
                                <i class="far fa-calendar-alt mr-2 text-secondary"></i>Tarih Bilgileri
                            </div>
                            <div class="card-body p-3">
                                <p class="mb-3"><strong>Oluşturma:</strong> <span class="ml-2">${dFmt(accrual.createdAt)}</span></p>
                                <p class="mb-0"><strong>Ödeme:</strong> <span class="ml-2">${accrual.paymentDate ? dFmt(accrual.paymentDate) : '-'}</span></p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this.viewModal.classList.add('show');
    }

    showPaymentModal(selectedAccrualsList, activeTab = 'main') {
        document.getElementById('paidAccrualCount').textContent = selectedAccrualsList.length;
        
        const dateInput = document.getElementById('paymentDate');
        const today = new Date();
        const dd = String(today.getDate()).padStart(2, '0');
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const yyyy = today.getFullYear();
        
        dateInput.value = `${dd}.${mm}.${yyyy}`;
        if (dateInput._flatpickr) {
            dateInput._flatpickr.setDate(today, true);
        }

        document.getElementById('paymentReceiptFileList').innerHTML = '';

        const localArea = document.getElementById('detailedPaymentInputs');
        const foreignArea = document.getElementById('foreignPaymentInputs');

        if(localArea) localArea.style.display = 'none';
        if(foreignArea) foreignArea.style.display = 'none';

        if (selectedAccrualsList.length === 1) {
            const acc = selectedAccrualsList[0];

            if (activeTab === 'foreign') {
                if(foreignArea) foreignArea.style.display = 'block';

                const offAmt = acc.officialFee?.amount || 0;
                const offCurr = acc.officialFee?.currency || 'EUR';
                
                document.getElementById('foreignTotalBadge').textContent = `${this._formatMoney(offAmt, offCurr)}`;
                document.querySelectorAll('.foreign-currency-label').forEach(el => el.textContent = offCurr);

                document.getElementById('manualForeignOfficial').value = acc.paidOfficialAmount || 0;
                document.getElementById('manualForeignService').value = acc.paidServiceAmount || 0;

                const payFullCb = document.getElementById('payFullForeign');
                const splitInputs = document.getElementById('foreignSplitInputs');
                
                if(payFullCb) payFullCb.checked = true;
                if(splitInputs) splitInputs.style.display = 'none';
            }
            else {
                if(localArea) localArea.style.display = 'block';

                const offAmt = acc.officialFee?.amount || 0;
                const offCurr = acc.officialFee?.currency || 'TRY';
                document.getElementById('officialFeeBadge').textContent = `${offAmt} ${offCurr}`;
                document.getElementById('manualOfficialCurrencyLabel').textContent = offCurr;
                document.getElementById('manualOfficialAmount').value = acc.paidOfficialAmount || 0;

                const srvAmt = acc.serviceFee?.amount || 0;
                const srvCurr = acc.serviceFee?.currency || 'TRY';
                document.getElementById('serviceFeeBadge').textContent = `${srvAmt} ${srvCurr}`;
                document.getElementById('manualServiceCurrencyLabel').textContent = srvCurr;
                document.getElementById('manualServiceAmount').value = acc.paidServiceAmount || 0;

                document.getElementById('payFullOfficial').checked = true;
                document.getElementById('officialAmountInputContainer').style.display = 'none';
                document.getElementById('payFullService').checked = true;
                document.getElementById('serviceAmountInputContainer').style.display = 'none';
            }
        }
        
        this.paymentModal.classList.add('show');
    }

    showTaskDetailLoading() {
        this.taskDetailModal.classList.add('show');
        document.getElementById('modalTaskTitle').textContent = 'Yükleniyor...';
        this.taskDetailManager.showLoading();
    }
    
    updateTaskDetailContent(task, extraData) {
        document.getElementById('modalTaskTitle').textContent = `İş Detayı (${task.id})`;
        this.taskDetailManager.render(task, extraData);
    }

    updateTaskDetailError(msg) {
        this.taskDetailManager.showError(msg);
    }

    updateBulkActionsVisibility(isVisible) {
        if(this.bulkActions) this.bulkActions.style.display = isVisible ? 'flex' : 'none';
    }

    toggleLoading(show) {
        if (window.SimpleLoadingController && typeof window.SimpleLoadingController.show === 'function') {
            if (show) window.SimpleLoadingController.show({ text: 'Veriler Yükleniyor...' });
            else window.SimpleLoadingController.hide();
        }
        if(this.loadingIndicator) this.loadingIndicator.style.display = show ? 'block' : 'none';
    }

    closeModal(modalId) {
        document.getElementById(modalId).classList.remove('show');
    }

    _formatMoney(val, curr) {
        if (!val) return '0 ' + (curr || 'TRY');
        
        if (Array.isArray(val)) {
            if (val.length === 0) return '0 ' + (curr || 'TRY');
            return val.map(item => {
                const num = parseFloat(item.amount) || 0;
                return `${new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(num)} ${item.currency || curr || 'TRY'}`;
            }).join(' + ');
        }
        
        if (typeof val === 'object') {
            const num = parseFloat(val.amount) || 0;
            return `${new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(num)} ${val.currency || curr || 'TRY'}`;
        }
        
        const num = parseFloat(val) || 0;
        return `${new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(num)} ${curr || 'TRY'}`;
    }

    getEditFormData() {
        return this.editFormManager ? this.editFormManager.getData() : { success: false, error: 'Form yüklenmedi' };
    }

    // 👇 EKLENECEK: TEKRARLAYAN TAHAKKUK TABLOSUNU ÇİZME 👇
    renderRecursiveTable(accruals, allPersonsList) {
        if (!this.recursiveTableBody) return;
        
        if (!accruals || accruals.length === 0) {
            this.recursiveTableBody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-muted">Kayıtlı abonelik / tekrarlayan tahakkuk bulunamadı.</td></tr>';
            return;
        }

        const periodMap = { 'monthly': 'Aylık', 'quarterly': '3 Aylık', 'biannually': '6 Aylık', 'annually': 'Yıllık' };

        const html = accruals.map(a => {
            const personObj = allPersonsList.find(p => p.id === a.person_id);
            const personName = personObj ? personObj.name : 'Bilinmiyor';
            const statusBadge = a.is_active ? '<span class="badge badge-success">Aktif</span>' : '<span class="badge badge-secondary">Pasif</span>';
            
            return `
                <tr data-id="${a.id}">
                    <td><input type="checkbox" class="recursive-row-checkbox" value="${a.id}"></td>
                    <td><strong>${personName}</strong></td>
                    <td><span class="badge badge-primary">${a.type}</span></td>
                    <td><span class="badge badge-info">${periodMap[a.period] || a.period}</span></td>
                    <td class="font-weight-bold text-success">${this._formatMoney(a.amount, a.currency)}</td>
                    <td>${a.start_date ? new Date(a.start_date).toLocaleDateString('tr-TR') : '-'}</td>
                    <td><span class="text-primary font-weight-bold">${a.next_trigger_date ? new Date(a.next_trigger_date).toLocaleDateString('tr-TR') : '-'}</span></td>
                    <td>${statusBadge}</td>
                    <td class="text-center">
                        <div class="dropdown">
                            <button class="btn btn-sm btn-light text-secondary rounded-circle" type="button" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;">
                                <i class="fas fa-ellipsis-v" style="pointer-events: none;"></i>
                            </button>
                            <div class="dropdown-menu dropdown-menu-right shadow-sm border-0 p-2" style="min-width: auto;">
                                <div class="d-flex justify-content-center align-items-center" style="gap: 5px;">
                                    <button class="btn btn-sm btn-light text-warning edit-recursive-btn" data-id="${a.id}" title="Düzenle">
                                        <i class="fas fa-edit" style="pointer-events: none;"></i>
                                    </button>
                                    <button class="btn btn-sm btn-light text-danger delete-recursive-btn" data-id="${a.id}" title="Sil">
                                        <i class="fas fa-trash-alt" style="pointer-events: none;"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        this.recursiveTableBody.innerHTML = html;
    }
}