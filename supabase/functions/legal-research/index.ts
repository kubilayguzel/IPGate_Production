import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const PACKAGE_VERSION = "6.1.2.5";
const RESEARCH_MODEL = Deno.env.get("LEGAL_RESEARCH_MODEL") ?? "gemini-3.8-flash";
const EMBEDDING_MODEL = Deno.env.get("GEMINI_EMBEDDING_MODEL") ?? "gemini-embedding-2";
const GUIDELINE_SOURCE_KEY =
  Deno.env.get("EVREKA_GUIDELINE_SOURCE_KEY") ??
  "turkpatent-marka-inceleme-kilavuzu-2021";

const COVERAGE_THRESHOLD = Number(
  Deno.env.get("LEGAL_RESEARCH_COVERAGE_THRESHOLD") ?? "0.75",
);
const CORPUS_MATCH_THRESHOLD = Number(
  Deno.env.get("LEGAL_CORPUS_MATCH_THRESHOLD") ?? "0.48",
);
const CORPUS_MATCH_COUNT = Math.max(
  3,
  Math.min(10, Number(Deno.env.get("LEGAL_CORPUS_MATCH_COUNT") ?? "6") || 6),
);
const WEB_MAX_CANDIDATES = Math.max(
  1,
  Math.min(4, Number(Deno.env.get("LEGAL_WEB_MAX_CANDIDATES") ?? "3") || 3),
);

const DEFAULT_MIN_CASE_AUTHORITIES = Math.max(
  0,
  Math.min(
    6,
    Number(Deno.env.get("LEGAL_MIN_CASE_AUTHORITIES") ?? "3") || 3,
  ),
);

const CASE_LAW_PRIORITY_TAGS = [
  "single_letter_mark",
  "goods_retail_relation",
  "common_element",
  "interdependence",
  "sign_similarity",
  "relevant_consumer",
  "association",
  "complementarity",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OFFICIAL_TOKENS = [
  "turkpatent",
  "türkpatent",
  "yargitay",
  "yargıtay",
  "danistay",
  "danıştay",
  "anayasa",
  "resmi gazete",
  "resmî gazete",
  "mevzuat.gov.tr",
  "adalet.gov.tr",
  "curia",
  "eur-lex",
  "euipo",
  "wipo",
];

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    supported: { type: "boolean" },
    sourceChunkId: { type: "string" },
    propositionText: { type: "string" },
    supportSummary: { type: "string" },
    issueTags: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: [
    "supported",
    "sourceChunkId",
    "propositionText",
    "supportSummary",
    "issueTags",
    "confidence",
  ],
};

const WEB_DISCOVERY_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issueTags: { type: "array", items: { type: "string" } },
          authorityType: { type: "string" },
          jurisdiction: { type: "string" },
          authorityName: { type: "string" },
          court: { type: "string" },
          chamber: { type: "string" },
          caseNo: { type: "string" },
          decisionNo: { type: "string" },
          decisionDate: { type: "string" },
          title: { type: "string" },
          propositionText: { type: "string" },
          holdingSummary: { type: "string" },
          sourceHint: { type: "string" },
        },
        required: [
          "issueTags",
          "authorityType",
          "jurisdiction",
          "authorityName",
          "court",
          "chamber",
          "caseNo",
          "decisionNo",
          "decisionDate",
          "title",
          "propositionText",
          "holdingSummary",
          "sourceHint",
        ],
      },
    },
  },
  required: ["candidates"],
};

const OFFICIAL_GROUNDING_RECOVERY_SCHEMA = {
  type: "object",
  properties: {
    verified: { type: "boolean" },
    exactIdentityMatch: { type: "boolean" },
    propositionSupported: { type: "boolean" },
    supportedIssueTags: { type: "array", items: { type: "string" } },
    caseNo: { type: "string" },
    decisionNo: { type: "string" },
    decisionDate: { type: "string" },
    propositionText: { type: "string" },
    holdingSummary: { type: "string" },
    rationale: { type: "string" },
  },
  required: [
    "verified",
    "exactIdentityMatch",
    "propositionSupported",
    "supportedIssueTags",
    "caseNo",
    "decisionNo",
    "decisionDate",
    "propositionText",
    "holdingSummary",
    "rationale",
  ],
};

const WEB_VERIFY_SCHEMA = {
  type: "object",
  properties: {
    verified: { type: "boolean" },
    exactIdentityMatch: { type: "boolean" },
    propositionSupported: { type: "boolean" },
    supportedIssueTags: { type: "array", items: { type: "string" } },
    authorityType: { type: "string" },
    jurisdiction: { type: "string" },
    authorityName: { type: "string" },
    court: { type: "string" },
    chamber: { type: "string" },
    caseNo: { type: "string" },
    decisionNo: { type: "string" },
    decisionDate: { type: "string" },
    title: { type: "string" },
    propositionText: { type: "string" },
    holdingSummary: { type: "string" },
    rationale: { type: "string" },
  },
  required: [
    "verified",
    "exactIdentityMatch",
    "propositionSupported",
    "supportedIssueTags",
    "authorityType",
    "jurisdiction",
    "authorityName",
    "court",
    "chamber",
    "caseNo",
    "decisionNo",
    "decisionDate",
    "title",
    "propositionText",
    "holdingSummary",
    "rationale",
  ],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function normalizeText(value) {
  return String(value ?? "")
    .toLocaleLowerCase("tr-TR")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean))];
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value ?? ""));
}

function dateOrNull(value) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function intersect(a, b) {
  const bSet = new Set(b);
  return uniqueStrings(a.filter((x) => bSet.has(x)));
}

function authorityType(value) {
  const v = String(value ?? "").trim();
  return [
    "court_decision",
    "administrative_decision",
    "legislation",
    "guideline",
    "academic",
    "other",
  ].includes(v) ? v : "other";
}

function sourceTypeToAuthorityType(value) {
  const v = normalizeText(value);
  if (v.includes("guideline") || v.includes("kılavuz")) return "guideline";
  if (v.includes("legislation") || v.includes("mevzuat") || v.includes("law")) {
    return "legislation";
  }
  if (v.includes("decision") || v.includes("court") || v.includes("karar")) {
    return "court_decision";
  }
  return "other";
}

function inferVerifiedAuthorityType(value) {
  const explicit = authorityType(value?.authorityType);

  if (explicit !== "other") {
    return explicit;
  }

  const haystack = normalizeText([
    value?.authorityName,
    value?.court,
    value?.chamber,
    value?.title,
    value?.caseNo,
    value?.decisionNo,
  ].filter(Boolean).join(" "));

  const courtTokens = [
    "adalet divanı",
    "court of justice",
    "general court",
    "mahkeme",
    "court",
    "yargıtay",
    "yargitay",
    "danıştay",
    "danistay",
    "anayasa mahkemesi",
    "cjeu",
    "ecj",
    "ecli:",
  ];

  if (
    courtTokens.some((token) => haystack.includes(normalizeText(token))) &&
    (
      String(value?.caseNo ?? "").trim() ||
      String(value?.decisionNo ?? "").trim()
    )
  ) {
    return "court_decision";
  }

  const administrativeTokens = [
    "türkpatent",
    "turkpatent",
    "yi̇dk",
    "yidk",
    "euipo",
    "board of appeal",
    "temyiz kurulu",
  ];

  if (
    administrativeTokens.some((token) => haystack.includes(normalizeText(token))) &&
    (
      String(value?.caseNo ?? "").trim() ||
      String(value?.decisionNo ?? "").trim()
    )
  ) {
    return "administrative_decision";
  }

  return "other";
}

function semanticIssueTagSupported(tag, verification) {
  const haystack = normalizeText([
    verification?.propositionText,
    verification?.holdingSummary,
    verification?.rationale,
    verification?.title,
  ].filter(Boolean).join(" "));

  const rules = {
    goods_retail_relation: [
      "retail",
      "perakende",
      "35. sınıf",
      "35 sınıf",
      "class 35",
      "retailing services",
      "retail services",
    ],
    complementarity: [
      "complement",
      "tamamlayıc",
    ],
    interdependence: [
      "interdepend",
      "karşılıklı bağıml",
    ],
    single_letter_mark: [
      "single letter",
      "one-letter",
      "one letter",
      "tek harf",
    ],
    common_element: [
      "common element",
      "common component",
      "shared element",
      "ortak unsur",
      "ortak öğe",
      "ortak öge",
    ],
    relevant_consumer: [
      "relevant public",
      "relevant consumer",
      "average consumer",
      "attention",
      "ilgili tüketici",
      "ortalama tüketici",
      "dikkat düzeyi",
    ],
    association: [
      "association",
      "ilişkilendiril",
      "economic link",
      "economically linked",
      "ekonomik bağlant",
    ],
    sign_similarity: [
      "visual",
      "phonetic",
      "conceptual",
      "görsel",
      "işitsel",
      "kavramsal",
      "sign similarity",
      "marka benzer",
      "işaret benzer",
    ],
  };

  const tokens = rules[tag];

  // Unknown future tag: verification model must explicitly support it.
  if (!tokens) return true;

  return tokens.some((token) =>
    haystack.includes(normalizeText(token))
  );
}

function verifiedIssueTags(verification, requestedTags) {
  const modelTags = intersect(
    uniqueStrings(verification?.supportedIssueTags),
    requestedTags,
  );

  return modelTags.filter((tag) =>
    semanticIssueTagSupported(tag, verification)
  );
}

function hasSpecificIdentity(candidate) {
  const type = authorityType(candidate?.authorityType);
  if (["guideline", "legislation"].includes(type)) {
    return Boolean(String(candidate?.title ?? candidate?.authorityName ?? "").trim());
  }
  return Boolean(
    String(candidate?.court ?? candidate?.authorityName ?? "").trim() &&
      (
        String(candidate?.caseNo ?? "").trim() ||
        String(candidate?.decisionNo ?? "").trim()
      ),
  );
}

function compactIdentifier(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function identityResolved(candidate, verified) {
  if (verified?.verified !== true) return false;

  const candidateCase = compactIdentifier(candidate?.caseNo);
  const verifiedCase = compactIdentifier(verified?.caseNo);

  const candidateDecision = compactIdentifier(candidate?.decisionNo);
  const verifiedDecision = compactIdentifier(verified?.decisionNo);

  const candidateDate = dateOrNull(candidate?.decisionDate);
  const verifiedDate = dateOrNull(verified?.decisionDate);

  const caseMatch =
    candidateCase &&
    verifiedCase &&
    candidateCase === verifiedCase;

  const decisionMatch =
    candidateDecision &&
    verifiedDecision &&
    candidateDecision === verifiedDecision;

  const dateCompatible =
    !candidateDate ||
    !verifiedDate ||
    candidateDate === verifiedDate;

  // Discovery aşamasındaki chamber/title hataları düzeltilebilir metadata'dır.
  // Stabil kimlik unsurları aynı authority'yi gösteriyorsa verification çözülmüş sayılır.
  if (caseMatch && decisionMatch && dateCompatible) return true;
  if (caseMatch && dateCompatible && verified?.exactIdentityMatch === true) return true;
  if (decisionMatch && dateCompatible && verified?.exactIdentityMatch === true) return true;

  return verified?.exactIdentityMatch === true && hasSpecificIdentity(verified);
}

function isEuEcli(value) {
  return /^ECLI:EU:[A-Z]+:\d{4}:\d+$/i.test(String(value ?? "").trim());
}

async function resolveOfficialEurLexSource(verified) {
  const ecli = String(verified?.decisionNo ?? "").trim();
  const caseNo = String(verified?.caseNo ?? "").trim();

  if (!isEuEcli(ecli) || !caseNo) return null;

  const uri =
    `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=${encodeURIComponent(ecli)}`;

  try {
    const response = await fetch(uri, {
      method: "GET",
      redirect: "follow",
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "EVREKA-Legal-Intelligence/6.1.2.4",
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) return null;

    const html = await response.text();
    const compactHtml = compactIdentifier(html);

    const ecliFound =
      compactHtml.includes(compactIdentifier(ecli));

    const caseFound =
      compactHtml.includes(compactIdentifier(caseNo));

    if (!ecliFound || !caseFound) return null;

    return {
      uri,
      title: "EUR-Lex",
      verificationMethod: "direct_official_eurlex_ecli_fetch",
    };
  } catch (error) {
    console.warn(
      "[legal-research] EUR-Lex deterministic verification unavailable",
      error,
    );
    return null;
  }
}

function dedupeSources(sources) {
  const seen = new Set();
  const result = [];

  for (const source of safeArray(sources)) {
    const uri = String(source?.uri ?? "").trim();
    const title = String(source?.title ?? "").trim();
    if (!uri && !title) continue;

    const key = `${uri}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({ ...source, uri, title });
  }

  return result;
}

function preferredOfficialSource(sources) {
  const items = safeArray(sources);

  return (
    items.find((source) =>
      String(source?.uri ?? "").includes("eur-lex.europa.eu")
    ) ??
    items.find((source) => hasOfficialGrounding([source])) ??
    items[0] ??
    null
  );
}

function webAuthorityDoNotUseFor(verified, issueTags) {
  const result = ["beyond_verified_proposition"];

  const haystack = normalizeText([
    verified?.title,
    verified?.holdingSummary,
    verified?.rationale,
  ].filter(Boolean).join(" "));

  const absoluteGroundSignals = [
    "absolute grounds",
    "absolute ground",
    "mutlak ret",
    "7(1)(b)",
    "7/1-b",
    "distinctive character",
  ];

  const relativeGroundSignals = [
    "likelihood of confusion",
    "karıştırılma ihtimali",
    "relative ground",
    "nispi ret",
    "article 8(1)(b)",
  ];

  if (
    absoluteGroundSignals.some((token) =>
      haystack.includes(normalizeText(token))
    ) &&
    !relativeGroundSignals.some((token) =>
      haystack.includes(normalizeText(token))
    )
  ) {
    result.push("likelihood_of_confusion_direct_holding");
  }

  if (
    issueTags.length === 1 &&
    issueTags[0] === "single_letter_mark"
  ) {
    result.push("single_letter_mark_beyond_verified_distinctiveness_rule");
  }

  return uniqueStrings(result);
}

function extractGrounding(candidate) {
  const metadata = candidate?.groundingMetadata ?? {};
  const chunks = safeArray(metadata.groundingChunks);
  const sources = [];
  const seen = new Set();

  for (const chunk of chunks) {
    const uri = String(chunk?.web?.uri ?? "").trim();
    const title = String(chunk?.web?.title ?? "").trim();
    if (!uri && !title) continue;
    const key = `${uri}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ uri, title });
  }

  const queries = uniqueStrings(metadata.webSearchQueries ?? []);
  return { sources, queries };
}

function hasOfficialGrounding(sources) {
  return safeArray(sources).some((source) => {
    const haystack = normalizeText(`${source?.title ?? ""} ${source?.uri ?? ""}`);
    return OFFICIAL_TOKENS.some((token) =>
      haystack.includes(normalizeText(token))
    );
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(text ?? "")),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function stableKey(prefix, parts) {
  const digest = await sha256Hex(
    parts.map((p) => normalizeText(p)).filter(Boolean).join("|"),
  );
  return `${prefix}-${digest.slice(0, 24)}`;
}

async function createEmbedding(apiKey, query) {
  const prepared = `task: search result | query: ${query}`;
  let lastError = "Embedding API başarısız.";

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text: prepared }] },
          outputDimensionality: 768,
        }),
      },
    );

    const data = await response.json().catch(() => ({}));

    if (response.ok) {
      const values = data?.embedding?.values;
      if (!Array.isArray(values) || values.length !== 768) {
        throw new Error("Embedding boyutu 768 değil.");
      }
      return values;
    }

    lastError = `Embedding ${response.status}: ${
      data?.error?.message ?? response.statusText
    }`;

    if (![408, 429, 500, 502, 503, 504].includes(response.status)) break;
    await new Promise((r) => setTimeout(r, Math.min(8000, 700 * 2 ** attempt)));
  }

  throw new Error(lastError);
}

async function callGeminiJson(apiKey, {
  systemInstruction,
  prompt,
  schema,
  googleSearch = false,
  thinkingLevel = "medium",
  maxOutputTokens = 7000,
}) {
  const generationConfig = {
    temperature: 0.05,
    maxOutputTokens,
    thinkingConfig: { thinkingLevel },
  };

  // Google'ın güncel Gemini 3 REST yapısında tool + structured output için
  // responseFormat kullanılır. Tool kullanılmayan çağrılarda production'daki
  // legacy responseMimeType/responseSchema biçimi korunur.
  if (googleSearch) {
    generationConfig.responseFormat = {
      text: {
        mimeType: "APPLICATION_JSON",
        schema,
      },
    };
  } else {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = schema;
  }

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  };

  if (googleSearch) {
    body.tools = [{ google_search: {} }];
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${RESEARCH_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Gemini API ${response.status}: ${
        data?.error?.message ?? response.statusText
      }`,
    );
  }

  const candidate = data?.candidates?.[0];
  const text = safeArray(candidate?.content?.parts)
    .map((part) => String(part?.text ?? ""))
    .join("")
    .trim();

  if (!text) throw new Error("Gemini boş yanıt döndürdü.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Gemini JSON parse hatası: ${error.message}`);
  }

  const grounding = extractGrounding(candidate);

  return {
    parsed,
    sources: grounding.sources,
    queries: grounding.queries,
    usage: data?.usageMetadata ?? {},
    model: RESEARCH_MODEL,
  };
}

async function callGeminiGroundedText(apiKey, {
  systemInstruction,
  prompt,
  thinkingLevel = "medium",
  maxOutputTokens = 5000,
}) {
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.02,
      maxOutputTokens,
      thinkingConfig: { thinkingLevel },
    },
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${RESEARCH_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    },
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Gemini grounded-text ${response.status}: ${
        data?.error?.message ?? response.statusText
      }`,
    );
  }

  const candidate = data?.candidates?.[0];
  const responseText = safeArray(candidate?.content?.parts)
    .map((part) => String(part?.text ?? ""))
    .join("")
    .trim();

  if (!responseText) {
    throw new Error("Gemini grounded-text boş yanıt döndürdü.");
  }

  const grounding = extractGrounding(candidate);

  return {
    text: responseText,
    sources: grounding.sources,
    queries: grounding.queries,
    usage: data?.usageMetadata ?? {},
    model: RESEARCH_MODEL,
  };
}

async function recoverOfficialGrounding(
  apiKey,
  candidate,
  verified,
  requestedTags,
) {
  const officialEvidence = await callGeminiGroundedText(apiKey, {
    thinkingLevel: "medium",
    maxOutputTokens: 5000,
    systemInstruction: `
Sen EVREKA'nın son resmî kaynak doğrulama katmanısın.

SADECE resmî/primary kaynak ara:
- AB kararları için CURIA / InfoCuria / EUR-Lex
- Türkiye için Yargıtay / Danıştay / TÜRKPATENT / resmî mevzuat
- EUIPO kararları için EUIPO
- WIPO için WIPO

Görev:
1. Exact authority kimliğini (court, case no, ECLI/decision no, date) doğrula.
2. Verilen dar hukukî proposition'ın gerçekten bu authority tarafından desteklenip
   desteklenmediğini resmî kaynağa göre açıkla.
3. Özellikle hangi requested issue tag'lerin desteklendiğini metinde açıkça söyle.
4. Desteklenmeyen etiketi genişletme.
5. İkincil blog/özetleri authority kanıtı olarak kullanma.
`.trim(),
    prompt: `
AUTHORITY CANDIDATE
${JSON.stringify({
  title: candidate?.title,
  authorityName: candidate?.authorityName,
  court: candidate?.court,
  chamber: candidate?.chamber,
  caseNo: verified?.caseNo ?? candidate?.caseNo,
  decisionNo: verified?.decisionNo ?? candidate?.decisionNo,
  decisionDate: verified?.decisionDate ?? candidate?.decisionDate,
})}

PROPOSITION TO VERIFY
${String(verified?.propositionText ?? candidate?.propositionText ?? "")}

REQUESTED ISSUE TAGS
${JSON.stringify(requestedTags)}

Önce resmî kaynağı Google Search ile bul; sonra identity + proposition desteğini
kısa ve denetlenebilir biçimde açıkla.
`.trim(),
  });

  if (!hasOfficialGrounding(officialEvidence.sources)) {
    return {
      recovered: false,
      officialEvidence,
      parsed: null,
    };
  }

  const validation = await callGeminiJson(apiKey, {
    schema: OFFICIAL_GROUNDING_RECOVERY_SCHEMA,
    googleSearch: false,
    thinkingLevel: "low",
    maxOutputTokens: 3500,
    systemInstruction: `
Sen EVREKA'nın resmî-grounding kanıtından yapılandırılmış doğrulama çıkaran katmanısın.

KESİN KURALLAR:
- Yalnız sana verilen OFFICIAL GROUNDED EVIDENCE metnini kullan.
- Kaynakta olmayan holding veya proposition ekleme.
- propositionText'i gerekiyorsa DARALT; genişletme.
- propositionSupported, DÖNDÜRDÜĞÜN propositionText'in resmî kanıtça desteklenmesini ifade eder.
- supportedIssueTags yalnız resmî kanıtın gerçekten desteklediği etiketleri içersin.
- goods_retail_relation ancak retail/perakende hizmetleri açıkça tartışılıyorsa verilebilir.
- Kimlik bilgisi resmî kanıtta doğrulanmıyorsa verified=false döndür.
`.trim(),
    prompt: `
ORIGINAL CANDIDATE
${JSON.stringify(candidate)}

INITIAL VERIFICATION
${JSON.stringify(verified)}

REQUESTED TAGS
${JSON.stringify(requestedTags)}

OFFICIAL GROUNDED EVIDENCE
${officialEvidence.text}

OFFICIAL GROUNDING SOURCES
${JSON.stringify(officialEvidence.sources)}
`.trim(),
  });

  return {
    recovered: true,
    officialEvidence,
    parsed: validation.parsed,
  };
}


async function authenticate(req, supabaseUrl, anonKey) {
  const header = req.headers.get("Authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    throw new Error("AUTH_REQUIRED");
  }

  const token = header.slice(7).trim();
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user?.id) throw new Error("AUTH_REQUIRED");
  return { userId: data.user.id };
}

async function authorityPack(supabase, issueTags) {
  const { data, error } = await supabase.rpc("build_legal_authority_pack", {
    requested_issue_tags: issueTags,
    max_propositions: 24,
  });
  if (error) throw new Error(`Authority Pack RPC: ${error.message}`);
  return data;
}

function isCaseAuthorityType(value) {
  return [
    "court_decision",
    "administrative_decision",
  ].includes(String(value ?? "").trim());
}

function countCaseAuthorities(pack) {
  const ids = new Set();

  for (const proposition of safeArray(pack?.propositions)) {
    if (!isCaseAuthorityType(proposition?.authorityType)) continue;

    const identity = String(
      proposition?.authorityId ??
      proposition?.authorityKey ??
      proposition?.citationLabel ??
      "",
    ).trim();

    if (identity) ids.add(identity);
  }

  return ids.size;
}

function caseLawGapTags(pack, requestedTags) {
  const propositions = safeArray(pack?.propositions);

  return requestedTags.filter((tag) => {
    return !propositions.some((proposition) => {
      if (!isCaseAuthorityType(proposition?.authorityType)) return false;

      const tags = uniqueStrings(proposition?.issueTags);
      return tags.includes(tag);
    });
  });
}

function orderedResearchTags(missingTags, caseGapTags) {
  const missingSet = new Set(missingTags);
  const gapSet = new Set(caseGapTags);
  const ordered = [];

  for (const tag of missingTags) {
    if (!ordered.includes(tag)) ordered.push(tag);
  }

  for (const tag of CASE_LAW_PRIORITY_TAGS) {
    if (gapSet.has(tag) && !ordered.includes(tag)) ordered.push(tag);
  }

  for (const tag of caseGapTags) {
    if (!ordered.includes(tag)) ordered.push(tag);
  }

  return ordered;
}

async function refreshModules(supabase) {
  const { error } = await supabase.rpc("refresh_legal_module_statuses");
  if (error) throw new Error(`Module refresh: ${error.message}`);
}

async function ensureCorpusAuthority(supabase, chunk) {
  const authorityKey = `CORPUS-${String(chunk.source_key)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .slice(0, 120)}`;

  const { data, error } = await supabase
    .from("legal_authorities")
    .upsert({
      authority_key: authorityKey,
      authority_type: sourceTypeToAuthorityType(chunk.source_type),
      jurisdiction: chunk.jurisdiction ?? "Türkiye",
      authority_name: chunk.source_authority ?? null,
      title: chunk.source_title,
      short_name: chunk.citation_label ?? chunk.source_title,
      source_url: chunk.source_url ?? null,
      source_document_url: chunk.source_url ?? null,
      source_sha256: chunk.file_sha256 ?? null,
      legal_source_id: chunk.source_id,
      language: "tr",
      status: "verified",
      verified: true,
      citable: true,
      verification_method: "existing_verified_legal_source",
      verification_notes:
        `Paket ${PACKAGE_VERSION}: verified+citable+ready legal_source kaydından yükseltildi.`,
      verified_at: new Date().toISOString(),
      verified_by: `EVREKA_${PACKAGE_VERSION}`,
      legal_issue_tags: [],
      use_for: ["trademark_opposition", "SMK_6_1"],
      do_not_use_for: ["unsupported_case_specific_fact"],
      source_kind: "corpus",
      source_reliability: "official",
      citation_label: chunk.citation_label ?? chunk.source_title,
      verification_payload: {
        packageVersion: PACKAGE_VERSION,
        legalSourceId: chunk.source_id,
        sourceKey: chunk.source_key,
      },
      metadata: {
        package_version: PACKAGE_VERSION,
        source_key: chunk.source_key,
        auto_promoted_from_verified_corpus: true,
      },
    }, { onConflict: "authority_key" })
    .select("id, authority_key")
    .single();

  if (error) throw new Error(`Corpus authority upsert: ${error.message}`);
  return data;
}

async function bindModule(supabase, moduleId, authorityId, propositionId, score) {
  const { data: existing, error: findError } = await supabase
    .from("legal_module_authorities")
    .select("id")
    .eq("module_id", moduleId)
    .eq("proposition_id", propositionId)
    .maybeSingle();

  if (findError) throw new Error(`Binding lookup: ${findError.message}`);

  const row = {
    module_id: moduleId,
    authority_id: authorityId,
    proposition_id: propositionId,
    relevance_score: clamp(score, 0, 1, 0.85),
    is_core: true,
    notes: `EVREKA ${PACKAGE_VERSION} verified authority binding`,
  };

  if (existing?.id) {
    const { error } = await supabase
      .from("legal_module_authorities")
      .update(row)
      .eq("id", existing.id);
    if (error) throw new Error(`Binding update: ${error.message}`);
  } else {
    const { error } = await supabase
      .from("legal_module_authorities")
      .insert(row);
    if (error) throw new Error(`Binding insert: ${error.message}`);
  }
}

async function enrichOneModuleFromCorpus(
  supabase,
  apiKey,
  module,
  requestedTags,
) {
  const query = String(module?.retrieval_query ?? module?.title ?? "").trim();
  if (!query) return null;

  const embedding = await createEmbedding(apiKey, query);

  const { data: chunks, error } = await supabase.rpc(
    "match_verified_legal_source_chunks_6_1_2",
    {
      query_embedding: embedding,
      match_threshold: CORPUS_MATCH_THRESHOLD,
      match_count: CORPUS_MATCH_COUNT,
      source_key_filter: GUIDELINE_SOURCE_KEY,
    },
  );

  if (error) throw new Error(`Corpus retrieval ${module.module_key}: ${error.message}`);
  const candidates = safeArray(chunks);
  if (!candidates.length) return null;

  const sourceText = candidates.map((chunk, i) => [
    `SOURCE_${i + 1}`,
    `chunkId: ${chunk.chunk_id}`,
    `source: ${chunk.citation_label ?? chunk.source_title}`,
    `page: ${chunk.page_from ?? "-"}`,
    `heading: ${chunk.section_title ?? "-"}`,
    `similarity: ${Number(chunk.similarity ?? 0).toFixed(4)}`,
    "TEXT:",
    String(chunk.content ?? "").slice(0, 3200),
  ].join("\n")).join("\n\n----------------\n\n");

  const result = await callGeminiJson(apiKey, {
    schema: EXTRACTION_SCHEMA,
    thinkingLevel: "low",
    maxOutputTokens: 3500,
    systemInstruction: `
Sen EVREKA'nın kaynak-kısıtlı hukukî önerme çıkarım katmanısın.

KESİN KURALLAR:
- Yalnız verilen doğrulanmış SOURCE metinlerinde açıkça desteklenen şeyi söyle.
- Kaynakta olmayan mahkeme, karar numarası, tarih, doktrin veya olguyu ekleme.
- Somut dosyadaki marka hakkında baskın/asli/yüksek ayırt edici gibi nitelendirme üretme.
- Çıktı dilekçe paragrafı değil, dar ve genel bir hukukî proposition'dır.
- sourceChunkId verilen chunkId değerlerinden tam olarak biri olmalıdır.
- Doğrudan ve yeterli destek yoksa supported=false döndür.
`.trim(),
    prompt: `
MODULE
${module.module_key} — ${module.title}
moduleIssueTags: ${JSON.stringify(module.legal_issue_tags ?? [])}
requestedIssueTags: ${JSON.stringify(requestedTags)}
theorySummary: ${module.theory_summary ?? ""}
applicationGuidance: ${module.application_guidance ?? ""}

VERIFIED CORPUS
${sourceText}
`.trim(),
  });

  const extracted = result.parsed;
  if (extracted?.supported !== true) return null;

  const chunk = candidates.find(
    (item) => String(item.chunk_id) === String(extracted.sourceChunkId),
  );
  if (!chunk) return null;

  const propositionText = String(extracted.propositionText ?? "").trim();
  const confidence = clamp(extracted.confidence, 0, 1, 0);
  if (propositionText.length < 40 || confidence < 0.72) return null;

  const moduleTags = uniqueStrings(module.legal_issue_tags);
  const issueTags = uniqueStrings([
    ...intersect(moduleTags, requestedTags),
    ...intersect(uniqueStrings(extracted.issueTags), moduleTags),
  ]);
  if (!issueTags.length) return null;

  const authority = await ensureCorpusAuthority(supabase, chunk);
  const propositionEmbedding = await createEmbedding(apiKey, propositionText);
  const fullSource = String(chunk.content ?? "").trim();
  const hash = await sha256Hex(fullSource);

  const propositionKey = [
    authority.authority_key,
    module.module_key,
    chunk.page_from ?? "NA",
    chunk.chunk_index ?? "NA",
  ].join("-").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 220);

  const { data: proposition, error: propError } = await supabase
    .from("legal_authority_propositions")
    .upsert({
      authority_id: authority.id,
      proposition_key: propositionKey,
      proposition_text: propositionText,
      holding_text: fullSource,
      source_locator: [
        chunk.citation_label ?? chunk.source_title,
        chunk.page_from ? `s. ${chunk.page_from}` : null,
        chunk.section_title ?? null,
      ].filter(Boolean).join(", "),
      page_from: chunk.page_from ?? null,
      page_to: chunk.page_to ?? chunk.page_from ?? null,
      legal_issue_tags: issueTags,
      use_for: ["SMK_6_1", ...issueTags],
      do_not_use_for: uniqueStrings(module.do_not_use_for),
      confidence,
      verified: true,
      citable: true,
      quote_safe: false,
      embedding: propositionEmbedding,
      source_chunk_id: isUuid(chunk.chunk_id) ? chunk.chunk_id : null,
      source_chunk_index: chunk.chunk_index ?? null,
      verification_excerpt: fullSource.slice(0, 1800),
      verification_sha256: hash,
      verification_method: "derived_from_verified_official_corpus_exact_chunk",
      verified_at: new Date().toISOString(),
      verified_by: `EVREKA_${PACKAGE_VERSION}`,
      metadata: {
        package_version: PACKAGE_VERSION,
        module_key: module.module_key,
        source_key: chunk.source_key,
        corpus_similarity: chunk.similarity,
        support_summary: String(extracted.supportSummary ?? ""),
      },
    }, { onConflict: "authority_id,proposition_key" })
    .select("id")
    .single();

  if (propError) {
    throw new Error(`Corpus proposition ${module.module_key}: ${propError.message}`);
  }

  await bindModule(
    supabase,
    module.id,
    authority.id,
    proposition.id,
    Number(chunk.similarity ?? 0.85),
  );

  return { propositionId: proposition.id, issueTags };
}

async function enrichMissingFromCorpus(supabase, apiKey, missingTags) {
  const { data: modules, error } = await supabase
    .from("legal_modules")
    .select(
      "id,module_key,title,legal_issue_tags,status,theory_summary,application_guidance,do_not_use_for,retrieval_query",
    )
    .neq("status", "retired")
    .overlaps("legal_issue_tags", missingTags)
    .order("module_key", { ascending: true });

  if (error) throw new Error(`Legal modules: ${error.message}`);

  const promoted = [];
  let remaining = [...missingTags];

  for (const module of safeArray(modules)) {
    if (!intersect(uniqueStrings(module.legal_issue_tags), remaining).length) continue;

    try {
      const result = await enrichOneModuleFromCorpus(
        supabase,
        apiKey,
        module,
        remaining,
      );

      if (result?.propositionId) {
        promoted.push(result.propositionId);
        const covered = new Set(result.issueTags);
        remaining = remaining.filter((tag) => !covered.has(tag));
      }
    } catch (error) {
      console.error(`[legal-research] corpus module skipped ${module.module_key}`, error);
    }
  }

  await refreshModules(supabase);
  return promoted;
}

async function discoverWeb(apiKey, missingTags, caseContext) {
  return await callGeminiJson(apiKey, {
    schema: WEB_DISCOVERY_SCHEMA,
    googleSearch: true,
    thinkingLevel: "medium",
    maxOutputTokens: 7000,
    systemInstruction: `
Sen EVREKA Trademark Opposition Engine'in dış hukuk araştırması katmanısın.

Kaynak önceliği:
1. TÜRKPATENT / YİDK resmî kaynakları
2. Yargıtay ve diğer yüksek mahkemelerin resmî kaynakları
3. CJEU / General Court / CURIA / EUR-Lex
4. EUIPO
5. WIPO

KESİN KURALLAR:
- Karar numarası, dosya numarası, tarih veya mahkeme bilgisi uydurma.
- Emin olmadığın authority'yi aday olarak verme.
- Web makalesini karar gibi gösterme.
- Dar bir proposition yaz.
- Somut markaya ilişkin avukatın vermediği baskın/asli/yüksek ayırt edicilik gibi olgusal nitelendirme üretme.
- En fazla ${WEB_MAX_CANDIDATES} güçlü aday üret.
`.trim(),
    prompt: `
Eksik issue tags:
${JSON.stringify(missingTags)}

Dosya bağlamı:
${JSON.stringify(caseContext)}

Google Search kullan ve doğrulanabilir authority adaylarını schema'ya göre döndür.
`.trim(),
  });
}

async function verifyWeb(apiKey, candidate, issueTags) {
  return await callGeminiJson(apiKey, {
    schema: WEB_VERIFY_SCHEMA,
    googleSearch: true,
    thinkingLevel: "medium",
    maxOutputTokens: 5500,
    systemInstruction: `
Sen EVREKA'nın authority verification katmanısın.

Adayı bağımsız Google Search ile yeniden doğrula.
- Mahkeme/kurum, dosya-karar numarası ve tarihi kontrol et.
- Aday proposition gerçekten authority tarafından destekleniyor mu kontrol et.
- Aday proposition kısmen aşırı genişse onu REDDETMEKLE yetinme:
  propositionText alanında authority'nin gerçekten desteklediği DAR ve düzeltilmiş önermeyi yaz.
- propositionSupported, ORİJİNAL aday metnin değil, DÖNDÜRDÜĞÜN propositionText'in
  authority tarafından desteklenip desteklenmediğini ifade eder.
- supportedIssueTags alanına YALNIZ döndürdüğün propositionText'in gerçekten desteklediği issue tag'lerini yaz.
- Discovery'deki title/chamber gibi tali metadata hatalarını düzeltebilirsin.
  CaseNo + DecisionNo/ECLI + tarih aynı authority'yi açıkça gösteriyorsa,
  sırf chamber/title düzeltildi diye exactIdentityMatch=false yapma.
- goods_retail_relation ancak authority açıkça perakendecilik/retail hizmetleri ilişkisini tartışıyorsa desteklenebilir.
- complementarity veya interdependence hakkında genel bir karar, sırf benzer konu olduğu için goods_retail_relation etiketi alamaz.
- Mümkünse resmî/primary kaynağa dayan.
- Authority'nin kendisini veya döndürdüğün dar proposition'ı doğrulayamıyorsan false döndür; tahmin etme.
`.trim(),
    prompt: `
Aday:
${JSON.stringify(candidate)}

Issue tags:
${JSON.stringify(issueTags)}

Bu authority'yi bağımsız olarak doğrula.
`.trim(),
  });
}

async function stageCandidate(supabase, runId, candidate, issueTags, discovery) {
  const first = discovery.sources[0] ?? null;

  const { data, error } = await supabase
    .from("legal_research_candidates")
    .insert({
      research_run_id: runId,
      issue_tag: issueTags[0] ?? null,
      issue_tags: issueTags,
      title: String(candidate?.title ?? "") || null,
      authority_name: String(candidate?.authorityName ?? "") || null,
      court: String(candidate?.court ?? "") || null,
      chamber: String(candidate?.chamber ?? "") || null,
      case_no: String(candidate?.caseNo ?? "") || null,
      decision_no: String(candidate?.decisionNo ?? "") || null,
      decision_date: dateOrNull(candidate?.decisionDate),
      source_url: first?.uri ?? null,
      source_domain: first?.title ?? null,
      discovered_text: String(candidate?.propositionText ?? "") || null,
      status: "candidate",
      search_queries: discovery.queries,
      grounding_sources: discovery.sources,
      source_reliability: hasOfficialGrounding(discovery.sources) ? "official" : "unknown",
      auto_verification_eligible: false,
      raw_payload: {
        packageVersion: PACKAGE_VERSION,
        discoveryModel: discovery.model,
        candidate,
      },
    })
    .select("id")
    .single();

  if (error) throw new Error(`Candidate insert: ${error.message}`);
  return data;
}

async function updateCandidate(supabase, id, patch) {
  const { error } = await supabase
    .from("legal_research_candidates")
    .update(patch)
    .eq("id", id);

  if (error) throw new Error(`Candidate update: ${error.message}`);
}

async function bindWebAuthorityToModules(
  supabase,
  authorityId,
  propositionId,
  issueTags,
) {
  const { data: modules, error } = await supabase
    .from("legal_modules")
    .select("id,module_key")
    .neq("status", "retired")
    .overlaps("legal_issue_tags", issueTags);

  if (error) throw new Error(`Web module lookup: ${error.message}`);

  for (const module of safeArray(modules)) {
    await bindModule(supabase, module.id, authorityId, propositionId, 0.95);
  }
}

async function promoteWebAuthority(
  supabase,
  apiKey,
  stagedId,
  candidate,
  verification,
  issueTags,
) {
  const v = verification.parsed;
  const key = await stableKey("WEB", [
    v.jurisdiction,
    v.authorityName,
    v.court,
    v.chamber,
    v.caseNo,
    v.decisionNo,
    v.decisionDate,
    v.title,
  ]);

  const first = preferredOfficialSource(verification.sources);
  const citationLabel = [
    v.court || v.authorityName,
    v.caseNo,
    v.decisionNo,
    dateOrNull(v.decisionDate),
  ].filter(Boolean).join(", ");

  const { data: authority, error } = await supabase
    .from("legal_authorities")
    .upsert({
      authority_key: key,
      authority_type: inferVerifiedAuthorityType({
        ...candidate,
        ...v,
      }),
      jurisdiction: String(v.jurisdiction ?? candidate.jurisdiction ?? "") || null,
      authority_name: String(v.authorityName ?? candidate.authorityName ?? "") || null,
      court: String(v.court ?? candidate.court ?? "") || null,
      chamber: String(v.chamber ?? candidate.chamber ?? "") || null,
      case_no: String(v.caseNo ?? candidate.caseNo ?? "") || null,
      decision_no: String(v.decisionNo ?? candidate.decisionNo ?? "") || null,
      decision_date: dateOrNull(v.decisionDate ?? candidate.decisionDate),
      title: String((v.title ?? candidate.title ?? citationLabel) || "Verified authority"),
      short_name: citationLabel || null,
      source_url: first?.uri ?? null,
      source_document_url: first?.uri ?? null,
      language: "tr",
      status: "verified",
      verified: true,
      citable: true,
      verification_method:
        verification.officialGroundingRecovered === true
          ? "gemini_double_pass_plus_plaintext_official_grounding_recovery"
          : verification.directOfficialSourceVerified === true
          ? "gemini_double_pass_plus_direct_official_source"
          : "gemini_google_search_double_pass_official_grounding",
      verification_notes: String(v.rationale ?? ""),
      verified_at: new Date().toISOString(),
      verified_by: `EVREKA_${PACKAGE_VERSION}`,
      legal_issue_tags: issueTags,
      holding_summary: String(v.holdingSummary ?? candidate.holdingSummary ?? "") || null,
      use_for: issueTags,
      do_not_use_for: webAuthorityDoNotUseFor(v, issueTags),
      source_kind: "google_search",
      source_reliability: "official",
      citation_label: citationLabel || null,
      verification_payload: {
        packageVersion: PACKAGE_VERSION,
        searchQueries: verification.queries,
        groundingSources: verification.sources,
        verification: v,
        resolvedIdentity: true,
        directOfficialSourceVerified:
          verification.directOfficialSourceVerified === true,
        officialGroundingRecovered:
          verification.officialGroundingRecovered === true,
      },
      metadata: {
        package_version: PACKAGE_VERSION,
        discovered_candidate_id: stagedId,
        google_search_verified: true,
      },
    }, { onConflict: "authority_key" })
    .select("id,authority_key")
    .single();

  if (error) throw new Error(`Web authority upsert: ${error.message}`);

  const propositionText = String(
    v.propositionText ?? candidate.propositionText ?? "",
  ).trim();
  if (propositionText.length < 40) throw new Error("Web proposition yetersiz.");

  const embedding = await createEmbedding(apiKey, propositionText);
  const holding = String(v.holdingSummary ?? candidate.holdingSummary ?? "").trim();
  const propKey = `${authority.authority_key}-P1`;

  const { data: proposition, error: propError } = await supabase
    .from("legal_authority_propositions")
    .upsert({
      authority_id: authority.id,
      proposition_key: propKey,
      proposition_text: propositionText,
      holding_text: holding || propositionText,
      source_locator: citationLabel || String(v.title ?? ""),
      legal_issue_tags: issueTags,
      use_for: issueTags,
      do_not_use_for: webAuthorityDoNotUseFor(v, issueTags),
      confidence: 0.92,
      verified: true,
      citable: true,
      quote_safe: false,
      embedding,
      verification_excerpt: holding.slice(0, 1800),
      verification_sha256: await sha256Hex(JSON.stringify({
        verification: v,
        groundingSources: verification.sources,
      })),
      verification_method:
        verification.officialGroundingRecovered === true
          ? "gemini_double_pass_plus_plaintext_official_grounding_recovery"
          : verification.directOfficialSourceVerified === true
          ? "gemini_double_pass_plus_direct_official_source"
          : "gemini_google_search_double_pass_official_grounding",
      verified_at: new Date().toISOString(),
      verified_by: `EVREKA_${PACKAGE_VERSION}`,
      metadata: {
        package_version: PACKAGE_VERSION,
        candidate_id: stagedId,
        search_queries: verification.queries,
        grounding_sources: verification.sources,
        direct_official_source_verified:
          verification.directOfficialSourceVerified === true,
        official_grounding_recovered:
          verification.officialGroundingRecovered === true,
      },
    }, { onConflict: "authority_id,proposition_key" })
    .select("id")
    .single();

  if (propError) throw new Error(`Web proposition upsert: ${propError.message}`);

  await bindWebAuthorityToModules(
    supabase,
    authority.id,
    proposition.id,
    issueTags,
  );

  await updateCandidate(supabase, stagedId, {
    status: "verified_promoted",
    promoted_authority_id: authority.id,
    verification_notes: String(v.rationale ?? ""),
    verification_payload: {
      packageVersion: PACKAGE_VERSION,
      verification: v,
      searchQueries: verification.queries,
      groundingSources: verification.sources,
    },
    grounding_sources: verification.sources,
    search_queries: verification.queries,
    source_url: first?.uri ?? null,
    source_domain: first?.title ?? null,
    source_reliability: "official",
    auto_verification_eligible: true,
  });

  return authority.id;
}

async function researchWeb(
  supabase,
  apiKey,
  runId,
  missingTags,
  caseContext,
  autoVerify,
) {
  const discovery = await discoverWeb(apiKey, missingTags, caseContext);
  const rawCandidates = safeArray(discovery.parsed?.candidates)
    .slice(0, WEB_MAX_CANDIDATES);

  const promoted = [];
  let candidateCount = 0;
  let groundingSourceCount = discovery.sources.length;
  const observedSearchQueries = [...discovery.queries];

  for (const candidate of rawCandidates) {
    let tags = intersect(uniqueStrings(candidate?.issueTags), missingTags);
    if (!tags.length && missingTags[0]) tags = [missingTags[0]];

    const staged = await stageCandidate(
      supabase,
      runId,
      candidate,
      tags,
      discovery,
    );
    candidateCount += 1;

    if (!autoVerify || !hasSpecificIdentity(candidate)) continue;

    try {
      const verification = await verifyWeb(apiKey, candidate, tags);
      const v = verification.parsed;

      observedSearchQueries.push(...verification.queries);

      let safeVerifiedTags = verifiedIssueTags(v, tags);
      let resolvedIdentity = identityResolved(candidate, v);
      let officialGrounding = hasOfficialGrounding(verification.sources);

      verification.directOfficialSourceVerified = false;
      verification.officialGroundingRecovered = false;

      // Structured-output + Google Search çağrılarında grounding metadata bazen boş kalabiliyor.
      // Böyle durumda ayrı bir PLAIN-TEXT grounded search yap ve yalnız resmî kaynakları kabul et.
      if (
        v?.verified === true &&
        resolvedIdentity &&
        v?.propositionSupported === true &&
        safeVerifiedTags.length > 0 &&
        !officialGrounding
      ) {
        try {
          const recovered = await recoverOfficialGrounding(
            apiKey,
            candidate,
            v,
            tags,
          );

          observedSearchQueries.push(
            ...safeArray(recovered?.officialEvidence?.queries),
          );

          if (
            recovered?.recovered === true &&
            recovered?.parsed
          ) {
            const r = recovered.parsed;

            verification.sources = dedupeSources([
              ...safeArray(recovered.officialEvidence.sources),
              ...verification.sources,
            ]);

            verification.queries = uniqueStrings([
              ...verification.queries,
              ...safeArray(recovered.officialEvidence.queries),
            ]);

            verification.officialGroundingRecovered = true;

            v = {
              ...v,
              verified: r.verified,
              exactIdentityMatch: r.exactIdentityMatch,
              propositionSupported: r.propositionSupported,
              supportedIssueTags: r.supportedIssueTags,
              caseNo: r.caseNo || v.caseNo,
              decisionNo: r.decisionNo || v.decisionNo,
              decisionDate: r.decisionDate || v.decisionDate,
              propositionText:
                String(r.propositionText ?? "").trim() ||
                v.propositionText,
              holdingSummary:
                String(r.holdingSummary ?? "").trim() ||
                v.holdingSummary,
              rationale:
                String(r.rationale ?? "").trim() ||
                v.rationale,
            };

            verification.parsed = v;
          }
        } catch (error) {
          console.warn(
            "[legal-research] official grounding recovery unavailable",
            error,
          );
        }

        safeVerifiedTags = verifiedIssueTags(v, tags);
        resolvedIdentity = identityResolved(candidate, v);
        officialGrounding = hasOfficialGrounding(verification.sources);
      }

      groundingSourceCount += verification.sources.length;

      const eligible =
        v?.verified === true &&
        resolvedIdentity &&
        v?.propositionSupported === true &&
        safeVerifiedTags.length > 0 &&
        hasSpecificIdentity(v) &&
        officialGrounding;

      if (!eligible) {
        const hardRejected =
          v?.verified === false ||
          !resolvedIdentity ||
          v?.propositionSupported === false;

        await updateCandidate(supabase, staged.id, {
          status: hardRejected ? "rejected" : "candidate",
          verification_notes:
            String(v?.rationale ?? "") ||
            (
              officialGrounding
                ? "Verification tamamlanamadı."
                : "Authority/proposition doğrulandı ancak resmî/primary source grounding bulunamadı."
            ),
          verification_payload: {
            packageVersion: PACKAGE_VERSION,
            verification: v,
            resolvedIdentity,
            directOfficialSourceVerified:
              verification.directOfficialSourceVerified,
            searchQueries: verification.queries,
            groundingSources: verification.sources,
          },
          grounding_sources: verification.sources,
          search_queries: verification.queries,
          source_url:
            preferredOfficialSource(verification.sources)?.uri ?? null,
          source_domain:
            preferredOfficialSource(verification.sources)?.title ?? null,
          source_reliability:
            officialGrounding ? "official" : "unknown",
          auto_verification_eligible: false,
        });
        continue;
      }

      const authorityId = await promoteWebAuthority(
        supabase,
        apiKey,
        staged.id,
        candidate,
        verification,
        safeVerifiedTags,
      );
      promoted.push(authorityId);
    } catch (error) {
      console.error("[legal-research] verification skipped", error);
      await updateCandidate(supabase, staged.id, {
        verification_notes:
          `Verification teknik hata: ${error?.message ?? String(error)}`,
      });
    }
  }

  await refreshModules(supabase);

  const uniqueObservedQueries = uniqueStrings(observedSearchQueries);

  return {
    candidateCount,
    promotedAuthorityIds: uniqueStrings(promoted),
    searchQueries: uniqueObservedQueries,
    groundingSourceCount,
    searchUsed:
      groundingSourceCount > 0 ||
      uniqueObservedQueries.length > 0 ||
      promoted.length > 0,
  };
}

function safeCaseContext(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};

  const allowed = [
    "opposedMark",
    "earlierMark",
    "opposedClasses",
    "earlierClasses",
    "goodsRetailPairs",
    "lawyerFindings",
    "legalBasis",
    "notes",
  ];

  const result = {};
  for (const key of allowed) {
    if (key in source) result[key] = source[key];
  }
  return result;
}

async function createRun(supabase, body, issueTags, userId) {
  const { data, error } = await supabase
    .from("legal_research_runs")
    .insert({
      task_id: body?.taskId ? String(body.taskId) : null,
      opposition_case_id:
        body?.oppositionCaseId ? String(body.oppositionCaseId) : null,
      package_version: PACKAGE_VERSION,
      status: "started",
      requested_issue_tags: issueTags,
      resolved_issue_tags: [],
      missing_issue_tags: issueTags,
      coverage_score: 0,
      corpus_authority_ids: [],
      module_ids: [],
      google_search_used: false,
      google_search_queries: 0,
      telemetry: {
        packageVersion: PACKAGE_VERSION,
        requestedBy: userId,
      },
      request_payload: {
        issueTags,
        caseContext: safeCaseContext(body?.caseContext),
        allowWebSearch: body?.allowWebSearch !== false,
        autoVerify: body?.autoVerify !== false,
        requireCompleteCoverage: body?.requireCompleteCoverage !== false,
        minCaseAuthorities:
          body?.minCaseAuthorities ?? DEFAULT_MIN_CASE_AUTHORITIES,
      },
    })
    .select("id")
    .single();

  if (error) throw new Error(`Research run insert: ${error.message}`);
  return data.id;
}

async function updateRun(supabase, id, patch) {
  const { error } = await supabase
    .from("legal_research_runs")
    .update(patch)
    .eq("id", id);
  if (error) throw new Error(`Research run update: ${error.message}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { ok: false, packageVersion: PACKAGE_VERSION, error: "Yalnız POST." },
      405,
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY") ?? "";

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(
      { ok: false, packageVersion: PACKAGE_VERSION, error: "Supabase env eksik." },
      500,
    );
  }

  let auth;
  try {
    auth = await authenticate(req, supabaseUrl, anonKey);
  } catch {
    return jsonResponse(
      { ok: false, packageVersion: PACKAGE_VERSION, error: "Geçerli oturum gerekli." },
      401,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const action = String(body?.action ?? "research");

  if (action === "stats") {
    const { data, error } = await supabase.rpc("legal_intelligence_stats");
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, packageVersion: PACKAGE_VERSION, stats: data });
  }

  if (action !== "research") {
    return jsonResponse(
      { ok: false, packageVersion: PACKAGE_VERSION, error: "action: research veya stats" },
      400,
    );
  }

  if (!geminiApiKey) {
    return jsonResponse(
      { ok: false, packageVersion: PACKAGE_VERSION, error: "GEMINI_API_KEY yok." },
      500,
    );
  }

  const issueTags = uniqueStrings(body?.issueTags);
  if (!issueTags.length) {
    return jsonResponse(
      { ok: false, packageVersion: PACKAGE_VERSION, error: "issueTags gerekli." },
      400,
    );
  }

  const threshold = clamp(
    body?.coverageThreshold,
    0,
    1,
    Number.isFinite(COVERAGE_THRESHOLD) ? COVERAGE_THRESHOLD : 0.75,
  );
  const allowWebSearch = body?.allowWebSearch !== false;
  const autoVerify = body?.autoVerify !== false;
  const requireCompleteCoverage = body?.requireCompleteCoverage !== false;
  const minCaseAuthorities = Math.max(
    0,
    Math.min(
      6,
      Number(
        body?.minCaseAuthorities ??
        DEFAULT_MIN_CASE_AUTHORITIES
      ) || 0,
    ),
  );
  const caseContext = safeCaseContext(body?.caseContext);

  let runId = null;

  try {
    runId = await createRun(supabase, body, issueTags, auth.userId);

    let pack = await authorityPack(supabase, issueTags);
    const initialCoverage = Number(pack?.coverageScore ?? 0);
    const initialMissing = uniqueStrings(pack?.missingIssueTags);
    const initialCaseAuthorityCount = countCaseAuthorities(pack);

    let corpusPromoted = [];

    const shouldResearchCorpus =
      initialMissing.length > 0 &&
      (
        requireCompleteCoverage ||
        initialCoverage < threshold
      );

    if (shouldResearchCorpus) {
      corpusPromoted = await enrichMissingFromCorpus(
        supabase,
        geminiApiKey,
        initialMissing,
      );
      pack = await authorityPack(supabase, issueTags);
    }

    const afterCorpusCoverage = Number(pack?.coverageScore ?? 0);
    const afterCorpusMissing = uniqueStrings(pack?.missingIssueTags);
    const afterCorpusCaseAuthorityCount = countCaseAuthorities(pack);
    const afterCorpusCaseLawGapTags = caseLawGapTags(pack, issueTags);

    const webResearchTags = orderedResearchTags(
      afterCorpusMissing,
      afterCorpusCaseLawGapTags,
    );

    const needsCoverageResearch =
      afterCorpusMissing.length > 0 &&
      (
        requireCompleteCoverage ||
        afterCorpusCoverage < threshold
      );

    const needsAuthorityDepthResearch =
      minCaseAuthorities > 0 &&
      afterCorpusCaseAuthorityCount < minCaseAuthorities &&
      webResearchTags.length > 0;

    const shouldResearchWeb =
      allowWebSearch &&
      (
        needsCoverageResearch ||
        needsAuthorityDepthResearch
      );

    let webResult = {
      candidateCount: 0,
      promotedAuthorityIds: [],
      searchQueries: [],
      groundingSourceCount: 0,
      searchUsed: false,
    };

    if (shouldResearchWeb) {
      await updateRun(supabase, runId, {
        status: "searching",
        google_search_used: true,
      });

      webResult = await researchWeb(
        supabase,
        geminiApiKey,
        runId,
        webResearchTags,
        caseContext,
        autoVerify,
      );

      pack = await authorityPack(supabase, issueTags);
    }

    const finalCoverage = Number(pack?.coverageScore ?? 0);
    const finalCovered = uniqueStrings(pack?.coveredIssueTags);
    const finalMissing = uniqueStrings(pack?.missingIssueTags);
    const finalCaseAuthorityCount = countCaseAuthorities(pack);
    const finalCaseLawGapTags = caseLawGapTags(pack, issueTags);

    await updateRun(supabase, runId, {
      status:
        webResult.searchUsed
          ? "completed"
          : finalCoverage >= threshold
          ? "corpus_only"
          : "completed",
      resolved_issue_tags: finalCovered,
      missing_issue_tags: finalMissing,
      coverage_score: finalCoverage,
      google_search_used: webResult.searchUsed,
      google_search_queries: webResult.searchQueries.length,
      authority_pack: pack,
      telemetry: {
        packageVersion: PACKAGE_VERSION,
        googleSearchQueries: webResult.searchQueries,
        googleGroundingSourceCount: webResult.groundingSourceCount,
        googleSearchUsed: webResult.searchUsed,
        requireCompleteCoverage,
        minCaseAuthorities,
        initialCaseAuthorityCount,
        afterCorpusCaseAuthorityCount,
        finalCaseAuthorityCount,
        webResearchTags,
        finalCaseLawGapTags,
      },
      web_candidates_count: webResult.candidateCount,
      verified_web_authorities_count: webResult.promotedAuthorityIds.length,
      promoted_authority_ids: webResult.promotedAuthorityIds.filter(isUuid),
      completed_at: new Date().toISOString(),
    });

    return jsonResponse({
      ok: true,
      packageVersion: PACKAGE_VERSION,
      researchRunId: runId,
      routing: {
        threshold,
        requireCompleteCoverage,
        minCaseAuthorities,
        initialCoverage,
        initialMissing,
        initialCaseAuthorityCount,
        afterCorpusCoverage,
        afterCorpusMissing,
        afterCorpusCaseAuthorityCount,
        afterCorpusCaseLawGapTags,
        webResearchTags,
        webResearchAttempted: shouldResearchWeb,
        finalCoverage,
        finalMissing,
        finalCaseAuthorityCount,
        finalCaseLawGapTags,
        authorityDepthSatisfied:
          finalCaseAuthorityCount >= minCaseAuthorities,
        webSearchUsed: webResult.searchUsed,
        autoVerify,
      },
      corpus: {
        promotedPropositionIds: corpusPromoted,
      },
      web: webResult,
      authorityPack: pack,
    });
  } catch (error) {
    const message = error?.message ?? String(error);
    console.error("[legal-research] fatal", error);

    if (runId) {
      try {
        await updateRun(supabase, runId, {
          status: "failed",
          error_message: message,
          completed_at: new Date().toISOString(),
        });
      } catch (updateError) {
        console.error("[legal-research] failed-run update", updateError);
      }
    }

    return jsonResponse(
      {
        ok: false,
        packageVersion: PACKAGE_VERSION,
        researchRunId: runId,
        error: message,
      },
      500,
    );
  }
});
