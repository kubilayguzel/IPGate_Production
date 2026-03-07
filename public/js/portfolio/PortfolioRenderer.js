import { STATUSES, formatToTRDate } from '../../utils.js';
import '../simple-loading.js';

export class PortfolioRenderer {
    constructor(containerId, dataManager) {
        this.containerId = containerId; 
        this.dataManager = dataManager;
        
        this.simpleLoader = null;
        if (window.SimpleLoading) {
            this.simpleLoader = new window.SimpleLoading();
        }
    }

    get tbody() {
        return document.getElementById(this.containerId);
    }

    clearTable() {
        if (this.tbody) this.tbody.innerHTML = '';
    }

    showLoading(show) {
        const defaultSpinner = document.getElementById('loadingIndicator');
        if (show) {
            if (defaultSpinner) defaultSpinner.style.display = 'none';
            if (this.simpleLoader) {
                this.simpleLoader.show({ text: 'Veriler Yükleniyor', subtext: 'Lütfen bekleyiniz, kayıtlar taranıyor...' });
            } else if (defaultSpinner) {
                defaultSpinner.style.display = 'flex';
            }
        } else {
            if (this.simpleLoader) this.simpleLoader.hide();
            if (defaultSpinner) defaultSpinner.style.display = 'none';
        }
    }

    renderEmptyState() {
        if (this.tbody) {
            this.tbody.innerHTML = `
                <tr>
                    <td colspan="100%" class="text-center py-5">
                        <div class="text-muted">
                            <i class="fas fa-search fa-3x mb-3"></i>
                            <p>Kayıt bulunamadı.</p>
                        </div>
                    </td>
                </tr>`;
        }
    }

    renderHeaders(columns, activeFilters = {}) {
        const headerRow = document.getElementById('portfolioTableHeaderRow');
        const thead = headerRow ? headerRow.parentElement : null;

        if (!headerRow || !thead) return;

        headerRow.innerHTML = '';

        let filterRow = document.getElementById('portfolioTableFilterRow');
        if (!filterRow) {
            filterRow = document.createElement('tr');
            filterRow.id = 'portfolioTableFilterRow';
            filterRow.style.backgroundColor = '#f8f9fa';
            thead.appendChild(filterRow);
        }
        filterRow.innerHTML = '';

        columns.forEach(col => {
            const th = document.createElement('th');
            if (col.width) th.style.width = col.width;
            th.className = col.sortable ? 'sortable-header inactive' : '';
            if (col.sortable) th.dataset.column = col.key;
            th.textContent = col.label || '';
            if (col.isCheckbox) th.innerHTML = '<input type="checkbox" id="selectAllCheckbox">';
            headerRow.appendChild(th);

            const filterTh = document.createElement('th');
            filterTh.style.padding = '5px';
            if (col.filterable) {
                const input = document.createElement('input');
                input.type = col.inputType || 'text';
                input.className = 'form-control column-filter';
                input.style.width = '100%';
                input.style.fontSize = '14px';
                input.style.padding = '8px 12px';
                input.style.borderRadius = '8px';
                input.style.border = '1px solid #ced4da';
                input.style.height = '38px';

                if (input.type === 'text') input.placeholder = '🔍 Ara...';

                input.dataset.key = col.key;
                input.value = activeFilters[col.key] || '';
                filterTh.appendChild(input);
            }
            filterRow.appendChild(filterTh);
        });
    }

    renderStandardRow(record, isTrademarkTab, isSelected) {
        const tr = document.createElement('tr');
        tr.dataset.id = record.id;
        
        const isWipoParent = (record.origin === 'WIPO' || record.origin === 'ARIPO') && record.transactionHierarchy === 'parent';
        const isChild = record.transactionHierarchy === 'child'; 
        
        if (isWipoParent) {
            // 🔥 ÇÖZÜM: WIPO Numarası değil, kendi ID'si referans alınıyor
            tr.dataset.groupId = record.id;
            tr.className = 'group-header';
            tr.style.backgroundColor = '#e3f2fd'; 
        } else if (isChild) {
             tr.style.backgroundColor = '#ffffff';
             // 🔥 ÇÖZÜM: Akordeonun çalışması için gereken Child (Alt) sınıfları ve gizleme özelliği
             tr.className = 'group-row child-row';
             tr.dataset.parentId = record.parentId;
             tr.style.display = 'none'; 
        }

        const countryName = this.dataManager.getCountryName(record.country || record.countryCode);
        const imgHtml = isTrademarkTab ? 
            `<td><div class="trademark-image-wrapper">${record.brandImageUrl ? `<img class="trademark-image-thumbnail" src="${record.brandImageUrl}" loading="lazy" decoding="async" width="40" height="40" alt="Logo">` : ''}</div></td>` : '';
        const isTP = [record.origin, record.source, record.country].map(s => (s||'').toUpperCase()).some(s => s.includes('TURKPATENT') || s.includes('TÜRKPATENT') || s === 'TR');
        
        const viewBtnTitle = isTP ? "TürkPatent'te Sorgula" : "Detayı Görüntüle";
        const btnContent = isTP 
            ? `<img src="./tp-icon.png" style="width: 50px; height: 50px; object-fit: contain;" alt="TP">`
            : `<i class="fas fa-eye"></i>`;

        const actions = `
            <div class="d-flex gap-1 justify-content-end">
                <button class="action-btn view-btn btn btn-sm ${isTP ? '' : 'btn-info'}" data-id="${record.id}" title="${viewBtnTitle}" ${isTP ? 'style="background:transparent;border:none;padding:2px;"' : ''}>${btnContent}</button>
                <button class="action-btn edit-btn btn btn-sm btn-warning" data-id="${record.id}" title="Düzenle"><i class="fas fa-edit"></i></button>
                <button class="action-btn delete-btn btn btn-sm btn-danger" data-id="${record.id}" title="Sil"><i class="fas fa-trash"></i></button>
            </div>`;

        // Ok (caret) işareti artık numaraya bağlı değil, sadece WIPO Parent ise direkt çıkar
        const caret = isWipoParent ? `<i class="fas fa-chevron-right row-caret" style="cursor:pointer; padding: 5px;"></i>` : '';
        const titleText = record.title || record.brandText || '-';
        
        // Numara yoksa da (null) sorunsuz - bassın
        const appNoText = record.applicationNumber || record.wipoIR || record.aripoIR || '-'; 
        
        const applicantText = record.formattedApplicantName || record.applicantName || '-';

        let html = `
            <td><input type="checkbox" class="record-checkbox" data-id="${record.id}" ${isSelected ? 'checked' : ''}></td>
            <td class="toggle-cell text-center" style="vertical-align: middle;">${caret}</td>
        `;

        if (!isTrademarkTab) html += `<td>${record.type || '-'}</td>`;

        // 🔥 Alt işlemler (Child) için metne estetik girinti oku eklendi (↳)
        html += `<td title="${titleText}" ${isChild ? 'style="padding-left: 25px; border-left: 3px solid #6c757d;"' : ''}>
                    ${isChild ? '↳ ' : ''}<strong>${titleText}</strong>
                 </td>`;

        if (isTrademarkTab) {
            html += imgHtml;
            html += `<td>${record.origin || '-'}</td>`;
            html += `<td title="${countryName}">${countryName}</td>`;
        }

        if (appNoText && appNoText !== '-') {
            html += `<td title="Portföy detayını aç"><a href="portfolio-detail.html?id=${record.id}" target="_blank" style="color: #1e3c72; font-weight: 600; text-decoration: underline;">${appNoText}</a></td>`;
        } else {
            html += `<td title="${appNoText}">${appNoText}</td>`;
        }
        
        html += `<td>${record.formattedApplicationDate || '-'}</td>`;
        html += `<td>${isChild ? '' : this.getStatusBadge(record)}</td>`;
        html += `<td><small title="${applicantText}">${applicantText}</small></td>`;
        
        const niceText = record.formattedNiceClasses || '-';
        html += `<td title="${niceText}">${niceText}</td>`;
        
        html += `<td>${actions}</td>`;

        tr.innerHTML = html;
        return tr;
    }

    renderLitigationRow(row, index) {
        const tr = document.createElement('tr');
        tr.dataset.id = row.id;
        const suitTypeStr = String(row.suitType || '');
        if (suitTypeStr.includes('İptal')) tr.style.backgroundColor = '#ffebee';
        else if (suitTypeStr.includes('Tecavüz')) tr.style.backgroundColor = '#fff3e0';
        
        const actions = `
            <div class="d-flex gap-1 justify-content-end">
                <button class="action-btn view-btn btn btn-sm btn-info" data-id="${row.id}" title="Görüntüle"><i class="fas fa-eye"></i></button>
                <button class="action-btn edit-btn btn btn-sm btn-warning" data-id="${row.id}" title="Düzenle"><i class="fas fa-edit"></i></button>
            </div>`;
        const statusBadge = this.getStatusBadge(row);

        tr.innerHTML = `
            <td><strong>${index}</strong></td>
            <td title="${row.title || ''}">${row.title || '-'}</td>
            <td title="${row.suitType || ''}">${row.suitType || '-'}</td>
            <td title="${row.caseNo || ''}">${row.caseNo || '-'}</td>
            <td title="${row.court || ''}">${row.court || '-'}</td>
            <td title="${row.client || ''}">${row.client || '-'}</td>
            <td title="${row.opposingParty || ''}">${row.opposingParty || '-'}</td>
            <td>${this.formatDate(row.openedDate)}</td>
            <td>${statusBadge}</td>
            <td>${actions}</td>`;
        return tr;
    }

    renderObjectionRow(row, hasChildren, isChild = false) {
        const tr = document.createElement('tr');
        tr.className = isChild ? 'group-row child-row' : (hasChildren ? 'group-header' : '');
        if (isChild) tr.setAttribute('aria-hidden', 'true');
        
        if (!isChild && row.isOwnRecord) {
            tr.classList.add('table-danger'); 
        } else if (isChild) {
            tr.style.backgroundColor = '#f8f9fa'; 
        }

        const docsHtml = (row.documents || []).map(doc => {
            let iconClass = 'fa-file-pdf'; 
            let iconColor = '#dc3545'; 
            
            if (doc.type === 'epats_document') {
                iconClass = 'fa-file-invoice';
                iconColor = '#0d6efd'; 
            } else if (doc.type === 'official_document') {
                iconClass = 'fa-file-signature';
                iconColor = '#198754'; 
            } else if (doc.type === 'opposition_petition') {
                iconClass = 'fa-file-contract';
                iconColor = '#fd7e14'; 
            }

            return `
                <a href="${doc.fileUrl}" target="_blank" class="pdf-link" title="${doc.fileName}" style="text-decoration: none; margin-right: 8px;">
                    <i class="fas ${iconClass}" style="color: ${iconColor} !important; font-size: 1.3em; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'"></i>
                </a>
            `;
        }).join('');

        const caret = hasChildren ? `<i class="fas fa-chevron-right row-caret" style="cursor:pointer;"></i>` : '';
        const indentation = isChild ? 'style="padding-left: 30px; border-left: 3px solid #f39c12;"' : '';
        const statusDisplay = isChild ? '' : (row.statusText || '-');

        tr.innerHTML = `
            <td class="toggle-cell text-center">${caret}</td>
            <td ${indentation} title="${row.title || ''}" style="max-width: 250px; white-space: normal; word-wrap: break-word; overflow-wrap: break-word;">
                ${isChild ? '↳ ' : ''} <strong>${row.title || '-'}</strong>
            </td>
            <td title="${row.transactionTypeName || ''}" style="white-space: normal;">${row.transactionTypeName || '-'}</td>
            <td title="${row.applicationNumber}">${row.applicationNumber || '-'}</td>
            <td title="${row.applicantName}" style="max-width: 200px; white-space: normal; word-wrap: break-word;">${row.applicantName || '-'}</td>
            <td title="${row.opponent}" style="max-width: 200px; white-space: normal; word-wrap: break-word;">${row.opponent || '-'}</td>
            <td>${row.bulletinDate || '-'}</td>
            <td>${row.bulletinNo || '-'}</td>
            <td>${row.epatsDate || '-'}</td>
            <td>${statusDisplay}</td>
            <td>${docsHtml || '-'}</td>
        `;
        
        if (hasChildren) tr.dataset.groupId = row.id;
        if (isChild) tr.dataset.parentId = row.parentId;
        return tr;
    }

    formatDate(d) {
        if (!d) return '-';
        // 🔥 YENİ: Firebase (_seconds) kontrolü silindi, doğrudan string/date işleniyor.
        return formatToTRDate(d);
    }
    
    getStatusBadge(record) {
        const rawStatus = record.status;
        let displayStatus = rawStatus || '-';
        let color = 'secondary';
        
        if (record.type && STATUSES[record.type]) {
            const statusObj = STATUSES[record.type].find(s => s.value === rawStatus);
            if (statusObj) {
                displayStatus = statusObj.text;
                if (statusObj.color) color = statusObj.color;
            }
        } else {
            for (const type in STATUSES) {
                const found = STATUSES[type].find(s => s.value === rawStatus);
                if (found) {
                    displayStatus = found.text;
                    if (found.color) color = found.color;
                    break;
                }
            }
        }
        
        if (color === 'secondary') {
             const s = String(rawStatus).toLowerCase();
             // Supabase/PostgreSQL ile gelen Türkçe statülerin doğru renklendirilmesi:
             if (['registered', 'approved', 'active', 'tescilli', 'finalized', 'kesinleşti', 'kabul'].includes(s)) color = 'success';
             else if (['filed', 'application', 'pending', 'published', 'decision_pending', 'karar bekleniyor', 'başvuru', 'yayında'].includes(s)) color = 'warning';
             else if (['rejected', 'refused', 'cancelled', 'reddedildi', 'iptal', 'hükümsüz'].includes(s)) color = 'danger';
        }
        return `<span class="badge badge-${color} border">${displayStatus}</span>`;
    }
}