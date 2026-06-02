// supabase/functions/perform-trademark-similarity-search/index.ts

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RELATED_CLASSES_MAP: Record<string, string[]> = {
    "29": ["30", "31", "43"], "30": ["29", "31", "43"], "31": ["29", "30", "43"],
    "32": ["33"], "33": ["32"], "43": ["29", "30", "31"],
    "1": ["5"], "3": ["5", "44"], "5": ["1", "3", "10", "44"],
    "10": ["5", "44"], "44": ["3", "5", "10"],
    "18": ["25"], "23": ["24", "25"], "24": ["20", "23", "25", "27", "35"],
    "25": ["18", "23", "24", "26"], "26": ["25"],
    "9": ["28", "38", "41", "42"], "28": ["9", "41"], "38": ["9"],
    "41": ["9", "16", "28", "42"], "42": ["9", "41"], "16": ["41"],
    "7": ["37"], "11": ["21", "37"], "12": ["37", "39"],
    "37": ["7", "11", "12", "19", "36"], "39": ["12", "36"],
    "6": ["19", "20"], "19": ["6", "35", "37"], "20": ["6", "21", "24", "27", "35"],
    "21": ["11", "20"], "27": ["20", "24", "35"], "35": ["19", "20", "24", "27", "36"],
    "36": ["35", "37", "39"]
};

const GENERIC_WORDS = [
    'ltd', 'şti', 'aş', 'anonim', 'şirketi', 'şirket', 'limited', 'inc', 'corp', 'corporation', 'co', 'company', 'llc', 'group', 'grup',
    'sanayi', 'ticaret', 'turizm', 'tekstil', 'gıda', 'inşaat', 'danışmanlık', 'hizmet', 'hizmetleri', 'bilişim', 'teknoloji', 'sigorta', 'yayıncılık', 'mobilya', 'otomotiv', 'tarım', 'enerji', 'petrol', 'kimya', 'kozmetik', 'ilaç', 'medikal', 'sağlık', 'eğitim', 'spor', 'müzik', 'film', 'medya', 'reklam', 'pazarlama', 'lojistik', 'nakliyat', 'kargo', 'finans', 'bankacılık', 'emlak', 'gayrimenkul', 'madencilik', 'metal', 'plastik', 'cam', 'seramik', 'ahşap',
    'mühendislik', 'proje', 'taahhüt', 'ithalat', 'ihracat', 'üretim', 'imalat', 'veteriner', 'petshop', 'polikliniği', 'hastane', 'klinik', 'müşavirlik', 'muhasebe', 'hukuk', 'avukatlık', 'mimarlık', 'peyzaj', 'tasarım', 'dizayn', 'design', 'grafik', 'web', 'yazılım', 'software', 'donanım', 'hardware', 'elektronik', 'elektrik', 'makina', 'makine', 'endüstri', 'fabrika', 'laboratuvar', 'araştırma', 'geliştirme', 'ofis',
    'ürün', 'products', 'services', 'solutions', 'çözüm', 'sistem', 'systems', 'teknolojileri', 'malzeme', 'materials', 'ekipman', 'equipment', 'cihaz', 'device', 'araç', 'tools', 'yedek', 'parça', 'parts', 'aksesuar', 'accessories', 'gereç',
    'meşhur', 'ünlü', 'famous', 'since', 'est', 'established', 'tarihi', 'historical', 'geleneksel', 'traditional', 'klasik', 'classic', 'yeni', 'new', 'fresh', 'taze', 'özel', 'special', 'premium', 'lüks', 'luxury', 'kalite', 'quality', 'uygun',
    'turkey', 'türkiye', 'international', 'uluslararası', 'tesisi', 'sistemleri',
    'real', 'estate', 'realestate', 'emlak', 'konut', 'housing', 'arsa', 'ticari', 'commercial', 'office', 'plaza', 'shopping', 'alışveriş', 'residence', 'rezidans', 'villa', 'apartment', 'daire',
    'online', 'digital', 'dijital', 'internet', 'app', 'mobile', 'mobil', 'network', 'ağ', 'server', 'sunucu', 'hosting', 'domain', 'platform', 'social', 'sosyal', 'media', 'medya',
    'yemek', 'restaurant', 'restoran', 'cafe', 'coffee', 'tea', 'fırın', 'bakery', 'ekmek', 'bread', 'pasta', 'börek', 'pizza', 'burger', 'kebap', 'döner', 'pide', 'lahmacun', 'balık', 'fish', 'et', 'meat', 'tavuk', 'chicken', 'sebze', 'vegetable', 'meyve', 'fruit', 'süt', 'milk', 'peynir', 'cheese', 'yoğurt', 'yogurt', 'dondurma', 'şeker', 'sugar', 'bal', 'reçel', 'jam', 'konserve', 'canned', 'organic', 'organik', 'doğal', 'natural',
    've', 'ile', 'için', 'bir', 'bu', 'da', 'de', 'ki', 'mi', 'mı', 'mu', 'mü', 'sadece', 'tek', 'en', 'çok', 'az', 'üst', 'alt', 'eski', 'insaat', 'in', 'to', 'the', 'of', 'for', 'and', 'at', 'on', 'by', 'with', 'a', 'an',
    'com', 'comtr', 'www', 'io'
];

function removeTurkishSuffixes(word: string) {
    if (!word) return '';
    if (word.endsWith('ler') || word.endsWith('lar')) return word.substring(0, word.length - 3);
    if (word.endsWith('si') || word.endsWith('sı') || word.endsWith('sü') || word.endsWith('su')) return word.substring(0, word.length - 2);
    if (word.length > 2 && ['i', 'ı', 'u', 'ü'].includes(word[word.length - 1])) return word.substring(0, word.length - 1);
    return word;
}

function cleanMarkName(name: string, removeGenericWords = true) {
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
        cleaned = cleaned.split(' ').filter(word => {
            const stemmedWord = removeTurkishSuffixes(word);
            return !GENERIC_WORDS.includes(stemmedWord) && !GENERIC_WORDS.includes(word);
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
    if (bestWordPairScore >= 0.75) {
        phase2Final = Math.max(phase2Final, bestWordPairScore);
    } else if (bestWordPairScore > fullStringScore) {
        phase2Final = fullStringScore + ((bestWordPairScore - fullStringScore) * 0.5);
    }
    
    // 🔥 YENİ: ANAGRAM (HARF KARIŞTIRMA) ALGORİTMASI 🔥
    // Boşlukları silip, harfleri alfabetik sıraya diziyoruz
    const s1Sorted = s1.replace(/\s+/g, '').split('').sort().join('');
    const s2Sorted = s2.replace(/\s+/g, '').split('').sort().join('');
    const anagramScoreRaw = computeCoreScore(s1Sorted, s2Sorted);
    
    // Birebir harfler tutsa bile sıraları bozuk olduğu için %20 ceza kesiyoruz.
    const anagramScore = anagramScoreRaw * 0.80; 

    // Anagram skoru bizim normal skorumuzdan yüksekse, onu geçerli kılıyoruz.
    phase2Final = Math.max(phase2Final, substringBonus, anagramScore);

    // TÜRKÇE FONETİK BONUSU DEVREDE
    const phonRaw = isPhoneticallySimilar(searchMarkNameOriginal, hitMarkNameOriginal);

    let finalScore = (phase2Final * 0.95) + (phonRaw * 0.05);
    finalScore = Math.max(0.0, Math.min(1.0, finalScore));

    return { finalScore, positionalExactMatchScore }; 
}

async function markWorkerStatus(supabase: any, jobId: string, workerId: string | number, status: 'completed' | 'failed') {
    await supabase.from('search_progress_workers').update({ status }).eq('id', `${jobId}_w${workerId}`);
    
    const { data: activeWorkers } = await supabase.from('search_progress_workers').select('id').eq('job_id', jobId).eq('status', 'processing');
    if (!activeWorkers || activeWorkers.length === 0) {
        console.log(`[Job ${jobId}] 🎉 TÜM İŞÇİLER (${status}) İŞLEMİ BİTİRDİ. Ana Job 'completed' yapılıyor.`);
        await supabase.from('search_progress').update({ status: 'completed' }).eq('id', jobId);
    }
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);
        const body = await req.json();

        if (body.action === 'worker') {
            const { jobId, workerId, monitoredMarks, selectedBulletinId, lastId, processedCount, totalBulletinRecords } = body;
            
            try {
                const BATCH_SIZE = 150; 
                const rawBulletinNumber = String(selectedBulletinId).split('_')[0]; 
                
                console.log(`[Worker ${workerId}] 🚀 BAŞLADI | Hedef: ${rawBulletinNumber} | Marka: ${monitoredMarks.length} | Başlangıç Offset: ${lastId}`);

                const preparedMarks = monitoredMarks.map((mark: any) => {
                    const validSearchMarkName = mark.searchMarkName && String(mark.searchMarkName).trim() !== "" && String(mark.searchMarkName) !== "undefined" && String(mark.searchMarkName) !== "null";
                    const primaryName = validSearchMarkName 
                        ? String(mark.searchMarkName).trim() 
                        : (mark.markName || mark.title || mark.trademarkName || 'İsimsiz Marka').trim();
                    
                    const rawBrandText = mark.brandTextSearch || mark.brand_text_search;
                    let alternatives = Array.isArray(rawBrandText) ? [...rawBrandText] : [];
                    
                    if (validSearchMarkName && mark.markName) {
                        const exactMarkName = String(mark.markName).trim().toLowerCase();
                        alternatives = alternatives.filter(alt => String(alt).trim().toLowerCase() !== exactMarkName);
                    }

                    const conceptualName = convertNumbersAndSymbolsToText(primaryName);
                    if (conceptualName !== primaryName) {
                        alternatives.push(conceptualName);
                    }

                    const primaryCleaned = cleanMarkName(primaryName, true);
                    const words = primaryCleaned.split(' ').filter(w => w.trim().length > 0);
                    if (words.length > 1) {
                        const sortedName = [...words].sort().join(' ');
                        if (sortedName !== primaryCleaned) {
                            alternatives.push(sortedName);
                        }
                    }

                    const searchTerms = [primaryName, ...alternatives]
                        .filter(t => t && String(t).trim().length > 0 && String(t) !== "undefined")
                        .map(term => {
                            const termStr = String(term);
                            const isMultiWord = termStr.trim().split(/\s+/).length > 1;
                            return { term: termStr, cleanedSearchName: cleanMarkName(termStr, isMultiWord) };
                        });
                    
                    const makeArray = (val: any) => {
                        if (!val) return [];
                        if (Array.isArray(val)) return val.map(String);
                        if (typeof val === 'string') return val.split(/[^\d]+/);
                        return [String(val)];
                    };

                    const originalClassesRaw = mark.goodsAndServicesByClass ? makeArray(mark.goodsAndServicesByClass.map((c:any)=>c.classNo||c)) : makeArray(mark.niceClasses || mark.nice_classes);
                    const watchedClassesRaw = makeArray(mark.niceClassSearch || mark.nice_class_search);

                    const cleanClass = (c: any) => {
                        const num = parseInt(String(c).replace(/\D/g, ''), 10);
                        return isNaN(num) ? '' : num.toString();
                    };

                    const greenSet = new Set(originalClassesRaw.map(cleanClass).filter(Boolean));
                    const orangeSet = new Set(watchedClassesRaw.map(cleanClass).filter(Boolean)); 
                    const blueSet = new Set<string>();

                    greenSet.forEach(c => { if (RELATED_CLASSES_MAP[c]) RELATED_CLASSES_MAP[c].forEach(rel => blueSet.add(rel)); });
                    
                    const bypassClassFilter = greenSet.size === 0 && orangeSet.size === 0;

                    const appDateRaw = mark.applicationDate || mark.application_date || null;
                    const parsedAppDate = parseDateForValidation(appDateRaw);

                    return { ...mark, primaryName, searchTerms, applicationDate: appDateRaw, parsedAppDate, greenSet, orangeSet, blueSet, bypassClassFilter };
                });

                // 🔥 YENİ: lastId artık metin değil, bir sayısal indeks (offset) olarak kullanılıyor
                let currentOffset = parseInt(lastId, 10) || 0;
                let actualProcessedCount = 0;
                const uiResults = [];
                const permanentRecords = []; 

                // 🔥 YENİ: Veri tabanından çekerken .gt() yerine .range() kullanılıyor
                const { data: hits, error } = await supabase
                    .from('trademark_bulletin_records')
                    .select('id, application_number, application_date, brand_name, nice_classes, holders, image_url')
                    .in('bulletin_id', [rawBulletinNumber, `bulletin_main_${rawBulletinNumber}`]) 
                    .order('id')
                    .range(currentOffset, currentOffset + BATCH_SIZE - 1);

                if (error) throw error;

                const hasMoreRecords = hits && hits.length === BATCH_SIZE;

                if (hits && hits.length > 0) {
                    for (let i = 0; i < hits.length; i++) {
                        actualProcessedCount++;
                        const hit = hits[i];
                        
                        const parsedHitDate = parseDateForValidation(hit.application_date);
                        
                        let rawHitClasses: string[] = [];
                        if (Array.isArray(hit.nice_classes)) rawHitClasses = hit.nice_classes.map(String);
                        else if (typeof hit.nice_classes === 'string') rawHitClasses = hit.nice_classes.split(/[^\d]+/);
                        else if (hit.nice_classes) rawHitClasses = [String(hit.nice_classes)];
                        
                        const cleanClass = (c: any) => {
                            const num = parseInt(String(c).replace(/\D/g, ''), 10);
                            return isNaN(num) ? '' : num.toString();
                        };
                        
                        const hitClasses = rawHitClasses.map(cleanClass).filter(Boolean);
                        
                        const rawHitName = String(hit.brand_name || '');
                        
                        const isHitMultiWord = rawHitName.replace(/[^a-zA-Z0-9ğüşöçı]/g, ' ').trim().split(/\s+/).length > 1;
                        let cleanedHitName = cleanMarkName(rawHitName, isHitMultiWord); 
                        
                        if (isHitMultiWord) {
                            cleanedHitName = cleanedHitName.split(' ').sort().join(' ');
                        }

                        for (const mark of preparedMarks) {
                            let isValidDate = true;
                            if (parsedHitDate && mark.parsedAppDate && !isNaN(parsedHitDate.getTime()) && !isNaN(mark.parsedAppDate.getTime())) {
                                isValidDate = parsedHitDate >= mark.parsedAppDate;
                            }
                            if (!isValidDate) continue;

                            let hasPoolMatch = mark.bypassClassFilter; 

                            hitClasses.forEach((hc: string) => {
                                if (mark.greenSet.has(hc)) { hasPoolMatch = true; }
                                else if (mark.orangeSet.has(hc)) { hasPoolMatch = true; }
                                else if (mark.blueSet.has(hc)) { hasPoolMatch = true; }
                            });

                            for (const searchItem of mark.searchTerms) {
                                let isExactPrefixSuffix = searchItem.cleanedSearchName.length >= 3 && cleanedHitName.includes(searchItem.cleanedSearchName);

                                if (!hasPoolMatch && !isExactPrefixSuffix) continue;

                                const { finalScore, positionalExactMatchScore } = calculateSimilarityScoreInternal(
                                    searchItem.term, rawHitName, searchItem.cleanedSearchName, cleanedHitName
                                );

                                if (finalScore < 0.5 && positionalExactMatchScore < 0.5 && !isExactPrefixSuffix) continue;

                                uiResults.push({
                                    job_id: jobId, 
                                    monitored_trademark_id: mark.id, 
                                    mark_name: hit.brand_name,
                                    application_no: hit.application_number, 
                                    nice_classes: Array.isArray(hit.nice_classes) ? hit.nice_classes.join(', ') : String(hit.nice_classes || ''), 
                                    similarity_score: finalScore,
                                    holders: typeof hit.holders === 'string' ? hit.holders : JSON.stringify(hit.holders), 
                                    image_path: hit.image_url
                                });

                                permanentRecords.push({
                                    id: `${mark.id}_${hit.id}`, 
                                    monitored_trademark_id: mark.id,
                                    bulletin_record_id: hit.id,
                                    similarity_score: finalScore,
                                    is_earlier: false, 
                                    matched_term: searchItem.term, 
                                    source: 'auto',
                                    is_similar: false
                                });
                                break;
                            }
                        }
                    }
                } 

                if (actualProcessedCount === 0 && !hasMoreRecords) {
                    await markWorkerStatus(supabase, jobId, workerId, 'completed');
                    return new Response(JSON.stringify({ success: true, finished: true }), { headers: corsHeaders });
                }

                if (uiResults.length > 0) {
                    const CHUNK_SIZE = 1000;
                    for (let i = 0; i < uiResults.length; i += CHUNK_SIZE) {
                        await supabase.from('search_progress_results').insert(uiResults.slice(i, i + CHUNK_SIZE));
                    }
                    for (let i = 0; i < permanentRecords.length; i += CHUNK_SIZE) {
                        await supabase.from('monitoring_trademark_records').upsert(permanentRecords.slice(i, i + CHUNK_SIZE), { onConflict: 'id' });
                    }
                    const { data: jobData } = await supabase.from('search_progress').select('current_results').eq('id', jobId).single();
                    await supabase.from('search_progress').update({ current_results: (jobData?.current_results || 0) + uiResults.length }).eq('id', jobId);
                }

                const newProcessedCount = processedCount + actualProcessedCount;
                const progressPercent = Math.min(100, Math.floor((newProcessedCount / totalBulletinRecords) * 100));
                await supabase.from('search_progress_workers').upsert({ id: `${jobId}_w${workerId}`, job_id: jobId, status: 'processing', progress: progressPercent });

                // 🔥 YENİ: Bir sonraki işlem bloğu için indexi BATCH_SIZE kadar ileri kaydırıyoruz
                const nextOffset = currentOffset + BATCH_SIZE;

                if (hasMoreRecords) {
                    EdgeRuntime.waitUntil(
                        supabase.functions.invoke('perform-trademark-similarity-search', {
                            body: { action: 'worker', jobId, workerId, monitoredMarks, selectedBulletinId, lastId: nextOffset.toString(), processedCount: newProcessedCount, totalBulletinRecords },
                            headers: { Authorization: `Bearer ${supabaseKey}` }
                        }).then(async (res) => {
                            if (res.error) await markWorkerStatus(supabase, jobId, workerId, 'failed');
                        }).catch(async (err) => {
                            await markWorkerStatus(supabase, jobId, workerId, 'failed');
                        })
                    );
                } else {
                    await markWorkerStatus(supabase, jobId, workerId, 'completed');
                }

                return new Response(JSON.stringify({ success: true, workerId }), { headers: corsHeaders });

            } catch (workerErr) {
                await markWorkerStatus(supabase, jobId, workerId, 'failed');
                return new Response(JSON.stringify({ success: false, error: workerErr.message }), { headers: corsHeaders, status: 500 });
            }
        }

        const { monitoredMarks, selectedBulletinId } = body;
        if (!monitoredMarks || !selectedBulletinId) throw new Error("Eksik parametre.");

        const jobId = `job_${Date.now()}`;
        const rawBulletinNumber = String(selectedBulletinId).split('_')[0];

        const { count, error: countError } = await supabase
            .from('trademark_bulletin_records')
            .select('*', { count: 'exact', head: true })
            .in('bulletin_id', [rawBulletinNumber, `bulletin_main_${rawBulletinNumber}`]);
        
        if (countError) throw countError;

        const totalRecords = count || 1;
        await supabase.from('search_progress').insert({ id: jobId, status: 'processing', current_results: 0, total_records: totalRecords });
        
        const WORKER_COUNT = Math.min(10, monitoredMarks.length);
        const chunkSize = Math.ceil(monitoredMarks.length / WORKER_COUNT);
        
        const workerRecords = [];
        const activeChunks = [];
        
        let activeWorkerId = 1;
        for (let i = 0; i < WORKER_COUNT; i++) {
            const chunk = monitoredMarks.slice(i * chunkSize, (i + 1) * chunkSize);
            if (chunk.length === 0) continue;
            
            workerRecords.push({ id: `${jobId}_w${activeWorkerId}`, job_id: jobId, status: 'processing', progress: 0 });
            activeChunks.push({ workerId: activeWorkerId, chunk });
            activeWorkerId++;
        }

        if (workerRecords.length > 0) {
            await supabase.from('search_progress_workers').insert(workerRecords);
        }

        for (const item of activeChunks) {
            EdgeRuntime.waitUntil(
                supabase.functions.invoke('perform-trademark-similarity-search', {
                    // 🔥 DÜZELTME: İlk çağrıda '0' stringini gönderiyoruz ki parseInt('0') -> 0 (offset başlangıcı) olsun
                    body: { action: 'worker', jobId, workerId: item.workerId, monitoredMarks: item.chunk, selectedBulletinId, lastId: '0', processedCount: 0, totalBulletinRecords: totalRecords },
                    headers: { Authorization: `Bearer ${supabaseKey}` }
                }).catch(async (err) => {
                    await markWorkerStatus(supabase, jobId, item.workerId, 'failed');
                })
            );
        }

        return new Response(JSON.stringify({ success: true, jobId }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});