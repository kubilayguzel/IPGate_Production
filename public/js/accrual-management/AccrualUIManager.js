// public/js/accrual-management/AccrualUIManager.js

import { AccrualFormManager } from '../components/AccrualFormManager.js';
import { TaskDetailManager } from '../components/TaskDetailManager.js';
import { supabase } from '../../supabase-config.js';

export class AccrualUIManager {
    constructor() {
        this.tableBody = document.getElementById('accrualsTableBody');
        this.foreignTableBody = document.getElementById('foreignTableBody');
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
    }

    renderTable(data, lookups, activeTab = 'main') {
        this.currentData = data || [];

        const { tasks, transactionTypes, ipRecordsMap, selectedIds } = lookups;
        const targetBody = activeTab === 'foreign' ? this.foreignTableBody : this.tableBody;
        
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
                const typeHtml = `<span class="badge ${typeBadgeClass}">${accType}</span>`;

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
                    taskDisplay = acc.taskTitle || '-'; 
                    fullSubject = acc.subject || '-';
                }

                let shortSubject = fullSubject.length > 18 ? fullSubject.substring(0, 18) + '..' : fullSubject;
                const subjectHtml = `<span title="${fullSubject}" style="cursor:help;">${shortSubject}</span>`;

                let fullPartyName = '-';
                if (acc.officialFee?.amount > 0 && acc.tpInvoiceParty) fullPartyName = acc.tpInvoiceParty.name || 'Türk Patent';
                else if (acc.serviceFee?.amount > 0 && acc.serviceInvoiceParty) fullPartyName = acc.serviceInvoiceParty.name || '-';

                let shortPartyName = fullPartyName.length > 18 ? fullPartyName.substring(0, 18) + '..' : fullPartyName;
                const partyHtml = `<span title="${fullPartyName}" style="cursor:help;">${shortPartyName}</span>`;

                const tfn = acc.tpeInvoiceNo || '-';
                const efn = acc.evrekaInvoiceNo || '-';
                const officialStr = acc.officialFee ? this._formatMoney(acc.officialFee.amount, acc.officialFee.currency) : '-';

                const isEditDisabled = acc.status === 'paid';
                const editBtnClass = isEditDisabled ? 'btn btn-sm btn-light text-muted disabled' : 'btn btn-sm btn-light text-warning edit-btn action-btn';
                const editBtnStyle = isEditDisabled ? 'cursor: not-allowed; opacity: 0.5;' : 'cursor: pointer;';
                const editTitle = isEditDisabled ? 'Ödenmiş kayıt düzenlenemez' : 'Düzenle';

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

                if (activeTab === 'main') {
                    const serviceStr = acc.serviceFee ? this._formatMoney(acc.serviceFee.amount, acc.serviceFee.currency) : '-';
                    
                    return `
                    <tr>
                        <td><input type="checkbox" class="row-checkbox" data-id="${acc.id}" ${isSelected ? 'checked' : ''}></td>
                        <td>${acc.id}</td>
                        <td>${dateStr}</td>
                        <td>${typeHtml}</td> <td><span class="badge badge-info">${fieldDisplay}</span></td>
                        <td><span class="badge ${sCls}">${sTxt}</span></td>
                        <td>${relatedFileDisplay}</td>
                        <td><span class="font-weight-bold text-secondary">${subjectHtml}</span></td>
                        <td><a href="#" class="task-detail-link" data-task-id="${acc.taskId}">${taskDisplay}</a></td>
                        <td>${partyHtml}</td>
                        <td><span class="text-muted font-weight-bold">${tfn}</span></td>
                        <td><span class="text-muted font-weight-bold">${efn}</span></td>
                        <td>${officialStr}</td>
                        <td>${serviceStr}</td>
                        <td>${this._formatMoney(acc.totalAmount)}</td>
                        <td>${remainingHtml}</td>
                        <td class="text-center">${actionMenuHtml}</td>
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

                    return `
                    <tr>
                        <td><input type="checkbox" class="row-checkbox" data-id="${acc.id}" ${isSelected ? 'checked' : ''}></td>
                        <td>${acc.id}</td>
                        <td><span class="badge ${sCls}">${sTxt}</span></td>
                        <td><a href="#" class="task-detail-link" data-task-id="${acc.taskId}">${taskDisplay}</a></td>
                        <td>${paymentParty}</td>
                        <td>${officialStr}</td>
                        <td>${remainingHtml}</td>
                        <td>${documentHtml}</td>
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
        const tpParty = accrual.tpInvoiceParty?.name || '-';
        const foreignParty = accrual.serviceInvoiceParty?.name || '-';
        const applyVatToOfficial = accrual.applyVatToOfficialFee ? 'Evet' : 'Hayır';

        const offFeeStr = accrual.officialFee ? this._formatMoney(accrual.officialFee) : '0 TRY';
        const srvFeeStr = accrual.serviceFee ? this._formatMoney(accrual.serviceFee) : '0 TRY';
        const totalStr = this._formatMoney(accrual.totalAmount);
        const remainingStr = this._formatMoney(accrual.remainingAmount);

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
                                    <div class="col-6"><p class="mb-0"><strong>TPE Fatura No:</strong> ${tfn}</p></div>
                                    <div class="col-6"><p class="mb-0"><strong>EVREKA Fatura No:</strong> ${efn}</p></div>
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
}