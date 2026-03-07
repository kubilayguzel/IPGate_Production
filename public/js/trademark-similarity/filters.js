// js/trademark-similarity/filters.js
  function parseDate(dateStr) {
  if (!dateStr) return null;

  // ISO format (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(dateStr);
  }

  // DD/MM/YYYY formatı
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [day, month, year] = dateStr.split('/');
    return new Date(`${year}-${month}-${day}`);
  }

  // Default
  return new Date(dateStr);
}
export function isValidBasedOnDate(hitApplicationDate, monitoredApplicationDate) {
  console.log("📅 Tarih karşılaştırması:", hitApplicationDate, "vs", monitoredApplicationDate);
  
  try {
    if (!hitApplicationDate || !monitoredApplicationDate) {
      console.log("⚠️ Eksik tarih bilgisi, kabul ediliyor");
      return true;
    }
    
  const hitDate = parseDate(hitApplicationDate);
  const monitoredDate = parseDate(monitoredApplicationDate);

  if (!hitDate || !monitoredDate || isNaN(hitDate.getTime()) || isNaN(monitoredDate.getTime())) {
      console.log("⚠️ Geçersiz tarih formatı, kabul ediliyor");
      return true;
  }

    // Hit'in tarihi izlenen markanın tarihinden önce veya aynı gün ise dahil et
    const isValid = hitDate >= monitoredDate;
    console.log(`📅 Tarih kontrolü: ${isValid ? 'Geçerli' : 'Geçersiz'}`);
    return isValid;
    
  } catch (error) {
    console.error('❌ Tarih karşılaştırma hatası:', error);
    return true; // Hata durumunda dahil et
  }
}

export function hasOverlappingNiceClasses(hitNiceClasses, monitoredNiceClasses) {
  console.log("🏷️ Nice sınıf karşılaştırması:", hitNiceClasses, "vs", monitoredNiceClasses);
  
  try {
    if (!Array.isArray(hitNiceClasses) || !Array.isArray(monitoredNiceClasses)) {
      console.log("⚠️ Nice sınıf array değil, false döndürülüyor");
      return false;
    }
    
    // Nice sınıflarını normalize et (sadece rakamları al)
    const normalizeClass = (cls) => {
      if (typeof cls === 'string') {
        return cls.replace(/\D/g, ''); // Sadece rakamları al
      }
      return String(cls);
    };
    
    const hitClasses = hitNiceClasses.map(normalizeClass).filter(cls => cls);
    const monitoredClasses = monitoredNiceClasses.map(normalizeClass).filter(cls => cls);
    
    console.log("🔧 Normalize edilmiş sınıflar:", hitClasses, "vs", monitoredClasses);
    
    // Kesişim kontrolü
    const hasOverlap = hitClasses.some(hitClass => 
      monitoredClasses.some(monitoredClass => hitClass === monitoredClass)
    );
    
    console.log(`🏷️ Nice sınıf kesişimi: ${hasOverlap ? 'VAR' : 'YOK'}`);
    return hasOverlap;
    
  } catch (error) {
    console.error('❌ Nice class karşılaştırma hatası:', error);
    return false;
  }
}