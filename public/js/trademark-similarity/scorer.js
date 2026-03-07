// js/trademark-similarity/scorer.js

import { cleanMarkName } from './preprocess.js';
import { visualMismatchPenalty } from './visual-match.js';
import { isPhoneticallySimilar } from './phonetic.js';

// ======== Dahili Yardımcı Fonksiyonlar ========

/**
 * Levenshtein mesafesi hesaplar ve 0-1 aralığında benzerlik skoru döndürür.
 * 1.0 tam benzerlik, 0.0 hiç benzer olmama.
 */
function levenshteinSimilarity(str1, str2) {
    const matrix = [];
    if (str1.length === 0) return str2.length === 0 ? 1.0 : 0.0;
    if (str2.length === 0) return str1.length === 0 ? 1.0 : 0.0;

    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            const cost = str2.charAt(i - 1) === str1.charAt(j - 1) ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j - 1] + cost, // substitution
                matrix[i][j - 1] + 1,     // insertion
                matrix[i - 1][j] + 1      // deletion
            );
        }
    }
    const maxLength = Math.max(str1.length, str2.length);
    return maxLength === 0 ? 1.0 : 1.0 - (matrix[str2.length][str1.length] / maxLength);
}

/**
 * Jaro-Winkler benzerliği hesaplar. Öneklere daha fazla ağırlık verir.
 * Kaynak: https://en.wikipedia.org/wiki/Jaro%E2%80%93Winkler_distance
 */
function jaroWinklerSimilarity(s1, s2) {
    if (s1 === s2) return 1.0;

    let m = 0; // matching characters
    const s1_len = s1.length;
    const s2_len = s2.length;

    const range = Math.floor(Math.max(s1_len, s2_len) / 2) - 1;
    const s1_matches = new Array(s1_len);
    const s2_matches = new Array(s2_len);

    for (let i = 0; i < s1_len; i++) {
        const char_s1 = s1[i];
        for (let j = Math.max(0, i - range); j < Math.min(s2_len, i + range + 1); j++) {
            if (char_s1 === s2[j] && !s2_matches[j]) {
                s1_matches[i] = true;
                s2_matches[j] = true;
                m++;
                break;
            }
        }
    }

    if (m === 0) return 0.0;

    let k = 0;
    let t = 0; // transpositions
    for (let i = 0; i < s1_len; i++) {
        if (s1_matches[i]) {
            let j;
            for (j = k; j < s2_len; j++) {
                if (s2_matches[j]) {
                    k = j + 1;
                    break;
                }
            }
            if (s1[i] !== s2[j]) {
                t++;
            }
        }
    }
    t = t / 2;

    const jaro_score = (m / s1_len + m / s2_len + (m - t) / m) / 3;

    // Winkler modification
    const p = 0.1; // prefix scale (typically 0.1)
    let l = 0; // length of common prefix
    const max_prefix_len = 4; // usually up to 4 characters

    for (let i = 0; i < Math.min(s1_len, s2_len, max_prefix_len); i++) {
        if (s1[i] === s2[i]) {
            l++;
        } else {
            break;
        }
    }

    return jaro_score + l * p * (1 - jaro_score);
}

/**
 * N-gram benzerliği hesaplar (örneğin n=2 için bigram).
 * 0-1 aralığında benzerlik skoru döndürür.
 */
function ngramSimilarity(s1, s2, n = 2) {
    if (!s1 || !s2) return 0.0;
    if (s1 === s2) return 1.0;

    const getNGrams = (s, num) => {
        const ngrams = new Set();
        for (let i = 0; i <= s.length - num; i++) {
            ngrams.add(s.substring(i, i + num));
        }
        return ngrams;
    };

    const ngrams1 = getNGrams(s1, n);
    const ngrams2 = getNGrams(s2, n);

    if (ngrams1.size === 0 && ngrams2.size === 0) return 1.0;
    if (ngrams1.size === 0 || ngrams2.size === 0) return 0.0;

    let common = 0;
    ngrams1.forEach(ngram => {
        if (ngrams2.has(ngram)) {
            common++;
        }
    });

    return common / Math.min(ngrams1.size, ngrams2.size); // Ortak n-gram'ların en küçük küme boyutuna oranı
}

/**
 * Önek benzerliği hesaplar (ilk N karakter).
 * 0-1 aralığında skor döndürür.
 */
function prefixSimilarity(s1, s2, length = 3) {
    if (!s1 || !s2) return 0.0;
    const prefix1 = s1.substring(0, Math.min(s1.length, length));
    const prefix2 = s2.substring(0, Math.min(s2.length, length));

    if (prefix1 === prefix2) return 1.0;
    if (prefix1.length === 0 && prefix2.length === 0) return 1.0; // Her ikisi de boşsa tam benzer

    // Önekler arasında Levenshtein benzerliği kullanarak kademeli skor
    return levenshteinSimilarity(prefix1, prefix2);
}

/**
 * Çok kelimeli markalarda kelime bazında en yüksek benzerliği bulur.
 * Marka isimleri kelimelere ayrılır ve her kelime çifti arasında en yüksek Levenshtein benzerliği bulunur.
 */
function maxWordSimilarity(s1, s2) {
    if (!s1 || !s2) return 0.0;

    const words1 = s1.split(' ').filter(w => w.length > 0);
    const words2 = s2.split(' ').filter(w => w.length > 0);

    if (words1.length === 0 && words2.length === 0) return 1.0;
    if (words1.length === 0 || words2.length === 0) return 0.0;

    let maxSim = 0.0;
    for (const w1 of words1) {
        for (const w2 of words2) {
            maxSim = Math.max(maxSim, levenshteinSimilarity(w1, w2));
        }
    }
    return maxSim;
}

// ======== Ana Benzerlik Skorlama Fonksiyonu ========

/**
 * İki marka arasında kapsamlı bir benzerlik skoru hesaplar.
 *
 * @param {Object} hit - Veritabanındaki marka kaydı (markName alanı içerir).
 * @param {string} searchMarkName - Kullanıcının aradığı marka adı.
 * @returns {number} 0 ile 1 arasında benzerlik skoru.
 */
export function calculateSimilarityScore(hit, searchMarkName) {
    // Jenerik ibare temizliği
    // Sadece birden fazla kelime içeren markalar için generic kelime temizliği yap.
    // Tek kelimelik markalarda 'market' gibi kelimeler temizlenmemeli, çünkü markanın çekirdeği olabilir.
    const isSearchMultiWord = searchMarkName.trim().split(/\s+/).length > 1;
    const isHitMultiWord = (hit.markName || '').trim().split(/\s+/).length > 1;

    const cleanedSearchName = cleanMarkName(searchMarkName || '', isSearchMultiWord).toLowerCase().trim();
    const cleanedHitName = cleanMarkName(hit.markName || '', isHitMultiWord).toLowerCase().trim();

    // Debug için temizlenmiş isimleri logla
    console.log(`📊 Skorlama: '${searchMarkName}' (temizlenmiş: '${cleanedSearchName}') vs '${hit.markName}' (temizlenmiş: '${cleanedHitName}')`);

    if (!cleanedSearchName || !cleanedHitName) {
        // İsimlerden biri veya ikisi temizlendikten sonra boş kalırsa benzerlik sıfır.
        return 0.0;
    }

    // Tam eşleşme kontrolü (en yüksek öncelik)
    if (cleanedSearchName === cleanedHitName) {
        return 1.0;
    }

    // ======== Alt Benzerlik Skorları ========

    // 1. Levenshtein Benzerlik Skoru
    const levenshteinScore = levenshteinSimilarity(cleanedSearchName, cleanedHitName);
    console.log(`   - Levenshtein Score: ${levenshteinScore.toFixed(2)}`);

    // 2. Jaro-Winkler Benzerlik Skoru
    const jaroWinklerScore = jaroWinklerSimilarity(cleanedSearchName, cleanedHitName);
    console.log(`   - Jaro-Winkler Score: ${jaroWinklerScore.toFixed(2)}`);

    // 3. N-gram Benzerlik Skoru (Bigram, n=2)
    const ngramScore = ngramSimilarity(cleanedSearchName, cleanedHitName, 2);
    console.log(`   - N-gram Score (n=2): ${ngramScore.toFixed(2)}`);

    // 4. Görsel Karakter Benzerlik Skoru
    // visualMismatchPenalty düşükse skor yüksek demektir. Tersine çevirip normalize etmeliyiz.
    const visualPenalty = visualMismatchPenalty(cleanedSearchName, cleanedHitName);
    const maxPossibleVisualPenalty = Math.max(cleanedSearchName.length, cleanedHitName.length) * 1.0; // Her karakter tam farklı ise
    const visualScore = maxPossibleVisualPenalty === 0 ? 1.0 : (1.0 - (visualPenalty / maxPossibleVisualPenalty));
    console.log(`   - Visual Score: ${visualScore.toFixed(2)} (Penalty: ${visualPenalty.toFixed(2)})`);

    // 5. Önek Benzerlik Skoru (İlk 3 karakter)
    const prefixScore = prefixSimilarity(cleanedSearchName, cleanedHitName, 3);
    console.log(`   - Prefix Score (len 3): ${prefixScore.toFixed(2)}`);

    // 6. Kelime Bazında En Yüksek Benzerlik Skoru
    const maxWordScore = maxWordSimilarity(cleanedSearchName, cleanedHitName);
    console.log(`   - Max Word Score: ${maxWordScore.toFixed(2)}`);

    // ======== İsim Benzerliği Alt Toplamı Hesaplama (%95 Ağırlık) ========
    const nameSimilarityRaw = (
        levenshteinScore * 0.30 +
        jaroWinklerScore * 0.25 +
        ngramScore * 0.15 +
        visualScore * 0.15 +
        prefixScore * 0.10 +
        maxWordScore * 0.05 // Daha düşük ağırlık, çünkü diğerleri daha temel
    );
    // Maksimum skor 1.0 olduğu için, ağırlıklı ortalama doğrudan 0-1 arasında bir değer verir.
    // Burada normalize etmeye gerek yok, çünkü ağırlıklar toplamı 1.0'dir.

    const nameSimilarityWeighted = nameSimilarityRaw * 0.95;
    console.log(`   - Name Similarity (weighted 95%): ${nameSimilarityWeighted.toFixed(2)}`);

    // ======== Fonetik Benzerlik Skoru (%5 Ağırlık) ========
    // isPhoneticallySimilar artık 0-1 arası skor döndürüyor.
    const phoneticScoreRaw = isPhoneticallySimilar(searchMarkName, hit.markName); // Orijinal isimleri kullan
    const phoneticSimilarityWeighted = phoneticScoreRaw * 0.05;
    console.log(`   - Phonetic Score (weighted 5%): ${phoneticSimilarityWeighted.toFixed(2)}`);

    // ======== Genel Benzerlik Skoru ========
    let finalScore = nameSimilarityWeighted + phoneticSimilarityWeighted;

    // Minimum bir skor eşiği koyabiliriz, eğer çok alakasız ise 0'a yakın olmasını sağlamak için.
    finalScore = Math.max(0.0, Math.min(1.0, finalScore)); // Skoru 0-1 arasına sıkıştır

    console(`   - FINAL SCORE: ${finalScore.toFixed(2)}\n`);
    return finalScore;
}