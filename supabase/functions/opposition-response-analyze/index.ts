import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const PACKAGE_VERSION = "response-studio-1.0.3";
const OPENAI_MODEL = Deno.env.get("OPPOSITION_RESPONSE_EXTRACTION_MODEL") ?? "gpt-5.6-sol";
const RESPONSE_TASK_TYPE = "38";

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

function text(value: unknown) {
  return String(value ?? "").trim();
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function arr(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function normalizeNo(value: unknown) {
  return text(value).toLocaleUpperCase("tr-TR").replace(/[^A-Z0-9]/g, "");
}

async function assertInternalUser(req: Request, supabase: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Oturum bilgisi bulunamadı.");

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) throw new HttpError(401, "Geçersiz oturum.");

  const { data: profile } = await supabase.from("users")
    .select("id, role, disabled")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (!profile || profile.disabled || !["user", "admin", "superadmin"].includes(String(profile.role))) {
    throw new HttpError(403, "Bu çalışma alanına erişim yetkiniz bulunmuyor.");
  }
  return { id: authData.user.id, token };
}

async function invokeProjectFunction({
  supabaseUrl,
  apiKey,
  bearerToken,
  functionName,
  body,
}: any) {
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
  if (!response.ok || data?.success === false) {
    throw new HttpError(response.status || 422, data?.error ?? `${functionName} çağrısı başarısız.`);
  }
  return data;
}

function extractionSchema() {
  const provenance = {
    type: "object",
    additionalProperties: false,
    properties: {
      documentRole: { type: "string" },
      documentId: { type: "string" },
      page: { type: "integer" },
      excerpt: { type: "string" },
    },
    required: ["documentRole", "documentId", "page", "excerpt"],
  };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      procedureStage: {
        type: "string",
        enum: ["publication_opposition", "yidk_appeal"],
      },
      opponentParty: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          representativeName: { type: "string" },
          address: { type: "string" },
          confidence: { type: "number" },
          provenance: { type: "array", items: provenance },
        },
        required: ["name", "representativeName", "address", "confidence", "provenance"],
      },
      applicantCrossCheck: {
        type: "object",
        additionalProperties: false,
        properties: {
          consistent: { type: "boolean" },
          documentApplicantNames: { type: "array", items: { type: "string" } },
          applicationNoInDocuments: { type: "string" },
          note: { type: "string" },
        },
        required: ["consistent", "documentApplicantNames", "applicationNoInDocuments", "note"],
      },
      legalGrounds: { type: "array", items: { type: "string" } },
      priorMarks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            markText: { type: "string" },
            applicationNo: { type: "string" },
            registrationNo: { type: "string" },
            internationalRegistrationNo: { type: "string" },
            ownerName: { type: "string" },
            applicationDate: { type: "string" },
            registrationDate: { type: "string" },
            legalGrounds: { type: "array", items: { type: "string" } },
            reliedScope: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  classNo: { type: "integer" },
                  itemsText: { type: "string" },
                },
                required: ["classNo", "itemsText"],
              },
            },
            confidence: { type: "number" },
            provenance: { type: "array", items: provenance },
          },
          required: [
            "markText", "applicationNo", "registrationNo", "internationalRegistrationNo",
            "ownerName", "applicationDate", "registrationDate", "legalGrounds",
            "reliedScope", "confidence", "provenance"
          ],
        },
      },
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            legalGround: { type: "string" },
            claimType: { type: "string" },
            claimText: { type: "string" },
            priorMarkReference: { type: "string" },
            challengedFinding: { type: "string" },
            sourceDocumentRole: { type: "string" },
            sourceDocumentId: { type: "string" },
            sourcePage: { type: "integer" },
            sourceExcerpt: { type: "string" },
          },
          required: [
            "legalGround", "claimType", "claimText", "priorMarkReference",
            "challengedFinding", "sourceDocumentRole", "sourceDocumentId",
            "sourcePage", "sourceExcerpt"
          ],
        },
      },
      yidkContinuity: {
        type: "object",
        additionalProperties: false,
        properties: {
          previousResponseFound: { type: "boolean" },
          previousDefenseSummary: { type: "string" },
          officeDecisionSummary: { type: "string" },
          appellantChallenges: { type: "array", items: { type: "string" } },
          priorProofRequestDetected: { type: "boolean" },
        },
        required: [
          "previousResponseFound", "previousDefenseSummary", "officeDecisionSummary",
          "appellantChallenges", "priorProofRequestDetected"
        ],
      },
      conflicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            field: { type: "string" },
            epatsValue: { type: "string" },
            otherValue: { type: "string" },
            resolution: { type: "string" },
          },
          required: ["field", "epatsValue", "otherValue", "resolution"],
        },
      },
      extractionNotes: { type: "array", items: { type: "string" } },
    },
    required: [
      "procedureStage", "opponentParty", "applicantCrossCheck", "legalGrounds",
      "priorMarks", "claims", "yidkContinuity", "conflicts", "extractionNotes"
    ],
  };
}

function extractOutputText(response: any) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) return response.output_text;
  for (const item of arr(response?.output)) {
    for (const content of arr(item?.content)) {
      if (typeof content?.text === "string" && content.text.trim()) return content.text;
    }
  }
  return "";
}

async function callExtractionModel(workspace: any) {
  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  if (!openaiKey) throw new HttpError(500, "OPENAI_API_KEY tanımlı değil.");

  const documents = arr(workspace.documents)
    .filter((d) => {
      const role = String(d.role);
      if (["official_notice", "opposition_petition", "epats_opposition"].includes(role)) {
        return d.is_current_stage === true;
      }
      return ["office_decision", "previous_response", "proof_of_use_evidence"].includes(role);
    })
    .slice(0, 12);

  const content: any[] = [{
    type: "input_text",
    text: `
EVREKA Opposition Response Studio belge çıkarımı.

PORTFÖYDEKİ BAŞVURU SAHİBİ VERİSİ (DEĞİŞTİRİLEMEZ CANONICAL KAYNAK):
${JSON.stringify({
  markText: workspace.applicant?.markText,
  applicationNo: workspace.applicant?.applicationNo,
  applicationDate: workspace.applicant?.applicationDate,
  applicants: workspace.applicant?.applicants,
  classes: workspace.applicant?.classes,
})}

SİSTEMİN TESPİT ETTİĞİ USUL AŞAMASI: ${workspace.procedureStage}

KURALLAR:
1. Karşı taraf/opponent kimliğinde EPATS belgesini birincil kaynak kabul et. Diğer belgeler çelişirse EPATS değerini canonical opponent olarak döndür ve conflicts alanında çelişkiyi kaydet.
2. Başvuru sahibi adını portföy canonical verisinden değiştirme. Belgelerde farklı görünüyorsa applicantCrossCheck altında belirt.
3. Mesnet markaları kullanıcı girişi beklemeden belgelerden çıkar. Aynı hakkı farklı yazım/numara formatı nedeniyle iki kez oluşturma.
4. Her mesnet marka ve her iddia için kaynak belge ID'si, belge rolü, sayfa ve kısa kaynak pasajı ver. Kaynaksız iddia üretme.
5. EPATS'ta işaretli bir hukuki gerekçe anlatı dilekçesinde az tartışılsa bile legalGrounds'a dahil et.
6. Dilekçede geçen bir madde EPATS'ta filing ground olarak görünmüyorsa bunu conflicts/extractionNotes altında belirt; filing ground'u genişletme.
7. YİDK aşamasında önceki karşı görüş varsa savunma çizgisini ve Daire kararını ayrı özetle; appellant'ın karara yönelttiği eleştirileri claims/challengedFinding alanlarında yakala.
8. Hiçbir sicil tarihi/numarası uydurma. Belgede yoksa boş string döndür.
9. Çıkarım görevidir; hukuki başarı kanaati verme.
`.trim(),
  }];

  for (const doc of documents) {
    content.push({
      type: "input_text",
      text: `BELGE ID: ${doc.id}\nBELGE ROLÜ: ${doc.role}\nBELGE ADI: ${doc.document_name ?? "-"}`,
    });
    content.push({
      type: "input_file",
      file_url: doc.source_url,
    });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning: { effort: "high" },
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "opposition_response_document_extraction",
          strict: true,
          schema: extractionSchema(),
        },
      },
      max_output_tokens: 30000,
    }),
  });

  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(response.status, raw?.error?.message ?? "OpenAI belge çıkarımı başarısız.");
  }

  const outputText = extractOutputText(raw);
  if (!outputText) throw new HttpError(502, "Belge çıkarım modeli JSON sonucu üretmedi.");

  try {
    return { parsed: JSON.parse(outputText), responseId: raw?.id ?? null };
  } catch {
    throw new HttpError(502, "Belge çıkarım modeli geçerli JSON üretmedi.");
  }
}

function validateExtraction(workspace: any, extraction: any) {
  const documentMap = new Map(arr(workspace?.documents).map((d) => [String(d.id), d]));
  const currentEpatsIds = new Set(
    arr(workspace?.documents)
      .filter((d) => d.role === "epats_opposition" && d.is_current_stage === true)
      .map((d) => String(d.id)),
  );

  extraction.procedureStage = workspace.procedureStage;

  const opponent = object(extraction.opponentParty);
  if (!text(opponent.name)) {
    throw new HttpError(422, "EPATS belgesinden karşı tarafın adı güvenli biçimde çıkarılamadı.");
  }

  const opponentEpatsProvenance = arr(opponent.provenance).some((p) =>
    text(p.documentRole) === "epats_opposition" && currentEpatsIds.has(String(p.documentId))
  );
  if (!opponentEpatsProvenance) {
    throw new HttpError(422, "Karşı taraf kimliği güncel EPATS belgesiyle kaynaklandırılamadı; extraction kaydedilmedi.");
  }

  if (!arr(extraction.legalGrounds).length) {
    throw new HttpError(422, "İtirazın hukuki gerekçeleri kaynak belgelerden çıkarılamadı.");
  }
  if (!arr(extraction.claims).length) {
    throw new HttpError(422, "Karşı tarafın kaynaklı iddiaları çıkarılamadı.");
  }

  for (const mark of arr(extraction.priorMarks)) {
    const provenance = arr(mark.provenance);
    if (!provenance.length) {
      throw new HttpError(422, `Mesnet hak için kaynak bilgisi yok: ${text(mark.markText) || text(mark.applicationNo) || "tanımsız hak"}`);
    }
    for (const source of provenance) {
      if (!documentMap.has(String(source.documentId))) {
        throw new HttpError(422, `Mesnet hak geçersiz documentId taşıyor: ${text(source.documentId)}`);
      }
      if (Number(source.page) < 1 || !text(source.excerpt)) {
        throw new HttpError(422, "Mesnet hak provenance bilgisi sayfa/pasaj bakımından eksik.");
      }
    }
  }

  for (const claim of arr(extraction.claims)) {
    const doc = documentMap.get(String(claim.sourceDocumentId));
    if (!doc) {
      throw new HttpError(422, `İddia geçersiz documentId taşıyor: ${text(claim.sourceDocumentId)}`);
    }
    if (Number(claim.sourcePage) < 1 || !text(claim.sourceExcerpt) || !text(claim.claimText)) {
      throw new HttpError(422, "İddia provenance bilgisi sayfa/pasaj bakımından eksik.");
    }
    if (workspace.procedureStage === "yidk_appeal" &&
        ["official_notice", "opposition_petition", "epats_opposition"].includes(String(doc.role)) &&
        doc.is_current_stage !== true) {
      throw new HttpError(422, "YİDK iddiası geçmiş aşamadaki itiraz belgesine yanlış bağlandı; güncel karara itiraz belgesi kullanılmalıdır.");
    }
  }

  return extraction;
}

function findPriorMarkId(priorRows: any[], reference: unknown) {
  const ref = normalizeNo(reference);
  if (!ref) return null;
  const found = priorRows.find((row) => {
    const candidates = [row.application_no, row.registration_no, row.international_registration_no, row.mark_text]
      .map(normalizeNo)
      .filter(Boolean);
    return candidates.some((value) => value === ref || value.includes(ref) || ref.includes(value));
  });
  return found?.id ?? null;
}

async function persistExtraction(
  supabase: ReturnType<typeof createClient>,
  workspace: any,
  extraction: any,
  userId: string,
  runId: string,
) {
  const caseId = workspace.case.id;

  // Preserve lawyer-added rights; refresh only AI-extracted rights.
  const { error: deletePriorError } = await supabase.from("opposition_response_prior_marks")
    .delete().eq("response_case_id", caseId).eq("source_kind", "ai");
  if (deletePriorError) throw new Error(`Eski AI mesnet markaları temizlenemedi: ${deletePriorError.message}`);

  const priorInserts = arr(extraction.priorMarks).map((mark) => ({
    response_case_id: caseId,
    source_kind: "ai",
    mark_text: text(mark.markText) || null,
    application_no: text(mark.applicationNo) || null,
    registration_no: text(mark.registrationNo) || null,
    international_registration_no: text(mark.internationalRegistrationNo) || null,
    owner_name: text(mark.ownerName) || null,
    application_date: /^\d{4}-\d{2}-\d{2}$/.test(text(mark.applicationDate)) ? text(mark.applicationDate) : null,
    registration_date: /^\d{4}-\d{2}-\d{2}$/.test(text(mark.registrationDate)) ? text(mark.registrationDate) : null,
    legal_grounds: arr(mark.legalGrounds).map(String),
    relied_scope: arr(mark.reliedScope),
    provenance: arr(mark.provenance),
    identity_resolution_status: Number(mark.confidence ?? 0) >= 0.75 ? "extracted" : "needs_review",
    registry_resolution_status: "not_checked",
    extraction_confidence: Number(mark.confidence ?? 0) || null,
    created_by: userId,
  }));

  if (priorInserts.length) {
    const { error } = await supabase.from("opposition_response_prior_marks").insert(priorInserts);
    if (error) throw new Error(`AI mesnet markaları kaydedilemedi: ${error.message}`);
  }

  const { data: priorRows, error: priorReadError } = await supabase.from("opposition_response_prior_marks")
    .select("*").eq("response_case_id", caseId).eq("is_active", true);
  if (priorReadError) throw new Error(`Mesnet marka eşleştirmesi okunamadı: ${priorReadError.message}`);

  const { error: deleteClaimsError } = await supabase.from("opposition_response_claims")
    .delete().eq("response_case_id", caseId);
  if (deleteClaimsError) throw new Error(`Eski iddia haritası temizlenemedi: ${deleteClaimsError.message}`);

  const documentMap = new Map(arr(workspace.documents).map((d) => [String(d.id), d]));
  const claims = arr(extraction.claims).map((claim, index) => ({
    response_case_id: caseId,
    prior_mark_id: findPriorMarkId(priorRows ?? [], claim.priorMarkReference),
    legal_ground: text(claim.legalGround) || "UNSPECIFIED",
    claim_type: text(claim.claimType) || "general",
    claim_text: text(claim.claimText),
    challenged_finding: text(claim.challengedFinding) || null,
    source_document_id: documentMap.has(String(claim.sourceDocumentId)) ? String(claim.sourceDocumentId) : null,
    source_page: Number.isInteger(Number(claim.sourcePage)) ? Number(claim.sourcePage) : null,
    source_excerpt: text(claim.sourceExcerpt) || null,
    provenance: {
      documentRole: text(claim.sourceDocumentRole),
      documentId: text(claim.sourceDocumentId),
      modelRunId: runId,
    },
    order_index: index,
  })).filter((row) => row.claim_text);

  if (claims.length) {
    const { error } = await supabase.from("opposition_response_claims").insert(claims);
    if (error) throw new Error(`İddia haritası kaydedilemedi: ${error.message}`);
  }

  const stage = workspace.procedureStage;
  const opponentParty = object(extraction.opponentParty);
  const partySnapshot = {
    applicant: workspace.case?.party_snapshot?.applicant ?? {
      source: "ip_gate_portfolio",
      applicants: workspace.applicant?.applicants ?? [],
      applicationNo: workspace.applicant?.applicationNo ?? null,
      markText: workspace.applicant?.markText ?? null,
    },
    opponent: {
      source: "epats_primary",
      name: text(opponentParty.name) || null,
      representativeName: text(opponentParty.representativeName) || null,
      address: text(opponentParty.address) || null,
      confidence: Number(opponentParty.confidence ?? 0),
      provenance: arr(opponentParty.provenance),
    },
  };

  const analysisFingerprintPayload = {
    sourceFingerprint: workspace.case.source_fingerprint,
    extraction,
    lawyerFindings: workspace.case.lawyer_findings,
    proofOfUseRequested: stage === "publication_opposition" ? workspace.case.proof_of_use_requested : false,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(analysisFingerprintPayload)),
  );
  const analysisFingerprint = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");

  const { error: caseError } = await supabase.from("opposition_response_cases").update({
    procedure_stage: stage,
    extracted_case: extraction,
    party_snapshot: partySnapshot,
    procedural_history: object(extraction.yidkContinuity),
    analysis_fingerprint: analysisFingerprint,
    status: "extracted",
    current_reasoning: null,
    current_research_run_id: null,
    current_draft: null,
    current_draft_structured: null,
    qa_report: null,
    updated_by: userId,
  }).eq("id", caseId);
  if (caseError) throw new Error(`Extraction sonucu Response Case'e kaydedilemedi: ${caseError.message}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const projectApiKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const auth = await assertInternalUser(req, supabase);
    const body = await req.json().catch(() => ({}));
    const taskId = text(body.taskId);
    if (!taskId) throw new HttpError(400, "taskId zorunludur.");

    const workspaceResponse = await invokeProjectFunction({
      supabaseUrl,
      apiKey: projectApiKey,
      bearerToken: auth.token,
      functionName: "opposition-response-workspace",
      body: { action: "get", taskId },
    });
    const workspace = workspaceResponse.workspace;

    if (String(workspace?.task?.id ?? "") !== taskId) throw new HttpError(422, "Response workspace uyuşmuyor.");
    if (workspace?.sourceBundle?.complete !== true) {
      throw new HttpError(422, `Kaynak belge paketi eksik: ${arr(workspace?.sourceBundle?.missing).join(", ")}`);
    }

    const { data: run, error: runError } = await supabase.from("opposition_response_runs").insert({
      response_case_id: workspace.case.id,
      run_type: "extraction",
      status: "running",
      source_fingerprint: workspace.case.source_fingerprint,
      model: OPENAI_MODEL,
      input_payload: {
        taskId,
        procedureStage: workspace.procedureStage,
        documentIds: arr(workspace.documents).map((d) => d.id),
      },
      created_by: auth.id,
    }).select("id").single();
    if (runError) throw new Error(`Extraction run oluşturulamadı: ${runError.message}`);

    try {
      const result = await callExtractionModel(workspace);
      const validatedExtraction = validateExtraction(workspace, result.parsed);
      await persistExtraction(supabase, workspace, validatedExtraction, auth.id, run.id);

      // Resolve extracted (and any lawyer-added) prior rights against IP GATE's
      // third-party trademark records. This keeps document extraction and registry
      // verification as separate responsibilities. A genuine no-match is recorded as
      // registry_resolution_status=not_found; technical resolver failures block the run.
      await invokeProjectFunction({
        supabaseUrl,
        apiKey: projectApiKey,
        bearerToken: auth.token,
        functionName: "opposition-response-prior-rights",
        body: { taskId },
      });

      await supabase.from("opposition_response_runs").update({
        status: "completed",
        output_payload: {
          responseId: result.responseId,
          extraction: validatedExtraction,
        },
        completed_at: new Date().toISOString(),
      }).eq("id", run.id);

      const refreshed = await invokeProjectFunction({
        supabaseUrl,
        apiKey: projectApiKey,
        bearerToken: auth.token,
        functionName: "opposition-response-workspace",
        body: { action: "get", taskId },
      });

      return json({ success: true, packageVersion: PACKAGE_VERSION, runId: run.id, workspace: refreshed.workspace });
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
    console.error("[opposition-response-analyze]", error);
    return json({ success: false, packageVersion: PACKAGE_VERSION, error: error instanceof Error ? error.message : String(error) }, status);
  }
});
