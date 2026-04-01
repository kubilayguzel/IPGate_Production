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

// 🔥 ÇÖZÜM 1: Firebase Tarzı 20 Karakter Rastgele ID Üretici
// (Firebase'den göç eden veya otomatik ID üretimi kapalı olan DB'ler için)
function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
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

    const safeName = (fileName || `tescil_belgesi_${appNo || 'evrak'}.pdf`).replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const storagePath = `transactions/${ipRecordId}/${Date.now()}_${safeName}`;

    // Storage Kayıt
    const fileBytes = decodeBase64(fileBase64);
    const { error: uploadError } = await supabaseClient.storage
      .from('documents')
      .upload(storagePath, fileBytes, {
        contentType: 'application/pdf',
        upsert: false
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabaseClient.storage.from('documents').getPublicUrl(storagePath);
    const publicUrl = urlData.publicUrl;

    // Parent Transaction Bul
    let parentId = null;
    const { data: parentTxs, error: parentErr } = await supabaseClient
      .from('transactions')
      .select('id, description, created_at, transaction_date')
      .eq('ip_record_id', ipRecordId)
      .eq('transaction_hierarchy', 'parent');

    if (!parentErr && parentTxs && parentTxs.length > 0) {
      const basvuruTx = parentTxs.find(tx => (tx.description || '').toLowerCase().includes('başvuru'));
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
    if (docDate) recordDateStr = new Date(docDate).toISOString(); 
    else {
      const todayZero = new Date(now);
      todayZero.setHours(0,0,0,0);
      recordDateStr = todayZero.toISOString();
    }

    // 🔥 ÇÖZÜM 2: Eklenti hafızasındaki "tescil_belgesi" metnini yakalayıp 45 yapıyoruz.
    const finalDocType = (docType === 'tescil_belgesi' || !docType) ? '45' : docType;

    // 🔥 ÇÖZÜM 3: DB'ye "NULL" gitmemesi için manuel ID'lerimizi oluşturuyoruz
    const newTxId = generateId();
    const newDocId = generateId();

    // Ana İşlem (Transaction) Kaydı
    const { data: newTx, error: txError } = await supabaseClient.from('transactions').insert({
      id: newTxId, // <-- VERİTABANINA ID'Yİ BİZ VERDİK
      ip_record_id: ipRecordId,
      transaction_type_id: finalDocType,
      transaction_hierarchy: 'child',
      parent_id: parentId,
      description: 'Tescil Belgesi',
      transaction_date: recordDateStr,
      user_id: userId,
      user_email: userEmail,
      user_name: userName
    }).select('id').single();

    if (txError) throw txError;

    // Alt Belge Kaydı
    const { error: docError } = await supabaseClient.from('transaction_documents').insert({
      id: newDocId, // <-- BURAYA DA BİZ VERDİK
      transaction_id: newTxId,
      document_name: safeName,
      document_url: publicUrl,
      document_type: 'application/pdf',
      document_designation: 'Resmi Yazı'
    });

    if (docError) throw docError;

    await supabaseClient.from('ip_records').update({ updated_at: now.toISOString() }).eq('id', ipRecordId);

    console.log(`✅ Transaction Oluşturuldu: ${newTxId}`);

    return new Response(JSON.stringify({ success: true, message: 'Belge başarıyla işlendi.', transactionId: newTxId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error: any) {
    console.error('❌ saveEpatsDocument Hatası:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }
})