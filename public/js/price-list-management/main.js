// public/js/price-list-management/main.js
import { PriceListDataManager } from './PriceListDataManager.js';
import { PriceListUIManager } from './PriceListUIManager.js';
import { loadSharedLayout } from '../layout-loader.js';
import { showNotification } from '../../utils.js';

document.addEventListener('DOMContentLoaded', async () => {
    // Sayfa iskeletini ve shared layout'u yükle
    await loadSharedLayout({ activeMenuLink: 'price-lists.html' });
    
    // Yüklenen arayüze active sınıfı ver ki sekmeler ve scriptler çalışsın
    $('a[data-toggle="tab"]').on('click', function (e) {
        e.preventDefault();
        $(this).tab('show');
    });

    const dataManager = new PriceListDataManager();
    const uiManager = new PriceListUIManager();

    async function loadAndRender() {
        uiManager.toggleLoading(true);
        try {
            await dataManager.fetchAllData();
            uiManager.renderPriceLists(dataManager.allPriceLists);
            uiManager.renderAssignments(dataManager.allPersons, dataManager.allPriceLists);
            uiManager.populateFeeDropdown(dataManager.allFeeTariffs);
        } catch (e) {
            showNotification("Veriler yüklenirken hata oluştu.", "error");
        } finally {
            uiManager.toggleLoading(false);
        }
    }

    // --- ELEMENT OLAYLARI VE TETİKLEYİCİLER ---
    
    document.getElementById('btnCreatePriceList')?.addEventListener('click', () => {
        document.getElementById('priceListForm').reset();
        $('#priceListModal').modal('show');
    });

    document.getElementById('btnSavePriceList')?.addEventListener('click', async () => {
        const name = document.getElementById('plName').value.trim();
        const desc = document.getElementById('plDescription').value.trim();
        if (!name) { showNotification("Lütfen tarife adı giriniz.", "warning"); return; }

        uiManager.toggleLoading(true);
        const { error } = await dataManager.createPriceList(name, desc);
        uiManager.toggleLoading(false);

        if (error) { showNotification("Tarife oluşturulamadı.", "error"); }
        else {
            showNotification("Tarife başarıyla oluşturuldu.", "success");
            $('#priceListModal').modal('hide');
            await loadAndRender();
        }
    });

    document.getElementById('itemFeeId')?.addEventListener('change', (e) => {
        const customNameContainer = document.getElementById('customNameContainer');
        if (e.target.value !== "") {
            customNameContainer.style.display = 'none';
            document.getElementById('itemCustomName').value = "";
        } else {
            customNameContainer.style.display = 'block';
        }
    });

    document.getElementById('btnAddItemToTemplate')?.addEventListener('click', async () => {
        const priceListId = document.getElementById('currentPriceListId').value;
        const feeId = document.getElementById('itemFeeId').value;
        const customName = document.getElementById('itemCustomName').value.trim();
        const feeType = document.getElementById('itemFeeType').value;
        const amount = document.getElementById('itemAmount').value;
        const currency = document.getElementById('itemCurrency').value;

        if (!feeId && !customName) { showNotification("Lütfen bir hizmet seçin veya özel isim girin.", "warning"); return; }
        if (!amount) { showNotification("Lütfen anlaşılan fiyatı girin.", "warning"); return; }

        uiManager.toggleLoading(true);
        const { error } = await dataManager.addPriceListItem(priceListId, feeId, customName, feeType, amount, currency);
        
        if (error) {
            showNotification("Bu kalem tarifede zaten ekli olabilir.", "error");
            uiManager.toggleLoading(false);
        } else {
            showNotification("Kalem tarifeye eklendi.", "success");
            document.getElementById('itemAmount').value = "";
            const freshItems = await dataManager.fetchItemsForList(priceListId);
            uiManager.renderTariffItems(freshItems, dataManager.allFeeTariffs);
            uiManager.toggleLoading(false);
        }
    });

    document.getElementById('priceListsTableBody')?.addEventListener('click', async (e) => {
        const btnManage = e.target.closest('.manage-items-btn');
        if (btnManage) {
            const id = btnManage.dataset.id;
            const name = btnManage.dataset.name;
            document.getElementById('currentPriceListId').value = id;
            document.getElementById('tariffModalTitle').innerHTML = `<i class="fas fa-tags mr-2"></i> ${name} - Fiyat Düzenleme`;
            
            uiManager.toggleLoading(true);
            const items = await dataManager.fetchItemsForList(id);
            uiManager.renderTariffItems(items, dataManager.allFeeTariffs);
            uiManager.toggleLoading(false);
            
            $('#tariffItemsModal').modal('show');
            return;
        }

        const btnDelete = e.target.closest('.delete-list-btn');
        if (btnDelete) {
            if (confirm("Bu tarife şablonunu silmek istediğinize emin misiniz? (Bu tarifeyi kullanan tüm müvekkiller standart genel tarifeye geri dönecektir!)")) {
                uiManager.toggleLoading(true);
                await dataManager.deletePriceList(btnDelete.dataset.id);
                await loadAndRender();
            }
        }
    });

    document.getElementById('tariffItemsTableBody')?.addEventListener('click', async (e) => {
        const btnDeleteItem = e.target.closest('.delete-item-btn');
        if (btnDeleteItem) {
            const itemId = btnDeleteItem.dataset.id;
            const priceListId = document.getElementById('currentPriceListId').value;
            
            uiManager.toggleLoading(true);
            await dataManager.deletePriceListItem(itemId);
            const freshItems = await dataManager.fetchItemsForList(priceListId);
            uiManager.renderTariffItems(freshItems, dataManager.allFeeTariffs);
            uiManager.toggleLoading(false);
            showNotification("Kalem şablondan silindi.", "success");
        }
    });

    document.getElementById('assignmentsTableBody')?.addEventListener('change', async (e) => {
        const select = e.target.closest('.assign-list-select');
        if (select) {
            const personId = select.dataset.personId;
            const priceListId = select.value;

            uiManager.toggleLoading(true);
            const { error } = await dataManager.assignPriceListToPerson(personId, priceListId);
            uiManager.toggleLoading(false);

            if (error) {
                showNotification("Atama gerçekleştirilemedi.", "error");
            } else {
                showNotification("Müvekkil tarifesi başarıyla güncellendi.", "success");
                const badge = document.getElementById(`badge-p-${personId}`);
                if (badge) {
                    const selectedText = select.options[select.selectedIndex].text;
                    badge.innerHTML = priceListId ? selectedText : '<i class="fas fa-globe mr-1"></i> Standart Genel Tarife';
                    badge.className = priceListId ? 'badge badge-primary px-3 py-2 shadow-sm' : 'badge badge-light border text-secondary px-3 py-2';
                }
            }
        }
    });

    document.querySelectorAll('.close-modal-btn').forEach(b => {
        b.addEventListener('click', e => {
            const modal = e.target.closest('.modal');
            if (modal) $(modal).modal('hide');
        });
    });

    await loadAndRender();
});