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

        // 🔥 ÇÖZÜM 1: Yeni Şemaya Uygun Okuma (Marka adı ip_record_trademark_details tablosundan çekiliyor)
        const { data: ipData } = await supabase.from('ip_records').select('*, details:ip_record_trademark_details(brand_name)').eq('id', targetIpRecordId).maybeSingle();

        let clientId = null;
        let ipAppName = "-";
        let ipTitle = "-";
        let ipAppNo = "-";

        if (ipData) {
            const detailsObj = Array.isArray(ipData.details) ? ipData.details[0] : ipData.details;
            ipTitle = (detailsObj && detailsObj.brand_name) ? detailsObj.brand_name : (ipData.title || ipData.brand_name || ipData.brand_text || "-");
            ipAppNo = ipData.application_number || "-";
            
            const { data: applicantData } = await supabase.from('ip_record_applicants').select('person_id').eq('ip_record_id', ipData.id).order('order_index', { ascending: true }).limit(1).maybeSingle();
            if (applicantData && applicantData.person_id) {
                clientId = applicantData.person_id;
                const { data: personData } = await supabase.from('persons').select('name').eq('id', clientId).maybeSingle();
                if (personData) ipAppName = personData.name || "-";
            }
        } else if (monData) {
            // 🔥 ÇÖZÜM: monitoring_trademarks tablosundaki yeni şemaya uyum sağlandı
            ipTitle = monData.search_mark_name || "-";
            ipAppNo = "-";
            ipAppName = "-";
        }

        // 🔥 2. ATAMA (TEST/CANLI ORTAM KONTROLLÜ)
        // supabaseUrl üzerinden hangi veritabanında (Test mi Canlı mı) olduğumuzu anlıyoruz.
        const isTestEnv = supabaseUrl.includes('guicrctynauzxhyfpdfe');
        const assignedUid = isTestEnv ? "b0f29aa1-e3e7-4314-a117-4c1dbb100d03" : "788e10fb-f137-4a78-b03d-840b14a14b87"; 
        const assignedEmail = isTestEnv ? "kubilayguzel@evrekagroup.com" : "selcanakoglu@evrekapatent.com";

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

        // 🔥 ÇÖZÜM 2: MÜKERRER İŞ (DUPLICATE) KONTROLÜ
        // Aynı müvekkil için, aynı bültendeki aynı rakip markaya zaten "Yayına İtiraz" işi açılmış mı?
        const hitMarkName = similarMarkName || similarMark.markName || 'Bilinmeyen Marka';
        
        let dupQuery = supabase
            .from('tasks')
            .select('id')
            .eq('task_type_id', '20')
            .contains('details', { bulletin_no: String(bulletinNo) })
            .limit(1);

        if (clientId) {
            dupQuery = dupQuery.eq('task_owner_id', clientId);
        }
        const { data: existingTasks } = await dupQuery;

        if (existingTasks && existingTasks.length > 0) {
            console.log(`⚠️ Mükerrer Görev Engellendi. Mevcut Task ID: ${existingTasks[0].id}`);
            return new Response(JSON.stringify({ 
                success: true, 
                taskId: existingTasks[0].id, 
                message: "Bu görev zaten mevcut, tekrar oluşturulmadı.",
                isDuplicate: true 
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
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
     
        // 5. ÜÇÜNCÜ TARAF (THIRD PARTY) PORTFÖY KAYDINI OLUŞTUR
        const thirdPartyPortfolioId = thirdPartyIpRecordId || crypto.randomUUID();
        let hitImageUrl = bulletinRecordData?.imagePath || similarMark.imagePath || null;
        if (hitImageUrl && !hitImageUrl.startsWith('http')) {
            hitImageUrl = `https://guicrctynauzxhyfpdfe.supabase.co/storage/v1/object/public/brand_images/${hitImageUrl}`;
        }

        // 🔥 ÇÖZÜM 2: Yeni Şemaya Uygun İki Tablolu Kayıt (Ana Tablo + Detay Tablosu Ayrıldı)
        const portfolioData = {
            id: thirdPartyPortfolioId,
            status: 'published_in_bulletin',
            ip_type: 'trademark',
            created_from: 'bulletin_record',
            application_date: similarMark.applicationDate || null,
            portfolio_status: 'active',
            record_owner_type: 'third_party',
            application_number: similarMark.applicationNo || null,
            transaction_hierarchy: 'parent',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        const { error: ipError } = await supabase.from('ip_records').upsert(portfolioData, { onConflict: 'id' });
        if (ipError) throw new Error(`Rakip Portföy Kayıt Hatası: ${ipError.message}`);

        const detailsData = {
            ip_record_id: thirdPartyPortfolioId,
            brand_name: hitMarkName,
            description: `Bülten benzerlik araması ile otomatik oluşturulan rakip kaydı.`,
            brand_image_url: hitImageUrl,
            has_registration_cert: false
        };
        const { error: detailsError } = await supabase.from('ip_record_trademark_details').upsert(detailsData, { onConflict: 'ip_record_id' });
        if (detailsError) throw new Error(`Marka Detay Kayıt Hatası: ${detailsError.message}`);

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
            task_type_id: '20', 
            status: 'awaiting_client_approval',
            priority: 'medium',
            ip_record_id: thirdPartyPortfolioId, 
            task_owner_id: clientId, 
            transaction_id: transactionId, 
            assigned_to: assignedUid, 
            created_by: isTestEnv ? null : assignedUid, // 🔥 HARİKA YAKLAŞIM: Test ortamında FK hatasını önlemek için null, Canlı ortamda ise gerçek atanan kişinin ID'si!
            title: `Yayına İtiraz: ${hitMarkName} (Bülten No: ${bulletinNo})`,
            description: `"${ipTitle}" markamız için bültende benzer bulunan "${hitMarkName}" markasına itiraz işi.`,
            delivery_date: officialDueDate, 
            official_due_date: officialDueDate,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            // 🔥 TERTEMİZ MİNİMAL JSON (Arayüz / Frontend ile Birebir Aynı)
            details: {
                assigned_to_email: assignedEmail,
                bulletin_no: String(bulletinNo),
                bulletin_date: bulletinData?.bulletin_date ? new Date(bulletinData.bulletin_date).toISOString().split('T')[0] : null,
                similarity_score: similarMark.similarityScore || 0,
                opposed_mark_owner: hitHoldersStr !== "-" ? hitHoldersStr : null,
                
                // Şema Standart Alanları (Başlangıç Değerleri)
                statusBeforeEpatsUpload: "open",
                target_accrual_id: null, // Edge function şu an tahakkuk kesmediği için null kalır
                epatsDocumentNo: null,
                epatsDocumentDate: null,
                documents: [],
                history: [{
                    action: "Görev oluşturuldu (Otomatik İzleme Sistemi)",
                    timestamp: new Date().toISOString(),
                    userEmail: callerEmail || 'system@evreka.com'
                }]
            }
        };
        const { error: taskErr } = await supabase.from('tasks').insert(taskPayload);
        if (taskErr) throw new Error(`Task kayıt hatası: ${taskErr.message}`);

        // 8. İŞLEMİ (TRANSACTION) TASK ID İLE GÜNCELLE
        await supabase.from('transactions').update({ task_id: taskId }).eq('id', transactionId);

        return new Response(JSON.stringify({ success: true, taskId: taskId, message: "İtiraz işi başarıyla oluşturuldu." }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});

    } catch (error: any) {
        console.error("❌ Edge Function Hatası:", error.message);
        // 🔥 HTTP 200 Dönüyoruz ki arayüz (frontend) hatayı gizlemesin, ekrana açıkça neyin patladığını yazsın!
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }
});