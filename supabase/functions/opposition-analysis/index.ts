import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function asObject(value: unknown): Record<string, any> {
  if (!value) return {};

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  return {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean),
  )];
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;

  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function calculateProofRisk(
  registrationDate?: string | null,
  opponentApplicationDate?: string | null,
): boolean | null {
  const registration = parseDate(registrationDate);
  const opposed = parseDate(opponentApplicationDate);

  if (!registration || !opposed) return null;

  const fiveYearsLater = new Date(registration);
  fiveYearsLater.setUTCFullYear(fiveYearsLater.getUTCFullYear() + 5);

  return fiveYearsLater <= opposed;
}

function compareDates(
  earlierDate?: string | null,
  laterDate?: string | null,
): number | null {
  const earlier = parseDate(earlierDate);
  const later = parseDate(laterDate);

  if (!earlier || !later) return null;

  if (earlier.getTime() < later.getTime()) return -1;
  if (earlier.getTime() > later.getTime()) return 1;
  return 0;
}

async function sha256(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function assertInternalUser(
  req: Request,
  supabase: ReturnType<typeof createClient>,
) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    throw new HttpError(401, "Oturum bilgisi bulunamadı.");
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(token);

  if (authError || !authData.user) {
    throw new HttpError(401, "Geçersiz veya süresi dolmuş oturum.");
  }

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id, role, disabled")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    throw new HttpError(403, "IP GATE kullanıcı profili bulunamadı.");
  }

  if (profile.disabled) {
    throw new HttpError(403, "Kullanıcı hesabı pasif.");
  }

  if (!["user", "admin", "superadmin"].includes(String(profile.role ?? ""))) {
    throw new HttpError(403, "Bu hukuki çalışma alanına erişim yetkiniz bulunmuyor.");
  }

  return {
    id: authData.user.id,
    role: profile.role,
  };
}

async function loadCase(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
) {
  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, task_type_id, title, status")
    .eq("id", taskId)
    .maybeSingle();

  if (taskError) {
    throw new Error(`Görev okunamadı: ${taskError.message}`);
  }

  if (!task) {
    throw new HttpError(404, "Görev bulunamadı.");
  }

  if (String(task.task_type_id) !== "20") {
    throw new HttpError(400, "SMK 6/1 analiz motoru yalnız yayıma itiraz görevlerinde kullanılabilir.");
  }

  const { data: oppositionCase, error: caseError } = await supabase
    .from("opposition_cases")
    .select("*")
    .eq("task_id", taskId)
    .maybeSingle();

  if (caseError) {
    throw new Error(`Opposition Case okunamadı: ${caseError.message}`);
  }

  if (!oppositionCase) {
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
  supabase: ReturnType<typeof createClient>,
  ipRecordId: string,
  opponentApplicationDate?: string | null,
  priorRow?: any,
) {
  const [recordRes, detailsRes, classesRes] = await Promise.all([
    supabase
      .from("ip_records")
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
      .eq("id", ipRecordId)
      .maybeSingle(),

    supabase
      .from("ip_record_trademark_details")
      .select("brand_name, brand_type, brand_image_url")
      .eq("ip_record_id", ipRecordId)
      .maybeSingle(),

    supabase
      .from("ip_record_classes")
      .select("class_no, items")
      .eq("ip_record_id", ipRecordId)
      .order("class_no", { ascending: true }),
  ]);

  if (recordRes.error || !recordRes.data) {
    throw new Error(
      `Müstenit marka ana kaydı okunamadı (${ipRecordId}): ${recordRes.error?.message ?? "Kayıt bulunamadı"}`,
    );
  }

  if (detailsRes.error) {
    throw new Error(`Müstenit marka detayı okunamadı: ${detailsRes.error.message}`);
  }

  if (classesRes.error) {
    throw new Error(`Müstenit marka emtiası okunamadı: ${classesRes.error.message}`);
  }

  const record = recordRes.data;
  const classes = (classesRes.data ?? []).map((row: any) => ({
    classNo: Number(row.class_no),
    items: Array.isArray(row.items) ? row.items : [],
  }));

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!detailsRes.data?.brand_name) {
    blockers.push("Marka adı kayıtlı değil.");
  }

  if (!record.application_number) {
    blockers.push("Başvuru numarası kayıtlı değil.");
  }

  if (!record.application_date) {
    blockers.push("Başvuru tarihi kayıtlı değil; tarihsel öncelik teyit edilemiyor.");
  }

  if (classes.length === 0) {
    blockers.push("Müstenit markanın mal/hizmet kapsamı bulunamadı.");
  }

  const priorityComparison = compareDates(
    record.application_date,
    opponentApplicationDate,
  );

  if (priorityComparison === 0) {
    blockers.push("Müstenit marka ile itiraz edilen başvurunun başvuru tarihleri aynı görünüyor; öncelik ayrıca teyit edilmeli.");
  } else if (priorityComparison === 1) {
    blockers.push("Müstenit markanın başvuru tarihi itiraz edilen başvurudan daha sonraki görünüyor.");
  } else if (priorityComparison === null) {
    warnings.push("Başvuru tarihleri otomatik olarak karşılaştırılamadı.");
  }

  const proofRiskFromRow = priorRow?.proof_of_use_required;
  const proofRisk = typeof proofRiskFromRow === "boolean"
    ? proofRiskFromRow
    : calculateProofRisk(record.registration_date, opponentApplicationDate);

  if (proofRisk === true) {
    warnings.push("Beş yıllık kullanım ispatı dönemi bakımından ayrıca kontrol gerekli.");
  } else if (proofRisk === null) {
    warnings.push("Kullanım ispatı ön kontrolü için yeterli tarih verisi yok.");
  }

  if (record.status) {
    warnings.push(`Sicil statüsü: ${record.status}. Müstenit hak olarak kullanılabilirliği avukat tarafından teyit edilmeli.`);
  }

  return {
    id: record.id,
    markText: detailsRes.data?.brand_name ?? "",
    markType: detailsRes.data?.brand_type ?? null,
    imageUrl: detailsRes.data?.brand_image_url ?? null,
    status: record.status,
    portfolioStatus: record.portfolio_status,
    origin: record.origin,
    countryCode: record.country_code,
    applicationNo: record.application_number,
    applicationDate: record.application_date,
    registrationNo: record.registration_number,
    registrationDate: record.registration_date,
    renewalDate: record.renewal_date,
    proofOfUseRequired: proofRisk,
    proofOfUseStatus: priorRow?.proof_of_use_status ?? "unknown",
    classes,
    autoChecks: {
      blockers,
      warnings,
    },
  };
}

function groupBulletinGoods(rows: any[]): Array<{ classNo: number; text: string }> {
  const grouped = new Map<number, string[]>();

  for (const row of rows ?? []) {
    const classNo = Number(row.class_number);
    if (!Number.isFinite(classNo)) continue;

    if (!grouped.has(classNo)) grouped.set(classNo, []);

    const text = normalizeText(row.class_text);
    if (text) grouped.get(classNo)!.push(text);
  }

  return [...grouped.entries()]
    .map(([classNo, texts]) => ({
      classNo,
      text: [...new Set(texts)].join("\n"),
    }))
    .sort((a, b) => a.classNo - b.classNo);
}

async function loadOpponent(
  supabase: ReturnType<typeof createClient>,
  oppositionCase: any,
) {
  let applicationNo: string | null = null;
  let applicationDate: string | null = null;
  let markText: string | null = null;
  let niceClasses: string[] = [];
  let goodsByClass: Array<{ classNo: number; text: string }> = [];

  if (oppositionCase.bulletin_record_id) {
    const { data: bulletinRecord, error: bulletinRecordError } = await supabase
      .from("trademark_bulletin_records")
      .select("id, application_number, application_date, brand_name, nice_classes")
      .eq("id", oppositionCase.bulletin_record_id)
      .maybeSingle();

    if (bulletinRecordError) {
      throw new Error(`Rakip bülten kaydı okunamadı: ${bulletinRecordError.message}`);
    }

    if (bulletinRecord) {
      applicationNo = bulletinRecord.application_number ?? null;
      applicationDate = bulletinRecord.application_date ?? null;
      markText = bulletinRecord.brand_name ?? null;
      niceClasses = Array.isArray(bulletinRecord.nice_classes)
        ? bulletinRecord.nice_classes.map(String)
        : [];
    }

    const { data: goods, error: goodsError } = await supabase
      .from("trademark_bulletin_goods")
      .select("class_number, class_text")
      .eq("bulletin_record_id", oppositionCase.bulletin_record_id)
      .order("class_number", { ascending: true });

    if (goodsError) {
      throw new Error(`Rakip mal/hizmet listesi okunamadı: ${goodsError.message}`);
    }

    goodsByClass = groupBulletinGoods(goods ?? []);
  }

  const [recordRes, detailsRes, classesRes] = await Promise.all([
    supabase
      .from("ip_records")
      .select("application_number, application_date")
      .eq("id", oppositionCase.opposed_ip_record_id)
      .maybeSingle(),

    supabase
      .from("ip_record_trademark_details")
      .select("brand_name")
      .eq("ip_record_id", oppositionCase.opposed_ip_record_id)
      .maybeSingle(),

    supabase
      .from("ip_record_classes")
      .select("class_no, items")
      .eq("ip_record_id", oppositionCase.opposed_ip_record_id)
      .order("class_no", { ascending: true }),
  ]);

  if (recordRes.error) {
    throw new Error(`Rakip IP kaydı okunamadı: ${recordRes.error.message}`);
  }

  if (detailsRes.error) {
    throw new Error(`Rakip marka detayı okunamadı: ${detailsRes.error.message}`);
  }

  if (classesRes.error) {
    throw new Error(`Rakip portföy emtiası okunamadı: ${classesRes.error.message}`);
  }

  applicationNo = applicationNo ?? recordRes.data?.application_number ?? null;
  applicationDate = applicationDate ?? recordRes.data?.application_date ?? null;
  markText = markText ?? detailsRes.data?.brand_name ?? null;

  if (goodsByClass.length === 0 && classesRes.data?.length) {
    goodsByClass = (classesRes.data ?? [])
      .map((row: any) => ({
        classNo: Number(row.class_no),
        text: Array.isArray(row.items) ? row.items.join("\n") : "",
      }))
      .filter((row: any) => Number.isFinite(row.classNo));
  }

  if (niceClasses.length === 0) {
    niceClasses = goodsByClass.map((row) => String(row.classNo));
  }

  return {
    ipRecordId: oppositionCase.opposed_ip_record_id,
    bulletinRecordId: oppositionCase.bulletin_record_id,
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
  saved: Record<string, any>,
) {
  const savedPriorReview = Array.isArray(saved.priorRightsReview)
    ? saved.priorRightsReview
    : [];

  const savedGoods = Array.isArray(saved.goodsAssessments)
    ? saved.goodsAssessments
    : [];

  const priorRightsReview = priorRights.map((right: any) => {
    const existing = savedPriorReview.find(
      (row: any) => String(row.ipRecordId) === String(right.id),
    );

    return {
      ipRecordId: right.id,
      confirmedEligible: existing?.confirmedEligible === true,
      note: normalizeText(existing?.note),
    };
  });

  const goodsAssessments = opponent.goodsByClass.map((goods: any) => {
    const existing = savedGoods.find(
      (row: any) => Number(row.opponentClassNo) === Number(goods.classNo),
    );

    return {
      opponentClassNo: Number(goods.classNo),
      opponentText: goods.text ?? "",
      similarityLevel: GOODS_SIMILARITY_LEVELS.has(existing?.similarityLevel)
        ? existing.similarityLevel
        : "not_assessed",
      matchedPriorClasses: asStringArray(existing?.matchedPriorClasses),
      criteria: asStringArray(existing?.criteria).filter((item) => GOODS_CRITERIA.has(item)),
      requestedRefusal: existing?.requestedRefusal === true,
      note: normalizeText(existing?.note),
    };
  });

  const signAssessment = {
    commonElements: normalizeText(saved.signAssessment?.commonElements),
    differences: normalizeText(saved.signAssessment?.differences),
    commonElementDistinctiveness: DISTINCTIVENESS_LEVELS.has(saved.signAssessment?.commonElementDistinctiveness)
      ? saved.signAssessment.commonElementDistinctiveness
      : "",
    clientDominantElements: normalizeText(saved.signAssessment?.clientDominantElements),
    opponentDominantElements: normalizeText(saved.signAssessment?.opponentDominantElements),
    additionalElementsRole: ADDITIONAL_ELEMENT_ROLES.has(saved.signAssessment?.additionalElementsRole)
      ? saved.signAssessment.additionalElementsRole
      : "",
    independentDistinctiveRole: INDEPENDENT_ROLE_OPTIONS.has(saved.signAssessment?.independentDistinctiveRole)
      ? saved.signAssessment.independentDistinctiveRole
      : "",
    visualSimilarity: SIGN_SIMILARITY_LEVELS.has(saved.signAssessment?.visualSimilarity)
      ? saved.signAssessment.visualSimilarity
      : "",
    auralSimilarity: SIGN_SIMILARITY_LEVELS.has(saved.signAssessment?.auralSimilarity)
      ? saved.signAssessment.auralSimilarity
      : "",
    conceptualSimilarity: SIGN_SIMILARITY_LEVELS.has(saved.signAssessment?.conceptualSimilarity)
      ? saved.signAssessment.conceptualSimilarity
      : "",
    overallSimilarity: SIGN_SIMILARITY_LEVELS.has(saved.signAssessment?.overallSimilarity)
      ? saved.signAssessment.overallSimilarity
      : "",
    note: normalizeText(saved.signAssessment?.note),
  };

  const publicAssessment = {
    publicType: PUBLIC_TYPES.has(saved.publicAssessment?.publicType)
      ? saved.publicAssessment.publicType
      : "",
    attentionLevel: ATTENTION_LEVELS.has(saved.publicAssessment?.attentionLevel)
      ? saved.publicAssessment.attentionLevel
      : "",
    note: normalizeText(saved.publicAssessment?.note),
  };

  const globalAssessment = {
    conclusion: GLOBAL_CONCLUSIONS.has(saved.globalAssessment?.conclusion)
      ? saved.globalAssessment.conclusion
      : "",
    associationLikelihood: ASSOCIATION_LEVELS.has(saved.globalAssessment?.associationLikelihood)
      ? saved.globalAssessment.associationLikelihood
      : "",
    lawyerMerits: normalizeText(saved.globalAssessment?.lawyerMerits),
  };

  return {
    priorRightsReview,
    goodsAssessments,
    signAssessment,
    publicAssessment,
    globalAssessment,
  };
}

function buildAvailablePriorClassKeys(priorRights: any[]): Set<string> {
  const keys = new Set<string>();

  for (const right of priorRights) {
    for (const cls of right.classes ?? []) {
      keys.add(`${right.id}:${Number(cls.classNo)}`);
    }
  }

  return keys;
}

function assessReadiness(
  formData: any,
  priorRights: any[],
  opponent: any,
  groundSelected: boolean,
  stale = false,
) {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!groundSelected) {
    blockers.push("SMK 6/1 itiraz gerekçesi dosyada seçili değil.");
  }

  if (stale) {
    blockers.push("Müstenit haklar veya rakip kapsam değişti. 6/1 analizi güncellenip yeniden kaydedilmeli.");
  }

  if (priorRights.length === 0) {
    blockers.push("Seçili müstenit marka bulunmuyor.");
  }

  const priorReviewMap = new Map(
    (formData.priorRightsReview ?? []).map((row: any) => [String(row.ipRecordId), row]),
  );

  for (const right of priorRights) {
    const review: any = priorReviewMap.get(String(right.id));

    if (!review?.confirmedEligible) {
      blockers.push(`Müstenit hak uygunluğu teyit edilmedi: ${right.markText || right.applicationNo || right.id}`);
    }

    for (const blocker of right.autoChecks?.blockers ?? []) {
      blockers.push(`${right.markText || right.applicationNo}: ${blocker}`);
    }

    for (const warning of right.autoChecks?.warnings ?? []) {
      warnings.push(`${right.markText || right.applicationNo}: ${warning}`);
    }
  }

  const availablePriorClassKeys = buildAvailablePriorClassKeys(priorRights);
  const currentOpponentClasses = new Set(
    (opponent.goodsByClass ?? []).map((row: any) => Number(row.classNo)),
  );

  const goodsMap = new Map(
    (formData.goodsAssessments ?? []).map((row: any) => [Number(row.opponentClassNo), row]),
  );

  let requestedRefusalCount = 0;

  for (const opponentClassNo of currentOpponentClasses) {
    const row: any = goodsMap.get(opponentClassNo);

    if (!row) {
      blockers.push(`Rakip Sınıf ${opponentClassNo} için mal/hizmet değerlendirmesi yok.`);
      continue;
    }

    if (!GOODS_SIMILARITY_LEVELS.has(row.similarityLevel) || row.similarityLevel === "not_assessed") {
      blockers.push(`Rakip Sınıf ${opponentClassNo} için benzerlik derecesi seçilmedi.`);
      continue;
    }

    const matched = asStringArray(row.matchedPriorClasses);
    const criteria = asStringArray(row.criteria).filter((item) => GOODS_CRITERIA.has(item));

    if (row.similarityLevel !== "none") {
      if (matched.length === 0) {
        blockers.push(`Rakip Sınıf ${opponentClassNo} için dayanılan müstenit sınıf seçilmedi.`);
      }

      if (criteria.length === 0) {
        blockers.push(`Rakip Sınıf ${opponentClassNo} için mal/hizmet benzerliği kriteri seçilmedi.`);
      }
    }

    for (const key of matched) {
      if (!availablePriorClassKeys.has(key)) {
        blockers.push(`Rakip Sınıf ${opponentClassNo} için artık seçili olmayan/geçersiz bir müstenit sınıf eşleştirmesi var.`);
      }
    }

    if (row.requestedRefusal === true) {
      requestedRefusalCount += 1;

      if (row.similarityLevel === "none") {
        blockers.push(`Rakip Sınıf ${opponentClassNo} bakımından "benzer değil" sonucu varken ret talebi işaretlenmiş.`);
      }
    }
  }

  if ((opponent.goodsByClass ?? []).length === 0) {
    blockers.push("Rakip başvurunun tam mal/hizmet kapsamı bulunamadı.");
  }

  const sign = formData.signAssessment ?? {};

  if (!normalizeText(sign.commonElements)) blockers.push("Ortak unsur(lar) değerlendirilmedi.");
  if (!normalizeText(sign.differences)) blockers.push("Farklı unsur(lar) değerlendirilmedi.");
  if (!DISTINCTIVENESS_LEVELS.has(sign.commonElementDistinctiveness)) blockers.push("Ortak unsurun ayırt edicilik düzeyi seçilmedi.");
  if (!normalizeText(sign.clientDominantElements)) blockers.push("Müstenit markanın baskın/ayırt edici unsuru değerlendirilmedi.");
  if (!normalizeText(sign.opponentDominantElements)) blockers.push("Rakip markanın baskın/ayırt edici unsuru değerlendirilmedi.");
  if (!ADDITIONAL_ELEMENT_ROLES.has(sign.additionalElementsRole)) blockers.push("Ek unsurların rolü değerlendirilmedi.");
  if (!INDEPENDENT_ROLE_OPTIONS.has(sign.independentDistinctiveRole)) blockers.push("Bağımsız ayırt edici rol değerlendirilmedi.");
  if (!SIGN_SIMILARITY_LEVELS.has(sign.visualSimilarity)) blockers.push("Görsel benzerlik derecesi seçilmedi.");
  if (!SIGN_SIMILARITY_LEVELS.has(sign.auralSimilarity)) blockers.push("İşitsel benzerlik derecesi seçilmedi.");
  if (!SIGN_SIMILARITY_LEVELS.has(sign.conceptualSimilarity)) blockers.push("Kavramsal benzerlik/farklılık değerlendirilmedi.");
  if (!SIGN_SIMILARITY_LEVELS.has(sign.overallSimilarity)) blockers.push("İşaretlerin genel izlenim benzerliği seçilmedi.");

  const publicAssessment = formData.publicAssessment ?? {};

  if (!PUBLIC_TYPES.has(publicAssessment.publicType)) blockers.push("İlgili tüketici kesimi seçilmedi.");
  if (!ATTENTION_LEVELS.has(publicAssessment.attentionLevel)) blockers.push("Dikkat düzeyi seçilmedi.");

  const globalAssessment = formData.globalAssessment ?? {};

  if (!GLOBAL_CONCLUSIONS.has(globalAssessment.conclusion)) blockers.push("6/1 global karıştırılma ihtimali sonucu seçilmedi.");
  if (!ASSOCIATION_LEVELS.has(globalAssessment.associationLikelihood)) blockers.push("İlişkilendirilme ihtimali sonucu seçilmedi.");

  if (normalizeText(globalAssessment.lawyerMerits).length < 30) {
    blockers.push("Avukatın dosyaya özgü kısa değerlendirmesi çok kısa veya boş. Yaklaşık 3–8 cümlelik somut değerlendirme girilmeli.");
  }

  if (["exists", "borderline"].includes(globalAssessment.conclusion) && requestedRefusalCount === 0) {
    blockers.push("Karıştırılma ihtimali sonucuna rağmen ret talep edilen en az bir rakip sınıf seçilmedi.");
  }

  if (globalAssessment.conclusion === "does_not_exist" && requestedRefusalCount > 0) {
    blockers.push("Global 6/1 sonucu 'karıştırılma ihtimali yok' iken ret kapsamı seçilmiş. Sonuç ve talep uyumlu değil.");
  }

  if (globalAssessment.conclusion === "borderline") {
    warnings.push("Global sonuç sınırda olarak işaretlendi. Dilekçe üretiminde ihtiyatlı ve ölçülü argümantasyon kullanılmalı.");
  }

  const canDraft =
    blockers.length === 0 &&
    ["exists", "borderline"].includes(globalAssessment.conclusion) &&
    requestedRefusalCount > 0;

  return {
    canDraft,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    requestedRefusalCount,
    checkedAt: new Date().toISOString(),
  };
}

async function buildSourceFingerprint(
  oppositionCase: any,
  priorRights: any[],
  opponent: any,
) {
  const sourceObject = {
    oppositionCaseId: oppositionCase.id,
    selectedGrounds: oppositionCase.selected_grounds ?? [],
    priorRights: priorRights.map((right: any) => ({
      id: right.id,
      applicationNo: right.applicationNo,
      applicationDate: right.applicationDate,
      registrationNo: right.registrationNo,
      registrationDate: right.registrationDate,
      status: right.status,
      classes: (right.classes ?? []).map((cls: any) => ({
        classNo: cls.classNo,
        items: cls.items ?? [],
      })),
    })),
    opponent: {
      applicationNo: opponent.applicationNo,
      applicationDate: opponent.applicationDate,
      markText: opponent.markText,
      goodsByClass: opponent.goodsByClass,
    },
  };

  return await sha256(JSON.stringify(sourceObject));
}

async function buildContext(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
) {
  const { task, oppositionCase } = await loadCase(supabase, taskId);
  const selectedGrounds = Array.isArray(oppositionCase.selected_grounds)
    ? oppositionCase.selected_grounds.map(String)
    : [];
  const groundSelected = selectedGrounds.includes("SMK_6_1");

  const opponent = await loadOpponent(supabase, oppositionCase);

  const { data: priorRows, error: priorRowsError } = await supabase
    .from("opposition_case_prior_marks")
    .select("*")
    .eq("opposition_case_id", oppositionCase.id)
    .eq("is_selected", true)
    .order("selection_order", { ascending: true });

  if (priorRowsError) {
    throw new Error(`Müstenit haklar okunamadı: ${priorRowsError.message}`);
  }

  const priorRights: any[] = [];

  for (const priorRow of priorRows ?? []) {
    priorRights.push(
      await loadPriorMark(
        supabase,
        String(priorRow.ip_record_id),
        opponent.applicationDate,
        priorRow,
      ),
    );
  }

  const sourceFingerprint = await buildSourceFingerprint(
    oppositionCase,
    priorRights,
    opponent,
  );

  const lawyerFindings = asObject(oppositionCase.lawyer_findings);
  const saved = asObject(lawyerFindings.smk_6_1);
  const savedFingerprint = normalizeText(saved.sourceFingerprint);
  const stale = Boolean(savedFingerprint && savedFingerprint !== sourceFingerprint);

  const formData = buildDefaultForm(priorRights, opponent, saved);
  const readiness = assessReadiness(
    formData,
    priorRights,
    opponent,
    groundSelected,
    stale,
  );

  return {
    enabled: groundSelected,
    stale,
    sourceFingerprint,
    savedAt: saved.updatedAt ?? null,
    savedBy: saved.updatedBy ?? null,
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
    },
    case: {
      id: oppositionCase.id,
      status: oppositionCase.status,
      complexity: oppositionCase.complexity,
      selectedGrounds,
    },
    opponent,
    priorRights,
    formData,
    readiness,
  };
}

function sanitizePayload(payload: any, context: any) {
  const priorRights = context.priorRights ?? [];
  const opponent = context.opponent ?? {};
  const validPriorIds = new Set(priorRights.map((right: any) => String(right.id)));
  const validPriorClassKeys = buildAvailablePriorClassKeys(priorRights);
  const validOpponentClasses = new Set(
    (opponent.goodsByClass ?? []).map((row: any) => Number(row.classNo)),
  );

  const priorRightsReview = Array.isArray(payload.priorRightsReview)
    ? payload.priorRightsReview
      .filter((row: any) => validPriorIds.has(String(row.ipRecordId)))
      .map((row: any) => ({
        ipRecordId: String(row.ipRecordId),
        confirmedEligible: row.confirmedEligible === true,
        note: normalizeText(row.note),
      }))
    : [];

  const goodsAssessments = Array.isArray(payload.goodsAssessments)
    ? payload.goodsAssessments
      .filter((row: any) => validOpponentClasses.has(Number(row.opponentClassNo)))
      .map((row: any) => ({
        opponentClassNo: Number(row.opponentClassNo),
        opponentText:
          opponent.goodsByClass.find(
            (goods: any) => Number(goods.classNo) === Number(row.opponentClassNo),
          )?.text ?? "",
        similarityLevel: GOODS_SIMILARITY_LEVELS.has(row.similarityLevel)
          ? row.similarityLevel
          : "not_assessed",
        matchedPriorClasses: asStringArray(row.matchedPriorClasses)
          .filter((key) => validPriorClassKeys.has(key)),
        criteria: asStringArray(row.criteria)
          .filter((item) => GOODS_CRITERIA.has(item)),
        requestedRefusal: row.requestedRefusal === true,
        note: normalizeText(row.note),
      }))
    : [];

  const sign = asObject(payload.signAssessment);
  const publicAssessmentInput = asObject(payload.publicAssessment);
  const global = asObject(payload.globalAssessment);

  return {
    priorRightsReview,
    goodsAssessments,
    signAssessment: {
      commonElements: normalizeText(sign.commonElements),
      differences: normalizeText(sign.differences),
      commonElementDistinctiveness: DISTINCTIVENESS_LEVELS.has(sign.commonElementDistinctiveness)
        ? sign.commonElementDistinctiveness
        : "",
      clientDominantElements: normalizeText(sign.clientDominantElements),
      opponentDominantElements: normalizeText(sign.opponentDominantElements),
      additionalElementsRole: ADDITIONAL_ELEMENT_ROLES.has(sign.additionalElementsRole)
        ? sign.additionalElementsRole
        : "",
      independentDistinctiveRole: INDEPENDENT_ROLE_OPTIONS.has(sign.independentDistinctiveRole)
        ? sign.independentDistinctiveRole
        : "",
      visualSimilarity: SIGN_SIMILARITY_LEVELS.has(sign.visualSimilarity)
        ? sign.visualSimilarity
        : "",
      auralSimilarity: SIGN_SIMILARITY_LEVELS.has(sign.auralSimilarity)
        ? sign.auralSimilarity
        : "",
      conceptualSimilarity: SIGN_SIMILARITY_LEVELS.has(sign.conceptualSimilarity)
        ? sign.conceptualSimilarity
        : "",
      overallSimilarity: SIGN_SIMILARITY_LEVELS.has(sign.overallSimilarity)
        ? sign.overallSimilarity
        : "",
      note: normalizeText(sign.note),
    },
    publicAssessment: {
      publicType: PUBLIC_TYPES.has(publicAssessmentInput.publicType)
        ? publicAssessmentInput.publicType
        : "",
      attentionLevel: ATTENTION_LEVELS.has(publicAssessmentInput.attentionLevel)
        ? publicAssessmentInput.attentionLevel
        : "",
      note: normalizeText(publicAssessmentInput.note),
    },
    globalAssessment: {
      conclusion: GLOBAL_CONCLUSIONS.has(global.conclusion)
        ? global.conclusion
        : "",
      associationLikelihood: ASSOCIATION_LEVELS.has(global.associationLikelihood)
        ? global.associationLikelihood
        : "",
      lawyerMerits: normalizeText(global.lawyerMerits),
    },
  };
}

async function saveAnalysis(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  currentUserId: string,
  payload: any,
) {
  const context = await buildContext(supabase, taskId);

  if (!context.enabled) {
    throw new HttpError(422, "SMK 6/1 dosyada seçili değil. Önce çalışma alanından 6/1 gerekçesini seçin.");
  }

  const sanitized = sanitizePayload(payload, context);
  const readiness = assessReadiness(
    sanitized,
    context.priorRights,
    context.opponent,
    true,
    false,
  );

  const { oppositionCase } = await loadCase(supabase, taskId);
  const currentLawyerFindings = asObject(oppositionCase.lawyer_findings);

  const smk61Findings = {
    version: 1,
    sourceFingerprint: context.sourceFingerprint,
    ...sanitized,
    readiness,
    updatedAt: new Date().toISOString(),
    updatedBy: currentUserId,
  };

  const nextLawyerFindings = {
    ...currentLawyerFindings,
    smk_6_1: smk61Findings,
  };

  const { error: updateError } = await supabase
    .from("opposition_cases")
    .update({
      lawyer_findings: nextLawyerFindings,
      status: readiness.canDraft ? "drafting" : "analysis",
    })
    .eq("id", oppositionCase.id);

  if (updateError) {
    throw new Error(`SMK 6/1 analizi kaydedilemedi: ${updateError.message}`);
  }

  return await buildContext(supabase, taskId);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );

    const currentUser = await assertInternalUser(req, supabase);
    const body = await req.json();
    const action = String(body.action ?? "get");
    const taskId = String(body.taskId ?? "").trim();

    if (!taskId) {
      throw new HttpError(400, "taskId zorunludur.");
    }

    let context;

    if (action === "get") {
      context = await buildContext(supabase, taskId);
    } else if (action === "save") {
      context = await saveAnalysis(
        supabase,
        taskId,
        currentUser.id,
        body.payload ?? {},
      );
    } else {
      throw new HttpError(400, "Geçersiz action.");
    }

    return new Response(
      JSON.stringify({
        success: true,
        context,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    const status = error instanceof HttpError
      ? ([401, 403].includes(error.status) ? error.status : 200)
      : 500;

    const message = error instanceof Error
      ? error.message
      : "Bilinmeyen hata";

    console.error("❌ opposition-analysis:", message);

    return new Response(
      JSON.stringify({
        success: false,
        error: message,
      }),
      {
        status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
