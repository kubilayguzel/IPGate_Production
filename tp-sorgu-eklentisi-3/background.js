// TP EPATS Otomasyon - background.js
// v3.2.5 - duplicate PDF capture koruması + top-frame mesajlaşma

let activeJobTabId = null;
let pdfReceiverTabId = null;
const dispatchedCaptureIds = new Set();
const recentPdfUrls = new Map();
const PDF_URL_DEDUP_MS = 15000;

function rememberRecentPdfUrl(url) {
  const now = Date.now();
  for (const [key, ts] of recentPdfUrls.entries()) {
    if (now - ts > PDF_URL_DEDUP_MS * 4) recentPdfUrls.delete(key);
  }
  const previous = recentPdfUrls.get(url) || 0;
  if (now - previous < PDF_URL_DEDUP_MS) return false;
  recentPdfUrls.set(url, now);
  return true;
}

async function claimPdfDispatch(url) {
  const state = await chrome.storage.local.get([
    "tp_pdf_capture_id",
    "tp_pdf_dispatched_capture_id",
    "tp_waiting_pdf_url"
  ]);

  const captureId = state.tp_pdf_capture_id || null;

  // Detay sayfasındaki her indirme tıklaması benzersiz bir captureId üretir.
  // Aynı click'ten tabs.onUpdated + webRequest veya redirect üzerinden birden
  // fazla PDF olayı gelse bile yalnızca ilkini receiver'a gönder.
  if (captureId) {
    if (!state.tp_waiting_pdf_url) {
      console.log("[BG] PDF olayı beklenmiyor; atlandı:", captureId, url);
      return { ok: false, captureId };
    }

    if (
      dispatchedCaptureIds.has(captureId) ||
      state.tp_pdf_dispatched_capture_id === captureId
    ) {
      console.log("[BG] Aynı PDF capture tekrar yakalandı; atlandı:", captureId, url);
      return { ok: false, captureId };
    }

    // In-memory claim'i await'ten önce al; eşzamanlı iki event aynı storage
    // değerini okusa bile ikinci callback burada durur. Storage kaydı ise
    // service worker yeniden başlarsa koruma sağlamaya devam eder.
    dispatchedCaptureIds.add(captureId);
    await chrome.storage.local.set({ tp_pdf_dispatched_capture_id: captureId });
    return { ok: true, captureId };
  }

  // Eski / captureId'siz akışlar için kısa süreli URL dedup fallback'i.
  return { ok: rememberRecentPdfUrl(url), captureId: null };
}

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

async function sendPdfUrlToReceiver(url) {
  const claim = await claimPdfDispatch(url);
  if (!claim.ok) return;

  const targetTabId = await getPdfReceiverTabId();
  if (!targetTabId) {
    console.warn("[BG] PDF bulundu fakat alıcı sekme yok:", url);
    return;
  }

  await ensureContentScript(targetTabId);

  const message = {
    action: "PDF_URL_CAPTURED",
    url,
    captureId: claim.captureId
  };

  // Mesajı yalnızca top frame'e gönder. Manifest de all_frames=false,
  // fakat frameId:0 ikinci bir güvenlik katmanı olarak tutuluyor.
  chrome.tabs.sendMessage(
    targetTabId,
    message,
    { frameId: 0 },
    async (resp) => {
      if (!chrome.runtime.lastError) {
        console.log("[BG] PDF URL alıcıya gönderildi:", targetTabId, claim.captureId, resp);
        return;
      }

      console.warn("[BG] sendMessage FAIL:", chrome.runtime.lastError.message);
      await ensureContentScript(targetTabId);

      chrome.tabs.sendMessage(
        targetTabId,
        message,
        { frameId: 0 },
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
  if (tabId === activeJobTabId || tabId === pdfReceiverTabId) return;

  setTimeout(() => {
    chrome.tabs.remove(tabId).catch(() => {});
  }, 1500);
}

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  if (request.action !== "START_QUEUE") return;

  const fallbackUrl =
    "https://kadxvkejzctwymzeyrrl.supabase.co/functions/v1/save-epats-document";

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
      tp_pdf_capture_id: null,
      tp_pdf_dispatched_capture_id: null,
      tp_pdf_capture_consumed: false
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
      if (sender?.frameId != null && sender.frameId !== 0) {
        sendResponse({ ok: false, ignored: true, reason: "non_top_frame" });
        return;
      }
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

  console.log("[BG] PDF sekmesi yakalandı:", url);

  await sendPdfUrlToReceiver(url);
  await maybeClosePdfTab(tabId);
});

chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.tabId == null || details.tabId < 0) return;
    if (!hasPdfContentType(details.responseHeaders)) return;

    const url = details.url;
    if (!url) return;

    console.log("[BG] PDF yakalandı (Content-Type):", url);
    await sendPdfUrlToReceiver(url);
    await maybeClosePdfTab(details.tabId);
  },
  { urls: EPATS_HOST_PATTERNS },
  ["responseHeaders"]
);
