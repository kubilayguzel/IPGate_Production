// public/js/task-management/triggered-tasks.js

import { authService, taskService, ipRecordsService, accrualService, personService, transactionTypeService, supabase } from '../../supabase-config.js';
import { showNotification, TASK_STATUS_MAP, formatToTRDate } from '../../utils.js';
import { loadSharedLayout } from '../layout-loader.js';

// --- ORTAK MODÜLLER ---
import Pagination from '../pagination.js';
import { AccrualFormManager } from '../components/AccrualFormManager.js';
import { TaskDetailManager } from '../components/TaskDetailManager.js';

document.addEventListener('DOMContentLoaded', async () => {
    await loadSharedLayout({ activeMenuLink: 'triggered-tasks.html' });

    class TriggeredTasksModule {
        constructor() {
            this.currentUser = null;
            
            this.allTasks = [];
            this.allTransactionTypes = [];

            this.processedData = [];
            this.filteredData = [];
            this.sortState = { key: 'officialDueObj', direction: 'asc' };
            this.pagination = null;

            this.currentTaskForAccrual = null;
            this.currentTaskForStatusChange = null;

            // YENİ: State Yöneticileri
            this.activeTab = 'general'; // 'general' veya 'opposition'
            this.selectedTaskIds = new Set();

            this.taskDetailManager = null;
            this.accrualFormManager = null;
            this.statusDisplayMap = TASK_STATUS_MAP;
            // Çekilecek statüler
            this.triggeredTaskStatuses = ['awaiting_client_approval', 'client_approval_opened', 'client_approval_closed', 'client_no_response_closed'];
        }

        async init() {
            this.initializePagination();
            this.setupStaticEventListeners();

            this.taskDetailManager = new TaskDetailManager('modalBody');
            this.accrualFormManager = new AccrualFormManager('accrualFormContainer', 'triggeredAccrual');

            const session = await authService.getCurrentSession();
            if (session) {
                const { data: profile } = await supabase.from('users').select('*').eq('id', session.user.id).single();
                this.currentUser = { ...session.user, ...(profile || {}), uid: session.user.id };
                this.loadAllData();
            } else {
                window.location.href = '/index.html';
            }
        }

        initializePagination() {
            if (typeof Pagination !== 'undefined') {
                this.pagination = new Pagination({
                    containerId: 'paginationContainer',
                    itemsPerPage: 10,
                    itemsPerPageOptions: [10, 25, 50, 100],
                    onPageChange: async () => {
                        this.renderTable();
                    }
                });
            }
        }

        async loadAllData() {
            const loader = document.getElementById('loadingIndicator');
            if (loader) loader.style.display = 'block';

            try {
                const isManager = ['superadmin', 'admin'].includes(this.currentUser?.role);
                const queryUid = isManager ? null : this.currentUser.uid;
                
                // 🔥 ÇÖZÜM 1: Işık hızında yükleme için yeni View kullanılıyor!
                let query = supabase.from('v_tasks_expanded')
                                    .select('*')
                                    .in('status', this.triggeredTaskStatuses);
                
                if (!isManager) {
                    query = query.eq('assigned_to', queryUid);
                }

                const [tasksResult, transTypesResult] = await Promise.all([
                    query,
                    transactionTypeService.getTransactionTypes()
                ]);

                // Gelen düz veriyi arayüzün anladığı formata haritalıyoruz
                this.allTasks = tasksResult.data ? tasksResult.data.map(t => {
                    const d = t.details || {};
                    return {
                        ...t,
                        taskType: t.task_type_id,
                        dueDate: t.operational_due_date || t.official_due_date,
                        officialDueDate: t.official_due_date,
                        operationalDueDate: t.operational_due_date,
                        assignedTo_uid: t.assigned_to,
                        transactionId: t.transaction_id,
                        history: d.history || [],
                        documents: d.documents || []
                    };
                }) : [];

                this.allTransactionTypes = transTypesResult.success ? transTypesResult.data : [];

                this.processData(); 

            } catch (error) {
                console.error("Yükleme Hatası:", error);
            } finally {
                if (loader) loader.style.display = 'none';
            }
        }

        processData(preservePage = false) {
            const transTypeMap = new Map();
            this.allTransactionTypes.forEach(t => transTypeMap.set(String(t.id), t));

            this.processedData = this.allTasks.map(task => {
                const applicationNumber = task.iprecordApplicationNo || "-";
                const relatedRecordTitle = task.iprecordTitle || task.relatedIpRecordTitle || "-";
                const applicantName = task.iprecordApplicantName || "-";

                const transactionTypeObj = transTypeMap.get(String(task.taskType));
                const taskTypeDisplayName = transactionTypeObj ? (transactionTypeObj.alias || transactionTypeObj.name) : (task.taskType || 'Bilinmiyor');

                const parseDate = (d) => d ? new Date(d) : null;
                const operationalDueObj = parseDate(task.dueDate || task.operationalDueDate); 
                const officialDueObj = parseDate(task.officialDueDate);
                const statusText = this.statusDisplayMap[task.status] || task.status;

                // YENİ: Bülten Verisi Ayıklama
                let detailsObj = {};
                if (task.details) {
                    if (typeof task.details === 'string') {
                        try { detailsObj = JSON.parse(task.details); } catch(e) {}
                    } else {
                        detailsObj = task.details;
                    }
                }
                const bulletinNo = detailsObj.bulletinNo || detailsObj.bulletin_no || '-';
                const bulletinDate = detailsObj.bulletinDate || detailsObj.bulletin_date || '-';

                const searchString = `${task.id} ${applicationNumber} ${relatedRecordTitle} ${applicantName} ${taskTypeDisplayName} ${bulletinNo} ${statusText}`.toLowerCase();

                return {
                    ...task,
                    applicationNumber,
                    relatedRecordTitle,
                    applicantName,
                    taskTypeDisplayName,
                    operationalDueObj,
                    officialDueObj,
                    statusText,
                    searchString,
                    bulletinNo,
                    bulletinDate
                };
            });

            // YENİ SAYACLARI GÜNCELLE ÇAĞRISI BURAYA EKLENDİ
            this.updateTabCounts();

            const currentQuery = document.getElementById('searchInput')?.value || '';
            this.handleSearch(currentQuery, preservePage); 
        }

        // 🔥 YENİ: Sayaçları Hesaplayan ve Ekrana Basan Fonksiyon
        updateTabCounts() {
            let counts = { general: 0, renewals: 0, opposition: 0, closed: 0 };

            this.processedData.forEach(item => {
                const isOpposition = String(item.taskType) === '20';
                const isRenewal = String(item.taskType) === '22';
                const isClosed = ['client_approval_closed', 'client_no_response_closed'].includes(item.status);

                if (isClosed) counts.closed++;
                else if (isRenewal) counts.renewals++;
                else if (isOpposition) counts.opposition++;
                else counts.general++;
            });

            const updateEl = (id, count) => {
                const el = document.getElementById(id);
                if (el) el.textContent = count;
            };

            updateEl('count-general', counts.general);
            updateEl('count-renewals', counts.renewals);
            updateEl('count-opposition', counts.opposition);
            updateEl('count-closed', counts.closed);
        }

        handleSearch(query, preservePage = false) {
            const statusFilter = document.getElementById('statusFilter')?.value || 'all';
            const lowerQuery = query ? query.toLowerCase() : '';

            this.filteredData = this.processedData.filter(item => {
                const matchesSearch = !lowerQuery || item.searchString.includes(lowerQuery);
                const matchesStatus = (statusFilter === 'all' || item.status === statusFilter);
                
                // 🔥 YENİ SEKMELERE GÖRE FİLTRELEME
                const isOpposition = String(item.taskType) === '20'; // 20: Yayına İtiraz
                const isRenewal = String(item.taskType) === '22'; // 22: Yenileme
                const isClosed = ['client_approval_closed', 'client_no_response_closed'].includes(item.status);
                let matchesTab = false;
                
                if (this.activeTab === 'closed') {
                    matchesTab = isClosed; // Kapatılanlar sekmesinde sadece kapalılar
                } else if (this.activeTab === 'renewals') {
                    matchesTab = isRenewal && !isClosed; // 🔥 YENİ: Sadece Açık Yenilemeler
                } else if (this.activeTab === 'general') {
                    matchesTab = !isOpposition && !isRenewal && !isClosed; // Diğer tüm tetiklenen işler
                } else if (this.activeTab === 'opposition') {
                    matchesTab = isOpposition && !isClosed; // Aktif Yayına İtirazlar
                }

                return matchesSearch && matchesStatus && matchesTab;
            });

            this.sortData();
            
            if (this.pagination) {
                if (!preservePage) this.pagination.reset();
                this.pagination.update(this.filteredData.length);
            }
            this.renderTable();
        }

        handleSort(key) {
            if (this.sortState.key === key) {
                this.sortState.direction = this.sortState.direction === 'asc' ? 'desc' : 'asc';
            } else {
                this.sortState.key = key;
                this.sortState.direction = 'asc';
            }
            this.sortData();
            this.renderTable();
        }

        sortData() {
            const { key, direction } = this.sortState;
            const multiplier = direction === 'asc' ? 1 : -1;

            this.filteredData.sort((a, b) => {
                let valA = a[key];
                let valB = b[key];

                const isEmptyA = (valA === null || valA === undefined || valA === '');
                const isEmptyB = (valB === null || valB === undefined || valB === '');

                if (isEmptyA && isEmptyB) return 0;

                if ((valA instanceof Date || isEmptyA) && (valB instanceof Date || isEmptyB)) {
                    if (isEmptyA) return -1 * multiplier; 
                    if (isEmptyB) return 1 * multiplier;
                    return (valA - valB) * multiplier;
                }

                if (isEmptyA) return 1;
                if (isEmptyB) return -1;

                if (key === 'id') {
                    const numA = parseInt(String(valA), 10);
                    const numB = parseInt(String(valB), 10);
                    if (!isNaN(numA) && !isNaN(numB)) return (numA - numB) * multiplier;
                }

                return String(valA).localeCompare(String(valB), 'tr') * multiplier;
            });
            
            this.updateSortIcons();
        }

        updateSortIcons() {
            document.querySelectorAll('#tasksTableHeaderRow th[data-sort]').forEach(th => {
                const icon = th.querySelector('i');
                if (icon) {
                    icon.className = 'fas fa-sort';
                    icon.style.opacity = '0.3';
                    if (th.dataset.sort === this.sortState.key) {
                        icon.className = this.sortState.direction === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down';
                        icon.style.opacity = '1';
                    }
                }
            });
        }

        renderTable() {
            const tbody = document.getElementById('myTasksTableBody');
            const noRecordsMsg = document.getElementById('noTasksMessage');
            if(!tbody) return;
            
            // 🔥 YENİ: Sütun BAŞLIKLARININ Gösterimini Ayarla
            const oppCols = document.querySelectorAll('th.opp-only-col');
            const genCols = document.querySelectorAll('th.general-only-col');
            
            if (this.activeTab === 'opposition') {
                oppCols.forEach(col => col.style.display = 'table-cell');
                genCols.forEach(col => col.style.display = 'none'); // İtirazda Tip ve Son Tarih gizlenir
            } else {
                oppCols.forEach(col => col.style.display = 'none');
                genCols.forEach(col => col.style.display = 'table-cell'); // Genel sekmede geri gelir
            }

            tbody.innerHTML = '';

            if (this.filteredData.length === 0) {
                if(noRecordsMsg) noRecordsMsg.style.display = 'block';
                return;
            }
            if(noRecordsMsg) noRecordsMsg.style.display = 'none';

            let currentData = this.filteredData;
            if (this.pagination) {
                currentData = this.pagination.getCurrentPageData(this.filteredData);
            }

            let html = '';
            currentData.forEach(task => {
                const statusClass = `status-${task.status.replace(/ /g, '_').toLowerCase()}`;
                
                const opDate = formatToTRDate(task.operationalDueObj);
                const offDate = formatToTRDate(task.officialDueObj);

                const opISO = task.operationalDueObj ? task.operationalDueObj.toISOString().slice(0,10) : '';
                const offISO = task.officialDueObj ? task.officialDueObj.toISOString().slice(0,10) : '';
                const actionMenuHtml = `
                    <div class="dropdown">
                        <button class="btn btn-sm btn-light text-secondary rounded-circle" type="button" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false" style="width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;">
                            <i class="fas fa-ellipsis-v" style="pointer-events: none;"></i>
                        </button>
                        
                        <div class="dropdown-menu dropdown-menu-right shadow-sm border-0 p-2" style="min-width: auto;">
                            <div class="d-flex justify-content-center align-items-center" style="gap: 5px;">
                                <button class="btn btn-sm btn-light text-primary view-btn action-btn" data-id="${task.id}" title="Detay Görüntüle"><i class="fas fa-eye" style="pointer-events: none;"></i></button>
                                <button class="btn btn-sm btn-light text-warning edit-btn action-btn" data-id="${task.id}" title="Düzenle"><i class="fas fa-edit" style="pointer-events: none;"></i></button>
                                <button class="btn btn-sm btn-light text-success add-accrual-btn action-btn" data-id="${task.id}" title="Ek Tahakkuk Ekle"><i class="fas fa-file-invoice-dollar" style="pointer-events: none;"></i></button>
                                <button class="btn btn-sm btn-light text-info change-status-btn action-btn" data-id="${task.id}" title="Durum Değiştir"><i class="fas fa-exchange-alt" style="pointer-events: none;"></i></button>
                            </div>
                        </div>
                    </div>
                `;

                let formattedBulletinDate = task.bulletinDate;
                if (formattedBulletinDate && formattedBulletinDate !== '-') {
                    formattedBulletinDate = formatToTRDate(new Date(formattedBulletinDate)) || formattedBulletinDate;
                }

                const bultenCols = this.activeTab === 'opposition' 
                    ? `<td class="col-bulletin">${task.bulletinNo}</td><td class="col-bulletin">${formattedBulletinDate}</td>` 
                    : '';

                const typeCol = this.activeTab !== 'opposition' ? `<td class="col-type general-only-col" title="${task.taskTypeDisplayName}">${task.taskTypeDisplayName}</td>` : '';
                const opDateCol = this.activeTab !== 'opposition' ? `<td class="col-date general-only-col" data-field="operationalDue" data-date="${opISO}">${opDate}</td>` : '';

                // 🔥 YENİ: Başvuru Numarası Linki (Eklentiyi Tetikler)
                let appLink = `portfolio-detail.html?id=${task.ip_record_id || task.related_ip_record_id || task.relatedIpRecordId || ''}`;
                
                // Eğer "Yayına İtiraz (20)" ise eklentiyi tetikleyecek TPE linkini ver!
                if (String(task.taskType) === '20') {
                    appLink = `https://opts.turkpatent.gov.tr/trademark#bn=${encodeURIComponent(task.applicationNumber)}`;
                }

                html += `
                    <tr class="task-row ${statusClass}" data-status="${task.status}">
                        <td class="col-check text-center"><input type="checkbox" class="task-checkbox" value="${task.id}" ${this.selectedTaskIds.has(task.id) ? 'checked' : ''}></td>
                        <td class="col-id">${task.id}</td>
                        <td class="col-appno">
                            <a href="${appLink}" target="_blank" class="text-primary font-weight-bold" style="text-decoration: underline;">
                                ${task.applicationNumber}
                            </a>
                        </td>
                        <td class="col-record" title="${task.relatedRecordTitle}">${task.relatedRecordTitle}</td>
                        <td class="col-owner" title="${task.applicantName}">${task.applicantName}</td>
                        
                        ${typeCol}
                        ${bultenCols}
                        ${opDateCol}
                        
                        <td class="col-date" data-field="officialDue" data-date="${offISO}">${offDate}</td>
                        <td class="col-status"><span class="status-badge ${statusClass}">${task.statusText}</span></td>
                        <td class="col-actions text-center" style="overflow:visible;">${actionMenuHtml}</td>
                    </tr>
                `;
            });

            tbody.innerHTML = html;
            this.attachCheckboxListeners(); 

            if (window.DeadlineHighlighter) {
                setTimeout(() => window.DeadlineHighlighter.refresh('triggeredTasks'), 50);
            }
            if (window.$) $('.dropdown-toggle').dropdown();
        }

        // YENİ: Checkbox Dinleyicileri
        attachCheckboxListeners() {
            const selectAllCb = document.getElementById('selectAllTasks');
            const rowCbs = document.querySelectorAll('.task-checkbox');

            if (selectAllCb) {
                const newSelectAll = selectAllCb.cloneNode(true);
                selectAllCb.parentNode.replaceChild(newSelectAll, selectAllCb);
                
                newSelectAll.addEventListener('change', (e) => {
                    const isChecked = e.target.checked;
                    rowCbs.forEach(cb => {
                        cb.checked = isChecked;
                        if (isChecked) this.selectedTaskIds.add(cb.value);
                        else this.selectedTaskIds.delete(cb.value);
                    });
                    this.updateBatchActionsButton();
                });
            }

            rowCbs.forEach(cb => {
                cb.addEventListener('change', (e) => {
                    if (e.target.checked) this.selectedTaskIds.add(e.target.value);
                    else this.selectedTaskIds.delete(e.target.value);
                    
                    if (selectAllCb) selectAllCb.checked = Array.from(rowCbs).every(c => c.checked);
                    this.updateBatchActionsButton();
                });
            });
            this.updateBatchActionsButton();
        }

        updateBatchActionsButton() {
            const btnContainer = document.getElementById('batchActionContainer');
            const countSpan = document.getElementById('selectedTaskCount');
            if (!btnContainer || !countSpan) return;

            // 🔥 ÇÖZÜM 2: Kapatılanlar ('closed') sekmesinde Toplu Kapat butonunu GİZLE
            if (this.selectedTaskIds.size > 0 && this.activeTab !== 'closed') {
                countSpan.textContent = this.selectedTaskIds.size;
                btnContainer.style.display = 'inline-block';
            } else {
                btnContainer.style.display = 'none';
            }
        }

        // YENİ: Toplu Durum Güncelleme
        async handleBatchClose(newStatus) {
            if (this.selectedTaskIds.size === 0) return;
            
            const statusLabel = newStatus === 'client_approval_closed' ? 'Müvekkil Onayı - Kapatıldı (Red)' : 'Müvekkil Cevaplamadı - Kapatıldı';
            if (!confirm(`Seçilen ${this.selectedTaskIds.size} adet görevi "${statusLabel}" olarak kapatmak istediğinize emin misiniz?`)) return;

            const loader = window.showSimpleLoading ? window.showSimpleLoading('Toplu İşlem Yapılıyor...') : null;
            
            try {
                const selectedTasks = this.allTasks.filter(t => this.selectedTaskIds.has(String(t.id)));
                
                const promises = selectedTasks.map(task => {
                    const history = task.history ? [...task.history] : [];
                    history.push({
                        action: `Durum değiştirildi: ${newStatus} (Toplu İşlem ile kapatıldı)`,
                        timestamp: new Date().toISOString(),
                        userEmail: this.currentUser.email
                    });

                    return taskService.updateTask(task.id, {
                        status: newStatus,
                        history: history
                    });
                });

                await Promise.all(promises);
                
                if (loader) loader.hide();
                showNotification(`${promises.length} adet görev başarıyla kapatıldı!`, 'success');
                
                this.selectedTaskIds.clear();
                const selectAllCb = document.getElementById('selectAllTasks');
                if(selectAllCb) selectAllCb.checked = false;

                await this.loadAllData();

            } catch (err) {
                if (loader) loader.hide();
                console.error("Toplu kapatma hatası:", err);
                showNotification('Toplu işlem sırasında hata oluştu.', 'error');
            }
        }

        async showTaskDetail(taskId) { 
            const task = this.allTasks.find(t => t.id === taskId);
            if (!task || !this.taskDetailManager) return;

            const modal = document.getElementById('taskDetailModal');
            const title = document.getElementById('modalTaskTitle');
            modal.classList.add('show');
            title.textContent = 'Yükleniyor...';
            this.taskDetailManager.showLoading();

            let ipRecord = null;
            if (task.relatedIpRecordId) {
                try {
                    const { data: ipSnap } = await supabase.from('ip_records').select('*').eq('id', String(task.relatedIpRecordId)).maybeSingle();
                    if (ipSnap) {
                        ipRecord = ipSnap;
                    } else {
                        const { data: suitSnap } = await supabase.from('suits').select('*').eq('id', String(task.relatedIpRecordId)).maybeSingle();
                        if (suitSnap) ipRecord = suitSnap;
                    }
                } catch(e) { console.warn("Kayıt detayı çekilemedi:", e); }
            }

            const transactionType = this.allTransactionTypes.find(t => String(t.id) === String(task.taskType));
            const assignedUser = task.assignedTo_email ? { email: task.assignedTo_email } : null;
            
            const accResult = await accrualService.getAccrualsByTaskId(task.id);
            const relatedAccruals = accResult.success ? accResult.data : [];

            title.textContent = `İş Detayı (${task.id})`;
            this.taskDetailManager.render(task, { ipRecord, transactionType, assignedUser, accruals: relatedAccruals });
        }

        async showAccrualModal(taskId) {
            this.currentTaskForAccrual = this.allTasks.find(t => t.id === taskId);
            if (!this.currentTaskForAccrual) return;

            document.getElementById('accrualTaskTitleDisplay').value = this.currentTaskForAccrual.title;
            this.accrualFormManager.reset();
            
            const getEpats = (t) => {
                if (!t) return null;
                if (t.documents && Array.isArray(t.documents)) return t.documents.find(d => d.type === 'epats_document');
                return t.epats_doc_url ? { name: t.epats_doc_name, url: t.epats_doc_url, type: 'epats_document' } : null;
            };

            let epatsDoc = getEpats(this.currentTaskForAccrual);
            const parentId = this.currentTaskForAccrual.transactionId || null;
            
            if (!epatsDoc && parentId) {
                let parent = this.allTasks.find(t => String(t.id) === String(parentId));
                if (!parent) {
                    try {
                        const { data: parentSnap } = await supabase.from('tasks').select('*').eq('id', String(parentId)).maybeSingle();
                        if (parentSnap) parent = parentSnap;
                    } catch (e) { console.warn('Parent fetch error:', e); }
                }
                epatsDoc = getEpats(parent);
            }
            
            this.accrualFormManager.showEpatsDoc(epatsDoc);
            document.getElementById('createMyTaskAccrualModal').classList.add('show');
        }

        async handleSaveAccrual() {
            if (!this.currentTaskForAccrual) return;

            const btn = document.getElementById('saveNewMyTaskAccrualBtn');
            if (btn) btn.disabled = true;

            const result = this.accrualFormManager.getData();
            if (!result.success) {
                showNotification(result.error, 'error');
                if (btn) btn.disabled = false;
                return;
            }
            
            const formData = result.data;
            const { files, ...formDataNoFiles } = formData;

            let uploadedFiles = [];
            if (files && files.length > 0) {
                try {
                    const file = files[0];
                    const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                    const filePath = `foreign_invoices/${Date.now()}_${cleanFileName}`;
                    
                    const { error: uploadError } = await supabase.storage.from('accruals').upload(filePath, file);
                    if (uploadError) throw uploadError;

                    const { data: urlData } = supabase.storage.from('accruals').getPublicUrl(filePath);

                    uploadedFiles.push({ 
                        name: file.name, 
                        url: urlData.publicUrl, 
                        type: 'foreign_invoice', 
                        documentDesignation: 'Yurtdışı Fatura/Debit', 
                        uploadedAt: new Date().toISOString() 
                    });
                } catch(err) { 
                    showNotification("Dosya yüklenemedi.", "error"); 
                    if (btn) btn.disabled = false;
                    return; 
                }
            }

            let targetTaskId = this.currentTaskForAccrual.id;
            let targetTaskTitle = this.currentTaskForAccrual.title;

            let detailsObj = {};
            if (this.currentTaskForAccrual.details) {
                if (typeof this.currentTaskForAccrual.details === 'string') {
                    try { detailsObj = JSON.parse(this.currentTaskForAccrual.details); } catch(e) {}
                } else {
                    detailsObj = this.currentTaskForAccrual.details;
                }
            }

            if (String(this.currentTaskForAccrual.taskType) === '53' || (this.currentTaskForAccrual.title || '').toLowerCase().includes('tahakkuk')) {
                const parentId = detailsObj.relatedTaskId || this.currentTaskForAccrual.relatedTaskId || detailsObj.parent_task_id;
                if (parentId) {
                    targetTaskId = String(parentId);
                    try {
                        const { data: pTask } = await supabase.from('tasks').select('title').eq('id', targetTaskId).single();
                        if (pTask) targetTaskTitle = pTask.title;
                    } catch(e) {}
                }
            }

            const newAccrual = {
                taskId: targetTaskId,
                taskTitle: targetTaskTitle,
                ...formDataNoFiles,

                officialFeeAmount: formDataNoFiles.officialFee?.amount || 0,
                officialFeeCurrency: formDataNoFiles.officialFee?.currency || 'TRY',
                serviceFeeAmount: formDataNoFiles.serviceFee?.amount || 0,
                serviceFeeCurrency: formDataNoFiles.serviceFee?.currency || 'TRY',

                tpeInvoiceNo: formDataNoFiles.tpeInvoiceNo?.trim() || null,
                evrekaInvoiceNo: formDataNoFiles.evrekaInvoiceNo?.trim() || null,
                
                status: 'unpaid',
                createdAt: new Date().toISOString(),
                files: uploadedFiles
            };

            try {
                const res = await accrualService.addAccrual(newAccrual);
                if (res.success) {
                    showNotification('Tahakkuk başarıyla oluşturuldu!', 'success');
                    this.closeModal('createMyTaskAccrualModal');
                    await this.loadAllData();
                } else {
                    showNotification('Hata: ' + res.error, 'error');
                }
            } catch(e) { 
                showNotification('Hata oluştu: ' + e.message, 'error'); 
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        showStatusChangeModal(taskId) {
            this.currentTaskForStatusChange = this.allTasks.find(t => t.id === taskId);
            if(!this.currentTaskForStatusChange) return;
            
            document.getElementById('changeStatusModalTaskTitleDisplay').textContent = this.currentTaskForStatusChange.title;
            document.getElementById('newTriggeredTaskStatus').value = this.currentTaskForStatusChange.status;
            
            document.getElementById('changeTriggeredTaskStatusModal').classList.add('show');
        }

        async handleUpdateStatus() {
            if (!this.currentTaskForStatusChange) return;
            
            let newStatus = document.getElementById('newTriggeredTaskStatus').value;
            
            // Eğer müşteri portalı statüsü manuel olarak "açık" (open) yapılıyorsa
            if (newStatus === 'client_approval_opened') {
                newStatus = 'open';
            }

            try {
                const updatePayload = {
                    status: newStatus
                };

                const history = this.currentTaskForStatusChange.history ? [...this.currentTaskForStatusChange.history] : [];
                history.push({
                    action: `Durum değiştirildi: ${newStatus} (Manuel Müdahale ile)`,
                    timestamp: new Date().toISOString(),
                    userEmail: this.currentUser.email
                });
                updatePayload.history = history;

                // 🔥 PARALEL GELİŞTİRME: İş durumu "Açık" (open) yapılırsa, işi asıl sahibine (departman/kişi) geri ata!
                if (newStatus === 'open' && this.currentTaskForStatusChange.taskType) {
                    try {
                        const { data: assignData } = await supabase
                            .from('task_assignments')
                            .select('assignee_ids')
                            .eq('id', String(this.currentTaskForStatusChange.taskType))
                            .single();
                            
                        if (assignData && assignData.assignee_ids && assignData.assignee_ids.length > 0) {
                            const correctAssigneeId = assignData.assignee_ids[0];
                            
                            // Eğer şu anki atanan kişi doğru kişi değilse, payload'a yeni atananı da ekle
                            if (this.currentTaskForStatusChange.assignedTo_uid !== correctAssigneeId) {
                                updatePayload.assigned_to = correctAssigneeId;
                                
                                history.push({
                                    action: `Görev Onaylandı: Sistem tarafından asıl sorumlusuna (Departmana) geri atandı.`,
                                    timestamp: new Date().toISOString(),
                                    userEmail: "Sistem Otomasyonu"
                                });
                            }
                        }
                    } catch (err) {
                        console.warn("Görev atama kuralı (Task Assignment) çekilemedi:", err);
                    }
                }

                // Supabase'e tüm güncellemeleri tek seferde gönder
                await taskService.updateTask(this.currentTaskForStatusChange.id, updatePayload);
                
                showNotification('Durum güncellendi ve ilgili kişiye atandı.', 'success');
                this.closeModal('changeTriggeredTaskStatusModal');
                await this.loadAllData();
                
            } catch (e) {
                console.error("Durum Güncelleme Hatası:", e);
                showNotification('Hata: ' + e.message, 'error');
            }
        }

        setupStaticEventListeners() {
            // YENİ: Sekme (Tab) Dinleyicileri
            const mainTabs = document.querySelectorAll('#triggeredTaskTabs .nav-link');
            mainTabs.forEach(tab => {
                tab.addEventListener('click', (e) => {
                    e.preventDefault();
                    
                    mainTabs.forEach(t => {
                        t.classList.remove('active');
                        t.style.color = '#6c757d';
                    });
                    e.currentTarget.classList.add('active');
                    e.currentTarget.style.color = '#495057';

                    this.activeTab = e.currentTarget.dataset.tab;
                    
                    // Seçimleri Temizle
                    this.selectedTaskIds.clear();
                    const selectAllCb = document.getElementById('selectAllTasks');
                    if(selectAllCb) selectAllCb.checked = false;
                    this.updateBatchActionsButton();

                    this.handleSearch();
                });
            });

            // Toplu Kapatma Butonu Dinleyicisi
            document.querySelectorAll('.batch-close-opt').forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.preventDefault();
                    const newStatus = e.currentTarget.dataset.status;
                    this.handleBatchClose(newStatus);
                });
            });

            document.getElementById('searchInput')?.addEventListener('input', (e) => this.handleSearch(e.target.value));
            document.getElementById('statusFilter')?.addEventListener('change', () => {
                const query = document.getElementById('searchInput').value;
                this.handleSearch(query);
            });

            document.querySelectorAll('#tasksTableHeaderRow th[data-sort]').forEach(th => {
                th.addEventListener('click', () => this.handleSort(th.dataset.sort));
            });

            const tbody = document.getElementById('myTasksTableBody');
            if(tbody) {
                tbody.addEventListener('click', (e) => {
                    const btn = e.target.closest('.action-btn');
                    if (!btn) return;
                    const taskId = btn.dataset.id;

                    if (btn.classList.contains('view-btn')) this.showTaskDetail(taskId);
                    else if (btn.classList.contains('edit-btn')) window.location.href = `task-update.html?id=${taskId}`;
                    else if (btn.classList.contains('add-accrual-btn')) this.showAccrualModal(taskId);
                    else if (btn.classList.contains('change-status-btn')) this.showStatusChangeModal(taskId);
                });
            }

            const closeModal = (id) => this.closeModal(id);
            document.getElementById('closeTaskDetailModal')?.addEventListener('click', () => closeModal('taskDetailModal'));
            
            document.getElementById('closeMyTaskAccrualModal')?.addEventListener('click', () => closeModal('createMyTaskAccrualModal'));
            document.getElementById('cancelCreateMyTaskAccrualBtn')?.addEventListener('click', () => closeModal('createMyTaskAccrualModal'));
            document.getElementById('saveNewMyTaskAccrualBtn')?.addEventListener('click', () => this.handleSaveAccrual());

            document.getElementById('closeChangeTriggeredTaskStatusModal')?.addEventListener('click', () => closeModal('changeTriggeredTaskStatusModal'));
            document.getElementById('cancelChangeTriggeredTaskStatusBtn')?.addEventListener('click', () => closeModal('changeTriggeredTaskStatusModal'));
            document.getElementById('saveChangeTriggeredTaskStatusBtn')?.addEventListener('click', () => this.handleUpdateStatus());

            document.getElementById('manualRenewalTriggerBtn')?.addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                const originalHtml = btn.innerHTML;
                
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Kontrol Ediliyor...';
                
                showNotification('Yenileme süreleri kontrol ediliyor, lütfen bekleyin...', 'info');
                
                try {
                    const { data, error } = await supabase.functions.invoke('check-renewal-tasks', { method: 'POST' });
                    if (error) throw error;
                    
                    if (data && data.success) {
                        let msg = `Tarama tamamlandı! ${data.processed || 0} marka incelendi, ${data.count || 0} adet yeni görev oluşturuldu.`;
                        if (data.skipped && data.skipped.length > 0) {
                            msg += `<br><b>Not: ${data.skipped.length} adet marka, zaten açık bir görevi olduğu için atlandı.</b>`;
                        }
                        showNotification(msg, 'success', 6000); 
                        this.loadAllData();
                    } else {
                        showNotification(data?.error || 'Bilinmeyen Hata', 'error');
                    }
                } catch(err) { 
                    console.error('Yenileme otomasyonu hatası:', err);
                    showNotification('Kontrol sırasında bir hata: ' + err.message, 'error'); 
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = originalHtml;
                }
            });
            if (window.DeadlineHighlighter) {
                window.DeadlineHighlighter.init();
                window.DeadlineHighlighter.registerList('triggeredTasks', {
                    container: 'table',
                    rowSelector: 'tbody tr',
                    dateFields: [
                        { name: 'officialDue', selector: '[data-field="officialDue"]' }
                    ],
                    strategy: 'earliest',
                    applyTo: 'cell',
                    addBadgeTo: '[data-field="officialDue"]', 
                    showLegend: true
                });
            }
        }

        closeModal(modalId) {
            const m = document.getElementById(modalId);
            if(m) m.classList.remove('show');
            if (modalId === 'createMyTaskAccrualModal' && this.accrualFormManager) {
                this.accrualFormManager.reset();
            }
        }
    }

    new TriggeredTasksModule().init();
});