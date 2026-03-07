// public/js/turkpatent-mapper.js

import { supabase } from './supabase-config.js';

function normalizeText(v) { return (v || '').toString().replace(/\s+/g, ' ').trim().toLowerCase(); }

function parseDDMMYYYYToISO(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = (s || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

function formatDate(dateStr) { return parseDDMMYYYYToISO(dateStr); }
function uniq(arr) { return Array.from(new Set(arr)); }

export function mapStatusToUtils(turkpatentStatus) {
  if (!turkpatentStatus) return null;
  if (/GEÇERSİZ/i.test(turkpatentStatus.toString().trim())) return 'rejected';
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
    
    // Klasör yapısı düzenlendi
    const fileName = `turkpatent_scraped/${applicationNumber}_${Date.now()}.${ext}`;

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
  return uniq(niceClassesStr.toString().split(/[,;\s]+/).map(n => parseInt(String(n).trim(), 10)).filter(n => !Number.isNaN(n) && n > 0 && n <= 45));
}

function createBulletins(details, transactions) {
  const out = [];
  const get = (k) => details?.[k] ?? null;
  const bNo = get('Bülten Numarası') || get('Bülten No') || get('Marka İlan Bülten No') || null;
  const bDate = get('Bülten Tarihi') || get('Yayım Tarihi') || get('Marka İlan Bülten Tarihi') || null;

  if (bNo || bDate) out.push({ bulletin_no: bNo, bulletin_date: formatDate(bDate) });

  if (Array.isArray(transactions)) {
    for (const tx of transactions) {
      const m = (tx?.description || '').match(/(?:bülten|bulletin)\s*(?:no|numarası)?\s*[:\-]?\s*([0-9/]+)/i);
      if (m) out.push({ bulletin_no: m[1], bulletin_date: formatDate(tx?.date) || null });
    }
  }

  const uniqueMap = new Map();
  for (const b of out) {
    const key = `${b.bulletin_no || ''}_${b.bulletin_date || ''}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key, b);
  }
  return Array.from(uniqueMap.values());
}

function createGoodsAndServicesByClass(inputGSC, niceClassesStr, details) {
  if (Array.isArray(inputGSC) && inputGSC.length > 0) {
    const groupedByClass = new Map();
    inputGSC.forEach(entry => {
      const class_no = Number(entry.classNo);
      let items = Array.isArray(entry.items) ? entry.items : [entry.items];
      if (!groupedByClass.has(class_no)) groupedByClass.set(class_no, []);
      groupedByClass.get(class_no).push(...items.flatMap(item => typeof item === 'string' ? item.split(/[\n.]/).map(s => s.trim()).filter(Boolean) : []));
    });
    // JSON'a uyum için classNo -> class_no olarak düzeltildi
    return Array.from(groupedByClass.entries()).map(([class_no, items]) => ({ class_no: parseInt(class_no), items: [...new Set(items)] })).sort((a, b) => a.class_no - b.class_no);
  }

  const niceNums = parseNiceClasses(niceClassesStr) || parseNiceClasses(details?.['Nice Sınıfları']);
  if (!Array.isArray(niceNums) || niceNums.length === 0) return [];
  return niceNums.map(class_no => ({ class_no: parseInt(class_no), items: [] }));
}

function createOldTransactions(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];
  // DB'de JSONB olarak tutulacağı için key'leri snake_case yapıyoruz
  return transactions.map(tx => ({
    transaction_date: formatDate(tx?.date),
    description: tx?.description || tx?.action || null,
    note: tx?.note || null,
    source: 'turkpatent_scrape',
    created_at: new Date().toISOString()
  }));
}

export async function mapTurkpatentToIPRecord(turkpatentData, selectedApplicants = []) {
  const { applicationNumber, brandName, applicationDate, registrationNumber, status, niceClasses, brandImageDataUrl, imageSrc, details = {}, goodsAndServicesByClass, transactions: rootTransactions } = turkpatentData || {};
  const transactions = (Array.isArray(rootTransactions) && rootTransactions.length > 0) ? rootTransactions : (details.transactions || []);
  const brandImageUrl = await uploadBrandImage(applicationNumber, brandImageDataUrl, imageSrc);

  let registrationDate = turkpatentData.registrationDate ? formatDate(turkpatentData.registrationDate) : formatDate(details?.['Tescil Tarihi']);
  if (!registrationDate && Array.isArray(transactions)) {
    const regTx = transactions.find(tx => (tx?.description || tx?.action || '').toUpperCase().includes('TESCİL EDİLDİ'));
    if (regTx?.date) registrationDate = formatDate(regTx.date);
  }

  let calculatedRenewalDate = null;
  const topLevelRenewal = turkpatentData?.renewalDate || details?.['Yenileme Tarihi'];
  if (topLevelRenewal) {
    const d = new Date(formatDate(topLevelRenewal) || topLevelRenewal);
    if (!isNaN(d.getTime())) calculatedRenewalDate = d.toISOString().split('T')[0];
  } else if (registrationDate || applicationDate) {
    const baseDate = new Date(registrationDate || formatDate(applicationDate) || applicationDate);
    if (!isNaN(baseDate.getTime())) { baseDate.setFullYear(baseDate.getFullYear() + 10); calculatedRenewalDate = baseDate.toISOString().split('T')[0]; }
  }

  let turkpatentStatusText = details?.['Durumu'] || status;
  let finalStatus = mapStatusToUtils(turkpatentStatusText); 

  if (!finalStatus && registrationDate && calculatedRenewalDate) {
    const graceEnd = new Date(calculatedRenewalDate); graceEnd.setMonth(graceEnd.getMonth() + 6); 
    if (new Date() < graceEnd) finalStatus = 'registered'; 
  }
  if (!finalStatus) finalStatus = 'filed';

  return {
    // --- 1. ip_records Tablosu ---
    ip_type: 'trademark',
    origin: 'TÜRKPATENT',
    country_code: 'TR',
    portfolio_status: 'active',
    status: finalStatus,
    record_owner_type: 'self',
    application_number: applicationNumber || null,
    application_date: formatDate(applicationDate),
    registration_number: registrationNumber || details?.['Tescil Numarası'] || null,
    registration_date: registrationDate,
    renewal_date: calculatedRenewalDate,
    created_from: 'turkpatent_scraper',
    old_transactions: createOldTransactions(transactions), // JSONB olarak saklanacak
    
    // --- 2. ip_record_trademark_details Tablosu ---
    brand_name: brandName || 'Başlıksız Marka',
    brand_type: details?.['Marka Türü'] || 'Şekil + Kelime',
    brand_category: details?.['Marka Kategorisi'] || 'Ticaret/Hizmet Markası',
    brand_image_url: brandImageUrl,
    description: details?.['Açıklama'] || null,

    // --- 3. İlişkisel Diziler (tp-file-transfer.js bunları ilgili tablolara bölecek) ---
    classes: createGoodsAndServicesByClass(goodsAndServicesByClass, niceClasses, details), // ip_record_classes
    bulletins: createBulletins(details, transactions), // ip_record_bulletins
    // applicant id'lerini person_id ile eşliyoruz
    applicants: Array.isArray(selectedApplicants) ? selectedApplicants.map(a => ({ person_id: a.id, email: a.email || null })) : [] // ip_record_applicants
  };
}

export async function mapTurkpatentResultsToIPRecords(turkpatentResults, selectedApplicants) {
  if (!Array.isArray(turkpatentResults)) return [];
  const out = [];
  for (let i = 0; i < turkpatentResults.length; i++) {
    try {
      const rec = await mapTurkpatentToIPRecord(turkpatentResults[i], selectedApplicants);
      rec.id = `turkpatent_${Date.now()}_${i}`; // Geçici ID (UI'da göstermek için), DB'ye kaydederken UUID üretilecek
      out.push(rec);
    } catch (e) { console.error(`Kayıt ${i} mapping hatası:`, e); }
  }
  return out; 
}