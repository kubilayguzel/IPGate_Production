// public/js/turkpatent-mapper.js

import { supabase } from '../supabase-config.js';

function normalizeText(v) { return (v || '').toString().replace(/\s+/g, ' ').trim().toLowerCase(); }

function parseDDMMYYYYToISO(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = (s || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

function formatDate(dateStr) { return parseDDMMYYYYToISO(dateStr); }
function uniq(arr) { return Array.from(new Set(arr)); }

// 🔥 KURAL 1: Sadece GEÇERSİZ veya RED yazıyorsa rejected yap! (Published veya diğerlerini sildik)
export function mapStatusToUtils(turkpatentStatus) {
  if (!turkpatentStatus) return null;
  const s = turkpatentStatus.toString().trim().toUpperCase();
  if (/GEÇERSİZ|RED|RET|İPTAL/i.test(s)) return 'rejected';
  return null;
}

async function uploadBrandImage(applicationNumber, brandImageDataUrl, imageSrc) {
  const imageUrl = brandImageDataUrl || imageSrc;
  if (!imageUrl || !applicationNumber) return null;

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;
    const blob = await response.blob();
    const ext = (blob.type && blob.type.split('/')[1]) || 'jpg';
    
    // Güvenli dosya adı (Bölü işaretlerini temizler)
    const safeAppNo = applicationNumber.replace(/[^a-zA-Z0-9]/g, '_');
    const fileName = `turkpatent_scraped/${safeAppNo}_${Date.now()}.${ext}`;

    const { data, error } = await supabase.storage.from('brand_images').upload(fileName, blob, {
      contentType: blob.type || 'image/jpeg',
      cacheControl: '31536000'
    });

    if (error || !data) return null;
    
    // Public URL döndür
    const { data: publicUrlData } = supabase.storage.from('brand_images').getPublicUrl(data.path);
    return publicUrlData.publicUrl;
  } catch (error) {
    console.error('Görsel upload hatası:', error);
    return null;
  }
}

function parseNiceClasses(niceClassesStr) {
  if (!niceClassesStr) return [];
  // Hem virgül hem boşluk hem de OPTS'deki slash (/) işaretini temizle
  return uniq(niceClassesStr.toString().split(/[,;\s\/]+/).map(n => parseInt(String(n).trim(), 10)).filter(n => !Number.isNaN(n) && n > 0 && n <= 45));
}

function createGoodsAndServicesByClass(inputGSC, niceClassesStr, details) {
  if (Array.isArray(inputGSC) && inputGSC.length > 0) {
    const groupedByClass = new Map();
    inputGSC.forEach(entry => {
      const classNo = Number(entry.classNo);
      let items = Array.isArray(entry.items) ? entry.items : [entry.items];
      if (!groupedByClass.has(classNo)) groupedByClass.set(classNo, []);
      groupedByClass.get(classNo).push(...items.flatMap(item => typeof item === 'string' ? item.split(/[\n.]/).map(s => s.trim()).filter(Boolean) : []));
    });
    return Array.from(groupedByClass.entries()).map(([classNo, items]) => ({ classNo: parseInt(classNo), items: [...new Set(items)] })).sort((a, b) => a.classNo - b.classNo);
  }

  const niceNums = parseNiceClasses(niceClassesStr) || parseNiceClasses(details?.['Nice Sınıfları']);
  if (!Array.isArray(niceNums) || niceNums.length === 0) return [];
  return niceNums.map(classNo => ({ classNo: parseInt(classNo), items: [] }));
}

export async function mapTurkpatentToIPRecord(turkpatentData, selectedApplicants = []) {
  const { applicationNumber, brandName, applicationDate, registrationNumber, status, niceClasses, brandImageDataUrl, imageSrc, details = {}, goodsAndServicesByClass, transactions: rootTransactions } = turkpatentData || {};
  const transactions = (Array.isArray(rootTransactions) && rootTransactions.length > 0) ? rootTransactions : (details.transactions || []);
  
  // Başvuru numarasını her koşulda güvene al
  const finalAppNo = applicationNumber || details?.['Başvuru Numarası'] || null;
  const brandImageUrl = await uploadBrandImage(finalAppNo, brandImageDataUrl, imageSrc);

  // 🔥 İŞLEM GEÇMİŞİ (TRANSACTIONS) ARAMASI TAMAMEN KALDIRILDI. SADECE ALANLARI OKUYORUZ.
  const registrationDate = turkpatentData.registrationDate ? formatDate(turkpatentData.registrationDate) : formatDate(details?.['Tescil Tarihi']);
  const regNo = registrationNumber || details?.['Tescil Numarası'] || null;

  let calculatedRenewalDate = null;
  const topLevelRenewal = turkpatentData?.renewalDate || details?.['Yenileme Tarihi'];
  if (topLevelRenewal) {
    const d = new Date(formatDate(topLevelRenewal) || topLevelRenewal);
    if (!isNaN(d.getTime())) calculatedRenewalDate = d.toISOString().split('T')[0];
  } else if (registrationDate || applicationDate) {
    const baseDate = new Date(registrationDate || formatDate(applicationDate) || applicationDate);
    if (!isNaN(baseDate.getTime())) { baseDate.setFullYear(baseDate.getFullYear() + 10); calculatedRenewalDate = baseDate.toISOString().split('T')[0]; }
  }

  // ==========================================
  // 🔥 SİZİN KESİN DURUM (STATUS) ALGORİTMANIZ
  // ==========================================
  let turkpatentStatusText = details?.['Durumu'] || details?.['Karar'] || status || '';
  
  // 1. KURAL: GEÇERSİZ veya RED yazıyorsa anında rejected!
  let finalStatus = mapStatusToUtils(turkpatentStatusText); 

  if (!finalStatus) {
    // 2. KURAL: Tescil Tarihi veya Tescil Numarası Varsa
    if (registrationDate || regNo) {
      if (calculatedRenewalDate) {
        const graceEnd = new Date(calculatedRenewalDate); 
        graceEnd.setMonth(graceEnd.getMonth() + 6); // 6 aylık lütuf süresi
        if (new Date() < graceEnd) {
          finalStatus = 'registered'; // Süre bitmediyse Tescilli
        } else {
          finalStatus = 'rejected'; // Süre bitmişse ve yenilenmemişse düştü
        }
      } else {
        finalStatus = 'registered'; // Yenileme tarihi hesaplanamadı ama Tescil tarihi var
      }
    }
  }

  // 3. KURAL: İkisi de değilse Başvuru Aşamasındadır!
  if (!finalStatus) {
    finalStatus = 'filed';
  }
  // ==========================================

  // Bülten bilgisi çıkarma
  const get = (k) => details?.[k] ?? null;
  let bNo = get('Bülten Numarası') || get('Bülten No') || get('Marka İlan Bülten No') || null;
  let bDate = get('Bülten Tarihi') || get('Yayım Tarihi') || get('Marka İlan Bülten Tarihi') || null;

  if (!bNo && Array.isArray(transactions)) {
    for (const tx of transactions) {
      const m = (tx?.description || tx?.action || '').match(/(?:bülten|bulletin)\s*(?:no|numarası)?\s*[:\-]?\s*([0-9/]+)/i);
      if (m) {
         bNo = m[1];
         bDate = tx?.date || null;
         break;
      }
    }
  }

  // 🔥 SUPABASE-CONFIG BEKLENTİLERİNE GÖRE TAM VE EKSİKSİZ OBJEYİ DÖNDÜR
  return {
    // 1. Ana Tablo Alanları
    ipType: 'trademark',
    origin: 'TÜRKPATENT',
    countryCode: 'TR',
    portfoyStatus: 'active',
    status: finalStatus,
    recordOwnerType: 'self',
    applicationNumber: finalAppNo,
    applicationDate: formatDate(applicationDate || details?.['Başvuru Tarihi']),
    registrationNumber: regNo,
    registrationDate: registrationDate,
    renewalDate: calculatedRenewalDate,
    createdFrom: 'turkpatent_scraper',
    
    // 2. Marka Detayları
    title: brandName || details?.['Marka Adı'] || 'Başlıksız Marka',
    brandType: details?.['Marka Türü'] || 'Şekil + Kelime',
    brandCategory: details?.['Marka Kategorisi'] || 'Ticaret/Hizmet Markası',
    brandImageUrl: brandImageUrl,
    description: details?.['Açıklama'] || null,

    // 3. İlişkisel Diziler
    goodsAndServicesByClass: createGoodsAndServicesByClass(goodsAndServicesByClass, niceClasses, details),
    applicants: Array.isArray(selectedApplicants) ? selectedApplicants.map(a => ({ id: a.id })) : [],
    
    bulletinNo: bNo,
    bulletinDate: formatDate(bDate)
  };
}

export async function mapTurkpatentResultsToIPRecords(turkpatentResults, selectedApplicants) {
  if (!Array.isArray(turkpatentResults)) return [];
  const out = [];
  for (let i = 0; i < turkpatentResults.length; i++) {
    try {
      const rec = await mapTurkpatentToIPRecord(turkpatentResults[i], selectedApplicants);
      rec.id = `turkpatent_${Date.now()}_${i}`; // Geçici ID
      out.push(rec);
    } catch (e) { console.error(`Kayıt ${i} mapping hatası:`, e); }
  }
  return out; 
}