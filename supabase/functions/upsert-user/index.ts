import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { uid, email, newEmail, displayName, role = "user", password, disabled } = await req.json()

    if (!uid && !email) throw new Error("uid veya email zorunlu.");
    if (!displayName) throw new Error("displayName zorunlu.");

    // İsteği yapan kullanıcının token'ını al
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error("Yetkilendirme başlığı eksik.")
    const token = authHeader.replace('Bearer ', '')

    // Supabase Admin İstemcisini (Service Role Key ile) Başlat
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // 1. GÜVENLİK (YETKİ KONTROLÜ)
    const { data: { user: caller }, error: callerError } = await supabaseAdmin.auth.getUser(token)
    if (callerError || !caller) throw new Error("Yetkisiz istek (Token geçersiz).")

    // İsteği yapan kişinin superadmin olup olmadığını public.users tablosundan teyit et
    const { data: callerProfile } = await supabaseAdmin.from('users').select('role').eq('id', caller.id).single()
    
    const isSuperadmin = callerProfile?.role === 'superadmin' || 
                         caller.id === 'wH6MFM3jrYShxWDPkjr0Lbuj61F2' || 
                         caller.email?.includes('@evrekapatent.com');

    if (!isSuperadmin) {
       throw new Error("Bu işlemi yapmak için superadmin yetkisine sahip olmalısınız.")
    }

    console.log(`[Upsert User] İstek alındı. Hedef Email: ${email}, İşlemi Yapan: ${caller.email}`);

    // 2. KULLANICIYI BUL (uid veya email ile)
    let targetUid = uid;
    let existed = false;

    // Eğer uid yoksa ama email varsa, public.users tablosundan uid'yi bul
    if (!targetUid && email) {
        const { data: searchUser } = await supabaseAdmin.from('users').select('id').eq('email', email).maybeSingle();
        if (searchUser) targetUid = searchUser.id;
    }

    let authUser = null;

    if (targetUid) {
        // Kullanıcı Supabase Auth'da var mı kontrol et
        const { data: uData, error: uError } = await supabaseAdmin.auth.admin.getUserById(targetUid);
        if (!uError && uData.user) {
            existed = true;
            authUser = uData.user;
        }
    }

    const targetEmail = newEmail || email || (authUser ? authUser.email : null);

    // 3. OLUŞTURMA (CREATE) VEYA GÜNCELLEME (UPDATE) İŞLEMİ
    if (!existed) {
        // --- YENİ KULLANICI OLUŞTUR (CREATE) ---
        const { data: newUData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
            email: targetEmail,
            password: password,
            email_confirm: true, // Doğrulama beklemeden direkt aktif et
            user_metadata: { display_name: displayName, role: role }
        });
        if (createErr) throw createErr;
        
        authUser = newUData.user;
        targetUid = authUser.id;
        console.log(`✅ [Upsert User] Yeni kullanıcı oluşturuldu: ${targetUid}`);

    } else {
        // --- MEVCUT KULLANICIYI GÜNCELLE (UPDATE) ---
        const updatePayload: any = {
            user_metadata: { display_name: displayName, role: role }
        };
        
        if (password) updatePayload.password = password;
        
        if (targetEmail && targetEmail !== authUser.email) {
            updatePayload.email = targetEmail;
            updatePayload.email_confirm = true; // Email değişse de anında onayla
        }

        // Eğer 'disabled' true gönderildiyse hesabı askıya al (ban_duration kullanılarak)
        if (disabled === true) {
            updatePayload.ban_duration = "87600h"; // Yaklaşık 10 yıl banla (devre dışı bırak)
        } else if (disabled === false) {
            updatePayload.ban_duration = "none"; // Banı kaldır
        }

        const { data: updData, error: updErr } = await supabaseAdmin.auth.admin.updateUserById(targetUid, updatePayload);
        if (updErr) throw new Error("Kullanıcı güncellenemedi: " + updErr.message);
        
        authUser = updData.user;
        console.log(`🔄 [Upsert User] Kullanıcı güncellendi: ${targetUid}`);
    }

    // 4. PUBLIC.USERS TABLOSUNU SENKRONİZE ET (UPSERT)
    const { error: dbErr } = await supabaseAdmin.from('users').upsert({
        id: targetUid,
        email: targetEmail,
        display_name: displayName,
        role: role,
        disabled: disabled || false,
        updated_at: new Date().toISOString()
    });

    if (dbErr) throw new Error("Veritabanı (public.users) güncellenemedi: " + dbErr.message);

    return new Response(JSON.stringify({
        success: true,
        uid: targetUid,
        email: targetEmail,
        existed,
        role,
        disabled: disabled || false
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error: any) {
    console.error("❌ [Upsert User] Hata:", error.message)
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})