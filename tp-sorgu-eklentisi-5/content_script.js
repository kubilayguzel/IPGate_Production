const TAG = '[IPGate API Bot]';
console.log(TAG, 'Gizli API dinleyicisi sayfaya yerleşti. Operasyona hazır!');

// Jitter: Sunucuyu şüphelendirmemek için rastgele milisaniye bekleten fonksiyon
const sleep = (min, max) => {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'FIRE_FETCH') {
        const appNo = request.data.applicationNo;
        
        (async () => {
            try {
                console.log(TAG, `🔍 Hedefe kilitlenildi: ${appNo}`);
                
                // GÜVENLİK: 300ms ile 700ms arası rastgele bekle (WAF'ı kandır)
                await sleep(300, 700);

                // API'ye doğrudan gizli vuruş yap
                const response = await fetch('https://opts.turkpatent.gov.tr/api/trademark-search/mark', {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json'
                        // Tarayıcı bu isteğe e-Devlet oturum Cookie'lerinizi otomatik olarak ekler!
                    },
                    body: JSON.stringify({
                        applicationNo: appNo,
                        documentNo: "",
                        internationalRegistrationNo: "",
                        registrationNo: ""
                    })
                });

                // 1. KONTROL: Oturum düştü mü? (HTTP 401 veya 403)
                if (response.status === 401 || response.status === 403 || response.redirected) {
                    console.error(TAG, '🚨 DİKKAT: Oturum Düştü! (401/403 HTTP Hatası)');
                    sendResponse({ success: false, error: 'SESSION_DEAD', appNo });
                    return;
                }

                const text = await response.text();
                
                // 2. KONTROL: Sistem JSON yerine HTML (Login Sayfası) mi döndü?
                if (text.includes('<html') || text.includes('e-Devlet') || text.includes('giriş')) {
                    console.error(TAG, '🚨 DİKKAT: Oturum Düştü! (Sistem login sayfasına yönlendirdi)');
                    sendResponse({ success: false, error: 'SESSION_DEAD', appNo });
                    return;
                }

                // Veriyi çözümle
                const json = JSON.parse(text);

                if (json && json.success && json.data && json.data.markInformation) {
                    const info = json.data.markInformation;
                    // Sınıfların sonundaki gereksiz " / " işaretini temizle
                    const niceClasses = info.niceClasses ? info.niceClasses.replace(/\/\s*$/, '').trim() : '';
                    
                    const resultData = {
                        application_no: info.applicationNo,
                        brand_name: info.markName,
                        application_date: info.applicationDate,
                        nice_classes: niceClasses,
                        image_base64: info.figure, // Base64 logo formatı
                        holders: json.data.holderInformation || []
                    };
                    
                    console.log(TAG, `✅ Veri Alındı: ${info.markName}`);
                    sendResponse({ success: true, data: resultData, appNo });
                } else {
                    console.warn(TAG, `⚠️ Numara Bulunamadı: ${appNo}`);
                    sendResponse({ success: false, error: 'NOT_FOUND', appNo });
                }

            } catch (error) {
                console.error(TAG, `❌ Ağ/İstek Hatası (${appNo}):`, error);
                sendResponse({ success: false, error: error.message, appNo });
            }
        })();

        return true; // Asenkron işlem olduğu için eklentinin kapanmasını engeller
    }
});