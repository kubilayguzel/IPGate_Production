import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// KolayBi API Temel URL'si (Test/Sandbox Ortamı)
const KOLAYBI_BASE_URL = "https://ofis-sandbox-api.kolaybi.com"; 

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { accrualIds } = await req.json();

    if (!accrualIds || accrualIds.length === 0) {
      throw new Error("Lütfen faturalandırılacak tahakkukları seçin.");
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } }
    });

    // 1. Tahakkuk Verilerini Çek
    const { data: accruals, error: accError } = await supabaseClient
      .from('accruals')
      .select('*')
      .in('id', accrualIds);

    if (accError || !accruals || accruals.length === 0) throw new Error("Tahakkuk verileri alınamadı.");

    const clientId = accruals[0].service_invoice_party_id || accruals[0].tp_invoice_party_id;
    if (!clientId) {
      throw new Error("Bu tahakkukta faturanın kesileceği bir Taraf (Müşteri/Cari) seçilmemiş. Lütfen önce tahakkuku düzenleyip bir taraf seçin.");
    }

    // 2. Müşteri (Cari) Verilerini Çek
    const { data: clientData, error: clientError } = await supabaseClient
      .from('persons')
      .select('*')
      .eq('id', clientId)
      .single();

    if (clientError || !clientData) throw new Error("Müşteri bilgileri veritabanında bulunamadı.");

    // 3. ZORUNLU ALAN KONTROLÜ (GİB Kurallarına Göre)
    const missingFields: string[] = [];
    if (!clientData.name || clientData.name.trim() === '') missingFields.push("Ad Soyad / Unvan");
    
    // VKN veya TCKN'den en az biri olmak zorunda ve boşluklar temizlenmeli
    const identityNo = (clientData.tax_no || clientData.tckn || "").replace(/\s+/g, '');
    
    if (!identityNo || identityNo === '') {
        missingFields.push("TCKN veya VKN");
    } else if (identityNo.length === 10) {
        // ŞİRKET (VKN) İÇİN VERGİ DAİRESİ ZORUNLUDUR
        if (!clientData.tax_office || clientData.tax_office.trim() === '') {
            missingFields.push("Vergi Dairesi (10 haneli VKN'si olan firmalar için zorunludur)");
        }
    }

    if (!clientData.address || clientData.address.trim() === '') missingFields.push("Açık Adres");
    if (!clientData.province || clientData.province.trim() === '') missingFields.push("İl / Şehir");

    if (missingFields.length > 0) {
        throw new Error(`Seçili kişi/firma kartında (${clientData.name || 'İsimsiz'}) e-Fatura kesebilmek için şu zorunlu bilgiler eksik: ${missingFields.join(', ')}. Lütfen Kişiler menüsünden güncelleyin.`);
    }

    // ==============================================================================
    // KOLAYBI API ENTEGRASYONU BAŞLIYOR
    // ==============================================================================
    
    const apiKey = Deno.env.get('KOLAYBI_API_KEY') ?? 'b9de5d0f-a1f1-49c8-8f3c-af2a1ddb9158'; 
    const channel = Deno.env.get('KOLAYBI_CHANNEL') ?? 'evrekapatent';

    // ADIM 1: Access Token Alımı
    const authReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/access_token`, {
        method: 'POST',
        headers: {
            'Channel': channel,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ api_key: apiKey })
    });

    const authData = await authReq.json();
    if (!authReq.ok) {
        throw new Error(`KolayBi Kimlik Doğrulama Hatası: ${authData.message || 'Sunucuya bağlanılamadı'}`);
    }

    const accessToken = authData.data || authData.access_token || authData.token;
    if (!accessToken) throw new Error("KolayBi'den Access Token alınamadı.");

    const apiHeaders = {
        'Authorization': `Bearer ${accessToken}`,
        'Channel': channel,
        'Content-Type': 'application/json'
    };

    // ADIM 2: Müşteriyi (Cariyi) KolayBi'de Oluştur veya Bul
    const associatePayload: Record<string, any> = {
        name: clientData.name,
        identity_no: identityNo,
        address: clientData.address,
        city: clientData.province,
        email: clientData.email || ""
    };

    // Vergi dairesi varsa ekle (Yoksa hiç gönderme, şahıslar için böylece hata vermez)
    if (clientData.tax_office && clientData.tax_office.trim() !== '') {
        associatePayload.tax_office = clientData.tax_office.trim();
    }

    const associateReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/associates`, {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify(associatePayload)
    });

    const associateRes = await associateReq.json();
    if (!associateReq.ok) {
        throw new Error(`KolayBi Cari Kayıt Hatası: ${associateRes.message || JSON.stringify(associateRes)}`);
    }
    
    const kolaybiContactId = associateRes.data?.id || associateRes.id;
    const kolaybiAddressId = associateRes.data?.addresses?.[0]?.id || associateRes.data?.default_address_id || 1;

    // ADIM 3: Ürün (Hizmet) ID'sini Bul
    let productId = 1;
    const productsReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/products`, { headers: apiHeaders });
    if (productsReq.ok) {
        const productsRes = await productsReq.json();
        if (productsRes.data && productsRes.data.length > 0) {
            productId = productsRes.data[0].id; 
        }
    }

    // ADIM 4: Faturayı Oluştur
    const invoiceItems = accruals.map(acc => {
        const offFee = parseFloat(acc.official_fee_amount || '0');
        const srvFee = parseFloat(acc.service_fee_amount || '0');
        const description = acc.description || "Danışmanlık ve Hizmet Bedeli";
        
        return {
            product_id: productId, 
            name: description,
            quantity: "1.00",
            unit_price: (offFee + srvFee).toFixed(2), 
            vat_rate: acc.vat_rate || 20 
        };
    });

    const invoicePayload = {
        associate_id: kolaybiContactId, 
        address_id: kolaybiAddressId, 
        issue_date: new Date().toISOString().split('T')[0], 
        currency: accruals[0].service_fee_currency || 'TRY',
        items: invoiceItems,
        notes: "IPGate Sistemi Üzerinden Otomatik Oluşturulmuştur."
    };

    const invoiceReq = await fetch(`${KOLAYBI_BASE_URL}/kolaybi/v1/invoices`, {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify(invoicePayload)
    });

    const invoiceRes = await invoiceReq.json();
    if (!invoiceReq.ok) {
        throw new Error(`KolayBi Fatura Oluşturma Hatası: ${invoiceRes.message || JSON.stringify(invoiceRes)}`);
    }
    
    const kolaybiInvoiceId = invoiceRes.data?.id || invoiceRes.id; 
    const totalAmount = invoiceRes.data?.total_amount || invoicePayload.items.reduce((s, i) => s + parseFloat(i.unit_price), 0);

    // ==============================================================================
    // SUPABASE VERİTABANI GÜNCELLEMELERİ
    // ==============================================================================
    
    const { data: newInvoice, error: invError } = await supabaseClient
      .from('invoices')
      .insert({
        kolaybi_invoice_id: String(kolaybiInvoiceId),
        invoice_no: null,
        status: 'draft',
        total_amount: totalAmount,
        currency: invoicePayload.currency,
        client_id: clientId
      })
      .select()
      .single();

    if (invError) throw new Error("Fatura KolayBi'de kesildi ancak yerel veritabanına kaydedilemedi: " + invError.message);

    await supabaseClient
      .from('accruals')
      .update({ invoice_id: newInvoice.id, status: 'invoiced' })
      .in('id', accrualIds);

    return new Response(JSON.stringify({ 
      success: true, 
      message: "Fatura başarıyla KolayBi'ye iletildi.",
      invoiceId: newInvoice.id 
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 200, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }
});