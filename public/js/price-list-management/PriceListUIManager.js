export class PriceListUIManager {
    constructor() {
        this.standardTariffsTableBody = document.getElementById('standardTariffsTableBody');
        this.priceListsTableBody = document.getElementById('priceListsTableBody');
        this.assignmentsTableBody = document.getElementById('assignmentsTableBody');
        this.tariffItemsTableBody = document.getElementById('tariffItemsTableBody');
    }

    toggleLoading(show) {
        let loader = document.getElementById('simple-page-loader');
        if (show) {
            if (!loader) {
                loader = document.createElement('div');
                loader.id = 'simple-page-loader';
                loader.className = 'fixed-top w-100 h-100 d-flex align-items-center justify-content-center bg-white';
                loader.style.zIndex = '9999';
                loader.style.opacity = '0.8';
                loader.innerHTML = '<div class="spinner-border text-primary" role="status"></div>';
                document.body.appendChild(loader);
            }
        } else {
            if (loader) loader.remove();
        }
    }

    toggleTemplateView(showDetail, title = '') {
        const listContainer = document.getElementById('templatesListContainer');
        const detailContainer = document.getElementById('templateDetailContainer');
        const titleEl = document.getElementById('detailTemplateTitle');

        if (showDetail) {
            listContainer.classList.add('d-none');
            detailContainer.classList.remove('d-none');
            titleEl.innerHTML = `<i class="fas fa-tags mr-2 text-primary"></i> ${title} <span class="text-muted ml-2" style="font-size: 1rem;">(Düzenleme Modu)</span>`;
        } else {
            listContainer.classList.remove('d-none');
            listContainer.classList.add('w-100'); 
            detailContainer.classList.add('d-none');
        }
    }

    renderStandardTariffs(tariffs) {
        if (!this.standardTariffsTableBody) return;
        this.standardTariffsTableBody.innerHTML = tariffs.map(t => `
            <tr>
                <td class="font-weight-bold text-muted px-4">${t.id}</td>
                <td class="px-4"><span class="font-weight-bold text-dark">${t.name}</span></td>
                <td class="px-4"><span class="badge ${t.fee_type === 'TP Harç' ? 'badge-warning' : 'badge-secondary'}">${t.fee_type}</span></td>
                <td class="px-4" style="width: 220px;">
                    <div class="input-group input-group-sm">
                        <input type="number" class="form-control font-weight-bold text-success std-fee-input" data-id="${t.id}" value="${t.amount}">
                        <div class="input-group-append"><span class="input-group-text">${t.currency}</span></div>
                    </div>
                </td>
                <td class="text-center px-4" style="width: 120px; min-width: 120px;">
                    <button class="btn btn-sm btn-primary save-std-fee-btn shadow-sm font-weight-bold w-100" data-id="${t.id}">Güncelle</button>
                </td>
            </tr>
        `).join('');
    }

    renderPriceLists(lists) {
        if (!this.priceListsTableBody) return;
        if (lists.length === 0) {
            this.priceListsTableBody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-muted">Hiç özel şablon yok.</td></tr>`;
            return;
        }
        this.priceListsTableBody.innerHTML = lists.map((list, idx) => `
            <tr>
                <td class="font-weight-bold text-muted px-4">${idx + 1}</td>
                <td class="px-4"><span class="font-weight-bold text-primary">${list.name}</span></td>
                <td class="px-4"><span class="text-muted small">${list.description || '-'}</span></td>
                <td class="text-center px-4"><span class="badge badge-light border text-info px-3 py-2 font-weight-bold shadow-sm">${list.itemCount} Özel Kalem</span></td>
                <td class="px-4" style="width: 180px; min-width: 180px;">
                    <div class="d-flex flex-nowrap justify-content-center align-items-center">
                        <button class="btn btn-sm btn-outline-primary manage-items-btn shadow-sm font-weight-bold" data-id="${list.id}" data-name="${list.name}">
                            <i class="fas fa-edit mr-1"></i> Yönet
                        </button>
                        <button class="btn btn-sm btn-light text-danger delete-list-btn border ml-2" data-id="${list.id}">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
    }

    // 🔥 TAB 3: MÜVEKKİL ATAMALARI (Genişlikler HTML ile uyumlu hale getirildi)
    renderAssignments(persons, priceLists) {
        if (!this.assignmentsTableBody) return;

        this.assignmentsTableBody.innerHTML = persons.map(p => {
            const hasDiscount = p.discount_rate > 0;
            const hasTemplate = p.price_list_id !== null;
            
            let badgeHtml = '';
            if (hasTemplate) badgeHtml = `<span class="badge badge-primary px-2 py-1 ml-2">Özel Tarife</span>`;
            else if (hasDiscount) badgeHtml = `<span class="badge badge-success px-2 py-1 ml-2">%${p.discount_rate} İskonto</span>`;
            else badgeHtml = `<span class="badge badge-light border text-secondary px-2 py-1 ml-2">Standart</span>`;

            return `
                <tr class="assignment-row ${hasDiscount || hasTemplate ? 'bg-light' : ''}">
                    <td class="px-4 client-name-td">
                        <span class="font-weight-bold text-dark">${p.name}</span> ${badgeHtml}
                    </td>
                    <td class="px-4" style="width: 130px; min-width: 130px;">
                        <div class="input-group input-group-sm">
                            <input type="number" class="form-control text-center font-weight-bold discount-input px-1" data-person-id="${p.id}" value="${p.discount_rate || 0}">
                            <div class="input-group-append"><span class="input-group-text px-1">%</span></div>
                        </div>
                    </td>
                    <td class="px-4" style="width: 300px; min-width: 300px;">
                        <select class="form-control form-control-sm bg-white font-weight-bold assign-list-select" data-person-id="${p.id}">
                            <option value="" ${!p.price_list_id ? 'selected' : ''}>-- Standart Katalog --</option>
                            ${priceLists.map(pl => `<option value="${pl.id}" ${p.price_list_id === pl.id ? 'selected' : ''}>${pl.name}</option>`).join('')}
                        </select>
                    </td>
                    <td class="text-center px-4" style="width: 110px; min-width: 110px;">
                        <button class="btn btn-sm btn-outline-success save-person-settings-btn shadow-sm font-weight-bold w-100 px-1" data-person-id="${p.id}">Kaydet</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    renderTariffItems(items, feeTariffs) {
        if (!this.tariffItemsTableBody) return;
        if(items.length === 0) {
             this.tariffItemsTableBody.innerHTML = `<tr><td colspan="4" class="text-center py-5 text-muted">Bu şablonda henüz fiyat yok. Üst taraftan eklemeye başlayın.</td></tr>`;
             return;
        }

        this.tariffItemsTableBody.innerHTML = items.map(item => {
            let displayName = item.custom_item_name || 'Bilinmeyen Kalem';
            if (item.fee_id) {
                const tar = feeTariffs.find(f => String(f.id) === String(item.fee_id));
                displayName = tar ? tar.name : displayName;
            }
            return `
                <tr>
                    <td class="px-4"><span class="font-weight-bold text-dark">${displayName}</span></td>
                    <td class="px-4"><span class="badge ${item.fee_type === 'TP Harç' ? 'badge-warning' : 'badge-secondary'} px-2">${item.fee_type}</span></td>
                    <td class="px-4" style="width: 220px;">
                        <div class="input-group input-group-sm">
                            <input type="number" class="form-control font-weight-bold text-success custom-fee-input" data-id="${item.id}" value="${item.amount}">
                            <div class="input-group-append"><span class="input-group-text">${item.currency}</span></div>
                        </div>
                    </td>
                    <td class="px-4" style="width: 180px; min-width: 180px;">
                        <div class="d-flex flex-nowrap justify-content-center align-items-center">
                            <button class="btn btn-sm btn-primary update-custom-fee-btn shadow-sm font-weight-bold" data-id="${item.id}">Güncelle</button>
                            <button class="btn btn-sm btn-light text-danger delete-item-btn border ml-2" data-id="${item.id}" title="Sil"><i class="fas fa-trash-alt"></i></button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    populateCopyDropdown(priceLists) {
        const select = document.getElementById('plCopyFrom');
        if (!select) return;
        select.innerHTML = `
            <option value="">-- Tamamen Boş Şablon Oluştur --</option>
            <option value="standard" class="font-weight-bold text-success">🎯 Tüm Standart Kataloğu Kopyala</option>
            ${priceLists.map(pl => `<option value="${pl.id}">📦 ${pl.name} Şablonunu Kopyala</option>`).join('')}
        `;
    }

    populateFeeDropdown(feeTariffs) {
        const select = document.getElementById('itemFeeId');
        if (!select) return;
        select.innerHTML = `<option value="">-- Katalog Dışı (Özel İsim Belirle) --</option>` + 
            feeTariffs.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
    }
}