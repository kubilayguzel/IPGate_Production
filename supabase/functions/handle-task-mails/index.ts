import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const payload = await req.json();
    const { type, record, old_record } = payload;

    if (!['INSERT', 'UPDATE'].includes(type) || !record) {
      return new Response("İlgisiz işlem, atlandı.", { status: 200 });
    }

    console.log(`\n[MAIL-DEBUG] ==========================================`);
    console.log(`[MAIL-DEBUG] FUNCTION TRIGGERED. Type: ${type}, Task ID: ${record.id}, Status: ${record.status}`);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    let viewData: any = null;
    const targetIpRecordId = record.ip_record_id || record.details?.relatedIpRecordId || record.details?.ip_record_id || record.related_ip_record_id;

    if (targetIpRecordId) {
        const { data } = await supabaseAdmin.from('portfolio_list_view').select('*').eq('id', targetIpRecordId).single();
        if (data) viewData = data;
    }

    let triggeredByUserId = null;
    const associatedTxId = record.transaction_id || record.details?.transactionId || record.details?.associated_transaction_id;
    
    if (associatedTxId) {
        const { data: txData } = await supabaseAdmin.from('transactions').select('user_id').eq('id', associatedTxId).maybeSingle();
        if (txData && txData.user_id) triggeredByUserId = txData.user_id;
    }
    if (!triggeredByUserId && record.created_by) {
        triggeredByUserId = record.created_by;
    }

    const brandName = viewData?.brand_name || record.details?.iprecordTitle || record.title || "-";
    const appNo = viewData?.application_number || viewData?.registration_number || record.details?.iprecordApplicationNo || record.details?.applicationNo || "-";
    const applicantNames = viewData?.applicant_names || "-";
    const taskTypeId = String(record.task_type_id || '');
    
    let renewalDateText = "-";
    if (viewData?.renewal_date) {
        renewalDateText = new Date(viewData.renewal_date).toLocaleDateString('tr-TR');
    }

    // 🔥 YENİ EKLENEN: Başvuru Tarihi, Sınıflar ve Ülke formatlama (DETAYLI LOGLAMA İLE)
    let applicationDateText = "-";
    if (viewData?.application_date) {
        applicationDateText = new Date(viewData.application_date).toLocaleDateString('tr-TR');
    }

    console.log(`[MAIL-DEBUG-COUNTRY] 1. IP Record Data -> Origin: "${viewData?.origin}", Country Code: "${viewData?.country_code}"`);

    // 1. Sınıfları doğrudan veritabanından çek
    const { data: classesData, error: classesErr } = await supabaseAdmin.from('ip_record_classes').select('class_no').eq('ip_record_id', targetIpRecordId);
    let classNumbersText = "-";
    if (classesData && classesData.length > 0) {
        classNumbersText = classesData.map(c => c.class_no).sort((a: any, b: any) => a - b).join(', ');
    }
    console.log(`[MAIL-DEBUG-COUNTRY] 2. Çekilen Sınıflar: ${classNumbersText}`);

    // 2. Ülke Bilgisi İçin Common Tablosundan Ülkeleri Çek
    const { data: commonData, error: commonErr } = await supabaseAdmin.from('common').select('data').eq('id', 'countries').maybeSingle();
    if (commonErr) console.error(`[MAIL-DEBUG-COUNTRY] ❌ Common tablosu çekme hatası:`, commonErr);
    
    const origin = (viewData?.origin || "").toUpperCase().trim();
    const isWipoOrAripo = ["WIPO", "ARIPO"].some(o => origin.includes(o));
    const isYurtdisi = ["YURTDIŞI", "YURT DIŞI"].some(o => origin.includes(o));
    const showCountry = isWipoOrAripo || isYurtdisi;
    
    console.log(`[MAIL-DEBUG-COUNTRY] 3. Origin Kontrolü -> İşlenmiş Origin: "${origin}", WIPO/ARIPO mu?: ${isWipoOrAripo}, Ülke Gösterilecek mi?: ${showCountry}`);

    let countryInfoHtml = "";
    if (showCountry) {
        let countryCodes: string[] = [];

        if (isWipoOrAripo) {
            // WIPO veya ARIPO ise Child kayıtları bul (parent_id veya wipo_ir/aripo_ir üzerinden)
            console.log(`[MAIL-DEBUG-COUNTRY] 3.1 WIPO/ARIPO Child Ülkeleri Aranıyor. Parent ID: ${targetIpRecordId}`);
            
            let orQuery = `parent_id.eq.${targetIpRecordId}`;
            if (viewData?.wipo_ir) orQuery += `,wipo_ir.eq."${viewData.wipo_ir}"`;
            if (viewData?.aripo_ir) orQuery += `,aripo_ir.eq."${viewData.aripo_ir}"`;

            const { data: childRecords, error: childErr } = await supabaseAdmin
                .from('ip_records')
                .select('country_code')
                .or(orQuery);

            if (childErr) {
                console.error(`[MAIL-DEBUG-COUNTRY] ❌ Child kayıtları çekme hatası:`, childErr);
            } else if (childRecords && childRecords.length > 0) {
                // Null olmayan ülke kodlarını al ve listeye ekle
                countryCodes = childRecords.map(c => c.country_code).filter(Boolean);
                console.log(`[MAIL-DEBUG-COUNTRY] 3.2 Bulunan Child Ülke Kodları:`, countryCodes);
            } else {
                console.log(`[MAIL-DEBUG-COUNTRY] 3.2 DİKKAT: WIPO/ARIPO için child ülke kodu bulunamadı!`);
            }
        } else if (isYurtdisi && viewData?.country_code) {
            // Yurtdışı Ulusal ise direkt kendi kodunu al
            countryCodes = [viewData.country_code];
        }

        // Aynı ülkeden 2 tane yazmasını önlemek için listeyi tekilleştir
        countryCodes = [...new Set(countryCodes)];
        
        console.log(`[MAIL-DEBUG-COUNTRY] 4. Common Data Var mı?:`, !!commonData?.data);
        
        const countryList = commonData?.data?.list || commonData?.data || [];
        const countryNames: string[] = [];

        // Tüm toplanan ülke kodlarını Türkçe isimlerine çevir
        for (const code of countryCodes) {
            let cName = code;
            if (Array.isArray(countryList)) {
                const found = countryList.find((c: any) => c.code === code || c.iso2 === code);
                if (found && (found.tr || found.name)) {
                    cName = found.tr || found.name; 
                }
            }
            countryNames.push(cName.toLocaleUpperCase('tr-TR'));
        }
        
        if (countryNames.length > 0) {
            // Ülkeleri virgülle ayırarak tek bir metin haline getir (Örn: ALMANYA, FRANSA)
            const finalCountryText = countryNames.join(', ');
            countryInfoHtml = `<p style="margin: 0 0 8px 0;"><strong>Ülke:</strong> <span style="color: #333;">${finalCountryText}</span></p>`;
            console.log(`[MAIL-DEBUG-COUNTRY] 5. Üretilen HTML: ${countryInfoHtml}`);
        } else {
            console.log(`[MAIL-DEBUG-COUNTRY] 5. Ülke HTML Üretilmedi. Geçerli ülke kodu bulunamadı.`);
        }
    }

    // 🔥 ÇÖZÜM 2: Mailde gösterilecek İşlem (Evrak) Tarihi
    let transactionDate = new Date().toLocaleDateString('tr-TR'); // Varsayılan: Bugün
    
    // Eğer Task'ın detaylarında arayüzden kaydettiğimiz EPATS evrak tarihi varsa onu kullan
    if (record.details && record.details.epatsDocumentDate) {
        const d = new Date(record.details.epatsDocumentDate);
        if (!isNaN(d.getTime())) {
            transactionDate = d.toLocaleDateString('tr-TR');
        } else {
            // Eğer tarih JS tarafından algılanamazsa doğrudan kullanıcının yazdığı metni bas
            transactionDate = record.details.epatsDocumentDate;
        }
        console.log(`[MAIL-DEBUG] Evrak Tarihi algılandı ve maile eklenecek: ${transactionDate}`);
    }

    const imgUrl = viewData?.brand_image_url || record.details?.brandImageUrl || "";

    // 🔥 ÇÖZÜM: İTİRAZ SAHİBİNİ (OPPONENT) TRANSACTION HİYERARŞİSİNDEN BULMA
    let itirazSahibi = "-";
    
    if (associatedTxId) {
        // 1. Task'a bağlı Transaction'ı bul
        const { data: childTx } = await supabaseAdmin
            .from('transactions')
            .select('parent_id, opposition_owner')
            .eq('id', associatedTxId)
            .maybeSingle();

        if (childTx) {
            if (childTx.opposition_owner) {
                // Eğer bu transaction'ın kendisinde veri varsa al
                itirazSahibi = childTx.opposition_owner;
                console.log(`[MAIL-DEBUG] İtiraz Sahibi bağlı transaction'dan bulundu: ${itirazSahibi}`);
            } else if (childTx.parent_id) {
                // 2. Veri yoksa ve parent'ı varsa, Parent Transaction'a git
                const { data: parentTx } = await supabaseAdmin
                    .from('transactions')
                    .select('opposition_owner')
                    .eq('id', childTx.parent_id)
                    .maybeSingle();

                if (parentTx && parentTx.opposition_owner) {
                    itirazSahibi = parentTx.opposition_owner;
                    console.log(`[MAIL-DEBUG] İtiraz Sahibi Parent Transaction'dan (${childTx.parent_id}) bulundu: ${itirazSahibi}`);
                }
            }
        }
    }

    // Eğer tüm bu hiyerarşide bulunamazsa eski metotlara (fallback) başvur
    if (itirazSahibi === "-") {
        itirazSahibi = record.details?.opponent?.name || record.details?.itiraz_sahibi || "-";
        if (itirazSahibi === "-" && record.task_owner_id) {
            const { data: pData } = await supabaseAdmin.from('persons').select('name').eq('id', record.task_owner_id).maybeSingle();
            if (pData) itirazSahibi = pData.name;
        }
    }

    // 🔥 YENİ: Yurtdışı Yenileme Uyarı Metni (GÜVENLİ KAPSAM)
    let extraWarningHtml = "";
    if (origin !== "TÜRKPATENT" && origin !== "") {
        extraWarningHtml = `<p style="margin-top: 20px; padding: 12px; background-color: #fffbe6; border: 1px solid #ffe58f; border-radius: 5px; color: #856404; font-size: 14px; line-height: 1.5;">
            <strong>Önemli Not:</strong> Yurtdışı yenileme operasyonlarında belirtilen son tarihten 2 ay öncesine kadar talimatın verilmesi sürecin sorunsuz yönetilmesi ve hak kaybı yaşanmaması için önemlidir.
        </p>`;
    }

    const emailParams: Record<string, string> = {
        "{{applicationNo}}": appNo,
        "{{markName}}": brandName,
        "{{is_basligi}}": record.title || "",
        "{{relatedIpRecordTitle}}": brandName,
        "{{applicantNames}}": applicantNames,
        "{{transactionDate}}": transactionDate,
        "{{renewalDate}}": renewalDateText,
        "{{markImageUrl}}": imgUrl,
        "{{itiraz_sahibi}}": itirazSahibi,
        "{{applicationDate}}": applicationDateText,
        "{{classNumbers}}": classNumbersText,
        "{{countryInfo}}": countryInfoHtml,
        "{{extraWarning}}": extraWarningHtml
    };

    console.log(`[MAIL-DEBUG] Oluşturulan E-posta Parametreleri:`, JSON.stringify(emailParams));

    // ALICI BULMA (RECIPIENTS) FONKSİYONU
    async function getRecipients(viewData: any, record: any, currentTaskType: string) {
        const to: string[] = [];
        const cc: string[] = [];
        let personIds: string[] = [];
        
        if (record.task_owner_id) {
            personIds = [record.task_owner_id];
        } else if (record.details?.task_owner_id || record.details?.clientId || record.details?.client_id) {
            personIds = [record.details.task_owner_id || record.details.clientId || record.details.client_id];
        } else if (viewData?.record_owner_type !== 'third_party' && viewData?.applicants_json && viewData.applicants_json.length > 0) {
            personIds = viewData.applicants_json.map((a: any) => a.id).filter(Boolean);
        }
        
        if (personIds && personIds.length > 0) {
            const { data: prData } = await supabaseAdmin.from('persons_related').select('*').in('person_id', personIds).eq('resp_trademark', true);
            if (prData && prData.length > 0) {
                for (const pr of prData) {
                    if (pr.email) {
                        if (pr.notify_trademark_to) to.push(pr.email);
                        if (pr.notify_trademark_cc) cc.push(pr.email);
                        if (!pr.notify_trademark_to && !pr.notify_trademark_cc) to.push(pr.email); 
                    }
                }
            }
        }

        const { data: internalCcs } = await supabaseAdmin.from('evreka_mail_cc_list').select('email, transaction_types');
        if (internalCcs && internalCcs.length > 0) {
            internalCcs.forEach((internal: any) => {
                if (internal.email) {
                    const types = internal.transaction_types || [];
                    if (types.includes('All') || types.includes(currentTaskType) || types.includes(Number(currentTaskType))) {
                        cc.push(internal.email.trim().toLowerCase());
                    }
                }
            });
        }

        const finalTo = [...new Set(to)].filter(Boolean);
        const finalCc = [...new Set(cc)].filter(Boolean).filter(e => !finalTo.includes(e));
        
        console.log(`[MAIL-DEBUG] SONUÇ TO Listesi:`, finalTo);
        console.log(`[MAIL-DEBUG] SONUÇ CC Listesi:`, finalCc);

        return { to: finalTo, cc: finalCc };
    }

    // YENİ GÖREV (INSERT)
    if (type === 'INSERT' && taskTypeId === '22' && record.status === 'awaiting_client_approval') {
        let subject = `${appNo} - "${brandName}" - Marka Yenileme İşlemi / Talimat Bekleniyor`;
        let body = record.description || "Yenileme işlemi için onayınızı rica ederiz.";
        let templateId = null;

        const { data: ruleData } = await supabaseAdmin.from('template_rules').select('template_id').eq('source_type', 'task').eq('task_type', '22').maybeSingle();
        if (ruleData && ruleData.template_id) {
            templateId = ruleData.template_id;
            const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body').eq('id', templateId).maybeSingle();
            if (tmplData) {
                subject = tmplData.mail_subject || tmplData.subject || subject;
                let rawBody = tmplData.body || body;
                for (const [k, v] of Object.entries(emailParams)) {
                    subject = subject.replaceAll(k, String(v));
                    rawBody = rawBody.replaceAll(k, String(v));
                }
                body = rawBody;
            }
        }

        let { to, cc } = await getRecipients(viewData, record, taskTypeId);
        const missingFields = [];
        if (to.length === 0 && cc.length === 0) missingFields.push("recipients");

        await supabaseAdmin.from('mail_notifications').insert({
            id: crypto.randomUUID(),
            associated_task_id: record.id,
            associated_transaction_id: record.transaction_id || record.details?.transactionId || record.details?.associated_transaction_id || null,
            related_ip_record_id: targetIpRecordId,
            client_id: record.task_owner_id || (viewData?.applicants_json?.[0]?.id || null),
            to_list: to,
            cc_list: cc,
            subject: subject,
            body: body,
            status: missingFields.length > 0 ? "missing_info" : "awaiting_client_approval",
            missing_fields: missingFields,
            is_draft: true,
            mode: "draft",
            notification_type: "marka",
            template_id: templateId,
            source: "task_renewal_auto",
            triggered_by_user_id: triggeredByUserId
        });
    }

    // GÜNCELLEME (UPDATE)
    if (type === 'UPDATE' && old_record) {
        const hadMainEpats = !!(old_record.details?.epatsDocument);
        const hasMainEpats = !!(record.details?.epatsDocument);
        
        if (hadMainEpats && !hasMainEpats) {
            await supabaseAdmin.from('mail_notifications').delete().eq('associated_task_id', record.id).in('status', ['draft', 'awaiting_client_approval', 'missing_info', 'pending', 'evaluation_pending']);
        }

        const becameCompleted = old_record.status !== 'completed' && record.status === 'completed';
        const wasAwaiting = ['awaiting_client_approval', 'awaiting-approval'].includes(old_record.status);
        const clientApproved = wasAwaiting && record.status === 'open';
        const clientClosed = wasAwaiting && ['client_approval_closed', 'client_no_response_closed'].includes(record.status);

        if (becameCompleted && !['53', '66'].includes(taskTypeId)) {
            console.log(`[MAIL-DEBUG] Görev Tamamlandı Algılandı! İşlemler Başlıyor...`);
            
            const { data: taskDocs, error: docsErr } = await supabaseAdmin
                .from('task_documents')
                .select('*')
                .eq('task_id', record.id);
                
            console.log(`[MAIL-DEBUG] Göreve (Task: ${record.id}) ait task_documents araması yapıldı. Bulunan evrak sayısı: ${taskDocs ? taskDocs.length : 0}`);
            if (docsErr) console.error(`[MAIL-DEBUG] task_documents çekilirken hata:`, docsErr);

            let primaryDocId = null;
            if (taskDocs && taskDocs.length > 0) {
                const epats = taskDocs.find(d => d.document_type === 'epats_document');
                primaryDocId = epats ? epats.id : taskDocs[0].id;
            }
            
            let templateId = null;
            const { data: ruleData } = await supabaseAdmin.from('template_rules').select('template_id').eq('source_type', 'task_completion_epats').eq('task_type', taskTypeId).maybeSingle();
            if (ruleData) templateId = ruleData.template_id;

            let subject = "İşleminiz Tamamlandı";
            let body = "İlgili görev tamamlanmıştır.";
            let hasTemplate = false;

            if (templateId) {
                // Artık body1, body2 çekmiyoruz, sadece ana body (iskelet) çekiliyor
                const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body').eq('id', templateId).maybeSingle();
                
                if (tmplData) {
                    hasTemplate = true;
                    subject = tmplData.mail_subject || tmplData.subject || subject;
                    const recordOwnerType = viewData?.record_owner_type || 'self';
                    let rawBody = tmplData.body || body;

                    // 1. ANA İŞLEM (PARENT TASK) TESPİTİ
                    let parentTaskTypeId = null;
                    if (associatedTxId) {
                        const { data: currentTx } = await supabaseAdmin.from('transactions').select('parent_id').eq('id', associatedTxId).maybeSingle();
                        if (currentTx?.parent_id) {
                            const { data: parentTx } = await supabaseAdmin.from('transactions').select('transaction_type_id').eq('id', currentTx.parent_id).maybeSingle();
                            if (parentTx) parentTaskTypeId = String(parentTx.transaction_type_id);
                        }
                    }
                    if (!parentTaskTypeId && record.details?.parent_task_id) {
                        const { data: parentTask } = await supabaseAdmin.from('tasks').select('task_type_id').eq('id', String(record.details.parent_task_id)).maybeSingle();
                        if (parentTask) parentTaskTypeId = String(parentTask.task_type_id);
                    }

                    // 2. AKTİF ŞARTLARI (KOŞULLARI) BELİRLE
                    // Markanın aidiyetine göre şart (Örn: owner_self, owner_third_party)
                    const activeConditions = [`owner_${recordOwnerType}`]; 
                    // Ana işleme göre şart (Örn: parent_6, parent_20)
                    if (parentTaskTypeId) activeConditions.push(`parent_${parentTaskTypeId}`); 

                    // 3. VARYANT (SEÇENEK) TABLOSUNDA BU ŞARTLARI ARA
                    const { data: variants } = await supabaseAdmin
                        .from('mail_template_variants')
                        .select('condition_key, body')
                        .eq('template_id', templateId)
                        .in('condition_key', activeConditions);

                    if (variants && variants.length > 0) {
                        // Öncelik: Eğer ana işleme (parent) özel bir metin yazılmışsa onu al, yoksa marka aidiyetine (owner) özel metni al
                        const parentVariant = variants.find((v: any) => v.condition_key === `parent_${parentTaskTypeId}`);
                        const ownerVariant = variants.find((v: any) => v.condition_key === `owner_${recordOwnerType}`);

                        if (parentVariant) {
                            rawBody = parentVariant.body;
                        } else if (ownerVariant) {
                            rawBody = ownerVariant.body;
                        }
                    }

                    body = rawBody; // Seçilen özel metni veya hiçbir şey bulunamazsa ana şablon metnini ata

                    // 4. DEĞİŞKENLERİ ({{...}}) METNİN İÇİNE GÖM
                    for (const [k, v] of Object.entries(emailParams)) {
                        subject = subject.replaceAll(k, String(v));
                        body = body.replaceAll(k, String(v));
                    }
                }
            }

            let { to, cc } = await getRecipients(viewData, record, taskTypeId);
            const missingFields = [];
            if (to.length === 0) missingFields.push("to_list"); 
            if (!hasTemplate) missingFields.push("template");

            const notificationId = crypto.randomUUID();

            console.log(`[MAIL-DEBUG] Bildirim (mail_notifications) oluşturuluyor... Notification ID: ${notificationId}`);
            const { error: insErr } = await supabaseAdmin.from('mail_notifications').insert({
                id: notificationId,
                
                // 🔥 ÇÖZÜM: Arayüzün "Müvekkil" sütununda kimi göstereceğini bulması için Akıllı Zırh!
                // Önce Task Sahibine bakar, yoksa detaylardaki İtiraz Sahibine bakar, o da yoksa Marka Sahibine bakar.
                client_id: record.task_owner_id || record.details?.task_owner_id || record.details?.clientId || record.details?.client_id || (viewData?.applicants_json?.[0]?.id || null),
                
                associated_task_id: record.id,
                associated_transaction_id: record.transaction_id || record.details?.transactionId || record.details?.associated_transaction_id || null,
                related_ip_record_id: targetIpRecordId,
                
                source_document_id: primaryDocId,

                to_list: to,
                cc_list: cc,
                subject: subject,
                body: body,
                status: missingFields.length > 0 ? "missing_info" : "pending",
                missing_fields: missingFields,
                is_draft: false,
                mode: "draft",
                notification_type: "marka",
                template_id: templateId,
                source: "task_completion",
                triggered_by_user_id: triggeredByUserId
            });

            if (insErr) {
                console.error(`[MAIL-DEBUG] KRİTİK HATA: mail_notifications eklenemedi!`, insErr);
            } else {
                if (taskDocs && taskDocs.length > 0) {
                    console.log(`[MAIL-DEBUG] Bildirime ait ${taskDocs.length} adet evrak 'mail_attachments' tablosuna KOPYALANIYOR...`);
                    
                    const attachmentsToInsert = taskDocs.map(doc => ({
                        id: crypto.randomUUID(),
                        notification_id: notificationId,
                        file_name: doc.document_name,
                        url: doc.document_url,
                        storage_path: doc.document_url 
                    }));

                    const { error: attErr } = await supabaseAdmin.from('mail_attachments').insert(attachmentsToInsert);
                    
                    if (attErr) {
                        console.error(`[MAIL-DEBUG] HATA: mail_attachments tablosuna eklenemedi!`, attErr);
                    } else {
                        console.log(`[MAIL-DEBUG] BAŞARILI: Evraklar mail_attachments tablosuna resmen bağlandı!`);
                    }
                } else {
                    console.log(`[MAIL-DEBUG] Kopyalanacak evrak bulunamadı.`);
                }
            }
        }

        if (clientApproved) {
            try {
                const { data: counterData } = await supabaseAdmin.from('counters').select('last_id').eq('id', 'tasks_accruals').single();
                let currentCount = counterData ? Number(counterData.last_id) : 0;
                currentCount++;
                const newAccrualId = `T-${currentCount}`;
                const { data: assignData } = await supabaseAdmin.from('task_assignments').select('assignee_ids').eq('id', '53').single();
                const assignedUid = assignData?.assignee_ids?.[0] || null;

                await supabaseAdmin.from('tasks').insert({
                    id: newAccrualId,
                    task_type_id: "53",
                    title: `Tahakkuk Oluşturma: ${record.title || ''}`,
                    description: `"${record.title || ''}" işi onaylandı. Lütfen finansal kaydı oluşturun.`,
                    priority: 'high',
                    status: 'pending',
                    assigned_to: assignedUid,
                    task_owner_id: record.task_owner_id,
                    ip_record_id: targetIpRecordId,
                    details: { 
                        parent_task_id: record.id, 
                        originalTaskType: taskTypeId,
                        iprecordApplicationNo: appNo,
                        iprecordTitle: brandName,
                        iprecordApplicantName: applicantNames
                    }
                });
                await supabaseAdmin.from('counters').upsert({ id: 'tasks_accruals', last_id: currentCount });
            } catch (accErr) { console.error("Tahakkuk görev hatası:", accErr); }

            const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body').eq('id', 'tmpl_clientInstruction_1').maybeSingle();
            let subject = tmplData?.mail_subject || tmplData?.subject || "{{relatedIpRecordTitle}} - Talimatınız Alındı";
            let body = tmplData?.body || "<p>Talimatınız alınmıştır, işlem başlatılıyor.</p>";

            for (const [k, v] of Object.entries(emailParams)) {
                subject = subject.replaceAll(k, String(v));
                body = body.replaceAll(k, String(v));
            }

            let { to, cc } = await getRecipients(viewData, record, taskTypeId);
            await supabaseAdmin.from('mail_notifications').insert({
                id: crypto.randomUUID(),
                associated_task_id: record.id,
                related_ip_record_id: targetIpRecordId,
                to_list: to,
                cc_list: cc,
                subject: subject,
                body: body,
                status: "pending",
                notification_type: "general_notification",
                source: "auto_instruction_response",
                is_draft: false,
                triggered_by_user_id: triggeredByUserId
            });
        }

        // 🔥 YENİ KORUMA: Yayına İtiraz (Type 20) görevleri kapatıldığında "Dosya Kapatıldı" maili ATMA!
        if (clientClosed && taskTypeId !== '20') {
            const { data: tmplData } = await supabaseAdmin.from('mail_templates').select('subject, mail_subject, body').eq('id', 'tmpl_clientInstruction_2').maybeSingle();
            let subject = tmplData?.mail_subject || tmplData?.subject || "{{relatedIpRecordTitle}} - Dosya Kapatıldı";
            let body = tmplData?.body || "<p>Talimatınız üzerine dosya kapatılmıştır.</p>";

            for (const [k, v] of Object.entries(emailParams)) {
                subject = subject.replaceAll(k, String(v));
                body = body.replaceAll(k, String(v));
            }

            let { to, cc } = await getRecipients(viewData, record, taskTypeId);
            await supabaseAdmin.from('mail_notifications').insert({
                id: crypto.randomUUID(),
                associated_task_id: record.id,
                related_ip_record_id: targetIpRecordId,
                to_list: to,
                cc_list: cc,
                subject: subject,
                body: body,
                status: "pending",
                notification_type: "general_notification",
                source: "auto_instruction_response",
                is_draft: false,
                triggered_by_user_id: triggeredByUserId
            });
        }
    }
    
    console.log(`[MAIL-DEBUG] ================== İŞLEM BİTTİ ==================\n`);
    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error: any) {
    console.error(`[MAIL-DEBUG] KRİTİK HATA:`, error);
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
  }
});