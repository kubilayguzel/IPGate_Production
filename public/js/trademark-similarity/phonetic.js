// phonetic.js - Tarayıcı uyumlu basit fonetik benzerlik kontrolü

/**
 * Noktalama ve büyük harfleri temizler ve Türkçe karakterleri normalleştirir.
 */
function normalizeString(str) {
    if (!str) return "";
    return str
        .toLowerCase()
        .replace(/[^a-z0-9ğüşöçı]/g, '') // Sadece harf ve rakamları tut
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/ı/g, 'i');
}

/**
 * İki kelimenin basit fonetik benzerliğini skor olarak döndürür (0-1 arası).
 * Çok basit bir fonetik kontrolü yapar, daha gelişmiş algoritmalar (örn. Double Metaphone) için Node.js ortamı veya complex JS kütüphaneleri gerekebilir.
 * Burada, harf değişimlerini ve pozisyonları dikkate alan bir puanlama yapıyoruz.
 */
export function isPhoneticallySimilar(a, b) {
    if (!a || !b) return 0.0;

    a = normalizeString(a);
    b = normalizeString(b);

    if (a === b) return 1.0;

    const lenA = a.length;
    const lenB = b.length;
    const minLen = Math.min(lenA, lenB);
    const maxLen = Math.max(lenA, lenB);

    if (maxLen === 0) return 1.0; // Her ikisi de boşsa
    if (maxLen > 0 && minLen === 0) return 0.0; // Birisi boşsa

    // Eğer uzunluk farkı çok büyükse, benzerlik düşüktür.
    // Örneğin, uzunluk farkının maksimum uzunluğa oranı
    const lengthMismatchPenalty = Math.abs(lenA - lenB) / maxLen;
    let score = 1.0 - lengthMismatchPenalty;

    // Basit bir eşleşen karakter sayısı / transpozisyon benzeri mantık
    let matchingChars = 0;
    const matchedA = new Array(lenA).fill(false);
    const matchedB = new Array(lenB).fill(false);

    // Kapsam içinde eşleşen karakterleri say
    const searchRange = Math.min(maxLen, Math.floor(maxLen / 2) + 1); // Arama penceresi
    for (let i = 0; i < lenA; i++) {
        for (let j = Math.max(0, i - searchRange); j < Math.min(lenB, i + searchRange + 1); j++) {
            if (a[i] === b[j] && !matchedB[j]) {
                matchingChars++;
                matchedA[i] = true;
                matchedB[j] = true;
                break;
            }
        }
    }

    if (matchingChars === 0) return 0.0;

    // Ortak harflerin oranı
    const commonality = matchingChars / Math.max(lenA, lenB);
    
    // Pozisyonel benzerlik bonusu/cezası (ilk harfler daha önemli)
    let positionalBonus = 0;
    if (lenA > 0 && lenB > 0) {
        if (a[0] === b[0]) positionalBonus += 0.2; // İlk harf eşleşmesi
        // İkinci harf eşleşmesi
        if (lenA > 1 && lenB > 1 && a[1] === b[1]) positionalBonus += 0.1;
    }

    // Skorları birleştirme
    // commonality daha temel bir benzerlik ölçüsü, positionalBonus onu artırır.
    score = (commonality * 0.7) + (positionalBonus * 0.3);

    // Sonuç 0-1 aralığına normalize et
    return Math.max(0.0, Math.min(1.0, score));
}