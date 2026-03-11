// PDF.js kütüphanesinin sayfanızda yüklü olduğunu varsayıyoruz.
// Sayfanızda HTML olarak şu input olmalı: <input type="file" id="bulletinPdfInput" accept="application/pdf" />

document.getElementById('bulletinPdfInput')?.addEventListener('change', async function(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Kullanıcıdan Bülten Numarasını isteyelim
    const bulletinNo = prompt("Lütfen bu dosyanın Bülten Numarasını girin (Örn: 484):");
    if (!bulletinNo) return;

    alert("PDF okunuyor, lütfen bekleyin...");
    
    // 1. PDF'i Metne Çevir
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(" ");
        fullText += pageText + "\n";
    }

    // 2. Sihirli Regex ile Sadece Numaraları Bul
    const regex = /\b(20\d{2}\/\d{5,6})\b/g;
    const matches = fullText.match(regex) || [];
    const uniqueNumbers = [...new Set(matches)]; // Çiftleri temizle

    if (uniqueNumbers.length === 0) {
        return alert("PDF içinde geçerli bir başvuru numarası bulunamadı!");
    }

    // 3. Supabase Kuyruğuna Toplu Ekle (500'erli paketler halinde)
    alert(`Harika! ${uniqueNumbers.length} adet numara bulundu. Kuyruğa aktarılıyor...`);
    
    const BATCH_SIZE = 500;
    let successCount = 0;

    for (let i = 0; i < uniqueNumbers.length; i += BATCH_SIZE) {
        const batch = uniqueNumbers.slice(i, i + BATCH_SIZE);
        const payload = batch.map(num => ({
            application_number: num,
            bulletin_no: bulletinNo,
            status: 'pending'
        }));

        const { error } = await supabase.from('bulletin_fetch_queue').upsert(payload, { onConflict: 'application_number' });
        
        if (!error) successCount += batch.length;
    }

    alert(`İşlem Başarılı! ${successCount} adet numara işlenmek üzere sıraya alındı.`);
});