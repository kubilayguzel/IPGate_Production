// public/js/notifications.js
import { supabase, attachmentService } from "../supabase-config.js";
import { loadSharedLayout } from "./layout-loader.js";
import Pagination from "./pagination.js";

class NotificationsManager {
    constructor() {
        this.allNotifications = [];
        this.notificationsData = [];
        this.activeTab = 'pending';
        this.pagination = null;
        this.realtimeChannel = null;

        // DOM Elementlerini Cache'leme
        this.elements = {
            tableBody: document.getElementById("notifications-table-body"),
            loader: document.getElementById("loader"),
            tabBtns: document.querySelectorAll('.tab-btn'),
            overlayEl: document.getElementById('progressOverlay'),
            overlayMsg: document.getElementById('progressMessage'),
            
            // Edit Modal Elements
            editModal: document.getElementById("notification-modal"),
            editSubject: document.getElementById("modal-subject"),
            toInput: document.getElementById("modal-to-input"),
            ccInput: document.getElementById("modal-cc-input"),
            toContainer: document.getElementById("modal-to"),
            ccContainer: document.getElementById("modal-cc"),
            saveDraftBtn: document.getElementById("save-draft"),
            closeEditModalBtns: [document.getElementById("close-modal-btn"), document.getElementById("close-modal")],
            
            // Missing Info Modal Elements
            missingModal: document.getElementById("missing-info-modal"),
            missingAppNo: document.getElementById("mi-application-no"),
            missingList: document.getElementById("mi-missing-list"),
            missingEditBtn: document.getElementById("mi-edit"),
            closeMissingModalBtns: [document.getElementById("mi-close"), document.getElementById("mi-close-btn")]
        };

        // Edit Modal Geçici Durumları
        this.currentEditNotification = null;
        this.currentTo = [];
        this.currentCc = [];
    }

    async init() {
        // Oturum kontrolü
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            window.location.href = "index.html";
            return;
        }

        // İskeleti yükle ve olayları bağla
        loadSharedLayout({ activeMenuLink: "notifications.html" });
        this.bindEvents();
        this.initRealtimeListener();
    }

    // --- OLAY (EVENT) DİNLEYİCİLERİ ---
    bindEvents() {
        // Tab Butonları
        this.elements.tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => this.switchTab(e.currentTarget.dataset.tab));
        });

        // Modal Kapatma Butonları
        this.elements.closeEditModalBtns.forEach(btn => {
            if(btn) btn.addEventListener('click', () => this.closeEditModal());
        });
        
        this.elements.closeMissingModalBtns.forEach(btn => {
            if(btn) btn.addEventListener('click', () => this.elements.missingModal.style.display = "none");
        });

        // Edit Modal - To/Cc Input Enter Eventleri
        this.elements.toInput.addEventListener('keydown', (e) => {
            if (['Enter', ',', ';'].includes(e.key)) {
                e.preventDefault();
                this.addEmailToChip(this.elements.toInput, this.currentTo);
            }
        });

        this.elements.ccInput.addEventListener('keydown', (e) => {
            if (['Enter', ',', ';'].includes(e.key)) {
                e.preventDefault();
                this.addEmailToChip(this.elements.ccInput, this.currentCc);
            }
        });

        // Kaydet Butonu
        this.elements.saveDraftBtn.addEventListener('click', () => this.saveDraft());
    }

    // --- VERİ ÇEKME & DİNLEME ---
    async loadData() {
        this.toggleLoading(true);
        // 🔥 YENİ: Artık View (Sanal Tablo) üzerinden şimşek hızında çekiyoruz
        const { data, error } = await supabase
                .from('v_mail_notifications_list')
                .select('*')
                .order('created_at', { ascending: false });
        
        if (data && !error) {
            this.allNotifications = data; 
            if (!this.pagination) {
                this.pagination = new Pagination({
                    containerId: "paginationContainer", itemsPerPage: 20, maxVisiblePages: 7,
                    showFirstLast: true, showPrevNext: true, showPageInfo: true,
                    onPageChange: () => this.renderCurrentPage()
                });
            }
            await this.applyTabFilter();
        }
        this.toggleLoading(false);
    }

    initRealtimeListener() {
        this.loadData();
        if (this.realtimeChannel) supabase.removeChannel(this.realtimeChannel);
        
        this.realtimeChannel = supabase.channel('mail_notifications_changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'mail_notifications' }, () => this.loadData())
            .subscribe();
    }

    // --- TAB KONTROLLERİ ---
    async switchTab(tabName) {
        this.activeTab = tabName;
        this.elements.tabBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        await this.applyTabFilter();
    }

    async applyTabFilter() {
        this.toggleLoading(true);
        this.elements.tableBody.innerHTML = "";

        if (this.activeTab === 'pending') {
            this.notificationsData = this.allNotifications.filter(n => n.status !== 'sent');
        } else {
            const sentList = this.allNotifications.filter(n => n.status === 'sent');
            let filtered = [];
            
            for (const n of sentList) {
                let tStatus = null;
                if (n.associated_task_id) {
                    const { data: task } = await supabase.from('tasks').select('status').eq('id', n.associated_task_id).single();
                    tStatus = task?.status;
                }
                
                if (this.activeTab === 'reminders' && n.associated_task_id && tStatus === 'awaiting_client_approval') filtered.push(n);
                if (this.activeTab === 'sent' && (!n.associated_task_id || tStatus !== 'awaiting_client_approval')) filtered.push(n);
            }
            this.notificationsData = filtered;
        }

        if (this.pagination) {
            this.pagination.update(this.notificationsData.length);
            this.pagination.goToPage(1);
        }

        if (this.notificationsData.length === 0) {
            this.elements.tableBody.innerHTML = `<tr><td colspan="11" class="no-records">Bu sekmede bildirim bulunamadı.</td></tr>`;
        } else {
            await this.renderCurrentPage();
        }
        this.toggleLoading(false);
    }

    // --- RENDER (EKRANA BASMA) İŞLEMLERİ ---
    async renderCurrentPage() {
        if (!this.pagination) return;
        this.elements.tableBody.innerHTML = "";
        const slice = this.pagination.getCurrentPageData(this.notificationsData || []);

        // 🔥 BURAYI SİLİN: (Artık startIndex hesabına gerek yok)
        // const startIndex = (this.pagination.currentPage - 1) * this.pagination.itemsPerPage;

        slice.forEach((notification, index) => {
            // 🔥 YENİ: Verinin ana listedeki gerçek sırasını buluyoruz
            const globalIndex = this.notificationsData.indexOf(notification);
            
            const tr = document.createElement('tr');
            
            const statusMap = {
                'sent': 'Gönderildi', 'failed': 'Hata Oluştu', 'pending': 'Bekliyor',
                'missing_info': 'Eksik Bilgi', 'awaiting_client_approval': 'Onay Bekliyor',
                'evaluation_pending': 'Değerlendirme Bekliyor'
            };

            let statusClass = 'status-pending';
            if (notification.status === 'sent') statusClass = 'status-sent';
            if (notification.status === 'failed') statusClass = 'status-failed';
            if (notification.status === 'missing_info') statusClass = 'missing-info';

            const isEvalPending = notification.status === 'evaluation_pending';
            
            const rowOpacity = notification.is_held ? '0.5' : '1';
            tr.style.opacity = rowOpacity;

            const appNo = notification.app_no || '-';
            const clientName = notification.client_name || '-';
            const typeText = notification.type_text || notification.associated_transaction_id || '-';
            const dueDate = this.formatDate(notification.objection_deadline) || '-';

            tr.innerHTML = `
                <td><strong>${globalIndex + 1}</strong></td>
                <td>
                    <div class="form-check form-switch">
                        <input class="form-check-input hold-checkbox" type="checkbox" style="cursor:pointer; width:35px; height:18px;"
                               data-id="${notification.id}" 
                               ${notification.is_held ? 'checked' : ''}>
                    </div>
                </td>
                <td><span class="status-badge ${statusClass}">${statusMap[notification.status] || notification.status}</span></td>
                <td>${clientName}</td>
                <td>${notification.subject || '<span class="missing-field">Konu Eksik</span>'}</td>
                <td>${appNo}</td>
                <td>${typeText}</td>
                <td class="attachment-cell" data-tx-id="${notification.associated_transaction_id || ''}" data-doc-id="${notification.source_document_id || ''}">
                    <span class="spinner-border spinner-border-sm text-primary" role="status" aria-hidden="true"></span>
                </td>
                <td>${dueDate}</td>
                <td>${this.formatDate(notification.last_reminder_at)}</td>
                <td>${this.formatDate(notification.created_at)}</td>
                <td>${this.formatDate(notification.sent_at)}</td>
                <td class="actions-cell d-flex flex-column gap-2" style="gap: 5px;"></td>
            `;

            const actionCell = tr.querySelector('.actions-cell');
            
            // Düzenle Butonu
            const editBtn = document.createElement('button');
            editBtn.className = 'action-btn btn-sm btn-info w-100';
            editBtn.innerHTML = '<i class="fas fa-edit"></i> Düzenle';
            if (isEvalPending) { editBtn.disabled = true; editBtn.style.opacity = '0.5'; } 
            else { editBtn.onclick = () => this.openEditModal(notification); }
            actionCell.appendChild(editBtn);

            // Aksiyon Butonları
            if (notification.status === 'missing_info') {
                const miBtn = document.createElement('button');
                miBtn.className = 'action-btn btn-sm btn-warning text-dark w-100'; 
                miBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Eksikler';
                miBtn.onclick = () => this.showMissingInfo(notification, appNo);
                actionCell.appendChild(miBtn);
            } else if (notification.status === 'sent') {
                const remBtn = document.createElement('button');
                remBtn.className = 'action-btn btn-sm action-btn-remind w-100'; 
                remBtn.innerHTML = '<i class="fas fa-bell"></i> Hatırlat';
                remBtn.onclick = (e) => this.processAction(e, notification, 'reminder');
                actionCell.appendChild(remBtn);
            } else {
                const sendBtn = document.createElement('button');
                sendBtn.className = 'action-btn btn-sm btn-success w-100 send-btn'; // send-btn classı eklendi
                sendBtn.innerHTML = notification.status === 'failed' ? '<i class="fas fa-redo"></i> Tekrar Dene' : '<i class="fas fa-paper-plane"></i> Gönder';
                // 🔥 YENİ: Eğer bekletiliyorsa butonu kilitle
                if (isEvalPending || notification.is_held) { sendBtn.disabled = true; sendBtn.style.opacity = '0.5'; }
                else { sendBtn.onclick = (e) => this.processAction(e, notification, 'send'); }
                actionCell.appendChild(sendBtn);
            }

            this.elements.tableBody.appendChild(tr);
        });

        // Satırlar eklendikten sonra Beklet checkbox olaylarını bağla
        this.setupHoldCheckboxes();
        this.loadAttachmentsForCells();
    }

    formatDate(dateStr) {
        if (!dateStr) return '-';
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? '-' : d.toLocaleString('tr-TR');
    }

    getToCc(notification) {
        return { 
            toList: Array.isArray(notification.to_list) ? notification.to_list : [], 
            ccList: Array.isArray(notification.cc_list) ? notification.cc_list : [] 
        };
    }

    // --- AKSİYONLAR (GÖNDERİM & HATIRLATMA) ---
    async processAction(e, notification, actionType) {
        const btn = e.currentTarget;
        const isSend = actionType === 'send';
        
        if (isSend) {
            const { toList } = this.getToCc(notification);
            if (!toList || toList.length === 0) {
                alert("HATA: 'Kime' (To) alanı boş. Sadece CC ile gönderim yapılamaz.\nLütfen 'Düzenle' butonuna basarak alıcı ekleyin.");
                return; 
            }
        }

        const confirmMsg = isSend ? "E-postayı müvekkile göndermek istediğinize emin misiniz?" : "Hatırlatma göndermek istediğinize emin misiniz?";
        if(!confirm(confirmMsg)) return;

        try {
            btn.disabled = true;
            this.showOverlay(isSend ? 'E-posta gönderiliyor...' : 'Hatırlatma gönderiliyor...');
            
            // 🔥 YENİ: Göndermeden hemen önce evrakları merkezi servisten çekiyoruz!
            const attachments = await attachmentService.resolveAttachments(
                notification.associated_transaction_id, 
                notification.source_document_id
            );

            const payload = { 
                notificationId: notification.id,
                attachments: attachments // Backend'e evrak URL'leri gidiyor
            };
            if (!isSend) payload.mode = 'reminder';

            const { error } = await supabase.functions.invoke('process-mail-notification', { body: payload });
            if (error) throw error;
            
            alert(isSend ? "E-posta başarıyla gönderildi!" : "Hatırlatma e-postası başarıyla gönderildi.");
            // Tablonun otomatik yenilenmesi Supabase realtime servisi tarafından yapılacak.
        } catch (err) { 
            alert("Hata oluştu: " + err.message); 
        } finally { 
            this.hideOverlay(); 
            btn.disabled = false; 
        }
    }

    // --- MODAL (DÜZENLEME & EKSİK) YÖNETİMİ ---
    openEditModal(notification) {
        this.currentEditNotification = notification;
        this.elements.editSubject.value = notification.subject || "";
        
        if (tinymce.get("modal-body")) tinymce.get("modal-body").remove();
        
        tinymce.init({
            selector: "#modal-body", height: 400, menubar: false, plugins: "link lists",
            toolbar: "undo redo | bold italic underline | bullist numlist | link", branding: false, language: "tr",
            setup: (editor) => {
                editor.on("init", () => {
                    editor.setContent(notification.body || "");
                    this.elements.editModal.style.display = "flex";
                });
            }
        });

        const { toList, ccList } = this.getToCc(notification);
        this.currentTo = [...toList]; 
        this.currentCc = [...ccList];
        
        this.renderChips();
    }

    closeEditModal() {
        this.elements.editModal.style.display = "none";
        this.currentEditNotification = null;
    }

    addEmailToChip(inputEl, targetArray) {
        const val = inputEl.value.trim();
        if (val && !targetArray.includes(val)) { 
            targetArray.push(val); 
            inputEl.value = ''; 
            this.renderChips(); 
        }
    }

    renderChips() {
        const createChip = (v, cls, arrayRef) => {
            const span = document.createElement('span');
            span.className = `badge ${cls}`;
            span.innerHTML = `${v} <span class="x" style="cursor:pointer;margin-left:5px">×</span>`;
            span.querySelector('.x').onclick = () => {
                const index = arrayRef.indexOf(v);
                if (index > -1) arrayRef.splice(index, 1);
                this.renderChips();
            };
            return span;
        };

        this.elements.toContainer.innerHTML = '';
        this.elements.ccContainer.innerHTML = '';

        if (this.currentTo.length === 0) {
            this.elements.toContainer.innerHTML = '<span class="badge badge-empty">—</span>';
        } else {
            this.currentTo.forEach(v => this.elements.toContainer.appendChild(createChip(v, 'badge-to', this.currentTo)));
        }

        if (this.currentCc.length === 0) {
            this.elements.ccContainer.innerHTML = '<span class="badge badge-empty">—</span>';
        } else {
            this.currentCc.forEach(v => this.elements.ccContainer.appendChild(createChip(v, 'badge-cc', this.currentCc)));
        }
    }

    async saveDraft() {
        try {
            this.showOverlay('Kaydediliyor...');
            
            // Eğer kullanıcı inputa bir şey yazıp Enter'a basmadan "Kaydet"e bastıysa onları da yakala
            if (this.elements.toInput.value.trim()) this.addEmailToChip(this.elements.toInput, this.currentTo);
            if (this.elements.ccInput.value.trim()) this.addEmailToChip(this.elements.ccInput, this.currentCc);

            const missing = [];
            if (this.currentTo.length === 0) missing.push("to_list");
            const newStatus = missing.length > 0 ? 'missing_info' : 'pending';

            const updatePayload = {
                subject: this.elements.editSubject.value.trim(),
                body: tinymce.get("modal-body").getContent(),
                to_list: this.currentTo,
                cc_list: this.currentCc,
                status: newStatus,
                missing_fields: missing,
                is_draft: missing.length > 0
            };

            const { error } = await supabase.from("mail_notifications").update(updatePayload).eq('id', this.currentEditNotification.id);
            if (error) throw error;

            this.closeEditModal();
            alert("Bildirim başarıyla güncellendi.");
            // Tabloyu realtime listener otomatik güncelleyecektir, manuel tetiklemeye gerek yok.
        } catch (err) { 
            alert("Hata: " + err.message); 
        } finally { 
            this.hideOverlay(); 
        }
    }

    showMissingInfo(notification, appNo) {
        this.elements.missingAppNo.textContent = appNo || "—";
        this.elements.missingList.innerHTML = "";
        
        const fields = notification.missing_fields || [];
        if (fields.length) {
            fields.forEach(f => {
                let fieldName = f === 'to_list' ? "'Kime' (Alıcı) E-posta Adresi" : f;
                this.elements.missingList.innerHTML += `<li>${fieldName}</li>`;
            });
        } else {
            this.elements.missingList.innerHTML = `<li>Detay yok. Lütfen 'Düzenle'ye basarak eksikleri tamamlayın.</li>`;
        }
        
        this.elements.missingModal.style.display = "flex";
        
        this.elements.missingEditBtn.onclick = () => { 
            this.elements.missingModal.style.display = "none"; 
            this.openEditModal(notification); 
        };
    }

    // --- YARDIMCI UI FONKSİYONLARI ---
    showOverlay(message) {
        if (this.elements.overlayMsg) this.elements.overlayMsg.textContent = message;
        if (this.elements.overlayEl) this.elements.overlayEl.style.display = 'flex';
    }

    hideOverlay() {
        if (this.elements.overlayEl) this.elements.overlayEl.style.display = 'none';
    }

    toggleLoading(show) {
        if (this.elements.loader) this.elements.loader.style.display = show ? 'block' : 'none';
    }

    setupHoldCheckboxes() {
        document.querySelectorAll('.hold-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', async (e) => {
                const id = e.target.dataset.id;
                const isHeld = e.target.checked;
                const tr = e.target.closest('tr');
                
                try {
                    // Veritabanını güncelle (Sadece mail_notifications tablosunu güncelleriz, view otomatik güncellenir)
                    const { error } = await supabase
                        .from('mail_notifications')
                        .update({ is_held: isHeld })
                        .eq('id', id);
                        
                    if (error) throw error;

                    // Arayüzü anlık güncelle (Satırı soluklaştır ve Gönder butonunu kilitle)
                    tr.style.opacity = isHeld ? '0.5' : '1';
                    
                    const sendBtn = tr.querySelector('.send-btn');
                    if (sendBtn) {
                        sendBtn.disabled = isHeld;
                    }
                    
                    // Gönderilmiş veya diğer butonlar varsa onları da kilitleyebilirsiniz
                } catch (err) {
                    console.error("Bekletme durumu güncellenemedi:", err);
                    alert("Durum güncellenirken hata oluştu.");
                    e.target.checked = !isHeld; // Hata olursa checkbox'ı eski haline al
                }
            });
        });
    }
    // 🔥 YENİ EKLENEN METOD: Evrakları Listeye Asenkron (Gecikmeli) Yükler
    loadAttachmentsForCells() {
        // Henüz yüklenmemiş hücreleri bul
        const cells = document.querySelectorAll('.attachment-cell:not(.loaded)');
        
        cells.forEach(cell => {
            cell.classList.add('loaded'); // Çift yüklemeyi engelle
            const txId = cell.dataset.txId;
            const docId = cell.dataset.docId;
            
            if (!txId && !docId) {
                cell.innerHTML = '-';
                return;
            }

            // Arka planda evrakları çek
            attachmentService.resolveAttachments(txId, docId)
                .then(attachments => {
                    if (attachments && attachments.length > 0) {
                        cell.innerHTML = attachments.map(a => 
                            `<a class="link text-truncate d-inline-block" style="max-width: 200px;" href="${a.url}" target="_blank" title="${a.name}">
                                <i class="fas fa-paperclip"></i> ${a.name}
                            </a>`
                        ).join('<br>');
                    } else {
                        cell.innerHTML = '-';
                    }
                })
                .catch(err => {
                    cell.innerHTML = '<i class="fas fa-exclamation-triangle text-warning" title="Yüklenemedi"></i>';
                });
        });
    }
}

// Uygulamayı Başlat
const app = new NotificationsManager();
document.addEventListener('DOMContentLoaded', () => app.init());