import { PriceListDataManager } from './PriceListDataManager.js';
import { PriceListUIManager } from './PriceListUIManager.js';
import { loadSharedLayout } from '../layout-loader.js';
import { showNotification } from '../../utils.js';

document.addEventListener('DOMContentLoaded', async () => {
    await loadSharedLayout({ activeMenuLink: 'price-lists.html' });
    
    $('a[data-toggle="tab"]').on('click', function (e) {
        e.preventDefault(); $(this).tab('show');
    });

    const dataManager = new PriceListDataManager();
    const uiManager = new PriceListUIManager();

    async function loadAndRender() {
        uiManager.toggleLoading(true);
        try {
            await dataManager.fetchAllData();
            uiManager.renderStandardTariffs(dataManager.allFeeTariffs);
            uiManager.renderPriceLists(dataManager.allPriceLists);
            uiManager.renderAssignments(dataManager.allPersons, dataManager.allPriceLists);
            
            // 🔥 YENİ: Klonlama ve Kalem Seçim Listelerini Doldur
            uiManager.populateCopyDropdown(dataManager.allPriceLists);
            uiManager.populateFeeDropdown(dataManager.allFeeTariffs);
        } catch (e) {
            showNotification("Veriler yüklenirken hata oluştu.", "error");
        } finally {
            uiManager.toggleLoading(false);
        }
    }

    document.getElementById('standardTariffsTableBody')?.addEventListener('click', async (e) => {
        const btnSave = e.target.closest('.save-std-fee-btn');
        if (btnSave) {
            const feeId = btnSave.dataset.id;
            const inputEl = document.querySelector(`.std-fee-input[data-id="${feeId}"]`);
            if (inputEl) {
                uiManager.toggleLoading(true);
                const { error } = await dataManager.updateStandardFee(feeId, inputEl.value);
                uiManager.toggleLoading(false);
                if (error) showNotification("Fiyat güncellenemedi.", "error");
                else showNotification("Standart fiyat başarıyla güncellendi!", "success");
            }
        }
    });

    document.getElementById('assignmentsTableBody')?.addEventListener('click', async (e) => {
        const btnSave = e.target.closest('.save-person-settings-btn');
        if (btnSave) {
            const personId = btnSave.dataset.personId;
            const discountInput = document.querySelector(`.discount-input[data-person-id="${personId}"]`);
            const selectList = document.querySelector(`.assign-list-select[data-person-id="${personId}"]`);
            
            uiManager.toggleLoading(true);
            const { error } = await dataManager.assignPersonSettings(personId, selectList.value, discountInput.value);
            
            if (error) {
                showNotification("Ayarlar kaydedilemedi.", "error");
                uiManager.toggleLoading(false);
            } else {
                showNotification("Müvekkil finans ayarları güncellendi!", "success");
                await loadAndRender(); 
            }
        }
    });

    document.getElementById('btnCreatePriceList')?.addEventListener('click', () => {
        document.getElementById('priceListForm').reset();
        $('#priceListModal').modal('show');
    });

    // 🔥 YENİ: Kopyalama Seçeneğini (plCopyFrom) Okuyup Backende Gönderme
    document.getElementById('btnSavePriceList')?.addEventListener('click', async () => {
        const name = document.getElementById('plName').value.trim();
        const desc = document.getElementById('plDescription').value.trim();
        const copyFrom = document.getElementById('plCopyFrom').value; // Seçili Kopyalama Değeri
        
        if (!name) { showNotification("Şablon adı zorunludur.", "warning"); return; }

        uiManager.toggleLoading(true);
        const { error } = await dataManager.createPriceList(name, desc, copyFrom);
        if (error) { showNotification("Oluşturulamadı.", "error"); uiManager.toggleLoading(false); }
        else {
            showNotification(copyFrom ? "Şablon kopyalanarak oluşturuldu." : "Şablon oluşturuldu.", "success");
            $('#priceListModal').modal('hide');
            await loadAndRender();
        }
    });

    document.getElementById('priceListsTableBody')?.addEventListener('click', async (e) => {
        const btnManage = e.target.closest('.manage-items-btn');
        if (btnManage) {
            const id = btnManage.dataset.id;
            document.getElementById('currentPriceListId').value = id;
            document.getElementById('tariffModalTitle').innerHTML = `<i class="fas fa-tags mr-2"></i> ${btnManage.dataset.name}`;
            
            uiManager.toggleLoading(true);
            const items = await dataManager.fetchItemsForList(id);
            uiManager.renderTariffItems(items, dataManager.allFeeTariffs);
            uiManager.toggleLoading(false);
            $('#tariffItemsModal').modal('show');
        }

        const btnDelete = e.target.closest('.delete-list-btn');
        if (btnDelete && confirm("Şablonu silmek istediğinize emin misiniz?")) {
            uiManager.toggleLoading(true);
            await dataManager.deletePriceList(btnDelete.dataset.id);
            await loadAndRender();
        }
    });

    document.getElementById('itemFeeId')?.addEventListener('change', (e) => {
        const customNameContainer = document.getElementById('customNameContainer');
        if (e.target.value !== "") { customNameContainer.style.display = 'none'; document.getElementById('itemCustomName').value = ""; } 
        else { customNameContainer.style.display = 'block'; }
    });

    document.getElementById('btnAddItemToTemplate')?.addEventListener('click', async () => {
        const listId = document.getElementById('currentPriceListId').value;
        const feeId = document.getElementById('itemFeeId').value;
        const customName = document.getElementById('itemCustomName').value.trim();
        const type = document.getElementById('itemFeeType').value;
        const amount = document.getElementById('itemAmount').value;
        const cur = document.getElementById('itemCurrency').value;

        if (!feeId && !customName) { showNotification("Hizmet seçin veya isim girin.", "warning"); return; }
        if (!amount) { showNotification("Fiyat girin.", "warning"); return; }

        uiManager.toggleLoading(true);
        const { error } = await dataManager.addPriceListItem(listId, feeId, customName, type, amount, cur);
        if (error) { showNotification("Bu kalem zaten ekli olabilir.", "error"); uiManager.toggleLoading(false); } 
        else {
            document.getElementById('itemAmount').value = "";
            const items = await dataManager.fetchItemsForList(listId);
            uiManager.renderTariffItems(items, dataManager.allFeeTariffs);
            uiManager.toggleLoading(false);
        }
    });

    document.getElementById('tariffItemsTableBody')?.addEventListener('click', async (e) => {
        const btnDelete = e.target.closest('.delete-item-btn');
        if (btnDelete) {
            uiManager.toggleLoading(true);
            await dataManager.deletePriceListItem(btnDelete.dataset.id);
            const items = await dataManager.fetchItemsForList(document.getElementById('currentPriceListId').value);
            uiManager.renderTariffItems(items, dataManager.allFeeTariffs);
            uiManager.toggleLoading(false);
        }
    });

    document.querySelectorAll('.close-modal-btn').forEach(b => b.addEventListener('click', e => $(e.target.closest('.modal')).modal('hide')));

    await loadAndRender();
});