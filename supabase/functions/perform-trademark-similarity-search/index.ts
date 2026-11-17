// supabase/functions/perform-trademark-similarity-search/index.ts

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RELATED_CLASSES_MAP: Record<string, string[]> = {
    // 1-34 ARASI TÜM MALLAR (Kendi aralarındaki ilişkiler + 35. Sınıf)
    "1": ["5", "35"],
    "2": ["35"],
    "3": ["5", "35", "44"],
    "4": ["35"],
    "5": ["1", "3", "10", "35", "44"],
    "6": ["19", "20", "35", "37"],
    "7": ["35", "37"],
    "8": ["35"],
    "9": ["28", "35", "38", "41", "42"],
    "10": ["5", "35", "44"],
    "11": ["21", "35", "37"],
    "12": ["35", "37", "39"],
    "13": ["35"],
    "14": ["18", "25", "35"], // Moda/Aksesuar üçgeni
    "15": ["35"],
    "16": ["35", "41"],
    "17": ["35"],
    "18": ["14", "25", "35"], // Moda/Aksesuar üçgeni
    "19": ["6", "35", "37"],
    "20": ["6", "21", "24", "27", "35"],
    "21": ["11", "20", "35"],
    "22": ["35"],
    "23": ["24", "25", "35"],
    "24": ["20", "23", "25", "27", "35"],
    "25": ["14", "18", "23", "24", "26", "35"], // Moda/Aksesuar üçgeni
    "26": ["25", "35"],
    "27": ["20", "24", "35"],
    "28": ["9", "35", "41"],
    "29": ["30", "31", "35", "43"],
    "30": ["29", "31", "35", "43"],
    "31": ["29", "30", "35", "43"],
    "32": ["33", "35", "43"], // İçecek ve Kafe/Restoran ilişkisi
    "33": ["32", "35", "43"], // İçecek ve Kafe/Restoran ilişkisi
    "34": ["35"],

    // 35. SINIF (Tüm mallar 1-34 ve Finans 36 ile eşleşti)
    "35": [
        "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", 
        "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", 
        "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", 
        "31", "32", "33", "34", "36"
    ],

    // 36-45 ARASI HİZMETLER
    "36": ["35", "37", "39"],
    "37": ["6", "7", "11", "12", "19", "36"],
    "38": ["9"],
    "39": ["12", "36"],
    "41": ["9", "16", "28", "42"],
    "42": ["9", "41"],
    "43": ["29", "30", "31", "32", "33"], // Yiyecek/İçecek malları ile ilişkili
    "44": ["3", "5", "10"]
};;

const GENERIC_WORDS = [
    'ltd', 'şti', 'aş', 'anonim', 'şirketi', 'şirket', 'limited', 'inc', 'corp', 'corporation', 'co', 'company', 'llc', 'group', 'grup',
    'sanayi', 'ticaret', 'turizm', 'tekstil', 'gıda', 'inşaat', 'danışmanlık', 'hizmet', 'hizmetleri', 'bilişim', 'teknoloji', 'sigorta', 'yayıncılık', 'mobilya', 'otomotiv', 'tarım', 'enerji', 'petrol', 'kimya', 'kozmetik', 'ilaç', 'medikal', 'sağlık', 'eğitim', 'spor', 'müzik', 'film', 'medya', 'reklam', 'pazarlama', 'lojistik', 'nakliyat', 'kargo', 'finans', 'bankacılık', 'emlak', 'gayrimenkul', 'madencilik', 'metal', 'plastik', 'cam', 'seramik', 'ahşap',
    'mühendislik', 'proje', 'taahhüt', 'ithalat', 'ihracat', 'kuyumculuk','mücevherat','üretim', 'imalat', 'veteriner', 'petshop', 'polikliniği', 'hastane', 'klinik', 'müşavirlik', 'muhasebe', 'hukuk', 'avukatlık', 'mimarlık', 'peyzaj', 'tasarım', 'dizayn', 'design', 'grafik', 'web', 'yazılım', 'software', 'donanım', 'hardware', 'elektronik', 'elektrik', 'makina', 'makine', 'endüstri', 'fabrika', 'laboratuvar', 'araştırma', 'geliştirme', 'ofis',
    'ürün', 'products', 'services', 'solutions', 'çözüm', 'sistem', 'systems', 'teknolojileri', 'malzeme', 'materials', 'ekipman', 'equipment', 'cihaz', 'device', 'araç', 'tools', 'yedek', 'parça', 'parts', 'aksesuar', 'accessories', 'gereç',
    'meşhur', 'ünlü', 'famous', 'since', 'est', 'established', 'tarihi', 'historical', 'geleneksel', 'traditional', 'klasik', 'classic', 'yeni', 'new', 'fresh', 'taze', 'özel', 'special', 'premium', 'lüks', 'luxury', 'kalite', 'quality', 'uygun',
    'turkey', 'türkiye', 'international', 'uluslararası', 'tesisi', 'sistemleri',
    'real', 'estate', 'realestate', 'emlak', 'konut', 'housing', 'arsa', 'ticari', 'commercial', 'office', 'plaza', 'shopping', 'alışveriş', 'residence', 'rezidans', 'villa', 'apartment', 'daire',
    'online', 'digital', 'dijital', 'internet', 'app', 'mobile', 'mobil', 'network', 'ağ', 'server', 'sunucu', 'hosting', 'domain', 'platform', 'social', 'sosyal', 'media', 'medya',
    'yemek', 'restaurant', 'restoran', 'cafe', 'coffee', 'tea', 'fırın', 'bakery', 'ekmek', 'pasta', 'börek', 'pizza', 'burger', 'kebap', 'döner', 'pide', 'lahmacun', 'balık', 'fish', 'et', 'meat', 'tavuk', 'chicken', 'sebze', 'vegetable', 'meyve', 'fruit', 'süt', 'milk', 'peynir', 'cheese', 'yoğurt', 'yogurt', 'dondurma', 'sugar', 'bal', 'reçel', 'jam', 'konserve', 'canned', 'organic', 'organik', 'doğal', 'natural',
    've', 'ile', 'için', 'bir', 'bu', 'da', 'de', 'ki', 'mi', 'mı', 'mu', 'mü', 'sadece', 'tek', 'en', 'çok', 'az', 'üst', 'alt', 'eski', 'insaat', 'in', 'to', 'the', 'of', 'for', 'at', 'on', 'by', 'with', 'a', 'an',
    'com', 'comtr', 'www', 'io'
];

function removeTurkishSuffixes(word: string) {
    if (!word) return '';
    if (word.endsWith('ler') || word.endsWith('lar')) return word.substring(0, word.length - 3);
    if (word.endsWith('si') || word.endsWith('sı') || word.endsWith('sü') || word.endsWith('su')) return word.substring(0, word.length - 2);
    if (word.length > 2 && ['i', 'ı', 'u', 'ü'].includes(word[word.length - 1])) return word.substring(0, word.length - 1);
    return word;
}

function splitCompoundGenerics(text: string) {
    const safeGenerics = GENERIC_WORDS.filter(w => w.length >= 4);
    let words = text.split(/\s+/);
    let processedWords = words.map(word => {
        if (word.length <= 5) return word;
        let stemmedWord = removeTurkishSuffixes(word);
        let originalSuffix = word.slice(stemmedWord.length); 

        for (const gen of safeGenerics) {
            if (stemmedWord.endsWith(gen) && stemmedWord.length > gen.length) {
                const root = stemmedWord.slice(0, -gen.length);
                if (root.length >= 3) {
                    return root + ' ' + gen + originalSuffix; 
                }
            }
        }

        for (const gen of safeGenerics) {
            if (stemmedWord.startsWith(gen) && stemmedWord.length > gen.length) {
                const root = stemmedWord.slice(gen.length);
                if (root.length >= 3) {
                    return gen + ' ' + root + originalSuffix;
                }
            }
        }
        return word;
    });
    return processedWords.join(' ');
}

function cleanMarkName(name: string, removeGenericWords = true, protectedWords: string[] = []) {
    if (!name) return '';
    let processed = String(name).toLowerCase()
        .replace(/['`’]/g, '')
        .replace(/\.(com\.tr|net\.tr|org\.tr|com|tr|net|org|co|io|info|biz|tv)\b/g, '')
        .replace(/^www\./g, '')
        .replace(/ch/g, 'ç')
        .replace(/sh/g, 'ş')
        .replace(/x/g, 'ks')
        .replace(/pf/g, 'f');
        
    let cleaned = processed.replace(/[^a-z0-9ğüşöçı\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (removeGenericWords) {
        cleaned = splitCompoundGenerics(cleaned);
        cleaned = cleaned.split(' ').filter(word => {
            const stemmedWord = removeTurkishSuffixes(word);
            
            // Jenerik ve Koruma kontrolleri
            const isGeneric = GENERIC_WORDS.includes(stemmedWord) || GENERIC_WORDS.includes(word);
            const isProtected = protectedWords.includes(stemmedWord) || protectedWords.includes(word);
            
            return !isGeneric || isProtected;
        }).join(' ');
    }
    return cleaned.trim();
}

function normalizeStringForPhonetic(str: string) {
    if (!str) return "";
    return str.toLowerCase()
        .replace(/ch/g, 'ç')
        .replace(/sh/g, 'ş')
        .replace(/x/g, 'ks')
        .replace(/pf/g, 'f')
        .replace(/[^a-z0-9ğüşöçı]/g, '')
        .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/ı/g, 'i');
}

function numberToTurkishText(numStr: string): string {
    const birler = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
    const onlar = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
    let num = parseInt(numStr, 10);
    if (isNaN(num)) return numStr;
    if (num === 0) return "sıfır";
    
    let text = "";
    let binlerBas = Math.floor(num / 1000);
    let yuzlerBas = Math.floor((num % 1000) / 100);
    let onlarBas = Math.floor((num % 100) / 10);
    let birlerBas = num % 10;

    if (binlerBas > 1) text += birler[binlerBas] + " bin ";
    else if (binlerBas === 1) text += "bin ";

    if (yuzlerBas > 1) text += birler[yuzlerBas] + " yüz ";
    else if (yuzlerBas === 1) text += "yüz ";

    if (onlarBas > 0) text += onlar[onlarBas] + " ";
    if (birlerBas > 0) text += birler[birlerBas] + " ";

    return text.trim();
}

function convertNumbersAndSymbolsToText(str: string): string {
    if (!str) return "";
    let result = str;
    result = result.replace(/&/g, ' ve ').replace(/\+/g, ' artı ').replace(/%/g, ' yüzde ');
    result = result.replace(/\b\d{1,4}\b/g, (match) => {
        return numberToTurkishText(match);
    });
    return result.replace(/\s+/g, ' ').trim();
}

const rawVisualMap: Record<string, string[]> = {
    "o": ["0", "ö"], "ö": ["o"], "0": ["o", "O"],
    "b": ["d", "p"], "d": ["b", "p", "t"], "p": ["b", "d", "q"],
    "c": ["ç", "s", "k"], "ç": ["c", "s"], 
    "s": ["ş", "z", "c"], "ş": ["s", "z"], "z": ["s", "ş"],
    "g": ["ğ", "k", "q"], "ğ": ["g", "q"],
    "q": ["k", "g"], "k": ["q", "c", "g"], 
    "i": ["ı", "l", "1", "j"], "ı": ["i", "l", "1"], "l": ["i", "ı", "1"], "1": ["i", "ı", "l"], "j": ["i", "y"], "y": ["j"],
    "m": ["n"], "n": ["m", "r"], "r": ["n"],
    "u": ["ü", "v"], "ü": ["u", "v"], "v": ["u", "ü", "w"], "w": ["v", "u"], 
    "f": ["t"], "t": ["f", "d"]
};

const fastVisualMap: Record<string, Record<string, boolean>> = {};
for (const [k, vals] of Object.entries(rawVisualMap)) {
    if (!fastVisualMap[k]) fastVisualMap[k] = {};
    for (const v of vals) {
        fastVisualMap[k][v] = true;
        if (!fastVisualMap[v]) fastVisualMap[v] = {};
        fastVisualMap[v][k] = true;
    }
}

function parseDateForValidation(val: any): Date | null {
    if (!val) return null;
    if (typeof val === 'string') {
        const parts = val.split(/[./-]/);
        if (parts.length === 3) {
            if (parts[0].length === 4) return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
            else return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
        }
        const iso = new Date(val);
        if (!isNaN(iso.getTime())) return iso;
    }
    return null;
}

const v0 = new Float64Array(512);
const v1 = new Float64Array(512);

function levenshteinSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    const lenA = a.length, lenB = b.length;
    if (lenA === 0 || lenB === 0) return 0.0;
    if (lenB >= 512) return 0.0; 

    let pStart, pMid, pEnd;
    const maxLen = Math.max(lenA, lenB);
    
    if (maxLen <= 3) {
        pStart = 0.70; pMid = 0.50; pEnd = 0.60;
    } else if (maxLen >= 8) {
        pStart = 0.30; pMid = 0.20; pEnd = 0.15;
    } else {
        const step = maxLen - 3; 
        pStart = 0.70 - (0.08 * step); 
        pMid = 0.50 - (0.06 * step);   
        pEnd = 0.60 - (0.09 * step);   
    }

    for (let i = 0; i <= lenB; i++) v0[i] = i;
    
    for (let i = 0; i < lenA; i++) {
        v1[0] = i + 1;
        for (let j = 0; j < lenB; j++) {
            const charA = a[i];
            const charB = b[j];
            
            let cost = 1.0; 
            
            if (charA === charB) {
                cost = 0.0; 
            } else {
                let isSpecialIY = false;
                if (charA === 'i' && charB === 'y' && (a[i + 1] === 'a' || a[i + 1] === 'e' || b[j + 1] === 'a' || b[j + 1] === 'e')) isSpecialIY = true;
                if (charA === 'y' && charB === 'i' && (a[i + 1] === 'a' || a[i + 1] === 'e' || b[j + 1] === 'a' || b[j + 1] === 'e')) isSpecialIY = true;

                if (isSpecialIY || (fastVisualMap[charA] && fastVisualMap[charA][charB])) {
                    const isStart = (i === 0 && j === 0);
                    const isEnd = (i === lenA - 1 && j === lenB - 1);

                    if (isStart) cost = pStart; 
                    else if (isEnd) cost = pEnd; 
                    else cost = pMid; 
                }
            }

            v1[j + 1] = Math.min(
                v1[j] + 1,           
                v0[j + 1] + 1,       
                v0[j] + cost         
            );
        }
        for (let j = 0; j <= lenB; j++) v0[j] = v1[j];
    }
    
    return Math.max(0.0, Math.min(1.0, 1 - (v1[lenB] / Math.max(lenA, lenB))));
}

function getTurkishPhoneticSkeleton(str: string): string {
    if (!str) return "";
    let code = str.toLowerCase();
    
    code = code.replace(/[bp]/g, '1')
               .replace(/[cçj]/g, '2')
               .replace(/[dt]/g, '3')
               .replace(/[gkğq]/g, '4')
               .replace(/[vf]/g, '5')
               .replace(/[sşz]/g, '6');
               
    code = code.replace(/[aeıioöuü]/g, '');
    code = code.replace(/(.)\1+/g, '$1');
    
    return code;
}

function isPhoneticallySimilar(a: string, b: string) {
    if (!a || !b) return 0.0;
    
    const skeletonA = getTurkishPhoneticSkeleton(a);
    const skeletonB = getTurkishPhoneticSkeleton(b);
    
    if (skeletonA === skeletonB && skeletonA.length > 0) {
        return 1.0; 
    }
    
    return levenshteinSimilarity(skeletonA, skeletonB);
}

function calculateSimilarityScoreInternal(searchMarkNameOriginal: string, hitMarkNameOriginal: string, s1: string, s2: string) {
    if (!s1 || !s2) return { finalScore: 0.0, positionalExactMatchScore: 0.0 }; 
    if (s1 === s2) return { finalScore: 1.0, positionalExactMatchScore: 1.0 }; 

    const positionalExactMatchScore = (() => {
        const len = Math.min(s1.length, s2.length, 3);
        if (len === 0) return 0.0;
        for (let i = 0; i < len; i++) if (s1[i] !== s2[i]) return 0.0;
        return 1.0;
    })();

    let substringBonus = 0.0;
    if (s1.length >= 3 && s2.length >= 3) {
        const checkExactWord = (full: string, part: string) => {
            return full === part || full.startsWith(part + ' ') || full.endsWith(' ' + part) || full.includes(' ' + part + ' ');
        };
        if (checkExactWord(s2, s1) || checkExactWord(s1, s2)) {
            substringBonus = 0.88; 
        }
    }

    if (s1.length === 2 && s2.length >= 2) {
        const words2 = s2.split(' ').filter(w => w.length > 0);
        for (const w of words2) {
            if (w.length > 2 && w.endsWith(s1)) {
                substringBonus = Math.max(substringBonus, 0.82); 
            }
        }
    }

    const computeCoreScore = (a: string, b: string) => {
        if (!a || !b) return 0.0;
        if (a === b) return 1.0;

        const lev = levenshteinSimilarity(a, b);
        
        const jw = (() => {
            let m = 0; const a_len = a.length, b_len = b.length;
            const range = Math.floor(Math.max(a_len, b_len) / 2) - 1;
            const a_matches = new Array(a_len).fill(false), b_matches = new Array(b_len).fill(false);
            for (let i = 0; i < a_len; i++) {
                for (let j = Math.max(0, i - range); j < Math.min(b_len, i + range + 1); j++) {
                    if (a[i] === b[j] && !b_matches[j]) { a_matches[i] = true; b_matches[j] = true; m++; break; }
                }
            }
            if (m === 0) return 0.0;
            let k = 0, t = 0;
            for (let i = 0; i < a_len; i++) {
                if (a_matches[i]) {
                    let j; for (j = k; j < b_len; j++) { if (b_matches[j]) { k = j + 1; break; } }
                    if (a[i] !== b[j]) t++;
                }
            }
            t /= 2;
            const jaro_score = (m / a_len + m / b_len + (m - t) / m) / 3;
            let l = 0;
            for (let i = 0; i < Math.min(a_len, b_len, 4); i++) { if (a[i] === b[i]) l++; else break; }
            return jaro_score + l * 0.1 * (1 - jaro_score);
        })();

        const ngram = (() => {
            const getNGrams = (s: string) => { const n = new Set<string>(); for (let i = 0; i <= s.length - 2; i++) n.add(s.substring(i, i + 2)); return n; };
            const ng1 = getNGrams(a), ng2 = getNGrams(b);
            if (ng1.size === 0 && ng2.size === 0) return 1.0;
            if (ng1.size === 0 || ng2.size === 0) return 0.0;
            let common = 0; ng1.forEach(ng => { if (ng2.has(ng)) common++; });
            return (2 * common) / (ng1.size + ng2.size); 
        })();

        let coreScore = (lev * 0.60 + jw * 0.25 + ngram * 0.15);

        if (a.length > 0 && b.length > 0) {
            const charA = a[0];
            const charB = b[0];
            let isFirstLetterMatch = (charA === charB);
            
            if (!isFirstLetterMatch) {
                 let isSpecialIY = false;
                 if (charA === 'i' && charB === 'y' && (a[1] === 'a' || a[1] === 'e' || b[1] === 'a' || b[1] === 'e')) isSpecialIY = true;
                 if (charA === 'y' && charB === 'i' && (a[1] === 'a' || a[1] === 'e' || b[1] === 'a' || b[1] === 'e')) isSpecialIY = true;
                 
                 if (isSpecialIY || (fastVisualMap[charA] && fastVisualMap[charA][charB])) {
                     isFirstLetterMatch = true; 
                 }
            }
            
            if (!isFirstLetterMatch) {
                coreScore = coreScore * 0.85; 
            }
        }

        if (coreScore >= 0.50 && ngram <= 0.40) {
            const penaltyPercent = 0.30 - (ngram * 0.50); 
            coreScore = coreScore * (1.0 - penaltyPercent); 
        }

        return coreScore;
    };

    const w1 = s1.split(' ').filter(w => w.length > 0);
    const w2 = s2.split(' ').filter(w => w.length > 0);
    
    let bestWordLevenshtein = 0.0; 
    let exactWordLen = 0;

    if (w1.length > 0 && w2.length > 0) {
        for (const a of w1) {
            for (const b of w2) {
                const pairLevenshtein = levenshteinSimilarity(a, b);
                if (pairLevenshtein > bestWordLevenshtein) {
                    bestWordLevenshtein = pairLevenshtein;
                    if (a === b) exactWordLen = a.length;
                }
            }
        }
    }

    let earlyReturnScore = Math.max(substringBonus, bestWordLevenshtein);
    if (earlyReturnScore >= 0.70) {
        if (earlyReturnScore === 1.0 && exactWordLen < 2 && s1 !== s2) { 
            // pas geç
        } else { 
            return { finalScore: earlyReturnScore, positionalExactMatchScore }; 
        }
    }

    const fullStringScore = computeCoreScore(s1, s2);
    
    let bestWordPairScore = 0.0;
    if (w1.length > 0 && w2.length > 0) {
        for (const a of w1) {
            for (const b of w2) {
                const pairScore = computeCoreScore(a, b);
                if (pairScore > bestWordPairScore) {
                    bestWordPairScore = pairScore;
                }
            }
        }
    }

    let phase2Final = fullStringScore;
    
    // 🔥 2. YENİ KURAL: Aranan marka (veya ayrıştırılıp sepete atılan tekil kelime) TEK BİR kelimeyse, 
    // bültendeki marka kaç kelime olursa olsun (örn: "ünüdolu çeltik"), cümlenin bütünüyle kıyaslayıp 
    // puanı düşürmek yerine, yakaladığı en iyi kelime skorunu (bestWordPairScore) geçerli say.
    if (w1.length === 1 && w2.length >= 1) {
        phase2Final = Math.max(fullStringScore, bestWordPairScore);
    } else {
        // Eğer aranan marka da birden fazla kelimeyse (örn: "anadolu parse" vs "ünüdolu çeltik")
        // eski harmanlama mantığını koru.
        if (bestWordPairScore >= 0.6) {
            phase2Final = Math.max(phase2Final, bestWordPairScore);
        } else if (bestWordPairScore > fullStringScore) {
            phase2Final = fullStringScore + ((bestWordPairScore - fullStringScore) * 0.5);
        }
    }
    
    phase2Final = Math.max(phase2Final, substringBonus);

    const s1Sorted = s1.replace(/\s+/g, '').split('').sort().join('');
    const s2Sorted = s2.replace(/\s+/g, '').split('').sort().join('');
    const anagramScoreRaw = computeCoreScore(s1Sorted, s2Sorted);
    const anagramScore = anagramScoreRaw * 0.80; 

    phase2Final = Math.max(phase2Final, substringBonus, anagramScore);

    // Tek kelimelik izlenen marka ile çok kelimeli bülten markası karşılaştırmasında
    // ek kelimeler fonetik skoru yapay olarak düşürmesin. Bu özel senaryoda
    // yalnızca görsel/core benzerlik skoru kullanılır.
    const useVisualOnlyForSingleVsMulti = w1.length === 1 && w2.length > 1;

    let finalScore;
    if (useVisualOnlyForSingleVsMulti) {
        finalScore = phase2Final;
    } else {
        const phonRaw = isPhoneticallySimilar(searchMarkNameOriginal, hitMarkNameOriginal);
        finalScore = (phase2Final * 0.95) + (phonRaw * 0.05);
    }

    finalScore = Math.max(0.0, Math.min(1.0, finalScore));

    return { finalScore, positionalExactMatchScore }; 
}
// -----------------------------------------------------------------------------
// IPGate 2026-11-13: Kalıcı checkpoint'li, tarayıcı tarafından sürülen güvenilir
// worker yapısı. Önceki marka temizleme / Nice / benzerlik fonksiyonları aynen
// korunmuştur (bu dosyanın üst bölümünde).
// -----------------------------------------------------------------------------

type SearchMark = Record<string, any> & { id: string; monitoringType: 'domestic' | 'international' };
type PreparedMark = SearchMark & {
    primaryName: string;
    searchTerms: { term: string; cleanedSearchName: string }[];
    parsedAppDate: Date | null;
    greenSet: Set<string>;
    orangeSet: Set<string>;
    blueSet: Set<string>;
    bypassClassFilter: boolean;
    protectedWords: string[];
};

const MAX_WORKERS = 10;
const MAX_LEASE_ATTEMPTS = 8;
const LEASE_SECONDS = 75;
const PERMANENT_RESULT_CHUNK_SIZE = 500;
const BULLETIN_SELECT = 'id, application_number, application_date, brand_name, nice_classes, holders, image_url';

// Yalnızca işçi yürütme verimliliği: Hazırlanan marka verisini aynı Edge
// isolate tekrar kullanırsa hesaplamadan alır. Isolate değişirse özgün
// prepareMarks() tekrar çalışır; eşleşme/eleme/skor koduna dokunulmaz.
// Job ve worker kimlikleri yeni bir aramada benzersizdir.
const WORKER_LIGHT_COLUMNS = [
    'id', 'job_id', 'status', 'progress', 'results_count', 'last_error',
    'expected_mark_count', 'last_record_id', 'processed_records',
    'lease_token', 'lease_until', 'attempts', 'updated_at'
].join(', ');
const MAX_PREPARED_CACHE_WORKERS = 32;
const preparedWorkerCache = new Map<string, {
    jobId: string;
    marks: SearchMark[];
    prepared: PreparedMark[];
}>();
function rememberPreparedWorker(workerId: string, item: {
    jobId: string; marks: SearchMark[]; prepared: PreparedMark[]
}) {
    preparedWorkerCache.delete(workerId);
    preparedWorkerCache.set(workerId, item);
    if (preparedWorkerCache.size > MAX_PREPARED_CACHE_WORKERS) {
        const oldest = preparedWorkerCache.keys().next().value;
        if (oldest) preparedWorkerCache.delete(oldest);
    }
}

// Supabase Edge Function aktif CPU sınırı nedeniyle uyarlanabilir paketleme KAPALI.
// Her worker, izlediği marka sayısından bağımsız olarak en fazla 35 bülten
// kaydı işler. İş kapsamı, eleme, skorlar ve kalıcı sonuçlar değişmez.
const FIXED_WORKER_BATCH_SIZE = 35;

const reply = (payload: Record<string, any>, status = 200) =>
    new Response(JSON.stringify(payload), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
    });

const searchBulletinIds = (bulletinKey: string) => {
    const number = String(bulletinKey).split('_')[0];
    return [number, `bulletin_main_${number}`];
};

const assertDatabase = (error: any, message: string) => {
    if (error) throw new Error(`${message}: ${error.message || String(error)}`);
};

const toClasses = (value: any): string[] => {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) return value.flatMap(toClasses);
    if (typeof value === 'string') return value.split(/[^\d]+/).filter(Boolean);
    return [String(value)];
};
const canonicalClass = (value: any) => {
    const number = parseInt(String(value).replace(/\D/g, ''), 10);
    return Number.isFinite(number) ? String(number) : '';
};

function prepareMarks(monitoredMarks: SearchMark[]): PreparedMark[] {
    return monitoredMarks.map((mark: SearchMark) => {
        const primaryName = String(mark.searchMarkName || '').trim() ||
            String(mark.markName || mark.title || mark.trademarkName || '').trim();
        if (!primaryName || primaryName === 'BELİRSİZ_MARKA' || primaryName === 'İsimsiz Marka') {
            throw new Error(`İzlenen marka ${mark.id} için geçerli bir marka adı yok; sessizce atlanmayacak.`);
        }
        const rawAlternatives = mark.brandTextSearch || mark.brand_text_search;
        let alternatives: string[] = Array.isArray(rawAlternatives) ? [...rawAlternatives] : [];
        const validSearchMarkName = Boolean(String(mark.searchMarkName || '').trim());
        if (validSearchMarkName && mark.markName) {
            const exact = String(mark.markName).trim().toLowerCase();
            alternatives = alternatives.filter(alt => String(alt).trim().toLowerCase() !== exact);
        }
        const conceptualName = convertNumbersAndSymbolsToText(primaryName);
        if (conceptualName !== primaryName) alternatives.push(conceptualName);
        const primaryCleaned = cleanMarkName(primaryName, true);
        const words = primaryCleaned.split(' ').filter(w => w.trim().length > 0);
        if (words.length > 1) {
            const sortedName = [...words].sort().join(' ');
            if (sortedName !== primaryCleaned) alternatives.push(sortedName);
        }
        const rawWords = primaryName.toLowerCase().replace(/[^a-z0-9ğüşöçı\s]/g, ' ')
            .split(/\s+/).filter(Boolean);
        if (rawWords.length > 1) {
            for (const word of rawWords) {
                const stemmed = removeTurkishSuffixes(word);
                if (word.length >= 3 && !GENERIC_WORDS.includes(word) &&
                    !GENERIC_WORDS.includes(stemmed) && !alternatives.includes(word) && primaryName !== word) {
                    alternatives.push(word);
                }
            }
        }
        const protectedWords: string[] = [];
        for (const phrase of [primaryName, ...alternatives]) {
            if (!phrase) continue;
            const tokens = String(phrase).toLowerCase().replace(/[^a-z0-9ğüşöçı\s]/g, ' ')
                .split(/\s+/).filter(Boolean);
            protectedWords.push(...tokens);
            for (const token of tokens) protectedWords.push(removeTurkishSuffixes(token));
        }
        const uniqueProtectedWords = [...new Set(protectedWords)];
        // Aynı alternatif terimleri iki kez karşılaştırmayız; sonuç kriteri değişmez.
        const searchTerms = [...new Set([primaryName, ...alternatives]
            .filter(t => t && String(t).trim() && String(t) !== 'undefined').map(t => String(t)))]
            .map(term => ({
                term,
                cleanedSearchName: cleanMarkName(term, term.trim().split(/\s+/).length > 1, uniqueProtectedWords)
            }));
        const goodsByClass = Array.isArray(mark.goodsAndServicesByClass) ? mark.goodsAndServicesByClass : [];
        const originalClasses = goodsByClass.length > 0
            ? toClasses(goodsByClass.map((item: any) => item.classNo || item))
            : toClasses(mark.niceClasses || mark.nice_classes);
        const watchedClasses = toClasses(mark.niceClassSearch || mark.nice_class_search);
        const greenSet = new Set(originalClasses.map(canonicalClass).filter(Boolean));
        const orangeSet = new Set(watchedClasses.map(canonicalClass).filter(Boolean));
        const blueSet = new Set<string>();
        greenSet.forEach(cls => {
            if (RELATED_CLASSES_MAP[cls]) RELATED_CLASSES_MAP[cls].forEach(related => blueSet.add(related));
        });
        const applicationDate = mark.applicationDate || mark.application_date || null;
        return {
            ...mark, primaryName, searchTerms, greenSet, orangeSet, blueSet,
            bypassClassFilter: greenSet.size === 0 && orangeSet.size === 0,
            protectedWords: uniqueProtectedWords,
            parsedAppDate: parseDateForValidation(applicationDate)
        };
    });
}

function matchBulletinBatch(jobId: string, preparedMarks: PreparedMark[], bulletinHits: any[]) {
    const permanentRecords: any[] = [];
    for (const hit of bulletinHits) {
        const parsedHitDate = parseDateForValidation(hit.application_date);
        const hitClasses = toClasses(hit.nice_classes).map(canonicalClass).filter(Boolean);
        const rawHitName = String(hit.brand_name || '');
        const isHitMultiWord = rawHitName.replace(/[^a-zA-Z0-9ğüşöçı]/g, ' ').trim()
            .split(/\s+/).length > 1;
        for (const mark of preparedMarks) {
            if (parsedHitDate && mark.parsedAppDate &&
                !isNaN(parsedHitDate.getTime()) && !isNaN(mark.parsedAppDate.getTime()) &&
                parsedHitDate < mark.parsedAppDate) continue;

            let cleanedHitName = cleanMarkName(rawHitName, isHitMultiWord, mark.protectedWords);
            if (isHitMultiWord) cleanedHitName = cleanedHitName.split(' ').sort().join(' ');
            let hasPoolMatch = mark.bypassClassFilter;
            for (const cls of hitClasses) {
                if (mark.greenSet.has(cls) || mark.orangeSet.has(cls) || mark.blueSet.has(cls)) {
                    hasPoolMatch = true; break;
                }
            }
            for (const searchItem of mark.searchTerms) {
                const term = searchItem.cleanedSearchName;
                let exactPrefixSuffix = false;
                if (term.length >= 3) exactPrefixSuffix = cleanedHitName.includes(term);
                else if (term.length === 2) exactPrefixSuffix = cleanedHitName.split(' ').some(w => w.endsWith(term));
                if (!hasPoolMatch && !exactPrefixSuffix) continue;
                const { finalScore, positionalExactMatchScore } = calculateSimilarityScoreInternal(
                    searchItem.term, rawHitName, term, cleanedHitName
                );
                if (finalScore < 0.5 && positionalExactMatchScore < 0.5 && !exactPrefixSuffix) continue;
                permanentRecords.push({
                    id: `${mark.id}_${hit.id}`,
                    monitored_trademark_id: mark.id,
                    bulletin_record_id: hit.id,
                    similarity_score: finalScore,
                    is_earlier: false,
                    matched_term: searchItem.term,
                    source: 'auto',
                    monitoring_type: mark.monitoringType,
                    criteria_version: Number(mark.criteriaVersion || mark.criteria_version || 1)
                });
                break;
            }
        }
    }
    return permanentRecords;
}

async function resolveMonitoringTypes(supabase: any, marks: any[]): Promise<SearchMark[]> {
    const domesticIds = new Set<string>();
    const intlIds = new Set<string>();
    for (let i = 0; i < marks.length; i += 175) {
        const ids = marks.slice(i, i + 175).map(m => String(m.id));
        const { data, error } = await supabase.from('monitoring_trademarks').select('id').in('id', ids);
        assertDatabase(error, 'Yurtiçi izleme kaydı doğrulaması başarısız');
        for (const row of data || []) domesticIds.add(String(row.id));
    }
    const others = marks.map(m => String(m.id)).filter(id => !domesticIds.has(id));
    // international_monitoring.id uuid: geçersiz kimliği sorguya göndermeyiz.
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (others.some(id => !uuidPattern.test(id))) {
        throw new Error(`İzlenen markalarda bulunmayan kimlik(ler) var: ${others.filter(id => !uuidPattern.test(id)).slice(0, 5).join(', ')}`);
    }
    for (let i = 0; i < others.length; i += 175) {
        const { data, error } = await supabase.from('international_monitoring')
            .select('id').in('id', others.slice(i, i + 175));
        assertDatabase(error, 'Uluslararası izleme kaydı doğrulaması başarısız');
        for (const row of data || []) intlIds.add(String(row.id));
    }
    const unknown = others.filter(id => !intlIds.has(id));
    if (unknown.length) throw new Error(`İzleme kayıtlarında bulunmayan marka kimlikleri: ${unknown.slice(0, 5).join(', ')}`);
    return marks.map(mark => ({
        ...mark,
        id: String(mark.id),
        monitoringType: domesticIds.has(String(mark.id)) ? 'domestic' : 'international'
    }));
}

async function reconcileJob(supabase: any, jobId: string) {
    const { data: job, error: jobError } = await supabase.from('search_progress')
        .select('id, status, total_records, monitored_count, current_results').eq('id', jobId).single();
    assertDatabase(jobError, 'Arama işi okunamadı');
    const { data: workers, error: workerError } = await supabase.from('search_progress_workers')
        .select('id, status, processed_records, expected_mark_count, progress, results_count, last_error')
        .eq('job_id', jobId);
    assertDatabase(workerError, 'Worker durumları okunamadı');
    if (!workers?.length) throw new Error('Arama işinin worker kayıtları bulunamadı.');
    const failed = workers.filter((w: any) => w.status === 'failed');
    const allCompleted = workers.every((w: any) => w.status === 'completed');
    const completeCoverage = allCompleted && workers.every((w: any) =>
        Number(w.processed_records) === Number(job.total_records)) &&
        workers.reduce((sum: number, w: any) => sum + Number(w.expected_mark_count || 0), 0) ===
            Number(job.monitored_count);
    const totalResultCount = workers.reduce((sum: number, w: any) => sum + Number(w.results_count || 0), 0);
    let state = job.status;
    if (failed.length || (allCompleted && !completeCoverage)) {
        state = 'failed';
        const reason = failed.length
            ? failed.map((w: any) => `${w.id}: ${w.last_error || 'Worker başarısız'}`).join(' | ').slice(0, 3500)
            : 'Tüm worker tamamlandı ancak bülten veya marka kapsamı doğrulanamadı.';
        const { error } = await supabase.from('search_progress').update({
            status: 'failed', error_message: reason, current_results: totalResultCount
        }).eq('id', jobId);
        assertDatabase(error, 'Başarısız iş durumu kaydedilemedi');
    } else if (completeCoverage) {
        state = 'completed';
        const { error } = await supabase.from('search_progress').update({
            status: 'completed', error_message: null, current_results: totalResultCount,
            completed_at: new Date().toISOString()
        }).eq('id', jobId);
        assertDatabase(error, 'Tamamlanma doğrulaması kaydedilemedi');
    }
    return {
        status: state,
        currentResults: totalResultCount,
        totalWorkers: workers.length,
        completedWorkers: workers.filter((w: any) => w.status === 'completed').length,
        workers: workers.map((w: any) => ({
            id: w.id, status: w.status, progress: w.progress, resultsCount: w.results_count,
            error: w.last_error
        }))
    };
}

async function createJob(supabase: any, monitoredMarks: any[], selectedBulletinId: string) {
    if (!Array.isArray(monitoredMarks) || !monitoredMarks.length || !selectedBulletinId) {
        throw new Error('İzleme listesi veya bülten numarası eksik.');
    }
    if (monitoredMarks.some(m => !m?.id)) throw new Error('Kimliksiz izleme kaydı var; eksik arama başlatılmayacak.');
    if (new Set(monitoredMarks.map(m => String(m.id))).size !== monitoredMarks.length) {
        throw new Error('İzleme listesindeki kimlikler tekrarlanıyor; eksik arama başlatılmayacak.');
    }
    const { count, error: countError } = await supabase.from('trademark_bulletin_records')
        .select('*', { count: 'exact', head: true }).in('bulletin_id', searchBulletinIds(selectedBulletinId));
    assertDatabase(countError, 'Bülten kayıtları sayılamadı');
    if (!count) throw new Error('Seçilen bültende taranacak kayıt bulunamadı.');

    // Tür bilgisini gönderen eski arayüz sürümlerine bağımlı olmadan DB'den doğrula.
    // Eşleşme kaydı yanlışlıkla domestic türüyle yazılırsa trigger kaydı reddediyordu.
    const marksWithType = await resolveMonitoringTypes(supabase, monitoredMarks);
    const workerCount = Math.min(MAX_WORKERS, marksWithType.length);
    const chunkSize = Math.ceil(marksWithType.length / workerCount);
    const jobId = `job_${crypto.randomUUID()}`;
    const { error: jobError } = await supabase.from('search_progress').insert({
        id: jobId, status: 'processing', current_results: 0, total_records: count,
        bulletin_key: selectedBulletinId, monitored_count: marksWithType.length
    });
    assertDatabase(jobError, 'Arama işi oluşturulamadı');
    const workerRecords = [];
    for (let i = 0; i < workerCount; i++) {
        const chunk = marksWithType.slice(i * chunkSize, (i + 1) * chunkSize);
        if (!chunk.length) continue;
        workerRecords.push({
            id: `${jobId}_w${i + 1}`, job_id: jobId, status: 'pending', progress: 0,
            mark_payload: chunk, expected_mark_count: chunk.length, last_record_id: null,
            processed_records: 0, results_count: 0, attempts: 0,
            updated_at: new Date().toISOString()
        });
    }
    const { error: workerError } = await supabase.from('search_progress_workers').insert(workerRecords);
    if (workerError) {
        await supabase.from('search_progress').update({ status: 'failed', error_message: workerError.message }).eq('id', jobId);
        throw new Error(`Worker kayıtları oluşturulamadı: ${workerError.message}`);
    }
    return {
        success: true, jobId, monitoredMarkCount: marksWithType.length,
        workerCount: workerRecords.length, workerIds: workerRecords.map(w => w.id),
        totalBulletinRecords: count, resumed: false
    };
}

async function claimWorker(supabase: any, jobId: string, workerId: string) {
    const { data: job, error: jobError } = await supabase.from('search_progress')
        .select('id, status, bulletin_key, total_records').eq('id', jobId).single();
    assertDatabase(jobError, 'Arama işi bulunamadı');
    if (job.status === 'failed') throw new Error('Arama işi başarısız. Eksik sonuçlarla tamamlandı sayılmayacak.');
    const cachedPrepared = preparedWorkerCache.get(workerId);
    const hasCache = cachedPrepared?.jobId === jobId;
    const workerColumns = hasCache ? WORKER_LIGHT_COLUMNS : '*';
    const { data: row, error } = await supabase.from('search_progress_workers')
        .select(workerColumns).eq('job_id', jobId).eq('id', workerId).single();
    assertDatabase(error, 'Worker kaydı okunamadı');
    if (row.status === 'completed') return { job, worker: row, state: 'completed', leaseToken: null, cachedPrepared };
    if (row.status === 'failed') throw new Error(row.last_error || 'Worker başarısız.');
    const now = new Date();
    if (row.status === 'processing' && (!row.lease_until || new Date(row.lease_until) > now)) {
        return { job, worker: row, state: 'locked', leaseToken: null, cachedPrepared };
    }
    if (row.status === 'processing' && Number(row.attempts || 0) >= MAX_LEASE_ATTEMPTS) {
        await supabase.from('search_progress_workers').update({
            status: 'failed', last_error: `Worker ${MAX_LEASE_ATTEMPTS} kez kesildi/yeniden denendi.`,
            updated_at: now.toISOString()
        }).eq('id', workerId);
        await reconcileJob(supabase, jobId);
        throw new Error('Worker deneme sınırına ulaştı.');
    }
    const leaseToken = crypto.randomUUID();
    const until = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
    let query = supabase.from('search_progress_workers').update({
        status: 'processing', lease_token: leaseToken, lease_until: until,
        attempts: row.status === 'processing' ? Number(row.attempts || 0) + 1 : 0,
        updated_at: now.toISOString()
    }).eq('id', workerId).eq('job_id', jobId);
    if (row.status === 'pending') query = query.eq('status', 'pending');
    else query = query.eq('status', 'processing').lt('lease_until', now.toISOString());
    const { data: claimed, error: claimError } = await query.select(workerColumns).maybeSingle();
    assertDatabase(claimError, 'Worker kilidi alınamadı');
    if (!claimed) return { job, worker: row, state: 'locked', leaseToken: null, cachedPrepared };
    return { job, worker: claimed, state: 'claimed', leaseToken, cachedPrepared };
}

async function runStep(supabase: any, jobId: string, workerId: string) {
    const claimed = await claimWorker(supabase, jobId, workerId);
    const worker = claimed.worker;
    if (claimed.state !== 'claimed') {
        return {
            success: true, state: claimed.state, workerId, progress: Number(worker.progress || 0),
            resultsCount: Number(worker.results_count || 0),
            waitMs: claimed.state === 'locked' ? Math.max(1200, Math.min(5000,
                new Date(worker.lease_until || Date.now()).getTime() - Date.now())) : 0
        };
    }
    const token = claimed.leaseToken as string;
    try {
        const cached = claimed.cachedPrepared?.jobId === jobId
            ? claimed.cachedPrepared : null;
        const marks: SearchMark[] = Array.isArray(worker.mark_payload)
            ? worker.mark_payload : cached?.marks;
        if (!Array.isArray(marks) || marks.length !== Number(worker.expected_mark_count) || !marks.length) {
            throw new Error('Worker marka listesi eksik veya değiştirilmiş.');
        }
        // Her işçi için aynı marka listesi: hazırlık fonksiyonları isolate hayatta
        // kaldığı sürece bir kez çalışır, soğuk instance'ta güvenle tekrar edilir.
        const preparationStarted = Date.now();
        const prepared = cached?.prepared || prepareMarks(marks);
        const preparationMs = Date.now() - preparationStarted;
        if (!cached) rememberPreparedWorker(workerId, { jobId, marks, prepared });
        const BATCH_SIZE = FIXED_WORKER_BATCH_SIZE;
        let query = supabase.from('trademark_bulletin_records').select(BULLETIN_SELECT)
            .in('bulletin_id', searchBulletinIds(claimed.job.bulletin_key))
            .order('id', { ascending: true }).limit(BATCH_SIZE);
        if (worker.last_record_id) query = query.gt('id', worker.last_record_id);
        const { data: hits, error: fetchError } = await query;
        assertDatabase(fetchError, 'Bülten aralık sorgusu başarısız');
        if (!Array.isArray(hits) || !hits.length) {
            if (Number(worker.processed_records) !== Number(claimed.job.total_records)) {
                throw new Error('Bülten kayıt sayısı değişti ya da aralık eksik; işlem tamamlandı sayılmadı.');
            }
        }
        // Karşılaştırma aynı fonksiyona, aynı hazırlanan markalar ve hit'ler ile
        // girer. Süre bilgisi yalnızca teşhis için döndürülür; paket sabittir.
        const compareStarted = Date.now();
        const records = matchBulletinBatch(jobId, prepared, hits || []);
        // DB sorgusunun ağ süresi CPU ölçümüne katılmaz.
        const computationMs = preparationMs + Date.now() - compareStarted;
        for (let i = 0; i < records.length; i += PERMANENT_RESULT_CHUNK_SIZE) {
            // Aynı (izlenen marka + bülten kaydı) tekrar tarandığında üzerine yazılır.
            // Not / Benzer kararları / başarı şansı dahil edilmez: kullanıcı kararları korunur.
            const batch = records.slice(i, i + PERMANENT_RESULT_CHUNK_SIZE);
            const { data: written, error } = await supabase.rpc('upsert_trademark_similarity_results', {
                p_rows: batch
            });
            assertDatabase(error, 'Kalıcı izleme sonuçları yazılamadı');
            if (Number(written) !== batch.length) {
                throw new Error(`Kalıcı sonuç sayısı eksik: ${written}/${batch.length}`);
            }
        }
        const processed = Number(worker.processed_records || 0) + (hits?.length || 0);
        if (processed > Number(claimed.job.total_records)) {
            throw new Error('Bülten aralığı toplam kayıt sayısını aştı.');
        }
        const finished = processed === Number(claimed.job.total_records) || (hits || []).length < BATCH_SIZE;
        if (finished && processed !== Number(claimed.job.total_records)) {
            throw new Error(`Worker tam kapsama ulaşmadı: ${processed}/${claimed.job.total_records}.`);
        }
        const nextProgress = finished ? 100 : Math.min(99,
            Math.floor(processed * 100 / Number(claimed.job.total_records)));
        const nextState = finished ? 'completed' : 'pending';
        const { data: written, error: updateError } = await supabase.from('search_progress_workers')
            .update({
                status: nextState, last_record_id: hits?.length ? hits[hits.length - 1].id : worker.last_record_id,
                processed_records: processed, results_count: Number(worker.results_count || 0) + records.length,
                progress: nextProgress, lease_token: null, lease_until: null,
                attempts: 0, last_error: null, updated_at: new Date().toISOString()
            })
            .eq('id', workerId).eq('lease_token', token).eq('status', 'processing')
            .select('id').maybeSingle();
        assertDatabase(updateError, 'Checkpoint yazılamadı');
        if (!written) throw new Error('Worker lease değişti; eski işleyici checkpoint yazamaz.');
        if (finished) {
            preparedWorkerCache.delete(workerId);
            await reconcileJob(supabase, jobId);
        }
        return {
            success: true, state: nextState, workerId, progress: nextProgress,
            processedRecords: processed, resultsCount: Number(worker.results_count || 0) + records.length,
            totalRecords: claimed.job.total_records,
            // Zaman bilgisi yalnızca teşhis içindir; paket boyu değişmez.
            batchSize: BATCH_SIZE, processedThisStep: hits?.length || 0,
            computationMs, warmPreparation: Boolean(cached)
        };
    } catch (error: any) {
        const message = String(error?.message || error).slice(0, 2400);
        // Hata halinde asla checkpoint atlanmaz veya başarılı görünmez.
        const { error: statusError } = await supabase.from('search_progress_workers').update({
            status: 'failed', last_error: message, lease_token: null,
            lease_until: null, updated_at: new Date().toISOString()
        }).eq('id', workerId).eq('lease_token', token);
        if (statusError) console.error('[IPGate] Worker hata durumu yazılamadı:', statusError);
        try { await reconcileJob(supabase, jobId); } catch (reconcileError) {
            console.error('[IPGate] Worker başarısızlığını job durumuna taşıyamadı:', reconcileError);
        }
        return { success: false, state: 'failed', workerId, error: message };
    }
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!supabaseUrl || !serviceKey) throw new Error('Supabase servis yapılandırması eksik.');
        const supabase = createClient(supabaseUrl, serviceKey);
        const body = await req.json();
        const action = body.action || 'start';
        if (action === 'start') {
            return reply(await createJob(supabase, body.monitoredMarks, String(body.selectedBulletinId || '')));
        }
        if (action === 'step') {
            const jobId = String(body.jobId || '');
            const workerId = String(body.workerId || '');
            if (!jobId || !workerId || !workerId.startsWith(`${jobId}_w`)) {
                throw new Error('Geçersiz job/worker kimliği.');
            }
            return reply(await runStep(supabase, jobId, workerId));
        }
        if (action === 'verify') {
            const jobId = String(body.jobId || '');
            if (!jobId) throw new Error('jobId eksik.');
            return reply({ success: true, ...(await reconcileJob(supabase, jobId)) });
        }
        if (action === 'resume') {
            const jobId = String(body.jobId || '');
            const selectedBulletinId = String(body.selectedBulletinId || '');
            const { data: job, error: jobError } = await supabase.from('search_progress')
                .select('id, bulletin_key, status, monitored_count, total_records').eq('id', jobId).single();
            assertDatabase(jobError, 'Devam edilecek iş bulunamadı');
            if (job.bulletin_key !== selectedBulletinId) throw new Error('Bülten kimliği değişmiş; yeni tarama başlatılmalı.');
            const { data: workers, error: workersError } = await supabase.from('search_progress_workers')
                .select('id, status').eq('job_id', jobId).order('id');
            assertDatabase(workersError, 'Devam edilecek worker listesi okunamadı');
            if (!workers?.length) throw new Error('İşin worker kayıtları bulunamadı.');
            return reply({
                success: true, resumed: true, jobId, status: job.status,
                workerIds: workers.map((w: any) => w.id), workerCount: workers.length,
                monitoredMarkCount: job.monitored_count, totalBulletinRecords: job.total_records
            });
        }
        throw new Error('Bilinmeyen arama eylemi.');
    } catch (error: any) {
        console.error('[IPGate] Marka tarama hatası:', error);
        return reply({ success: false, error: error?.message || String(error) }, 400);
    }
});
