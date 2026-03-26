import { supabase } from '../../supabase-config.js';

console.log(">>> run-search.js modülü yüklendi (Realtime/WebSocket Versiyonu) <<<");

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
        // İşçilerin (workers) yüzdelerini hafızada tutarak veritabanına sormadan ortalama hesaplayacağız
        const workerProgressMap = new Map();
        let currentResultsCount = 0;

        // 🔥 1. SUPABASE REALTIME (CANLI) KANALINI OLUŞTUR
        const channel = supabase.channel(`progress-${jobId}`);

        // İşçilerin (Workers) ilerlemesini anlık dinle
        channel.on('postgres_changes', {
            event: '*', // INSERT ve UPDATE'leri anında yakala
            schema: 'public',
            table: 'search_progress_workers',
            filter: `job_id=eq.${jobId}`
        }, (payload) => {
            const newRecord = payload.new;
            if (newRecord && newRecord.id) {
                // Hangi işçi yüzde kaça geldi lokal hafızaya yaz
                workerProgressMap.set(newRecord.id, newRecord.progress || 0);
                
                // Ortalama ilerlemeyi anlık hesapla (Sıfır veritabanı yorgunluğu!)
                const totalProgress = Array.from(workerProgressMap.values()).reduce((a, b) => a + b, 0);
                const avgProgress = workerProgressMap.size > 0 ? Math.floor(totalProgress / workerProgressMap.size) : 0;

                if (onProgress) {
                    onProgress({ 
                        status: 'processing', 
                        progress: avgProgress, 
                        currentResults: currentResultsCount 
                    });
                }
            }
        });

        // Ana görevin (Job) bitişini ve toplam tespit edilen marka sayısını dinle
        channel.on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'search_progress',
            filter: `id=eq.${jobId}`
        }, (payload) => {
            const newRecord = payload.new;
            
            if (newRecord.current_results !== undefined) {
                currentResultsCount = newRecord.current_results;
            }

            if (newRecord.status === 'completed') {
                if (onProgress) {
                    onProgress({ 
                        status: 'fetching_results', 
                        progress: 100, 
                        currentResults: currentResultsCount,
                        message: 'Arama tamamlandı, veriler derleniyor...'
                    });
                }
                
                clearInterval(fallbackInterval);
                supabase.removeChannel(channel);
                resolve(true); // Veriyi artık loadDataFromCache çektiği için sadece true dönüyoruz
            } 
            else if (newRecord.status === 'failed' || newRecord.status === 'error') {
                clearInterval(fallbackInterval);
                supabase.removeChannel(channel);
                reject(new Error(newRecord.error_message || "Arama arka planda başarısız oldu."));
            }
        });

        // Kanala Abone Ol
        channel.subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                console.log(`✅ Realtime kanalına başarıyla abone olundu. Kesintisiz veri akışı başladı: ${jobId}`);
            }
        });

        // 🔥 2. GÜVENLİK AĞI VE POLLING (FALLBACK)
        // Kurum ağlarında WebSocket (Realtime) engellenebildiği için,
        // ilerleme durumunu klasik yöntemle (HTTP Polling) her 2 saniyede bir çekip arayüzü güncelliyoruz!
        const fallbackInterval = setInterval(async () => {
            // 1. Ana Job durumunu kontrol et
            const { data: jobData } = await supabase.from('search_progress').select('status, current_results').eq('id', jobId).single();
            
            if (jobData) {
                currentResultsCount = jobData.current_results || currentResultsCount;
                
                // 2. Eğer iş bitmediyse, işçilerin (workers) durumunu çekip ilerlemeyi (progress) hesapla
                if (jobData.status !== 'completed' && jobData.status !== 'failed' && jobData.status !== 'error') {
                    const { data: workers } = await supabase.from('search_progress_workers').select('progress').eq('job_id', jobId);
                    if (workers && workers.length > 0) {
                        const totalProgress = workers.reduce((sum, w) => sum + (w.progress || 0), 0);
                        const avgProgress = Math.floor(totalProgress / workers.length);
                        
                        // 🔥 Arayüzdeki Progress Bar'ı Güncelle!
                        if (onProgress) {
                            onProgress({ 
                                status: 'processing', 
                                progress: avgProgress, 
                                currentResults: currentResultsCount 
                            });
                        }
                    }
                }

                // 3. İş bitmişse arayüzü sonuca yönlendir
                if (jobData.status === 'completed') {
                    if (onProgress) {
                        onProgress({ 
                            status: 'fetching_results', 
                            progress: 100, 
                            currentResults: currentResultsCount,
                            message: 'Arama tamamlandı, veriler derleniyor...'
                        });
                    }
                    clearInterval(fallbackInterval);
                    supabase.removeChannel(channel);
                    resolve(true);
                } else if (jobData.status === 'failed' || jobData.status === 'error') {
                    clearInterval(fallbackInterval);
                    supabase.removeChannel(channel);
                    reject(new Error("Arama işlemi başarısız oldu."));
                }
            }
        }, 2000); // Daha akıcı bir UI için 3 saniye yerine 2 saniyeye düşürüldü
    });
}