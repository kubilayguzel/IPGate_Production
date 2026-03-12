chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'FORWARD_BATCH_TO_APP') {
        
        if (request.data.isComplete) {
            console.log(`✅ TÜM BÜLTEN BİTTİ! Toplam sayfa: ${request.data.totalPages}`);
            sendResponse({ status: 'OK' });
            return true;
        }

        console.log(`📦 Sayfa ${request.data.page} eklentiden geldi (${request.data.batch.length} adet). Supabase'e işleniyor...`);
        
        // DİKKAT: Kendi Supabase URL'nizi buraya yazın
        const supabaseFunctionUrl = "https://guicrctynauzxhyfpdfe.supabase.co/functions/v1/sync-bulletin-batch";

        fetch(supabaseFunctionUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                bulletinNo: request.data.bulletinNo,
                batch: request.data.batch
            })
        })
        .then(response => response.json())
        .then(result => {
            console.log("✔️ Veritabanına işlendi:", result);
        })
        .catch(error => {
            console.error("❌ Veritabanı yazma hatası:", error);
        });

        sendResponse({ status: 'OK' });
    }
    return true;
});