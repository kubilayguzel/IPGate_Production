import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const PACKAGE_VERSION = "response-studio-1.0.1";
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

function object(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function lower(value: unknown) {
  return text(value).toLocaleLowerCase("tr-TR");
}

function isUrl(value: unknown) {
  return /^https?:\/\//i.test(text(value));
}

function normalizeDateOnly(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

async function sha256(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function assertInternalUser(req: Request, supabase: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Oturum bilgisi bulunamadı.");

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) throw new HttpError(401, "Geçersiz veya süresi dolmuş oturum.");

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id, role, disabled")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (profileError || !profile) throw new HttpError(403, "IP GATE kullanıcı profili bulunamadı.");
  if (profile.disabled) throw new HttpError(403, "Kullanıcı hesabı pasif.");
  if (!["user", "admin", "superadmin"].includes(String(profile.role ?? ""))) {
    throw new HttpError(403, "Bu çalışma alanına erişim yetkiniz bulunmuyor.");
  }

  return { id: authData.user.id, role: profile.role, token };
}

async function loadMarkSnapshot(supabase: ReturnType<typeof createClient>, ipRecordId: string) {
  const [recordRes, detailsRes, classesRes, applicantsRes] = await Promise.all([
    supabase.from("ip_records").select(`
      id, ip_type, origin, status, portfolio_status, record_owner_type,
      application_number, application_date, registration_number, registration_date,
      country_code, wipo_ir, aripo_ir
    `).eq("id", ipRecordId).maybeSingle(),
    supabase.from("ip_record_trademark_details").select(`
      brand_name, brand_type, brand_category, brand_image_url, description
    `).eq("ip_record_id", ipRecordId).maybeSingle(),
    supabase.from("ip_record_classes").select("class_no, items").eq("ip_record_id", ipRecordId).order("class_no"),
    supabase.from("ip_record_applicants").select("person_id, order_index").eq("ip_record_id", ipRecordId).order("order_index"),
  ]);

  if (recordRes.error || !recordRes.data) {
    throw new HttpError(422, `Portföy marka kaydı okunamadı: ${recordRes.error?.message ?? ipRecordId}`);
  }

  const personIds = (applicantsRes.data ?? []).map((x: any) => x.person_id).filter(Boolean);
  let persons: any[] = [];
  if (personIds.length) {
    const { data, error } = await supabase.from("persons").select("id, name, type, email").in("id", personIds);
    if (error) throw new Error(`Başvuru sahipleri okunamadı: ${error.message}`);
    persons = data ?? [];
  }

  const applicants = (applicantsRes.data ?? []).map((row: any) => {
    const p = persons.find((x: any) => String(x.id) === String(row.person_id));
    return {
      id: row.person_id,
      name: p?.name ?? "-",
      type: p?.type ?? null,
      email: p?.email ?? null,
      orderIndex: row.order_index ?? 0,
    };
  });

  return {
    id: recordRes.data.id,
    markText: detailsRes.data?.brand_name ?? "",
    markType: detailsRes.data?.brand_type ?? null,
    imageUrl: detailsRes.data?.brand_image_url ?? null,
    applicationNo: recordRes.data.application_number,
    applicationDate: recordRes.data.application_date,
    registrationNo: recordRes.data.registration_number,
    registrationDate: recordRes.data.registration_date,
    recordOwnerType: recordRes.data.record_owner_type,
    applicants,
    classes: (classesRes.data ?? []).map((c: any) => ({
      classNo: Number(c.class_no),
      items: Array.isArray(c.items) ? c.items : [],
    })),
  };
}

async function loadTask(supabase: ReturnType<typeof createClient>, taskId: string) {
  const { data, error } = await supabase.from("tasks").select(`
    id, title, description, task_type_id, status, ip_record_id, transaction_id,
    task_owner_id, assigned_to, details, official_due_date, operational_due_date,
    created_at, updated_at
  `).eq("id", taskId).maybeSingle();

  if (error) throw new Error(`Görev okunamadı: ${error.message}`);
  if (!data) throw new HttpError(404, "Görev bulunamadı.");
  if (String(data.task_type_id) !== RESPONSE_TASK_TYPE) {
    throw new HttpError(400, "Response Studio yalnız İtiraza Karşı Görüş (Task Type 38) için kullanılabilir.");
  }
  return data;
}

async function loadTransactionLineage(supabase: ReturnType<typeof createClient>, transactionId: string | null) {
  const result: any[] = [];
  const seen = new Set<string>();
  let currentId = text(transactionId);

  for (let depth = 0; currentId && depth < 15; depth += 1) {
    if (seen.has(currentId)) break;
    seen.add(currentId);

    const { data, error } = await supabase.from("transactions").select(`
      id, ip_record_id, transaction_type_id, transaction_hierarchy, parent_id,
      description, opposition_owner, transaction_date, details, created_at, updated_at
    `).eq("id", currentId).maybeSingle();

    if (error) throw new Error(`İşlem soy ağacı okunamadı: ${error.message}`);
    if (!data) break;
    result.push(data);
    currentId = text(data.parent_id);
  }

  return result;
}

function isYidkTransaction(tx: any) {
  const yidkSignals = new Set([
    "19",
    "trademark_reconsideration_of_publication_objection",
    "trademark_decision_objection",
  ]);
  const typeId = text(tx?.transaction_type_id || tx?.type);
  const desc = lower(tx?.description);
  return yidkSignals.has(typeId) || desc.includes("yeniden incelen") || desc.includes("yidk") || desc.includes("karara itiraz");
}

function detectProcedureStage(lineage: any[], taskDetails: Record<string, any>) {
  const explicit = text(taskDetails.procedure_stage || taskDetails.procedureStage);
  if (["publication_opposition", "yidk_appeal"].includes(explicit)) return explicit;

  const found = lineage.some((tx) => isYidkTransaction(tx));

  return found ? "yidk_appeal" : "publication_opposition";
}

function normalizeDocumentCandidate(candidate: any) {
  return {
    role: candidate.role,
    sourceUrl: text(candidate.sourceUrl),
    documentName: text(candidate.documentName) || candidate.role,
    transactionId: candidate.transactionId ? text(candidate.transactionId) : null,
    transactionDocumentId: candidate.transactionDocumentId ? text(candidate.transactionDocumentId) : null,
    sourceDesignation: candidate.sourceDesignation ? text(candidate.sourceDesignation) : null,
    sourceType: candidate.sourceType ? text(candidate.sourceType) : null,
    sourceDate: normalizeDateOnly(candidate.sourceDate),
    isCurrentStage: candidate.isCurrentStage !== false,
  };
}

function classifyDocumentName(name: unknown, designation: unknown, txDescription: unknown) {
  const haystack = lower([name, designation, txDescription].filter(Boolean).join(" "));

  if (haystack.includes("epats") && haystack.includes("itiraz")) return "epats_opposition";
  if (haystack.includes("itiraza karşı görüş") || haystack.includes("itiraza karsi gorus") || haystack.includes("itiraza_karsi_gorus")) return "previous_response";
  if (haystack.includes("kullanım ispat") || haystack.includes("kullanim ispat")) return "proof_of_use_evidence";
  if (haystack.includes("itiraz dilekçe") || haystack.includes("itiraz dilekce")) return "opposition_petition";
  if (haystack.includes("karar") && !haystack.includes("itiraz dilek")) return "office_decision";
  if (haystack.includes("resmi yaz") || haystack.includes("resmî yaz") || haystack.includes("teblig")) return "official_notice";
  return "other";
}

function relatedPdfRole(tx: any) {
  const txType = text(tx?.transaction_type_id || tx?.type);
  if (["31", "32", "33", "34", "35", "36"].includes(txType)) return "office_decision";
  if (txType === "itiraza_karsi_gorus_child") return "previous_response";
  const inferred = classifyDocumentName("", "", tx?.description);
  return inferred === "other" ? "official_notice" : inferred;
}

async function collectDocuments(
  supabase: ReturnType<typeof createClient>,
  responseCaseId: string,
  ipRecordId: string,
  lineage: any[],
  stage: string,
) {
  const candidates: any[] = [];
  const lineageIds = lineage.map((x) => text(x.id)).filter(Boolean);
  const lineageDepthById = new Map(lineage.map((x, index) => [String(x.id), index]));
  const yidkAnchorIndex = stage === "yidk_appeal"
    ? lineage.findIndex((tx) => isYidkTransaction(tx))
    : lineage.length - 1;
  const currentStageBoundary = stage === "yidk_appeal"
    ? (yidkAnchorIndex >= 0 ? yidkAnchorIndex : Math.min(2, Math.max(0, lineage.length - 1)))
    : lineage.length - 1;
  const belongsToCurrentStage = (transactionId: unknown) => {
    if (stage !== "yidk_appeal") return true;
    const depth = lineageDepthById.get(String(transactionId));
    return Number.isInteger(depth) && Number(depth) <= currentStageBoundary;
  };

  // 1) Explicit URLs embedded in transaction details are highest-confidence role hints.
  for (const tx of lineage) {
    const d = object(tx.details);
    const add = (role: string, url: unknown, label: string) => {
      if (!isUrl(url)) return;
      candidates.push(normalizeDocumentCandidate({
        role,
        sourceUrl: url,
        documentName: label,
        transactionId: tx.id,
        sourceDate: tx.transaction_date,
        isCurrentStage: belongsToCurrentStage(tx.id),
      }));
    };

    add(relatedPdfRole(tx), d.relatedPdfUrl || d.related_pdf_url, "İlişkili Resmî Belge");
    add("opposition_petition", d.oppositionPetitionFileUrl || d.opposition_petition_file_url, "Karşı Taraf İtiraz Dilekçesi");
    add("epats_opposition", d.oppositionEpatsPetitionFileUrl || d.opposition_epats_petition_file_url, "EPATS İtiraz Belgesi");
  }

  // 2) Documents attached to current lineage.
  if (lineageIds.length) {
    const { data, error } = await supabase.from("transaction_documents").select(`
      id, transaction_id, document_name, document_url, document_type, document_designation, uploaded_at
    `).in("transaction_id", lineageIds);
    if (error) throw new Error(`İşlem belgeleri okunamadı: ${error.message}`);

    for (const doc of data ?? []) {
      if (!isUrl(doc.document_url)) continue;
      const tx = lineage.find((x) => String(x.id) === String(doc.transaction_id));
      const role = classifyDocumentName(doc.document_name, doc.document_designation, tx?.description);
      candidates.push(normalizeDocumentCandidate({
        role,
        sourceUrl: doc.document_url,
        documentName: doc.document_name,
        transactionId: doc.transaction_id,
        transactionDocumentId: doc.id,
        sourceDesignation: doc.document_designation,
        sourceType: doc.document_type,
        sourceDate: tx?.transaction_date ?? null,
        isCurrentStage: belongsToCurrentStage(doc.transaction_id),
      }));
    }
  }

  // 3) YİDK continuity: retrieve earlier response and challenged Office decision from the same portfolio record.
  if (stage === "yidk_appeal") {
    const { data: allTx, error: txError } = await supabase.from("transactions").select(`
      id, transaction_type_id, description, transaction_date, details, created_at
    `).eq("ip_record_id", ipRecordId).order("transaction_date", { ascending: false });
    if (txError) throw new Error(`Geçmiş işlem zinciri okunamadı: ${txError.message}`);

    for (const tx of allTx ?? []) {
      const d = object(tx.details);
      const relatedUrl = d.relatedPdfUrl || d.related_pdf_url;
      if (!isUrl(relatedUrl)) continue;
      const role = relatedPdfRole(tx);
      if (!["previous_response", "office_decision", "proof_of_use_evidence"].includes(role)) continue;
      candidates.push(normalizeDocumentCandidate({
        role,
        sourceUrl: relatedUrl,
        documentName: text(tx.description) || "Geçmiş İlişkili Belge",
        transactionId: tx.id,
        sourceDate: tx.transaction_date,
        isCurrentStage: false,
      }));
    }

    const historyIds = (allTx ?? []).map((x: any) => text(x.id)).filter(Boolean);
    if (historyIds.length) {
      const { data: historyDocs, error: historyDocError } = await supabase.from("transaction_documents").select(`
        id, transaction_id, document_name, document_url, document_type, document_designation, uploaded_at
      `).in("transaction_id", historyIds);
      if (historyDocError) throw new Error(`Geçmiş işlem belgeleri okunamadı: ${historyDocError.message}`);

      for (const doc of historyDocs ?? []) {
        if (!isUrl(doc.document_url)) continue;
        const tx = (allTx ?? []).find((x: any) => String(x.id) === String(doc.transaction_id));
        let role = classifyDocumentName(doc.document_name, doc.document_designation, tx?.description);
        const txType = text(tx?.transaction_type_id);

        if (role === "other" && ["31", "32", "33", "34", "35", "36"].includes(txType)) {
          role = "office_decision";
        }

        if (!["previous_response", "office_decision", "proof_of_use_evidence"].includes(role)) continue;

        candidates.push(normalizeDocumentCandidate({
          role,
          sourceUrl: doc.document_url,
          documentName: doc.document_name,
          transactionId: doc.transaction_id,
          transactionDocumentId: doc.id,
          sourceDesignation: doc.document_designation,
          sourceType: doc.document_type,
          sourceDate: tx?.transaction_date ?? null,
          isCurrentStage: false,
        }));
      }
    }
  }

  // De-duplicate by URL, keeping the strongest role if repeated.
  const rolePriority: Record<string, number> = {
    epats_opposition: 100,
    opposition_petition: 90,
    official_notice: 80,
    office_decision: 70,
    previous_response: 60,
    proof_of_use_evidence: 50,
    other: 1,
  };

  const byUrl = new Map<string, any>();
  for (const candidate of candidates) {
    if (!candidate.sourceUrl) continue;
    const current = byUrl.get(candidate.sourceUrl);
    if (!current || (rolePriority[candidate.role] ?? 0) > (rolePriority[current.role] ?? 0)) {
      byUrl.set(candidate.sourceUrl, candidate);
    }
  }

  const finalCandidates = [...byUrl.values()];

  // We intentionally do not delete previously discovered source rows here.
  // Source URLs can contain characters that make a generated PostgREST `in` filter brittle,
  // and historical documents are legally useful for YİDK continuity. New canonical rows are
  // idempotently upserted below; stale rows can later be marked superseded by an explicit
  // document-management action instead of being silently deleted during workspace loading.

  // Recalculate active/current-stage membership on every load without deleting legal history.
  // Rows no longer discoverable are marked superseded so they cannot satisfy source-bundle
  // completeness or leak into AI input, while their audit trail remains available.
  const { error: resetStageError } = await supabase
    .from("opposition_response_documents")
    .update({ is_current_stage: false, extraction_status: "superseded" })
    .eq("response_case_id", responseCaseId);
  if (resetStageError) throw new Error(`Belge aşama durumu sıfırlanamadı: ${resetStageError.message}`);

  for (const candidate of finalCandidates) {
    const { error: upsertError } = await supabase.from("opposition_response_documents").upsert({
      response_case_id: responseCaseId,
      transaction_id: candidate.transactionId,
      transaction_document_id: candidate.transactionDocumentId,
      role: candidate.role,
      document_name: candidate.documentName,
      source_url: candidate.sourceUrl,
      source_designation: candidate.sourceDesignation,
      source_type: candidate.sourceType,
      source_date: candidate.sourceDate,
      is_required: false,
      is_current_stage: candidate.isCurrentStage,
      extraction_status: "pending",
    }, { onConflict: "response_case_id,role,source_url" });
    if (upsertError) throw new Error(`Response belgesi kaydedilemedi: ${upsertError.message}`);
  }

  const { data: stored, error: storedError } = await supabase.from("opposition_response_documents")
    .select("*")
    .eq("response_case_id", responseCaseId)
    .neq("extraction_status", "superseded")
    .order("created_at", { ascending: true });
  if (storedError) throw new Error(`Response belgeleri okunamadı: ${storedError.message}`);

  return stored ?? [];
}

function assessBundle(stage: string, documents: any[]) {
  const present = new Set((documents ?? []).map((x) => text(x.role)));
  const currentPresent = new Set((documents ?? [])
    .filter((x) => x.is_current_stage === true)
    .map((x) => text(x.role)));
  const required = stage === "yidk_appeal"
    ? ["official_notice", "opposition_petition", "epats_opposition", "office_decision"]
    : ["official_notice", "opposition_petition", "epats_opposition"];

  const missing = required.filter((role) => {
    if (stage === "yidk_appeal" && role === "office_decision") return !present.has(role);
    return !currentPresent.has(role);
  });
  const warnings: string[] = [];
  if (stage === "yidk_appeal" && !present.has("previous_response")) {
    warnings.push("Önceki itiraza karşı görüş belgesi bulunamadı; varsa dosyaya eklenmesi savunma devamlılığı için yararlıdır.");
  }

  return {
    complete: missing.length === 0,
    required,
    missing,
    warnings,
    status: missing.length ? "incomplete" : "complete",
  };
}

async function ensureCase(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  currentUserId: string,
) {
  const task = await loadTask(supabase, taskId);
  const details = object(task.details);
  const lineage = await loadTransactionLineage(supabase, task.transaction_id ?? null);
  const stage = detectProcedureStage(lineage, details);

  const ipRecordId = text(
    task.ip_record_id ||
    details.ip_record_id ||
    details.related_ip_record_id ||
    details.relatedIpRecordId,
  );
  if (!ipRecordId) throw new HttpError(422, "İtiraza karşı görüş işinin portföy marka kaydı tespit edilemedi.");

  const { data: existing, error: existingError } = await supabase
    .from("opposition_response_cases")
    .select("*")
    .eq("task_id", taskId)
    .maybeSingle();
  if (existingError) throw new Error(`Response Case okunamadı: ${existingError.message}`);

  let responseCase = existing;
  if (!responseCase) {
    const { data: created, error } = await supabase.from("opposition_response_cases").insert({
      task_id: taskId,
      transaction_id: task.transaction_id ?? null,
      ip_record_id: ipRecordId,
      client_id: task.task_owner_id ?? null,
      procedure_stage: stage,
      proof_of_use_requested: false,
      created_by: currentUserId,
      updated_by: currentUserId,
      procedural_history: {
        detectedFrom: "transaction_lineage",
        lineageTransactionIds: lineage.map((x) => x.id),
      },
    }).select("*").single();
    if (error) throw new Error(`Response Case oluşturulamadı: ${error.message}`);
    responseCase = created;
  } else {
    const patch: any = {
      transaction_id: task.transaction_id ?? responseCase.transaction_id,
      ip_record_id: ipRecordId,
      client_id: task.task_owner_id ?? responseCase.client_id,
      procedure_stage: stage,
      updated_by: currentUserId,
    };
    if (stage === "yidk_appeal") patch.proof_of_use_requested = false;

    const { data: updated, error } = await supabase.from("opposition_response_cases")
      .update(patch).eq("id", responseCase.id).select("*").single();
    if (error) throw new Error(`Response Case güncellenemedi: ${error.message}`);
    responseCase = updated;
  }

  const applicant = await loadMarkSnapshot(supabase, ipRecordId);
  const documents = await collectDocuments(supabase, responseCase.id, ipRecordId, lineage, stage);
  const bundle = assessBundle(stage, documents);

  const sourceFingerprint = await sha256({
    taskId,
    stage,
    applicant: {
      id: applicant.id,
      applicationNo: applicant.applicationNo,
      applicationDate: applicant.applicationDate,
      applicants: applicant.applicants,
      classes: applicant.classes,
    },
    documents: documents.map((d: any) => ({
      id: d.id,
      role: d.role,
      url: d.source_url,
      date: d.source_date,
      currentStage: d.is_current_stage === true,
    })).sort((a: any, b: any) => `${a.role}|${a.url}`.localeCompare(`${b.role}|${b.url}`)),
  });

  const sourceChanged = Boolean(
    responseCase.source_fingerprint &&
    responseCase.source_fingerprint !== sourceFingerprint
  );

  if (sourceChanged) {
    // Preserve lawyer-added prior rights, but invalidate all AI-derived facts and downstream
    // work because the canonical source bundle or portfolio snapshot changed.
    const { error: stalePriorError } = await supabase
      .from("opposition_response_prior_marks")
      .delete()
      .eq("response_case_id", responseCase.id)
      .eq("source_kind", "ai");
    if (stalePriorError) throw new Error(`Stale AI mesnet hakları temizlenemedi: ${stalePriorError.message}`);

    const { error: staleClaimError } = await supabase
      .from("opposition_response_claims")
      .delete()
      .eq("response_case_id", responseCase.id);
    if (staleClaimError) throw new Error(`Stale iddia haritası temizlenemedi: ${staleClaimError.message}`);
  }

  const partySnapshot = {
    applicant: {
      source: "ip_gate_portfolio",
      applicants: applicant.applicants,
      applicationNo: applicant.applicationNo,
      markText: applicant.markText,
    },
    opponent: sourceChanged ? null : (responseCase.party_snapshot?.opponent ?? null),
  };

  const { data: finalCase, error: casePatchError } = await supabase.from("opposition_response_cases")
    .update({
      source_bundle_status: bundle.status,
      source_fingerprint: sourceFingerprint,
      party_snapshot: partySnapshot,
      ...(sourceChanged ? {
        extracted_case: {},
        procedural_history: {
          detectedFrom: "transaction_lineage",
          lineageTransactionIds: lineage.map((x) => x.id),
          invalidatedAt: new Date().toISOString(),
          invalidationReason: "source_fingerprint_changed",
        },
        analysis_fingerprint: null,
        current_reasoning: null,
        current_research_run_id: null,
        current_draft: null,
        current_draft_structured: null,
        qa_report: null,
      } : {}),
      status: !bundle.complete
        ? "blocked"
        : sourceChanged
        ? "source_review"
        : (["blocked", "source_review"].includes(String(responseCase.status)) ? "source_review" : responseCase.status),
      updated_by: currentUserId,
    })
    .eq("id", responseCase.id)
    .select("*")
    .single();
  if (casePatchError) throw new Error(`Source Bundle durumu kaydedilemedi: ${casePatchError.message}`);

  return { task, details, lineage, stage, applicant, documents, bundle, responseCase: finalCase };
}

async function buildWorkspace(supabase: ReturnType<typeof createClient>, taskId: string, currentUserId: string) {
  const ctx = await ensureCase(supabase, taskId, currentUserId);

  const [{ data: priorMarks, error: priorError }, { data: claims, error: claimsError }, { data: runs, error: runsError }] = await Promise.all([
    supabase.from("opposition_response_prior_marks").select("*").eq("response_case_id", ctx.responseCase.id).eq("is_active", true).order("created_at"),
    supabase.from("opposition_response_claims").select("*").eq("response_case_id", ctx.responseCase.id).eq("is_active", true).order("order_index"),
    supabase.from("opposition_response_runs").select("id, run_type, status, model, research_run_id, error_message, created_at, completed_at")
      .eq("response_case_id", ctx.responseCase.id).order("created_at", { ascending: false }).limit(15),
  ]);

  if (priorError) throw new Error(`Mesnet markalar okunamadı: ${priorError.message}`);
  if (claimsError) throw new Error(`İddia haritası okunamadı: ${claimsError.message}`);
  if (runsError) throw new Error(`Run geçmişi okunamadı: ${runsError.message}`);

  return {
    packageVersion: PACKAGE_VERSION,
    case: ctx.responseCase,
    task: {
      id: ctx.task.id,
      title: ctx.task.title,
      status: ctx.task.status,
      officialDueDate: ctx.task.official_due_date,
      operationalDueDate: ctx.task.operational_due_date,
    },
    procedureStage: ctx.stage,
    applicant: ctx.applicant,
    documents: ctx.documents,
    sourceBundle: ctx.bundle,
    priorMarks: priorMarks ?? [],
    claims: claims ?? [],
    runs: runs ?? [],
    capabilities: {
      proofOfUseInstruction: ctx.stage === "publication_opposition",
      yidkContinuity: ctx.stage === "yidk_appeal",
      canAnalyze: ctx.bundle.complete,
      canDraft: ctx.bundle.complete && (claims ?? []).length > 0,
    },
  };
}

async function saveLawyerSettings(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  currentUserId: string,
  payload: any,
) {
  const ctx = await ensureCase(supabase, taskId, currentUserId);
  const lawyerFindings = object(payload?.lawyerFindings);
  const requested = payload?.proofOfUseRequested === true;

  if (ctx.stage === "yidk_appeal" && requested) {
    throw new HttpError(422, "YİDK karşı görüş aşamasında yeni kullanım ispatı talebi oluşturulamaz.");
  }

  const { error } = await supabase.from("opposition_response_cases").update({
    lawyer_findings: lawyerFindings,
    proof_of_use_requested: ctx.stage === "publication_opposition" ? requested : false,
    analysis_fingerprint: null,
    current_reasoning: null,
    current_research_run_id: null,
    current_draft: null,
    current_draft_structured: null,
    qa_report: null,
    status: "extracted",
    updated_by: currentUserId,
  }).eq("id", ctx.responseCase.id);
  if (error) throw new Error(`Avukat bulguları kaydedilemedi: ${error.message}`);

  return await buildWorkspace(supabase, taskId, currentUserId);
}

async function addLawyerPriorMark(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  currentUserId: string,
  payload: any,
) {
  const ctx = await ensureCase(supabase, taskId, currentUserId);
  const applicationNo = text(payload?.applicationNo);
  const registrationNo = text(payload?.registrationNo);
  const markText = text(payload?.markText);

  if (!applicationNo && !registrationNo && !markText) {
    throw new HttpError(422, "Avukat tarafından mesnet marka eklemek için en az marka adı veya sicil numarası gerekir.");
  }

  const { error } = await supabase.from("opposition_response_prior_marks").insert({
    response_case_id: ctx.responseCase.id,
    source_kind: "lawyer",
    mark_text: markText || null,
    application_no: applicationNo || null,
    registration_no: registrationNo || null,
    international_registration_no: text(payload?.internationalRegistrationNo) || null,
    owner_name: text(payload?.ownerName) || null,
    legal_grounds: Array.isArray(payload?.legalGrounds) ? payload.legalGrounds.map(String) : [],
    relied_scope: Array.isArray(payload?.reliedScope) ? payload.reliedScope : [],
    provenance: [{ source: "lawyer_addition", userId: currentUserId, at: new Date().toISOString() }],
    identity_resolution_status: "lawyer_added",
    registry_resolution_status: "not_checked",
    created_by: currentUserId,
  });
  if (error) throw new Error(`Mesnet marka eklenemedi: ${error.message}`);

  const { error: invalidateError } = await supabase.from("opposition_response_cases").update({
    analysis_fingerprint: null,
    current_reasoning: null,
    current_research_run_id: null,
    current_draft: null,
    current_draft_structured: null,
    qa_report: null,
    status: "extracted",
    updated_by: currentUserId,
  }).eq("id", ctx.responseCase.id);
  if (invalidateError) throw new Error(`Mesnet marka değişikliği sonrası analiz sıfırlanamadı: ${invalidateError.message}`);

  return await buildWorkspace(supabase, taskId, currentUserId);
}

async function deactivatePriorMark(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
  currentUserId: string,
  payload: any,
) {
  const ctx = await ensureCase(supabase, taskId, currentUserId);
  const priorMarkId = text(payload?.priorMarkId);
  if (!priorMarkId) throw new HttpError(400, "priorMarkId zorunludur.");

  const { error } = await supabase.from("opposition_response_prior_marks")
    .update({ is_active: false })
    .eq("id", priorMarkId)
    .eq("response_case_id", ctx.responseCase.id);
  if (error) throw new Error(`Mesnet marka devre dışı bırakılamadı: ${error.message}`);

  const { error: invalidateError } = await supabase.from("opposition_response_cases").update({
    analysis_fingerprint: null,
    current_reasoning: null,
    current_research_run_id: null,
    current_draft: null,
    current_draft_structured: null,
    qa_report: null,
    status: "extracted",
    updated_by: currentUserId,
  }).eq("id", ctx.responseCase.id);
  if (invalidateError) throw new Error(`Mesnet marka değişikliği sonrası analiz sıfırlanamadı: ${invalidateError.message}`);

  return await buildWorkspace(supabase, taskId, currentUserId);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const currentUser = await assertInternalUser(req, supabase);
    const body = await req.json().catch(() => ({}));
    const action = text(body.action || "get");
    const taskId = text(body.taskId);
    if (!taskId) throw new HttpError(400, "taskId zorunludur.");

    let workspace: any;
    if (action === "get") {
      workspace = await buildWorkspace(supabase, taskId, currentUser.id);
    } else if (action === "save-lawyer-settings") {
      workspace = await saveLawyerSettings(supabase, taskId, currentUser.id, body.payload ?? {});
    } else if (action === "add-prior-mark") {
      workspace = await addLawyerPriorMark(supabase, taskId, currentUser.id, body.payload ?? {});
    } else if (action === "deactivate-prior-mark") {
      workspace = await deactivatePriorMark(supabase, taskId, currentUser.id, body.payload ?? {});
    } else {
      throw new HttpError(400, "Geçersiz action.");
    }

    return json({ success: true, workspace });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    console.error("[opposition-response-workspace]", error);
    return json({ success: false, error: error instanceof Error ? error.message : String(error) }, status);
  }
});
