import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const PACKAGE_VERSION = "6.1.6";

const OPENAI_MODEL =
  Deno.env.get("LEGAL_PETITION_MODEL") ??
  "gpt-5.6-sol";

const DEFAULT_REASONING_EFFORT =
  Deno.env.get("LEGAL_PETITION_REASONING_EFFORT") ??
  "medium";

const MAX_OUTPUT_TOKENS = Math.max(
  8000,
  Math.min(
    24000,
    Number(
      Deno.env.get("LEGAL_PETITION_MAX_OUTPUT_TOKENS") ??
      "16000",
    ) || 16000,
  ),
);

const VALID_REASONING_EFFORTS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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
        "Content-Type":
          "application/json; charset=utf-8",
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
  return Array.isArray(value)
    ? value
    : [];
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

function uniqueStrings(value) {
  return [
    ...new Set(
      safeArray(value)
        .map(
          (item) =>
            String(item ?? "").trim(),
        )
        .filter(Boolean),
    ),
  ];
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n
    : 0;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(
      String(value ?? ""),
    );
}

async function sha256Hex(value) {
  const digest =
    await crypto.subtle.digest(
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
        byte
          .toString(16)
          .padStart(2, "0"),
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

  const supabase =
    createClient(
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
  } =
    await supabase.auth.getUser(token);

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
  } =
    await supabase
      .from("users")
      .select("id, role, disabled")
      .eq(
        "id",
        authData.user.id,
      )
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
      "Bu dilekçe çalışma alanına erişim yetkiniz bulunmuyor.",
    );
  }

  return {
    token,
    userId:
      authData.user.id,
    role:
      profile.role,
  };
}

async function loadReasoningRunForUser({
  supabase,
  reasoningRunId,
  auth,
}) {
  const {
    data: run,
    error,
  } =
    await supabase
      .from("legal_reasoning_runs")
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
      String(auth?.role ?? ""),
    );

  if (
    !isAdmin &&
    String(run?.created_by ?? "") !==
      String(auth?.userId ?? "")
  ) {
    throw new HttpError(
      403,
      "Bu reasoning run kaydına erişim yetkiniz yok.",
    );
  }

  if (!run?.memorandum) {
    throw new HttpError(
      422,
      "Reasoning run memorandum içermiyor.",
    );
  }

  return run;
}

async function loadDraftRunForUser({
  supabase,
  draftRunId,
  auth,
}) {
  const {
    data: run,
    error,
  } =
    await supabase
      .from(
        "legal_petition_draft_runs",
      )
      .select(`
        id,
        reasoning_run_id,
        research_run_id,
        task_id,
        opposition_case_id,
        package_version,
        status,
        model,
        reasoning_effort,
        reasoning_validation_final_pass,
        canonical_fingerprint,
        authority_pack_fingerprint,
        memorandum_fingerprint,
        input_sha256,
        canonical_snapshot,
        memorandum_snapshot,
        authority_pack_snapshot,
        structured_draft,
        petition,
        validation,
        openai_response_id,
        openai_status,
        service_tier,
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
        draftRunId,
      )
      .maybeSingle();

  if (
    error ||
    !run
  ) {
    throw new HttpError(
      404,
      `Petition draft run bulunamadı: ${
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
      String(auth?.role ?? ""),
    );

  if (
    !isAdmin &&
    String(run?.created_by ?? "") !==
      String(auth?.userId ?? "")
  ) {
    throw new HttpError(
      403,
      "Bu petition draft run kaydına erişim yetkiniz yok.",
    );
  }

  return run;
}

function compactAuthorityPack(pack) {
  return {
    packageVersion:
      pack?.packageVersion ??
      null,

    coverageScore:
      asNumber(
        pack?.coverageScore,
      ),

    requestedIssueTags:
      uniqueStrings(
        pack?.requestedIssueTags,
      ),

    propositions:
      safeArray(
        pack?.propositions,
      )
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
            jurisdiction:
              p?.jurisdiction ??
              null,
            citationLabel:
              p?.citationLabel ??
              p?.authorityTitle ??
              null,
            propositionText:
              normalizeText(
                p?.propositionText,
              ),
            holdingText:
              normalizeText(
                p?.holdingText,
              ),
            sourceLocator:
              p?.sourceLocator ??
              null,
            sourceUrl:
              p?.sourceUrl ??
              null,
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
          }),
        )
        .filter(
          (p) =>
            isUuid(
              p.propositionId,
            ),
        ),
  };
}

function usedMemoPropositionIds(memo) {
  const ids =
    new Set();

  for (
    const issue
    of safeArray(
      memo?.issues,
    )
  ) {
    for (
      const app
      of safeArray(
        issue
          ?.authorityApplications,
      )
    ) {
      if (
        isUuid(
          app?.propositionId,
        )
      ) {
        ids.add(
          String(
            app.propositionId,
          ),
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
    if (
      isUuid(
        item?.propositionId,
      )
    ) {
      ids.add(
        String(
          item.propositionId,
        ),
      );
    }
  }

  return [...ids];
}

function buildMemoUsageMap(memo) {
  const map =
    new Map();

  const add =
    (
      propositionId,
      issueTags,
    ) => {
      const id =
        String(
          propositionId ??
          "",
        );

      if (!isUuid(id)) {
        return;
      }

      if (!map.has(id)) {
        map.set(
          id,
          new Set(),
        );
      }

      const bucket =
        map.get(id);

      for (
        const tag
        of uniqueStrings(
          issueTags,
        )
      ) {
        bucket.add(tag);
      }
    };

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

    for (
      const app
      of safeArray(
        issue
          ?.authorityApplications,
      )
    ) {
      add(
        app?.propositionId,
        tag
          ? [tag]
          : [],
      );
    }
  }

  for (
    const item
    of safeArray(
      memo?.citationLedger,
    )
  ) {
    add(
      item?.propositionId,
      item?.usedForIssueTags,
    );
  }

  return map;
}

function buildDraftSchema({
  issueTags,
  propositionIds,
}) {
  const safeIssueTags =
    issueTags.length > 0
      ? issueTags
      : ["general"];

  const safePropIds =
    propositionIds.length > 0
      ? propositionIds
      : [
        "00000000-0000-0000-0000-000000000000",
      ];

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      draftingVersion: {
        type: "string",
      },

      overallStrategy: {
        type: "string",
      },

      sections: {
        type: "array",
        minItems: 4,
        maxItems: 7,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            heading: {
              type: "string",
            },

            issueTags: {
              type: "array",
              minItems: 1,
              items: {
                type: "string",
                enum:
                  safeIssueTags,
              },
            },

            paragraphs: {
              type: "array",
              minItems: 2,
              maxItems: 6,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  text: {
                    type: "string",
                  },

                  propositionIds: {
                    type: "array",
                    items: {
                      type: "string",
                      enum:
                        safePropIds,
                    },
                  },
                },
                required: [
                  "text",
                  "propositionIds",
                ],
              },
            },
          },
          required: [
            "heading",
            "issueTags",
            "paragraphs",
          ],
        },
      },

      finalBridge: {
        type: "string",
      },

      draftingWarnings: {
        type: "array",
        items: {
          type: "string",
        },
      },
    },

    required: [
      "draftingVersion",
      "overallStrategy",
      "sections",
      "finalBridge",
      "draftingWarnings",
    ],
  };
}

function buildSystemInstructions() {
  return `
Sen EVREKA'nın TÜRKPATENT yayıma itiraz dilekçelerini hazırlayan kıdemli marka vekili/hukukçususun.

GÖREV
Sana verilen CANONICAL CASE SNAPSHOT, AVUKAT KARAR AĞACI, VERIFIED AUTHORITY PACK ve SOL LEGAL REASONING MEMORANDUM üzerinden nihai dilekçe gövdesi üret.

Bu aşamada YENİ hukuk araştırması veya YENİ hukuki sonuç üretme.
Reasoning Memorandum, nihai metnin bağlayıcı hukukî yol haritasıdır.

DOSYA GERÇEĞİ HİYERARŞİSİ
1. Canonical case snapshot = bağlayıcı olgular.
2. Lawyer Decision Tree = bağlayıcı avukat bulguları.
3. Legal Reasoning Memorandum = bağlayıcı reasoning çerçevesi.
4. Verified Authority Pack = kullanılabilecek TEK authority evreni.

KESİN AUTHORITY KURALI
- Authority Pack dışında mahkeme/kurul/kılavuz/karar üretme.
- Karar numarası, ECLI, tarih, mahkeme adı veya kaynak adını paragraf text alanına YAZMA.
- Kaynak kullanımını yalnız propositionIds alanında göster.
- propositionIds yalnız reasoning memorandumda kullanılmış ve sana izin verilen doğrulanmış proposition ID'lerden seçilebilir.
- Dilekçe içindeki görünür citation metni sistem tarafından deterministik olarak eklenecek.
- Authority Pack içinde aynı temel mesele için Kılavuz + verified Yargıtay/Türk içtihadı + verified CJEU/General Court katmanları varsa, reasoning memorandumun kullanımını izleyerek bu katmanları dilekçeye dengeli biçimde taşı.
- Her paragrafı üç kaynakla doldurma. Ama Yargıtay proposition mevcut ve memo tarafından kullanılmışsa, yalnız Kılavuz + AB citation'larıyla Türk yargısal katmanı sessizce düşürme.
- verifiedQuote/quoteSafe alanı ileride deterministik alıntı yüzeyi için saklanır; model kendi başına doğrudan alıntı üretmesin.

BAĞLAYICI AVUKAT KURALLARI
- Avukatın işaret, mal/hizmet, tüketici, global sonuç ve ret kapsamı bulgularını tersine çevirme.
- Ortak unsurun ağırlığını avukat bulgusundan daha yüksek kurma.
- Eksik olguyu tamamlama veya varsayma.
- Reasoning Memorandum içindeki factualLimitations, unresolvedQuestions ve prohibitedOrUnsupportedClaims sınırlarını aşma.

Z-ŞARJ DOSYASI GİBİ DOSYALARDA ÖZEL ANTI-OVERREACH
- Ortak tek harf otomatik olarak baskın, asli, çekirdek veya yüksek ayırt edici değildir.
- Tek harf otomatik olarak güçlü veya zayıf değildir.
- Fizikî mal ile 35. sınıf perakendecilik hizmetini aynı doğa/nitelik/mahiyet olarak yazma.
- Goods↔retail ilişkisini yalnız memo ve verified proposition'ın izin verdiği ölçüde; tamamlayıcılık, kanallar, tüketici ve ticari kaynak algısı üzerinden tartış.
- Tamamlayıcılığı dosya bulgusundan daha güçlü hale getirme.
- Interdependence'i otomatik telafi kuralına dönüştürme.
- Salt çağrışımı association için yeterli sayma.
- Seri marka/marka ailesi/tanınmışlık/kötü niyet argümanı kurma.
- "seri marka" veya "marka ailesi" terimlerini, bunları reddetmek amacıyla dahi görünür dilekçe metnine yazma. Gerekirse "bu yönde bağımsız bir iddia ileri sürülmemektedir" gibi nötr bir ifade kullan.
- SMK 6/5 veya SMK 6/9'a geçme.

YAZIM STANDARDI
- Türkçe.
- TÜRKPATENT'e sunulabilecek profesyonel, akıcı, tartışmalı ve ikna edici hukuk dili.
- Genel ders kitabı anlatımı yapma.
- Her bölüm mümkün olduğunca:
  hukuki ölçüt → authority desteği → somut olaya uygulama → ara sonuç
  zincirini izlesin.
- Gereksiz tekrar yapma.
- Avukatın zayıf/sınırda bulduğu noktayı "kesin" veya "çok güçlü" hale getirme.
- Karşı argüman ancak memo içinde gerçekten kurulmuşsa ele al.
- Metin dilekçe gövdesidir; antet, taraf tablosu veya ayrı "SONUÇ VE TALEP" bölümü üretme.
- "AÇIKLAMALARIMIZ VE HUKUKİ GEREKÇELER" başlığını JSON text alanlarında tekrar etme; sistem deterministik ekleyecek.
- İç sistem kodu, UUID, [S#], ⟦S#⟧, K# veya benzeri marker'ları görünür metne yazma.

BÖLÜM MANTIĞI
Dosyaya göre 4-7 bölüm kullan.
Başlıklar kısa ve hukukî olsun.
Mümkün olduğunda şu eksenleri uygun biçimde grupla:
- SMK 6/1 çerçevesi ve önceki hak
- işaretlerin bütünsel karşılaştırılması
- ortak unsur / tek harf / ek unsurlar
- mal ve hizmet ilişkisi
- ilgili tüketici
- global karıştırılma ve ilişkilendirilme ihtimali

SON
finalBridge alanı ayrı bir "Sonuç ve Talep" değildir.
Yalnız açıklamalar bölümünü ret kapsamına bağlayan 1 kısa kapanış paragrafıdır.
`.trim();
}

function buildUserPrompt({
  canonical,
  memorandum,
  authorityPack,
  allowedPropositionIds,
}) {
  return `
CANONICAL CASE SNAPSHOT
${JSON.stringify(canonical)}

SOL LEGAL REASONING MEMORANDUM
${JSON.stringify(memorandum)}

VERIFIED AUTHORITY PACK
${JSON.stringify(authorityPack)}

DRAFTING İÇİN İZİN VERİLEN propositionIds
${JSON.stringify(allowedPropositionIds)}

FINAL TALİMAT
Reasoning Memorandum'un hukukî sonucunu ve ölçülülüğünü koruyarak filing-ready dilekçe gövdesi üret.
Authority adlarını paragraf text'ine yazma; yalnız propositionIds kullan.
`.trim();
}

async function startOpenAiDraftBackground({
  apiKey,
  model,
  reasoningEffort,
  safetyIdentifier,
  schema,
  canonical,
  memorandum,
  authorityPack,
  allowedPropositionIds,
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
              buildUserPrompt({
                canonical,
                memorandum,
                authorityPack,
                allowedPropositionIds,
              }),
          },
        ],
      },
    ],

    reasoning: {
      effort:
        reasoningEffort,
    },

    text: {
      verbosity: "high",
      format: {
        type: "json_schema",
        name:
          "evreka_final_petition_draft",
        strict: true,
        schema,
      },
    },

    max_output_tokens:
      MAX_OUTPUT_TOKENS,

    truncation:
      "disabled",

    prompt_cache_key:
      "evreka-final-petition-6.1.6",

    safety_identifier:
      safetyIdentifier,

    metadata: {
      package_version:
        PACKAGE_VERSION,
      workload:
        "trademark_opposition_final_draft",
    },
  };

  const response =
    await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Authorization":
            `Bearer ${apiKey}`,
          "Content-Type":
            "application/json",
        },
        body:
          JSON.stringify(body),
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
  const response =
    await fetch(
      `https://api.openai.com/v1/responses/${
        encodeURIComponent(
          responseId,
        )
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

function extractStructuredDraft(
  openAiResponse,
) {
  if (
    openAiResponse?.status !==
    "completed"
  ) {
    throw new Error(
      `OpenAI response tamamlanmadı: ${
        openAiResponse?.status ??
        "unknown"
      }`,
    );
  }

  let outputText =
    typeof openAiResponse
      ?.output_text === "string"
      ? openAiResponse.output_text
      : "";

  if (!outputText) {
    outputText =
      safeArray(
        openAiResponse?.output,
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
      "OpenAI boş structured draft döndürdü.",
    );
  }

  try {
    return JSON.parse(
      outputText,
    );
  } catch (error) {
    throw new Error(
      `OpenAI structured draft parse hatası: ${
        error?.message ??
        String(error)
      }`,
    );
  }
}

function propositionMap(pack) {
  const map =
    new Map();

  for (
    const p
    of safeArray(
      pack?.propositions,
    )
  ) {
    const id =
      String(
        p?.propositionId ??
        "",
      );

    if (isUuid(id)) {
      map.set(id, p);
    }
  }

  return map;
}

function cleanGuidelineLocator(
  citationLabel,
  sourceLocator,
) {
  const base =
    normalizeText(
      citationLabel ||
      "TÜRKPATENT, Marka İnceleme Kılavuzu (2021)",
    );

  const locator =
    normalizeText(
      sourceLocator,
    );

  if (!locator) {
    return base;
  }

  const pageMatch =
    locator.match(
      /\bs\.\s*(\d{1,4}(?:\s*[-–]\s*\d{1,4})?)/i,
    );

  const page =
    pageMatch
      ? `s. ${pageMatch[1].replace(/\s+/g, "")}`
      : "";

  let section = "";

  if (pageMatch) {
    const afterPage =
      locator
        .slice(
          (pageMatch.index ?? 0) +
          pageMatch[0].length,
        )
        .replace(
          /^[,;:\s–-]+/,
          "",
        )
        .trim();

    const looksLikeDate =
      /^\d{1,2}\.\d{1,2}\.\d{4}\b/u.test(
        afterPage,
      );

    const looksLikeSourceProse =
      /\b(?:tarih|sayılı|kararında|kararı)\b/i.test(
        afterPage,
      );

    if (
      /^\d+(?:\.\d+){0,5}\s+\S+/u.test(
        afterPage,
      ) &&
      !looksLikeDate &&
      !looksLikeSourceProse
    ) {
      section =
        afterPage
          .split(
            /\s*[|;]\s*/,
          )[0]
          .slice(0, 180)
          .trim();
    }
  }

  return [
    base,
    page,
    section,
  ]
    .filter(Boolean)
    .join(", ");
}

function citationLabelFor(
  proposition,
) {
  const citationLabel =
    normalizeText(
      proposition?.citationLabel,
    );

  const sourceLocator =
    normalizeText(
      proposition?.sourceLocator,
    );

  const guidelineLike =
    /türkpatent|marka inceleme kılavuzu/i.test(
      `${citationLabel} ${sourceLocator}`,
    );

  if (guidelineLike) {
    return cleanGuidelineLocator(
      citationLabel,
      sourceLocator,
    );
  }

  return (
    citationLabel ||
    sourceLocator
  );
}

function renderPetition({
  structuredDraft,
  authorityPack,
}) {
  const pMap =
    propositionMap(
      authorityPack,
    );

  const lines = [
    "AÇIKLAMALARIMIZ VE HUKUKİ GEREKÇELER",
    "",
  ];

  for (
    const section
    of safeArray(
      structuredDraft?.sections,
    )
  ) {
    const heading =
      normalizeText(
        section?.heading,
      );

    if (heading) {
      lines.push(
        heading,
        "",
      );
    }

    let previousCitationKey = "";

    for (
      const paragraph
      of safeArray(
        section?.paragraphs,
      )
    ) {
      let paragraphText =
        normalizeText(
          paragraph?.text,
        );

      const labels = [];

      for (
        const id
        of uniqueStrings(
          paragraph?.propositionIds,
        )
      ) {
        const proposition =
          pMap.get(id);

        if (!proposition) {
          continue;
        }

        const label =
          citationLabelFor(
            proposition,
          );

        if (
          label &&
          !labels.includes(label)
        ) {
          labels.push(label);
        }
      }

      const citationKey =
        labels
          .slice()
          .sort()
          .join("||");

      const shouldRenderCitation =
        Boolean(
          paragraphText &&
          labels.length > 0 &&
          citationKey !==
            previousCitationKey,
        );

      if (
        shouldRenderCitation
      ) {
        paragraphText =
          `${paragraphText} (${labels.join("; ")})`;
      }

      if (paragraphText) {
        lines.push(
          paragraphText,
          "",
        );
      }

      previousCitationKey =
        citationKey;
    }
  }

  const finalBridge =
    normalizeText(
      structuredDraft?.finalBridge,
    );

  if (finalBridge) {
    lines.push(
      finalBridge,
      "",
    );
  }

  return lines
    .join("\n")
    .replace(
      /\n{3,}/g,
      "\n\n",
    )
    .trim();
}
function findRawAuthorityIdentifiers(
  structuredDraft,
) {
  const text =
    JSON.stringify(
      structuredDraft,
    );

  const refs = [];

  const patterns = [
    /\b[CT]-\d{1,5}\/\d{2,4}(?:\s*P)?\b/gi,
    /\bECLI:[A-Z0-9:.-]+\b/gi,
    /\bE\.\s*\d{4}\/\d+\b/gi,
    /\bK\.\s*\d{4}\/\d+\b/gi,
  ];

  for (
    const pattern
    of patterns
  ) {
    for (
      const match
      of text.matchAll(pattern)
    ) {
      refs.push(
        String(
          match?.[0] ??
          "",
        ),
      );
    }
  }

  return [
    ...new Set(
      refs.filter(Boolean),
    ),
  ];
}


function filingSentences(
  value,
) {
  return String(
    value ?? "",
  )
    .split(
      /(?<=[.!?])\s+|\n+/u,
    )
    .map(
      (item) =>
        normalizeText(item),
    )
    .filter(Boolean);
}

function sentenceContainsNegation(
  sentence,
) {
  const text =
    normalizeComparable(
      sentence,
    );

  return (
    /(?:^|\s)(?:değil\w*|yok\w*|bulunma(?:maktadır|mıştır|mış|dığ\w*)|dayandırılma(?:malı|malıdır|malıydı)\w*|ileri\s+sürülme(?:meli|miştir|miş|mektedir)\w*|kabul\s+edilme(?:meli|miştir|miş)\w*|varsayılma(?:malı|mıştır|mış)\w*|söylenme(?:meli|miştir|miş)\w*|oluşturma(?:z|maktadır)\w*|yetme(?:z|mektedir)\w*|yeterli\s+(?:değil\w*|olma(?:z|maktadır)\w*)|gösterilme(?:miş|miştir|mektedir)\w*|dayanma(?:z|maktadır)\w*|iddia\s+edilme(?:mektedir|miştir|miş)\w*)(?:$|\s|[.,;:])/iu.test(
      text,
    )
  );
}

function hasAssertiveForbiddenConcept(
  text,
  conceptPattern,
) {
  for (
    const sentence
    of filingSentences(text)
  ) {
    if (
      !conceptPattern.test(
        sentence,
      )
    ) {
      continue;
    }

    if (
      sentenceContainsNegation(
        sentence,
      )
    ) {
      continue;
    }

    return true;
  }

  return false;
}

function hasPositiveGoodsRetailNatureClaim(
  text,
) {
  for (
    const sentence
    of filingSentences(text)
  ) {
    if (
      !/perakend/i.test(
        sentence,
      )
    ) {
      continue;
    }

    const natureBridge =
      /(?:aynı|benzer)\s+(?:bir\s+)?(?:doğa|nitelik|mahiyet)|(?:doğa|nitelik|mahiyet)(?:leri|ları)?\s+(?:aynı|benzer)/i.test(
        sentence,
      );

    if (
      natureBridge &&
      !sentenceContainsNegation(
        sentence,
      )
    ) {
      return sentence;
    }
  }

  return "";
}

function hasUnsupportedStrongComplementarity(
  text,
) {
  for (
    const sentence
    of filingSentences(text)
  ) {
    if (
      /\b(?:güçlü|yüksek|çok\s+güçlü)\s+tamamlayıc/i.test(
        sentence,
      ) &&
      !sentenceContainsNegation(
        sentence,
      )
    ) {
      return sentence;
    }
  }

  return "";
}

function validateStructuredDraft({
  structuredDraft,
  memorandum,
  authorityPack,
  allowedPropositionIds,
}) {
  const errors = [];
  const warnings = [];

  const sections =
    safeArray(
      structuredDraft?.sections,
    );

  if (
    sections.length < 4 ||
    sections.length > 7
  ) {
    errors.push(
      "Dilekçe 4-7 bölüm arasında olmalı.",
    );
  }

  const headings =
    sections
      .map(
        (section) =>
          normalizeComparable(
            section?.heading,
          ),
      )
      .filter(Boolean);

  if (
    new Set(headings).size !==
    headings.length
  ) {
    errors.push(
      "Tekrarlanan bölüm başlığı var.",
    );
  }

  const allowed =
    new Set(
      allowedPropositionIds,
    );

  const pMap =
    propositionMap(
      authorityPack,
    );

  const memoUsage =
    buildMemoUsageMap(
      memorandum,
    );

  const usedIds = [];

  for (
    const section
    of sections
  ) {
    const sectionTags =
      uniqueStrings(
        section?.issueTags,
      );

    if (
      sectionTags.length === 0
    ) {
      errors.push(
        `Bölüm issueTags boş: ${
          normalizeText(
            section?.heading,
          )
        }`,
      );
    }

    const paragraphs =
      safeArray(
        section?.paragraphs,
      );

    if (
      paragraphs.length < 2
    ) {
      errors.push(
        `Bölüm en az 2 paragraf içermeli: ${
          normalizeText(
            section?.heading,
          )
        }`,
      );
    }

    for (
      const paragraph
      of paragraphs
    ) {
      const paragraphText =
        normalizeText(
          paragraph?.text,
        );

      if (!paragraphText) {
        errors.push(
          "Boş dilekçe paragrafı bulundu.",
        );
      }

      for (
        const id
        of uniqueStrings(
          paragraph
            ?.propositionIds,
        )
      ) {
        usedIds.push(id);

        if (!allowed.has(id)) {
          errors.push(
            `Reasoning Memorandum dışında propositionId kullanıldı: ${id}`,
          );
          continue;
        }

        const p =
          pMap.get(id);

        if (!p) {
          errors.push(
            `Authority Pack dışında propositionId kullanıldı: ${id}`,
          );
          continue;
        }

        const doNotUseFor =
          uniqueStrings(
            p?.doNotUseFor,
          );

        if (
          sectionTags.some(
            (tag) =>
              doNotUseFor.includes(tag),
          )
        ) {
          errors.push(
            `${id} proposition bu bölüm issueTag'i için doNotUseFor kapsamında.`,
          );
        }

        const memoTags =
          memoUsage.get(id);

        if (
          memoTags &&
          memoTags.size > 0 &&
          !sectionTags.some(
            (tag) =>
              memoTags.has(tag),
          )
        ) {
          // Proposition remains globally authorized by the reasoning memorandum
          // and verified Authority Pack. Section movement is structural only.
          // doNotUseFor remains a hard blocker above.
          warnings.push(
            `${id} proposition reasoning memorandumdaki issue kullanımından farklı bir dilekçe bölümünde kullanıldı; verified/doNotUseFor kontrolü geçti.`,
          );
        }
      }
    }
  }

  const visibleModelText =
    [
      ...sections.flatMap(
        (section) =>
          safeArray(
            section?.paragraphs,
          )
            .map(
              (paragraph) =>
                normalizeText(
                  paragraph?.text,
                ),
            ),
      ),
      normalizeText(
        structuredDraft?.finalBridge,
      ),
    ]
      .filter(Boolean)
      .join("\n");

  if (
    /\[(?:S|K)\d{1,3}\]/i.test(
      visibleModelText,
    ) ||
    /⟦\s*S?\d{1,3}\s*⟧/i.test(
      visibleModelText,
    )
  ) {
    errors.push(
      "İç kaynak/QA marker'ı görünür dilekçe metnine sızdı.",
    );
  }

  if (
    /sonuç\s+ve\s+talep/i.test(
      visibleModelText,
    )
  ) {
    errors.push(
      "Bu katman ayrı SONUÇ VE TALEP bölümü üretmemeli.",
    );
  }

  if (
    /\bSMK\s*(?:m\.?\s*)?6\/(?:5|9)\b/i.test(
      visibleModelText,
    )
  ) {
    errors.push(
      "SMK 6/1 dışı hukuki gerekçe görünür metne girdi.",
    );
  }

  const forbiddenConcepts = [
    {
      label:
        "marka ailesi",
      pattern:
        /\bmarka\s+ailesi\b/i,
    },
    {
      label:
        "seri marka",
      pattern:
        /\bseri\s+marka\b/i,
    },
    {
      label:
        "tanınmış marka",
      pattern:
        /\btanınmış\s+marka\b/i,
    },
    {
      label:
        "kötü niyet",
      pattern:
        /\bkötü\s+niyet\b/i,
    },
  ];

  for (
    const item
    of forbiddenConcepts
  ) {
    if (
      hasAssertiveForbiddenConcept(
        visibleModelText,
        item.pattern,
      )
    ) {
      errors.push(
        `6.1.6 kapsamı dışı assertive argüman bulundu: ${item.label}.`,
      );
    }
  }

  const goodsRetailNatureClaim =
    hasPositiveGoodsRetailNatureClaim(
      visibleModelText,
    );

  if (goodsRetailNatureClaim) {
    errors.push(
      `Goods↔retail ilişkisinde pozitif nitelik/doğa aynılığı-benzerliği kuruldu: ${goodsRetailNatureClaim}`,
    );
  }

  const strongComplementarity =
    hasUnsupportedStrongComplementarity(
      visibleModelText,
    );

  if (strongComplementarity) {
    errors.push(
      `Dosya bulgusunu aşan güçlü tamamlayıcılık iddiası bulundu: ${strongComplementarity}`,
    );
  }

  const rawAuthorityIds =
    findRawAuthorityIdentifiers(
      structuredDraft,
    );

  if (
    rawAuthorityIds.length > 0
  ) {
    errors.push(
      `Authority kimliği model free-text alanına yazıldı: ${
        rawAuthorityIds.join(", ")
      }`,
    );
  }

  const finalBridge =
    normalizeText(
      structuredDraft?.finalBridge,
    );

  if (
    finalBridge.length < 40
  ) {
    warnings.push(
      "Final bridge çok kısa.",
    );
  }

  if (
    usedIds.length < 3
  ) {
    warnings.push(
      "Final draft yalnız çok az verified proposition kullandı.",
    );
  }

  const usedUniqueIds =
    [
      ...new Set(
        usedIds.filter(Boolean),
      ),
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
      [
        ...pMap.values(),
      ].map(layerOf),
    );

  const usedLayers =
    new Set(
      usedUniqueIds
        .map(
          (id) =>
            pMap.get(id),
        )
        .filter(Boolean)
        .map(layerOf),
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
      "Verified Yargıtay authority mevcut olduğu halde final dilekçede kullanılmadı.",
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
      "Verified AB authority mevcut olduğu halde final dilekçede kullanılmadı.",
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
      "Verified TÜRKPATENT Kılavuzu authority mevcut olduğu halde final dilekçede kullanılmadı.",
    );
  }

  const reasoningPass =
    memorandum &&
    typeof memorandum === "object"
      ? null
      : null;

  return {
    finalPass:
      errors.length === 0,
    errors,
    warnings,
    usedPropositionIds:
      [
        ...new Set(
          usedIds.filter(Boolean),
        ),
      ],
    checkedAt:
      new Date()
        .toISOString(),
  };
}

function validateRenderedPetition(
  petition,
) {
  const errors = [];
  const warnings = [];

  const text =
    String(
      petition ?? "",
    );

  if (
    !text.startsWith(
      "AÇIKLAMALARIMIZ VE HUKUKİ GEREKÇELER",
    )
  ) {
    errors.push(
      "Dilekçe zorunlu başlıkla başlamıyor.",
    );
  }

  if (
    /\[(?:S|K)\d{1,3}\]/i.test(
      text,
    ) ||
    /⟦[^⟧]*⟧/.test(text)
  ) {
    errors.push(
      "Rendered petition internal marker içeriyor.",
    );
  }

  if (
    /\bpropositionId\b/i.test(
      text,
    ) ||
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(
      text,
    )
  ) {
    errors.push(
      "Rendered petition internal proposition/UUID içeriyor.",
    );
  }

  if (
    /sonuç\s+ve\s+talep/i.test(
      text,
    )
  ) {
    errors.push(
      "Rendered petition ayrı SONUÇ VE TALEP bölümü içeriyor.",
    );
  }

  if (
    text.length < 2500
  ) {
    warnings.push(
      "Dilekçe gövdesi beklenenden kısa.",
    );
  }

  return {
    pass:
      errors.length === 0,
    errors,
    warnings,
    characterCount:
      text.length,
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
    ) /
    1_000_000;

  return Number(
    cost.toFixed(6),
  );
}

async function createDraftRun(
  supabase,
  payload,
) {
  const {
    data,
    error,
  } =
    await supabase
      .from(
        "legal_petition_draft_runs",
      )
      .insert(payload)
      .select("id")
      .single();

  if (
    error ||
    !data?.id
  ) {
    throw new Error(
      `Petition draft run oluşturulamadı: ${
        error?.message ??
        "id yok"
      }`,
    );
  }

  return data.id;
}

async function updateDraftRun(
  supabase,
  draftRunId,
  patch,
) {
  const {
    error,
  } =
    await supabase
      .from(
        "legal_petition_draft_runs",
      )
      .update(patch)
      .eq(
        "id",
        draftRunId,
      );

  if (error) {
    throw new Error(
      `Petition draft run güncellenemedi: ${
        error.message
      }`,
    );
  }
}

async function finalizeCompletedDraft({
  supabase,
  draftRunId,
  run,
  openAiResponse,
}) {
  const structuredDraft =
    extractStructuredDraft(
      openAiResponse,
    );

  const memorandum =
    safeObject(
      run?.memorandum_snapshot,
    );

  const authorityPack =
    safeObject(
      run
        ?.authority_pack_snapshot,
    );

  const allowedPropositionIds =
    usedMemoPropositionIds(
      memorandum,
    );

  const validation =
    validateStructuredDraft({
      structuredDraft,
      memorandum,
      authorityPack,
      allowedPropositionIds,
    });

  const petition =
    renderPetition({
      structuredDraft,
      authorityPack,
    });

  const renderedValidation =
    validateRenderedPetition(
      petition,
    );

  const finalValidation = {
    ...validation,
    rendered:
      renderedValidation,
    reasoningValidationFinalPass:
      run
        ?.reasoning_validation_final_pass ===
      true,
    finalPass:
      validation.finalPass &&
      renderedValidation.pass,
  };

  const usage =
    safeObject(
      openAiResponse?.usage,
    );

  const estimatedCostUsd =
    estimateOpenAiCost(
      usage,
    );

  const finalStatus =
    finalValidation.finalPass
      ? "completed"
      : "validation_failed";

  await updateDraftRun(
    supabase,
    draftRunId,
    {
      status:
        finalStatus,

      structured_draft:
        structuredDraft,

      petition,

      validation:
        finalValidation,

      openai_response_id:
        openAiResponse?.id ??
        run?.openai_response_id ??
        null,

      openai_status:
        openAiResponse?.status ??
        null,

      service_tier:
        openAiResponse?.service_tier ??
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
    structuredDraft,
    petition,
    validation:
      finalValidation,
    usage,
    estimatedCostUsd,
    serviceTier:
      openAiResponse?.service_tier ??
      null,
  };
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
      "draft",
    );

  if (
    action === "stats"
  ) {
    const {
      data,
      error,
    } =
      await supabase.rpc(
        "legal_petition_draft_stats",
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
      "draft",
      "status",
    ].includes(action)
  ) {
    return jsonResponse(
      {
        ok: false,
        packageVersion:
          PACKAGE_VERSION,
        error:
          "action: draft, status veya stats",
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
    const draftRunId =
      String(
        body?.draftRunId ??
        "",
      ).trim();

    if (!isUuid(draftRunId)) {
      return jsonResponse(
        {
          ok: false,
          packageVersion:
            PACKAGE_VERSION,
          error:
            "Geçerli draftRunId zorunludur.",
        },
        400,
      );
    }

    try {
      const run =
        await loadDraftRunForUser({
          supabase,
          draftRunId,
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
            draftRunId,
            reasoningRunId:
              run?.reasoning_run_id ??
              null,
            researchRunId:
              run?.research_run_id ??
              null,
            runStatus:
              run?.status ??
              null,
            openAiStatus:
              run?.openai_status ??
              null,
            model:
              run?.model ??
              null,
            reasoningEffort:
              run?.reasoning_effort ??
              null,
            reasoningValidationFinalPass:
              run
                ?.reasoning_validation_final_pass ===
              true,
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
            serviceTier:
              run?.service_tier ??
              null,
            structuredDraft:
              run?.structured_draft ??
              null,
            petition:
              run?.petition ??
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
            draftRunId,
            runStatus:
              "failed",
            openAiStatus:
              run?.openai_status ??
              null,
            error:
              run?.error_message ??
              "Petition draft run başarısız.",
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
          openAiResponse?.status ??
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
        await updateDraftRun(
          supabase,
          draftRunId,
          {
            openai_status:
              currentStatus,
            service_tier:
              openAiResponse
                ?.service_tier ??
              null,
          },
        );

        return jsonResponse(
          {
            ok: true,
            packageVersion:
              PACKAGE_VERSION,
            pending: true,
            draftRunId,
            reasoningRunId:
              run?.reasoning_run_id ??
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
          `OpenAI final draft terminal durum: ${
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

        await updateDraftRun(
          supabase,
          draftRunId,
          {
            status:
              "failed",
            openai_status:
              currentStatus,
            service_tier:
              openAiResponse
                ?.service_tier ??
              null,
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
            draftRunId,
            runStatus:
              "failed",
            openAiStatus:
              currentStatus,
            openAiError,
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
        await finalizeCompletedDraft({
          supabase,
          draftRunId,
          run,
          openAiResponse,
        });

      return jsonResponse(
        {
          ok: true,
          packageVersion:
            PACKAGE_VERSION,
          pending: false,
          draftRunId,
          reasoningRunId:
            run?.reasoning_run_id ??
            null,
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
          reasoningValidationFinalPass:
            run
              ?.reasoning_validation_final_pass ===
            true,
          serviceTier:
            final.serviceTier,
          validation:
            final.validation,
          usage:
            final.usage,
          estimatedCostUsd:
            final.estimatedCostUsd,
          structuredDraft:
            final.structuredDraft,
          petition:
            final.petition,
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
          draftRunId,
          error:
            error?.message ??
            String(error),
        },
        status,
      );
    }
  }

  let draftRunId = null;

  try {
    const reasoningRunId =
      String(
        body?.reasoningRunId ??
        "",
      ).trim();

    if (!isUuid(reasoningRunId)) {
      throw new HttpError(
        400,
        "Geçerli reasoningRunId zorunludur.",
      );
    }

    const reasoningRun =
      await loadReasoningRunForUser({
        supabase,
        reasoningRunId,
        auth,
      });

    const reasoningValidation =
      safeObject(
        reasoningRun?.validation,
      );

    const reasoningPass =
      reasoningValidation
        ?.finalPass === true;

    const allowReasoningWarnings =
      body
        ?.allowReasoningValidationWarnings ===
      true;

    if (
      !reasoningPass &&
      !allowReasoningWarnings
    ) {
      throw new HttpError(
        422,
        "Reasoning memorandum validation.finalPass=false. Lab/pilot için açıkça allowReasoningValidationWarnings=true verilmeden final draft başlatılmaz.",
      );
    }

    const canonical =
      safeObject(
        reasoningRun
          ?.canonical_snapshot,
      );

    const memorandum =
      safeObject(
        reasoningRun
          ?.memorandum,
      );

    const authorityPack =
      compactAuthorityPack(
        reasoningRun
          ?.authority_pack_snapshot,
      );

    if (
      Object.keys(
        memorandum,
      ).length === 0
    ) {
      throw new HttpError(
        422,
        "Reasoning memorandum boş.",
      );
    }

    if (
      authorityPack
        .propositions
        .length === 0
    ) {
      throw new HttpError(
        422,
        "Verified Authority Pack boş.",
      );
    }

    const allowedPropositionIds =
      usedMemoPropositionIds(
        memorandum,
      )
        .filter(
          (id) =>
            authorityPack
              .propositions
              .some(
                (p) =>
                  p.propositionId ===
                  id,
              ),
        );

    if (
      allowedPropositionIds.length ===
      0
    ) {
      throw new HttpError(
        422,
        "Reasoning memorandum verified proposition kullanmıyor.",
      );
    }

    const issueTags =
      uniqueStrings(
        reasoningRun?.issue_tags,
      );

    const schema =
      buildDraftSchema({
        issueTags,
        propositionIds:
          allowedPropositionIds,
      });

    const requestedEffort =
      String(
        body?.reasoningEffort ??
        DEFAULT_REASONING_EFFORT,
      );

    const reasoningEffort =
      VALID_REASONING_EFFORTS.has(
        requestedEffort,
      )
        ? requestedEffort
        : "medium";

    const canonicalFingerprint =
      await sha256Hex(
        JSON.stringify(
          canonical,
        ),
      );

    const authorityPackFingerprint =
      await sha256Hex(
        JSON.stringify(
          authorityPack,
        ),
      );

    const memorandumFingerprint =
      await sha256Hex(
        JSON.stringify(
          memorandum,
        ),
      );

    const inputSha =
      await sha256Hex(
        JSON.stringify({
          canonical,
          memorandum,
          authorityPack,
          allowedPropositionIds,
          reasoningEffort,
        }),
      );

    draftRunId =
      await createDraftRun(
        supabase,
        {
          reasoning_run_id:
            reasoningRunId,

          research_run_id:
            isUuid(
              reasoningRun
                ?.research_run_id,
            )
              ? reasoningRun
                .research_run_id
              : null,

          task_id:
            reasoningRun
              ?.task_id ??
            null,

          opposition_case_id:
            reasoningRun
              ?.opposition_case_id ??
            null,

          package_version:
            PACKAGE_VERSION,

          status:
            "started",

          model:
            OPENAI_MODEL,

          reasoning_effort:
            reasoningEffort,

          reasoning_validation_final_pass:
            reasoningPass,

          canonical_fingerprint:
            canonicalFingerprint,

          authority_pack_fingerprint:
            authorityPackFingerprint,

          memorandum_fingerprint:
            memorandumFingerprint,

          input_sha256:
            inputSha,

          canonical_snapshot:
            canonical,

          memorandum_snapshot:
            memorandum,

          authority_pack_snapshot:
            authorityPack,

          created_by:
            auth.userId,
        },
      );

    const safetyHash =
      await sha256Hex(
        auth.userId,
      );

    const openAiResponse =
      await startOpenAiDraftBackground({
        apiKey:
          openAiApiKey,

        model:
          OPENAI_MODEL,

        reasoningEffort,

        safetyIdentifier:
          `evreka_${safetyHash.slice(0, 32)}`,

        schema,

        canonical,

        memorandum,

        authorityPack,

        allowedPropositionIds,
      });

    await updateDraftRun(
      supabase,
      draftRunId,
      {
        openai_response_id:
          openAiResponse?.id ??
          null,

        openai_status:
          openAiResponse?.status ??
          null,

        service_tier:
          openAiResponse
            ?.service_tier ??
          null,
      },
    );

    if (
      openAiResponse?.status ===
      "completed"
    ) {
      const run =
        await loadDraftRunForUser({
          supabase,
          draftRunId,
          auth,
        });

      const final =
        await finalizeCompletedDraft({
          supabase,
          draftRunId,
          run,
          openAiResponse,
        });

      return jsonResponse(
        {
          ok: true,
          packageVersion:
            PACKAGE_VERSION,
          pending: false,
          draftRunId,
          reasoningRunId,
          researchRunId:
            reasoningRun
              ?.research_run_id ??
            null,
          runStatus:
            final.finalStatus,
          openAiStatus:
            "completed",
          model:
            OPENAI_MODEL,
          reasoningEffort,
          reasoningValidationFinalPass:
            reasoningPass,
          serviceTier:
            final.serviceTier,
          validation:
            final.validation,
          usage:
            final.usage,
          estimatedCostUsd:
            final.estimatedCostUsd,
          structuredDraft:
            final.structuredDraft,
          petition:
            final.petition,
        },
      );
    }

    return jsonResponse(
      {
        ok: true,
        packageVersion:
          PACKAGE_VERSION,
        pending: true,
        draftRunId,
        reasoningRunId,
        researchRunId:
          reasoningRun
            ?.research_run_id ??
          null,
        openAiStatus:
          openAiResponse?.status ??
          "queued",
        model:
          OPENAI_MODEL,
        reasoningEffort,
        reasoningValidationFinalPass:
          reasoningPass,
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
          allowedByMemorandum:
            allowedPropositionIds
              .length,
        },
        message:
          "Final petition background drafting başlatıldı. action=status ile polling yapın.",
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
      "[legal-petition-draft] fatal",
      error,
    );

    if (draftRunId) {
      try {
        await updateDraftRun(
          supabase,
          draftRunId,
          {
            status:
              "failed",
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
          "[legal-petition-draft] failed-run update",
          updateError,
        );
      }
    }

    return jsonResponse(
      {
        ok: false,
        packageVersion:
          PACKAGE_VERSION,
        draftRunId,
        error:
          message,
      },
      status,
    );
  }
});
