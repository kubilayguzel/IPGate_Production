// js/trademark-similarity/preprocess.js

export const GENERIC_WORDS = [
    // ======== ŞİRKET TİPLERİ ========
    'ltd', 'şti', 'aş', 'anonim', 'şirketi', 'şirket', 'limited', 'inc', 'corp', 'corporation', 'co', 'company', 'llc', 'group', 'grup',

    // ======== TİCARİ SEKTÖRLER ========
    'sanayi', 'ticaret', 'turizm', 'tekstil', 'gıda', 'inşaat', 'danışmanlık', 'hizmet', 'hizmetleri', 'bilişim', 'teknoloji', 'sigorta', 'yayıncılık', 'mobilya', 'otomotiv', 'tarım', 'enerji', 'petrol', 'kimya', 'kozmetik', 'ilaç', 'medikal', 'sağlık', 'eğitim', 'spor', 'müzik', 'film', 'medya', 'reklam', 'pazarlama', 'lojistik', 'nakliyat', 'kargo', 'finans', 'bankacılık', 'emlak', 'gayrimenkul', 'madencilik', 'metal', 'plastik', 'cam', 'seramik', 'ahşap',

    // ======== MESLEKİ TERİMLER ========
    'mühendislik', 'proje', 'taahhüt', 'ithalat', 'ihracat', 'üretim', 'imalat', 'veteriner', 'petshop', 'polikliniği', 'hastane', 'klinik', 'müşavirlik', 'muhasebe', 'hukuk', 'avukatlık', 'mimarlık', 'peyzaj', 'tasarım', 'dizayn', 'design', 'grafik', 'web', 'yazılım', 'software', 'donanım', 'hardware', 'elektronik', 'elektrik', 'makina', 'makine', 'endüstri', 'fabrika', 'laboratuvar', 'araştırma', 'geliştirme', 'ofis', // 'ofis' eklendi

    // ======== ÜRÜN/HİZMET TERİMLERİ ========
    'ürün', // 'ürün' kökü eklendi (ürünleri, ürünler gibi varyasyonları kapsayacak)
    'products', 'services', 'solutions', 'çözüm', // 'çözümleri' yerine 'çözüm' kökü
    'sistem', 'systems', 'teknolojileri', 'teknoloji', // 'teknolojileri' yanına 'teknoloji'
    'malzeme', 'materials', 'ekipman', 'equipment', 'cihaz', 'device', 'araç', 'tools', 'yedek', 'parça', 'parts', 'aksesuar', 'accessories', 'gereç', 'malzeme',

    // ======== GENEL MARKALAŞMA TERİMLERİ ========
    'meşhur', 'ünlü', 'famous', 'since', 'est', 'established', 'tarihi', 'historical', 'geleneksel', 'traditional', 'klasik', 'classic', 'yeni', 'new', 'fresh', 'taze', 'özel', 'special', 'premium', 'lüks', 'luxury', 'kalite', // 'kalite' eklendi
    'quality', 'uygun', // 'uygun' eklendi

    // ======== LOKASYON TERİMLERİ ========
    'turkey', 'türkiye', 'international', 'uluslararası',

    // ======== EMLAK TERİMLERİ ========
    'realestate', 'emlak', 'konut', 'housing', 'arsa', 'ticari', 'commercial', 'ofis', 'office', 'plaza', 'shopping', 'alışveriş', 'residence', 'rezidans', 'villa', 'apartment', 'daire',

    // ======== DİJİTAL TERİMLERİ ========
    'online', 'digital', 'dijital', 'internet', 'web', 'app', 'mobile', 'mobil', 'network', 'ağ', 'server', 'sunucu', 'hosting', 'domain', 'platform', 'social', 'sosyal', 'media', 'medya',

    // ======== GIDA TERİMLERİ ========
    'gıda', 'food', 'yemek', 'restaurant', 'restoran', 'cafe', 'kahve', 'coffee', 'çay', 'tea', 'fırın', 'bakery', 'ekmek', 'bread', 'pasta', 'börek', 'pizza', 'burger', 'kebap', 'döner', 'pide', 'lahmacun', 'balık', 'fish', 'et', 'meat', 'tavuk', 'chicken', 'sebze', 'vegetable', 'meyve', 'fruit', 'süt', 'milk', 'peynir', 'cheese', 'yoğurt', 'yogurt', 'dondurma', 'şeker', 'sugar', 'bal', 'reçel', 'jam', 'konserve', 'canned', 'organic', 'organik', 'doğal', 'natural', 'taze', 'fresh',

    // ======== BAĞLAÇLAR ve Yaygın Kelimeler ========
    've', // 've' eklendi
    'ile', 'için', 'bir', 'bu', 'da', 'de', 'ki', 'mi', 'mı', 'mu', 'mü', // Yaygın bağlaçlar ve edatlar
    'sadece', 'tek', 'en', 'çok', 'az', 'üst', 'alt', 'yeni', 'eski'
];

/**
 * Kelimelerdeki yaygın Türkçe ekleri kaldırır (çok basit bir stemming).
 * Tüm olası ekleri kapsamaz, ancak yaygın olanları hedefler.
 */
function removeTurkishSuffixes(word) {
    if (!word) return '';
    
    // Çoğul ekleri: -ler, -lar
    if (word.endsWith('ler') || word.endsWith('lar')) {
        return word.substring(0, word.length - 3);
    }
    // İyelik ekleri (basit formlar): -im, -in, -i, -ımız, -ınız, -ları
    // Örneğin, 'ofisi' -> 'ofis'
    if (word.endsWith('si') || word.endsWith('sı') || word.endsWith('sü') || word.endsWith('su')) {
        return word.substring(0, word.length - 2);
    }
    if (word.endsWith('i') || word.endsWith('ı') || word.endsWith('u') || word.endsWith('ü')) {
        // 'gıda' gibi kelimelerde 'ı' son ek olmamalı, bu yüzden dikkatli olmalı
        // Daha güvenli bir kontrol için kelime kökü kontrol edilebilir
        // Şimdilik sadece iyelik ve yönelme eklerini çıkarıyoruz.
        // Basitçe son harfi kaldırmak riskli, ama şimdilik en yaygın olanları ele alalım
        if (word.length > 2 && ['i', 'ı', 'u', 'ü'].includes(word[word.length - 1])) {
             // 'ofis' gibi kelimelerde 'i' iyelik eki olabilir.
             // Daha sofistike bir çözüm için NLP kütüphanesi gerekir, bu basit bir yaklaşımdır.
             return word.substring(0, word.length - 1);
        }
    }
    // Fiilimsiler, durum ekleri vb. için daha karmaşık kurallar gerekebilir
    
    return word;
}

/**
 * Marka adını temizler: küçük harfe çevirir, özel karakterleri kaldırır, stopwords'ü çıkarır.
 *
 * @param {string} name Marka adı
 * @param {boolean} removeGenericWords Stopwords'ün çıkarılıp çıkarılmayacağını belirler.
 * Genellikle çok kelimeli isimler için true olmalı.
 * @returns {string} Temizlenmiş marka adı.
 */
export function cleanMarkName(name, removeGenericWords = true) {
    if (!name) return '';
    let cleaned = name.toLowerCase().replace(/[^a-z0-9ğüşöçı\s]/g, '').trim(); // Harf, rakam ve boşluk dışındaki her şeyi kaldır

    // Birden fazla boşluğu tek boşluğa indirge
    cleaned = cleaned.replace(/\s+/g, ' ');

    if (removeGenericWords) {
        // Kelimelere ayır, eklerini kaldır ve stopwords olmayanları filtrele
        cleaned = cleaned.split(' ').filter(word => {
            const stemmedWord = removeTurkishSuffixes(word);
            // Kök kelime veya orijinal kelime stopwords listesinde mi kontrol et
            return !GENERIC_WORDS.includes(stemmedWord) && !GENERIC_WORDS.includes(word);
        }).join(' ');
    }

    return cleaned.trim();
}