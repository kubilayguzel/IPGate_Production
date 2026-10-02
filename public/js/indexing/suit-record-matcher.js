// public/js/indexing/suit-record-matcher.js
// AŞAMA 3 - Dava dosyaları için salt-okunur arama yardımcı sınıfı.

export class SuitRecordMatcher {
    normalizeText(value) {
        return String(value || '')
            .toLocaleLowerCase('tr-TR')
            .replace(/\s+/g, ' ')
            .trim();
    }

    normalizeCompact(value) {
        return this.normalizeText(value)
            .replace(/[^0-9a-zçğıöşü]/gi, '');
    }

    findMatches(query, suits, limit = 10) {
        const normalizedQuery = this.normalizeText(query);
        const compactQuery = this.normalizeCompact(query);

        if (!normalizedQuery || normalizedQuery.length < 3) return [];
        if (!Array.isArray(suits) || suits.length === 0) return [];

        const queryTokens = normalizedQuery
            .split(/\s+/)
            .map((x) => x.trim())
            .filter(Boolean);

        return suits
            .map((suit) => {
                const fields = [
                    suit.file_no,
                    suit.title,
                    suit.court_name,
                    suit.suit_type,
                    suit._clientName,
                    suit.opposing_party,
                    ...(suit._partyNames || [])
                ].filter(Boolean);

                const haystack = this.normalizeText(fields.join(' | '));
                const compactHaystack = this.normalizeCompact(fields.join(' | '));

                const fileNo = this.normalizeText(suit.file_no);
                const compactFileNo = this.normalizeCompact(suit.file_no);
                const title = this.normalizeText(suit.title);
                const court = this.normalizeText(suit.court_name);
                const client = this.normalizeText(suit._clientName);

                const tokenMatch = queryTokens.every((token) =>
                    haystack.includes(token)
                );

                const compactMatch =
                    compactQuery.length >= 4 &&
                    compactHaystack.includes(compactQuery);

                if (!tokenMatch && !compactMatch) return null;

                let score = 10;

                if (fileNo && fileNo === normalizedQuery) score += 100;
                else if (compactFileNo && compactFileNo === compactQuery) score += 95;
                else if (fileNo && fileNo.startsWith(normalizedQuery)) score += 80;
                else if (compactFileNo && compactFileNo.includes(compactQuery)) score += 70;

                if (title && title.includes(normalizedQuery)) score += 40;
                if (court && court.includes(normalizedQuery)) score += 30;
                if (client && client.includes(normalizedQuery)) score += 30;

                return { suit, score };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((item) => item.suit);
    }

    getDisplayLabel(suit) {
        if (!suit) return 'Dava Dosyası';

        const fileNo = suit.file_no || 'Esas No Yok';
        const court = suit.court_name || 'Mahkeme Yok';

        return `${fileNo} • ${court}`;
    }
}
