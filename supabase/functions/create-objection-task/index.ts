import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function isWeekend(date: Date) { return date.getDay() === 0 || date.getDay() === 6; }

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; 
        const supabase = createClient(supabaseUrl, supabaseKey);

        const body = await req.json();
        const { monitoredMarkId, thirdPartyIpRecordId, similarMark, similarMarkName, bulletinNo, callerEmail, bulletinRecordData } = body;

        if (!monitoredMarkId || !similarMark || !bulletinNo) throw new Error("Eksik parametre.");

        const cleanMonitoredId = String(monitoredMarkId).trim();

        // 1. KENDİ MARKAMIZI (IP RECORD VEYA MONITORING) BUL
        const { data: monData } = await supabase.from('monitoring_trademarks').select('*').eq('id', cleanMonitoredId).maybeSingle();
        let targetIpRecordId = cleanMonitoredId;
        if (monData && monData.ip_record_id) targetIpRecordId = monData.ip_record_id;

        const { data: ipData } = await supabase.from('ip_records').select('*').eq('id', targetIpRecordId).maybeSingle();

        let clientId = null;
        let ipAppName = "-";
        let ipTitle = "-";
        let ipAppNo = "-";

        if (ipData) {
            ipTitle = ipData.title || ipData.brand_name || ipData.brand_text || "-";
            ipAppNo = ipData.application_number || "-";
            
            const { data: applicantData } = await supabase.from('ip_record_applicants').select('person_id').eq('ip_record_id', ipData.id).order('order_index', { ascending: true }).limit(1).maybeSingle();
            if (applicantData && applicantData.person_id) {
                clientId = applicantData.person_id;
                const { data: personData } = await supabase.from('persons').select('name').eq('id', clientId).maybeSingle();
                if (personData) ipAppName = personData.name || "-";
            }
        } else if (monData) {
            ipTitle = monData.mark_name || "-";
            ipAppNo = monData.application_no || "-";
            ipAppName = monData.owner_name || "-";
        }

        // 🔥 2. ATAMA (DÜZELTİLDİ)
        // İş "awaiting_client_approval" statüsünde açıldığı için task_assignments tablosundaki 
        // standart kuralı eziyoruz ve doğrudan onay sürecinden sorumlu kişiye atıyoruz.
        const assignedUid = "dqk6yRN7Kwgf6HIJldLt9Uz77RU2"; 
        const assignedEmail = "selcanakoglu@evrekapatent.com";

        // 3. RESMİ SON TARİH HESAPLAMA
        let officialDueDate = null;
        const { data: bulletinData } = await supabase.from('trademark_bulletins').select('bulletin_date').eq('bulletin_no', String(bulletinNo).trim()).maybeSingle();
        if (bulletinData && bulletinData.bulletin_date) {
            const bDate = new Date(bulletinData.bulletin_date);
            if (!isNaN(bDate.getTime())) {
                bDate.setMonth(bDate.getMonth() + 2);
                let iter = 0;
                while (isWeekend(bDate) && iter < 10) { bDate.setDate(bDate.getDate() + 1); iter++; }
                officialDueDate = bDate.toISOString();
            }
        }

        // 4. COUNTER MANTIĞI
        let taskId = crypto.randomUUID(); 
        try {
            const { data: counterData } = await supabase.from('counters').select('last_id').eq('id', 'tasks').maybeSingle();
            let nextCount = 1000;
            if (counterData && typeof counterData.last_id === 'number') {
                nextCount = counterData.last_id + 1;
                await supabase.from('counters').update({ last_id: nextCount }).eq('id', 'tasks');
            } else {
                await supabase.from('counters').insert({ id: 'tasks', last_id: nextCount });
            }
            taskId = String(nextCount);
        } catch (e) { console.error("Sayaç okuma hatası:", e); }

        const hitMarkName = similarMarkName || similarMark.markName || 'Bilinmeyen Marka';
        
        // 5. ÜÇÜNCÜ TARAF (THIRD PARTY) PORTFÖY KAYDINI OLUŞTUR
        const thirdPartyPortfolioId = thirdPartyIpRecordId || crypto.randomUUID();
        let hitImageUrl = bulletinRecordData?.imagePath || similarMark.imagePath || null;
        if (hitImageUrl && !hitImageUrl.startsWith('http')) {
            hitImageUrl = `https://guicrctynauzxhyfpdfe.supabase.co/storage/v1/object/public/brand_images/${hitImageUrl}`;
        }

        const portfolioData = {
            id: thirdPartyPortfolioId,
            title: hitMarkName,
            status: 'published_in_bulletin',
            ip_type: 'trademark',
            brand_name: hitMarkName,
            brand_text: hitMarkName,
            description: `Bülten benzerlik araması ile otomatik oluşturulan rakip kaydı.`,
            created_from: 'bulletin_record',
            brand_image_url: hitImageUrl,
            application_date: similarMark.applicationDate || null,
            portfolio_status: 'active',
            record_owner_type: 'third_party',
            application_number: similarMark.applicationNo || null,
            has_registration_cert: false,
            transaction_hierarchy: 'parent',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        const { error: ipError } = await supabase.from('ip_records').insert(portfolioData);
        if (ipError) throw new Error(`Rakip Portföy Kayıt Hatası: ${ipError.message}`);

        // 6. RAKİBİN ALTINA İŞLEM (TRANSACTION) EKLE
        const transactionId = crypto.randomUUID();
        const txPayload = {
            id: transactionId,
            ip_record_id: thirdPartyPortfolioId,
            transaction_type_id: '20', 
            description: 'Yayına İtiraz',
            transaction_hierarchy: 'parent',
            task_id: null, // Çakışmayı önlemek için boş bırakıyoruz
            opposition_owner: ipAppName, 
            user_id: assignedUid,
            user_email: callerEmail || 'system@evreka.com',
            transaction_date: new Date().toISOString(),
            created_at: new Date().toISOString()
        };
        const { error: txError } = await supabase.from('transactions').insert(txPayload);
        if (txError) throw new Error(`İşlem (Transaction) Kayıt Hatası: ${txError.message}`);

        let parsedNiceClasses = [];
        if (Array.isArray(similarMark.niceClasses)) {
            parsedNiceClasses = similarMark.niceClasses.map(String);
        } else if (typeof similarMark.niceClasses === 'string') {
            parsedNiceClasses = similarMark.niceClasses.split(/[,\s/]+/).filter(Boolean);
        }

        let hitHoldersStr = "-";
        let rawHolders = similarMark.holders || bulletinRecordData?.holders;
        if (rawHolders) {
            if (Array.isArray(rawHolders)) {
                hitHoldersStr = rawHolders.map((h: any) => typeof h === 'object' ? (h.name || h.holderName || h.title) : h).join(', ');
            } else if (typeof rawHolders === 'string') {
                hitHoldersStr = rawHolders;
            }
        }

        // 7. KENDİ DOSYAMIZA (TASK) GÖREVİ EKLE
        const taskPayload = {
            id: taskId,
            task_type: '20',
            status: 'awaiting_client_approval',
            priority: 'medium',
            related_ip_record_id: thirdPartyPortfolioId,
            related_ip_record_title: hitMarkName,
            client_id: clientId,
            transaction_id: transactionId, 
            assigned_to_uid: assignedUid, 
            assigned_to_email: assignedEmail,
            created_by_email: callerEmail || 'system',
            title: `Yayına İtiraz: ${hitMarkName} (Bülten No: ${bulletinNo})`,
            description: `"${ipTitle}" markamız için bültende benzer bulunan "${hitMarkName}" markasına itiraz işi.`,
            iprecord_application_no: similarMark.applicationNo || "-",
            iprecord_title: hitMarkName,
            iprecord_applicant_name: hitHoldersStr,
            due_date: officialDueDate,
            official_due_date: officialDueDate,
            target_app_no: similarMark.applicationNo || null,
            target_nice_classes: parsedNiceClasses,
            bulletin_no: String(bulletinNo),
            similarity_score: similarMark.similarityScore || 0,
            related_party_id: clientId,
            related_party_name: ipAppName,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        const { error: taskErr } = await supabase.from('tasks').insert(taskPayload);
        if (taskErr) throw new Error(`Task kayıt hatası: ${taskErr.message}`);

        // 8. İŞLEMİ (TRANSACTION) TASK ID İLE GÜNCELLE
        await supabase.from('transactions').update({ task_id: taskId }).eq('id', transactionId);

        return new Response(JSON.stringify({ success: true, taskId: taskId, message: "İtiraz işi başarıyla oluşturuldu." }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});

    } catch (error: any) {
        console.error("❌ Edge Function Çöktü:", error.message);
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }
});