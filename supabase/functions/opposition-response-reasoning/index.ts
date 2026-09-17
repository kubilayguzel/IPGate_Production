import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const PACKAGE_VERSION = "response-studio-1.0.0";
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
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success === false || data?.ok === false) {
    throw new HttpError(response.status || 422, data?.error ?? `${functionName} çağrısı başarısız.`);
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

async function callOpenAIJson(prompt: string, schema: any) {
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
  let data = await create.json().catch(() => ({}));
  if (!create.ok) throw new HttpError(create.status, data?.error?.message ?? "OpenAI reasoning başlatılamadı.");

  const responseId = text(data?.id);
  for (let attempt = 0; data?.status === "queued" || data?.status === "in_progress"; attempt += 1) {
    if (attempt > 110) throw new HttpError(504, "OpenAI reasoning zaman aşımına uğradı.");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const poll = await fetch(`https://api.openai.com/v1/responses/${encodeURIComponent(responseId)}`, {
      headers: { "Authorization": `Bearer ${key}` },
    });
    data = await poll.json().catch(() => ({}));
    if (!poll.ok) throw new HttpError(poll.status, data?.error?.message ?? "OpenAI reasoning sonucu alınamadı.");
  }

  if (data?.status !== "completed") {
    throw new HttpError(502, data?.error?.message ?? `Reasoning tamamlanamadı: ${data?.status ?? "unknown"}`);
  }

  const output = responseText(data);
  if (!output) throw new HttpError(502, "Reasoning modeli JSON çıktı üretmedi.");
  try {
    return { parsed: JSON.parse(output), responseId };
  } catch {
    throw new HttpError(502, "Reasoning modeli geçerli JSON üretmedi.");
  }
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const apiKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const auth = await assertInternalUser(req, supabase);
    const body = await req.json().catch(() => ({}));
    const taskId = text(body.taskId);
    if (!taskId) throw new HttpError(400, "taskId zorunludur.");

    const workspaceResult = await invokeProjectFunction({
      supabaseUrl, apiKey, bearerToken: auth.token,
      functionName: "opposition-response-workspace",
      body: { action: "get", taskId },
    });
    let workspace = workspaceResult.workspace;

    if (workspace?.sourceBundle?.complete !== true) {
      throw new HttpError(422, `Kaynak belge paketi eksik: ${arr(workspace?.sourceBundle?.missing).join(", ")}`);
    }
    if (!arr(workspace?.claims).length) {
      throw new HttpError(422, "Önce AI belge analizi tamamlanmalıdır; iddia haritası bulunmuyor.");
    }
    const hasRelativePriorRightGround = arr(workspace?.claims).some((c) =>
      /6[\/_\s.-]*(?:1|3|4|5)/i.test(text(c?.legal_ground))
    );
    if (hasRelativePriorRightGround && !arr(workspace?.priorMarks).length) {
      throw new HttpError(422, "İleri sürülen marka hakkına dayalı gerekçeler için mesnet hak çıkarılamadı. AI analizi yenilenmeli veya eksik mesnet hak avukat tarafından eklenmelidir.");
    }

    // Re-run registry resolution immediately before legal research so direct API calls,
    // later lawyer additions and changed third-party records cannot leave reasoning stale.
    await invokeProjectFunction({
      supabaseUrl, apiKey, bearerToken: auth.token,
      functionName: "opposition-response-prior-rights",
      body: { taskId },
    });
    const refreshedWorkspace = await invokeProjectFunction({
      supabaseUrl, apiKey, bearerToken: auth.token,
      functionName: "opposition-response-workspace",
      body: { action: "get", taskId },
    });
    workspace = refreshedWorkspace.workspace;

    const issueTags = deriveIssueTags(workspace);
    if (!issueTags.length) issueTags.push("sign_similarity", "goods_services_similarity");

    const research = await invokeProjectFunction({
      supabaseUrl, apiKey, bearerToken: auth.token,
      functionName: "legal-research",
      body: {
        action: "research",
        taskId,
        issueTags,
        coverageThreshold: 0.78,
        requireCompleteCoverage: false,
        minCaseAuthorities: 3,
        minYargitayAuthorities: 1,
        minEuAuthorities: 1,
        allowWebSearch: body?.allowWebSearch !== false,
        autoVerify: true,
        forceGuidelineEvidence: true,
        guidelineEvidenceTags: [
          "goods_services_similarity", "goods_retail_relation", "sign_similarity",
          "common_element", "dominant_element", "interdependence"
        ].filter((tag) => issueTags.includes(tag)),
        caseContext: buildResearchContext(workspace),
      },
    });

    const authorityPack = compactAuthorityPack(research.authorityPack);
    const propositionIds = arr(authorityPack.propositions).map((p) => p.propositionId).filter(Boolean);
    const claimIds = arr(workspace.claims).map((c) => text(c.id)).filter(Boolean);

    const { data: run, error: runError } = await supabase.from("opposition_response_runs").insert({
      response_case_id: workspace.case.id,
      run_type: "reasoning",
      status: "running",
      source_fingerprint: workspace.case.analysis_fingerprint ?? workspace.case.source_fingerprint,
      model: OPENAI_MODEL,
      research_run_id: research.researchRunId ?? null,
      input_payload: { taskId, issueTags, procedureStage: workspace.procedureStage },
      authority_pack: authorityPack,
      created_by: auth.id,
    }).select("id").single();
    if (runError) throw new Error(`Reasoning run oluşturulamadı: ${runError.message}`);

    try {
      const result = await callOpenAIJson(
        buildPrompt(workspace, authorityPack),
        reasoningSchema(propositionIds, claimIds),
      );

      const responseClaimIds = new Set(arr(result.parsed?.claimResponses).map((row) => text(row?.claimId)));
      const missingClaimIds = claimIds.filter((id) => !responseClaimIds.has(id));
      if (missingClaimIds.length) {
        throw new HttpError(422, `Hukuki reasoning karşı tarafın ${missingClaimIds.length} iddiasını cevaplamadı; run reddedildi.`);
      }

      // Deterministic filing-control corrections: model may not override these.
      result.parsed.proofOfUse = workspace.procedureStage === "publication_opposition"
        ? {
            include: workspace.case.proof_of_use_requested === true,
            instruction: workspace.case.proof_of_use_requested === true
              ? "Karşı tarafın itirazına dayanak gösterdiği mesnet markaların dayanılan tüm mal ve hizmetleri bakımından kullanım ispatı talep edilecektir."
              : "Kullanım ispatı talebi filing instruction olarak verilmemiştir.",
          }
        : {
            include: false,
            instruction: "YİDK karşı görüş aşamasında yeni kullanım ispatı talebi oluşturulmayacaktır.",
          };

      await supabase.from("opposition_response_cases").update({
        current_reasoning: result.parsed,
        current_research_run_id: research.researchRunId ?? null,
        status: "analysis",
        current_draft: null,
        current_draft_structured: null,
        qa_report: null,
        updated_by: auth.id,
      }).eq("id", workspace.case.id);

      await supabase.from("opposition_response_runs").update({
        status: "completed",
        output_payload: { responseId: result.responseId, reasoning: result.parsed },
        completed_at: new Date().toISOString(),
      }).eq("id", run.id);

      return json({
        success: true,
        packageVersion: PACKAGE_VERSION,
        runId: run.id,
        researchRunId: research.researchRunId ?? null,
        reasoning: result.parsed,
        authorityPack,
      });
    } catch (error) {
      await supabase.from("opposition_response_runs").update({
        status: "failed",
        error_message: error instanceof Error ? error.message : String(error),
        completed_at: new Date().toISOString(),
      }).eq("id", run.id);
      throw error;
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    console.error("[opposition-response-reasoning]", error);
    return json({ success: false, packageVersion: PACKAGE_VERSION, error: error instanceof Error ? error.message : String(error) }, status);
  }
});
