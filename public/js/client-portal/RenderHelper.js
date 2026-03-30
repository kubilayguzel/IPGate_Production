export class RenderHelper {
    constructor(state) {
        this.state = state; 
    }

    formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return '-';
            return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
        } catch { return '-'; }
    }

    renderDavaTable(dataSlice, startIndex = 0) {
        const tbody = document.getElementById('dava-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (!dataSlice || dataSlice.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Kayıt yok.</td></tr>';
            return;
        }

        dataSlice.forEach((r, index) => {
            const badge = (r.suitStatus || '').toLowerCase().includes('devam') ? 'info' : 'secondary';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${startIndex + index + 1}</td>
                <td>${r.caseNo || '-'}</td>
                <td><a href="#" class="dava-detail-link" data-suit-id="${r.id}">${r.title || 'Dava'}</a></td>
                <td>${r.subjectAssetTitle || '-'}</td>
                <td>${r.court || '-'}</td>
                <td>${r.opposingParty || '-'}</td>
                <td>${this.formatDate(r.openingDate)}</td>
                <td><span class="badge badge-${badge}">${r.suitStatus || 'Devam Ediyor'}</span></td>
            `;
            tbody.appendChild(tr);
        });
    }

    renderObjectionTable(dataSlice, startIndex = 0) {
        const tbody = document.getElementById('dava-itiraz-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (!dataSlice || dataSlice.length === 0) {
            tbody.innerHTML = '<tr><td colspan="12" class="text-center text-muted">Henüz itiraz kaydı bulunmamaktadır.</td></tr>';
            return;
        }

        dataSlice.forEach((row, index) => {
            const parentIndex = startIndex + index + 1;
            const tr = document.createElement('tr');
            
            const originDisplay = row.origin || 'TÜRKPATENT';
            tr.setAttribute('data-origin', originDisplay);

            const imgHtml = row.brandImageUrl 
                ? `<img src="${row.brandImageUrl}" alt="marka" class="brand-thumb">` 
                : '<img src="https://placehold.co/100x100?text=Yok" alt="yok" class="brand-thumb">';
            
            const hasChildren = row.childrenData && row.childrenData.length > 0;
            const iconHtml = hasChildren ? '<i class="fas fa-chevron-right mr-2"></i>' : '';
            const uniqueAccordionId = `itiraz-accordion-${row.recordId}-${row.id}`;

            if (hasChildren) {
                tr.classList.add('accordion-header-row');
                tr.setAttribute('data-toggle', 'collapse');
                tr.setAttribute('data-target', `#${uniqueAccordionId}`);
            }

            tr.innerHTML = `
                <td>${iconHtml}${parentIndex}</td>
                <td class="col-origin">${originDisplay}</td>
                <td class="text-center">${imgHtml}</td>
                <td><a href="#" class="portfolio-detail-link" data-item-id="${row.recordId}">${row.title}</a></td>
                <td>${row.transactionTypeName}</td>
                <td>${row.applicationNumber}</td>
                <td>${row.applicantName}</td>
                <td>${this.formatDate(row.bulletinDate)}</td>
                <td>${row.bulletinNo || '-'}</td>
                <td>${this.formatDate(row.epatsDate)}</td>
                <td><span class="badge badge-${row.statusBadge || 'warning'}">${row.statusText}</span></td>
                <td>${this.renderDocsCell(row.allParentDocs)}</td>
            `;
            
            tbody.appendChild(tr);

            if (hasChildren) {
                const detailRow = document.createElement('tr');
                detailRow.setAttribute('data-origin', originDisplay);
                
                const childrenHtml = row.childrenData.map((child, idx) => {
                    let childDate = child.transaction_date || child.created_at ? this.formatDate(child.transaction_date || child.created_at) : '-';
                    const typeObj = this.state.transactionTypes.get(String(child.transaction_type_id));
                    const typeName = typeObj?.alias || typeObj?.name || `İşlem ${child.transaction_type_id}`;
                    
                    return `<tr>
                        <td>${parentIndex}.${idx + 1}</td>
                        <td>${typeName}</td>
                        <td>${childDate}</td>
                        <td>${this.renderDocsCell(child.transaction_documents)}</td>
                    </tr>`;
                }).join('');

                detailRow.innerHTML = `
                <td colspan="12" class="p-0">
                    <div class="collapse" id="${uniqueAccordionId}">
                        <table class="table mb-0 accordion-table bg-light" style="font-size:0.9em;">
                            <thead><tr><th>#</th><th>İşlem Tipi</th><th>İşlem Tarihi</th><th>Evraklar</th></tr></thead>
                            <tbody>${childrenHtml}</tbody>
                        </table>
                    </div>
                </td>`;
                tbody.appendChild(detailRow);
            }
        });
    }

    renderDocsCell(docs) {
        if (!docs || docs.length === 0) return '<span class="text-muted">-</span>';
        return docs.map(doc => {
            let iconClass = 'fas fa-file-pdf';
            let titleText = doc.document_name || doc.name || doc.fileName || 'Belge';
            let iconColor = '#dc3545'; 
            let badgeHtml = '';

            const docType = doc.document_type || doc.type || '';

            if (docType === 'opposition_petition') { iconClass = 'fas fa-gavel'; titleText = 'Karşı Taraf İtiraz Dilekçesi'; iconColor = '#ffc107'; }
            else if (docType === 'official_document') { iconClass = 'fas fa-file-signature'; titleText = 'Resmi Yazı'; iconColor = '#17a2b8'; }
            else if (docType === 'epats_document') { 
                iconClass = 'fas fa-file-invoice'; 
                titleText = `ePats: ${doc.evrakNo || titleText}`; 
                iconColor = '#007bff'; 
            }
            else if (docType === 'task_document' || doc.isTaskDoc) { iconClass = 'fas fa-file-alt'; titleText = 'Görev Belgesi: ' + titleText; iconColor = '#6c757d'; }

            const url = doc.document_url || doc.fileUrl || doc.downloadURL || doc.url;
            if (!url) return '';
            
            return `<a href="${url}" target="_blank" title="${titleText}" style="color:${iconColor}; text-decoration:none; margin-right:8px; font-size:1.2em; display:inline-block;"><i class="${iconClass}"></i>${badgeHtml}</a>`;
        }).filter(Boolean).join('') || '<span class="text-muted">-</span>';
    }

    formatScore(val) {
        if (val === undefined || val === null || val === '') return null;
        let strVal = String(val).replace(/['"%]/g, '').trim();
        let num = parseFloat(strVal);
        if (isNaN(num)) return val;
        if (num <= 1 && num > 0) return `%${Math.round(num * 100)}`;
        return `%${Math.round(num)}`;
    }

    renderTaskSection(tasks, containerId, taskTypeFilter) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!tasks || tasks.length === 0) {
            container.innerHTML = '<div class="text-center text-muted p-4">Aranan kriterlere uygun iş bulunamadı.</div>';
            return;
        }

        if (taskTypeFilter === 'bulletin-watch') {
            const groups = {};
            const expired = [];
            const today = new Date(); 
            today.setHours(0, 0, 0, 0);

            tasks.forEach(t => {
                const due = t.dueDate || t.officialDueDate;
                let isExp = false;
                if (due) {
                    const d = new Date(due);
                    d.setHours(0, 0, 0, 0);
                    if (d < today) isExp = true;
                }

                if (isExp) {
                    expired.push({ ...t, status: 'Bülten Kapandı' });
                } else {
                    let rawBNo = t.details?.bulletinNo || t.details?.brandInfo?.opposedMarkBulletinNo || t.details?.bulletin_no;
                    let bNo = 'Diğer';
                    
                    if (rawBNo) {
                        const match = String(rawBNo).match(/\d+/); 
                        if (match) bNo = match[0];
                    }
                    
                    if (!groups[bNo]) groups[bNo] = [];
                    groups[bNo].push(t);
                }
            });

            const bNumbers = Object.keys(groups).sort((a, b) => {
                if (a === 'Diğer') return 1;
                if (b === 'Diğer') return -1;
                return Number(b) - Number(a);
            });

            let html = '<ul class="nav nav-tabs mb-3">';
            let content = '<div class="tab-content">';

            bNumbers.forEach((no, i) => {
                const active = i === 0 ? 'active' : '';
                const tabTitle = no === 'Diğer' ? `Diğer Bültenler (${groups[no].length})` : `${no}. Bülten (${groups[no].length})`;
                
                html += `<li class="nav-item"><a class="nav-link ${active}" data-toggle="tab" href="#b-${no}">${tabTitle}</a></li>`;
                content += `<div class="tab-pane fade ${active ? 'show active' : ''}" id="b-${no}"><div class="row">${this.generateTaskCardsHtml(groups[no], taskTypeFilter)}</div></div>`;
            });

            if (expired.length > 0) {
                const cls = bNumbers.length === 0 ? 'active' : '';
                html += `<li class="nav-item"><a class="nav-link ${cls}" data-toggle="tab" href="#b-exp">Önceki Bültenler (${expired.length})</a></li>`;
                content += `<div class="tab-pane fade ${cls ? 'show active' : ''}" id="b-exp"><div class="alert alert-secondary">Bu bildirimlerin süresi dolmuştur.</div><div class="row">${this.generateTaskCardsHtml(expired, taskTypeFilter)}</div></div>`;
            }

            container.innerHTML = html + '</ul>' + content + '</div>';
        } else {
            container.innerHTML = `<div class="row">${this.generateTaskCardsHtml(tasks.slice(0, 50), taskTypeFilter)}</div>`;
            if (tasks.length > 50) {
                container.innerHTML += `<div class="text-center text-muted mt-3"><small>Sadece ilk 50 kayıt listelenmiştir.</small></div>`;
            }
        }
    }

    generateTaskCardsHtml(tasks, taskTypeFilter) {
        const isCompletedView = taskTypeFilter.includes('completed');
        const isBulletinWatch = taskTypeFilter === 'bulletin-watch';

        return tasks.map((task, index) => {
            let bulletinKey = task.details?.bulletinKey || (task.details?.bulletinNo ? `${task.details.bulletinNo}_${task.details.bulletinDate?.replace(/\//g, '')}` : null);
            const targetAppNo = task.details?.targetAppNo || '-';

            let cardTitle = `#${task.id} - ${task.taskTypeDisplay}`;
            if (!isBulletinWatch) {
                cardTitle += ` - ${task.appNo} - ${task.recordTitle}`;
            }

            let comparisonRow = '';
            
            if (isBulletinWatch) {
                // ==========================================
                // 🔥 SOL TARAF: İZLENEN MARKA (BİZİM)
                // ==========================================
                const myRecordTitle = task.recordTitle;
                const myAppNo = task.appNo;
                const myImgUrl = task.brandImageUrl || 'https://placehold.co/100x100?text=Görsel+Yok';
                const myOwner = task.applicantName !== '-' ? task.applicantName : (document.getElementById('currentClientName')?.textContent || 'Belirtilmedi');
                const formattedMyAppDate = task.appDate !== '-' ? this.formatDate(task.appDate) : 'Belirtilmedi';
                const myClasses = task.niceClasses;

                // ==========================================
                // 🔥 SAĞ TARAF: BENZER MARKA (RAKİP)
                // ==========================================
                const cleanCompNo = String(targetAppNo).replace(/[^a-zA-Z0-9/]/g, '');
                const compImgUrl = task.details?.competitorBrandImage || 'https://placehold.co/100x100?text=Görsel+Yok';
                const compName = task.details?.objectionTarget || 'İsimsiz Marka';
                const compOwner = task.details?.competitorOwner || '-';
                const compAppDate = task.details?.competitorAppDate ? this.formatDate(task.details.competitorAppDate) : 'Belirtilmedi';
                const compClasses = task.details?.competitorClasses || '-';

                const displayScore = this.formatScore(task.details?.similarityScore);
                const note = task.details?.note;

                let extraInfoHtml = '';
                if (displayScore || note) {
                    extraInfoHtml = `
                    <div class="mt-3 pt-2 border-top" style="font-size: 0.9rem;">
                        ${displayScore ? `<span class="mr-3 d-block d-sm-inline mb-1"><strong class="text-muted font-weight-bold">Başarı Şansı:</strong> <span class="badge badge-warning" style="font-size:0.9rem;">${displayScore}</span></span>` : ''}
                        ${note ? `<span class="d-block d-sm-inline"><strong class="text-muted font-weight-bold">Değerlendirme:</strong> <span class="font-italic opacity-75">${note}</span></span>` : ''}
                    </div>`;
                }

                // HİÇBİR ZORLAMA RENK YOK - TEMA KENDİSİ RENGİ ALACAK
                comparisonRow = `
                <div class="row mt-3 pt-3 border-top">
                    <div class="col-md-6 border-right mb-3 mb-md-0">
                        <h6 class="text-info font-weight-bold mb-3 text-left" style="font-size:1.1rem;">İZLENEN MARKANIZ</h6>
                        <div class="d-flex align-items-start text-left">
                            <div class="mr-4" style="min-width:100px; text-align:center;">
                                <img src="${myImgUrl}" class="task-brand-image" style="height:100px; width:auto; max-width:100%; object-fit:contain; background:white; border-radius:4px; padding:2px;">
                            </div>
                            <div>
                                <div class="font-weight-bold mb-2" style="font-size:1.2rem;">${myRecordTitle}</div>
                                <div style="font-size:0.95rem; margin-bottom:4px;"><span class="text-muted font-weight-bold">Başvuru No:</span> <span>${myAppNo}</span></div>
                                <div style="font-size:0.95rem; margin-bottom:4px;"><span class="text-muted font-weight-bold">Başvuru Tarihi:</span> <span>${formattedMyAppDate}</span></div>
                                <div style="font-size:0.95rem; margin-bottom:4px;"><span class="text-muted font-weight-bold">Sahip:</span> <span>${myOwner}</span></div>
                                <div style="font-size:0.95rem;"><span class="text-muted font-weight-bold">Sınıf:</span> <span>${myClasses}</span></div>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-6">
                        <h6 class="text-danger font-weight-bold mb-3 text-left" style="font-size:1.1rem;">BENZER MARKA</h6>
                        <div class="d-flex align-items-start text-left">
                            <div class="mr-4" style="min-width:100px; text-align:center;">
                                <img src="${compImgUrl}" class="task-brand-image" style="height:100px; width:auto; max-width:100%; object-fit:contain; background:white; border-radius:4px; padding:2px;">
                            </div>
                            <div>
                                <div class="font-weight-bold mb-2" style="font-size:1.2rem;">${compName}</div>
                                <div style="font-size:0.95rem; margin-bottom:4px;"><span class="text-muted font-weight-bold">Başvuru No:</span> <span>${targetAppNo}</span></div>
                                <div style="font-size:0.95rem; margin-bottom:4px;"><span class="text-muted font-weight-bold">Başvuru Tarihi:</span> <span>${compAppDate}</span></div>
                                <div style="font-size:0.95rem; margin-bottom:4px;"><span class="text-muted font-weight-bold">Sahip:</span> <span>${compOwner}</span></div>
                                <div style="font-size:0.95rem; margin-bottom:8px;"><span class="text-muted font-weight-bold">Sınıf:</span> <span>${compClasses}</span></div>
                                <div class="mt-2">
                                    <button onclick="window.triggerTpQuery('${cleanCompNo}')" class="btn btn-sm btn-outline-secondary py-0 px-2" style="font-size: 0.85rem;">
                                        <i class="fas fa-search mr-1"></i> TÜRKPATENT'ten Sorgula
                                    </button>
                                </div>
                            </div>
                        </div>
                        ${extraInfoHtml}
                    </div>
                </div>`;
            }

            let badgeClass = 'secondary';
            let statusText = task.status;
            if (task.status === 'awaiting_client_approval') { badgeClass = 'warning'; statusText = 'Onay Bekliyor'; }
            else if (task.status === 'completed' || task.status === 'open') { badgeClass = 'success'; statusText = 'Talimat İletildi'; }
            else if (task.status.includes('kapatıldı')) { badgeClass = 'danger'; statusText = 'Reddedildi/Kapandı'; }
            else if (task.status === 'Bülten Kapandı') { badgeClass = 'secondary'; statusText = 'Süresi Doldu'; }

            let buttons = `<button class="btn btn-info btn-sm task-detail-btn mr-1" data-id="${task.id}"><i class="fas fa-eye"></i> İncele</button>`;
            
            if (!isCompletedView && task.status === 'awaiting_client_approval') {
                buttons = `
                    <button class="btn btn-success btn-sm task-action-btn mr-1" data-action="approve" data-id="${task.id}"><i class="fas fa-check"></i> Onayla</button>
                    <button class="btn btn-danger btn-sm task-action-btn mr-1" data-action="reject" data-id="${task.id}"><i class="fas fa-times"></i> Reddet</button>
                    ${buttons}
                `;
                if(isBulletinWatch && targetAppNo !== '-') {
                    buttons += `<button class="btn btn-warning btn-sm task-compare-goods mr-1" data-task-id="${task.id}" data-ip-record-id="${task.relatedIpRecordId}" data-bulletin-key="${bulletinKey}" data-target-app-no="${targetAppNo}"><i class="fas fa-balance-scale"></i> Kıyasla</button>`;
                }
            }

            const dateVal = this.formatDate(task.dueDate);
            const dateLabel = isCompletedView ? 'Oluşturma Tarihi:' : 'Son Onay Tarihi:';
            const dateWarning = !isCompletedView ? `<span class="text-muted ml-2 d-block d-sm-inline" style="font-size:0.85rem; font-style:italic;">(Hak kaybı yaşanmaması adına talimatların bu tarihten önce iletilmesi beklenmektedir.)</span>` : '';

            return `
            <div class="col-12 mb-4">
                <div class="task-card task-card-${badgeClass}">
                    <div class="task-number-tag">${index + 1}.</div>
                    <h5 class="task-title ml-4">${cardTitle}</h5>
                    ${comparisonRow}
                    <div class="ml-4 mt-2 mb-2"><span class="badge badge-${badgeClass}" style="font-size:0.85rem;">${statusText}</span></div>
                    <div class="d-flex flex-column flex-md-row justify-content-between align-items-md-center mt-3 border-top pt-2">
                        <div class="mb-2 mb-md-0"><small class="task-meta"><i class="fas fa-clock mr-1"></i> <strong>${dateLabel} ${dateVal}</strong>${dateWarning}</small></div>
                        <div class="text-right">${buttons}</div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    renderTransactionHistory(processedParents, containerId) {
        const tbody = document.querySelector(`#${containerId} tbody`);
        if (!tbody) return;

        if (!processedParents || processedParents.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">İşlem geçmişi bulunamadı.</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        let rowIndex = 1;

        processedParents.forEach(parent => {
            const children = parent.childrenData || [];
            const hasChildren = children.length > 0;
            const accordionId = `modal-transaction-${parent.id}`;

            let transactionAlias = parent.typeName || parent.description || 'İşlem';
            if (String(parent.transaction_type_id) === '20' && parent.opposition_owner) {
                transactionAlias += ` (${parent.opposition_owner})`;
            }

            let resultBadge = '';
            if (parent.request_result) {
                const rrObj = this.state.transactionTypes.get(String(parent.request_result));
                if (rrObj) {
                    const resultName = rrObj.alias || rrObj.name;
                    const lowerName = resultName.toLowerCase();
                    const parentType = String(parent.transaction_type_id);
                    
                    let badgeColor = 'info'; 
                    if (parentType === '20') { 
                        badgeColor = lowerName.includes('kabul') ? 'danger' : 'success';
                    } else if (parentType === '19') { 
                        badgeColor = (lowerName.includes('ret') || lowerName.includes('red')) ? 'danger' : 'success';
                    } else {
                        if (lowerName.includes('ret') || lowerName.includes('red')) badgeColor = 'danger';
                        else if (lowerName.includes('kabul') || lowerName.includes('onay')) badgeColor = 'success';
                        else if (lowerName.includes('kısmen')) badgeColor = 'warning';
                    }
                    resultBadge = `<span class="badge badge-${badgeColor} ml-2" style="font-size: 0.85em;">🏁 ${resultName}</span>`;
                }
            }

            const docsHtml = this.renderDocsCell(parent.all_documents);

            const parentRow = document.createElement('tr');
            if (hasChildren) {
                parentRow.classList.add('accordion-header-row');
                parentRow.setAttribute('data-toggle', 'collapse');
                parentRow.setAttribute('data-target', `#${accordionId}`);
            }

            parentRow.innerHTML = `
                <td>${hasChildren ? '<i class="fas fa-chevron-right mr-2"></i>' : ''}${rowIndex}</td>
                <td>${transactionAlias} ${resultBadge}</td>
                <td>${this.formatDate(parent.created_at || parent.transaction_date)}</td>
                <td>${docsHtml}</td>
            `;
            tbody.appendChild(parentRow);

            if (hasChildren) {
                const detailRow = document.createElement('tr');
                const childrenHtml = children.map((child, idx) => {
                    let childAlias = child.typeName || child.description || 'Alt İşlem';
                    if (String(child.transaction_type_id) === '20' && child.opposition_owner) childAlias += ` (${child.opposition_owner})`;
                    return `<tr>
                        <td>${rowIndex}.${idx + 1}</td>
                        <td>${childAlias}</td>
                        <td>${this.formatDate(child.created_at || child.transaction_date)}</td>
                        <td>${this.renderDocsCell(child.all_documents)}</td>
                    </tr>`;
                }).join('');

                detailRow.innerHTML = `<td colspan="4" class="p-0">
                    <div class="collapse" id="${accordionId}">
                        <table class="table mb-0 accordion-table bg-light" style="font-size:0.9em;">
                            <thead><tr><th>#</th><th>İşlem Detayı</th><th>Tarih</th><th>Evrak</th></tr></thead>
                            <tbody>${childrenHtml}</tbody>
                        </table>
                    </div>
                </td>`;
                tbody.appendChild(detailRow);
            }
            rowIndex++;
        });
    }
}