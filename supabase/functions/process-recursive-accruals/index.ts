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
            // 2. Yeni sisteme uygun ID'yi oluştur
            const newAccrualId = await getNextAccrualId(supabase);

            // 3. Ana Tabloya 'accruals' Gerçek Tahakkuku yaz (items Sütunu Çıkarıldı)
            const { error: insertError } = await supabase.from('accruals').insert({
                id: newAccrualId,
                tp_invoice_party_id: t.person_id,
                accrual_type: t.type || 'Hizmet',
                department: t.department || 'EVREKA',
                total_amount: [{ amount: t.amount, currency: t.currency }],
                remaining_amount: [{ amount: t.amount, currency: t.currency }],
                service_fee_amount: t.amount,
                service_fee_currency: t.currency,
                official_fee_amount: 0,
                official_fee_currency: "TRY",
                apply_vat_to_official_fee: false,
                vat_rate: 20, 
                status: 'unpaid', // pending yerine unpaid atandı
                description: `OTOMATİK OLUŞTURULDU: ${t.description || 'Periyodik Tahakkuk'}`
            });

            if (insertError) {
                console.error(`Tahakkuk oluşturulamadı (Şablon ID: ${t.id}):`, insertError);
                continue; // Hata varsa tarihi ilerletmeden atla
            }

            // 4. Alt Kalemleri Yeni 'accrual_items' Tablosuna Yaz
            let itemsToInsert = [];
            if (t.items && Array.isArray(t.items) && t.items.length > 0) {
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