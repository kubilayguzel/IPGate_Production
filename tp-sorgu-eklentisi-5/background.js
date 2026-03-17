const TAG = '[IPGate BG]';
console.log(TAG, 'Arka plan servisi aktif. Görev bekleniyor...');

// IPGate Web Uygulamasından gelen istekleri dinle
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
    
    if (request.type === 'FETCH_TRADEMARK_API') {
        const appNo = request.data.applicationNo;
        console.log(TAG, `📩 Webten istek geldi: ${appNo}`);
        
        // Açık olan opts.turkpatent.gov.tr sekmesini bul
        chrome.tabs.query({ url: "*://opts.turkpatent.gov.tr/*" }, (tabs) => {
            if (tabs.length === 0) {
                console.error(TAG, '❌ Açık bir TürkPatent sekmesi bulunamadı!');
                sendResponse({ success: false, error: 'NO_TAB_FOUND' });
                return;
            }

            const targetTab = tabs[0]; // İlk bulduğu TPE sekmesini kullan
            
            // Sekmenin içindeki content_script'e ateşleme emri ver
            chrome.tabs.sendMessage(targetTab.id, { type: 'FIRE_FETCH', data: { applicationNo: appNo } }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error(TAG, '⚠️ Content Script Hatası:', chrome.runtime.lastError.message);
                    sendResponse({ success: false, error: 'CONTENT_SCRIPT_NOT_READY' });
                } else {
                    // Content script'ten gelen yanıtı doğrudan IPGate'e geri gönder
                    sendResponse(response);
                }
            });
        });

        // Asenkron (Promise) yanıt döneceğimiz için true döndürmek zorunludur.
        return true; 
    }
});