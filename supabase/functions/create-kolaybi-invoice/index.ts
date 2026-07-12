import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const action = body.action || 'create';

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    
    // Oturum açmış kullanıcının yetkisiyle (Senin JWT token'ın) çalışacak tek ve asıl istemci
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } }
    });

    const getKolaybiConfig = (department: string) => {
        if (department === 'HUKUK') {
            return {
                baseUrl: "https://ofis-api.kolaybi.com", // 🔥 CANLIYA ALINDI: Sandbox adresi canlı API adresi ile değiştirildi
                channel: "evrekagroupsmm",
                authPayload: { api_key: "da39099a-b851-445c-9ee9-a57ab3dfe6b7"}, // 🔥 CANLIYA ALINDI: Canlı ortam SMM API anahtarı
                endpointBase: "/kolaybi/v1/invoices", 
                isSmm: true
            };
        } else {
            return {
                baseUrl: "https://ofis-api.kolaybi.com", 
                channel: "evrekapatent",
                authPayload: { api_key: Deno.env.get("KOLAYBI_EVREKA_API_KEY") ?? "e95988f7-52d0-44ac-85ab-d40f8c6e27d4" }, 
                endpointBase: "/kolaybi/v1/invoices", 
                isSmm: false
            };
        }
    };

    const getKolaybiToken = async (config: any) => {
        const authReq = await fetch(`${config.baseUrl}/kolaybi/v1/access_token`, {
            method: 'POST',
            headers: { 'Channel': config.channel, 'Content-Type': 'application/json' },
            body: JSON.stringify(config.authPayload)
        });
        const authData = await authReq.json();
        if (!authReq.ok) throw new Error(`KolayBi Kimlik Doğrulama Hatası (${config.baseUrl}): ${authData.message || 'Bilinmeyen Hata'}`);
        return authData.data || authData.access_token || authData.token;
    };

    const getDepartmentForInvoice = async (invoiceId: string) => {
        const { data, error } = await supabaseClient
            .from('accrual_invoices')
            .select('accruals ( department )')
            .eq('invoice_id', invoiceId)
            .limit(1)
            .maybeSingle();

        if (error || !data || !data.accruals) return 'EVREKA';
        const accObj: any = Array.isArray(data.accruals) ? data.accruals[0] : data.accruals;
        return accObj?.department || 'EVREKA';
    };

    // ==============================================================================
    // İŞLEM 1: FATURA SİLME / İPTAL ETME 
    // ==============================================================================
    if (action === 'delete') {
        const { invoiceId } = body;
        if (!invoiceId) throw new Error("Fatura ID gerekli.");

        const { data: invoiceData, error: invError } = await supabaseClient.from('invoices').select('*').eq('id', invoiceId).single();
        if (invError || !invoiceData) throw new Error("Fatura veritabanında bulunamadı.");
        if (invoiceData.status !== 'draft') throw new Error("Sadece 'Taslak' durumundaki belgeler iptal edilebilir.");

        const department = await getDepartmentForInvoice(invoiceId);
        const config = getKolaybiConfig(department);
        const accessToken = await getKolaybiToken(config);

        if (invoiceData.kolaybi_invoice_id && invoiceData.kolaybi_invoice_id !== 'undefined') {
            try {
                await fetch(`${config.baseUrl}${config.endpointBase}/${invoiceData.kolaybi_invoice_id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${accessToken}`, 'Channel': config.channel }
                });
            } catch (e) {
                console.error(`KolayBi silme hatası:`, e);
            }
        }
        
        await supabaseClient.from('invoices').delete().eq('id', invoiceId);
        return new Response(JSON.stringify({ success: true, message: "Seçilen taslak belge başarıyla iptal edildi." }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ==============================================================================
    // İŞLEM 3: FATURA SENKRONİZASYONU
    // ==============================================================================
    if (action === 'sync') {
        const { invoiceId } = body;
        if (!invoiceId) throw new Error("Fatura ID gerekli.");

        const { data: inv } = await supabaseClient.from('invoices').select('*').eq('id', invoiceId).single();
        if (!inv || !inv.kolaybi_invoice_id) throw new Error("KolayBi Fatura/SMM ID bulunamadı.");

        const department = await getDepartmentForInvoice(invoiceId);
        const config = getKolaybiConfig(department);
        const accessToken = await getKolaybiToken(config);
        const getHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Channel': config.channel };

        const detailReq = await fetch(`${config.baseUrl}${config.endpointBase}/${inv.kolaybi_invoice_id}`, { method: 'GET', headers: getHeaders });
        const detailResText = await detailReq.text();
        let detailRes;
        try { detailRes = JSON.parse(detailResText); } catch(e) { throw new Error("Belge detayı API yanıtı okunamadı."); }

        if (!detailReq.ok || detailRes.success === false) {
            const errorMsg = detailRes.message || JSON.stringify(detailRes);
            if (errorMsg.toLowerCase().includes('bulunamadı') || detailReq.status === 404) {
                const updates = { kolaybi_status: "not_found", status: "rejected" };
                await supabaseClient.from("invoices").update(updates).eq("id", invoiceId);
                return new Response(JSON.stringify({ success: true, message: "Belge KolayBi'de bulunamadı (silinmiş/reddedilmiş olabilir). Durumu 'Reddedildi' olarak güncellendi.", data: updates }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            }
            throw new Error(`Belge detayı alınamadı: ${errorMsg}`);
        }

        const docData = detailRes.data || detailRes;
        let listItem = null;
        try {
            const invoiceType = config.isSmm ? "self_employment_receipt" : "sale_invoice";
            const listReq = await fetch(`${config.baseUrl}${config.endpointBase}?type=${encodeURIComponent(invoiceType)}`, { method: 'GET', headers: getHeaders });
            if (listReq.ok) {
                const listRes = await listReq.json();
                const items = Array.isArray(listRes.data) ? listRes.data : (listRes.data?.data || []);
                listItem = items.find((item: any) => String(item.commercial_doc_id ?? item.id) === String(inv.kolaybi_invoice_id)) || null;
            }
        } catch(e) {}

        const combinedData = { ...docData, ...listItem };
        const commStatusObj = combinedData.commercial_doc_status || {};
        const commStatusVal = commStatusObj.value || combinedData.status || null; 
        const eDocStatus = combinedData.e_document_status || null; 

        const serialNo = combinedData.header?.serial_no || combinedData.serial_no || combinedData.invoice_no || combinedData.receipt_no || combinedData.document_no || null;
        const issueDate = combinedData.header?.issue_date || combinedData.issue_date || combinedData.order_date || null;
        const uuid = combinedData.uuid || combinedData.e_document_uuid || null;

        const updates: any = {};
        if (serialNo) updates.invoice_no = serialNo;
        if (issueDate) updates.invoice_date = issueDate;
        if (uuid) updates.kolaybi_uuid = uuid;

        const cStatus = typeof commStatusVal === 'string' ? commStatusVal.toLowerCase() : '';
        const eStatus = typeof eDocStatus === 'string' ? eDocStatus.toLowerCase() : '';
        const standardStatuses = ['draft', 'ready_to_send', 'sent', 'approved', 'rejected', 'cancelled'];
        
        if (standardStatuses.includes(cStatus)) {
            updates.status = cStatus;
        } else if (standardStatuses.includes(eStatus)) {
            updates.status = eStatus;
        } else {
            const raw = cStatus + ' ' + eStatus;
            if (raw.includes('red') || raw.includes('reject') || raw.includes('hata') || raw.includes('error') || raw.includes('fail') || raw.includes('iade') || raw.includes('kabul edilme')) {
                updates.status = 'rejected';
            } else if (raw.includes('iptal') || raw.includes('cancel')) {
                updates.status = 'cancelled';
            } else if (raw.includes('onay') || raw.includes('approv')) {
                updates.status = 'approved';
            } else if (raw.includes('taslak') || raw.includes('ready')) {
                updates.status = 'draft';
            } else if (cStatus) {
                updates.status = cStatus;
            } else if (uuid && inv.status === 'draft') {
                updates.status = 'sent';
            }
        }

        if (eDocStatus) updates.kolaybi_status = eDocStatus;
        else if (commStatusVal) updates.kolaybi_status = typeof commStatusVal === 'string' ? commStatusVal : null;

        if (Object.keys(updates).length > 0) {
            await supabaseClient.from('invoices').update(updates).eq('id', invoiceId);
            
            if (serialNo) {
                const { data: links, error: linkError } = await supabaseClient.from('accrual_invoices').select('accrual_id').eq('invoice_id', invoiceId);
                if (linkError) throw new Error(`Veritabanı hatası (Köprü okuma): ${linkError.message}`);

                if (links && links.length > 0) {
                     for (const link of links) {
                         const { error: accUpdErr } = await supabaseClient.from('accruals').update({ evreka_invoice_no: serialNo }).eq('id', link.accrual_id);
                         if (accUpdErr) throw new Error(`Tahakkuk güncellenirken hata: ${accUpdErr.message}`);
                     }
                }
            }
        }

        return new Response(JSON.stringify({ success: true, message: "Belge durumu başarıyla senkronize edildi.", data: updates, raw_kolaybi_data: docData }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // ==============================================================================
    // İŞLEM 5: TOPLU SENKRONİZASYON 
    // ==============================================================================
    if (action === 'sync_bulk') {
        const { invoiceIds } = body;
        if (!invoiceIds || !Array.isArray(invoiceIds)) throw new Error("Belge ID listesi gerekli.");

        const { data: invoices } = await supabaseClient.from('invoices').select('*').in('id', invoiceIds);
        if (!invoices || invoices.length === 0) return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        let successCount = 0;
        
        const { data: allLinked } = await supabaseClient.from('accrual_invoices').select('invoice_id, accrual_id, accruals(department)');
        let tokens: Record<string, string> = {};
        
        const chunkSize = 10;
        for (let i = 0; i < invoices.length; i += chunkSize) {
            const chunk = invoices.slice(i, i + chunkSize);
            
            await Promise.all(chunk.map(async (inv) => {
                if (!inv.kolaybi_invoice_id || inv.kolaybi_invoice_id === 'undefined') return;
                
                try {
                    let department = 'EVREKA';
                    if (allLinked) {
                        const link = allLinked.find(l => String(l.invoice_id) === String(inv.id));
                        if (link && link.accruals) {
                             const accObj: any = Array.isArray(link.accruals) ? link.accruals[0] : link.accruals;
                             if (accObj?.department) department = accObj.department;
                        }
                    }

                    const config = getKolaybiConfig(department);
                    if (!tokens[department]) tokens[department] = await getKolaybiToken(config);
                    
                    const accessToken = tokens[department];
                    const getHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Channel': config.channel };

                    const detailReq = await fetch(`${config.baseUrl}${config.endpointBase}/${inv.kolaybi_invoice_id}`, { method: 'GET', headers: getHeaders });
                    const detailResText = await detailReq.text();
                    let detailRes;
                    try { detailRes = JSON.parse(detailResText); } catch(e) { return; }

                    if (!detailReq.ok || detailRes.success === false) {
                        const errMsg = detailRes.message || "";
                        if (errMsg.toLowerCase().includes('bulunamadı') || detailReq.status === 404) {
                            await supabaseClient.from("invoices").update({ kolaybi_status: "not_found", status: "sync_error" }).eq("id", inv.id);
                        }
                        return;
                    }

                    const docData = detailRes.data || detailRes;
                    let listItem = null;
                    try {
                        const invoiceType = config.isSmm ? "self_employment_receipt" : "sale_invoice";
                        const listReq = await fetch(`${config.baseUrl}${config.endpointBase}?type=${encodeURIComponent(invoiceType)}`, { method: 'GET', headers: getHeaders });
                        if (listReq.ok) {
                            const listRes = await listReq.json();
                            const items = Array.isArray(listRes.data) ? listRes.data : (listRes.data?.data || []);
                            listItem = items.find((item: any) => String(item.commercial_doc_id ?? item.id) === String(inv.kolaybi_invoice_id)) || null;
                        }
                    } catch(e) {}

                    const combinedData = { ...docData, ...listItem };
                    const commStatusObj = combinedData.commercial_doc_status || {};
                    const commStatusVal = commStatusObj.value || combinedData.status || null; 
                    const eDocStatus = combinedData.e_document_status || null; 

                    const serialNo = combinedData.header?.serial_no || combinedData.serial_no || combinedData.invoice_no || combinedData.receipt_no || combinedData.document_no || null;
                    const issueDate = combinedData.header?.issue_date || combinedData.issue_date || combinedData.order_date || null;
                    const uuid = combinedData.uuid || combinedData.e_document_uuid || null;

                    const updates: any = {};
                    if (serialNo) updates.invoice_no = serialNo;
                    if (issueDate) updates.invoice_date = issueDate;
                    if (uuid) updates.kolaybi_uuid = uuid;

                    const cStatus = typeof commStatusVal === 'string' ? commStatusVal.toLowerCase() : '';
                    const eStatus = typeof eDocStatus === 'string' ? eDocStatus.toLowerCase() : '';
                    const standardStatuses = ['draft', 'ready_to_send', 'sent', 'approved', 'rejected', 'cancelled'];
                    
                    if (standardStatuses.includes(cStatus)) {
                        updates.status = cStatus;
                    } else if (standardStatuses.includes(eStatus)) {
                        updates.status = eStatus;
                    } else {
                        const raw = cStatus + ' ' + eStatus;
                        if (raw.includes('red') || raw.includes('reject') || raw.includes('hata') || raw.includes('error') || raw.includes('fail') || raw.includes('iade') || raw.includes('kabul edilme')) {
                            updates.status = 'rejected';
                        } else if (raw.includes('iptal') || raw.includes('cancel')) {
                            updates.status = 'cancelled';
                        } else if (raw.includes('onay') || raw.includes('approv')) {
                            updates.status = 'approved';
                        } else if (raw.includes('taslak') || raw.includes('ready')) {
                            updates.status = 'draft';
                        } else if (cStatus) {
                            updates.status = cStatus;
                        } else if (uuid && inv.status === 'draft') {
                            updates.status = 'sent';
                        }
                    }

                    if (eDocStatus) updates.kolaybi_status = eDocStatus;
                    else if (commStatusVal) updates.kolaybi_status = typeof commStatusVal === 'string' ? commStatusVal : null;

                    if (Object.keys(updates).length > 0) {
                        await supabaseClient.from('invoices').update(updates).eq('id', inv.id);
                        
                        if (serialNo && allLinked) {
                            const subLinks = allLinked.filter(l => String(l.invoice_id) === String(inv.id));
                            for (const link of subLinks) {
                                await supabaseClient.from('accruals').update({ evreka_invoice_no: serialNo }).eq('id', link.accrual_id);
                            }
                        }
                        successCount++;
                    }
                } catch (e) {
                    console.error(`Belge senkronize edilemedi (ID: ${inv.id}):`, e);
                }
            }));
        }

        return new Response(JSON.stringify({ success: true, message: `${successCount} adet belge başarıyla güncellendi.` }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ==============================================================================
    // İŞLEM 4: FATURA/SMM GÖRÜNTÜLEME 
    // ==============================================================================
    if (action === 'view') {
        const { invoiceId } = body;
        if (!invoiceId) throw new Error("Fatura ID gerekli.");

        const { data: inv } = await supabaseClient.from('invoices').select('*').eq('id', invoiceId).single();
        if (!inv || !inv.kolaybi_uuid) throw new Error("Belgenin ETTN (UUID) numarası yok. Lütfen belgenin resmileştiğinden emin olun ve önce 'Durumu Güncelle' butonuna basın.");

        const department = await getDepartmentForInvoice(invoiceId);
        const config = getKolaybiConfig(department);
        const accessToken = await getKolaybiToken(config);
        const getHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Channel': config.channel };

        const viewReq = await fetch(`${config.baseUrl}${config.endpointBase}/e-document/view?uuid=${inv.kolaybi_uuid}`, { method: 'GET', headers: getHeaders });
        const viewResText = await viewReq.text();
        
        let viewRes;
        try { viewRes = JSON.parse(viewResText); } catch(e) {}

        if (!viewReq.ok || (viewRes && viewRes.success === false)) {
            throw new Error(`Görüntüleme Hatası: ${viewRes?.message || viewResText}`);
        }

        return new Response(JSON.stringify({ success: true, data: viewRes || viewResText }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ==============================================================================
    // İŞLEM 2: FATURA / SMM OLUŞTURMA (CREATE) 
    // ==============================================================================
    if (action === 'create') {
        const { accrualIds, mergeStrategy } = body;
        if (!accrualIds || accrualIds.length === 0) throw new Error("Lütfen faturalandırılacak tahakkukları seçin.");

        const { data: accruals, error: accError } = await supabaseClient
            .from('accruals')
            .select('*, accrual_items(*)')
            .in('id', accrualIds);

        if (accError || !accruals || accruals.length === 0) throw new Error("Tahakkuk Çekme Hatası.");

        const department = accruals[0].department || 'EVREKA';
        for (const acc of accruals) {
            if ((acc.department || 'EVREKA') !== department) {
                throw new Error("Güvenlik İhlali: Evreka ve Hukuk birimlerine ait tahakkuklar tek belgede birleştirilemez!");
            }
        }
        
        const config = getKolaybiConfig(department);

        const getTcmbRate = async (currencyCode: string) => {
            try {
                const res = await fetch('https://www.tcmb.gov.tr/kurlar/today.xml');
                const text = await res.text();
                const regex = new RegExp(`<Currency[^>]*Kod="${currencyCode}"[^>]*>[\\s\\S]*?<ForexSelling>([\\d.]+)<\\/ForexSelling>`, 'i');
                const match = text.match(regex);
                if (match && match[1]) return parseFloat(match[1]);
            } catch (e) {
                console.error("TCMB Kur Hatası:", e);
            }
            throw new Error(`Merkez Bankasından ${currencyCode} güncel satış kuru alınamadı.`);
        };

        const uniqueCurrencies = new Set<string>();
        accruals.forEach((acc: any) => {
            if (acc.accrual_items) {
                acc.accrual_items.forEach((item: any) => {
                    let cur = (item.currency || 'TRY').toUpperCase();
                    if (cur === 'TL') cur = 'TRY';
                    uniqueCurrencies.add(cur);
                });
            }
        });

        if (uniqueCurrencies.size > 1 && !mergeStrategy) {
            return new Response(JSON.stringify({ 
                success: false, 
                requireMergeDecision: true,
                currencies: Array.from(uniqueCurrencies)
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (mergeStrategy === 'merge_try') {
            const rates: Record<string, number> = {};
            for (const acc of accruals) {
                if (acc.accrual_items) {
                    for (const item of acc.accrual_items) {
                        let cur = (item.currency || 'TRY').toUpperCase();
                        if (cur === 'TL') cur = 'TRY';
                        
                        if (cur !== 'TRY') {
                            if (!rates[cur]) rates[cur] = await getTcmbRate(cur);
                            const rate = rates[cur];
                            const originalPrice = parseFloat(item.unit_price || 0);
                            item.unit_price = (originalPrice * rate).toFixed(2); 
                            item.currency = 'TRY'; 
                            item.item_name = `${item.item_name} (Kur: 1 ${cur} = ${rate} TL)`; 
                        }
                    }
                }
            }
        }

        const clientId = accruals[0].tp_invoice_party_id;
        if (!clientId) throw new Error("Taraf (Müşteri) seçilmemiş.");

        for (const acc of accruals) {
            if (acc.tp_invoice_party_id !== clientId) throw new Error("Güvenlik İhlali: Farklı müşterilere ait tahakkuklar tek belgede birleştirilemez!");
        }

        const { data: clientData, error: clientError } = await supabaseClient.from('persons').select('*').eq('id', clientId).single();
        if (clientError || !clientData) throw new Error("Müşteri bilgileri veritabanında bulunamadı.");

        let identityNo = (clientData.tax_no || clientData.tckn || "").replace(/\s+/g, '');
        if (!/^\d{10,11}$/.test(identityNo)) {
            throw new Error(`${clientData.name} için geçerli bir VKN veya TCKN girilmelidir.`);
        }
        if (identityNo.length === 10 && !clientData.tax_office?.trim()) {
            throw new Error(`${clientData.name} kurumsal bir müşteri (10 haneli VKN). Lütfen Vergi Dairesini giriniz.`);
        }

        const cityName = clientData.province?.trim() || "Ankara";
        const districtName = clientData.district?.trim() || "Merkez";

        const { data: financePersons } = await supabaseClient
            .from('persons_related')
            .select('email')
            .eq('person_id', clientId)
            .or('notify_finance_to.eq.true,notify_finance_cc.eq.true');

        let emailList: string[] = [];
        if (financePersons && financePersons.length > 0) {
            financePersons.forEach((p: any) => {
                if (p.email && p.email.trim() !== '') emailList.push(p.email.trim());
            });
        }
        if (emailList.length === 0 && clientData.email && clientData.email.trim() !== '') {
            emailList.push(clientData.email.trim());
        }
        const uniqueEmails = [...new Set(emailList)];
        const finalEmail = uniqueEmails.length > 0 ? uniqueEmails[0] : "";

        const orderCodes = [...new Set(accruals.map((a: any) => a.order_code).filter(Boolean))];
        if (clientData.requires_sas_code === true && orderCodes.length === 0) {
            throw new Error(`[SAS ZORUNLU] Bu müvekkil (${clientData.name}) için Sipariş (SAS) Kodu girmek zorunludur!`);
        }
        
        const taskIds = accruals.map((a: any) => a.task_id).filter(Boolean);
        let tasksMap: any = {};

        if (taskIds.length > 0) {
            const { data: tasksData } = await supabaseClient.from('tasks').select('id, title, ip_record_id').in('id', taskIds);
            if (tasksData && tasksData.length > 0) {
                const ipRecordIds = tasksData.map(t => t.ip_record_id).filter(Boolean);
                let ipRecords: any[] = [], tmDetails: any[] = [], suits: any[] = [];
                
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

        const accessToken = await getKolaybiToken(config);
        const apiHeadersForm = { 'Authorization': `Bearer ${accessToken}`, 'Channel': config.channel, 'Content-Type': 'application/x-www-form-urlencoded' };
        const getHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Channel': config.channel };

        let kolaybiContactId = null;
        let kolaybiAddressId = null;

        // 🔥 KESİN ÇÖZÜM: KolayBi associates uç noktası query parametresini bekler. identity_no gönderildiğinde API hata verir.
        const searchUrl = `${config.baseUrl}/kolaybi/v1/associates?query=${identityNo}&limit=50`;
        const searchReq = await fetch(searchUrl, { method: 'GET', headers: getHeaders });
        const searchText = await searchReq.text();
        
        let searchRes: any;
        try { searchRes = JSON.parse(searchText); } catch { throw new Error(`Cari arama yanıtı okunamadı: ${searchText}`); }
        
        // 🔥 CANLI ORTAM DÜZELTMESİ: Yeni ve boş hesapta cari bulunamazsa KolayBi "success: false" döner.
        // Bunu bir çöküş (crash) olarak değil, "Kayıt yok, yeni oluşturulmalı" olarak kabul etmeliyiz.
        if (!searchReq.ok || searchRes.success === false) {
            const errorMsg = (searchRes.message || "").toLowerCase();
            if (!errorMsg.includes("bulunamadı") && !errorMsg.includes("not found") && searchRes.code !== 10404 && searchReq.status !== 404) {
                throw new Error(`KolayBi Cari Arama Hatası: ${searchRes.message || searchText}`);
            }
        }
        
        const list = Array.isArray(searchRes.data) ? searchRes.data : (searchRes.data?.data || []);
        const foundAssociate = list.find((a: any) => String(a.identity_no) === identityNo || String(a.tax_number) === identityNo);

        if (foundAssociate && foundAssociate.id) {
            kolaybiContactId = foundAssociate.id;
            const detailReq = await fetch(`${config.baseUrl}/kolaybi/v1/associates/${kolaybiContactId}`, { method: 'GET', headers: getHeaders });
            if (detailReq.ok) {
                const detailRes = await detailReq.json();
                const detailData = detailRes.data || detailRes;
                const invoiceAddress = detailData.address?.find((a: any) => a.address_type === "invoice") || detailData.address?.[0];
                kolaybiAddressId = invoiceAddress?.id || null;
            }
        } else {
            const associateParams = new URLSearchParams();
            if (identityNo.length === 10) {
                associateParams.append("is_corporate", "true");
                associateParams.append("name", clientData.name);
                associateParams.append("surname", "ŞTİ."); 
            } else {
                associateParams.append("is_corporate", "false");
                const nameParts = clientData.name.trim().split(' ');
                const surname = nameParts.length > 1 ? nameParts.pop() || '' : clientData.name;
                const firstName = nameParts.length > 0 ? nameParts.join(' ') : clientData.name;
                associateParams.append("name", firstName);
                associateParams.append("surname", surname);
            }

            associateParams.append("identity_no", identityNo);
            associateParams.append("email", finalEmail || "");
            if (clientData.tax_office) associateParams.append("tax_office", clientData.tax_office);

            const associateReq = await fetch(`${config.baseUrl}/kolaybi/v1/associates`, { method: 'POST', headers: apiHeadersForm, body: associateParams.toString() });
            const associateResText = await associateReq.text();
            let associateRes;
            try { associateRes = JSON.parse(associateResText); } catch(e) { throw new Error(`API Yanıtı Okunamadı`); }
            if (!associateReq.ok || associateRes.success === false) throw new Error(`Cari Kayıt Hatası: ${associateRes.message || associateResText}`);            
            const dataObj = associateRes.data || associateRes;
            kolaybiContactId = dataObj.id;
        }

        if (!kolaybiContactId) throw new Error("KolayBi Cari ID'si alınamadı.");

        if (!kolaybiAddressId) {
            const addressParams = new URLSearchParams();
            addressParams.append("associate_id", String(kolaybiContactId));
            addressParams.append("address", clientData.address?.trim() || "Merkez");
            addressParams.append("city", cityName);
            addressParams.append("district", districtName); 
            addressParams.append("country", "Türkiye");
            addressParams.append("address_type", "invoice");

            const addressReq = await fetch(`${config.baseUrl}/kolaybi/v1/address/create`, { method: 'POST', headers: apiHeadersForm, body: addressParams.toString() });
            const addressText = await addressReq.text();
            let addressRes: any;
            try { addressRes = JSON.parse(addressText); } catch { throw new Error(`Adres oluşturma yanıtı okunamadı.`); }
            if (!addressReq.ok || addressRes.success === false) throw new Error(`KolayBi Adres Oluşturma Hatası: ${addressRes.message || addressText}`);            
            kolaybiAddressId = addressRes.data?.id || addressRes.id || null;
        }

        if (!kolaybiAddressId) throw new Error("KolayBi fatura adresi bulunamadı.");

        let productId = null; 
        const productsReq = await fetch(`${config.baseUrl}/kolaybi/v1/products?limit=100`, { method: 'GET', headers: getHeaders });
        
        if (productsReq.ok) {
            const productsRes = await productsReq.json();
            const items = productsRes.data?.data || productsRes.data || [];
            
            let validServiceItem = null;

            if (config.isSmm) {
                // 🔥 SMM İÇİN KESİN KURAL: Rastgele hizmet alma, SADECE bu isimdeki ürünü ara!
                validServiceItem = items.find((i: any) => i.name === 'Hukuki Danışmanlık ve Vekalet Ücreti');
            } else {
                // EVREKA İÇİN ÖNCELİK: URN000006 kodlu "Danışmanlık Hizmet Bedeli" ürününü bul
                validServiceItem = items.find((i: any) => i.code === 'URN000006' || i.product_code === 'URN000006');
                if (!validServiceItem) {
                    validServiceItem = items.find((i: any) => i.product_type === 'SERVICE' || i.product_type === 'service' || i.type === 'service');
                }
            }

            if (validServiceItem && validServiceItem.id) {
                productId = validServiceItem.id;
            } else {
                // Bulamazsa Yeni Ürün Oluştur
                const newProductParams = new URLSearchParams();
                newProductParams.append("name", config.isSmm ? "Hukuki Danışmanlık ve Vekalet Ücreti" : "Hizmet Bedeli"); 
                newProductParams.append("product_type", "service");
                newProductParams.append("vat_rate", "20");
                newProductParams.append("price_currency", "try");
                // DİKKAT: quantity parametresi KolayBi API'sinde model hatası verdiği için kaldırıldı!

                const createProdReq = await fetch(`${config.baseUrl}/kolaybi/v1/products`, { method: 'POST', headers: apiHeadersForm, body: newProductParams.toString() });
                if (createProdReq.ok) {
                    const createProdRes = await createProdReq.json();
                    if (createProdRes.data && createProdRes.data.id) productId = createProdRes.data.id;
                }
            }
        }
        
        if (!productId) {
            throw new Error("KolayBi hesabınızda faturaya eklenecek geçerli bir ürün/hizmet kartı bulunamadı.");
        }

        let jobDetailsLines: string[] = [];
        accruals.forEach((acc: any) => {
            if (acc.task_id && tasksMap[acc.task_id]) {
                const t = tasksMap[acc.task_id];
                const line = `${t.origin} ${t.refNo} ${t.brand} ${t.title} (${acc.task_id})`.replace(/\s+/g, ' ').trim();
                if (!jobDetailsLines.includes(line)) jobDetailsLines.push(line);
            }
        });

        let noteLines: string[] = [];
        noteLines.push("AÇIKLAMALAR:");
        if (orderCodes.length > 0) noteLines.push(`Sipariş No (SAS): ${orderCodes.join(', ')}`);
        if (jobDetailsLines.length > 0) noteLines.push(`İş Detayı: ${jobDetailsLines.join(', ')}`);
        noteLines.push(`Tahakkuk No: ${accrualIds.join(', ')}`);

        let invoiceNotesFromAccruals: string[] = [];
        accruals.forEach((acc: any) => {
            if (acc.invoice_description && acc.invoice_description.trim() !== '') {
                const cleanNote = acc.invoice_description.trim().replace(/\n/g, ' - ');
                if (!invoiceNotesFromAccruals.includes(cleanNote)) invoiceNotesFromAccruals.push(cleanNote);
            }
        });
        
        if (invoiceNotesFromAccruals.length > 0) noteLines.push(`Ek Açıklama: ${invoiceNotesFromAccruals.join(' | ')}`);
        noteLines.push(`Not: IPGate Sistemi Üzerinden Otomatik Oluşturulmuştur.`);

        const finalInvoiceNote = noteLines.join('\n');
        const isTevkifatli = clientData.has_tevkifat === true;
        // YENİ SATIR: Veritabanındaki oranı default 2 olacak şekilde çek
        const tevkifatRate = clientData.tevkifat_rate || 2; 

        const { data: linkedInvoices, error: linkReadError } = await supabaseClient
            .from('accrual_invoices')
            .select('accrual_id, invoice_id')
            .in('accrual_id', accrualIds);
            
        if (linkReadError) {
            throw new Error(`Bağlı faturalar okunurken veritabanı hatası: ${linkReadError.message}`);
        }

        const existingInvoiceIds = new Set<string>();
        if (linkedInvoices) linkedInvoices.forEach(l => existingInvoiceIds.add(l.invoice_id));

        const accrualActiveCurrencies: Record<string, Set<string>> = {};
        let existingInvoices: any[] = [];

        if (existingInvoiceIds.size > 0) {
            const { data: invs } = await supabaseClient.from('invoices').select('id, status, kolaybi_status, currency').in('id', Array.from(existingInvoiceIds));
            if (invs) {
                existingInvoices = invs;
                accruals.forEach((acc: any) => {
                    accrualActiveCurrencies[acc.id] = new Set<string>();
                    const myLinks = linkedInvoices?.filter(l => l.accrual_id === acc.id) || [];
                    
                    myLinks.forEach(link => {
                        const inv = existingInvoices.find(i => i.id === link.invoice_id);
                        if (inv) {
                            const s = (inv.status || '').toLowerCase().trim();
                            const ks = (inv.kolaybi_status || '').toLowerCase().trim();
                            
                            const isDeclined = ks === 'declined' || s === 'declined' || ks.includes('decline');
                            const isRejected = ks === 'rejected' || s === 'rejected' || ks.includes('red') || s.includes('red') || ks.includes('reject') || s.includes('reject') || ks.includes('kabul edilme') || s.includes('kabul edilme') || ks.includes('iade') || s.includes('iade') || ks.includes('return') || s.includes('return');
                            const isCancelled = ks === 'cancelled' || s === 'cancelled' || ks.includes('iptal') || s.includes('iptal') || ks.includes('cancel') || s.includes('cancel');
                            const isFailed = ks === 'failed' || s === 'failed' || ks.includes('hata') || s.includes('hata') || s === 'sync_error' || ks === 'not_found' || s.includes('error') || ks.includes('error');

                            if (!(isDeclined || isRejected || isCancelled || isFailed)) accrualActiveCurrencies[acc.id].add((inv.currency || 'TRY').toUpperCase());
                        }
                    });
                });
            }
        }

        const groups: Record<string, any[]> = {};

        accruals.forEach((acc: any) => {
            if (acc.accrual_items && acc.accrual_items.length > 0) {
                acc.accrual_items.forEach((item: any) => {
                    
                    // 🔥 YENİ KURAL: Eğer bu Hukuk Departmanı SMM işlemiyse, 
                    // SADECE "Hukuk Danışmanlık" kalemi KolayBi'ye gönderilir. 
                    // Diğer masraflar atlanır (Onlar için Masraf Dekontu PDF'i üretilecek).
                    if (config.isSmm && item.fee_type !== 'Hukuk Danışmanlık') {
                        return; 
                    }

                    const itemCurrency = item.currency ? (item.currency.toUpperCase() === 'TL' ? 'TRY' : item.currency.toUpperCase()) : 'TRY';
                    if (accrualActiveCurrencies[acc.id] && accrualActiveCurrencies[acc.id].has(itemCurrency)) return; 

                    const qty = parseFloat(item.quantity || 1);
                    const price = parseFloat(item.unit_price || 0);
                    let vat = parseFloat(item.vat_rate || 0);

                    let feeTypeDisplay = item.fee_type || "";
                    const typeLower = feeTypeDisplay.toLowerCase().trim();

                    if (typeLower === 'tp harç' || typeLower === 'harç') feeTypeDisplay = 'TÜRKPATENT Harç';
                    else if (typeLower === 'tp hizmet') feeTypeDisplay = 'TÜRKPATENT Hizmet';
                    else if (typeLower === 'hizmet') feeTypeDisplay = 'EVREKA Hizmet';

                    const cleanItemName = (item.item_name || "").replace(/\s*-\s*(Harç|Hizmet Bedeli|Hizmet Ücreti|Hizmet)\s*$/i, "").trim();
                    let combinedName = `${feeTypeDisplay} - ${cleanItemName}`;

                    // 🔥 KOLAYBİ'NİN MAİLİNE İSTİNADEN: SMM için PDF'te görünecek ürün adı standartlaştırılıyor
                    if (config.isSmm) {
                        combinedName = "Hukuki Danışmanlık ve Vekalet Ücreti";
                    }

                    let docType = "SATIS";
                    if (!config.isSmm && isTevkifatli && typeLower === 'hizmet') {
                        docType = "TEVKIFAT";
                        vat = 20; 
                    }

                    const groupKey = config.isSmm ? itemCurrency : `${itemCurrency}_${docType}`; 
                    if (!groups[groupKey]) groups[groupKey] = [];

                    groups[groupKey].push({ ...item, qty, price, vat, combinedName, docType, currency: itemCurrency });
                });
            }
        });

        // 🔥 GÜNCELLENEN BELGE OLUŞTURMA MOTORU (SMM Aritmetiğine Tam Uyumlu + Tevkifat Düzeltmesi)
        const createDocumentInKolaybi = async (items: any[], docType: string, invoiceCurrency: string, forceScenario?: string): Promise<any> => {
            if (items.length === 0) return null;
            
            const invoiceParams = new URLSearchParams();
            
            invoiceParams.append("contact_id", String(kolaybiContactId));
            if (kolaybiAddressId && kolaybiAddressId !== "null" && kolaybiAddressId !== "undefined") {
                invoiceParams.append("address_id", String(kolaybiAddressId));
            }
            
            const turkeyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
            
            invoiceParams.append("order_date", turkeyDate);

            // 🔥 ÇÖZÜM: isSmmDocument karmaşası kaldırıldı. Hukuk departmanıysa (config.isSmm) kesinlikle SMM kesilir!
            if (config.isSmm) {
                invoiceParams.append("type", "self_employment_receipt");
                invoiceParams.append("is_gross", "1");
            } else {
                const currentScenario = forceScenario || (identityNo.length === 10 ? "TICARIFATURA" : "EARSIVFATURA");
                invoiceParams.append("type", "sale_invoice"); 
                invoiceParams.append("document_scenario", currentScenario); 
                invoiceParams.append("document_type", docType === 'SMM' ? 'SATIS' : docType); 
            }
            
            let localDescription = finalInvoiceNote; 
            let currentExchangeRate = 1;

            if (invoiceCurrency !== 'TRY') {
                currentExchangeRate = await getTcmbRate(invoiceCurrency);
                const formattedRate = currentExchangeRate.toFixed(4); 
                invoiceParams.append("exchange_rate", formattedRate); 
                localDescription += `\nBelge Kuru: 1 ${invoiceCurrency} = ${formattedRate} TL`;
            }

            let itemIndex = 0;
            let calculatedGrandTotal = 0;

            items.forEach(item => {
                invoiceParams.append(`items[${itemIndex}][product_id]`, String(productId));
                invoiceParams.append(`items[${itemIndex}][name]`, item.combinedName);
                invoiceParams.append(`items[${itemIndex}][quantity]`, item.qty.toFixed(2));
                
                let safeVat = [0, 1, 10, 20].includes(item.vat) ? item.vat : 20;
                
                let finalUnitPrice = item.price;
                let stoppage = "0";

                // 🔥 ÇÖZÜM: SMM ise netten brüte çevrim garantilendi
                if (config.isSmm) {
                    stoppage = identityNo.length === 10 ? "20" : "0";
                    if (stoppage === "20") {
                        finalUnitPrice = item.price / 0.8;
                    }
                }

                invoiceParams.append(`items[${itemIndex}][unit_price]`, finalUnitPrice.toFixed(2));
                invoiceParams.append(`items[${itemIndex}][vat_rate]`, safeVat.toString());
                invoiceParams.append(`items[${itemIndex}][description]`, item.combinedName);

                if (safeVat === 0 && !config.isSmm) {
                    invoiceParams.append(`items[${itemIndex}][vat_exemption_reason_code]`, "351");
                }

                if (config.isSmm) {
                    // 🔥 ÇÖZÜM: SMM Genel Toplam Matematiği (Brüt + KDV - Stopaj)
                    invoiceParams.append(`items[${itemIndex}][stoppage_value]`, stoppage);
                    
                    const itemGrossTotal = item.qty * finalUnitPrice;
                    const itemVatAmount = itemGrossTotal * (safeVat / 100);
                    const itemStoppageAmount = itemGrossTotal * (Number(stoppage) / 100);
                    
                    calculatedGrandTotal += (itemGrossTotal + itemVatAmount - itemStoppageAmount);
                } else {
                    if (docType === 'TEVKIFAT') {
                        const withholdingVal = tevkifatRate === 10 ? "50" : "90";
                        const withholdingCode = tevkifatRate === 10 ? "611" : "602"; 
                        
                        invoiceParams.append(`items[${itemIndex}][withholding_code]`, withholdingCode);
                        invoiceParams.append(`items[${itemIndex}][withholding_value]`, withholdingVal);
                        invoiceParams.append(`items[${itemIndex}][withholding_type]`, "PERCENTAGE");
                        
                        calculatedGrandTotal += (item.qty * item.price) * (1 + (tevkifatRate / 100)); 
                    } else {
                        calculatedGrandTotal += (item.qty * item.price) * (1 + (safeVat / 100));
                    }
                }

                itemIndex++;
            });

            invoiceParams.append("currency", invoiceCurrency);

            if (invoiceCurrency !== 'TRY') {
                const tryGrandTotal = (calculatedGrandTotal * currentExchangeRate).toFixed(2);
                localDescription += `\nÖdenecek Toplam TL Karşılığı: ${tryGrandTotal} TL`;
            }
            
            invoiceParams.append("description", localDescription);

            if (config.isSmm) {
                invoiceParams.append("note", localDescription);
                invoiceParams.append("e_document_note", localDescription);
                invoiceParams.append("notes[0][note]", localDescription);
            }

            const requestBodyString = invoiceParams.toString();
            
            console.log("\n==================================================================");
            console.log(`🚀 [KOLAYBI API İSTEĞİ - ${config.isSmm ? 'SMM' : 'FATURA'}] BAŞLIYOR`);
            console.log("==================================================================");
            console.log(`URL: ${config.baseUrl}${config.endpointBase}`);
            console.log("HEADERS:", JSON.stringify({ ...apiHeadersForm, Authorization: "Bearer [GİZLENDİ]" }, null, 2));
            console.log("\n----- GÖNDERİLEN PARAMETRELER (PARAM BAZLI DETAY) -----");
            
            const paramKeys = Array.from(invoiceParams.keys());
            for (const key of paramKeys) {
                console.log(`[PARAM] ${key} = ${invoiceParams.get(key)}`);
            }
            
            console.log("\n----- RAW BODY (URL Encoded Format) -----");
            console.log(requestBodyString);
            console.log("==================================================================\n");

            const invoiceReq = await fetch(`${config.baseUrl}${config.endpointBase}`, { method: 'POST', headers: apiHeadersForm, body: requestBodyString });
            const invoiceResText = await invoiceReq.text();
            
            console.log(`[KOLAYBI RES STATUS]: ${invoiceReq.status}`);
            console.log(`[KOLAYBI RES BODY]: ${invoiceResText}`);

            let invoiceRes;
            try { invoiceRes = JSON.parse(invoiceResText); } catch(e) { throw new Error(`Belge API Yanıtı Okunamadı: ${invoiceResText}`); }

            if (!invoiceReq.ok || invoiceRes.success === false) {
                const errorMessage = invoiceRes.message || JSON.stringify(invoiceRes);
                if (!config.isSmm && errorMessage.includes("e-Fatura kullanıcısına e-Arşiv gönderilemez") && (!forceScenario)) {
                    return await createDocumentInKolaybi(items, docType, invoiceCurrency, "TICARIFATURA");
                }
                const displayType = config.isSmm ? "SMM" : docType;
                throw new Error(`[${displayType} - ${invoiceCurrency}] Hata: ${errorMessage}`);
            }
            
            return {
                kolaybiId: invoiceRes.data?.document_id || invoiceRes.data?.id || invoiceRes.document_id || invoiceRes.id,
                total: calculatedGrandTotal,
                serialNo: invoiceRes.data?.serial_no || invoiceRes.data?.invoice_no || invoiceRes.data?.receipt_no || invoiceRes.data?.document_no || null
            };
        };
        
        let createdKolaybiDocIds: string[] = []; 
        let localInvoiceIds: string[] = [];

        try {
            for (const groupKey of Object.keys(groups)) {
                const items = groups[groupKey];
                if (items.length === 0) continue;

                const currency = items[0].currency;
                const docType = items[0].docType;

                const result = await createDocumentInKolaybi(items, docType, currency);
                if (result && result.kolaybiId) {
                    createdKolaybiDocIds.push(String(result.kolaybiId));
                    
                    const { data: inv, error: invInsError } = await supabaseClient.from('invoices').insert({
                        kolaybi_invoice_id: String(result.kolaybiId), 
                        status: 'draft', 
                        total_amount: result.total, 
                        currency: currency, 
                        client_id: clientId,
                        invoice_no: result.serialNo || null
                    }).select().single();
                    
                    if (invInsError) {
                        throw new Error(`Fatura veritabanına kaydedilemedi: ${invInsError.message}`);
                    }
                    
                    if (inv && inv.id) {
                        localInvoiceIds.push(inv.id);
                    }

                    if (result.serialNo) {
                        for (const accId of accrualIds) {
                            const { error: accUpdErr } = await supabaseClient.from('accruals').update({ evreka_invoice_no: result.serialNo }).eq('id', accId);
                            if (accUpdErr) throw new Error(`Tahakkuk güncellenirken hata: ${accUpdErr.message}`);
                        }
                    }
                }
            }

            if (localInvoiceIds.length === 0) throw new Error("Fatura edilecek geçerli kalem bulunamadı.");

            // 🔥 YENİ KÖPRÜ TABLOSUNA BAĞLANTIYI KAYDETME EKRANI (Hata fırlatacak şekilde güçlendirildi)
            const junctionInserts: any[] = [];
            for (const accId of accrualIds) {
                for (const invId of localInvoiceIds) {
                    junctionInserts.push({ accrual_id: accId, invoice_id: invId });
                }
            }

            if (junctionInserts.length > 0) {
                const { error: junctionError } = await supabaseClient.from('accrual_invoices').insert(junctionInserts);
                if (junctionError) {
                    throw new Error(`Köprü tablosuna (accrual_invoices) yazılırken veritabanı hatası: ${junctionError.message}`);
                }
            }

            return new Response(JSON.stringify({ 
                success: true, 
                message: "Belge başarıyla oluşturuldu.", 
                invoiceId: localInvoiceIds[0] 
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        } catch (invoiceError: any) {
            // 1. İşlem yarıda kalırsa KolayBi'de önceden başarıyla açılmış taslakları sil (Rollback)
            if (createdKolaybiDocIds.length > 0) {
                for (const kId of createdKolaybiDocIds) {
                    try {
                        await fetch(`${config.baseUrl}${config.endpointBase}/${kId}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${accessToken}`, 'Channel': config.channel }
                        });
                    } catch (e) {}
                }
            }
            
            // 2. 🔥 KESİN ÇÖZÜM: İşlem hata verirse veritabanına yeni eklenen yerel fatura kayıtlarını da SİL!
            if (localInvoiceIds.length > 0) {
                await supabaseClient.from('invoices').delete().in('id', localInvoiceIds);
            }
            
            throw invoiceError;
        }
    }

  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});