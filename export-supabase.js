const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// Kendi Supabase bilgilerinizi buraya girin
const SUPABASE_URL = 'https://guicrctynauzxhyfpdfe.supabase.co'; 
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1aWNyY3R5bmF1enhoeWZwZGZlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTcwNDcyNywiZXhwIjoyMDg3MjgwNzI3fQ.Wop3lCBK3XvauYXOEg33TVxv4Cb6KQ8bK28N-sEgu08'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function exportAllSamples() {
    console.log("🚀 Supabase'den tüm tabloların listesi çekiliyor...");

    // 1. Az önce oluşturduğumuz SQL fonksiyonunu çağırarak tüm tabloları alıyoruz
    const { data: tablesData, error: tableError } = await supabase.rpc('get_all_tables');

    if (tableError) {
        console.error("❌ Tablo listesi alınamadı. SQL Editor'de fonksiyonu oluşturduğunuzdan emin olun!", tableError.message);
        return;
    }

    const tablesToExport = tablesData.map(t => t.table_name);
    console.log(`📋 Toplam ${tablesToExport.length} tablo bulundu:\n`, tablesToExport.join(', '));

    const sampleData = {};

    // 2. Her bir tabloyu dönüp 4'er satır örnek çekiyoruz
    for (const table of tablesToExport) {
        console.log(`⏳ [${table}] tablosundan 4 örnek satır çekiliyor...`);
        const { data, error } = await supabase
            .from(table)
            .select('*')
            .limit(4);

        if (error) {
            console.log(`❌ [${table}] okunamadı: ${error.message}`);
        } else {
            sampleData[table] = data;
        }
    }

    // 3. Dosyaya yazdırıyoruz
    fs.writeFileSync('supabase_all_tables_sample.json', JSON.stringify(sampleData, null, 4), 'utf-8');
    console.log("\n🎉 İŞLEM TAMAM! Tüm veriler 'supabase_all_tables_sample.json' dosyasına kaydedildi.");
}

exportAllSamples().catch(console.error);