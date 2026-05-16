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
            const [plRes, itemRes, personRes, feeRes, discRes] = await Promise.all([
                supabase.from('price_lists').select('*').order('name'),
                supabase.from('price_list_items').select('*'),
                supabase.from('persons').select('id, name, type, price_list_id').order('name'),
                supabase.from('fee_tariffs').select('*').order('id'),
                supabase.from('client_discounts').select('*')
            ]);

            this.allFeeTariffs = feeRes.data || [];
            
            const items = itemRes.data || [];
            this.allPriceLists = (plRes.data || []).map(list => ({
                ...list,
                itemCount: items.filter(i => i.price_list_id === list.id).length
            }));

            const discounts = discRes.data || [];
            this.allPersons = (personRes.data || []).map(p => {
                const clientDiscount = discounts.find(d => d.client_id === p.id);
                return {
                    ...p,
                    discount_rate: clientDiscount ? parseFloat(clientDiscount.discount_rate) : 0
                };
            });

            return true;
        } catch (error) {
            console.error("Veri yükleme hatası:", error);
            throw error;
        }
    }

    async updateStandardFee(feeId, newAmount) {
        return await supabase.from('fee_tariffs').update({ amount: parseFloat(newAmount) }).eq('id', feeId);
    }

    async createPriceList(name, description, copyFromValue) {
        const { data: newList, error: createErr } = await supabase.from('price_lists').insert({ name, description }).select().single();
        if (createErr || !newList) return { error: createErr || new Error("Şablon oluşturulamadı.") };

        const newListId = newList.id;

        if (copyFromValue === 'standard') {
            const { data: stdFees } = await supabase.from('fee_tariffs').select('*');
            if (stdFees && stdFees.length > 0) {
                const inserts = stdFees.map(f => ({
                    price_list_id: newListId,
                    fee_id: f.id,
                    fee_type: f.fee_type,
                    amount: f.amount,
                    currency: f.currency
                }));
                await supabase.from('price_list_items').insert(inserts);
            }
        } 
        else if (copyFromValue && copyFromValue !== '') {
            const { data: existingItems } = await supabase.from('price_list_items').select('*').eq('price_list_id', copyFromValue);
            if (existingItems && existingItems.length > 0) {
                const inserts = existingItems.map(item => ({
                    price_list_id: newListId,
                    fee_id: item.fee_id,
                    custom_item_name: item.custom_item_name,
                    fee_type: item.fee_type,
                    amount: item.amount,
                    currency: item.currency
                }));
                await supabase.from('price_list_items').insert(inserts);
            }
        }

        return { error: null, id: newListId };
    }

    async deletePriceList(id) {
        return await supabase.from('price_lists').delete().eq('id', id);
    }

    async fetchItemsForList(priceListId) {
        const { data } = await supabase.from('price_list_items').select('*').eq('price_list_id', priceListId).order('created_at');
        return data || [];
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

    // 🔥 YENİ: ŞABLON İÇİNDEKİ ÖZEL FİYATI GÜNCELLEME
    async updatePriceListItem(itemId, newAmount) {
        return await supabase.from('price_list_items').update({ amount: parseFloat(newAmount) }).eq('id', itemId);
    }

    async deletePriceListItem(itemId) {
        return await supabase.from('price_list_items').delete().eq('id', itemId);
    }

    async assignPersonSettings(personId, priceListId, discountRate) {
        const { error: pErr } = await supabase.from('persons')
            .update({ price_list_id: priceListId || null })
            .eq('id', personId);
        if (pErr) return { error: pErr };

        await supabase.from('client_discounts').delete().eq('client_id', personId);
        
        if (parseFloat(discountRate) > 0) {
            const { error: dErr } = await supabase.from('client_discounts')
                .insert({ client_id: personId, discount_rate: parseFloat(discountRate) });
            if (dErr) return { error: dErr };
        }

        return { error: null };
    }
}