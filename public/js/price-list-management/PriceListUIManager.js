// public/js/price-list-management/PriceListUIManager.js
export class PriceListUIManager {
    constructor() {
        this.priceListsTableBody = document.getElementById('priceListsTableBody');
        this.assignmentsTableBody = document.getElementById('assignmentsTableBody');
        this.tariffItemsTableBody = document.getElementById('tariffItemsTableBody');
    }

    toggleLoading(show) {
        const container = document.body;
        if (show) {
            const loader = document.createElement('div');
            loader.id = 'simple-page-loader';
            loader.className = 'fixed-top w-100 h-100 d-flex align-items-center justify-content-center bg-white';
            loader.style.zIndex = '9999';
            loader.style.opacity = '0.8';
            loader.innerHTML = '<div class="spinner-border text-primary" role="status"></div>';
            container.appendChild(loader);
        } else {
            document.getElementById('simple-page-loader')?.remove();
        }
    }

    renderPriceLists(lists) {
        if (!this.priceListsTableBody) return;
        if (lists.length === 0) {
            this.priceListsTableBody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-muted"><i class="fas fa-info-circle mb-2" style="font-size: 24px; opacity: 0.5;"></i><br>Henüz hiç tarife şablonu tanımlanmamış.</td></tr>`;
            return;
        }

        this.priceListsTableBody.innerHTML = lists.map((list, idx) => `
            <tr>
                <td class="font-weight-bold text-muted">${idx + 1}</td>
                <td><span class="font-weight-bold text-primary" style="font-size: 1.05rem;">${list.name}</span></td>
                <td><span class="text-muted small">${list.description || '-'}</span></td>
                <td class="text-center"><span class="badge badge-light border text-info px-3 py-2 font-weight-bold shadow-sm">${list.itemCount} Özel Kalem</span></td>
                <td class="text-center">
                    <button class="btn btn-sm btn-outline-primary manage-items-btn shadow-sm font-weight-bold" data-id="${list.id}" data-name="${list.name}">
                        <i class="fas fa-cog mr-1"></i> Yönet
                    </button>
                    <button class="btn btn-sm btn-light text-danger delete-list-btn ml-1 border" data-id="${list.id}" title="Tarifeyi Sil">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }

    renderAssignments(persons, priceLists) {
        if (!this.assignmentsTableBody) return;

        const optionsHtml = `<option value="">-- Standart Genel Tarife --</option>` + 
            priceLists.map(pl => `<option value="${pl.id}">${pl.name}</option>`).join('');

        this.assignmentsTableBody.innerHTML = persons.map(p => {
            const matchedList = priceLists.find(l => l.id === p.price_list_id);
            const currentListName = matchedList ? matchedList.name : '<span class="text-muted"><i class="fas fa-globe mr-1"></i> Standart Genel Tarife</span>';
            const badgeClass = matchedList ? 'badge-primary shadow-sm' : 'badge-light border text-secondary';

            return `
                <tr>
                    <td>
                        <span class="font-weight-bold text-dark">${p.name}</span> <br>
                        <small class="text-muted">${p.type === 'corporate' ? '<i class="fas fa-building mr-1"></i> Kurumsal' : '<i class="fas fa-user mr-1"></i> Şahıs'}</small>
                    </td>
                    <td><span class="badge ${badgeClass} px-3 py-2" id="badge-p-${p.id}" style="font-size: 0.85rem;">${currentListName}</span></td>
                    <td class="text-center">
                        <select class="form-control form-control-sm bg-light border-0 font-weight-bold assign-list-select" data-person-id="${p.id}" style="cursor: pointer;">
                            ${priceLists.map(pl => `<option value="${pl.id}" ${p.price_list_id === pl.id ? 'selected' : ''}>${pl.name}</option>`).join('')}
                            <option value="" ${!p.price_list_id ? 'selected' : ''}>-- Standart Genel Tarife --</option>
                        </select>
                    </td>
                </tr>
            `;
        }).join('');
    }

    renderTariffItems(items, feeTariffs) {
        if (!this.tariffItemsTableBody) return;
        if (items.length === 0) {
            this.tariffItemsTableBody.innerHTML = `<tr><td colspan="4" class="text-center py-5 text-muted"><i class="fas fa-folder-open mb-3" style="font-size: 32px; opacity: 0.3;"></i><br>Bu şablonda henüz hiç özel fiyatlama bulunmuyor.<br><small>Sol taraftaki formu kullanarak yeni bir kalem ekleyin.</small></td></tr>`;
            return;
        }

        this.tariffItemsTableBody.innerHTML = items.map(item => {
            let displayName = item.custom_item_name || 'Bilinmeyen Kalem';
            if (item.fee_id) {
                const tar = feeTariffs.find(f => String(f.id) === String(item.fee_id));
                displayName = tar ? (tar.alias || tar.name) : displayName;
            }

            return `
                <tr>
                    <td>
                        <span class="font-weight-bold text-dark">${displayName}</span> 
                        ${item.fee_id ? '<br><small class="badge badge-light border border-warning text-warning mt-1"><i class="fas fa-cut mr-1"></i> Katalog Değerini Ezer</small>' : '<br><small class="badge badge-light border border-info text-info mt-1"><i class="fas fa-star mr-1"></i> Tamamen Özel Kalem</small>'}
                    </td>
                    <td><span class="badge badge-secondary px-2 py-1">${item.fee_type === 'Hizmet' ? 'Hizmet Bedeli' : 'Resmi Harç'}</span></td>
                    <td class="text-right font-weight-bold text-success" style="font-size: 1.1rem;">
                        ${item.amount.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ${item.currency}
                    </td>
                    <td class="text-center">
                        <button class="btn btn-sm btn-light border text-danger delete-item-btn shadow-sm" data-id="${item.id}" title="Kalemi Sil">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    populateFeeDropdown(feeTariffs) {
        const select = document.getElementById('itemFeeId');
        if (!select) return;
        select.innerHTML = `<option value="">-- Katalog Dışı (Özel İsim Belirle) --</option>` + 
            feeTariffs.map(f => `<option value="${f.id}">${f.alias || f.name}</option>`).join('');
    }
}