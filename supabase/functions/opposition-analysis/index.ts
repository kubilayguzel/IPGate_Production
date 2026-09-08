import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const PACKAGE_VERSION = "6.1.10";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GOODS_SIMILARITY_LEVELS = new Set([
  "not_assessed",
  "identical",
  "high",
  "medium",
  "low",
  "none",
]);

const GOODS_CRITERIA = new Set([
  "nature",
  "purpose",
  "use_method",
  "complementary",
  "competitive",
  "distribution_channels",
  "relevant_public",
]);

const REFUSAL_SCOPE_MODES = new Set([
  "full_class",
  "partial",
]);

const ELEMENT_DISTINCTIVENESS_LEVELS = new Set([
  "high",
  "normal",
  "weak",
  "descriptive",
  "non_distinctive",
  "not_assessed",
  "not_applicable",
]);

const DISTINCTIVENESS_LEVELS = new Set([
  "high",
  "normal",
  "weak",
  "descriptive",
  "non_distinctive",
]);

const ADDITIONAL_ELEMENT_ROLES = new Set([
  "negligible",
  "secondary_distinctive",
  "co_dominant",
  "dominant",
  "not_assessed",
  "not_applicable",
]);

const INDEPENDENT_ROLE_OPTIONS = new Set([
  "yes",
  "no",
  "uncertain",
  "not_applicable",
]);

const SIGN_SIMILARITY_LEVELS = new Set([
  "high",
  "medium",
  "low",
  "none",
  "no_comparison",
]);

const PUBLIC_TYPES = new Set([
  "general",
  "professional",
  "mixed",
]);

const ATTENTION_LEVELS = new Set([
  "low",
  "normal",
  "high",
]);

const GLOBAL_CONCLUSIONS = new Set([
  "exists",
  "borderline",
  "does_not_exist",
]);

const ASSOCIATION_LEVELS = new Set([
  "exists",
  "borderline",
  "does_not_exist",
]);

class HttpError extends Error {
  status: number;

  constructor(
    status: number,
    message: string,
  ) {
    super(message);
    this.status = status;
  }
}

function asObject(
  value: unknown,
): Record<string, any> {
  if (!value) {
    return {};
  }

  if (
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as Record<string, any>;
  }

  if (
    typeof value === "string"
  ) {
    try {
      const parsed =
        JSON.parse(value);

      return (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
        )
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  return {};
}

function asStringArray(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map(
          (item) =>
            String(item ?? "")
              .trim(),
        )
        .filter(Boolean),
    ),
  ];
}

function normalizeText(
  value: unknown,
): string {
  return String(value ?? "")
    .trim();
}

function normalizeComparableText(
  value: unknown,
): string {
  return String(value ?? "")
    .toLocaleLowerCase("tr-TR")
    .replace(
      /[^a-z0-9çğıöşü]+/gi,
      " ",
    )
    .replace(
      /[\s\u00A0]+/g,
      " ",
    )
    .trim();
}

function isNoElementValue(
  value: unknown,
): boolean {
  const normalized =
    normalizeComparableText(value);

  return [
    "yok",
    "yoktur",
    "bulunmuyor",
    "birebir ortak unsur yok",
  ].includes(normalized);
}

function markTokens(
  value: unknown,
): string[] {
  return String(value ?? "")
    .trim()
    .split(
      /[^0-9A-Za-zÇĞİIÖŞÜçğıiöşü]+/,
    )
    .map(
      (token) =>
        token.trim(),
    )
    .filter(Boolean);
}

function uniqueMarkNames(
  priorRights: any[],
): string[] {
  return [
    ...new Set(
      priorRights
        .map(
          (right: any) =>
            normalizeText(
              right?.markText,
            ),
        )
        .filter(Boolean),
    ),
  ];
}

function exactCommonTokens(
  priorRights: any[],
  opponent: any,
): string[] {
  const opponentTokens =
    new Set(
      markTokens(
        opponent?.markText,
      ).map(
        (token) =>
          token.toLocaleLowerCase(
            "tr-TR",
          ),
      ),
    );

  const found =
    new Map<string, string>();

  for (
    const markName
    of uniqueMarkNames(
      priorRights,
    )
  ) {
    for (
      const token
      of markTokens(
        markName,
      )
    ) {
      const key =
        token.toLocaleLowerCase(
          "tr-TR",
        );

      if (
        opponentTokens.has(key) &&
        !found.has(key)
      ) {
        found.set(
          key,
          token,
        );
      }
    }
  }

  return [
    ...found.values(),
  ];
}

function differenceSide(
  markName: string,
  commonTokensLower:
    Set<string>,
): string {
  return markTokens(markName)
    .filter(
      (token) =>
        !commonTokensLower.has(
          token.toLocaleLowerCase(
            "tr-TR",
          ),
        ),
    )
    .join(" ")
    .trim();
}

function defaultCommonElements(
  priorRights: any[],
  opponent: any,
): string {
  const common =
    exactCommonTokens(
      priorRights,
      opponent,
    );

  return common.length
    ? common.join(" ")
    : "yok";
}

function defaultDifferences(
  priorRights: any[],
  opponent: any,
): string {
  const commonLower =
    new Set(
      exactCommonTokens(
        priorRights,
        opponent,
      ).map(
        (token) =>
          token.toLocaleLowerCase(
            "tr-TR",
          ),
      ),
    );

  const priorParts =
    uniqueMarkNames(
      priorRights,
    )
      .map(
        (name) =>
          differenceSide(
            name,
            commonLower,
          ),
      )
      .filter(Boolean);

  const opponentPart =
    differenceSide(
      normalizeText(
        opponent?.markText,
      ),
      commonLower,
    );

  const uniquePrior =
    [
      ...new Set(
        priorParts,
      ),
    ];

  if (
    uniquePrior.length === 0 &&
    !opponentPart
  ) {
    return "yok";
  }

  return [
    uniquePrior.join(" / "),
    opponentPart,
  ]
    .filter(Boolean)
    .join(" / ") ||
    "yok";
}

function defaultPriorMarkLabel(
  priorRights: any[],
): string {
  return uniqueMarkNames(
    priorRights,
  ).join(" / ");
}

function defaultAdditionalElements(
  markName: string,
  commonElements: string,
): string {
  if (
    isNoElementValue(
      commonElements,
    )
  ) {
    return normalizeText(
      markName,
    ) ||
      "yok";
  }

  const commonLower =
    new Set(
      markTokens(
        commonElements,
      ).map(
        (token) =>
          token.toLocaleLowerCase(
            "tr-TR",
          ),
      ),
    );

  return differenceSide(
    markName,
    commonLower,
  ) ||
    "yok";
}

function defaultPriorAdditionalElements(
  priorRights: any[],
  commonElements: string,
): string {
  if (
    isNoElementValue(
      commonElements,
    )
  ) {
    return defaultPriorMarkLabel(
      priorRights,
    ) ||
      "yok";
  }

  const values =
    uniqueMarkNames(
      priorRights,
    )
      .map(
        (name) =>
          defaultAdditionalElements(
            name,
            commonElements,
          ),
      )
      .filter(
        (value) =>
          !isNoElementValue(
            value,
          ),
      );

  return [
    ...new Set(
      values,
    ),
  ].join(" / ") ||
    "yok";
}

function splitScopeSegments(
  value: unknown,
): string[] {
  return String(value ?? "")
    .split(/[;\n]+/)
    .map(
      (item) =>
        normalizeComparableText(
          item,
        ),
    )
    .filter(
      (item) =>
        item.length >= 3,
    );
}

function isPartialScopeSupported(
  fullText: unknown,
  partialText: unknown,
): boolean {
  const full =
    normalizeComparableText(
      fullText,
    );

  const partial =
    normalizeComparableText(
      partialText,
    );

  if (
    !full ||
    !partial
  ) {
    return false;
  }

  if (
    full === partial
  ) {
    return false;
  }

  if (
    full.includes(
      partial,
    )
  ) {
    return true;
  }

  const segments =
    splitScopeSegments(
      partialText,
    );

  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        full.includes(
          segment,
        ),
    )
  );
}

function parseDate(
  value?:
    string | null,
): Date | null {
  if (!value) {
    return null;
  }

  const date =
    new Date(
      `${value}T00:00:00Z`,
    );

  return Number.isNaN(
    date.getTime(),
  )
    ? null
    : date;
}

function calculateProofRisk(
  registrationDate?:
    string | null,
  opponentApplicationDate?:
    string | null,
): boolean | null {
  const registration =
    parseDate(
      registrationDate,
    );

  const opposed =
    parseDate(
      opponentApplicationDate,
    );

  if (
    !registration ||
    !opposed
  ) {
    return null;
  }

  const fiveYearsLater =
    new Date(
      registration,
    );

  fiveYearsLater
    .setUTCFullYear(
      fiveYearsLater
        .getUTCFullYear() +
        5,
    );

  return (
    fiveYearsLater <=
    opposed
  );
}

function compareDates(
  earlierDate?:
    string | null,
  laterDate?:
    string | null,
): number | null {
  const earlier =
    parseDate(
      earlierDate,
    );

  const later =
    parseDate(
      laterDate,
    );

  if (
    !earlier ||
    !later
  ) {
    return null;
  }

  if (
    earlier.getTime() <
    later.getTime()
  ) {
    return -1;
  }

  if (
    earlier.getTime() >
    later.getTime()
  ) {
    return 1;
  }

  return 0;
}

async function sha256(
  value: string,
): Promise<string> {
  const encoded =
    new TextEncoder()
      .encode(value);

  const digest =
    await crypto.subtle
      .digest(
        "SHA-256",
        encoded,
      );

  return Array.from(
    new Uint8Array(
      digest,
    ),
  )
    .map(
      (byte) =>
        byte
          .toString(16)
          .padStart(
            2,
            "0",
          ),
    )
    .join("");
}

async function assertInternalUser(
  req: Request,
  supabase:
    ReturnType<
      typeof createClient
    >,
) {
  const authHeader =
    req.headers.get(
      "Authorization",
    ) ??
    "";

  const token =
    authHeader
      .replace(
        /^Bearer\s+/i,
        "",
      )
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
  } =
    await supabase.auth
      .getUser(
        token,
      );

  if (
    authError ||
    !authData.user
  ) {
    throw new HttpError(
      401,
      "Geçersiz veya süresi dolmuş oturum.",
    );
  }

  const {
    data: profile,
    error: profileError,
  } =
    await supabase
      .from("users")
      .select(
        "id, role, disabled",
      )
      .eq(
        "id",
        authData.user.id,
      )
      .maybeSingle();

  if (
    profileError ||
    !profile
  ) {
    throw new HttpError(
      403,
      "IP GATE kullanıcı profili bulunamadı.",
    );
  }

  if (
    profile.disabled
  ) {
    throw new HttpError(
      403,
      "Kullanıcı hesabı pasif.",
    );
  }

  if (
    ![
      "user",
      "admin",
      "superadmin",
    ].includes(
      String(
        profile.role ??
        "",
      ),
    )
  ) {
    throw new HttpError(
      403,
      "Bu hukuki çalışma alanına erişim yetkiniz bulunmuyor.",
    );
  }

  return {
    id:
      authData.user.id,
    role:
      profile.role,
  };
}

async function loadCase(
  supabase:
    ReturnType<
      typeof createClient
    >,
  taskId: string,
) {
  const {
    data: task,
    error: taskError,
  } =
    await supabase
      .from("tasks")
      .select(
        "id, task_type_id, title, status",
      )
      .eq(
        "id",
        taskId,
      )
      .maybeSingle();

  if (
    taskError
  ) {
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
    String(
      task.task_type_id,
    ) !==
    "20"
  ) {
    throw new HttpError(
      400,
      "SMK 6/1 analiz motoru yalnız yayıma itiraz görevlerinde kullanılabilir.",
    );
  }

  const {
    data:
      oppositionCase,
    error:
      caseError,
  } =
    await supabase
      .from(
        "opposition_cases",
      )
      .select("*")
      .eq(
        "task_id",
        taskId,
      )
      .maybeSingle();

  if (
    caseError
  ) {
    throw new Error(
      `Opposition Case okunamadı: ${caseError.message}`,
    );
  }

  if (
    !oppositionCase
  ) {
    throw new HttpError(
      422,
      "Opposition Case bulunamadı. Önce Yayına İtiraz Çalışma Alanını açıp dosyayı kaydedin.",
    );
  }

  return {
    task,
    oppositionCase,
  };
}

async function loadPriorMark(
  supabase:
    ReturnType<
      typeof createClient
    >,
  ipRecordId: string,
  opponentApplicationDate?:
    string | null,
  priorRow?: any,
) {
  const [
    recordRes,
    detailsRes,
    classesRes,
  ] =
    await Promise.all([
      supabase
        .from(
          "ip_records",
        )
        .select(`
          id,
          status,
          portfolio_status,
          record_owner_type,
          origin,
          country_code,
          application_number,
          application_date,
          registration_number,
          registration_date,
          renewal_date
        `)
        .eq(
          "id",
          ipRecordId,
        )
        .maybeSingle(),

      supabase
        .from(
          "ip_record_trademark_details",
        )
        .select(
          "brand_name, brand_type, brand_image_url",
        )
        .eq(
          "ip_record_id",
          ipRecordId,
        )
        .maybeSingle(),

      supabase
        .from(
          "ip_record_classes",
        )
        .select(
          "class_no, items",
        )
        .eq(
          "ip_record_id",
          ipRecordId,
        )
        .order(
          "class_no",
          {
            ascending:
              true,
          },
        ),
    ]);

  if (
    recordRes.error ||
    !recordRes.data
  ) {
    throw new Error(
      `Müstenit marka ana kaydı okunamadı (${ipRecordId}): ${recordRes.error?.message ?? "Kayıt bulunamadı"}`,
    );
  }

  if (
    detailsRes.error
  ) {
    throw new Error(
      `Müstenit marka detayı okunamadı: ${detailsRes.error.message}`,
    );
  }

  if (
    classesRes.error
  ) {
    throw new Error(
      `Müstenit marka emtiası okunamadı: ${classesRes.error.message}`,
    );
  }

  const record =
    recordRes.data;

  const classes =
    (
      classesRes.data ??
      []
    ).map(
      (row: any) => ({
        classNo:
          Number(
            row.class_no,
          ),
        items:
          Array.isArray(
            row.items,
          )
            ? row.items
            : [],
      }),
    );

  const blockers:
    string[] =
    [];

  const warnings:
    string[] =
    [];

  if (
    !detailsRes.data
      ?.brand_name
  ) {
    blockers.push(
      "Marka adı kayıtlı değil.",
    );
  }

  if (
    !record
      .application_number
  ) {
    blockers.push(
      "Başvuru numarası kayıtlı değil.",
    );
  }

  if (
    !record
      .application_date
  ) {
    blockers.push(
      "Başvuru tarihi kayıtlı değil; tarihsel öncelik teyit edilemiyor.",
    );
  }

  if (
    classes.length ===
    0
  ) {
    blockers.push(
      "Müstenit markanın mal/hizmet kapsamı bulunamadı.",
    );
  }

  const priorityComparison =
    compareDates(
      record
        .application_date,
      opponentApplicationDate,
    );

  if (
    priorityComparison ===
    0
  ) {
    blockers.push(
      "Müstenit marka ile itiraz edilen başvurunun başvuru tarihleri aynı görünüyor; öncelik ayrıca teyit edilmeli.",
    );
  } else if (
    priorityComparison ===
    1
  ) {
    blockers.push(
      "Müstenit markanın başvuru tarihi itiraz edilen başvurudan daha sonraki görünüyor.",
    );
  } else if (
    priorityComparison ===
    null
  ) {
    warnings.push(
      "Başvuru tarihleri otomatik olarak karşılaştırılamadı.",
    );
  }

  const proofRiskFromRow =
    priorRow
      ?.proof_of_use_required;

  const proofRisk =
    typeof proofRiskFromRow ===
      "boolean"
      ? proofRiskFromRow
      : calculateProofRisk(
          record
            .registration_date,
          opponentApplicationDate,
        );

  if (
    proofRisk ===
    true
  ) {
    warnings.push(
      "Beş yıllık kullanım ispatı dönemi bakımından ayrıca kontrol gerekli.",
    );
  } else if (
    proofRisk ===
    null
  ) {
    warnings.push(
      "Kullanım ispatı ön kontrolü için yeterli tarih verisi yok.",
    );
  }

  if (
    record.status
  ) {
    warnings.push(
      `Sicil statüsü: ${record.status}. Müstenit hak olarak kullanılabilirliği avukat tarafından teyit edilmeli.`,
    );
  }

  return {
    id:
      record.id,

    markText:
      detailsRes.data
        ?.brand_name ??
      "",

    markType:
      detailsRes.data
        ?.brand_type ??
      null,

    imageUrl:
      detailsRes.data
        ?.brand_image_url ??
      null,

    status:
      record.status,

    portfolioStatus:
      record
        .portfolio_status,

    origin:
      record.origin,

    countryCode:
      record
        .country_code,

    applicationNo:
      record
        .application_number,

    applicationDate:
      record
        .application_date,

    registrationNo:
      record
        .registration_number,

    registrationDate:
      record
        .registration_date,

    renewalDate:
      record
        .renewal_date,

    proofOfUseRequired:
      proofRisk,

    proofOfUseStatus:
      priorRow
        ?.proof_of_use_status ??
      "unknown",

    classes,

    autoChecks: {
      blockers,
      warnings,
    },
  };
}

function groupBulletinGoods(
  rows: any[],
): Array<{
  classNo: number;
  text: string;
}> {
  const grouped =
    new Map<
      number,
      string[]
    >();

  for (
    const row
    of rows ??
      []
  ) {
    const classNo =
      Number(
        row.class_number,
      );

    if (
      !Number.isFinite(
        classNo,
      )
    ) {
      continue;
    }

    if (
      !grouped.has(
        classNo,
      )
    ) {
      grouped.set(
        classNo,
        [],
      );
    }

    const text =
      normalizeText(
        row.class_text,
      );

    if (text) {
      grouped
        .get(
          classNo,
        )!
        .push(
          text,
        );
    }
  }

  return [
    ...grouped.entries(),
  ]
    .map(
      ([
        classNo,
        texts,
      ]) => ({
        classNo,
        text:
          [
            ...new Set(
              texts,
            ),
          ].join("\n"),
      }),
    )
    .sort(
      (a, b) =>
        a.classNo -
        b.classNo,
    );
}

async function loadOpponent(
  supabase:
    ReturnType<
      typeof createClient
    >,
  oppositionCase: any,
) {
  let applicationNo:
    string | null =
    null;

  let applicationDate:
    string | null =
    null;

  let markText:
    string | null =
    null;

  let niceClasses:
    string[] =
    [];

  let goodsByClass:
    Array<{
      classNo: number;
      text: string;
    }> =
    [];

  if (
    oppositionCase
      .bulletin_record_id
  ) {
    const {
      data:
        bulletinRecord,
      error:
        bulletinRecordError,
    } =
      await supabase
        .from(
          "trademark_bulletin_records",
        )
        .select(
          "id, application_number, application_date, brand_name, nice_classes",
        )
        .eq(
          "id",
          oppositionCase
            .bulletin_record_id,
        )
        .maybeSingle();

    if (
      bulletinRecordError
    ) {
      throw new Error(
        `Rakip bülten kaydı okunamadı: ${bulletinRecordError.message}`,
      );
    }

    if (
      bulletinRecord
    ) {
      applicationNo =
        bulletinRecord
          .application_number ??
        null;

      applicationDate =
        bulletinRecord
          .application_date ??
        null;

      markText =
        bulletinRecord
          .brand_name ??
        null;

      niceClasses =
        Array.isArray(
          bulletinRecord
            .nice_classes,
        )
          ? bulletinRecord
              .nice_classes
              .map(String)
          : [];
    }

    const {
      data:
        goods,
      error:
        goodsError,
    } =
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
          {
            ascending:
              true,
          },
        );

    if (
      goodsError
    ) {
      throw new Error(
        `Rakip mal/hizmet listesi okunamadı: ${goodsError.message}`,
      );
    }

    goodsByClass =
      groupBulletinGoods(
        goods ??
          [],
      );
  }

  const [
    recordRes,
    detailsRes,
    classesRes,
  ] =
    await Promise.all([
      supabase
        .from(
          "ip_records",
        )
        .select(
          "application_number, application_date",
        )
        .eq(
          "id",
          oppositionCase
            .opposed_ip_record_id,
        )
        .maybeSingle(),

      supabase
        .from(
          "ip_record_trademark_details",
        )
        .select(
          "brand_name",
        )
        .eq(
          "ip_record_id",
          oppositionCase
            .opposed_ip_record_id,
        )
        .maybeSingle(),

      supabase
        .from(
          "ip_record_classes",
        )
        .select(
          "class_no, items",
        )
        .eq(
          "ip_record_id",
          oppositionCase
            .opposed_ip_record_id,
        )
        .order(
          "class_no",
          {
            ascending:
              true,
          },
        ),
    ]);

  if (
    recordRes.error
  ) {
    throw new Error(
      `Rakip IP kaydı okunamadı: ${recordRes.error.message}`,
    );
  }

  if (
    detailsRes.error
  ) {
    throw new Error(
      `Rakip marka detayı okunamadı: ${detailsRes.error.message}`,
    );
  }

  if (
    classesRes.error
  ) {
    throw new Error(
      `Rakip portföy emtiası okunamadı: ${classesRes.error.message}`,
    );
  }

  applicationNo =
    applicationNo ??
    recordRes.data
      ?.application_number ??
    null;

  applicationDate =
    applicationDate ??
    recordRes.data
      ?.application_date ??
    null;

  markText =
    markText ??
    detailsRes.data
      ?.brand_name ??
    null;

  if (
    goodsByClass.length ===
      0 &&
    classesRes.data
      ?.length
  ) {
    goodsByClass =
      (
        classesRes.data ??
        []
      )
        .map(
          (row: any) => ({
            classNo:
              Number(
                row.class_no,
              ),
            text:
              Array.isArray(
                row.items,
              )
                ? row.items
                    .join("\n")
                : "",
          }),
        )
        .filter(
          (row: any) =>
            Number.isFinite(
              row.classNo,
            ),
        );
  }

  if (
    niceClasses.length ===
    0
  ) {
    niceClasses =
      goodsByClass
        .map(
          (row) =>
            String(
              row.classNo,
            ),
        );
  }

  return {
    ipRecordId:
      oppositionCase
        .opposed_ip_record_id,

    bulletinRecordId:
      oppositionCase
        .bulletin_record_id,

    markText,
    applicationNo,
    applicationDate,
    niceClasses,
    goodsByClass,
  };
}

function buildDefaultForm(
  priorRights: any[],
  opponent: any,
  saved:
    Record<string, any>,
) {
  const savedPriorReview =
    Array.isArray(
      saved
        .priorRightsReview,
    )
      ? saved
          .priorRightsReview
      : [];

  const savedGoods =
    Array.isArray(
      saved
        .goodsAssessments,
    )
      ? saved
          .goodsAssessments
      : [];

  const priorRightsReview =
    priorRights.map(
      (right: any) => {
        const existing =
          savedPriorReview
            .find(
              (row: any) =>
                String(
                  row.ipRecordId,
                ) ===
                String(
                  right.id,
                ),
            );

        return {
          ipRecordId:
            right.id,

          /*
           * 6.1.10:
           * Bu hak önceki Dosya ve Kapsam ekranında zaten mesnet olarak
           * seçilmiştir. İlk kez Decision Tree'ye geldiğinde default
           * uygun kabul edilir. Kullanıcının daha önce açıkça kaydettiği
           * FALSE tercihi ise korunur.
           */
          confirmedEligible:
            existing
              ? existing
                  .confirmedEligible !==
                false
              : true,

          note:
            normalizeText(
              existing
                ?.note,
            ),
        };
      },
    );

  const goodsAssessments =
    opponent
      .goodsByClass
      .map(
        (goods: any) => {
          const existing =
            savedGoods
              .find(
                (row: any) =>
                  Number(
                    row.opponentClassNo,
                  ) ===
                  Number(
                    goods.classNo,
                  ),
              );

          /*
           * 6.1.8.2:
           * Yeni sınıf ilk kez görülüyorsa ret talebi default açık.
           * Kayıtlı FALSE varsa korunur.
           */
          const requestedRefusal =
            existing
              ? existing
                  .requestedRefusal ===
                true
              : true;

          const refusalScopeMode =
            requestedRefusal
              ? (
                  REFUSAL_SCOPE_MODES
                    .has(
                      existing
                        ?.refusalScopeMode,
                    )
                    ? existing
                        .refusalScopeMode
                    : "full_class"
                )
              : "";

          const refusalScopeText =
            refusalScopeMode ===
              "full_class"
              ? normalizeText(
                  goods.text,
                )
              : refusalScopeMode ===
                  "partial"
                ? normalizeText(
                    existing
                      ?.refusalScopeText,
                  )
                : "";

          return {
            opponentClassNo:
              Number(
                goods.classNo,
              ),

            opponentText:
              goods.text ??
              "",

            similarityLevel:
              GOODS_SIMILARITY_LEVELS
                .has(
                  existing
                    ?.similarityLevel,
                )
                ? existing
                    .similarityLevel
                : "not_assessed",

            matchedPriorClasses:
              asStringArray(
                existing
                  ?.matchedPriorClasses,
              ),

            criteria:
              asStringArray(
                existing
                  ?.criteria,
              )
                .filter(
                  (item) =>
                    GOODS_CRITERIA
                      .has(
                        item,
                      ),
                ),

            requestedRefusal,

            refusalScopeMode,

            refusalScopeText,

            note:
              normalizeText(
                existing
                  ?.note,
              ),
          };
        },
      );

  const savedSign =
    asObject(
      saved
        .signAssessment,
    );

  const commonElements =
    normalizeText(
      savedSign
        .commonElements,
    ) ||
    defaultCommonElements(
      priorRights,
      opponent,
    );

  const noCommon =
    isNoElementValue(
      commonElements,
    );

  const differences =
    normalizeText(
      savedSign
        .differences,
    ) ||
    defaultDifferences(
      priorRights,
      opponent,
    );

  const priorMarkLabel =
    defaultPriorMarkLabel(
      priorRights,
    );

  const opponentMarkLabel =
    normalizeText(
      opponent
        ?.markText,
    );

  const clientAdditionalElements =
    normalizeText(
      savedSign
        .clientAdditionalElements,
    ) ||
    defaultPriorAdditionalElements(
      priorRights,
      commonElements,
    );

  const opponentAdditionalElements =
    normalizeText(
      savedSign
        .opponentAdditionalElements,
    ) ||
    defaultAdditionalElements(
      opponentMarkLabel,
      commonElements,
    );

  const clientAdditionalIsNo =
    isNoElementValue(
      clientAdditionalElements,
    );

  const opponentAdditionalIsNo =
    isNoElementValue(
      opponentAdditionalElements,
    );

  const signAssessment = {
    commonElements,

    differences,

    commonElementDistinctiveness:
      !noCommon &&
      DISTINCTIVENESS_LEVELS
        .has(
          savedSign
            .commonElementDistinctiveness,
        )
        ? savedSign
            .commonElementDistinctiveness
        : "",

    clientDominantElements:
      normalizeText(
        savedSign
          .clientDominantElements,
      ) ||
      priorMarkLabel,

    opponentDominantElements:
      normalizeText(
        savedSign
          .opponentDominantElements,
      ) ||
      opponentMarkLabel,

    clientAdditionalElements,

    clientAdditionalDistinctiveness:
      ELEMENT_DISTINCTIVENESS_LEVELS
        .has(
          savedSign
            .clientAdditionalDistinctiveness,
        )
        ? savedSign
            .clientAdditionalDistinctiveness
        : (
            noCommon ||
            clientAdditionalIsNo
          )
          ? "not_applicable"
          : "",

    clientAdditionalRole:
      ADDITIONAL_ELEMENT_ROLES
        .has(
          savedSign
            .clientAdditionalRole,
        )
        ? savedSign
            .clientAdditionalRole
        : (
            noCommon ||
            clientAdditionalIsNo
          )
          ? "not_applicable"
          : "",

    opponentAdditionalElements,

    opponentAdditionalDistinctiveness:
      ELEMENT_DISTINCTIVENESS_LEVELS
        .has(
          savedSign
            .opponentAdditionalDistinctiveness,
        )
        ? savedSign
            .opponentAdditionalDistinctiveness
        : (
            noCommon ||
            opponentAdditionalIsNo
          )
          ? "not_applicable"
          : "",

    opponentAdditionalRole:
      ADDITIONAL_ELEMENT_ROLES
        .has(
          savedSign
            .opponentAdditionalRole,
        )
        ? savedSign
            .opponentAdditionalRole
        : (
            noCommon ||
            opponentAdditionalIsNo
          )
          ? "not_applicable"
          : "",

    independentDistinctiveRole:
      noCommon
        ? "not_applicable"
        : INDEPENDENT_ROLE_OPTIONS
            .has(
              savedSign
                .independentDistinctiveRole,
            )
          ? savedSign
              .independentDistinctiveRole
          : "",

    visualSimilarity:
      SIGN_SIMILARITY_LEVELS
        .has(
          savedSign
            .visualSimilarity,
        )
        ? savedSign
            .visualSimilarity
        : "",

    auralSimilarity:
      SIGN_SIMILARITY_LEVELS
        .has(
          savedSign
            .auralSimilarity,
        )
        ? savedSign
            .auralSimilarity
        : "",

    conceptualSimilarity:
      SIGN_SIMILARITY_LEVELS
        .has(
          savedSign
            .conceptualSimilarity,
        )
        ? savedSign
            .conceptualSimilarity
        : "",

    overallSimilarity:
      SIGN_SIMILARITY_LEVELS
        .has(
          savedSign
            .overallSimilarity,
        )
        ? savedSign
            .overallSimilarity
        : "",

    note:
      normalizeText(
        savedSign.note,
      ),
  };

  const publicAssessment = {
    publicType:
      PUBLIC_TYPES
        .has(
          saved
            .publicAssessment
            ?.publicType,
        )
        ? saved
            .publicAssessment
            .publicType
        : "",

    attentionLevel:
      ATTENTION_LEVELS
        .has(
          saved
            .publicAssessment
            ?.attentionLevel,
        )
        ? saved
            .publicAssessment
            .attentionLevel
        : "",

    note:
      normalizeText(
        saved
          .publicAssessment
          ?.note,
      ),
  };

  /*
   * Yayıma itiraz işi:
   * İlk açılışta "var / var" hızlı başlangıç.
   * Kayıtlı kullanıcı tercihi daima korunur.
   */
  const globalAssessment = {
    conclusion:
      GLOBAL_CONCLUSIONS
        .has(
          saved
            .globalAssessment
            ?.conclusion,
        )
        ? saved
            .globalAssessment
            .conclusion
        : "exists",

    associationLikelihood:
      ASSOCIATION_LEVELS
        .has(
          saved
            .globalAssessment
            ?.associationLikelihood,
        )
        ? saved
            .globalAssessment
            .associationLikelihood
        : "exists",

    lawyerMerits:
      normalizeText(
        saved
          .globalAssessment
          ?.lawyerMerits,
      ),
  };

  return {
    priorRightsReview,
    goodsAssessments,
    signAssessment,
    publicAssessment,
    globalAssessment,
  };
}

function buildAvailablePriorClassKeys(
  priorRights: any[],
): Set<string> {
  const keys =
    new Set<string>();

  for (
    const right
    of priorRights
  ) {
    for (
      const cls
      of right.classes ??
        []
    ) {
      keys.add(
        `${right.id}:${Number(cls.classNo)}`,
      );
    }
  }

  return keys;
}

function assessReadiness(
  formData: any,
  priorRights: any[],
  opponent: any,
  groundSelected:
    boolean,
  stale = false,
) {
  const blockers:
    string[] =
    [];

  const warnings:
    string[] =
    [];

  if (
    !groundSelected
  ) {
    blockers.push(
      "SMK 6/1 itiraz gerekçesi dosyada seçili değil.",
    );
  }

  if (stale) {
    blockers.push(
      "Müstenit haklar veya rakip kapsam değişti. 6/1 analizi güncellenip yeniden kaydedilmeli.",
    );
  }

  if (
    priorRights.length ===
    0
  ) {
    blockers.push(
      "Seçili müstenit marka bulunmuyor.",
    );
  }

  const priorReviewMap =
    new Map(
      (
        formData
          .priorRightsReview ??
        []
      ).map(
        (row: any) => [
          String(
            row.ipRecordId,
          ),
          row,
        ],
      ),
    );

  for (
    const right
    of priorRights
  ) {
    const review:
      any =
      priorReviewMap
        .get(
          String(
            right.id,
          ),
        );

    if (
      !review
        ?.confirmedEligible
    ) {
      blockers.push(
        `Müstenit hak uygunluğu teyit edilmedi: ${right.markText || right.applicationNo || right.id}`,
      );
    }

    for (
      const blocker
      of right
        .autoChecks
        ?.blockers ??
        []
    ) {
      blockers.push(
        `${right.markText || right.applicationNo}: ${blocker}`,
      );
    }

    for (
      const warning
      of right
        .autoChecks
        ?.warnings ??
        []
    ) {
      warnings.push(
        `${right.markText || right.applicationNo}: ${warning}`,
      );
    }
  }

  const availablePriorClassKeys =
    buildAvailablePriorClassKeys(
      priorRights,
    );

  const currentOpponentClasses =
    new Set(
      (
        opponent
          .goodsByClass ??
        []
      ).map(
        (row: any) =>
          Number(
            row.classNo,
          ),
      ),
    );

  const goodsMap =
    new Map(
      (
        formData
          .goodsAssessments ??
        []
      ).map(
        (row: any) => [
          Number(
            row.opponentClassNo,
          ),
          row,
        ],
      ),
    );

  let requestedRefusalCount =
    0;

  for (
    const opponentClassNo
    of currentOpponentClasses
  ) {
    const row:
      any =
      goodsMap.get(
        opponentClassNo,
      );

    if (!row) {
      blockers.push(
        `Rakip Sınıf ${opponentClassNo} için mal/hizmet değerlendirmesi yok.`,
      );
      continue;
    }

    /*
     * 6.1.8.2:
     * Ret talep edilmeyen sınıf filing scope dışındadır.
     * Bu satır için similarity / matched class / criteria / scope
     * değerlendirmesi ZORUNLU DEĞİL.
     */
    if (
      row.requestedRefusal !==
      true
    ) {
      continue;
    }

    requestedRefusalCount +=
      1;

    /*
     * 6.1.10 OPTIONAL GOODS COMPARISON POLICY
     *
     * Filing readiness için yalnız RET KAPSAMI zorunludur.
     * Aşağıdaki avukat girdileri opsiyoneldir:
     * - similarityLevel
     * - matchedPriorClasses
     * - criteria
     *
     * Girilen değerler downstream reasoning/drafting için bağlayıcı
     * lawyer finding olarak saklanır. Boş bırakılması blocker değildir.
     */
    const similarityLevel =
      normalizeText(
        row.similarityLevel,
      );

    const matched =
      asStringArray(
        row
          .matchedPriorClasses,
      );

    const criteria =
      asStringArray(
        row.criteria,
      ).filter(
        (item) =>
          GOODS_CRITERIA
            .has(
              item,
            ),
      );

    for (
      const key
      of matched
    ) {
      if (
        !availablePriorClassKeys
          .has(key)
      ) {
        blockers.push(
          `Rakip Sınıf ${opponentClassNo} için artık seçili olmayan/geçersiz bir müstenit sınıf eşleştirmesi var.`,
        );
      }
    }

    if (
      similarityLevel ===
      "none"
    ) {
      warnings.push(
        `Rakip Sınıf ${opponentClassNo} için "benzer değil" avukat bulgusu girildiği halde ret talebi açıktır. Bu tercih dilekçe üretiminde açık çelişki olarak dikkate alınacaktır.`,
      );
    }

    if (
      matched.length === 0 &&
      criteria.length > 0
    ) {
      warnings.push(
        `Rakip Sınıf ${opponentClassNo} için benzerlik kriteri girildi ancak belirli bir müstenit sınıf seçilmedi. Kriterler genel avukat bulgusu olarak korunacaktır.`,
      );
    }

    if (
      !REFUSAL_SCOPE_MODES
        .has(
          row.refusalScopeMode,
        )
    ) {
      blockers.push(
        `Rakip Sınıf ${opponentClassNo} için ret kapsamı seçilmedi: sınıfın tamamı mı, sınıf içinde kısmi kapsam mı?`,
      );
    } else if (
      row.refusalScopeMode ===
      "partial"
    ) {
      const canonicalText =
        opponent
          .goodsByClass
          .find(
            (goods: any) =>
              Number(
                goods.classNo,
              ) ===
              opponentClassNo,
          )
          ?.text ??
        "";

      if (
        !normalizeText(
          row
            .refusalScopeText,
        )
      ) {
        blockers.push(
          `Rakip Sınıf ${opponentClassNo} için kısmi ret kapsamının exact mal/hizmet metni girilmedi.`,
        );
      } else if (
        !isPartialScopeSupported(
          canonicalText,
          row
            .refusalScopeText,
        )
      ) {
        blockers.push(
          `Rakip Sınıf ${opponentClassNo} için girilen kısmi ret kapsamı, rakip başvurunun kayıtlı mal/hizmet metniyle birebir eşleştirilemedi.`,
        );
      }
    }
  }

  if (
    (
      opponent
        .goodsByClass ??
      []
    ).length ===
    0
  ) {
    blockers.push(
      "Rakip başvurunun tam mal/hizmet kapsamı bulunamadı.",
    );
  }

  const sign =
    formData
      .signAssessment ??
    {};

  if (
    !normalizeText(
      sign
        .commonElements,
    )
  ) {
    blockers.push(
      "Ortak unsur / birebir ortaklık değerlendirilmedi.",
    );
  }

  if (
    !normalizeText(
      sign.differences,
    )
  ) {
    blockers.push(
      "Farklı unsur(lar) değerlendirilmedi.",
    );
  }

  const noCommon =
    isNoElementValue(
      sign
        .commonElements,
    );

  /*
   * Birebir ortak unsur yoksa bu iki alt tespit uygulanamaz.
   * Buna rağmen sign similarity tamamen değerlendirilebilir.
   */
  if (!noCommon) {
    if (
      !DISTINCTIVENESS_LEVELS
        .has(
          sign
            .commonElementDistinctiveness,
        )
    ) {
      blockers.push(
        "Ortak unsurun ayırt edicilik düzeyi seçilmedi.",
      );
    }

    if (
      !INDEPENDENT_ROLE_OPTIONS
        .has(
          sign
            .independentDistinctiveRole,
        )
    ) {
      blockers.push(
        "Bağımsız ayırt edici rol değerlendirilmedi.",
      );
    }
  }

  if (
    !normalizeText(
      sign
        .clientDominantElements,
    )
  ) {
    blockers.push(
      "Müstenit markanın baskın/ayırt edici unsuru değerlendirilmedi.",
    );
  }

  if (
    !normalizeText(
      sign
        .opponentDominantElements,
    )
  ) {
    blockers.push(
      "Rakip markanın baskın/ayırt edici unsuru değerlendirilmedi.",
    );
  }

  if (
    !normalizeText(
      sign
        .clientAdditionalElements,
    )
  ) {
    blockers.push(
      "Müstenit markanın ortak unsur dışındaki ek unsurları belirtilmedi.",
    );
  }

  if (
    !ELEMENT_DISTINCTIVENESS_LEVELS
      .has(
        sign
          .clientAdditionalDistinctiveness,
      )
  ) {
    blockers.push(
      "Müstenit markanın ek unsurlarının ayırt edicilik değerlendirmesi seçilmedi.",
    );
  }

  if (
    !ADDITIONAL_ELEMENT_ROLES
      .has(
        sign
          .clientAdditionalRole,
      )
  ) {
    blockers.push(
      "Müstenit markanın ek unsurlarının rolü seçilmedi.",
    );
  }

  if (
    !normalizeText(
      sign
        .opponentAdditionalElements,
    )
  ) {
    blockers.push(
      "Rakip markanın ortak unsur dışındaki ek unsurları belirtilmedi.",
    );
  }

  if (
    !ELEMENT_DISTINCTIVENESS_LEVELS
      .has(
        sign
          .opponentAdditionalDistinctiveness,
      )
  ) {
    blockers.push(
      "Rakip markanın ek unsurlarının ayırt edicilik değerlendirmesi seçilmedi.",
    );
  }

  if (
    !ADDITIONAL_ELEMENT_ROLES
      .has(
        sign
          .opponentAdditionalRole,
      )
  ) {
    blockers.push(
      "Rakip markanın ek unsurlarının rolü seçilmedi.",
    );
  }

  if (
    !SIGN_SIMILARITY_LEVELS
      .has(
        sign
          .visualSimilarity,
      )
  ) {
    blockers.push(
      "Görsel benzerlik derecesi seçilmedi.",
    );
  }

  if (
    !SIGN_SIMILARITY_LEVELS
      .has(
        sign
          .auralSimilarity,
      )
  ) {
    blockers.push(
      "İşitsel benzerlik derecesi seçilmedi.",
    );
  }

  if (
    !SIGN_SIMILARITY_LEVELS
      .has(
        sign
          .conceptualSimilarity,
      )
  ) {
    blockers.push(
      "Kavramsal benzerlik/farklılık değerlendirilmedi.",
    );
  }

  if (
    !SIGN_SIMILARITY_LEVELS
      .has(
        sign
          .overallSimilarity,
      )
  ) {
    blockers.push(
      "İşaretlerin genel izlenim benzerliği seçilmedi.",
    );
  }

  const publicAssessment =
    formData
      .publicAssessment ??
    {};

  if (
    !PUBLIC_TYPES
      .has(
        publicAssessment
          .publicType,
      )
  ) {
    blockers.push(
      "İlgili tüketici kesimi seçilmedi.",
    );
  }

  if (
    !ATTENTION_LEVELS
      .has(
        publicAssessment
          .attentionLevel,
      )
  ) {
    blockers.push(
      "Dikkat düzeyi seçilmedi.",
    );
  }

  const globalAssessment =
    formData
      .globalAssessment ??
    {};

  if (
    !GLOBAL_CONCLUSIONS
      .has(
        globalAssessment
          .conclusion,
      )
  ) {
    blockers.push(
      "6/1 global karıştırılma ihtimali sonucu seçilmedi.",
    );
  }

  if (
    !ASSOCIATION_LEVELS
      .has(
        globalAssessment
          .associationLikelihood,
      )
  ) {
    blockers.push(
      "İlişkilendirilme ihtimali sonucu seçilmedi.",
    );
  }

  if (
    normalizeText(
      globalAssessment
        .lawyerMerits,
    ).length <
    30
  ) {
    blockers.push(
      "Avukatın dosyaya özgü kısa değerlendirmesi en az 30 karakterlik kısa bir notla tamamlanmalı.",
    );
  }

  if (
    [
      "exists",
      "borderline",
    ].includes(
      globalAssessment
        .conclusion,
    ) &&
    requestedRefusalCount ===
      0
  ) {
    blockers.push(
      "Karıştırılma ihtimali sonucuna rağmen ret talep edilen en az bir rakip sınıf seçilmedi.",
    );
  }

  if (
    globalAssessment
      .conclusion ===
      "does_not_exist" &&
    requestedRefusalCount >
      0
  ) {
    blockers.push(
      "Global 6/1 sonucu 'karıştırılma ihtimali yok' iken ret kapsamı seçilmiş. Sonuç ve talep uyumlu değil.",
    );
  }

  if (
    globalAssessment
      .conclusion ===
    "borderline"
  ) {
    warnings.push(
      "Global sonuç sınırda olarak işaretlendi. Dilekçe üretiminde ihtiyatlı ve ölçülü argümantasyon kullanılmalı.",
    );
  }

  const canDraft =
    blockers.length ===
      0 &&
    [
      "exists",
      "borderline",
    ].includes(
      globalAssessment
        .conclusion,
    ) &&
    requestedRefusalCount >
      0;

  return {
    canDraft,

    blockers:
      [
        ...new Set(
          blockers,
        ),
      ],

    warnings:
      [
        ...new Set(
          warnings,
        ),
      ],

    requestedRefusalCount,

    checkedAt:
      new Date()
        .toISOString(),
  };
}

async function buildSourceFingerprint(
  oppositionCase: any,
  priorRights: any[],
  opponent: any,
) {
  const sourceObject = {
    oppositionCaseId:
      oppositionCase.id,

    selectedGrounds:
      oppositionCase
        .selected_grounds ??
      [],

    priorRights:
      priorRights.map(
        (right: any) => ({
          id:
            right.id,

          applicationNo:
            right
              .applicationNo,

          applicationDate:
            right
              .applicationDate,

          registrationNo:
            right
              .registrationNo,

          registrationDate:
            right
              .registrationDate,

          status:
            right.status,

          classes:
            (
              right.classes ??
              []
            ).map(
              (cls: any) => ({
                classNo:
                  cls.classNo,
                items:
                  cls.items ??
                  [],
              }),
            ),
        }),
      ),

    opponent: {
      applicationNo:
        opponent
          .applicationNo,

      applicationDate:
        opponent
          .applicationDate,

      markText:
        opponent
          .markText,

      goodsByClass:
        opponent
          .goodsByClass,
    },
  };

  return await sha256(
    JSON.stringify(
      sourceObject,
    ),
  );
}

async function buildContext(
  supabase:
    ReturnType<
      typeof createClient
    >,
  taskId: string,
) {
  const {
    task,
    oppositionCase,
  } =
    await loadCase(
      supabase,
      taskId,
    );

  const selectedGrounds =
    Array.isArray(
      oppositionCase
        .selected_grounds,
    )
      ? oppositionCase
          .selected_grounds
          .map(String)
      : [];

  const groundSelected =
    selectedGrounds
      .includes(
        "SMK_6_1",
      );

  const opponent =
    await loadOpponent(
      supabase,
      oppositionCase,
    );

  const {
    data:
      priorRows,
    error:
      priorRowsError,
  } =
    await supabase
      .from(
        "opposition_case_prior_marks",
      )
      .select("*")
      .eq(
        "opposition_case_id",
        oppositionCase.id,
      )
      .eq(
        "is_selected",
        true,
      )
      .order(
        "selection_order",
        {
          ascending:
            true,
        },
      );

  if (
    priorRowsError
  ) {
    throw new Error(
      `Müstenit haklar okunamadı: ${priorRowsError.message}`,
    );
  }

  const priorRights:
    any[] =
    [];

  for (
    const priorRow
    of priorRows ??
      []
  ) {
    priorRights.push(
      await loadPriorMark(
        supabase,
        String(
          priorRow
            .ip_record_id,
        ),
        opponent
          .applicationDate,
        priorRow,
      ),
    );
  }

  const sourceFingerprint =
    await buildSourceFingerprint(
      oppositionCase,
      priorRights,
      opponent,
    );

  const lawyerFindings =
    asObject(
      oppositionCase
        .lawyer_findings,
    );

  const saved =
    asObject(
      lawyerFindings
        .smk_6_1,
    );

  const savedFingerprint =
    normalizeText(
      saved
        .sourceFingerprint,
    );

  const stale =
    Boolean(
      savedFingerprint &&
      savedFingerprint !==
        sourceFingerprint,
    );

  const formData =
    buildDefaultForm(
      priorRights,
      opponent,
      saved,
    );

  const readiness =
    assessReadiness(
      formData,
      priorRights,
      opponent,
      groundSelected,
      stale,
    );

  return {
    packageVersion:
      PACKAGE_VERSION,

    enabled:
      groundSelected,

    stale,

    sourceFingerprint,

    savedAt:
      saved.updatedAt ??
      null,

    savedBy:
      saved.updatedBy ??
      null,

    task: {
      id:
        task.id,
      title:
        task.title,
      status:
        task.status,
    },

    case: {
      id:
        oppositionCase.id,
      status:
        oppositionCase
          .status,
      complexity:
        oppositionCase
          .complexity,
      selectedGrounds,
    },

    opponent,
    priorRights,
    formData,
    readiness,
  };
}

function sanitizePayload(
  payload: any,
  context: any,
) {
  const priorRights =
    context
      .priorRights ??
    [];

  const opponent =
    context
      .opponent ??
    {};

  const validPriorIds =
    new Set(
      priorRights
        .map(
          (right: any) =>
            String(
              right.id,
            ),
        ),
    );

  const validPriorClassKeys =
    buildAvailablePriorClassKeys(
      priorRights,
    );

  const validOpponentClasses =
    new Set(
      (
        opponent
          .goodsByClass ??
        []
      ).map(
        (row: any) =>
          Number(
            row.classNo,
          ),
      ),
    );

  const priorRightsReview =
    Array.isArray(
      payload
        .priorRightsReview,
    )
      ? payload
          .priorRightsReview
          .filter(
            (row: any) =>
              validPriorIds
                .has(
                  String(
                    row.ipRecordId,
                  ),
                ),
          )
          .map(
            (row: any) => ({
              ipRecordId:
                String(
                  row.ipRecordId,
                ),

              confirmedEligible:
                row
                  .confirmedEligible ===
                true,

              note:
                normalizeText(
                  row.note,
                ),
            }),
          )
      : [];

  const goodsAssessments =
    Array.isArray(
      payload
        .goodsAssessments,
    )
      ? payload
          .goodsAssessments
          .filter(
            (row: any) =>
              validOpponentClasses
                .has(
                  Number(
                    row.opponentClassNo,
                  ),
                ),
          )
          .map(
            (row: any) => {
              const opponentClassNo =
                Number(
                  row.opponentClassNo,
                );

              const opponentText =
                opponent
                  .goodsByClass
                  .find(
                    (goods: any) =>
                      Number(
                        goods.classNo,
                      ) ===
                      opponentClassNo,
                  )
                  ?.text ??
                "";

              const requestedRefusal =
                row
                  .requestedRefusal ===
                true;

              return {
                opponentClassNo,

                opponentText,

                similarityLevel:
                  requestedRefusal &&
                  GOODS_SIMILARITY_LEVELS
                    .has(
                      row
                        .similarityLevel,
                    )
                    ? row
                        .similarityLevel
                    : "not_assessed",

                matchedPriorClasses:
                  requestedRefusal
                    ? asStringArray(
                        row
                          .matchedPriorClasses,
                      )
                        .filter(
                          (key) =>
                            validPriorClassKeys
                              .has(
                                key,
                              ),
                        )
                    : [],

                criteria:
                  requestedRefusal
                    ? asStringArray(
                        row.criteria,
                      )
                        .filter(
                          (item) =>
                            GOODS_CRITERIA
                              .has(
                                item,
                              ),
                        )
                    : [],

                requestedRefusal,

                refusalScopeMode:
                  requestedRefusal
                    ? (
                        REFUSAL_SCOPE_MODES
                          .has(
                            row
                              .refusalScopeMode,
                          )
                          ? row
                              .refusalScopeMode
                          : "full_class"
                      )
                    : "",

                refusalScopeText:
                  requestedRefusal &&
                  (
                    !REFUSAL_SCOPE_MODES
                      .has(
                        row
                          .refusalScopeMode,
                      ) ||
                    row
                      .refusalScopeMode ===
                      "full_class"
                  )
                    ? opponentText
                    : requestedRefusal &&
                      row
                        .refusalScopeMode ===
                        "partial"
                      ? normalizeText(
                          row
                            .refusalScopeText,
                        )
                      : "",

                note:
                  normalizeText(
                    row.note,
                  ),
              };
            },
          )
      : [];

  const sign =
    asObject(
      payload
        .signAssessment,
    );

  const commonElements =
    normalizeText(
      sign
        .commonElements,
    );

  const noCommon =
    isNoElementValue(
      commonElements,
    );

  const clientAdditionalElements =
    normalizeText(
      sign
        .clientAdditionalElements,
    );

  const opponentAdditionalElements =
    normalizeText(
      sign
        .opponentAdditionalElements,
    );

  const clientNo =
    isNoElementValue(
      clientAdditionalElements,
    );

  const opponentNo =
    isNoElementValue(
      opponentAdditionalElements,
    );

  const publicAssessmentInput =
    asObject(
      payload
        .publicAssessment,
    );

  const global =
    asObject(
      payload
        .globalAssessment,
    );

  return {
    priorRightsReview,

    goodsAssessments,

    signAssessment: {
      commonElements,

      differences:
        normalizeText(
          sign.differences,
        ),

      commonElementDistinctiveness:
        !noCommon &&
        DISTINCTIVENESS_LEVELS
          .has(
            sign
              .commonElementDistinctiveness,
          )
          ? sign
              .commonElementDistinctiveness
          : "",

      clientDominantElements:
        normalizeText(
          sign
            .clientDominantElements,
        ),

      opponentDominantElements:
        normalizeText(
          sign
            .opponentDominantElements,
        ),

      clientAdditionalElements,

      clientAdditionalDistinctiveness:
        (
          noCommon ||
          clientNo
        )
          ? "not_applicable"
          : ELEMENT_DISTINCTIVENESS_LEVELS
              .has(
                sign
                  .clientAdditionalDistinctiveness,
              )
            ? sign
                .clientAdditionalDistinctiveness
            : "",

      clientAdditionalRole:
        (
          noCommon ||
          clientNo
        )
          ? "not_applicable"
          : ADDITIONAL_ELEMENT_ROLES
              .has(
                sign
                  .clientAdditionalRole,
              )
            ? sign
                .clientAdditionalRole
            : "",

      opponentAdditionalElements,

      opponentAdditionalDistinctiveness:
        (
          noCommon ||
          opponentNo
        )
          ? "not_applicable"
          : ELEMENT_DISTINCTIVENESS_LEVELS
              .has(
                sign
                  .opponentAdditionalDistinctiveness,
              )
            ? sign
                .opponentAdditionalDistinctiveness
            : "",

      opponentAdditionalRole:
        (
          noCommon ||
          opponentNo
        )
          ? "not_applicable"
          : ADDITIONAL_ELEMENT_ROLES
              .has(
                sign
                  .opponentAdditionalRole,
              )
            ? sign
                .opponentAdditionalRole
            : "",

      independentDistinctiveRole:
        noCommon
          ? "not_applicable"
          : INDEPENDENT_ROLE_OPTIONS
              .has(
                sign
                  .independentDistinctiveRole,
              )
            ? sign
                .independentDistinctiveRole
            : "",

      visualSimilarity:
        SIGN_SIMILARITY_LEVELS
          .has(
            sign
              .visualSimilarity,
          )
          ? sign
              .visualSimilarity
          : "",

      auralSimilarity:
        SIGN_SIMILARITY_LEVELS
          .has(
            sign
              .auralSimilarity,
          )
          ? sign
              .auralSimilarity
          : "",

      conceptualSimilarity:
        SIGN_SIMILARITY_LEVELS
          .has(
            sign
              .conceptualSimilarity,
          )
          ? sign
              .conceptualSimilarity
          : "",

      overallSimilarity:
        SIGN_SIMILARITY_LEVELS
          .has(
            sign
              .overallSimilarity,
          )
          ? sign
              .overallSimilarity
          : "",

      note:
        normalizeText(
          sign.note,
        ),
    },

    publicAssessment: {
      publicType:
        PUBLIC_TYPES
          .has(
            publicAssessmentInput
              .publicType,
          )
          ? publicAssessmentInput
              .publicType
          : "",

      attentionLevel:
        ATTENTION_LEVELS
          .has(
            publicAssessmentInput
              .attentionLevel,
          )
          ? publicAssessmentInput
              .attentionLevel
          : "",

      note:
        normalizeText(
          publicAssessmentInput
            .note,
        ),
    },

    globalAssessment: {
      conclusion:
        GLOBAL_CONCLUSIONS
          .has(
            global
              .conclusion,
          )
          ? global
              .conclusion
          : "exists",

      associationLikelihood:
        ASSOCIATION_LEVELS
          .has(
            global
              .associationLikelihood,
          )
          ? global
              .associationLikelihood
          : "exists",

      lawyerMerits:
        normalizeText(
          global
            .lawyerMerits,
        ),
    },
  };
}

async function saveAnalysis(
  supabase:
    ReturnType<
      typeof createClient
    >,
  taskId: string,
  currentUserId: string,
  payload: any,
) {
  const context =
    await buildContext(
      supabase,
      taskId,
    );

  if (
    !context.enabled
  ) {
    throw new HttpError(
      422,
      "SMK 6/1 dosyada seçili değil. Önce çalışma alanından 6/1 gerekçesini seçin.",
    );
  }

  const sanitized =
    sanitizePayload(
      payload,
      context,
    );

  const readiness =
    assessReadiness(
      sanitized,
      context
        .priorRights,
      context
        .opponent,
      true,
      false,
    );

  const {
    oppositionCase,
  } =
    await loadCase(
      supabase,
      taskId,
    );

  const currentLawyerFindings =
    asObject(
      oppositionCase
        .lawyer_findings,
    );

  const smk61Findings = {
    version:
      3,

    uxPackageVersion:
      PACKAGE_VERSION,

    sourceFingerprint:
      context
        .sourceFingerprint,

    ...sanitized,

    readiness,

    updatedAt:
      new Date()
        .toISOString(),

    updatedBy:
      currentUserId,
  };

  const nextLawyerFindings = {
    ...currentLawyerFindings,
    smk_6_1:
      smk61Findings,
  };

  const {
    error:
      updateError,
  } =
    await supabase
      .from(
        "opposition_cases",
      )
      .update({
        lawyer_findings:
          nextLawyerFindings,

        status:
          readiness
            .canDraft
            ? "drafting"
            : "analysis",
      })
      .eq(
        "id",
        oppositionCase.id,
      );

  if (
    updateError
  ) {
    throw new Error(
      `SMK 6/1 analizi kaydedilemedi: ${updateError.message}`,
    );
  }

  return await buildContext(
    supabase,
    taskId,
  );
}

serve(async (req) => {
  if (
    req.method ===
    "OPTIONS"
  ) {
    return new Response(
      "ok",
      {
        headers:
          corsHeaders,
      },
    );
  }

  try {
    const supabase =
      createClient(
        Deno.env.get(
          "SUPABASE_URL",
        ) ??
          "",

        Deno.env.get(
          "SUPABASE_SERVICE_ROLE_KEY",
        ) ??
          "",

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

    let context;

    if (
      action ===
      "get"
    ) {
      context =
        await buildContext(
          supabase,
          taskId,
        );
    } else if (
      action ===
      "save"
    ) {
      context =
        await saveAnalysis(
          supabase,
          taskId,
          currentUser.id,
          body.payload ??
            {},
        );
    } else {
      throw new HttpError(
        400,
        "Geçersiz action.",
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        context,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type":
            "application/json",
        },
      },
    );
  } catch (error) {
    const status =
      error instanceof
        HttpError
        ? [
            401,
            403,
          ].includes(
            error.status,
          )
          ? error.status
          : 200
        : 500;

    const message =
      error instanceof
        Error
        ? error.message
        : "Bilinmeyen hata";

    console.error(
      "❌ opposition-analysis:",
      message,
    );

    return new Response(
      JSON.stringify({
        success: false,
        error: message,
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
