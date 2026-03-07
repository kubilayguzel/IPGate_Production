// [Evreka BG] TÜRKPATENT Otomatik Sorgu Yardımcısı
const TAG = '[Evreka BG]';
console.log(TAG, 'Service worker loaded.');

const pendingQueries = new Map(); // tabId -> applicationNumber

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  console.log(TAG, 'External message:', request.type, 'from:', sender?.origin);
  
  if (request?.type === 'SORGULA' && request.data) {
    const appNo = String(request.data);
    console.log(TAG, '🔍 Query request:', appNo);
    
    const targetUrl = `https://opts.turkpatent.gov.tr/trademark#bn=${encodeURIComponent(appNo)}`;
    const isTrademark = (url="") => /^https:\/\/opts\.turkpatent\.gov\.tr\/trademark\b/i.test(url);
    const isLogin = (url="") => /login|auth|giris/i.test(url);
    const isHome = (url="") => /\/home\b/i.test(url);

    chrome.tabs.create({ url: targetUrl }, (newTab) => {
      const tabId = newTab.id;
      console.log(TAG, '✅ Tab created:', tabId);
      
      // Query'i sakla (tab kapanana kadar)
      pendingQueries.set(tabId, appNo);
      
      let messageAttempts = 0;
      let isWaitingForLogin = false;
      let hasProcessedTrademark = false;
      
      // Mesaj gönderme fonksiyonu
      const sendMessage = () => {
        const query = pendingQueries.get(tabId);
        if (!query) return;
        
        messageAttempts++;
        console.log(TAG, `📨 Sending message (${messageAttempts}/20)`);
        
        chrome.tabs.sendMessage(tabId, { type: 'AUTO_FILL', data: query }, (response) => {
          if (chrome.runtime.lastError) {
            if (messageAttempts < 20) {
              setTimeout(sendMessage, isWaitingForLogin ? 2000 : 500);
            }
          } else {
            console.log(TAG, '✅ Message delivered');
            isWaitingForLogin = false;
          }
        });
      };
      
      // URL değişikliklerini izle
      const listener = (tId, changeInfo, tab) => {
        if (tId !== tabId) return;
        
        const url = changeInfo.url || tab?.url || "";
        if (!url && changeInfo.status !== 'complete') return;
        
        if (changeInfo.url) console.log(TAG, '🌐', url);
        
        // Login algılandı
        if (isLogin(url)) {
          console.log(TAG, '🔐 Login detected');
          isWaitingForLogin = true;
          hasProcessedTrademark = false;
          messageAttempts = 0;
          return;
        }
        
        // Home algılandı
        if (isHome(url)) {
          console.log(TAG, '🏠 Home page');
          isWaitingForLogin = false;
          hasProcessedTrademark = false;
          return;
        }
        
        // Trademark sayfası algılandı
        if (isTrademark(url) || (changeInfo.status === 'complete' && isTrademark(tab?.url))) {
          console.log(TAG, '📍 Trademark page');
          
          // Zaten işlendiyse ve login/home'dan gelmediyse skip
          if (hasProcessedTrademark && !isWaitingForLogin) {
            console.log(TAG, '⏭️ Already processed');
            return;
          }
          
          hasProcessedTrademark = true;
          const query = pendingQueries.get(tabId);
          
          if (!query) {
            console.warn(TAG, '⚠️ No query for this tab');
            return;
          }
          
          // Hash kontrolü
          const hash = (tab.url || '').split('#')[1] || '';
          if (!hash.includes(`bn=${encodeURIComponent(query)}`)) {
            console.log(TAG, '🔄 Restoring hash');
            chrome.tabs.update(tabId, { 
              url: `https://opts.turkpatent.gov.tr/trademark#bn=${encodeURIComponent(query)}` 
            });
            return;
          }
          
          // Mesaj gönder
          console.log(TAG, '✉️ Preparing to send message');
          setTimeout(sendMessage, 1000);
          
          // Listener'ı 60s sonra kaldır
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            console.log(TAG, '⏹️ Listener removed');
          }, 60000);
        }
      };
      
      chrome.tabs.onUpdated.addListener(listener);
      
      // Tab kapanınca temizlik
      chrome.tabs.onRemoved.addListener((closedTabId) => {
        if (closedTabId === tabId) {
          pendingQueries.delete(tabId);
          chrome.tabs.onUpdated.removeListener(listener);
          console.log(TAG, '🧹 Cleanup done');
        }
      });
    });

    sendResponse({ status: 'OK' });
  }
  
  return true;
});

// Content script'ten query isteme
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === 'GET_PENDING_QUERY' && sender.tab?.id) {
    const query = pendingQueries.get(sender.tab.id);
    console.log(TAG, '📞 Query request from tab:', sender.tab.id, '→', query || 'none');
    sendResponse({ query: query || null });
    return true;
  }
});

console.log(TAG, '✅ Ready');