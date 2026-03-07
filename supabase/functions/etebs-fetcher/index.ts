import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function joinNumericKeyObject(obj: any) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return null;
  const allNumeric = keys.every(k => String(Number(k)) === k);
  if (!allNumeric) return null;
  return keys.sort((a, b) => Number(a) - Number(b)).map(k => obj[k]).join('');
}

function extractAllAttachments(downloadRawData: any) {
  let node = downloadRawData?.DownloadDocumentResult ?? downloadRawData;
  const documents: any[] = [];

  const extractFromObject = (obj: any) => {
    if (!obj) return null;
    if (typeof obj === 'string') return obj; 
    if (obj.BASE64 && typeof obj.BASE64 === 'string') return obj.BASE64;
    const joined = joinNumericKeyObject(obj);
    if (joined) return joined;
    return null;
  };

  if (Array.isArray(node)) {
    node.forEach(item => {
      const b64 = extractFromObject(item);
      const desc = item.BELGE_ACIKLAMASI || item.belgeAciklamasi || "Ek";
      if (b64) documents.push({ base64: b64, description: desc });
    });
  } else if (typeof node === 'object') {
    const b64 = extractFromObject(node);
    const desc = node.BELGE_ACIKLAMASI || node.belgeAciklamasi || "Ana Doküman";
    if (b64) documents.push({ base64: b64, description: desc });
  }
  return documents;
}

function parseDateToYMD(dateStr: string | null) {
    if (!dateStr) return null;
    const match = dateStr.match(/^(\d{2})[./-](\d{2})[./-](\d{4})/);
    if (match) return `${match[3]}-${match[2]}-${match[1]}`;
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    return null;
}

// Şemada "timestamp with time zone" olan sütunlar için yardımcı
function toTimestampTz(dateStr: string | null) {
    if (!dateStr) return null;
    const ymd = parseDateToYMD(dateStr);
    if (!ymd) return null;
    return new Date(`${ymd}T00:00:00Z`).toISOString();
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { action, token, userId } = await req.json()

    if (!action || !token || !userId) {
      throw new Error('Eksik parametreler (action, token, userId gereklidir).')
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    console.log(`🚀 [ETEBS] İstek başlatıldı. Kullanıcı: ${userId}`);

    const listApiUrl = 'https://epats.turkpatent.gov.tr/service/TP/DAILY_NOTIFICATIONS?apikey=etebs';
    const listResponse = await fetch(listApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ TOKEN: token })
    });
    
    if (!listResponse.ok) throw new Error(`Liste API Hatası: ${listResponse.status}`);
    const listResult = await listResponse.json();
    
    if (listResult?.IslemSonucKod && listResult.IslemSonucKod !== '000') {
       throw new Error(`API Reddi: ${listResult.IslemSonucAck}`);
    }

    let notifications: any[] = [];
    if (Array.isArray(listResult)) notifications = listResult;
    else if (listResult.DAILY_NOTIFICATIONSResult) notifications = listResult.DAILY_NOTIFICATIONSResult;
    else if (listResult.notifications) notifications = listResult.notifications;

    const uniqueMap = new Map();
    notifications.forEach(item => {
        const docNo = String(item.EVRAK_NO || item.evrakNo || '').trim();
        if (docNo && !uniqueMap.has(docNo)) uniqueMap.set(docNo, item);
    });
    notifications = Array.from(uniqueMap.values());

    console.log(`📊 [ETEBS] ${notifications.length} tekil tebligat listelendi.`);

    const savedDocuments: any[] = [];
    const downloadFailures: any[] = [];
    
    let processHalted = false;
    let haltReason = "";

    const CHUNK_SIZE = 5; 
    
    for (let i = 0; i < notifications.length; i += CHUNK_SIZE) {
        if (processHalted) {
            console.warn(`🛑 [ETEBS] Kritik hata nedeniyle ${i}. evraktan sonrası iptal edildi!`);
            break; 
        }

        const chunk = notifications.slice(i, i + CHUNK_SIZE);
        console.log(`📦 [ETEBS] İşleniyor: ${i + 1}-${i + chunk.length} / ${notifications.length}`);
        
        await Promise.all(chunk.map(async (notification) => {
            if (processHalted) return;

            const docNo = String(notification.EVRAK_NO || notification.evrakNo || '').trim();
            const belgeAciklamasi = notification.BELGE_ACIKLAMASI || notification.belgeAciklamasi || 'Belge';

            if (!docNo) return;

            try {
                const { data: existingDoc, error: checkError } = await supabaseAdmin
                    .from('incoming_documents')
                    .select('id, file_url, status')
                    .eq('document_number', docNo)
                    .limit(1)
                    .maybeSingle();

                if (checkError) {
                    throw new Error(`Veritabanı Okuma Hatası: ${checkError.message}`);
                }

                if (existingDoc && existingDoc.file_url) {
                    console.log(`⏭️ [ETEBS] Atlandı (Zaten var): ${docNo}`);
                    savedDocuments.push({ ...existingDoc, isPreExisting: true });
                    return;
                }

                const downloadApiUrl = 'https://epats.turkpatent.gov.tr/service/TP/DOWNLOAD_DOCUMENT?apikey=etebs';
                const downloadResponse = await fetch(downloadApiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ "TOKEN": token, "DOCUMENT_NO": docNo })
                });

                const ct = (downloadResponse.headers.get('content-type') || '').toLowerCase();
                let downloadRawData;
                if (ct.includes('json')) {
                  downloadRawData = await downloadResponse.json();
                } else {
                  const txt = await downloadResponse.text();
                  try { downloadRawData = JSON.parse(txt); } 
                  catch { downloadRawData = { __rawText: txt, IslemSonucKod: 'NON_JSON' }; }
                }

                if (downloadRawData?.IslemSonucKod && downloadRawData.IslemSonucKod !== '000') {
                  if (downloadRawData.IslemSonucKod === '005') {
                    console.log(`⚠️ [ETEBS] Atlandı (005): ${docNo}`);
                    downloadFailures.push({ docNo, reason: 'SKIP: 005 (Daha önce indirilmiş)' });
                    return; 
                  }
                  throw new Error(`API Reddi: ${downloadRawData.IslemSonucAck} (${downloadRawData.IslemSonucKod})`);
                }

                const documentParts = extractAllAttachments(downloadRawData);

                if (!documentParts || documentParts.length === 0) {
                    throw new Error('BASE64 verisi boş döndü.');
                }

                let finalPdfBytes: Uint8Array;
                if (documentParts.length > 1) {
                    const mergedPdf = await PDFDocument.create();
                    for (const part of documentParts) {
                        if (!part.base64) continue;
                        const binaryString = atob(part.base64);
                        const bytes = new Uint8Array(binaryString.length);
                        for (let j = 0; j < binaryString.length; j++) {
                            bytes[j] = binaryString.charCodeAt(j);
                        }
                        const partDoc = await PDFDocument.load(bytes);
                        const copiedPages = await mergedPdf.copyPages(partDoc, partDoc.getPageIndices());
                        copiedPages.forEach((page) => mergedPdf.addPage(page));
                    }
                    finalPdfBytes = await mergedPdf.save();
                } else {
                    const binaryString = atob(documentParts[0].base64);
                    finalPdfBytes = new Uint8Array(binaryString.length);
                    for (let j = 0; j < binaryString.length; j++) {
                        finalPdfBytes[j] = binaryString.charCodeAt(j);
                    }
                }

                const safeName = belgeAciklamasi.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                const fileName = `${Date.now()}_${docNo}_${safeName}.pdf`;
                const storagePath = `incoming_documents/etebs/${docNo}/${fileName}`;
                
                const { error: uploadError } = await supabaseAdmin.storage
                    .from('documents')
                    .upload(storagePath, finalPdfBytes, {
                        contentType: 'application/pdf',
                        upsert: true
                    });

                if (uploadError) throw new Error(`Storage Upload Hatası: ${uploadError.message}`);

                const { data: publicUrlData } = supabaseAdmin.storage.from('documents').getPublicUrl(storagePath);
                
                // 🔥 ŞEMAYA BİREBİR UYGUN DB INSERT 
                const docData = {
                    id: docNo, // Şemanızdaki text id
                    file_name: fileName,
                    file_url: publicUrlData.publicUrl,
                    file_path: storagePath,
                    document_source: 'etebs',
                    status: 'pending',
                    document_number: docNo,
                    application_number: notification.DOSYA_NO ? String(notification.DOSYA_NO).trim() : (notification.dosyaNo ? String(notification.dosyaNo).trim() : null),
                    belge_tarihi: parseDateToYMD(notification.BELGE_TARIHI || notification.belgeTarihi), // 'date' tipine uygun
                    teblig_tarihi: parseDateToYMD(notification.TEBLIG_TARIHI || notification.tebligTarihi), // 'date' tipine uygun
                    user_id: userId,
                    description: belgeAciklamasi
                };

                const { error: dbError } = await supabaseAdmin.from('incoming_documents').insert(docData);
                if (dbError) throw new Error(`DB Insert Hatası (incoming_documents): ${dbError.message}`);

                const { error: etebsDbError } = await supabaseAdmin.from('etebs_notifications').insert({
                    id: docNo, // Şemanızdaki text id
                    evrak_no: docNo,
                    document_id: docNo,
                    status: 'downloaded',
                    belge_tarihi: toTimestampTz(notification.BELGE_TARIHI || notification.belgeTarihi), // 'timestamptz' tipine uygun
                    teblig_tarihi: toTimestampTz(notification.TEBLIG_TARIHI || notification.tebligTarihi), // 'timestamptz' tipine uygun
                    fetched_at: new Date().toISOString()
                });
                
                if (etebsDbError) console.error(`⚠️ [ETEBS] Log tablosuna yazılamadı (${docNo}):`, etebsDbError.message);

                savedDocuments.push(docData);
                console.log(`✅ [ETEBS] Başarıyla Kaydedildi: ${docNo}`);

            } catch (err: any) {
                console.error(`❌ [ETEBS] Evrak Hatası (${docNo}):`, err.message);
                
                if (!err.message.includes("SKIP: 005") && !err.message.includes("BASE64") && !err.message.includes("API Reddi")) {
                    console.error(`🛑 [KRİTİK HATA TESPİTİ] Süreç durduruluyor! Evraklar korunacak. Hata: ${err.message}`);
                    processHalted = true;
                    haltReason = err.message;
                } else {
                    downloadFailures.push({ docNo, reason: err.message });
                }
            }
        }));
    }

    // etebs_logs tablosuna yazma (Bu tabloda id uuid, o yüzden göndermiyoruz kendi atıyor)
    await supabaseAdmin.from('etebs_logs').insert({
        action: 'daily_fetch',
        status: processHalted ? 'halted' : (downloadFailures.length > 0 ? 'partial_success' : 'success'),
        error_message: processHalted ? haltReason : null,
        user_id: userId,
        context: { 
            total: notifications.length, 
            saved: savedDocuments.length, 
            failures: downloadFailures,
            halted: processHalted
        }
    });

    if (processHalted) {
         return new Response(JSON.stringify({
            success: false,
            error: `Sistem Kritik Bir Hata Nedeniyle Korumaya Alındı!\nNeden: ${haltReason}\n(Hata çözüldükten sonra tekrar sorgulayarak kaldığınız evraktan devam edebilirsiniz. İşlenen: ${savedDocuments.length})`,
            data: { savedDocuments, failures: downloadFailures }
        }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      success: true,
      data: {
        message: `İşlem tamamlandı. ${savedDocuments.length} başarılı, ${downloadFailures.length} hatalı.`,
        savedDocuments,
        failures: downloadFailures
      }
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error: any) {
    console.error("🔥 [ETEBS] Kritik Fetch Hatası:", error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})