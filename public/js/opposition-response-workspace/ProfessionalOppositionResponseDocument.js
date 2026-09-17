import PizZip from 'https://cdn.jsdelivr.net/npm/pizzip@3.1.7/+esm';
import saveAs from 'https://cdn.jsdelivr.net/npm/file-saver@2.0.5/+esm';

const DEFAULT_TEMPLATE_URL =
    'https://kadxvkejzctwymzeyrrl.supabase.co/storage/v1/object/public/templates/itiraza-karsi-gorus-dilekce-taslagi.docx';

const DOCUMENT_MARKER = '[[EVREKA_DOCUMENT_BODY]]';
const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const BODY_WIDTH = 9000;

const COLORS = {
    green: '118A3A',
    greenDark: '0B6B2B',
    grayLight: 'F5F7F8',
    grayBorder: 'C9D2D9',
    grayText: '4B5563',
    black: '111827',
    white: 'FFFFFF',
};

export class ProfessionalOppositionResponseDocument {
    constructor(options = {}) {
        this.templateUrl = options.templateUrl || DEFAULT_TEMPLATE_URL;
    }

    async generate({ documentData, petitionText, qaReport, fileName }) {
        if (!qaReport || qaReport.finalPass !== true) {
            throw new Error('Word çıktısı için Strict QA PASS gereklidir.');
        }

        const cleanPetition = this.sanitizePetitionText(petitionText);
        if (!cleanPetition) {
            throw new Error('Word çıktısı için dilekçe metni bulunamadı.');
        }

        const separator = this.templateUrl.includes('?') ? '&' : '?';
        const templateRequestUrl = `${this.templateUrl}${separator}responseStudio=1.0.8`;
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

        let documentXml = zip.file('word/document.xml')?.asText();
        if (!documentXml) {
            throw new Error('Word şablonunun document.xml dosyası bulunamadı.');
        }
        if (!documentXml.includes(DOCUMENT_MARKER)) {
            throw new Error(`Word şablonunda ${DOCUMENT_MARKER} işareti bulunamadı.`);
        }

        const bodyXml = this.buildDocumentBodyXml(documentData || {}, cleanPetition);
        documentXml = this.replaceMarkerParagraph(documentXml, bodyXml);
        zip.file('word/document.xml', documentXml);

        const output = zip.generate({
            type: 'blob',
            mimeType: WORD_MIME,
            compression: 'DEFLATE',
        });

        const finalFileName = fileName || this.defaultFileName(documentData || {});
        saveAs(output, finalFileName);
        return { fileName: finalFileName };
    }

    defaultFileName(documentData) {
        const applicationNo = String(documentData?.applicant?.applicationNo || '')
            .replace(/[\\/]/g, '-')
            .replace(/[^A-Za-z0-9._-]/g, '_')
            .trim();

        return applicationNo
            ? `${applicationNo}_Itiraza_Karsi_Gorus.docx`
            : 'Itiraza_Karsi_Gorus.docx';
    }

    sanitizePetitionText(value) {
        return String(value ?? '')
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map(line => line
                .replace(/^\s*#{1,6}\s*/, '')
                .replace(/\*\*/g, '')
                .replace(/\*/g, '')
                .replace(/__/g, '')
                .replace(/`/g, '')
                .trimEnd())
            .join('\n')
            .replace(/^\s*AÇIKLAMALARIMIZ VE İTİRAZA KARŞI GÖRÜŞLERİMİZ\s*\n+/i, '')
            .trim();
    }

    buildDocumentBodyXml(data, petitionText) {
        const parts = [];
        const stage = data?.procedureStage;

        parts.push(this.paragraph(
            'T.C. TÜRK PATENT VE MARKA KURUMU',
            { bold: true, align: 'center', size: 22, after: 40 }
        ));

        parts.push(this.paragraph(
            stage === 'yidk_appeal'
                ? 'YENİDEN İNCELEME VE DEĞERLENDİRME DAİRESİ BAŞKANLIĞI’NA'
                : 'MARKALAR DAİRESİ BAŞKANLIĞI’NA',
            { bold: true, align: 'center', size: 22, after: 220 }
        ));

        parts.push(this.caseInformationTable(data));

        parts.push(this.sectionHeading(
            'AÇIKLAMALARIMIZ VE İTİRAZA KARŞI GÖRÜŞLERİMİZ'
        ));

        const split = this.splitPetitionConclusion(petitionText);
        parts.push(...this.petitionParagraphs(split.body));

        if (split.conclusion || split.hadConclusionHeading) {
            parts.push(this.sectionHeading('SONUÇ VE TALEP'));
            parts.push(...this.petitionParagraphs(split.conclusion));
        }

        parts.push(this.paragraph(
            new Date().toLocaleDateString('tr-TR'),
            { before: 180, after: 120 }
        ));

        parts.push(this.paragraph(
            `Başvuru Sahibi Vekili ${data?.representativeName || 'Evreka Group Danışmanlık'}`,
            { bold: true, after: 0 }
        ));

        return parts.join('');
    }

    splitPetitionConclusion(petitionText) {
        const lines = String(petitionText || '').split('\n');
        const body = [];
        const conclusion = [];
        let inConclusion = false;
        let hadConclusionHeading = false;

        for (const raw of lines) {
            const line = String(raw ?? '').trim();
            if (/^\d+(?:\.\d+)*\.\s*SONUÇ VE TALEP\b/i.test(line) || /^SONUÇ VE TALEP\b/i.test(line)) {
                inConclusion = true;
                hadConclusionHeading = true;
                continue;
            }
            (inConclusion ? conclusion : body).push(raw);
        }

        return {
            body: body.join('\n').trim(),
            conclusion: conclusion.join('\n').trim(),
            hadConclusionHeading,
        };
    }

    caseInformationTable(data) {
        const applicant = data?.applicant || {};
        const opponent = data?.opponentParty || {};
        const stage = data?.procedureStage;
        const applicantNames = (applicant.applicants || [])
            .map(item => item?.name)
            .filter(Boolean)
            .join(', ');

        const rows = [
            ['BAŞVURU SAHİBİ', applicantNames || 'Müvekkil'],
            ['VEKİLİ', data?.representativeName || 'Evreka Group Danışmanlık'],
            ['İTİRAZ EDEN', opponent.name || 'Karşı Taraf'],
            ['BAŞVURU NO', applicant.applicationNo || 'Belirtilmemiş'],
            ['MARKA', applicant.markText || 'Belirtilmemiş'],
            [
                'KONU',
                stage === 'yidk_appeal'
                    ? 'YİDK nezdindeki itiraza karşı görüşlerimizin sunulmasıdır.'
                    : 'Yayıma itiraza karşı görüşlerimizin sunulmasıdır.'
            ],
        ];

        return this.keyValueTable(rows);
    }

    petitionParagraphs(text) {
        const lines = String(text || '').split('\n');
        const paragraphs = [];

        for (const rawLine of lines) {
            const line = rawLine.trim();

            if (!line) {
                paragraphs.push(this.paragraph('', { after: 40 }));
                continue;
            }

            const numberedHeading =
                /^\d+(?:\.\d+)*\.\s+[A-ZÇĞİÖŞÜ]/u.test(line) &&
                line.length < 180;

            if (
                numberedHeading ||
                (
                    line.length < 120 &&
                    line === line.toLocaleUpperCase('tr-TR') &&
                    /[A-ZÇĞİÖŞÜ]/.test(line)
                )
            ) {
                const isSubheading = /^\d+\.\d+\./.test(line);
                paragraphs.push(this.paragraph(
                    line,
                    {
                        bold: true,
                        before: isSubheading ? 90 : 140,
                        after: isSubheading ? 55 : 80,
                        size: isSubheading ? 19 : 20,
                        keepNext: true,
                    }
                ));
                continue;
            }

            if (/^[-•]\s+/.test(line)) {
                paragraphs.push(this.bulletParagraph(
                    line.replace(/^[-•]\s+/, '')
                ));
                continue;
            }

            paragraphs.push(this.paragraph(
                line,
                { align: 'both', after: 90 }
            ));
        }

        return paragraphs;
    }

    sectionHeading(text) {
        return this.paragraph(
            text,
            {
                bold: true,
                color: COLORS.greenDark,
                size: 21,
                before: 220,
                after: 90,
                keepNext: true,
                borderBottom: COLORS.green,
            }
        );
    }

    keyValueTable(rows) {
        const contentRows = rows.map(([label, value]) => [
            {
                xml: this.paragraph(label, { bold: true, after: 0 }),
                shading: COLORS.grayLight,
            },
            {
                xml: this.paragraph(value, { after: 0 }),
            },
        ]);

        return this.table(
            contentRows,
            [1900, BODY_WIDTH - 1900],
            { after: 180 }
        );
    }

    table(rows, widths, options = {}) {
        const totalWidth = widths.reduce(
            (sum, value) => sum + Number(value || 0),
            0
        );

        const grid = widths
            .map(width => `<w:gridCol w:w="${Math.round(width)}"/>`)
            .join('');

        const rowXml = rows
            .map(row =>
                `<w:tr>${row
                    .map((cell, index) =>
                        this.tableCell(
                            cell,
                            widths[index] || (totalWidth / Math.max(row.length, 1))
                        )
                    )
                    .join('')}</w:tr>`
            )
            .join('');

        return `
<w:tbl>
    <w:tblPr>
        <w:tblW w:w="${Math.round(totalWidth)}" w:type="dxa"/>
        <w:tblLayout w:type="fixed"/>
        <w:tblBorders>
            <w:top w:val="single" w:sz="6" w:space="0" w:color="${COLORS.grayBorder}"/>
            <w:left w:val="single" w:sz="6" w:space="0" w:color="${COLORS.grayBorder}"/>
            <w:bottom w:val="single" w:sz="6" w:space="0" w:color="${COLORS.grayBorder}"/>
            <w:right w:val="single" w:sz="6" w:space="0" w:color="${COLORS.grayBorder}"/>
            <w:insideH w:val="single" w:sz="4" w:space="0" w:color="${COLORS.grayBorder}"/>
            <w:insideV w:val="single" w:sz="4" w:space="0" w:color="${COLORS.grayBorder}"/>
        </w:tblBorders>
        <w:tblCellMar>
            <w:top w:w="90" w:type="dxa"/>
            <w:left w:w="90" w:type="dxa"/>
            <w:bottom w:w="90" w:type="dxa"/>
            <w:right w:w="90" w:type="dxa"/>
        </w:tblCellMar>
    </w:tblPr>
    <w:tblGrid>${grid}</w:tblGrid>
    ${rowXml}
</w:tbl>
${this.paragraph('', { after: options.after ?? 60 })}`;
    }

    tableCell(cell, width) {
        const normalized = typeof cell === 'string'
            ? { xml: this.paragraph(cell) }
            : (cell || {});

        return `
<w:tc>
    <w:tcPr>
        <w:tcW w:w="${Math.round(width)}" w:type="dxa"/>
        ${normalized.shading
            ? `<w:shd w:val="clear" w:color="auto" w:fill="${normalized.shading}"/>`
            : ''}
        <w:vAlign w:val="center"/>
    </w:tcPr>
    ${normalized.xml || this.paragraph('')}
</w:tc>`;
    }

    paragraph(text, options = {}) {
        const alignMap = {
            left: 'left',
            center: 'center',
            right: 'right',
            both: 'both',
        };

        const paragraphProperties = [
            `<w:spacing w:before="${Number(options.before ?? 0)}" w:after="${Number(options.after ?? 80)}" w:line="276" w:lineRule="auto"/>`,
            options.align
                ? `<w:jc w:val="${alignMap[options.align] || options.align}"/>`
                : '',
            options.keepNext ? '<w:keepNext/>' : '',
            options.borderBottom
                ? `<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="5" w:color="${options.borderBottom}"/></w:pBdr>`
                : '',
        ].filter(Boolean).join('');

        return `
<w:p>
    <w:pPr>${paragraphProperties}</w:pPr>
    ${this.run(text, options)}
</w:p>`;
    }

    bulletParagraph(text) {
        return `
<w:p>
    <w:pPr>
        <w:spacing w:before="0" w:after="80" w:line="276" w:lineRule="auto"/>
        <w:ind w:left="360" w:hanging="240"/>
    </w:pPr>
    ${this.run('• ', { bold: true, color: COLORS.greenDark })}
    ${this.run(text, {})}
</w:p>`;
    }

    run(text, options = {}) {
        const properties = [
            '<w:rFonts w:ascii="Poppins" w:hAnsi="Poppins" w:eastAsia="Poppins" w:cs="Poppins"/>',
            options.bold ? '<w:b/><w:bCs/>' : '',
            options.italic ? '<w:i/><w:iCs/>' : '',
            `<w:color w:val="${options.color || COLORS.black}"/>`,
            `<w:sz w:val="${Number(options.size || 19)}"/>`,
            `<w:szCs w:val="${Number(options.size || 19)}"/>`,
            '<w:lang w:val="tr-TR"/>',
        ].filter(Boolean).join('');

        return `
<w:r>
    <w:rPr>${properties}</w:rPr>
    <w:t xml:space="preserve">${this.xmlEscape(text)}</w:t>
</w:r>`;
    }

    replaceMarkerParagraph(documentXml, replacementXml) {
        const markerIndex = documentXml.indexOf(DOCUMENT_MARKER);
        if (markerIndex < 0) {
            throw new Error(`Word şablonunda ${DOCUMENT_MARKER} işareti bulunamadı.`);
        }

        const paragraphMatches = [
            ...documentXml.slice(0, markerIndex).matchAll(/<w:p(?:\s[^>]*)?>/g)
        ];
        const paragraphStart = paragraphMatches.length
            ? paragraphMatches[paragraphMatches.length - 1].index
            : -1;
        const paragraphEndStart = documentXml.indexOf('</w:p>', markerIndex);

        if (paragraphStart < 0 || paragraphEndStart < 0) {
            throw new Error('Word şablonundaki document marker paragrafı bulunamadı.');
        }

        const paragraphEnd = paragraphEndStart + '</w:p>'.length;
        return documentXml.slice(0, paragraphStart) +
            replacementXml +
            documentXml.slice(paragraphEnd);
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
