import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const PACKAGE_VERSION = "response-studio-1.0.0";
const OPENAI_MODEL = Deno.env.get("OPPOSITION_RESPONSE_DRAFT_MODEL") ?? "gpt-5.6-sol";
const MAX_OUTPUT_TOKENS = Number(Deno.env.get("OPPOSITION_RESPONSE_DRAFT_MAX_TOKENS") ?? "36000");

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

function responseText(response: any) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) return response.output_text;
  for (const item of arr(response?.output)) {
    for (const content of arr(item?.content)) {
      if (typeof content?.text === "string" && content.text.trim()) return content.text;
    }
  }
  return "";
}

function draftSchema(propositionIds: string[], claimIds: string[]) {
  const safeIds = propositionIds.length ? propositionIds : ["00000000-0000-0000-0000-000000000000"];
  const safeClaimIds = claimIds.length ? claimIds : ["00000000-0000-0000-0000-000000000000"];
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      intro: { type: "string" },
      sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            sectionKey: { type: "string" },
            heading: { type: "string" },
            coveredClaimIds: { type: "array", items: { type: "string", enum: safeClaimIds } },
            paragraphs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  text: { type: "string" },
                  authorityApplications: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        propositionId: { type: "string", enum: safeIds },
                        relevanceSentence: { type: "string" },
                        useQuote: { type: "boolean" },
                      },
                      required: ["propositionId", "relevanceSentence", "useQuote"],
                    },
                  },
                },
                required: ["text", "authorityApplications"],
              },
            },
          },
          required: ["sectionKey", "heading", "coveredClaimIds", "paragraphs"],
        },
      },
      closingBridge: { type: "string" },
    },
    required: ["intro", "sections", "closingBridge"],
  };
}

async function callOpenAIJson(prompt: string, schema: any) {
  const key = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!key) throw new HttpError(500, "OPENAI_API_KEY tanımlı değil.");

  const created = await fetch("https://api.openai.com/v1/responses", {
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
          name: "opposition_response_petition",
          strict: true,
          schema,
        },
      },
      max_output_tokens: MAX_OUTPUT_TOKENS,
    }),
  });

  let data = await created.json().catch(() => ({}));
  if (!created.ok) throw new HttpError(created.status, data?.error?.message ?? "Dilekçe modeli başlatılamadı.");
  const id = text(data?.id);

  for (let attempt = 0; data?.status === "queued" || data?.status === "in_progress"; attempt += 1) {
    if (attempt > 100) throw new HttpError(504, "Dilekçe üretimi zaman aşımına uğradı.");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const poll = await fetch(`https://api.openai.com/v1/responses/${encodeURIComponent(id)}`, {
      headers: { "Authorization": `Bearer ${key}` },
    });
    data = await poll.json().catch(() => ({}));
    if (!poll.ok) throw new HttpError(poll.status, data?.error?.message ?? "Dilekçe modeli sonucu alınamadı.");
  }

  if (data?.status !== "completed") throw new HttpError(502, data?.error?.message ?? `Dilekçe tamamlanamadı: ${data?.status}`);
  const output = responseText(data);
  if (!output) throw new HttpError(502, "Dilekçe modeli JSON çıktı üretmedi.");
  try {
    return { parsed: JSON.parse(output), responseId: id };
  } catch {
    throw new HttpError(502, "Dilekçe modeli geçerli JSON üretmedi.");
  }
}

function authorityMap(pack: any) {
  return new Map(arr(pack?.propositions).map((p) => [text(p.propositionId), p]));
}

function cleanSentence(value: unknown) {
  return text(value).replace(/\s+/g, " ");
}

function limitWords(value: unknown, maxWords = 25) {
  const words = cleanSentence(value).split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

function authorityNarrative(p: any, relevanceSentence: string, useQuote: boolean) {
  const label = cleanSentence(
    p?.citationLabel ||
    [p?.court || p?.authorityName, p?.caseNo, p?.decisionNo, p?.decisionDate].filter(Boolean).join(", ") ||
    p?.authorityTitle ||
    "ilgili doğrulanmış kaynak"
  );
  const proposition = cleanSentence(p?.propositionText || p?.holdingText);
  const relevance = cleanSentence(relevanceSentence);

  let narrative = "";
  if (label && proposition) {
    narrative = `Nitekim ${label} kapsamında doğrulanan hukuki ilkeye göre, ${proposition.charAt(0).toLocaleLowerCase("tr-TR")}${proposition.slice(1)}`;
    if (!/[.!?]$/.test(narrative)) narrative += ".";
  } else if (proposition) {
    narrative = proposition;
    if (!/[.!?]$/.test(narrative)) narrative += ".";
  }

  if (useQuote && p?.quoteSafe === true && cleanSentence(p?.verifiedQuote)) {
    // Keep visible direct quotation short even if the verified corpus stores a longer
    // quote-safe excerpt. The legal proposition itself is paraphrased above.
    const quote = limitWords(p.verifiedQuote, 25);
    const locator = cleanSentence(p?.quoteLocator);
    narrative += ` Kaynakta${locator ? ` ${locator} bölümünde` : ""} “${quote}” ifadesine yer verilmiştir.`;
  }

  if (relevance) {
    narrative += ` Somut uyuşmazlık bakımından ${relevance.charAt(0).toLocaleLowerCase("tr-TR")}${relevance.slice(1)}`;
    if (!/[.!?]$/.test(narrative)) narrative += ".";
  }
  return narrative.trim();
}

function proofSection() {
  return {
    heading: "Kullanım İspatı Talebimiz",
    paragraphs: [
      "İtiraz sahibinin itirazına dayanak gösterdiği mesnet markaların, itirazda dayanılan tüm mal ve hizmetler bakımından mevzuatta öngörülen koşullar çerçevesinde kullanımının ispatlanmasını talep ediyoruz. Kullanımın usulüne uygun ve yeterli delillerle ispatlanamaması hâlinde, ilgili mesnet hakların değerlendirmede kullanımın ispatlandığı kapsamı aşacak şekilde dikkate alınmaması gerekir."
    ],
  };
}

function deterministicConclusion(stage: string) {
  if (stage === "yidk_appeal") {
    return "Yukarıda açıklanan nedenlerle, karşı tarafın Yeniden İnceleme ve Değerlendirme Kurulu nezdindeki itirazının reddine ve itiraza konu Markalar Dairesi kararının karşı tarafça itiraz edilen kısmı yönünden korunmasına karar verilmesini saygıyla arz ve talep ederiz.";
  }
  return "Yukarıda açıklanan nedenlerle, başvurumuza karşı yapılan yayına itirazın reddine ve marka başvurumuzun tescil işlemlerine devam edilmesine karar verilmesini saygıyla arz ve talep ederiz.";
}

function renderPetition(workspace: any, draft: any, pack: any) {
  const map = authorityMap(pack);
  const lines: string[] = [];
  let number = 1;

  lines.push("AÇIKLAMALARIMIZ VE İTİRAZA KARŞI GÖRÜŞLERİMİZ");
  lines.push("");
  if (cleanSentence(draft.intro)) {
    lines.push(cleanSentence(draft.intro));
    lines.push("");
  }

  lines.push(`${number}. İtirazın Kapsamı ve Değerlendirme Çerçevesi`);
  lines.push("");
  lines.push(
    workspace.procedureStage === "yidk_appeal"
      ? "Karşı tarafça Markalar Dairesi kararına karşı yapılan itiraz kapsamında, önceki aşamadaki savunmalarımız ile dosyadaki karar gerekçeleri birlikte değerlendirilerek aşağıdaki karşı görüşlerimizin dikkate alınmasını talep ediyoruz."
      : "Karşı tarafın yayına itiraz dilekçesinde ileri sürdüğü gerekçeler ve dayanak gösterdiği mesnet haklar, başvurumuzun kapsamı ve somut uyuşmazlığın özellikleri çerçevesinde aşağıda ayrı ayrı cevaplandırılmaktadır."
  );
  lines.push("");
  number += 1;

  if (workspace.procedureStage === "publication_opposition" && workspace.case.proof_of_use_requested === true) {
    const proof = proofSection();
    lines.push(`${number}. ${proof.heading}`);
    lines.push("");
    proof.paragraphs.forEach((p) => { lines.push(p); lines.push(""); });
    number += 1;
  }

  for (const section of arr(draft.sections)) {
    const heading = cleanSentence(section.heading) || "İtiraz Gerekçesine İlişkin Karşı Görüşlerimiz";
    lines.push(`${number}. ${heading}`);
    lines.push("");

    for (const paragraph of arr(section.paragraphs)) {
      const body = cleanSentence(paragraph.text);
      if (body) {
        lines.push(body);
        lines.push("");
      }

      for (const use of arr(paragraph.authorityApplications)) {
        const proposition = map.get(text(use.propositionId));
        if (!proposition) continue;
        const narrative = authorityNarrative(proposition, cleanSentence(use.relevanceSentence), use.useQuote === true);
        if (narrative) {
          lines.push(narrative);
          lines.push("");
        }
      }
    }
    number += 1;
  }

  if (cleanSentence(draft.closingBridge)) {
    lines.push(cleanSentence(draft.closingBridge));
    lines.push("");
  }

  lines.push(`${number}. SONUÇ VE TALEP`);
  lines.push("");
  lines.push(deterministicConclusion(workspace.procedureStage));

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function internalLanguageHits(petition: string) {
  const forbidden = [
    /Decision Tree/i,
    /canonical/i,
    /lawyer finding/i,
    /avukat bulgusu/i,
    /dosyada kaydedilen/i,
    /sistem tarafından/i,
    /AI tarafından/i,
  ];
  return forbidden.filter((rx) => rx.test(petition)).map((rx) => rx.source);
}

function qaDraft(workspace: any, structured: any, petition: string, pack: any) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const map = authorityMap(pack);

  const claims = arr(workspace.claims);
  const covered = new Set(arr(structured.sections).flatMap((s) => arr(s.coveredClaimIds).map(String)));
  const uncovered = claims.map((c) => String(c.id)).filter((id) => !covered.has(id));
  if (uncovered.length) blockers.push(`Karşı tarafın ${uncovered.length} iddiası taslakta coverage almıyor.`);

  for (const section of arr(structured.sections)) {
    for (const paragraph of arr(section.paragraphs)) {
      for (const use of arr(paragraph.authorityApplications)) {
        const p = map.get(text(use.propositionId));
        if (!p) blockers.push(`Authority Pack dışında propositionId kullanıldı: ${text(use.propositionId)}`);
        if (use.useQuote === true && p?.quoteSafe !== true) blockers.push(`quoteSafe olmayan authority için doğrudan alıntı istendi: ${text(use.propositionId)}`);
      }
    }
  }

  const internalHits = internalLanguageHits(petition);
  if (internalHits.length) blockers.push(`Görünür dilekçede iç sistem dili bulundu: ${internalHits.join(", ")}`);

  const proofRequested = workspace.procedureStage === "publication_opposition" && workspace.case.proof_of_use_requested === true;
  const hasProofRequest = /kullanım(?:ının)?\s+ispat(?:ı|lanmasını).{0,120}(?:talep|ist)/is.test(petition) || /kullanım\s+ispatı\s+talebimiz/i.test(petition);
  if (proofRequested && !hasProofRequest) blockers.push("Kullanım ispatı filing instruction=true fakat görünür dilekçede açık talep yok.");
  if (workspace.procedureStage === "yidk_appeal" && /kullanım.{0,80}ispat.{0,80}(?:talep ediyoruz|talep ederiz|talep edilsin)/is.test(petition)) {
    blockers.push("YİDK karşı görüşünde yeni kullanım ispatı talebi üretildi.");
  }

  if (petition.length < 2500) warnings.push("Dilekçe beklenenden kısa; karşı taraf iddialarına cevap derinliği kontrol edilmeli.");
  if (petition.length > 18000) warnings.push("Dilekçe karşı görüş hedefi için gereğinden uzun olabilir; tekrarlar kontrol edilmelidir.");

  const partyConflict = arr(workspace.case?.extracted_case?.conflicts).some((c) => text(c.field).toLocaleLowerCase("tr-TR").includes("opponent"));
  if (partyConflict) warnings.push("Kaynak belgelerde taraf bilgisi çelişkisi tespit edilmişti; EPATS canonical değerinin kullanıldığı kontrol edilmelidir.");

  return {
    finalPass: blockers.length === 0,
    blockers,
    warnings,
    checks: {
      claimCoverage: uncovered.length === 0,
      authorityClosedWorld: blockers.every((x) => !x.includes("propositionId")),
      quoteSafety: blockers.every((x) => !x.includes("quoteSafe")),
      proofInstructionConsistency: blockers.every((x) => !x.includes("Kullanım ispatı")),
      internalLanguageClean: internalHits.length === 0,
    },
  };
}

function buildPrompt(workspace: any, reasoning: any, pack: any) {
  const propositionIds = arr(pack.propositions).map((p) => p.propositionId).filter(Boolean);
  return `
Draft a TURKISH TRADEMARK OPPOSITION RESPONSE petition body for EVREKA.

OBJECTIVE
- This is not an originating opposition petition. Keep it materially shorter and more focused.
- Nevertheless, it must contain real legal discussion and must answer the opponent's concrete allegations persuasively.
- The visible writing should read like experienced Turkish trademark counsel, not a summary or AI memo.

PROCEDURE STAGE: ${workspace.procedureStage}

CANONICAL CASE:
${JSON.stringify({
  applicant: workspace.applicant,
  opponentParty: workspace.case.party_snapshot?.opponent,
  priorMarks: workspace.priorMarks,
  claims: workspace.claims,
  lawyerFindings: workspace.case.lawyer_findings,
  proofOfUseRequested: workspace.case.proof_of_use_requested,
  yidkHistory: workspace.case.procedural_history,
})}

BINDING INTERNAL REASONING:
${JSON.stringify(reasoning)}

ALLOWED VERIFIED AUTHORITY PROPOSITION IDS:
${JSON.stringify(propositionIds)}

AUTHORITY PACK FOR SELECTION CONTEXT:
${JSON.stringify(pack)}

DRAFTING RULES
1. Follow every explicit lawyer finding and the controlled reasoning. Do not contradict them.
2. Answer the opponent's actual claims; every claim ID must appear in coveredClaimIds of at least one section.
3. For YİDK, if previous response exists and there is no contrary lawyer instruction, preserve the prior defense line and focus additionally on why the appellant's attacks on the Markalar Dairesi decision are unpersuasive.
4. Do NOT put a new proof-of-use request into a YİDK response.
5. Do NOT write authority names, case numbers, dates, quotations or bibliographic citations inside paragraph.text. Those will be injected deterministically later.
6. When authority support strengthens a paragraph, use authorityApplications with ONLY the supplied proposition IDs. relevanceSentence must explain why that proposition supports the concrete defense.
7. useQuote=true only when the Authority Pack says quoteSafe=true; otherwise false.
8. Authorities should support legal reasoning with concrete application. Avoid string citations.
9. Prefer useful TÜRKPATENT Guideline comparisons and verified Yargıtay/CJEU/General Court authority that is FAVORABLE to the defense. There is no need to discuss adverse authority.
10. The legal discussion should have good depth but no repetition. Normally 4-8 substantive sections are enough depending on grounds. Aim for a focused petition body roughly in the 6,000-16,000 character range when the number of claims permits; depth comes from concrete rebuttal and application of authority, not repetition.
11. Do not write the final SONUÇ VE TALEP; the system adds it deterministically.
12. Do not write a separate usage-proof section; the system adds it deterministically if the lawyer checked the filing instruction.
13. Do not use internal words such as Decision Tree, canonical, lawyer finding, AI analysis, recorded in file.
14. No fabricated facts. No expansion beyond source documents.

Return only the strict JSON structure.
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

    const wsRes = await invokeProjectFunction({
      supabaseUrl, apiKey, bearerToken: auth.token,
      functionName: "opposition-response-workspace",
      body: { action: "get", taskId },
    });
    const workspace = wsRes.workspace;
    const reasoning = obj(workspace?.case?.current_reasoning);
    if (!Object.keys(reasoning).length) throw new HttpError(422, "Önce Response Studio hukuki reasoning aşaması tamamlanmalıdır.");

    const { data: reasoningRun, error: reasoningRunError } = await supabase.from("opposition_response_runs")
      .select("id, authority_pack, research_run_id, source_fingerprint")
      .eq("response_case_id", workspace.case.id)
      .eq("run_type", "reasoning")
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (reasoningRunError || !reasoningRun?.authority_pack) {
      throw new HttpError(422, "Reasoning Authority Pack bulunamadı.");
    }

    const pack = reasoningRun.authority_pack;
    const propositionIds = arr(pack.propositions).map((p) => text(p.propositionId)).filter(Boolean);
    const claimIds = arr(workspace.claims).map((c) => text(c.id)).filter(Boolean);

    const { data: run, error: runError } = await supabase.from("opposition_response_runs").insert({
      response_case_id: workspace.case.id,
      run_type: "draft",
      status: "running",
      source_fingerprint: workspace.case.analysis_fingerprint ?? workspace.case.source_fingerprint,
      model: OPENAI_MODEL,
      research_run_id: reasoningRun.research_run_id ?? null,
      input_payload: { taskId, reasoningRunId: reasoningRun.id, procedureStage: workspace.procedureStage },
      authority_pack: pack,
      created_by: auth.id,
    }).select("id").single();
    if (runError) throw new Error(`Draft run oluşturulamadı: ${runError.message}`);

    try {
      const modelDraft = await callOpenAIJson(
        buildPrompt(workspace, reasoning, pack),
        draftSchema(propositionIds, claimIds),
      );

      const petitionText = renderPetition(workspace, modelDraft.parsed, pack);
      const qaReport = qaDraft(workspace, modelDraft.parsed, petitionText, pack);

      const nextVersion = Number(workspace.case.draft_version ?? 0) + 1;
      await supabase.from("opposition_response_cases").update({
        current_draft: petitionText,
        current_draft_structured: modelDraft.parsed,
        qa_report: qaReport,
        draft_version: nextVersion,
        status: qaReport.finalPass ? "draft" : "analysis",
        updated_by: auth.id,
      }).eq("id", workspace.case.id);

      await supabase.from("opposition_response_runs").update({
        status: "completed",
        output_payload: {
          responseId: modelDraft.responseId,
          structuredDraft: modelDraft.parsed,
          petitionText,
          qaReport,
          draftVersion: nextVersion,
        },
        completed_at: new Date().toISOString(),
      }).eq("id", run.id);

      return json({
        success: true,
        packageVersion: PACKAGE_VERSION,
        runId: run.id,
        draftVersion: nextVersion,
        petitionText,
        structuredDraft: modelDraft.parsed,
        qaReport,
        documentData: {
          procedureStage: workspace.procedureStage,
          applicant: workspace.applicant,
          opponentParty: workspace.case.party_snapshot?.opponent ?? null,
          priorMarks: workspace.priorMarks,
          task: workspace.task,
        },
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
    console.error("[opposition-response-draft]", error);
    return json({ success: false, packageVersion: PACKAGE_VERSION, error: error instanceof Error ? error.message : String(error) }, status);
  }
});
