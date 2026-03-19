// ================================================
// Evreka IP — SADE (Sadece Sahip No) İçerik Scripti + Sonuç Toplama (STRICT)
// ================================================
console.log('[Evreka OPTS] ========== CONTENT SCRIPT LOADED ==========');
console.log('[Evreka OPTS] URL:', window.location.href);

const TAG = '[Evreka SahipNo]';
let __EVREKA_SENT_OPTS_MAP__ = {};
let __EVREKA_SENT_ERR_MAP__ = {};
let targetKisiNo = null;
let targetAppNo = null; // Başvuru No (Application Number) hedefi
let sourceOrigin = null; // opener target origin (from ?source=...)

// --------- Log Helpers ---------
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const err = (...a) => console.error(TAG, ...a);

// --- Single Transfer helpers (OPTS) ---
const getHashParam = (name) => {
  const m = location.hash && location.hash.match(new RegExp(`[?#&]${name}=([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
};

// ============================================================
// GLOBAL YARDIMCI FONKSİYONLAR VE DEĞİŞKENLER
// (Bunu dosyanın en en tepesine yapıştırın)
// ============================================================

// Global kilit değişkeni (Aynı anda iki modal açılmasın diye)
let _isModalLocked = false;

// Modern Sleep Fonksiyonu
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Kilit Mekanizması: Sıraya sokar ve çakışmayı önler
async function withModalLock(action) {
  // Eğer kilitliyse, kilit açılana kadar bekle
  while (_isModalLocked) {
    await sleep(100);
  }
  
  // Kilitle
  _isModalLocked = true;
  
  try {
    // İşlemi yap
    return await action();
  } catch (e) {
    console.error('Lock içi işlem hatası:', e);
    throw e;
  } finally {
    // İşlem bitince veya hata olsa bile kilidi mutlaka aç
    _isModalLocked = false;
  }
}

// Detay objesinden Başvuru Numarasını çeker
function getDetailAppNo(detail) {
  if (!detail || !detail.fields) return null;
  // Hem "Başvuru Numarası" hem "Başvuru No" alanlarına bakar
  return normalizeAppNo(detail.fields['Başvuru Numarası'] || detail.fields['Başvuru No']);
}

// İki numarayı (boşluksuz ve sadece rakam olarak) karşılaştırır
function numbersMatch(no1, no2) {
  const n1 = (no1 || '').replace(/[^0-9]/g, '');
  const n2 = (no2 || '').replace(/[^0-9]/g, '');
  // İkisi de doluysa ve eşleşiyorsa true döner
  return n1 && n2 && n1 === n2;
}

// ✅ EKSİK OLAN BEKLEME FONKSİYONU (Dosyanın en tepesine ekleyin)
function waitForNoDialog(timeout = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      // Ekranda görünür olan dialog var mı?
      const visibleDialogs = Array.from(document.querySelectorAll('div[role="dialog"], .MuiDialog-root'))
        .filter(el => window.getComputedStyle(el).display !== 'none' && el.offsetParent !== null);
      
      if (visibleDialogs.length === 0) {
        resolve(true); // Temiz
      } else if (Date.now() - start > timeout) {
        console.warn('⚠️ Modal kapanma zaman aşımı, devam ediliyor.');
        resolve(false); // Zorla devam et
      } else {
        requestAnimationFrame(check); // Tekrar kontrol et
      }
    };
    check();
  });
}

// ============================================================
// MODAL PARSE VE İŞLEME KODLARI AŞAĞIDA DEVAM EDER...
// ============================================================

async function waitAndScrapeResultFromDom(appNo, timeout = 25000) {
  const root = document.body;
  let resolved = false;
  function scrape() {
    const appNoEl = root.querySelector('[data-app-no], .app-no, #appNo, td.appno, .application-number');
    let foundAppNo = appNoEl ? (appNoEl.textContent || appNoEl.value || '').trim() : null;
    if (!foundAppNo) {
      const labels = Array.from(root.querySelectorAll('th,td,div,span,label'));
      const cand = labels.find(el => /başvuru\s*no/i.test((el.textContent || ''))); // Düzeltildi
      if (cand) {
        const val = (cand.nextElementSibling && cand.nextElementSibling.textContent || '').trim();
        if (/\d{4}\/\d+/.test(val)) foundAppNo = val; // Düzeltildi
      }
    }
    if (!foundAppNo) {
      const text = (root.textContent || '');
      const m = text.match(/(\d{4}\/\d{3,})/); // Düzeltildi
      if (m) foundAppNo = m[1];
    }
    if (foundAppNo && (!appNo || foundAppNo === appNo)) {
      const titleEl = root.querySelector('[data-title], .result-title, h1, h2');
      return {
        applicationNumber: foundAppNo,
        title: titleEl ? (titleEl.textContent || '').trim() : null,
        source: 'dom'
      };
    }
    return null;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!resolved) {
        try { obs.disconnect(); } catch {}
        reject(new Error('RESULT_TIMEOUT'));
      }
    }, timeout);
    const obs = new MutationObserver(() => {
      const data = scrape();
      if (data) {
        resolved = true;
        clearTimeout(timer);
        obs.disconnect();
        resolve(data);
      }
    });
    const first = scrape();
    if (first) {
      resolved = true;
      clearTimeout(timer);
      resolve(first);
      return;
    }
    obs.observe(root, { childList: true, subtree: true, characterData: true });
  });
}
// --------- DOM Helpers ---------
function waitFor(selector, { root = document, timeout = 7000, test = null } = {}) {
  return new Promise((resolve, reject) => {
    let el = root.querySelector(selector);
    if (el && (!test || test(el))) return resolve(el);
    const obs = new MutationObserver(() => {
      el = root.querySelector(selector);
      if (el && (!test || test(el))) {
        cleanup();
        resolve(el);
      }
    });
    obs.observe(root, { childList: true, subtree: true, attributes: true });
    const timer = setTimeout(() => { cleanup(); reject(new Error(`waitFor timeout: ${selector}`)); }, timeout);
    function cleanup() { try { obs.disconnect(); } catch {} try { clearTimeout(timer); } catch {} }
  });
}
function click(el) {
  if (!el) return false;
  try {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  } catch {}
  return false;
}
function setReactInputValue(input, value) {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc && desc.set) desc.set.call(input, value); else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function pressEnter(el){
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
}


// --------- EVREKA PATCH HELPERS (appNo normalize & label extraction) ---------
function normalizeAppNo(appNo) {
  try {
    const raw = String(appNo || '').trim();
    if (!raw) return '';
    const parts = raw.split('/');
    if (parts.length != 2) return raw;
    let [yy, rest] = parts;
    yy = String(yy || '').trim();
    rest = String(rest || '').trim();
    if (/^\d{2}$/.test(yy)) { // Düzeltildi
      const n = parseInt(yy, 10);
      const fullYear = (n <= 24 ? 2000 + n : 1900 + n);
      return `${fullYear}/${rest}`;
    }
    return `${yy}/${rest}`;
  } catch { return String(appNo || '').trim(); }
}
function extractByLabel(root, label) {
  try {
    const tds = Array.from(root.querySelectorAll('td, .MuiTableCell-root, .MuiTableCell-body'));
    for (let i = 0; i < tds.length - 1; i++) {
      const k = (tds[i].textContent || '').trim().toLowerCase();
      if (k === String(label || '').trim().toLowerCase()) {
        return (tds[i + 1].textContent || '').trim();
      }
    }
  } catch {}
  return '';
}

// Opener'a mesaj gönder (window.opener veya chrome.runtime ile)
function sendToOpener(type, data) {
  try {
    // Önce window.opener'ı dene
    if (window.opener && !window.opener.closed) {
      log('📤 window.opener\'a postMessage gönderiliyor:', type); // Düzeltildi
      window.opener.postMessage({
        type: type,
        source: 'tp-sorgu-eklentisi-2',
        data: data
      }, '*');
      return;
    }
    
    // window.opener yoksa background'a gönder
    log('📤 Background\'a mesaj gönderiliyor:', type); // Düzeltildi
    if (chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'FORWARD_TO_APP',
        messageType: type,
        data: data
      });
    } else {
      warn('⚠️ Chrome runtime API yok');
    }
  } catch (error) {
    err('❌ sendToOpener hatası:', error);
  }
}

// --------- Modal Yardımcıları ---------
async function closeFraudModalIfAny() {
  try {
    const fraudContainer = await waitFor('.jss84', { timeout: 1800 }).catch(()=>null);
    if (fraudContainer) {
      const closeEl = fraudContainer.querySelector('.jss92');
      if (closeEl && click(closeEl)) {
        log('Dolandırıcılık popup kapatıldı (.jss92).');
        await new Promise(r => setTimeout(r, 100));
        return;
      }
      if (click(fraudContainer)) {
        log('Dolandırıcılık popup container tıklandı (fallback).');
        await new Promise(r => setTimeout(r, 80));
        return;
      }
    }
  } catch (e) { /* yoksay */ }

  try {
    const anyDialog = await waitFor('[role="dialog"], .MuiDialog-root, .MuiModal-root, .modal', { timeout: 700 }).catch(()=>null);
    if (anyDialog) {
      const closeCandidate = anyDialog.querySelector('button[aria-label="Close"], button[aria-label="Kapat"], .close, .MuiIconButton-root[aria-label="close"]')
        || anyDialog.querySelector('button');
      if (closeCandidate && click(closeCandidate)) {
        log('Genel MUI modal kapatıldı.');
        await new Promise(r => setTimeout(r, 80));
        return;
      }
    }
  } catch (e) { /* sessiz */ }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
}

function closeAnyOpenDialog() {
  const dialogs = document.querySelectorAll('[role="dialog"], .MuiDialog-root, .MuiModal-root, .modal');
  if (!dialogs.length) return;
  for (const d of dialogs) {
    const closeBtn = d.querySelector('button[aria-label="Close"], button[aria-label="Kapat"], .close, .MuiIconButton-root[aria-label="close"]')
      || d.querySelector('button');
    if (closeBtn) click(closeBtn);
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
}

// --------- Sonsuz Liste & Scroll Yardımcıları ---------
function elementHasText(el, text) {
  return !!el && (el.textContent || '').toLowerCase().includes((text || '').toLowerCase());
}
function findInfiniteToggle() {
  // "Sonsuz Liste" metnini taşıyan label/span'ı bul
  const labelCandidates = Array.from(document.querySelectorAll(
    'label.MuiFormControlLabel-root, .MuiFormControlLabel-root, label, .MuiFormControlLabel-label, .MuiTypography-root'
  ));
  const labelNode = labelCandidates.find(n => (n.textContent || '').toLowerCase().includes('sonsuz liste'));
  if (!labelNode) return null;

  const root = labelNode.closest('.MuiFormControlLabel-root') || labelNode.parentElement || labelNode;
  const input = root.querySelector('input.MuiSwitch-input[type="checkbox"], input[type="checkbox"]');
  const switchBase = root.querySelector('.MuiSwitch-switchBase');
  const switchRoot = root.querySelector('.MuiSwitch-root');
  const clickable = switchBase || switchRoot || root;

  return { root, labelNode, input, switchBase, switchRoot, clickable };
}
async function ensureInfiniteOn() {
  const t = findInfiniteToggle();
  if (!t) { log('Sonsuz Liste toggle bulunamadı.'); return false; }

  const isChecked = () => {
    try {
      if (t.input && typeof t.input.checked !== 'undefined') return !!t.input.checked;
      if (t.switchBase) return t.switchBase.classList.contains('Mui-checked');
      const checkedEl = t.root.querySelector('.MuiSwitch-switchBase.Mui-checked');
      return !!checkedEl;
    } catch { return false; }
  };

  if (isChecked()) { log('Sonsuz Liste zaten AÇIK.'); return true; }

  // 1) Switch base/root tıklaması
  if (t.clickable) click(t.clickable);
  await new Promise(r => setTimeout(r, 150));
  if (isChecked()) { log('Sonsuz Liste AÇILDI (clickable).'); return true; }

  // 2) Input tıklaması
  if (t.input) {
    click(t.input);
    await new Promise(r => setTimeout(r, 150));
    if (isChecked()) { log('Sonsuz Liste AÇILDI (input).'); return true; }
  }

  // 3) Label tıklaması
  if (t.labelNode) {
    click(t.labelNode);
    await new Promise(r => setTimeout(r, 150));
    if (isChecked()) { log('Sonsuz Liste AÇILDI (label).'); return true; }
  }

  // 4) Son çare: input.checked = true + event
  try {
    if (t.input) {
      t.input.checked = true;
      t.input.dispatchEvent(new Event('input', { bubbles: true }));
      t.input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      if (isChecked()) { log('Sonsuz Liste AÇILDI (forced).'); return true; }
    }
  } catch {}

  log('Sonsuz Liste AÇILAMADI.');
  return false;
}
function findScrollContainerFor(el) {
  let cur = el;
  while (cur) {
    const sh = cur.scrollHeight, ch = cur.clientHeight;
    const style = cur === document.documentElement ? '' : getComputedStyle(cur);
    const overflowY = style ? style.overflowY : '';
    if (sh && ch && (sh - ch > 5) && (overflowY === 'auto' || overflowY === 'scroll' || cur === document.scrollingElement)) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return document.scrollingElement || document.documentElement || document.body;
}

// ---- Beklenen Toplamı Oku: "34 kayıt bulundu. Sayfa 1 / 2" ----
function getExpectedTotalCountFromNodeText(txt) {
  const m = (txt || '').match(/(\d+)\s*kayıt\s*b[uü]lundu/i); // Düzeltildi
  return m ? parseInt(m[1], 10) : null;
}
function getExpectedTotalCount() {
  const nodes = Array.from(document.querySelectorAll('p, span, div'));
  const node = nodes.find(n => elementHasText(n, 'kayıt bulundu'));
  if (!node) return null;
  return getExpectedTotalCountFromNodeText(node.textContent || '');
}
async function waitForTotalMetaAndParse(timeout = 45000) {
  // Önce varsa direkt oku
  let expected = getExpectedTotalCount();
  if (typeof expected === 'number') return expected;

  // Yoksa "kayıt bulundu" metni gelene kadar bekle
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const nodes = Array.from(document.querySelectorAll('p, span, div'));
    const node = nodes.find(n => elementHasText(n, 'kayıt bulundu'));
    if (node) {
      expected = getExpectedTotalCountFromNodeText(node.textContent || '');
      if (typeof expected === 'number') return expected;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// ---- Scroll Akışı: "yükleme → 1sn bekle → scroll" (beklenen sayıya ulaşana dek) ----
const countRows = () => document.querySelectorAll('tbody.MuiTableBody-root tr').length;
const isLoading = () =>
  !!document.querySelector('.MuiCircularProgress-root, [role="progressbar"], .MuiBackdrop-root[aria-hidden="false"]');

function waitForRowIncrease(baseCount, timeout = 35000) {
  return new Promise((resolve) => {
    const tbody = document.querySelector('tbody.MuiTableBody-root');
    if (!tbody) return resolve(false);

    const check = () => {
      const n = countRows();
      if (n > baseCount) { cleanup(); resolve(n); }
    };

    const cleanup = () => {
      try { obs.disconnect(); } catch {}
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
    };

    const obs = new MutationObserver(check);
    obs.observe(tbody, { childList: true, subtree: true });

    // bazı ortamlarda sanal liste/paketli ekleme olabileceği için ek olarak poll
    const poll = setInterval(check, 400);
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeout);
  });
}

async function infiniteScrollAllRowsSTRICT(expectedTotal, { overallTimeoutMs = 360000 } = {}) {
  const tbody = document.querySelector('tbody.MuiTableBody-root');
  if (!tbody) return;

  const scroller = findScrollContainerFor(tbody);
  const scrollBottom = () => {
    try {
      if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) {
        window.scrollTo(0, document.body.scrollHeight);
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
    } catch {}
  };

  const start = performance.now();
  let lastCount = countRows();

  // Eğer daha fazlası bekleniyorsa ilk scroll'u tetikle
  if (!expectedTotal || lastCount < expectedTotal) {
    await sleep(800); // ilk paket için kısa bekleme
    scrollBottom();
  }

  while (true) {
    if (expectedTotal && lastCount >= expectedTotal) {
      // küçük stabilize beklemesi
      await sleep(500);
      break;
    }

    // güvenlik: toplam süre aşıldıysa çık
    if (performance.now() - start > overallTimeoutMs) {
      log('Uyarı: overall timeout aşıldı. Yüklenen:', lastCount, 'beklenen:', expectedTotal);
      break;
    }

    // yeni kayıt gelmesini bekle
    const increasedTo = await waitForRowIncrease(lastCount, 35000); // 35s chunk beklemesi
    if (increasedTo && increasedTo > lastCount) {
      lastCount = increasedTo;
      log('Yeni kayıtlar geldi →', lastCount, '/', expectedTotal || '?');

      // İSTENEN: "yeni veriler geldikten sonra 1 sn bekle → scroll"
      await sleep(1000);
      scrollBottom();
      continue;
    }

    // artış yoksa ama spinner/loader görünüyorsa biraz daha bekle ve tekrar dene
    if (isLoading()) {
      log('Loader görünüyor, biraz daha bekleniyor...');
      await sleep(1500);
      scrollBottom();
      continue;
    }

    // artış yok, loader da yok → yine de bir şans daha ver
    await sleep(1200);
    scrollBottom();

    // küçük bir ek beklemeden sonra tekrar kontrol edilecek; döngü devam eder
  }

  log('STRICT: Yüklenen toplam satır:', lastCount, 'beklenen:', expectedTotal);
  return lastCount;
}

// --------- MODAL PARSE: Detay'ı aç ve görsel + alanları topla ---------
function findDetailButton(tr) {
  const btns = Array.from(tr.querySelectorAll('button, a[role="button"], .MuiIconButton-root'));
  const byLabel = btns.find(b => {
    const t = (b.textContent || '').toLowerCase();
    const a = (b.getAttribute?.('aria-label') || '').toLowerCase();
    return /detay|detail|incele/.test(t) || /detay|detail|incele/.test(a);
  });
  return byLabel || btns[btns.length - 1] || null;
}

// ============================================================
// GÜÇLENDİRİLMİŞ PARSE FONKSİYONU (Yedekli Okuma)
// ============================================================
// content_script.js - parseDetailsFromOpenDialog Güncellemesi

async function parseDetailsFromOpenDialog(dialogRoot) {
  console.log('🔍 parseDetailsFromOpenDialog çağrıldı');
  
  if (!dialogRoot) return {};

  const data = {
    imageDataUrl: null,
    fields: {},
    goodsAndServices: [],
    transactions: []
  };

  // --- 1. ETAP: Başvuru No/Tarih (Hızlı Çekim) ---
  try {
    const labeledAppNo = extractByLabel(dialogRoot, 'Başvuru Numarası');
    if (labeledAppNo) {
      data.fields['Başvuru Numarası'] = normalizeAppNo(labeledAppNo);
    } else {
      const txtAll = (dialogRoot.textContent || '').replace(/\s+/g, ' ').trim();
      const m = txtAll.match(/\b((?:19|20)\d{2}|\d{2})\/\d{4,}\b/);
      if (m) data.fields['Başvuru Numarası'] = normalizeAppNo(m[0]);
    }
    const labeledAppDate = extractByLabel(dialogRoot, 'Başvuru Tarihi');
    if (labeledAppDate) data.fields['Başvuru Tarihi'] = labeledAppDate;
  } catch (e) { /* ignore */ }

  try {
    // --- 2. ETAP: Tablo Taraması ---
    const allTables = dialogRoot.querySelectorAll('table, .MuiTable-root');
    
    for (const table of allTables) {
      const headers = table.querySelectorAll('th, .MuiTableCell-head');
      const headerTexts = Array.from(headers).map(h => h.textContent.trim());
      const tbody = table.querySelector('tbody, .MuiTableBody-root');
      if (!tbody) continue;
      const rows = tbody.querySelectorAll('tr, .MuiTableRow-root');

      // A) MAL VE HİZMETLER TABLOSU
      if (headerTexts.some(h => h.includes('Sınıf')) && 
          headerTexts.some(h => h.includes('Mal') || h.includes('Hizmet'))) {
          // ... (Mevcut mal/hizmet kodu aynen kalabilir) ...
          for (const row of rows) {
             const cells = row.querySelectorAll('td, .MuiTableCell-body');
             if (cells.length >= 2) {
                 const classNo = parseInt(cells[0].textContent.trim(), 10);
                 const goodsText = cells[1].textContent.trim();
                 if (!isNaN(classNo) && goodsText.length > 0) {
                     const items = goodsText.split(/\n+/).map(i => i.trim()).filter(Boolean);
                     data.goodsAndServices.push({ classNo, items });
                 }
             }
          }
      }
      // B) İŞLEM GEÇMİŞİ
      else if (headerTexts.some(h => h.includes('Tarih')) && headerTexts.some(h => h.includes('İşlem'))) {
         // ... (Mevcut işlem geçmişi kodu) ...
         for (const row of rows) {
             const cells = row.querySelectorAll('td');
             if (cells.length >= 3) {
                 const dateT = cells[0].textContent.trim();
                 const opT = cells[2].textContent.trim();
                 if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateT)) {
                     data.transactions.push({ date: dateT, description: opT });
                 }
             }
         }
      }
      // C) ANA BİLGİLER (Key-Value)
      else {
        for (const row of rows) {
          const cells = row.querySelectorAll('td, .MuiTableCell-body');
          
          // [YENİ] Vekil/Sahip Bilgileri (Colspan'lı yapı)
          // HTML: <td>Vekil Bilgileri</td><td colspan="3"><p>AD</p><p>FİRMA</p></td>
          if (cells.length === 2) {
             const k = cells[0].textContent.trim();
             const vCell = cells[1];
             
             // Eğer Vekil veya Sahip bilgisi ise ve içinde <p> etiketleri varsa
             if ((k.includes('Vekil') || k.includes('Sahip')) && vCell.querySelector('p')) {
                 const lines = Array.from(vCell.querySelectorAll('p'))
                     .map(p => p.textContent.trim())
                     .filter(Boolean);
                 
                 // İsim - Firma şeklinde birleştir
                 const joinedVal = lines.join(' - ');
                 if (joinedVal) data.fields[k] = joinedVal;
                 
             } else {
                 // Standart Key-Value
                 const v = vCell.textContent.trim();
                 if(k && v && v !== '--') data.fields[k] = v;
             }
          }
          // 4 Hücreli Standart (Key-Val-Key-Val)
          else if (cells.length === 4) {
             const k1 = cells[0].textContent.trim(); const v1 = cells[1].textContent.trim();
             const k2 = cells[2].textContent.trim(); const v2 = cells[3].textContent.trim();
             if(k1 && v1 && v1 !== '--') data.fields[k1] = v1;
             if(k2 && v2 && v2 !== '--') data.fields[k2] = v2;
          }
        }
      }
    }
  } catch (e) {
    console.error('❌ Parse hatası:', e);
  }

  // Görsel
  const imgEl = dialogRoot.querySelector('img[src*="data:image"], img[src*="MarkaGorseli"]');
  if (imgEl?.src) data.imageDataUrl = imgEl.src;

  return data;
}

// ============================================================
// HEDEF ODAKLI MODAL AÇICI (Doğru Numarayı Bekler)
// ============================================================
async function openRowModalAndParse(tr, expectedAppNo, { timeout = 15000 } = {}) {
  try {
    // 1. ADIM: SAHA TEMİZLİĞİ (Bir önceki kapansın)
    closeAnyOpenDialog();
    if (typeof waitForNoDialog === 'function') {
        await waitForNoDialog(2000); // Kapanmayı bekle
    } else {
        await sleep(1000);
    }

    const btn = findDetailButton(tr);
    if (!btn) {
        console.warn('Detay butonu bulunamadı');
        return null;
    }
    
    // Butona git ve tıkla
    btn.scrollIntoView({ block: 'center' });
    await sleep(50);
    click(btn);
    await sleep(250); 

    // 2. ADIM: MODAL KUTUSUNU BUL
    let dialog = null;
    const searchStart = Date.now();
    
    while (Date.now() - searchStart < 4000) {
      const highZElements = Array.from(document.querySelectorAll('div'))
        .filter(el => {
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && parseInt(s.zIndex) > 1000;
        });

      for (const el of highZElements) { 
        if (el.querySelector('fieldset, table')) { dialog = el; break; }
      }
      if (dialog) break;
      await sleep(100); 
    }

    if (!dialog) return null;

    // 3. ADIM: DOĞRU VERİYİ VE YÜKLEMEYİ BEKLE (En Kritik Yer)
    const contentStart = Date.now();
    let prevRowCount = -1;
    let stableCount = 0;
    
    // Beklediğimiz numarayı temizle (Sadece rakam: 2024034166)
    const targetClean = (expectedAppNo || '').replace(/[^0-9]/g, '');

    while (Date.now() - contentStart < timeout) {
        const txt = (dialog.textContent || '').trim();
        const txtClean = txt.replace(/[^0-9]/g, ''); // Sayfadaki tüm rakamlar
        const currentRows = dialog.querySelectorAll('tr').length;
        
        // Modal dolu mu? (En azından 'Başvuru' yazısı var mı?)
        const hasContent = txt.length > 50 && (txt.includes('Başvuru') || /\d{4}\/\d+/.test(txt));

        if (hasContent) {
            // EĞER hedef numara verilmişse ve ekranda YOKSA -> Bekle (Eski veri var demektir)
            if (targetClean && !txtClean.includes(targetClean)) {
                // Beklenen numara henüz ekrana düşmedi, döngüye devam et
                await sleep(100);
                continue; 
            }

            // Buraya geldiysek doğru numara ekranda demektir.
            // Şimdi de tablonun tam yüklenmesini (satır sayısının durmasını) bekleyelim.
            if (currentRows === prevRowCount) stableCount++;
            else stableCount = 0;
            
            prevRowCount = currentRows;

            // Satır sayısı 4 döngü (400ms) boyunca değişmediyse ve tablo boş değilse TAMAMDIR
            if (stableCount >= 4 && currentRows > 0) {
                break; 
            }
        }
        await sleep(100);
    }

    // Parse et
    const parsed = await parseDetailsFromOpenDialog(dialog);

    // İşlem bitince kapat
    closeAnyOpenDialog();
    
    return parsed;

  } catch (e) {
    console.error('Modal işlem hatası:', e);
    return null;
  }
}

// --------- Sonuç Toplama ---------

// content_script.js içindeki parseOwnerRowBase fonksiyonunu bununla değiştirin:

function parseOwnerRowBase(tr, idx) {
  const orderTxt = (tr.querySelector('td .MuiTypography-alignCenter') || tr.querySelector('td'))?.textContent || `${idx+1}`;
  const tds = Array.from(tr.querySelectorAll('td'));

  // DEBUG: İlk 3 satır için detaylı log (Konsolda kolonları saymak için)
  if (idx < 3) {
    console.log(`🔍 DETAY - Satır ${idx + 1}:`);
    tds.forEach((td, i) => {
      // Hücre içeriğini temizleyip logla
      console.log(`   Hücre [${i}]: "${(td.textContent || '').trim()}"`);
    });
  }

  let applicationNumber = '';
  let brandName = '';
  let ownerName = '';
  let applicationDate = '';
  let registrationNumber = '';
  let status = '';
  let niceClasses = '';
  let imageSrc = null;
  // 👇 [YENİ] Vekil değişkeni
  let attorneyName = ''; 

  // Görseli yakala
  const img1 = tr.querySelector('img');
  if (img1?.src) imageSrc = img1.src;

  // Sahip Adı (role attribute varsa)
  const ownerElement = tr.querySelector('td[role="holdName"]');
  if (ownerElement) {
    ownerName = ownerElement.textContent.trim().replace(/\s*\(\d+\)\s*$/, '');
  }

  // 👇 [YENİ] VEKİL BİLGİSİNİ YAKALAMA 👇
  // Yöntem 1: Role attribute kontrolü (Varsa en garantisi budur)
  const attorneyElement = tr.querySelector('td[role="agentName"]') || tr.querySelector('td[role="attorneyName"]');
  
  if (attorneyElement) {
      attorneyName = attorneyElement.textContent.trim();
  } else {
      // Yöntem 2: İndeks ile yakalama (Role yoksa)
      // TürkPatent tablosunda Vekil genellikle 8. indekste (9. sırada) olur.
      // Eğer loglarda farklı görürseniz buradaki [8] sayısını değiştirin.
      if (tds[8]) attorneyName = tds[8].textContent.trim();
  }
  // 👆 --------------------------------- 👆

  // Mevcut döngü (Statü, Başvuru No, Tarih vb. yakalamak için)
  for (let i = 0; i < tds.length; i++) {
    const cellText = (tds[i]?.textContent || '').trim();

    // Statü Yakalama
    if (!status) {
      if (/MARKA\s*BAŞVURUSU\/TESCİLİ\s*GEÇERSİZ/i.test(cellText)) {
        status = 'MARKA BAŞVURUSU/TESCİLİ GEÇERSİZ';
      }
    }

    // Başvuru Numarası Yakalama (Regex ile)
    if (!applicationNumber && /^((?:19|20)\d{2}|\d{2})\/\d+$/.test(cellText)) {
      applicationNumber = normalizeAppNo(cellText);
      
      // Marka Adı (Bir sonraki hücre)
      if (tds[i + 1] && !brandName) {
        const nextCell = (tds[i + 1].textContent || '').trim();
        if (nextCell && !/LİMİTED|ŞİRKETİ/i.test(nextCell)) {
          brandName = nextCell;
        }
      }

      // Başvuru Tarihi (İki sonraki hücre)
      if (tds[i + 2] && !applicationDate) {
        const dateCell = (tds[i + 2].textContent || '').trim();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateCell)) {
          applicationDate = dateCell;
        }
      }
      continue;
    }
    
    // ... Diğer yakalamalar (Tarih, Tescil No, Nice) ...
    if (!applicationDate && /^\d{2}\.\d{2}\.\d{4}$/.test(cellText)) { applicationDate = cellText; continue; }
    if (!registrationNumber && /^\d{4}\s+\d+$/.test(cellText)) { registrationNumber = cellText; continue; }
    if (!niceClasses && /\d+/.test(cellText) && cellText.includes('/')) { niceClasses = cellText; continue; }
  }

  // Esnek Başvuru No taraması (Yedek)
  if (!applicationNumber) {
    for (let i = 0; i < tds.length; i++) {
      const cellText = (tds[i]?.textContent || '').trim();
      if (/(?:\d{4}|\d{2})\/\d/.test(cellText) || /\d{4}-\d/.test(cellText)) {
        applicationNumber = normalizeAppNo(cellText);
        break;
      }
    }
  }

  return {
    order: Number(orderTxt) || (idx + 1),
    applicationNumber,
    brandName,
    ownerName,
    applicationDate,
    registrationNumber,
    status,
    niceClasses,
    imageSrc,
    attorneyName // 👈 [YENİ] Bunu return objesine eklemeyi unutmayın!
  };
}

// ============================================================
// DOĞRULAMALI SERİ TOPLAYICI
// ============================================================
async function collectOwnerResultsWithDetails() {
  console.log('🚀 collectOwnerResultsWithDetails başladı (TARGET CHECK MODE)');

  const rows = Array.from(document.querySelectorAll('tbody.MuiTableBody-root tr, tbody tr'));
  const processedApplicationNumbers = new Set();
  const batchSize = 100; 

  async function resetModalState() {
    try { 
      closeAnyOpenDialog(); 
      if (typeof waitForNoDialog === 'function') await waitForNoDialog(1500);
      else await sleep(1000);
    } catch (e) {}
  }

  for (let batchStart = 0; batchStart < rows.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, rows.length);
    const currentBatch = rows.slice(batchStart, batchEnd);

    console.log(`📦 Batch ${Math.floor(batchStart / batchSize) + 1} işleniyor...`);
    const batchItems = [];

    for (const [localIdx, tr] of currentBatch.entries()) {
      tr.scrollIntoView({ block: 'center' });
      await sleep(50); 

      const globalIdx = batchStart + localIdx;
      const base = parseOwnerRowBase(tr, globalIdx);

      if (!base.applicationNumber) continue;

      base.applicationNumber = normalizeAppNo(base.applicationNumber);
      
      // Duplicate kontrolü
      if (processedApplicationNumbers.has(base.applicationNumber)) continue;
      processedApplicationNumbers.add(base.applicationNumber);
      
      base.thumbnailSrc = base.imageSrc || null;

      // --- İLK DENEME ---
      await resetModalState();
      
      // YENİLİK BURADA: base.applicationNumber'ı parametre olarak gönderiyoruz 👇
      let detail = await withModalLock(() => openRowModalAndParse(tr, base.applicationNumber, { timeout: 6000 }));
      
      let isVerified = false;

      // Basit Doğrulama (Zaten fonksiyon doğru numarayı beklediği için burası genelde true döner)
      const verifyDetail = (d) => {
          if (!d) return false;
          const dNo = getDetailAppNo(d);
          return dNo && numbersMatch(base.applicationNumber, dNo);
      };

      isVerified = verifyDetail(detail);

      // --- İKİNCİ DENEME (Eğer ilkinde hata/timeout olduysa) ---
      if (!isVerified) {
          console.warn(`⚠️ [${base.applicationNumber}] İlk deneme başarısız. Tekrar deneniyor...`);
          await sleep(1000); 
          await resetModalState();
          
          // İkinci denemede süreyi uzatıyoruz (15 sn) ve yine numarayı gönderiyoruz 👇
          detail = await withModalLock(() => openRowModalAndParse(tr, base.applicationNumber, { timeout: 15000 }));
          isVerified = verifyDetail(detail);
          
          if (!isVerified) {
              console.error(`❌ [${base.applicationNumber}] İkinci deneme de başarısız. Liste verisi kullanılacak.`);
          }
      }

      // Veriyi kaydet
      if (detail && isVerified) {
        base.details = detail.fields || {};
        
        // 👇 [YENİ] Detaydan gelen vekil bilgisini ana objeye ekle
        if (base.details['Vekil Bilgileri']) {
            base.attorneyName = base.details['Vekil Bilgileri'];
            // Debug için log
            console.log(`⚖️ Vekil Bulundu (${base.applicationNumber}):`, base.attorneyName);
        }

        if (Array.isArray(detail.goodsAndServices)) base.goodsAndServicesByClass = detail.goodsAndServices;
        if (Array.isArray(detail.transactions)) base.transactions = detail.transactions;
        if (detail.imageDataUrl) {
          base.brandImageDataUrl = detail.imageDataUrl;
          base.brandImageUrl = detail.imageDataUrl;
          base.imageSrc = detail.imageDataUrl;
        }
      }

      batchItems.push(base);
      await sleep(50); 
    }

    if (batchItems.length > 0) {
      sendToOpener('BATCH_VERI_GELDI_KISI', {
        batch: batchItems,
        batchNumber: Math.floor(batchStart / batchSize) + 1,
        totalBatches: Math.ceil(rows.length / batchSize),
        processedCount: batchEnd,
        totalCount: rows.length,
        isComplete: batchEnd >= rows.length
      });
      await sleep(100);
    }
  }

  sendToOpener('VERI_GELDI_KISI_COMPLETE', {
    totalProcessed: processedApplicationNumbers.size,
    totalRows: rows.length
  });
}

async function waitAndSendOwnerResults() {
  // 1) Önce meta: "... kayıt bulundu" gelene kadar bekle ve oku
  let expected = await waitForTotalMetaAndParse(60000); // 60s'e kadar bekle
  if (typeof expected !== 'number' || !(expected > 0)) {
    // Meta bulunamazsa yine de tabloya göre ilerleyelim (fallback)
    try { await waitFor('tbody.MuiTableBody-root tr', { timeout: 20000 }); } catch {}
    expected = getExpectedTotalCount(); // son bir kez daha dene
  }
  log('Beklenen toplam kayıt:', expected);

  // 2) Tablo en az bir satır gözüksün
  try { await waitFor('tbody.MuiTableBody-root tr', { timeout: 30000 }); } catch {}

  // 3) Sonsuz Liste gerekiyorsa aç
  try {
    const initialCount = document.querySelectorAll('tbody.MuiTableBody-root tr').length;
    const needInfinite = (typeof expected === 'number' ? expected >= 20 : initialCount >= 20);
    if (needInfinite) {
      const ok = await ensureInfiniteOn();
      if (ok && typeof expected === 'number' && expected > 0) {
        // 4) STRICT: beklenen sayıya ulaşana kadar yükleme→bekle→scroll
        const loaded = await infiniteScrollAllRowsSTRICT(expected, { overallTimeoutMs: 360000 });
        if (typeof loaded === 'number' && loaded < expected) {
          log('Uyarı: beklenen sayıya ulaşılamadı. loaded:', loaded, 'expected:', expected);
        }
      }
    }
  } catch (e) { /* yoksay */ }

  // 4) Beklenen sayıya ulaşmadan ERKEN GÖNDERMEYİ ÖNLE! (meta biliniyorsa)
  const finalCount = document.querySelectorAll('tbody.MuiTableBody-root tr').length;
  if (typeof expected === 'number' && expected > 0 && finalCount < expected) {
    log('Beklenen sayıya ulaşılmadı, veri gönderilmeyecek. final:', finalCount, 'expected:', expected);
    sendToOpener('HATA_KISI', { message: 'Sonuçların tam listelemesi tamamlanmadı.', loaded: finalCount, expected });
    return;
  }

  // 5) Satırları MODAL ile detaylı parse et (görsel dahil)
  await collectOwnerResultsWithDetails(); // Düzeltildi
}

// --------- Ana Akış ---------
async function runOwnerFlow() {
  log('Sahip No akışı başladı:', targetKisiNo);
  if (!targetKisiNo) { warn('targetKisiNo boş; çıkış.'); return; }

  try { await closeFraudModalIfAny(); } catch {}

  // input[placeholder="Kişi Numarası"]
  let kisiInput =
    document.querySelector('input.MuiInputBase-input.MuiInput-input[placeholder="Kişi Numarası"]') ||
    document.querySelector('input[placeholder="Kişi Numarası"]');

  if (!kisiInput) {
    kisiInput = await waitFor('input[placeholder="Kişi Numarası"]', { timeout: 6000 }).catch(()=>null);
  }
  if (!kisiInput) { err('Kişi Numarası alanı bulunamadı.'); sendToOpener('HATA_KISI', { message: 'Kişi Numarası alanı bulunamadı.' }); return; }

  // Aynı bloktaki Sorgula butonu → yoksa globalde bul → en sonda Enter
  let container = kisiInput.closest('.MuiFormControl-root') || kisiInput.closest('form') || document;
  let sorgulaBtn = Array.from(container.querySelectorAll('button')).find(b => /sorgula/i.test(b.textContent || ''));
  if (!sorgulaBtn) {
    const allButtons = Array.from(document.querySelectorAll('button'));
    sorgulaBtn = allButtons.find(b => /sorgula/i.test(b.textContent || ''));
  }

  kisiInput.focus();
  setReactInputValue(kisiInput, String(targetKisiNo));
  log('Kişi No yazıldı.');

  sendToOpener('SORGU_BASLADI');
  if (sorgulaBtn && click(sorgulaBtn)) {
    log('Sorgula tıklandı. ✔');
  } else {
    pressEnter(kisiInput);
    log('Sorgula butonu yok; Enter gönderildi. ✔');
  }
  await waitAndSendOwnerResults();
}

// Yeni: "Dosya Takibi" sekmesine geçişi sağlayan yardımcı fonksiyon
async function ensureDosyaTakibiTab() {
  let tabBtn = document.querySelector('button[role="tab"]') || await waitFor('button[role="tab"]', { timeout: 4000 });
  if (!tabBtn) {
    log('Dosya Takibi/Marka Araştırma sekmeleri bulunamadı, bekleniyor...');
    tabBtn = await waitFor('button[role="tab"]', { timeout: 6000 });
  }

  // Doğru sekme metnini bul
  let dosyaTakibiBtn = Array.from(document.querySelectorAll('button[role="tab"]'))
    .find(btn => (btn.textContent || '').trim().toLowerCase().includes('dosya takibi'));
  
  if (dosyaTakibiBtn) {
    if (dosyaTakibiBtn.getAttribute('aria-selected') !== 'true') {
      click(dosyaTakibiBtn);
      log('[Evreka Eklenti] "Dosya Takibi" sekmesine tıklandı.');
      await sleep(500); // Sekme geçişi için kısa bekleme
    } else {
      log('[Evreka Eklenti] "Dosya Takibi" zaten aktif.');
    }
  } else {
    warn('[Evreka Eklenti] "Dosya Takibi" sekmesi bulunamadı.');
    // Hata durumunda akışı durdurabiliriz veya devam edebiliriz
    // Devam etmek, marka araştırması formunda sorgu yapmaya çalışır ki bu istenmeyen bir durum olabilir
  }
}

// Yeni: Başvuru No akışı
async function runApplicationFlow() {
  log('Başvuru No akışı başladı:', targetAppNo);
  if (!targetAppNo) { warn('targetAppNo boş; çıkış.'); return; }

  try { await closeFraudModalIfAny(); } catch {}

  // 1) Önce doğru sekmeye geçiş yap
  await ensureDosyaTakibiTab();
  
  // input[placeholder="Başvuru Numarası"]
  let appInput =
    document.querySelector('input.MuiInputBase-input.MuiInput-input[placeholder="Başvuru Numarası"]') ||
    document.querySelector('input[placeholder="Başvuru Numarası"]');

  if (!appInput) {
    appInput = await waitFor('input[placeholder="Başvuru Numarası"]', { timeout: 6000 }).catch(()=>null);
  }
  if (!appInput) {
    err('Başvuru Numarası alanı bulunamadı.');
    sendToOpener('HATA_BASVURU_ALANI_YOK', { message: 'Başvuru Numarası alanı bulunamadı.' });
    return;
  }

  // Aynı bloktaki Sorgula butonu → yoksa globalde bul → en sonda Enter
  let container = appInput.closest('.MuiFormControl-root') || appInput.closest('form') || document;
  let sorgulaBtn = Array.from(container.querySelectorAll('button')).find(b => /sorgula/i.test(b.textContent || ''));
  if (!sorgulaBtn) {
    const allButtons = Array.from(document.querySelectorAll('button'));
    sorgulaBtn = allButtons.find(b => /sorgula/i.test(b.textContent || ''));
  }

  appInput.focus();
  setReactInputValue(appInput, String(targetAppNo));
  log('Başvuru No yazıldı.');

  sendToOpener('SORGU_BASLADI');
  if (sorgulaBtn && click(sorgulaBtn)) {
    log('Sorgula tıklandı. ✔');
  } else {
    pressEnter(appInput);
    log('Sorgula butonu yok; Enter gönderildi. ✔');
  }

  // Sonuçları topla ve gönder (mevcut owner mantığını yeniden kullanıyoruz)
  await waitAndSendApplicationResults();
}

// Başvuru numarası sayfasından doğrudan detay çıkarımı (Optimized)
async function extractApplicationDetailsFromPage() {
  const details = {};
  
  try {
    log('HTML yapısından detaylar çıkarılıyor...');
    
    // Marka Bilgileri fieldset'ini bul
    const markaBilgileriFieldset = Array.from(document.querySelectorAll('fieldset')).find(fs => 
      fs.querySelector('legend')?.textContent?.includes('Marka Bilgileri')
    );
    
    if (markaBilgileriFieldset) {
      // Table hücrelerinden bilgi çıkar
      const extractFromTable = (label) => {
        const cells = Array.from(markaBilgileriFieldset.querySelectorAll('td'));
        for (let i = 0; i < cells.length - 1; i++) {
          if (cells[i].textContent.trim() === label) {
            return cells[i + 1].textContent.trim();
          }
        }
        return null;
      };
      
      // Temel bilgileri çıkar
      details.applicationNumber = normalizeAppNo(extractFromTable('Başvuru Numarası')) || '';
      details.applicationDate = extractFromTable('Başvuru Tarihi') || '';
      details.registrationNumber = extractFromTable('Tescil Numarası') || '';
      details.registrationDate = extractFromTable('Tescil Tarihi') || '';
      details.brandName = extractFromTable('Marka Adı') || '';
      details.niceClasses = extractFromTable('Nice Sınıfları') || '';
      details.brandType = extractFromTable('Türü') || '';
      details.protectionDate = extractFromTable('Koruma Tarihi') || '';
      details.status = extractFromTable('Durumu') || 'TESCİL EDİLDİ'; // Default değer
      
      // Sahip bilgileri - çok satırlı olabilir
      const sahipCell = Array.from(markaBilgileriFieldset.querySelectorAll('td')).find((cell, i, cells) => 
        cells[i-1]?.textContent?.trim() === 'Sahip Bilgileri'
      );
      if (sahipCell) {
        const sahipTexts = Array.from(sahipCell.querySelectorAll('p')).map(p => p.textContent.trim());
        if (sahipTexts.length > 1) {
          details.ownerName = sahipTexts[1]; // İkinci satır genellikle şirket adı
          details.ownerId = sahipTexts[0]; // İlk satır genellikle TPE numarası
        }
      }
      
      // Marka görseli
      const img = markaBilgileriFieldset.querySelector('img[src*="data:image"]');
      if (img && img.src) {
        details.brandImageUrl = img.src;
        details.brandImageDataUrl = img.src;
        details.imageSrc = img.src;
      }
    }
    
// Mal ve Hizmet Bilgileri
    const malHizmetFieldset = Array.from(document.querySelectorAll('fieldset')).find(fs => 
      fs.querySelector('legend')?.textContent?.includes('Mal ve Hizmet')
    );
    
    if (malHizmetFieldset) {
      const goodsAndServices = [];
      const niceClassesSet = new Set();
      const rows = malHizmetFieldset.querySelectorAll('tbody tr');
      
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const classNum = cells[0].textContent.trim();
          const description = cells[1].textContent.trim();
          if (classNum && description) {
            goodsAndServices.push({
              classNo: parseInt(classNum),
              items: description.split('\n').filter(item => item.trim() !== '') // Düzeltildi
            });
            niceClassesSet.add(classNum);
          }
        }
      });
      
      details.goodsAndServicesByClass = goodsAndServices;
      details.niceClasses = Array.from(niceClassesSet).join(' / ');
    }
    
    // İşlem Bilgileri - son durumu bul
    const islemFieldset = Array.from(document.querySelectorAll('fieldset')).find(fs => 
      fs.querySelector('legend')?.textContent?.includes('İşlem Bilgileri')
    );
    
    if (islemFieldset) {
      const transactions = [];
      const rows = islemFieldset.querySelectorAll('tbody tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          const tarih = cells[0].textContent.trim();
          const islem = cells[2].textContent.trim();
          if (tarih && islem && !cells[0].hasAttribute('colspan')) { // colspan olanları skip et
            transactions.push({
              date: tarih,
              action: islem,
              description: cells[3]?.textContent?.trim() || ''
            });
          }
        }
      });
      details.transactions = transactions;
      
      // En son işlemden durumu belirle
      if (transactions.length > 0) {
        const lastAction = transactions[transactions.length - 1].action;
        if (lastAction.includes('TESCİL')) {
          details.status = 'TESCİL EDİLDİ';
        } else if (lastAction.includes('YAYIN')) {
          details.status = 'YAYINLANDI';
        }
      }
    }
    
    log('HTML yapısından çıkarılan detaylar:', details);
    return details;
    
  } catch (e) {
    warn('Sayfa detay çıkarımında hata:', e?.message);
    // Fallback - basit text-based extraction
    return extractDetailsFromText();
  }
}

// Fallback fonksiyon
function extractDetailsFromText() {
  const details = {};
  const pageText = document.body.textContent || '';
  
  const appNoMatch = pageText.match(/Başvuru Numarası[:\s]*((?:\d{4}|\d{2})\/\d+)/i); // Düzeltildi
  if (appNoMatch) details.applicationNumber = normalizeAppNo(appNoMatch[1]);
  
  const brandNameMatch = pageText.match(/Marka Adı[:\s]*([^\n\r]+)/i); // Düzeltildi
  if (brandNameMatch) details.brandName = brandNameMatch[1].trim();
  
  const statusMatch = pageText.match(/TESCİL EDİLDİ|YAYINLANDI|KABUL|RET/i);
  if (statusMatch) details.status = statusMatch[0];
  
  const img = document.querySelector('img[src*="data:image"]');
  if (img && img.src) {
    details.brandImageUrl = img.src;
    details.brandImageDataUrl = img.src;
  }
  
  return details;
}

// Başvuru numarası için özelleştirilmiş sonuç toplama
async function waitAndSendApplicationResults() {
  log('Başvuru numarası sonuçları toplanıyor...');
  
  // Tek kayıt beklentisi ile basit bekleme
  try { 
    await waitFor('tbody.MuiTableBody-root tr, tbody tr', { timeout: 15000 }); 
  } catch {
    log('Sonuç tablosu bulunamadı, sayfa yapısı kontrol ediliyor...');
    // Alternatif: doğrudan sayfa içeriğinden parse et
    await parseApplicationResultFromPage();
    return;
  }

  // Tablo varsa basit parse (modal açmadan)
  const rows = Array.from(document.querySelectorAll('tbody.MuiTableBody-root tr, tbody tr'));
  if (rows.length === 0) {
    log('Hiç sonuç bulunamadı');
    sendToOpener('HATA_BASVURU', { message: 'Bu başvuru numarası için sonuç bulunamadı.' });
    return;
  }

  log(`${rows.length} sonuç bulundu, parse ediliyor...`);
  const items = [];
  
  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    const item = parseOwnerRowBase(tr, i);
    
    if (item.applicationNumber) {
      // Başvuru numarası için ek detayları sayfadan topla
      const pageDetails = await extractApplicationDetailsFromPage();
      if (pageDetails) {
        Object.assign(item, pageDetails);
      }
      items.push(item);
    }
  }

  if (items.length > 0) {
    sendToOpener('VERI_GELDI_BASVURU', items);
  } else {
    sendToOpener('HATA_BASVURU', { message: 'Başvuru numarası sonuçları işlenirken hata oluştu.' });
  }
}

// Yeni: parseApplicationResultFromPage fonksiyonunu ekleyelim (Eksikti)
async function parseApplicationResultFromPage() {
  try {
    // Basit parse'ı doğrudan çağırıyoruz (detaylı modal açma ihtiyacı yok)
    const details = await extractApplicationDetailsFromPage();
    if (!details || !details.applicationNumber) {
      throw new Error('Ana uygulama detayları çıkarılamadı.');
    }

    const item = {
      applicationNumber: details.applicationNumber,
      brandName: details.brandName || details.fields?.['Marka Adı'] || '',
      ownerName: details.ownerName || details.fields?.['Sahip Adı'] || '',
      applicationDate: details.applicationDate || details.fields?.['Başvuru Tarihi'] || '',
      registrationNumber: details.registrationNumber || details.fields?.['Tescil Numarası'] || '',
      status: details.status || details.fields?.['Durumu'] || 'Bilinmiyor',
      niceClasses: details.niceClasses || details.fields?.['Nice Sınıfları'] || '',
      brandImageUrl: details.brandImageUrl,
      brandImageDataUrl: details.brandImageDataUrl,
      details: details.fields || {},
      goodsAndServicesByClass: details.goodsAndServicesByClass || [],
      transactions: details.transactions || []
    };

    log('Tekil Başvuru Sonucu Gönderiliyor:', item.applicationNumber);
    sendToOpener('VERI_GELDI_BASVURU', [item]);
    return true;
  } catch (e) {
    err('❌ parseApplicationResultFromPage hatası:', e.message);
    sendToOpener('HATA_BASVURU', { message: 'Sayfa yüklenmesi bekleniyor veya detaylar bulunamadı.' });
    return false;
  }
}

// Dış mesajlar: AUTO_FILL (geri uyum) ve AUTO_FILL_BASVURU
chrome.runtime?.onMessage?.addListener?.((request, sender, sendResponse) => {
  if (request?.type === 'AUTO_FILL' && request?.data) {
    targetAppNo = request.data;
    runApplicationFlow().catch(err);
    sendResponse?.({ status: 'OK' });
    return true;
  }
  if (request?.type === 'AUTO_FILL_BASVURU' && request?.data) {
    targetAppNo = request.data;
    runApplicationFlow().catch(err);
    sendResponse?.({ status: 'OK' });
    return true;
  }
  return true;
});
// --------- Background ve URL tetikleyicileri ---------
chrome.runtime?.onMessage?.addListener?.((request, sender, sendResponse) => {
  if (request?.type === 'AUTO_FILL_KISI' && request?.data) {
    targetKisiNo = request.data;
    runOwnerFlow().catch(err);
    sendResponse?.({ status: 'OK' });
  }
  return true;
});

// Parent → iframe köprüsü
function broadcastAutoQueryToFrames(value, queryType = 'sahip') {
  try {
    const payload = { source: 'EVREKA', type: 'EVREKA_AUTO_QUERY', queryType, value };
    const frames = window.frames || [];
    for (let i = 0; i < frames.length; i++) {
      try { frames[i].postMessage(payload, '*'); } catch {}
    }
    window.postMessage(payload, '*');
    log('auto_query yayınlandı:', payload);
  } catch (e) { warn('broadcastAutoQueryToFrames hata:', e?.message); }
}
window.addEventListener('message', (e) => {
  const msg = e?.data;
  if (!msg || msg.source !== 'EVREKA' || msg.type !== 'EVREKA_AUTO_QUERY') return;
  if (msg.queryType === 'sahip') {
    targetKisiNo = msg.value;
    runOwnerFlow().catch(err);
  } else if (msg.queryType === 'basvuru') {
    targetAppNo = msg.value;
    runApplicationFlow().catch(err);
  }
}, false);

function captureUrlParams() {
  try {
    const url = new URL(window.location.href);
    const autoQuery = url.searchParams.get('auto_query');
    const queryType = url.searchParams.get('query_type');
    const src = url.searchParams.get('source');
    if (src) sourceOrigin = src;
    if (autoQuery && (queryType === 'sahip' || queryType === 'basvuru' || queryType === 'application')) {
      log('URL üzerinden auto_query alındı:', autoQuery, 'queryType:', queryType, 'sourceOrigin:', sourceOrigin);
      
      // QueryType parametresini broadcastAutoQueryToFrames'e geçir
      const broadcastQueryType = queryType === 'sahip' ? 'sahip' : 'basvuru';
      broadcastAutoQueryToFrames(autoQuery, broadcastQueryType);
      
      if (queryType === 'sahip') { 
        targetKisiNo = autoQuery; 
        runOwnerFlow().catch(err); 
      } else { 
        targetAppNo = autoQuery; 
        runApplicationFlow().catch(err); 
      }
      return true;
    }
  } catch (e) { warn('URL param hatası:', e?.message); }
  return false;
}

document.addEventListener('DOMContentLoaded', () => {
  log('DOMContentLoaded. frame:', window.self !== window.top ? 'iframe' : 'top');
  captureUrlParams();
});
window.addEventListener('load', () => {
  log('window.load. frame:', window.self !== window.top ? 'iframe' : 'top');
  captureUrlParams();
});

// ============================================
// OPTS.TURKPATENT.GOV.TR İÇİN ÖZEL AKIM
// ============================================
// Tablo sonuçlarını scrape et
function scrapeOptsTableResults(rows, appNo) {
  log('[OPTS] 📊 Scraping başlatıldı, appNo:', appNo);
  
  const results = [];
  
  // Marka Görselini doğrudan en üst seviye div'den çekelim
  const imageContainer = document.querySelector('.MuiBox-root img[alt="Marka Görseli"]');
  const imgUrl = imageContainer ? imageContainer.src : null;
  
  log('[OPTS] 🖼️ Görsel URL:', imgUrl ? 'Bulundu' : 'Bulunamadı');

  const item = {
    applicationNumber: appNo,
    brandName: '',
    ownerName: '',
    applicationDate: '',
    registrationNumber: '',
    status: '',
    niceClasses: '',
    imageSrc: imgUrl,
    brandImageUrl: imgUrl,
    brandImageDataUrl: imgUrl,
    fields: {},
    details: {}
  };

  // ✅ İLK TABLO: Marka Bilgileri (4 kolonlu Key-Value-Key-Value yapısı)
  const firstTableBody = document.querySelector('tbody.MuiTableBody-root');
  
  if (!firstTableBody) {
    err('[OPTS] ❌ tbody.MuiTableBody-root bulunamadı!');
    sendToOpener('HATA_OPTS', { message: 'Tablo yapısı bulunamadı' });
    return;
  }
  
  log('[OPTS] ✅ İlk tablo tbody bulundu');
  
  const dataRows = firstTableBody.querySelectorAll('tr.MuiTableRow-root');
  log('[OPTS] 📊 Toplam satır sayısı:', dataRows.length);
  
  dataRows.forEach((dataRow, rowIndex) => {
    const rowCells = dataRow.querySelectorAll('td.MuiTableCell-root, td.MuiTableCell-body');
    const cellTexts = Array.from(rowCells).map(c => (c.textContent || '').trim());
    
    // Debug: İlk 3 satırı logla
    if (rowIndex < 3) {
      log(`[OPTS] Satır ${rowIndex + 1}: ${rowCells.length} hücre -`, cellTexts);
    }

    // 4 HÜCRELİ: Key1, Value1, Key2, Value2
    if (rowCells.length === 4) {
      const key1 = cellTexts[0];
      let value1 = cellTexts[1];
      const key2 = cellTexts[2];
      let value2 = cellTexts[3];

      // '--' değerlerini boş string yap
      if (value1 === '--' || value1 === '-') value1 = '';
      if (value2 === '--' || value2 === '-') value2 = '';

      if (key1 && value1) {
        item.fields[key1] = value1;
        item.details[key1] = value1;
      }
      if (key2 && value2) {
        item.fields[key2] = value2;
        item.details[key2] = value2;
      }
      
      if (rowIndex < 3) {
        log(`[OPTS]   ✅ 4 hücreli: ${key1}="${value1}", ${key2}="${value2}"`);
      }
    } 
    // COLSPAN DURUMU (Sahip/Vekil Bilgileri)
    else if (rowCells.length === 2) {
      const key = cellTexts[0];
      const valueCell = rowCells[1];
      const colspanVal = valueCell.getAttribute('colspan');
      
      if (colspanVal === '3') {
        // Sahip/Vekil Bilgileri özel işleme
        if (key.includes('Sahip Bilgileri') || key.includes('Vekil Bilgileri')) {
          const lines = Array.from(valueCell.querySelectorAll('div'))
            .map(d => d.textContent.trim())
            .filter(Boolean);
          
          const joinedValue = lines.join(' | ');
          item.fields[key] = joinedValue;
          item.details[key] = joinedValue;
          
          // Sahip adını özel olarak çıkar
          if (key.includes('Sahip Bilgileri') && lines.length > 1) {
            item.ownerName = lines[1];
          }
          
          log(`[OPTS]   ✅ Colspan (${key}): ${lines.length} satır birleştirildi`);
        } else {
          let val = valueCell.textContent.trim();
          if (val === '--' || val === '-') val = '';
          if (key && val) {
            item.fields[key] = val;
            item.details[key] = val;
          }
        }
      } else {
        // Normal 2 hücreli
        let val = cellTexts[1];
        if (val === '--' || val === '-') val = '';
        if (key && val) {
          item.fields[key] = val;
          item.details[key] = val;
        }
      }
    }
  });

  // ✅ İKİNCİ TABLO: Mal ve Hizmetler (varsa)
  const allTables = document.querySelectorAll('table.MuiTable-root');
  log('[OPTS] 📋 Toplam tablo sayısı:', allTables.length);
  
  if (allTables.length > 1) {
    const secondTable = allTables[1];
    const headers = secondTable.querySelectorAll('th');
    const headerTexts = Array.from(headers).map(h => h.textContent.trim());
    
    log('[OPTS] 📋 2. tablo header\'ları:', headerTexts);
    
    if (headerTexts.some(h => h.includes('Sınıf'))) {
      const goodsRows = secondTable.querySelectorAll('tbody tr');
      const goodsAndServices = [];
      
      goodsRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length === 2) {
          const classNo = parseInt(cells[0].textContent.trim());
          const description = cells[1].textContent.trim();
          
          if (!isNaN(classNo) && description) {
            goodsAndServices.push({
              classNo: classNo,
              items: [description]
            });
          }
        }
      });
      
      if (goodsAndServices.length > 0) {
        item.goodsAndServicesByClass = goodsAndServices;
        log('[OPTS] ✅ Mal ve Hizmetler:', goodsAndServices.length, 'sınıf bulundu');
      }
    }
  }

  // Ana alanlara mapping
  item.applicationDate = item.fields['Başvuru Tarihi'] || '';
  item.registrationNumber = item.fields['Tescil Numarası'] || '';
  item.niceClasses = item.fields['Nice Sınıfları'] || '';
  item.status = item.fields['Durumu'] || item.fields['Karar'] || '';
  item.brandName = item.fields['Marka Adı'] || '';
  
  // Başvuru numarasını normalize et
  const finalAppNo = normalizeAppNo(item.fields['Başvuru Numarası'] || item.applicationNumber);
  item.applicationNumber = finalAppNo;

  log('[OPTS] 📝 Final değerler:', {
    appNo: finalAppNo,
    brandName: item.brandName,
    ownerName: item.ownerName,
    status: item.status,
    fieldsCount: Object.keys(item.fields).length
  });

  if (finalAppNo) {
    log(`[OPTS] ✅ Başarıyla tamamlandı: ${finalAppNo}`);
    results.push(item);
  } else {
    err('[OPTS] ❌ Başvuru numarası çıkarılamadı');
  }
  
  // Sonuçları gönder
  if (results.length > 0) {
    const firstAppNo = results[0].applicationNumber;
    
    // Duplicate kontrolü - Her başvuru için sadece 1 kez gönder
    if (__EVREKA_SENT_OPTS_MAP__[firstAppNo]) {
      log('[OPTS] ⚠️ Duplicate VERI_GELDI_OPTS engellendi:', firstAppNo);
      return; // Mesaj gönderme, direkt çık
    }
    
    __EVREKA_SENT_OPTS_MAP__[firstAppNo] = true;
    log('[OPTS] 📤 VERI_GELDI_OPTS gönderiliyor:', results);
    sendToOpener('VERI_GELDI_OPTS', results);
    
    // Başarılı scrape sonrası sekme kapatma
    setTimeout(() => {
      log('[OPTS] 🚪 Sekme kapatılıyor...');
      window.close();
    }, 2000); // 3 saniye -> 2 saniye
  } else {
    err('[OPTS] ❌ Sonuç listesi boş');
    
    // Hata mesajını da sadece 1 kez gönder
    const errorKey = `ERROR_${optsCurrentAppNo || 'unknown'}`;
    if (!__EVREKA_SENT_ERR_MAP__[errorKey]) {
      __EVREKA_SENT_ERR_MAP__[errorKey] = true;
      sendToOpener('HATA_OPTS', { message: 'Scrape sonrası sonuç listesi boş kaldı.' });
    }
  }
}

// Sonuçları bekle ve scrape et
async function waitForOptsResultsAndScrape(appNo) {
  log('[OPTS] ⏳ Sonuçlar bekleniyor...');
  
  try {
    // ✅ YENİ SEÇİCİ: Sonuçları içeren ana tablo gövdesini bekliyoruz.
    // Material UI yapısını (.MuiTableContainer-root) ve tbody içeriğini hedef al
    const tableContainer = await waitFor('.MuiTableContainer-root', { 
      timeout: 35000, // Zaman aşımı süresi artırıldı
      test: (el) => {
          // Tablo içinde en az bir MuiTableRow-root sınıfına sahip satır var mı?
          return !!el.querySelector('tbody.MuiTableBody-root tr.MuiTableRow-root');
      }
    });

    // Tablonun içindeki tüm veri satırlarını topla
    const allRows = tableContainer.querySelectorAll('tbody.MuiTableBody-root tr.MuiTableRow-root');

    if (allRows.length === 0) {
      throw new Error("Sorgu sonucu bulunamadı (0 satır).");
    }
    
    log('[OPTS] ✅ Sonuç bulundu:', allRows.length, 'satır');
    scrapeOptsTableResults(Array.from(allRows), appNo);
    return true;

  } catch (error) {
      err('[OPTS] ❌ Timeout/Hata:', error.message);
      
      // Hata mesajını sadece 1 kez gönder
      const errorKey = `ERROR_${optsCurrentAppNo || appNo}`;
      if (!__EVREKA_SENT_ERR_MAP__[errorKey]) {
        __EVREKA_SENT_ERR_MAP__[errorKey] = true;
        sendToOpener('HATA_OPTS', { message: error.message || 'Sonuç tablosu bulunamadı veya zaman aşımı' });
      }
      return false;
    }
}

// ============================================
// OPTS.TURKPATENT.GOV.TR İÇİN ÖZEL AKIM
// ============================================
let optsAlreadyProcessed = false; // Global duplicate flag
let optsCurrentAppNo = null; // İşlenen başvuru no

// Chrome message listener için handler
chrome.runtime?.onMessage?.addListener?.((request, sender, sendResponse) => {
  if (request?.type === 'AUTO_FILL_OPTS' && request?.data) {
    const appNo = request.data;
    log('[OPTS] 📨 AUTO_FILL_OPTS mesajı alındı:', appNo);
    
    // OPTS sayfasında değilsek çık
    if (!/^https:\/\/opts\.turkpatent\.gov\.tr/i.test(window.location.href)) {
      log('[OPTS] ⚠️ OPTS sayfasında değil, atlanıyor');
      sendResponse?.({ status: 'IGNORED' });
      return;
    }
    
    // Duplicate kontrolü
    if (optsAlreadyProcessed && optsCurrentAppNo === appNo) {
      log('[OPTS] ⚠️ Bu başvuru zaten işleniyor:', appNo);
      sendResponse?.({ status: 'ALREADY_PROCESSING' });
      return;
    }
    
    optsAlreadyProcessed = true;
    optsCurrentAppNo = appNo;
    
    log('[OPTS] 🚀 runOptsApplicationFlow başlatılıyor');
    
    // Async işlem başlat
    setTimeout(() => {
      runOptsApplicationFlow(appNo);
    }, 500);
    
    sendResponse?.({ status: 'OK' });
  }
});

// Sayfa yüklendiğinde hash kontrolü (fallback)
(function initOptsDetection() {
  const url = window.location.href;
  
  if (!/^https:\/\/opts\.turkpatent\.gov\.tr/i.test(url)) {
    return; // OPTS değilse çık
  }
  
  log('🎯 [OPTS] Sayfa algılandı:', url);
  
  // Hash'ten başvuru no al
  const hash = window.location.hash;
  const match = hash.match(/#bn=([^&]+)/);
  
  if (!match) {
    log('⚠️ [OPTS] Hash\'te başvuru no yok - Background\'dan mesaj bekleniyor');
    return;
  }
  
  const appNo = decodeURIComponent(match[1]);
  log('✅ [OPTS] Hash\'ten başvuru no bulundu:', appNo);
  
  // Duplicate kontrolü
  if (optsAlreadyProcessed && optsCurrentAppNo === appNo) {
    log('⚠️ [OPTS] Bu başvuru zaten işleniyor, atlanıyor');
    return;
  }
  
  optsAlreadyProcessed = true;
  optsCurrentAppNo = appNo;
  
  // 🔥 DÜZELTME 1: OPTS için 2 saniyelik beklemeyi (setTimeout) tamamen kaldırdık. Anında tetiklenir!
  log('🚀 [OPTS] runOptsApplicationFlow başlatılıyor (hash fallback)');
  runOptsApplicationFlow(appNo);
})();

// OPTS için başvuru no akışı - Kutucuğu bulur, yazar ve butona basar! (HIZLANDIRILDI 🚀)
async function runOptsApplicationFlow(appNo) {
  log('🚀 [OPTS] Hızlı Scraping ve Arama akışı başladı:', appNo);
  
  if (!appNo) {
    err('[OPTS] appNo parametresi boş!');
    return;
  }
  
  try {
    // 🔥 DÜZELTME 2: OPTS sayfasında pop-up çıkmadığı için bu bekleme mantığını sildik! (Sıfır gecikme)
    
    log('[OPTS] 🔎 Başvuru Numarası kutucuğu aranıyor...');
    
    // 🔥 DÜZELTME 3: Küçük/büyük harf ayrımını kaldırdık ("i" flag) ve bekleme süresini kıstık.
    let appInput = await waitFor('input[placeholder*="numarası" i], input.MuiInputBase-input[type="text"]', { timeout: 3000 }).catch(()=>null);

    if (!appInput) {
        err('[OPTS] ❌ Başvuru Numarası input alanı bulunamadı!');
        sendToOpener('HATA_OPTS', { message: 'Başvuru Numarası alanı sayfada bulunamadı.' });
        return;
    }

    // Butonu bul
    let container = appInput.closest('form') || document.body;
    let sorgulaBtn = Array.from(container.querySelectorAll('button')).find(b => /sorgula|ara\b/i.test(b.textContent || '')) 
                     || container.querySelector('button[aria-label="search"], button[aria-label="Ara"]') 
                     || container.querySelector('svg[data-testid="SearchIcon"]')?.closest('button');

    // Değeri Input'a Yaz ve Tıkla
    appInput.focus();
    setReactInputValue(appInput, String(appNo));
    log('[OPTS] Numarayı inputa yazdı:', appNo);

    await sleep(100); // React'ın state güncellemesi için saliselik bekleme

    if (sorgulaBtn && click(sorgulaBtn)) {
        log('[OPTS] Sorgula butonuna tıklandı. ✔');
    } else {
        pressEnter(appInput);
        log('[OPTS] Enter tuşuna basıldı. ✔');
    }

    // Sonuçları bekle ve scrape et
    log('[OPTS] Sonuçlar bekleniyor ve scrape edilecek...');
    await waitForOptsResultsAndScrape(appNo); 
    
  } catch (error) {
    err('[OPTS] ❌ Genel hata:', error);
    const errorKey = `ERROR_${optsCurrentAppNo || appNo}`;
    if (!__EVREKA_SENT_ERR_MAP__[errorKey]) {
      __EVREKA_SENT_ERR_MAP__[errorKey] = true;
      sendToOpener('HATA_OPTS', { message: error.message || 'OPTS arama/scraping hatası' });
    }
  }
}

chrome.runtime?.onMessage?.addListener?.((msg)=>{
  if (msg && msg.type === 'VERI_ALINDI_OK') {
    try {
      const sp = document.querySelector('#evrk-spinner,[data-evrk-spinner]');
      if (sp) sp.remove();
    } catch(e){}
  }
});
