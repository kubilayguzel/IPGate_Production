// public/js/services/filename-parser.js

export class FilenameParser {
    constructor() {
        // Regex desenleri buraya tanımlanır, yönetimi kolaylaşır
        this.patterns = [
            /(\d{4}[-\/\s]\d+)/g,          // 2025-1, 2025/1, 2025 1
            /TR(\d{4}[-\/]\d+)/gi,         // TR2025-1, TR2025/1
            /(\d{6,})/g                    // 250369056 (6+ rakam)
        ];
    }

    /**
     * Dosya adından başvuru numarasını çeker.
     * @param {string} fileName 
     * @returns {string|null} Bulunan numara veya null
     */
    extractApplicationNumber(fileName) {
        if (!fileName) return null;

        const extractedNumbers = [];
        
        this.patterns.forEach(pattern => {
            const matches = fileName.match(pattern);
            if (matches) {
                matches.forEach(match => {
                    // TR, EP gibi prefixleri ve gereksiz karakterleri temizle
                    let cleaned = match.replace(/^(TR|EP|WO)/i, '').trim();
                    extractedNumbers.push(cleaned);
                });
            }
        });

        // En olası numarayı (ilk bulunanı) döndür.
        // İleride burada daha akıllı bir seçim mantığı (örn: en uzun olanı al) kurabiliriz.
        return extractedNumbers.length > 0 ? extractedNumbers[0] : null;
    }
}