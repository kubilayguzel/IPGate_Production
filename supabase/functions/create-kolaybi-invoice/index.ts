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

    // 🔥 YENİ: Departmana Göre Dinamik KolayBi Ayar Motoru
    const getKolaybiConfig = (department: string) => {
        if (department === 'HUKUK') {
            return {
                baseUrl: "https://ofis-sandbox-api.kolaybi.com", 
                channel: "evrekagroupsmm", // 🔥 DÜZELTME: Kanal adı test hesabının çalışma alanına göre ayarlandı
                authPayload: { api_key: "2e000fbf-920d-4c5b-9a42-b9422f734c01" },
                endpointBase: "/kolaybi/v1/smms", // SMM Kesim Uç Noktası
                isSmm: true
            };
        } else {
            return {
                baseUrl: "https://ofis-api.kolaybi.com", // Evreka için Canlı Ortam
                channel: "evrekapatent",
                authPayload: { api_key: "e95988f7-52d0-44ac-85ab-d40f8c6e27d4" },
                endpointBase: "/kolaybi/v1/invoices", // Fatura Kesim Uç Noktası
                isSmm: false
            };
        }
    };

    // 🔥 YENİ: Dinamik Token Alıcı
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

    // Yardımcı: Belgenin Hangi Departmana Ait Olduğunu Bulur
    const getDepartmentForInvoice = async (invoiceId: string) => {
        const { data } = await supabaseClient.from('accruals')
            .select('department')
            .or(`invoice_id.eq.${invoiceId},invoice_id_2.eq.${invoiceId}`)
            .limit(1)
            .maybeSingle();
        return data?.department || 'EVREKA';
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

        const { data: allAccruals, error: accErr } = await supabaseClient
            .from('accruals')
            .select('id, invoice_id, invoice_id_2')
            .or(`invoice_id.eq.${invoiceId},invoice_id_2.eq.${invoiceId}`);
            
        if (accErr) throw new Error(`Bağlı tahakkuklar sorgulanamadı: ${accErr.message}`);

        if (allAccruals && allAccruals.length > 0) {
            for (const acc of allAccruals) {
                let updates: any = {};
                if (acc.invoice_id === invoiceId) updates.invoice_id = null;
                if (acc.invoice_id_2 === invoiceId) updates.invoice_id_2 = null;
                
                if (updates.hasOwnProperty('invoice_id') && updates.invoice_id === null) {
                    const currentInvoiceId2 = updates.hasOwnProperty('invoice_id_2') ? updates.invoice_id_2 : acc.invoice_id_2;
                    if (currentInvoiceId2 && currentInvoiceId2 !== invoiceId) {
                        updates.invoice_id = currentInvoiceId2;
                        updates.invoice_id_2 = null;
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

        return new Response(JSON.stringify({ 
            success: true, 
            message: "Seçilen taslak belge başarıyla iptal edildi." 
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ==============================================================================
    // İŞLEM 3: FATURA SENKRONİZASYONU 
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

        if (!detailReq.ok || detailRes.success === false) {
            const errorMsg = detailRes.message || JSON.stringify(detailRes);
            if (errorMsg.toLowerCase().includes('bulunamadı') || detailReq.status === 404) {
                await supabaseClient.from('accruals')
                    .update({ invoice_id: null, invoice_id_2: null, evreka_invoice_no: null })
                    .or(`invoice_id.eq.${invoiceId},invoice_id_2.eq.${invoiceId}`);
                await supabaseClient.from('invoices').delete().eq('id', invoiceId);
                
                throw new Error("Bu belge KolayBi'den fiziksel olarak silinmiş. Sistemden kaldırıldı ve tahakkuklar serbest bırakıldı.");
            }
            throw new Error(`Belge detayı alınamadı: ${errorMsg}`);
        }

        const docData = detailRes.data || detailRes;
        
        let listItem = null;
        try {
            const listReq = await fetch(`${config.baseUrl}${config.endpointBase}?id=${inv.kolaybi_invoice_id}`, { method: 'GET', headers: getHeaders });
            if (listReq.ok) {
                const listRes = await listReq.json();
                const items = listRes.data?.data || listRes.data || [];
                listItem = items.find((i: any) => String(i.id) === String(inv.kolaybi_invoice_id));
                if (!listItem && items.length > 0) listItem = items[0];
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
                await supabaseClient.from('accruals').update({ evreka_invoice_no: serialNo }).or(`invoice_id.eq.${invoiceId},invoice_id_2.eq.${invoiceId}`);
            }
        }

        return new Response(JSON.stringify({ 
            success: true, 
            message: "Belge durumu başarıyla senkronize edildi.", 
            data: updates,
            raw_kolaybi_data: docData 
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // ==============================================================================
    // İŞLEM 5: TOPLU SENKRONİZASYON (HIZLI VE OPTİMİZE SÜRÜM)
    // ==============================================================================
    if (action === 'sync_bulk') {
        const { invoiceIds } = body;
        if (!invoiceIds || !Array.isArray(invoiceIds)) throw new Error("Belge ID listesi gerekli.");

        const { data: invoices } = await supabaseClient.from('invoices').select('*').in('id', invoiceIds);
        if (!invoices || invoices.length === 0) return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        let successCount = 0;

        // Performans: Her belge için ayrı ayrı token çekmemek için departmanları toplu alıyoruz
        const { data: allLinkedAccruals } = await supabaseClient.from('accruals').select('department, invoice_id, invoice_id_2');
        
        let tokens: Record<string, string> = {};
        
        const chunkSize = 10;
        for (let i = 0; i < invoices.length; i += chunkSize) {
            const chunk = invoices.slice(i, i + chunkSize);
            
            await Promise.all(chunk.map(async (inv) => {
                if (!inv.kolaybi_invoice_id || inv.kolaybi_invoice_id === 'undefined') return;
                
                try {
                    // Bu faturanın departmanını bul
                    let department = 'EVREKA';
                    if (allLinkedAccruals) {
                        const acc = allLinkedAccruals.find(a => a.invoice_id === inv.id || (a.invoice_id_2 && a.invoice_id_2.includes(inv.id)));
                        if (acc && acc.department) department = acc.department;
                    }

                    const config = getKolaybiConfig(department);
                    if (!tokens[department]) {
                        tokens[department] = await getKolaybiToken(config);
                    }
                    const accessToken = tokens[department];
                    const getHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Channel': config.channel };

                    const detailReq = await fetch(`${config.baseUrl}${config.endpointBase}/${inv.kolaybi_invoice_id}`, { method: 'GET', headers: getHeaders });
                    const detailResText = await detailReq.text();
                    let detailRes;
                    try { detailRes = JSON.parse(detailResText); } catch(e) { return; }

                    if (!detailReq.ok || detailRes.success === false) {
                        const errMsg = detailRes.message || "";
                        if (errMsg.toLowerCase().includes('bulunamadı') || detailReq.status === 404) {
                            await supabaseClient.from('accruals').update({ invoice_id: null, invoice_id_2: null, evreka_invoice_no: null }).or(`invoice_id.eq.${inv.id},invoice_id_2.eq.${inv.id}`);
                            await supabaseClient.from('invoices').delete().eq('id', inv.id);
                            successCount++;
                        }
                        return;
                    }

                    const docData = detailRes.data || detailRes;
                    let listItem = null;
                    try {
                        const listReq = await fetch(`${config.baseUrl}${config.endpointBase}?id=${inv.kolaybi_invoice_id}`, { method: 'GET', headers: getHeaders });
                        if (listReq.ok) {
                            const listRes = await listReq.json();
                            const items = listRes.data?.data || listRes.data || [];
                            listItem = items.find((j: any) => String(j.id) === String(inv.kolaybi_invoice_id));
                            if (!listItem && items.length > 0) listItem = items[0];
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
                            await supabaseClient.from('accruals').update({ evreka_invoice_no: serialNo }).or(`invoice_id.eq.${inv.id},invoice_id_2.eq.${inv.id}`);
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
    // İŞLEM 2: FATURA / SMM OLUŞTURMA (CREATE) - MEVCUT YAPI %100 KORUNDU
    // ==============================================================================
    if (action === 'create') {
        const { accrualIds, mergeStrategy } = body;
        if (!accrualIds || accrualIds.length === 0) throw new Error("Lütfen faturalandırılacak tahakkukları seçin.");

        const { data: accruals, error: accError } = await supabaseClient
            .from('accruals')
            .select('*, accrual_items(*)')
            .in('id', accrualIds);

        if (accError || !accruals || accruals.length === 0) throw new Error("Tahakkuk Çekme Hatası.");

        // 🔥 YENİ: ORTAK DEPARTMAN TESPİTİ VE GÜVENLİK
        const department = accruals[0].department || 'EVREKA';
        for (const acc of accruals) {
            if ((acc.department || 'EVREKA') !== department) {
                throw new Error("Güvenlik İhlali: Evreka ve Hukuk birimlerine ait tahakkuklar tek belgede birleştirilemez!");
            }
        }
        
        const config = getKolaybiConfig(department);

        // MEVCUT KOD: TCMB Kuru Çekici
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

        let identityNo = (clientData.tax_no || clientData.tckn || "").replace(/\s+/g, '');
        if (identityNo.length !== 10 && identityNo.length !== 11) {
            identityNo = "11111111111";
        }

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

        const accessToken = await getKolaybiToken(config); // 🔥 YENİ: Config bazlı token alımı
        const apiHeadersForm = { 'Authorization': `Bearer ${accessToken}`, 'Channel': config.channel, 'Content-Type': 'application/x-www-form-urlencoded' };
        const getHeaders = { 'Authorization': `Bearer ${accessToken}`, 'Channel': config.channel };

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

        const cityName = clientData.province && clientData.province.trim() !== '' ? clientData.province.trim() : "Ankara";
        const districtName = clientData.district && clientData.district.trim() !== '' ? clientData.district.trim() : "Merkez";

        associateParams.append("addresses[address]", clientData.address || "Merkez");
        associateParams.append("addresses[city]", cityName);
        associateParams.append("addresses[district]", districtName); 
        associateParams.append("addresses[country]", "Türkiye"); 
        associateParams.append("addresses[address_type]", "invoice");

        let kolaybiContactId = null;
        let kolaybiAddressId = null;

        const searchReq = await fetch(`${config.baseUrl}/kolaybi/v1/associates?query=${identityNo}&limit=50`, { method: 'GET', headers: getHeaders });
        const searchRes = await searchReq.json();
        const list = searchRes.data?.data || searchRes.data || [];
        const foundAssociate = list.find((a: any) => String(a.identity_no) === identityNo || String(a.tax_number) === identityNo);

        if (foundAssociate && foundAssociate.id) {
            kolaybiContactId = foundAssociate.id;
            await fetch(`${config.baseUrl}/kolaybi/v1/associates/${kolaybiContactId}`, { method: 'PUT', headers: apiHeadersForm, body: associateParams.toString() });
            const detailReq = await fetch(`${config.baseUrl}/kolaybi/v1/associates/${kolaybiContactId}`, { method: 'GET', headers: getHeaders });
            if (detailReq.ok) {
                const detailRes = await detailReq.json();
                const detailData = detailRes.data || detailRes;
                kolaybiAddressId = detailData.default_address_id || detailData.address?.[0]?.id || detailData.addresses?.[0]?.id || detailData.address_id;
            }
        } else {
            const associateReq = await fetch(`${config.baseUrl}/kolaybi/v1/associates`, { method: 'POST', headers: apiHeadersForm, body: associateParams.toString() });
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

            const addrReq = await fetch(`${config.baseUrl}/kolaybi/v1/address/create`, { method: 'POST', headers: apiHeadersForm, body: addressParams.toString() });
            const addrResText = await addrReq.text();
            try { const addrRes = JSON.parse(addrResText); if (addrRes.data && addrRes.data.id) kolaybiAddressId = addrRes.data.id; } catch(e) {}
        }

        let productId = null; 
        try {
            const productsReq = await fetch(`${config.baseUrl}/kolaybi/v1/products?limit=1`, { method: 'GET', headers: getHeaders });
            if (productsReq.ok) {
                const productsRes = await productsReq.json();
                if (productsRes.data && productsRes.data.length > 0) {
                    productId = productsRes.data[0].id; 
                }
            }
            
            // 🔥 ÇÖZÜM: Yeni hesapta hiç hizmet kartı yoksa "Kayıt bulunamadı" hatasını önlemek için otomatik oluştur.
            if (!productId) {
                const prodParams = new URLSearchParams();
                prodParams.append("name", "Danışmanlık / Hizmet Bedeli");
                prodParams.append("unit", "ADET");
                prodParams.append("product_type", "2"); // 1: Ürün, 2: Hizmet
                prodParams.append("vat_rate", "20");
                prodParams.append("currency", "TRY");
                
                const newProdReq = await fetch(`${config.baseUrl}/kolaybi/v1/products`, { 
                    method: 'POST', 
                    headers: apiHeadersForm, 
                    body: prodParams.toString() 
                });
                
                if (newProdReq.ok) {
                    const newProdRes = await newProdReq.json();
                    if (newProdRes.data && newProdRes.data.id) {
                        productId = newProdRes.data.id;
                    }
                }
            }
        } catch(e) {
            console.error("Hizmet çekme/oluşturma hatası:", e);
        }

        if (!productId) productId = 1; // Güvenlik amaçlı son çare

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
                if (!invoiceNotesFromAccruals.includes(cleanNote)) {
                    invoiceNotesFromAccruals.push(cleanNote);
                }
            }
        });
        
        if (invoiceNotesFromAccruals.length > 0) {
            noteLines.push(`Ek Açıklama: ${invoiceNotesFromAccruals.join(' | ')}`);
        }

        noteLines.push(`Not: IPGate Sistemi Üzerinden Otomatik Oluşturulmuştur.`);

        const finalInvoiceNote = noteLines.join('\n');
        const isTevkifatli = clientData.has_tevkifat === true;

        const existingInvoiceIds = new Set<string>();
        accruals.forEach((acc: any) => {
            if (acc.invoice_id) existingInvoiceIds.add(acc.invoice_id);
            if (acc.invoice_id_2) {
                acc.invoice_id_2.split(',').forEach((id:string) => {
                    if (id.trim()) existingInvoiceIds.add(id.trim());
                });
            }
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

                            if (!(isDeclined || isRejected || isCancelled || isFailed)) {
                                accrualActiveCurrencies[acc.id].add((inv.currency || 'TRY').toUpperCase());
                            }
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
                    
                    if (accrualActiveCurrencies[acc.id] && accrualActiveCurrencies[acc.id].has(itemCurrency)) {
                        return; 
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

                    let docType = "SATIS";
                    if (isTevkifatli && typeLower === 'hizmet') {
                        docType = "TEVKIFAT";
                        vat = 20; 
                    }

                    const groupKey = `${itemCurrency}_${docType}`; 
                    if (!groups[groupKey]) groups[groupKey] = [];

                    groups[groupKey].push({ ...item, qty, price, vat, combinedName, docType, currency: itemCurrency });
                });
            }
        });

        // 🔥 YENİ: BELGE OLUŞTURMA MOTORU (Fatura ve SMM'yi Kapsayacak Şekilde Akıllandırıldı)
        const createDocumentInKolaybi = async (items: any[], docType: string, invoiceCurrency: string, forceScenario?: string): Promise<any> => {
            if (items.length === 0) return null;

            const invoiceParams = new URLSearchParams();
            invoiceParams.append("contact_id", String(kolaybiContactId));
            invoiceParams.append("address_id", String(kolaybiAddressId));
            
            const currentScenario = forceScenario || (identityNo.length === 10 ? "TICARIFATURA" : "EARSIVFATURA");
            
            // 🚀 BİRİM KONTROLÜ (SMM Mİ FATURA MI?)
            if (config.isSmm) {
                invoiceParams.append("issue_date", new Date().toISOString().split('T')[0]); // SMM'de issue_date zorunlu
                invoiceParams.append("document_scenario", "ESMM"); // Serbest Meslek Makbuzu Senaryosu
            } else {
                invoiceParams.append("order_date", new Date().toISOString().split('T')[0]); 
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
                invoiceParams.append(`items[${itemIndex}][vat_rate]`, item.vat.toString());
                invoiceParams.append(`items[${itemIndex}][description]`, item.combinedName);

                if (config.isSmm) {
                    // SMM İÇİN KESİNTİLER (Varsayılan olarak 0 bırakıyoruz, vergi kuralına göre eklenebilir)
                    invoiceParams.append(`items[${itemIndex}][stoppage_rate]`, "0"); // Stopaj 
                    invoiceParams.append(`items[${itemIndex}][withholding_rate]`, "0"); // KDV Tevkifatı
                    calculatedGrandTotal += (item.qty * item.price) * (1 + (item.vat / 100));
                } else {
                    // FATURA İÇİN MUAFİYET VE TEVKİFAT
                    if (item.vat === 0) {
                        invoiceParams.append(`items[${itemIndex}][vat_exemption_code]`, "351");
                        invoiceParams.append(`items[${itemIndex}][vat_exemption_reason_code]`, "351");
                    }
                    if (docType === 'TEVKIFAT') {
                        invoiceParams.append(`items[${itemIndex}][withholding_code]`, "602");
                        invoiceParams.append(`items[${itemIndex}][withholding_value]`, "90");
                        invoiceParams.append(`items[${itemIndex}][withholding_type]`, "PERCENTAGE");
                        calculatedGrandTotal += (item.qty * item.price) * 1.02; 
                    } else {
                        calculatedGrandTotal += (item.qty * item.price) * (1 + (item.vat / 100));
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
            // YENİ: Uç nokta (Endpoint) Config'den alınıyor (SMM veya Fatura)
            const invoiceReq = await fetch(`${config.baseUrl}${config.endpointBase}`, { method: 'POST', headers: apiHeadersForm, body: requestBodyString });
            const invoiceResText = await invoiceReq.text();
            let invoiceRes;
            try { invoiceRes = JSON.parse(invoiceResText); } catch(e) { throw new Error(`Belge API Yanıtı Okunamadı`); }

            if (!invoiceReq.ok || invoiceRes.success === false) {
                const errorMessage = invoiceRes.message || "";
                
                // Sadece fatura kesilirken geçerli olan akıllı senaryo düşürme mantığı
                if (!config.isSmm && errorMessage.includes("e-Fatura kullanıcısına e-Arşiv gönderilemez") && currentScenario === "EARSIVFATURA") {
                    console.log(`[OTOMATİK DÜZELTME] Müşteri e-Fatura mükellefi çıktı. TICARIFATURA ile tekrar deneniyor...`);
                    return await createDocumentInKolaybi(items, docType, invoiceCurrency, "TICARIFATURA");
                }

                throw new Error(`[${docType} - ${invoiceCurrency}] Belge Oluşturma Hatası: ${errorMessage}`);
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
                    
                    if (inv && inv.id) {
                        localInvoiceIds.push(inv.id);
                    }
                }
            }

            if (localInvoiceIds.length === 0) throw new Error("Fatura edilecek herhangi bir kalem bulunamadı (Belge kalemlerinin geçerli bir taslak veya onaylanmış faturası/SMM'si halihazırda mevcut).");

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

                if (acc.invoice_id && checkIsActive(acc.invoice_id)) {
                    activeIds.push(acc.invoice_id);
                }
                if (acc.invoice_id_2) {
                    acc.invoice_id_2.split(',').forEach((id:string) => {
                        const trimmed = id.trim();
                        if (trimmed && checkIsActive(trimmed)) {
                            activeIds.push(trimmed);
                        }
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
                message: localInvoiceIds.length > 1 ? `Başarılı: Farklı tipler için ${localInvoiceIds.length} ayrı belge oluştu.` : (config.isSmm ? "SMM Başarıyla Oluşturuldu." : "Fatura başarıyla oluşturuldu."), 
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