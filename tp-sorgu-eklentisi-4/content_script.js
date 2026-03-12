const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// EPATS ekranına yüzer bir kontrol paneli ekleyelim
function injectUI() {
    if(document.getElementById('ipgate-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'ipgate-panel';
    panel.innerHTML = `
        <div style="position:fixed; bottom:20px; right:20px; z-index:99999; background:#1976d2; color:white; padding:15px; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.3); font-family:sans-serif;">
            <h3 style="margin:0 0 10px 0; font-size:16px;">🚀 IPGate Bülten Motoru</h3>
            <input type="text" id="ipgate-bulletin-no" placeholder="Bülten No (Örn: 484)" style="padding:5px; width:100%; margin-bottom:10px; border:none; border-radius:4px; color:black;">
            <button id="ipgate-start-btn" style="background:#4caf50; color:white; border:none; padding:8px 15px; width:100%; border-radius:4px; cursor:pointer; font-weight:bold;">Taramayı Başlat</button>
            <div id="ipgate-status" style="margin-top:10px; font-size:12px; color:#ffeb3b;">Bekliyor...</div>
        </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('ipgate-start-btn').addEventListener('click', async () => {
        const bulletinNo = document.getElementById('ipgate-bulletin-no').value.trim();
        if(!bulletinNo) {
            alert('Lütfen Bülten Numarasını giriniz!');
            return;
        }
        document.getElementById('ipgate-start-btn').disabled = true;
        document.getElementById('ipgate-status').innerText = "Tarama Başladı! Lütfen dokunmayın...";
        await startScraping(bulletinNo);
    });
}

function parseRow(tr) {
    const getRoleTxt = (role) => (tr.querySelector(`td[role="${role}"]`)?.textContent || '').trim();
    
    const appNo = getRoleTxt('applicationNo');
    if (!appNo) return null;

    const imgEl = tr.querySelector('td[role="image"] img');
    const imgSrc = imgEl ? imgEl.src : null; // Base64 kodunu alır

    return {
        application_number: appNo,
        brand_name: getRoleTxt('markName'),
        owner_name: getRoleTxt('holdName').replace(/\s*\(\d+\)\s*$/, ''), // Parantez içindeki TPE no'yu siler
        application_date: getRoleTxt('applicationDate'),
        nice_classes: getRoleTxt('niceClasses'),
        image_base64: imgSrc
    };
}

async function startScraping(bulletinNo) {
    let hasNextPage = true;
    let pageCount = 1;

    // 🔥 DİKKAT: O hatalı "Sonsuz Liste" kilit kodunu buradan tamamen sildik!
    // Artık doğrudan tabloyu taramaya başlayacak.

    while(hasNextPage) {
        document.getElementById('ipgate-status').innerText = `Sayfa ${pageCount} taranıyor...`;
        
        // Sayfanın yüklenmesi için ufak bir pay
        await sleep(1500);

        const rows = document.querySelectorAll('tbody.MuiTableBody-root tr.MuiTableRow-root');
        const batch = [];
        
        rows.forEach(tr => {
            const parsed = parseRow(tr);
            if(parsed) batch.push(parsed);
        });

        if(batch.length > 0) {
            // Background üzerinden uygulamaya fırlat
            chrome.runtime.sendMessage({
                type: 'FORWARD_BATCH_TO_APP',
                data: { bulletinNo, batch, page: pageCount }
            });
            console.log(`[IPGate] Sayfa ${pageCount} (${batch.length} kayıt) gönderildi.`);
        }

        // Sonraki Sayfa Butonunu Bul (Material UI SVG iconu veya aria-label)
        const nextBtn = document.querySelector('button[aria-label="Sonraki sayfa"], button[aria-label="Go to next page"], button[title="Sonraki sayfa"]');
        
        if (nextBtn && !nextBtn.disabled) {
            nextBtn.click();
            pageCount++;
            await sleep(1500); // Tablonun yenilenmesini bekle
        } else {
            hasNextPage = false;
            document.getElementById('ipgate-status').innerText = `BİTTİ! Toplam Sayfa: ${pageCount}`;
            chrome.runtime.sendMessage({
                type: 'FORWARD_BATCH_TO_APP',
                data: { bulletinNo, isComplete: true, totalPages: pageCount }
            });
        }
    }
}

// 2 saniye sonra arayüzü ekle
setTimeout(injectUI, 2000);