export class PriceListUIManager {
    constructor() {
        this.standardTariffsTableBody = document.getElementById('standardTariffsTableBody');
        this.priceListsTableBody = document.getElementById('priceListsTableBody');
        this.assignmentsTableBody = document.getElementById('assignmentsTableBody');
        this.tariffItemsTableBody = document.getElementById('tariffItemsTableBody');
    }

    toggleLoading(show) {
        if (show) {
            const loader = document.createElement('div');
            loader.id = 'simple-page-loader';
            loader.className = 'fixed-top w-100 h-100 d-flex align-items-center justify-content-center bg-white';
            loader.style.zIndex = '9999';
            loader.style.opacity = '0.8';
            loader.innerHTML = '<div class="spinner-border text-primary" role="status"></div>';
            document.body.appendChild(loader);
        } else {
            document.getElementById('simple-page-loader')?.remove();
        }
    }

    renderStandardTariffs(tariffs) {
        if (!this.standardTariffsTableBody) return;
        this.standardTariffsTableBody.innerHTML = tariffs.map(t => `
            <tr>
                <td class="font-weight-bold text-muted">${t.id}</td>
                <td><span class="font-weight-bold text-dark">${t.name}</span></td>
                <td><span class="badge ${t.fee_type === 'TP Harç' ? 'badge-warning' : 'badge-secondary'}">${t.fee_type}</span></td>
                <td style="width: 220px;">
                    <div class="input-group input-group-sm">
                        <input type="number" class="form-control font-weight-bold text-success std-fee-input" data-id="${t.id}" value="${t.amount}">
                        <div class="input-group-append"><span class="input-group-text">${t.currency}</span></div>
                    </div>
                </td>
                <td class="text-center">
                    <button class="btn btn-sm btn-primary save-std-fee-btn shadow-sm font-weight-bold" data-id="${t.id}">Güncelle</button>
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
                <td class="font-weight-bold text-muted">${idx + 1}</td>
                <td><span class="font-weight-bold text-primary">${list.name}</span></td>
                <td><span class="text-muted small">${list.description || '-'}</span></td>
                <td class="text-center"><span class="badge badge-light border text-info px-3 py-2 font-weight-bold shadow-sm">${list.itemCount} Özel Kalem</span></td>
                <td class="text-center">
                    <button class="btn btn-sm btn-outline-primary manage-items-btn shadow-sm font-weight-bold" data-id="${list.id}" data-name="${list.name}">Yönet</button>
                    <button class="btn btn-sm btn-light text-danger delete-list-btn border ml-1" data-id="${list.id}"><i class="fas fa-trash-alt"></i></button>
                </td>
            </tr>
        `).join('');
    }

    renderAssignments(persons, priceLists) {
        if (!this.assignmentsTableBody) return;

        this.assignmentsTableBody.innerHTML = persons.map(p => {
            const hasDiscount = p.discount_rate > 0;
            const hasTemplate = p.price_list_id !== null;
            
            let badgeHtml = '';
            if (hasTemplate) {
                badgeHtml = `<span class="badge badge-primary px-2 py-1 ml-2">Özel Tarife</span>`;
            } else if (hasDiscount) {
                badgeHtml = `<span class="badge badge-success px-2 py-1 ml-2">%${p.discount_rate} İskontolu Standart</span>`;
            } else {
                badgeHtml = `<span class="badge badge-light border text-secondary px-2 py-1 ml-2">Standart Fiyatlar</span>`;
            }

            return `
                <tr class="${hasDiscount || hasTemplate ? 'bg-light' : ''}">
                    <td>
                        <span class="font-weight-bold text-dark">${p.name}</span> ${badgeHtml}<br>
                        <small class="text-muted">${p.type === 'corporate' ? '<i class="fas fa-building"></i> Kurumsal' : '<i class="fas fa-user"></i> Şahıs'}</small>
                    </td>
                    <td>
                        <div class="input-group input-group-sm">
                            <input type="number" class="form-control text-center font-weight-bold discount-input" data-person-id="${p.id}" value="${p.discount_rate || 0}">
                            <div class="input-group-append"><span class="input-group-text">%</span></div>
                        </div>
                    </td>
                    <td>
                        <select class="form-control form-control-sm bg-white font-weight-bold assign-list-select" data-person-id="${p.id}">
                            <option value="" ${!p.price_list_id ? 'selected' : ''}>-- Standart Katalog --</option>
                            ${priceLists.map(pl => `<option value="${pl.id}" ${p.price_list_id === pl.id ? 'selected' : ''}>${pl.name}</option>`).join('')}
                        </select>
                    </td>
                    <td class="text-center">
                        <button class="btn btn-sm btn-success save-person-settings-btn shadow-sm font-weight-bold" data-person-id="${p.id}">Kaydet</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    renderTariffItems(items, feeTariffs) {
        if (!this.tariffItemsTableBody) return;
        this.tariffItemsTableBody.innerHTML = items.map(item => {
            let displayName = item.custom_item_name || 'Bilinmeyen Kalem';
            if (item.fee_id) {
                const tar = feeTariffs.find(f => String(f.id) === String(item.fee_id));
                displayName = tar ? tar.name : displayName;
            }
            return `
                <tr>
                    <td><span class="font-weight-bold text-dark">${displayName}</span></td>
                    <td><span class="badge badge-secondary px-2">${item.fee_type}</span></td>
                    <td class="text-right font-weight-bold text-success">${item.amount.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ${item.currency}</td>
                    <td class="text-center"><button class="btn btn-sm btn-light text-danger delete-item-btn border" data-id="${item.id}"><i class="fas fa-trash-alt"></i></button></td>
                </tr>
            `;
        }).join('');
    }

    // 🔥 YENİ: KOPYALAMA DROPDOWN'INI DOLDURMA
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