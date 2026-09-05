import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { createClient } from '@supabase/supabase-js';

const EMBEDDING_MODEL =
    process.env.GEMINI_EMBEDDING_MODEL ||
    'gemini-embedding-2';

const EMBEDDING_DIMENSION = 768;
const DEFAULT_DELAY_MS = 80;
const DEFAULT_CHUNK_CHARS = 3400;
const DEFAULT_OVERLAP_CHARS = 350;

function parseArgs(argv) {
    const args = {};

    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];

        if (!token.startsWith('--')) {
            continue;
        }

        const key = token.slice(2);
        const next = argv[i + 1];

        if (!next || next.startsWith('--')) {
            args[key] = true;
            continue;
        }

        args[key] = next;
        i += 1;
    }

    return args;
}

function requiredEnv(name) {
    const value = String(process.env[name] || '').trim();

    if (!value) {
        throw new Error(`${name} environment variable bulunamadı.`);
    }

    return value;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function cleanPageText(value) {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/^--\s*\d+\s+of\s+\d+\s*--\s*$/gim, '')
        .replace(/^\s*sayfa\s*\d+\s*(?:\/\s*\d+)?\s*$/gim, '')
        .replace(/\u0000/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}


function firstPrintedPageNumber(pageText) {
    const lines = String(pageText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    // TÜRKPATENT 2021 PDF'sinde basılı sayfa numarası,
    // esas metin sayfalarında ilk satırda yer alıyor.
    for (const line of lines.slice(0, 5)) {
        if (/^\d{1,4}$/.test(line)) {
            const value = Number(line);

            if (Number.isFinite(value) && value > 0) {
                return value;
            }
        }
    }

    return null;
}


function resolveCitationPageNumber(pageText, pdfPageNo, manifest) {
    const printed = firstPrintedPageNumber(pageText);

    if (printed !== null) {
        return printed;
    }

    const offset = Number(
        manifest?.citation_page_offset ?? 0
    );

    const calculated = pdfPageNo + (
        Number.isFinite(offset) ? offset : 0
    );

    return calculated > 0
        ? calculated
        : pdfPageNo;
}


function stripLeadingPrintedPageNumber(pageText, citationPageNo) {
    const lines = String(pageText || '').split('\n');

    let removed = false;

    const cleaned = lines.filter(line => {
        if (removed) {
            return true;
        }

        const normalized = line.trim();

        if (
            citationPageNo &&
            normalized === String(citationPageNo)
        ) {
            removed = true;
            return false;
        }

        // İlk boş satırlar korunmak zorunda değil.
        if (!normalized) {
            return false;
        }

        return true;
    });

    return cleaned.join('\n').trim();
}

function looksLikeHeading(line) {
    const text = String(line || '').trim();

    if (!text || text.length > 180) {
        return false;
    }

    // Dipnot / kaynak satırları başlık değildir.
    // Örn: "123 Ibid.", "124 Çolak Uğur, ..."
    if (/^\d{1,3}\s+\S+/.test(text)) {
        return false;
    }

    // Gövde cümlelerinde sık geçen "SMK 6/1 uyarınca..." gibi
    // ifadeler section heading değildir.
    if (/^SMK\s+\d+(?:\/\d+)?\s+(?:uyarınca|kapsamında|anlamında)\b/i.test(text)) {
        return false;
    }

    // Hiyerarşik numaralı başlıklar: 2.1, 2.4.43, 5.2.1 vb.
    if (/^\d+(?:\.\d+)+\.?\s+\S+/.test(text)) {
        // PDF satır kırılması nedeniyle gövde içindeki bir çapraz atıf
        // yanlışlıkla satır başına taşınabilir.
        // Örn: "2.4.45 Hammaddeler ... ) Örneğin, ..."
        // Bu tip satırlar bölüm başlığı değildir.
        if (
            /Örneğin/i.test(text) ||
            /\bbkz\.?\b/i.test(text) ||
            /\bIbid\.?\b/i.test(text) ||
            /\bnaklen\b/i.test(text)
        ) {
            return false;
        }

        return !/[.!?;:]$/.test(text);
    }

    // Ana başlıklar: 1. GİRİŞ, 2. MALLARIN-HİZMETLERİN ...
    if (/^\d+\.\s+\S+/.test(text)) {
        const letters = text.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü]/g, '');
        const upper = letters.toLocaleUpperCase('tr-TR');
        const uppercaseRatio = letters.length
            ? [...letters].filter((char, index) => char === [...upper][index]).length / letters.length
            : 0;

        return uppercaseRatio >= 0.75 && !/[.!?;:]$/.test(text);
    }

    if (/^(?:BÖLÜM|KISIM|ALT BÖLÜM|MADDE\s+\d)/i.test(text)) {
        return true;
    }

    // Belge / ana bölüm başlıkları gibi tamamı büyük harfli satırlar.
    const letters = text.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü]/g, '');

    if (letters.length >= 8) {
        const upper = letters.toLocaleUpperCase('tr-TR');
        if (letters === upper && !/[.!?;:]$/.test(text)) {
            return true;
        }
    }

    return false;
}

function detectSectionTitle(pageText, previousHeading = null) {
    const lines = String(pageText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    let heading = previousHeading;

    // İlk 35 satır yeterli; yeni bölüm başlıkları tipik olarak sayfanın
    // üst bölümünde yer alıyor. Son geçerli başlık en spesifik olanıdır.
    for (const line of lines.slice(0, 35)) {
        if (looksLikeHeading(line)) {
            heading = line;
        }
    }

    return heading;
}

function splitLargeParagraph(text, maxChars) {
    const normalized = String(text || '').trim();

    if (normalized.length <= maxChars) {
        return [normalized];
    }

    const sentences = normalized
        .split(/(?<=[.!?;:])\s+(?=[A-ZÇĞİÖŞÜ0-9])/)
        .map(item => item.trim())
        .filter(Boolean);

    if (sentences.length <= 1) {
        const parts = [];
        for (let index = 0; index < normalized.length; index += maxChars) {
            parts.push(normalized.slice(index, index + maxChars));
        }
        return parts;
    }

    const parts = [];
    let current = '';

    for (const sentence of sentences) {
        const candidate = current
            ? `${current} ${sentence}`
            : sentence;

        if (candidate.length > maxChars && current) {
            parts.push(current);
            current = sentence;
        } else {
            current = candidate;
        }
    }

    if (current) {
        parts.push(current);
    }

    return parts;
}

function chunkPageText(pageText, options = {}) {
    const maxChars = Number(options.maxChars || DEFAULT_CHUNK_CHARS);
    const overlapChars = Number(options.overlapChars || DEFAULT_OVERLAP_CHARS);

    const paragraphs = String(pageText || '')
        .split(/\n{2,}/)
        .flatMap(paragraph => splitLargeParagraph(paragraph, maxChars))
        .map(item => item.trim())
        .filter(item => item.length >= 80);

    if (!paragraphs.length && String(pageText || '').trim().length >= 80) {
        paragraphs.push(String(pageText).trim());
    }

    const chunks = [];
    let current = '';

    const pushCurrent = () => {
        const text = current.trim();
        if (!text) return;
        chunks.push(text);
    };

    for (const paragraph of paragraphs) {
        const candidate = current
            ? `${current}\n\n${paragraph}`
            : paragraph;

        if (candidate.length > maxChars && current) {
            pushCurrent();

            const tail = current.slice(
                Math.max(0, current.length - overlapChars)
            ).trim();

            current = tail
                ? `${tail}\n\n${paragraph}`
                : paragraph;
        } else {
            current = candidate;
        }
    }

    pushCurrent();

    return chunks;
}

function quoteSafeFor(text) {
    const value = String(text || '');

    return (
        value.length >= 150 &&
        !value.includes('�') &&
        (value.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length >= 80
    );
}

async function generateEmbedding(apiKey, sourceTitle, sectionTitle, pageNo, content) {
    const preparedText = [
        `title: ${sourceTitle}`,
        sectionTitle ? `section: ${sectionTitle}` : null,
        pageNo ? `page: ${pageNo}` : null,
        `text: ${content}`,
    ]
        .filter(Boolean)
        .join(' | ');

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
                model: `models/${EMBEDDING_MODEL}`,
                content: {
                    parts: [
                        {
                            text: preparedText,
                        },
                    ],
                },
                outputDimensionality: EMBEDDING_DIMENSION,
            }),
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            `Gemini embedding hatası (${response.status}): ${data?.error?.message || JSON.stringify(data)}`
        );
    }

    const vector = data?.embedding?.values;

    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSION) {
        throw new Error(
            `Embedding boyutu geçersiz. Beklenen ${EMBEDDING_DIMENSION}, gelen ${Array.isArray(vector) ? vector.length : 'yok'}.`
        );
    }

    return vector;
}

function normalizeManifest(raw, filePath) {
    const manifest = {
        ...raw,
    };

    const required = ['source_key', 'title', 'source_type'];

    for (const key of required) {
        if (!String(manifest[key] || '').trim()) {
            throw new Error(`Manifest alanı zorunlu: ${key}`);
        }
    }

    manifest.file_name =
        manifest.file_name ||
        path.basename(filePath);

    manifest.verified = manifest.verified === true;
    manifest.citable = manifest.citable !== false;

    return manifest;
}

async function upsertSource(supabase, manifest, fileSha256) {
    const payload = {
        source_key: manifest.source_key,
        title: manifest.title,
        source_type: manifest.source_type,
        authority: manifest.authority || null,
        jurisdiction: manifest.jurisdiction || null,
        court: manifest.court || null,
        chamber: manifest.chamber || null,
        case_no: manifest.case_no || null,
        decision_no: manifest.decision_no || null,
        decision_date: manifest.decision_date || null,
        publication_date: manifest.publication_date || null,
        version_label: manifest.version_label || null,
        source_url: manifest.source_url || null,
        file_name: manifest.file_name || null,
        file_sha256: fileSha256,
        citation_label: manifest.citation_label || null,
        verified: manifest.verified === true,
        citable: manifest.citable !== false,
        status: 'processing',
        metadata: {
            ...(manifest.metadata || {}),
            ingest_package: '6.0.4',
            ingest_started_at: new Date().toISOString(),
        },
    };

    const { data, error } = await supabase
        .from('legal_sources')
        .upsert(payload, {
            onConflict: 'source_key',
        })
        .select('id, source_key, title')
        .single();

    if (error) {
        throw new Error(`legal_sources upsert hatası: ${error.message}`);
    }

    return data;
}

async function markSourceStatus(supabase, sourceId, status, metadataPatch = {}) {
    const { data: current } = await supabase
        .from('legal_sources')
        .select('metadata')
        .eq('id', sourceId)
        .maybeSingle();

    const { error } = await supabase
        .from('legal_sources')
        .update({
            status,
            metadata: {
                ...(current?.metadata || {}),
                ...metadataPatch,
            },
        })
        .eq('id', sourceId);

    if (error) {
        throw new Error(`Kaynak status güncellenemedi: ${error.message}`);
    }
}

async function replaceChunks({
    supabase,
    apiKey,
    parser,
    totalPages,
    pdfPageFrom,
    pdfPageTo,
    source,
    manifest,
    delayMs,
    chunkChars,
    overlapChars,
    dryRun,
}) {
    if (!dryRun) {
        const { error: deleteError } = await supabase
            .from('legal_source_chunks')
            .delete()
            .eq('source_id', source.id);

        if (deleteError) {
            throw new Error(`Eski legal_source_chunks silinemedi: ${deleteError.message}`);
        }
    }

    let chunkIndex = 0;
    let currentHeading = manifest.default_section || null;
    let inserted = 0;

    for (
        let pdfPageNo = pdfPageFrom;
        pdfPageNo <= pdfPageTo;
        pdfPageNo += 1
    ) {
        const result = await parser.getText({
            partial: [pdfPageNo],
        });

        const rawPageText = cleanPageText(
            result?.text || ''
        );

        if (!rawPageText || rawPageText.length < 50) {
            console.warn(
                `[PDF ${pdfPageNo}] Metin çok kısa; atlandı.`
            );
            continue;
        }

        const citationPageNo =
            resolveCitationPageNumber(
                rawPageText,
                pdfPageNo,
                manifest
            );

        // Basılı sayfa numarası chunk metninin içine girmesin.
        const pageText =
            stripLeadingPrintedPageNumber(
                rawPageText,
                citationPageNo
            );

        currentHeading =
            detectSectionTitle(
                pageText,
                currentHeading
            );

        const chunks = chunkPageText(pageText, {
            maxChars: chunkChars,
            overlapChars,
        });

        console.log(
            `[PDF ${pdfPageNo}/${totalPages} | Kılavuz s. ${citationPageNo}] ` +
            `${chunks.length} chunk | Bölüm: ${currentHeading || '-'}`
        );

        for (const chunk of chunks) {
            const embedding = dryRun
                ? Array(EMBEDDING_DIMENSION).fill(0)
                : await generateEmbedding(
                    apiKey,
                    manifest.title,
                    currentHeading,
                    citationPageNo,
                    chunk
                );

            const row = {
                source_id: source.id,
                chunk_index: chunkIndex,
                page_from: citationPageNo,
                page_to: citationPageNo,
                section_title: currentHeading,
                article_number: null,
                heading_path: currentHeading ? [currentHeading] : [],
                content: chunk,
                quote_safe: quoteSafeFor(chunk),
                embedding,
                metadata: {
                    ingest_package: '6.0.4',
                    page_number: citationPageNo,
                    citation_page_number: citationPageNo,
                    pdf_page_number: pdfPageNo,
                    source_key: manifest.source_key,
                },
            };

            if (!dryRun) {
                const { error } = await supabase
                    .from('legal_source_chunks')
                    .insert(row);

                if (error) {
                    throw new Error(
                        `Chunk insert hatası (PDF ${pdfPageNo} / kılavuz s. ${citationPageNo}, chunk ${chunkIndex}): ${error.message}`
                    );
                }
            }

            inserted += 1;
            chunkIndex += 1;

            if (!dryRun && delayMs > 0) {
                await sleep(delayMs);
            }
        }
    }

    return inserted;
}

async function main() {
    const args = parseArgs(process.argv);

    const filePath = path.resolve(String(args.file || ''));
    const manifestPath = path.resolve(String(args.manifest || ''));
    const dryRun = args['dry-run'] === true;

    if (!args.file || !fs.existsSync(filePath)) {
        throw new Error('--file ile mevcut bir PDF dosyası belirtin.');
    }

    if (!args.manifest || !fs.existsSync(manifestPath)) {
        throw new Error('--manifest ile mevcut bir JSON manifest dosyası belirtin.');
    }

    if (path.extname(filePath).toLowerCase() !== '.pdf') {
        throw new Error('Paket 6.0 ingest script ilk sürümde PDF kaynakları kabul eder.');
    }

    const manifest = normalizeManifest(
        JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
        filePath
    );

    const delayMs = Math.max(
        0,
        Number(args['delay-ms'] || DEFAULT_DELAY_MS)
    );

    const chunkChars = Math.max(
        1200,
        Number(args['chunk-chars'] || DEFAULT_CHUNK_CHARS)
    );

    const overlapChars = Math.max(
        0,
        Math.min(
            Math.floor(chunkChars / 3),
            Number(args['overlap-chars'] || DEFAULT_OVERLAP_CHARS)
        )
    );

    const supabaseUrl = dryRun
        ? 'https://dry-run.invalid'
        : requiredEnv('SUPABASE_URL');

    const serviceRoleKey = dryRun
        ? 'dry-run'
        : requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

    const apiKey = dryRun
        ? 'dry-run'
        : requiredEnv('GEMINI_API_KEY');

    const supabase = createClient(
        supabaseUrl,
        serviceRoleKey,
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        }
    );

    const fileSha256 = sha256File(filePath);
    const pdfBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: pdfBuffer });

    let source = null;

    try {
        const info = await parser.getInfo({ parsePageInfo: true });
        const totalPages = Number(info?.total || info?.pages?.length || 0);

        if (!Number.isFinite(totalPages) || totalPages < 1) {
            throw new Error('PDF toplam sayfa sayısı tespit edilemedi.');
        }

        const manifestPageFrom = Number(
            manifest.pdf_page_from ?? 1
        );

        const manifestPageTo = Number(
            manifest.pdf_page_to ?? totalPages
        );

        const argPageFrom = Number(
            args['start-page'] ?? manifestPageFrom
        );

        const argPageTo = Number(
            args['end-page'] ?? manifestPageTo
        );

        const pdfPageFrom = Math.max(
            1,
            Number.isFinite(argPageFrom)
                ? Math.floor(argPageFrom)
                : 1
        );

        const pdfPageTo = Math.min(
            totalPages,
            Number.isFinite(argPageTo)
                ? Math.floor(argPageTo)
                : totalPages
        );

        if (pdfPageFrom > pdfPageTo) {
            throw new Error(
                `Geçersiz PDF sayfa aralığı: ${pdfPageFrom}-${pdfPageTo}.`
            );
        }

        console.log('=========================================================');
        console.log('EVREKA PAKET 6.0.4 - LEGAL SOURCE INGEST');
        console.log(`Kaynak: ${manifest.title}`);
        console.log(`Tür: ${manifest.source_type}`);
        console.log(`PDF toplam sayfa: ${totalPages}`);
        console.log(`İndekslenecek PDF aralığı: ${pdfPageFrom}-${pdfPageTo}`);
        console.log(`Citation page offset fallback: ${manifest.citation_page_offset ?? 0}`);
        console.log(`Verified: ${manifest.verified}`);
        console.log(`Citable: ${manifest.citable}`);
        console.log(`SHA-256: ${fileSha256}`);
        console.log(`Dry run: ${dryRun}`);
        console.log('=========================================================');

        if (dryRun) {
            source = {
                id: '00000000-0000-0000-0000-000000000000',
                source_key: manifest.source_key,
                title: manifest.title,
            };
        } else {
            source = await upsertSource(supabase, manifest, fileSha256);
        }

        const inserted = await replaceChunks({
            supabase,
            apiKey,
            parser,
            totalPages,
            pdfPageFrom,
            pdfPageTo,
            source,
            manifest,
            delayMs,
            chunkChars,
            overlapChars,
            dryRun,
        });

        if (!dryRun) {
            await markSourceStatus(
                supabase,
                source.id,
                'ready',
                {
                    ingest_completed_at: new Date().toISOString(),
                    total_pages: totalPages,
                    indexed_pdf_page_from: pdfPageFrom,
                    indexed_pdf_page_to: pdfPageTo,
                    indexed_page_count: (pdfPageTo - pdfPageFrom) + 1,
                    citation_page_offset_fallback:
                        manifest.citation_page_offset ?? 0,
                    total_chunks: inserted,
                    file_sha256: fileSha256,
                }
            );
        }

        console.log('=========================================================');
        console.log(`TAMAMLANDI. Toplam chunk: ${inserted}`);
        console.log('=========================================================');
    } catch (error) {
        if (!dryRun && source?.id) {
            try {
                await markSourceStatus(
                    supabase,
                    source.id,
                    'error',
                    {
                        ingest_failed_at: new Date().toISOString(),
                        ingest_error: error instanceof Error ? error.message : String(error),
                    }
                );
            } catch {
                // İkinci hata asıl hatayı maskelemesin.
            }
        }

        throw error;
    } finally {
        if (typeof parser.destroy === 'function') {
            await parser.destroy();
        }
    }
}

main().catch(error => {
    console.error('\nKRİTİK HATA:', error);
    process.exit(1);
});
