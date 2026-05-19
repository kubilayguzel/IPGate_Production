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
    'turkey', 'türkiye', 'international', 'uluslararası',
    'realestate', 'emlak', 'konut', 'housing', 'arsa', 'ticari', 'commercial', 'office', 'plaza', 'shopping', 'alışveriş', 'residence', 'rezidans', 'villa', 'apartment', 'daire',
    'online', 'digital', 'dijital', 'internet', 'app', 'mobile', 'mobil', 'network', 'ağ', 'server', 'sunucu', 'hosting', 'domain', 'platform', 'social', 'sosyal', 'media', 'medya',
    'yemek', 'restaurant', 'restoran', 'cafe', 'kahve', 'coffee', 'çay', 'tea', 'fırın', 'bakery', 'ekmek', 'bread', 'pasta', 'börek', 'pizza', 'burger', 'kebap', 'döner', 'pide', 'lahmacun', 'balık', 'fish', 'et', 'meat', 'tavuk', 'chicken', 'sebze', 'vegetable', 'meyve', 'fruit', 'süt', 'milk', 'peynir', 'cheese', 'yoğurt', 'yogurt', 'dondurma', 'şeker', 'sugar', 'bal', 'reçel', 'jam', 'konserve', 'canned', 'organic', 'organik', 'doğal', 'natural',
    've', 'ile', 'için', 'bir', 'bu', 'da', 'de', 'ki', 'mi', 'mı', 'mu', 'mü', 'sadece', 'tek', 'en', 'çok', 'az', 'üst', 'alt', 'eski'
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
    
    // 🔥 OPTİMİZASYON: Çoklu harf ve ses kombinasyonlarını standartlaştırma (ia-ya, ie-ye, pf-f eklendi)
    let processed = String(name).toLowerCase()
        .replace(/ch/g, 'ç')
        .replace(/sh/g, 'ş')
        .replace(/x/g, 'ks')
        .replace(/pf/g, 'f')
        .replace(/ia/g, 'ya')
        .replace(/ie/g, 'ye');
        
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
    
    // 🔥 OPTİMİZASYON: Fonetik kıyaslama öncesi dönüşümler (ia-ya, ie-ye, pf-f eklendi)
    return str.toLowerCase()
        .replace(/ch/g, 'ç')
        .replace(/sh/g, 'ş')
        .replace(/x/g, 'ks')
        .replace(/pf/g, 'f')
        .replace(/ia/g, 'ya')
        .replace(/ie/g, 'ye')
        .replace(/[^a-z0-9ğüşöçı]/g, '')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/ı/g, 'i');
}

// 🎯 YENİ GÖRSEL HARİTA (c-s, c-k, d-t, g-k ilişkileri eklendi)
const visualMap: Record<string, string[]> = {
    "b": ["d", "p"], "d": ["b", "p", "t"], "p": ["b", "d"],
    "c": ["ç", "s", "k"], "ç": ["c"], 
    "s": ["ş", "z", "c"], "ş": ["s", "z"], "z": ["s", "ş"],
    "g": ["ğ", "k"], "ğ": ["g"],
    "q": ["k"], "k": ["q", "c", "g"], 
    "i": ["ı", "l", "1", "j"], "ı": ["i", "l", "1"], "l": ["i", "ı", "1"], "1": ["i", "ı", "l"], "j": ["i", "y"], "y": ["j"],
    "m": ["n"], "n": ["m"], 
    "o": ["ö", "0"], "ö": ["o"], "0": ["o", "O"],
    "u": ["ü"], "ü": ["u"],
    "v": ["w"], "w": ["v"], 
    "f": ["t"], "t": ["f", "d"]
};

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

// 🔥 GÖRSEL ZEKAYA VE KONUM BİLİNCİNE SAHİP LEVENSHTEIN 
function levenshteinSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    const lenA = a.length, lenB = b.length;
    if (lenA === 0 || lenB === 0) return 0.0;
    if (lenB >= 512) return 0.0; 

    for (let i = 0; i <= lenB; i++) v0[i] = i;
    
    for (let i = 0; i < lenA; i++) {
        v1[0] = i + 1;
        for (let j = 0; j < lenB; j++) {
            const charA = a[i];
            const charB = b[j];
            
            let cost = 1.0; 
            
            if (charA === charB) {
                cost = 0.0; 
            } else if (
                (visualMap[charA] && visualMap[charA].includes(charB)) || 
                (visualMap[charB] && visualMap[charB].includes(charA))
            ) {
                const isStart = (i === 0 || j === 0);
                const isEnd = (i === lenA - 1 || j === lenB - 1);

                if (isStart) {
                    cost = 0.30; 
                } else if (isEnd) {
                    cost = 0.15; 
                } else {
                    cost = 0.10; 
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

function isPhoneticallySimilar(a: string, b: string) {
    if (!a || !b) return 0.0;
    a = normalizeStringForPhonetic(a); b = normalizeStringForPhonetic(b);
    if (a === b) return 1.0;
    const lenA = a.length, lenB = b.length;
    const minLen = Math.min(lenA, lenB), maxLen = Math.max(lenA, lenB);
    if (maxLen === 0) return 1.0; if (minLen === 0) return 0.0;
    let matchingChars = 0;
    const matchedB = new Array(lenB).fill(false);
    const searchRange = Math.min(maxLen, Math.floor(maxLen / 2) + 1);
    for (let i = 0; i < lenA; i++) {
        for (let j = Math.max(0, i - searchRange); j < Math.min(lenB, i + searchRange + 1); j++) {
            if (a[i] === b[j] && !matchedB[j]) { matchingChars++; matchedB[j] = true; break; }
        }
    }
    if (matchingChars === 0) return 0.0;
    const commonality = matchingChars / Math.max(lenA, lenB);
    let positionalBonus = 0;
    if (a[0] === b[0]) positionalBonus += 0.2;
    if (lenA > 1 && lenB > 1 && a[1] === b[1]) positionalBonus += 0.1;
    return Math.max(0.0, Math.min(1.0, (commonality * 0.7) + (positionalBonus * 0.3)));
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

    // 🌟 1. ALT DİZE (SUBSTRING) BONUSU
    let substringBonus = 0.0;
    if (s1.length >= 3 && s2.length >= 3 && (s2.includes(s1) || s1.includes(s2))) {
        substringBonus = 0.88; 
    }

    // 🌟 2. ÇEKİRDEK SKORLAMA MOTORU
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
            return common / Math.min(ng1.size, ng2.size);
        })();

        const prefix = (() => {
            const p1 = a.substring(0, Math.min(a.length, 3)), p2 = b.substring(0, Math.min(b.length, 3));
            if (p1 === p2) return 1.0; if (p1.length === 0 && p2.length === 0) return 1.0;
            return levenshteinSimilarity(p1, p2);
        })();

        return (lev * 0.50 + jw * 0.25 + ngram * 0.15 + prefix * 0.10);
    };

    // 🌟 3. KELİMELERİ PARÇALAMA VE ERKEN DÖNÜŞ KONTROLÜ
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
    if (earlyReturnScore >= 0.65) {
        if (earlyReturnScore === 1.0 && exactWordLen < 2 && s1 !== s2) { 
            // pas geç
        } else { 
            return { finalScore: earlyReturnScore, positionalExactMatchScore }; 
        }
    }

    // 🌟 4. ASLİ UNSUR (KELİME) VS BÜTÜNSEL CÜMLE KIYASLAMASI
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

    let phase2Final = Math.max(fullStringScore, bestWordPairScore, substringBonus);

    // 🌟 5. FONETİK SKOR VE BİRLEŞTİRME
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

        // =========================================================================
        // İŞÇİ MODU (Zincirleme Tarama - Bayrak Yarışı)
        // =========================================================================
        if (body.action === 'worker') {
            const { jobId, workerId, monitoredMarks, selectedBulletinId, lastId, processedCount, totalBulletinRecords } = body;
            
            try {
                const BATCH_SIZE = 250; 
                const rawBulletinNumber = String(selectedBulletinId).split('_')[0]; 
                
                console.log(`[Worker ${workerId}] 🚀 BAŞLADI | Hedef: ${rawBulletinNumber} | Marka: ${monitoredMarks.length} | Başlangıç ID: ${lastId}`);

                const preparedMarks = monitoredMarks.map((mark: any) => {
                    const validSearchMarkName = mark.searchMarkName && String(mark.searchMarkName).trim() !== "" && String(mark.searchMarkName) !== "undefined" && String(mark.searchMarkName) !== "null";
                    const primaryName = validSearchMarkName 
                        ? String(mark.searchMarkName).trim() 
                        : (mark.markName || mark.title || mark.trademarkName || 'İsimsiz Marka').trim();
                    
                    const rawBrandText = mark.brandTextSearch || mark.brand_text_search;
                    let alternatives = Array.isArray(rawBrandText) ? rawBrandText : [];
                    
                    if (validSearchMarkName && mark.markName) {
                        const exactMarkName = String(mark.markName).trim().toLowerCase();
                        alternatives = alternatives.filter(alt => String(alt).trim().toLowerCase() !== exactMarkName);
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

                let currentLastId = lastId;
                let actualProcessedCount = 0;
                const uiResults = [];
                const permanentRecords = []; 

                const { data: hits, error } = await supabase
                    .from('trademark_bulletin_records')
                    .select('id, application_number, application_date, brand_name, nice_classes, holders, image_url')
                    .in('bulletin_id', [rawBulletinNumber, `bulletin_main_${rawBulletinNumber}`]) 
                    .order('id')
                    .gt('id', currentLastId)
                    .limit(BATCH_SIZE);

                if (error) throw error;

                const hasMoreRecords = hits && hits.length === BATCH_SIZE;

                if (hits && hits.length > 0) {
                    for (let i = 0; i < hits.length; i++) {
                        actualProcessedCount++;
                        const hit = hits[i];
                        currentLastId = hit.id;
                        
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
                        const rawCleanedHitName = rawHitName.toLowerCase().replace(/[^a-z0-9ğüşöçı\s]/g, ' ').replace(/\s+/g, ' ').trim();
                        const cleanedHitName = cleanMarkName(rawHitName, isHitMultiWord); 

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
                                let isExactPrefixSuffix = searchItem.cleanedSearchName.length >= 3 && rawCleanedHitName.includes(searchItem.cleanedSearchName);

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
                    console.log(`[Worker ${workerId}] ✅ GÖREV TAMAMLANDI | Kayıt kalmadı, işçi başarıyla kapanıyor.`);
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

                if (hasMoreRecords) {
                    console.log(`[Worker ${workerId}] 🔄 DEVAM EDİYOR | İşlenen: ${newProcessedCount}/${totalBulletinRecords} (%${progressPercent})`);
                    
                    EdgeRuntime.waitUntil(
                        supabase.functions.invoke('perform-trademark-similarity-search', {
                            body: { action: 'worker', jobId, workerId, monitoredMarks, selectedBulletinId, lastId: currentLastId, processedCount: newProcessedCount, totalBulletinRecords },
                            headers: { Authorization: `Bearer ${supabaseKey}` }
                        }).then(async (res) => {
                            if (res.error) {
                                console.error(`[Worker ${workerId}] 🚨 API Çağrı Hatası:`, res.error);
                                await markWorkerStatus(supabase, jobId, workerId, 'failed');
                            }
                        }).catch(async (err) => {
                            console.error(`[Worker ${workerId}] 🚨 Ağ Hatası:`, err);
                            await markWorkerStatus(supabase, jobId, workerId, 'failed');
                        })
                    );
                } else {
                    console.log(`[Worker ${workerId}] ✅ GÖREV TAMAMLANDI | Tüm bülten tarandı.`);
                    await markWorkerStatus(supabase, jobId, workerId, 'completed');
                }

                return new Response(JSON.stringify({ success: true, workerId }), { headers: corsHeaders });

            } catch (workerErr) {
                console.error(`🚨 [Worker ${workerId}] ÇÖKTÜ:`, workerErr);
                await markWorkerStatus(supabase, jobId, workerId, 'failed');
                return new Response(JSON.stringify({ success: false, error: workerErr.message }), { headers: corsHeaders, status: 500 });
            }
        }

        // =========================================================================
        // BAŞLANGIÇ MODU
        // =========================================================================
        const { monitoredMarks, selectedBulletinId } = body;
        if (!monitoredMarks || !selectedBulletinId) throw new Error("Eksik parametre.");

        const jobId = `job_${Date.now()}`;
        const rawBulletinNumber = String(selectedBulletinId).split('_')[0];
        console.log(`[Main Job] 🟢 ARAMA BAŞLATILDI | Job ID: ${jobId}, Hedef Bülten No: ${rawBulletinNumber}`);

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
                    body: { action: 'worker', jobId, workerId: item.workerId, monitoredMarks: item.chunk, selectedBulletinId, lastId: '0', processedCount: 0, totalBulletinRecords: totalRecords },
                    headers: { Authorization: `Bearer ${supabaseKey}` }
                }).catch(async (err) => {
                    console.error(`[Worker ${item.workerId}] Başlangıç çağrısı başarısız oldu:`, err);
                    await markWorkerStatus(supabase, jobId, item.workerId, 'failed');
                })
            );
        }

        return new Response(JSON.stringify({ success: true, jobId }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error("[General Error] İşlem hatası:", error);
        return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
});