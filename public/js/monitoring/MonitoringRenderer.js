import { supabase } from '../../supabase-config.js';

export class MonitoringRenderer {
    constructor(containerId, dataManager) {
        this.containerId = containerId;
        this.dataManager = dataManager;
    }

    get container() { return document.getElementById(this.containerId); }

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

        const isIntl = this.dataManager.currentTab === 'international';

        let html = `<table class="accruals-table"><thead><tr>`;
        
        if (!isIntl) {
            // YURTİÇİ TABLO BAŞLIKLARI
            html += `<th style="width: 40px; text-align: center; overflow: visible; text-overflow: clip;"><input type="checkbox" id="headerSelectAllCheckbox" /></th>
            <th style="width: 100px; text-align: center;">Görsel</th>
                     <th class="sortable" data-sort="markName" style="cursor:pointer; width: 220px;">Marka Adı ${getSortIcon('markName')}</th>
                     <th style="width: 250px;">Aranacak İbareler</th>
                     <th class="sortable" data-sort="owner" style="cursor:pointer; width: auto;">Sahip ${getSortIcon('owner')}</th>
                     <th style="width: 130px;">Başvuru No</th>
                     <th class="sortable" data-sort="applicationDate" style="cursor:pointer; width: 120px;">Başvuru Tarihi ${getSortIcon('applicationDate')}</th>
                     <th style="width: 150px;">Nice Sınıfı</th>
                     <th style="width: 100px; text-align: center;">Durum</th>`;
        } else {
            // YURTDIŞI TABLO BAŞLIKLARI (Marka/Sahip 40px daraltıldı, diğerlerine paylaştırıldı)
            html += `<th style="width: 100px; text-align: center;">Görsel</th>
                     <th class="sortable" data-sort="markName" style="cursor:pointer; width: auto; min-width: 160px;">Marka Adı ${getSortIcon('markName')}</th>
                     <th class="sortable" data-sort="owner" style="cursor:pointer; width: auto; min-width: 160px;">Sahip ${getSortIcon('owner')}</th>
                     <th style="width: 130px;">Başvuru No</th>
                     <th class="sortable" data-sort="applicationDate" style="cursor:pointer; width: 120px;">Başvuru Tarihi ${getSortIcon('applicationDate')}</th>
                     <th style="width: 140px;">Nice Sınıfı</th>
                     <th style="width: 170px;">İzlenecek Ülkeler</th>
                     <th style="width: 120px;">Başlangıç Tarihi</th>
                     <th style="width: 120px;">Bitiş Tarihi</th>
                     <th style="width: 130px; min-width: 130px; text-align: center;">İşlemler</th>`;
        }
        
        html += `</tr></thead><tbody>`;

        if (!data || data.length === 0) {
            html += `<tr><td colspan="${isIntl ? 10 : 9}" class="text-center py-4 text-muted">Kayıt bulunamadı.</td></tr>`;
        } else {
            data.forEach(r => {
                const isSelected = selectedItems.has(r.id) ? 'checked' : '';
                const rowClass = selectedItems.has(r.id) ? 'selected-row' : '';

                const trademarkImageHtml = (() => {
                    let imageUrl = r.brandImageUrl;
                    if (imageUrl && imageUrl.trim() !== '') {
                        if (!imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
                            const { data } = supabase.storage.from('brand_images').getPublicUrl(imageUrl);
                            imageUrl = data.publicUrl || imageUrl;
                        }
                        return `<img src="${imageUrl}" class="trademark-image-thumbnail" loading="lazy" style="width: 80px; height: 80px; object-fit: contain; border-radius: 6px; border: 1px solid #ddd;">`;
                    }
                    return '<span style="color:#999; font-size:12px;">🖼️ Yok</span>';
                })();

                const markNameText = r.title || r.markName || '-';
                let markNameHtml = `<strong>${markNameText}</strong>`;
                if (r.monitoringType === 'domestic' && r.ipRecordId) {
                    markNameHtml = `<a href="portfolio-detail.html?id=${r.ipRecordId}" target="_blank" title="Portföy Detayına Git"><strong>${markNameText}</strong></a>`;
                }

                const statusInfo = this.getStatusInfo(r.status);
                const ownerNames = this.dataManager.getOwnerNames(r);
                
                let searchTermsHtml = '-';
                if (r.monitoringType === 'domestic') {
                    const bt = r.brandTextSearch || [];
                    searchTermsHtml = bt.length > 0 ? bt.map(t => `<span class="badge badge-info mb-1">${t}</span>`).join(' ') : '-';
                }

                const nc = r.niceClasses || [];
                const niceClassesHtml = nc.length > 0 ? nc.map(c => `<span class="badge badge-secondary mb-1">${c}</span>`).join(' ') : '-';

                // Satır Çizimi
                let rowHtml = `<tr data-id="${r.id}" class="${rowClass}">`;
                if (!isIntl) {
                    rowHtml += `<td style="text-align: center; overflow: visible; text-overflow: clip;"><input type="checkbox" class="row-checkbox" data-id="${r.id}" ${isSelected}></td>
                                <td style="text-align: center;">${trademarkImageHtml}</td>
                                <td title="${markNameText}">${markNameHtml}</td>
                                <td>${searchTermsHtml}</td>
                                <td><div class="owner-cell" title="${ownerNames}">${ownerNames}</div></td>
                                <td>${r.applicationNumber || '-'}</td>
                                <td>${this.formatTurkishDate(r.applicationDate)}</td>
                                <td>${niceClassesHtml}</td>
                                <td style="text-align: center;"><span class="badge badge-${statusInfo.color}">${statusInfo.text}</span></td>`;
                } else {
                    rowHtml += `<td style="text-align: center;">${trademarkImageHtml}</td>
                                <td title="${markNameText}">${markNameHtml}</td>
                                <td><div class="owner-cell" title="${ownerNames}">${ownerNames}</div></td>
                                <td>${r.applicationNumber || '-'}</td>
                                <td>${this.formatTurkishDate(r.applicationDate)}</td>
                                <td>${niceClassesHtml}</td>
                                <td>${r.monitoredCountries && r.monitoredCountries.length ? r.monitoredCountries.join(', ') : '-'}</td>
                                <td>${this.formatTurkishDate(r.monitoringStartDate)}</td>
                                <td>${this.formatTurkishDate(r.monitoringEndDate)}</td>
                                <td style="white-space: nowrap; text-align: center;">
                                    <button class="btn btn-sm btn-info edit-intl-btn" data-id="${r.id}" title="Düzenle"><i class="fas fa-edit"></i></button>
                                    <button class="btn btn-sm btn-danger delete-intl-btn" data-id="${r.id}" title="Sil"><i class="fas fa-trash"></i></button>
                                </td>`;
                }
                rowHtml += `</tr>`;
                html += rowHtml;
            });
        }
        html += `</tbody></table>`;
        this.container.innerHTML = html;
        this.setupImageHover();
    }

    getStatusInfo(status) {
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
                hoverElement.style.cssText = `position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 300px; height: 300px; object-fit: contain; border: 3px solid #1e3c72; border-radius: 10px; box-shadow: 0 15px 40px rgba(0,0,0,0.5); z-index: 10000; pointer-events: none; background: white;`;
                document.body.appendChild(hoverElement);
            });
            img.addEventListener('mouseleave', () => {
                if (hoverElement) {
                    document.body.removeChild(hoverElement);
                    hoverElement = null;
                }
            });
        });
    }
}