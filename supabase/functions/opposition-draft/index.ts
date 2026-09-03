import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeForSearch(value: unknown): string {
  return String(value ?? "")
    .toLocaleLowerCase("tr-TR")
    .replace(/[^a-z0-9çğıöşü]+/gi, " ")
    .replace(/[\s\u00A0]+/g, " ")
    .trim();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean),
  )];
}

function parseHolderNames(value: unknown): string[] {
  if (!value) return [];

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      return parseHolderNames(JSON.parse(trimmed));
    } catch {
      return [trimmed];
    }
  }

  if (Array.isArray(value)) {
    return [...new Set(
      value
        .flatMap((item) => {
          if (typeof item === "string") return [item.trim()];
          if (!item || typeof item !== "object") return [];

          const candidate =
            item.name ??
            item.holderName ??
            item.title ??
            item.ownerName ??
            item.applicantName ??
            null;

          return candidate ? [String(candidate).trim()] : [];
        })
        .filter(Boolean),
    )];
  }

  if (typeof value === "object") {
    const obj = value as Record<string, any>;

    const candidate =
      obj.name ??
      obj.holderName ??
      obj.title ??
      obj.ownerName ??
      obj.applicantName ??
      null;

    return candidate
      ? [String(candidate).trim()]
      : [];
  }

  return [];
}


async function assertInternalUser(
  req: Request,
  supabase: ReturnType<typeof createClient>,
) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

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
      "Bu dilekçe çalışma alanına erişim yetkiniz bulunmuyor.",
    );
  }

  return {
    id: authData.user.id,
    token,
  };
}


async function callFunction(
  supabaseUrl: string,
  functionName: string,
  token: string,
  body: any,
) {
  const response = await fetch(
    `${supabaseUrl}/functions/v1/${functionName}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new HttpError(
      response.status,
      data?.error ||
      `${functionName} çağrısı başarısız oldu.`,
    );
  }

  if (data?.success === false) {
    throw new HttpError(
      422,
      data.error ||
      `${functionName} işlemi başarısız oldu.`,
    );
  }

  return data;
}


async function loadAnalysisContext(
  supabaseUrl: string,
  token: string,
  taskId: string,
) {
  const data = await callFunction(
    supabaseUrl,
    "opposition-analysis",
    token,
    {
      action: "get",
      taskId,
    },
  );

  if (!data?.context) {
    throw new HttpError(
      422,
      "SMK 6/1 analiz bağlamı alınamadı.",
    );
  }

  return data.context;
}


async function loadCaseMeta(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
) {
  const {
    data: oppositionCase,
    error: caseError,
  } = await supabase
    .from("opposition_cases")
    .select(`
      id,
      task_id,
      client_id,
      bulletin_record_id,
      selected_grounds,
      status,
      draft_version,
      current_draft
    `)
    .eq("task_id", taskId)
    .maybeSingle();

  if (caseError) {
    throw new Error(
      `Opposition Case okunamadı: ${caseError.message}`,
    );
  }

  if (!oppositionCase) {
    throw new HttpError(
      422,
      "Opposition Case bulunamadı.",
    );
  }


  let clientName = "";

  if (oppositionCase.client_id) {
    const {
      data: client,
      error: clientError,
    } = await supabase
      .from("persons")
      .select("name")
      .eq(
        "id",
        oppositionCase.client_id,
      )
      .maybeSingle();

    if (clientError) {
      throw new Error(
        `Müvekkil bilgisi okunamadı: ${clientError.message}`,
      );
    }

    clientName =
      client?.name ?? "";
  }


  let opponentName = "Karşı Taraf";
  let bulletinNo: string | null = null;
  let bulletinDate: string | null = null;


  if (oppositionCase.bulletin_record_id) {
    const {
      data: bulletinRecord,
      error: bulletinRecordError,
    } = await supabase
      .from("trademark_bulletin_records")
      .select("bulletin_id, holders")
      .eq(
        "id",
        oppositionCase.bulletin_record_id,
      )
      .maybeSingle();

    if (bulletinRecordError) {
      throw new Error(
        `Rakip bülten kaydı okunamadı: ${bulletinRecordError.message}`,
      );
    }


    const holderNames =
      parseHolderNames(
        bulletinRecord?.holders,
      );

    if (holderNames.length > 0) {
      opponentName =
        holderNames.join(", ");
    }


    if (bulletinRecord?.bulletin_id) {
      const {
        data: bulletin,
        error: bulletinError,
      } = await supabase
        .from("trademark_bulletins")
        .select(
          "bulletin_no, bulletin_date",
        )
        .eq(
          "id",
          bulletinRecord.bulletin_id,
        )
        .maybeSingle();

      if (bulletinError) {
        throw new Error(
          `Bülten bilgisi okunamadı: ${bulletinError.message}`,
        );
      }

      bulletinNo =
        bulletin?.bulletin_no
          ? String(bulletin.bulletin_no)
          : null;

      bulletinDate =
        bulletin?.bulletin_date ??
        null;
    }
  }


  return {
    oppositionCase,
    clientName,
    opponentName,
    bulletinNo,
    bulletinDate,
  };
}


function buildCanonicalPayload(
  analysis: any,
  caseMeta: any,
) {
  const blockers: string[] = [];
  const warnings: string[] = [];


  const selectedGrounds =
    Array.isArray(
      analysis?.case?.selectedGrounds,
    )
      ? analysis.case.selectedGrounds.map(String)
      : [];


  if (
    !selectedGrounds.includes("SMK_6_1")
  ) {
    blockers.push(
      "SMK 6/1 dosyada seçili değil.",
    );
  }


  const unsupportedGrounds =
    selectedGrounds.filter(
      (ground: string) =>
        ground !== "SMK_6_1",
    );


  if (unsupportedGrounds.length > 0) {
    blockers.push(
      `Bu sürüm yalnız tamamlanmış SMK 6/1 analizinden dilekçe üretir. Şu gerekçeler için ayrıca decision tree gerekir: ${unsupportedGrounds.join(", ")}`,
    );
  }


  if (analysis?.stale) {
    blockers.push(
      "SMK 6/1 analizi güncel dosya verileriyle eşleşmiyor.",
    );
  }


  if (!analysis?.readiness?.canDraft) {
    blockers.push(
      "SMK 6/1 decision tree dilekçe üretimine hazır değil.",
    );
  }


  if (!caseMeta.clientName) {
    blockers.push(
      "Müvekkil adı/unvanı bulunamadı.",
    );
  }


  const priorRights =
    Array.isArray(analysis?.priorRights)
      ? analysis.priorRights
      : [];


  const opponent =
    analysis?.opponent ?? {};


  const formData =
    analysis?.formData ?? {};


  if (priorRights.length === 0) {
    blockers.push(
      "Seçili müstenit marka bulunamadı.",
    );
  }


  if (!opponent.markText) {
    blockers.push(
      "İtiraz edilen marka adı bulunamadı.",
    );
  }


  if (!opponent.applicationNo) {
    blockers.push(
      "İtiraz edilen başvuru numarası bulunamadı.",
    );
  }


  const goodsAssessments =
    Array.isArray(
      formData.goodsAssessments,
    )
      ? formData.goodsAssessments
      : [];


  const requestedRows =
    goodsAssessments.filter(
      (row: any) =>
        row.requestedRefusal === true,
    );


  if (requestedRows.length === 0) {
    blockers.push(
      "Ret talep edilen rakip sınıf bulunmuyor.",
    );
  }


  const selectedRefusalClasses =
    [...new Set(
      requestedRows
        .map(
          (row: any) =>
            Number(row.opponentClassNo),
        )
        .filter(
          (n: number) =>
            Number.isFinite(n),
        ),
    )].sort(
      (a, b) => a - b,
    );


  const matchedByPrior =
    new Map<string, Set<number>>();


  for (const row of requestedRows) {

    if (
      [
        "none",
        "not_assessed",
        "",
      ].includes(
        String(
          row.similarityLevel ?? "",
        ),
      )
    ) {
      blockers.push(
        `Rakip Sınıf ${row.opponentClassNo} için ret talebi ile benzerlik sonucu uyumsuz.`,
      );
    }


    if (
      !Array.isArray(
        row.matchedPriorClasses,
      ) ||
      row.matchedPriorClasses.length === 0
    ) {
      blockers.push(
        `Rakip Sınıf ${row.opponentClassNo} için dayanılan müstenit sınıf bulunmuyor.`,
      );
    }


    if (
      !Array.isArray(row.criteria) ||
      row.criteria.length === 0
    ) {
      blockers.push(
        `Rakip Sınıf ${row.opponentClassNo} için emtia benzerliği kriteri bulunmuyor.`,
      );
    }


    for (
      const key of
      asStringArray(
        row.matchedPriorClasses,
      )
    ) {
      const splitIndex =
        key.lastIndexOf(":");

      if (splitIndex <= 0) {
        continue;
      }


      const priorId =
        key.slice(
          0,
          splitIndex,
        );


      const classNo =
        Number(
          key.slice(
            splitIndex + 1,
          ),
        );


      if (
        !priorId ||
        !Number.isFinite(classNo)
      ) {
        continue;
      }


      if (!matchedByPrior.has(priorId)) {
        matchedByPrior.set(
          priorId,
          new Set<number>(),
        );
      }


      matchedByPrior
        .get(priorId)!
        .add(classNo);
    }
  }


  const clientMarks =
    priorRights.map(
      (right: any) => {

        const matchedClasses =
          matchedByPrior.get(
            String(right.id),
          ) ??
          new Set<number>();


        const selectedClasses =
          (right.classes ?? [])
            .filter(
              (cls: any) =>
                matchedClasses.has(
                  Number(cls.classNo),
                ),
            )
            .map(
              (cls: any) => ({
                classNo:
                  Number(cls.classNo),

                items:
                  Array.isArray(cls.items)
                    ? cls.items.map(String)
                    : [],
              }),
            );


        return {
          ipRecordId:
            right.id,

          markText:
            right.markText,

          markType:
            right.markType,

          applicationNo:
            right.applicationNo,

          applicationDate:
            right.applicationDate,

          registrationNo:
            right.registrationNo,

          registrationDate:
            right.registrationDate,

          proofOfUseRequired:
            right.proofOfUseRequired,

          proofOfUseStatus:
            right.proofOfUseStatus,

          classes:
            selectedClasses,

          goodsServices:
            selectedClasses.flatMap(
              (cls: any) =>
                cls.items,
            ),
        };
      },
    );


  if (
    !clientMarks.some(
      (mark: any) =>
        mark.goodsServices.length > 0,
    )
  ) {
    blockers.push(
      "Dayanılan müstenit sınıfların gerçek mal/hizmet metni bulunmuyor.",
    );
  }


  const opponentGoodsByClass =
    Array.isArray(
      opponent.goodsByClass,
    )
      ? opponent.goodsByClass
      : [];


  const requestedOpponentGoods =
    opponentGoodsByClass
      .filter(
        (row: any) =>
          selectedRefusalClasses.includes(
            Number(row.classNo),
          ),
      )
      .map(
        (row: any) => ({
          classNo:
            Number(row.classNo),

          text:
            normalizeText(
              row.text,
            ),
        }),
      );


  if (
    requestedOpponentGoods.length === 0
  ) {
    blockers.push(
      "Ret kapsamındaki gerçek rakip mal/hizmet metni bulunmuyor.",
    );
  }


  const payload = {
    oppositionCaseId:
      analysis?.case?.id,

    taskId:
      analysis?.task?.id,

    sourceFingerprint:
      analysis?.sourceFingerprint,

    clientName:
      caseMeta.clientName,

    clientMarks,

    opponentName:
      caseMeta.opponentName,

    opponentApplication: {
      markText:
        opponent.markText,

      applicationNo:
        opponent.applicationNo,

      applicationDate:
        opponent.applicationDate,

      requestedRefusalClasses:
        selectedRefusalClasses,

      goodsByClass:
        requestedOpponentGoods,

      goodsServices:
        requestedOpponentGoods
          .map(
            (row: any) =>
              row.text,
          )
          .filter(Boolean),
    },

    selectedGrounds: [
      "SMK_6_1",
    ],

    lawyerAssessment: {
      version:
        1,

      sourceFingerprint:
        analysis?.sourceFingerprint,

      priorRightsReview:
        formData.priorRightsReview ??
        [],

      goodsAssessments,

      signAssessment:
        formData.signAssessment ??
        {},

      publicAssessment:
        formData.publicAssessment ??
        {},

      globalAssessment:
        formData.globalAssessment ??
        {},

      readiness:
        analysis?.readiness ??
        {},
    },

    bulletinInfo: {
      bulletinNo:
        caseMeta.bulletinNo,

      bulletinDate:
        caseMeta.bulletinDate,
    },
  };


  return {
    canGenerate:
      blockers.length === 0,

    blockers:
      [...new Set(blockers)],

    warnings:
      [...new Set(warnings)],

    payload,

    selectedRefusalClasses,
  };
}


function deterministicDraftQa(
  draft: string,
  payload: any,
) {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const text =
    normalizeText(draft);

  const normalizedDraft =
    normalizeForSearch(text);


  if (text.length < 500) {
    blockers.push(
      "Taslak olağan dışı derecede kısa.",
    );
  }


  const opponentMark =
    normalizeForSearch(
      payload
        .opponentApplication
        ?.markText,
    );


  if (
    opponentMark &&
    !normalizedDraft.includes(
      opponentMark,
    )
  ) {
    blockers.push(
      "Taslakta itiraz edilen marka adı bulunmuyor.",
    );
  }


  const priorMarks =
    (payload.clientMarks ?? [])
      .map(
        (mark: any) =>
          normalizeForSearch(
            mark.markText,
          ),
      )
      .filter(Boolean);


  if (
    priorMarks.length > 0 &&
    !priorMarks.some(
      (mark: string) =>
        normalizedDraft.includes(mark),
    )
  ) {
    blockers.push(
      "Taslakta seçili müstenit markalardan hiçbiri anılmıyor.",
    );
  }


  const forbiddenPatterns = [
    {
      regex:
        /\bkötü\s+niyet\b/i,

      label:
        "kötü niyet",
    },
    {
      regex:
        /\bSMK\s*6\s*\/\s*9\b/i,

      label:
        "SMK 6/9",
    },
    {
      regex:
        /\bSMK\s*6\s*\/\s*5\b/i,

      label:
        "SMK 6/5",
    },
    {
      regex:
        /\btanınmış(?:lık)?\b/i,

      label:
        "tanınmışlık",
    },
    {
      regex:
        /\bseri\s+marka\b/i,

      label:
        "seri marka",
    },
    {
      regex:
        /\bmarka\s+ailesi\b/i,

      label:
        "marka ailesi",
    },
  ];


  for (
    const item of
    forbiddenPatterns
  ) {
    if (
      item.regex.test(text)
    ) {
      blockers.push(
        `Taslakta bu 6/1-only dosyada desteklenmeyen ifade bulundu: ${item.label}.`,
      );
    }
  }


  const allowedApplicationNumbers =
    new Set<string>();


  const opponentAppNo =
    normalizeText(
      payload
        .opponentApplication
        ?.applicationNo,
    );


  if (opponentAppNo) {
    allowedApplicationNumbers.add(
      opponentAppNo,
    );
  }


  for (
    const mark of
    payload.clientMarks ?? []
  ) {
    const appNo =
      normalizeText(
        mark.applicationNo,
      );

    if (appNo) {
      allowedApplicationNumbers.add(
        appNo,
      );
    }
  }


  const foundApplicationNumbers =
    text.match(
      /\b20\d{2}[\/-]\d{3,}\b/g,
    ) ?? [];


  for (
    const found of
    [...new Set(foundApplicationNumbers)]
  ) {
    if (
      !allowedApplicationNumbers.has(found)
    ) {
      blockers.push(
        `Taslakta dosya verilerinde olmayan başvuru numarası bulundu: ${found}`,
      );
    }
  }


  if (
    !text.startsWith(
      "AÇIKLAMALARIMIZ VE HUKUKİ GEREKÇELER",
    )
  ) {
    warnings.push(
      "Taslak standart başlıkla başlamıyor.",
    );
  }


  if (
    /\bsonuç\s+ve\s+talep\b/i
      .test(text)
  ) {
    warnings.push(
      "Taslak gövdesinde ayrıca Sonuç ve Talep bölümü var; Word şablonu ile çakışma kontrol edilmeli.",
    );
  }


  return {
    pass:
      blockers.length === 0,

    blockers:
      [...new Set(blockers)],

    warnings:
      [...new Set(warnings)],

    checkedAt:
      new Date().toISOString(),
  };
}


async function loadDraftHistory(
  supabase: ReturnType<typeof createClient>,
  oppositionCaseId: string,
) {
  const {
    data,
    error,
  } = await supabase
    .from(
      "opposition_case_drafts",
    )
    .select(
      "id, version_no, stage, content, qa_report, generated_by, created_at",
    )
    .eq(
      "opposition_case_id",
      oppositionCaseId,
    )
    .order(
      "version_no",
      { ascending: false },
    )
    .limit(10);


  if (error) {
    throw new Error(
      `Dilekçe versiyonları okunamadı: ${error.message}`,
    );
  }


  return data ?? [];
}


async function buildStatus(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  token: string,
  taskId: string,
) {
  const analysis =
    await loadAnalysisContext(
      supabaseUrl,
      token,
      taskId,
    );


  const caseMeta =
    await loadCaseMeta(
      supabase,
      taskId,
    );


  const canonical =
    buildCanonicalPayload(
      analysis,
      caseMeta,
    );


  const drafts =
    await loadDraftHistory(
      supabase,
      caseMeta.oppositionCase.id,
    );


  return {
    canGenerate:
      canonical.canGenerate,

    blockers:
      canonical.blockers,

    warnings:
      canonical.warnings,

    stale:
      analysis?.stale === true,

    caseStatus:
      caseMeta.oppositionCase.status,

    currentVersion:
      Number(
        caseMeta
          .oppositionCase
          .draft_version ??
        0,
      ),

    currentDraft:
      caseMeta
        .oppositionCase
        .current_draft ??
      null,

    drafts,

    wordData: {
      clientName:
        caseMeta.clientName ||
        "Müvekkil",

      opponentName:
        caseMeta.opponentName ||
        "Karşı Taraf",

      opponentMark:
        analysis
          ?.opponent
          ?.markText ||
        "Belirtilmemiş",

      opponentAppNo:
        analysis
          ?.opponent
          ?.applicationNo ||
        "Belirtilmemiş",

      bulletinNo:
        caseMeta.bulletinNo,

      bulletinDate:
        caseMeta.bulletinDate,
    },

    selectedRefusalClasses:
      canonical
        .selectedRefusalClasses,
  };
}


async function nextVersion(
  supabase: ReturnType<typeof createClient>,
  oppositionCase: any,
) {
  const {
    data,
    error,
  } = await supabase
    .from(
      "opposition_case_drafts",
    )
    .select("version_no")
    .eq(
      "opposition_case_id",
      oppositionCase.id,
    )
    .order(
      "version_no",
      { ascending: false },
    )
    .limit(1)
    .maybeSingle();


  if (error) {
    throw new Error(
      `Son dilekçe versiyonu okunamadı: ${error.message}`,
    );
  }


  return Math.max(
    Number(
      oppositionCase.draft_version ??
      0,
    ),

    Number(
      data?.version_no ??
      0,
    ),
  ) + 1;
}


async function persistDraft(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  caseMeta: any,
  canonical: any,
  generation: any,
  qaReport: any,
) {
  const versionNo =
    await nextVersion(
      supabase,
      caseMeta.oppositionCase,
    );


  const {
    error: insertError,
  } = await supabase
    .from(
      "opposition_case_drafts",
    )
    .insert({
      opposition_case_id:
        caseMeta
          .oppositionCase
          .id,

      version_no:
        versionNo,

      stage:
        "generated",

      content:
        generation.petition,

      generation_context: {
        sourceFingerprint:
          canonical
            .payload
            .sourceFingerprint,

        selectedGrounds:
          canonical
            .payload
            .selectedGrounds,

        selectedRefusalClasses:
          canonical
            .selectedRefusalClasses,

        payloadSnapshot:
          canonical.payload,

        ragSourceIds:
          (
            generation.sources ??
            []
          ).map(
            (source: any) =>
              source.sourceId,
          ),
      },

      qa_report:
        qaReport,

      generated_by:
        userId,
    });


  if (insertError) {
    throw new Error(
      `Dilekçe versiyonu kaydedilemedi: ${insertError.message}`,
    );
  }


  const {
    error: updateError,
  } = await supabase
    .from("opposition_cases")
    .update({
      ai_analysis:
        generation.analysis ??
        {},

      qa_report:
        qaReport,

      current_draft:
        generation.petition,

      draft_version:
        versionNo,

      status:
        "review",
    })
    .eq(
      "id",
      caseMeta
        .oppositionCase
        .id,
    );


  if (updateError) {
    throw new Error(
      `Opposition Case taslak kaydı güncellenemedi: ${updateError.message}`,
    );
  }


  return versionNo;
}


async function generate(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  userId: string,
  token: string,
  taskId: string,
) {
  const analysis =
    await loadAnalysisContext(
      supabaseUrl,
      token,
      taskId,
    );


  const caseMeta =
    await loadCaseMeta(
      supabase,
      taskId,
    );


  const canonical =
    buildCanonicalPayload(
      analysis,
      caseMeta,
    );


  if (!canonical.canGenerate) {
    throw new HttpError(
      422,
      `Dilekçe üretimi engellendi: ${canonical.blockers.join(" | ")}`,
    );
  }


  const generationResponse =
    await callFunction(
      supabaseUrl,
      "generate-petition",
      token,
      canonical.payload,
    );


  if (
    generationResponse.status ===
    "needs_input"
  ) {
    return {
      generationStatus:
        "needs_input",

      saved:
        false,

      missingCriticalFacts:
        generationResponse
          .missingCriticalFacts ??
        generationResponse
          .analysis
          ?.missingCriticalFacts ??
        [],

      analysis:
        generationResponse
          .analysis ??
        null,
    };
  }


  if (
    !generationResponse.petition
  ) {
    throw new HttpError(
      422,
      "AI dilekçe metni üretmedi.",
    );
  }


  const deterministic =
    deterministicDraftQa(
      generationResponse.petition,
      canonical.payload,
    );


  const qaReport = {
    version:
      1,

    deterministic,

    aiAuditIssues:
      generationResponse
        .auditIssues ??
      [],

    finalPass:
      deterministic.pass,

    checkedAt:
      new Date().toISOString(),
  };


  if (!deterministic.pass) {
    return {
      generationStatus:
        "qa_failed",

      saved:
        false,

      petition:
        generationResponse.petition,

      analysis:
        generationResponse
          .analysis ??
        null,

      qaReport,
    };
  }


  const versionNo =
    await persistDraft(
      supabase,
      userId,
      caseMeta,
      canonical,
      generationResponse,
      qaReport,
    );


  return {
    generationStatus:
      "completed",

    saved:
      true,

    versionNo,

    petition:
      generationResponse.petition,

    analysis:
      generationResponse
        .analysis ??
      null,

    qaReport,
  };
}


serve(async (req) => {

  if (req.method === "OPTIONS") {
    return new Response(
      "ok",
      { headers: corsHeaders },
    );
  }


  try {
    const supabaseUrl =
      Deno.env.get(
        "SUPABASE_URL",
      ) ?? "";


    const serviceRoleKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY",
      ) ?? "";


    const supabase =
      createClient(
        supabaseUrl,
        serviceRoleKey,
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
        "status",
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


    if (action === "status") {
      const status =
        await buildStatus(
          supabase,
          supabaseUrl,
          currentUser.token,
          taskId,
        );


      return new Response(
        JSON.stringify({
          success: true,
          status,
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


    if (action === "generate") {

      const generation =
        await generate(
          supabase,
          supabaseUrl,
          currentUser.id,
          currentUser.token,
          taskId,
        );


      const status =
        await buildStatus(
          supabase,
          supabaseUrl,
          currentUser.token,
          taskId,
        );


      return new Response(
        JSON.stringify({
          success:
            true,

          generation,

          status,
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


    throw new HttpError(
      400,
      "Geçersiz action.",
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
      "❌ opposition-draft:",
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