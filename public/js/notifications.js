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
        this.searchQuery = ''; // 🔥 YENİ: Arama filtresi tutucu

        // DOM Elementlerini Cache'leme
        this.elements = {
            tableBody: document.getElementById("notifications-table-body"),
            loader: document.getElementById("loader"),
            tabBtns: document.querySelectorAll('.tab-btn'),
            overlayEl: document.getElementById('progressOverlay'),
            overlayMsg: document.getElementById('progressMessage'),
            searchInput: document.getElementById('notificationSearchInput'), // 🔥 YENİ: Arama inputu elementimiz
            
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
        this.currentAttachmentContext = null;
        this.currentAttachmentLoadError = null;
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

        // 🔥 YENİ: Klavyeden yazıldıkça arama motorunu tetikle
        if (this.elements.searchInput) {
            this.elements.searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.toLowerCase().trim();
                this.applyTabFilter(); // Yazıldıkça tabloyu anında filtreler
            });
        }

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

    async loadData() {
        this.toggleLoading(true);
        const { data, error } = await supabase
                .from('v_mail_notifications_list')
                .select('*')
                .order('created_at', { ascending: false });
        
        if (data && !error) {
            // 🔥 enrichment sildik, sadece datayı state'e atıyoruz.
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

        let baseList = []; 

        for (const n of this.allNotifications) {
            const tStatus = n.task_status ? n.task_status.trim() : null;
            const isWaitingForClient = ['awaiting_client_approval', 'client_approval_opened', 'awaiting-approval'].includes(tStatus);
            const isSent = n.status === 'sent';
            
            const subjectLower = (n.subject || '').toLocaleLowerCase('tr-TR');
            
            const isMonitoring = subjectLower.includes('sayılı bülten bildirimi');
            const isRenewal = subjectLower.includes('yenileme işlemi / talimat bekleniyor');

            if (this.activeTab === 'monitoring') {
                if (!isSent && isMonitoring) baseList.push(n);
            }
            else if (this.activeTab === 'renewal') {
                if (!isSent && !isMonitoring && isRenewal) baseList.push(n);
            }
            else if (this.activeTab === 'pending') {
                if (!isSent && !isMonitoring && !isRenewal) baseList.push(n);
            }
            else if (this.activeTab === 'reminders') {
                if (isSent && n.associated_task_id && isWaitingForClient) baseList.push(n);
            }
            else if (this.activeTab === 'sent') {
                if (isSent && (!n.associated_task_id || !isWaitingForClient)) baseList.push(n);
            }
        }

        if (this.searchQuery) {
            baseList = baseList.filter(n => {
                const subject = (n.subject || '').toLowerCase();
                const client = (n.client_name || '').toLowerCase();
                const appNo = (n.app_no || '').toLowerCase();
                const brandName = (n.brand_name || n.ip_record_title || '').toLowerCase();
                const typeText = (n.type_text || '').toLowerCase();
                
                return subject.includes(this.searchQuery) || 
                       client.includes(this.searchQuery) || 
                       appNo.includes(this.searchQuery) ||
                       brandName.includes(this.searchQuery) ||
                       typeText.includes(this.searchQuery);
            });
        }

        // 🔥 YENİ: Pending sekmesindeki aynı başvuru numaralarını gruplama (Tarihe göre sıralı)
        if (this.activeTab === 'pending') {
            const groups = {};
            baseList.forEach(n => {
                // Eğer başvuru numarası yoksa, kendine ait eşsiz bir grup anahtarı veriyoruz
                const key = (n.app_no && n.app_no.trim() !== '' && n.app_no.trim() !== '-') ? n.app_no : 'no_app_' + n.id;
                if (!groups[key]) groups[key] = { items: [], maxDate: 0 };
                groups[key].items.push(n);
                const d = new Date(n.created_at || 0).getTime();
                if (d > groups[key].maxDate) groups[key].maxDate = d;
            });
            
            // Grupları kendi içindeki EN YENİ bildirimin tarihine göre sırala
            const sortedGroupKeys = Object.keys(groups).sort((a, b) => groups[b].maxDate - groups[a].maxDate);
            
            const flatGroupedList = [];
            sortedGroupKeys.forEach(key => {
                // Grubun kendi içindeki bildirimleri de yeniden eskiye sırala
                groups[key].items.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
                flatGroupedList.push(...groups[key].items);
            });
            this.notificationsData = flatGroupedList;
        } else {
            this.notificationsData = baseList;
        }

        const dynamicCols = document.querySelectorAll('.dynamic-col');
        dynamicCols.forEach(col => {
            col.style.display = ['pending', 'monitoring', 'renewal'].includes(this.activeTab) ? 'none' : '';
        });

        if (this.pagination) {
            this.pagination.update(this.notificationsData.length);
            this.pagination.goToPage(1);
        }

        if (this.notificationsData.length === 0) {
            this.elements.tableBody.innerHTML = `<tr><td colspan="15" class="text-center text-muted p-4">Bu sekmede bildirim bulunamadı.</td></tr>`;
        } else {
            await this.renderCurrentPage();
        }
        
        this.toggleLoading(false);
    }

    async renderCurrentPage() {
        if (!this.pagination) return;
        this.elements.tableBody.innerHTML = "";
        const slice = this.pagination.getCurrentPageData(this.notificationsData || []);

        const isPendingGroup = ['pending', 'monitoring', 'renewal'].includes(this.activeTab);
        
        // 🔥 YENİ: Akordeon grupları takip etmek için değişken
        let currentGroupKey = null;

        slice.forEach((notification, index) => {
            const globalIndex = this.notificationsData.indexOf(notification);
            
            // 🔥 YENİ: Akordeon Başlığı Çizimi (Sadece pending sekmesinde ve 1'den fazla aynı app_no varsa)
            let safeGroupKey = null;
            let groupItemsCount = 0;
            
            if (this.activeTab === 'pending') {
                const key = (notification.app_no && notification.app_no.trim() !== '' && notification.app_no.trim() !== '-') ? notification.app_no : null;
                
                if (key) {
                    groupItemsCount = this.notificationsData.filter(n => n.app_no === key).length;
                    if (groupItemsCount > 1) {
                        safeGroupKey = key.replace(/[^a-zA-Z0-9]/g, '_'); // Class name için güvenli metin
                        
                        if (currentGroupKey !== key) {
                            currentGroupKey = key;
                            
                            const groupHeader = document.createElement('tr');
                            groupHeader.className = 'table-light group-header shadow-sm';
                            groupHeader.style.cursor = 'pointer';
                            groupHeader.innerHTML = `
                                <td colspan="15" class="text-left font-weight-bold text-dark" style="padding: 12px 15px; border-left: 4px solid #4e73df; background-color: #eaecf4;">
                                    <i class="fas fa-chevron-down mr-2 toggle-icon text-primary" style="transition: 0.3s; width: 15px;"></i> 
                                    <i class="fas fa-layer-group text-secondary mr-1"></i> ${key} Numaralı Başvuruya Ait Bekleyen Bildirimler
                                    <span class="badge bg-primary text-white ml-2" style="font-size: 0.85rem;">${groupItemsCount} Bildirim</span>
                                </td>
                            `;
                            
                            // Akordeon Tıklama Özelliği
                            groupHeader.onclick = () => {
                                const isCollapsed = groupHeader.classList.toggle('collapsed');
                                const icon = groupHeader.querySelector('.toggle-icon');
                                icon.style.transform = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
                                
                                const rows = document.querySelectorAll(`.group-row-${safeGroupKey}`);
                                rows.forEach(row => {
                                    row.style.display = isCollapsed ? 'none' : '';
                                });
                            };
                            
                            this.elements.tableBody.appendChild(groupHeader);
                        }
                    } else {
                        currentGroupKey = null; // Grupsuz bir elemana geçildi
                    }
                } else {
                    currentGroupKey = null;
                }
            }

            const tr = document.createElement('tr');
            
            // 🔥 YENİ: Eğer bir gruba aitse, akordeonun açıp kapatabilmesi için özel class ver
            if (groupItemsCount > 1 && safeGroupKey) {
                tr.classList.add(`group-row-${safeGroupKey}`);
                tr.style.backgroundColor = '#fafafa'; // Gruplanmış satırlar farklı görünsün diye hafif gri yapıldı
            }
            
            const statusMap = {
                'sent': 'Gönderildi', 
                'failed': 'Hata Oluştu', 
                'pending': 'Gönderime Hazır', 
                'missing_info': 'Eksik Bilgi', 
                'awaiting_client_approval': 'Gönderime Hazır',
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
            
            let dueDate = '-';
            if (notification.objection_deadline && notification.objection_deadline !== '-') {
                const d = new Date(notification.objection_deadline);
                dueDate = isNaN(d.getTime()) ? notification.objection_deadline : d.toLocaleDateString('tr-TR');
            }

            let finalSubject = notification.subject || '<span class="missing-field">Konu Eksik</span>';
            const brandName = notification.brand_name || notification.ip_record_title;
            
            if (brandName && finalSubject !== '<span class="missing-field">Konu Eksik</span>' && !finalSubject.includes(brandName)) {
                finalSubject = `<strong>${brandName}</strong> - ${finalSubject}`;
            }

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
                <td>${finalSubject}</td>
                <td>${appNo}</td>
                <td>${typeText}</td>
                <td class="attachment-cell" data-tx-id="${notification.associated_transaction_id || ''}" data-doc-id="${notification.source_document_id || ''}">
                    <span class="spinner-border spinner-border-sm text-primary" role="status" aria-hidden="true"></span>
                </td>
                <td>${dueDate}</td>
                ${!isPendingGroup ? `<td>${this.formatDate(notification.last_reminder_at)}</td>` : ''}
                <td><span class="badge bg-light text-dark border" title="Tetikleyen"><i class="fas fa-user mr-1"></i> ${notification.triggered_by_name || '-'}</span></td>
                ${!isPendingGroup ? `<td><span class="badge bg-success text-white" title="Gönderen"><i class="fas fa-paper-plane mr-1"></i> ${notification.sent_by_name || '-'}</span></td>` : ''}
                <td>${this.formatDate(notification.created_at)}</td>
                <td>${this.formatDate(notification.sent_at)}</td>
                <td class="actions-cell d-flex flex-column gap-2" style="gap: 5px;"></td>
            `;

            const actionCell = tr.querySelector('.actions-cell');
            
            const editBtn = document.createElement('button');
            editBtn.className = 'action-btn btn-sm btn-info w-100';
            editBtn.innerHTML = '<i class="fas fa-edit"></i> Düzenle';
            if (isEvalPending) { editBtn.disabled = true; editBtn.style.opacity = '0.5'; } 
            else { editBtn.onclick = () => this.openEditModal(notification); }
            actionCell.appendChild(editBtn);

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
                sendBtn.className = 'action-btn btn-sm btn-success w-100 send-btn'; 
                sendBtn.innerHTML = notification.status === 'failed' ? '<i class="fas fa-redo"></i> Tekrar Dene' : '<i class="fas fa-paper-plane"></i> Gönder';
                if (isEvalPending || notification.is_held) { sendBtn.disabled = true; sendBtn.style.opacity = '0.5'; }
                else { sendBtn.onclick = (e) => this.processAction(e, notification, 'send'); }
                actionCell.appendChild(sendBtn);
            }

            // SİL BUTONU EKLENTİSİ: Gönderilmiş mailler (sent) hariç hepsinde Sil butonu çıksın
            if (notification.status !== 'sent') {
                const deleteBtn = document.createElement('button');
                // btn-danger class'ı ile kırmızı renk veriyoruz
                deleteBtn.className = 'action-btn btn-sm btn-danger w-100 mt-1'; 
                deleteBtn.innerHTML = '<i class="fas fa-trash"></i> Sil';
                
                // Eğer mail beklemedeyse (is_held) silme butonunu da kilitlemek isterseniz:
                if (notification.is_held) { 
                    deleteBtn.disabled = true; 
                    deleteBtn.style.opacity = '0.5'; 
                } else { 
                    deleteBtn.onclick = () => this.handleDeleteMail(notification.id); 
                }
                
                actionCell.appendChild(deleteBtn);
            }

            this.elements.tableBody.appendChild(tr);
        });

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
            
            const { data: { session } } = await supabase.auth.getSession();
            const senderEmail = session?.user?.email || null;

            // Liste, düzenleme penceresi ve gönderim aynı kaynak / seçimi kullanır.
            // Dava işleri için Genel Belgeler'den gelen dosyalar hiçbir zaman
            // gönderilecek ekler listesine dahil edilmez.
            const attachmentContext = await this.getNotificationAttachmentContext(notification);
            const attachments = attachmentContext.attachments
                .filter(file => !attachmentContext.excludedUrls.has(file.url))
                .map(file => ({ name: file.name, url: file.url }));

            const payload = { 
                notificationId: notification.id,
                attachments: attachments,
                senderEmail: senderEmail 
            };
            
            if (!isSend) payload.mode = 'reminder';

            const { error } = await supabase.functions.invoke('process-mail-notification', { body: payload });
            if (error) throw error;
            
            alert(isSend ? "E-posta başarıyla gönderildi!" : "Hatırlatma e-postası başarıyla gönderildi.");
            await this.loadData(); 
            
        } catch (err) {
            alert("Hata oluştu: " + err.message); 
        } finally { 
            this.hideOverlay(); 
            btn.disabled = false; 
        }
    }

    // Sunucudaki gönderim kuralı ile aynı: dava işi yalnızca özel alana
    // yüklenmiş resmî PDF'yi kullanır. Diğer bildirimlerin davranışı korunur.
    async getNotificationAttachmentContext(notification) {
        const { data: mail, error: mailError } = await supabase
            .from('mail_notifications')
            .select('source, associated_task_id, excluded_attachment_urls')
            .eq('id', notification.id)
            .single();
        if (mailError || !mail) {
            throw new Error('Bildirim ek tercihleri okunamadı: ' + (mailError?.message || 'Kayıt bulunamadı'));
        }

        const litigationTypes = new Set([
            '49', '54', '55', '56', '57', '58', '59', '60',
            '61', '62', '63', '64', '65', '91', '93', '94', '96', '97'
        ]);
        const taskId = mail.associated_task_id || notification.associated_task_id;
        let taskType = '';
        if (taskId && ['litigation_task_completion', 'task_completion'].includes(mail.source)) {
            const { data: task, error: taskError } = await supabase
                .from('tasks')
                .select('task_type_id')
                .eq('id', String(taskId))
                .maybeSingle();
            if (taskError || !task) {
                throw new Error('İşe ait ekler doğrulanamadı: ' + (taskError?.message || 'İş bulunamadı'));
            }
            taskType = String(task.task_type_id || '');
        }
        const isLitigation = mail.source === 'litigation_task_completion' ||
            (mail.source === 'task_completion' && litigationTypes.has(taskType));
        const excludedUrls = new Set(Array.isArray(mail.excluded_attachment_urls)
            ? mail.excluded_attachment_urls.filter(url => typeof url === 'string') : []);
        let attachments = [];

        if (isLitigation) {
            if (!taskId || !taskType) {
                throw new Error('Dava işi ve resmî PDF alanı doğrulanamadı. Ekler gösterilmedi.');
            }
            const officialType = taskType === '49' ? 'epats_document' : 'court_filed_pdf';
            // Aynı alanın eski yükleme kayıtları farklı URL taşıyabilir.
            // Mailde birden fazla resmî PDF görünmemesi için en son
            // yüklenen kaydı tek yetkili ek olarak kabul et.
            const { data, error } = await supabase
                .from('task_documents')
                .select('document_name, document_url, uploaded_at, id')
                .eq('task_id', String(taskId))
                .eq('document_type', officialType)
                .not('document_url', 'is', null)
                .neq('document_url', '')
                .order('uploaded_at', { ascending: false, nullsFirst: false })
                .order('id', { ascending: false })
                .limit(1);
            if (error) throw new Error('Mahkemeye sunulan PDF okunamadı: ' + error.message);
            attachments = (data || []).map(doc => ({
                name: doc.document_name || 'Mahkemeye_Sunulan_PDF.pdf',
                url: doc.document_url
            }));
        } else {
            const { data, error } = await supabase
                .from('mail_attachments')
                .select('file_name, url')
                .eq('notification_id', notification.id);
            if (error) throw new Error('Bildirim ekleri okunamadı: ' + error.message);
            if (data?.length) {
                attachments = data.map(doc => ({ name: doc.file_name || 'Ek', url: doc.url }));
            } else {
                // Sadece dava dışı ve eski bildirimler için mevcut fallback.
                const resolved = await attachmentService.resolveAttachments(
                    notification.associated_transaction_id,
                    notification.source_document_id,
                    taskId
                );
                attachments = (resolved || []).map(doc => ({ name: doc.name || 'Ek', url: doc.url }));
            }
        }
        const seen = new Set();
        attachments = attachments.filter(doc => {
            if (!doc.url || seen.has(doc.url)) return false;
            seen.add(doc.url);
            return true;
        });
        return { attachments, excludedUrls, isLitigation };
    }

    // Kaydedilene kadar seçim yalnızca modal durumundadır. Kaydet ile
    // mail_notifications.excluded_attachment_urls alanına yazılır.
    async renderEditableAttachments(notification) {
        let block = document.getElementById('modal-attachments-block');
        if (!block) {
            block = document.createElement('section');
            block.id = 'modal-attachments-block';
            block.className = 'mt-3 mb-2 p-3 rounded border bg-light';
            const modalBody = this.elements.editModal?.querySelector('.modal-body');
            if (!modalBody) throw new Error('Bildirim düzenleme penceresi bulunamadı.');
            modalBody.prepend(block);
        }
        block.replaceChildren();
        const heading = document.createElement('h6');
        heading.className = 'font-weight-bold mb-2';
        heading.textContent = '📎 E-posta Ekleri';
        block.appendChild(heading);
        const help = document.createElement('p');
        help.className = 'small text-muted mb-2';
        help.textContent = 'İşareti kaldırdığınız dosya bu bildirime eklenmez. Dava dosyasındaki asıl belge silinmez.';
        block.appendChild(help);
        this.currentAttachmentLoadError = null;
        this.currentAttachmentContext = null;
        try {
            const context = await this.getNotificationAttachmentContext(notification);
            // Önceki modalın gecikmiş yanıtı yeni bildirime yazılmasın.
            if (this.currentEditNotification?.id !== notification.id) return;
            this.currentAttachmentContext = context;
            if (context.isLitigation) {
                const note = document.createElement('p');
                note.className = 'small text-primary mb-2';
                note.textContent = 'Dava işleri: Yalnızca “Mahkemeye Sunulan Dava Dilekçesi / Tevzi PDF” alanının resmî PDF ekleri listelenir.';
                block.appendChild(note);
            }
            if (!context.attachments.length) {
                const empty = document.createElement('div');
                empty.className = 'text-muted small';
                empty.textContent = 'Gönderilebilir ek bulunmuyor.';
                block.appendChild(empty);
            }
            for (const doc of context.attachments) {
                const row = document.createElement('div');
                row.className = 'd-flex align-items-center py-2 border-top';
                row.style.gap = '10px';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'notification-attachment-checkbox';
                checkbox.value = doc.url;
                checkbox.checked = !context.excludedUrls.has(doc.url);
                checkbox.disabled = notification.status === 'sent';
                checkbox.setAttribute('aria-label', doc.name + ' gönderilsin');
                row.appendChild(checkbox);
                const link = document.createElement('a');
                link.className = 'text-break';
                link.textContent = doc.name;
                if (/^https?:\/\//i.test(doc.url)) {
                    link.href = doc.url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                }
                row.appendChild(link);
                block.appendChild(row);
            }
        } catch (error) {
            if (this.currentEditNotification?.id !== notification.id) return;
            this.currentAttachmentLoadError = error;
            const warning = document.createElement('div');
            warning.className = 'text-danger small';
            warning.textContent = 'Ekler alınamadı: ' + error.message + '. Bu bildirim ek tercihi doğrulanmadan kaydedilemez.';
            block.appendChild(warning);
        }
    }

    // --- MODAL (DÜZENLEME & EKSİK) YÖNETİMİ ---
    async openEditModal(notification) {
        this.currentEditNotification = notification;
        this.elements.editSubject.value = notification.subject || "";
        
        // 🔥 ÇÖZÜM: View içinde 'body' olmadığı için modal açıldığında anlık olarak çekiyoruz
        let mailBody = "";
        try {
            this.showOverlay('İçerik yükleniyor...');
            const { data, error } = await supabase.from('mail_notifications').select('body').eq('id', notification.id).single();
            if (data && !error) mailBody = data.body || "";
        } catch (err) {
            console.error("Mail içeriği alınamadı:", err);
        } finally {
            this.hideOverlay();
        }

        if (tinymce.get("modal-body")) tinymce.get("modal-body").remove();
        
        tinymce.init({
            selector: "#modal-body", height: 400, menubar: false, plugins: "link lists",
            toolbar: "undo redo | bold italic underline | bullist numlist | link", branding: false, language: "tr",
            setup: (editor) => {
                editor.on("init", () => {
                    editor.setContent(mailBody); // Çekilen datayı editöre basıyoruz
                    this.elements.editModal.style.display = "flex";
                });
            }
        });

        const { toList, ccList } = this.getToCc(notification);
        this.currentTo = [...toList]; 
        this.currentCc = [...ccList];
        
        this.renderChips();
        await this.renderEditableAttachments(notification);
    }

    closeEditModal() {
        this.elements.editModal.style.display = "none";
        this.currentEditNotification = null;
        this.currentAttachmentContext = null;
        this.currentAttachmentLoadError = null;
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
            
            if (this.currentAttachmentLoadError || !this.currentAttachmentContext) {
                throw this.currentAttachmentLoadError || new Error('Ekler henüz yüklenmedi.');
            }
            // Eğer kullanıcı inputa bir şey yazıp Enter'a basmadan "Kaydet"e bastıysa onları da yakala
            if (this.elements.toInput.value.trim()) this.addEmailToChip(this.elements.toInput, this.currentTo);
            if (this.elements.ccInput.value.trim()) this.addEmailToChip(this.elements.ccInput, this.currentCc);

            const missing = [];
            if (this.currentTo.length === 0) missing.push("to_list"); // Sadece To alanına bakar, CC boş olabilir.
            
            let newStatus = 'pending';
            if (missing.length > 0) {
                newStatus = 'missing_info';
            } else if (this.currentEditNotification.status === 'awaiting_client_approval' || this.currentEditNotification.status === 'evaluation_pending') {
                // Eğer statü zaten onay bekliyor ise veya değerlemedeyse, "pending" statüsüne düşürmemek için orijinali koru
                newStatus = this.currentEditNotification.status;
            }

            const updatePayload = {
                subject: this.elements.editSubject.value.trim(),
                body: tinymce.get("modal-body").getContent(),
                to_list: this.currentTo,
                cc_list: this.currentCc,
                status: newStatus,
                missing_fields: missing,
                is_draft: missing.length > 0
            };
            if (this.currentEditNotification.status !== 'sent') {
                // Hiçbiri işaretli değilse tümü çıkarılır; kaynak belgeler silinmez.
                updatePayload.excluded_attachment_urls = Array.from(
                    document.querySelectorAll('#modal-attachments-block .notification-attachment-checkbox')
                ).filter(input => !input.checked).map(input => input.value);
            }

            const { error } = await supabase.from("mail_notifications").update(updatePayload).eq('id', this.currentEditNotification.id);
            if (error) throw error;

            this.closeEditModal();
            alert("Bildirim başarıyla güncellendi.");
            
            // 🔥 ÇÖZÜM: Realtime dinleyicisinin gecikmesine ihtimal vermemek için, 
            // modal kapandığı anda veritabanından en güncel listeyi çekip arayüzü yeniliyoruz!
            await this.loadData();
            
        } catch (err) { 
            alert("Hata: " + err.message); 
        } finally { 
            this.hideOverlay(); 
        }
    }

    async handleDeleteMail(mailId) {
        // 1. Teyit sorusu
        const isConfirmed = window.confirm("Bu mail taslağını silmek istediğinize emin misiniz? Bu işlem geri alınamaz.");
        if (!isConfirmed) return;

        try {
            this.showOverlay('Siliniyor...');
            
            // 2. Aktif kullanıcıyı al (Silen kişiyi kaydetmek için)
            const { data: { session } } = await supabase.auth.getSession();
            const userId = session?.user?.id;

            // 3. Veritabanı güncellemesi (Soft Delete)
            const { error } = await supabase
                .from('mail_notifications')
                .update({ 
                    status: 'cancelled', // Gönderilmekten vazgeçildiğini belirtmek için
                    deleted_at: new Date().toISOString(), 
                    deleted_by: userId 
                })
                .eq('id', mailId);

            if (error) throw error;

            alert("Mail başarıyla silindi.");
            
            // 4. Tabloyu yenile (Silinen mail view'dan düşeceği için ekrandan kaybolur)
            await this.loadData(); 
            
        } catch (err) {
            console.error("Silme hatası:", err);
            alert("Silme işlemi sırasında bir hata oluştu: " + err.message);
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

    loadAttachmentsForCells() {
        const cells = document.querySelectorAll('.attachment-cell:not(.loaded)');
        cells.forEach(async (cell) => {
            cell.classList.add('loaded');
            const notificationId = cell.closest('tr')?.querySelector('.hold-checkbox')?.dataset?.id;
            const notification = this.allNotifications.find(row => row.id === notificationId);
            if (!notification) {
                cell.textContent = '-';
                return;
            }
            try {
                // Liste ile gerçek gönderim aynı filtreyi kullanır.
                const context = await this.getNotificationAttachmentContext(notification);
                const selected = context.attachments.filter(doc => !context.excludedUrls.has(doc.url));
                cell.replaceChildren();
                if (!selected.length) {
                    cell.textContent = '-';
                } else {
                    selected.forEach((doc, index) => {
                        if (index) cell.appendChild(document.createElement('br'));
                        const link = document.createElement('a');
                        link.className = 'link text-truncate d-inline-block';
                        link.style.maxWidth = '200px';
                        link.title = doc.name;
                        link.textContent = '📎 ' + doc.name;
                        if (/^https?:\/\//i.test(doc.url)) {
                            link.href = doc.url;
                            link.target = '_blank';
                            link.rel = 'noopener noreferrer';
                        }
                        cell.appendChild(link);
                    });
                }
                const omittedCount = context.attachments.length - selected.length;
                if (omittedCount) {
                    const note = document.createElement('div');
                    note.className = 'small text-muted';
                    note.textContent = omittedCount + ' ek gönderimden çıkarıldı';
                    cell.appendChild(note);
                }
            } catch (error) {
                cell.textContent = 'Ekler doğrulanamadı';
                cell.title = error.message;
                cell.classList.add('text-danger');
            }
        });
    }
    
}

// Uygulamayı Başlat
const app = new NotificationsManager();
document.addEventListener('DOMContentLoaded', () => app.init());