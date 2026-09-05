import { supabase } from '../../supabase-config.js';

import PizZip from 'https://cdn.jsdelivr.net/npm/pizzip@3.1.7/+esm';
import saveAs from 'https://cdn.jsdelivr.net/npm/file-saver@2.0.5/+esm';


const DEFAULT_TEMPLATE_URL =
    'https://kadxvkejzctwymzeyrrl.supabase.co/storage/v1/object/public/templates/yayina%20itiraz%20dilekce%20taslagi.docx';

const DOCUMENT_MARKER =
    '[[EVREKA_DOCUMENT_BODY]]';

const WORD_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const BODY_WIDTH =
    9000;

const COLORS = {
    green:
        '118A3A',

    greenDark:
        '0B6B2B',

    greenLight:
        'EAF6EE',

    grayLight:
        'F5F7F8',

    grayBorder:
        'C9D2D9',

    grayText:
        '4B5563',

    black:
        '111827',

    white:
        'FFFFFF',
};


export class ProfessionalOppositionDocument {

    constructor(options = {}) {

        this.templateUrl =
            options.templateUrl ||
            DEFAULT_TEMPLATE_URL;

        this.docPrCounter =
            2000;
    }


    async generate({
        documentData,
        petitionText,
        fileName,
        qaReport,
    }) {

        if (!documentData) {

            throw new Error(
                'Profesyonel Word için documentData bulunamadı.'
            );
        }


        this.assertWordExportEligibility({
            documentData,
            petitionText,
            qaReport,
        });


        const cleanPetition =
            this.sanitizePetitionText(
                petitionText
            );


        if (!cleanPetition) {

            throw new Error(
                'Word belgesine aktarılacak hukuki gerekçe metni bulunamadı.'
            );
        }


        const templateResponse =
            await fetch(
                `${this.templateUrl}?package=5.1`,
                {
                    cache:
                        'no-store'
                }
            );


        if (!templateResponse.ok) {

            throw new Error(
                'Paket 5 Word şablonu indirilemedi.'
            );
        }


        const templateBuffer =
            await templateResponse.arrayBuffer();


        const zip =
            new PizZip(
                templateBuffer
            );


        let documentXml =
            zip
                .file(
                    'word/document.xml'
                )
                ?.asText();


        let relationshipsXml =
            zip
                .file(
                    'word/_rels/document.xml.rels'
                )
                ?.asText();


        let contentTypesXml =
            zip
                .file(
                    '[Content_Types].xml'
                )
                ?.asText();


        if (
            !documentXml ||
            !relationshipsXml ||
            !contentTypesXml
        ) {

            throw new Error(
                'Word şablonunun OOXML yapısı eksik.'
            );
        }


        if (
            !documentXml.includes(
                DOCUMENT_MARKER
            )
        ) {

            throw new Error(
                `Word şablonunda ${DOCUMENT_MARKER} işareti bulunamadı.`
            );
        }


        const assetState = {
            zip,

            relationshipsXml,

            contentTypesXml,

            nextRelationshipId:
                this.findNextRelationshipId(
                    relationshipsXml
                ),

            mediaCounter:
                1,
        };


        const opponentImage =
            await this.prepareImage(
                assetState,
                documentData
                    ?.opponent
                    ?.imageUrl,
                'opponent'
            );


        const priorMarks = [];

        for (
            let index = 0;
            index <
            (
                documentData.priorMarks ||
                []
            ).length;
            index += 1
        ) {

            const mark =
                documentData
                    .priorMarks[index];


            const image =
                await this.prepareImage(
                    assetState,
                    mark.imageUrl,
                    `prior_${index + 1}`
                );


            priorMarks.push({
                ...mark,
                _wordImage:
                    image,
            });
        }


        relationshipsXml =
            assetState.relationshipsXml;

        contentTypesXml =
            assetState.contentTypesXml;


        const bodyXml =
            this.buildDocumentBodyXml(
                {
                    ...documentData,

                    priorMarks,

                    opponent: {
                        ...(
                            documentData.opponent ||
                            {}
                        ),

                        _wordImage:
                            opponentImage,
                    },
                },
                cleanPetition
            );


        documentXml =
            this.replaceMarkerParagraph(
                documentXml,
                bodyXml
            );


        zip.file(
            'word/document.xml',
            documentXml
        );


        zip.file(
            'word/_rels/document.xml.rels',
            relationshipsXml
        );


        zip.file(
            '[Content_Types].xml',
            contentTypesXml
        );


        const output =
            zip.generate({
                type:
                    'blob',

                mimeType:
                    WORD_MIME,

                compression:
                    'DEFLATE',
            });


        const finalFileName =
            fileName ||
            this.defaultFileName(
                documentData
            );


        saveAs(
            output,
            finalFileName
        );


        return {
            fileName:
                finalFileName,

            priorImageCount:
                priorMarks.filter(
                    mark =>
                        Boolean(
                            mark._wordImage
                        )
                ).length,

            opponentImageIncluded:
                Boolean(
                    opponentImage
                ),
        };
    }


    defaultFileName(
        documentData
    ) {

        const applicationNo =
            String(
                documentData
                    ?.opponent
                    ?.applicationNo ||
                ''
            )
                .replace(
                    /[\\/]/g,
                    '-'
                )
                .trim();


        return applicationNo

            ? `${applicationNo}_Yayima_Itiraz_Dilekcesi.docx`

            : 'Yayima_Itiraz_Dilekcesi.docx';
    }


    sanitizePetitionText(
        value
    ) {

        const lines =
            String(
                value ??
                ''
            )
                .replace(
                    /\r\n?/g,
                    '\n'
                )
                .split('\n');


        const result = [];

        let conclusionReached =
            false;


        for (
            const rawLine of
            lines
        ) {

            let line =
                rawLine
                    .trim();


            if (
                !line &&
                result.length === 0
            ) {

                continue;
            }


            if (
                /^AÇIKLAMALARIMIZ VE HUKUKİ GEREKÇELER$/i
                    .test(line)
            ) {

                continue;
            }


            if (
                /^(?:\d+\.\s*)?SONUÇ VE TALEP\b/i
                    .test(line)
            ) {

                conclusionReached =
                    true;

                break;
            }


            line =
                line
                    .replace(
                        /^\s*#{1,6}\s*/,
                        ''
                    )
                    .replace(
                        /\*\*/g,
                        ''
                    )
                    .replace(
                        /\*/g,
                        ''
                    )
                    .replace(
                        /__/g,
                        ''
                    )
                    .replace(
                        /`/g,
                        ''
                    );


            result.push(
                line
            );
        }


        if (conclusionReached) {

            while (
                result.length &&
                !result[
                    result.length - 1
                ]
            ) {

                result.pop();
            }
        }


        return result
            .join('\n')
            .trim();
    }


    assertWordExportEligibility({
        documentData,
        petitionText,
        qaReport,
    }) {

        const qaVersion =
            Number(
                qaReport
                    ?.version ??
                0
            );


        // Paket 6.0.7 TEST/REVIEW MODE:
        // QA FAIL, profesyonel Word oluşturulmasını engellemez.
        // Yalnızca QA metadata yapısının güncel olması aranır.
        if (
            !qaReport ||
            !Number.isFinite(
                qaVersion
            ) ||
            qaVersion <
            3
        ) {

            throw new Error(
                'Seçili dilekçenin QA metadata/sürüm bilgisi Word export için uygun değil.'
            );
        }


        const packageVersion =
            String(
                qaReport
                    ?.packageVersion ??
                ''
            )
                .trim();


        if (
            packageVersion !==
            '4.2'
        ) {

            throw new Error(
                `Seçili dilekçenin QA paketi (${packageVersion || 'belirsiz'}) Word export için güvenli kabul edilmiyor. Güncel bir dilekçe versiyonu üretin.`
            );
        }


        const text =
            String(
                petitionText ??
                ''
            );


        if (
            /\bK\d{1,3}\b/i.test(
                text
            )
        ) {

            throw new Error(
                'Dilekçe metninde iç RAG kaynak kodu (K1, K12 vb.) bulundu. Kuruma sunulacak Word belgesi oluşturulmadı. Güncel dilekçe versiyonu üretin.'
            );
        }


        const internalEnumPattern =
            /\b(?:negligible|secondary_distinctive|co_dominant|not_assessed|not_applicable|full_class)\b/i;


        if (
            internalEnumPattern.test(
                text
            )
        ) {

            throw new Error(
                'Dilekçe metninde uygulama içi teknik enum/etiket bulundu. Kuruma sunulacak Word belgesi oluşturulmadı.'
            );
        }


        const contradiction =
            this.detectSimilarityContradiction(
                text
            );


        if (contradiction) {

            throw new Error(
                `${contradiction} benzerliği bakımından metin içinde birbiriyle çelişen seviye ifadeleri bulundu. Word export durduruldu.`
            );
        }


        if (
            documentData
                ?.wholeApplicationRefusal !==
            true &&
            (
                /\bbaşvurunun\s+tümden\s+redd/i.test(
                    text
                ) ||
                /\bbaşvurunun\s+tamamen\s+redd/i.test(
                    text
                ) ||
                /\btüm\s+mal\s+ve\s+hizmetleri\s+bakımından\s+redd/i.test(
                    text
                )
            )
        ) {

            throw new Error(
                'Dilekçe metni başvurunun tamamının reddini talep ediyor; ancak canonical ret kapsamı başvurunun tamamını kapsamıyor. Word export durduruldu.'
            );
        }
    }


    detectSimilarityContradiction(
        text
    ) {

        const normalized =
            String(
                text ??
                ''
            )
                .toLocaleLowerCase(
                    'tr-TR'
                )
                .replace(
                    /\s+/g,
                    ' '
                );


        const dimensions = [
            {
                label:
                    'Görsel',

                token:
                    '(?:görsel|gorsel)',
            },
            {
                label:
                    'İşitsel',

                token:
                    '(?:işitsel|isitsel)',
            },
            {
                label:
                    'Kavramsal',

                token:
                    'kavramsal',
            },
        ];


        const levelTokens = [
            {
                key:
                    'high',

                token:
                    'yüksek',
            },
            {
                key:
                    'medium',

                token:
                    'orta',
            },
            {
                key:
                    'low',

                token:
                    'düşük',
            },
        ];


        const otherDimension =
            '(?:görsel|gorsel|işitsel|isitsel|kavramsal)';


        for (
            const dimension of
            dimensions
        ) {

            const found =
                new Set();


            for (
                const level of
                levelTokens
            ) {

                const patterns = [
                    new RegExp(
                        `${level.token}(?:\\s+düzeyde)?\\s+(?:bir\\s+)?${dimension.token}(?:\\s+ve\\s+${otherDimension})?\\s+benzerlik`,
                        'i'
                    ),

                    new RegExp(
                        `${dimension.token}(?:\\s+ve\\s+${otherDimension})?\\s+benzerlik(?:\\s+düzeyi)?\\s+${level.token}(?:\\s+düzeyde)?`,
                        'i'
                    ),

                    new RegExp(
                        `${dimension.token}\\s+(?:olarak|açıdan)\\s+${level.token}(?:\\s+düzeyde)?(?:\\s+bir)?\\s+benzerlik`,
                        'i'
                    ),
                ];


                if (
                    patterns.some(
                        pattern =>
                            pattern.test(
                                normalized
                            )
                    )
                ) {

                    found.add(
                        level.key
                    );
                }
            }


            const nonePatterns = [
                new RegExp(
                    `${dimension.token}(?:\\s+ve\\s+${otherDimension})?\\s+benzerlik\\s+bulunmamaktadır`,
                    'i'
                ),

                new RegExp(
                    `${dimension.token}(?:\\s+ve\\s+${otherDimension})?\\s+bakımından\\s+benzerlik\\s+bulunmamaktadır`,
                    'i'
                ),
            ];


            if (
                nonePatterns.some(
                    pattern =>
                        pattern.test(
                            normalized
                        )
                )
            ) {

                found.add(
                    'none'
                );
            }


            if (
                found.size >
                1
            ) {

                return dimension.label;
            }
        }


        return null;
    }


    buildPreciseTopicText(
        data
    ) {

        const opponent =
            data.opponent ||
            {};


        const appNo =
            String(
                opponent.applicationNo ||
                ''
            )
                .trim();


        const mark =
            String(
                opponent.markText ||
                ''
            )
                .trim();


        const scopes =
            Array.isArray(
                data.refusalScopes
            )
                ? data.refusalScopes
                : [];


        if (
            scopes.length ===
            1
        ) {

            const scope =
                scopes[0];


            if (
                scope.mode ===
                'full_class'
            ) {

                return `${appNo} sayılı “${mark}” ibareli marka başvurusunun 6769 sayılı Sınai Mülkiyet Kanunu’nun 6/1. maddesi uyarınca ${scope.classNo}. sınıfta yer alan mal ve hizmetlerin tamamı bakımından reddi talebimizdir.`;
            }


            return `${appNo} sayılı “${mark}” ibareli marka başvurusunun 6769 sayılı Sınai Mülkiyet Kanunu’nun 6/1. maddesi uyarınca ${scope.classNo}. sınıfta aşağıda belirtilen mal ve hizmetler bakımından reddi talebimizdir.`;
        }


        return `${appNo} sayılı “${mark}” ibareli marka başvurusunun 6769 sayılı Sınai Mülkiyet Kanunu’nun 6/1. maddesi uyarınca aşağıda belirtilen sınıf ve kapsamlar bakımından reddi talebimizdir.`;
    }


    buildPreciseResultItems(
        data
    ) {

        const opponent =
            data.opponent ||
            {};


        const appNo =
            String(
                opponent.applicationNo ||
                ''
            )
                .trim();


        const mark =
            String(
                opponent.markText ||
                ''
            )
                .trim();


        const scopes =
            Array.isArray(
                data.refusalScopes
            )
                ? data.refusalScopes
                : [];


        const items =
            scopes.map(
                scope => {

                    if (
                        scope.mode ===
                        'full_class'
                    ) {

                        return `${appNo} sayılı “${mark}” ibareli marka başvurusunun ${scope.classNo}. sınıfta yer alan mal ve hizmetlerin tamamı bakımından reddine,`;
                    }


                    return `${appNo} sayılı “${mark}” ibareli marka başvurusunun ${scope.classNo}. sınıfta yer alan şu mal ve hizmetler bakımından reddine: ${scope.text || '-'}`;
                }
            );


        items.push(
            'İtirazımızın kabulüne karar verilmesini saygılarımızla arz ve talep ederiz.'
        );


        return items;
    }


    async prepareImage(
        state,
        rawImageUrl,
        logicalName
    ) {

        const resolvedUrl =
            this.resolveImageUrl(
                rawImageUrl
            );


        if (!resolvedUrl) {

            return null;
        }


        try {

            const asset =
                await this.fetchImageAsset(
                    resolvedUrl
                );


            if (!asset) {

                return null;
            }


            const extension =
                asset.extension;


            const mediaName =
                `evreka_${logicalName}_${state.mediaCounter}.${extension}`;


            state.mediaCounter +=
                1;


            state.zip.file(
                `word/media/${mediaName}`,
                asset.bytes
            );


            const relationshipId =
                `rId${state.nextRelationshipId}`;


            state.nextRelationshipId +=
                1;


            state.relationshipsXml =
                state.relationshipsXml
                    .replace(
                        '</Relationships>',
                        `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${this.escapeAttribute(mediaName)}"/></Relationships>`
                    );


            state.contentTypesXml =
                this.ensureImageContentType(
                    state.contentTypesXml,
                    extension
                );


            return {
                relationshipId,

                widthEmu:
                    asset.widthEmu,

                heightEmu:
                    asset.heightEmu,
            };


        } catch (error) {

            console.warn(
                'Marka görseli Word belgesine eklenemedi:',
                rawImageUrl,
                error
            );


            return null;
        }
    }


    resolveImageUrl(
        value
    ) {

        const raw =
            String(
                value ??
                ''
            )
                .trim();


        if (!raw) {

            return null;
        }


        if (
            /^(https?:|data:|blob:)/i
                .test(raw)
        ) {

            return raw;
        }


        if (
            /^gs:\/\//i
                .test(raw)
        ) {

            return null;
        }


        const storagePath =
            raw
                .replace(
                    /^\/+/,
                    ''
                )
                .replace(
                    /^brand_images\//i,
                    ''
                );


        const {
            data
        } =
            supabase
                .storage
                .from(
                    'brand_images'
                )
                .getPublicUrl(
                    storagePath
                );


        return data
            ?.publicUrl ||
            null;
    }


    async fetchImageAsset(
        url
    ) {

        const controller =
            new AbortController();


        const timeout =
            setTimeout(
                () =>
                    controller.abort(),
                15000
            );


        try {

            const response =
                await fetch(
                    url,
                    {
                        signal:
                            controller.signal,
                    }
                );


            if (!response.ok) {

                throw new Error(
                    `HTTP ${response.status}`
                );
            }


            const blob =
                await response.blob();


            if (
                !blob.type
                    .toLowerCase()
                    .startsWith(
                        'image/'
                    )
            ) {

                throw new Error(
                    `Görsel MIME türü geçersiz: ${blob.type || 'bilinmiyor'}`
                );
            }


            let targetBlob =
                blob;

            let extension =
                this.extensionForMime(
                    blob.type
                );


            let bitmap =
                null;


            try {

                bitmap =
                    await createImageBitmap(
                        blob
                    );

            } catch {

                bitmap =
                    null;
            }


            if (
                ![
                    'png',
                    'jpeg',
                    'jpg'
                ].includes(
                    extension
                )
            ) {

                if (!bitmap) {

                    throw new Error(
                        'Görsel Word uyumlu PNG/JPEG formatına çevrilemedi.'
                    );
                }


                targetBlob =
                    await this.bitmapToPngBlob(
                        bitmap
                    );


                extension =
                    'png';
            }


            let width =
                bitmap?.width ||
                240;

            let height =
                bitmap?.height ||
                120;


            if (bitmap?.close) {

                bitmap.close();
            }


            const maxWidth =
                260;

            const maxHeight =
                125;


            const scale =
                Math.min(
                    1,
                    maxWidth /
                    Math.max(
                        width,
                        1
                    ),
                    maxHeight /
                    Math.max(
                        height,
                        1
                    )
                );


            width =
                Math.max(
                    40,
                    Math.round(
                        width *
                        scale
                    )
                );


            height =
                Math.max(
                    28,
                    Math.round(
                        height *
                        scale
                    )
                );


            return {
                bytes:
                    await targetBlob.arrayBuffer(),

                extension,

                widthEmu:
                    width *
                    9525,

                heightEmu:
                    height *
                    9525,
            };


        } finally {

            clearTimeout(
                timeout
            );
        }
    }


    extensionForMime(
        mime
    ) {

        const normalized =
            String(
                mime ||
                ''
            )
                .toLowerCase();


        if (
            normalized.includes(
                'png'
            )
        ) {

            return 'png';
        }


        if (
            normalized.includes(
                'jpeg'
            ) ||
            normalized.includes(
                'jpg'
            )
        ) {

            return 'jpeg';
        }


        if (
            normalized.includes(
                'gif'
            )
        ) {

            return 'gif';
        }


        if (
            normalized.includes(
                'bmp'
            )
        ) {

            return 'bmp';
        }


        if (
            normalized.includes(
                'webp'
            )
        ) {

            return 'webp';
        }


        return 'png';
    }


    bitmapToPngBlob(
        bitmap
    ) {

        return new Promise(
            (
                resolve,
                reject
            ) => {

                const canvas =
                    document.createElement(
                        'canvas'
                    );


                canvas.width =
                    bitmap.width;

                canvas.height =
                    bitmap.height;


                const context =
                    canvas.getContext(
                        '2d'
                    );


                if (!context) {

                    reject(
                        new Error(
                            'Görsel dönüştürme canvas context açılamadı.'
                        )
                    );

                    return;
                }


                context.drawImage(
                    bitmap,
                    0,
                    0
                );


                canvas.toBlob(
                    blob => {

                        if (!blob) {

                            reject(
                                new Error(
                                    'PNG dönüştürme başarısız.'
                                )
                            );

                            return;
                        }


                        resolve(
                            blob
                        );
                    },
                    'image/png'
                );
            }
        );
    }


    findNextRelationshipId(
        xml
    ) {

        const values =
            [
                ...String(
                    xml ||
                    ''
                )
                    .matchAll(
                        /Id="rId(\d+)"/g
                    )
            ]
                .map(
                    match =>
                        Number(
                            match[1]
                        )
                )
                .filter(
                    Number.isFinite
                );


        return (
            values.length

                ? Math.max(
                    ...values
                )

                : 0
        ) + 1;
    }


    ensureImageContentType(
        xml,
        extension
    ) {

        const normalizedExtension =
            extension ===
            'jpg'

                ? 'jpeg'

                : extension;


        const mime =
            normalizedExtension ===
            'png'

                ? 'image/png'

                : 'image/jpeg';


        const defaultRegex =
            new RegExp(
                `<Default[^>]+Extension="${normalizedExtension}"[^>]*>`,
                'i'
            );


        if (
            defaultRegex.test(
                xml
            )
        ) {

            return xml;
        }


        return xml.replace(
            '</Types>',
            `<Default Extension="${normalizedExtension}" ContentType="${mime}"/></Types>`
        );
    }


    replaceMarkerParagraph(
        documentXml,
        replacementXml
    ) {

        const markerIndex =
            documentXml.indexOf(
                DOCUMENT_MARKER
            );


        if (
            markerIndex < 0
        ) {

            throw new Error(
                'Paket 5 document marker bulunamadı.'
            );
        }


        const paragraphMatches =
            [
                ...documentXml
                    .slice(
                        0,
                        markerIndex
                    )
                    .matchAll(
                        /<w:p(?:\s[^>]*)?>/g
                    )
            ];


        const paragraphStart =
            paragraphMatches.length

                ? paragraphMatches[
                    paragraphMatches.length - 1
                ].index

                : -1;


        const paragraphEndStart =
            documentXml.indexOf(
                '</w:p>',
                markerIndex
            );


        if (
            paragraphStart < 0 ||
            paragraphEndStart < 0
        ) {

            throw new Error(
                'Paket 5 document marker paragrafı bulunamadı.'
            );
        }


        const paragraphEnd =
            paragraphEndStart +
            '</w:p>'.length;


        return (
            documentXml.slice(
                0,
                paragraphStart
            ) +
            replacementXml +
            documentXml.slice(
                paragraphEnd
            )
        );
    }


    buildDocumentBodyXml(
        data,
        petitionText
    ) {

        const parts = [];


        parts.push(
            this.paragraph(
                'T.C. TÜRK PATENT VE MARKA KURUMU',
                {
                    bold:
                        true,

                    align:
                        'center',

                    size:
                        22,

                    after:
                        40,
                }
            )
        );


        parts.push(
            this.paragraph(
                'MARKALAR DAİRESİ BAŞKANLIĞI’NA',
                {
                    bold:
                        true,

                    align:
                        'center',

                    size:
                        22,

                    after:
                        220,
                }
            )
        );


        parts.push(
            this.caseInformationTable(
                data
            )
        );


        parts.push(
            this.sectionHeading(
                'MARKA KARŞILAŞTIRMASI'
            )
        );


        parts.push(
            ...this.markComparisonBlocks(
                data
            )
        );


        parts.push(
            this.sectionHeading(
                'MÜSTENİT HAKLAR'
            )
        );


        parts.push(
            this.priorRightsTable(
                data.priorMarks ||
                []
            )
        );


        parts.push(
            this.sectionHeading(
                'RET TALEP EDİLEN MAL VE HİZMETLER'
            )
        );


        parts.push(
            this.refusalScopeTable(
                data.refusalScopes ||
                []
            )
        );


        parts.push(
            this.sectionHeading(
                'MAL VE HİZMET KARŞILAŞTIRMASI'
            )
        );


        parts.push(
            this.goodsComparisonTable(
                data.goodsComparisons ||
                []
            )
        );


        parts.push(
            this.sectionHeading(
                'AÇIKLAMALARIMIZ VE HUKUKİ GEREKÇELER'
            )
        );


        parts.push(
            ...this.petitionParagraphs(
                petitionText
            )
        );


        parts.push(
            this.sectionHeading(
                'SONUÇ VE TALEP'
            )
        );


        parts.push(
            this.paragraph(
                'Yukarıda açıklanan nedenlerle;',
                {
                    after:
                        100,
                }
            )
        );


        for (
            const item of
            this.buildPreciseResultItems(
                data
            )
        ) {

            parts.push(
                this.bulletParagraph(
                    item
                )
            );
        }


        parts.push(
            this.paragraph(
                data.documentDate ||
                new Date()
                    .toLocaleDateString(
                        'tr-TR'
                    ),
                {
                    before:
                        180,

                    after:
                        120,
                }
            )
        );


        parts.push(
            this.paragraph(
                `İtiraz Eden Vekili ${data.representativeName || 'Evreka Group Danışmanlık'}`,
                {
                    bold:
                        true,

                    after:
                        0,
                }
            )
        );


        return parts.join('');
    }


    caseInformationTable(
        data
    ) {

        const opponent =
            data.opponent ||
            {};


        const rows = [
            [
                'YAYIMA İTİRAZ EDEN',
                data.clientName ||
                'Müvekkil',
            ],
            [
                'VEKİLİ',
                data.representativeName ||
                'Evreka Group Danışmanlık',
            ],
            [
                'BAŞVURU SAHİBİ',
                opponent.ownerName ||
                'Karşı Taraf',
            ],
            [
                'BAŞVURU NO',
                opponent.applicationNo ||
                'Belirtilmemiş',
            ],
            [
                'MARKA',
                opponent.markText ||
                'Belirtilmemiş',
            ],
            [
                'BÜLTEN',
                data.bulletinText ||
                'İlgili Bülten',
            ],
            [
                'KONU',
                this.buildPreciseTopicText(
                    data
                ),
            ],
        ];


        return this.keyValueTable(
            rows
        );
    }


    markComparisonBlocks(
        data
    ) {

        const priorMarks =
            data.priorMarks ||
            [];


        const opponent =
            data.opponent ||
            {};


        if (!priorMarks.length) {

            return [
                this.paragraph(
                    'Müstenit marka bilgisi bulunamadı.',
                    {
                        italic:
                            true,

                        color:
                            COLORS.grayText,
                    }
                )
            ];
        }


        return priorMarks.map(
            (
                prior,
                index
            ) => {

                const left =
                    [
                        this.paragraph(
                            `MÜSTENİT MARKA ${priorMarks.length > 1 ? index + 1 : ''}`.trim(),
                            {
                                bold:
                                    true,

                                align:
                                    'center',

                                color:
                                    COLORS.greenDark,

                                after:
                                    70,
                            }
                        ),

                        this.imageOrMarkParagraph(
                            prior._wordImage,
                            prior.markText
                        ),

                        this.paragraph(
                            prior.markText ||
                            'Marka',
                            {
                                bold:
                                    true,

                                align:
                                    'center',

                                after:
                                    30,
                            }
                        ),

                        this.paragraph(
                            `Başvuru No: ${prior.applicationNo || '-'}`,
                            {
                                align:
                                    'center',

                                size:
                                    18,

                                color:
                                    COLORS.grayText,
                            }
                        ),

                        this.paragraph(
                            `Tescil No: ${prior.registrationNo || '-'}`,
                            {
                                align:
                                    'center',

                                size:
                                    18,

                                color:
                                    COLORS.grayText,
                            }
                        ),
                    ]
                        .join('');


                const right =
                    [
                        this.paragraph(
                            'İTİRAZA KONU MARKA',
                            {
                                bold:
                                    true,

                                align:
                                    'center',

                                color:
                                    COLORS.greenDark,

                                after:
                                    70,
                            }
                        ),

                        this.imageOrMarkParagraph(
                            opponent._wordImage,
                            opponent.markText
                        ),

                        this.paragraph(
                            opponent.markText ||
                            'Marka',
                            {
                                bold:
                                    true,

                                align:
                                    'center',

                                after:
                                    30,
                            }
                        ),

                        this.paragraph(
                            `Başvuru No: ${opponent.applicationNo || '-'}`,
                            {
                                align:
                                    'center',

                                size:
                                    18,

                                color:
                                    COLORS.grayText,
                            }
                        ),

                        this.paragraph(
                            `Başvuru Tarihi: ${this.formatDate(opponent.applicationDate)}`,
                            {
                                align:
                                    'center',

                                size:
                                    18,

                                color:
                                    COLORS.grayText,
                            }
                        ),
                    ]
                        .join('');


                return this.table(
                    [
                        [
                            {
                                xml:
                                    left,

                                shading:
                                    'FFFFFF',
                            },

                            {
                                xml:
                                    right,

                                shading:
                                    'FFFFFF',
                            },
                        ],
                    ],
                    [
                        BODY_WIDTH / 2,
                        BODY_WIDTH / 2,
                    ],
                    {
                        after:
                            120,
                    }
                );
            }
        );
    }


    priorRightsTable(
        marks
    ) {

        if (!marks.length) {

            return this.paragraph(
                'Müstenit hak bulunamadı.',
                {
                    italic:
                        true,
                }
            );
        }


        const rows = [
            [
                'Marka',
                'Başvuru No',
                'Tescil No',
                'Başvuru Tarihi',
                'Dayanılan Sınıflar',
            ],

            ...marks.map(
                mark => [
                    mark.markText ||
                    '-',

                    mark.applicationNo ||
                    '-',

                    mark.registrationNo ||
                    '-',

                    this.formatDate(
                        mark.applicationDate
                    ),

                    (
                        mark.classes ||
                        []
                    )
                        .map(
                            item =>
                                item.classNo
                        )
                        .join(', ') ||
                    '-',
                ]
            ),
        ];


        return this.simpleTextTable(
            rows,
            [
                1800,
                1600,
                1400,
                1700,
                2500,
            ],
            {
                header:
                    true,
            }
        );
    }


    refusalScopeTable(
        scopes
    ) {

        if (!scopes.length) {

            return this.paragraph(
                'Ret kapsamı bulunamadı.',
                {
                    italic:
                        true,
                }
            );
        }


        const rows = [
            [
                'Sınıf',
                'Ret Kapsamı',
                'Ret Talep Edilen Mal / Hizmetler',
            ],

            ...scopes.map(
                scope => [
                    String(
                        scope.classNo ??
                        '-'
                    ),

                    scope.modeLabel ||
                    (
                        scope.mode ===
                        'full_class'

                            ? 'Sınıfın tamamı'

                            : 'Kısmi kapsam'
                    ),

                    scope.text ||
                    '-',
                ]
            ),
        ];


        return this.simpleTextTable(
            rows,
            [
                900,
                1700,
                6400,
            ],
            {
                header:
                    true,
            }
        );
    }


    goodsComparisonTable(
        rows
    ) {

        if (!rows.length) {

            return this.paragraph(
                'Mal/hizmet karşılaştırma satırı bulunamadı.',
                {
                    italic:
                        true,
                }
            );
        }


        const grouped =
            this.groupGoodsComparisons(
                rows
            );


        const tableRows = [
            [
                'İtiraza Konu Sınıf',
                'Müstenit Marka / Dayanılan Sınıflar',
                'Benzerlik',
                'Kriterler',
            ],

            ...grouped.map(
                row => [
                    `Sınıf ${row.opponentClassNo}`,

                    `${row.priorMarkText || '-'}\nSınıf ${row.priorClassNumbers.join(', ') || '-'}`,

                    row.similarityLabel ||
                    row.similarityLevel ||
                    '-',

                    (
                        row.criteriaLabels ||
                        row.criteria ||
                        []
                    ).join(', ') ||
                    '-',
                ]
            ),
        ];


        return this.simpleTextTable(
            tableRows,
            [
                1650,
                3150,
                1400,
                2800,
            ],
            {
                header:
                    true,

                size:
                    18,
            }
        );
    }


    groupGoodsComparisons(
        rows
    ) {

        const groups =
            new Map();


        for (
            const row of
            rows ||
            []
        ) {

            const criteriaLabels =
                [
                    ...new Set(
                        (
                            row.criteriaLabels ||
                            row.criteria ||
                            []
                        ).map(
                            item =>
                                String(
                                    item ?? ''
                                ).trim()
                        ).filter(Boolean)
                    )
                ];


            const key =
                [
                    row.opponentClassNo,
                    row.priorIpRecordId ||
                    row.priorApplicationNo ||
                    row.priorMarkText ||
                    '',
                    row.similarityLevel ||
                    row.similarityLabel ||
                    '',
                    criteriaLabels
                        .slice()
                        .sort()
                        .join('|'),
                ].join('::');


            if (
                !groups.has(
                    key
                )
            ) {

                groups.set(
                    key,
                    {
                        opponentClassNo:
                            row.opponentClassNo,

                        priorMarkText:
                            row.priorMarkText,

                        similarityLevel:
                            row.similarityLevel,

                        similarityLabel:
                            row.similarityLabel,

                        criteria:
                            row.criteria ||
                            [],

                        criteriaLabels,

                        priorClassNumbers:
                            [],
                    }
                );
            }


            const group =
                groups.get(
                    key
                );


            const classNo =
                Number(
                    row.priorClassNo
                );


            if (
                Number.isFinite(
                    classNo
                ) &&
                !group.priorClassNumbers.includes(
                    classNo
                )
            ) {

                group.priorClassNumbers.push(
                    classNo
                );
            }
        }


        return [
            ...groups.values()
        ].map(
            group => ({
                ...group,

                priorClassNumbers:
                    group.priorClassNumbers
                        .sort(
                            (
                                a,
                                b
                            ) =>
                                a - b
                        ),
            })
        );
    }


    petitionParagraphs(
        text
    ) {

        const lines =
            String(
                text ||
                ''
            )
                .split('\n');


        const paragraphs = [];


        for (
            const rawLine of
            lines
        ) {

            const line =
                rawLine.trim();


            if (!line) {

                paragraphs.push(
                    this.paragraph(
                        '',
                        {
                            after:
                                40,
                        }
                    )
                );

                continue;
            }


            if (
                /^\d+\.\s+/.test(
                    line
                ) ||
                (
                    line.length <
                    120 &&
                    line ===
                    line.toLocaleUpperCase(
                        'tr-TR'
                    ) &&
                    /[A-ZÇĞİÖŞÜ]/.test(
                        line
                    )
                )
            ) {

                paragraphs.push(
                    this.paragraph(
                        line,
                        {
                            bold:
                                true,

                            before:
                                140,

                            after:
                                80,

                            size:
                                20,
                        }
                    )
                );

                continue;
            }


            if (
                /^[-•]\s+/.test(
                    line
                )
            ) {

                paragraphs.push(
                    this.bulletParagraph(
                        line.replace(
                            /^[-•]\s+/,
                            ''
                        )
                    )
                );

                continue;
            }


            paragraphs.push(
                this.paragraph(
                    line,
                    {
                        align:
                            'both',

                        after:
                            90,
                    }
                )
            );
        }


        return paragraphs;
    }


    sectionHeading(
        text
    ) {

        return this.paragraph(
            text,
            {
                bold:
                    true,

                color:
                    COLORS.greenDark,

                size:
                    21,

                before:
                    220,

                after:
                    90,

                keepNext:
                    true,

                borderBottom:
                    COLORS.green,
            }
        );
    }


    keyValueTable(
        rows
    ) {

        const contentRows =
            rows.map(
                (
                    [
                        label,
                        value
                    ]
                ) => [

                    {
                        xml:
                            this.paragraph(
                                label,
                                {
                                    bold:
                                        true,

                                    after:
                                        0,
                                }
                            ),

                        shading:
                            COLORS.grayLight,
                    },

                    {
                        xml:
                            this.paragraph(
                                value,
                                {
                                    after:
                                        0,
                                }
                            ),
                    },
                ]
            );


        return this.table(
            contentRows,
            [
                1900,
                BODY_WIDTH -
                1900,
            ],
            {
                after:
                    180,
            }
        );
    }


    simpleTextTable(
        rows,
        widths,
        options = {}
    ) {

        const headerEnabled =
            options.header ===
            true;


        const body =
            rows.map(
                (
                    row,
                    rowIndex
                ) =>
                    row.map(
                        cellText => ({
                            xml:
                                this.multilineCellText(
                                    cellText,
                                    {
                                        bold:
                                            headerEnabled &&
                                            rowIndex ===
                                            0,

                                        color:
                                            headerEnabled &&
                                            rowIndex ===
                                            0

                                                ? COLORS.white

                                                : COLORS.black,

                                        align:
                                            headerEnabled &&
                                            rowIndex ===
                                            0

                                                ? 'center'

                                                : 'left',

                                        size:
                                            options.size ||
                                            18,
                                    }
                                ),

                            shading:
                                headerEnabled &&
                                rowIndex ===
                                0

                                    ? COLORS.green

                                    : (
                                        rowIndex %
                                        2 ===
                                        0

                                            ? COLORS.grayLight

                                            : 'FFFFFF'
                                    ),
                        })
                    )
            );


        return this.table(
            body,
            widths,
            {
                after:
                    120,
            }
        );
    }


    multilineCellText(
        value,
        options = {}
    ) {

        const lines =
            String(
                value ??
                ''
            )
                .split('\n');


        return lines
            .map(
                line =>
                    this.paragraph(
                        line,
                        {
                            bold:
                                options.bold,

                            color:
                                options.color,

                            align:
                                options.align,

                            size:
                                options.size,

                            after:
                                20,
                        }
                    )
            )
            .join('');
    }


    table(
        rows,
        widths,
        options = {}
    ) {

        const totalWidth =
            widths.reduce(
                (
                    sum,
                    value
                ) =>
                    sum +
                    Number(
                        value ||
                        0
                    ),
                0
            );


        const grid =
            widths
                .map(
                    width =>
                        `<w:gridCol w:w="${Math.round(width)}"/>`
                )
                .join('');


        const rowXml =
            rows
                .map(
                    row =>
                        `<w:tr>${row
                            .map(
                                (
                                    cell,
                                    index
                                ) =>
                                    this.tableCell(
                                        cell,
                                        widths[index] ||
                                        (
                                            totalWidth /
                                            Math.max(
                                                row.length,
                                                1
                                            )
                                        )
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
    <w:tblGrid>
        ${grid}
    </w:tblGrid>
    ${rowXml}
</w:tbl>
${this.paragraph('', {
    after:
        options.after ??
        60
})}`;
    }


    tableCell(
        cell,
        width
    ) {

        const normalized =
            typeof cell ===
            'string'

                ? {
                    xml:
                        this.paragraph(
                            cell
                        ),
                }

                : (
                    cell ||
                    {}
                );


        return `
<w:tc>
    <w:tcPr>
        <w:tcW w:w="${Math.round(width)}" w:type="dxa"/>
        ${
            normalized.shading

                ? `<w:shd w:val="clear" w:color="auto" w:fill="${normalized.shading}"/>`

                : ''
        }
        <w:vAlign w:val="center"/>
    </w:tcPr>
    ${
        normalized.xml ||
        this.paragraph('')
    }
</w:tc>`;
    }


    imageOrMarkParagraph(
        image,
        fallbackText
    ) {

        if (!image) {

            return this.paragraph(
                fallbackText ||
                'Görsel bulunamadı',
                {
                    bold:
                        true,

                    italic:
                        true,

                    align:
                        'center',

                    color:
                        COLORS.grayText,

                    size:
                        20,

                    before:
                        100,

                    after:
                        100,
                }
            );
        }


        return `
<w:p>
    <w:pPr>
        <w:jc w:val="center"/>
        <w:spacing w:before="80" w:after="80"/>
    </w:pPr>
    <w:r>
        <w:drawing>
            <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">
                <wp:extent cx="${image.widthEmu}" cy="${image.heightEmu}"/>
                <wp:effectExtent l="0" t="0" r="0" b="0"/>
                <wp:docPr id="${this.docPrCounter++}" name="Marka Görseli"/>
                <wp:cNvGraphicFramePr>
                    <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
                </wp:cNvGraphicFramePr>
                <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                    <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                            <pic:nvPicPr>
                                <pic:cNvPr id="0" name="Marka Görseli"/>
                                <pic:cNvPicPr/>
                            </pic:nvPicPr>
                            <pic:blipFill>
                                <a:blip r:embed="${this.escapeAttribute(image.relationshipId)}"/>
                                <a:stretch>
                                    <a:fillRect/>
                                </a:stretch>
                            </pic:blipFill>
                            <pic:spPr>
                                <a:xfrm>
                                    <a:off x="0" y="0"/>
                                    <a:ext cx="${image.widthEmu}" cy="${image.heightEmu}"/>
                                </a:xfrm>
                                <a:prstGeom prst="rect">
                                    <a:avLst/>
                                </a:prstGeom>
                            </pic:spPr>
                        </pic:pic>
                    </a:graphicData>
                </a:graphic>
            </wp:inline>
        </w:drawing>
    </w:r>
</w:p>`;
    }


    paragraph(
        text,
        options = {}
    ) {

        const alignMap = {
            left:
                'left',

            center:
                'center',

            right:
                'right',

            both:
                'both',
        };


        const paragraphProperties = [
            `<w:spacing w:before="${Number(options.before ?? 0)}" w:after="${Number(options.after ?? 80)}" w:line="276" w:lineRule="auto"/>`,

            options.align
                ? `<w:jc w:val="${alignMap[options.align] || options.align}"/>`
                : '',

            options.keepNext
                ? '<w:keepNext/>'
                : '',

            options.borderBottom
                ? `<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="5" w:color="${options.borderBottom}"/></w:pBdr>`
                : '',
        ]
            .filter(Boolean)
            .join('');


        return `
<w:p>
    <w:pPr>
        ${paragraphProperties}
    </w:pPr>
    ${this.run(
        text,
        options
    )}
</w:p>`;
    }


    bulletParagraph(
        text
    ) {

        return `
<w:p>
    <w:pPr>
        <w:spacing w:before="0" w:after="80" w:line="276" w:lineRule="auto"/>
        <w:ind w:left="360" w:hanging="240"/>
    </w:pPr>
    ${this.run(
        '• ',
        {
            bold:
                true,

            color:
                COLORS.greenDark,
        }
    )}
    ${this.run(
        text,
        {}
    )}
</w:p>`;
    }


    run(
        text,
        options = {}
    ) {

        const value =
            this.escapeXml(
                text
            );


        const properties = [
            '<w:rFonts w:ascii="Poppins" w:hAnsi="Poppins" w:eastAsia="Poppins" w:cs="Poppins"/>',

            options.bold
                ? '<w:b/><w:bCs/>'
                : '',

            options.italic
                ? '<w:i/><w:iCs/>'
                : '',

            `<w:color w:val="${options.color || COLORS.black}"/>`,

            `<w:sz w:val="${Number(options.size || 19)}"/>`,

            `<w:szCs w:val="${Number(options.size || 19)}"/>`,

            '<w:lang w:val="tr-TR"/>',
        ]
            .filter(Boolean)
            .join('');


        return `
<w:r>
    <w:rPr>
        ${properties}
    </w:rPr>
    <w:t xml:space="preserve">${value}</w:t>
</w:r>`;
    }


    formatDate(
        value
    ) {

        if (!value) {

            return '-';
        }


        const date =
            new Date(
                `${String(value).slice(0, 10)}T00:00:00`
            );


        if (
            Number.isNaN(
                date.getTime()
            )
        ) {

            return String(
                value
            );
        }


        return date
            .toLocaleDateString(
                'tr-TR'
            );
    }


    escapeXml(
        value
    ) {

        return String(
            value ??
            ''
        )
            .replace(
                /&/g,
                '&amp;'
            )
            .replace(
                /</g,
                '&lt;'
            )
            .replace(
                />/g,
                '&gt;'
            )
            .replace(
                /"/g,
                '&quot;'
            )
            .replace(
                /'/g,
                '&apos;'
            );
    }


    escapeAttribute(
        value
    ) {

        return this.escapeXml(
            value
        );
    }
}
