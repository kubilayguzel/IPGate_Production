import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const PACKAGE_VERSION = "response-studio-1.0.0";
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

function arr(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function variants(value: unknown) {
  const raw = text(value);
  if (!raw) return [];

  const compactSpaces = raw.replace(/\s+/g, "");
  const slash = compactSpaces.replace(/-/g, "/");
  const dash = compactSpaces.replace(/\//g, "-");

  return [...new Set([raw, compactSpaces, slash, dash].filter(Boolean))];
}

async function assertInternalUser(req: Request, supabase: ReturnType<typeof createClient>) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Oturum bilgisi bulunamadı.");

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) throw new HttpError(401, "Geçersiz oturum.");

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id, role, disabled")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (profileError || !profile || profile.disabled) {
    throw new HttpError(403, "IP GATE kullanıcı profili bulunamadı veya pasif.");
  }

  if (!["user", "admin", "superadmin"].includes(String(profile.role ?? ""))) {
    throw new HttpError(403, "Bu çalışma alanına erişim yetkiniz bulunmuyor.");
  }

  return { id: authData.user.id };
}

async function findIpRecord(supabase: ReturnType<typeof createClient>, mark: any) {
  const searches = [
    { field: "application_number", values: variants(mark.application_no) },
    { field: "registration_number", values: variants(mark.registration_no) },
    { field: "wipo_ir", values: variants(mark.international_registration_no) },
    { field: "aripo_ir", values: variants(mark.international_registration_no) },
  ];

  for (const search of searches) {
    if (!search.values.length) continue;

    const { data, error } = await supabase
      .from("ip_records")
      .select(`
        id, ip_type, record_owner_type, application_number, application_date,
        registration_number, registration_date, wipo_ir, aripo_ir
      `)
      .eq("ip_type", "trademark")
      .in(search.field, search.values)
      .limit(10);

    if (error) throw new Error(`Mesnet marka sicil eşleştirmesi okunamadı: ${error.message}`);
    if (!data?.length) continue;

    // Opponent rights are normally third-party records; prefer those if duplicates exist.
    const selected = data.find((row: any) => String(row.record_owner_type) === "third_party") ?? data[0];
    return selected;
  }

  return null;
}

async function loadRegisteredScope(supabase: ReturnType<typeof createClient>, ipRecordId: string) {
  const { data, error } = await supabase
    .from("ip_record_classes")
    .select("class_no, items")
    .eq("ip_record_id", ipRecordId)
    .order("class_no", { ascending: true });

  if (error) throw new Error(`Mesnet markanın gerçek mal/hizmet kapsamı okunamadı: ${error.message}`);

  return (data ?? []).map((row: any) => ({
    classNo: Number(row.class_no),
    items: Array.isArray(row.items) ? row.items : [],
  }));
}

async function resolveAll(
  supabase: ReturnType<typeof createClient>,
  taskId: string,
) {
  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, task_type_id")
    .eq("id", taskId)
    .maybeSingle();

  if (taskError) throw new Error(`Görev okunamadı: ${taskError.message}`);
  if (!task) throw new HttpError(404, "Görev bulunamadı.");
  if (String(task.task_type_id) !== RESPONSE_TASK_TYPE) {
    throw new HttpError(400, "Prior Right Resolver yalnız Task Type 38 için kullanılabilir.");
  }

  const { data: responseCase, error: caseError } = await supabase
    .from("opposition_response_cases")
    .select("id")
    .eq("task_id", taskId)
    .maybeSingle();

  if (caseError) throw new Error(`Response Case okunamadı: ${caseError.message}`);
  if (!responseCase) throw new HttpError(422, "Önce Response Studio çalışma alanı oluşturulmalıdır.");

  const { data: marks, error: markError } = await supabase
    .from("opposition_response_prior_marks")
    .select("*")
    .eq("response_case_id", responseCase.id)
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (markError) throw new Error(`Mesnet markalar okunamadı: ${markError.message}`);

  const results: any[] = [];

  for (const mark of marks ?? []) {
    const record = await findIpRecord(supabase, mark);

    if (!record) {
      const { error } = await supabase
        .from("opposition_response_prior_marks")
        .update({
          registry_ip_record_id: null,
          registry_resolution_status: "not_found",
        })
        .eq("id", mark.id);

      if (error) throw new Error(`Mesnet marka çözüm durumu kaydedilemedi: ${error.message}`);
      results.push({ priorMarkId: mark.id, status: "not_found" });
      continue;
    }

    const scope = await loadRegisteredScope(supabase, String(record.id));
    const status = scope.length ? "resolved" : "needs_review";

    const patch: Record<string, any> = {
      registry_ip_record_id: String(record.id),
      registry_resolution_status: status,
      identity_resolution_status: "resolved",
      registered_scope: scope,
    };

    // effective_scope is intentionally NOT populated here. It is reserved for a later
    // proof-of-use evidence review. For ordinary comparison, the opponent's relied_scope
    // remains controlling; registered_scope verifies that the relied scope sits within a
    // real registered right and must never silently expand the opponent's filing.

    const { error } = await supabase
      .from("opposition_response_prior_marks")
      .update(patch)
      .eq("id", mark.id);

    if (error) throw new Error(`Mesnet marka sicil kapsamı kaydedilemedi: ${error.message}`);

    results.push({
      priorMarkId: mark.id,
      status,
      registryIpRecordId: String(record.id),
      classCount: scope.length,
    });
  }

  return results;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    await assertInternalUser(req, supabase);
    const body = await req.json().catch(() => ({}));
    const taskId = text(body.taskId);
    if (!taskId) throw new HttpError(400, "taskId zorunludur.");

    const results = await resolveAll(supabase, taskId);
    return json({ success: true, packageVersion: PACKAGE_VERSION, results });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    console.error("[opposition-response-prior-rights]", error);
    return json({
      success: false,
      packageVersion: PACKAGE_VERSION,
      error: error instanceof Error ? error.message : String(error),
    }, status);
  }
});
