import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { userId } = await req.json()
    if (!userId) {
      throw new Error("Silinecek kullanıcı ID'si (userId) eksik.")
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Authorization header kontrolü eklendi
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
        throw new Error("Yetkisiz erişim: Authorization header bulunamadı.")
    }

    const token = authHeader.replace('Bearer ', '')
    const { data: { user: requestingUser }, error: authError } = await supabaseAdmin.auth.getUser(token)
    
    if (authError || !requestingUser) {
      throw new Error("Yetkisiz erişim: Geçerli bir oturum bulunamadı.")
    }

    const { data: adminProfile } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', requestingUser.id)
      .single()

    if (!adminProfile || adminProfile.role !== 'superadmin') {
      throw new Error(`Yetkisiz işlem: Bu işlemi sadece Süper Admin yapabilir. Sizin rolünüz: ${adminProfile?.role || 'Yok'}`)
    }

    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId)
    if (deleteError) throw deleteError

    await supabaseAdmin.from('users').delete().eq('id', userId)

    return new Response(
      JSON.stringify({ success: true, message: "Kullanıcı başarıyla silindi." }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error: any) {
    // 🔥 EKSİK OLAN KISIM: Hatayı Supabase Loglarına yazdırıyoruz
    console.error("❌ Kullanıcı Silme Hatası:", error.message || error)
    
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Bilinmeyen bir hata oluştu." }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})