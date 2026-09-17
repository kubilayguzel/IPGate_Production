import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const PACKAGE_VERSION = "response-studio-1.0.6";
const OPENAI_MODEL = Deno.env.get("OPPOSITION_RESPONSE_REASONING_MODEL") ?? "gpt-5.6-sol";
const MAX_OUTPUT_TOKENS = Number(Deno.env.get("OPPOSITION_RESPONSE_REASONING_MAX_TOKENS") ?? "42000");

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function text(value: unknown) { return String(value ?? "").trim(); }
function arr(value: unknown): any[] { return Array.isArray(value) ? value : []; }
function obj(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function uniq(values: unknown[]) { return [...new Set(values.map((v) => text(v)).filter(Boolean))]; }

async function assertInternalUser(req: Request, supabase: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Oturum bilgisi bulunamadı.");

  const { data: authData, error } = await supabase.auth.getUser(token);
  if (error || !authData.user) throw new HttpError(401, "Geçersiz oturum.");

  const { data: profile } = await supabase.from("users").select("id, role, disabled")
    .eq("id", authData.user.id).maybeSingle();
  if (!profile || profile.disabled || !["user", "admin", "superadmin"].includes(String(profile.role))) {
    throw new HttpError(403, "Bu hukuki çalışma alanına erişim yetkiniz bulunmuyor.");
  }
  return { id: authData.user.id, token };
}

async function invokeProjectFunction({ supabaseUrl, apiKey, bearerToken, functionName, body }: any) {
  const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${bearerToken}`,
      "apikey": apiKey,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text().catch(() => "");
  let data: any = {};
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = {}; }
  }

  if (!response.ok || data?.success === false || data?.ok === false) {
    const upstreamMessage = text(data?.error);
    const rawSnippet = raw && !upstreamMessage
      ? raw.replace(/\s+/g, " ").trim().slice(0, 700)
      : "";
    const detail = upstreamMessage || rawSnippet || response.statusText || "yanıt gövdesi yok";
    throw new HttpError(
      response.status || 422,
      `${functionName} ${response.status || "?"}: ${detail}`,
    );
  }
  return data;
}

function flattenLawyerFindings(value: unknown, prefix = ""): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => flattenLawyerFindings(v, `${prefix}[${i}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, any>)
      .flatMap(([k, v]) => flattenLawyerFindings(v, prefix ? `${prefix}.${k}` : k));
  }
  return [`${prefix}: ${String(value)}`];
}

function applicationGoods(workspace: any) {
  return arr(workspace?.applicant?.classes).map((c) => ({
    classNo: Number(c.classNo),
    text: arr(c.items).map(String).join("; "),
  }));
}

function priorGoods(workspace: any) {
  return arr(workspace?.priorMarks).flatMap((mark) => {
    // Legal comparison must not expand beyond the opponent's filing. A proof-of-use
    // review may later narrow the effective scope further. Registry scope is fallback
    // only when the filing itself contains no usable relied-scope text.
    const source = arr(mark.effective_scope).length
      ? arr(mark.effective_scope)
      : arr(mark.relied_scope).length
      ? arr(mark.relied_scope)
      : arr(mark.registered_scope);
    return source.map((row) => ({
      markText: mark.mark_text ?? "",
      classNo: Number(row.classNo ?? row.class_no),
      items: arr(row.items).length
        ? arr(row.items).map(String)
        : text(row.itemsText ?? row.items_text).split(/\s*;\s*/).filter(Boolean),
    }));
  }).filter((row) => Number.isInteger(row.classNo));
}

function buildResearchContext(workspace: any) {
  const appGoods = applicationGoods(workspace);
  const earlierGoods = priorGoods(workspace);
  const lawyerFindings = flattenLawyerFindings(workspace?.case?.lawyer_findings);
  const priorMarks = arr(workspace?.priorMarks);

  return {
    // Neutral names for Response Studio.
    laterMark: workspace?.applicant?.markText ?? null,
    earlierMarks: priorMarks.map((m) => m.mark_text).filter(Boolean),
    laterGoodsByClass: appGoods,
    earlierGoodsByClass: earlierGoods,
    claimMap: arr(workspace?.claims).map((c) => ({
      ground: c.legal_ground,
      type: c.claim_type,
      claim: c.claim_text,
      challengedFinding: c.challenged_finding,
    })),
    lawyerFindings,

    // Compatibility keys consumed by legal-research 6.1.12.
    opposedMark: workspace?.applicant?.markText ?? null,
    earlierMark: priorMarks.map((m) => m.mark_text).filter(Boolean).join(" / "),
    legalBasis: uniq(arr(workspace?.claims).map((c) => c.legal_ground)).join(", "),
    opposedClasses: appGoods.map((g) => g.classNo).filter(Number.isFinite),
    earlierClasses: uniq(earlierGoods.map((g) => g.classNo)).map(Number),
    opponentGoodsByClass: appGoods,
    priorGoodsByClass: earlierGoods,
    priorGoodsClassGroups: [],
    canonicalDecisionTree: {
      responseStudio: true,
      lawyerFindings: obj(workspace?.case?.lawyer_findings),
    },
  };
}

function deriveIssueTags(workspace: any) {
  const tags = new Set<string>();
  const grounds = uniq(arr(workspace?.claims).map((c) => c.legal_ground));
  const types = uniq(arr(workspace?.claims).map((c) => c.claim_type));

  if (grounds.some((g) => /6[\/_\s.-]*1/i.test(g))) {
    [
      "goods_services_similarity", "sign_similarity", "common_element",
      "dominant_element", "interdependence", "relevant_consumer", "association"
    ].forEach((t) => tags.add(t));
  }

  if (types.some((t) => /retail|perakende|35/i.test(t))) tags.add("goods_retail_relation");
  if (types.some((t) => /complement|tamamlay/i.test(t))) tags.add("complementarity");

  for (const ground of grounds) {
    if (/6[\/_\s.-]*3/i.test(ground)) tags.add("prior_use");
    if (/6[\/_\s.-]*4/i.test(ground)) tags.add("well_known_mark");
    if (/6[\/_\s.-]*5/i.test(ground)) tags.add("reputation");
    if (/6[\/_\s.-]*6/i.test(ground)) tags.add("other_rights");
    if (/6[\/_\s.-]*9/i.test(ground)) tags.add("bad_faith");
  }

  return [...tags];
}

function compactAuthorityPack(pack: any) {
  return {
    packageVersion: pack?.packageVersion ?? null,
    coverageScore: Number(pack?.coverageScore ?? 0),
    coveredIssueTags: uniq(arr(pack?.coveredIssueTags)),
    missingIssueTags: uniq(arr(pack?.missingIssueTags)),
    modules: arr(pack?.modules).slice(0, 24).map((m) => ({
      moduleKey: m?.moduleKey,
      title: m?.title,
      issueTags: uniq(arr(m?.issueTags)),
      theorySummary: text(m?.theorySummary).slice(0, 3000),
      applicationGuidance: text(m?.applicationGuidance).slice(0, 3000),
      counterargumentGuidance: text(m?.counterargumentGuidance).slice(0, 3000),
    })),
    propositions: arr(pack?.propositions).slice(0, 40).map((p) => ({
      propositionId: text(p?.propositionId),
      authorityId: text(p?.authorityId),
      authorityType: p?.authorityType ?? null,
      authorityLayer: p?.authorityLayer ?? null,
      jurisdiction: p?.jurisdiction ?? null,
      authorityName: p?.authorityName ?? null,
      court: p?.court ?? null,
      chamber: p?.chamber ?? null,
      caseNo: p?.caseNo ?? null,
      decisionNo: p?.decisionNo ?? null,
      decisionDate: p?.decisionDate ?? null,
      authorityTitle: p?.authorityTitle ?? null,
      citationLabel: p?.citationLabel ?? p?.authorityTitle ?? null,
      sourceUrl: p?.sourceUrl ?? null,
      propositionText: text(p?.propositionText).slice(0, 4500),
      holdingText: text(p?.holdingText).slice(0, 4500),
      verificationExcerpt: text(p?.verificationExcerpt).slice(0, 2500),
      quoteSafe: p?.quoteSafe === true,
      verifiedQuote: p?.quoteSafe === true ? text(p?.verifiedQuote).slice(0, 1200) : "",
      quoteLocator: p?.quoteSafe === true ? p?.quoteLocator ?? null : null,
      issueTags: uniq(arr(p?.issueTags)),
      useFor: uniq(arr(p?.useFor)),
      doNotUseFor: uniq(arr(p?.doNotUseFor)),
      confidence: Number(p?.confidence ?? 0),
    })).filter((p) => p.propositionId),
  };
}

function reasoningSchema(propositionIds: string[], claimIds: string[]) {
  const safeIds = propositionIds.length ? propositionIds : ["00000000-0000-0000-0000-000000000000"];
  const safeClaimIds = claimIds.length ? claimIds : ["00000000-0000-0000-0000-000000000000"];
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      executiveSummary: { type: "string" },
      defenseTheory: { type: "string" },
      claimResponses: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            claimId: { type: "string", enum: safeClaimIds },
            legalGround: { type: "string" },
            opponentPosition: { type: "string" },
            responsePosition: { type: "string" },
            legalAnalysis: { type: "string" },
            favorableAuthorityApplications: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  propositionId: { type: "string", enum: safeIds },
                  relevance: { type: "string" },
                  quoteRecommendation: { type: "string", enum: ["use_if_verified", "not_needed"] },
                },
                required: ["propositionId", "relevance", "quoteRecommendation"],
              },
            },
            conclusion: { type: "string" },
          },
          required: [
            "claimId", "legalGround", "opponentPosition", "responsePosition",
            "legalAnalysis", "favorableAuthorityApplications", "conclusion"
          ],
        },
      },
      proofOfUse: {
        type: "object",
        additionalProperties: false,
        properties: {
          include: { type: "boolean" },
          instruction: { type: "string" },
        },
        required: ["include", "instruction"],
      },
      yidkContinuity: {
        type: "object",
        additionalProperties: false,
        properties: {
          preservePreviousDefense: { type: "boolean" },
          continuityNote: { type: "string" },
          decisionDefense: { type: "string" },
        },
        required: ["preservePreviousDefense", "continuityNote", "decisionDefense"],
      },
      overallConclusion: { type: "string" },
      unresolvedQuestions: { type: "array", items: { type: "string" } },
      prohibitedClaims: { type: "array", items: { type: "string" } },
    },
    required: [
      "executiveSummary", "defenseTheory", "claimResponses", "proofOfUse",
      "yidkContinuity", "overallConclusion", "unresolvedQuestions", "prohibitedClaims"
    ],
  };
}

function responseText(response: any) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) return response.output_text;
  for (const item of arr(response?.output)) {
    for (const content of arr(item?.content)) {
      if (typeof content?.text === "string" && content.text.trim()) return content.text;
    }
  }
  return "";
}

async function startOpenAIJson(prompt: string, schema: any) {
  const key = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!key) throw new HttpError(500, "OPENAI_API_KEY tanımlı değil.");

  const create = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      background: true,
      store: true,
      reasoning: { effort: "high" },
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      text: {
        format: {
          type: "json_schema",
          name: "opposition_response_reasoning",
          strict: true,
          schema,
        },
      },
      max_output_tokens: MAX_OUTPUT_TOKENS,
    }),
  });

  const data = await create.json().catch(() => ({}));
  if (!create.ok) {
    throw new HttpError(
      create.status,
      data?.error?.message ?? "OpenAI reasoning başlatılamadı.",
    );
  }

  const responseId = text(data?.id);
  if (!responseId) throw new HttpError(502, "OpenAI reasoning response ID üretmedi.");

  return {
    responseId,
    status: text(data?.status) || "queued",
    raw: data,
  };
}

async function retrieveOpenAIResponse(responseId: string) {
  const key = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!key) throw new HttpError(500, "OPENAI_API_KEY tanımlı değil.");

  const response = await fetch(
    `https://api.openai.com/v1/responses/${encodeURIComponent(responseId)}`,
    { headers: { "Authorization": `Bearer ${key}` } },
  );
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new HttpError(
      response.status,
      data?.error?.message ?? "OpenAI reasoning sonucu alınamadı.",
    );
  }

  return data;
}

function parseCompletedOpenAIResponse(data: any) {
  if (data?.status !== "completed") {
    throw new HttpError(
      409,
      data?.error?.message ??
        `Reasoning henüz tamamlanmadı: ${data?.status ?? "unknown"}`,
    );
  }

  const output = responseText(data);
  if (!output) throw new HttpError(502, "Reasoning modeli JSON çıktı üretmedi.");

  try {
    return JSON.parse(output);
  } catch {
    throw new HttpError(502, "Reasoning modeli geçerli JSON üretmedi.");
  }
}

function stableJson(value: any): any {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    const result: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = stableJson(value[key]);
    }
    return result;
  }
  return value;
}

async function sha256Hex(value: unknown) {
  const encoded = new TextEncoder().encode(
    JSON.stringify(stableJson(value)),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function reasoningInputFingerprint(workspace: any) {
  const snapshot = {
    sourceFingerprint: workspace?.case?.source_fingerprint ?? null,
    analysisFingerprint: workspace?.case?.analysis_fingerprint ?? null,
    procedureStage: workspace?.procedureStage ?? null,
    proofOfUseRequested: workspace?.case?.proof_of_use_requested === true,
    lawyerFindings: obj(workspace?.case?.lawyer_findings),
    applicant: {
      markText: workspace?.applicant?.markText ?? null,
      classes: arr(workspace?.applicant?.classes),
    },
    priorMarks: arr(workspace?.priorMarks)
      .map((m) => ({
        id: m?.id ?? null,
        markText: m?.mark_text ?? null,
        applicationNo: m?.application_no ?? null,
        registrationNo: m?.registration_no ?? null,
        internationalRegistrationNo: m?.international_registration_no ?? null,
        grounds: arr(m?.legal_grounds),
        reliedScope: arr(m?.relied_scope),
        registeredScope: arr(m?.registered_scope),
        effectiveScope: arr(m?.effective_scope),
        active: m?.is_active !== false,
      }))
      .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? ""))),
    claims: arr(workspace?.claims)
      .map((c) => ({
        id: c?.id ?? null,
        legalGround: c?.legal_ground ?? null,
        claimType: c?.claim_type ?? null,
        claimText: c?.claim_text ?? null,
        challengedFinding: c?.challenged_finding ?? null,
        sourcePage: c?.source_page ?? null,
        sourceExcerpt: c?.source_excerpt ?? null,
      }))
      .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? ""))),
  };

  return await sha256Hex(snapshot);
}

function buildPrompt(workspace: any, authorityPack: any) {
  const lawyerFindings = obj(workspace?.case?.lawyer_findings);
  const stage = workspace?.procedureStage;
  const proofRequested = stage === "publication_opposition" && workspace?.case?.proof_of_use_requested === true;
  const previousResponse = arr(workspace?.documents).some((d) => d.role === "previous_response");

  const canonical = {
    procedureStage: stage,
    applicant: workspace?.applicant,
    opponentParty: workspace?.case?.party_snapshot?.opponent,
    legalGrounds: workspace?.case?.extracted_case?.legalGrounds ?? [],
    priorMarks: arr(workspace?.priorMarks),
    claims: arr(workspace?.claims).map((c) => ({
      id: c.id,
      ground: c.legal_ground,
      type: c.claim_type,
      text: c.claim_text,
      challengedFinding: c.challenged_finding,
      sourcePage: c.source_page,
      sourceExcerpt: c.source_excerpt,
    })),
    yidkHistory: workspace?.case?.procedural_history,
    lawyerFindings,
    proofOfUseRequested: proofRequested,
  };

  return `
Prepare an INTERNAL DEFENSE LEGAL REASONING MEMORANDUM for EVREKA's Turkish trademark opposition-response practice.
This is NOT the final petition. A later controlled drafting layer will use this memorandum.

CANONICAL RESPONSE CASE:
${JSON.stringify(canonical)}

VERIFIED AUTHORITY PACK:
${JSON.stringify(authorityPack)}

NON-NEGOTIABLE RULES:
1. This is a DEFENSE of the portfolio application against the opponent/appellant's filing. Do not switch party direction.
2. Every explicit lawyer finding in lawyerFindings is BINDING. Never contradict, dilute or silently replace it.
3. Missing lawyer fields are NOT blockers. Independently perform the legal analysis from canonical marks, goods/services, opponent claims and the verified authority pack.
4. Address the opponent's actual claims one by one. Do not write generic textbook analysis detached from the claim map.
5. For SMK 6/1, where relevant, analyze sign similarity, distinctiveness/weakness of the common element, dominant/additional elements, goods/services, relevant consumer and attention, interdependence, association and global likelihood of confusion.
6. Use the opponent's RELIED scope and any available registered/effective scope. Never silently expand a prior right beyond the source material.
7. Authority use must be favorable to the defense. It is not necessary to discuss adverse authorities. Select ONLY proposition IDs from the Authority Pack that genuinely support a defense proposition or help distinguish the opponent's allegation.
8. Do not invent authority names, numbers, dates, quotations or holdings. Reference authority only via propositionId.
9. A quote may be recommended only when quoteSafe=true in the Authority Pack; otherwise quoteRecommendation must be not_needed.
10. Authorities must be applied as legal rule → authority proposition → application to concrete case → conclusion; no naked bibliographic citations.
11. TÜRKPATENT Trademark Examination Guidelines should receive concrete weight, especially same class-pair goods/services examples supplied by 6.1.12 intelligence.
12. For publication_opposition only: proofOfUse.include MUST equal ${proofRequested}. If true, the filing instruction is a GENERAL request for proof of use for the opponent's relied-on prior marks in respect of all goods/services relied upon. Do not create mark-by-mark UI or filing selections.
13. For yidk_appeal: proofOfUse.include MUST be false. Never create a new proof-of-use request at YİDK stage.
14. YİDK continuity: previousResponseFound=${previousResponse}. If a previous response exists and lawyerFindings do not instruct a material change, preserve the same defense line, then answer the appellant's criticisms of the challenged Office decision. Do not needlessly rewrite the strategy from scratch.
15. The final petition is intended to be shorter than an originating opposition petition, but legally substantive. Therefore the memorandum should prioritize the opponent's strongest allegations and the legal answers that actually defeat them.
16. Do not use internal-system vocabulary in prose intended for later drafting (Decision Tree, canonical, lawyer finding, recorded in file, etc.).

Return the strict JSON schema only.
`.trim();
}

function validateWorkspaceForReasoning(workspace: any) {
  if (workspace?.sourceBundle?.complete !== true) {
    throw new HttpError(
      422,
      `Kaynak belge paketi eksik: ${arr(workspace?.sourceBundle?.missing).join(", ")}`,
    );
  }

  if (!arr(workspace?.claims).length) {
    throw new HttpError(
      422,
      "Önce AI belge analizi tamamlanmalıdır; iddia haritası bulunmuyor.",
    );
  }

  const hasRelativePriorRightGround = arr(workspace?.claims).some((c) =>
    /6[\/_\s.-]*(?:1|3|4|5)/i.test(text(c?.legal_ground))
  );

  if (hasRelativePriorRightGround && !arr(workspace?.priorMarks).length) {
    throw new HttpError(
      422,
      "İleri sürülen marka hakkına dayalı gerekçeler için mesnet hak çıkarılamadı. AI analizi yenilenmeli veya eksik mesnet hak avukat tarafından eklenmelidir.",
    );
  }
}

function currentSourceFingerprint(workspace: any) {
  return text(
    workspace?.case?.analysis_fingerprint ??
    workspace?.case?.source_fingerprint ??
    "",
  );
}

function runPhase(run: any) {
  return text(
    run?.output_payload?.phase ??
    run?.input_payload?.phase ??
    "researching",
  ) || "researching";
}

function phaseMessage(phase: string) {
  if (phase === "research_corpus") return "Doğrulanmış hukuk corpus'u taranıyor.";
  if (phase === "research_guideline") return "TÜRKPATENT Kılavuzu somut örnekleri taranıyor.";
  if (phase === "research_yargitay") return "Yargıtay katmanı araştırılıyor ve doğrulanıyor.";
  if (phase === "research_eu") return "CJEU / General Court katmanı araştırılıyor ve doğrulanıyor.";
  if (phase === "collect_authorities") return "Doğrulanmış authority paketi birleştiriliyor.";
  if (phase === "starting_reasoning") return "Doğrulanmış kaynak paketi hazır; GPT-5.6 Sol başlatılıyor.";
  if (phase === "reasoning") return "GPT-5.6 Sol hukuki reasoning çalışıyor.";
  if (phase === "completed") return "Hukuki analiz tamamlandı.";
  if (phase === "failed") return "Hukuki analiz başarısız.";
  return "Hukuki analiz hazırlanıyor.";
}

async function getWorkspace(
  supabaseUrl: string,
  apiKey: string,
  bearerToken: string,
  taskId: string,
) {
  const result = await invokeProjectFunction({
    supabaseUrl,
    apiKey,
    bearerToken,
    functionName: "opposition-response-workspace",
    body: { action: "get", taskId },
  });
  return result.workspace;
}

async function markRunFailed(
  supabase: ReturnType<typeof createClient>,
  runId: string,
  error: unknown,
  outputPayload: Record<string, any> = {},
) {
  const message = error instanceof Error ? error.message : String(error);
  await supabase.from("opposition_response_runs").update({
    status: "failed",
    error_message: message,
    output_payload: {
      ...outputPayload,
      phase: "failed",
      failedAt: new Date().toISOString(),
      error: message,
    },
    completed_at: new Date().toISOString(),
  }).eq("id", runId);
}

async function finalizeReasoning({
  supabase,
  run,
  workspace,
  authorityPack,
  openAIData,
  currentUserId,
}: any) {
  const storedFingerprint = text(run?.input_payload?.reasoningInputFingerprint);
  const liveFingerprint = await reasoningInputFingerprint(workspace);

  if (storedFingerprint && storedFingerprint !== liveFingerprint) {
    throw new HttpError(
      409,
      "Reasoning çalışırken dosya verileri veya avukat bulguları değişti. Eski sonuç kaydedilmedi; hukuki analizi yeniden çalıştırın.",
    );
  }

  const parsed = parseCompletedOpenAIResponse(openAIData);
  const claimIds = arr(workspace?.claims)
    .map((c) => text(c?.id))
    .filter(Boolean);

  const responseClaimIds = new Set(
    arr(parsed?.claimResponses).map((row) => text(row?.claimId)),
  );
  const missingClaimIds = claimIds.filter((id) => !responseClaimIds.has(id));

  if (missingClaimIds.length) {
    throw new HttpError(
      422,
      `Hukuki reasoning karşı tarafın ${missingClaimIds.length} iddiasını cevaplamadı; run reddedildi.`,
    );
  }

  parsed.proofOfUse = workspace?.procedureStage === "publication_opposition"
    ? {
        include: workspace?.case?.proof_of_use_requested === true,
        instruction: workspace?.case?.proof_of_use_requested === true
          ? "Karşı tarafın itirazına dayanak gösterdiği mesnet markaların dayanılan tüm mal ve hizmetleri bakımından kullanım ispatı talep edilecektir."
          : "Kullanım ispatı talebi filing instruction olarak verilmemiştir.",
      }
    : {
        include: false,
        instruction: "YİDK karşı görüş aşamasında yeni kullanım ispatı talebi oluşturulmayacaktır.",
      };

  const { error: caseUpdateError } = await supabase
    .from("opposition_response_cases")
    .update({
      current_reasoning: parsed,
      current_research_run_id: run?.research_run_id ?? null,
      status: "analysis",
      current_draft: null,
      current_draft_structured: null,
      qa_report: null,
      updated_by: currentUserId,
    })
    .eq("id", workspace.case.id);

  if (caseUpdateError) {
    throw new Error(
      `Reasoning sonucu dosyaya kaydedilemedi: ${caseUpdateError.message}`,
    );
  }

  const responseId = text(run?.output_payload?.responseId ?? openAIData?.id);
  const finalOutput = {
    ...obj(run?.output_payload),
    phase: "completed",
    responseId,
    openAIStatus: "completed",
    completedAt: new Date().toISOString(),
    reasoning: parsed,
  };

  const { error: runUpdateError } = await supabase
    .from("opposition_response_runs")
    .update({
      status: "completed",
      output_payload: finalOutput,
      completed_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", run.id);

  if (runUpdateError) {
    throw new Error(
      `Reasoning run tamamlanamadı: ${runUpdateError.message}`,
    );
  }

  return {
    parsed,
    authorityPack,
    responseId,
  };
}


const GUIDELINE_PHASE_ORDER = [
  "goods_services_similarity",
  "goods_retail_relation",
  "sign_similarity",
  "common_element",
  "dominant_element",
  "interdependence",
];

const CASE_AUTHORITY_PRIORITY = [
  "sign_similarity",
  "goods_services_similarity",
  "common_element",
  "interdependence",
  "relevant_consumer",
  "association",
  "complementarity",
];

function pickCaseAuthorityTag(issueTags: string[]) {
  for (const tag of CASE_AUTHORITY_PRIORITY) {
    if (issueTags.includes(tag)) return tag;
  }
  return issueTags[0] ?? "sign_similarity";
}

function researchContextBody(workspace: any) {
  return buildResearchContext(workspace);
}

async function assertRunInputsStillCurrent(run: any, workspace: any) {
  const stored = text(run?.input_payload?.reasoningInputFingerprint);
  const live = await reasoningInputFingerprint(workspace);
  if (stored && stored !== live) {
    throw new HttpError(
      409,
      "Hukuki analiz sırasında dosya verileri veya avukat bulguları değişti. Eski run kullanılmadı; analizi yeniden başlatın.",
    );
  }
}

async function callBoundedLegalResearch({
  supabaseUrl,
  apiKey,
  bearerToken,
  taskId,
  workspace,
  issueTags,
  allowWebSearch = false,
  minYargitayAuthorities = 0,
  minEuAuthorities = 0,
  forceGuidelineEvidence = false,
  guidelineEvidenceTags = [],
  guidelinePairMaxTargets = 1,
}: any) {
  return await invokeProjectFunction({
    supabaseUrl,
    apiKey,
    bearerToken,
    functionName: "legal-research",
    body: {
      action: "research",
      taskId,
      issueTags,
      coverageThreshold: forceGuidelineEvidence ? 0 : 0.78,
      requireCompleteCoverage: false,
      minCaseAuthorities: 0,
      minYargitayAuthorities,
      minEuAuthorities,
      allowWebSearch,
      autoVerify: true,
      forceGuidelineEvidence,
      guidelineEvidenceTags,
      caseContext: researchContextBody(workspace),
      // 1.0.6 bounded-work controls. They are optional in legal-research and
      // default to legacy behavior for all existing Opposition Studio callers.
      webMaxCandidates: 1,
      guidelinePairMaxTargets,
      corpusModuleLimit: forceGuidelineEvidence ? 1 : 2,
    },
  });
}

async function updateRunState(
  supabase: ReturnType<typeof createClient>,
  runId: string,
  patch: Record<string, any>,
) {
  const { data, error } = await supabase
    .from("opposition_response_runs")
    .update(patch)
    .eq("id", runId)
    .select("*")
    .single();
  if (error) throw new Error(`Reasoning run güncellenemedi: ${error.message}`);
  return data;
}

async function findReusableRunningRun(
  supabase: ReturnType<typeof createClient>,
  responseCaseId: string,
  taskId: string,
) {
  const { data, error } = await supabase
    .from("opposition_response_runs")
    .select("*")
    .eq("response_case_id", responseCaseId)
    .eq("run_type", "reasoning")
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(8);

  if (error) throw new Error(`Devam eden reasoning run okunamadı: ${error.message}`);

  const now = Date.now();
  for (const run of arr(data)) {
    if (
      text(run?.input_payload?.asyncOrchestratorVersion) !== PACKAGE_VERSION ||
      text(run?.input_payload?.taskId) !== taskId
    ) continue;

    const ageMs = Math.max(0, now - new Date(run.created_at ?? 0).getTime());
    if (ageMs < 45 * 60 * 1000) return run;
  }
  return null;
}

async function advanceResearchPhase({
  supabase,
  supabaseUrl,
  apiKey,
  auth,
  taskId,
  run,
}: any) {
  const workspace = await getWorkspace(supabaseUrl, apiKey, auth.token, taskId);
  validateWorkspaceForReasoning(workspace);
  await assertRunInputsStillCurrent(run, workspace);

  const input = obj(run?.input_payload);
  const issueTags = uniq(arr(input?.issueTags));
  const phase = runPhase(run);

  if (phase === "research_corpus") {
    const cursor = Math.max(0, Number(input?.corpusCursor ?? 0));
    if (cursor >= issueTags.length) {
      const nextInput = { ...input, corpusCursor: cursor, phase: "research_guideline" };
      const nextOutput = {
        ...obj(run?.output_payload),
        phase: "research_guideline",
        progressMessage: phaseMessage("research_guideline"),
      };
      await updateRunState(supabase, run.id, { input_payload: nextInput, output_payload: nextOutput });
      return { status: "running", phase: "research_guideline", progressMessage: nextOutput.progressMessage };
    }

    const tag = issueTags[cursor];
    await callBoundedLegalResearch({
      supabaseUrl, apiKey, bearerToken: auth.token, taskId, workspace,
      issueTags: [tag],
      allowWebSearch: false,
    });

    const nextCursor = cursor + 1;
    const done = nextCursor >= issueTags.length;
    const nextPhase = done ? "research_guideline" : "research_corpus";
    const progressMessage = done
      ? phaseMessage("research_guideline")
      : `Doğrulanmış hukuk corpus'u taranıyor (${nextCursor + 1}/${issueTags.length}): ${issueTags[nextCursor]}`;

    await updateRunState(supabase, run.id, {
      input_payload: { ...input, corpusCursor: nextCursor, phase: nextPhase },
      output_payload: {
        ...obj(run?.output_payload),
        phase: nextPhase,
        progressMessage,
        lastCompletedResearchTag: tag,
      },
    });
    return { status: "running", phase: nextPhase, progressMessage };
  }

  if (phase === "research_guideline") {
    const guidelineTags = uniq(
      arr(input?.guidelineTags).length
        ? arr(input?.guidelineTags)
        : GUIDELINE_PHASE_ORDER.filter((tag) => issueTags.includes(tag)),
    );
    const cursor = Math.max(0, Number(input?.guidelineCursor ?? 0));

    if (cursor >= guidelineTags.length) {
      const nextPhase = input?.allowWebSearch === false ? "collect_authorities" : "research_yargitay";
      const progressMessage = phaseMessage(nextPhase);
      await updateRunState(supabase, run.id, {
        input_payload: { ...input, guidelineCursor: cursor, phase: nextPhase },
        output_payload: { ...obj(run?.output_payload), phase: nextPhase, progressMessage },
      });
      return { status: "running", phase: nextPhase, progressMessage };
    }

    const tag = guidelineTags[cursor];
    await callBoundedLegalResearch({
      supabaseUrl, apiKey, bearerToken: auth.token, taskId, workspace,
      issueTags: [tag],
      allowWebSearch: false,
      forceGuidelineEvidence: true,
      guidelineEvidenceTags: [tag],
      guidelinePairMaxTargets: tag === "goods_services_similarity" ? 2 : 1,
    });

    const nextCursor = cursor + 1;
    const done = nextCursor >= guidelineTags.length;
    const nextPhase = done
      ? (input?.allowWebSearch === false ? "collect_authorities" : "research_yargitay")
      : "research_guideline";
    const progressMessage = done
      ? phaseMessage(nextPhase)
      : `TÜRKPATENT Kılavuzu taranıyor (${nextCursor + 1}/${guidelineTags.length}): ${guidelineTags[nextCursor]}`;

    await updateRunState(supabase, run.id, {
      input_payload: { ...input, guidelineCursor: nextCursor, phase: nextPhase },
      output_payload: {
        ...obj(run?.output_payload),
        phase: nextPhase,
        progressMessage,
        lastCompletedGuidelineTag: tag,
      },
    });
    return { status: "running", phase: nextPhase, progressMessage };
  }

  if (phase === "research_yargitay") {
    const tag = pickCaseAuthorityTag(issueTags);
    await callBoundedLegalResearch({
      supabaseUrl, apiKey, bearerToken: auth.token, taskId, workspace,
      issueTags: [tag],
      allowWebSearch: true,
      minYargitayAuthorities: 1,
      minEuAuthorities: 0,
    });

    const nextPhase = "research_eu";
    const progressMessage = phaseMessage(nextPhase);
    await updateRunState(supabase, run.id, {
      input_payload: { ...input, phase: nextPhase, yargitayTag: tag },
      output_payload: { ...obj(run?.output_payload), phase: nextPhase, progressMessage },
    });
    return { status: "running", phase: nextPhase, progressMessage };
  }

  if (phase === "research_eu") {
    const tag = pickCaseAuthorityTag(issueTags);
    await callBoundedLegalResearch({
      supabaseUrl, apiKey, bearerToken: auth.token, taskId, workspace,
      issueTags: [tag],
      allowWebSearch: true,
      minYargitayAuthorities: 0,
      minEuAuthorities: 1,
    });

    const nextPhase = "collect_authorities";
    const progressMessage = phaseMessage(nextPhase);
    await updateRunState(supabase, run.id, {
      input_payload: { ...input, phase: nextPhase, euTag: tag },
      output_payload: { ...obj(run?.output_payload), phase: nextPhase, progressMessage },
    });
    return { status: "running", phase: nextPhase, progressMessage };
  }

  if (phase === "collect_authorities") {
    // Final call is intentionally research-disabled: it only rebuilds and returns
    // the full verified authority pack after the bounded phases above.
    const research = await invokeProjectFunction({
      supabaseUrl,
      apiKey,
      bearerToken: auth.token,
      functionName: "legal-research",
      body: {
        action: "research",
        taskId,
        issueTags,
        coverageThreshold: 0,
        requireCompleteCoverage: false,
        minCaseAuthorities: 0,
        minYargitayAuthorities: 0,
        minEuAuthorities: 0,
        allowWebSearch: false,
        autoVerify: true,
        forceGuidelineEvidence: false,
        caseContext: researchContextBody(workspace),
        webMaxCandidates: 1,
        guidelinePairMaxTargets: 1,
        corpusModuleLimit: 1,
      },
    });

    const authorityPack = compactAuthorityPack(research.authorityPack);
    const propositionIds = arr(authorityPack?.propositions)
      .map((p) => text(p?.propositionId))
      .filter(Boolean);
    const claimIds = arr(workspace?.claims)
      .map((c) => text(c?.id))
      .filter(Boolean);

    const startingPayload = {
      ...obj(run?.output_payload),
      phase: "starting_reasoning",
      progressMessage: phaseMessage("starting_reasoning"),
      authorityPackCollectedAt: new Date().toISOString(),
    };

    run = await updateRunState(supabase, run.id, {
      research_run_id: research.researchRunId ?? null,
      authority_pack: authorityPack,
      input_payload: { ...input, phase: "starting_reasoning" },
      output_payload: startingPayload,
      error_message: null,
    });

    const openAI = await startOpenAIJson(
      buildPrompt(workspace, authorityPack),
      reasoningSchema(propositionIds, claimIds),
    );

    const reasoningPayload = {
      ...startingPayload,
      phase: "reasoning",
      progressMessage: phaseMessage("reasoning"),
      responseId: openAI.responseId,
      openAIStatus: openAI.status,
      reasoningStartedAt: new Date().toISOString(),
    };

    const updatedRun = await updateRunState(supabase, run.id, {
      input_payload: { ...obj(run?.input_payload), phase: "reasoning" },
      output_payload: reasoningPayload,
      error_message: null,
    });

    if (openAI.status === "completed") {
      const finalized = await finalizeReasoning({
        supabase,
        run: updatedRun,
        workspace,
        authorityPack,
        openAIData: openAI.raw,
        currentUserId: auth.id,
      });
      return {
        status: "completed",
        phase: "completed",
        reasoning: finalized.parsed,
        authorityPack,
        progressMessage: phaseMessage("completed"),
      };
    }

    return { status: "running", phase: "reasoning", progressMessage: phaseMessage("reasoning") };
  }

  throw new HttpError(409, `Bilinmeyen araştırma aşaması: ${phase}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const apiKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  try {
    if (!supabaseUrl || !serviceRoleKey || !apiKey) {
      throw new HttpError(500, "Supabase ortam değişkenleri eksik.");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const auth = await assertInternalUser(req, supabase);
    const body = await req.json().catch(() => ({}));
    const action = text(body?.action || "start");
    const taskId = text(body?.taskId);
    if (!taskId) throw new HttpError(400, "taskId zorunludur.");

    if (action === "start") {
      // Registry resolution is DB-bound and short; doing it before creating the run
      // ensures all later research phases see the same canonical prior-right snapshot.
      await invokeProjectFunction({
        supabaseUrl, apiKey, bearerToken: auth.token,
        functionName: "opposition-response-prior-rights",
        body: { taskId },
      });

      const workspace = await getWorkspace(supabaseUrl, apiKey, auth.token, taskId);
      validateWorkspaceForReasoning(workspace);

      const existing = await findReusableRunningRun(supabase, workspace.case.id, taskId);
      if (existing) {
        const phase = runPhase(existing);
        return json({
          success: true,
          packageVersion: PACKAGE_VERSION,
          runId: existing.id,
          status: "running",
          phase,
          progressMessage: text(existing?.output_payload?.progressMessage) || phaseMessage(phase),
          resumed: true,
        }, 202);
      }

      const issueTags = deriveIssueTags(workspace);
      if (!issueTags.length) issueTags.push("sign_similarity", "goods_services_similarity");
      const guidelineTags = GUIDELINE_PHASE_ORDER.filter((tag) => issueTags.includes(tag));
      const initialFingerprint = await reasoningInputFingerprint(workspace);
      const nowIso = new Date().toISOString();
      const initialProgress = issueTags.length
        ? `Doğrulanmış hukuk corpus'u taranıyor (1/${issueTags.length}): ${issueTags[0]}`
        : phaseMessage("research_corpus");

      const { data: run, error: runError } = await supabase
        .from("opposition_response_runs")
        .insert({
          response_case_id: workspace.case.id,
          run_type: "reasoning",
          status: "running",
          source_fingerprint: currentSourceFingerprint(workspace),
          model: OPENAI_MODEL,
          research_run_id: null,
          input_payload: {
            taskId,
            procedureStage: workspace.procedureStage,
            phase: "research_corpus",
            asyncOrchestratorVersion: PACKAGE_VERSION,
            allowWebSearch: body?.allowWebSearch !== false,
            reasoningInputFingerprint: initialFingerprint,
            issueTags,
            guidelineTags,
            corpusCursor: 0,
            guidelineCursor: 0,
            startedAt: nowIso,
          },
          output_payload: {
            phase: "research_corpus",
            progressMessage: initialProgress,
            startedAt: nowIso,
          },
          created_by: auth.id,
        })
        .select("id")
        .single();

      if (runError) throw new Error(`Reasoning run oluşturulamadı: ${runError.message}`);

      return json({
        success: true,
        packageVersion: PACKAGE_VERSION,
        runId: run.id,
        status: "running",
        phase: "research_corpus",
        progressMessage: initialProgress,
        resumed: false,
      }, 202);
    }

    if (action === "status") {
      const runId = text(body?.runId);
      if (!runId) throw new HttpError(400, "runId zorunludur.");

      const { data: run, error: runError } = await supabase
        .from("opposition_response_runs")
        .select("*")
        .eq("id", runId)
        .eq("run_type", "reasoning")
        .maybeSingle();
      if (runError) throw new Error(`Reasoning run okunamadı: ${runError.message}`);
      if (!run) throw new HttpError(404, "Reasoning run bulunamadı.");

      const { data: caseRow, error: caseError } = await supabase
        .from("opposition_response_cases")
        .select("id,task_id")
        .eq("id", run.response_case_id)
        .maybeSingle();
      if (caseError) throw new Error(`Response case okunamadı: ${caseError.message}`);
      if (!caseRow || text(caseRow.task_id) !== taskId) {
        throw new HttpError(404, "Reasoning run bu göreve ait değil.");
      }

      if (run.status === "failed") {
        throw new HttpError(409, text(run.error_message) || "Hukuki analiz başarısız oldu.");
      }
      if (run.status === "completed") {
        return json({
          success: true,
          packageVersion: PACKAGE_VERSION,
          runId,
          status: "completed",
          phase: "completed",
          reasoning: run?.output_payload?.reasoning ?? null,
          researchRunId: run?.research_run_id ?? null,
          progressMessage: phaseMessage("completed"),
        });
      }

      const phase = runPhase(run);

      if (phase !== "reasoning") {
        try {
          const result = await advanceResearchPhase({
            supabase, supabaseUrl, apiKey, auth, taskId, run,
          });
          return json({
            success: true,
            packageVersion: PACKAGE_VERSION,
            runId,
            researchRunId: run?.research_run_id ?? null,
            ...result,
          }, result.status === "completed" ? 200 : 202);
        } catch (error) {
          await markRunFailed(supabase, runId, error, obj(run?.output_payload));
          throw error;
        }
      }

      const workspace = await getWorkspace(supabaseUrl, apiKey, auth.token, taskId);
      validateWorkspaceForReasoning(workspace);
      await assertRunInputsStillCurrent(run, workspace);

      const responseId = text(run?.output_payload?.responseId);
      if (!responseId) throw new HttpError(409, "Reasoning response ID bulunamadı. Analizi yeniden başlatın.");

      const openAIData = await retrieveOpenAIResponse(responseId);
      const openAIStatus = text(openAIData?.status) || "unknown";
      if (openAIStatus === "queued" || openAIStatus === "in_progress") {
        return json({
          success: true,
          packageVersion: PACKAGE_VERSION,
          runId,
          status: "running",
          phase: "reasoning",
          researchRunId: run?.research_run_id ?? null,
          openAIStatus,
          progressMessage: phaseMessage("reasoning"),
        }, 202);
      }

      if (openAIStatus !== "completed") {
        const reason = text(
          openAIData?.error?.message ??
          openAIData?.incomplete_details?.reason ??
          `OpenAI reasoning tamamlanamadı: ${openAIStatus}`,
        );
        const failure = new HttpError(502, reason);
        await markRunFailed(supabase, runId, failure, {
          ...obj(run?.output_payload), openAIStatus,
        });
        throw failure;
      }

      try {
        const finalized = await finalizeReasoning({
          supabase,
          run,
          workspace,
          authorityPack: obj(run?.authority_pack),
          openAIData,
          currentUserId: auth.id,
        });
        return json({
          success: true,
          packageVersion: PACKAGE_VERSION,
          runId,
          status: "completed",
          phase: "completed",
          researchRunId: run?.research_run_id ?? null,
          reasoning: finalized.parsed,
          authorityPack: finalized.authorityPack,
          progressMessage: phaseMessage("completed"),
        });
      } catch (error) {
        await markRunFailed(supabase, runId, error, {
          ...obj(run?.output_payload), openAIStatus,
        });
        throw error;
      }
    }

    throw new HttpError(400, "action yalnız start veya status olabilir.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    console.error("[opposition-response-reasoning]", error);
    return json({
      success: false,
      packageVersion: PACKAGE_VERSION,
      error: error instanceof Error ? error.message : String(error),
    }, status);
  }
});
