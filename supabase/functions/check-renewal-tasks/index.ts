import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TURKEY_HOLIDAYS = [
    "2025-01-01", "2025-03-30", "2025-03-31", "2025-04-01", "2025-04-23", "2025-05-01", "2025-05-19", "2025-06-06", "2025-06-07", "2025-06-08", "2025-06-09", "2025-07-15", "2025-08-30", "2025-10-29",
    "2026-01-01", "2026-03-19", "2026-03-20", "2026-03-21", "2026-03-22", "2026-04-23", "2026-05-01", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30", "2026-07-15", "2026-08-30", "2026-10-29"
];

function isWeekend(date: Date) {
    const day = date.getDay();
    return day === 0 || day === 6;
}

function isHoliday(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return TURKEY_HOLIDAYS.includes(`${year}-${month}-${day}`);
}

function findNextWorkingDay(startDate: Date) {
    let currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0);
    while (isWeekend(currentDate) || isHoliday(currentDate)) {
        currentDate.setDate(currentDate.getDate() + 1);
    }
    return currentDate;
}

function findPreviousWorkingDay(startDate: Date) {
    let currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0);
    while (isWeekend(currentDate) || isHoliday(currentDate)) {
        currentDate.setDate(currentDate.getDate() - 1);
    }
    return currentDate;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error("Yetki reddedildi.")

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    console.log('🔄 [Yenileme Otomasyonu] Manuel tetikleme başlatıldı.');

    let assignedTo_uid = null;
    let assignedTo_email = "sistem@evrekapatent.com";
    let assignedTo_name = "Sistem Otomasyonu";

    const { data: assignmentData } = await supabaseAdmin.from('task_assignments').select('*').eq('id', '22').maybeSingle();
    
    if (assignmentData && assignmentData.assignee_ids && assignmentData.assignee_ids.length > 0) {
        assignedTo_uid = assignmentData.assignee_ids[0];
        const { data: userData } = await supabaseAdmin.from('users').select('*').eq('id', assignedTo_uid).maybeSingle();
        if (userData) {
            assignedTo_email = userData.email || assignedTo_email;
            assignedTo_name = userData.display_name || assignedTo_email;
        }
    }

    // AÇIK İŞLERİ ÇEK
    const { data: openTasks } = await supabaseAdmin.from('tasks')
        .select('ip_record_id')
        .eq('task_type_id', '22')
        .neq('status', 'completed');

    const openRecordIds = (openTasks || []).map(t => t.ip_record_id).filter(Boolean);
    const activeAppOriginKeys = new Set();
    const activeRecordIds = new Set(openRecordIds);

    if (openRecordIds.length > 0) {
        const { data: activeIpData } = await supabaseAdmin.from('ip_records')
            .select('application_number, origin')
            .in('id', openRecordIds);
        
        for (const rec of (activeIpData || [])) {
            if (rec.application_number && rec.origin) {
                const key = `${String(rec.application_number).trim()}_${String(rec.origin).trim()}`;
                activeAppOriginKeys.add(key);
            }
        }
    }

    // TÜM MARKALARI ÇEK
    const { data: ipRecords, error: ipError } = await supabaseAdmin.from('ip_records')
        .select(`
            id, 
            status, 
            origin, 
            wipo_ir, 
            application_number, 
            application_date, 
            renewal_date, 
            transaction_hierarchy,
            ip_record_trademark_details(brand_name),
            ip_record_applicants(person_id, persons(name))
        `)
        .not('status', 'in', '("geçersiz", "rejected", "expired", "invalidated", "reddedildi")');

    if (ipError) throw new Error("Markalar çekilemedi: " + ipError.message);

    // 🔥 SAYAÇ (COUNTER) OKUMA 🔥
    const { data: counterData } = await supabaseAdmin.from('counters').select('last_id').eq('id', 'tasks').maybeSingle();
    let currentLastId = counterData ? Number(counterData.last_id || 0) : 0;

    const today = new Date();
    const sixMonthsAgo = new Date(today); sixMonthsAgo.setMonth(today.getMonth() - 6);
    const sixMonthsLater = new Date(today); sixMonthsLater.setMonth(today.getMonth() + 6);

    const tasksToInsert: any[] = [];
    const transactionsToInsert: any[] = [];
    const skippedRecords: any[] = [];

    for (const record of (ipRecords || [])) {
        let title = "-";
        if (record.ip_record_trademark_details && record.ip_record_trademark_details.length > 0) {
            title = record.ip_record_trademark_details[0].brand_name || "-";
        }

        if ((record.wipo_ir || record.origin === 'WIPO' || record.origin === 'ARIPO') && record.transaction_hierarchy !== 'parent') {
            continue;
        }

        const appNo = String(record.application_number || "").trim();
        const origin = String(record.origin || "").trim();
        const appOriginKey = `${appNo}_${origin}`;

        if (activeRecordIds.has(record.id) || (appNo && origin && activeAppOriginKeys.has(appOriginKey))) {
            skippedRecords.push({ appNo: record.application_number, title: title, origin: origin });
            continue;
        }

        let renewalDate = record.renewal_date ? new Date(record.renewal_date) : null;
        if (!renewalDate && record.application_date) {
            renewalDate = new Date(record.application_date);
            renewalDate.setFullYear(renewalDate.getFullYear() + 10);
        }

        if (!renewalDate || isNaN(renewalDate.getTime())) continue;
        if (renewalDate < sixMonthsAgo || renewalDate > sixMonthsLater) continue;

        let appName = "-";
        let applicantIds: string[] = [];
        if (record.ip_record_applicants && record.ip_record_applicants.length > 0) {
            const p = record.ip_record_applicants[0].persons;
            appName = p?.name || "-";
            applicantIds = record.ip_record_applicants.map((a: any) => a.person_id).filter(Boolean);
        }

        const officialDate = findNextWorkingDay(renewalDate);
        let operationalDate = new Date(officialDate);
        operationalDate.setDate(operationalDate.getDate() - 3);
        operationalDate = findPreviousWorkingDay(operationalDate);

        // 🔥 YENİ: SAYAÇTAN SIRALI GÖREV ID'Sİ ÜRETME 🔥
        currentLastId++;
        const taskId = String(currentLastId);
        
        const txId = crypto.randomUUID(); // Transaction id'si standart uuid kalsın
        const nowIso = new Date().toISOString();

        tasksToInsert.push({
            id: taskId,
            task_type_id: "22",
            status: "awaiting_client_approval",
            priority: "medium",
            title: `${title} Marka Yenileme`,
            description: `${title} adlı markanın yenileme süreci için müvekkil onayı bekleniyor. Yenileme tarihi: ${renewalDate.toLocaleDateString('tr-TR')}.`,
            ip_record_id: record.id,
            details: {
                iprecordApplicationNo: record.application_number || "-",
                iprecordTitle: title,
                iprecordApplicantName: appName
            },
            task_owner_id: applicantIds.length > 0 ? applicantIds[0] : null,
            operational_due_date: operationalDate.toISOString(),
            official_due_date: officialDate.toISOString(),
            assigned_to: assignedTo_uid,
            created_at: nowIso,
            updated_at: nowIso
        });

        transactionsToInsert.push({
            id: txId,
            ip_record_id: record.id,
            transaction_type_id: "22",
            transaction_hierarchy: "parent",
            description: "Yenileme işlemi.",
            transaction_date: nowIso,
            user_id: assignedTo_uid,
            user_email: assignedTo_email,
            user_name: assignedTo_name,
            task_id: taskId,
            created_at: nowIso
        });
        
        if (appNo && origin) activeAppOriginKeys.add(appOriginKey);
    }

    if (tasksToInsert.length === 0) {
        return new Response(JSON.stringify({ 
            success: true, count: 0, processed: ipRecords?.length, skipped: skippedRecords 
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // GÖREVLERİ KAYDET VE SAYACI GÜNCELLE
    const { error: taskError } = await supabaseAdmin.from('tasks').insert(tasksToInsert);
    if (taskError) throw new Error("Görevler kaydedilemedi: " + taskError.message);

    // Sayacı Yeni Değerle Güncelle
    await supabaseAdmin.from('counters').upsert({ id: 'tasks', last_id: currentLastId });

    const { error: txError } = await supabaseAdmin.from('transactions').insert(transactionsToInsert);
    if (txError) throw new Error("İşlemler (Transactions) kaydedilemedi: " + txError.message);

    return new Response(JSON.stringify({
        success: true,
        count: tasksToInsert.length,
        processed: ipRecords?.length,
        skipped: skippedRecords
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error: any) {
    console.error("❌ [Yenileme Otomasyonu] Hata:", error.message)
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})