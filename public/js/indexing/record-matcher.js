// public/js/indexing/record-matcher.js

export class RecordMatcher {
    /**
     * Verilen numarayı kayıt listesinde arar.
     */
    findMatch(searchNumber, allRecords) {
        if (!searchNumber || !allRecords || allRecords.length === 0) {
            return null;
        }

        // Arama numarasını "Atomik" hale getir (Sembolleri ve baştaki sıfırları temizle)
        const cleanSearch = this._normalize(searchNumber);
        
        for (const record of allRecords) {
            // 🔥 DÜZELTME: Supabase'den raw (snake_case) veri gelme ihtimaline karşı kalkan eklendi
            const fieldsToCheck = [
                record.applicationNumber,
                record.application_number, // Supabase Native Fallback
                record.applicationNo,
                record.wipoIR,
                record.wipo_ir,            // Supabase Native Fallback
                record.aripoIR,
                record.aripo_ir            // Supabase Native Fallback
            ];

            for (const fieldValue of fieldsToCheck) {
                if (fieldValue && this._checkMatch(cleanSearch, fieldValue)) {
                    return { 
                        record, 
                        matchType: 'standard', 
                        matchedNumber: fieldValue 
                    };
                }
            }
        }
        
        return null;
    }

    /**
     * İki numarayı mantıksal olarak kıyaslar.
     * @private
     */
    _checkMatch(normalizedSearch, originalValue) {
        if (!normalizedSearch || !originalValue) return false;

        const normalizedRecord = this._normalize(originalValue);

        // 1. Tam Eşleşme (Örn: 201799562 === 201799562)
        if (normalizedRecord === normalizedSearch) return true;

        // 2. Kapsama Kontrolü (Minimum 5 karakter güvenlik sınırı ile)
        if (normalizedSearch.length >= 5) {
            if (normalizedRecord.includes(normalizedSearch) || normalizedSearch.includes(normalizedRecord)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Numarayı temizler: Rakam dışı karakterleri ve sayı başındaki sıfırları kaldırır.
     * @private
     */
    _normalize(val) {
        if (!val) return '';
        // Sadece rakamları bırakır, başındaki etkisiz sıfırları temizler
        // "2017/099562" -> "201799562"
        return String(val)
            .replace(/\D/g, '') // Rakam dışı her şeyi sil
            .replace(/^0+/, ''); // Sadece en baştaki sıfırları temizle
    }

    /**
     * UI'da gösterilecek formatı hazırlar
     */
    getDisplayLabel(record) {
        if (!record) return '';
        
        // Güvenlik ağı ile label oluştur
        let displayNum = record.applicationNumber || record.application_number || record.applicationNo || 'Numara Yok';
        let displayOrigin = record.origin || 'Bilinmiyor';

        if (record.wipoIR || record.wipo_ir) {
            displayNum = record.wipoIR || record.wipo_ir;
            displayOrigin = 'WIPO';
        } else if (record.aripoIR || record.aripo_ir) {
            displayNum = record.aripoIR || record.aripo_ir;
            displayOrigin = 'ARIPO';
        }

        return `[${displayOrigin}] ${displayNum}`;
    }
}