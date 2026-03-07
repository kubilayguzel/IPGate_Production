// public/js/bulletin-upload.js
import { supabase } from '../supabase-config.js';


document.addEventListener('DOMContentLoaded', () => {
  setupUploadEvents();
});

function setupUploadEvents() {
  const dropArea = document.getElementById("dropAreaTrademark");
  const fileInput = document.getElementById("bulletinFileTrademark");
  const form = document.getElementById("bulletinUploadFormTrademark");
  const selectedFileName = document.getElementById("selectedFileNameTrademark");
  const uploadStatus = document.getElementById("uploadStatusTrademark");
  const progressContainer = document.getElementById("progressContainer");
  const progressBar = document.getElementById("progressBar");

  let selectedFile = null;

  if (!dropArea || !fileInput || !form) return;

  dropArea.addEventListener("click", () => fileInput.click());
  dropArea.addEventListener("dragover", (e) => { e.preventDefault(); dropArea.style.border = "2px dashed #1e3c72"; });
  dropArea.addEventListener("dragleave", () => { dropArea.style.border = "2px dashed #ccc"; });
  
  dropArea.addEventListener("drop", (e) => {
    e.preventDefault();
    dropArea.style.border = "2px dashed #ccc";
    if (e.dataTransfer.files.length > 0) handleFileSelection(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) handleFileSelection(e.target.files[0]);
  });

  function handleFileSelection(file) {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      if (uploadStatus) { uploadStatus.textContent = "⚠️ Sadece .zip dosyaları kabul edilir!"; uploadStatus.style.color = "orange"; }
      selectedFile = null;
      return;
    }
    selectedFile = file;
    if (uploadStatus) { uploadStatus.textContent = "✅ Dosya seçildi: " + selectedFile.name; uploadStatus.style.color = "green"; }
    if (selectedFileName) selectedFileName.textContent = selectedFile.name;
  }

  function updateProgress(percent, text, color = "#1e3c72") {
    if(progressBar) {
        progressBar.style.width = `${percent}%`;
        progressBar.textContent = `${percent}%`;
        progressBar.style.background = color;
    }
    if(uploadStatus) {
        uploadStatus.textContent = text;
        uploadStatus.style.color = color === "crimson" ? "red" : "#333";
    }
  }

  // --- SQL Parse Yardımcıları ---
  function formatDateForSupabase(dateStr) {
      if (!dateStr) return null;
      const s = String(dateStr).trim();
      const match = s.match(/^(\d{1,2})[\/\.](\d{1,2})[\/\.](\d{4})$/);
      if (match) {
          return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      }
      return s; 
  }

  function parseValuesFromRaw(raw) {
      const values = [];
      let current = "";
      let inString = false;
      let i = 0;
      while (i < raw.length) {
          const char = raw[i];
          if (char === "'") {
              if (inString && raw[i + 1] === "'") { current += "'"; i += 2; continue; }
              else { inString = !inString; }
          } else if (char === "," && !inString) {
              values.push(decodeValue(current.trim())); current = ""; i++; continue;
          } else { current += char; }
          i++;
      }
      if (current.trim()) values.push(decodeValue(current.trim()));
      return values;
  }

  function decodeValue(str) {
      if (!str || str === "") return null;
      str = str.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");
      return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, g1) => String.fromCharCode(parseInt(g1, 16)));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedFile) return uploadStatus && (uploadStatus.textContent = "Lütfen bir dosya seçin.");
    
    try {
      if (progressContainer) progressContainer.style.display = "block";
      updateProgress(0, "ZIP dosyası tarayıcıda açılıyor...");

      const zip = await JSZip.loadAsync(selectedFile);
      
      let bulletinNo = "Unknown";
      let bulletinDate = "Unknown";
      let sqlContent = "";
      const imageFiles = [];

      updateProgress(5, "Dosyalar taranıyor...");

      for (const [filename, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) continue;
        const lowerName = filename.toLowerCase();
        
        if (lowerName.includes("bulletin.inf") || lowerName.includes("bulletin.txt")) {
            const content = await zipEntry.async("string");
            const bNoMatch = content.match(/NO\s*=\s*(.*)/);
            const bDateMatch = content.match(/DATE\s*=\s*(.*)/);
            if (bNoMatch) bulletinNo = bNoMatch[1].trim();
            if (bDateMatch) bulletinDate = bDateMatch[1].trim();
        } else if (lowerName.includes("tmbulletin.log")) {
            sqlContent = await zipEntry.async("string");
        } else if (lowerName.includes("images/")) {
            imageFiles.push(zipEntry);
        }
      }

      if (!sqlContent) throw new Error("ZIP içinde SQL verisi (tmbulletin.log) bulunamadı!");

      updateProgress(10, `Bülten No: ${bulletinNo} | Veriler Çözümleniyor...`);

      const recordsMap = new Map();
      let startIndex = 0;

      while (startIndex < sqlContent.length) {
          let endIndex = sqlContent.indexOf('\n', startIndex);
          if (endIndex === -1) endIndex = sqlContent.length;
          
          const line = sqlContent.substring(startIndex, endIndex).trim();
          startIndex = endIndex + 1;

          if (!line.startsWith('INSERT INTO')) continue;
          const match = line.match(/INSERT INTO (\w+) VALUES\s*\((.*)\)/i);
          if (!match) continue;

          const table = match[1].toUpperCase();
          const rawValues = parseValuesFromRaw(match[2]);
          if (!rawValues || rawValues.length === 0) continue;

          const appNo = rawValues[0];
          if (!recordsMap.has(appNo)) {
              recordsMap.set(appNo, { application_no: appNo, bulletin_no: bulletinNo, holders: [], goodsObjects: [] });
          }
          const record = recordsMap.get(appNo);

          if (table === "TRADEMARK") {
              record.application_date = formatDateForSupabase(rawValues[1]);
              record.mark_name = rawValues[4] || rawValues[5];
              record.nice_classes = rawValues[6];
          } else if (table === "HOLDER") {
              const holderName = rawValues[2];
              if (holderName) record.holders.push(holderName);
          } else if (table === "GOODS") {
              // 🔥 DÜZELTME BURADA: Sınıf Numarası (Class No) için doğru indeks (2) seçildi!
              let classNo = "";
              let classText = "";

              if (rawValues.length >= 4) {
                  // İdeal Format: ['2025/123', '1', '35', 'Reklamcılık...']
                  classNo = rawValues[2] ? String(rawValues[2]).trim() : '';
                  classText = rawValues[3] ? String(rawValues[3]).trim() : '';
              } else if (rawValues.length === 3) {
                  // Olası Eksik Format
                  classNo = rawValues[1] ? String(rawValues[1]).trim() : '';
                  classText = rawValues[2] ? String(rawValues[2]).trim() : '';
              } else {
                  // Kurtarma (Fallback)
                  classText = rawValues.reduce((a, b) => (b && b.length > a.length) ? b : a, "");
              }

              if (classText && classText !== "") {
                  record.goodsObjects.push({
                      classNo: classNo,
                      classText: classText
                  });
              }
          }
      }

      const finalRecords = [];
      const finalGoods = [];
      
      // 🔥 YENİ DB: Ana bülten ID'sini önceden belirliyoruz ki alt tablolara (records) bağlayabilelim
      const bulletinDbId = `bulletin_main_${bulletinNo}`;

      recordsMap.forEach((r) => {
          if (r.mark_name) {
              const safeAppNo = r.application_no.replace(/\//g, '_').replace(/-/g, '_');
              const imgMatch = imageFiles.find(img => img.name.includes(safeAppNo));
              let image_url = null; // Kolon adı image_url oldu
              if (imgMatch) {
                  image_url = `bulletins/trademark_${bulletinNo}_images/${imgMatch.name.split('/').pop()}`;
              }

              const deterministicId = `bull_${bulletinNo}_app_${safeAppNo}`;

              // 🔥 YENİ DB: Kolon isimleri ve tipleri şemaya göre (ARRAY, JSONB) düzeltildi
              finalRecords.push({
                  id: deterministicId, 
                  bulletin_id: bulletinDbId, // bulletin_no yerine foreign key
                  application_number: r.application_no, // application_no -> application_number
                  brand_name: r.mark_name, // mark_name -> brand_name
                  application_date: r.application_date,
                  // String olan sınıfları DB'deki text[] (ARRAY) formatına çeviriyoruz
                  nice_classes: r.nice_classes ? r.nice_classes.split(/[,\s]+/).filter(Boolean) : [], 
                  // Sahipleri virgüllü string yerine doğrudan Dizi olarak veriyoruz (DB JSONB bekliyor)
                  holders: r.holders, 
                  image_url: image_url, // image_path -> image_url
                  source: 'turkpatent',
                  created_at: new Date().toISOString()
              });

              r.goodsObjects.forEach((g, idx) => {
                  finalGoods.push({
                      id: `${deterministicId}_class_${g.classNo}_${idx}`, 
                      bulletin_record_id: deterministicId, // İlişkisel bağ: application_no yerine record ID'si
                      class_number: parseInt(g.classNo, 10) || null, // DB Integer bekliyor
                      class_text: g.classText,
                      created_at: new Date().toISOString()
                  });
              });
          }
      });

      // Ana bülten kaydını oluşturma (Aynı kalıyor)
        const { error: bulletinError } = await supabase.from('trademark_bulletins').upsert({ 
          id: bulletinDbId, 
          bulletin_no: bulletinNo, 
          bulletin_date: formatDateForSupabase(bulletinDate),
          created_at: new Date().toISOString()
      }, { onConflict: 'id' });
      
      if (bulletinError) {
          throw new Error("Ana bülten kaydı oluşturulamadı: " + bulletinError.message);
      }

      updateProgress(15, `Veritabanına ${finalRecords.length} marka aktarılıyor...`);
      for (let i = 0; i < finalRecords.length; i += 1000) {
          const chunk = finalRecords.slice(i, i + 1000);
          const { error } = await supabase.from('trademark_bulletin_records').upsert(chunk);
          if (error) throw error;
          let pct = 15 + Math.floor((i / finalRecords.length) * 15);
          updateProgress(pct, `Markalar Kaydediliyor: ${Math.min(i + 1000, finalRecords.length)} / ${finalRecords.length}`);
      }

      if (finalGoods.length > 0) {
          updateProgress(25, `Veritabanına ${finalGoods.length} eşya listesi aktarılıyor...`);
          for (let i = 0; i < finalGoods.length; i += 1000) {
              const chunk = finalGoods.slice(i, i + 1000);
              const { error } = await supabase.from('trademark_bulletin_goods').upsert(chunk);
              if (error) console.error("Goods (Eşya) veritabanı yazma hatası:", error);
          }
      }

      async function uploadImageWithRetrySafe(destPath, imgData, contentType, retries = 3) {
          for (let i = 0; i < retries; i++) {
              try {
                  const { data, error } = await supabase.storage.from('brand_images').upload(destPath, imgData, {
                      contentType: contentType,
                      upsert: true 
                  });
                  if (!error) return true; 
                  await new Promise(res => setTimeout(res, 500 * (i + 1))); 
              } catch (err) {
                  await new Promise(res => setTimeout(res, 500 * (i + 1))); 
              }
          }
          return false; 
      }

      updateProgress(35, "Görseller Storage'a aktarılıyor. (Lütfen sekmeyi kapatmayın)...");
      const CHUNK_SIZE = 40; 
      let uploadedCount = 0;

      for (let i = 0; i < imageFiles.length; i += CHUNK_SIZE) {
          const chunk = imageFiles.slice(i, i + CHUNK_SIZE);
          
          await Promise.all(chunk.map(async (entry) => {
              try {
                  const imgData = await entry.async("blob");
                  const imgName = entry.name.split('/').pop() || "unknown.jpg";
                  const destPath = `bulletins/trademark_${bulletinNo}_images/${imgName}`;
                  const contentType = imgName.endsWith('.png') ? 'image/png' : 'image/jpeg';
                  
                  await uploadImageWithRetrySafe(destPath, imgData, contentType);
              } catch (blobErr) {}
          }));
          
          uploadedCount += chunk.length;
          let pct = 35 + Math.floor((uploadedCount / imageFiles.length) * 65);
          updateProgress(pct, `Görseller Yükleniyor: ${Math.min(uploadedCount, imageFiles.length)} / ${imageFiles.length}`);
      }

      updateProgress(100, "🎉 İşlem Başarıyla Tamamlandı! Tablo yenileniyor...", "green");
      
      selectedFile = null;
      if (selectedFileName) selectedFileName.textContent = "";
      if (fileInput) fileInput.value = "";
      setTimeout(() => location.reload(), 2000);

    } catch (err) {
      console.error("İşlem Hatası:", err);
      updateProgress(100, "❌ Hata: " + err.message, "crimson");
    }
  });
}

// =========================================================================
// PDF PARSE VE YÜKLEME MOTORU (SÜTUN BAZLI İNSAN GİBİ OKUMA MOTORU)
// =========================================================================
document.addEventListener('DOMContentLoaded', () => {
    // Gizli dosya seçici oluştur
    const pdfInput = document.createElement('input');
    pdfInput.type = 'file';
    pdfInput.accept = 'application/pdf';
    pdfInput.style.display = 'none';
    document.body.appendChild(pdfInput);

    let currentUploadBulletinId = null;
    let currentUploadBulletinNo = null;

    async function loadPdfLibrary() {
        if (window.pdfjsLib) return window.pdfjsLib;
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
            script.onload = () => {
                const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
                if (lib) {
                    lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                    window.pdfjsLib = lib;
                    resolve(lib);
                } else reject(new Error("Kütüphane başlatılamadı."));
            };
            script.onerror = () => reject(new Error("PDF kütüphanesi indirilemedi."));
            document.head.appendChild(script);
        });
    }

    // 🔥 ÇÖZÜM: PDF'İ İNSAN GİBİ OKUYAN (SOL SÜTUN -> SAĞ SÜTUN) MOTOR
    async function getSortedPageItems(page) {
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1.0 });
        const midX = viewport.width / 2; // Sayfanın tam ortası
        
        const leftCol = [];
        const rightCol = [];
        
        textContent.items.forEach(item => {
            if (item.transform[4] < midX) leftCol.push(item);
            else rightCol.push(item);
        });
        
        // Yukarıdan aşağıya (Y azalarak) ve Soldan Sağa (X artarak) sırala
        const sortFn = (a, b) => {
            const yDiff = b.transform[5] - a.transform[5]; 
            // 5 punto tolerans (Aynı satırdaki kelimeleri yan yana getirmek için)
            if (Math.abs(yDiff) > 5) return yDiff; 
            return a.transform[4] - b.transform[4]; 
        };
        
        leftCol.sort(sortFn);
        rightCol.sort(sortFn);
        
        // Önce Sol sütun, peşine Sağ sütun (Kusursuz akış)
        return leftCol.concat(rightCol);
    }

    window.triggerPdfUpload = (bulletinId, bulletinNo) => {
        currentUploadBulletinId = bulletinId;
        currentUploadBulletinNo = bulletinNo;
        pdfInput.value = ''; 
        pdfInput.click();
    };

    pdfInput.addEventListener('change', async (e) => {
        if (!e.target.files || e.target.files.length === 0) return;
        const file = e.target.files[0];
        
        try {
            if (typeof SimpleLoading !== 'undefined') SimpleLoading.show('Hazırlanıyor...', 'PDF İşlem Motoru indiriliyor...');
            
            const pdfjs = await loadPdfLibrary();

            if (typeof SimpleLoading !== 'undefined') SimpleLoading.updateText('PDF Okunuyor...', 'Lütfen bekleyin, metin analiz ediliyor.');

            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjs.getDocument({data: arrayBuffer}).promise;
            let fullText = "";
            
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                // Klasik düz okuma yerine akıllı sütun okuması kullanıyoruz!
                const sortedItems = await getSortedPageItems(page);
                const pageText = sortedItems.map(item => item.str).join(" ");
                fullText += pageText + "\n";
                
                if (i % 10 === 0 && typeof SimpleLoading !== 'undefined') {
                    SimpleLoading.updateText('PDF Okunuyor...', `Sayfa: ${i} / ${pdf.numPages}`);
                }
            }

            if (typeof SimpleLoading !== 'undefined') SimpleLoading.updateText('Veriler Ayrıştırılıyor...', 'Markalar tespit ediliyor.');
            const { records, goods } = parsePdfToRecords(fullText, currentUploadBulletinId, currentUploadBulletinNo);

            if (records.length === 0) throw new Error("PDF içinde geçerli bir marka formatı bulunamadı.");

            // Görselleri Kırpıp (Crop) Yükleme İşlemi
            await extractAndUploadImagesFromPdf(pdf, records, currentUploadBulletinNo);

            if (typeof SimpleLoading !== 'undefined') SimpleLoading.updateText('Veritabanına Kaydediliyor...', `${records.length} adet marka bulundu.`);

            const BATCH_SIZE = 500;
            for (let i = 0; i < records.length; i += BATCH_SIZE) {
                const batchRecords = records.slice(i, i + BATCH_SIZE);
                const { error: recError } = await supabase.from('trademark_bulletin_records').upsert(batchRecords, { onConflict: 'id' });
                if (recError) throw recError;
            }

            for (let i = 0; i < goods.length; i += BATCH_SIZE) {
                const batchGoods = goods.slice(i, i + BATCH_SIZE);
                const { error: goodsError } = await supabase.from('trademark_bulletin_goods').upsert(batchGoods, { onConflict: 'id' });
            }

            if (typeof showNotification !== 'undefined') showNotification(`Başarılı! ${records.length} adet kayıt bültene eklendi.`, 'success');
            setTimeout(() => location.reload(), 1500);

        } catch (error) {
            console.error("PDF Yükleme Hatası:", error);
            if (typeof showNotification !== 'undefined') showNotification("Hata: " + error.message, "error");
        } finally {
            if (typeof SimpleLoading !== 'undefined') SimpleLoading.hide();
        }
    });

    // ---------------------------------------------------------------------------------
    // KOORDİNAT BAZLI GÖRSEL KESİCİ (Sadece 531 ve 511 Kuralı, 5.5 cm Şablon)
    // ---------------------------------------------------------------------------------
    async function extractAndUploadImagesFromPdf(pdf, records, bulletinNo) {
        const imageUploadTasks = [];
        const pdfInfo = {}; 

        // =========================================================
        // 1. AŞAMA: SADECE 531 VE 511 HARİTALANDIRMASI
        // =========================================================
        let currentAppNo = null;

        for (let i = 1; i <= pdf.numPages; i++) {
            if (typeof SimpleLoading !== 'undefined') {
                SimpleLoading.updateText('Kordinatlar Hesaplanıyor...', `Sayfa: ${i} / ${pdf.numPages}`);
            }
            const page = await pdf.getPage(i);
            const sortedItems = await getSortedPageItems(page); 

            for (let j = 0; j < sortedItems.length; j++) {
                const item = sortedItems[j];
                const text = item.str.trim();

                const appNoMatch = text.match(/(\d{4}\/\d{6})/);
                if (appNoMatch) {
                    currentAppNo = appNoMatch[1];
                    if (!pdfInfo[currentAppNo]) {
                        pdfInfo[currentAppNo] = { startAnchor: null, endAnchor: null };
                    }
                }

                if (currentAppNo) {
                    // 🔥 SADECE (531) KODUNU BAŞLANGIÇ (START) OLARAK AL (540 tamamen kaldırıldı)
                    if (text === '(531)' || text.includes('(531)')) {
                        pdfInfo[currentAppNo].startAnchor = { page: i, x: item.transform[4], y: item.transform[5] };
                    }
                    
                    // SADECE (511) KODUNU BİTİŞ (END) OLARAK AL
                    if ((text === '(511)' || text.includes('(511)')) && !pdfInfo[currentAppNo].endAnchor) {
                        pdfInfo[currentAppNo].endAnchor = { page: i, x: item.transform[4], y: item.transform[5] };
                    }
                }
            }
        }

        // =========================================================
        // 2. AŞAMA: BOŞLUK KIYASLAMASI VE SAYFA ÇİZİMİ
        // =========================================================
        const tasksByPage = {};
        const CM_TO_PT = 28.3465;
        const BOX_WIDTH_PT = 7 * CM_TO_PT; 
        const BOX_HEIGHT_PT = 5.5 * CM_TO_PT; // 5.5 cm yükseklik

        for (const record of records) {
            if (record.image_url) continue; 
            const info = pdfInfo[record.application_number];
            
            // Eğer markanın (531) kodu yoksa, resmi de yoktur, pas geç.
            if (info && info.startAnchor) {
                const start = info.startAnchor; // 531
                const end = info.endAnchor;     // 511
                
                let targetPage, targetX, yTopPdf, yBottomPdf;

                // Aynı sayfa ve aynı sütun kontrolü (X sapması < 150 pt)
                const isSamePageAndCol = end && start.page === end.page && Math.abs(start.x - end.x) < 150 && start.y > end.y;

                if (isSamePageAndCol) {
                    // 🔥 KURAL 1: Aynı sütundaysa 511'in ÜSTÜNÜ al
                    targetPage = end.page;
                    targetX = end.x;
                    yBottomPdf = end.y + 14; // 511'in 14 pt üstü
                    yTopPdf = yBottomPdf + BOX_HEIGHT_PT; // 5.5 cm yukarı çık
                    
                    // 531 yazısına çarpmamak için üst sınırı 531'in hemen altına tırpanla
                    if (yTopPdf > start.y - 14) {
                        yTopPdf = start.y - 14;
                    }
                } else if (end) {
                    // 🔥 KURAL 2: Farklı sayfa/sütundaysa BOŞLUK KIYASLAMASI yap
                    const spaceBelow531 = start.y - 50; // 531'in altından sayfa sonuna kadar alan
                    const spaceAbove511 = 800 - end.y;  // 511'in üstünden sayfa başına kadar alan

                    if (spaceBelow531 > spaceAbove511) {
                        // 531'in altındaki boşluk daha büyük -> 531'in ALTINI KES
                        targetPage = start.page;
                        targetX = start.x;
                        yTopPdf = start.y - 14;
                        yBottomPdf = yTopPdf - BOX_HEIGHT_PT;
                    } else {
                        // 511'in üstündeki boşluk daha büyük -> 511'in ÜSTÜNÜ KES
                        targetPage = end.page;
                        targetX = end.x;
                        yBottomPdf = end.y + 14;
                        yTopPdf = yBottomPdf + BOX_HEIGHT_PT;
                    }
                } else {
                    // Nadir durum: 511 hiç bulunamadıysa doğrudan 531'in altını kes
                    targetPage = start.page;
                    targetX = start.x;
                    yTopPdf = start.y - 14;
                    yBottomPdf = yTopPdf - BOX_HEIGHT_PT;
                }

                if (!tasksByPage[targetPage]) tasksByPage[targetPage] = [];
                tasksByPage[targetPage].push({ record, targetX, yTopPdf, yBottomPdf });
            }
        }

        const totalPagesToRender = Object.keys(tasksByPage).length;
        let renderedCount = 0;

        for (const pageNumStr of Object.keys(tasksByPage)) {
            const pageNum = parseInt(pageNumStr);
            const tasks = tasksByPage[pageNum];
            renderedCount++;

            if (typeof SimpleLoading !== 'undefined') {
                SimpleLoading.updateText('Görseller Kesiliyor...', `Sayfa İşleniyor: ${renderedCount} / ${totalPagesToRender}`);
            }

            const page = await pdf.getPage(pageNum);
            const scale = 2.0; 
            const viewport = page.getViewport({ scale });
            
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;

            const unscaledWidth = viewport.width / scale;
            const unscaledHeight = viewport.height / scale;
            const unscaledMidX = unscaledWidth / 2;

            for (const task of tasks) {
                // Sütunun tam ortasını hizala
                let colCenterUnscaled = task.targetX < unscaledMidX ? (unscaledMidX / 2) : (unscaledMidX + (unscaledMidX / 2));
                let rectXUnscaled = colCenterUnscaled - (BOX_WIDTH_PT / 2);

                const rectX = rectXUnscaled * scale;
                const rectYTop = (unscaledHeight - task.yTopPdf) * scale; 
                const rectW = BOX_WIDTH_PT * scale;
                const rectH = (task.yTopPdf - task.yBottomPdf) * scale;

                if (rectH > 0 && rectW > 0) {
                    const cropCanvas = document.createElement('canvas');
                    cropCanvas.width = rectW;
                    cropCanvas.height = rectH;
                    const cropCtx = cropCanvas.getContext('2d');
                    
                    cropCtx.fillStyle = '#FFFFFF';
                    cropCtx.fillRect(0, 0, rectW, rectH);
                    cropCtx.drawImage(canvas, rectX, rectYTop, rectW, rectH, 0, 0, rectW, rectH);

                    const blob = await new Promise(res => cropCanvas.toBlob(res, 'image/jpeg', 0.95));
                    const imgName = `${task.record.application_number.replace(/\//g, '_')}.jpg`;
                    const storagePath = `bulletins/trademark_${bulletinNo}_images/${imgName}`;
                    
                    imageUploadTasks.push({ storagePath, blob, record: task.record });
                }
            }
            canvas.width = 0; canvas.height = 0; 
        }

        // =========================================================
        // 3. AŞAMA: SUPABASE STORAGE'A YÜKLEME
        // =========================================================
        const CHUNK_SIZE = 20;
        for (let i = 0; i < imageUploadTasks.length; i += CHUNK_SIZE) {
            const chunk = imageUploadTasks.slice(i, i + CHUNK_SIZE);
            if (typeof SimpleLoading !== 'undefined') {
                SimpleLoading.updateText('Görseller Yükleniyor...', `${Math.min(i + CHUNK_SIZE, imageUploadTasks.length)} / ${imageUploadTasks.length} yüklendi.`);
            }

            await Promise.all(chunk.map(async (task) => {
                const { error } = await supabase.storage.from('brand_images').upload(task.storagePath, task.blob, { upsert: true, contentType: 'image/jpeg' });
                if (!error) task.record.image_url = task.storagePath; 
            }));
        }
    }

    // ---------------------------------------------------------------------------------
    // METİN PARÇALAYICI (TEMİZLİK VE İNSAN GİBİ OKUMA UYUMLU)
    // ---------------------------------------------------------------------------------
    function parsePdfToRecords(fullText, bulletinId, bulletinNo) {
        const records = [];
        const goods = [];

        // İnsan okumasıyla birleştiği için artık markalar birbirine karışmayacak
        const blocks = fullText.split(/\(\s*210\s*\)/).slice(1); 

        for (let block of blocks) {
            try {
                const appNoMatch = block.match(/(\d{4}\/\d{6})/);
                if (!appNoMatch) continue;
                const application_number = appNoMatch[1];

                const appDateMatch = block.match(/\(\s*220\s*\)\s*(\d{2}\.\d{2}\.\d{4})/);
                let application_date = null;
                if (appDateMatch) {
                    const parts = appDateMatch[1].split('.');
                    application_date = `${parts[2]}-${parts[1]}-${parts[0]}`; 
                }

                const holderMatch = block.match(/\(\s*731\s*\)\s*([\s\S]*?)(?:Vekil:|\(\s*540\s*\)|\(\s*511\s*\))/);
                let holders = [];
                if (holderMatch) {
                    let holderText = holderMatch[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                    holderText = holderText.replace(/Yayın Tarihi.*?\d{4}/gi, '').replace(/Türk Patent ve Marka Kurumu/gi, '').replace(/\d{4}\/\d{3} Resmi Marka Bülteni/gi, '').trim();
                    if (holderText) holders.push(holderText);
                }

                const classMatch = block.match(/\(\s*511\s*\)\s*([\d,\s]+)/);
                let nice_classes = [];
                if (classMatch) nice_classes = classMatch[1].split(/[, \n]+/).map(c => c.trim()).filter(c => c.match(/^\d+$/));

                let brand_name = "Bilinmeyen Marka";
                const nameMatch = block.match(/(?:\(\s*540\s*\)|\(\s*531\s*\))([\s\S]*?)(?=\(\s*511\s*\)|\(\s*510\s*\)|$)/);
                if (nameMatch) {
                     let nameRaw = nameMatch[1].replace(/\(\s*531\s*\)/g, '').replace(/null/gi, '').trim();
                     let lines = nameRaw.split('\n').map(l => l.trim()).filter(l => l);
                     
                     lines = lines.filter(l => {
                         const lower = l.toLowerCase();
                         return !lower.includes('resmi marka bülteni') && !lower.includes('türk patent') && !lower.includes('yayın tarihi') && !/^[_]+$/.test(l) && !/^\d{4}$/.test(l);
                     });
                     
                     if (lines.length > 0) brand_name = lines.join(' ').replace(/\s+/g, ' ').trim();
                }

                let goodsTextMatch = block.match(/\(\s*510\s*\)\s*([\s\S]*)/);
                let goodsText = goodsTextMatch ? goodsTextMatch[1].trim() : "";
                if (goodsText) {
                    goodsText = goodsText.split('\n').filter(l => {
                        const lower = l.toLowerCase();
                        return !lower.includes('resmi marka bülteni') && !lower.includes('türk patent') && !lower.includes('yayın tarihi') && !/^[_]+$/.test(l);
                    }).join(' ').replace(/\s+/g, ' ').trim();
                }

                const deterministicId = `bull_${bulletinNo}_app_${application_number.replace(/\//g, '_')}`;

                records.push({
                    id: deterministicId,
                    bulletin_id: bulletinId,
                    application_number: application_number,
                    brand_name: brand_name,
                    application_date: application_date,
                    nice_classes: nice_classes,
                    holders: holders,
                    image_url: null, 
                    source: 'pdf', 
                    created_at: new Date().toISOString()
                });

                if (goodsText) {
                    nice_classes.forEach((classNo, idx) => {
                        goods.push({
                            id: `${deterministicId}_class_${classNo}_${idx}`,
                            bulletin_record_id: deterministicId,
                            class_number: parseInt(classNo, 10),
                            class_text: goodsText,
                            created_at: new Date().toISOString()
                        });
                    });
                }
            } catch (err) {}
        }
        return { records, goods };
    }
});