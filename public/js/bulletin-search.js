// public/js/bulletin-search.js
import { supabase } from "../supabase-config.js";
import { loadSharedLayout } from "../js/layout-loader.js";

console.log("✅ bulletin-search.js yüklendi (Supabase Uyumlu)!");

loadSharedLayout({ activeMenuLink: "bulletin-search.html" });

document.getElementById("searchButton").addEventListener("click", async () => {
  const type = document.getElementById("bulletinType").value;
  const bulletinNo = document.getElementById("bulletinNo").value.trim();

  if (!bulletinNo) {
    alert("Lütfen bülten numarası girin.");
    return;
  }

  const recordsContainer = document.getElementById("recordsContainer");
  recordsContainer.innerHTML = "<p>Aranıyor...</p>";

  try {
    // 1. Bültenin varlığını kontrol et ve ID'sini al
    const { data: bulletinData, error: bulletinError } = await supabase
      .from("trademark_bulletins")
      .select("id, bulletin_no")
      .eq("bulletin_no", bulletinNo)
      .limit(1);

    if (bulletinError || !bulletinData || bulletinData.length === 0) {
      recordsContainer.innerHTML = "<p>Belirtilen kriterlerde bülten bulunamadı. Lütfen önce bülteni yükleyin.</p>";
      return;
    }

    const bulletinId = bulletinData[0].id; // Gerçek bulletin ID'sini aldık

    // 2. Bültene ait kayıtları (Markaları) bulletin_id kullanarak getir
    const { data: records, error: recordsError } = await supabase
      .from("trademark_bulletin_records")
      .select("*")
      .eq("bulletin_id", bulletinId)
      .limit(5000); 

    if (recordsError || !records || records.length === 0) {
      recordsContainer.innerHTML = "<p>Bu bültene ait kayıt bulunamadı.</p>";
      return;
    }

    let html = `
      <div class="tasks-container">
      <table class="tasks-table">
        <thead>
          <tr>
            <th>Başvuru No</th>
            <th>Marka Örneği</th>
            <th>Marka Adı</th>
            <th>Hak Sahibi / Vekil</th>
            <th>Başvuru Tarihi</th>
            <th>Sınıflar</th>
          </tr>
        </thead>
        <tbody>`;

    for (const r of records) {
      let imageUrlHtml = "-";
      // Şemadaki doğru kolon adı: image_url
      if (r.image_url) {
        const { data } = supabase.storage.from("brand_images").getPublicUrl(r.image_url);
        if (data && data.publicUrl) {
            imageUrlHtml = `<img src="${data.publicUrl}" loading="lazy" class="marka-image" style="max-height: 60px; object-fit: contain;">`;
        }
      }

      // JSONB array formatındaki holders alanını düzgün göstermek için ayırıyoruz
      let holdersText = "-";
      if (r.holders && Array.isArray(r.holders) && r.holders.length > 0) {
          holdersText = r.holders.join("<br>");
      } else if (typeof r.holders === 'string') {
          holdersText = r.holders;
      }

      // nice_classes array formatında, string'e çeviriyoruz
      let classesText = "-";
      if (r.nice_classes && Array.isArray(r.nice_classes)) {
          classesText = r.nice_classes.join(", ");
      }

      html += `
        <tr>
          <td>${r.application_number || "-"}</td>
          <td>${imageUrlHtml}</td>
          <td>${r.brand_name || "-"}</td>
          <td>${holdersText}</td>
          <td>${r.application_date || "-"}</td>
          <td>${classesText}</td>
        </tr>`;
    }

    html += "</tbody></table></div>";
    recordsContainer.innerHTML = html;

  } catch (err) {
    console.error("Sorgulama hatası:", err);
    recordsContainer.innerHTML = "<p>Bir hata oluştu. Konsolu kontrol edin.</p>";
  }
});