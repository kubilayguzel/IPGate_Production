chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'FORWARD_BATCH_TO_APP') {
        
        if (request.data.isComplete) {
            console.log(`✅ TEST BAŞARIYLA TAMAMLANDI! Toplam gönderilen: ${request.data.totalSent}`);
            sendResponse({ status: 'OK' });
            return true;
        }

        console.log(`📦 Paket ${request.data.page} geldi (${request.data.batch.length} kayıt). Supabase'e yazılıyor...`);
        
        // 1. Kendi Supabase Function URL'nizi buraya yazın
        const supabaseFunctionUrl = "https://kadxvkejzctwymzeyrrl.supabase.co/functions/v1/sync-bulletin-batch";
        
        // 2. Kendi Supabase 'anon' (public) anahtarınızı buraya yazın
        const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNzg0NDgsImV4cCI6MjA4Nzc1NDQ0OH0.PFSzq8hOc14HgYwwF_ZR3v82ZzegKcoN4Vqw2wR2ZP0";

        fetch(supabaseFunctionUrl, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${supabaseAnonKey}` 
            },
            body: JSON.stringify({
                bulletinNo: request.data.bulletinNo,
                bulletinDate: request.data.bulletinDate, // Tarihi de gönderiyoruz
                batch: request.data.batch
            })
        })
        .then(async response => {
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`HTTP ${response.status} - ${errText}`);
            }
            return response.json();
        })
        .then(result => {
            console.log(`✔️ [Paket ${request.data.page}] DB'ye işlendi:`, result);
            
            // 🔥 SİHİRLİ DOKUNUŞ: Veritabanına yazılınca ön yüze Progress Bar'ı doldurması için mesaj at!
            if (sender && sender.tab) {
                chrome.tabs.sendMessage(sender.tab.id, {
                    type: 'DB_SAVE_SUCCESS',
                    processedCount: request.data.batch.length
                }).catch(e => console.log("Tab kapalı olduğu için progress bar güncellenemedi."));
            }
        })
        .catch(error => {
            console.error(`❌ [Paket ${request.data.page}] DB yazma hatası:`, error);
        });

        sendResponse({ status: 'OK' });
    }
    return true;
});