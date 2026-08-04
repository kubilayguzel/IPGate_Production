const fs = require('fs');
const { PDFParse } = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');

// --- AYARLAR ---
const SUPABASE_URL = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjE3ODQ0OCwiZXhwIjoyMDg3NzU0NDQ4fQ.WUKhJrBnWNABIZnUj9EF2zKyIsan7M3DCm7Nwu1NeGQ';
const GEMINI_API_KEY = 'AQ.Ab8RN6LrzzO4JqrPEdZGwBctz_ETkSjBd7PXoNataliPYJYEzg';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function generateEmbedding(text) {
    // 🔥 YENİ MİMARİ: Google'ın önerdiği belge bağlam formatı
    const preparedText = `title: TÜRKPATENT Karıştırılma İhtimali Kılavuzu | text: ${text}`;

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${GEMINI_API_KEY}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'models/gemini-embedding-2',
                content: {
                    parts: [
                        {
                            text: preparedText
                        }
                    ]
                },
                // 🔥 ÇOK KRİTİK: Alt tire olmadan camelCase yazılmalı!
                outputDimensionality: 768
            })
        }
    );

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            `Gemini API hatası (${response.status}): ${JSON.stringify(data)}`
        );
    }

    const vector = data?.embedding?.values;

    if (!Array.isArray(vector)) {
        throw new Error(
            `Gemini geçerli embedding döndürmedi: ${JSON.stringify(data)}`
        );
    }

    if (vector.length !== 768) {
        throw new Error(
            `Embedding boyutu hatalı. Beklenen: 768, Gelen: ${vector.length}`
        );
    }

    return vector;
}

async function readPdf(pdfPath) {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const parser = new PDFParse({ data: pdfBuffer });
    
    try {
        const result = await parser.getText();
        return result.text;
    } finally {
        if (typeof parser.destroy === 'function') {
            await parser.destroy();
        }
    }
}

async function main() {
    try {
        console.log("1. 700 sayfalık dev PDF okunuyor...");
        const pdfText = await readPdf('kilavuz.pdf');
        console.log(`PDF başarıyla okundu. Toplam Karakter: ${pdfText.length}`);

        console.log("2. Metin paragraflara bölünüyor...");
        const paragraphs = pdfText.split('\n\n').filter(p => p.trim().length > 100);
        console.log(`Toplam ${paragraphs.length} anlamlı paragraf bulundu. Yükleme başlıyor...`);

        console.log("3. Vektörler oluşturuluyor ve Supabase'e yükleniyor...");
        for (let i = 0; i < paragraphs.length; i++) {
            const chunk = paragraphs[i].trim();
            
            try {
                const vector = await generateEmbedding(chunk);

                const { error } = await supabase
                    .from('knowledge_base')
                    .insert({
                        content: chunk,
                        // Daha sonra aramalarda filtreleme yapabilmek için kaynak belirttik
                        metadata: { source: 'turkpatent_kilavuz', document_title: 'TÜRKPATENT Karıştırılma İhtimali Kılavuzu', chunk_index: i },
                        embedding: vector
                    });

                if (error) throw error;
                console.log(`[${i+1}/${paragraphs.length}] Başarıyla yüklendi.`);
            } catch (err) {
                console.error(`Hata (Paragraf ${i+1}):`, err.message);
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log("🎉 İŞLEM TAMAMLANDI! Tüm TÜRKPATENT kılavuzu yeni mimariyle indekslendi.");

    } catch (error) {
        console.error("İşlem sırasında kritik bir hata oluştu:", error);
        process.exit(1);
    }
}

main();