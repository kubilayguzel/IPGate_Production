import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const KOLAYBI_BASE_URL = "https://ofis-api.kolaybi.com"; 

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

    const apiKey = 'e95988f7-52d0-44ac-85ab-d40f8c6e27d4'; 
    const channel = 'evrekapatent';

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
    // İŞLEM 1: FATURA SİLME / İPTAL ETME (AKILLANDIRILDI: İkili Faturaları da Siler)
    // ==============================================================================
    if (action === 'delete') {
        const { invoiceId } = body;
        if (!invoiceId) throw new Error("Fatura ID (invoiceId) gerekli.");

        // Önce faturayı bul
        const { data: invoiceData, error: invError } = await supabaseClient.from('invoices').select('*').eq('id', invoiceId).single();
        if (invError || !invoiceData) throw new Error("Fatura veritabanında bulunamadı.");
        if (invoiceData.status !== 'draft') throw new Error("Sadece 'Taslak' durumundaki faturalar iptal edilebilir.");

        // Bu faturaya bağlı tahakkuku bul (invoice_id veya invoice_id_2 eşleşen)
        const { data: accData } = await supabaseClient.from('accruals')
            .select('id, invoice_id, invoice_id_2')
            .or(`invoice_id.eq.${invoiceId},invoice_id_2.eq.${invoiceId}`)
            .limit(1).single();

        let invoicesToDelete = [invoiceId];
        if (accData) {
            if (accData.invoice_id) invoicesToDelete.push(accData.invoice_id);
            if (accData.invoice_id_2) invoicesToDelete.push(accData.invoice_id_2);
        }
        invoicesToDelete = [...new Set(invoicesToDelete)].filter(Boolean);

        for (const invId of invoicesToDelete) {
            const { data: inv } = await supabaseClient.from('invoices').select('*').eq('id', invId).single();
            if (inv && inv.kolaybi_invoice_id && inv.kolaybi_invoice_id !== 'undefined' && inv.kolaybi_invoice_id !== 'null') {
                const accessToken = await getKolaybiToken();
                await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/invoices/${inv.kolaybi_invoice_id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${accessToken}`, 'Channel': channel }
                });
            }
            await supabaseClient.from('invoices').delete().eq('id', invId);
        }

        if (accData) {
            await supabaseClient.from('accruals').update({ invoice_id: null, invoice_id_2: null }).eq('id', accData.id);
        }

        return new Response(JSON.stringify({ success: true, message: "Fatura(lar) başarıyla silindi ve tahakkuklar serbest bırakıldı." }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ==============================================================================
    // İŞLEM 2: FATURA OLUŞTURMA (CREATE) - OTOMATİK PARÇALAYICI
    // ==============================================================================
    if (action === 'create') {
        const { accrualIds } = body;
        if (!accrualIds || accrualIds.length === 0) throw new Error("Lütfen faturalandırılacak tahakkukları seçin.");

        const { data: accruals, error: accError } = await supabaseClient
            .from('accruals')
            .select('*, accrual_items(*)')
            .in('id', accrualIds);

        if (accError || !accruals || accruals.length === 0) throw new Error("Tahakkuk Çekme Hatası.");

        const clientId = accruals[0].service_invoice_party_id || accruals[0].tp_invoice_party_id;
        if (!clientId) throw new Error("Taraf (Müşteri/Cari) seçilmemiş.");

        for (const acc of accruals) {
            const currentPartyId = acc.service_invoice_party_id || acc.tp_invoice_party_id;
            if (currentPartyId !== clientId) throw new Error("Güvenlik İhlali: Farklı müşterilere ait tahakkuklar tek faturada birleştirilemez!");
        }

        const { data: clientData, error: clientError } = await supabaseClient.from('persons').select('*').eq('id', clientId).single();
        if (clientError || !clientData) throw new Error("Müşteri bilgileri veritabanında bulunamadı.");

        // 🔥 YENİ: SAS / SİPARİŞ KODU KONTROLÜ VE TOPLANMASI
        const identityNo = (clientData.tax_no || clientData.tckn || "").replace(/\s+/g, '');
        const orderCodes = [...new Set(accruals.map((a: any) => a.order_code).filter(Boolean))];
        
        if (clientData.requires_sas_code === true && orderCodes.length === 0) {
            throw new Error(`[SAS ZORUNLU] Bu müvekkil (${clientData.name}) için Sipariş (SAS) Kodu girmek zorunludur! Lütfen fatura oluşturmadan önce tahakkukları düzenleyerek kodları ekleyin.`);
        }
        
        // İş (Task) detaylarını çekip hazırlıyoruz
        const taskIds = accruals.map(a => a.task_id).filter(Boolean);
        let tasksMap: any = {};

        if (taskIds.length > 0) {
            const { data: tasksData } = await supabaseClient.from('tasks').select('id, title, ip_record_id').in('id', taskIds);
            if (tasksData && tasksData.length > 0) {
                const ipRecordIds = tasksData.map(t => t.ip_record_id).filter(Boolean);
                let ipRecords = [], tmDetails = [], suits = [];
                
                if (ipRecordIds.length > 0) {
                    const [ipRes, tmRes, suitRes] = await Promise.all([
                        supabaseClient.from('ip_records').select('id, origin, application_number').in('id', ipRecordIds),
                        supabaseClient.from('ip_record_trademark_details').select('ip_record_id, brand_name').in('ip_record_id', ipRecordIds),
                        supabaseClient.from('suits').select('id, court_name, file_no').in('id', ipRecordIds)
                    ]);
                    if (ipRes.data) ipRecords = ipRes.data;
                    if (tmRes.data) tmDetails = tmRes.data;
                    if (suitRes.data) suits = suitRes.data;
                }

                tasksData.forEach(t => {
                    const ipRec = ipRecords.find(ip => ip.id === t.ip_record_id);
                    const suit = suits.find(s => s.id === t.ip_record_id);
                    const tmDet = tmDetails.find(tm => tm.ip_record_id === t.ip_record_id);
                    tasksMap[t.id] = { title: t.title || "", origin: ipRec?.origin || suit?.court_name || "TÜRKPATENT", refNo: ipRec?.application_number || suit?.file_no || "", brand: tmDet?.brand_name || "" };
                });
            }
        }

        const accessToken = await getKolaybiToken();
        const apiHeadersForm = { 'Authorization': `Bearer ${accessToken}`, 'Channel': channel, 'Content-Type': 'application/x-www-form-urlencoded' };
        const getHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Channel': channel };

        // --- CARİ OLUŞTURMA / GÜNCELLEME ---
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

        const searchReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/associates?query=${identityNo}&limit=50`, { method: 'GET', headers: getHeaders });
        const searchRes = await searchReq.json();
        const list = searchRes.data?.data || searchRes.data || [];
        const foundAssociate = list.find((a: any) => String(a.identity_no) === identityNo || String(a.tax_number) === identityNo);

        if (foundAssociate && foundAssociate.id) {
            kolaybiContactId = foundAssociate.id;
            await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/associates/${kolaybiContactId}`, { method: 'PUT', headers: apiHeadersForm, body: associateParams.toString() });
            const detailReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/associates/${kolaybiContactId}`, { method: 'GET', headers: getHeaders });
            if (detailReq.ok) {
                const detailRes = await detailReq.json();
                const detailData = detailRes.data || detailRes;
                kolaybiAddressId = detailData.default_address_id || detailData.address?.[0]?.id || detailData.addresses?.[0]?.id || detailData.address_id;
            }
        } else {
            const associateReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/associates`, { method: 'POST', headers: apiHeadersForm, body: associateParams.toString() });
            const associateResText = await associateReq.text();
            let associateRes;
            try { associateRes = JSON.parse(associateResText); } catch(e) { throw new Error(`API Yanıtı Okunamadı`); }
            if (!associateReq.ok || associateRes.success === false) throw new Error(`Cari Kayıt Hatası: ${associateRes.message}`);
            const dataObj = associateRes.data || associateRes;
            kolaybiContactId = dataObj.id;
            kolaybiAddressId = dataObj.default_address_id || dataObj.address?.[0]?.id || dataObj.addresses?.[0]?.id || dataObj.address_id;
        }

        if (!kolaybiContactId) throw new Error("KolayBi Cari ID'si alınamadı.");
        if (!kolaybiAddressId) {
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

        let productId = 1; 
        const productsReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/products`, { method: 'GET', headers: getHeaders });
        if (productsReq.ok) {
            const productsRes = await productsReq.json();
            if (productsRes.data && productsRes.data.length > 0) productId = productsRes.data[0].id; 
        }

        let jobDetailsLines: string[] = [];
        accruals.forEach(acc => {
            if (acc.task_id && tasksMap[acc.task_id]) {
                const t = tasksMap[acc.task_id];
                const line = `${t.origin} ${t.refNo} ${t.brand} ${t.title} (${acc.task_id})`.replace(/\s+/g, ' ').trim();
                if (!jobDetailsLines.includes(line)) jobDetailsLines.push(line);
            }
        });

        // 🔥 YENİ: SİPARİŞ NUMARASINI FATURA AÇIKLAMASINA YAPIŞTIRMA
        let finalInvoiceNote = `İş Detayı:\n${jobDetailsLines.join('\n')}\n\nTahakkuk No: ${accrualIds.join(', ')}`;
        
        if (orderCodes.length > 0) {
            finalInvoiceNote += `\nSipariş No: ${orderCodes.join(', ')}`;
        }
        
        finalInvoiceNote += `\n\nNot: IPGate Sistemi Üzerinden Otomatik Oluşturulmuştur.`;
        const isTevkifatli = clientData.has_tevkifat === true;

        // 🔥 GÜNCELLEME: AKILLI GRUPLAMA (SATIŞ vs TEVKİFAT)
        let satisItemsList: any[] = [];
        let tevkifatItemsList: any[] = [];
        let invoiceCurrency = 'TRY';

        accruals.forEach((acc) => {
            if (acc.accrual_items && acc.accrual_items.length > 0) {
                acc.accrual_items.forEach((item: any) => {
                    if (item.currency) {
                        invoiceCurrency = item.currency.toUpperCase() === 'TL' ? 'TRY' : item.currency.toUpperCase();
                    }

                    const qty = parseFloat(item.quantity || 1);
                    const price = parseFloat(item.unit_price || 0);
                    let vat = parseFloat(item.vat_rate || 0);

                    let feeTypeDisplay = item.fee_type || "";
                    const typeLower = feeTypeDisplay.toLowerCase().trim();

                    if (typeLower === 'tp harç' || typeLower === 'harç') feeTypeDisplay = 'TÜRKPATENT Harç';
                    else if (typeLower === 'tp hizmet') feeTypeDisplay = 'TÜRKPATENT Hizmet';
                    else if (typeLower === 'hizmet') feeTypeDisplay = 'EVREKA Hizmet';

                    const cleanItemName = (item.item_name || "").replace(/\s*-\s*(Harç|Hizmet Bedeli|Hizmet Ücreti|Hizmet)\s*$/i, "").trim();
                    const combinedName = `${feeTypeDisplay} - ${cleanItemName}`;

                    // Sadece Evreka Hizmeti ise ve Müşteri Tevkifatlıysa ayır!
                    if (isTevkifatli && typeLower === 'hizmet') {
                        tevkifatItemsList.push({ ...item, qty, price, vat: 20, combinedName });
                    } else {
                        satisItemsList.push({ ...item, qty, price, vat, combinedName });
                    }
                });
            }
        });

        // 🔥 KOLAYBİ'YE FATURA GÖNDERME MOTORU (Her Liste İçin Ayrı Çalışır)
        const createInvoiceInKolaybi = async (items: any[], docType: string) => {
            if (items.length === 0) return null;

            const invoiceParams = new URLSearchParams();
            invoiceParams.append("contact_id", String(kolaybiContactId));
            invoiceParams.append("address_id", String(kolaybiAddressId));
            invoiceParams.append("order_date", new Date().toISOString().split('T')[0]); 
            invoiceParams.append("type", "sale_invoice"); 
            invoiceParams.append("document_scenario", identityNo.length === 10 ? "TICARIFATURA" : "EARSIV"); 
            invoiceParams.append("document_type", docType); 
            invoiceParams.append("description", finalInvoiceNote);
            
            let itemIndex = 0;
            let calculatedGrandTotal = 0;

            items.forEach(item => {
                invoiceParams.append(`items[${itemIndex}][product_id]`, String(productId));
                invoiceParams.append(`items[${itemIndex}][quantity]`, item.qty.toFixed(2));
                invoiceParams.append(`items[${itemIndex}][unit_price]`, item.price.toFixed(2));
                invoiceParams.append(`items[${itemIndex}][vat_rate]`, item.vat.toString());
                invoiceParams.append(`items[${itemIndex}][description]`, item.combinedName);

                if (docType === 'TEVKIFAT') {
                    // 🔥 KolayBi API Ekibinin Belirttiği Resmi Tevkifat Parametreleri
                    invoiceParams.append(`items[${itemIndex}][withholding_code]`, "602");
                    invoiceParams.append(`items[${itemIndex}][withholding_value]`, "90");
                    invoiceParams.append(`items[${itemIndex}][withholding_type]`, "PERCENTAGE");

                    // 10.000 TL * %20 KDV'nin 9/10'u tevkif edilir, satıcıya KDV'nin 1/10'u (%2) ödenir. 
                    // (Tutar * 1.02)
                    calculatedGrandTotal += (item.qty * item.price) * 1.02; 
                } else {
                    // Normal (%0, %20 vb) tevkifatsız hesaplama
                    calculatedGrandTotal += (item.qty * item.price) * (1 + (item.vat / 100));
                }
                itemIndex++;
            });

            invoiceParams.append("currency", invoiceCurrency);

            const requestBodyString = invoiceParams.toString();
            const invoiceReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/invoices`, { method: 'POST', headers: apiHeadersForm, body: requestBodyString });
            const invoiceResText = await invoiceReq.text();
            let invoiceRes;
            try { invoiceRes = JSON.parse(invoiceResText); } catch(e) { throw new Error(`Fatura API Yanıtı Okunamadı`); }

            if (!invoiceReq.ok || invoiceRes.success === false) {
                // KolayBi ekibinin rahatça okuyabilmesi için URL-Encoded metni temiz ve alt alta okunabilir formata çeviriyoruz
                const decodedRequest = decodeURIComponent(requestBodyString).replace(/&/g, '\n');
                
                const debugMessage = `[${docType}] Fatura Oluşturma Hatası: ${invoiceRes.message || JSON.stringify(invoiceRes)} \n\n--- KOLAYBI DESTEK İÇİN PAYLAŞILACAK BİLGİLER ---\n\n📌 GİDEN İSTEK (REQUEST):\n${decodedRequest}\n\n📌 GELEN YANIT (RESPONSE):\n${invoiceResText}`;
                
                throw new Error(debugMessage);
            }
            
            return {
                kolaybiId: invoiceRes.data?.document_id || invoiceRes.data?.id || invoiceRes.document_id || invoiceRes.id,
                total: calculatedGrandTotal
            };
        };

        // 🔥 FATURALAMA VE ROLLBACK (GERİ ALMA) İŞLEMİ
        let satisResult: any = null;
        let tevkifatResult: any = null;
        let createdKolaybiDocIds: string[] = []; // Başarıyla KolayBi'ye iletilen fatura ID'lerini burada tutacağız

        try {
            // 1. Satış (Harç) faturasını KolayBi'ye gönder
            if (satisItemsList.length > 0) {
                satisResult = await createInvoiceInKolaybi(satisItemsList, "SATIS");
                if (satisResult && satisResult.kolaybiId) createdKolaybiDocIds.push(String(satisResult.kolaybiId));
            }

            // 2. Tevkifat (Hizmet) faturasını KolayBi'ye gönder
            if (tevkifatItemsList.length > 0) {
                tevkifatResult = await createInvoiceInKolaybi(tevkifatItemsList, "TEVKIFAT");
                if (tevkifatResult && tevkifatResult.kolaybiId) createdKolaybiDocIds.push(String(tevkifatResult.kolaybiId));
            }

            if (!satisResult && !tevkifatResult) throw new Error("Fatura edilecek herhangi bir kalem bulunamadı.");

            // 3. Her şey başarılıysa Yerel Veritabanına (invoices tablosuna) Kayıt İşlemlerini yap
            let primaryInvoiceId = null;
            let secondaryInvoiceId = null;

            if (satisResult) {
                const { data: inv1 } = await supabaseClient.from('invoices').insert({
                    kolaybi_invoice_id: String(satisResult.kolaybiId), status: 'draft', total_amount: satisResult.total, currency: invoiceCurrency, client_id: clientId
                }).select().single();
                primaryInvoiceId = inv1.id;
            }

            if (tevkifatResult) {
                const { data: inv2 } = await supabaseClient.from('invoices').insert({
                    kolaybi_invoice_id: String(tevkifatResult.kolaybiId), status: 'draft', total_amount: tevkifatResult.total, currency: invoiceCurrency, client_id: clientId
                }).select().single();
                
                if (!primaryInvoiceId) primaryInvoiceId = inv2.id;
                else secondaryInvoiceId = inv2.id;
            }

            // Tahakkuku Faturalarla Eşleştir
            const updatePayload: any = { invoice_id: primaryInvoiceId };
            if (secondaryInvoiceId) updatePayload.invoice_id_2 = secondaryInvoiceId;

            await supabaseClient.from('accruals').update(updatePayload).in('id', accrualIds);

            return new Response(JSON.stringify({ 
                success: true, 
                message: secondaryInvoiceId ? "Otomatik Parçalama Başarılı: Sistem harçlar ve hizmetler için iki ayrı e-Fatura oluşturdu." : "Fatura başarıyla KolayBi'ye iletildi.", 
                invoiceId: primaryInvoiceId 
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        } catch (invoiceError: any) {
            // 🔥 ROLLBACK: Eğer tevkifat faturası API'ye takılırsa, daha önce oluşturulmuş Satış faturasını anında sil!
            if (createdKolaybiDocIds.length > 0) {
                console.warn("⚠️ İşlem yarıda kesildi! Oluşturulan kısmi faturalar KolayBi'den geri siliniyor (Rollback)...");
                for (const kId of createdKolaybiDocIds) {
                    try {
                        await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/invoices/${kId}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${accessToken}`, 'Channel': channel }
                        });
                        console.log(`🧹 KolayBi Fatura (ID: ${kId}) başarıyla iptal edildi.`);
                    } catch (e) {
                        console.error(`KolayBi Fatura (ID: ${kId}) silinemedi:`, e);
                    }
                }
            }
            
            // Orijinal hatayı kullanıcıya gösterilmesi için yeniden fırlatıyoruz
            throw invoiceError;
        }
    }

  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});