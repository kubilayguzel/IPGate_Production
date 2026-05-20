import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
    try {
        // Supabase Servis İstemcisini Başlat
        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' // Admin yetkisi
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
            // 2. Asıl 'accruals' tablosuna Gerçek Tahakkuku yaz
            const { error: insertError } = await supabase.from('accruals').insert({
                person_id: t.person_id,
                type: t.type,
                accrual_type: t.type,
                department: 'EVREKA',
                total_amount: [{ amount: t.amount, currency: t.currency }],
                remaining_amount: [{ amount: t.amount, currency: t.currency }],
                service_fee: { amount: t.amount, currency: t.currency },
                official_fee: { amount: 0, currency: "TRY" },
                apply_vat_to_official_fee: false,
                vat_rate: 20, // İhtiyaca göre şablona eklenebilir
                items: [{
                    fee_type: "Hizmet",
                    item_name: "Abonelik / Periyodik Hizmet Bedeli",
                    quantity: 1,
                    unit_price: t.amount,
                    vat_rate: 20,
                    total_amount: Number((t.amount * 1.20).toFixed(2)),
                    currency: t.currency
                }],
                status: 'pending',
                payment_status: 'unpaid',
                is_paid: false,
                is_freestyle: true,
                description: `OTOMATİK OLUŞTURULDU: ${t.description || 'Periyodik Tahakkuk'}`
            });

            if (insertError) {
                console.error(`Tahakkuk oluşturulamadı (Şablon ID: ${t.id}):`, insertError);
                continue;
            }

            // 3. Bir sonraki tarihi hesapla
            const nextDate = new Date(t.next_trigger_date);
            if (t.period === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
            else if (t.period === 'quarterly') nextDate.setMonth(nextDate.getMonth() + 3);
            else if (t.period === 'biannually') nextDate.setMonth(nextDate.getMonth() + 6);
            else if (t.period === 'annually') nextDate.setFullYear(nextDate.getFullYear() + 1);

            // 4. Şablonun tarihlerini güncelle
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