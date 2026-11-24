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
        // Ayrı international_monitoring kayıtları da farklı izleme bildirimleridir.
        // WIPO/ARIPO child kaydıyla eşleştirme yapılmıyorsa kaynak izleme ID'si korunur.
        let intlData: any = null;
        if (!monData && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(cleanMonitoredId)) {
            const { data, error: intlError } = await supabase.from('international_monitoring')
                .select('*').eq('id', cleanMonitoredId).maybeSingle();
            if (intlError) throw new Error('Yurtdışı izleme kaydı okunamadı: ' + intlError.message);
            intlData = data;
        }

        // Bağımsız yurtdışı izleme bildirimi varsa IR numarasını gerçek WIPO/ARIPO
        // kaynak dosyasına eşleştir. Bir IR birden çok ülke child'ına bağlı olabilir.
        if (intlData) {
            const intlNo = String(intlData.application_no || '').trim();
            if (!intlNo) throw new Error('Yurtdışı izleme bildiriminde IR/başvuru numarası bulunmuyor.');
            const matchQueries = await Promise.all(['wipo_ir', 'aripo_ir', 'application_number'].map(col =>
                supabase.from('ip_records')
                    .select('id, parent_id, transaction_hierarchy, origin, country_code')
                    .eq('record_owner_type', 'self').eq(col, intlNo).limit(300)
            ));
            const parentMap = new Map<string, any>();
            for (const res of matchQueries) {
                if (res.error) throw new Error('Uluslararası portföy eşleştirmesi yapılamadı: ' + res.error.message);
                for (const row of (res.data || [])) {
                    if (['WIPO', 'ARIPO'].includes(String(row.origin || '').toUpperCase())) parentMap.set(String(row.id), row);
                }
            }
            const parents = [...parentMap.values()].filter(r => r.transaction_hierarchy === 'parent');
            const childMap = new Map<string, any>();
            [...parentMap.values()].filter(r => r.transaction_hierarchy === 'child').forEach(r => childMap.set(String(r.id), r));
            if (parents.length) {
                const { data: linkedChildren, error: linkedError } = await supabase.from('ip_records')
                    .select('id, parent_id, country_code, origin, transaction_hierarchy')
                    .eq('record_owner_type', 'self')
                    .in('parent_id', parents.map(r => String(r.id)))
                    .eq('transaction_hierarchy', 'child').limit(500);
                if (linkedError) throw new Error('Uluslararası child kayıtları okunamadı: ' + linkedError.message);
                for (const child of (linkedChildren || [])) childMap.set(String(child.id), child);
            }
            const countryValues = Array.isArray(intlData.countries) ? intlData.countries : [];
            let wantedCountry = countryValues.length === 1
                ? String(typeof countryValues[0] === 'object'
                    ? (countryValues[0]?.code || countryValues[0]?.country_code || countryValues[0]?.name || '')
                    : countryValues[0]).trim() : '';
            // Ülke adı girildiyse ortak sözlükten ISO ülke kodunu bul.
            if (wantedCountry && wantedCountry.length > 2) {
                const { data: countryMeta } = await supabase.from('common')
                    .select('data').eq('id', 'countries').maybeSingle();
                let catalog: any = countryMeta?.data?.list || countryMeta?.data || [];
                if (typeof catalog === 'string') { try { catalog = JSON.parse(catalog); } catch { catalog = []; } }
                if (!Array.isArray(catalog) && Array.isArray(catalog?.list)) catalog = catalog.list;
                const match = Array.isArray(catalog) ? catalog.find((c: any) =>
                    [c.name, c.tr, c.code].some(value =>
                        String(value || '').toLocaleLowerCase('tr-TR') === wantedCountry.toLocaleLowerCase('tr-TR'))
                ) : null;
                if (match?.code) wantedCountry = String(match.code);
            }
            const matches = [...childMap.values()].filter(c =>
                wantedCountry && String(c.country_code || '').toUpperCase() === wantedCountry.toUpperCase());
            const matched = matches.length === 1 ? matches[0] : null;
            if (!matched) {
                throw new Error('Yurtdışı izleme bildirimi için kaynak WIPO/ARIPO child dosyası tekil belirlenemedi. ' +
                    'İzleme kaydını ilgili ülkeye ve portföy dosyasına eşleştirin. IR: ' + intlNo +
                    ', ülke: ' + (wantedCountry || 'belirsiz'));
            }
            targetIpRecordId = String(matched.id);
        }

        // 🔥 ÇÖZÜM 1: Yeni Şemaya Uygun Okuma (Marka adı ip_record_trademark_details tablosundan çekiliyor)
        const { data: ipData, error: sourceError } = await supabase.from('ip_records').select('*, details:ip_record_trademark_details(brand_name)').eq('id', targetIpRecordId).maybeSingle();

        if (sourceError) throw new Error(sourceError.message);
        if (!ipData) throw new Error('İzlenen markanın kaynak portföy kaydı bulunamadı.');

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
        } else if (intlData) {
            ipTitle = intlData.mark_name || '-';
            ipAppNo = intlData.application_no || '-';
            ipAppName = intlData.applicant_name || '-';
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

        // İzlenen portföy kaydının benzersiz kaynak kimliği, WIPO/ARIPO child ülkelerini ayırır.
        // IR/application_no sadece dosya numarasıdır; child kaydını tek başına temsil etmez.
        const sourceIpRecordId = ipData?.id ? String(ipData.id) : null;
        const intlCountries = Array.isArray(intlData?.countries) ? intlData.countries : [];
        const inferredIntlCountry = intlCountries.length === 1
            ? String(typeof intlCountries[0] === 'object'
                ? (intlCountries[0]?.code || intlCountries[0]?.country_code || '')
                : intlCountries[0]) : null;
        const sourceCountryCode = ipData?.country_code || inferredIntlCountry || null;
        // Tek WIPO/ARIPO child'in kendisi veya bağımsız yurt dışı izleme bildirimi
        // kaynak kimliği olarak kullanılır; başvuru/IR numarası tekilleştirme anahtarı değildir.
        const sourceContextKey = sourceIpRecordId
            ? 'ip:' + sourceIpRecordId
            : intlData ? 'international:' + cleanMonitoredId + ':' + (sourceCountryCode || '-')
            : null;
        const sourceParentIpRecordId = ipData?.parent_id || null;
        const sourceHierarchy = ipData?.transaction_hierarchy || null;
        const sourceOrigin = String(ipData?.origin || '').toUpperCase();
        const sourceIsWipoAripoChild = ['WIPO', 'ARIPO'].includes(sourceOrigin)
            && sourceHierarchy === 'child';

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

            if (bulletinRecordId && monData) {

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

        // b) Aynı rakip kayıt + aynı müvekkil + aynı İZLENEN KAYNAK dosya = mükerrer.
        // WIPO/ARIPO'da farklı ülke child'ları aynı IR no ve aynı rakip başvuru no
        // paylaşabilir; fakat child.ip_records.id birbirinden farklıdır.
        // Bu nedenle kaynak child kimliği farklı ise yeni itirazın önü açılır.
        if (existingIpRecordId || thirdPartyIpRecordId) {
            let dupQuery = supabase
                .from('tasks')
                .select('id, details')
                .eq('task_type_id', '20')
                .eq('ip_record_id', thirdPartyIpRecordId || existingIpRecordId)
                .in('status', ['open', 'awaiting_client_approval', 'in_progress', 'in-progress', 'client_approval_opened']);

            if (finalClientId) {
                dupQuery = dupQuery.eq('task_owner_id', finalClientId);
            } else {
                dupQuery = dupQuery.is('task_owner_id', null);
            }

            // Tek kayda limit koymak başka ülke child'ı kaynaklı mükerrerliği gizler.
            // Aynı rakip/müvekkil için bütün aktif işleri sayfalarla kontrol et.
            let duplicateTaskId: string | null = null;
            for (let from = 0; ; from += 500) {
                const { data: existingTasks, error: dupError } = await dupQuery.order('id').range(from, from + 499);
                if (dupError) throw new Error(`İtiraz mükerrerlik kontrolü yapılamadı: ${dupError.message}`);
                for (const t of existingTasks || []) {
                    const details = typeof t.details === 'string'
                        ? (() => { try { return JSON.parse(t.details); } catch { return {}; } })()
                        : (t.details || {});
                    let differentCountry = false;
                    const previousSource = details?.source_ip_record_id;
                    if (sourceIsWipoAripoChild && sourceParentIpRecordId && sourceCountryCode &&
                        previousSource && previousSource !== sourceIpRecordId) {
                        // Eski işlerde yalnızca source_ip_record_id mevcut olabilir.
                        const { data: previous, error } = await supabase.from('ip_records')
                            .select('parent_id, country_code, transaction_hierarchy, origin')
                            .eq('id', previousSource).maybeSingle();
                        if (error) throw new Error(error.message);
                        differentCountry = previous?.transaction_hierarchy === 'child' &&
                            previous.parent_id === sourceParentIpRecordId &&
                            String(previous.origin || '').toUpperCase() === sourceOrigin &&
                            Boolean(previous.country_code) &&
                            String(previous.country_code).toUpperCase() !== String(sourceCountryCode).toUpperCase();
                    }
                    if (!differentCountry) { duplicateTaskId = String(t.id); break; }
                }
                if (duplicateTaskId) break;
                if (!existingTasks || existingTasks.length < 500) break;
            }
            if (duplicateTaskId) {
                return new Response(JSON.stringify({
                    success: true,
                    taskId: duplicateTaskId,
                    message: 'Aynı müvekkil, rakip marka ve kaynak portföy kaydı için devam eden itiraz zaten mevcut.',
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
                source_ip_record_id: sourceIpRecordId,
                source_context_key: sourceContextKey,
                source_country_code: sourceCountryCode,
                source_parent_ip_record_id: sourceParentIpRecordId,
                source_transaction_hierarchy: sourceHierarchy,
                competitor_ip_record_id: thirdPartyPortfolioId,
                monitored_trademark_id: cleanMonitoredId,
                international_monitoring_id: intlData ? cleanMonitoredId : null,
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
                monitoring_trademark_id: monData?.id || null,
                monitoring_match_id: monitoringMatchId,

                status: 'analysis',
                complexity: 'green',

                selected_grounds: ['SMK_6_1'],

                created_by: isTestEnv ? null : assignedUid,

                facts_snapshot: {
                    created_from: 'monitoring',

                    source_ip_record_id: sourceIpRecordId,
                    source_context_key: sourceContextKey,
                    source_country_code: sourceCountryCode,
                    source_parent_ip_record_id: sourceParentIpRecordId,
                    source_transaction_hierarchy: sourceHierarchy,
                    opposed_ip_record_id: thirdPartyPortfolioId,

                    bulletin_record_id: bulletinRecordId,
                    monitoring_trademark_id: monData?.id || null,
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
