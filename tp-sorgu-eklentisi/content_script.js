// [Evreka CS] TÜRKPATENT Otomatik Form Doldurucu
const TAG = '[Evreka CS]';
console.log(TAG, 'Loaded at', location.href);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// CRITICAL: Debounce mekanizması - aynı query'i tekrar çalıştırma
let lastQuery = '';
let lastQueryTime = 0;
const DEBOUNCE_MS = 1800;

function shouldProcess(appNo) {
  const now = Date.now();
  if (appNo === lastQuery && (now - lastQueryTime) < DEBOUNCE_MS) {
    console.log(TAG, '⏭️ Skipping duplicate query (debounced)');
    return false;
  }
  lastQuery = appNo;
  lastQueryTime = now;
  return true;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function waitFor(checkFn, {timeout=15000, interval=200, label=''} = {}) {
  const t0 = Date.now();
  return new Promise(async (resolve) => {
    while (Date.now() - t0 < timeout) {
      try {
        const el = typeof checkFn === 'string' ? document.querySelector(checkFn) : checkFn();
        if (el) {
          console.log(TAG, '✅', label, 'found in', Date.now()-t0, 'ms');
          return resolve(el);
        }
      } catch(e) {}
      await sleep(interval);
    }
    console.warn(TAG, '⚠️', label, 'timeout');
    resolve(null);
  });
}

function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
}

function fillInput(input, value) {
  if (!input) return;
  input.focus();
  setNativeValue(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  console.log(TAG, '📝 Input filled:', value);
}

function findButton() {
  const texts = ['SORGULA', 'Sorgula', 'sorgula'];
  const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
  
  for (const btn of buttons) {
    const text = (btn.innerText || btn.textContent || btn.value || '').trim().toLowerCase();
    if (texts.some(t => text === t.toLowerCase())) {
      console.log(TAG, '✅ Button found:', btn.innerText || btn.value);
      return btn;
    }
  }
  
  return document.querySelector('button[type="submit"]');
}

async function findInput() {
  await sleep(100);
  
  // 1) Placeholder ile
  let el = document.querySelector('input[placeholder*="Başvuru" i][placeholder*="numarası" i]');
  if (el) return el;
  
  // 2) Label ile
  const labels = document.querySelectorAll('label');
  for (const label of labels) {
    if ((label.textContent || '').includes('Başvuru Numarası')) {
      const inputId = label.getAttribute('for');
      if (inputId) {
        const input = document.getElementById(inputId);
        if (input) return input;
      }
      
      const container = label.closest('.MuiFormControl-root, .MuiTextField-root');
      if (container) {
        const input = container.querySelector('input');
        if (input) return input;
      }
    }
  }
  
  // 3) Tüm input'larda ara
  const inputs = document.querySelectorAll('input.MuiInputBase-input, input.MuiOutlinedInput-input');
  for (const inp of inputs) {
    const ph = (inp.placeholder || '').toLowerCase();
    if (ph.includes('başvuru') && ph.includes('numarası')) return inp;
  }
  
  // 4) İlk görünür input
  return Array.from(inputs).find(i => i.offsetParent !== null);
}

// ============================================
// MAIN QUERY FUNCTION
// ============================================

async function doQuery(appNo) {
  console.log(TAG, '🚀 Starting query:', appNo);
  
  // Debounce kontrolü
  if (!shouldProcess(appNo)) return;
  
  const url = location.href;
  
  // Login kontrolü
  if (/login|auth|giris/i.test(url)) {
    console.log(TAG, '🔐 On login page, waiting...');
    return;
  }
  
  // Trademark kontrolü
  if (!/^https:\/\/opts\.turkpatent\.gov\.tr\/trademark\b/i.test(url)) {
    console.log(TAG, '⚠️ Not on trademark page');
    return;
  }

  // MUI container bekle
  const container = await waitFor('.MuiBox-root, .MuiFormControl-root', { timeout: 10000, label: 'MUI Container' });
  if (container) {
    await sleep(100); // 300 → 100 (container bulunduysa az bekle)
  } else {
    await sleep(500); // Container bulunamadıysa biraz daha bekle
  }

  // Input bul
  const input = await waitFor(findInput, { timeout: 5000, label: 'Input field' });
  if (!input) {
    console.error(TAG, '❌ Input not found');
    return;
  }

  // Input doldur
  fillInput(input, appNo);
  await sleep(300);

  // Button bul
  const btn = await waitFor(findButton, { timeout: 5000, label: 'Button' });
  if (!btn) {
    console.error(TAG, '❌ Button not found');
    return;
  }

  if (btn.disabled) await sleep(500);
  
  // Tıkla
  btn.scrollIntoView({ block: 'center', behavior: 'instant' });
  await sleep(100);
  
  console.log(TAG, '🖱️ Clicking button');
  btn.click();
  console.log(TAG, '✅ Query completed!');
}

// ============================================
// MESSAGE HANDLER
// ============================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log(TAG, '📨 Message:', msg.type);
  
  if (msg?.type === 'AUTO_FILL') {
    console.log(TAG, '🎯 AUTO_FILL:', msg.data);
    setTimeout(() => doQuery(msg.data), 100);
    sendResponse({ status: 'received' });
    return true;
  }
  
  sendResponse({ status: 'unknown' });
  return true;
});

// ============================================
// HASH CAPTURE & STORAGE
// ============================================

(function() {
  const hash = window.location.hash;
  if (hash && hash.includes('#bn=')) {
    const match = hash.match(/#bn=([^&]+)/);
    if (match) {
      const appNo = decodeURIComponent(match[1]);
      console.log(TAG, '⚡ Hash captured:', appNo);
      try {
        sessionStorage.setItem('evreka_query', appNo);
        sessionStorage.setItem('evreka_time', Date.now().toString());
      } catch(e) {}
    }
  }
})();

// ============================================
// URL MONITORING
// ============================================

let lastUrl = '';

function checkUrl() {
  const currentUrl = window.location.href;
  if (currentUrl === lastUrl) return;
  
  console.log(TAG, '🌐 URL:', currentUrl);
  lastUrl = currentUrl;
  
  if (!/^https:\/\/opts\.turkpatent\.gov\.tr\/trademark\b/i.test(currentUrl)) return;
  
  console.log(TAG, '📍 Trademark page detected');
  
  // Hash kontrolü
  const hash = window.location.hash;
  const match = hash.match(/#bn=([^&]+)/);
  
  if (match) {
    const appNo = decodeURIComponent(match[1]);
    console.log(TAG, '🔖 Hash found:', appNo);
    setTimeout(() => doQuery(appNo), 700);
    return;
  }
  
  // SessionStorage kontrolü
  const stored = sessionStorage.getItem('evreka_query');
  const time = sessionStorage.getItem('evreka_time');
  
  if (stored && time) {
    const age = Date.now() - parseInt(time);
    if (age < 300000) { // 5 dakika
      console.log(TAG, '💾 Restored from sessionStorage:', stored);
      window.location.hash = `#bn=${encodeURIComponent(stored)}`;
      setTimeout(() => doQuery(stored), 700);
      return;
    }
  }
  
  // Background'a sor
  console.log(TAG, '🔍 Asking background...');
  chrome.runtime.sendMessage({ type: 'GET_PENDING_QUERY' }, (response) => {
    if (response && response.query) {
      console.log(TAG, '📦 Background query:', response.query);
      window.location.hash = `#bn=${encodeURIComponent(response.query)}`;
      setTimeout(() => doQuery(response.query), 700);
    } else {
      console.log(TAG, '❌ No query available');
    }
  });
}

// URL monitoring başlat
setInterval(checkUrl, 200);
setTimeout(checkUrl, 100);

// 2 dakika sonra durdur
setTimeout(() => {
  console.log(TAG, '⏹️ URL monitoring stopped');
}, 120000);

console.log(TAG, '✅ Ready');