import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_GROUNDS = new Set([
  "SMK_6_1",
  "SMK_6_3",
  "SMK_6_4",
  "SMK_6_5",
  "SMK_6_6",
  "SMK_6_9",
]);

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseJsonObject(value: unknown): Record<string, any> {
  if (!value) return {};

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);

      return parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  return {};
}

function chunkArray<T>(items: T[], size = 150): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

function normalizeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
}


/**
 * İlk kullanım ispatı ön kontrolü.
 *
 * Buradaki sonuç nihai hukuki kanaat değildir.
 * Rakip başvuru tarihinde önceki markanın tescilinin
 * üzerinden beş yıl geçip geçmediğini kontrol eder.
 */
function calculateProofOfUseCheck(
  registrationDate?: string | null,
  opponentApplicationDate?: string | null,
) {
  if (!registrationDate || !opponentApplicationDate) {
    return null;
  }

  const reg = new Date(`${registrationDate}T00:00:00Z`);
  const opposed = new Date(
    `${opponentApplicationDate}T00:00:00Z`,
  );

  if (
    Number.isNaN(reg.getTime()) ||
    Number.isNaN(opposed.getTime())
  ) {
    return null;
  }

  const fiveYearDate = new Date(reg);

  fiveYearDate.setUTCFullYear(
    fiveYearDate.getUTCFullYear() + 5,
  );

  return fiveYearDate <= opposed;
}


/**
 * Sadece IP GATE iç kullanıcıları erişebilsin.
 * Client rolü service-role kullanan bu Edge Function üzerinden
 * hukuki dosya verisine ulaşamasın.
 */
async function assertInternalUser(
  req: Request,
  supabase: ReturnType<typeof createClient>,
) {
  const authHeader =
    req.headers.get("Authorization") ?? "";

  const token = authHeader
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (!token) {
    throw new HttpError(
      401,
      "Oturum bilgisi bulunamadı.",
    );
  }

  const {
    data: authData,
    error: authError,
  } = await supabase.auth.getUser(token);

  if (authError || !authData.user) {
    throw new HttpError(
      401,
      "Geçersiz veya süresi dolmuş oturum.",
    );
  }

  const {
    data: profile,
    error: profileError,
  } = await supabase
    .from("users")
    .select("id, role, disabled")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    throw new HttpError(
      403,
      "IP GATE kullanıcı profili bulunamadı.",
    );
  }

  if (profile.disabled) {
    throw new HttpError(
      403,
      "Kullanıcı hesabı pasif.",
    );
  }

  if (
    !["user", "admin", "superadmin"].includes(
      String(profile.role ?? ""),
    )
  ) {
    throw new HttpError(
      403,
      "Bu çalışma alanına erişim yetkiniz bulunmuyor.",
    );
  }

  return {
    id: authData.user.id,
    role: profile.role,
  };
}


/**
 * Bir marka kaydının hukuki çalışma alanı için ihtiyaç
 * duyduğumuz tüm temel verilerini toplar.
 */
async function loadMarkSnapshot(
  supabase: ReturnType<typeof createClient>,
  ipRecordId: string,
) {
  const [
    recordRes,
    detailsRes,
    classesRes,
    applicantsRes,
  ] = await Promise.all([
    supabase
      .from("ip_records")
      .select(`
        id,
        ip_type,
        origin,
        status,
        portfolio_status,
        record_owner_type,
        application_number,
        application_date,
        registration_number,
        registration_date,
        renewal_date,
        country_code,
        wipo_ir,
        aripo_ir
      `)
      .eq("id", ipRecordId)
      .maybeSingle(),

    supabase
      .from("ip_record_trademark_details")
      .select(`
        brand_name,
        brand_type,
        brand_category,
        brand_image_url,
        description
      `)
      .eq("ip_record_id", ipRecordId)
      .maybeSingle(),

    supabase
      .from("ip_record_classes")
      .select("class_no, items")
      .eq("ip_record_id", ipRecordId)
      .order(
        "class_no",
        { ascending: true },
      ),

    supabase
      .from("ip_record_applicants")
      .select("person_id, order_index")
      .eq("ip_record_id", ipRecordId)
      .order(
        "order_index",
        { ascending: true },
      ),
  ]);

  if (recordRes.error) {
    throw new Error(
      `Marka ana kaydı okunamadı: ${recordRes.error.message}`,
    );
  }

  if (!recordRes.data) {
    throw new Error(
      `Marka kaydı bulunamadı: ${ipRecordId}`,
    );
  }

  if (detailsRes.error) {
    throw new Error(
      `Marka detayları okunamadı: ${detailsRes.error.message}`,
    );
  }

  if (classesRes.error) {
    throw new Error(
      `Marka emtia bilgileri okunamadı: ${classesRes.error.message}`,
    );
  }

  if (applicantsRes.error) {
    throw new Error(
      `Marka sahibi ilişkileri okunamadı: ${applicantsRes.error.message}`,
    );
  }

  const personIds =
    (applicantsRes.data ?? [])
      .map((a: any) => a.person_id)
      .filter(Boolean);

  let persons: any[] = [];

  if (personIds.length > 0) {
    const {
      data,
      error,
    } = await supabase
      .from("persons")
      .select("id, name, type, email")
      .in("id", personIds);

    if (error) {
      throw new Error(
        `Marka sahipleri okunamadı: ${error.message}`,
      );
    }

    persons = data ?? [];
  }

  const applicants =
    (applicantsRes.data ?? []).map(
      (a: any) => {
        const p = persons.find(
          (x: any) =>
            String(x.id) ===
            String(a.person_id),
        );

        return {
          id: a.person_id,
          name: p?.name ?? "-",
          type: p?.type ?? null,
          email: p?.email ?? null,
          orderIndex:
            a.order_index ?? 0,
        };
      },
    );

  return {
    id: recordRes.data.id,

    ipType:
      recordRes.data.ip_type,

    origin:
      recordRes.data.origin,

    status:
      recordRes.data.status,

    portfolioStatus:
      recordRes.data.portfolio_status,

    recordOwnerType:
      recordRes.data.record_owner_type,

    markText:
      detailsRes.data?.brand_name ?? "",

    markType:
      detailsRes.data?.brand_type ?? null,

    brandCategory:
      detailsRes.data?.brand_category ?? null,

    imageUrl:
      detailsRes.data?.brand_image_url ?? null,

    applicationNo:
      recordRes.data.application_number,

    applicationDate:
      recordRes.data.application_date,

    registrationNo:
      recordRes.data.registration_number,

    registrationDate:
      recordRes.data.registration_date,

    renewalDate:
      recordRes.data.renewal_date,

    countryCode:
      recordRes.data.country_code,

    wipoIr:
      recordRes.data.wipo_ir,

    aripoIr:
      recordRes.data.aripo_ir,

    applicants,

    classes:
      (classesRes.data ?? []).map(
        (c: any) => ({
          classNo: c.class_no,
          items:
            Array.isArray(c.items)
              ? c.items
              : [],
        }),
      ),
  };
}


/**
 * Müvekkile bağlı bütün IP record ID'lerini sayfalı biçimde alır.
 */
async function fetchAllClientTrademarkIds(
  supabase: ReturnType<typeof createClient>,
  clientId: string,
) {
  const ids: string[] = [];

  const pageSize = 1000;

  let from = 0;

  while (true) {
    const {
      data,
      error,
    } = await supabase
      .from("ip_record_applicants")
      .select("ip_record_id")
      .eq("person_id", clientId)
      .range(
        from,
        from + pageSize - 1,
      );

    if (error) {
      throw new Error(
        `Müvekkil marka ilişkileri okunamadı: ${error.message}`,
      );
    }

    if (!data || data.length === 0) {
      break;
    }

    for (const row of data) {
      if (row.ip_record_id) {
        ids.push(
          String(row.ip_record_id),
        );
      }
    }

    if (data.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  return [...new Set(ids)];
}


/**
 * Müvekkilin marka portföyünü seçim ekranı için getirir.
 */
async function getClientTrademarkCandidates(
  supabase: ReturnType<typeof createClient>,
  clientId: string,
  opponentApplicationDate?: string | null,
) {
  const applicantIpIds =
    await fetchAllClientTrademarkIds(
      supabase,
      clientId,
    );

  if (applicantIpIds.length === 0) {
    return [];
  }

  const records: any[] = [];
  const details: any[] = [];
  const classes: any[] = [];

  for (
    const chunk of
    chunkArray(applicantIpIds)
  ) {
    const [
      recordsRes,
      detailsRes,
      classesRes,
    ] = await Promise.all([
      supabase
        .from("ip_records")
        .select(`
          id,
          ip_type,
          origin,
          status,
          portfolio_status,
          record_owner_type,
          application_number,
          application_date,
          registration_number,
          registration_date,
          country_code
        `)
        .in("id", chunk)
        .eq(
          "ip_type",
          "trademark",
        )
        .eq(
          "record_owner_type",
          "self",
        ),

      supabase
        .from(
          "ip_record_trademark_details",
        )
        .select(`
          ip_record_id,
          brand_name,
          brand_type,
          brand_image_url
        `)
        .in(
          "ip_record_id",
          chunk,
        ),

      supabase
        .from("ip_record_classes")
        .select(`
          ip_record_id,
          class_no
        `)
        .in(
          "ip_record_id",
          chunk,
        ),
    ]);

    if (recordsRes.error) {
      throw new Error(
        `Müvekkil marka kayıtları okunamadı: ${recordsRes.error.message}`,
      );
    }

    if (detailsRes.error) {
      throw new Error(
        `Müvekkil marka detayları okunamadı: ${detailsRes.error.message}`,
      );
    }

    if (classesRes.error) {
      throw new Error(
        `Müvekkil marka sınıfları okunamadı: ${classesRes.error.message}`,
      );
    }

    records.push(
      ...(recordsRes.data ?? []),
    );

    details.push(
      ...(detailsRes.data ?? []),
    );

    classes.push(
      ...(classesRes.data ?? []),
    );
  }

  return records
    .map((record: any) => {
      const d = details.find(
        (x: any) =>
          String(x.ip_record_id) ===
          String(record.id),
      );

      const niceClasses = classes
        .filter(
          (x: any) =>
            String(x.ip_record_id) ===
            String(record.id),
        )
        .map(
          (x: any) =>
            Number(x.class_no),
        )
        .filter(
          (n: number) =>
            Number.isFinite(n),
        )
        .sort(
          (a: number, b: number) =>
            a - b,
        );

      const proofCheck =
        calculateProofOfUseCheck(
          record.registration_date,
          opponentApplicationDate,
        );

      return {
        id: record.id,

        markText:
          d?.brand_name ?? "",

        markType:
          d?.brand_type ?? null,

        imageUrl:
          d?.brand_image_url ?? null,

        applicationNo:
          record.application_number,

        applicationDate:
          record.application_date,

        registrationNo:
          record.registration_number,

        registrationDate:
          record.registration_date,

        origin:
          record.origin,

        status:
          record.status,

        portfolioStatus:
          record.portfolio_status,

        countryCode:
          record.country_code,

        niceClasses:
          [...new Set(niceClasses)],

        proofOfUseCheck:
          proofCheck === null
            ? "unknown"
            : (
              proofCheck
                ? "likely_required"
                : "likely_not_required"
            ),
      };
    })
    .sort(
      (a: any, b: any) => {
        const aName =
          String(
            a.markText ?? "",
          ).toLocaleLowerCase(
            "tr-TR",
          );

        const bName =
          String(
            b.markText ?? "",
          ).toLocaleLowerCase(
            "tr-TR",
          );

        return aName.localeCompare(
          bName,
          "tr-TR",
        );
      },
    );
}


/**
 * Eski Type 20 task'larında source_ip_record_id yoksa
 * önce mevcut view'dan, sonra description'dan bulmaya çalışır.
 */
async function deriveSourceIpRecordId(
  supabase: ReturnType<typeof createClient>,
  task: any,
  details: Record<string, any>,
) {
  if (details.source_ip_record_id) {
    return String(
      details.source_ip_record_id,
    );
  }

  const {
    data: viewRow,
  } = await supabase
    .from("v_client_bulletin_matches")
    .select("my_ip_record_id")
    .eq("task_id", task.id)
    .limit(1)
    .maybeSingle();

  if (viewRow?.my_ip_record_id) {
    return String(
      viewRow.my_ip_record_id,
    );
  }

  const description =
    String(
      task.description ?? "",
    );

  const match =
    description.match(
      /^\s*["“]?(.+?)["”]?\s+markamız\s+için/i,
    );

  const markName =
    match?.[1]?.trim();

  if (
    markName &&
    task.task_owner_id
  ) {
    const clientIpIds =
      await fetchAllClientTrademarkIds(
        supabase,
        String(task.task_owner_id),
      );

    for (
      const chunk of
      chunkArray(clientIpIds)
    ) {
      const {
        data,
      } = await supabase
        .from(
          "ip_record_trademark_details",
        )
        .select(
          "ip_record_id, brand_name",
        )
        .in(
          "ip_record_id",
          chunk,
        )
        .ilike(
          "brand_name",
          markName,
        );

      if (
        data &&
        data.length > 0
      ) {
        return String(
          data[0].ip_record_id,
        );
      }
    }
  }

  return null;
}


/**
 * Eski task'lar bakımından bülten record ID'sini geri kazanır.
 */
async function resolveBulletinRecordId(
  supabase: ReturnType<typeof createClient>,
  task: any,
  details: Record<string, any>,
  opposedIpRecordId: string,
) {
  if (details.bulletin_record_id) {
    return String(
      details.bulletin_record_id,
    );
  }

  let opponentAppNo =
    details.target_app_no ||
    details.opponent_app_no ||
    null;

  if (
    !opponentAppNo &&
    opposedIpRecordId
  ) {
    const {
      data,
    } = await supabase
      .from("ip_records")
      .select("application_number")
      .eq(
        "id",
        opposedIpRecordId,
      )
      .maybeSingle();

    opponentAppNo =
      data?.application_number ??
      null;
  }

  if (!opponentAppNo) {
    return null;
  }

  let bulletinId:
    string | null = null;

  const bulletinNo =
    details.bulletin_no;

  if (bulletinNo) {
    const {
      data,
    } = await supabase
      .from("trademark_bulletins")
      .select("id")
      .eq(
        "bulletin_no",
        String(bulletinNo),
      )
      .limit(1)
      .maybeSingle();

    bulletinId =
      data?.id
        ? String(data.id)
        : null;
  }

  let query = supabase
    .from(
      "trademark_bulletin_records",
    )
    .select("id")
    .eq(
      "application_number",
      String(opponentAppNo),
    );

  if (bulletinId) {
    query =
      query.eq(
        "bulletin_id",
        bulletinId,
      );
  }

  const {
    data,
  } = await query
    .limit(1)
    .maybeSingle();

  return data?.id
    ? String(data.id)
    : null;
}


/**
 * Task için Opposition Case yoksa otomatik oluşturur.
 *
 * Böylece Paket 1 öncesinde oluşturulmuş eski Type 20
 * task'ları da mümkün olduğu ölçüde yeni sisteme alınır.
 */
async function ensureOppositionCase(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  currentUserId: string,
) {
  const {
    data: task,
    error: taskError,
  } = await supabase
    .from("tasks")
    .select(`
      id,
      title,
      description,
      task_type_id,
      status,
      ip_record_id,
      transaction_id,
      task_owner_id,
      assigned_to,
      details,
      official_due_date,
      operational_due_date
    `)
    .eq("id", taskId)
    .maybeSingle();

  if (taskError) {
    throw new Error(
      `Görev okunamadı: ${taskError.message}`,
    );
  }

  if (!task) {
    throw new HttpError(
      404,
      "Görev bulunamadı.",
    );
  }

  if (
    String(task.task_type_id) !== "20"
  ) {
    throw new HttpError(
      400,
      "Bu çalışma alanı yalnız yayıma itiraz görevlerinde kullanılabilir.",
    );
  }

  const details =
    parseJsonObject(
      task.details,
    );

  const {
    data: existingCase,
    error: existingCaseError,
  } = await supabase
    .from("opposition_cases")
    .select("*")
    .eq("task_id", taskId)
    .maybeSingle();

  if (existingCaseError) {
    throw new Error(
      `Opposition Case okunamadı: ${existingCaseError.message}`,
    );
  }

  let oppositionCase =
    existingCase;

  if (!oppositionCase) {
    const opposedIpRecordId =
      String(
        details.competitor_ip_record_id ||
        task.ip_record_id ||
        "",
      ).trim();

    if (!opposedIpRecordId) {
      throw new HttpError(
        422,
        "Rakip marka IP kaydı tespit edilemedi.",
      );
    }

    const sourceIpRecordId =
      await deriveSourceIpRecordId(
        supabase,
        task,
        details,
      );

    const bulletinRecordId =
      await resolveBulletinRecordId(
        supabase,
        task,
        details,
        opposedIpRecordId,
      );

    let monitoringTrademarkId =
      details.monitored_trademark_id
        ? String(
          details.monitored_trademark_id,
        )
        : null;

    let monitoringMatchId =
      details.monitoring_match_id
        ? String(
          details.monitoring_match_id,
        )
        : null;

    if (
      !monitoringTrademarkId &&
      sourceIpRecordId
    ) {
      const {
        data,
      } = await supabase
        .from(
          "monitoring_trademarks",
        )
        .select("id")
        .eq(
          "ip_record_id",
          sourceIpRecordId,
        )
        .limit(1)
        .maybeSingle();

      monitoringTrademarkId =
        data?.id
          ? String(data.id)
          : null;
    }

    if (
      !monitoringMatchId &&
      monitoringTrademarkId &&
      bulletinRecordId
    ) {
      const {
        data,
      } = await supabase
        .from(
          "monitoring_trademark_records",
        )
        .select("id")
        .eq(
          "monitored_trademark_id",
          monitoringTrademarkId,
        )
        .eq(
          "bulletin_record_id",
          bulletinRecordId,
        )
        .limit(1)
        .maybeSingle();

      monitoringMatchId =
        data?.id
          ? String(data.id)
          : null;
    }

    const {
      data: createdCase,
      error: createError,
    } = await supabase
      .from("opposition_cases")
      .insert({
        task_id:
          taskId,

        transaction_id:
          task.transaction_id ??
          null,

        client_id:
          task.task_owner_id ??
          null,

        opposed_ip_record_id:
          opposedIpRecordId,

        bulletin_record_id:
          bulletinRecordId,

        monitoring_trademark_id:
          monitoringTrademarkId,

        monitoring_match_id:
          monitoringMatchId,

        status:
          "analysis",

        complexity:
          "green",

        selected_grounds:
          ["SMK_6_1"],

        created_by:
          currentUserId,

        facts_snapshot: {
          created_from:
            "legacy_task_backfill",

          source_ip_record_id:
            sourceIpRecordId,

          opposed_ip_record_id:
            opposedIpRecordId,

          bulletin_record_id:
            bulletinRecordId,

          monitoring_trademark_id:
            monitoringTrademarkId,

          monitoring_match_id:
            monitoringMatchId,

          migrated_at:
            new Date()
              .toISOString(),
        },
      })
      .select("*")
      .single();

    if (createError) {
      throw new Error(
        `Opposition Case oluşturulamadı: ${createError.message}`,
      );
    }

    oppositionCase =
      createdCase;

    if (sourceIpRecordId) {
      const snapshot =
        await loadMarkSnapshot(
          supabase,
          sourceIpRecordId,
        );

      await supabase
        .from(
          "opposition_case_prior_marks",
        )
        .upsert({
          opposition_case_id:
            oppositionCase.id,

          ip_record_id:
            sourceIpRecordId,

          is_selected:
            true,

          selection_order:
            0,

          proof_of_use_status:
            "unknown",

          mark_snapshot:
            snapshot,
        }, {
          onConflict:
            "opposition_case_id,ip_record_id",
        });
    }
  }


  const {
    data: priorRows,
    error: priorRowsError,
  } = await supabase
    .from(
      "opposition_case_prior_marks",
    )
    .select("*")
    .eq(
      "opposition_case_id",
      oppositionCase.id,
    )
    .order(
      "selection_order",
      { ascending: true },
    );

  if (priorRowsError) {
    throw new Error(
      `Müstenit markalar okunamadı: ${priorRowsError.message}`,
    );
  }


  if (
    !priorRows ||
    priorRows.length === 0
  ) {
    const fallbackSource =
      oppositionCase
        .facts_snapshot
        ?.source_ip_record_id ||
      await deriveSourceIpRecordId(
        supabase,
        task,
        details,
      );

    if (fallbackSource) {
      const snapshot =
        await loadMarkSnapshot(
          supabase,
          String(fallbackSource),
        );

      const {
        error,
      } = await supabase
        .from(
          "opposition_case_prior_marks",
        )
        .upsert({
          opposition_case_id:
            oppositionCase.id,

          ip_record_id:
            String(fallbackSource),

          is_selected:
            true,

          selection_order:
            0,

          proof_of_use_status:
            "unknown",

          mark_snapshot:
            snapshot,
        }, {
          onConflict:
            "opposition_case_id,ip_record_id",
        });

      if (error) {
        throw new Error(
          `İlk müstenit marka eklenemedi: ${error.message}`,
        );
      }
    }
  }


  return {
    task,
    details,
    oppositionCase,
  };
}


/**
 * Frontend'in kullanacağı bütün çalışma alanını oluşturur.
 */
async function buildWorkspace(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  currentUserId: string,
) {
  const {
    task,
    details,
    oppositionCase,
  } =
    await ensureOppositionCase(
      supabase,
      taskId,
      currentUserId,
    );


  const opponentSnapshot =
    await loadMarkSnapshot(
      supabase,
      String(
        oppositionCase
          .opposed_ip_record_id,
      ),
    );


  let bulletinRecord: any =
    null;

  let bulletinGoods: any[] =
    [];

  let bulletin: any =
    null;


  if (
    oppositionCase
      .bulletin_record_id
  ) {
    const {
      data,
      error,
    } = await supabase
      .from(
        "trademark_bulletin_records",
      )
      .select(`
        id,
        bulletin_id,
        application_number,
        application_date,
        brand_name,
        nice_classes,
        holders,
        image_url
      `)
      .eq(
        "id",
        oppositionCase
          .bulletin_record_id,
      )
      .maybeSingle();

    if (error) {
      throw new Error(
        `Bülten marka kaydı okunamadı: ${error.message}`,
      );
    }

    bulletinRecord =
      data;


    const goodsRes =
      await supabase
        .from(
          "trademark_bulletin_goods",
        )
        .select(
          "class_number, class_text",
        )
        .eq(
          "bulletin_record_id",
          oppositionCase
            .bulletin_record_id,
        )
        .order(
          "class_number",
          { ascending: true },
        );

    if (goodsRes.error) {
      throw new Error(
        `Rakip marka emtia listesi okunamadı: ${goodsRes.error.message}`,
      );
    }

    bulletinGoods =
      goodsRes.data ?? [];


    if (
      bulletinRecord
        ?.bulletin_id
    ) {
      const bulletinRes =
        await supabase
          .from(
            "trademark_bulletins",
          )
          .select(
            "id, bulletin_no, bulletin_date",
          )
          .eq(
            "id",
            bulletinRecord
              .bulletin_id,
          )
          .maybeSingle();

      if (bulletinRes.error) {
        throw new Error(
          `Bülten bilgisi okunamadı: ${bulletinRes.error.message}`,
        );
      }

      bulletin =
        bulletinRes.data;
    }
  }


  const opponentApplicationDate =
    bulletinRecord
      ?.application_date ||
    opponentSnapshot
      .applicationDate ||
    null;


  const {
    data: priorRows,
    error: priorRowsError,
  } = await supabase
    .from(
      "opposition_case_prior_marks",
    )
    .select("*")
    .eq(
      "opposition_case_id",
      oppositionCase.id,
    )
    .order(
      "selection_order",
      { ascending: true },
    );

  if (priorRowsError) {
    throw new Error(
      `Müstenit marka kayıtları okunamadı: ${priorRowsError.message}`,
    );
  }


  const priorMarks: any[] =
    [];

  for (
    const row of
    (priorRows ?? [])
      .filter(
        (r: any) =>
          r.is_selected,
      )
  ) {
    const snapshot =
      await loadMarkSnapshot(
        supabase,
        String(row.ip_record_id),
      );

    priorMarks.push({
      ...row,
      snapshot,
    });
  }


  let client: any =
    null;

  if (
    oppositionCase.client_id
  ) {
    const {
      data,
      error,
    } = await supabase
      .from("persons")
      .select(
        "id, name, type, email",
      )
      .eq(
        "id",
        oppositionCase.client_id,
      )
      .maybeSingle();

    if (error) {
      throw new Error(
        `Müvekkil bilgisi okunamadı: ${error.message}`,
      );
    }

    client =
      data;
  }


  const candidates =
    oppositionCase.client_id
      ? await getClientTrademarkCandidates(
        supabase,
        String(
          oppositionCase.client_id,
        ),
        opponentApplicationDate,
      )
      : [];


  const selectedIds =
    new Set(
      priorMarks.map(
        (p: any) =>
          String(p.ip_record_id),
      ),
    );


  const candidatePriorMarks =
    candidates.map(
      (c: any) => ({
        ...c,

        selected:
          selectedIds.has(
            String(c.id),
          ),
      }),
    );


  return {
    case:
      oppositionCase,

    task: {
      id:
        task.id,

      title:
        task.title,

      status:
        task.status,

      officialDueDate:
        task.official_due_date,

      operationalDueDate:
        task.operational_due_date,
    },

    client,

    bulletin:
      bulletin ?? {
        bulletin_no:
          details.bulletin_no ??
          null,

        bulletin_date:
          details.bulletin_date ??
          null,
      },

    opponent: {
      ...opponentSnapshot,

      markText:
        bulletinRecord
          ?.brand_name ||
        opponentSnapshot
          .markText,

      applicationNo:
        bulletinRecord
          ?.application_number ||
        opponentSnapshot
          .applicationNo,

      applicationDate:
        opponentApplicationDate,

      imageUrl:
        bulletinRecord
          ?.image_url ||
        opponentSnapshot
          .imageUrl,

      holders:
        bulletinRecord
          ?.holders ??
        [],

      niceClasses:
        bulletinRecord
          ?.nice_classes ??
        opponentSnapshot
          .classes
          .map(
            (c: any) =>
              String(c.classNo),
          ),

      goodsByClass:
        bulletinGoods.map(
          (g: any) => ({
            classNo:
              g.class_number,

            text:
              g.class_text ??
              "",
          }),
        ),
    },

    priorMarks,

    candidatePriorMarks,
  };
}


/**
 * Müstenit markaları, itiraz gerekçelerini ve complexity seviyesini kaydeder.
 */
async function saveWorkspace(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  currentUserId: string,
  payload: any,
) {
  const {
    oppositionCase,
  } =
    await ensureOppositionCase(
      supabase,
      taskId,
      currentUserId,
    );


  const selectedPriorMarkIds =
    [
      ...new Set(
        normalizeArray(
          payload
            .selectedPriorMarkIds,
        ),
      ),
    ];


  if (
    selectedPriorMarkIds
      .length === 0
  ) {
    throw new HttpError(
      422,
      "En az bir müstenit marka seçilmelidir.",
    );
  }


  const selectedGrounds =
    [
      ...new Set(
        normalizeArray(
          payload
            .selectedGrounds,
        ),
      ),
    ];


  if (
    selectedGrounds.length === 0
  ) {
    throw new HttpError(
      422,
      "En az bir itiraz gerekçesi seçilmelidir.",
    );
  }


  if (
    selectedGrounds.some(
      (g) =>
        !ALLOWED_GROUNDS.has(g),
    )
  ) {
    throw new HttpError(
      422,
      "Geçersiz itiraz gerekçesi seçildi.",
    );
  }


  const complexity =
    String(
      payload.complexity ??
      "green",
    );


  if (
    ![
      "green",
      "yellow",
      "red",
    ].includes(complexity)
  ) {
    throw new HttpError(
      422,
      "Geçersiz dosya karmaşıklık seviyesi.",
    );
  }


  if (
    !oppositionCase.client_id
  ) {
    throw new HttpError(
      422,
      "Opposition Case üzerinde müvekkil bilgisi bulunmuyor.",
    );
  }


  const clientTrademarkIds =
    new Set(
      await fetchAllClientTrademarkIds(
        supabase,
        String(
          oppositionCase.client_id,
        ),
      ),
    );


  const invalidSelection =
    selectedPriorMarkIds.find(
      (id) =>
        !clientTrademarkIds.has(id),
    );


  if (invalidSelection) {
    throw new HttpError(
      403,
      "Seçilen müstenit markalardan biri bu müvekkile ait değil.",
    );
  }


  let opponentApplicationDate:
    string | null =
    null;


  if (
    oppositionCase
      .bulletin_record_id
  ) {
    const {
      data,
    } = await supabase
      .from(
        "trademark_bulletin_records",
      )
      .select(
        "application_date",
      )
      .eq(
        "id",
        oppositionCase
          .bulletin_record_id,
      )
      .maybeSingle();

    opponentApplicationDate =
      data?.application_date ??
      null;
  }


  if (
    !opponentApplicationDate
  ) {
    const opponent =
      await loadMarkSnapshot(
        supabase,
        String(
          oppositionCase
            .opposed_ip_record_id,
        ),
      );

    opponentApplicationDate =
      opponent.applicationDate ??
      null;
  }


  const {
    error: clearError,
  } = await supabase
    .from(
      "opposition_case_prior_marks",
    )
    .update({
      is_selected:
        false,
    })
    .eq(
      "opposition_case_id",
      oppositionCase.id,
    );


  if (clearError) {
    throw new Error(
      `Eski müstenit seçimleri güncellenemedi: ${clearError.message}`,
    );
  }


  for (
    let i = 0;
    i <
    selectedPriorMarkIds.length;
    i++
  ) {
    const ipRecordId =
      selectedPriorMarkIds[i];

    const snapshot =
      await loadMarkSnapshot(
        supabase,
        ipRecordId,
      );


    const proofRequired =
      calculateProofOfUseCheck(
        snapshot
          .registrationDate,

        opponentApplicationDate,
      );


    const {
      error,
    } = await supabase
      .from(
        "opposition_case_prior_marks",
      )
      .upsert({
        opposition_case_id:
          oppositionCase.id,

        ip_record_id:
          ipRecordId,

        is_selected:
          true,

        selection_order:
          i,

        proof_of_use_required:
          proofRequired,

        proof_of_use_status:
          proofRequired === false
            ? "not_required"
            : "unknown",

        mark_snapshot:
          snapshot,
      }, {
        onConflict:
          "opposition_case_id,ip_record_id",
      });


    if (error) {
      throw new Error(
        `Müstenit marka kaydedilemedi: ${error.message}`,
      );
    }
  }


  const {
    error: caseUpdateError,
  } = await supabase
    .from("opposition_cases")
    .update({
      selected_grounds:
        selectedGrounds,

      complexity,

      status:
        "analysis",
    })
    .eq(
      "id",
      oppositionCase.id,
    );


  if (caseUpdateError) {
    throw new Error(
      `Opposition Case ayarları kaydedilemedi: ${caseUpdateError.message}`,
    );
  }


  return await buildWorkspace(
    supabase,
    taskId,
    currentUserId,
  );
}


serve(async (req) => {
  if (
    req.method === "OPTIONS"
  ) {
    return new Response(
      "ok",
      { headers: corsHeaders },
    );
  }


  try {
    const supabase =
      createClient(
        Deno.env.get(
          "SUPABASE_URL",
        ) ?? "",

        Deno.env.get(
          "SUPABASE_SERVICE_ROLE_KEY",
        ) ?? "",

        {
          auth: {
            autoRefreshToken:
              false,

            persistSession:
              false,
          },
        },
      );


    const currentUser =
      await assertInternalUser(
        req,
        supabase,
      );


    const body =
      await req.json();


    const action =
      String(
        body.action ??
        "get",
      );


    const taskId =
      String(
        body.taskId ??
        "",
      ).trim();


    if (!taskId) {
      throw new HttpError(
        400,
        "taskId zorunludur.",
      );
    }


    let workspace;


    if (action === "get") {
      workspace =
        await buildWorkspace(
          supabase,
          taskId,
          currentUser.id,
        );
    }

    else if (
      action === "save"
    ) {
      workspace =
        await saveWorkspace(
          supabase,
          taskId,
          currentUser.id,
          body.payload ?? {},
        );
    }

    else {
      throw new HttpError(
        400,
        "Geçersiz action.",
      );
    }


    return new Response(
      JSON.stringify({
        success:
          true,

        workspace,
      }),
      {
        headers: {
          ...corsHeaders,

          "Content-Type":
            "application/json",
        },
      },
    );
  }

  catch (error) {
    const status =
      error instanceof HttpError
        ? (
          [401, 403].includes(
            error.status,
          )
            ? error.status
            : 200
        )
        : 500;


    const message =
      error instanceof Error
        ? error.message
        : "Bilinmeyen hata";


    console.error(
      "❌ opposition-workspace:",
      message,
    );


    return new Response(
      JSON.stringify({
        success:
          false,

        error:
          message,
      }),
      {
        status,

        headers: {
          ...corsHeaders,

          "Content-Type":
            "application/json",
        },
      },
    );
  }
});