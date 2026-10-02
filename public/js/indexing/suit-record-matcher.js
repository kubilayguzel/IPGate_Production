// public/js/indexing/suit-record-matcher.js
// AŞAMA 3R - Dava kaydını esas no / mahkeme / taraflar / müvekkil ve
// bağlı dava konusu IP varlığı üzerinden arar.

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

    findMatches(query, suits, limit = 20) {
        const q = this.normalizeText(query);
        const qc = this.normalizeCompact(query);
        if (!q || q.length < 2 || !Array.isArray(suits)) return [];

        const tokens = q.split(/\s+/).filter(Boolean);

        return suits.map((suit) => {
            const subject = suit._subjectRecord || {};
            const fields = [
                suit.file_no,
                suit.title,
                suit.court_name,
                suit.suit_type,
                suit._clientName,
                suit.client_role,
                suit.opposing_party,
                suit.opposing_counsel,
                ...(suit._partyNames || []),
                subject.title,
                subject.brandText,
                subject.applicationNumber,
                subject.registrationNumber,
                subject.wipoIR,
                subject.aripoIR,
                subject.applicantName,
                ...(subject.applicants || []).map(a =>
                    typeof a === 'string' ? a : (a?.name || '')
                )
            ].filter(Boolean);

            const hay = this.normalizeText(fields.join(' | '));
            const hayc = this.normalizeCompact(fields.join(' | '));
            const tokenMatch = tokens.every(t => hay.includes(t));
            const compactMatch = qc.length >= 3 && hayc.includes(qc);
            if (!tokenMatch && !compactMatch) return null;

            const fileNo = this.normalizeText(suit.file_no);
            const fileNoC = this.normalizeCompact(suit.file_no);
            const subjectTitle = this.normalizeText(subject.title || subject.brandText);
            const subjectNo = this.normalizeText(
                subject.applicationNumber || subject.registrationNumber ||
                subject.wipoIR || subject.aripoIR
            );
            const partyText = this.normalizeText([
                suit._clientName, suit.opposing_party, suit.opposing_counsel,
                ...(suit._partyNames || [])
            ].filter(Boolean).join(' | '));

            let score = 10;
            if (fileNo && fileNo === q) score += 150;
            else if (fileNoC && fileNoC === qc) score += 145;
            else if (fileNo && fileNo.startsWith(q)) score += 120;
            else if (fileNoC && fileNoC.includes(qc)) score += 100;

            if (subjectTitle && subjectTitle === q) score += 115;
            else if (subjectTitle && subjectTitle.includes(q)) score += 90;

            if (subjectNo && subjectNo === q) score += 110;
            else if (subjectNo && subjectNo.includes(q)) score += 80;

            if (partyText && partyText.includes(q)) score += 75;

            const title = this.normalizeText(suit.title);
            const court = this.normalizeText(suit.court_name);
            if (title && title.includes(q)) score += 55;
            if (court && court.includes(q)) score += 45;

            return { suit, score };
        }).filter(Boolean)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(x => x.suit);
    }
}