import PizZip from 'https://cdn.jsdelivr.net/npm/pizzip@3.1.7/+esm';
import saveAs from 'https://cdn.jsdelivr.net/npm/file-saver@2.0.5/+esm';

const DEFAULT_TEMPLATE_URL =
    'https://kadxvkejzctwymzeyrrl.supabase.co/storage/v1/object/public/templates/itiraza-karsi-gorus-dilekce-taslagi.docx';
const DOCUMENT_MARKER = '[[EVREKA_DOCUMENT_BODY]]';
const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export class ProfessionalOppositionResponseDocument {
    constructor(options = {}) {
        this.templateUrl = options.templateUrl || DEFAULT_TEMPLATE_URL;
    }

    async generate({ documentData, petitionText, qaReport, fileName }) {
        if (!qaReport || qaReport.finalPass !== true) {
            throw new Error('Word çıktısı için Strict QA PASS gereklidir.');
        }
        if (!String(petitionText || '').trim()) {
            throw new Error('Word çıktısı için dilekçe metni bulunamadı.');
        }

        const separator = this.templateUrl.includes('?') ? '&' : '?';
        const templateRequestUrl = `${this.templateUrl}${separator}responseStudio=1`;
        const response = await fetch(templateRequestUrl, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Word şablonu indirilemedi (HTTP ${response.status}). URL: ${this.templateUrl}`);
        }

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const templateBuffer = await response.arrayBuffer();
        const bytes = new Uint8Array(templateBuffer);
        const hasZipMagic = bytes.length >= 4 &&
            bytes[0] === 0x50 && bytes[1] === 0x4b &&
            bytes[2] === 0x03 && bytes[3] === 0x04;

        if (!hasZipMagic) {
            const likelyFallback = contentType.includes('text/html') ||
                contentType.includes('application/json') ||
                contentType.includes('text/plain');
            throw new Error(
                `Word şablonu geçerli bir DOCX/ZIP değil. ` +
                `URL: ${this.templateUrl}; Content-Type: ${contentType || 'bilinmiyor'}; ` +
                `Boyut: ${bytes.length} byte.` +
                (likelyFallback ? ' Sunucu büyük olasılıkla DOCX yerine HTML/JSON fallback döndürdü.' : '')
            );
        }

        let zip;
        try {
            zip = new PizZip(templateBuffer);
        } catch (error) {
            throw new Error(`Word şablonu açılamadı: ${error?.message || String(error)}`);
        }
        let xml = zip.file('word/document.xml')?.asText();
        if (!xml) throw new Error('Word şablonunun document.xml dosyası bulunamadı.');
        if (!xml.includes(DOCUMENT_MARKER)) {
            throw new Error(`Word şablonunda ${DOCUMENT_MARKER} işareti bulunamadı.`);
        }

        const body = this.buildBody(documentData || {}, petitionText);
        xml = this.replaceMarkerParagraph(xml, body);
        zip.file('word/document.xml', xml);

        const output = zip.generate({
            type: 'blob',
            mimeType: WORD_MIME,
            compression: 'DEFLATE'
        });

        const finalName = fileName || this.defaultFileName(documentData || {});
        saveAs(output, finalName);
        return { fileName: finalName };
    }

    defaultFileName(documentData) {
        const no = String(documentData?.applicant?.applicationNo || '')
            .replace(/[\\/]/g, '-')
            .replace(/[^A-Za-z0-9._-]/g, '_')
            .trim();
        return no
            ? `${no}_Itiraza_Karsi_Gorus.docx`
            : 'Itiraza_Karsi_Gorus.docx';
    }

    buildBody(documentData, petitionText) {
        const applicant = documentData?.applicant || {};
        const opponent = documentData?.opponentParty || {};
        const stage = documentData?.procedureStage;
        const applicantNames = (applicant.applicants || [])
            .map(x => x?.name)
            .filter(Boolean)
            .join(', ');

        const authorityTitleLines = stage === 'yidk_appeal'
            ? ['TÜRK PATENT VE MARKA KURUMU', 'YENİDEN İNCELEME VE DEĞERLENDİRME DAİRESİ BAŞKANLIĞINA']
            : ['TÜRK PATENT VE MARKA KURUMU', 'MARKALAR DAİRESİ BAŞKANLIĞINA'];

        const headerLines = [
            ...authorityTitleLines,
            '',
            `BAŞVURU NO: ${applicant.applicationNo || '-'}`,
            `MARKA: ${applicant.markText || '-'}`,
            `BAŞVURU SAHİBİ: ${applicantNames || '-'}`,
            `İTİRAZ EDEN: ${opponent.name || '-'}`,
            'KONU: İtiraza karşı görüşlerimizin sunulmasıdır.',
            ''
        ];

        const lines = [...headerLines, ...String(petitionText).replace(/\r\n?/g, '\n').split('\n')];
        return lines.map(line => this.lineToParagraph(line)).join('');
    }

    lineToParagraph(raw) {
        const line = String(raw ?? '').trim();
        if (!line) return '<w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>';

        const isMainTitle = /^TÜRK PATENT VE MARKA KURUMU$/i.test(line) ||
            /^YENİDEN İNCELEME VE DEĞERLENDİRME/i.test(line) ||
            /^MARKALAR DAİRESİ BAŞKANLIĞINA$/i.test(line) ||
            /^AÇIKLAMALARIMIZ VE İTİRAZA KARŞI GÖRÜŞLERİMİZ$/i.test(line);
        const isHeading = /^\d+\.\s+/.test(line) || /^\d+\.\s*SONUÇ VE TALEP/i.test(line);
        const isMeta = /^(BAŞVURU NO|MARKA|BAŞVURU SAHİBİ|İTİRAZ EDEN|KONU):/i.test(line);

        const alignment = isMainTitle ? '<w:jc w:val="center"/>' : '<w:jc w:val="both"/>';
        const bold = (isMainTitle || isHeading || isMeta) ? '<w:b/>' : '';
        const keepNext = (isHeading || isMainTitle) ? '<w:keepNext/>' : '';
        const size = isMainTitle ? '24' : isHeading ? '23' : '22';
        const before = isHeading ? '220' : '0';
        const after = isHeading ? '100' : '90';

        return `
            <w:p>
                <w:pPr>${alignment}${keepNext}<w:spacing w:before="${before}" w:after="${after}" w:line="300" w:lineRule="auto"/></w:pPr>
                <w:r>
                    <w:rPr>${bold}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>
                    <w:t xml:space="preserve">${this.xmlEscape(line)}</w:t>
                </w:r>
            </w:p>
        `;
    }

    replaceMarkerParagraph(xml, bodyXml) {
        const escaped = DOCUMENT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const paragraphRegex = new RegExp(`<w:p(?:\\s[^>]*)?>[\\s\\S]*?${escaped}[\\s\\S]*?<\\/w:p>`);
        if (paragraphRegex.test(xml)) return xml.replace(paragraphRegex, bodyXml);
        return xml.replace(DOCUMENT_MARKER, bodyXml);
    }

    xmlEscape(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
}
