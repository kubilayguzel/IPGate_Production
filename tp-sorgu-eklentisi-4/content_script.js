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
    const m = (node.textContent || '').match(/([\d.,]+)\s*kayıt\s*b[uü]lundu/i);
    if (m) {
        return parseInt(m[1].replace(/[^\d]/g, ''), 10);
    }
    return null;
}

// 🔥 YENİ VE REACT-GÜVENLİ BUDAMA FONKSİYONU
function pruneRow(tr) {
    if (!tr || tr.getAttribute('data-pruned') === 'true') return;
    
    // İşlendi olarak işaretle
    tr.setAttribute('data-pruned', 'true'); 
    
    // 🛑 KRİTİK DÜZELTME: React'in çökmemesi için innerHTML = '' YAPMIYORUZ!
    // DOM yapısını olduğu gibi bırakıyoruz.

    // 1. RAM'i asıl şişiren şey BASE64 resimlerdir. Sadece resimlerin içini boşaltıyoruz.
    const imgs = tr.querySelectorAll('img');
    imgs.forEach(img => {
        img.src = '';
        img.removeAttribute('src');
    });

    // 2. Tarayıcının ekran kartını (GPU) yormasını engellemek için 
    // satırı gizliyor ama sayfadaki kapladığı alanı (Scroll) bozmuyoruz.
    tr.style.opacity = '0.1'; // Satırı soluklaştır
    
    // Modern tarayıcılarda görünmeyen kısımların işlemci tüketimini sıfırlayan sihirli CSS:
    tr.style.contentVisibility = 'auto'; 
}

function parseRow(tr) {
    // Eğer bu satır daha önce budanmışsa (alınmışsa) bir daha bakma
    if (tr.getAttribute('data-pruned') === 'true') return null;

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
        image_base64: imgEl ? imgEl.src : null,
        _trRef: tr // Silmek için referansını tutuyoruz
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

    // 1. AŞAMA: HIZLI SARMA
    if (skipCount > 0) {
        document.getElementById('ipgate-status').innerText = `Kaldığı yere (Satır ${skipCount}) hızla iniliyor...`;
        
        while(true) {
            const allRows = document.querySelectorAll('tbody.MuiTableBody-root tr.MuiTableRow-root');
            
            // 🔥 Sadece henüz budanmamış GÖRÜNÜR satırları seç ve buda
            const unprunedRows = document.querySelectorAll('tbody.MuiTableBody-root tr.MuiTableRow-root:not([data-pruned="true"])');
            for(let i = 0; i < unprunedRows.length - 10; i++) {
                const tr = unprunedRows[i];
                const parsed = parseRow(tr);
                if (parsed) processedApps.add(parsed.application_number);
                pruneRow(tr); 
            }

            if (allRows.length >= skipCount) {
                break; 
            }
            
            // 🔥 CPU TASARRUFU: 'smooth' yerine 'auto' kullanarak saniyesinde aşağı zıplat
            const lastRow = allRows[allRows.length - 1];
            if(lastRow) lastRow.scrollIntoView({ behavior: "auto", block: "end" });
            
            document.getElementById('ipgate-status').innerText = `Hızla iniliyor: ${allRows.length} / ${skipCount}`;
            await sleep(500); // 800'den 500'e düşürdük, artık bilgisayar kasmadığı için daha hızlı inebilir
        }
    }

    // 2. AŞAMA: KAZIMA, GÖNDERME VE TEMİZLEME
    let totalSent = skipCount;

    while(isScraping && totalSent < targetTotal) {
        
        // 🔥 PERFORMANS MUCİZESİ: Tüm sayfayı aramak yerine SADECE yeni yüklenen ve 
        // henüz budanmamış satırları seç. (Döngü her zaman ~20 kayıtta döner, 5000 kayıtta değil!)
        const newRows = document.querySelectorAll('tbody.MuiTableBody-root tr.MuiTableRow-root:not([data-pruned="true"])');
        const batch = [];
        
        newRows.forEach(tr => {
            const parsed = parseRow(tr);
            if(parsed && !processedApps.has(parsed.application_number)) {
                processedApps.add(parsed.application_number);
                
                const dataToPush = {...parsed};
                delete dataToPush._trRef;
                batch.push(dataToPush);
                
                pruneRow(parsed._trRef); // Veriyi aldın, ekrandan (RAM'den) sil
            } else {
                // Önceden alınmışsa veya boşsa yine de buda (eski veriyi DOM'da boşuna tutma)
                pruneRow(tr);
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

            // 🔥 Sadece en alttaki satıra 'auto' (anlık) scroll yap.
            const lastRow = document.querySelector('tbody.MuiTableBody-root tr.MuiTableRow-root:last-child');
            if(lastRow) lastRow.scrollIntoView({ behavior: "auto", block: "end" });
            
            await sleep(1000); // Kasmalar bittiği için bekleme süresini 1.5 sn'den 1 sn'ye düşürdük

        } else {
            retryCount++;
            window.scrollTo(0, document.body.scrollHeight);
            await sleep(1500);

            if(retryCount >= 5) {
                isScraping = false;
                console.log("Yeni veri gelmedi, tarama sonlandırılıyor.");
            }
        }
    }

    chrome.runtime.sendMessage({ type: 'FORWARD_BATCH_TO_APP', data: { isComplete: true, totalSent } });
}

setTimeout(injectUI, 2000);