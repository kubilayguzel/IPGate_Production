// public/js/price-list-management/PriceListDataManager.js
import { supabase } from '../../supabase-config.js';

export class PriceListDataManager {
    constructor() {
        this.allPriceLists = [];
        this.allPersons = [];
        this.allFeeTariffs = [];
        this.currentTemplateItems = [];
    }

    async fetchAllData() {
        try {
            const [plRes, itemRes, personRes, feeRes] = await Promise.all([
                supabase.from('price_lists').select('*').order('name'),
                supabase.from('price_list_items').select('*'),
                supabase.from('persons').select('id, name, type, price_list_id').order('name'),
                supabase.from('fee_tariffs').select('id, name, alias')
            ]);

            this.allFeeTariffs = feeRes.data || [];
            this.allPersons = personRes.data || [];
            
            const items = itemRes.data || [];

            this.allPriceLists = (plRes.data || []).map(list => ({
                ...list,
                itemCount: items.filter(i => i.price_list_id === list.id).length,
                items: items.filter(i => i.price_list_id === list.id)
            }));

            return true;
        } catch (error) {
            console.error("Veri yükleme hatası:", error);
            throw error;
        }
    }

    async createPriceList(name, description) {
        return await supabase.from('price_lists').insert({ name, description });
    }

    async deletePriceList(id) {
        return await supabase.from('price_lists').delete().eq('id', id);
    }

    async fetchItemsForList(priceListId) {
        const { data } = await supabase.from('price_list_items').select('*').eq('price_list_id', priceListId);
        this.currentTemplateItems = data || [];
        return this.currentTemplateItems;
    }

    async addPriceListItem(priceListId, feeId, customName, feeType, amount, currency) {
        const payload = {
            price_list_id: priceListId,
            fee_id: feeId || null,
            custom_item_name: customName || null,
            fee_type: feeType,
            amount: parseFloat(amount),
            currency: currency
        };
        return await supabase.from('price_list_items').insert(payload);
    }

    async deletePriceListItem(itemId) {
        return await supabase.from('price_list_items').delete().eq('id', itemId);
    }

    async assignPriceListToPerson(personId, priceListId) {
        return await supabase.from('persons')
            .update({ price_list_id: priceListId || null })
            .eq('id', personId);
    }
}