// TP EPATS Otomasyon - background.js
// v3.2.8 - PDF capture dedupe + PDF sekmesini her durumda kapatma düzeltmesi

let activeJobTabId = null;
let pdfReceiverTabId = null;
let lastPdfUrl = null;
let lastPdfUrlAt = 0;

const PDF_DEDUPE_WINDOW_MS = 15000;

const EPATS_HOST_PATTERNS = [
  "https://epats.turkpatent.gov.tr/*",
  "https://epats2.turkpatent.gov.tr/*"
];

async function loadRuntimeTabIds() {
  const data = await chrome.storage.local.get([
    "tp_active_job_tab_id",
    "tp_pdf_receiver_tab_id"
  ]);

  if (!activeJobTabId && data.tp_active_job_tab_id) {
    activeJobTabId = Number(data.tp_active_job_tab_id);
  }
  if (!pdfReceiverTabId && data.tp_pdf_receiver_tab_id) {
    pdfReceiverTabId = Number(data.tp_pdf_receiver_tab_id);
  }
}

async function ensureContentScript(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content_script.js"]
    });
  } catch (e) {
    // Content script manifest üzerinden zaten yüklenmiş olabilir.
    console.warn("[BG] content_script inject warning:", e?.message || e);
  }
}

async function getPdfReceiverTabId() {
  await loadRuntimeTabIds();
  return pdfReceiverTabId || activeJobTabId || null;
}

function isRecentDuplicatePdfUrl(url) {
  const now = Date.now();
  const isDuplicate =
    Boolean(url) &&
    url === lastPdfUrl &&
    now - lastPdfUrlAt < PDF_DEDUPE_WINDOW_MS;

  if (!isDuplicate) {
    lastPdfUrl = url;
    lastPdfUrlAt = now;
  }

  return isDuplicate;
}

async function sendPdfUrlToReceiver(url) {
  const targetTabId = await getPdfReceiverTabId();
  if (!targetTabId) {
    console.warn("[BG] PDF bulundu fakat alıcı sekme yok:", url);
    return;
  }

  await ensureContentScript(targetTabId);

  chrome.tabs.sendMessage(
    targetTabId,
    { action: "PDF_URL_CAPTURED", url },
    async (resp) => {
      if (!chrome.runtime.lastError) {
        console.log("[BG] PDF URL alıcıya gönderildi:", targetTabId, resp);
        return;
      }

      console.warn("[BG] sendMessage FAIL:", chrome.runtime.lastError.message);
      await ensureContentScript(targetTabId);

      chrome.tabs.sendMessage(
        targetTabId,
        { action: "PDF_URL_CAPTURED", url },
        (resp2) => {
          if (chrome.runtime.lastError) {
            console.warn("[BG] sendMessage RETRY FAIL:", chrome.runtime.lastError.message);
          } else {
            console.log("[BG] sendMessage RETRY OK:", resp2);
          }
        }
      );
    }
  );
}

async function maybeClosePdfTab(tabId) {
  await loadRuntimeTabIds();
  if (!tabId || tabId < 0) return;

  // Ana kuyruk sekmesini veya aktif doküman-detay alıcı sekmesini burada
  // kapatmıyoruz. Detay sekmesi kendi akışı sonunda CLOSE_CURRENT_TAB ile kapanır.
  if (tabId === activeJobTabId || tabId === pdfReceiverTabId) return;

  setTimeout(() => {
    chrome.tabs.remove(tabId).catch(() => {});
  }, 1500);
}

/**
 * Aynı PDF URL'si hem webRequest hem de tabs.onUpdated tarafından görülebilir.
 *
 * Önemli ayrım:
 * - URL'yi receiver'a yalnızca bir kez gönder.
 * - Fakat duplicate event başka bir PDF sekmesine aitse o sekmeyi yine de kapat.
 *
 * Eski akışta "aynı URL" kontrolü tab kapatma işleminden önce return ettiği için,
 * webRequest detay sekmesinde URL'yi önce yakaladığında sonradan açılan PDF sekmesi
 * bazen açık kalabiliyordu.
 */
async function handlePdfCapture(url, tabId, source) {
  if (!url) return;

  const duplicate = isRecentDuplicatePdfUrl(url);

  if (!duplicate) {
    console.log(`[BG] PDF yakalandı (${source}):`, url);
    await sendPdfUrlToReceiver(url);
  } else {
    console.log(`[BG] Aynı PDF tekrar yakalandı (${source}); upload tekrar tetiklenmedi.`);
  }

  // Duplicate olsa dahi yeni açılmış PDF sekmesini kapatma kontrolü yapılır.
  await maybeClosePdfTab(tabId);
}

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  if (request.action !== "START_QUEUE") return;

  const fallbackUrl =
    "https://kadxvkejzctwymzeyrrl.supabase.co/functions/v1/save-epats-document";

  // Yeni kuyrukta önceki PDF dedupe state'ini temizle.
  lastPdfUrl = null;
  lastPdfUrlAt = 0;

  chrome.storage.local.set(
    {
      tp_queue: request.queue,
      tp_is_queue_running: true,
      tp_queue_index: 0,
      tp_app_no: null,
      tp_upload_url: request.uploadUrl || fallbackUrl,
      tp_token: request.token,
      tp_active_job_tab_id: null,
      tp_pdf_receiver_tab_id: null,
      tp_processed_upper_keys: [],
      tp_waiting_detail: false,
      tp_current_upper_key: null,
      tp_job_saved_count: 0,
      tp_current_file_name: null,
      tp_finish_current_job: false
    },
    () => {
      chrome.tabs.create(
        { url: "https://epats.turkpatent.gov.tr/run/TP/EDEVLET/giris" },
        async (tab) => {
          activeJobTabId = tab.id;
          await chrome.storage.local.set({ tp_active_job_tab_id: tab.id });
          await ensureContentScript(tab.id);
        }
      );
      sendResponse({ status: "started" });
    }
  );

  return true;
});

// Content script'lerin kullandığı dahili mesajlar.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    if (request?.action === "REGISTER_PDF_RECEIVER") {
      const tabId = sender?.tab?.id;
      if (tabId) {
        pdfReceiverTabId = tabId;
        await chrome.storage.local.set({ tp_pdf_receiver_tab_id: tabId });
      }
      sendResponse({ ok: true, tabId });
      return;
    }

    if (request?.action === "OPEN_DETAIL_URL" && request?.url) {
      const tab = await chrome.tabs.create({ url: request.url, active: true });
      sendResponse({ ok: true, tabId: tab.id });
      return;
    }

    if (request?.action === "CLOSE_CURRENT_TAB") {
      const tabId = sender?.tab?.id;
      if (tabId) {
        if (pdfReceiverTabId === tabId) pdfReceiverTabId = null;
        await chrome.storage.local.set({ tp_pdf_receiver_tab_id: null });
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 250);
      }
      sendResponse({ ok: true });
      return;
    }
  })().catch((err) => {
    console.error("[BG] Internal message error:", err);
    try { sendResponse({ ok: false, error: err?.message || String(err) }); } catch (_) {}
  });

  return true;
});

function hasPdfContentType(headers = []) {
  const h = headers.find(x => (x.name || "").toLowerCase() === "content-type");
  const v = (h?.value || "").toLowerCase();
  return v.includes("application/pdf");
}

function isPdfLikeUrl(url = "") {
  const lower = String(url).toLowerCase();
  return (
    lower.includes("/project/downloadfile/") ||
    (lower.includes("/run/tp/") && lower.includes("pdf")) ||
    lower.endsWith(".pdf") ||
    lower.includes("download") && lower.includes("dokuman")
  );
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url) return;

  if (url.includes("epats2.turkpatent.gov.tr/run/TP/dokumanlar/")) {
    await ensureContentScript(tabId);
  }

  if (!isPdfLikeUrl(url)) return;

  await handlePdfCapture(url, tabId, "tabs.onUpdated");
});

chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.tabId == null || details.tabId < 0) return;
    if (!hasPdfContentType(details.responseHeaders)) return;

    await handlePdfCapture(details.url, details.tabId, "Content-Type");
  },
  { urls: EPATS_HOST_PATTERNS },
  ["responseHeaders"]
);
