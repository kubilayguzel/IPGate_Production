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
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization')! } }
    });

    const getKolaybiConfig = (department: string) => {
        if (department === 'HUKUK') {
            return {
                baseUrl: "https://ofis-sandbox-api.kolaybi.com", 
                channel: "evrekagroupsmm", 
                authPayload: { api_key: Deno.env.get("KOLAYBI_HUKUK_API_KEY") ?? "2e000fbf-920d-4c5b-9a42-b9422f734c01" }, 
                endpointBase: "/kolaybi/v1/smms", // 🔥 DOĞRU UÇ NOKTAYA GERİ DÖNDÜK!
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

    // 🔥 2. DEPARTMAN TESPİTİ DÜZELTİLDİ (Virgüllü ID'ler ve Exact Match)
    const getDepartmentForInvoice = async (invoiceId: string) => {
        const { data, error } = await supabaseClient
            .from("accruals")
            .select("department, invoice_id, invoice_id_2")
            .or(`invoice_id.eq.${invoiceId},invoice_id_2.eq.${invoiceId}`);

        if (error) throw new Error(`Departman sorgulanamadı: ${error.message}`);

        const exactMatch = data?.find((row: any) => {
            const secondaryIds = String(row.invoice_id_2 || "").split(",").map((id) => id.trim()).filter(Boolean);
            return String(row.invoice_id) === String(invoiceId) || secondaryIds.includes(String(invoiceId));
        });

        if (!exactMatch?.department) throw new Error("Belgenin bağlı olduğu departman bulunamadı.");
        return exactMatch.department;
    };

    // ==============================================================================
    // İŞLEM 1: FATURA SİLME / İPTAL ETME 
    // ==============================================================================
    if (action === 'delete') {
        const { invoiceId } = body;
        if (!invoiceId) throw new Error("Fatura ID (invoiceId) gerekli.");

        const { data: invoiceData, error: invError } = await supabaseClient.from('invoices').select('*').eq('id', invoiceId).single();
        if (invError || !invoiceData) throw new Error("Fatura veritabanında bulunamadı.");
        if (invoiceData.status !== 'draft') throw new Error("Sadece 'Taslak' durumundaki belgeler iptal edilebilir.");

        const department = await getDepartmentForInvoice(invoiceId);
        const config = getKolaybiConfig(department);
        const accessToken = await getKolaybiToken(config);

        const { data: allAccruals } = await supabaseClient.from('accruals').select('id, invoice_id, invoice_id_2').or(`invoice_id.eq.${invoiceId},invoice_id_2.eq.${invoiceId}`);

        if (allAccruals && allAccruals.length > 0) {
            for (const acc of allAccruals) {
                let updates: any = {};
                if (String(acc.invoice_id) === String(invoiceId)) updates.invoice_id = null;
                
                if (acc.invoice_id_2) {
                    const secondaryIds = acc.invoice_id_2.split(",").map((id:string) => id.trim()).filter(Boolean);
                    if (secondaryIds.includes(String(invoiceId))) {
                        const newSecondary = secondaryIds.filter((id:string) => id !== String(invoiceId));
                        updates.invoice_id_2 = newSecondary.length > 0 ? newSecondary.join(',') : null;
                    }
                }
                
                if (updates.hasOwnProperty('invoice_id') && updates.invoice_id === null) {
                    const currentInvoiceId2 = updates.hasOwnProperty('invoice_id_2') ? updates.invoice_id_2 : acc.invoice_id_2;
                    if (currentInvoiceId2) {
                        const firstSecId = currentInvoiceId2.split(',')[0].trim();
                        updates.invoice_id = firstSecId;
                        const rest = currentInvoiceId2.split(',').slice(1).map((i:string)=>i.trim()).filter(Boolean);
                        updates.invoice_id_2 = rest.length > 0 ? rest.join(',') : null;
                    }
                }
                if (Object.keys(updates).length > 0) {
                    await supabaseClient.from('accruals').update(updates).eq('id', acc.id);
                }
            }
        }

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
    // İŞLEM 3: FATURA SENKRONİZASYONU (GÜVENLİ)
    // ==============================================================================
    if (action === 'sync') {
        const { invoiceId } = body;
        if (!invoiceId) throw new Error("Fatura ID (invoiceId) gerekli.");

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

        // 🔥 3. YEREL KAYDI OTOMATİK SİLME RİSKİ KALDIRILDI
        if (!detailReq.ok || detailRes.success === false) {
            const errorMsg = detailRes.message || JSON.stringify(detailRes);
            if (errorMsg.toLowerCase().includes('bulunamadı') || detailReq.status === 404) {
                await supabaseClient.from("invoices").update({ kolaybi_status: "not_found", status: "sync_error" }).eq("id", invoiceId);
                throw new Error("Belge KolayBi hesabında bulunamadı. Yerel kayıt güvenlik amacıyla silinmedi.");
            }
            throw new Error(`Belge detayı alınamadı: ${errorMsg}`);
        }

        const docData = detailRes.data || detailRes;
        let listItem = null;
        try {
            // 🔥 4. SADECE BELGE TİPİNE GÖRE LİSTELEME VE EXACT MATCH
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

        const serialNo = combinedData.header?.serial_no || combinedData.serial_no || combinedData.invoice_no || null;
        const issueDate = combinedData.header?.issue_date || combinedData.issue_date || combinedData.order_date || null;
        const uuid = combinedData.uuid || combinedData.e_document_uuid || null;

        const updates: any = {};
        if (serialNo) updates.invoice_no = serialNo;
        if (issueDate) updates.invoice_date = issueDate;
        if (uuid) updates.kolaybi_uuid = uuid;

        const rawStatus = String(eDocStatus || commStatusVal || '').toUpperCase();
        const rawComm = String(commStatusVal || '').toUpperCase();
        const rawEDoc = String(eDocStatus || '').toUpperCase();
                
        if (rawStatus.includes('RED') || rawStatus.includes('REJECT') || rawStatus.includes('İPTAL') || rawStatus.includes('CANCEL')) {
            updates.status = (rawStatus.includes('İPTAL') || rawStatus.includes('CANCEL')) ? 'cancelled' : 'rejected';
        } else if (rawStatus.includes('KABUL') || rawStatus.includes('ONAY') || rawStatus.includes('APPROV')) {
            updates.status = 'approved';
        } else if (rawComm === 'NEW' || rawComm === 'DRAFT' || rawEDoc === 'READY' || rawStatus.includes('TASLAK')) {
            updates.status = 'draft'; 
        } else if (commStatusVal) {
            updates.status = typeof commStatusVal === 'string' ? commStatusVal.toLowerCase() : 'sent';
        } else if (uuid && inv.status === 'draft') {
            updates.status = 'sent';
        }

        if (eDocStatus) updates.kolaybi_status = eDocStatus;
        else if (commStatusVal) updates.kolaybi_status = typeof commStatusVal === 'string' ? commStatusVal : null;

        if (Object.keys(updates).length > 0) {
            await supabaseClient.from('invoices').update(updates).eq('id', invoiceId);
            if (serialNo) {
                const allAccrualsReq = await supabaseClient.from('accruals').select('id').or(`invoice_id.eq.${invoiceId},invoice_id_2.eq.${invoiceId}`);
                if (allAccrualsReq.data && allAccrualsReq.data.length > 0) {
                     const accIds = allAccrualsReq.data.map(a => a.id);
                     await supabaseClient.from('accruals').update({ evreka_invoice_no: serialNo }).in('id', accIds);
                }
            }
        }

        return new Response(JSON.stringify({ success: true, message: "Belge durumu başarıyla senkronize edildi.", data: updates, raw_kolaybi_data: docData }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // ==============================================================================
    // İŞLEM 5: TOPLU SENKRONİZASYON (GÜVENLİ)
    // ==============================================================================
    if (action === 'sync_bulk') {
        const { invoiceIds } = body;
        if (!invoiceIds || !Array.isArray(invoiceIds)) throw new Error("Belge ID listesi gerekli.");

        const { data: invoices } = await supabaseClient.from('invoices').select('*').in('id', invoiceIds);
        if (!invoices || invoices.length === 0) return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        let successCount = 0;
        const { data: allLinkedAccruals } = await supabaseClient.from('accruals').select('department, invoice_id, invoice_id_2');
        let tokens: Record<string, string> = {};
        
        const chunkSize = 10;
        for (let i = 0; i < invoices.length; i += chunkSize) {
            const chunk = invoices.slice(i, i + chunkSize);
            
            await Promise.all(chunk.map(async (inv) => {
                if (!inv.kolaybi_invoice_id || inv.kolaybi_invoice_id === 'undefined') return;
                
                try {
                    let department = 'EVREKA';
                    if (allLinkedAccruals) {
                        const exactMatch = allLinkedAccruals.find(a => {
                            const secondaryIds = String(a.invoice_id_2 || "").split(",").map(id => id.trim()).filter(Boolean);
                            return String(a.invoice_id) === String(inv.id) || secondaryIds.includes(String(inv.id));
                        });
                        if (exactMatch && exactMatch.department) department = exactMatch.department;
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

                    const serialNo = combinedData.header?.serial_no || combinedData.serial_no || combinedData.invoice_no || null;
                    const issueDate = combinedData.header?.issue_date || combinedData.issue_date || combinedData.order_date || null;
                    const uuid = combinedData.uuid || combinedData.e_document_uuid || null;

                    const updates: any = {};
                    if (serialNo) updates.invoice_no = serialNo;
                    if (issueDate) updates.invoice_date = issueDate;
                    if (uuid) updates.kolaybi_uuid = uuid;

                    const rawStatus = String(eDocStatus || commStatusVal || '').toUpperCase();
                    const rawComm = String(commStatusVal || '').toUpperCase();
                    const rawEDoc = String(eDocStatus || '').toUpperCase();
                    
                    if (rawStatus.includes('RED') || rawStatus.includes('REJECT') || rawStatus.includes('İPTAL') || rawStatus.includes('CANCEL')) {
                        updates.status = (rawStatus.includes('İPTAL') || rawStatus.includes('CANCEL')) ? 'cancelled' : 'rejected';
                    } else if (rawStatus.includes('KABUL') || rawStatus.includes('ONAY') || rawStatus.includes('APPROV')) {
                        updates.status = 'approved';
                    } else if (rawComm === 'NEW' || rawComm === 'DRAFT' || rawEDoc === 'READY' || rawStatus.includes('TASLAK')) {
                        updates.status = 'draft'; 
                    } else if (commStatusVal) {
                        updates.status = typeof commStatusVal === 'string' ? commStatusVal.toLowerCase() : 'sent';
                    } else if (uuid && inv.status === 'draft') {
                        updates.status = 'sent';
                    }

                    if (eDocStatus) updates.kolaybi_status = eDocStatus;
                    else if (commStatusVal) updates.kolaybi_status = typeof commStatusVal === 'string' ? commStatusVal : null;

                    if (Object.keys(updates).length > 0) {
                        await supabaseClient.from('invoices').update(updates).eq('id', inv.id);
                        if (serialNo) {
                            const allAccrualsReq = await supabaseClient.from('accruals').select('id').or(`invoice_id.eq.${inv.id},invoice_id_2.eq.${inv.id}`);
                            if (allAccrualsReq.data && allAccrualsReq.data.length > 0) {
                                const accIds = allAccrualsReq.data.map(a => a.id);
                                await supabaseClient.from('accruals').update({ evreka_invoice_no: serialNo }).in('id', accIds);
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
    // İŞLEM 2: FATURA / SMM OLUŞTURMA (CREATE) - TAMAMEN GÜVENLİ VE KUSURSUZ YAPI 
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

        // 🔥 5. KİMLİK NUMARASI ZORUNLULUĞU (Güvenlik Düzeltmesi)
        let identityNo = (clientData.tax_no || clientData.tckn || "").replace(/\s+/g, '');
        if (!/^\d{10,11}$/.test(identityNo)) {
            throw new Error(`${clientData.name} için geçerli bir VKN veya TCKN girilmelidir. Lütfen Cari Kartını güncelleyin.`);
        }
        if (identityNo.length === 10 && !clientData.tax_office?.trim()) {
            throw new Error(`${clientData.name} kurumsal bir müşteri (10 haneli VKN). Lütfen cari kartına Vergi Dairesi bilgisini giriniz.`);
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

        // 🔥 6. CARİ ARAMA KONTROLÜ DÜZELTİLDİ
        const searchUrl = `${config.baseUrl}/kolaybi/v1/associates?identity_no=${encodeURIComponent(identityNo)}`;
        const searchReq = await fetch(searchUrl, { method: 'GET', headers: getHeaders });
        const searchText = await searchReq.text();
        
        let searchRes: any;
        try { searchRes = JSON.parse(searchText); } catch { throw new Error(`Cari arama yanıtı okunamadı: ${searchText}`); }
        if (!searchReq.ok || searchRes.success === false) throw new Error(`Cari arama hatası: ${searchRes.message || searchText}`);
        
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
            if (!associateReq.ok || associateRes.success === false) throw new Error(`Cari Kayıt Hatası: ${associateRes.message}`);
            const dataObj = associateRes.data || associateRes;
            kolaybiContactId = dataObj.id;
        }

        if (!kolaybiContactId) throw new Error("KolayBi Cari ID'si alınamadı.");

        // 🔥 7. ADRES EKSİKSE OLUŞTURMA ZORUNLULUĞU GETİRİLDİ
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
            try { addressRes = JSON.parse(addressText); } catch { throw new Error(`Adres oluşturma yanıtı okunamadı: ${addressText}`); }
            if (!addressReq.ok || addressRes.success === false) throw new Error(`KolayBi adres oluşturma hatası: ${addressRes.message || addressText}`);
            kolaybiAddressId = addressRes.data?.id || addressRes.id || null;
        }

        if (!kolaybiAddressId) throw new Error("KolayBi fatura adresi bulunamadı veya oluşturulamadı.");

        let productId = null; 
        const productsReq = await fetch(`${config.baseUrl}/kolaybi/v1/products?limit=50`, { method: 'GET', headers: getHeaders });
        
        if (productsReq.ok) {
            const productsRes = await productsReq.json();
            const items = productsRes.data?.data || productsRes.data || [];
            
            let validServiceItem = items.find((i: any) => i.product_type === 'SERVICE' || i.product_type === 'service' || i.type === 'service');

            if (validServiceItem && validServiceItem.id) {
                productId = validServiceItem.id;
            } else {
                const newProductParams = new URLSearchParams();
                newProductParams.append("name", "SMM Hukuk Hizmet Bedeli"); 
                newProductParams.append("product_type", "service"); 
                newProductParams.append("vat_rate", "20");
                newProductParams.append("price_currency", "try");
                newProductParams.append("quantity", "0");

                const createProdReq = await fetch(`${config.baseUrl}/kolaybi/v1/products`, { method: 'POST', headers: apiHeadersForm, body: newProductParams.toString() });
                if (createProdReq.ok) {
                    const createProdRes = await createProdReq.json();
                    if (createProdRes.data && createProdRes.data.id) productId = createProdRes.data.id;
                }
            }
        }
        
        if (!productId && config.isSmm) {
            throw new Error("KolayBi hesabınızda geçerli bir 'HİZMET' kalemi bulunamadı. Lütfen KolayBi arayüzünden Ürünler/Hizmetler kısmına girip manuel bir hizmet ekleyin.");
        } else if (!productId) {
            productId = 1; 
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

        const existingInvoiceIds = new Set<string>();
        accruals.forEach((acc: any) => {
            if (acc.invoice_id) existingInvoiceIds.add(acc.invoice_id);
            if (acc.invoice_id_2) acc.invoice_id_2.split(',').forEach((id:string) => { if (id.trim()) existingInvoiceIds.add(id.trim()); });
        });

        const accrualActiveCurrencies: Record<string, Set<string>> = {};
        let existingInvoices: any[] = [];

        if (existingInvoiceIds.size > 0) {
            const { data: invs } = await supabaseClient.from('invoices').select('id, status, kolaybi_status, currency').in('id', Array.from(existingInvoiceIds));
            if (invs) {
                existingInvoices = invs;
                accruals.forEach((acc: any) => {
                    accrualActiveCurrencies[acc.id] = new Set<string>();
                    const ids: string[] = [];
                    if (acc.invoice_id) ids.push(acc.invoice_id);
                    if (acc.invoice_id_2) acc.invoice_id_2.split(',').forEach((id:string) => { if(id.trim()) ids.push(id.trim()); });

                    ids.forEach(id => {
                        const inv = existingInvoices.find(i => i.id === id);
                        if (inv) {
                            const s = (inv.status || '').toLowerCase().trim();
                            const ks = (inv.kolaybi_status || '').toLowerCase().trim();
                            
                            const isDeclined = ks === 'declined' || s === 'declined' || ks.includes('decline');
                            const isRejected = ks === 'rejected' || s === 'rejected' || ks.includes('red') || s.includes('red');
                            const isCancelled = ks === 'cancelled' || s === 'cancelled' || ks.includes('iptal') || s.includes('iptal');
                            const isFailed = ks === 'failed' || s === 'failed' || ks.includes('hata') || s.includes('hata');

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
                    const combinedName = `${feeTypeDisplay} - ${cleanItemName}`;

                    let docType = "SATIS";
                    // 🔥 8. GRUPLAMA DÜZELTMESİ: SMM tevkifat grubu ayrımından çıkarıldı, hep "SATIS" kalacak
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

        // 🔥 5. BELGE OLUŞTURMA MOTORU (EVREKA Korunarak SMM için Uyarlandı)
        const createDocumentInKolaybi = async (items: any[], docType: string, invoiceCurrency: string, forceScenario?: string): Promise<any> => {
            if (items.length === 0) return null;

            const invoiceParams = new URLSearchParams();
            invoiceParams.append("contact_id", String(kolaybiContactId));

            if (kolaybiAddressId && kolaybiAddressId !== "null" && kolaybiAddressId !== "undefined") {
                invoiceParams.append("address_id", String(kolaybiAddressId));
            }
            
            const turkeyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
            
            let currentScenario: string | undefined;

            if (config.isSmm) {
                // 🔥 SMM UÇ NOKTASI (/smms) İÇİN MİNİMAL VE KUSURSUZ PAKET
                invoiceParams.append("issue_date", turkeyDate); 
                // NOT: SMM uç noktasında 'type', 'document_scenario', 'document_type' ASLA GÖNDERİLMEZ! 
            } else {
                // EVREKA Departmanı (Fatura) Ayarları - MEVCUT YAPI KORUNDU
                currentScenario = forceScenario || (identityNo.length === 10 ? "TICARIFATURA" : "EARSIVFATURA");
                invoiceParams.append("order_date", turkeyDate);
                invoiceParams.append("type", "sale_invoice"); 
                invoiceParams.append("document_scenario", currentScenario); 
                invoiceParams.append("document_type", docType); 
            }
            
            let itemIndex = 0;
            let calculatedGrandTotal = 0;

            items.forEach(item => {
                invoiceParams.append(`items[${itemIndex}][product_id]`, String(productId));
                invoiceParams.append(`items[${itemIndex}][quantity]`, item.qty.toFixed(2));
                invoiceParams.append(`items[${itemIndex}][unit_price]`, item.price.toFixed(2));
                
                let safeVat = [0, 1, 10, 20].includes(item.vat) ? item.vat : 20;
                invoiceParams.append(`items[${itemIndex}][vat_rate]`, safeVat.toString());
                invoiceParams.append(`items[${itemIndex}][description]`, item.combinedName);

                if (safeVat === 0 && !config.isSmm) {
                    invoiceParams.append(`items[${itemIndex}][vat_exemption_code]`, "351");
                    invoiceParams.append(`items[${itemIndex}][vat_exemption_reason_code]`, "351");
                }

                if (config.isSmm) {
                    // SMM Kalem Zorunlulukları
                    invoiceParams.append(`items[${itemIndex}][stoppage_rate]`, "0"); 
                    invoiceParams.append(`items[${itemIndex}][withholding_rate]`, "0"); 
                    calculatedGrandTotal += (item.qty * item.price) * (1 + (safeVat / 100));
                } else {
                    if (docType === 'TEVKIFAT') {
                        invoiceParams.append(`items[${itemIndex}][withholding_code]`, "602");
                        invoiceParams.append(`items[${itemIndex}][withholding_value]`, "90");
                        invoiceParams.append(`items[${itemIndex}][withholding_type]`, "PERCENTAGE");
                        calculatedGrandTotal += (item.qty * item.price) * 1.02; 
                    } else {
                        calculatedGrandTotal += (item.qty * item.price) * (1 + (safeVat / 100));
                    }
                }
                itemIndex++;
            });

            invoiceParams.append("currency", invoiceCurrency);

            let localDescription = finalInvoiceNote; 
            if (invoiceCurrency !== 'TRY') {
                const currentExchangeRate = await getTcmbRate(invoiceCurrency);
                const formattedRate = currentExchangeRate.toFixed(4); 
                invoiceParams.append("exchange_rate", formattedRate); 
                
                const tryGrandTotal = (calculatedGrandTotal * currentExchangeRate).toFixed(2);
                localDescription += `\nBelge Kuru: 1 ${invoiceCurrency} = ${formattedRate} TL`;
                localDescription += `\nÖdenecek Toplam TL Karşılığı: ${tryGrandTotal} TL`;
            }
            
            invoiceParams.append("description", localDescription);

            const requestBodyString = invoiceParams.toString();
            console.log(`[DEBUG] 🚀 GÖNDERİLEN ${config.isSmm ? 'SMM' : 'FATURA'} PAKETİ:`, requestBodyString);

            const invoiceReq = await fetch(`${config.baseUrl}${config.endpointBase}`, { method: 'POST', headers: apiHeadersForm, body: requestBodyString });
            const invoiceResText = await invoiceReq.text();
            console.log(`[DEBUG] 🎯 YANIT:`, invoiceResText);

            let invoiceRes;
            try { invoiceRes = JSON.parse(invoiceResText); } catch(e) { throw new Error(`Belge API Yanıtı Okunamadı: ${invoiceResText}`); }

            if (!invoiceReq.ok || invoiceRes.success === false) {
                const errorMessage = invoiceRes.message || "";
                if (!config.isSmm && errorMessage.includes("e-Fatura kullanıcısına e-Arşiv gönderilemez") && currentScenario === "EARSIVFATURA") {
                    return await createDocumentInKolaybi(items, docType, invoiceCurrency, "TICARIFATURA");
                }
                const displayType = config.isSmm ? "SMM" : docType;
                throw new Error(`[${displayType} - ${invoiceCurrency}] Hata: ${errorMessage}`);
            }
            
            return {
                kolaybiId: invoiceRes.data?.document_id || invoiceRes.data?.id || invoiceRes.document_id || invoiceRes.id,
                total: calculatedGrandTotal
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
                    
                    const { data: inv } = await supabaseClient.from('invoices').insert({
                        kolaybi_invoice_id: String(result.kolaybiId), 
                        status: 'draft', 
                        total_amount: result.total, 
                        currency: currency, 
                        client_id: clientId
                    }).select().single();
                    
                    if (inv && inv.id) localInvoiceIds.push(inv.id);
                }
            }

            if (localInvoiceIds.length === 0) throw new Error("Fatura edilecek geçerli kalem bulunamadı.");

            for (const accId of accrualIds) {
                const acc = accruals.find((a:any) => String(a.id) === String(accId));
                let activeIds: string[] = [];
                
                const checkIsActive = (id: string) => {
                    const inv = existingInvoices.find(i => i.id === id);
                    if (!inv) return false;
                    const s = (inv.status || '').toLowerCase().trim();
                    const ks = (inv.kolaybi_status || '').toLowerCase().trim();
                    const isDeclined = ks === 'declined' || s === 'declined' || ks.includes('decline');
                    const isRejected = ks === 'rejected' || s === 'rejected' || ks.includes('red') || s.includes('red');
                    const isCancelled = ks === 'cancelled' || s === 'cancelled' || ks.includes('iptal') || s.includes('iptal');
                    const isFailed = ks === 'failed' || s === 'failed' || ks.includes('hata') || s.includes('hata');
                    return !(isDeclined || isRejected || isCancelled || isFailed);
                };

                if (acc.invoice_id && checkIsActive(acc.invoice_id)) activeIds.push(acc.invoice_id);
                if (acc.invoice_id_2) {
                    acc.invoice_id_2.split(',').forEach((id:string) => {
                        const trimmed = id.trim();
                        if (trimmed && checkIsActive(trimmed)) activeIds.push(trimmed);
                    });
                }

                const allInvoiceIdsForAccrual = [...new Set([...activeIds, ...localInvoiceIds])];
                const updatePayload: any = { invoice_id: null, invoice_id_2: null };
                
                if (allInvoiceIdsForAccrual.length > 0) {
                    updatePayload.invoice_id = allInvoiceIdsForAccrual[0];
                    if (allInvoiceIdsForAccrual.length > 1) {
                        updatePayload.invoice_id_2 = allInvoiceIdsForAccrual.slice(1).join(',');
                    }
                }
                await supabaseClient.from('accruals').update(updatePayload).eq('id', accId);
            }

            return new Response(JSON.stringify({ 
                success: true, 
                message: "Belge başarıyla oluşturuldu.", 
                invoiceId: localInvoiceIds[0] 
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        } catch (invoiceError: any) {
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
            throw invoiceError;
        }
    }

  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});