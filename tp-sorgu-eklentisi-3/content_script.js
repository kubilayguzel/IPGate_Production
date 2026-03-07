// content_script.js (Final Fix: Loading Screen & Busy State Check)
(() => {
  // --- SINGLETON CHECK ---
  if (window.TP_SCRIPT_ALREADY_LOADED) {
      console.log("[TP-AUTO] ♻️ Script zaten yüklü.");
      return; 
  }
  window.TP_SCRIPT_ALREADY_LOADED = true;

  const TAG = "[TP-AUTO]";
  
  // --- STATE ---
  let isActionInProgress = false; 
  let searchPassCount = 0; 
  let globalProcessingLock = false; 
  let isAdvancing = false;          
  let lastProcessedUrl = null;      

  console.log("[TP-AUTO] Content script loaded:", location.href);

  // --- 1. MESAJ DİNLEYİCİSİ ---
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action === "PDF_URL_CAPTURED" && request?.url) {
      sendResponse({ ok: true }); 

      if (request.url === lastProcessedUrl) return; 
      if (globalProcessingLock || isAdvancing) return; 

      globalProcessingLock = true;
      lastProcessedUrl = request.url;

      (async () => {
        try {
          const state = await chrome.storage.local.get(["tp_waiting_pdf_url", "tp_download_clicked"]);
          if (!state.tp_waiting_pdf_url) {
            globalProcessingLock = false; 
            return;
          }
          await chrome.storage.local.set({ tp_download_clicked: true, tp_waiting_pdf_url: false });
          await processDocument(request.url, null);
        } catch (err) {
          console.error(TAG, "Hata:", err);
          globalProcessingLock = false; 
        }
      })();
      return true;
    }
  });

  if (window.top !== window) return;
  
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DEFAULT_UPLOAD_ENDPOINT =
    "https://europe-west1-ip-manager-production-aab4b.cloudfunctions.net/saveEpatsDocument";

  // storage'dan endpoint oku (UI/background set eder: tp_upload_url)
  async function getUploadEndpoint() {
    const { tp_upload_url } = await chrome.storage.local.get(["tp_upload_url"]);
    return tp_upload_url || DEFAULT_UPLOAD_ENDPOINT;
  }

  // --- KUYRUK KONTROL ---
  document.addEventListener("TP_RESET", async () => {
    try { await chrome.storage.local.clear(); } catch {}
  });

  async function checkQueueAndSetAppNo() {
    const data = await chrome.storage.local.get(["tp_queue", "tp_is_queue_running", "tp_queue_index", "tp_app_no"]);
    if (!data.tp_is_queue_running || !data.tp_queue || data.tp_queue.length === 0) return true; 

    const currentIndex = data.tp_queue_index || 0;
    if (currentIndex >= data.tp_queue.length) {
      console.log(TAG, "🏁 Kuyruk tamamlandı!");
      await chrome.storage.local.set({ tp_is_queue_running: false, tp_queue: [] });
      alert("Toplu işlem tamamlandı!");
      return false; 
    }

    const currentJob = data.tp_queue[currentIndex];
    if (data.tp_app_no !== currentJob.appNo) {
      console.log(TAG, `🔄 Yeni İş: ${currentIndex + 1}/${data.tp_queue.length} - ${currentJob.appNo}`);
      await chrome.storage.local.set({
        tp_app_no: currentJob.appNo,
        tp_current_job_id: currentJob.ipId,
        tp_current_doc_type: currentJob.docType,
        tp_clicked_ara: false,
        tp_download_clicked: false,
        tp_grid_ready: false,
        tp_prev_grid_sig: null,
        tp_expanded_twice: false,
        tp_last_belgelerim_try: 0,
        tp_last_search_ts: 0
      });
      searchPassCount = 0; 
      return true;
    }
    return true;
  }

  // --- ADVANCE QUEUE ---
  async function advanceQueue() {
    if (isAdvancing) return;
    isAdvancing = true;
    console.log(TAG, "✅ İşlem bitti, ilerleniyor...");

    try {
        const input = qAll("#textbox551 input");
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
          tp_expanded_twice: false,
          tp_last_belgelerim_try: 0,
          tp_last_search_ts: 0
        });

        console.log(TAG, `🔓 Sıradaki İndeks: ${nextIndex}`);
        globalProcessingLock = false; 
        isActionInProgress = false;
        await sleep(2000); 
    } catch (e) { console.error(TAG, e); } 
    finally { isAdvancing = false; }
  }

  // --- PDF PROCESS ---
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onloadend = () => resolve((reader.result || "").split(",")[1] || "");
      reader.readAsDataURL(blob);
    });
  }

  async function processDocument(downloadUrl, element) {
    console.log(TAG, "📄 PDF İndiriliyor:", downloadUrl);
    try {
      const response = await fetch(downloadUrl, { credentials: "include" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const blob = await response.blob();
      if (!blob.size) throw new Error("Boş dosya");
      const base64data = await blobToBase64(blob);
      if (!base64data || base64data.length < 1000) throw new Error("Base64 geçersiz");

      const storage = await chrome.storage.local.get(["tp_current_job_id", "tp_current_doc_type", "tp_token"]);      const payload = {
        ipRecordId: storage.tp_current_job_id,
        fileBase64: base64data,
        fileName: "Tescil_Belgesi.pdf",
        mimeType: "application/pdf",
        docType: storage.tp_current_doc_type || "tescil_belgesi",
      };

      console.log(TAG, "📤 Upload:", payload.ipRecordId);
      const endpoint = await getUploadEndpoint();
      console.log(TAG, "🌍 Upload endpoint:", endpoint);

      const uploadRes = await fetch(endpoint, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${storage.tp_token}` // 🔥 EKLENEN SATIR: Güvenlik Token'ı
        },
        body: JSON.stringify({ data: payload }),
      });


      if (uploadRes.ok) console.log(TAG, "✅ Başarılı");
      else console.error(TAG, "❌ Hata:", await uploadRes.text());

    } catch (error) { console.error(TAG, "Process hatası:", error); } 
    finally { await advanceQueue(); }
  }

  // --- DOM HELPERS ---
  function qAll(selector) {
    const docs = [document];
    document.querySelectorAll("iframe").forEach(fr => { try { if(fr.contentDocument) docs.push(fr.contentDocument); } catch{} });
    for (const d of docs) { const el = d.querySelector(selector); if (el) return el; }
    return null;
  }
  function qAllMany(selector) {
    let out = [];
    const docs = [document];
    document.querySelectorAll("iframe").forEach(fr => { try { if(fr.contentDocument) docs.push(fr.contentDocument); } catch{} });
    for (const d of docs) out = out.concat(Array.from(d.querySelectorAll(selector)));
    return out;
  }
  function superClick(el) {
    if (!el) return false;
    try { el.click(); return true; } catch { return false; }
  }
  function fillInputAngularSafe(input, value) {
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value); else input.value = value;
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

  // --- GRID HELPERS (sonuçların gerçekten yenilendiğini anlamak için) ---
  function getGridHost() {
    // EPATS ui-grid yapısı farklı sayfalarda değişebiliyor; o yüzden birden fazla aday.
    return (
      qAll(".ui-grid-render-container-body") ||
      qAll(".ui-grid-viewport") ||
      qAll(".ui-grid-canvas")
    );
  }

  function getFirstRowText() {
    const row = qAllMany(".ui-grid-row").find(r => r.offsetParent !== null);
    return (row?.innerText || "").trim();
  }

  function getGridSignature() {
    const host = getGridHost();
    const hostText = (host?.innerText || "").trim();
    const firstRow = getFirstRowText();
    // Çok büyük text'i storage'a basmamak için kısalt.
    const compact = (firstRow || hostText).replace(/\s+/g, " ").slice(0, 200);
    const rowCount = qAllMany(".ui-grid-row").filter(r => r.offsetParent !== null).length;
    return `${rowCount}|${compact}`;
  }

  async function waitForGridToRefresh(prevSig, timeoutMs = 20000) {
    const start = Date.now();

    // Grid DOM'undan ek bir imza (signature aynı kalsa bile DOM değişimini yakalar)
    const getDomStamp = () => {
      const rows = document.querySelectorAll(".ui-grid-row");
      const count = rows.length;

      // İlk satırdan ufak bir metin parçası al (çok pahalı olmasın)
      const firstText =
        rows[0]?.innerText?.trim()?.slice(0, 80) || "";

      // Canvas boyu da değişimde iyi sinyal olur
      const canvas = document.querySelector(".ui-grid-canvas");
      const h = canvas?.scrollHeight || 0;

      return `${count}|${h}|${firstText}`;
    };

    const prevDomStamp = getDomStamp();

    let sawBusy = false;
    let stableOkCount = 0;     // arka arkaya “ok” gördüğümüzde true döneceğiz
    let lastSig = null;

    while (Date.now() - start < timeoutMs) {
      const busy = isPageBusy();
      if (busy) {
        sawBusy = true;
        stableOkCount = 0; // busy iken stabil sayma
        await sleep(250);
        continue;
      }

      const sig = getGridSignature();
      const domStamp = getDomStamp();

      // 1) Signature değiştiyse (ve 0| değilse) -> güçlü sinyal
      const sigChangedAndValid = sig && sig !== prevSig && !sig.startsWith("0|");

      // 2) Signature değişmedi ama DOM değiştiyse -> yenilenmiş olabilir
      const domChanged = domStamp !== prevDomStamp;

      // 3) “0|” geçici olabiliyor; busy döngüsü gördükten sonra 0| dışına çıkınca kabul et
      const sigNowValid = sig && !sig.startsWith("0|");

      // Kabul koşulu:
      // - sig değişip valid ise
      // - veya DOM değiştiyse ve sig valid ise
      // - veya en az bir busy döngüsü gördük ve sig valid ise (bazı durumlarda sig aynı kalabiliyor)
      let ok =
        sigChangedAndValid ||
        (domChanged && sigNowValid) ||
        (sawBusy && sigNowValid);

      // Ek race önlemi: 2 kere üst üste ok görmeden dönme
      // (grid bazen 1 tick doğru görünüp sonra tekrar değişebiliyor)
      if (ok) {
        // Aynı sig'i iki kez üst üste görürsek daha güvenli
        if (lastSig === sig) stableOkCount += 1;
        else stableOkCount = 1;

        lastSig = sig;

        if (stableOkCount >= 2) return true;
      } else {
        stableOkCount = 0;
        lastSig = sig;
      }

      await sleep(250);
    }

    console.warn(TAG, "⚠️ Grid yenilenmesi zaman aşımı. Mevcut veri ile devam edilecek.");
    return false;
  }


  async function clearEvrakAdiFilter() {
    const cells = qAllMany(".ui-grid-header-cell");
    for (const cell of cells) {
      if (cell.innerText.toLowerCase().includes("evrak adı")) {
        const input = cell.querySelector("input");
        if (input && (input.value || "").trim() !== "") {
          fillInputAngularSafe(input, "");
          await sleep(300);
        }
        return true;
      }
    }
    return false;
  }

  // 🔥 [GÜNCELLENDİ] SAYFA MEŞGULİYET KONTROLÜ
  function isPageBusy() {
    // 1. Selector bazlı kontrol (Spinner, Overlay, Backdrop)
    const busySelectors = [
        ".modal-backdrop",          // Bootstrap modal arkası
        ".block-ui-overlay",        // Angular BlockUI
        ".block-ui-message-container",
        ".loading-spinner",
        ".fa-spinner",
        ".fa-refresh.fa-spin",
        "div[ng-show='isLoading']", // Angular loading flag
        ".ui-grid-icon-spin"        // Grid yükleniyor ikonu
    ];

    const els = qAllMany(busySelectors.join(","));
    const isOverlayVisible = els.some(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });

    if (isOverlayVisible) {
        // console.log(TAG, "⏳ Sayfa meşgul (Overlay/Spinner)...");
        return true;
    }

    // 2. Metin bazlı kontrol ("Lütfen Bekleyiniz", "Yükleniyor")
    const messageContainers = qAllMany(".modal-content, .alert, .growl-message, .block-ui-message");
    const hasWaitText = messageContainers.some(el => {
        const text = (el.innerText || "").toLowerCase();
        const style = window.getComputedStyle(el);
        const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        
        return isVisible && (
            text.includes("bekleyiniz") || 
            text.includes("yükleniyor") || 
            text.includes("işleminiz") ||
            text.includes("aranıyor")
        );
    });

    if (hasWaitText) {
        // console.log(TAG, "⏳ Sayfa meşgul (Mesaj: Bekleyiniz/Yükleniyor)...");
        return true;
    }

    return false;
  }

  // --- EPATS UI ---
  async function clickAraButtonOnly() {
    const { tp_clicked_ara } = await chrome.storage.local.get(["tp_clicked_ara"]);
    if (tp_clicked_ara) return true; 

    // Arama tetiklenmeden önce mevcut grid imzasını kaydet ki,
    // yeni başvuruya ait sonuçlar gelmeden filtreleme başlamasın.
    const prevSig = getGridSignature();

    const root = qAll("#button549");
    if (!root) return false;
    const btn = root.querySelector("div.btn[ng-click]") || root.querySelector(".btn");
    
    // Ara butonu pasifse bekle
    if (!btn || btn.hasAttribute("disabled") || btn.classList.contains("disabled")) {
        console.log(TAG, "⏳ Ara butonu pasif, bekleniyor...");
        return false;
    }

    console.log(TAG, "🔎 Ara butonuna basılıyor...");
    superClick(btn);
    
    await chrome.storage.local.set({ 
        tp_clicked_ara: true,
        tp_last_search_ts: Date.now(),
        tp_prev_grid_sig: prevSig
    });
    return true;
  }

  function isGirisPage() { return location.href.includes("/run/TP/EDEVLET/giris"); }
  function isBelgelerimScreenOpen() { return (!!qAll("div.ui-select-container[name='selectbox550']") || !!qAll("#textbox551 input")); }
  
  function findLoginButtonOnGiris() {
    const direct = qAll('a[href*="turkiye.gov.tr"]');
    if(direct) return direct;
    return qAllMany("a,button").find(el => (el.textContent||"").toLowerCase().includes("giriş"));
  }

  async function clickBelgelerim() {
    if (!(await throttle("tp_last_belgelerim_try", 3000))) return false;
    const targets = qAllMany("div[ng-click]");
    const target = targets.find(x => (x.textContent || "").trim() === "Belgelerim");
    if(target) { superClick(target); return true; }
    return false;
  }

  async function ensureDosyaTuruMarka() {
    const container = qAll("div.ui-select-container[name='selectbox550']");
    if (!container) return false;
    if (container.innerText.toLowerCase().includes("marka")) return true;
    
    if (!(await throttle("tp_last_select_try", 1000))) return false;
    const toggle = container.querySelector(".ui-select-toggle");
    if (!container.classList.contains("open")) { superClick(toggle); await sleep(200); }
    const rows = qAllMany(".ui-select-choices-row");
    const markaRow = rows.find(el => el.innerText.toLowerCase().includes("marka"));
    if (markaRow) { superClick(markaRow); await sleep(300); }
    return false;
  }

  async function fillBasvuruNo(appNo) {
    const input = qAll("#textbox551 input");
    if (!input) return false;
    if ((input.value || "").trim() !== String(appNo)) {
      fillInputAngularSafe(input, String(appNo));
      await sleep(300);
    }
    return true;
  }

  // --- ACCORDION & DOWNLOAD ---
  function getAccordionHost() { return qAll("div.ui-grid-tree-base-row-header-buttons"); }
  
  function getAccordionClickable() {
    const host = getAccordionHost();
    if (!host || host.offsetParent === null) return null; 
    return host.querySelector("i") || host;
  }

  function readAccordionState() {
    const host = getAccordionHost();
    if (!host) return "none";
    const cls = (host.querySelector("i")?.className || host.className || "").toLowerCase();
    if (cls.includes("minus")) return "minus"; 
    if (cls.includes("plus")) return "plus";   
    return "unknown";
  }

  async function ensureAccordionOpenAtStart() {
    const state = readAccordionState();
    if (state === "minus") return true; 
    const clickable = getAccordionClickable();
    if(clickable) { superClick(clickable); await sleep(2000); }
    return readAccordionState() === "minus";
  }

  async function ensureAccordionExpandedAfterFilter() {
    await sleep(800);
    const clickable = getAccordionClickable();
    if (!clickable) return false;
    const state = readAccordionState();
    
    if (state === "plus") { superClick(clickable); await sleep(1500); }
    else if (state === "minus") { 
        superClick(clickable); await sleep(800);
        superClick(clickable); await sleep(1500);
    }
    return true;
  }

  async function setEvrakAdiFilter(term) {
    const cells = qAllMany(".ui-grid-header-cell");
    for (const cell of cells) {
      if (cell.innerText.toLowerCase().includes("evrak adı")) {
        const input = cell.querySelector("input");
        if(input) { fillInputAngularSafe(input, term); await sleep(800); return true; }
      }
    }
    return false;
  }


  async function downloadTescilBelge() {
    const { tp_download_clicked, tp_clicked_ara, tp_waiting_pdf_url } = await chrome.storage.local.get([
      "tp_download_clicked",
      "tp_clicked_ara",
      "tp_waiting_pdf_url"
    ]);

    // PDF beklerken asla yeniden filtreleme / dokuman arama yapma.
    if (tp_waiting_pdf_url) return true;

    if (tp_download_clicked || isActionInProgress || !tp_clicked_ara) return true;
    if (isAdvancing) return true;

    // 🔥 Tablo yüklenmediyse bekle
    if (!getAccordionClickable()) return false; 

    isActionInProgress = true;
    try {
        await ensureAccordionOpenAtStart();
        const aramaListesi = ["Marka Yenileme Belges", "MYB", "TB", "Tescil_belgesi_us"];
        
        for (const terim of aramaListesi) {
            console.log(TAG, `🔍 Filtre: ${terim}`);
            await setEvrakAdiFilter(terim);
            await sleep(1500);
            await ensureAccordionExpandedAfterFilter();

            const icons = qAllMany("i.fa-download").filter(el => el.offsetParent !== null);
            const targetIcon = icons[1] || icons[0]; 

            if (targetIcon) {
                console.log(TAG, `✅ Dosya Bulundu: ${terim}`);
                await chrome.storage.local.set({ tp_waiting_pdf_url: true });

                // 1) Mümkünse download linkini yakala (PDF yeni sekme açılmadan da indirilebiliyor)
                const linkEl = targetIcon.closest("a");
                const href = (linkEl && linkEl.href) ? linkEl.href : null;

                // 2) UI davranışını korumak için yine tıkla
                superClick(targetIcon);
                await sleep(800);

                // 3) Eğer href yakaladıysak, background yakalamayı beklemeden direkt PDF'i indirip işle.
                // (Bu, sizde görülen "PDF Timeout" problemine çözüm olur.)
                if (href) {
                  console.log(TAG, "🔗 PDF linki yakalandı, direkt indirilecek:", href);

                  // Bu noktadan sonra filtre yazma / tekrar arama yapma.
                  await chrome.storage.local.set({ tp_download_clicked: true, tp_waiting_pdf_url: false });
                  globalProcessingLock = true;
                  lastProcessedUrl = href;

                  // Kısa bir gecikme: bazı durumlarda server click sonrası dosyayı hazır ediyor.
                  setTimeout(() => {
                    processDocument(href, null).catch(() => {});
                  }, 400);
                  return true;
                }

                setTimeout(async () => {
                  const s = await chrome.storage.local.get(["tp_waiting_pdf_url", "tp_download_clicked"]);
                  if (s.tp_waiting_pdf_url && !s.tp_download_clicked) {
                    console.warn(TAG, "⏳ PDF Timeout. Geçiliyor.");
                    await chrome.storage.local.set({ tp_waiting_pdf_url: false });
                    globalProcessingLock = false;
                    await advanceQueue();
                  }
                }, 12000);
                return true;
            }
        }
        
        searchPassCount++;
        if (searchPassCount >= 2) {
            console.log(TAG, "⚠️ Belge yok, geçiliyor.");
            await advanceQueue(); 
        }
    } catch(e) { console.error(TAG, e); await advanceQueue(); } 
    finally { isActionInProgress = false; }
  }

// --- ANA DÖNGÜ ---
async function run() {
  if (isAdvancing) return;

  const continueProcess = await checkQueueAndSetAppNo();
  if (!continueProcess) return;

  const {
    tp_app_no,
    tp_clicked_ara,
    tp_download_clicked,
    tp_last_search_ts
  } = await chrome.storage.local.get([
    "tp_app_no",
    "tp_clicked_ara",
    "tp_download_clicked",
    "tp_last_search_ts"
  ]);

  if (!tp_app_no) return;

  if (isGirisPage()) {
    const btn = findLoginButtonOnGiris();
    if (btn) superClick(btn);
    return;
  }

  if (isBelgelerimScreenOpen()) {
    const okMarka = await ensureDosyaTuruMarka();
    if (!okMarka) return;

    const input = qAll("#textbox551 input");
    const currentVal = input ? (input.value || "").trim() : "";

    if (currentVal !== String(tp_app_no)) {
      // Önce önceki aramadan kalan "Evrak adı" filtresini temizle.
      await clearEvrakAdiFilter();

      // Garanti olsun diye arama state'ini de sıfırla (başvuru no değişti).
      await chrome.storage.local.set({
        tp_clicked_ara: false,
        tp_download_clicked: false,
        tp_waiting_pdf_url: false,
        tp_grid_ready: false,
        tp_grid_retry: 0
      });

      await fillBasvuruNo(tp_app_no);
      return;
    }

    if (!tp_clicked_ara) {
      await clickAraButtonOnly();
      return;
    }

    // 1) Çok kısa bir güvenlik beklemesi
    if (tp_clicked_ara && (Date.now() - (tp_last_search_ts || 0) < 1500)) return;

    // 2) UI hala yükleniyorsa asla devam etme
    if (isPageBusy()) {
      console.log(TAG, "⏳ Sayfa meşgul, bekleniyor...");
      return;
    }

    // 3) Asıl kritik nokta:
    // Ara'ya basıldıktan sonra grid'in gerçekten yenilenmesini bekle.
    const {
      tp_grid_ready,
      tp_prev_grid_sig,
      tp_grid_retry = 0
    } = await chrome.storage.local.get([
      "tp_grid_ready",
      "tp_prev_grid_sig",
      "tp_grid_retry"
    ]);

    if (tp_clicked_ara && !tp_grid_ready) {
      const ok = await waitForGridToRefresh(tp_prev_grid_sig || "", 20000);

      if (!ok) {
        // ✅ Grid gelmediyse ready yapma. 1 kez daha Ara'ya basıp dene.
        const nextRetry = tp_grid_retry + 1;

        if (nextRetry <= 1) {
          console.log(TAG, "🔁 Grid gelmedi, Ara tekrar deneniyor...");
          await chrome.storage.local.set({ tp_grid_retry: nextRetry, tp_grid_ready: false });
          await clickAraButtonOnly();
          return;
        }

        console.log(TAG, "⛔ Grid yine gelmedi, bu tur atlanıyor.");
        await chrome.storage.local.set({ tp_grid_retry: 0, tp_grid_ready: false });
        return; // burada istersen "işi atla/ilerle" mantığını çağırabilirsin
      }

      // ✅ Grid yenilendi: ready yap, retry sıfırla, prev sig güncelle
      const newSig = getGridSignature() || "";
      await chrome.storage.local.set({
        tp_grid_ready: true,
        tp_grid_retry: 0,
        tp_prev_grid_sig: newSig
      });

      return; // Bir sonraki tick'te indirmeye geçsin
    }

    if (tp_clicked_ara && tp_grid_ready && !tp_download_clicked && !isActionInProgress) {
      await downloadTescilBelge();
    }

    return;
  }

  await clickBelgelerim();
}
  setInterval(() => run().catch(() => {}), 2000);
})();