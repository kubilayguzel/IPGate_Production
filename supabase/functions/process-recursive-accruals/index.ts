import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// 🔥 YENİ: Akıllı ID Üretici (Sıradaki tahakkuk numarasını bulur)
async function getNextAccrualId(supabase) {
    try {
        const counterId = 'accruals'; 
        const { data: counterData } = await supabase.from('counters').select('last_id').eq('id', counterId).single();
        let nextNum = (counterData?.last_id || 0) + 1;
        let isFree = false;
        let finalId = '';
        
        while (!isFree) {
            finalId = String(nextNum); 
            const { data: existingAccrual } = await supabase.from('accruals').select('id').eq('id', finalId).maybeSingle(); 
            if (!existingAccrual) isFree = true;
            else nextNum++; 
        }
        await supabase.from('counters').upsert({ id: counterId, last_id: nextNum }, { onConflict: 'id' });
        return finalId;
    } catch (e) {
        return String(Date.now()).slice(-6); 
    }
}


// Tek kalem döviz dönüşümü: her tetiklenmede aynı günün TCMB döviz satış kuru.
async function getCurrentTryRates(currencies: string[]): Promise<Record<string, number>> {
    const rates: Record<string, number> = { TRY: 1 };
    const needed = [...new Set(currencies.map(c => (c || 'TRY').toUpperCase()).filter(c => c !== 'TRY'))];
    if (needed.length === 0) return rates;
    const res = await fetch('https://www.tcmb.gov.tr/kurlar/today.xml');
    if (!res.ok) throw new Error(`TCMB kur servisi hatası (${res.status})`);
    const xml = await res.text();
    for (const currency of needed) {
        if (!['USD', 'EUR', 'GBP', 'CHF'].includes(currency)) throw new Error(`Desteklenmeyen döviz: ${currency}`);
        const re = new RegExp(`<Currency[^>]*Kod="${currency}"[^>]*>[\\s\\S]*?<ForexSelling>([\\d.]+)<\\/ForexSelling>`, 'i');
        const match = xml.match(re);
        const rate = Number(match?.[1]);
        if (!Number.isFinite(rate) || rate <= 0) throw new Error(`${currency} TCMB satış kuru alınamadı.`);
        rates[currency] = rate;
    }
    return rates;
}
const roundTry = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const expenseTypes = ['TP Harç', 'Harç', 'Yurtdışı Maliyet', 'Yurtdışı Gider'];

serve(async (req) => {
    try {
        // Supabase Servis İstemcisini Başlat
        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' // Admin yetkisi (RLS atlar)
        );

        // Bugünün tarihini YYYY-MM-DD formatında al
        const today = new Date().toISOString().split('T')[0];

        // 1. Günü gelmiş olan ve Aktif şablonları çek
        const { data: templates, error: fetchError } = await supabase
            .from('accruals_recursive')
            .select('*')
            .eq('is_active', true)
            .lte('next_trigger_date', today);

        if (fetchError) throw fetchError;
        if (!templates || templates.length === 0) {
            return new Response(JSON.stringify({ message: "Bugün tetiklenecek abonelik tahakkuku bulunamadı." }), { status: 200 });
        }

        let processedCount = 0;

        for (const t of templates) {
            let singleInfo: any = null;
            let generatedItems: any[] | null = null;
            if (t.single_item_invoice === true) {
                try {
                    if ((t.department || 'EVREKA') === 'HUKUK') throw new Error('HUKUK/SMM için EVREKA tek kalem faturası kullanılamaz.');
                    const currency = (t.single_item_invoice_currency || 'TRY').toUpperCase();
                    const amount = Number(t.single_item_invoice_amount);
                    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Fatura matrahı geçersiz.');
                    const expenses = (Array.isArray(t.items) ? t.items : []).filter((i: any) => expenseTypes.includes(i.fee_type));
                    const other = (Array.isArray(t.items) ? t.items : []).filter((i: any) => !expenseTypes.includes(i.fee_type) && i.fee_type !== 'Hizmet');
                    if (other.some((i: any) => Number(i.quantity) * Number(i.unit_price) > 0)) throw new Error('Uyumsuz gider/hizmet kalemi.');
                    const rates = await getCurrentTryRates([currency, ...expenses.map((i: any) => i.currency || 'TRY')]);
                    const netTry = roundTry(amount * rates[currency]);
                    const expenseTry = roundTry(expenses.reduce((sum: number, i: any) => sum + Number(i.unit_price) * Number(i.quantity) * rates[(i.currency || 'TRY').toUpperCase()], 0));
                    const serviceTry = roundTry(netTry - expenseTry);
                    if (serviceTry < 0) throw new Error('Harç/gider toplamı fatura matrahını aşıyor.');
                    const oldService = (t.items || []).find((i: any) => i.fee_type === 'Hizmet');
                    const vatRate = Number(oldService?.vat_rate ?? 20);
                    if (![0, 1, 10, 20].includes(vatRate)) throw new Error('Hizmet KDV oranı geçersiz.');
                    const { data: person, error: personError } = await supabase.from('persons').select('has_tevkifat').eq('id', t.person_id).maybeSingle();
                    if (personError) throw personError;
                    const effectiveVat = person?.has_tevkifat === true ? vatRate * 0.1 : vatRate;
                    const expenseGrossTry = roundTry(expenses.reduce((sum: number, i: any) => {
                        const quantity = Number(i.quantity), unitPrice = Number(i.unit_price), vat = Number(i.vat_rate || 0);
                        return sum + (Number.isFinite(Number(i.total_amount)) && i.total_amount != null ? Number(i.total_amount) : roundTry(quantity * unitPrice * (1 + vat / 100))) * rates[(i.currency || 'TRY').toUpperCase()];
                    }, 0));
                    const totalTry = roundTry(expenseGrossTry + serviceTry * (1 + effectiveVat / 100));
                    generatedItems = expenses.map((i: any) => ({ ...i }));
                    if (serviceTry > 0) generatedItems.push({
                        fee_type: 'Hizmet', item_name: 'EVREKA Hizmet Bedeli', quantity: 1,
                        unit_price: serviceTry, vat_rate: vatRate,
                        total_amount: roundTry(serviceTry * (1 + vatRate / 100)), currency: 'TRY'
                    });
                    singleInfo = { amount, currency, netTry, expenseTry, serviceTry, totalTry, rates };
                } catch (error) {
                    console.error(`Tekrarlayan tek kalem tahakkuk ${t.id} hesaplanamadı:`, error);
                    continue; // Kur hesaplanamadıysa şablonu ileri taşıma; daha sonra tekrar denensin.
                }
            }
            // 2. Yeni sisteme uygun ID'yi oluştur
            const newAccrualId = await getNextAccrualId(supabase);

            // 3. Ana Tabloya 'accruals' Gerçek Tahakkuku yaz (items Sütunu Çıkarıldı)
            const { error: insertError } = await supabase.from('accruals').insert({
                id: newAccrualId,
                tp_invoice_party_id: t.person_id,
                accrual_type: t.type || 'Hizmet',
                department: t.department || 'EVREKA',
                total_amount: singleInfo ? [{ amount: singleInfo.totalTry, currency: 'TRY' }] : [{ amount: t.amount, currency: t.currency }],
                remaining_amount: singleInfo ? [{ amount: singleInfo.totalTry, currency: 'TRY' }] : [{ amount: t.amount, currency: t.currency }],
                service_fee_amount: singleInfo ? singleInfo.serviceTry : t.amount,
                service_fee_currency: singleInfo ? 'TRY' : t.currency,
                official_fee_amount: singleInfo ? singleInfo.expenseTry : 0,
                official_fee_currency: "TRY",
                apply_vat_to_official_fee: false,
                vat_rate: singleInfo ? (generatedItems?.find((i: any) => i.fee_type === 'Hizmet')?.vat_rate ?? 20) : 20,
                single_item_invoice: !!singleInfo,
                single_item_invoice_amount: singleInfo?.amount ?? null,
                single_item_invoice_currency: singleInfo?.currency ?? 'TRY',
                single_item_invoice_try_amount: singleInfo?.netTry ?? null,
                single_item_invoice_rates: singleInfo?.rates ?? null,
                single_item_invoice_rate_date: singleInfo ? today : null,
                status: 'unpaid', // pending yerine unpaid atandı
                description: `OTOMATİK OLUŞTURULDU: ${t.description || 'Periyodik Tahakkuk'}`
            });

            if (insertError) {
                console.error(`Tahakkuk oluşturulamadı (Şablon ID: ${t.id}):`, insertError);
                continue; // Hata varsa tarihi ilerletmeden atla
            }

            // 4. Alt Kalemleri Yeni 'accrual_items' Tablosuna Yaz
            let itemsToInsert = [];
            if (singleInfo && generatedItems) {
                itemsToInsert = generatedItems.map((item: any) => ({
                    accrual_id: newAccrualId,
                    fee_type: item.fee_type,
                    item_name: item.item_name,
                    quantity: item.quantity,
                    unit_price: item.unit_price,
                    vat_rate: item.vat_rate,
                    total_amount: item.total_amount,
                    currency: item.currency
                }));
            } else if (t.items && Array.isArray(t.items) && t.items.length > 0) {
                itemsToInsert = t.items.map(item => ({
                    accrual_id: newAccrualId,
                    fee_type: item.fee_type || 'Hizmet',
                    item_name: item.item_name || 'Abonelik Bedeli',
                    quantity: item.quantity || 1,
                    unit_price: item.unit_price || t.amount,
                    vat_rate: item.vat_rate || 20,
                    total_amount: item.total_amount || Number((t.amount * 1.20).toFixed(2)),
                    currency: item.currency || t.currency
                }));
            } else {
                itemsToInsert = [{
                    accrual_id: newAccrualId,
                    fee_type: t.type || "Hizmet",
                    item_name: t.description || "Abonelik / Periyodik Hizmet Bedeli",
                    quantity: 1,
                    unit_price: t.amount,
                    vat_rate: 20,
                    total_amount: Number((t.amount * 1.20).toFixed(2)),
                    currency: t.currency
                }];
            }

            const { error: itemsErr } = await supabase.from('accrual_items').insert(itemsToInsert);
            if (itemsErr) console.error(`Kalemler yazılamadı (Tahakkuk ID: ${newAccrualId}):`, itemsErr);

            // 5. Bir sonraki tarihi hesapla (Tarih İlerletme Aşaması)
            const nextDate = new Date(t.next_trigger_date);
            if (t.period === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
            else if (t.period === 'quarterly') nextDate.setMonth(nextDate.getMonth() + 3);
            else if (t.period === 'biannually') nextDate.setMonth(nextDate.getMonth() + 6);
            else if (t.period === 'annually') nextDate.setFullYear(nextDate.getFullYear() + 1);

            // 6. Şablonun tarihlerini veri tabanında güncelle
            await supabase.from('accruals_recursive').update({
                next_trigger_date: nextDate.toISOString().split('T')[0],
                last_trigger_date: today
            }).eq('id', t.id);

            processedCount++;
        }

        return new Response(JSON.stringify({ success: true, processed: processedCount }), {
            headers: { "Content-Type": "application/json" },
            status: 200
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
});