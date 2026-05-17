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
            
            uiManager.populateCopyDropdown(dataManager.allPriceLists);
            uiManager.populateFeeDropdown(dataManager.allFeeTariffs);
        } catch (e) {
            showNotification("Veriler yüklenirken hata oluştu.", "error");
        } finally {
            uiManager.toggleLoading(false);
        }
    }

    // TAB 1: STANDART FİYAT GÜNCELLEME
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

    // 🔥 YENİ: ARAMA MOTORU (Hızlı Filtreleme)
    document.getElementById('searchClientInput')?.addEventListener('keyup', (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const rows = document.querySelectorAll('#assignmentsTableBody .assignment-row');
        
        rows.forEach(row => {
            const clientName = row.querySelector('.client-name-td').textContent.toLowerCase();
            if (clientName.includes(searchTerm)) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        });
    });

    // 🔥 YENİ: TOPLU KAYDET BUTONU
    document.getElementById('btnBulkSaveAssignments')?.addEventListener('click', async () => {
        const rows = document.querySelectorAll('#assignmentsTableBody .assignment-row');
        const assignmentsToUpdate = [];

        // Tablodaki tüm satırları gezip sadece veritabanından farklı (değiştirilmiş) olanları topluyoruz
        rows.forEach(row => {
            const personId = row.querySelector('.save-person-settings-btn').dataset.personId;
            const discount = parseFloat(row.querySelector('.discount-input').value) || 0;
            const priceListId = row.querySelector('.assign-list-select').value || null;

            const originalPerson = dataManager.allPersons.find(p => p.id === personId);
            if (originalPerson) {
                const originalDiscount = originalPerson.discount_rate || 0;
                const originalPriceListId = originalPerson.price_list_id || null;

                if (discount !== originalDiscount || priceListId !== originalPriceListId) {
                    assignmentsToUpdate.push({ personId, priceListId, discountRate: discount });
                }
            }
        });

        if (assignmentsToUpdate.length === 0) {
            showNotification("Kaydedilecek yeni bir değişiklik bulunamadı.", "warning");
            return;
        }

        uiManager.toggleLoading(true);
        const { error } = await dataManager.bulkAssignPersonSettings(assignmentsToUpdate);
        
        if (error) {
            showNotification("Bazı ayarlar kaydedilirken hata oluştu.", "error");
            uiManager.toggleLoading(false);
        } else {
            showNotification(`${assignmentsToUpdate.length} müvekkilin ayarları başarıyla güncellendi!`, "success");
            // Arama çubuğunu temizle ve ekranı yenile
            document.getElementById('searchClientInput').value = "";
            await loadAndRender(); 
        }
    });

    // TEKİL MÜVEKKİL ATAMA KAYDET BUTONU
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
                // Ekranı temizlemek yerine sadece veriyi tazele ve arama filtresini bozma!
                const searchVal = document.getElementById('searchClientInput').value;
                await loadAndRender(); 
                if(searchVal) {
                    document.getElementById('searchClientInput').value = searchVal;
                    document.getElementById('searchClientInput').dispatchEvent(new Event('keyup'));
                }
            }
        }
    });

    document.getElementById('btnCreatePriceList')?.addEventListener('click', () => {
        document.getElementById('priceListForm').reset();
        $('#priceListModal').modal('show');
    });

    document.getElementById('btnSavePriceList')?.addEventListener('click', async () => {
        const name = document.getElementById('plName').value.trim();
        const desc = document.getElementById('plDescription').value.trim();
        const copyFrom = document.getElementById('plCopyFrom').value; 
        
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
            uiManager.toggleTemplateView(true, btnManage.dataset.name);
            
            uiManager.toggleLoading(true);
            const items = await dataManager.fetchItemsForList(id);
            uiManager.renderTariffItems(items, dataManager.allFeeTariffs);
            uiManager.toggleLoading(false);
        }

        const btnDelete = e.target.closest('.delete-list-btn');
        if (btnDelete && confirm("Şablonu silmek istediğinize emin misiniz?")) {
            uiManager.toggleLoading(true);
            await dataManager.deletePriceList(btnDelete.dataset.id);
            await loadAndRender();
        }
    });

    document.getElementById('btnBackToTemplates')?.addEventListener('click', async () => {
        uiManager.toggleTemplateView(false);
        await loadAndRender(); 
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
        const btnUpdate = e.target.closest('.update-custom-fee-btn');
        if (btnUpdate) {
            const itemId = btnUpdate.dataset.id;
            const inputEl = document.querySelector(`.custom-fee-input[data-id="${itemId}"]`);
            if (inputEl) {
                uiManager.toggleLoading(true);
                const { error } = await dataManager.updatePriceListItem(itemId, inputEl.value);
                uiManager.toggleLoading(false);
                if (error) showNotification("Fiyat güncellenemedi.", "error");
                else showNotification("Özel fiyat başarıyla güncellendi!", "success");
            }
            return;
        }

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