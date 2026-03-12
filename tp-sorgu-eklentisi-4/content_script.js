const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let expectedTotal = 0;
let dbSavedCount = 0;

function injectUI() {
    if(document.getElementById('ipgate-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'ipgate-panel';
    panel.innerHTML = `
        <div style="position:fixed; bottom:20px; right:20px; z-index:99999; background:#1976d2; color:white; padding:15px; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.3); font-family:sans-serif; width: 280px;">
            <h3 style="margin:0 0 10px 0; font-size:16px;">🚀 IPGate Bülten Motoru</h3>
            <input type="text" id="ipgate-bulletin-no" placeholder="Bülten No (Örn: 484)" style="padding:5px; width:100%; margin-bottom:5px; border:none; border-radius:4px; color:black; box-sizing:border-box;">
            <input type="text" id="ipgate-bulletin-date" placeholder="Bülten Tarihi (Örn: 26.12.2025)" style="padding:5px; width:100%; margin-bottom:5px; border:none; border-radius:4px; color:black; box-sizing:border-box;">
            
            <input type="number" id="ipgate-skip-count" placeholder="Kaldığın Yer (Opsiyonel, Örn: 1220)" style="padding:5px; width:100%; margin-bottom:10px; border:none; border-radius:4px; color:black; box-sizing:border-box;">
            
            <button id="ipgate-start-btn" style="background:#4caf50; color:white; border:none; padding:8px 15px; width:100%; border-radius:4px; cursor:pointer; font-weight:bold;">Taramayı Başlat</button>
            
            <div style="width: 100%; background: rgba(255,255,255,0.2); border-radius: 4px; margin-top: 10px; overflow: hidden; height:12px;">
                <div id="ipgate-progress-fill" style="height: 100%; width: 0%; background: #4caf50; transition: width 0.3s;"></div>
            </div>
            <div id="ipgate-status" style="margin-top:5px; font-size:12px; color:#ffeb3b; text-align:center;">Bekliyor...</div>
        </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('ipgate-start-btn').addEventListener('click', async () => {
        const bulletinNo = document.getElementById('ipgate-bulletin-no').value.trim();
        const bulletinDate = document.getElementById('ipgate-bulletin-date').value.trim();
        const skipCount = parseInt(document.getElementById('ipgate-skip-count').value) || 0;
        
        if(!bulletinNo || !bulletinDate) {
            alert('Lütfen Bülten Numarasını ve Tarihini giriniz!');
            return;
        }
        document.getElementById('ipgate-start-btn').disabled = true;
        document.getElementById('ipgate-status').innerText = "Analiz ediliyor...";
        await startScraping(bulletinNo, bulletinDate, skipCount);
    });
}

// Background'dan gelen "Veritabanına Yazıldı" mesajlarını dinler ve barı doldurur
chrome.runtime.onMessage.addListener((request) => {
    if (request.type === 'DB_SAVE_SUCCESS') {
        dbSavedCount += request.processedCount;
        const percent = Math.min(100, Math.round((dbSavedCount / expectedTotal) * 100));
        
        document.getElementById('ipgate-progress-fill').style.width = percent + '%';
        document.getElementById('ipgate-status').innerText = `DB'ye Yazılan: ${dbSavedCount} / ${expectedTotal} (%${percent})`;
    }
});

function getExpectedTotalCount() {
    const nodes = Array.from(document.querySelectorAll('p, span, div'));
    const node = nodes.find(n => !!n && (n.textContent || '').toLowerCase().includes('kayıt bulundu'));
    if (!node) return null;
    
    // 🔥 ÇÖZÜM BURADA: Sayının içindeki noktaları da regex'e dahil ettik
    const m = (node.textContent || '').match(/([\d.,]+)\s*kayıt\s*b[uü]lundu/i);
    if (m) {
        // "5.930" gibi bir metnin içindeki rakam olmayan her şeyi (nokta/virgül) silip tam sayıya çeviririz.
        return parseInt(m[1].replace(/[^\d]/g, ''), 10);
    }
    return null;
}

function parseRow(tr) {
    const getRoleTxt = (role) => (tr.querySelector(`td[role="${role}"]`)?.textContent || '').trim();
    const appNo = getRoleTxt('applicationNo');
    if (!appNo) return null;
    const imgEl = tr.querySelector('td[role="image"] img');
    return {
        application_number: appNo,
        brand_name: getRoleTxt('markName'),
        owner_name: getRoleTxt('holdName').replace(/\s*\(\d+\)\s*$/, ''),
        application_date: getRoleTxt('applicationDate'),
        nice_classes: getRoleTxt('niceClasses'),
        image_base64: imgEl ? imgEl.src : null
    };
}

async function startScraping(bulletinNo, bulletinDate, skipCount) {
    expectedTotal = getExpectedTotalCount();
    if (!expectedTotal) {
        alert("Sayfada kaç kayıt olduğu bulunamadı. Aramayı yaptığınızdan emin olun.");
        document.getElementById('ipgate-start-btn').disabled = false;
        return;
    }

    const targetTotal = expectedTotal;
    dbSavedCount = skipCount; 

    let processedApps = new Set();
    let isScraping = true;
    let retryCount = 0;

    // 1. AŞAMA: HIZLI SARMA (FAST-FORWARD)
    if (skipCount > 0) {
        document.getElementById('ipgate-status').innerText = `Kaldığı yere (Satır ${skipCount}) hızla iniliyor...`;
        
        while(true) {
            const rows = document.querySelectorAll('tbody.MuiTableBody-root tr.MuiTableRow-root');
            if (rows.length >= skipCount) {
                // Atlanan satırların numaralarını hafızaya al ki bir daha göndermesin
                for(let i = 0; i < skipCount; i++) {
                    const parsed = parseRow(rows[i]);
                    if (parsed) processedApps.add(parsed.application_number);
                }
                break; 
            }
            
            const lastRow = rows[rows.length - 1];
            if(lastRow) lastRow.scrollIntoView({ behavior: "smooth", block: "end" });
            
            document.getElementById('ipgate-status').innerText = `Hızla iniliyor: ${rows.length} / ${skipCount}`;
            await sleep(800); 
        }
    }

    // 2. AŞAMA: NORMAL KAZIMA VE GÖNDERME
    let totalSent = skipCount;

    while(isScraping && totalSent < targetTotal) {
        const rows = document.querySelectorAll('tbody.MuiTableBody-root tr.MuiTableRow-root');
        const batch = [];
        
        rows.forEach(tr => {
            const parsed = parseRow(tr);
            if(parsed && !processedApps.has(parsed.application_number)) {
                processedApps.add(parsed.application_number);
                batch.push(parsed);
            }
        });

        if(batch.length > 0) {
            retryCount = 0;
            totalSent += batch.length;
            document.getElementById('ipgate-status').innerText = `Kuyruğa Atılıyor: ${totalSent} / ${targetTotal}`;

            chrome.runtime.sendMessage({
                type: 'FORWARD_BATCH_TO_APP',
                data: { bulletinNo, bulletinDate, batch, page: Math.ceil((totalSent - skipCount)/20) } 
            });

            if(totalSent >= targetTotal) {
                isScraping = false;
                break;
            }

            const lastRow = rows[rows.length - 1];
            if(lastRow) lastRow.scrollIntoView({ behavior: "smooth", block: "end" });
            await sleep(1500); 

        } else {
            retryCount++;
            window.scrollTo(0, document.body.scrollHeight);
            await sleep(2000);

            if(retryCount >= 4) {
                isScraping = false;
                console.log("Yeni veri gelmedi, tarama sonlandırılıyor.");
            }
        }
    }

    chrome.runtime.sendMessage({ type: 'FORWARD_BATCH_TO_APP', data: { isComplete: true, totalSent } });
}

setTimeout(injectUI, 2000);