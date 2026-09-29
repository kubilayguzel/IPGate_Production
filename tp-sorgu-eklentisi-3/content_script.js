// TP EPATS Otomasyon - content_script.js
// v3.2.4
// Yeni akış:
// 1) Belgelerim'de başvuru no ile arama
// 2) İşlem Tipi = "Üst Yazı" veya "Tescil belgesi ve üst yazısı" olan satırları sırayla açma
// 3) epats2 doküman ekranında Dosya Adı içinde hedef belge adlarını bulma
//    - "Tescil belgesi ve üst yazısı" için ayrıca TB_ desenini kabul etme
// 4) İndirme ikonuna basıp PDF'i IPGate/Supabase'e kaydetme
// 5) Aynı başvurudaki tüm Üst Yazılar bittikten sonra kuyruğu ilerletme

(() => {
  if (window.TP_SCRIPT_ALREADY_LOADED) {
    console.log("[TP-AUTO] ♻️ Script zaten yüklü.");
    return;
  }
  window.TP_SCRIPT_ALREADY_LOADED = true;

  const TAG = "[TP-AUTO]";
  const DEFAULT_UPLOAD_ENDPOINT =
    "https://kadxvkejzctwymzeyrrl.supabase.co/functions/v1/save-epats-document";

  const TARGET_OPERATION_PATTERNS = [
    "ust yazi",
    "tescil belgesi ve ust yazisi"
  ];

  const TARGET_FILE_PATTERNS = [
    "marka yenileme belgesi",
    "tescil belgesitb",
    "myb"
  ];

  let isActionInProgress = false;
  let globalProcessingLock = false;
  let isAdvancing = false;
  let lastProcessedUrl = null;
  let mainRunLock = false;

  let pendingPdfResolver = null;
  let pendingPdfTimer = null;

  console.log(TAG, "Content script loaded:", location.href);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeText(value) {
    return String(value || "")
      .toLocaleLowerCase("tr-TR")
      .replace(/ı/g, "i")
      .replace(/ş/g, "s")
      .replace(/ğ/g, "g")
      .replace(/ü/g, "u")
      .replace(/ö/g, "o")
      .replace(/ç/g, "c")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function compactText(value) {
    return normalizeText(value).replace(/[^a-z0-9]/g, "");
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function qAll(selector) {
    const docs = [document];
    document.querySelectorAll("iframe").forEach((fr) => {
      try {
        if (fr.contentDocument) docs.push(fr.contentDocument);
      } catch (_) {}
    });

    for (const d of docs) {
      const el = d.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function qAllMany(selector) {
    let out = [];
    const docs = [document];
    document.querySelectorAll("iframe").forEach((fr) => {
      try {
        if (fr.contentDocument) docs.push(fr.contentDocument);
      } catch (_) {}
    });

    for (const d of docs) {
      out = out.concat(Array.from(d.querySelectorAll(selector)));
    }
    return out;
  }

  function superClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (_) {}

    // Yeni EPATS2 ekranında bazı ikonlar doğrudan <a>/<button> değil;
    // Angular/JS click listener'ı span/svg/img gibi bir alt elemana bağlı olabiliyor.
    // Gerçek kullanıcı tıklamasına daha yakın bir event dizisi gönderiyoruz.
    try {
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      el.dispatchEvent(new MouseEvent("mouseover", opts));
      el.dispatchEvent(new MouseEvent("mouseenter", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
      if (typeof el.click === "function") el.click();
      return true;
    } catch (_) {
      try {
        if (typeof el.click === "function") {
          el.click();
          return true;
        }
      } catch (_) {}
      return false;
    }
  }

  function fillInputAngularSafe(input, value) {
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    return true;
  }

  async function throttle(key, ms) {
    const now = Date.now();
    const obj = await chrome.storage.local.get([key]);
    if (now - (obj[key] || 0) < ms) return false;
    await chrome.storage.local.set({ [key]: now });
    return true;
  }

  function sendInternalMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: true });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  async function getUploadEndpoint() {
    const { tp_upload_url } = await chrome.storage.local.get(["tp_upload_url"]);
    return tp_upload_url || DEFAULT_UPLOAD_ENDPOINT;
  }

  function sanitizeFileName(name, appNo) {
    let result = String(name || `tescil_belgesi_${appNo || "evrak"}.pdf`).trim();
    if (!/\.pdf$/i.test(result)) result += ".pdf";
    return result.replace(/[^a-zA-Z0-9çÇğĞıİöÖşŞüÜ.\-_ ]/g, "_").replace(/\s+/g, "_");
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onloadend = () => resolve((reader.result || "").split(",")[1] || "");
      reader.readAsDataURL(blob);
    });
  }

  async function processDocument(downloadUrl, options = {}) {
    const advanceQueueAfter = options.advanceQueueAfter === true;
    console.log(TAG, "📄 PDF indiriliyor:", downloadUrl);

    try {
      const response = await fetch(downloadUrl, { credentials: "include" });
      if (!response.ok) throw new Error("HTTP " + response.status);

      const blob = await response.blob();
      if (!blob.size) throw new Error("Boş dosya");

      const base64data = await blobToBase64(blob);
      if (!base64data || base64data.length < 1000) throw new Error("Base64 geçersiz");

      const storage = await chrome.storage.local.get([
        "tp_current_job_id",
        "tp_current_doc_type",
        "tp_token",
        "tp_app_no",
        "tp_current_file_name"
      ]);

      const fileName = sanitizeFileName(
        options.fileName || storage.tp_current_file_name,
        storage.tp_app_no
      );

      const payload = {
        ipRecordId: storage.tp_current_job_id,
        fileBase64: base64data,
        fileName,
        mimeType: "application/pdf",
        docType: storage.tp_current_doc_type || "45",
        appNo: storage.tp_app_no
      };

      const endpoint = await getUploadEndpoint();
      console.log(TAG, "📤 Upload başlıyor:", payload.ipRecordId, fileName);

      const uploadRes = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${storage.tp_token}`
        },
        body: JSON.stringify(payload)
      });

      if (!uploadRes.ok) {
        const errorText = await uploadRes.text();
        throw new Error(`Upload hatası (${uploadRes.status}): ${errorText}`);
      }

      console.log(TAG, "✅ PDF IPGate'e kaydedildi:", fileName);

      if (advanceQueueAfter) await advanceQueue();
      return true;
    } catch (error) {
      console.error(TAG, "❌ PDF işleme hatası:", error);
      if (advanceQueueAfter) await advanceQueue();
      return false;
    }
  }

  function resolvePendingPdf(result) {
    if (pendingPdfTimer) {
      clearTimeout(pendingPdfTimer);
      pendingPdfTimer = null;
    }
    if (pendingPdfResolver) {
      const resolver = pendingPdfResolver;
      pendingPdfResolver = null;
      resolver(Boolean(result));
    }
  }

  function waitForPdfProcessed(timeoutMs = 20000) {
    if (pendingPdfTimer) clearTimeout(pendingPdfTimer);
    pendingPdfResolver = null;

    return new Promise((resolve) => {
      pendingPdfResolver = resolve;
      pendingPdfTimer = setTimeout(() => {
        pendingPdfTimer = null;
        pendingPdfResolver = null;
        resolve(false);
      }, timeoutMs);
    });
  }

  function isDetailPage() {
    return (
      location.hostname === "epats2.turkpatent.gov.tr" ||
      location.href.includes("/run/TP/dokumanlar/")
    );
  }

  // PDF URL background tarafından yakalandığında aktif alıcı sekmede işlenir.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action !== "PDF_URL_CAPTURED" || !request?.url) return;

    sendResponse({ ok: true });

    if (request.url === lastProcessedUrl) return true;
    if (globalProcessingLock) return true;

    globalProcessingLock = true;
    lastProcessedUrl = request.url;

    (async () => {
      try {
        const storage = await chrome.storage.local.get([
          "tp_waiting_pdf_url",
          "tp_current_file_name"
        ]);

        if (!storage.tp_waiting_pdf_url && isDetailPage()) {
          globalProcessingLock = false;
          return;
        }

        await chrome.storage.local.set({ tp_waiting_pdf_url: false });

        const ok = await processDocument(request.url, {
          advanceQueueAfter: !isDetailPage(),
          fileName: storage.tp_current_file_name || null
        });

        resolvePendingPdf(ok);
      } catch (err) {
        console.error(TAG, "PDF_URL_CAPTURED hatası:", err);
        resolvePendingPdf(false);
      } finally {
        globalProcessingLock = false;
      }
    })();

    return true;
  });

  if (window.top !== window) return;

  document.addEventListener("TP_RESET", async () => {
    try { await chrome.storage.local.clear(); } catch (_) {}
  });

  // ---------------------------------------------------------------------------
  // ORTAK TABLO / KOLON YARDIMCILARI
  // ---------------------------------------------------------------------------

  function getCells(row) {
    if (!row) return [];
    let cells = Array.from(row.querySelectorAll(":scope > td, :scope > th"));
    if (cells.length) return cells;

    cells = Array.from(row.querySelectorAll(".ui-grid-cell, [role='gridcell'], [role='cell']"));
    return cells;
  }

  function getHeaderCellsForRow(row) {
    const table = row?.closest?.("table");
    if (table) {
      const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
      if (headerRow) {
        const cells = Array.from(headerRow.querySelectorAll("th, [role='columnheader']"));
        if (cells.length) return cells;
      }
    }

    const gridHeaders = qAllMany(".ui-grid-header-cell, [role='columnheader']").filter(isVisible);
    return gridHeaders;
  }

  function findColumnIndex(row, label) {
    const wanted = normalizeText(label);
    const headers = getHeaderCellsForRow(row);
    return headers.findIndex((h) => normalizeText(h.innerText || h.textContent).includes(wanted));
  }

  function getCellText(row, label) {
    const cells = getCells(row);
    const idx = findColumnIndex(row, label);
    if (idx >= 0 && cells[idx]) return (cells[idx].innerText || cells[idx].textContent || "").trim();
    return "";
  }

  function getScrollableAncestor(el) {
    let current = el?.parentElement || null;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        current.scrollHeight > current.clientHeight + 10
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // EPATS2 DETAY SAYFASI: DOSYA ADINA GÖRE PDF BUL / KAYDET
  // ---------------------------------------------------------------------------

  function getDetailRows() {
    // EPATS2'nin güncel doküman ekranındaki gerçek satır yapısı.
    // Örn: <tr class="bmm-table-row" ng-repeat="value in _datasource ...">
    const epats2Rows = qAllMany("tr.bmm-table-row").filter((r) => getCells(r).length > 0 && isVisible(r));
    if (epats2Rows.length) return epats2Rows;

    const tableRows = qAllMany("table tbody tr").filter((r) => getCells(r).length > 0 && isVisible(r));
    if (tableRows.length) return tableRows;

    const roleRows = qAllMany("[role='row']").filter((r) => {
      if (!isVisible(r)) return false;
      if (r.querySelector("[role='columnheader']")) return false;
      return getCells(r).length > 0;
    });
    if (roleRows.length) return roleRows;

    return qAllMany(".ui-grid-row").filter(isVisible);
  }

  function getDetailFileName(row, options = {}) {
    const byHeader = getCellText(row, "Dosya Adı") || getCellText(row, "Dosya Adi");
    if (byHeader && isTargetFileName(byHeader, options)) return byHeader;

    // Header eşleşmesi yeni EPATS2 tablosunda kolon yapısı nedeniyle şaşarsa,
    // hedef ifadeyi içeren hücreyi doğrudan bul. Örn:
    // "Ek1 Tescil Belgesitb_2022_005861..pdf"
    const cells = getCells(row);
    for (const cell of cells) {
      const text = (cell.innerText || cell.textContent || "").trim();
      if (text && isTargetFileName(text, options)) return text;
    }

    if (byHeader) return byHeader;

    const nonEmpty = cells
      .map((c) => (c.innerText || c.textContent || "").trim())
      .filter(Boolean);
    return nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : (row.innerText || row.textContent || "").trim();
  }

  function isTargetFileName(name, options = {}) {
    const normal = normalizeText(name);
    const compact = compactText(name);
    const allowTbPrefix = Boolean(options.allowTbPrefix);

    return (
      normal.includes("marka yenileme belgesi") ||
      compact.includes("markayenilemebelgesi") ||
      compact.includes("tescilbelgesitb") ||
      compact.includes("myb") ||
      // Yalnızca ana ekranda "Tescil belgesi ve üst yazısı" işlem tipinden
      // gelindiyse TB_ ile adlandırılan dosyaları da hedef kabul et.
      // Örn: "tescil belgesi TB_2015_52633.pdf"
      (allowTbPrefix && normal.includes("tb_"))
    );
  }

  function rowContainsTargetFile(row, options = {}) {
    if (!row) return false;
    if (isTargetFileName(getDetailFileName(row, options), options)) return true;
    // Son emniyet: kolon indeksleri/başlıkları beklenmedikse tüm satır metnini tara.
    return isTargetFileName(row.innerText || row.textContent || "", options);
  }

  function findDownloadClickable(row) {
    const cells = getCells(row);
    const firstCell = cells[0] || row;

    // 1) EPATS2 güncel DOM yapısı (29.09.2026):
    // <div style="...cursor:pointer..." ng-click="$parent.$parent.dokumanIndir(value);">
    //   <i class="fa fa-download"></i>
    // </div>
    // İkonun kendisine değil Angular ng-click taşıyan wrapper'a basmak gerekir.
    const epats2DownloadControl =
      firstCell.querySelector("[ng-click*='dokumanIndir'], [data-ng-click*='dokumanIndir']") ||
      row.querySelector("[ng-click*='dokumanIndir'], [data-ng-click*='dokumanIndir']");
    if (epats2DownloadControl) return epats2DownloadControl;

    // 2) Bilinen download selector'ları (eski/yeni EPATS varyasyonları)
    const knownIcon = row.querySelector(
      "i.fa-download, i.fas.fa-download, i.far.fa-download, " +
      ".glyphicon-download, .glyphicon-download-alt, " +
      "[class*='download'], [class*='Download'], " +
      "[title*='ndir'], [title*='İndir'], [title*='Indir'], " +
      "[aria-label*='ndir'], [aria-label*='İndir'], [aria-label*='Indir'], " +
      "img[src*='download'], img[src*='Download'], svg[class*='download']"
    );

    if (knownIcon) {
      return knownIcon.closest("a, button, [ng-click], [data-ng-click], [onclick], [role='button'], [tabindex]") || knownIcon;
    }

    // 3) Yeni ekrandaki ikon ilk kolonda. Önce klasik tıklanabilir wrapper'ları ara.
    const directClickable = firstCell.querySelector(
      "a[href], button, [ng-click], [data-ng-click], [onclick], [role='button'], [tabindex]"
    );
    if (directClickable) return directClickable;

    // 4) Wrapper yoksa ikonun kendisini yakala. TÜRKPATENT bazı ekranlarda
    // click listener'ını doğrudan <i>/<span>/<svg>/<img> üzerine bağlıyor.
    const iconLike = firstCell.querySelector("i, svg, img, span, .fa, .fas, .far, .glyphicon");
    if (iconLike) {
      let node = iconLike;
      while (node && node !== firstCell && node !== row) {
        const style = window.getComputedStyle(node);
        if (
          style.cursor === "pointer" ||
          node.hasAttribute?.("ng-click") ||
          node.hasAttribute?.("data-ng-click") ||
          node.hasAttribute?.("onclick") ||
          node.getAttribute?.("role") === "button"
        ) {
          return node;
        }
        node = node.parentElement;
      }
      return iconLike;
    }

    // 5) İlk hücrenin kendisi tıklanabilir olabilir.
    try {
      const firstStyle = window.getComputedStyle(firstCell);
      if (firstStyle.cursor === "pointer") return firstCell;
    } catch (_) {}

    return null;
  }

  function getClickableHref(clickable) {
    if (!clickable) return null;
    const anchor = clickable.matches?.("a") ? clickable : clickable.closest?.("a");
    const raw = anchor?.getAttribute?.("href") || "";
    if (!raw || raw === "#" || raw.toLowerCase().startsWith("javascript:")) return null;
    try { return new URL(raw, location.href).href; } catch (_) { return null; }
  }

  async function waitForDetailRows(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rows = getDetailRows();
      if (rows.length > 0) return rows;
      await sleep(300);
    }
    return [];
  }

  async function markCurrentUpperWriteComplete(savedCount) {
    const state = await chrome.storage.local.get([
      "tp_processed_upper_keys",
      "tp_current_upper_key",
      "tp_job_saved_count"
    ]);

    const processed = Array.isArray(state.tp_processed_upper_keys)
      ? state.tp_processed_upper_keys.slice()
      : [];

    if (state.tp_current_upper_key && !processed.includes(state.tp_current_upper_key)) {
      processed.push(state.tp_current_upper_key);
    }

    await chrome.storage.local.set({
      tp_processed_upper_keys: processed,
      tp_waiting_detail: false,
      tp_current_upper_key: null,
      tp_current_upper_operation_type: null,
      tp_detail_open_ts: 0,
      tp_job_saved_count: Number(state.tp_job_saved_count || 0) + Number(savedCount || 0),
      tp_current_file_name: null,
      tp_waiting_pdf_url: false
    });
  }

  async function processDetailDownloadRow(row, fileName) {
    const clickable = findDownloadClickable(row);
    if (!clickable) {
      console.warn(TAG, "⚠️ Hedef belge bulundu ancak indirme ikonu bulunamadı:", fileName);
      return false;
    }

    const href = getClickableHref(clickable);

    lastProcessedUrl = null;
    globalProcessingLock = false;

    await chrome.storage.local.set({
      tp_current_file_name: fileName,
      tp_waiting_pdf_url: true
    });

    await sendInternalMessage({ action: "REGISTER_PDF_RECEIVER" });

    const waitPromise = waitForPdfProcessed(20000);
    console.log(TAG, "⬇️ İndirme ikonuna basılıyor:", fileName);

    // Güncel EPATS2'de Angular ng-click doğrudan wrapper div üzerinde.
    // Burada tek bir native click kullanıyoruz; superClick'in ek MouseEvent zinciri
    // aynı ng-click'in iki kez tetiklenmesine yol açmasın.
    const ngClickValue = clickable.getAttribute?.("ng-click") || clickable.getAttribute?.("data-ng-click") || "";
    if (ngClickValue.includes("dokumanIndir") && typeof clickable.click === "function") {
      clickable.scrollIntoView?.({ block: "center", inline: "nearest" });
      clickable.click();
    } else {
      superClick(clickable);
    }

    let ok = await waitPromise;

    // Bazı yeni ekranlarda link doğrudan href olarak geliyor fakat PDF isteği
    // webRequest tarafından yakalanmayabiliyor. Bu durumda href'i fallback olarak kullan.
    if (!ok && href) {
      console.warn(TAG, "⚠️ PDF yakalama zaman aşımı; href fallback deneniyor:", href);
      lastProcessedUrl = href;
      globalProcessingLock = true;
      ok = await processDocument(href, { advanceQueueAfter: false, fileName });
      globalProcessingLock = false;
    }

    await chrome.storage.local.set({
      tp_waiting_pdf_url: false,
      tp_current_file_name: null
    });

    return ok;
  }

  async function runDetailPageAutomation() {
    console.log(TAG, "📂 EPATS2 doküman detay ekranı algılandı.");

    await sendInternalMessage({ action: "REGISTER_PDF_RECEIVER" });

    const rows = await waitForDetailRows(15000);
    if (!rows.length) {
      console.warn(TAG, "⚠️ Detay sayfasında doküman satırı bulunamadı.");
      await markCurrentUpperWriteComplete(0);
      await sendInternalMessage({ action: "CLOSE_CURRENT_TAB" });
      return;
    }

    const detailState = await chrome.storage.local.get(["tp_current_upper_operation_type"]);
    const currentUpperOperationType = normalizeText(detailState.tp_current_upper_operation_type || "");
    const allowTbPrefix = currentUpperOperationType.includes("tescil belgesi ve ust yazisi");
    const fileMatchOptions = { allowTbPrefix };

    if (allowTbPrefix) {
      console.log(TAG, 'ℹ️ "Tescil belgesi ve üst yazısı" detayı: TB_ dosya adı kriteri de aktif.');
    }

    const targets = rows.filter((row) => rowContainsTargetFile(row, fileMatchOptions));
    console.log(TAG, `🎯 Detay sayfasında ${targets.length} hedef belge bulundu.`);

    if (!targets.length) {
      console.log(TAG, "ℹ️ Detay satırları (hedef bulunamadı):", rows.map((row) => ({
        fileName: getDetailFileName(row, fileMatchOptions),
        rowText: (row.innerText || row.textContent || "").trim()
      })));
    }

    let savedCount = 0;

    for (const row of targets) {
      const fileName = getDetailFileName(row, fileMatchOptions);
      if (!fileName) continue;

      try {
        const ok = await processDetailDownloadRow(row, fileName);
        if (ok) savedCount += 1;
      } catch (e) {
        console.error(TAG, "Detay belge işleme hatası:", e);
      }

      await sleep(500);
    }

    await markCurrentUpperWriteComplete(savedCount);
    console.log(TAG, `✅ Üst Yazı taraması tamamlandı. Kaydedilen belge: ${savedCount}`);
    await sleep(500);
    await sendInternalMessage({ action: "CLOSE_CURRENT_TAB" });
  }

  // EPATS2 detay sekmesinde ana kuyruk döngüsüne girme.
  if (isDetailPage()) {
    runDetailPageAutomation().catch(async (err) => {
      console.error(TAG, "❌ Detay sayfası otomasyon hatası:", err);
      try { await markCurrentUpperWriteComplete(0); } catch (_) {}
      try { await sendInternalMessage({ action: "CLOSE_CURRENT_TAB" }); } catch (_) {}
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // ANA EPATS SAYFASI / KUYRUK
  // ---------------------------------------------------------------------------

  function isGirisPage() {
    return location.href.includes("/run/TP/EDEVLET/giris");
  }

  function findLoginButtonOnGiris() {
    const direct = qAll('a[href*="turkiye.gov.tr"]');
    if (direct) return direct;

    return qAllMany("a,button").find((el) =>
      normalizeText(el.textContent).includes("giris")
    );
  }

  async function clickBelgelerim() {
    if (!(await throttle("tp_last_belgelerim_try", 3000))) return false;

    const targets = qAllMany("a, button, div[ng-click], li, span");
    const target = targets.find((el) => normalizeText(el.textContent).trim() === "belgelerim");
    if (target) {
      superClick(target);
      return true;
    }
    return false;
  }

  function findApplicationNumberInput() {
    const oldInput = qAll("#textbox551 input");
    if (oldInput) return oldInput;

    const inputs = qAllMany("input[type='text'], input:not([type])").filter(isVisible);

    const byContext = inputs.find((input) => {
      let node = input.parentElement;
      for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
        if (normalizeText(node.innerText).includes("basvuru numarasi")) return true;
      }
      return false;
    });

    return byContext || null;
  }

  function findSearchButton() {
    const oldRoot = qAll("#button549");
    if (oldRoot) {
      const oldBtn = oldRoot.querySelector("div.btn[ng-click]") || oldRoot.querySelector(".btn") || oldRoot;
      if (oldBtn) return oldBtn;
    }

    return qAllMany("button, a.btn, div.btn[ng-click]")
      .filter(isVisible)
      .find((el) => normalizeText(el.innerText || el.textContent).trim() === "ara") || null;
  }

  function isBelgelerimScreenOpen() {
    return Boolean(findApplicationNumberInput() && findSearchButton());
  }

  async function ensureDosyaTuruMarka() {
    const oldContainer = qAll("div.ui-select-container[name='selectbox550']");
    if (oldContainer) {
      if (normalizeText(oldContainer.innerText).includes("marka")) return true;
      if (!(await throttle("tp_last_select_try", 1000))) return false;

      const toggle = oldContainer.querySelector(".ui-select-toggle") || oldContainer;
      if (!oldContainer.classList.contains("open")) {
        superClick(toggle);
        await sleep(250);
      }

      const rows = qAllMany(".ui-select-choices-row");
      const markaRow = rows.find((el) => normalizeText(el.innerText).includes("marka"));
      if (markaRow) {
        superClick(markaRow);
        await sleep(350);
        return true;
      }
    }

    const selects = qAllMany("select").filter(isVisible);
    for (const select of selects) {
      const markaOption = Array.from(select.options || []).find((o) => normalizeText(o.textContent) === "marka");
      if (!markaOption) continue;
      if (select.value !== markaOption.value) {
        select.value = markaOption.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(300);
      }
      return true;
    }

    return false;
  }

  async function fillBasvuruNo(appNo) {
    const input = findApplicationNumberInput();
    if (!input) return false;

    if ((input.value || "").trim() !== String(appNo)) {
      fillInputAngularSafe(input, String(appNo));
      await sleep(300);
    }
    return true;
  }

  function isPageBusy() {
    const busySelectors = [
      ".modal-backdrop",
      ".block-ui-overlay",
      ".block-ui-message-container",
      ".loading-spinner",
      ".fa-spinner",
      ".fa-refresh.fa-spin",
      "div[ng-show='isLoading']",
      ".ui-grid-icon-spin"
    ];

    const els = qAllMany(busySelectors.join(","));
    const overlayVisible = els.some(isVisible);
    if (overlayVisible) return true;

    const messageContainers = qAllMany(".modal-content, .alert, .growl-message, .block-ui-message");
    return messageContainers.some((el) => {
      if (!isVisible(el)) return false;
      const text = normalizeText(el.innerText);
      return (
        text.includes("bekleyiniz") ||
        text.includes("yukleniyor") ||
        text.includes("isleminiz") ||
        text.includes("araniyor")
      );
    });
  }

  function getMainResultRows() {
    const gridRows = qAllMany(".ui-grid-row").filter(isVisible);
    if (gridRows.length) return gridRows;

    const tableRows = qAllMany("table tbody tr").filter((r) => isVisible(r) && getCells(r).length > 0);
    if (tableRows.length) return tableRows;

    return qAllMany("[role='row']").filter((r) => {
      if (!isVisible(r)) return false;
      if (r.querySelector("[role='columnheader']")) return false;
      return getCells(r).length > 0;
    });
  }

  function getGridSignature() {
    const rows = getMainResultRows();
    const firstText = rows[0] ? normalizeText(rows[0].innerText).slice(0, 180) : "";
    return `${rows.length}|${firstText}`;
  }

  async function waitForGridToRefresh(prevSig, timeoutMs = 20000) {
    const start = Date.now();
    let sawBusy = false;
    let validCount = 0;

    while (Date.now() - start < timeoutMs) {
      if (isPageBusy()) {
        sawBusy = true;
        validCount = 0;
        await sleep(250);
        continue;
      }

      const sig = getGridSignature();
      const rows = getMainResultRows();
      const hasRows = rows.length > 0;
      const changed = sig && sig !== prevSig && hasRows;

      if (changed || (sawBusy && hasRows) || (Date.now() - start > 2500 && hasRows)) {
        validCount += 1;
        if (validCount >= 2) return true;
      } else {
        validCount = 0;
      }

      await sleep(300);
    }

    return false;
  }

  async function clickAraButtonOnly() {
    const { tp_clicked_ara } = await chrome.storage.local.get(["tp_clicked_ara"]);
    if (tp_clicked_ara) return true;

    const btn = findSearchButton();
    if (!btn || btn.hasAttribute("disabled") || btn.classList.contains("disabled")) return false;

    const prevSig = getGridSignature();
    console.log(TAG, "🔎 Ara butonuna basılıyor...");
    superClick(btn);

    await chrome.storage.local.set({
      tp_clicked_ara: true,
      tp_last_search_ts: Date.now(),
      tp_prev_grid_sig: prevSig,
      tp_grid_ready: false
    });
    return true;
  }

  function getOperationTypeText(row) {
    const byHeader = getCellText(row, "İşlem Tipi") || getCellText(row, "Islem Tipi");
    if (byHeader) return byHeader;
    return row.innerText || row.textContent || "";
  }

  function isUpperWriteRow(row) {
    const operationType = normalizeText(getOperationTypeText(row));
    return TARGET_OPERATION_PATTERNS.some(pattern => operationType.includes(pattern));
  }

  function isRegistrationCertificateUpperWriteRow(row) {
    const operationType = normalizeText(getOperationTypeText(row));
    return operationType.includes("tescil belgesi ve ust yazisi");
  }

  function makeUpperWriteKey(row) {
    const rowText = normalizeText(row.innerText || row.textContent).replace(/\s+/g, " ").trim();
    const evrakNo = getCellText(row, "Evrak No");
    const evrakTarihi = getCellText(row, "Evrak Tarihi");
    const operationType = getOperationTypeText(row);
    return normalizeText(`${evrakNo}|${evrakTarihi}|${operationType}|${rowText}`);
  }

  function findFolderClickable(row) {
    const icon = row.querySelector(
      "i.fa-folder, i.fa-folder-open, .fa-folder, .fa-folder-open, " +
      ".glyphicon-folder-open, .glyphicon-folder-close, [class*='folder']"
    );

    if (icon) {
      return icon.closest("a, button, [ng-click], [onclick], [role='button']") || icon;
    }

    const cells = getCells(row);
    const firstCell = cells[0] || row;
    return firstCell.querySelector("a, button, [ng-click], [onclick], [role='button']") || null;
  }

  function getDetailUrlFromClickable(clickable) {
    if (!clickable) return null;
    const anchor = clickable.matches?.("a") ? clickable : clickable.closest?.("a");
    const raw = anchor?.getAttribute?.("href") || "";
    if (!raw || raw === "#" || raw.toLowerCase().startsWith("javascript:")) return null;
    try { return new URL(raw, location.href).href; } catch (_) { return null; }
  }

  function getMainGridScrollContainer(rows) {
    const uiViewport = qAll(".ui-grid-viewport");
    if (uiViewport && uiViewport.scrollHeight > uiViewport.clientHeight + 10) return uiViewport;
    return getScrollableAncestor(rows[0]);
  }

  async function openUpperWriteRow(row) {
    const clickable = findFolderClickable(row);
    if (!clickable) {
      console.warn(TAG, "⚠️ Üst Yazı satırı bulundu fakat klasör ikonu bulunamadı.", row.innerText);
      return false;
    }

    const key = makeUpperWriteKey(row);
    const detailUrl = getDetailUrlFromClickable(clickable);

    const operationTypeText = getOperationTypeText(row);

    await chrome.storage.local.set({
      tp_waiting_detail: true,
      tp_current_upper_key: key,
      tp_current_upper_operation_type: operationTypeText,
      tp_detail_open_ts: Date.now()
    });

    console.log(
      TAG,
      isRegistrationCertificateUpperWriteRow(row)
        ? '📁 "Tescil belgesi ve üst yazısı" açılıyor (TB_ kriteri aktif):'
        : "📁 Üst Yazı açılıyor:",
      key
    );

    if (detailUrl && detailUrl.includes("turkpatent.gov.tr")) {
      const response = await sendInternalMessage({ action: "OPEN_DETAIL_URL", url: detailUrl });
      if (response?.ok) return true;
    }

    const clicked = superClick(clickable);
    if (!clicked) {
      await chrome.storage.local.set({
        tp_waiting_detail: false,
        tp_current_upper_key: null,
        tp_current_upper_operation_type: null,
        tp_detail_open_ts: 0
      });
    }
    return clicked;
  }

  async function scanUpperWriteRows() {
    const state = await chrome.storage.local.get([
      "tp_processed_upper_keys",
      "tp_waiting_detail",
      "tp_detail_open_ts"
    ]);

    if (state.tp_waiting_detail) {
      const elapsed = Date.now() - Number(state.tp_detail_open_ts || 0);
      if (elapsed < 120000) return true;

      console.warn(TAG, "⚠️ Detay ekranı zaman aşımına uğradı; aynı Üst Yazı tekrar denenecek.");
      await chrome.storage.local.set({
        tp_waiting_detail: false,
        tp_current_upper_key: null,
        tp_current_upper_operation_type: null,
        tp_detail_open_ts: 0
      });
      return true;
    }

    const processed = Array.isArray(state.tp_processed_upper_keys)
      ? state.tp_processed_upper_keys
      : [];

    const rows = getMainResultRows();
    if (!rows.length) return false;

    const upperRows = rows.filter(isUpperWriteRow);

    for (const row of upperRows) {
      const key = makeUpperWriteKey(row);
      if (processed.includes(key)) continue;

      await openUpperWriteRow(row);
      return true;
    }

    const scrollContainer = getMainGridScrollContainer(rows);
    if (scrollContainer) {
      const atBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 8;
      if (!atBottom) {
        const step = Math.max(200, Math.floor(scrollContainer.clientHeight * 0.75));
        scrollContainer.scrollTop = Math.min(
          scrollContainer.scrollTop + step,
          scrollContainer.scrollHeight
        );
        scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
        await sleep(650);
        return true;
      }
    }

    const finalState = await chrome.storage.local.get(["tp_job_saved_count"]);
    console.log(
      TAG,
      `✅ Başvurudaki tüm Üst Yazılar tarandı. Kaydedilen hedef belge: ${Number(finalState.tp_job_saved_count || 0)}`
    );
    await advanceQueue();
    return true;
  }

  async function resetMainGridScroll() {
    const rows = getMainResultRows();
    const scrollContainer = getMainGridScrollContainer(rows);
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(250);
    }
  }

  async function checkQueueAndSetAppNo() {
    const data = await chrome.storage.local.get([
      "tp_queue",
      "tp_is_queue_running",
      "tp_queue_index",
      "tp_app_no"
    ]);

    if (!data.tp_is_queue_running || !data.tp_queue || data.tp_queue.length === 0) return true;

    const currentIndex = data.tp_queue_index || 0;
    if (currentIndex >= data.tp_queue.length) {
      console.log(TAG, "🏁 Kuyruk tamamlandı!");
      await chrome.storage.local.set({
        tp_is_queue_running: false,
        tp_queue: [],
        tp_pdf_receiver_tab_id: null
      });
      alert("Toplu işlem tamamlandı!");
      return false;
    }

    const currentJob = data.tp_queue[currentIndex];
    if (data.tp_app_no !== currentJob.appNo) {
      console.log(TAG, `🔄 Yeni iş: ${currentIndex + 1}/${data.tp_queue.length} - ${currentJob.appNo}`);

      await chrome.storage.local.set({
        tp_app_no: currentJob.appNo,
        tp_current_job_id: currentJob.ipId,
        tp_current_doc_type: currentJob.docType,
        tp_clicked_ara: false,
        tp_download_clicked: false,
        tp_waiting_pdf_url: false,
        tp_grid_ready: false,
        tp_prev_grid_sig: null,
        tp_last_belgelerim_try: 0,
        tp_last_search_ts: 0,
        tp_grid_retry: 0,
        tp_processed_upper_keys: [],
        tp_waiting_detail: false,
        tp_current_upper_key: null,
        tp_current_upper_operation_type: null,
        tp_detail_open_ts: 0,
        tp_job_saved_count: 0,
        tp_current_file_name: null
      });

      await resetMainGridScroll();
      return true;
    }

    return true;
  }

  async function advanceQueue() {
    if (isAdvancing) return;
    isAdvancing = true;
    console.log(TAG, "➡️ Başvuru tamamlandı, kuyruk ilerletiliyor...");

    try {
      const input = findApplicationNumberInput();
      if (input) fillInputAngularSafe(input, "");

      const data = await chrome.storage.local.get(["tp_queue_index"]);
      const nextIndex = (data.tp_queue_index || 0) + 1;

      await chrome.storage.local.set({
        tp_queue_index: nextIndex,
        tp_app_no: null,
        tp_download_clicked: false,
        tp_clicked_ara: false,
        tp_waiting_pdf_url: false,
        tp_grid_ready: false,
        tp_prev_grid_sig: null,
        tp_last_belgelerim_try: 0,
        tp_last_search_ts: 0,
        tp_grid_retry: 0,
        tp_processed_upper_keys: [],
        tp_waiting_detail: false,
        tp_current_upper_key: null,
        tp_current_upper_operation_type: null,
        tp_detail_open_ts: 0,
        tp_job_saved_count: 0,
        tp_current_file_name: null,
        tp_pdf_receiver_tab_id: null
      });

      await resetMainGridScroll();
      await sleep(1500);
    } catch (e) {
      console.error(TAG, "Kuyruk ilerletme hatası:", e);
    } finally {
      isActionInProgress = false;
      globalProcessingLock = false;
      isAdvancing = false;
    }
  }

  async function run() {
    if (mainRunLock || isAdvancing) return;
    mainRunLock = true;

    try {
      const continueProcess = await checkQueueAndSetAppNo();
      if (!continueProcess) return;

      const state = await chrome.storage.local.get([
        "tp_app_no",
        "tp_clicked_ara",
        "tp_grid_ready",
        "tp_prev_grid_sig",
        "tp_grid_retry",
        "tp_last_search_ts"
      ]);

      if (!state.tp_app_no) return;

      if (isGirisPage()) {
        const btn = findLoginButtonOnGiris();
        if (btn) superClick(btn);
        return;
      }

      if (!isBelgelerimScreenOpen()) {
        await clickBelgelerim();
        return;
      }

      const okMarka = await ensureDosyaTuruMarka();
      if (!okMarka) return;

      const input = findApplicationNumberInput();
      const currentVal = input ? (input.value || "").trim() : "";

      if (currentVal !== String(state.tp_app_no)) {
        await chrome.storage.local.set({
          tp_clicked_ara: false,
          tp_grid_ready: false,
          tp_grid_retry: 0,
          tp_processed_upper_keys: [],
          tp_waiting_detail: false,
          tp_job_saved_count: 0
        });
        await resetMainGridScroll();
        await fillBasvuruNo(state.tp_app_no);
        return;
      }

      if (!state.tp_clicked_ara) {
        await clickAraButtonOnly();
        return;
      }

      if (Date.now() - Number(state.tp_last_search_ts || 0) < 1200) return;
      if (isPageBusy()) return;

      if (!state.tp_grid_ready) {
        const ok = await waitForGridToRefresh(state.tp_prev_grid_sig || "", 18000);

        if (!ok) {
          const nextRetry = Number(state.tp_grid_retry || 0) + 1;
          if (nextRetry <= 1) {
            console.log(TAG, "🔁 Sonuç tablosu gelmedi; Ara tekrar deneniyor...");
            await chrome.storage.local.set({
              tp_grid_retry: nextRetry,
              tp_clicked_ara: false,
              tp_grid_ready: false
            });
            return;
          }

          console.warn(TAG, "⚠️ Sonuç tablosu yüklenemedi; başvuru atlanıyor.");
          await advanceQueue();
          return;
        }

        await chrome.storage.local.set({
          tp_grid_ready: true,
          tp_grid_retry: 0,
          tp_prev_grid_sig: getGridSignature()
        });
        await resetMainGridScroll();
        return;
      }

      await scanUpperWriteRows();
    } catch (e) {
      console.error(TAG, "Ana otomasyon döngüsü hatası:", e);
    } finally {
      mainRunLock = false;
    }
  }

  setInterval(() => {
    run().catch((e) => console.error(TAG, e));
  }, 1800);
})();
