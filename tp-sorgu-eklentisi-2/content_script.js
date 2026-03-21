// ================================================
// Evreka IP — OPTS (Tekil) ve API (Toplu) İçerik Scripti
// ================================================
console.log('[Evreka IP] ========== CONTENT SCRIPT LOADED ==========');
console.log('[Evreka IP] URL:', window.location.href);

// 🔥 GÜVENLİ ENJEKSİYON (CSP'Yİ BYPASS EDER)
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
script.onload = function() {
    this.remove(); // Kod sayfaya yüklendikten sonra <script> etiketini siler (İz bırakmaz)
    console.log('[Evreka IP] ✅ inject.js sayfaya başarıyla yerleştirildi!');
};
(document.head || document.documentElement).appendChild(script);

const TAG = '[Evreka IP]';
let __EVREKA_SENT_OPTS_MAP__ = {};
let __EVREKA_SENT_ERR_MAP__ = {};
let targetKisiNo = null;
let targetAppNo = null; 
let sourceOrigin = null; 
let optsAlreadyProcessed = false; 
let optsCurrentAppNo = null; 

// --------- Log Helpers ---------
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);
const err = (...a) => console.error(TAG, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms)); // 🔥 EKSİKTİ, EKLENDİ

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

// --------- EVREKA PATCH HELPERS ---------
function normalizeAppNo(appNo) {
  try {
    const raw = String(appNo || '').trim();
    if (!raw) return '';
    const parts = raw.split('/');
    if (parts.length != 2) return raw;
    let [yy, rest] = parts;
    yy = String(yy || '').trim();
    rest = String(rest || '').trim();
    if (/^\d{2}$/.test(yy)) { 
      const n = parseInt(yy, 10);
      const fullYear = (n <= 24 ? 2000 + n : 1900 + n);
      return `${fullYear}/${rest}`;
    }
    return `${yy}/${rest}`;
  } catch { return String(appNo || '').trim(); }
}

function elementHasText(el, text) {
  return !!el && (el.textContent || '').toLowerCase().includes((text || '').toLowerCase());
}

// Opener'a mesaj gönder
function sendToOpener(type, data) {
  try {
    if (window.opener && !window.opener.closed) {
      log('📤 window.opener\'a postMessage gönderiliyor:', type); 
      window.opener.postMessage({ type: type, source: 'tp-sorgu-eklentisi-2', data: data }, '*');
      return;
    }
    
    log('📤 Background\'a mesaj gönderiliyor:', type); 
    if (chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'FORWARD_TO_APP', messageType: type, data: data });
    } else { warn('⚠️ Chrome runtime API yok'); }
  } catch (error) { err('❌ sendToOpener hatası:', error); }
}

async function closeFraudModalIfAny() {
  try {
    const fraudContainer = await waitFor('.jss84', { timeout: 1800 }).catch(()=>null);
    if (fraudContainer) {
      const closeEl = fraudContainer.querySelector('.jss92');
      if (closeEl && click(closeEl)) { await sleep(100); return; }
      if (click(fraudContainer)) { await sleep(80); return; }
    }
  } catch (e) {}

  try {
    const anyDialog = await waitFor('[role="dialog"], .MuiDialog-root, .MuiModal-root, .modal', { timeout: 700 }).catch(()=>null);
    if (anyDialog) {
      const closeCandidate = anyDialog.querySelector('button[aria-label="Close"], button[aria-label="Kapat"], .close, .MuiIconButton-root[aria-label="close"]') || anyDialog.querySelector('button');
      if (closeCandidate && click(closeCandidate)) { await sleep(80); return; }
    }
  } catch (e) {}
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
}


// =========================================================================
// 🚀 1. BÖLÜM: API TABANLI TOPLU ÇEKİM (SAHİP NO İÇİN)
// =========================================================================

function fetchFromApi(appNo) {
    return new Promise((resolve) => {
        // TIMEOUT EKLENDİ (Sonsuza kadar beklemesin diye)
        const timeoutId = setTimeout(() => {
            window.removeEventListener('message', listener);
            console.error(`[Evreka IP] ❌ ZAMAN AŞIMI! API cevap vermedi: ${appNo}`);
            resolve({ error: "TIMEOUT" });
        }, 15000); // 15 Saniye bekleme süresi

        const listener = (event) => {
            if (event.data.type === 'FETCH_RESULT' && event.data.appNo === appNo) {
                clearTimeout(timeoutId); // Cevap gelirse zamanlayıcıyı iptal et
                window.removeEventListener('message', listener);
                resolve(event.data);
            }
        };
        window.addEventListener('message', listener);
        
        console.log(`[Evreka IP] 🔍 API'ye soruluyor: ${appNo}`); // YENİ LOG
        window.postMessage({ type: 'FETCH_TRADEMARK_FILE', appNo: appNo }, '*');
    });
}

async function processApiQueueWithBatching(baseRecords) {
    const CONCURRENCY_LIMIT = 3; 
    const total = baseRecords.length;
    let currentIndex = 0;
    let activeRequests = 0;
    let isRunning = true;
    const finalResults = [];
    let completedCount = 0;

    return new Promise((resolve) => {
        function processNext() {
            if (!isRunning) return;
            if (completedCount >= total && activeRequests === 0) { 
                console.log(`[Evreka IP] 🎯 TÜM İŞLEMLER BİTTİ. Toplam: ${completedCount}`);
                resolve(); 
                return; 
            }

            while (activeRequests < CONCURRENCY_LIMIT && currentIndex < total) {
                const record = baseRecords[currentIndex++];
                activeRequests++;
                
                fetchFromApi(record.appNo).then(apiResponse => {
                    activeRequests--;
                    completedCount++;
                    
                    console.log(`[Evreka IP] 📨 Cevap Geldi (${record.appNo}):`, apiResponse);

                    if (apiResponse.error) {
                        if (apiResponse.error.includes('grecaptcha') || apiResponse.error === 'HUMAN_CHECK_ERROR') {
                            isRunning = false;
                            err("reCAPTCHA Engeli!");
                            sendToOpener('HATA_KISI', { message: 'Google reCAPTCHA engeli! Bot olduğumuzu anladı. Lütfen sayfayı yenileyip tekrar deneyin.' });
                            resolve(); return;
                        }
                        finalResults.push({ applicationNumber: record.appNo, brandName: record.brandName, applicationDate: record.applicationDate, status: record.status, details: { "Durumu": record.status } });
                    } else if (apiResponse.data && apiResponse.data.success) {
                        const apiData = apiResponse.data.payload?.item; 
                        
                        if (apiData) {
                            const info = apiData.markInformation || {};
                            const niceInfo = apiData.niceInformation || [];
                            
                            // 🔥 1. YENİLİK: Transaction (İşlem) Listesini Garantile
                            let txList = (apiData.dossierInformation || []).flatMap(d => (d.dossierTransaction || []).map(tx => ({ date: tx.date, description: tx.transaction + " - " + (tx.description || '') })));
                            const appDate = info.applicationDate || record.applicationDate;
                            if (appDate) {
                                // Listede zaten 'başvuru' geçmiyorsa en başa manuel ekle
                                const hasAppTx = txList.some(t => (t.description || '').toLowerCase().includes('başvuru'));
                                if (!hasAppTx) {
                                    txList.unshift({ date: appDate, description: "Marka Başvurusu" });
                                }
                            }
                            
                            const mappedData = {
                                applicationNumber: info.applicationNo || record.appNo,
                                brandName: info.markName || record.brandName,
                                ownerName: (info.holderInformation && info.holderInformation.length > 0) ? info.holderInformation.map(h => h.holderName).join(', ') : (info.holdName || record.brandName || ''),
                                agentInfo: info.agentName ? (info.agentName + (info.agentInfo ? ' - ' + info.agentInfo : '')) : '',
                                applicationDate: appDate,
                                registrationNumber: info.registrationNo,
                                status: info.state || record.status,
                                brandImageDataUrl: info.figure ? (info.figure.startsWith('/9j/') ? 'data:image/jpeg;base64,' + info.figure : info.figure) : null,
                                niceClasses: info.niceClasses,
                                details: { "Durumu": record.status, "Tescil Numarası": info.registrationNo, "Tescil Tarihi": info.protectionDate, "Karar": info.state, "Vekil": info.agentName ? (info.agentName + (info.agentInfo ? ' - ' + info.agentInfo : '')) : '' },
                                goodsAndServicesByClass: niceInfo.map(n => ({ classNo: parseInt(n.niceCode), items: [n.niceDescription] })),
                                transactions: txList // 🔥 GARANTİLİ LİSTE BURAYA EKLENDİ
                            };
                            finalResults.push(mappedData);
                        } else {
                            finalResults.push({ applicationNumber: record.appNo, status: record.status }); 
                        }
                    } else { 
                        finalResults.push({ applicationNumber: record.appNo, status: record.status }); 
                    }

                    if (finalResults.length >= 50 || completedCount >= total) {
                        sendToOpener('BATCH_VERI_GELDI_KISI', { batch: [...finalResults], isLastBatch: completedCount >= total, totalCompleted: completedCount, totalExpected: total });
                        finalResults.length = 0; 
                    }
                    setTimeout(processNext, 500);
                });
            }
        }
        processNext(); 
    });
}

// --------- Sonsuz Liste Yardımcıları ---------
function findInfiniteToggle() {
  const labelCandidates = Array.from(document.querySelectorAll('label.MuiFormControlLabel-root, .MuiFormControlLabel-root, label, .MuiFormControlLabel-label, .MuiTypography-root'));
  const labelNode = labelCandidates.find(n => (n.textContent || '').toLowerCase().includes('sonsuz liste'));
  if (!labelNode) return null;
  const root = labelNode.closest('.MuiFormControlLabel-root') || labelNode.parentElement || labelNode;
  const input = root.querySelector('input.MuiSwitch-input[type="checkbox"], input[type="checkbox"]');
  const switchBase = root.querySelector('.MuiSwitch-switchBase');
  const switchRoot = root.querySelector('.MuiSwitch-root');
  return { root, labelNode, input, switchBase, switchRoot, clickable: switchBase || switchRoot || root };
}

async function ensureInfiniteOn() {
  const t = findInfiniteToggle();
  if (!t) return false;
  const isChecked = () => {
    try {
      if (t.input && typeof t.input.checked !== 'undefined') return !!t.input.checked;
      if (t.switchBase) return t.switchBase.classList.contains('Mui-checked');
      return !!t.root.querySelector('.MuiSwitch-switchBase.Mui-checked');
    } catch { return false; }
  };
  if (isChecked()) return true;

  if (t.clickable) click(t.clickable);
  await sleep(150); if (isChecked()) return true;
  if (t.input) { click(t.input); await sleep(150); if (isChecked()) return true; }
  if (t.labelNode) { click(t.labelNode); await sleep(150); if (isChecked()) return true; }
  return false;
}

function findScrollContainerFor(el) {
  let cur = el;
  while (cur) {
    const sh = cur.scrollHeight, ch = cur.clientHeight;
    const style = cur === document.documentElement ? '' : getComputedStyle(cur);
    const overflowY = style ? style.overflowY : '';
    if (sh && ch && (sh - ch > 5) && (overflowY === 'auto' || overflowY === 'scroll' || cur === document.scrollingElement)) return cur;
    cur = cur.parentElement;
  }
  return document.scrollingElement || document.documentElement || document.body;
}

function getExpectedTotalCountFromNodeText(txt) {
  const m = (txt || '').match(/(\d+)\s*kayıt\s*b[uü]lundu/i); 
  return m ? parseInt(m[1], 10) : null;
}

function getExpectedTotalCount() {
  const node = Array.from(document.querySelectorAll('p, span, div')).find(n => elementHasText(n, 'kayıt bulundu'));
  return node ? getExpectedTotalCountFromNodeText(node.textContent || '') : null;
}

async function waitForTotalMetaAndParse(timeout = 45000) {
  let expected = getExpectedTotalCount();
  if (typeof expected === 'number') return expected;
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const node = Array.from(document.querySelectorAll('p, span, div')).find(n => elementHasText(n, 'kayıt bulundu'));
    if (node) {
      expected = getExpectedTotalCountFromNodeText(node.textContent || '');
      if (typeof expected === 'number') return expected;
    }
    await sleep(500);
  }
  return null;
}

const countRows = () => document.querySelectorAll('tbody.MuiTableBody-root tr').length;
const isLoading = () => !!document.querySelector('.MuiCircularProgress-root, [role="progressbar"], .MuiBackdrop-root[aria-hidden="false"]');

function waitForRowIncrease(baseCount, timeout = 35000) {
  return new Promise((resolve) => {
    const tbody = document.querySelector('tbody.MuiTableBody-root');
    if (!tbody) return resolve(false);
    const check = () => { const n = countRows(); if (n > baseCount) { cleanup(); resolve(n); } };
    const cleanup = () => { try { obs.disconnect(); } catch {} if (poll) clearInterval(poll); if (timer) clearTimeout(timer); };
    const obs = new MutationObserver(check);
    obs.observe(tbody, { childList: true, subtree: true });
    const poll = setInterval(check, 400);
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeout);
  });
}

async function infiniteScrollAllRowsSTRICT(expectedTotal, { overallTimeoutMs = 360000 } = {}) {
  const tbody = document.querySelector('tbody.MuiTableBody-root');
  if (!tbody) return;
  const scroller = findScrollContainerFor(tbody);
  const scrollBottom = () => {
    try { if (scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body) { window.scrollTo(0, document.body.scrollHeight); } else { scroller.scrollTop = scroller.scrollHeight; } } catch {}
  };
  const start = performance.now();
  let lastCount = countRows();
  if (!expectedTotal || lastCount < expectedTotal) { await sleep(800); scrollBottom(); }

  while (true) {
    if (expectedTotal && lastCount >= expectedTotal) { await sleep(500); break; }
    if (performance.now() - start > overallTimeoutMs) break;
    const increasedTo = await waitForRowIncrease(lastCount, 35000); 
    if (increasedTo && increasedTo > lastCount) {
      lastCount = increasedTo;
      await sleep(1000);
      scrollBottom();
      continue;
    }
    if (isLoading()) { await sleep(1500); scrollBottom(); continue; }
    await sleep(1200); scrollBottom();
  }
  return lastCount;
}

async function waitAndSendOwnerResults() {
  let expected = await waitForTotalMetaAndParse(60000); 
  if (typeof expected !== 'number' || !(expected > 0)) {
    try { await waitFor('tbody.MuiTableBody-root tr', { timeout: 20000 }); } catch {}
    expected = getExpectedTotalCount(); 
  }

  try { await waitFor('tbody.MuiTableBody-root tr', { timeout: 30000 }); } catch {}

  try {
    const initialCount = document.querySelectorAll('tbody.MuiTableBody-root tr').length;
    if ((typeof expected === 'number' ? expected >= 20 : initialCount >= 20)) {
      if (await ensureInfiniteOn() && typeof expected === 'number' && expected > 0) {
        await infiniteScrollAllRowsSTRICT(expected, { overallTimeoutMs: 360000 });
      }
    }
  } catch (e) {}

  const finalCount = document.querySelectorAll('tbody.MuiTableBody-root tr').length;
  if (typeof expected === 'number' && expected > 0 && finalCount < expected) {
    sendToOpener('HATA_KISI', { message: 'Sonuçların tam listelemesi tamamlanmadı.', loaded: finalCount, expected });
    return;
  }

  const rows = document.querySelectorAll('tbody.MuiTableBody-root tr');
  const baseRecords = [];
  rows.forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 5) return;
      baseRecords.push({ appNo: (tds[1]?.textContent || '').trim(), brandName: (tds[2]?.textContent || '').trim(), applicationDate: (tds[5]?.textContent || '').trim(), status: (tds[7]?.textContent || '').trim() });
  });

  log(`Tablodan ${baseRecords.length} adet başvuru numarası toplandı. API Yağmuru başlıyor...`);
  
  // 🔥 Sitenin progress bar'ı için toplam sayıyı fırlatıyoruz!
  sendToOpener('SORGU_BASLADI', { total: baseRecords.length }); 
  
  await processApiQueueWithBatching(baseRecords);
  log('✅ Tüm kayıtlar API üzerinden sessizce çekildi!');
}

let isOwnerFlowRunning = false;
// 🔥 EKSİKTİ, EKLENDİ! Toplu Sorgulamayı Başlatan Ana Fonksiyon
async function runOwnerFlow() {
  if (isOwnerFlowRunning) return; // Zaten çalışıyorsa durdur
  isOwnerFlowRunning = true;

  log('Sahip No akışı başladı:', targetKisiNo);
  if (!targetKisiNo) { warn('targetKisiNo boş; çıkış.'); return; }
  try { await closeFraudModalIfAny(); } catch {}

  let kisiInput = document.querySelector('input.MuiInputBase-input.MuiInput-input[placeholder="Kişi Numarası"]') || document.querySelector('input[placeholder="Kişi Numarası"]');
  if (!kisiInput) kisiInput = await waitFor('input[placeholder="Kişi Numarası"]', { timeout: 6000 }).catch(()=>null);
  if (!kisiInput) { err('Kişi Numarası alanı bulunamadı.'); sendToOpener('HATA_KISI', { message: 'Kişi Numarası alanı bulunamadı.' }); return; }

  let container = kisiInput.closest('.MuiFormControl-root') || kisiInput.closest('form') || document;
  let sorgulaBtn = Array.from(container.querySelectorAll('button')).find(b => /sorgula/i.test(b.textContent || '')) || Array.from(document.querySelectorAll('button')).find(b => /sorgula/i.test(b.textContent || ''));

  kisiInput.focus();
  setReactInputValue(kisiInput, String(targetKisiNo));
  sendToOpener('SORGU_BASLADI');
  
  if (sorgulaBtn && click(sorgulaBtn)) { log('Sorgula tıklandı. ✔'); } else { pressEnter(kisiInput); }
  await waitAndSendOwnerResults();
}


// =========================================================================
// 🚀 2. BÖLÜM: OPTS TABANLI TEKİL ÇEKİM
// =========================================================================

function scrapeOptsTableResults(rows, appNo) {
  const results = [];
  const imgUrl = document.querySelector('.MuiBox-root img[alt="Marka Görseli"]')?.src || null;
  const item = { applicationNumber: appNo, brandName: '', ownerName: '', applicationDate: '', registrationNumber: '', status: '', niceClasses: '', imageSrc: imgUrl, brandImageUrl: imgUrl, brandImageDataUrl: imgUrl, fields: {}, details: {} };

  const firstTableBody = document.querySelector('tbody.MuiTableBody-root');
  if (!firstTableBody) { sendToOpener('HATA_OPTS', { message: 'Tablo yapısı bulunamadı' }); return; }
  
  firstTableBody.querySelectorAll('tr.MuiTableRow-root').forEach((dataRow) => {
    const rowCells = dataRow.querySelectorAll('td.MuiTableCell-root, td.MuiTableCell-body');
    const cellTexts = Array.from(rowCells).map(c => (c.textContent || '').trim());
    
    if (rowCells.length === 4) {
      const key1 = cellTexts[0]; let value1 = cellTexts[1]; const key2 = cellTexts[2]; let value2 = cellTexts[3];
      if (value1 === '--' || value1 === '-') value1 = ''; if (value2 === '--' || value2 === '-') value2 = '';
      if (key1 && value1) { item.fields[key1] = value1; item.details[key1] = value1; }
      if (key2 && value2) { item.fields[key2] = value2; item.details[key2] = value2; }
    } else if (rowCells.length === 2) {
      const key = cellTexts[0]; const valueCell = rowCells[1];
      if (valueCell.getAttribute('colspan') === '3') {
        if (key.includes('Sahip Bilgileri') || key.includes('Vekil Bilgileri')) {
          const lines = Array.from(valueCell.querySelectorAll('div')).map(d => d.textContent.trim()).filter(Boolean);
          item.fields[key] = lines.join(' | '); item.details[key] = item.fields[key];
          if (key.includes('Sahip Bilgileri') && lines.length > 1) item.ownerName = lines[1];
        } else {
          let val = valueCell.textContent.trim(); if (val === '--' || val === '-') val = '';
          if (key && val) { item.fields[key] = val; item.details[key] = val; }
        }
      } else {
        let val = cellTexts[1]; if (val === '--' || val === '-') val = '';
        if (key && val) { item.fields[key] = val; item.details[key] = val; }
      }
    }
  });

  const allTables = document.querySelectorAll('table.MuiTable-root');
  if (allTables.length > 1) {
    if (Array.from(allTables[1].querySelectorAll('th')).map(h => h.textContent.trim()).some(h => h.includes('Sınıf'))) {
      const goodsAndServices = [];
      allTables[1].querySelectorAll('tbody tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length === 2 && !isNaN(parseInt(cells[0].textContent.trim())) && cells[1].textContent.trim()) {
          goodsAndServices.push({ classNo: parseInt(cells[0].textContent.trim()), items: [cells[1].textContent.trim()] });
        }
      });
      if (goodsAndServices.length > 0) item.goodsAndServicesByClass = goodsAndServices;
    }
  }

  item.applicationDate = item.fields['Başvuru Tarihi'] || '';
  item.registrationNumber = item.fields['Tescil Numarası'] || '';
  item.niceClasses = item.fields['Nice Sınıfları'] || '';
  item.status = item.fields['Durumu'] || item.fields['Karar'] || '';
  item.brandName = item.fields['Marka Adı'] || '';
  item.applicationNumber = normalizeAppNo(item.fields['Başvuru Numarası'] || item.applicationNumber);

  // 🔥 2. YENİLİK: OPTS İçin Başvuru Transaction'ı
  item.transactions = [];
  if (item.applicationDate) {
      item.transactions.push({ date: item.applicationDate, description: "Marka Başvurusu" });
  }

  if (item.applicationNumber) {
    if (__EVREKA_SENT_OPTS_MAP__[item.applicationNumber]) return;
    __EVREKA_SENT_OPTS_MAP__[item.applicationNumber] = true;
    sendToOpener('VERI_GELDI_OPTS', [item]);
    setTimeout(() => { window.close(); }, 2000); 
  } else {
    const errorKey = `ERROR_${optsCurrentAppNo || 'unknown'}`;
    if (!__EVREKA_SENT_ERR_MAP__[errorKey]) { __EVREKA_SENT_ERR_MAP__[errorKey] = true; sendToOpener('HATA_OPTS', { message: 'Sonuç listesi boş kaldı.' }); }
  }
}

async function waitForOptsResultsAndScrape(appNo) {
  try {
    const tableContainer = await waitFor('.MuiTableContainer-root', { timeout: 35000, test: (el) => !!el.querySelector('tbody.MuiTableBody-root tr.MuiTableRow-root') });
    const allRows = tableContainer.querySelectorAll('tbody.MuiTableBody-root tr.MuiTableRow-root');
    if (allRows.length === 0) throw new Error("Sorgu sonucu bulunamadı (0 satır).");
    scrapeOptsTableResults(Array.from(allRows), appNo);
    return true;
  } catch (error) {
      const errorKey = `ERROR_${optsCurrentAppNo || appNo}`;
      if (!__EVREKA_SENT_ERR_MAP__[errorKey]) { __EVREKA_SENT_ERR_MAP__[errorKey] = true; sendToOpener('HATA_OPTS', { message: error.message }); }
      return false;
  }
}

async function runOptsApplicationFlow(appNo) {
  if (!appNo) return;
  try {
    let appInput = await waitFor('input[placeholder*="numarası" i], input.MuiInputBase-input[type="text"]', { timeout: 3000 }).catch(()=>null);
    if (!appInput) { sendToOpener('HATA_OPTS', { message: 'Başvuru Numarası alanı sayfada bulunamadı.' }); return; }

    let container = appInput.closest('form') || document.body;
    let sorgulaBtn = Array.from(container.querySelectorAll('button')).find(b => /sorgula|ara\b/i.test(b.textContent || '')) || container.querySelector('button[aria-label="search"], button[aria-label="Ara"]') || container.querySelector('svg[data-testid="SearchIcon"]')?.closest('button');

    appInput.focus(); setReactInputValue(appInput, String(appNo)); await sleep(100); 
    if (sorgulaBtn && click(sorgulaBtn)) { } else { pressEnter(appInput); }
    await waitForOptsResultsAndScrape(appNo); 
  } catch (error) {
    const errorKey = `ERROR_${optsCurrentAppNo || appNo}`;
    if (!__EVREKA_SENT_ERR_MAP__[errorKey]) { __EVREKA_SENT_ERR_MAP__[errorKey] = true; sendToOpener('HATA_OPTS', { message: error.message }); }
  }
}

(function initOptsDetection() {
  const url = window.location.href;
  if (!/^https:\/\/opts\.turkpatent\.gov\.tr/i.test(url)) return; 
  const match = window.location.hash.match(/#bn=([^&]+)/);
  if (!match) return;
  const appNo = decodeURIComponent(match[1]);
  if (optsAlreadyProcessed && optsCurrentAppNo === appNo) return;
  optsAlreadyProcessed = true; optsCurrentAppNo = appNo;
  runOptsApplicationFlow(appNo);
})();


// =========================================================================
// 🚀 3. BÖLÜM: URL VE MESAJ (TETİKLEYİCİ) DİNLEYİCİLERİ
// =========================================================================

chrome.runtime?.onMessage?.addListener?.((request, sender, sendResponse) => {
  if (request?.type === 'AUTO_FILL_OPTS' && request?.data) {
    if (!/^https:\/\/opts\.turkpatent\.gov\.tr/i.test(window.location.href)) { sendResponse?.({ status: 'IGNORED' }); return; }
    if (optsAlreadyProcessed && optsCurrentAppNo === request.data) { sendResponse?.({ status: 'ALREADY_PROCESSING' }); return; }
    optsAlreadyProcessed = true; optsCurrentAppNo = request.data;
    setTimeout(() => { runOptsApplicationFlow(request.data); }, 500);
    sendResponse?.({ status: 'OK' });
  }
  if (request?.type === 'AUTO_FILL_KISI' && request?.data) {
    targetKisiNo = request.data; runOwnerFlow().catch(err); sendResponse?.({ status: 'OK' });
  }
  if (request?.type === 'VERI_ALINDI_OK') {
    try { document.querySelector('#evrk-spinner,[data-evrk-spinner]')?.remove(); } catch(e){}
  }
  return true;
});

function broadcastAutoQueryToFrames(value, queryType = 'sahip') {
  try {
    const payload = { source: 'EVREKA', type: 'EVREKA_AUTO_QUERY', queryType, value };
    const frames = window.frames || [];
    for (let i = 0; i < frames.length; i++) { try { frames[i].postMessage(payload, '*'); } catch {} }
    window.postMessage(payload, '*');
  } catch (e) { }
}

window.addEventListener('message', (e) => {
  const msg = e?.data;
  if (!msg || msg.source !== 'EVREKA' || msg.type !== 'EVREKA_AUTO_QUERY') return;
  if (msg.queryType === 'sahip') { targetKisiNo = msg.value; runOwnerFlow().catch(err); } 
});

function captureUrlParams() {
  try {
    const url = new URL(window.location.href);
    const autoQuery = url.searchParams.get('auto_query');
    const queryType = url.searchParams.get('query_type');
    if (url.searchParams.get('source')) sourceOrigin = url.searchParams.get('source');
    
    if (autoQuery && queryType === 'sahip') {
      broadcastAutoQueryToFrames(autoQuery, 'sahip');
      targetKisiNo = autoQuery; runOwnerFlow().catch(err); return true;
    }
  } catch (e) { }
  return false;
}

document.addEventListener('DOMContentLoaded', captureUrlParams);
window.addEventListener('load', captureUrlParams);