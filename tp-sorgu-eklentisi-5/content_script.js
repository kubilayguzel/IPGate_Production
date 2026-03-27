const TAG = '[IPGate API Bot]';
console.log(TAG, 'Ajan sayfaya yerleşti! Inject dosyası yükleniyor...');

// Güvenli (CSP'ye takılmayan) Enjeksiyon Yöntemi
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
script.onload = function() {
    this.remove(); // Yüklendikten sonra iz bırakmamak için kendini siler
};
(document.head || document.documentElement).appendChild(script);

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type === 'FIRE_FETCH') {
        const appNo = request.data.applicationNo;
        
        const listener = function(event) {
            if (event.data.type === 'FETCH_RESULT' && event.data.appNo === appNo) {
                window.removeEventListener('message', listener);
                
                if (event.data.error) {
                    sendResponse({ success: false, error: event.data.error, appNo: appNo });
                    return;
                }
                
                const json = event.data.data;
                
                if (json && json.success && json.payload && json.payload.item) {
                    const apiData = json.payload.item;
                    const info = apiData.markInformation || {};
                    const niceInfo = apiData.niceInformation || [];
                    
                    // 🔥 DÜZELTME 1: HAR dosyasına göre holderInformation 'apiData' (item) içindedir!
                    const holders = apiData.holderInformation || [];
                    
                    let cleanedClasses = "";
                    if (info.niceClasses) {
                        cleanedClasses = info.niceClasses.trim();
                        if (cleanedClasses.endsWith('/')) {
                            cleanedClasses = cleanedClasses.slice(0, -1).trim();
                        }
                    }
                    
                    const resultData = {
                        application_no: info.applicationNo,
                        brand_name: info.markName,
                        application_date: info.applicationDate,
                        nice_classes: cleanedClasses,
                        image_base64: info.figure,
                        holders: holders,
                        nice_details: niceInfo,
                        
                        // 🔥 DÜZELTME 2: Bülten No ve Bülten Tarihi Artık Dışarı Aktarılıyor
                        bulletin_no: info.bulletinNumber || apiData.bulletinNo || null,
                        bulletin_date: info.bulletinDate || null
                    };
                    sendResponse({ success: true, data: resultData, appNo: appNo });
                } else if (json && !json.success) {
                    sendResponse({ success: false, error: (json.error ? json.error.code : 'UNKNOWN_ERROR'), appNo: appNo });
                } else {
                    sendResponse({ success: false, error: 'NOT_FOUND', appNo: appNo });
                }
            }
        };
        
        window.addEventListener('message', listener);
        window.postMessage({ type: 'FETCH_TRADEMARK_FILE', appNo: appNo }, '*');
        
        return true; 
    }
});