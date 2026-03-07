// ============================================
// RESULT CACHE SYSTEM (Global Kapsamda Tanımlandı)
// Bu değişkenler, Chrome oturumu boyunca hafızada kalır.
// ============================================
const resultCache = new Map();
const processedAppNos = new Set(); 

console.log('[Background] Service worker yüklendi.');

// ============================================
// EXTERNAL MESSAGES (Ana Uygulamadan Gelen)
// ============================================

// Web sitenizden gelen mesajları dinle (External - Ana Uygulamadan)
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  console.log('[Background] External mesaj alındı:', request.type, 'from:', sender?.origin);

  // Başvuru No (geriye uyum): SORGULA veya SORGULA_BASVURU (opts.turkpatent.gov.tr'ye yönlendirir)
  if ((request.type === 'SORGULA' || request.type === 'SORGULA_BASVURU') && request.data) {
      const appNo = request.data;
      const targetUrl = `https://opts.turkpatent.gov.tr/trademark#bn=${encodeURIComponent(appNo)}`;
      
      chrome.tabs.create({ url: targetUrl }, (newTab) => {
        // Sekme oluşturulurken bir hata oluştu mu?
        if (chrome.runtime.lastError) {
          console.error('[Background] Sekme açma hatası:', chrome.runtime.lastError.message);
          return;
        }

        const listener = (tabId, changeInfo) => {
          if (tabId === newTab.id && changeInfo.status === 'complete') {
            // Sekme hazır, kısa bir mola verip mesajı gönder
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, { 
                type: 'AUTO_FILL_OPTS', 
                data: appNo 
              }).catch(err => console.warn('[Background] Content script henüz hazır değil, retry yapılacak.'));
            }, 1000);
            
            chrome.tabs.onUpdated.removeListener(listener);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      
      sendResponse({ status: 'OK', message: 'İşlem başlatıldı.' });
      return; 
    }

  // Sahip No: SORGULA_KISI
  if (request.type === 'SORGULA_KISI' && request.data) {
    const ownerId = request.data;
    console.log('[Background] 🔍 Sahip No sorgusu:', ownerId);
    
    const targetUrl = "https://www.turkpatent.gov.tr/arastirma-yap?form=trademark";
    
    chrome.tabs.create({ url: targetUrl }, (newTab) => {
      console.log('[Background] ✅ Yeni sekme oluşturuldu:', newTab.id);
      
      const listener = (tabId, changeInfo) => {
        if (tabId === newTab.id && changeInfo.status === 'complete') {
          console.log('[Background] 📨 Sekme yüklendi, AUTO_FILL_KISI gönderiliyor');
          
          chrome.tabs.sendMessage(tabId, { 
            type: 'AUTO_FILL_KISI', 
            data: ownerId 
          }).catch(err => {
            console.error('[Background] Mesaj gönderme hatası:', err);
          });
          
          chrome.tabs.onUpdated.removeListener(listener);
        }
      };
      
      chrome.tabs.onUpdated.addListener(listener);
      
      // 60 saniye sonra listener'ı temizle
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        console.log('[Background] Listener timeout, temizlendi');
      }, 60000);
    });
    
    sendResponse({ status: 'OK', message: 'Sahip No sekmesi açıldı.' });
    return; // Sadece return, return true değil
  }

// GET_RESULT için özel kontrol (External'dan da gelebilir)
  if (request.type === 'GET_RESULT' && request.applicationNumber) {
    const appNo = request.applicationNumber;
    const cached = resultCache.get(appNo);
    
    if (cached) {
      console.log(`[Background] ✅ Cache'ten döndürülüyor (external): ${appNo}`);
      resultCache.delete(appNo);
      
      sendResponse({
        status: 'READY',
        data: cached.data,
        messageType: cached.type
      });
    } else {
      sendResponse({ status: 'WAITING' });
    }
    return; // Sadece return
  }

  // Tanınmayan mesaj tipi
  console.warn('[Background] Bilinmeyen mesaj tipi:', request.type);
  sendResponse({ status: 'IGNORED' });
});


// ============================================
// INTERNAL MESSAGES (Content Script'ten Gelen)
// ============================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Content script'ten gelen verileri ana uygulamaya ilet (Broadcast)
  if (request.type === 'FORWARD_TO_APP') {
    const { messageType, data } = request;
    
    console.log(`[Background] Content script'ten veri alındı: ${messageType}`);
    
    // Tüm sekmelere broadcast et (ana uygulama dinleyecek)
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        // Sadece allowed domain'lere gönder
        const allowedOrigins = [
          'http://localhost',
          'https://ip-manager-production-aab4b.web.app',
          'https://kubilayguzel.github.io'
        ];
        
        const tabUrl = tab.url || '';
        const isAllowed = allowedOrigins.some(origin => tabUrl.startsWith(origin));
        
        if (isAllowed) {
          chrome.tabs.sendMessage(tab.id, {
            type: messageType,
            source: 'tp-sorgu-eklentisi-2',
            data: data
          }).catch(() => {
            // Tab mesaj dinlemiyorsa sessizce geç
          });
        }
      });
    });

    // ============================================
    // CACHE KAYIT (Polling için)
    // ============================================
    
    // Başvuru numarasını bul
    let appNo = null;
    if (Array.isArray(data) && data[0]?.applicationNumber) {
      appNo = data[0].applicationNumber;
    } else if (data?.applicationNumber) {
      appNo = data.applicationNumber;
    }
    
    if (appNo) {
      resultCache.set(appNo, {
        type: messageType,
        data: data,
        timestamp: Date.now()
      });
      
      console.log(`[Background] ✅ Cache'e kaydedildi: ${appNo}`);
      
      // 5 dakika sonra otomatik sil
      setTimeout(() => {
        resultCache.delete(appNo);
        console.log(`[Background] 🧹 Cache temizlendi: ${appNo}`);
      }, 300000);

      // ACK: içerik scriptine "veri alındı" mesajı gönder
      if (sender && sender.tab && sender.tab.id) {
        chrome.tabs.sendMessage(sender.tab.id, { 
          type: 'VERI_ALINDI_OK', 
          appNo: appNo 
        }, (response) => {
          // Callback ile hata yakalama
          if (chrome.runtime.lastError) {
            // Sekme kapanmışsa veya erişilemiyorsa sessizce logla
            console.log('[Background] ACK gönderilemedi (sekme kapalı olabilir):', chrome.runtime.lastError.message);
          } else {
            console.log('[Background] ✅ ACK gönderildi:', appNo);
          }
        });
      }
    }
    
    sendResponse({ status: 'OK' });
    return; // Sadece return, return true değil
  }

  // Ana uygulamadan polling sorgusu
  if (request.type === 'GET_RESULT' && request.applicationNumber) {
    const appNo = request.applicationNumber;
    const cached = resultCache.get(appNo);
    
    if (cached) {
      console.log(`[Background] ✅ Cache'ten döndürülüyor: ${appNo}`);
      resultCache.delete(appNo); // Bir kez kullanıldıktan sonra silinir
      
      sendResponse({
        status: 'READY',
        data: cached.data,
        messageType: cached.type
      });
    } else {
      sendResponse({ status: 'WAITING' });
    }
    
    return; // Sadece return, return true değil
  }
  
  // Tanınmayan mesaj tipi
  sendResponse({ status: 'IGNORED' });
});

// ============================================
// CACHE CLEANUP (Periyodik Temizlik)
// ============================================

// Her 10 dakikada bir eski cache'leri temizle
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  resultCache.forEach((value, key) => {
    if (now - value.timestamp > 300000) { // 5 dakikadan eski
      resultCache.delete(key);
      cleanedCount++;
    }
  });
  
  if (cleanedCount > 0) {
    console.log(`[Background] 🧹 Periyodik temizlik: ${cleanedCount} eski cache silindi`);
  }
}, 600000); // 10 dakika

console.log('[Background] ✅ Tüm dinleyiciler hazır');