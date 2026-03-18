console.log('[IPGate BG] Arka plan servisi aktif. Görev bekleniyor...');

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
    if (request.type === 'FETCH_TRADEMARK_API') {
        const appNo = request.data.applicationNo;
        console.log(`[IPGate BG] 📩 Webten istek geldi: ${appNo}`);

        // Tüm sekmeleri getir (Kısıtlama yapmadan)
        chrome.tabs.query({}, function(tabs) {
            console.log(`[IPGate BG] Chrome'da toplam ${tabs.length} sekme bulundu.`);
            
            let targetTab = null;

            // Bütün sekmelerin URL'lerini tek tek kontrol et
            for (let i = 0; i < tabs.length; i++) {
                const tabUrl = tabs[i].url || ""; // Eğer izin yoksa burası boş gelir
                
                if (tabUrl.includes("turkpatent.gov.tr")) {
                    targetTab = tabs[i];
                    break;
                }
            }

            if (!targetTab) {
                console.error('[IPGate BG] ❌ Açık bir TürkPatent sekmesi bulunamadı!');
                console.warn('[IPGate BG] 💡 İPUCU: Ya "tabs" yetkisi eksik/güncellenmedi ya da sekme gizli modda açık.');
                sendResponse(null);
                return;
            }

            console.log(`[IPGate BG] ✅ Sekme Bulundu! URL: ${targetTab.url}`);
            
            // Bulunan sekmeye veriyi çekmesi için emri gönder
            chrome.tabs.sendMessage(targetTab.id, {
                type: 'FIRE_FETCH',
                data: request.data
            }, function(response) {
                if (chrome.runtime.lastError) {
                    console.error('[IPGate BG] ❌ Content Script ile iletişim koptu:', chrome.runtime.lastError.message);
                    sendResponse(null);
                } else {
                    console.log(`[IPGate BG] 🎯 Yanıt Geldi:`, response);
                    sendResponse(response);
                }
            });
        });
        return true; 
    }
});