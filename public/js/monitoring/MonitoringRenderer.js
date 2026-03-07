import { supabase } from '../../supabase-config.js';

export class MonitoringRenderer {
    constructor(containerId, dataManager) {
        this.containerId = containerId;
        this.dataManager = dataManager;
    }

    get container() {
        return document.getElementById(this.containerId);
    }

    showLoading(text = 'Yükleniyor...') {
        if (this.container) {
            this.container.innerHTML = `<div class="loading"><i class="fas fa-spinner fa-spin"></i> ${text}</div>`;
        }
    }

    renderEmpty(message) {
        if (this.container) {
            this.container.innerHTML = `<div class="no-records">${message}</div>`;
        }
    }

    renderTable(data, selectedItems, currentSort) {
        if (!this.container) return;

        const getSortIcon = (field) => {
            if (currentSort.field !== field) return '<i class="fas fa-sort" style="color:#ccc; font-size:0.8em; margin-left:5px;"></i>';
            return currentSort.direction === 'asc' ? '<i class="fas fa-sort-up" style="color:#333; margin-left:5px;"></i>' : '<i class="fas fa-sort-down" style="color:#333; margin-left:5px;"></i>';
        };

        let html = `<table class="accruals-table"><thead><tr>
                        <th><input type="checkbox" id="headerSelectAllCheckbox" /></th>
                        <th>Görsel</th>
                        <th class="sortable" data-sort="markName" style="cursor:pointer">Marka Adı ${getSortIcon('markName')}</th>
                        <th>Aranacak İbareler</th>
                        <th class="sortable" data-sort="owner" style="cursor:pointer">Sahip ${getSortIcon('owner')}</th>
                        <th>Başvuru No</th>
                        <th class="sortable" data-sort="applicationDate" style="cursor:pointer">Başvuru Tarihi ${getSortIcon('applicationDate')}</th>
                        <th>Nice Sınıfı</th>
                        <th>Durum</th>
                    </tr></thead><tbody>`;

        data.forEach(r => {
            const isSelected = selectedItems.has(r.id) ? 'checked' : '';
            const rowClass = isSelected ? 'selected-row' : '';
            
            const trademarkImageHtml = (() => {
                let imageUrl = r.brandImageUrl || r.imagePath;
                if (imageUrl && imageUrl.trim() !== '') {
                    if (!imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
                        const { data } = supabase.storage.from('brand_images').getPublicUrl(imageUrl);
                        imageUrl = data.publicUrl || imageUrl;
                    }
                    return `<img src="${imageUrl}" class="trademark-image-thumbnail" loading="lazy" style="width: 80px; height: 80px; object-fit: contain; border-radius: 6px; border: 1px solid #ddd;">`;
                }
                return '<span style="color:#999; font-size:12px;">🖼️ Yok</span>';
            })();

            const markNameText = r.markName || r.title || '-';
            let markNameHtml = markNameText;
            if (r.ipRecordId) {
                markNameHtml = `<a href="portfolio-detail.html?id=${r.ipRecordId}" target="_blank" style="color: #1e3c72; font-weight:600; text-decoration: underline;">${markNameText}</a>`;
            }

            const ownerNames = this.dataManager.getOwnerNames(r);

            const searchTermsHtml = (() => {
                 let htmlParts = [];
                 if (r.searchMarkName) htmlParts.push(`<span style="color:#007bff; font-weight:bold;">${r.searchMarkName}</span>`);
                 if (Array.isArray(r.brandTextSearch)) {
                     r.brandTextSearch.forEach(t => { if (t !== r.searchMarkName) htmlParts.push(t); });
                 }
                 if (htmlParts.length === 0) return `<span style="color:#999; font-style:italic;">${markNameText}</span>`;
                 return htmlParts.join(' <span style="color:#ccc; margin:0 4px;">|</span> ');
            })();

            const statusInfo = this.getStatusInTurkish(r.status);
            
            const niceClassesHtml = (() => {
                const classes = new Set();
                if (r.niceClassSearch) r.niceClassSearch.forEach(c => classes.add(String(c)));
                if (r.niceClasses) r.niceClasses.forEach(c => classes.add(String(c)));
                if (classes.size > 0) {
                    return Array.from(classes).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)
                        .map(cls => `<span class="badge badge-info mr-1" style="font-size:12px;">${cls}</span>`).join(' ');
                }
                return '-';
            })();

            html += `<tr data-id="${r.id}" class="${rowClass}">
                        <td><input type="checkbox" class="row-checkbox" data-id="${r.id}" ${isSelected}></td>
                        <td>${trademarkImageHtml}</td>
                        <td title="${markNameText}">${markNameHtml}</td>
                        <td>${searchTermsHtml}</td>
                        <td><div class="owner-cell" title="${ownerNames}">${ownerNames}</div></td>
                        <td>${r.applicationNumber || '-'}</td>
                        <td>${this.formatTurkishDate(r.applicationDate)}</td>
                        <td>${niceClassesHtml}</td>
                        <td><span class="badge badge-${statusInfo.color}">${statusInfo.text}</span></td>
                    </tr>`;
        });

        html += `</tbody></table>`;
        this.container.innerHTML = html;
        this.setupImageHover();
    }

    getStatusInTurkish(status) {
        if (!status) return { text: 'Bilinmiyor', color: 'secondary' };
        const s = String(status).toLowerCase();
        if (['registered', 'approved', 'active', 'tescilli'].includes(s)) return { text: 'Tescilli', color: 'success' };
        if (['filed', 'application', 'başvuru'].includes(s)) return { text: 'Başvuru', color: 'primary' };
        if (['published', 'yayında'].includes(s)) return { text: 'Yayında', color: 'warning' };
        if (['rejected', 'refused', 'cancelled', 'iptal'].includes(s)) return { text: 'Red/İptal', color: 'danger' };
        if (['pending'].includes(s)) return { text: 'Beklemede', color: 'info' };
        return { text: status, color: 'secondary' };
    }

    formatTurkishDate(dateString) {
        if (!dateString) return '-';
        try {
            const date = new Date(dateString);
            return isNaN(date.getTime()) ? dateString : date.toLocaleDateString('tr-TR');
        } catch (e) { return dateString; }
    }

    setupImageHover() {
        this.container.querySelectorAll('.trademark-image-thumbnail').forEach(img => {
            let hoverElement = null;
            img.addEventListener('mouseenter', (e) => {
                hoverElement = document.createElement('img');
                hoverElement.src = e.target.src;
                hoverElement.style.cssText = `position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 300px; height: 300px; object-fit: contain; border: 3px solid #1e3c72; border-radius: 10px; box-shadow: 0 15px 40px rgba(0,0,0,0.4); z-index: 9999; pointer-events: none; background: white; padding: 10px;`;
                document.body.appendChild(hoverElement);
            });
            img.addEventListener('mouseleave', () => { if (hoverElement) hoverElement.remove(); });
        });
    }
}