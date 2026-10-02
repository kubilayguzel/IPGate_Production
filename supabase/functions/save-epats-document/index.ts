import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Güvenli Base64 Çözücü
function decodeBase64(b64: string): Uint8Array {
  const binString = atob(b64);
  const bytes = new Uint8Array(binString.length);
  for (let i = 0; i < binString.length; i++) {
    bytes[i] = binString.charCodeAt(i);
  }
  return bytes;
}

async function sha256Hex(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value;

  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function stableTextId(prefix: string, hash: string): string {
  // transactions.id ve transaction_documents.id text olduğu için mevcut
  // Firebase-tarzı 20 karakter uzunluğunu koruyoruz.
  return `${prefix}${hash}`.slice(0, 20);
}

function isStorageAlreadyExistsError(error: any): boolean {
  if (!error) return false;

  const status = Number(error?.statusCode || error?.status || 0);
  const message = String(error?.message || error?.error || '').toLowerCase();

  return (
    status === 409 ||
    message.includes('already exists') ||
    message.includes('duplicate')
  );
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const authHeader = req.headers.get('Authorization');

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader || '' } }
    });

    let userId = null;
    let userEmail = 'system@evrekapatent.com';
    let userName = 'Sistem Otomasyonu';

    if (authHeader) {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (user) {
        userId = user.id;
        userEmail = user.email || userEmail;
        userName = user.user_metadata?.display_name || user.user_metadata?.name || userName;
      }
    }

    const body = await req.json();
    const payload = body.data ? body.data : body;
    const { ipRecordId, fileBase64, fileName, appNo, docDate, docType } = payload;

    if (!ipRecordId || !fileBase64) {
      throw new Error('Eksik parametre: ipRecordId ve fileBase64 zorunludur.');
    }

    console.log(`📥 EPATS Belge Kaydı Başladı: ${appNo || 'Bilinmeyen No'} -> ${ipRecordId}`);

    const safeName = (fileName || `tescil_belgesi_${appNo || 'evrak'}.pdf`)
      .replace(/[^a-zA-Z0-9.\-_]/g, '_');

    // Eklenti hafızasındaki "tescil_belgesi" metnini yakalayıp 45 yapıyoruz.
    const finalDocType = (docType === 'tescil_belgesi' || !docType) ? '45' : String(docType);

    // -------------------------------------------------------------------------
    // IDEMPOTENCY
    // -------------------------------------------------------------------------
    // Aynı PDF tarayıcı tarafından webRequest + tabs.onUpdated gibi iki farklı
    // kanaldan yakalansa bile DB'de yalnızca bir kayıt oluşmalı.
    //
    // Anahtar:
    //   IP kaydı + işlem tipi + PDF'nin gerçek byte SHA-256 hash'i
    //
    // Böylece URL'nin değişmesi, timestamp veya farklı browser event'i yeni
    // transaction üretmez; gerçekten farklı PDF içeriği ise yeni evrak sayılır.
    const fileBytes = decodeBase64(fileBase64);
    if (!fileBytes.length) {
      throw new Error('PDF içeriği boş.');
    }

    const fileHash = await sha256Hex(fileBytes);
    const idempotencyHash = await sha256Hex(
      `${String(ipRecordId)}|${finalDocType}|${fileHash}`
    );

    const newTxId = stableTextId('E', idempotencyHash);
    const newDocId = stableTextId('D', await sha256Hex(`document|${idempotencyHash}`));

    // Daha önce başarıyla tamamlanmış aynı evrak varsa tekrar Storage/DB yazma.
    const { data: existingDoc, error: existingDocError } = await supabaseClient
      .from('transaction_documents')
      .select('id, transaction_id, document_url')
      .eq('id', newDocId)
      .maybeSingle();

    if (existingDocError) throw existingDocError;

    if (existingDoc) {
      console.log(`♻️ Aynı EPATS belgesi daha önce kaydedilmiş: ${existingDoc.transaction_id}`);
      return jsonResponse({
        success: true,
        duplicate: true,
        message: 'Belge daha önce kaydedilmiş; tekrar kayıt oluşturulmadı.',
        transactionId: existingDoc.transaction_id,
        documentId: existingDoc.id,
        documentUrl: existingDoc.document_url
      });
    }

    // Timestamp yerine deterministik Storage yolu kullanılır.
    // Eşzamanlı iki istek gelirse aynı path üzerinde yarışırlar; ikinci 409 alır
    // fakat bu durum hata değil, idempotent akışın doğal parçasıdır.
    const storagePath =
      `transactions/${ipRecordId}/epats/${finalDocType}_${fileHash}.pdf`;

    const { error: uploadError } = await supabaseClient.storage
      .from('documents')
      .upload(storagePath, fileBytes, {
        contentType: 'application/pdf',
        upsert: false
      });

    if (uploadError && !isStorageAlreadyExistsError(uploadError)) {
      throw uploadError;
    }

    if (uploadError) {
      console.log('♻️ Storage objesi zaten mevcut; DB kaydı idempotent olarak tamamlanacak.');
    }

    const { data: urlData } = supabaseClient.storage
      .from('documents')
      .getPublicUrl(storagePath);

    const publicUrl = urlData.publicUrl;

    // Parent Transaction Bul
    let parentId = null;
    const { data: parentTxs, error: parentErr } = await supabaseClient
      .from('transactions')
      .select('id, description, created_at, transaction_date')
      .eq('ip_record_id', ipRecordId)
      .eq('transaction_hierarchy', 'parent');

    if (!parentErr && parentTxs && parentTxs.length > 0) {
      const basvuruTx = parentTxs.find(
        tx => (tx.description || '').toLowerCase().includes('başvuru')
      );

      if (basvuruTx) {
        parentId = basvuruTx.id;
      } else {
        const sortedTxs = parentTxs.sort((a, b) => {
          const dateA = new Date(a.transaction_date || a.created_at).getTime();
          const dateB = new Date(b.transaction_date || b.created_at).getTime();
          return dateA - dateB;
        });
        parentId = sortedTxs[0].id;
      }
    }

    const now = new Date();
    let recordDateStr = now.toISOString();

    if (docDate) {
      const parsedDocDate = new Date(docDate);
      if (Number.isNaN(parsedDocDate.getTime())) {
        throw new Error(`Geçersiz docDate: ${docDate}`);
      }
      recordDateStr = parsedDocDate.toISOString();
    } else {
      const todayZero = new Date(now);
      todayZero.setHours(0, 0, 0, 0);
      recordDateStr = todayZero.toISOString();
    }

    // -------------------------------------------------------------------------
    // TRANSACTION UPSERT
    // -------------------------------------------------------------------------
    // Deterministik PK sayesinde eşzamanlı 2-3 çağrı aynı transaction'a denk gelir.
    // ignoreDuplicates=true mevcut kaydı değiştirmez ve ikinci kaydı üretmez.
    const { error: txError } = await supabaseClient
      .from('transactions')
      .upsert({
        id: newTxId,
        ip_record_id: ipRecordId,
        transaction_type_id: finalDocType,
        transaction_hierarchy: 'child',
        parent_id: parentId,
        description: 'Tescil Belgesi',
        transaction_date: recordDateStr,
        user_id: userId,
        user_email: userEmail,
        user_name: userName
      }, {
        onConflict: 'id',
        ignoreDuplicates: true
      });

    if (txError) throw txError;

    // Alt belge de deterministik PK ile idempotent yazılır.
    const { error: docError } = await supabaseClient
      .from('transaction_documents')
      .upsert({
        id: newDocId,
        transaction_id: newTxId,
        document_name: safeName,
        document_url: publicUrl,
        document_type: 'application/pdf',
        document_designation: 'Resmi Yazı'
      }, {
        onConflict: 'id',
        ignoreDuplicates: true
      });

    if (docError) throw docError;

    await supabaseClient
      .from('ip_records')
      .update({ updated_at: now.toISOString() })
      .eq('id', ipRecordId);

    console.log(`✅ EPATS belge kaydı tamamlandı: ${newTxId} / ${newDocId}`);

    return jsonResponse({
      success: true,
      duplicate: false,
      message: 'Belge başarıyla işlendi.',
      transactionId: newTxId,
      documentId: newDocId,
      documentUrl: publicUrl,
      fileHash
    });

  } catch (error: any) {
    console.error('❌ saveEpatsDocument Hatası:', error);
    return jsonResponse({ error: error?.message || String(error) }, 400);
  }
})
