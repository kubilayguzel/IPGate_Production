import { supabase } from '../../supabase-config.js';

console.log(">>> run-search.js modülü yüklendi (Supabase & 100% Tamamlanmış Versiyon) <<<");

export async function runTrademarkSearch(monitoredMarks, selectedBulletinId, onProgress) {
    try {
        console.log('🚀 Supabase Edge Function tetikleniyor...', { monitoredMarks: monitoredMarks.length, selectedBulletinId });

        const { data, error } = await supabase.functions.invoke('perform-trademark-similarity-search', {
            body: { monitoredMarks, selectedBulletinId }
        });

        if (error) {
            console.error("❌ Edge Function Hatası:", error);
            throw new Error("Arama başlatılamadı: " + error.message);
        }

        if (!data || !data.success || !data.jobId) {
            throw new Error('Job başlatılamadı veya jobId dönmedi.');
        }

        const jobId = data.jobId;
        console.log(`✅ İş başlatıldı, Job ID: ${jobId}`);

        return await monitorSearchProgress(jobId, onProgress);

    } catch (error) {
        console.error('Arama başlatma hatası:', error);
        throw error;
    }
}

async function monitorSearchProgress(jobId, onProgress) {
    return new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
            try {
                // 1. Ana İş Durumunu Kontrol Et
                const { data: mainData, error: mainError } = await supabase
                    .from('search_progress')
                    .select('status, current_results, total_records, error_message')
                    .eq('id', jobId)
                    .single();

                if (mainError) throw mainError;

                if (mainData.status === 'processing' || mainData.status === 'started') {
                    
                    // İşçilerin % ilerlemesini al
                    const { data: workersData } = await supabase
                        .from('search_progress_workers')
                        .select('progress')
                        .eq('job_id', jobId);

                    let avgProgress = 0;
                    if (workersData && workersData.length > 0) {
                        const totalProgress = workersData.reduce((sum, w) => sum + (w.progress || 0), 0);
                        avgProgress = Math.floor(totalProgress / workersData.length); 
                    }

                    if (onProgress) {
                        onProgress({ 
                            status: 'processing', 
                            progress: avgProgress, 
                            currentResults: mainData.current_results || 0 
                        });
                    }
                } 
                else if (mainData.status === 'completed') {
                    // 🔥 İŞ BİTTİĞİNDE BURASI ÇALIŞIR VE SONUÇLARI İNDİRİR
                    clearInterval(interval);
                    
                    if (onProgress) {
                        onProgress({ 
                            status: 'fetching_results', 
                            progress: 100, 
                            currentResults: mainData.current_results || 0,
                            message: 'Sonuçlar arayüze yükleniyor...'
                        });
                    }
                    
                    const results = await fetchResults(jobId, onProgress);
                    resolve(results); // Sonuçları performSearch (trademark-similarity-search.js) fonksiyonuna yollar
                } 
                else if (mainData.status === 'failed' || mainData.status === 'error') {
                    clearInterval(interval);
                    reject(new Error(mainData.error_message || "Arama işlemi başarısız oldu."));
                }
            } catch (err) {
                clearInterval(interval);
                reject(err);
            }
        }, 2000); // 2 saniyede bir durumu kontrol et
    });
}

async function fetchResults(jobId, onProgress) {
    let allResults = [];
    let offset = 0;
    const limit = 20000;
    let hasMore = true;

    while (hasMore) {
        // 🔥 VERİTABANINDAN ÇEK
        const { data, error } = await supabase
            .from('search_progress_results')
            .select('*')
            .eq('job_id', jobId)
            .order('id', { ascending: true }) 
            .range(offset, offset + limit - 1);

        if (error) {
            console.error("Sonuçları çekerken hata:", error);
            throw error;
        }

        if (data && data.length > 0) {
            // 🔥 ÇEVİRMEN: Veritabanındaki alt_tireli isimleri, arayüzün anladığı camelCase formata çevir
            const mappedData = data.map(item => ({
                id: item.id,
                objectID: item.id,
                jobId: item.job_id,
                monitoredTrademarkId: item.monitored_trademark_id,
                markName: item.similar_mark_name || item.mark_name, // Kalıcı veya Geçici tablodan gelmesine göre
                applicationNo: item.similar_application_no || item.application_no,
                applicationDate: item.application_date,
                niceClasses: item.nice_classes,
                similarityScore: item.similarity_score,
                holders: item.holders,
                imagePath: item.image_path,
                // 🔥 DÜZELTME 3: Yeni arama sonuçlarında da bu alanı netleştirelim
                isSimilar: false
            }));
            
            allResults = allResults.concat(mappedData);
            offset += limit;
            
            if (onProgress) {
                 onProgress({
                     status: 'downloading',
                     message: `Arayüze yükleniyor... (${allResults.length} kayıt eklendi)`
                 });
            }
            
        } else {
            hasMore = false; // Veri kalmadı, döngüden çık
        }
    }

    return allResults;
}