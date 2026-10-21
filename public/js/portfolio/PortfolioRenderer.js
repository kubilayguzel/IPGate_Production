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

    renderStandardRow(record, isTrademarkTab, isSelected, subTab = null, isMonitored = false) {
        const tr = document.createElement('tr');
        tr.dataset.id = record.id;
        
        const isWipoParent = (record.origin === 'WIPO' || record.origin === 'ARIPO') && record.transactionHierarchy === 'parent';
        const isChild = record.transactionHierarchy === 'child'; 
        
        if (isWipoParent) {
            tr.dataset.groupId = record.id;
            tr.className = 'group-header';
            tr.style.backgroundColor = '#e3f2fd'; 
        } else if (isChild) {
             tr.style.backgroundColor = '#ffffff';
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

        const caret = isWipoParent ? `<i class="fas fa-chevron-right row-caret" style="cursor:pointer; padding: 5px;"></i>` : '';
        const titleText = record.title || record.brandText || '-';
        const appNoText = record.applicationNumber || record.wipoIR || record.aripoIR || '-'; 
        const applicantText = record.formattedApplicantName || record.applicantName || '-';

        // 🔥 İZLEME LİSTESİ İKONU VE RENKLENDİRMESİ
        const monitorHtml = isMonitored 
            ? `<a href="monitoring-trademarks.html?filterId=${record.id}" target="_blank" data-toggle="tooltip" title="İzleme Detayını Aç">
                 <i class="fas fa-eye text-success mr-2" style="font-size: 1.15em; cursor: pointer; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform='scale(1)'"></i>
               </a>` 
            : '';
        const titleColorClass = isMonitored ? 'text-success' : '';

        let html = `
            <td><input type="checkbox" class="record-checkbox" data-id="${record.id}" ${isSelected ? 'checked' : ''}></td>
            <td class="toggle-cell text-center" style="vertical-align: middle;">${caret}</td>
        `;

        if (!isTrademarkTab) html += `<td>${record.type || '-'}</td>`;

        // Başlığa rengi ve göz ikonunu ekledik
        html += `<td class="record-title-cell" title="${titleText}" ${isChild ? 'style="padding-left: 25px; border-left: 3px solid #6c757d;"' : ''}>
                    ${isChild ? '↳ ' : ''}${monitorHtml}<strong class="${titleColorClass}">${titleText}</strong>
                 </td>`;

        if (isTrademarkTab) {
            html += imgHtml;
            html += `<td>${record.origin || '-'}</td>`;
            
            // 🔥 ÇÖZÜM: Sadece alt sekme turkpatent değilse Ülke kodunu çiz!
            if (subTab !== 'turkpatent') {
                html += `<td title="${countryName}">${countryName}</td>`;
            }
        }

        if (appNoText && appNoText !== '-') {
            html += `<td title="Portföy detayını aç"><a href="portfolio-detail.html?id=${record.id}" target="_blank" style="color: #1e3c72; font-weight: 600; text-decoration: underline;">${appNoText}</a></td>`;
        } else {
            html += `<td title="${appNoText}">${appNoText}</td>`;
        }
        
        html += `<td>${record.formattedApplicationDate || '-'}</td>`;

        // 🔥 GÜNCELLEME 1 & 2: Yurtdışı sekmesi ise eksik olan Yenileme Tarihi kolonunu buraya ekliyoruz.
        // Bu sayede hem veri görünür olacak hem de tablodaki sütun kayması (Ülke, Durum vb. uyuşmazlığı) düzelecektir.
        if (isTrademarkTab && subTab !== 'turkpatent') {
            const renDate = record.renewalDate ? this.formatDate(record.renewalDate) : '-';
            html += `<td>${renDate}</td>`;
        }
        
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
        
        // --- 1. VERİLERİ DOĞRUDAN RAW JSON'DAN GÜVENLE AL ---
        // Veritabanı isimlerini (suit_type) ana öncelik yapıyoruz.
        const suitType = row.suit_type || row.suitType || '-';
        const caseNo = row.file_no || row.caseNo || '-';
        const court = row.court_name || row.court || '-';
        const opposingParty = row.opposing_party || row.opposingParty || '-';
        const title = row.title || '-';
        const openedDate = row.opening_date || row.openedDate || row.created_at;

        // --- 2. MÜVEKKİL (CLIENT) İSMİNİ BUL ---
        let clientName = '-';
        if (row.client_id && this.dataManager && this.dataManager.personsMap) {
            const person = this.dataManager.personsMap.get(row.client_id);
            if (person) clientName = person.name;
        } else if (row.clientName) {
            clientName = row.clientName;
        }

        // --- 3. VARLIK (IP RECORD / MARKA) İSMİNİ BUL ---
        let assetName = '-';
        if (row.ip_record_id && this.dataManager) {
            const asset = this.dataManager.getRecordById(row.ip_record_id);
            if (asset) {
                assetName = asset.title || asset.brandText || asset.brand_name || asset.applicationNumber || '-';
            }
        } else if (row.assetName) {
            assetName = row.assetName;
        }

        // --- 4. RENKLENDİRME VE BUTONLAR ---
        const suitTypeStr = String(suitType);
        if (suitTypeStr.includes('İptal')) tr.style.backgroundColor = '#ffebee';
        else if (suitTypeStr.includes('Tecavüz')) tr.style.backgroundColor = '#fff3e0';
        
        const actions = `
            <div class="d-flex gap-1 justify-content-end">
                <button class="action-btn view-btn btn btn-sm btn-info" data-id="${row.id}" title="Görüntüle"><i class="fas fa-eye"></i></button>
                <button class="action-btn edit-btn btn btn-sm btn-warning" data-id="${row.id}" title="Düzenle"><i class="fas fa-edit"></i></button>
            </div>`;
            
        const statusBadge = this.getStatusBadge(row);

        // --- 5. TABLO HÜCRELERİNİ ÇİZ ---
        tr.innerHTML = `
            <td><strong>${index}</strong></td>
            <td title="${title}">
                ${title}
                <br>
                <small class="text-muted" title="Varlık: ${assetName}"><i class="fas fa-layer-group mr-1"></i> ${assetName}</small>
            </td>
            <td title="${suitType}">${suitType}</td>
            <td title="${caseNo}">${caseNo}</td>
            <td title="${court}">${court}</td>
            <td title="${clientName}">${clientName}</td>
            <td title="${opposingParty}">${opposingParty}</td>
            <td>${this.formatDate(openedDate)}</td>
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

        const safeText = value => String(value ?? '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const safeHref = value => {
            const uri = String(value || '').trim();
            // Sadece web adresleri ve uygulama içi göreli dosya yolları bağlanabilir.
            if (/^https?:\/\//i.test(uri) || (/^\/?[a-z0-9_.-][a-z0-9_./-]*$/i.test(uri) && !uri.startsWith('//'))) {
                return safeText(uri);
            }
            return null;
        };
        // Tekrarlanan marka/kişi bilgilerini yan yana ayrı sütunlar yerine
        // anlamlı ikincil satırlar halinde gösteriyoruz.
        const normalizeDisplay = value => String(value || '').trim().toLocaleLowerCase('tr-TR');
        const distinct = (left, right) => normalizeDisplay(left) &&
            normalizeDisplay(left) !== normalizeDisplay(right) && String(left) !== '-';
        const title = safeText(row.title || '-');
        const appNo = row.applicationNumber && row.applicationNumber !== '-'
            ? `<span class="opp-cell-muted">Başvuru: ${safeText(row.applicationNumber)}</span>` : '';
        const nice = row.niceClassesText && row.niceClassesText !== '-'
            ? `<span class="opp-cell-muted">Nice: ${safeText(row.niceClassesText)}</span>` : '';
        const clientMark = distinct(row.clientMark, row.title)
            ? `<span class="opp-cell-subline"><span class="opp-cell-kicker">Müvekkil markası:</span> ${safeText(row.clientMark)}</span>` : '';
        const opposedMark = distinct(row.opposedMark, row.title) && distinct(row.opposedMark, row.clientMark)
            ? `<span class="opp-cell-subline"><span class="opp-cell-kicker">Karşı marka:</span> ${safeText(row.opposedMark)}</span>` : '';
        // Karşı taraf, işlem yönüne göre atanır. Bizim itirazımızda başvuru sahibi
        // zaten karşı taraftır; iki satırda aynı ismi tekrarlamıyoruz.
        const applicant = row.applicantName && row.applicantName !== '-' &&
            !(row.partyDirection === 'outgoing' && row.opponent && !distinct(row.applicantName, row.opponent))
            ? `<span class="opp-cell-subline"><span class="opp-cell-kicker">Başvuru sahibi:</span> ${safeText(row.applicantName)}</span>` : '';
        const opponent = row.objectionProcessType !== '7' && row.opponent
            ? `<span class="opp-cell-subline"><span class="opp-cell-kicker">${row.partyDirection === 'outgoing' ? 'Karşı taraf (başvuru sahibi)' : 'Karşı taraf (itiraz eden)'}:</span> ${safeText(row.opponent)}</span>` : '';
        const roleText = safeText(row.clientRole || 'Doğrulanamadı');
        const roleClass = row.clientRole === 'Doğrulanamadı' ? ' opp-unknown' : '';
        const roleHtml = `<span class="opp-role${roleClass}" title="${safeText(row.roleSource || '')}">${roleText}</span>`;
        const bulletinText = row.bulletinNo && row.bulletinNo !== '-'
            ? `Bülten ${safeText(row.bulletinNo)}` : '';
        const bulletinDate = row.bulletinDate && row.bulletinDate !== '-'
            ? ` · ${safeText(row.bulletinDate)}` : '';
        const bulletinLine = bulletinText || bulletinDate
            ? `<span class="opp-cell-muted">${bulletinText}${bulletinDate}</span>` : '';
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

            const href = safeHref(doc.fileUrl);
            if (!href) return '';
            return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="pdf-link" title="${safeText(doc.fileName || 'Evrak')}">
                <i class="fas ${iconClass}" style="color:${iconColor}; font-size:1.3em;"></i></a>`;
        }).join('');

        const taskLink = row.taskId ? `<a href="task-update.html?id=${encodeURIComponent(String(row.taskId))}"
            target="_blank" rel="noopener noreferrer" class="pdf-link" title="Bağlı görevi aç">
            <i class="fas fa-external-link-alt"></i></a>` : '';

        const caret = hasChildren ? `<i class="fas fa-chevron-right row-caret" style="cursor:pointer;"></i>` : '';
        const indentation = isChild ? 'style="padding-left: 30px; border-left: 3px solid #f39c12;"' : '';
        
        // 🔥 ÇÖZÜM 2: İtiraz sonuçlarını (Kabul, Ret vb.) renklendirerek göze çarpmasını sağlıyoruz
        let statusDisplay = '';
        if (!isChild) {
            let badgeColor = 'secondary';
            const sText = String(row.statusText || '').toLowerCase();
            
            if (sText.includes('bekleniyor') || sText.includes('devam')) badgeColor = 'warning';
            else if (sText.includes('kabul') && !sText.includes('kısmen')) badgeColor = 'success';
            else if (sText.includes('ret') || sText.includes('red')) badgeColor = 'danger';
            else if (sText.includes('kısmen')) badgeColor = 'info';
            else badgeColor = 'primary';
            
            statusDisplay = `<span class="badge badge-${badgeColor} px-2 py-1 shadow-sm">${safeText(row.statusText || '-')}</span>`;
        }

        tr.innerHTML = `
            <td class="toggle-cell text-center">${caret}</td>
            <td title="${title}" ${indentation}>
                ${isChild ? '<span aria-hidden="true">↳ </span>' : ''}<span class="opp-cell-title">${title}</span>
                ${appNo}${nice}
            </td>
            <td><span class="opp-cell-title">${safeText(row.transactionTypeName || '-')}</span>
                <span class="opp-cell-muted">${roleHtml}</span>
            </td>
            <td>${clientMark}${opposedMark}${applicant}${opponent || ''}
                ${!clientMark && !opposedMark && !applicant && !opponent ? '<span class="opp-cell-muted">—</span>' : ''}
            </td>
            <td><span class="opp-cell-title">${safeText(row.epatsDate || '-')}</span>${bulletinLine}</td>
            <td>${statusDisplay}</td>
            <td><div class="opp-doc-actions">${docsHtml || (taskLink ? '' : '—')}${taskLink}</div>
                <button type="button" class="opp-detail-button" data-id="${safeText(row.id)}"
                    data-child="${isChild ? 'true' : 'false'}" aria-label="Dosyanın tüm bilgilerini gör">Ayrıntılar</button>
            </td>
        `;
        tr.dataset.oppId = String(row.id);
        tr.dataset.oppChild = String(isChild);

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