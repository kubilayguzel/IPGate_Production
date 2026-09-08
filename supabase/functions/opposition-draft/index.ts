import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const PACKAGE_VERSION = "6.1.6";
const ORCHESTRATOR_PATCH_VERSION = "6.1.8.3";
const INPUT_POLICY_VERSION = "6.1.10";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

function safeArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function safeObject(value: unknown): Record<string, any> {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    ? value as Record<string, any>
    : {};
}

function asStringArray(value: unknown): string[] {
  return [
    ...new Set(
      safeArray(value)
        .map(item => String(item ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function uniqueNumbers(value: unknown): number[] {
  return [
    ...new Set(
      safeArray(value)
        .map(item => Number(item))
        .filter(item => Number.isFinite(item)),
    ),
  ].sort((a, b) => a - b);
}

function splitScopeSegments(value: unknown): string[] {
  return String(value ?? "")
    .split(/[;\n]+/)
    .map(item => normalizeForSearch(item))
    .filter(item => item.length >= 3);
}

function isPartialScopeSupported(
  fullText: unknown,
  partialText: unknown,
): boolean {
  const full = normalizeForSearch(fullText);
  const partial = normalizeForSearch(partialText);

  if (!full || !partial || full === partial) {
    return false;
  }

  if (full.includes(partial)) {
    return true;
  }

  const segments = splitScopeSegments(partialText);

  return (
    segments.length > 0 &&
    segments.every(segment => full.includes(segment))
  );
}

function parseHolderNames(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return [];
    }

    try {
      return parseHolderNames(JSON.parse(trimmed));
    } catch {
      return [trimmed];
    }
  }

  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .flatMap(item => {
            if (typeof item === "string") {
              return [item.trim()];
            }

            if (!item || typeof item !== "object") {
              return [];
            }

            const candidate =
              item.name ??
              item.holderName ??
              item.title ??
              item.ownerName ??
              item.applicantName ??
              null;

            return candidate
              ? [String(candidate).trim()]
              : [];
          })
          .filter(Boolean),
      ),
    ];
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
  const authHeader =
    req.headers.get("Authorization") ?? "";

  const token =
    authHeader
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
  } =
    await supabase.auth.getUser(token);

  if (authError || !authData.user) {
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
    role: String(profile.role ?? ""),
  };
}

async function callFunction(
  supabaseUrl: string,
  functionName: string,
  token: string,
  body: any,
) {
  const response =
    await fetch(
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

  let data: any = {};

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new HttpError(
      response.status,
      data?.error ||
      data?.message ||
      `${functionName} çağrısı başarısız oldu.`,
    );
  }

  return data;
}

async function loadAnalysisContext(
  supabaseUrl: string,
  token: string,
  taskId: string,
) {
  const data =
    await callFunction(
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
  } =
    await supabase
      .from("opposition_cases")
      .select(`
        id,
        task_id,
        client_id,
        opposed_ip_record_id,
        bulletin_record_id,
        selected_grounds,
        status,
        draft_version,
        current_draft,
        ai_analysis,
        qa_report
      `)
      .eq("task_id", taskId)
      .maybeSingle();

  if (caseError || !oppositionCase) {
    throw new HttpError(
      422,
      caseError
        ? `Opposition Case okunamadı: ${caseError.message}`
        : "Opposition Case bulunamadı.",
    );
  }

  let clientName = "";

  if (oppositionCase.client_id) {
    const {
      data: client,
      error: clientError,
    } =
      await supabase
        .from("persons")
        .select("name")
        .eq("id", oppositionCase.client_id)
        .maybeSingle();

    if (clientError) {
      throw new Error(
        `Müvekkil bilgisi okunamadı: ${clientError.message}`,
      );
    }

    clientName = client?.name ?? "";
  }

  let opponentName = "Karşı Taraf";
  let bulletinNo: string | null = null;
  let bulletinDate: string | null = null;
  let opponentImageUrl: string | null = null;

  if (oppositionCase.bulletin_record_id) {
    const {
      data: bulletinRecord,
      error: bulletinRecordError,
    } =
      await supabase
        .from("trademark_bulletin_records")
        .select("bulletin_id, holders, image_url")
        .eq("id", oppositionCase.bulletin_record_id)
        .maybeSingle();

    if (bulletinRecordError) {
      throw new Error(
        `Rakip bülten kaydı okunamadı: ${bulletinRecordError.message}`,
      );
    }

    const holderNames =
      parseHolderNames(bulletinRecord?.holders);

    if (holderNames.length > 0) {
      opponentName = holderNames.join(", ");
    }

    opponentImageUrl =
      normalizeText(bulletinRecord?.image_url) ||
      null;

    if (bulletinRecord?.bulletin_id) {
      const {
        data: bulletin,
        error: bulletinError,
      } =
        await supabase
          .from("trademark_bulletins")
          .select("bulletin_no, bulletin_date")
          .eq("id", bulletinRecord.bulletin_id)
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

  if (
    !opponentImageUrl &&
    oppositionCase.opposed_ip_record_id
  ) {
    const {
      data: details,
      error: detailsError,
    } =
      await supabase
        .from("ip_record_trademark_details")
        .select("brand_image_url")
        .eq(
          "ip_record_id",
          oppositionCase.opposed_ip_record_id,
        )
        .maybeSingle();

    if (detailsError) {
      throw new Error(
        `Rakip marka görseli okunamadı: ${detailsError.message}`,
      );
    }

    opponentImageUrl =
      normalizeText(details?.brand_image_url) ||
      null;
  }

  return {
    oppositionCase,
    clientName,
    opponentName,
    bulletinNo,
    bulletinDate,
    opponentImageUrl,
  };
}

function buildCanonicalPayload(
  analysis: any,
  caseMeta: any,
) {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const selectedGrounds =
    safeArray(analysis?.case?.selectedGrounds)
      .map(String);

  if (!selectedGrounds.includes("SMK_6_1")) {
    blockers.push(
      "SMK 6/1 dosyada seçili değil.",
    );
  }

  const unsupportedGrounds =
    selectedGrounds.filter(
      (ground: string) => ground !== "SMK_6_1",
    );

  if (unsupportedGrounds.length > 0) {
    blockers.push(
      `Paket 6.1.5 yalnız tamamlanmış SMK 6/1 decision tree ile production üretim yapar. Ek gerekçeler: ${unsupportedGrounds.join(", ")}`,
    );
  }

  if (analysis?.stale) {
    blockers.push(
      "SMK 6/1 analizi güncel dosya verileriyle eşleşmiyor.",
    );
  }

  if (analysis?.readiness?.canDraft !== true) {
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
    safeArray(analysis?.priorRights);

  const opponent =
    safeObject(analysis?.opponent);

  const formData =
    safeObject(analysis?.formData);

  if (priorRights.length === 0) {
    blockers.push(
      "Seçili müstenit marka bulunamadı.",
    );
  }

  if (!normalizeText(opponent.markText)) {
    blockers.push(
      "İtiraz edilen marka adı bulunamadı.",
    );
  }

  if (!normalizeText(opponent.applicationNo)) {
    blockers.push(
      "İtiraz edilen başvuru numarası bulunamadı.",
    );
  }

  const goodsAssessments =
    safeArray(formData.goodsAssessments);

  const requestedRows =
    goodsAssessments.filter(
      (row: any) =>
        row?.requestedRefusal === true,
    );

  if (requestedRows.length === 0) {
    blockers.push(
      "Ret talep edilen rakip sınıf bulunmuyor.",
    );
  }

  const selectedRefusalClasses =
    uniqueNumbers(
      requestedRows.map(
        (row: any) => row?.opponentClassNo,
      ),
    );

  const matchedByPrior =
    new Map<string, Set<number>>();

  let manualGoodsComparisonCount =
    0;

  for (const row of requestedRows) {
    const similarityLevel =
      normalizeText(row?.similarityLevel);

    const matched =
      asStringArray(
        row?.matchedPriorClasses,
      );

    const criteria =
      asStringArray(
        row?.criteria,
      );

    const hasManualFinding =
      (
        similarityLevel &&
        similarityLevel !==
          "not_assessed"
      ) ||
      matched.length > 0 ||
      criteria.length > 0 ||
      Boolean(
        normalizeText(
          row?.note,
        ),
      );

    if (hasManualFinding) {
      manualGoodsComparisonCount +=
        1;
    }

    /*
     * 6.1.10:
     * similarity / matched classes / criteria artık filing preflight
     * blocker DEĞİLDİR.
     *
     * Girilmişse canonical lawyer finding olarak korunur.
     * Girilmemişse selected prior right'ın gerçek sicil kapsamı
     * legal reasoning'e tam olarak aktarılır.
     */
    if (
      similarityLevel ===
      "none"
    ) {
      warnings.push(
        `Rakip Sınıf ${row?.opponentClassNo} için "benzer değil" avukat bulgusu mevcutken ret talebi açıktır.`,
      );
    }

    for (const key of matched) {
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
        !Number.isFinite(
          classNo,
        )
      ) {
        continue;
      }

      if (
        !matchedByPrior.has(
          priorId,
        )
      ) {
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

  if (
    manualGoodsComparisonCount ===
    0
  ) {
    warnings.push(
      "Mal/hizmet karşılaştırması için manuel avukat seviyesi/sınıf/kriter girdisi bulunmuyor. Legal Reasoning canonical sicil metinleri ve verified authority pack üzerinden karşılaştırma yapacaktır.",
    );
  }

  const clientMarks =
    priorRights.map(
      (right: any) => {
        const matchedClasses =
          matchedByPrior.get(
            String(right?.id),
          ) ??
          new Set<number>();

        const hasManualClassScope =
          matchedClasses.size >
          0;

        const classes =
          safeArray(
            right?.classes,
          )
            .filter(
              (cls: any) =>
                !hasManualClassScope ||
                matchedClasses.has(
                  Number(
                    cls?.classNo,
                  ),
                ),
            )
            .map(
              (cls: any) => ({
                classNo:
                  Number(
                    cls?.classNo,
                  ),
                items:
                  safeArray(
                    cls?.items,
                  ).map(
                    String,
                  ),
              }),
            );

        return {
          ipRecordId:
            right?.id,

          markText:
            right?.markText,

          markType:
            right?.markType,

          imageUrl:
            right?.imageUrl ??
            null,

          applicationNo:
            right?.applicationNo,

          applicationDate:
            right?.applicationDate,

          registrationNo:
            right?.registrationNo,

          registrationDate:
            right?.registrationDate,

          proofOfUseRequired:
            right?.proofOfUseRequired,

          proofOfUseStatus:
            right?.proofOfUseStatus,

          manualClassScopeApplied:
            hasManualClassScope,

          classes,

          goodsServices:
            classes.flatMap(
              (cls: any) =>
                cls.items,
            ),
        };
      },
    );

  if (
    !clientMarks.some(
      (mark: any) =>
        safeArray(
          mark?.goodsServices,
        ).length >
        0,
    )
  ) {
    blockers.push(
      "Seçili müstenit markaların gerçek mal/hizmet metni bulunmuyor.",
    );
  }

  const opponentGoodsByClass =
    safeArray(opponent?.goodsByClass);

  const requestedRefusalScopes =
    requestedRows.map(
      (row: any) => {
        const classNo =
          Number(row?.opponentClassNo);

        const canonicalRow =
          opponentGoodsByClass.find(
            (goods: any) =>
              Number(goods?.classNo) ===
              classNo,
          );

        const fullClassText =
          normalizeText(
            canonicalRow?.text,
          );

        if (!fullClassText) {
          blockers.push(
            `Rakip Sınıf ${classNo} için canonical mal/hizmet metni bulunamadı.`,
          );
        }

        const mode =
          normalizeText(
            row?.refusalScopeMode,
          );

        let exactText = "";

        if (mode === "full_class") {
          exactText =
            fullClassText;
        } else if (mode === "partial") {
          exactText =
            normalizeText(
              row?.refusalScopeText,
            );

          if (!exactText) {
            blockers.push(
              `Rakip Sınıf ${classNo} için kısmi ret kapsamı boş.`,
            );
          } else if (
            !isPartialScopeSupported(
              fullClassText,
              exactText,
            )
          ) {
            blockers.push(
              `Rakip Sınıf ${classNo} için kısmi ret kapsamı canonical rakip kapsamıyla eşleşmiyor.`,
            );
          }
        } else {
          blockers.push(
            `Rakip Sınıf ${classNo} için ret kapsamı modu seçilmedi.`,
          );
        }

        return {
          classNo,
          mode,
          text: exactText,
          fullClassText,
        };
      },
    );

  const requestedOpponentGoods =
    requestedRefusalScopes
      .filter((row: any) => Boolean(row?.text))
      .map(
        (row: any) => ({
          classNo: row.classNo,
          scopeMode: row.mode,
          text: row.text,
          fullClassText: row.fullClassText,
        }),
      );

  if (requestedOpponentGoods.length === 0) {
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
      niceClasses:
        asStringArray(
          opponent.niceClasses,
        ),
      requestedRefusalClasses:
        selectedRefusalClasses,
      requestedRefusalScopes,
      goodsByClass:
        requestedOpponentGoods,
      goodsServices:
        requestedOpponentGoods
          .map((row: any) => row.text)
          .filter(Boolean),
    },

    selectedGrounds: [
      "SMK_6_1",
    ],

    lawyerAssessment: {
      version: 2,
      sourceFingerprint:
        analysis?.sourceFingerprint,
      priorRightsReview:
        formData.priorRightsReview ?? [],
      goodsAssessments,

      goodsInputPolicy: {
        version:
          INPUT_POLICY_VERSION,

        manualComparisonOptional:
          true,

        explicitLawyerFindingsBinding:
          true,

        fallbackWhenMissing:
          "canonical_goods_text_plus_verified_authority",
      },

      signAssessment:
        formData.signAssessment ?? {},
      publicAssessment:
        formData.publicAssessment ?? {},
      globalAssessment:
        formData.globalAssessment ?? {},
      readiness:
        analysis?.readiness ?? {},
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
    selectedRefusalScopes:
      requestedRefusalScopes,
  };
}

const GOODS_CRITERIA_LABELS:
  Record<string, string> = {
    nature:
      "Nitelik / doğa",
    purpose:
      "Amaç",
    use_method:
      "Kullanım biçimi",
    complementary:
      "Tamamlayıcılık",
    competitive:
      "Rekabet / ikame",
    distribution_channels:
      "Dağıtım / sunum kanalları",
    relevant_public:
      "İlgili tüketici kesimi",
  };

const GOODS_SIMILARITY_LABELS:
  Record<string, string> = {
    identical:
      "Aynı",
    high:
      "Yüksek",
    medium:
      "Orta",
    low:
      "Düşük",
    none:
      "Benzer değil",
    not_assessed:
      "Değerlendirilmedi",
  };

function buildProfessionalDocumentData(
  caseMeta: any,
  canonical: any,
) {
  const payload =
    canonical.payload ?? {};

  const opponent =
    payload.opponentApplication ?? {};

  const priorMarks =
    safeArray(payload.clientMarks)
      .map(
        (mark: any) => ({
          ipRecordId:
            mark.ipRecordId,
          markText:
            mark.markText,
          markType:
            mark.markType,
          imageUrl:
            mark.imageUrl ?? null,
          applicationNo:
            mark.applicationNo,
          applicationDate:
            mark.applicationDate,
          registrationNo:
            mark.registrationNo,
          registrationDate:
            mark.registrationDate,
          proofOfUseRequired:
            mark.proofOfUseRequired,
          proofOfUseStatus:
            mark.proofOfUseStatus,
          classes:
            safeArray(mark.classes)
              .map(
                (cls: any) => ({
                  classNo:
                    Number(cls.classNo),
                  items:
                    safeArray(cls.items)
                      .map(String),
                }),
              ),
        }),
      );

  const refusalScopes =
    safeArray(
      canonical.selectedRefusalScopes,
    )
      .map(
        (scope: any) => ({
          classNo:
            Number(scope.classNo),
          mode:
            scope.mode,
          modeLabel:
            scope.mode === "full_class"
              ? "Sınıfın tamamı"
              : "Kısmi kapsam",
          text:
            normalizeText(scope.text),
          fullClassText:
            normalizeText(
              scope.fullClassText,
            ),
        }),
      );

  const opponentNiceClasses =
    uniqueNumbers(
      opponent.niceClasses,
    );

  const refusalClassNumbers =
    uniqueNumbers(
      refusalScopes.map(
        (scope: any) =>
          scope.classNo,
      ),
    );

  const wholeApplicationRefusal =
    opponentNiceClasses.length > 0 &&
    opponentNiceClasses.length ===
      refusalClassNumbers.length &&
    opponentNiceClasses.every(
      classNo =>
        refusalClassNumbers.includes(
          classNo,
        ),
    ) &&
    refusalScopes.every(
      (scope: any) =>
        scope.mode === "full_class",
    );

  const goodsAssessments =
    safeArray(
      payload
        ?.lawyerAssessment
        ?.goodsAssessments,
    );

  const goodsComparisons:
    any[] = [];

  for (
    const row
    of goodsAssessments
  ) {
    if (
      row?.requestedRefusal !== true
    ) {
      continue;
    }

    const opponentClassNo =
      Number(row?.opponentClassNo);

    const scope =
      refusalScopes.find(
        (item: any) =>
          Number(item?.classNo) ===
          opponentClassNo,
      );

    for (
      const key
      of asStringArray(
        row?.matchedPriorClasses,
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

      const priorClassNo =
        Number(
          key.slice(
            splitIndex + 1,
          ),
        );

      const priorMark =
        priorMarks.find(
          (mark: any) =>
            String(
              mark?.ipRecordId,
            ) ===
            String(priorId),
        );

      const priorClass =
        priorMark
          ?.classes
          ?.find(
            (cls: any) =>
              Number(cls?.classNo) ===
              priorClassNo,
          );

      if (
        !priorMark ||
        !priorClass
      ) {
        continue;
      }

      const rawCriteria =
        asStringArray(
          row?.criteria,
        );

      const goodsRetailPair =
        opponentClassNo === 35 &&
        priorClassNo !== 35;

      const criteriaLabels =
        rawCriteria.map(
          criterion => {
            if (
              goodsRetailPair &&
              criterion === "nature"
            ) {
              return "Nitelik / doğa (aynılık varsayımı yok)";
            }

            return (
              GOODS_CRITERIA_LABELS[
                criterion
              ] ??
              criterion
            );
          },
        );

      goodsComparisons.push({
        opponentClassNo,

        opponentText:
          scope?.text ??
          normalizeText(
            row?.opponentText,
          ),

        priorIpRecordId:
          priorMark.ipRecordId,

        priorMarkText:
          priorMark.markText,

        priorApplicationNo:
          priorMark.applicationNo,

        priorClassNo,

        priorText:
          safeArray(
            priorClass?.items,
          ).join("; "),

        similarityLevel:
          normalizeText(
            row?.similarityLevel,
          ),

        similarityLabel:
          GOODS_SIMILARITY_LABELS[
            normalizeText(
              row?.similarityLevel,
            )
          ] ??
          normalizeText(
            row?.similarityLevel,
          ),

        criteria:
          rawCriteria,

        criteriaLabels,

        note:
          normalizeText(row?.note),
      });
    }
  }

  const opponentApplicationNo =
    normalizeText(
      opponent.applicationNo,
    );

  const opponentMarkText =
    normalizeText(
      opponent.markText,
    );

  const topicText =
    refusalScopes.length === 1
      ? (
        refusalScopes[0].mode ===
        "full_class"
          ? `${opponentApplicationNo} sayılı “${opponentMarkText}” ibareli marka başvurusunun 6769 sayılı Sınai Mülkiyet Kanunu’nun 6/1. maddesi uyarınca ${refusalScopes[0].classNo}. sınıfta yer alan mal ve hizmetlerin tamamı bakımından reddi talebimizdir.`
          : `${opponentApplicationNo} sayılı “${opponentMarkText}” ibareli marka başvurusunun 6769 sayılı Sınai Mülkiyet Kanunu’nun 6/1. maddesi uyarınca ${refusalScopes[0].classNo}. sınıfta aşağıda belirtilen mal ve hizmetler bakımından reddi talebimizdir.`
      )
      : `${opponentApplicationNo} sayılı “${opponentMarkText}” ibareli marka başvurusunun 6769 sayılı Sınai Mülkiyet Kanunu’nun 6/1. maddesi uyarınca aşağıda belirtilen sınıf ve kapsamlar bakımından reddi talebimizdir.`;

  const resultItems = [
    ...refusalScopes.map(
      (scope: any) =>
        scope.mode === "full_class"
          ? `${opponentApplicationNo} sayılı “${opponentMarkText}” ibareli marka başvurusunun ${scope.classNo}. sınıfta yer alan mal ve hizmetlerin tamamı bakımından reddine,`
          : `${opponentApplicationNo} sayılı “${opponentMarkText}” ibareli marka başvurusunun ${scope.classNo}. sınıfta yer alan şu mal ve hizmetler bakımından reddine: ${scope.text}`,
    ),

    "İtirazımızın kabulüne karar verilmesini saygılarımızla arz ve talep ederiz.",
  ];

  const bulletinDateText =
    caseMeta.bulletinDate
      ? new Date(
        `${String(caseMeta.bulletinDate).slice(0, 10)}T00:00:00Z`,
      )
        .toLocaleDateString(
          "tr-TR",
          {
            timeZone: "UTC",
          },
        )
      : null;

  const bulletinText =
    caseMeta.bulletinNo &&
    bulletinDateText
      ? `${bulletinDateText} tarihli ve ${caseMeta.bulletinNo} sayılı`
      : caseMeta.bulletinNo
        ? `${caseMeta.bulletinNo} sayılı`
        : "İlgili Bülten";

  return {
    version: 2,

    packageVersion:
      PACKAGE_VERSION,

    sourceFingerprint:
      payload.sourceFingerprint,

    clientName:
      caseMeta.clientName ||
      "Müvekkil",

    representativeName:
      "Evreka Group Danışmanlık",

    bulletinNo:
      caseMeta.bulletinNo,

    bulletinDate:
      caseMeta.bulletinDate,

    bulletinText,

    topicText,

    wholeApplicationRefusal,

    wordExportPolicy: {
      minimumQaVersion: 4,
      requiredEnginePackageVersion:
        PACKAGE_VERSION,
      legacyQaPackageVersion:
        "4.2",
      documentPackageVersion:
        PACKAGE_VERSION,
    },

    opponent: {
      ownerName:
        caseMeta.opponentName ||
        "Karşı Taraf",

      markText:
        opponentMarkText,

      imageUrl:
        caseMeta
          .opponentImageUrl ??
        null,

      applicationNo:
        opponentApplicationNo,

      applicationDate:
        opponent.applicationDate,

      niceClasses:
        opponentNiceClasses,
    },

    priorMarks,

    refusalScopes,

    goodsComparisons,

    resultItems,

    documentDate:
      new Date()
        .toLocaleDateString(
          "tr-TR",
          {
            timeZone:
              "Europe/Istanbul",
          },
        ),
  };
}

async function loadDraftHistory(
  supabase: ReturnType<typeof createClient>,
  oppositionCaseId: string,
) {
  const {
    data,
    error,
  } =
    await supabase
      .from(
        "opposition_case_drafts",
      )
      .select(
        "id, version_no, stage, content, qa_report, generation_context, generated_by, created_at",
      )
      .eq(
        "opposition_case_id",
        oppositionCaseId,
      )
      .order(
        "version_no",
        {
          ascending: false,
        },
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
      caseMeta
        .oppositionCase
        .id,
    );

  const documentData =
    buildProfessionalDocumentData(
      caseMeta,
      canonical,
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
      caseMeta
        .oppositionCase
        .status,

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

    documentData,

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

      opponentImageUrl:
        caseMeta.opponentImageUrl,

      priorMarks:
        documentData.priorMarks,

      refusalScopes:
        documentData.refusalScopes,

      goodsComparisons:
        documentData.goodsComparisons,

      topicText:
        documentData.topicText,

      resultItems:
        documentData.resultItems,
    },

    selectedRefusalClasses:
      canonical
        .selectedRefusalClasses,

    selectedRefusalScopes:
      canonical
        .selectedRefusalScopes,

    enginePackageVersion:
      PACKAGE_VERSION,

    orchestratorPatchVersion:
      ORCHESTRATOR_PATCH_VERSION,

    inputPolicyVersion:
      INPUT_POLICY_VERSION,
  };
}

async function nextVersion(
  supabase: ReturnType<typeof createClient>,
  oppositionCase: any,
) {
  const {
    data,
    error,
  } =
    await supabase
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
        {
          ascending: false,
        },
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
      oppositionCase
        .draft_version ??
      0,
    ),
    Number(
      data?.version_no ??
      0,
    ),
  ) + 1;
}

function reasoningValidationPolicy(
  validation: any,
) {
  if (
    validation?.finalPass === true
  ) {
    return {
      accepted: true,
      toleratedErrors: [],
      fatalErrors: [],
    };
  }

  const errors =
    asStringArray(
      validation?.errors,
    );

  const toleratedErrors =
    errors.filter(
      item =>
        /direct kullanıma doğrulanmamış/i
          .test(item),
    );

  const fatalErrors =
    errors.filter(
      item =>
        !/direct kullanıma doğrulanmamış/i
          .test(item),
    );

  return {
    accepted:
      errors.length > 0 &&
      fatalErrors.length === 0,
    toleratedErrors,
    fatalErrors,
  };
}

function authoritySourcesFromDraftRun(
  draftRun: any,
) {
  const authorityPack =
    safeObject(
      draftRun
        ?.authority_pack_snapshot,
    );

  const validation =
    safeObject(
      draftRun?.validation,
    );

  const used =
    new Set(
      asStringArray(
        validation
          ?.usedPropositionIds,
      ),
    );

  return safeArray(
    authorityPack
      ?.propositions,
  ).map(
    (p: any) => ({
      sourceId:
        String(
          p?.propositionId ??
          "",
        ),

      citation_label:
        p?.citationLabel ??
        p?.sourceLocator ??
        "Doğrulanmış hukuki kaynak",

      document_title:
        p?.citationLabel ??
        null,

      section_title:
        p?.sourceLocator ??
        null,

      source_type:
        p?.authorityType ??
        "other",

      document_type:
        p?.authorityType ??
        "other",

      source_url:
        p?.sourceUrl ??
        null,

      verified: true,
      citable: true,

      used:
        used.has(
          String(
            p?.propositionId ??
            "",
          ),
        ),
    }),
  );
}

function buildQaReport({
  reasoningStatus,
  draftStatus,
  reasoningPolicy,
}) {
  const draftValidation =
    safeObject(
      draftStatus?.validation,
    );

  const draftErrors =
    asStringArray(
      draftValidation?.errors,
    );

  const renderedErrors =
    asStringArray(
      draftValidation
        ?.rendered
        ?.errors,
    );

  const draftWarnings =
    asStringArray(
      draftValidation?.warnings,
    );

  const renderedWarnings =
    asStringArray(
      draftValidation
        ?.rendered
        ?.warnings,
    );

  const deterministicBlockers = [
    ...draftErrors,
    ...renderedErrors,
  ];

  const citationSpecificBlockers =
    draftErrors.filter(
      (item) =>
        /proposition|authority|citation|donotusefor|kaynak/i.test(
          String(item),
        ),
    );

  const reasoningWarnings =
    asStringArray(
      reasoningPolicy
        ?.toleratedErrors,
    ).map(
      item =>
        `Reasoning validator advisory: ${item}`,
    );

  const finalPass =
    reasoningPolicy?.accepted === true &&
    draftValidation?.finalPass === true &&
    deterministicBlockers.length === 0;

  return {
    version: 4,

    // Legacy Word generator contract.
    packageVersion:
      "4.2",

    enginePackageVersion:
      PACKAGE_VERSION,

    legalResearchPackageVersion:
      "6.1.6",

    deterministic: {
      pass:
        deterministicBlockers.length === 0,

      blockers:
        [
          ...new Set(
            deterministicBlockers,
          ),
        ],

      warnings:
        [
          ...new Set([
            ...draftWarnings,
            ...renderedWarnings,
            ...reasoningWarnings,
          ]),
        ],

      checkedAt:
        new Date()
          .toISOString(),
    },

    citationAudit: {
      version: 2,
      packageVersion:
        PACKAGE_VERSION,

      pass:
        draftValidation?.finalPass === true,

      blockers:
        [
          ...new Set(
            citationSpecificBlockers,
          ),
        ],

      warnings:
        [
          ...new Set(
            draftWarnings,
          ),
        ],

      citedSourceIds:
        asStringArray(
          draftValidation
            ?.usedPropositionIds,
        ),

      citableSourcesAvailable:
        asStringArray(
          draftValidation
            ?.usedPropositionIds,
        ).length,
    },

    aiAuditIssues: [],

    aiTelemetry: {
      engine:
        PACKAGE_VERSION,

      reasoning: {
        model:
          reasoningStatus?.model ??
          null,

        reasoningEffort:
          reasoningStatus
            ?.reasoningEffort ??
          null,

        usage:
          reasoningStatus?.usage ??
          {},

        estimatedUsd:
          Number(
            reasoningStatus
              ?.estimatedCostUsd ??
            0,
          ),
      },

      draft: {
        model:
          draftStatus?.model ??
          null,

        reasoningEffort:
          draftStatus
            ?.reasoningEffort ??
          null,

        usage:
          draftStatus?.usage ??
          {},

        estimatedUsd:
          Number(
            draftStatus
              ?.estimatedCostUsd ??
            0,
          ),
      },

      total: {
        estimatedUsd:
          Number(
            (
              Number(
                reasoningStatus
                  ?.estimatedCostUsd ??
                0,
              ) +
              Number(
                draftStatus
                  ?.estimatedCostUsd ??
                0,
              )
            ).toFixed(6),
          ),
      },
    },

    finalPass,

    enforcementMode:
      "strict",

    workflowAccepted:
      finalPass,

    checkedAt:
      new Date()
        .toISOString(),
  };
}

async function persistFinalDraft(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  caseMeta: any,
  canonical: any,
  reasoningStatus: any,
  draftStatus: any,
  reasoningPolicy: any,
) {
  const draftRunId =
    normalizeText(
      draftStatus?.draftRunId,
    );

  if (!draftRunId) {
    throw new Error(
      "Final draftRunId bulunamadı.",
    );
  }

  const {
    data: draftRun,
    error: draftRunError,
  } =
    await supabase
      .from(
        "legal_petition_draft_runs",
      )
      .select(
        "id, reasoning_run_id, research_run_id, authority_pack_snapshot, validation, persisted_at, opposition_case_draft_id, opposition_draft_version_no",
      )
      .eq("id", draftRunId)
      .maybeSingle();

  if (
    draftRunError ||
    !draftRun
  ) {
    throw new Error(
      `Final draft run okunamadı: ${
        draftRunError?.message ??
        "kayıt yok"
      }`,
    );
  }

  if (
    draftRun.persisted_at &&
    draftRun.opposition_draft_version_no
  ) {
    return {
      versionNo:
        Number(
          draftRun
            .opposition_draft_version_no,
        ),
      alreadyPersisted:
        true,
      qaReport: null,
    };
  }

  // Secondary idempotency guard:
  // even if the persisted marker update previously failed,
  // never create a second opposition_case_drafts row for the same draftRunId.
  const {
    data: alreadySaved,
    error: alreadySavedError,
  } =
    await supabase
      .from(
        "opposition_case_drafts",
      )
      .select(
        "id, version_no, qa_report",
      )
      .eq(
        "opposition_case_id",
        caseMeta
          .oppositionCase
          .id,
      )
      .contains(
        "generation_context",
        {
          draftRunId,
        },
      )
      .order(
        "version_no",
        {
          ascending:
            false,
        },
      )
      .limit(1)
      .maybeSingle();

  if (alreadySavedError) {
    console.warn(
      "Persist idempotency lookup failed:",
      alreadySavedError.message,
    );
  }

  if (alreadySaved?.id) {
    return {
      versionNo:
        Number(
          alreadySaved
            .version_no,
        ),
      alreadyPersisted:
        true,
      qaReport:
        alreadySaved
          .qa_report ??
        null,
    };
  }

  const qaReport =
    buildQaReport({
      reasoningStatus,
      draftStatus,
      reasoningPolicy,
    });

  if (qaReport.finalPass !== true) {
    throw new HttpError(
      422,
      `Paket 6.1.5 strict QA geçmedi: ${
        qaReport
          ?.deterministic
          ?.blockers
          ?.join(" | ") ||
        "finalPass=false"
      }`,
    );
  }

  const petition =
    normalizeText(
      draftStatus?.petition,
    );

  if (!petition) {
    throw new HttpError(
      422,
      "Final petition metni bulunamadı.",
    );
  }

  const versionNo =
    await nextVersion(
      supabase,
      caseMeta.oppositionCase,
    );

  const legalSources =
    authoritySourcesFromDraftRun(
      draftRun,
    );

  const documentDataSnapshot =
    buildProfessionalDocumentData(
      caseMeta,
      canonical,
    );

  const {
    data: inserted,
    error: insertError,
  } =
    await supabase
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
          petition,

        generation_context: {
          enginePackageVersion:
            PACKAGE_VERSION,

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

          selectedRefusalScopes:
            canonical
              .selectedRefusalScopes,

          payloadSnapshot:
            canonical.payload,

          reasoningRunId:
            reasoningStatus
              ?.reasoningRunId ??
            draftRun
              ?.reasoning_run_id ??
            null,

          researchRunId:
            reasoningStatus
              ?.researchRunId ??
            draftRun
              ?.research_run_id ??
            null,

          draftRunId,

          reasoningValidation:
            reasoningStatus
              ?.validation ??
            null,

          reasoningValidationPolicy:
            reasoningPolicy,

          finalDraftValidation:
            draftStatus
              ?.validation ??
            null,

          documentDataSnapshot,

          legalSources,

          citationAudit:
            qaReport
              .citationAudit,

          telemetry:
            qaReport
              .aiTelemetry,

          legalResearchPackageVersion:
            "6.1.6",

          finalDraftPackageVersion:
            PACKAGE_VERSION,
        },

        qa_report:
          qaReport,

        generated_by:
          userId,
      })
      .select("id")
      .single();

  if (
    insertError ||
    !inserted?.id
  ) {
    throw new Error(
      `Dilekçe versiyonu kaydedilemedi: ${
        insertError?.message ??
        "id yok"
      }`,
    );
  }

  const {
    error: updateCaseError,
  } =
    await supabase
      .from(
        "opposition_cases",
      )
      .update({
        ai_analysis: {
          ...safeObject(
            caseMeta
              .oppositionCase
              .ai_analysis,
          ),

          _enginePackageVersion:
            PACKAGE_VERSION,

          _lastReasoningRunId:
            reasoningStatus
              ?.reasoningRunId ??
            null,

          _lastDraftRunId:
            draftRunId,

          _lastCitationAudit:
            qaReport
              .citationAudit,

          _lastLegalSources:
            legalSources,

          _lastTelemetry:
            qaReport
              .aiTelemetry,
        },

        qa_report:
          qaReport,

        current_draft:
          petition,

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

  if (updateCaseError) {
    throw new Error(
      `Opposition Case taslak kaydı güncellenemedi: ${updateCaseError.message}`,
    );
  }

  const {
    error: markPersistedError,
  } =
    await supabase
      .from(
        "legal_petition_draft_runs",
      )
      .update({
        opposition_case_draft_id:
          inserted.id,

        opposition_draft_version_no:
          versionNo,

        persisted_at:
          new Date()
            .toISOString(),
      })
      .eq("id", draftRunId);

  if (markPersistedError) {
    console.warn(
      "Final draft persisted marker update failed:",
      markPersistedError.message,
    );
  }

  return {
    versionNo,
    qaReport,
    alreadyPersisted:
      false,
  };
}

async function findReusableReasoningRun(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  userId: string,
  sourceFingerprint: string,
) {
  if (!sourceFingerprint) {
    return null;
  }

  const cutoff =
    new Date(
      Date.now() -
      24 * 60 * 60 * 1000,
    ).toISOString();

  const {
    data,
    error,
  } =
    await supabase
      .from(
        "legal_reasoning_runs",
      )
      .select(
        "id, status, openai_status, source_fingerprint, validation, created_at",
      )
      .eq(
        "task_id",
        taskId,
      )
      .eq(
        "created_by",
        userId,
      )
      .eq(
        "package_version",
        "6.1.6",
      )
      .eq(
        "source_fingerprint",
        sourceFingerprint,
      )
      .in(
        "status",
        [
          "completed",
          "validation_failed",
        ],
      )
      .gte(
        "created_at",
        cutoff,
      )
      .order(
        "created_at",
        {
          ascending:
            false,
        },
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    console.warn(
      "Reusable reasoning lookup failed:",
      error.message,
    );
    return null;
  }

  return data ?? null;
}


async function findRecentActiveReasoningRun(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  userId: string,
) {
  const cutoff =
    new Date(
      Date.now() -
      30 * 60 * 1000,
    ).toISOString();

  const {
    data,
    error,
  } =
    await supabase
      .from(
        "legal_reasoning_runs",
      )
      .select(
        "id, package_version, status, openai_status, created_at",
      )
      .eq("task_id", taskId)
      .eq("created_by", userId)
      .eq("package_version", "6.1.6")
      .eq("status", "started")
      .gte("created_at", cutoff)
      .order(
        "created_at",
        {
          ascending:
            false,
        },
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    console.warn(
      "Active reasoning lookup failed:",
      error.message,
    );
    return null;
  }

  return data ?? null;
}

async function generateStart(
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

  const reusable =
    await findReusableReasoningRun(
      supabase,
      taskId,
      userId,
      normalizeText(
        canonical
          ?.payload
          ?.sourceFingerprint,
      ),
    );

  if (reusable?.id) {
    return {
      generationStatus:
        "reasoning_completed",

      stage:
        "reasoning",

      reasoningRunId:
        reusable.id,

      reusedCompletedReasoning:
        true,

      enginePackageVersion:
        PACKAGE_VERSION,

      orchestratorPatchVersion:
        ORCHESTRATOR_PATCH_VERSION,

      inputPolicyVersion:
        INPUT_POLICY_VERSION,
    };
  }

  const active =
    await findRecentActiveReasoningRun(
      supabase,
      taskId,
      userId,
    );

  if (active?.id) {
    return {
      generationStatus:
        "pending",

      stage:
        "reasoning",

      reasoningRunId:
        active.id,

      reusedActiveRun:
        true,

      enginePackageVersion:
        PACKAGE_VERSION,

      orchestratorPatchVersion:
        ORCHESTRATOR_PATCH_VERSION,
    };
  }

  const reasoningStart =
    await callFunction(
      supabaseUrl,
      "legal-reasoning",
      token,
      {
        action:
          "reason",

        taskId,

        /*
         * 6.1.8.3 gateway-timeout hotfix:
         *
         * generate_start is an interactive Edge request. Paket 6.1.6
         * legal-research may perform layered Kılavuz + Yargıtay + EU
         * discovery/verification synchronously and can exceed the
         * Supabase gateway window.
         *
         * Production drafting must therefore start from the already
         * verified/citable EVREKA authority corpus. legal-reasoning
         * still receives the current issue tags and the 6.1.6 prompt
         * still requires layered authority use when available.
         *
         * Fresh web research must not run inside this gateway-bound
         * generate_start request.
         */
        refreshResearch:
          false,

        minimumAuthorityCoverage:
          0.75,

        requireCompleteCoverage:
          true,

        minCaseAuthorities:
          3,

        minYargitayAuthorities:
          1,

        minEuAuthorities:
          1,

        reasoningEffort:
          "high",
      },
    );

  if (!reasoningStart?.reasoningRunId) {
    throw new HttpError(
      422,
      "6.1 Legal Reasoning run başlatılamadı.",
    );
  }

  return {
    generationStatus:
      reasoningStart?.pending === true
        ? "pending"
        : "reasoning_completed",

    stage:
      "reasoning",

    reasoningRunId:
      reasoningStart
        .reasoningRunId,

    researchRunId:
      reasoningStart
        ?.researchRunId ??
      null,

    openAiStatus:
      reasoningStart
        ?.openAiStatus ??
      null,

    enginePackageVersion:
      PACKAGE_VERSION,
  };
}

async function latestDraftRunForReasoning(
  supabase: ReturnType<typeof createClient>,
  reasoningRunId: string,
  userId: string,
) {
  const {
    data,
    error,
  } =
    await supabase
      .from(
        "legal_petition_draft_runs",
      )
      .select(
        "id, status, openai_status, petition, validation, estimated_cost_usd, created_at",
      )
      .eq(
        "reasoning_run_id",
        reasoningRunId,
      )
      .eq(
        "created_by",
        userId,
      )
      .eq(
        "package_version",
        PACKAGE_VERSION,
      )
      .eq(
        "status",
        "started",
      )
      .order(
        "created_at",
        {
          ascending:
            false,
        },
      )
      .limit(1)
      .maybeSingle();

  if (error) {
    throw new Error(
      `Final draft run sorgulanamadı: ${error.message}`,
    );
  }

  return data ?? null;
}

async function generateStatus(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  userId: string,
  token: string,
  taskId: string,
  reasoningRunId: string,
  requestedDraftRunId: string | null,
) {
  if (!reasoningRunId) {
    throw new HttpError(
      400,
      "reasoningRunId zorunludur.",
    );
  }

  const reasoningStatus =
    await callFunction(
      supabaseUrl,
      "legal-reasoning",
      token,
      {
        action:
          "status",

        reasoningRunId,
      },
    );

  if (
    reasoningStatus?.pending === true
  ) {
    return {
      generationStatus:
        "pending",

      stage:
        "reasoning",

      reasoningRunId,

      openAiStatus:
        reasoningStatus
          ?.openAiStatus ??
        null,
    };
  }

  const reasoningPolicy =
    reasoningValidationPolicy(
      reasoningStatus?.validation,
    );

  if (
    reasoningPolicy.accepted !== true
  ) {
    throw new HttpError(
      422,
      `Legal Reasoning strict safety policy geçmedi: ${
        reasoningPolicy
          .fatalErrors
          .join(" | ") ||
        "validation başarısız"
      }`,
    );
  }

  let draftRunId =
    normalizeText(
      requestedDraftRunId,
    ) ||
    null;

  const existingDraftRun =
    draftRunId
      ? null
      : await latestDraftRunForReasoning(
        supabase,
        reasoningRunId,
        userId,
      );

  if (
    !draftRunId &&
    existingDraftRun?.id
  ) {
    draftRunId =
      existingDraftRun.id;
  }

  if (!draftRunId) {
    const draftStart =
      await callFunction(
        supabaseUrl,
        "legal-petition-draft",
        token,
        {
          action:
            "draft",

          reasoningRunId,

          allowReasoningValidationWarnings:
            reasoningStatus
              ?.validation
              ?.finalPass !==
            true,

          reasoningEffort:
            "medium",
        },
      );

    draftRunId =
      normalizeText(
        draftStart?.draftRunId,
      ) ||
      null;

    if (!draftRunId) {
      throw new HttpError(
        422,
        "6.1.5 Final Petition Draft run başlatılamadı.",
      );
    }

    if (
      draftStart?.pending === true
    ) {
      return {
        generationStatus:
          "pending",

        stage:
          "drafting",

        reasoningRunId,

        draftRunId,

        openAiStatus:
          draftStart
            ?.openAiStatus ??
          null,

        reasoningValidationAdvisory:
          reasoningPolicy
            .toleratedErrors,
      };
    }
  }

  const draftStatus =
    await callFunction(
      supabaseUrl,
      "legal-petition-draft",
      token,
      {
        action:
          "status",

        draftRunId,
      },
    );

  if (
    draftStatus?.pending === true
  ) {
    return {
      generationStatus:
        "pending",

      stage:
        "drafting",

      reasoningRunId,

      draftRunId,

      openAiStatus:
        draftStatus
          ?.openAiStatus ??
        null,

      reasoningValidationAdvisory:
        reasoningPolicy
          .toleratedErrors,
    };
  }

  if (!draftStatus?.petition) {
    throw new HttpError(
      422,
      "Final Petition Draft tamamlandı ancak petition metni bulunamadı.",
    );
  }

  if (
    draftStatus
      ?.validation
      ?.finalPass !==
    true
  ) {
    const qaReport =
      buildQaReport({
        reasoningStatus,
        draftStatus,
        reasoningPolicy,
      });

    return {
      generationStatus:
        "qa_failed",

      saved:
        false,

      stage:
        "qa",

      reasoningRunId,

      draftRunId,

      petition:
        draftStatus.petition,

      qaReport,

      validation:
        draftStatus.validation,

      reasoningValidationAdvisory:
        reasoningPolicy
          .toleratedErrors,
    };
  }

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
      `Persist öncesi canonical doğrulama başarısız: ${canonical.blockers.join(" | ")}`,
    );
  }

  const persisted =
    await persistFinalDraft(
      supabase,
      userId,
      caseMeta,
      canonical,
      reasoningStatus,
      draftStatus,
      reasoningPolicy,
    );

  const qaReport =
    persisted.qaReport ??
    buildQaReport({
      reasoningStatus,
      draftStatus,
      reasoningPolicy,
    });

  return {
    generationStatus:
      "completed",

    saved:
      true,

    stage:
      "completed",

    reasoningRunId,

    draftRunId,

    versionNo:
      persisted.versionNo,

    petition:
      draftStatus.petition,

    qaReport,

    telemetry: {
      reasoningEstimatedUsd:
        reasoningStatus
          ?.estimatedCostUsd ??
        null,

      draftEstimatedUsd:
        draftStatus
          ?.estimatedCostUsd ??
        null,

      totalEstimatedUsd:
        Number(
          (
            Number(
              reasoningStatus
                ?.estimatedCostUsd ??
              0,
            ) +
            Number(
              draftStatus
                ?.estimatedCostUsd ??
              0,
            )
          ).toFixed(6),
        ),
    },

    reasoningValidationAdvisory:
      reasoningPolicy
        .toleratedErrors,

    alreadyPersisted:
      persisted
        .alreadyPersisted ===
      true,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(
      "ok",
      {
        headers:
          corsHeaders,
      },
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
          packageVersion:
            PACKAGE_VERSION,
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

    if (
      action ===
      "generate_start"
    ) {
      const generation =
        await generateStart(
          supabase,
          supabaseUrl,
          currentUser.id,
          currentUser.token,
          taskId,
        );

      return new Response(
        JSON.stringify({
          success: true,
          packageVersion:
            PACKAGE_VERSION,
          generation,
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

    if (
      action ===
      "generate_status"
    ) {
      const reasoningRunId =
        normalizeText(
          body.reasoningRunId,
        );

      const draftRunId =
        normalizeText(
          body.draftRunId,
        ) ||
        null;

      const generation =
        await generateStatus(
          supabase,
          supabaseUrl,
          currentUser.id,
          currentUser.token,
          taskId,
          reasoningRunId,
          draftRunId,
        );

      const status =
        generation
          ?.generationStatus ===
        "completed"
          ? await buildStatus(
            supabase,
            supabaseUrl,
            currentUser.token,
            taskId,
          )
          : null;

      return new Response(
        JSON.stringify({
          success: true,
          packageVersion:
            PACKAGE_VERSION,
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

    if (action === "generate") {
      throw new HttpError(
        409,
        "Paket 6.1.5 async üretim kullanır. Frontend'i 6.1.5 OppositionDraftManager ile güncelleyin.",
      );
    }

    throw new HttpError(
      400,
      "Geçersiz action.",
    );
  } catch (error) {
    const status =
      error instanceof
      HttpError
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
      "❌ opposition-draft 6.1.5:",
      message,
    );

    return new Response(
      JSON.stringify({
        success: false,
        packageVersion:
          PACKAGE_VERSION,
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
