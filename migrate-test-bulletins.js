// migrate-test-bulletins.js
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config(); // Varsa .env dosyanızdan anahtarları çekmek için

// TODO: BURAYA KENDİ PROJE BİLGİLERİNİZİ GİRİN
const LIVE_URL = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const LIVE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjE3ODQ0OCwiZXhwIjoyMDg3NzU0NDQ4fQ.WUKhJrBnWNABIZnUj9EF2zKyIsan7M3DCm7Nwu1NeGQ'; 


const TEST_URL = 'https://guicrctynauzxhyfpdfe.supabase.co';
const TEST_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1aWNyY3R5bmF1enhoeWZwZGZlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTcwNDcyNywiZXhwIjoyMDg3MjgwNzI3fQ.Wop3lCBK3XvauYXOEg33TVxv4Cb6KQ8bK28N-sEgu08'; // Service role key kullanın!

const liveDb = createClient(LIVE_URL, LIVE_KEY);
const testDb = createClient(TEST_URL, TEST_KEY);

// Taşınacak bülten ID'leri (Edge function mantığınıza göre 'bulletin_main_486' gibi varyasyonları da kapsıyoruz)
const BULLETIN_IDS_TO_FETCH = ['486', '487', 'bulletin_main_486', 'bulletin_main_487'];

// Yardımcı Fonksiyon: Diziyi parçalara bölmek için (Supabase limitlerine takılmamak adına)
function chunkArray(array, size) {
    const chunked = [];
    let index = 0;
    while (index < array.length) {
        chunked.push(array.slice(index, size + index));
        index += size;
    }
    return chunked;
}

async function migrateBulletins() {
    console.log("🚀 Taşıma işlemi başlıyor...");

    try {
        // ====================================================================
        // 1. trademark_bulletins Tablosunu Taşıma
        // ====================================================================
        console.log("\n📦 1. Bülten Ana Kayıtları Çekiliyor...");
        const { data: bulletins, error: bullErr } = await liveDb
            .from('trademark_bulletins')
            .select('*')
            .in('id', ['486', '487']); // Sizin verdiğiniz JSON'daki ID'ler

        if (bullErr) throw bullErr;
        
        console.log(`   -> ${bulletins.length} bülten bulundu. Test ortamına yazılıyor...`);
        const { error: bullInsertErr } = await testDb
            .from('trademark_bulletins')
            .upsert(bulletins, { onConflict: 'id' });
        
        if (bullInsertErr) throw bullInsertErr;


        // ====================================================================
        // 2. trademark_bulletin_records Tablosunu Taşıma (Döngüsel / Pagination)
        // ====================================================================
        console.log("\n📦 2. Bülten Marka Kayıtları (Records) Çekiliyor...");
        let allRecords = [];
        let start = 0;
        const limit = 1000;

        while (true) {
            const { data: records, error: recErr } = await liveDb
                .from('trademark_bulletin_records')
                .select('*')
                .in('bulletin_id', BULLETIN_IDS_TO_FETCH)
                .range(start, start + limit - 1);

            if (recErr) throw recErr;
            allRecords = allRecords.concat(records);

            if (records.length < limit) break; // Son partiye geldik
            start += limit;
        }

        console.log(`   -> Toplam ${allRecords.length} adet marka kaydı bulundu. Test ortamına parçalar halinde yazılıyor...`);
        const recordChunks = chunkArray(allRecords, 1000);
        for (let i = 0; i < recordChunks.length; i++) {
            const { error: recInsertErr } = await testDb
                .from('trademark_bulletin_records')
                .upsert(recordChunks[i], { onConflict: 'id' });
            if (recInsertErr) throw recInsertErr;
            console.log(`      Yazıldı: Parça ${i + 1}/${recordChunks.length}`);
        }


        // ====================================================================
        // 3. trademark_bulletin_goods Tablosunu Taşıma
        // ====================================================================
        console.log("\n📦 3. Marka Mal ve Hizmetleri (Goods) Çekiliyor...");
        // 10 binlerce kaydı tek bir 'in' sorgusuyla çekemeyiz. Record ID'leri 500'erli bölelim.
        const allRecordIds = allRecords.map(r => r.id);
        const recordIdChunks = chunkArray(allRecordIds, 500);
        
        let allGoods = [];
        
        for (let i = 0; i < recordIdChunks.length; i++) {
            let goodsStart = 0;
            while(true) {
                const { data: goods, error: goodsErr } = await liveDb
                    .from('trademark_bulletin_goods')
                    .select('*')
                    .in('bulletin_record_id', recordIdChunks[i])
                    .range(goodsStart, goodsStart + limit - 1);
                
                if (goodsErr) throw goodsErr;
                allGoods = allGoods.concat(goods);
                
                if (goods.length < limit) break;
                goodsStart += limit;
            }
            console.log(`      Çekiliyor: Parça ${i + 1}/${recordIdChunks.length} - Şu ana kadar bulunan good sayısı: ${allGoods.length}`);
        }

        console.log(`   -> Toplam ${allGoods.length} adet mal/hizmet kaydı bulundu. Test ortamına yazılıyor...`);
        const goodsChunks = chunkArray(allGoods, 1000);
        for (let i = 0; i < goodsChunks.length; i++) {
            const { error: goodsInsertErr } = await testDb
                .from('trademark_bulletin_goods')
                .upsert(goodsChunks[i], { onConflict: 'id' });
            if (goodsInsertErr) throw goodsInsertErr;
            console.log(`      Yazıldı: Parça ${i + 1}/${goodsChunks.length}`);
        }

        console.log("\n✅ TAŞIMA İŞLEMİ BAŞARIYLA TAMAMLANDI!");

    } catch (error) {
        console.error("\n❌ HATA OLUŞTU:", error);
    }
}

migrateBulletins();