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
        // 🔥 YENİ: Frontend'den gelen 'clientId' parametresini (bodyClientId olarak) alıyoruz
        const { monitoredMarkId, thirdPartyIpRecordId, similarMark, similarMarkName, bulletinNo, callerEmail, bulletinRecordData, clientId: bodyClientId } = body;
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
        const { data: bulletinData } = await supabase
            .from('trademark_bulletins')
            .select('id, bulletin_date')
            .eq('bulletin_no', String(bulletinNo).trim())
            .maybeSingle();
        if (bulletinData && bulletinData.bulletin_date) {
            const bDate = new Date(bulletinData.bulletin_date);
            if (!isNaN(bDate.getTime())) {
                bDate.setMonth(bDate.getMonth() + 2);
                let iter = 0;
                while (isWeekend(bDate) && iter < 10) { bDate.setDate(bDate.getDate() + 1); iter++; }
                officialDueDate = bDate.toISOString();
            }
        }

        // 🔥 NİHAİ MÜVEKKİL (CLIENT) ID BELİRLEME
        let finalClientId = bodyClientId || clientId;
        if (String(finalClientId).startsWith('owner_')) finalClientId = null;

        const hitMarkName = similarMarkName || similarMark.markName || 'Bilinmeyen Marka';

        // 🔥 ÇÖZÜM 2: BAŞVURU NUMARASI, STATÜ VE MÜVEKKİL İLE KESİN MÜKERRERLİK KONTROLÜ
        const opponentAppNo = similarMark.applicationNo;

        let existingIpRecordId = null;
        let bulletinRecordId: string | null = null;
        let monitoringMatchId: string | null = null;

        // ---------------------------------------------------------
        // YAYINA İTİRAZ DOSYASI İÇİN KAYNAK KAYITLARI KESİNLEŞTİR
        // ---------------------------------------------------------

        if (opponentAppNo && opponentAppNo !== "-") {

            let bulletinRecordQuery = supabase
                .from('trademark_bulletin_records')
                .select('id')
                .eq('application_number', opponentAppNo);

            if (bulletinData?.id) {
                bulletinRecordQuery = bulletinRecordQuery
                    .eq('bulletin_id', String(bulletinData.id));
            }

            const {
                data: bulletinRecord,
                error: bulletinRecordError
            } = await bulletinRecordQuery
                .limit(1)
                .maybeSingle();

            if (bulletinRecordError) {
                console.warn(
                    '⚠️ Bulletin record tespit edilemedi:',
                    bulletinRecordError.message
                );
            }

            bulletinRecordId = bulletinRecord?.id || null;

            if (bulletinRecordId) {

                const {
                    data: monitoringMatch,
                    error: monitoringMatchError
                } = await supabase
                    .from('monitoring_trademark_records')
                    .select('id')
                    .eq('monitored_trademark_id', cleanMonitoredId)
                    .eq('bulletin_record_id', bulletinRecordId)
                    .limit(1)
                    .maybeSingle();

                if (monitoringMatchError) {
                    console.warn(
                        '⚠️ Monitoring match tespit edilemedi:',
                        monitoringMatchError.message
                    );
                }

                monitoringMatchId = monitoringMatch?.id || null;
            }
        }

        // a) Önce rakibin "Başvuru Numarasına" sahip bir rakip (third_party) kayıt var mı buluyoruz
        if (opponentAppNo && opponentAppNo !== "-") {
            const { data: existingIp } = await supabase
                .from('ip_records')
                .select('id')
                .eq('application_number', opponentAppNo)
                .eq('record_owner_type', 'third_party')
                .limit(1)
                .maybeSingle();

            if (existingIp) existingIpRecordId = existingIp.id;
        }

        // b) Eğer bu başvuru numarasıyla kayıt varsa, O KAYDA, BU MÜVEKKİLE ve AKTİF STATÜDE iş açılmış mı bakıyoruz!
        if (existingIpRecordId) {
            let dupQuery = supabase
                .from('tasks')
                .select('id')
                .eq('task_type_id', '20')
                .eq('ip_record_id', existingIpRecordId)
                .in('status', ['open', 'awaiting_client_approval', 'in_progress']) // 🔥 Statü kontrolü korundu!
                .limit(1);

            // Müvekkil (Client) Eşleşmesi Kontrolü
            if (finalClientId) {
                dupQuery = dupQuery.eq('task_owner_id', finalClientId);
            } else {
                dupQuery = dupQuery.is('task_owner_id', null);
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
     
        // 5. ÜÇÜNCÜ TARAF (THIRD PARTY) PORTFÖY KAYDINI OLUŞTUR VEYA MEVCUDU KULLAN
        // 🔥 KRİTİK: Aynı başvuru numaralı rakip varsa, yeni UUID üretmek yerine onu kullanıyoruz.
        const thirdPartyPortfolioId = thirdPartyIpRecordId || existingIpRecordId || crypto.randomUUID();
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
            task_owner_id: finalClientId, // 🔥 YENİ: Göreve doğru müvekkil ID'si atandı
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
                source_ip_record_id: targetIpRecordId,
                competitor_ip_record_id: thirdPartyPortfolioId,
                monitored_trademark_id: cleanMonitoredId,
                bulletin_record_id: bulletinRecordId,
                monitoring_match_id: monitoringMatchId,
                target_app_no: opponentAppNo,
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

        // =========================================================
        // 9. OPPOSITION CASE OLUŞTUR
        // =========================================================

        const {
            data: oppositionCase,
            error: oppositionCaseError
        } = await supabase
            .from('opposition_cases')
            .upsert({
                task_id: taskId,
                transaction_id: transactionId,
                client_id: finalClientId,
                opposed_ip_record_id: thirdPartyPortfolioId,

                bulletin_record_id: bulletinRecordId,
                monitoring_trademark_id: cleanMonitoredId,
                monitoring_match_id: monitoringMatchId,

                status: 'analysis',
                complexity: 'green',

                selected_grounds: ['SMK_6_1'],

                created_by: isTestEnv ? null : assignedUid,

                facts_snapshot: {
                    created_from: 'monitoring',

                    source_ip_record_id: targetIpRecordId,
                    opposed_ip_record_id: thirdPartyPortfolioId,

                    bulletin_record_id: bulletinRecordId,
                    monitoring_trademark_id: cleanMonitoredId,
                    monitoring_match_id: monitoringMatchId,

                    opponent_application_no: opponentAppNo,
                    opponent_mark: hitMarkName,

                    bulletin_no: String(bulletinNo),

                    created_at: new Date().toISOString()
                }
            }, {
                onConflict: 'task_id'
            })
            .select('id')
            .single();

        if (oppositionCaseError) {
            throw new Error(
                `Opposition Case oluşturulamadı: ${oppositionCaseError.message}`
            );
        }


        // =========================================================
        // 10. İLK MÜSTENİT MARKAYI DOSYAYA EKLE
        // =========================================================

        const {
            error: priorMarkError
        } = await supabase
            .from('opposition_case_prior_marks')
            .upsert({
                opposition_case_id: oppositionCase.id,
                ip_record_id: targetIpRecordId,
                is_selected: true,
                selection_order: 0,
                proof_of_use_status: 'unknown'
            }, {
                onConflict: 'opposition_case_id,ip_record_id'
            });

        if (priorMarkError) {
            throw new Error(
                `Müstenit marka Opposition Case'e eklenemedi: ${priorMarkError.message}`
            );
        }

        return new Response(JSON.stringify({
            success: true,
            taskId: taskId,
            oppositionCaseId: oppositionCase.id,
            message: "İtiraz işi ve Opposition Case başarıyla oluşturuldu."
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});

    } catch (error: any) {
        console.error("❌ Edge Function Hatası:", error.message);
        // 🔥 HTTP 200 Dönüyoruz ki arayüz (frontend) hatayı gizlemesin, ekrana açıkça neyin patladığını yazsın!
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }
});