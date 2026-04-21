import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const KOLAYBI_BASE_URL = "https://ofis-sandbox-api.kolaybi.com"; 

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const action = body.action || 'create';

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } }
    });

    const apiKey = Deno.env.get('KOLAYBI_API_KEY') ?? 'b9de5d0f-a1f1-49c8-8f3c-af2a1ddb9158'; 
    const channel = Deno.env.get('KOLAYBI_CHANNEL') ?? 'evrekapatent';

    const getKolaybiToken = async () => {
        const authReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/access_token`, {
            method: 'POST',
            headers: { 'Channel': channel, 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey })
        });
        const authData = await authReq.json();
        if (!authReq.ok) throw new Error(`KolayBi Kimlik Doğrulama Hatası: ${authData.message}`);
        return authData.data || authData.access_token || authData.token;
    };

    // ==============================================================================
    // İŞLEM 1: FATURA SİLME / İPTAL ETME (DELETE)
    // ==============================================================================
    if (action === 'delete') {
        const { invoiceId } = body;
        if (!invoiceId) throw new Error("Fatura ID (invoiceId) gerekli.");

        const { data: invoiceData, error: invError } = await supabaseClient.from('invoices').select('*').eq('id', invoiceId).single();
        if (invError || !invoiceData) throw new Error("Fatura veritabanında bulunamadı.");
        if (invoiceData.status !== 'draft') throw new Error("Sadece 'Taslak' durumundaki faturalar iptal edilebilir.");

        const kolaybiDocId = invoiceData.kolaybi_invoice_id;

        if (kolaybiDocId && kolaybiDocId !== 'undefined' && kolaybiDocId !== 'null') {
            const accessToken = await getKolaybiToken();
            const delReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/invoices/${kolaybiDocId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Channel': channel }
            });
            if (!delReq.ok) console.log("KolayBi silme uyarısı:", await delReq.text());
        }

        await supabaseClient.from('accruals').update({ invoice_id: null }).eq('invoice_id', invoiceId);
        const { error: delError } = await supabaseClient.from('invoices').delete().eq('id', invoiceId);
        
        if (delError) throw new Error("Fatura KolayBi'den silindi ancak veritabanından silinemedi.");

        return new Response(JSON.stringify({ success: true, message: "Fatura başarıyla silindi ve tahakkuklar serbest bırakıldı." }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ==============================================================================
    // İŞLEM 2: FATURA OLUŞTURMA (CREATE)
    // ==============================================================================
    if (action === 'create') {
        const { accrualIds } = body;
        if (!accrualIds || accrualIds.length === 0) throw new Error("Lütfen faturalandırılacak tahakkukları seçin.");

        // 🔥 GÜNCELLEME: Artık tahakkukları çekerken altındaki dinamik kalemleri (accrual_items) de çekiyoruz!
        const { data: accruals, error: accError } = await supabaseClient
            .from('accruals')
            .select('*, accrual_items(*)')
            .in('id', accrualIds);

        if (accError || !accruals || accruals.length === 0) throw new Error("Tahakkuk verileri alınamadı.");

        const clientId = accruals[0].service_invoice_party_id || accruals[0].tp_invoice_party_id;
        if (!clientId) throw new Error("Taraf (Müşteri/Cari) seçilmemiş.");

        const { data: clientData, error: clientError } = await supabaseClient.from('persons').select('*').eq('id', clientId).single();
        if (clientError || !clientData) throw new Error("Müşteri bilgileri veritabanında bulunamadı.");

        const identityNo = (clientData.tax_no || clientData.tckn || "").replace(/\s+/g, '');
        console.log("=== YENİ KOLAYBİ FATURA OLUŞTURMA İŞLEMİ BAŞLADI ===");

        const accessToken = await getKolaybiToken();

        const apiHeadersForm = {
            'Authorization': `Bearer ${accessToken}`,
            'Channel': channel,
            'Content-Type': 'application/x-www-form-urlencoded' 
        };
        const getHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Channel': channel };

        // --- CARİ PARAMETRELERİ ---
        const associateParams = new URLSearchParams();
        if (identityNo.length === 10) {
            associateParams.append("is_corporate", "true");
            associateParams.append("name", clientData.name);
            associateParams.append("surname", "ŞTİ."); 
        } else {
            associateParams.append("is_corporate", "false");
            const nameParts = clientData.name.trim().split(' ');
            const surname = nameParts.length > 1 ? nameParts.pop() : clientData.name;
            const firstName = nameParts.length > 0 ? nameParts.join(' ') : clientData.name;
            associateParams.append("name", firstName);
            associateParams.append("surname", surname);
        }

        associateParams.append("identity_no", identityNo);
        if (clientData.email) associateParams.append("email", clientData.email);
        if (clientData.tax_office) associateParams.append("tax_office", clientData.tax_office);

        const cityName = clientData.province && clientData.province.trim() !== '' ? clientData.province.trim() : "Ankara";
        const districtName = clientData.district && clientData.district.trim() !== '' ? clientData.district.trim() : "Merkez";

        associateParams.append("addresses[address]", clientData.address || "Merkez");
        associateParams.append("addresses[city]", cityName);
        associateParams.append("addresses[district]", districtName); 
        associateParams.append("addresses[country]", "Türkiye"); 
        associateParams.append("addresses[address_type]", "invoice");

        let kolaybiContactId = null;
        let kolaybiAddressId = null;

        console.log(`KolayBi'de ${identityNo} VKN/TCKN ile cari aranıyor...`);
        const searchReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/associates?query=${identityNo}&limit=50`, { method: 'GET', headers: getHeaders });
        const searchRes = await searchReq.json();
        const list = searchRes.data?.data || searchRes.data || [];
        
        const foundAssociate = list.find((a: any) => String(a.identity_no) === identityNo || String(a.tax_number) === identityNo);

        if (foundAssociate && foundAssociate.id) {
            kolaybiContactId = foundAssociate.id;
            console.log(`Cari mevcut (ID: ${kolaybiContactId}). Bilgileri güncelleniyor...`);
            
            await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/associates/${kolaybiContactId}`, { 
                method: 'PUT', headers: apiHeadersForm, body: associateParams.toString() 
            });

            const detailReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/associates/${kolaybiContactId}`, { method: 'GET', headers: getHeaders });
            if (detailReq.ok) {
                const detailRes = await detailReq.json();
                const detailData = detailRes.data || detailRes;
                kolaybiAddressId = detailData.default_address_id || detailData.address?.[0]?.id || detailData.addresses?.[0]?.id || detailData.address_id;
            }
        } else {
            console.log(`Cari bulunamadı. Yeni kayıt oluşturuluyor...`);
            const associateReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/associates`, {
                method: 'POST', headers: apiHeadersForm, body: associateParams.toString()
            });
            const associateResText = await associateReq.text();
            let associateRes;
            try { associateRes = JSON.parse(associateResText); } catch(e) { throw new Error(`API Yanıtı Okunamadı`); }

            if (!associateReq.ok || associateRes.success === false) {
                throw new Error(`Cari Kayıt Hatası: ${associateRes.message}`);
            }

            const dataObj = associateRes.data || associateRes;
            kolaybiContactId = dataObj.id;
            kolaybiAddressId = dataObj.default_address_id || dataObj.address?.[0]?.id || dataObj.addresses?.[0]?.id || dataObj.address_id;
        }

        if (!kolaybiContactId) throw new Error("KolayBi Cari ID'si alınamadı.");
        if (!kolaybiAddressId) {
            console.log(`Adres ID bulunamadı. Adres API'si tetikleniyor...`);
            const addressParams = new URLSearchParams();
            addressParams.append("associate_id", String(kolaybiContactId));
            addressParams.append("address", clientData.address || "Merkez");
            addressParams.append("city", cityName);
            addressParams.append("district", districtName); 
            addressParams.append("country", "Türkiye");
            addressParams.append("address_type", "invoice");

            const addrReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/address/create`, { method: 'POST', headers: apiHeadersForm, body: addressParams.toString() });
            const addrResText = await addrReq.text();
            try { const addrRes = JSON.parse(addrResText); if (addrRes.data && addrRes.data.id) kolaybiAddressId = addrRes.data.id; } catch(e) {}
        }
        if (!kolaybiAddressId) throw new Error("Cari Adres ID alınamadı.");

        // --- HİZMET (ÜRÜN) BİLGİSİ ---
        let productId = 1; // Varsayılan ürün/hizmet ID'si (KolayBi'deki "Hizmet Bedeli" gibi bir kalemin ID'si)
        const productsReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/products`, { method: 'GET', headers: getHeaders });
        if (productsReq.ok) {
            const productsRes = await productsReq.json();
            if (productsRes.data && productsRes.data.length > 0) productId = productsRes.data[0].id; 
        }

        const invoiceParams = new URLSearchParams();
        invoiceParams.append("contact_id", String(kolaybiContactId));
        invoiceParams.append("address_id", String(kolaybiAddressId));
        invoiceParams.append("order_date", new Date().toISOString().split('T')[0]); 
        invoiceParams.append("type", "sale_invoice"); 
        invoiceParams.append("document_scenario", identityNo.length === 10 ? "TICARIFATURA" : "EARSIV"); 
        invoiceParams.append("document_type", "SATIS"); 
        invoiceParams.append("description", "IPGate Sistemi Üzerinden Otomatik Oluşturulmuştur.");
        
        let invoiceCurrency = 'TRY';
        let itemIndex = 0;
        let calculatedGrandTotal = 0;

        // 🔥 GÜNCELLEME: Yeni accrual_items tablosundaki satırları okuyarak faturaya ekliyoruz
        accruals.forEach((acc) => {
            if (acc.accrual_items && acc.accrual_items.length > 0) {
                acc.accrual_items.forEach((item: any) => {
                    if (item.currency) {
                        invoiceCurrency = item.currency.toUpperCase();
                        if (invoiceCurrency === 'TL') invoiceCurrency = 'TRY';
                    }

                    const qty = parseFloat(item.quantity || 1);
                    const price = parseFloat(item.unit_price || 0);
                    const vat = parseFloat(item.vat_rate || 0);

                    // KolayBi API'sine faturanın alt kalemlerini gönderiyoruz
                    invoiceParams.append(`items[${itemIndex}][product_id]`, String(productId));
                    invoiceParams.append(`items[${itemIndex}][quantity]`, qty.toFixed(2));
                    invoiceParams.append(`items[${itemIndex}][unit_price]`, price.toFixed(2));
                    invoiceParams.append(`items[${itemIndex}][vat_rate]`, vat.toString());
                    invoiceParams.append(`items[${itemIndex}][description]`, item.item_name || "Danışmanlık ve Hizmet Bedeli");
                    
                    calculatedGrandTotal += (qty * price) * (1 + (vat / 100));
                    itemIndex++;
                });
            }
        });

        invoiceParams.append("currency", invoiceCurrency);

        if (itemIndex === 0) throw new Error("Fatura edilecek herhangi bir kalem (satır) bulunamadı. Lütfen tahakkukun kalemlerini kontrol edin.");

        const invoiceReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/invoices`, { method: 'POST', headers: apiHeadersForm, body: invoiceParams.toString() });
        const invoiceResText = await invoiceReq.text();
        let invoiceRes;
        try { invoiceRes = JSON.parse(invoiceResText); } catch(e) { throw new Error(`Fatura API Yanıtı Okunamadı`); }

        if (!invoiceReq.ok || invoiceRes.success === false) {
            throw new Error(`Fatura Oluşturma Hatası: ${invoiceRes.message || JSON.stringify(invoiceRes)}`);
        }
        
        const kolaybiInvoiceId = invoiceRes.data?.document_id || invoiceRes.data?.id || invoiceRes.document_id || invoiceRes.id; 
        
        // Supabase Invoices Tablosuna Kayıt
        const { data: newInvoice, error: invError } = await supabaseClient.from('invoices').insert({
            kolaybi_invoice_id: String(kolaybiInvoiceId),
            status: 'draft',
            total_amount: calculatedGrandTotal,
            currency: invoiceCurrency,
            client_id: clientId
        }).select().single();

        if (invError) throw new Error("Fatura KolayBi'de kesildi ama yerel DB'ye kaydedilemedi: " + invError.message);

        await supabaseClient.from('accruals').update({ invoice_id: newInvoice.id }).in('id', accrualIds);

        return new Response(JSON.stringify({ success: true, message: "Fatura başarıyla KolayBi'ye iletildi.", invoiceId: newInvoice.id }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});