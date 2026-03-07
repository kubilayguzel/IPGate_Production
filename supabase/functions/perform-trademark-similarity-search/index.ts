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
    let cleaned = String(name).toLowerCase().replace(/[^a-z0-9ğüşöçı\s]/g, '').replace(/\s+/g, ' ').trim();
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
    return str.toLowerCase().replace(/[^a-z0-9ğüşöçı]/g, '').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/ı/g, 'i');
}

const visualMap: Record<string, string[]> = {
    "a": ["e", "o"], "b": ["d", "p"], "c": ["ç", "s"], "ç": ["c", "s"], "d": ["b", "p"], "e": ["a", "o"], "f": ["t"],
    "g": ["ğ", "q"], "ğ": ["g", "q"], "h": ["n"], "i": ["l", "j", "ı"], "ı": ["i"], "j": ["i", "y"], "k": ["q", "x"],
    "l": ["i", "1"], "m": ["n"], "n": ["m", "r"], "o": ["a", "0", "ö"], "ö": ["o"], "p": ["b", "q"], "q": ["g", "k"],
    "r": ["n"], "s": ["ş", "c", "z"], "ş": ["s", "z"], "t": ["f"], "u": ["ü", "v"], "ü": ["u", "v"], "v": ["u", "ü", "w"],
    "w": ["v"], "x": ["ks"], "y": ["j"], "z": ["s", "ş"], "0": ["o"], "1": ["l", "i"], "ks": ["x"], "Q": ["O","0"],
    "O": ["Q", "0"], "I": ["l", "1"], "L": ["I", "1"], "Z": ["2"], "S": ["5"], "B": ["8"], "D": ["O"]
};

function visualMismatchPenalty(a: string, b: string) {
    if (!a || !b) return 5; 
    const lenDiff = Math.abs(a.length - b.length);
    const minLen = Math.min(a.length, b.length);
    let penalty = lenDiff * 0.5;
    for (let i = 0; i < minLen; i++) {
        const ca = a[i].toLowerCase();
        const cb = b[i].toLowerCase();
        if (ca !== cb) {
            if (visualMap[ca] && visualMap[ca].includes(cb)) penalty += 0.25;
            else penalty += 1.0;
        }
    }
    return penalty;
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

function isValidBasedOnDate(hitDate: any, monitoredDate: any) {
    if (!hitDate || !monitoredDate) return true;
    const hit = parseDateForValidation(hitDate);
    const mon = parseDateForValidation(monitoredDate);
    if (!hit || !mon || isNaN(hit.getTime()) || isNaN(mon.getTime())) return true;
    return hit >= mon;
}

const v0 = new Int32Array(512);
const v1 = new Int32Array(512);

function levenshteinSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    const lenA = a.length, lenB = b.length;
    if (lenA === 0 || lenB === 0) return 0.0;
    if (lenB >= 512) return 0.0; 
    for (let i = 0; i <= lenB; i++) v0[i] = i;
    for (let i = 0; i < lenA; i++) {
        v1[0] = i + 1;
        for (let j = 0; j < lenB; j++) {
            const cost = a[i] === b[j] ? 0 : 1;
            v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
        }
        for (let j = 0; j <= lenB; j++) v0[j] = v1[j];
    }
    return 1 - (v1[lenB] / Math.max(lenA, lenB));
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

    const levenshteinScore = levenshteinSimilarity(s1, s2);
    
    const jaroWinklerScore = (() => {
        let m = 0; const s1_len = s1.length, s2_len = s2.length;
        const range = Math.floor(Math.max(s1_len, s2_len) / 2) - 1;
        const s1_matches = new Array(s1_len).fill(false), s2_matches = new Array(s2_len).fill(false);
        for (let i = 0; i < s1_len; i++) {
            for (let j = Math.max(0, i - range); j < Math.min(s2_len, i + range + 1); j++) {
                if (s1[i] === s2[j] && !s2_matches[j]) { s1_matches[i] = true; s2_matches[j] = true; m++; break; }
            }
        }
        if (m === 0) return 0.0;
        let k = 0, t = 0;
        for (let i = 0; i < s1_len; i++) {
            if (s1_matches[i]) {
                let j; for (j = k; j < s2_len; j++) { if (s2_matches[j]) { k = j + 1; break; } }
                if (s1[i] !== s2[j]) t++;
            }
        }
        t /= 2;
        const jaro_score = (m / s1_len + m / s2_len + (m - t) / m) / 3;
        let l = 0;
        for (let i = 0; i < Math.min(s1_len, s2_len, 4); i++) { if (s1[i] === s2[i]) l++; else break; }
        return jaro_score + l * 0.1 * (1 - jaro_score);
    })();

    const ngramScore = (() => {
        const getNGrams = (s: string) => { const n = new Set<string>(); for (let i = 0; i <= s.length - 2; i++) n.add(s.substring(i, i + 2)); return n; };
        const ng1 = getNGrams(s1), ng2 = getNGrams(s2);
        if (ng1.size === 0 && ng2.size === 0) return 1.0;
        if (ng1.size === 0 || ng2.size === 0) return 0.0;
        let common = 0; ng1.forEach(ng => { if (ng2.has(ng)) common++; });
        return common / Math.min(ng1.size, ng2.size);
    })();

    const prefixScore = (() => {
        const p1 = s1.substring(0, Math.min(s1.length, 3)), p2 = s2.substring(0, Math.min(s2.length, 3));
        if (p1 === p2) return 1.0; if (p1.length === 0 && p2.length === 0) return 1.0;
        return levenshteinSimilarity(p1, p2);
    })();

    const visualScore = (() => {
        const penalty = visualMismatchPenalty(s1, s2);
        const maxP = Math.max(s1.length, s2.length) * 1.0;
        return maxP === 0 ? 1.0 : (1.0 - (penalty / maxP));
    })();

    const { maxWordScore, maxWordPair } = (() => {
        const w1 = s1.split(' ').filter(w => w.length > 0), w2 = s2.split(' ').filter(w => w.length > 0);
        if (w1.length === 0 && w2.length === 0) return { maxWordScore: 1.0, maxWordPair: null };
        if (w1.length === 0 || w2.length === 0) return { maxWordScore: 0.0, maxWordPair: null };
        let maxSim = 0.0; let pair: [string, string] | null = null;
        for (const a of w1) {
            for (const b of w2) {
                const sim = levenshteinSimilarity(a, b);
                if (sim > maxSim) { maxSim = sim; pair = [a, b]; }
            }
        }
        return { maxWordScore: maxSim, maxWordPair: pair };
    })();

    const positionalExactMatchScore = (() => {
        const len = Math.min(s1.length, s2.length, 3);
        if (len === 0) return 0.0;
        for (let i = 0; i < len; i++) if (s1[i] !== s2[i]) return 0.0;
        return 1.0;
    })();

    const exactWordLen = (maxWordPair && maxWordPair[0] === maxWordPair[1]) ? maxWordPair[0].length : 0;
    if (maxWordScore >= 0.70) {
        if (maxWordScore === 1.0 && exactWordLen < 2) { } 
        else { return { finalScore: maxWordScore, positionalExactMatchScore }; }
    }

    const nameSimRaw = (levenshteinScore * 0.30 + jaroWinklerScore * 0.25 + ngramScore * 0.15 + visualScore * 0.15 + prefixScore * 0.10 + maxWordScore * 0.05);
    const phonRaw = isPhoneticallySimilar(searchMarkNameOriginal, hitMarkNameOriginal);

    let finalScore = (nameSimRaw * 0.95) + (phonRaw * 0.05);
    finalScore = Math.max(0.0, Math.min(1.0, finalScore));

    return { finalScore, positionalExactMatchScore }; 
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
            const BATCH_SIZE = Math.max(25, Math.min(250, Math.floor(50000 / (monitoredMarks.length || 1))));

            // 🔥 ÇÖZÜM: '484_20260112' gibi gelen ID'yi 'bulletin_main_484' yapıyoruz.
            const realBulletinId = `bulletin_main_${selectedBulletinId.split('_')[0]}`;
            
            console.log(`[Worker ${workerId}] İşlem başlatıldı. Hedef bülten: ${realBulletinId}, Başlangıç ID: ${lastId}`);

            const preparedMarks = monitoredMarks.map((mark: any) => {
                const rawName = mark.searchMarkName || mark.markName || mark.title || mark.trademarkName;
                const primaryName = (rawName && rawName !== "undefined" && rawName !== "null") ? String(rawName).trim() : 'İsimsiz Marka';
                
                const alternatives = Array.isArray(mark.brandTextSearch) ? mark.brandTextSearch : [];
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

                const originalClassesRaw = mark.goodsAndServicesByClass ? makeArray(mark.goodsAndServicesByClass.map((c:any)=>c.classNo||c)) : makeArray(mark.niceClasses);
                const watchedClassesRaw = makeArray(mark.niceClassSearch);

                const cleanClass = (c: any) => {
                    const num = parseInt(String(c).replace(/\D/g, ''), 10);
                    return isNaN(num) ? '' : num.toString();
                };

                const greenSet = new Set(originalClassesRaw.map(cleanClass).filter(Boolean));
                const orangeSet = new Set(watchedClassesRaw.map(cleanClass).filter(Boolean));
                const blueSet = new Set<string>();

                greenSet.forEach(c => { if (RELATED_CLASSES_MAP[c]) RELATED_CLASSES_MAP[c].forEach(rel => blueSet.add(rel)); });
                const bypassClassFilter = greenSet.size === 0 && orangeSet.size === 0;

                const appDate = mark.applicationDate || mark.application_date || null;

                return { ...mark, primaryName, searchTerms, applicationDate: appDate, greenSet, orangeSet, blueSet, bypassClassFilter };
            });

            // 🔥 Yeni bulletin_id kullanarak DB'den çek
            const { data: hits, error } = await supabase
                .from('trademark_bulletin_records')
                .select('id, application_number, application_date, brand_name, nice_classes, holders, image_url')
                .eq('bulletin_id', realBulletinId)
                .order('id')
                .gt('id', lastId)
                .limit(BATCH_SIZE);

            if (error) {
                console.error(`[Worker ${workerId}] Supabase Çekim Hatası:`, error);
                throw error;
            }

            console.log(`[Worker ${workerId}] ${hits?.length || 0} adet marka getirildi.`);

            if (!hits || hits.length === 0) {
                console.log(`[Worker ${workerId}] Getirilecek kayıt kalmadı, worker kapanıyor.`);
                await supabase.from('search_progress_workers').update({ status: 'completed' }).eq('id', `${jobId}_w${workerId}`);
                
                const { data: activeWorkers } = await supabase.from('search_progress_workers').select('id').eq('job_id', jobId).eq('status', 'processing');
                if (!activeWorkers || activeWorkers.length === 0) {
                    console.log(`[Worker ${workerId}] Tüm workerlar tamamlandı. Ana job 'completed' yapılıyor.`);
                    await supabase.from('search_progress').update({ status: 'completed' }).eq('id', jobId);
                }
                return new Response(JSON.stringify({ success: true, finished: true }), { headers: corsHeaders });
            }

            let newLastId = hits[hits.length - 1].id;
            let actualProcessedCount = 0;
            const uiResults = [];
            const permanentRecords = []; 

            const startTime = Date.now();
            const CPU_TIME_LIMIT = 1500; 

            for (let i = 0; i < hits.length; i++) {
                if (Date.now() - startTime > CPU_TIME_LIMIT) {
                    newLastId = i > 0 ? hits[i - 1].id : hits[0].id; 
                    console.log(`[Worker ${workerId}] CPU limiti aşıldı, işlem ${newLastId} id'sinde duraklatıldı.`);
                    break;
                }

                actualProcessedCount++;
                const hit = hits[i];
                
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
                const rawCleanedHitName = rawHitName.toLowerCase().replace(/[^a-z0-9ğüşöçı\s]/g, '').replace(/\s+/g, ' ').trim();
                const isHitMultiWord = rawHitName.trim().split(/\s+/).length > 1;
                const cleanedHitName = cleanMarkName(rawHitName, isHitMultiWord); 

                for (const mark of preparedMarks) {
                    const isValidDate = isValidBasedOnDate(hit.application_date, mark.applicationDate);
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

                        // 🔥 YENİ DB: Kalıcı Kayıt Tablosuna Sadece İlişkisel ID Atılıyor
                        permanentRecords.push({
                            id: `${mark.id}_${hit.id}`, // 🔥 ÇÖZÜM: Zorunlu ID alanını biz oluşturuyoruz (Benzersiz)
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

            if (uiResults.length > 0) {
                console.log(`[Worker ${workerId}] ${uiResults.length} adet benzer sonuç bulundu ve DB'ye yazılıyor...`);
                
                // UI Sonuçlarını Yaz
                await supabase.from('search_progress_results').insert(uiResults);
                
                // 🔥 ÇÖZÜM: Kalıcı sonuçları yaz ve hata varsa logla
                const { error: permError } = await supabase.from('monitoring_trademark_records').upsert(permanentRecords, { onConflict: 'id' });
                if (permError) {
                    console.error(`[Worker ${workerId}] Kalıcı DB Kayıt Hatası:`, permError);
                }
                
                const { data: jobData } = await supabase.from('search_progress').select('current_results').eq('id', jobId).single();
                await supabase.from('search_progress').update({ current_results: (jobData?.current_results || 0) + uiResults.length }).eq('id', jobId);
            }

            const newProcessedCount = processedCount + actualProcessedCount;
            const progressPercent = Math.min(100, Math.floor((newProcessedCount / totalBulletinRecords) * 100));
            await supabase.from('search_progress_workers').upsert({ id: `${jobId}_w${workerId}`, job_id: jobId, status: 'processing', progress: progressPercent });

            console.log(`[Worker ${workerId}] %${progressPercent} tamamlandı. Sonraki adıma geçiliyor.`);

            EdgeRuntime.waitUntil(
                supabase.functions.invoke('perform-trademark-similarity-search', {
                    body: { action: 'worker', jobId, workerId, monitoredMarks, selectedBulletinId, lastId: newLastId, processedCount: newProcessedCount, totalBulletinRecords },
                    headers: { Authorization: `Bearer ${supabaseKey}` }
                })
            );

            return new Response(JSON.stringify({ success: true, workerId }), { headers: corsHeaders });
        }

        // =========================================================================
        // BAŞLANGIÇ MODU
        // =========================================================================
        const { monitoredMarks, selectedBulletinId } = body;
        if (!monitoredMarks || !selectedBulletinId) throw new Error("Eksik parametre.");

        const jobId = `job_${Date.now()}`;
        
        // 🔥 ÇÖZÜM: İlk sayımda da ID'yi düzeltiyoruz
        const realBulletinId = `bulletin_main_${selectedBulletinId.split('_')[0]}`;
        console.log(`[Main Job] Başlatılıyor... Job ID: ${jobId}, Hedef Bülten: ${realBulletinId}`);

        const { count, error: countError } = await supabase.from('trademark_bulletin_records').select('*', { count: 'exact', head: true }).eq('bulletin_id', realBulletinId);
        
        if (countError) {
            console.error(`[Main Job] Kayıt sayısı çekilirken hata:`, countError);
            throw countError;
        }

        const totalRecords = count || 1;
        console.log(`[Main Job] Toplam aranacak marka sayısı: ${totalRecords}`);

        await supabase.from('search_progress').insert({ id: jobId, status: 'processing', current_results: 0, total_records: totalRecords });
        
        const WORKER_COUNT = 10;
        const chunkSize = Math.ceil(monitoredMarks.length / WORKER_COUNT);
        
        const workerRecords = [];
        for (let i = 0; i < WORKER_COUNT; i++) {
            const chunk = monitoredMarks.slice(i * chunkSize, (i + 1) * chunkSize);
            if (chunk.length === 0) continue;
            
            const workerId = i + 1;
            workerRecords.push({ id: `${jobId}_w${workerId}`, job_id: jobId, status: 'processing', progress: 0 });

            EdgeRuntime.waitUntil(
                supabase.functions.invoke('perform-trademark-similarity-search', {
                    body: { action: 'worker', jobId, workerId, monitoredMarks: chunk, selectedBulletinId, lastId: '0', processedCount: 0, totalBulletinRecords: totalRecords },
                    headers: { Authorization: `Bearer ${supabaseKey}` }
                })
            );
        }

        await supabase.from('search_progress_workers').insert(workerRecords);

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