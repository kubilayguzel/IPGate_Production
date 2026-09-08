import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const PACKAGE_VERSION = "6.1.6";
const INPUT_POLICY_VERSION = "6.1.10";
const ADVOCACY_POLICY_VERSION = "6.1.11";

const OPENAI_MODEL =
  Deno.env.get("LEGAL_REASONING_MODEL") ??
  "gpt-5.6-sol";

const DEFAULT_REASONING_EFFORT =
  Deno.env.get("LEGAL_REASONING_EFFORT") ??
  "high";

const MAX_OUTPUT_TOKENS = Math.max(
  16000,
  Math.min(
    96000,
    Number(
      Deno.env.get("LEGAL_REASONING_MAX_OUTPUT_TOKENS") ??
      "48000",
    ) || 48000,
  ),
);

const RETRY_MAX_OUTPUT_TOKENS = Math.max(
  MAX_OUTPUT_TOKENS,
  Math.min(
    120000,
    Number(
      Deno.env.get("LEGAL_REASONING_RETRY_MAX_OUTPUT_TOKENS") ??
      "96000",
    ) || 96000,
  ),
);

const MAX_OUTPUT_RETRIES = 1;

const VALID_REASONING_EFFORTS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const CORE_ISSUE_TAGS = [
  "goods_services_similarity",
  "sign_similarity",
  "common_element",
  "dominant_element",
  "interdependence",
  "relevant_consumer",
  "association",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparable(value) {
  return String(value ?? "")
    .toLocaleLowerCase("tr-TR")
    .replace(/\s+/g, " ")
    .trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(value) {
  return [
    ...new Set(
      safeArray(value)
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function safeObject(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    ? value
    : {};
}

function clampText(value, max = 50000) {
  const text = String(value ?? "");
  return text.length > max
    ? `${text.slice(0, max)}…`
    : text;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value ?? ""));
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      String(value ?? ""),
    ),
  );

  return Array.from(
    new Uint8Array(digest),
  )
    .map(
      (byte) =>
        byte.toString(16).padStart(2, "0"),
    )
    .join("");
}

async function authenticate(
  req,
  supabaseUrl,
  serviceRoleKey,
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
      "Geçerli kullanıcı oturumu gerekli.",
    );
  }

  const supabase = createClient(
    supabaseUrl,
    serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );

  const {
    data: authData,
    error: authError,
  } = await supabase.auth.getUser(token);

  if (
    authError ||
    !authData?.user?.id
  ) {
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

  if (
    profileError ||
    !profile
  ) {
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
    ![
      "user",
      "admin",
      "superadmin",
    ].includes(
      String(profile.role ?? ""),
    )
  ) {
    throw new HttpError(
      403,
      "Bu hukuki çalışma alanına erişim yetkiniz bulunmuyor.",
    );
  }

  return {
    token,
    userId: authData.user.id,
    role: profile.role,
  };
}

async function invokeProjectFunction({
  supabaseUrl,
  projectApiKey,
  bearerToken,
  functionName,
  body,
}) {
  const response = await fetch(
    `${supabaseUrl}/functions/v1/${functionName}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization":
          `Bearer ${bearerToken}`,
        "apikey": projectApiKey,
      },
      body: JSON.stringify(body),
    },
  );

  const data =
    await response
      .json()
      .catch(
        () => ({}),
      );

  if (!response.ok) {
    throw new Error(
      `${functionName} ${response.status}: ${
        data?.error ??
        data?.message ??
        response.statusText
      }`,
    );
  }

  return data;
}

async function loadCanonicalFromTask({
  supabaseUrl,
  projectApiKey,
  bearerToken,
  taskId,
}) {
  const analysis =
    await invokeProjectFunction({
      supabaseUrl,
      projectApiKey,
      bearerToken,
      functionName:
        "opposition-analysis",
      body: {
        action: "get",
        taskId,
      },
    });

  if (
    analysis?.success !== true ||
    !analysis?.context
  ) {
    throw new HttpError(
      422,
      analysis?.error ??
      "SMK 6/1 canonical analiz bağlamı alınamadı.",
    );
  }

  const context =
    analysis.context;

  if (
    context?.readiness?.canDraft !== true
  ) {
    throw new HttpError(
      422,
      `SMK 6/1 karar ağacı drafting-ready değil: ${
        safeArray(
          context?.readiness?.blockers,
        ).join(" | ") ||
        "Eksik analiz var."
      }`,
    );
  }

  return {
    sourceMode:
      "opposition_analysis_v2",
    sourceFingerprint:
      context?.sourceFingerprint ??
      null,
    taskId:
      String(
        context?.task?.id ??
        taskId,
      ),
    oppositionCaseId:
      String(
        context?.case?.id ??
        "",
      ) || null,
    selectedGrounds:
      uniqueStrings(
        context?.case?.selectedGrounds,
      ),
    caseStatus:
      context?.case?.status ??
      null,
    complexity:
      context?.case?.complexity ??
      null,
    opponent:
      safeObject(
        context?.opponent,
      ),
    priorRights:
      safeArray(
        context?.priorRights,
      ),
    lawyerDecisionTree:
      safeObject(
        context?.formData,
      ),
    readiness:
      safeObject(
        context?.readiness,
      ),
  };
}

function buildDirectCanonical(body) {
  const caseContext =
    safeObject(body?.caseContext);

  const lawyerDecisionTree =
    safeObject(
      body?.lawyerDecisionTree ??
      body?.lawyerFindings,
    );

  if (
    Object.keys(caseContext).length === 0
  ) {
    throw new HttpError(
      400,
      "taskId yoksa caseContext zorunludur.",
    );
  }

  if (
    Object.keys(lawyerDecisionTree).length === 0
  ) {
    throw new HttpError(
      400,
      "taskId yoksa lawyerDecisionTree/lawyerFindings zorunludur.",
    );
  }

  return {
    sourceMode:
      "direct_test_payload",
    sourceFingerprint:
      null,
    taskId:
      body?.taskId
        ? String(body.taskId)
        : null,
    oppositionCaseId:
      body?.oppositionCaseId
        ? String(
          body.oppositionCaseId,
        )
        : null,
    selectedGrounds: [
      "SMK_6_1",
    ],
    caseContext,
    lawyerDecisionTree,
    readiness: {
      canDraft: true,
      directTestPayload: true,
    },
  };
}

function getClassNumbersFromPriorRights(
  priorRights,
) {
  const result = [];

  for (
    const right
    of safeArray(priorRights)
  ) {
    for (
      const cls
      of safeArray(right?.classes)
    ) {
      const n =
        Number(
          cls?.classNo,
        );

      if (
        Number.isFinite(n)
      ) {
        result.push(n);
      }
    }
  }

  return [
    ...new Set(result),
  ].sort(
    (a, b) => a - b,
  );
}

function getOpponentClassNumbers(
  opponent,
) {
  return [
    ...new Set(
      safeArray(
        opponent?.goodsByClass,
      )
        .map(
          (row) =>
            Number(
              row?.classNo,
            ),
        )
        .filter(
          Number.isFinite,
        ),
    ),
  ].sort(
    (a, b) => a - b,
  );
}

function looksLikeSingleLetterCommonElement(
  value,
) {
  const compact =
    String(value ?? "")
      .trim()
      .replace(
        /[^A-Za-zÇĞİÖŞÜçğıöşü0-9]/g,
        "",
      );

  return compact.length === 1;
}

function deriveIssueTags(
  canonical,
  requested,
) {
  const explicit =
    uniqueStrings(requested);

  if (
    explicit.length > 0
  ) {
    return explicit;
  }

  const tags =
    new Set(CORE_ISSUE_TAGS);

  const tree =
    safeObject(
      canonical?.lawyerDecisionTree,
    );

  const sign =
    safeObject(
      tree?.signAssessment,
    );

  if (
    looksLikeSingleLetterCommonElement(
      sign?.commonElements,
    )
  ) {
    tags.add(
      "single_letter_mark",
    );
  }

  const goodsAssessments =
    safeArray(
      tree?.goodsAssessments,
    );

  if (
    goodsAssessments.some(
      (row) =>
        safeArray(
          row?.criteria,
        ).includes(
          "complementary",
        ),
    )
  ) {
    tags.add(
      "complementarity",
    );
  }

  let opposedClasses = [];
  let earlierClasses = [];

  if (
    canonical?.sourceMode ===
    "opposition_analysis_v2"
  ) {
    opposedClasses =
      getOpponentClassNumbers(
        canonical?.opponent,
      );

    earlierClasses =
      getClassNumbersFromPriorRights(
        canonical?.priorRights,
      );
  } else {
    opposedClasses =
      safeArray(
        canonical?.caseContext
          ?.opposedClasses,
      )
        .map(Number)
        .filter(
          Number.isFinite,
        );

    earlierClasses =
      safeArray(
        canonical?.caseContext
          ?.earlierClasses,
      )
        .map(Number)
        .filter(
          Number.isFinite,
        );
  }

  const oneSideRetail =
    opposedClasses.includes(35) ||
    earlierClasses.includes(35);

  const otherSideGoods =
    opposedClasses.some(
      (n) => n >= 1 && n <= 34,
    ) ||
    earlierClasses.some(
      (n) => n >= 1 && n <= 34,
    );

  if (
    oneSideRetail &&
    otherSideGoods
  ) {
    tags.add(
      "goods_retail_relation",
    );
  }

  return [
    ...tags,
  ];
}

function canonicalToResearchContext(
  canonical,
) {
  if (
    canonical?.sourceMode ===
    "direct_test_payload"
  ) {
    return safeObject(
      canonical?.caseContext,
    );
  }

  const tree =
    safeObject(
      canonical?.lawyerDecisionTree,
    );

  const opponent =
    safeObject(
      canonical?.opponent,
    );

  const priorRights =
    safeArray(
      canonical?.priorRights,
    );

  const opposedClasses =
    getOpponentClassNumbers(
      opponent,
    );

  const earlierClasses =
    getClassNumbersFromPriorRights(
      priorRights,
    );

  const earlierMarks =
    priorRights
      .map(
        (right) =>
          normalizeText(
            right?.markText,
          ),
      )
      .filter(Boolean);

  const lawyerFindings = [];

  const global =
    safeObject(
      tree?.globalAssessment,
    );

  const sign =
    safeObject(
      tree?.signAssessment,
    );

  const publicAssessment =
    safeObject(
      tree?.publicAssessment,
    );

  if (
    normalizeText(
      global?.lawyerMerits,
    )
  ) {
    lawyerFindings.push(
      normalizeText(
        global.lawyerMerits,
      ),
    );
  }

  if (
    normalizeText(
      sign?.note,
    )
  ) {
    lawyerFindings.push(
      `İşaretler: ${
        normalizeText(sign.note)
      }`,
    );
  }

  if (
    normalizeText(
      publicAssessment?.note,
    )
  ) {
    lawyerFindings.push(
      `İlgili tüketici: ${
        normalizeText(
          publicAssessment.note,
        )
      }`,
    );
  }

  for (
    const row
    of safeArray(
      tree?.goodsAssessments,
    )
  ) {
    if (
      normalizeText(
        row?.note,
      )
    ) {
      lawyerFindings.push(
        `Sınıf ${
          row?.opponentClassNo
        }: ${
          normalizeText(row.note)
        }`,
      );
    }
  }

  return {
    opposedMark:
      opponent?.markText ??
      null,
    earlierMark:
      earlierMarks.join(" / "),
    legalBasis:
      "SMK 6/1",
    opposedClasses,
    earlierClasses,
    lawyerFindings,
    canonicalDecisionTree: {
      goodsAssessments:
        safeArray(
          tree?.goodsAssessments,
        ),
      signAssessment:
        sign,
      publicAssessment:
        publicAssessment,
      globalAssessment:
        global,
    },

    opponentGoodsByClass:
      safeArray(
        opponent?.goodsByClass,
      )
        .slice(0, 20)
        .map(
          (row) => ({
            classNo:
              Number(row?.classNo),
            text:
              clampText(
                row?.text,
                2500,
              ),
          }),
        ),

    priorGoodsByClass:
      priorRights
        .flatMap(
          (right) =>
            safeArray(
              right?.classes,
            ).map(
              (cls) => ({
                markText:
                  normalizeText(
                    right?.markText,
                  ),
                classNo:
                  Number(
                    cls?.classNo,
                  ),
                items:
                  safeArray(
                    cls?.items,
                  )
                    .map(String)
                    .slice(0, 120),
              }),
            ),
        )
        .slice(0, 40),
  };
}

async function getAuthorityPack({
  supabase,
  supabaseUrl,
  projectApiKey,
  bearerToken,
  body,
  canonical,
  issueTags,
}) {
  const suppliedRunId =
    String(
      body?.researchRunId ??
      "",
    ).trim();

  if (
    suppliedRunId &&
    isUuid(suppliedRunId)
  ) {
    const {
      data: run,
      error,
    } = await supabase
      .from(
        "legal_research_runs",
      )
      .select(
        "id, package_version, status, authority_pack, coverage_score, requested_issue_tags, missing_issue_tags",
      )
      .eq(
        "id",
        suppliedRunId,
      )
      .maybeSingle();

    if (
      error ||
      !run?.authority_pack
    ) {
      throw new HttpError(
        422,
        `researchRunId Authority Pack bulunamadı: ${
          error?.message ??
          "kayıt yok"
        }`,
      );
    }

    return {
      researchRunId:
        run.id,
      authorityPack:
        run.authority_pack,
      researchMode:
        "reuse_research_run",
    };
  }

  const refreshMode =
    body?.refreshResearch;

  if (
    refreshMode ===
    "corpus_only"
  ) {
    const research =
      await invokeProjectFunction({
        supabaseUrl,
        projectApiKey,
        bearerToken,
        functionName:
          "legal-research",
        body: {
          action:
            "research",
          taskId:
            canonical?.taskId ??
            undefined,
          oppositionCaseId:
            canonical
              ?.oppositionCaseId ??
            undefined,
          issueTags,
          coverageThreshold:
            Number(
              body?.coverageThreshold ??
              0.75,
            ),
          requireCompleteCoverage:
            false,
          minCaseAuthorities:
            0,
          minYargitayAuthorities:
            0,
          minEuAuthorities:
            0,
          allowWebSearch:
            false,
          autoVerify:
            true,
          forceGuidelineEvidence:
            true,
          guidelineEvidenceTags:
            [
              "goods_services_similarity",
              "goods_retail_relation",
              "sign_similarity",
              "common_element",
              "dominant_element",
              "interdependence",
            ].filter(
              (tag) =>
                issueTags.includes(tag),
            ).slice(0, 4),
          caseContext:
            canonicalToResearchContext(
              canonical,
            ),
        },
      });

    if (
      research?.ok === true &&
      research?.authorityPack
    ) {
      return {
        researchRunId:
          research?.researchRunId ??
          null,
        authorityPack:
          research.authorityPack,
        researchMode:
          "fresh_verified_corpus_only",
        researchRouting:
          safeObject(
            research?.routing,
          ),
      };
    }

    console.warn(
      "[legal-reasoning] corpus-only advocacy refresh başarısız; mevcut citable pack ile devam ediliyor:",
      research?.error ??
      "bilinmeyen hata",
    );
  } else if (
    refreshMode !== false
  ) {
    const research =
      await invokeProjectFunction({
        supabaseUrl,
        projectApiKey,
        bearerToken,
        functionName:
          "legal-research",
        body: {
          action: "research",
          taskId:
            canonical?.taskId ??
            undefined,
          oppositionCaseId:
            canonical
              ?.oppositionCaseId ??
            undefined,
          issueTags,
          coverageThreshold:
            Number(
              body?.coverageThreshold ??
              0.75,
            ),
          requireCompleteCoverage:
            true,
          minCaseAuthorities:
            Number(
              body?.minCaseAuthorities ??
              3,
            ),
          minYargitayAuthorities:
            Number(
              body?.minYargitayAuthorities ??
              1,
            ),
          minEuAuthorities:
            Number(
              body?.minEuAuthorities ??
              1,
            ),
          allowWebSearch:
            body?.allowWebSearch !==
            false,
          autoVerify: true,
          forceGuidelineEvidence:
            true,
          caseContext:
            canonicalToResearchContext(
              canonical,
            ),
        },
      });

    if (
      research?.ok !== true ||
      !research?.authorityPack
    ) {
      throw new HttpError(
        422,
        research?.error ??
        "Legal research Authority Pack üretmedi.",
      );
    }

    return {
      researchRunId:
        research?.researchRunId ??
        null,
      authorityPack:
        research.authorityPack,
      researchMode:
        "fresh_legal_research",
      researchRouting:
        safeObject(
          research?.routing,
        ),
    };
  }

  const {
    data: authorityPack,
    error,
  } = await supabase.rpc(
    "build_legal_authority_pack",
    {
      requested_issue_tags:
        issueTags,
      max_propositions: 28,
    },
  );

  if (error) {
    throw new Error(
      `Authority Pack RPC: ${
        error.message
      }`,
    );
  }

  return {
    researchRunId: null,
    authorityPack,
    researchMode:
      "current_citable_pack_only",
  };
}

function compactCanonical(
  canonical,
) {
  const payload =
    structuredClone(canonical);

  const json =
    JSON.stringify(payload);

  if (
    json.length <= 140000
  ) {
    return payload;
  }

  return {
    ...payload,
    truncationNotice:
      "Canonical snapshot was trimmed for prompt safety.",
    rawTrimmed:
      clampText(
        json,
        130000,
      ),
  };
}

function compactAuthorityPack(
  pack,
) {
  const modules =
    safeArray(
      pack?.modules,
    )
      .slice(0, 20)
      .map(
        (module) => ({
          moduleKey:
            module?.moduleKey,
          title:
            module?.title,
          issueTags:
            uniqueStrings(
              module?.issueTags,
            ),
          theorySummary:
            clampText(
              module?.theorySummary,
              2500,
            ),
          applicationGuidance:
            clampText(
              module
                ?.applicationGuidance,
              2500,
            ),
          counterargumentGuidance:
            clampText(
              module
                ?.counterargumentGuidance,
              2500,
            ),
        }),
      );

  const propositions =
    safeArray(
      pack?.propositions,
    )
      .slice(0, 36)
      .map(
        (p) => ({
          propositionId:
            String(
              p?.propositionId ??
              "",
            ),
          authorityId:
            String(
              p?.authorityId ??
              "",
            ),
          authorityType:
            p?.authorityType ??
            null,
          authorityLayer:
            p?.authorityLayer ??
            null,
          jurisdiction:
            p?.jurisdiction ??
            null,
          authorityName:
            p?.authorityName ??
            null,
          court:
            p?.court ??
            null,
          chamber:
            p?.chamber ??
            null,
          caseNo:
            p?.caseNo ??
            null,
          decisionNo:
            p?.decisionNo ??
            null,
          decisionDate:
            p?.decisionDate ??
            null,
          authorityTitle:
            p?.authorityTitle ??
            null,
          citationLabel:
            p?.citationLabel ??
            p?.authorityTitle ??
            null,
          sourceUrl:
            p?.sourceUrl ??
            null,
          sourceKind:
            p?.sourceKind ??
            null,
          sourceReliability:
            p?.sourceReliability ??
            null,
          propositionText:
            clampText(
              p?.propositionText,
              4000,
            ),
          holdingText:
            clampText(
              p?.holdingText,
              4500,
            ),
          verificationExcerpt:
            clampText(
              p?.verificationExcerpt,
              2500,
            ),
          sourceLocator:
            p?.sourceLocator ??
            null,
          pageFrom:
            p?.pageFrom ??
            null,
          pageTo:
            p?.pageTo ??
            null,
          quoteSafe:
            p?.quoteSafe === true,
          verifiedQuote:
            p?.quoteSafe === true
              ? clampText(
                  p?.verifiedQuote,
                  1200,
                )
              : "",
          quoteLocator:
            p?.quoteSafe === true
              ? (
                  p?.quoteLocator ??
                  null
                )
              : null,
          quoteSourceUrl:
            p?.quoteSafe === true
              ? (
                  p?.quoteSourceUrl ??
                  null
                )
              : null,
          issueTags:
            uniqueStrings(
              p?.issueTags,
            ),
          useFor:
            uniqueStrings(
              p?.useFor,
            ),
          doNotUseFor:
            uniqueStrings(
              p?.doNotUseFor,
            ),
          confidence:
            asNumber(
              p?.confidence,
            ),
          isCore:
            p?.isCore === true,
        }),
      )
      .filter(
        (p) =>
          isUuid(
            p.propositionId,
          ),
      );

  return {
    packageVersion:
      pack?.packageVersion ??
      null,
    advocacyPolicyVersion:
      ADVOCACY_POLICY_VERSION,
    requestedIssueTags:
      uniqueStrings(
        pack?.requestedIssueTags,
      ),
    coverageScore:
      asNumber(
        pack?.coverageScore,
      ),
    coveredIssueTags:
      uniqueStrings(
        pack?.coveredIssueTags,
      ),
    missingIssueTags:
      uniqueStrings(
        pack?.missingIssueTags,
      ),
    modules,
    propositions,
  };
}

function buildMemoSchema(
  issueTags,
  propositionIds,
) {
  const safeIssueTags =
    issueTags.length
      ? issueTags
      : ["general"];

  const safePropIds =
    propositionIds.length
      ? propositionIds
      : [
        "00000000-0000-0000-0000-000000000000",
      ];

  const counterargumentSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      argument: {
        type: "string",
      },
      response: {
        type: "string",
      },
    },
    required: [
      "argument",
      "response",
    ],
  };

  const authorityApplicationSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      propositionId: {
        type: "string",
        enum: safePropIds,
      },
      useMode: {
        type: "string",
        enum: [
          "direct",
          "analogical",
          "limiting",
        ],
      },
      relevance: {
        type: "string",
      },
      propositionAsApplied: {
        type: "string",
      },
      quoteRecommendation: {
        type: "string",
        enum: [
          "use_if_verified",
          "not_needed",
        ],
      },
    },
    required: [
      "propositionId",
      "useMode",
      "relevance",
      "propositionAsApplied",
      "quoteRecommendation",
    ],
  };

  const scopeAssessmentSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      opponentClassNo: {
        type: "integer",
      },
      requestedScopeMode: {
        type: "string",
        enum: [
          "full_class",
          "partial",
        ],
      },
      manualSimilarityProvided: {
        type: "boolean",
      },
      supportStatus: {
        type: "string",
        enum: [
          "supports_requested_scope",
          "supports_only_partial_scope",
          "insufficient_for_requested_scope",
        ],
      },
      analysisSummary: {
        type: "string",
      },
      strongestConnection: {
        type: "string",
      },
      limitingPoint: {
        type: "string",
      },
      draftingInstruction: {
        type: "string",
      },
    },
    required: [
      "opponentClassNo",
      "requestedScopeMode",
      "manualSimilarityProvided",
      "supportStatus",
      "analysisSummary",
      "strongestConnection",
      "limitingPoint",
      "draftingInstruction",
    ],
  };

  const issueSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      issueTag: {
        type: "string",
        enum: safeIssueTags,
      },
      issueTitle: {
        type: "string",
      },
      question: {
        type: "string",
      },
      lawyerFinding: {
        type: "string",
      },
      rule: {
        type: "string",
      },
      authorityApplications: {
        type: "array",
        items:
          authorityApplicationSchema,
      },
      caseApplication: {
        type: "string",
      },
      counterarguments: {
        type: "array",
        items:
          counterargumentSchema,
      },
      conclusion: {
        type: "string",
      },
      confidence: {
        type: "string",
        enum: [
          "high",
          "medium",
          "low",
        ],
      },
      factualLimitations: {
        type: "array",
        items: {
          type: "string",
        },
      },
      draftingInstructions: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },
    required: [
      "issueTag",
      "issueTitle",
      "question",
      "lawyerFinding",
      "rule",
      "authorityApplications",
      "caseApplication",
      "counterarguments",
      "conclusion",
      "confidence",
      "factualLimitations",
      "draftingInstructions",
    ],
  };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      memorandumVersion: {
        type: "string",
      },
      legalBasis: {
        type: "string",
      },
      executiveAssessment: {
        type: "object",
        additionalProperties: false,
        properties: {
          overallConclusion: {
            type: "string",
            enum: [
              "supports_opposition",
              "borderline",
              "does_not_support_opposition",
            ],
          },
          summary: {
            type: "string",
          },
          strongestPoints: {
            type: "array",
            items: {
              type: "string",
            },
          },
          vulnerabilities: {
            type: "array",
            items: {
              type: "string",
            },
          },
          factualDependencies: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
        required: [
          "overallConclusion",
          "summary",
          "strongestPoints",
          "vulnerabilities",
          "factualDependencies",
        ],
      },
      issues: {
        type: "array",
        items: issueSchema,
      },
      scopeAssessments: {
        type: "array",
        items:
          scopeAssessmentSchema,
      },

      crossIssueSynthesis: {
        type: "object",
        additionalProperties: false,
        properties: {
          interdependenceAnalysis: {
            type: "string",
          },
          associationAnalysis: {
            type: "string",
          },
          conclusion: {
            type: "string",
          },
          nonOverreachRules: {
            type: "array",
            items: {
              type: "string",
            },
          },
        },
        required: [
          "interdependenceAnalysis",
          "associationAnalysis",
          "conclusion",
          "nonOverreachRules",
        ],
      },
      citationLedger: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            propositionId: {
              type: "string",
              enum: safePropIds,
            },
            usedForIssueTags: {
              type: "array",
              items: {
                type: "string",
                enum: safeIssueTags,
              },
            },
            propositionAsUsed: {
              type: "string",
            },
          },
          required: [
            "propositionId",
            "usedForIssueTags",
            "propositionAsUsed",
          ],
        },
      },
      unresolvedQuestions: {
        type: "array",
        items: {
          type: "string",
        },
      },
      prohibitedOrUnsupportedClaims: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },
    required: [
      "memorandumVersion",
      "legalBasis",
      "executiveAssessment",
      "issues",
      "scopeAssessments",
      "crossIssueSynthesis",
      "citationLedger",
      "unresolvedQuestions",
      "prohibitedOrUnsupportedClaims",
    ],
  };
}

function buildSystemInstructions() {
  return `
You are EVREKA Legal Intelligence's senior trademark opposition counsel.

TASK
Prepare an INTERNAL LEGAL REASONING MEMORANDUM for a Turkish trademark opposition under SMK 6/1.
This is NOT the final petition. It is the controlled reasoning layer that a later drafting model must follow.

ABSOLUTE SOURCE HIERARCHY
1. CANONICAL CASE SNAPSHOT is binding for facts, parties, marks, classes and actual goods/services text.
2. EXPLICIT LAWYER DECISION TREE findings are binding whenever the lawyer supplied them.
3. VERIFIED AUTHORITY PACK is the ONLY authority universe you may cite.
4. Your own general legal knowledge may help organize reasoning, but it CANNOT create, identify, cite, or attribute any authority outside the verified pack.
5. Never invent a factual use, market circumstance, reputation fact, consumer fact, goods/service wording, or other missing evidence.

OPTIONAL GOODS/SERVICES INPUT POLICY — ${INPUT_POLICY_VERSION}
- In the goodsAssessments rows, similarityLevel, matchedPriorClasses and criteria are OPTIONAL lawyer inputs.
- Their absence is NOT a factual gap and is NOT a reason to stop the goods/services analysis.
- If one or more of those fields are supplied, treat the supplied value as an explicit lawyer finding and do not contradict or silently replace it.
- If they are absent, independently perform the LEGAL comparison from the canonical goods/service texts, Nice classes and verified authority pack.
- When doing that fallback analysis, do not invent commercial facts not visible in the canonical record. Reason only from the wording, ordinary legal comparison criteria and verified propositions.
- A missing manual similarity level means "no lawyer override supplied"; it does NOT mean "not similar" or "not established".
- A missing matchedPriorClasses list means the selected prior mark's full canonical class/goods scope remains available for legal comparison.
- A missing criteria list means you must identify only the criteria genuinely supported by the canonical wording and verified authority; do not manufacture complementarity, competition, channels or consumer overlap.

REQUESTED REFUSAL SCOPE / ADVOCACY CONSISTENCY — ${ADVOCACY_POLICY_VERSION}
- Her requestedRefusal=true rakip sınıf için scopeAssessments içinde TAM BİR kayıt üret.
- Avukat "full_class" ret istemişse önce bu talebi hukuken SAVUNABİLMEK için canonical item'ları item/grup bazında gerçekten analiz et; sırf bazı alt kalemler uzak diye otomatik şekilde talebi zayıflatma.
- Manuel benzerlik seviyesi yoksa bu bir eksiklik değildir; Kılavuzdaki karşılaştırma ölçütleri, mümkünse somut Kılavuz örnekleri ve verified authorities ile kendi hukuki analizini tamamla.
- Manuel benzerlik seviyesi varsa SEVİYEYİ değiştirme. Bunun nedenini nitelik, amaç, kullanım, tamamlayıcılık, rekabet, kanal, tüketici veya ticari kaynak bağlantısı gibi gerçekten desteklenen ölçütlerle açıkla.
- İstenen tam/kısmi kapsam dürüstçe savunulamıyorsa supportStatus ile bunu INTERNAL olarak işaretle. Nihai dilekçe kendi talebini çürüten bir paragraf üretmemelidir; bu durumda dosya avukat kapsam incelemesine gitmelidir.
- "supports_only_partial_scope" veya "insufficient_for_requested_scope" kararı ancak önce mümkün tüm somut bağlantıları ve verified Kılavuz/karar desteğini araştırdıktan sonra verilebilir.

AUTHORITY RULES
- Cite/use authorities ONLY through propositionId fields from the Authority Pack.
- Never invent a court, chamber, case number, decision number, date, holding, quotation, or authority.
- Never cite a proposition beyond its verified propositionText / holdingText / useFor scope.
- Respect doNotUseFor strictly.
- Do not write case numbers/ECLI/Yargıtay E.-K. references in free prose. Authority identity will be deterministically attached after your output.
- Authority Pack'te quoteSafe=true + verifiedQuote bulunan proposition, dilekçe katmanında güvenli doğrudan alıntı yüzeyidir. Kritik bir meselede alıntı gerçekten argümanı güçlendirecekse authorityApplications.quoteRecommendation="use_if_verified" de.
- Özellikle Kılavuz proposition'ında somut mal/hizmet veya işaret kıyaslama örneği bulunuyorsa ve somut dosyayla anlamlı ölçüde örtüşüyorsa bunu draftingInstructions içinde açıkça öne çıkar.
- Distinguish DIRECT authority, ANALOGICAL use, and LIMITING authority.
- For core issues, use a LAYERED authority method when the supplied pack permits it:
  (a) TÜRKPATENT Marka İnceleme Kılavuzu for local examination doctrine,
  (b) verified Yargıtay/Turkish authority for Turkish judicial support,
  (c) verified CJEU/General Court authority for EU doctrinal support.
- Do NOT force all three into every issue. But when all three layers are materially relevant and available, the memorandum should not silently omit the Turkish judicial layer.
- A Turkish authority that is only analogically relevant must be labelled analogical; do not upgrade it to a direct holding.

LAWYER CONTROL RULE
The lawyer's EXPLICIT decision-tree findings are not suggestions. They are the factual/legal position to be developed.
You may identify tension, vulnerability, missing proof, or counterargument, but you must not silently replace an explicit lawyer finding.
For optional goods/services fields left blank, there is no lawyer finding to replace; apply the Optional Goods/Services Input Policy above.

ANTI-OVERREACH RULES
- A common letter/element is NOT automatically dominant, principal, core, or highly distinctive.
- A single-letter mark is NOT automatically strong or weak; use only lawyer findings and verified authority.
- Physical goods and Class 35 retail services must NOT be described as having the same nature merely because the retail service concerns those goods.
- For goods↔retail, separate nature/purpose/method-of-use from complementarity, channels, consumer overlap, and commercial-origin perception.
- Do not exaggerate "complementarity", "competition", consumer attention, or distinctiveness beyond the lawyer's finding and verified authority.
- Interdependence is holistic; do not state that one factor automatically compensates for another.
- Association/series-mark reasoning requires a concrete source-perception analysis; do not assume it abstractly.
- An authority about absolute distinctiveness cannot be presented as a direct likelihood-of-confusion holding unless the Authority Pack expressly permits it.

METHOD FOR EACH ISSUE
Rule → verified authority proposition(s) → exact application to canonical facts →
best counterargument → response → bounded conclusion → drafting instruction.

QUALITY STANDARD
Write as an experienced Turkish/EU trademark litigator preparing a memorandum for another senior lawyer:
analytical, precise, balanced, concrete, and useful for drafting.
Avoid generic textbook filler.
- Dilekçeye aktarılacak draftingInstructions "dosyada belirlenen", "dosyada kaydedilen", "bağlayıcı avukat bulgusu", "Decision Tree", "canonical" gibi iç sistem dili taşımamalıdır.
- Nihai dilekçe için önerilen otorite kullanımı şu mantığı izlemelidir:
  hukuki/somut bulgu → doğrulanmış authority → varsa kısa exact quote → somut olaya uygulama → ara sonuç.
Use Turkish.
`.trim();
}

function buildDynamicPrompt({
  canonical,
  authorityPack,
  issueTags,
}) {
  return `
REQUESTED ISSUES
${JSON.stringify(issueTags)}

CANONICAL CASE SNAPSHOT
${JSON.stringify(canonical)}

VERIFIED AUTHORITY PACK
${JSON.stringify(authorityPack)}

FINAL INSTRUCTIONS
- Cover every requested issue that is factually relevant.
- If an issue cannot responsibly be resolved, state the limitation instead of inventing a conclusion.
- Strong arguments and vulnerabilities must both be visible.
- Every authority use must point to a propositionId from the supplied pack.
- Inspect authorityPack.authorityCoverage. If verified Yargıtay + EU + guideline layers are available, use them across the memorandum where legally material; avoid citation dumping.
- quoteSafe/verifiedQuote bulunan otoriteleri kritik ve somut meselelerde quoteRecommendation ile seç; her paragrafı alıntıyla doldurma.
- Her requestedRefusal=true sınıfı scopeAssessments içinde değerlendir. Manuel benzerlik yoksa kendi hukuki analizini tamamla; manuel seviye varsa onu koru ve gerekçelendir.
- The memorandum should be sufficiently developed to support a later high-quality petition, but must remain an internal reasoning memorandum.
`.trim();
}

async function startOpenAiSolBackground({
  apiKey,
  model,
  reasoningEffort,
  safetyIdentifier,
  schema,
  canonical,
  authorityPack,
  issueTags,
  maxOutputTokens = MAX_OUTPUT_TOKENS,
}) {
  const body = {
    model,
    background: true,
    store: true,
    instructions:
      buildSystemInstructions(),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              buildDynamicPrompt({
                canonical,
                authorityPack,
                issueTags,
              }),
          },
        ],
      },
    ],
    reasoning: {
      effort: reasoningEffort,
    },
    text: {
      verbosity: "high",
      format: {
        type: "json_schema",
        name:
          "evreka_legal_reasoning_memorandum",
        strict: true,
        schema,
      },
    },
    max_output_tokens:
      maxOutputTokens,
    truncation: "disabled",
    prompt_cache_key:
      "evreka-legal-reasoning-6.1.11",
    safety_identifier:
      safetyIdentifier,
    metadata: {
      package_version:
        PACKAGE_VERSION,
      advocacy_policy_version:
        ADVOCACY_POLICY_VERSION,
      workload:
        "trademark_opposition_reasoning",
    },
  };

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Authorization":
          `Bearer ${apiKey}`,
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const data =
    await response
      .json()
      .catch(
        () => ({}),
      );

  if (!response.ok) {
    throw new Error(
      `OpenAI Responses API ${
        response.status
      }: ${
        data?.error?.message ??
        response.statusText
      }`,
    );
  }

  if (!data?.id) {
    throw new Error(
      "OpenAI background response id dönmedi.",
    );
  }

  return data;
}

async function retrieveOpenAiResponse({
  apiKey,
  responseId,
}) {
  const response = await fetch(
    `https://api.openai.com/v1/responses/${
      encodeURIComponent(responseId)
    }`,
    {
      method: "GET",
      headers: {
        "Authorization":
          `Bearer ${apiKey}`,
        "Content-Type":
          "application/json",
      },
    },
  );

  const data =
    await response
      .json()
      .catch(
        () => ({}),
      );

  if (!response.ok) {
    throw new Error(
      `OpenAI retrieve ${
        response.status
      }: ${
        data?.error?.message ??
        response.statusText
      }`,
    );
  }

  return data;
}

function extractMemoFromOpenAiResponse(
  data,
) {
  if (
    data?.status !== "completed"
  ) {
    throw new Error(
      `OpenAI response tamamlanmadı: ${
        data?.status ??
        "unknown"
      }${
        data?.incomplete_details
          ?.reason
          ? ` / ${
            data.incomplete_details
              .reason
          }`
          : ""
      }`,
    );
  }

  let outputText =
    typeof data?.output_text ===
    "string"
      ? data.output_text
      : "";

  if (!outputText) {
    outputText =
      safeArray(
        data?.output,
      )
        .filter(
          (item) =>
            item?.type ===
            "message",
        )
        .flatMap(
          (item) =>
            safeArray(
              item?.content,
            ),
        )
        .filter(
          (part) =>
            part?.type ===
            "output_text",
        )
        .map(
          (part) =>
            String(
              part?.text ??
              "",
            ),
        )
        .join("")
        .trim();
  }

  if (!outputText) {
    throw new Error(
      "OpenAI boş structured output döndürdü.",
    );
  }

  try {
    return JSON.parse(outputText);
  } catch (error) {
    throw new Error(
      `OpenAI structured output parse hatası: ${
        error?.message ??
        String(error)
      }`,
    );
  }
}

async function finalizeCompletedResponse({
  supabase,
  reasoningRunId,
  run,
  openAiResponse,
}) {
  const memo =
    extractMemoFromOpenAiResponse(
      openAiResponse,
    );

  const authorityPack =
    safeObject(
      run?.authority_pack_snapshot,
    );

  const issueTags =
    uniqueStrings(
      run?.issue_tags,
    );

  const validation =
    validateMemo({
      memo,
      authorityPack,
      issueTags,
      canonical:
        safeObject(
          run?.canonical_snapshot,
        ),
    });

  const enrichedMemo =
    enrichMemo(
      memo,
      authorityPack,
    );

  const finalAttemptUsage =
    safeObject(
      openAiResponse?.usage,
    );

  const finalAttemptCostUsd =
    estimateOpenAiCost(
      finalAttemptUsage,
    );

  const retryCostUsd =
    asNumber(
      run
        ?.retry_estimated_cost_usd,
    );

  const estimatedCostUsd =
    Number(
      (
        finalAttemptCostUsd +
        retryCostUsd
      ).toFixed(6),
    );

  const usage = {
    ...finalAttemptUsage,

    output_attempt_count:
      Math.max(
        1,
        asNumber(
          run
            ?.output_attempt_count,
        ) || 1,
      ),

    max_output_tokens:
      asNumber(
        run
          ?.max_output_tokens,
      ) ||
      MAX_OUTPUT_TOKENS,

    retry_attempts:
      safeArray(
        run
          ?.retry_usage,
      ),

    retry_estimated_cost_usd:
      retryCostUsd,

    final_attempt_estimated_cost_usd:
      finalAttemptCostUsd,

    total_estimated_cost_usd:
      estimatedCostUsd,
  };

  const finalStatus =
    validation?.finalPass
      ? "completed"
      : "validation_failed";

  await updateRun(
    supabase,
    reasoningRunId,
    {
      status:
        finalStatus,
      memorandum:
        enrichedMemo,
      validation,
      openai_response_id:
        openAiResponse?.id ??
        run?.openai_response_id ??
        null,
      openai_status:
        openAiResponse?.status ??
        null,
      usage,
      estimated_cost_usd:
        estimatedCostUsd,
      completed_at:
        new Date()
          .toISOString(),
      error_message:
        null,
    },
  );

  return {
    finalStatus,
    validation,
    enrichedMemo,
    usage,
    estimatedCostUsd,
  };
}

function propositionMapFromPack(
  authorityPack,
) {
  const map =
    new Map();

  for (
    const proposition
    of safeArray(
      authorityPack
        ?.propositions,
    )
  ) {
    const id =
      String(
        proposition
          ?.propositionId ??
        "",
      );

    if (
      isUuid(id)
    ) {
      map.set(
        id,
        proposition,
      );
    }
  }

  return map;
}

function findUnknownAuthorityPatterns(
  rawMemo,
  authorityPack,
) {
  const text =
    JSON.stringify(
      rawMemo,
    );

  const allowedText =
    normalizeComparable(
      JSON.stringify(
        safeArray(
          authorityPack
            ?.propositions,
        ).map(
          (p) => ({
            citationLabel:
              p?.citationLabel,
            court:
              p?.court,
            chamber:
              p?.chamber,
            caseNo:
              p?.caseNo,
            decisionNo:
              p?.decisionNo,
            authorityTitle:
              p?.authorityTitle,
          }),
        ),
      ),
    );

  const patterns = [
    /\b[CT]-\d{1,5}\/\d{2,4}(?:\s*P)?\b/gi,
    /\bECLI:[A-Z0-9:.-]+\b/gi,
    /\bE\.\s*\d{4}\/\d+\b/gi,
    /\bK\.\s*\d{4}\/\d+\b/gi,
  ];

  const unknown = [];

  for (
    const pattern
    of patterns
  ) {
    for (
      const match
      of text.matchAll(pattern)
    ) {
      const ref =
        String(
          match[0] ??
          "",
        );

      if (
        ref &&
        !allowedText.includes(
          normalizeComparable(ref),
        )
      ) {
        unknown.push(ref);
      }
    }
  }

  return [
    ...new Set(unknown),
  ];
}


function requestedScopeRows(
  canonical,
) {
  const tree =
    safeObject(
      canonical?.lawyerDecisionTree,
    );

  return safeArray(
    tree?.goodsAssessments,
  )
    .filter(
      (row) =>
        row?.requestedRefusal === true,
    )
    .map(
      (row) => ({
        classNo:
          Number(
            row?.opponentClassNo,
          ),
        requestedScopeMode:
          [
            "full_class",
            "partial",
          ].includes(
            String(
              row?.refusalScopeMode ??
              "",
            ),
          )
            ? String(
                row.refusalScopeMode,
              )
            : "full_class",
        manualSimilarityProvided:
          Boolean(
            normalizeText(
              row?.similarityLevel,
            ) &&
            normalizeText(
              row?.similarityLevel,
            ) !== "not_assessed",
          ),
      }),
    )
    .filter(
      (row) =>
        Number.isFinite(
          row.classNo,
        ),
    );
}

function validateMemo({
  memo,
  authorityPack,
  issueTags,
  canonical,
}) {
  const errors = [];
  const warnings = [];

  const allowedIssues =
    new Set(issueTags);

  const propositionMap =
    propositionMapFromPack(
      authorityPack,
    );

  if (
    propositionMap.size === 0
  ) {
    errors.push(
      "Authority Pack citable proposition içermiyor.",
    );
  }

  const usedIds = [];

  for (
    const issue
    of safeArray(
      memo?.issues,
    )
  ) {
    const tag =
      String(
        issue?.issueTag ??
        "",
      );

    if (
      !allowedIssues.has(tag)
    ) {
      errors.push(
        `İzin verilmeyen issueTag: ${tag}`,
      );
    }

    for (
      const application
      of safeArray(
        issue
          ?.authorityApplications,
      )
    ) {
      const id =
        String(
          application
            ?.propositionId ??
          "",
        );

      usedIds.push(id);

      const proposition =
        propositionMap.get(id);

      if (!proposition) {
        errors.push(
          `Authority Pack dışında propositionId: ${id}`,
        );
        continue;
      }

      const useMode =
        String(
          application?.useMode ??
          "",
        );

      const propositionIssues =
        uniqueStrings(
          proposition?.issueTags,
        );

      const useFor =
        uniqueStrings(
          proposition?.useFor,
        );

      const doNotUseFor =
        uniqueStrings(
          proposition
            ?.doNotUseFor,
        );

      if (
        doNotUseFor.includes(tag)
      ) {
        errors.push(
          `${id} proposition ${tag} için doNotUseFor kapsamında.`,
        );
      }

      if (
        useMode === "direct" &&
        !propositionIssues.includes(
          tag,
        ) &&
        !useFor.includes(tag)
      ) {
        errors.push(
          `${id} proposition ${tag} için direct kullanıma doğrulanmamış.`,
        );
      }

      if (
        useMode === "analogical" &&
        !propositionIssues.includes(
          tag,
        )
      ) {
        warnings.push(
          `${id} proposition ${tag} için analogical kullanıldı.`,
        );
      }
    }
  }

  for (
    const item
    of safeArray(
      memo?.citationLedger,
    )
  ) {
    const id =
      String(
        item?.propositionId ??
        "",
      );

    usedIds.push(id);

    if (
      !propositionMap.has(id)
    ) {
      errors.push(
        `Citation ledger Authority Pack dışında propositionId içeriyor: ${id}`,
      );
    }

    for (
      const tag
      of uniqueStrings(
        item
          ?.usedForIssueTags,
      )
    ) {
      if (
        !allowedIssues.has(tag)
      ) {
        errors.push(
          `Citation ledger izin verilmeyen issueTag: ${tag}`,
        );
      }
    }
  }

  const unknownRefs =
    findUnknownAuthorityPatterns(
      memo,
      authorityPack,
    );

  if (
    unknownRefs.length > 0
  ) {
    errors.push(
      `Authority Pack dışında serbest metin authority referansı bulundu: ${
        unknownRefs.join(", ")
      }`,
    );
  }

  const uniqueUsed =
    [
      ...new Set(
        usedIds.filter(Boolean),
      ),
    ];

  if (
    uniqueUsed.length === 0
  ) {
    warnings.push(
      "Memorandum hiçbir verified proposition kullanmadı.",
    );
  }

  const usedProps =
    uniqueUsed
      .map(
        (id) =>
          propositionMap.get(id),
      )
      .filter(Boolean);

  const allProps =
    [
      ...propositionMap.values(),
    ];

  const layerOf =
    (prop) => {
      const explicit =
        String(
          prop?.authorityLayer ??
          "",
        );

      if (explicit) {
        return explicit;
      }

      if (
        String(
          prop?.authorityType ??
          "",
        ) === "guideline"
      ) {
        return "guideline";
      }

      const haystack =
        normalizeComparable(
          [
            prop?.jurisdiction,
            prop?.authorityName,
            prop?.court,
            prop?.citationLabel,
            prop?.decisionNo,
          ]
            .filter(Boolean)
            .join(" "),
        );

      if (
        /yargıtay|yargitay/.test(
          haystack,
        )
      ) {
        return "tr_yargitay";
      }

      if (
        /european union|court of justice|general court|adalet divanı|adalet divani|ecli:eu:|euipo/.test(
          haystack,
        )
      ) {
        return "eu";
      }

      return "other";
    };

  const availableLayers =
    new Set(
      allProps.map(layerOf),
    );

  const usedLayers =
    new Set(
      usedProps.map(layerOf),
    );

  if (
    availableLayers.has(
      "tr_yargitay",
    ) &&
    !usedLayers.has(
      "tr_yargitay",
    )
  ) {
    warnings.push(
      "Verified Yargıtay proposition mevcut olduğu halde memorandumda kullanılmadı.",
    );
  }

  if (
    availableLayers.has(
      "eu",
    ) &&
    !usedLayers.has(
      "eu",
    )
  ) {
    warnings.push(
      "Verified AB proposition mevcut olduğu halde memorandumda kullanılmadı.",
    );
  }

  if (
    availableLayers.has(
      "guideline",
    ) &&
    !usedLayers.has(
      "guideline",
    )
  ) {
    warnings.push(
      "Verified TÜRKPATENT Kılavuzu proposition mevcut olduğu halde memorandumda kullanılmadı.",
    );
  }

  const expectedScopes =
    requestedScopeRows(
      canonical,
    );

  const scopeMap =
    new Map(
      safeArray(
        memo?.scopeAssessments,
      )
        .map(
          (item) => [
            Number(
              item?.opponentClassNo,
            ),
            item,
          ],
        ),
    );

  const scopeReviewRequired = [];

  for (
    const expected
    of expectedScopes
  ) {
    const item =
      scopeMap.get(
        expected.classNo,
      );

    if (!item) {
      errors.push(
        `Sınıf ${expected.classNo} için scopeAssessment bulunmuyor.`,
      );
      continue;
    }

    if (
      String(
        item?.requestedScopeMode ??
        "",
      ) !==
      expected.requestedScopeMode
    ) {
      errors.push(
        `Sınıf ${expected.classNo} scopeAssessment ret kapsamıyla uyumsuz.`,
      );
    }

    if (
      item?.manualSimilarityProvided !==
      expected.manualSimilarityProvided
    ) {
      warnings.push(
        `Sınıf ${expected.classNo} manualSimilarityProvided sinyali canonical veriyle uyumsuz.`,
      );
    }

    const supportStatus =
      String(
        item?.supportStatus ??
        "",
      );

    if (
      supportStatus !==
      "supports_requested_scope"
    ) {
      scopeReviewRequired.push({
        classNo:
          expected.classNo,
        requestedScopeMode:
          expected.requestedScopeMode,
        supportStatus,
        analysisSummary:
          normalizeText(
            item?.analysisSummary,
          ),
        limitingPoint:
          normalizeText(
            item?.limitingPoint,
          ),
      });

      warnings.push(
        `SCOPE_REVIEW_REQUIRED: Sınıf ${expected.classNo} / ${supportStatus}`,
      );
    }
  }

  for (
    const item
    of safeArray(
      memo?.scopeAssessments,
    )
  ) {
    const classNo =
      Number(
        item?.opponentClassNo,
      );

    if (
      Number.isFinite(classNo) &&
      !expectedScopes.some(
        (row) =>
          row.classNo ===
          classNo,
      )
    ) {
      warnings.push(
        `Ret talep edilmeyen Sınıf ${classNo} için gereksiz scopeAssessment üretildi.`,
      );
    }
  }

  return {
    finalPass:
      errors.length === 0,
    errors,
    warnings,
    usedPropositionIds:
      uniqueUsed,
    scopeReviewRequired,
    advocacyPolicyVersion:
      ADVOCACY_POLICY_VERSION,
    checkedAt:
      new Date()
        .toISOString(),
  };
}

function enrichMemo(
  memo,
  authorityPack,
) {
  const propositionMap =
    propositionMapFromPack(
      authorityPack,
    );

  const enrichApplication =
    (application) => {
      const proposition =
        propositionMap.get(
          String(
            application
              ?.propositionId ??
            "",
          ),
        );

      if (!proposition) {
        return application;
      }

      return {
        ...application,
        citationLabel:
          proposition
            ?.citationLabel ??
          proposition
            ?.authorityTitle ??
          null,
        authorityType:
          proposition
            ?.authorityType ??
          null,
        authorityLayer:
          proposition
            ?.authorityLayer ??
          null,
        jurisdiction:
          proposition
            ?.jurisdiction ??
          null,
        verifiedProposition:
          proposition
            ?.propositionText ??
          null,
        sourceLocator:
          proposition
            ?.sourceLocator ??
          null,
        sourceUrl:
          proposition
            ?.sourceUrl ??
          null,
        quoteSafe:
          proposition
            ?.quoteSafe ===
            true,
        verifiedQuote:
          proposition
            ?.quoteSafe ===
            true
              ? (
                  proposition
                    ?.verifiedQuote ??
                  ""
                )
              : "",
        quoteLocator:
          proposition
            ?.quoteSafe ===
            true
              ? (
                  proposition
                    ?.quoteLocator ??
                  null
                )
              : null,
        useFor:
          uniqueStrings(
            proposition
              ?.useFor,
          ),
        doNotUseFor:
          uniqueStrings(
            proposition
              ?.doNotUseFor,
          ),
      };
    };

  return {
    ...memo,
    issues:
      safeArray(
        memo?.issues,
      ).map(
        (issue) => ({
          ...issue,
          authorityApplications:
            safeArray(
              issue
                ?.authorityApplications,
            ).map(
              enrichApplication,
            ),
        }),
      ),
    citationLedger:
      safeArray(
        memo
          ?.citationLedger,
      ).map(
        (item) => {
          const proposition =
            propositionMap.get(
              String(
                item
                  ?.propositionId ??
                "",
              ),
            );

          return {
            ...item,
            citationLabel:
              proposition
                ?.citationLabel ??
              proposition
                ?.authorityTitle ??
              null,
            verifiedProposition:
              proposition
                ?.propositionText ??
              null,
            sourceLocator:
              proposition
                ?.sourceLocator ??
              null,
            sourceUrl:
              proposition
                ?.sourceUrl ??
              null,
            quoteSafe:
              proposition
                ?.quoteSafe ===
                true,
            verifiedQuote:
              proposition
                ?.quoteSafe ===
                true
                  ? (
                      proposition
                        ?.verifiedQuote ??
                      ""
                    )
                  : "",
            quoteLocator:
              proposition
                ?.quoteSafe ===
                true
                  ? (
                      proposition
                        ?.quoteLocator ??
                      null
                    )
                  : null,
          };
        },
      ),
  };
}

function estimateOpenAiCost(
  usage,
) {
  const inputTokens =
    asNumber(
      usage?.input_tokens,
    );

  const cachedTokens =
    asNumber(
      usage
        ?.input_tokens_details
        ?.cached_tokens,
    );

  const nonCachedTokens =
    Math.max(
      0,
      inputTokens -
      cachedTokens,
    );

  const outputTokens =
    asNumber(
      usage?.output_tokens,
    );

  // GPT-5.6 Sol current text token prices:
  // input $4/M, cached input $0.40/M, output $20/M.
  const cost =
    (
      nonCachedTokens *
      4
      +
      cachedTokens *
      0.4
      +
      outputTokens *
      20
    ) / 1_000_000;

  return Number(
    cost.toFixed(6),
  );
}

async function createRun(
  supabase,
  payload,
) {
  const {
    data,
    error,
  } = await supabase
    .from(
      "legal_reasoning_runs",
    )
    .insert(payload)
    .select("id")
    .single();

  if (
    error ||
    !data?.id
  ) {
    throw new Error(
      `Legal reasoning run oluşturulamadı: ${
        error?.message ??
        "id yok"
      }`,
    );
  }

  return data.id;
}

async function updateRun(
  supabase,
  runId,
  patch,
) {
  const {
    error,
  } = await supabase
    .from(
      "legal_reasoning_runs",
    )
    .update(patch)
    .eq(
      "id",
      runId,
    );

  if (error) {
    throw new Error(
      `Legal reasoning run güncellenemedi: ${
        error.message
      }`,
    );
  }
}

async function loadReasoningRunForUser({
  supabase,
  reasoningRunId,
  auth,
}) {
  const {
    data: run,
    error,
  } = await supabase
    .from(
      "legal_reasoning_runs",
    )
    .select(`
      id,
      research_run_id,
      task_id,
      opposition_case_id,
      package_version,
      status,
      model,
      reasoning_effort,
      issue_tags,
      source_fingerprint,
      authority_pack_fingerprint,
      canonical_snapshot,
      authority_pack_snapshot,
      memorandum,
      validation,
      openai_response_id,
      openai_status,
      output_attempt_count,
      max_output_tokens,
      retry_usage,
      retry_estimated_cost_usd,
      usage,
      estimated_cost_usd,
      created_by,
      error_message,
      started_at,
      completed_at,
      created_at,
      updated_at
    `)
    .eq(
      "id",
      reasoningRunId,
    )
    .maybeSingle();

  if (
    error ||
    !run
  ) {
    throw new HttpError(
      404,
      `Legal reasoning run bulunamadı: ${
        error?.message ??
        "kayıt yok"
      }`,
    );
  }

  const isAdmin =
    [
      "admin",
      "superadmin",
    ].includes(
      String(
        auth?.role ??
        "",
      ),
    );

  if (
    !isAdmin &&
    String(
      run?.created_by ??
      "",
    ) !== String(
      auth?.userId ??
      "",
    )
  ) {
    throw new HttpError(
      403,
      "Bu reasoning run kaydına erişim yetkiniz yok.",
    );
  }

  return run;
}

serve(async (req) => {
  if (
    req.method === "OPTIONS"
  ) {
    return new Response(
      "ok",
      {
        headers:
          corsHeaders,
      },
    );
  }

  if (
    req.method !== "POST"
  ) {
    return jsonResponse(
      {
        ok: false,
        packageVersion:
          PACKAGE_VERSION,
        error:
          "Yalnız POST.",
      },
      405,
    );
  }

  const supabaseUrl =
    Deno.env.get(
      "SUPABASE_URL",
    ) ?? "";

  const anonKey =
    Deno.env.get(
      "SUPABASE_ANON_KEY",
    ) ?? "";

  const serviceRoleKey =
    Deno.env.get(
      "SUPABASE_SERVICE_ROLE_KEY",
    ) ?? "";

  const openAiApiKey =
    Deno.env.get(
      "OPENAI_API_KEY",
    ) ?? "";

  if (
    !supabaseUrl ||
    !serviceRoleKey
  ) {
    return jsonResponse(
      {
        ok: false,
        packageVersion:
          PACKAGE_VERSION,
        error:
          "Supabase environment eksik.",
      },
      500,
    );
  }

  let auth;

  try {
    auth =
      await authenticate(
        req,
        supabaseUrl,
        serviceRoleKey,
      );
  } catch (error) {
    const status =
      error instanceof
      HttpError
        ? error.status
        : 401;

    return jsonResponse(
      {
        ok: false,
        packageVersion:
          PACKAGE_VERSION,
        error:
          error?.message ??
          "Yetkilendirme hatası.",
      },
      status,
    );
  }

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

  let body = {};

  try {
    body =
      await req.json();
  } catch {
    body = {};
  }

  const action =
    String(
      body?.action ??
      "reason",
    );

  if (
    action === "stats"
  ) {
    const {
      data,
      error,
    } = await supabase.rpc(
      "legal_reasoning_stats",
    );

    if (error) {
      return jsonResponse(
        {
          ok: false,
          packageVersion:
            PACKAGE_VERSION,
          error:
            error.message,
        },
        500,
      );
    }

    return jsonResponse(
      {
        ok: true,
        packageVersion:
          PACKAGE_VERSION,
        stats: data,
      },
    );
  }

  if (
    ![
      "reason",
      "status",
    ].includes(action)
  ) {
    return jsonResponse(
      {
        ok: false,
        packageVersion:
          PACKAGE_VERSION,
        error:
          "action: reason, status veya stats",
      },
      400,
    );
  }

  if (!openAiApiKey) {
    return jsonResponse(
      {
        ok: false,
        packageVersion:
          PACKAGE_VERSION,
        error:
          "OPENAI_API_KEY Supabase secret bulunamadı.",
      },
      500,
    );
  }

  if (
    action === "status"
  ) {
    const reasoningRunId =
      String(
        body?.reasoningRunId ??
        "",
      ).trim();

    if (
      !isUuid(
        reasoningRunId,
      )
    ) {
      return jsonResponse(
        {
          ok: false,
          packageVersion:
            PACKAGE_VERSION,
          error:
            "Geçerli reasoningRunId zorunludur.",
        },
        400,
      );
    }

    try {
      const run =
        await loadReasoningRunForUser({
          supabase,
          reasoningRunId,
          auth,
        });

      if (
        [
          "completed",
          "validation_failed",
        ].includes(
          String(
            run?.status ??
            "",
          ),
        )
      ) {
        return jsonResponse(
          {
            ok: true,
            packageVersion:
              PACKAGE_VERSION,
            pending: false,
            reasoningRunId,
            researchRunId:
              run?.research_run_id ??
              null,
            openAiStatus:
              run?.openai_status ??
              null,
            runStatus:
              run?.status ??
              null,
            model:
              run?.model ??
              null,
            reasoningEffort:
              run?.reasoning_effort ??
              null,
            issueTags:
              uniqueStrings(
                run?.issue_tags,
              ),
            authorityPackSummary: {
              packageVersion:
                run
                  ?.authority_pack_snapshot
                  ?.packageVersion ??
                null,
              coverageScore:
                run
                  ?.authority_pack_snapshot
                  ?.coverageScore ??
                0,
              propositions:
                safeArray(
                  run
                    ?.authority_pack_snapshot
                    ?.propositions,
                ).length,
              courtAuthorities:
                new Set(
                  safeArray(
                    run
                      ?.authority_pack_snapshot
                      ?.propositions,
                  )
                    .filter(
                      (p) =>
                        [
                          "court_decision",
                          "administrative_decision",
                        ].includes(
                          String(
                            p?.authorityType ??
                            "",
                          ),
                        ),
                    )
                    .map(
                      (p) =>
                        p?.authorityId,
                    ),
                ).size,
            },
            validation:
              safeObject(
                run?.validation,
              ),
            usage:
              safeObject(
                run?.usage,
              ),
            estimatedCostUsd:
              run?.estimated_cost_usd ??
              null,
            memorandum:
              run?.memorandum ??
              null,
          },
        );
      }

      if (
        run?.status ===
        "failed"
      ) {
        return jsonResponse(
          {
            ok: false,
            packageVersion:
              PACKAGE_VERSION,
            pending: false,
            reasoningRunId,
            runStatus:
              "failed",
            openAiStatus:
              run?.openai_status ??
              null,
            error:
              run?.error_message ??
              "Legal reasoning run başarısız.",
          },
          500,
        );
      }

      const responseId =
        String(
          run
            ?.openai_response_id ??
          "",
        ).trim();

      if (!responseId) {
        throw new Error(
          "OpenAI background response id henüz kaydedilmemiş.",
        );
      }

      const openAiResponse =
        await retrieveOpenAiResponse({
          apiKey:
            openAiApiKey,
          responseId,
        });

      const currentStatus =
        String(
          openAiResponse
            ?.status ??
          "unknown",
        );

      if (
        [
          "queued",
          "in_progress",
        ].includes(
          currentStatus,
        )
      ) {
        await updateRun(
          supabase,
          reasoningRunId,
          {
            openai_status:
              currentStatus,
          },
        );

        return jsonResponse(
          {
            ok: true,
            packageVersion:
              PACKAGE_VERSION,
            pending: true,
            reasoningRunId,
            researchRunId:
              run?.research_run_id ??
              null,
            runStatus:
              "started",
            openAiStatus:
              currentStatus,
            model:
              run?.model ??
              null,
            reasoningEffort:
              run?.reasoning_effort ??
              null,
            startedAt:
              run?.started_at ??
              null,
          },
          202,
        );
      }

      const incompleteReason =
        String(
          openAiResponse
            ?.incomplete_details
            ?.reason ??
          "",
        );

      const outputAttemptCount =
        Math.max(
          1,
          asNumber(
            run
              ?.output_attempt_count,
          ) || 1,
        );

      const canRecoverOutputBudget =
        currentStatus ===
          "incomplete" &&
        incompleteReason ===
          "max_output_tokens" &&
        outputAttemptCount <=
          MAX_OUTPUT_RETRIES;

      if (
        canRecoverOutputBudget
      ) {
        const currentMaxOutputTokens =
          asNumber(
            run
              ?.max_output_tokens,
          ) ||
          MAX_OUTPUT_TOKENS;

        const retryMaxOutputTokens =
          Math.max(
            currentMaxOutputTokens + 1,
            RETRY_MAX_OUTPUT_TOKENS,
          );

        const incompleteUsage =
          safeObject(
            openAiResponse?.usage,
          );

        const incompleteAttemptCostUsd =
          estimateOpenAiCost(
            incompleteUsage,
          );

        const authorityPack =
          safeObject(
            run
              ?.authority_pack_snapshot,
          );

        const canonical =
          safeObject(
            run
              ?.canonical_snapshot,
          );

        const issueTags =
          uniqueStrings(
            run
              ?.issue_tags,
          );

        const propositionIds =
          safeArray(
            authorityPack
              ?.propositions,
          )
            .map(
              (p) =>
                String(
                  p
                    ?.propositionId ??
                  "",
                ),
            )
            .filter(
              (id) =>
                isUuid(id),
            );

        if (
          propositionIds.length ===
          0
        ) {
          throw new Error(
            "Output-budget recovery için Authority Pack proposition bulunamadı.",
          );
        }

        const memoSchema =
          buildMemoSchema(
            issueTags,
            propositionIds,
          );

        const safetyHash =
          await sha256Hex(
            auth.userId,
          );

        const retryResponse =
          await startOpenAiSolBackground({
            apiKey:
              openAiApiKey,

            model:
              String(
                run?.model ??
                OPENAI_MODEL,
              ),

            reasoningEffort:
              String(
                run
                  ?.reasoning_effort ??
                DEFAULT_REASONING_EFFORT,
              ),

            safetyIdentifier:
              `evreka_${safetyHash.slice(0, 32)}`,

            schema:
              memoSchema,

            canonical,

            authorityPack,

            issueTags,

            maxOutputTokens:
              retryMaxOutputTokens,
          });

        const previousRetryUsage =
          safeArray(
            run
              ?.retry_usage,
          );

        const previousRetryCostUsd =
          asNumber(
            run
              ?.retry_estimated_cost_usd,
          );

        const retryUsage = [
          ...previousRetryUsage,

          {
            attempt:
              outputAttemptCount,

            responseId:
              openAiResponse?.id ??
              run
                ?.openai_response_id ??
              null,

            status:
              currentStatus,

            incompleteReason,

            maxOutputTokens:
              currentMaxOutputTokens,

            usage:
              incompleteUsage,

            estimatedCostUsd:
              incompleteAttemptCostUsd,

            recordedAt:
              new Date()
                .toISOString(),
          },
        ];

        await updateRun(
          supabase,
          reasoningRunId,
          {
            status:
              "started",

            openai_response_id:
              retryResponse?.id ??
              null,

            openai_status:
              retryResponse?.status ??
              "queued",

            output_attempt_count:
              outputAttemptCount + 1,

            max_output_tokens:
              retryMaxOutputTokens,

            retry_usage:
              retryUsage,

            retry_estimated_cost_usd:
              Number(
                (
                  previousRetryCostUsd +
                  incompleteAttemptCostUsd
                ).toFixed(6),
              ),

            completed_at:
              null,

            error_message:
              null,
          },
        );

        return jsonResponse(
          {
            ok:
              true,

            packageVersion:
              PACKAGE_VERSION,

            pending:
              true,

            reasoningRunId,

            researchRunId:
              run
                ?.research_run_id ??
              null,

            runStatus:
              "started",

            openAiStatus:
              retryResponse?.status ??
              "queued",

            autoRetried:
              true,

            retryReason:
              "max_output_tokens",

            outputAttemptCount:
              outputAttemptCount + 1,

            previousMaxOutputTokens:
              currentMaxOutputTokens,

            maxOutputTokens:
              retryMaxOutputTokens,

            message:
              "İlk reasoning yanıtı output token sınırına ulaştı; aynı canonical snapshot ve verified Authority Pack ile daha yüksek output bütçesinde otomatik recovery başlatıldı.",
          },
          202,
        );
      }

      if (
        currentStatus !==
        "completed"
      ) {
        const openAiError =
          safeObject(
            openAiResponse?.error,
          );

        const openAiErrorText =
          [
            openAiError?.code,
            openAiError?.message,
          ]
            .map(
              (value) =>
                String(
                  value ?? "",
                ).trim(),
            )
            .filter(Boolean)
            .join(" / ");

        const terminalError =
          `OpenAI background response terminal durum: ${
            currentStatus
          }${
            openAiResponse
              ?.incomplete_details
              ?.reason
              ? ` / ${
                openAiResponse
                  .incomplete_details
                  .reason
              }`
              : ""
          }${
            openAiErrorText
              ? ` / ${openAiErrorText}`
              : ""
          }`;

        await updateRun(
          supabase,
          reasoningRunId,
          {
            status:
              "failed",
            openai_status:
              currentStatus,
            error_message:
              terminalError,
            completed_at:
              new Date()
                .toISOString(),
          },
        );

        return jsonResponse(
          {
            ok: false,
            packageVersion:
              PACKAGE_VERSION,
            pending: false,
            reasoningRunId,
            runStatus:
              "failed",
            openAiStatus:
              currentStatus,
            openAiError:
              safeObject(
                openAiResponse?.error,
              ),
            incompleteDetails:
              safeObject(
                openAiResponse
                  ?.incomplete_details,
              ),
            error:
              terminalError,
          },
          500,
        );
      }

      const final =
        await finalizeCompletedResponse({
          supabase,
          reasoningRunId,
          run,
          openAiResponse,
        });

      return jsonResponse(
        {
          ok: true,
          packageVersion:
            PACKAGE_VERSION,
          pending: false,
          reasoningRunId,
          researchRunId:
            run?.research_run_id ??
            null,
          runStatus:
            final.finalStatus,
          openAiStatus:
            "completed",
          model:
            run?.model ??
            null,
          reasoningEffort:
            run?.reasoning_effort ??
            null,
          issueTags:
            uniqueStrings(
              run?.issue_tags,
            ),
          authorityPackSummary: {
            packageVersion:
              run
                ?.authority_pack_snapshot
                ?.packageVersion ??
              null,
            coverageScore:
              run
                ?.authority_pack_snapshot
                ?.coverageScore ??
              0,
            propositions:
              safeArray(
                run
                  ?.authority_pack_snapshot
                  ?.propositions,
              ).length,
            courtAuthorities:
              new Set(
                safeArray(
                  run
                    ?.authority_pack_snapshot
                    ?.propositions,
                )
                  .filter(
                    (p) =>
                      [
                        "court_decision",
                        "administrative_decision",
                      ].includes(
                        String(
                          p?.authorityType ??
                          "",
                        ),
                      ),
                  )
                  .map(
                    (p) =>
                      p?.authorityId,
                  ),
              ).size,
          },
          validation:
            final.validation,
          usage:
            final.usage,
          estimatedCostUsd:
            final.estimatedCostUsd,
          memorandum:
            final.enrichedMemo,
        },
      );
    } catch (error) {
      const status =
        error instanceof
        HttpError
          ? error.status
          : 500;

      return jsonResponse(
        {
          ok: false,
          packageVersion:
            PACKAGE_VERSION,
          pending: false,
          reasoningRunId,
          error:
            error?.message ??
            String(error),
        },
        status,
      );
    }
  }

  const projectApiKey =
    anonKey ||
    serviceRoleKey;

  let reasoningRunId = null;

  try {
    const taskId =
      String(
        body?.taskId ??
        "",
      ).trim();

    const canonical =
      taskId
        ? await loadCanonicalFromTask({
          supabaseUrl,
          projectApiKey,
          bearerToken:
            auth.token,
          taskId,
        })
        : buildDirectCanonical(
          body,
        );

    const issueTags =
      deriveIssueTags(
        canonical,
        body?.issueTags,
      );

    if (
      issueTags.length === 0
    ) {
      throw new HttpError(
        400,
        "Reasoning için issueTags üretilemedi.",
      );
    }

    const research =
      await getAuthorityPack({
        supabase,
        supabaseUrl,
        projectApiKey,
        bearerToken:
          auth.token,
        body,
        canonical,
        issueTags,
      });

    const authorityPack =
      compactAuthorityPack(
        research
          ?.authorityPack,
      );

    if (
      authorityPack
        .propositions
        .length === 0
    ) {
      throw new HttpError(
        422,
        "Verified Authority Pack proposition içermiyor.",
      );
    }

    if (
      authorityPack
        .coverageScore <
      Number(
        body
          ?.minimumAuthorityCoverage ??
        0.75,
      )
    ) {
      throw new HttpError(
        422,
        `Authority coverage yetersiz: ${
          authorityPack
            .coverageScore
        }`,
      );
    }

    const canonicalCompact =
      compactCanonical(
        canonical,
      );

    const propositionIds =
      authorityPack
        .propositions
        .map(
          (p) =>
            p.propositionId,
        );

    const memoSchema =
      buildMemoSchema(
        issueTags,
        propositionIds,
      );

    const authorityPackFingerprint =
      await sha256Hex(
        JSON.stringify(
          authorityPack,
        ),
      );

    const inputSha =
      await sha256Hex(
        JSON.stringify({
          canonical:
            canonicalCompact,
          authorityPack,
          issueTags,
          advocacyPolicyVersion:
            ADVOCACY_POLICY_VERSION,
        }),
      );

    const requestedEffort =
      String(
        body
          ?.reasoningEffort ??
        DEFAULT_REASONING_EFFORT,
      );

    const reasoningEffort =
      VALID_REASONING_EFFORTS.has(
        requestedEffort,
      )
        ? requestedEffort
        : "high";

    reasoningRunId =
      await createRun(
        supabase,
        {
          research_run_id:
            isUuid(
              research
                ?.researchRunId,
            )
              ? research
                .researchRunId
              : null,
          task_id:
            canonical
              ?.taskId ??
            null,
          opposition_case_id:
            canonical
              ?.oppositionCaseId ??
            null,
          package_version:
            PACKAGE_VERSION,
          status:
            "started",
          model:
            OPENAI_MODEL,
          reasoning_effort:
            reasoningEffort,
          issue_tags:
            issueTags,
          source_fingerprint:
            canonical
              ?.sourceFingerprint ??
            null,
          authority_pack_fingerprint:
            authorityPackFingerprint,
          input_sha256:
            inputSha,
          canonical_snapshot:
            canonicalCompact,
          authority_pack_snapshot:
            authorityPack,

          output_attempt_count:
            1,

          max_output_tokens:
            MAX_OUTPUT_TOKENS,

          retry_usage:
            [],

          retry_estimated_cost_usd:
            0,

          created_by:
            auth.userId,
        },
      );

    const safetyHash =
      await sha256Hex(
        auth.userId,
      );

    const openAiResponse =
      await startOpenAiSolBackground({
        apiKey:
          openAiApiKey,
        model:
          OPENAI_MODEL,
        reasoningEffort,
        safetyIdentifier:
          `evreka_${safetyHash.slice(0, 32)}`,
        schema:
          memoSchema,
        canonical:
          canonicalCompact,
        authorityPack,
        issueTags,
        maxOutputTokens:
          MAX_OUTPUT_TOKENS,
      });

    await updateRun(
      supabase,
      reasoningRunId,
      {
        openai_response_id:
          openAiResponse?.id ??
          null,
        openai_status:
          openAiResponse?.status ??
          null,
      },
    );

    if (
      openAiResponse?.status ===
      "completed"
    ) {
      const run =
        await loadReasoningRunForUser({
          supabase,
          reasoningRunId,
          auth,
        });

      const final =
        await finalizeCompletedResponse({
          supabase,
          reasoningRunId,
          run,
          openAiResponse,
        });

      return jsonResponse(
        {
          ok: true,
          packageVersion:
            PACKAGE_VERSION,
          pending: false,
          reasoningRunId,
          researchRunId:
            research
              ?.researchRunId ??
            null,
          researchMode:
            research
              ?.researchMode ??
            null,
          researchRouting:
            research
              ?.researchRouting ??
            null,
          openAiStatus:
            "completed",
          model:
            OPENAI_MODEL,
          reasoningEffort,
          issueTags,
          validation:
            final.validation,
          usage:
            final.usage,
          estimatedCostUsd:
            final.estimatedCostUsd,
          memorandum:
            final.enrichedMemo,
        },
      );
    }

    return jsonResponse(
      {
        ok: true,
        packageVersion:
          PACKAGE_VERSION,
        pending: true,
        reasoningRunId,
        researchRunId:
          research
            ?.researchRunId ??
          null,
        researchMode:
          research
            ?.researchMode ??
          null,
        researchRouting:
          research
            ?.researchRouting ??
          null,
        openAiStatus:
          openAiResponse?.status ??
          "queued",
        model:
          OPENAI_MODEL,
        reasoningEffort,
        issueTags,
        authorityPackSummary: {
          packageVersion:
            authorityPack
              ?.packageVersion ??
            null,
          coverageScore:
            authorityPack
              ?.coverageScore ??
            0,
          propositions:
            authorityPack
              .propositions
              .length,
          courtAuthorities:
            new Set(
              authorityPack
                .propositions
                .filter(
                  (p) =>
                    [
                      "court_decision",
                      "administrative_decision",
                    ].includes(
                      String(
                        p?.authorityType ??
                        "",
                      ),
                    ),
                )
                .map(
                  (p) =>
                    p.authorityId,
                ),
            ).size,
        },
        message:
          "Sol background reasoning başlatıldı. action=status ile polling yapın.",
      },
      202,
    );
  } catch (error) {
    const status =
      error instanceof
      HttpError
        ? error.status
        : 500;

    const message =
      error?.message ??
      String(error);

    console.error(
      "[legal-reasoning] fatal",
      error,
    );

    if (reasoningRunId) {
      try {
        await updateRun(
          supabase,
          reasoningRunId,
          {
            status: "failed",
            error_message:
              message,
            completed_at:
              new Date()
                .toISOString(),
          },
        );
      } catch (
        updateError
      ) {
        console.error(
          "[legal-reasoning] failed-run update",
          updateError,
        );
      }
    }

    return jsonResponse(
      {
        ok: false,
        packageVersion:
          PACKAGE_VERSION,
        reasoningRunId,
        error: message,
      },
      status,
    );
  }
});
