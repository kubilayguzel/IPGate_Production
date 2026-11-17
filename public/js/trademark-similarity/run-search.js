import { supabase } from '../../supabase-config.js';

// IPGate 13.11.2026 - Marka Bülteni taraması
// Worker'ları Edge Function'ın kendi kendine 50'lik çağrılar yapması yerine
// arayüz kontrollü, checkpoint'li ve tekrar çalıştırılabilir parçalara ayırır.
// Sonuçlar her parçada monitoring_trademark_records tablosuna KALICI kaydedilir.

const FUNCTION_NAME = 'perform-trademark-similarity-search';
const MAX_TRANSIENT_ERRORS = 8;
const MAX_JOB_MILLISECONDS = 60 * 60 * 1000;
// Worker paket boyutu backend'de SABİT 35'tir.
// Eleme ve skor hesaplamasına dokunulmaz; istemci paket boyu önermez.
let activeSearch = null;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const storageKey = (bulletinId) => `ipgate:trademark-search-job:${String(bulletinId)}`;

const getStored = (key) => {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch (_) { return null; }
};
const store = (key, value) => {
    try {
        if (value) localStorage.setItem(key, JSON.stringify(value));
        else localStorage.removeItem(key);
    } catch (error) { console.warn('[Marka taraması] İş devam bilgisi tarayıcıda saklanamadı:', error); }
};

function payloadFingerprint(marks) {
    // Tekrar girişte eski veya farklı kriterli bir iş yanlışlıkla sürdürülmesin.
    let hash = 2166136261;
    for (const mark of marks) {
        const identity = JSON.stringify([
            mark.id, mark.searchMarkName, mark.markName, mark.brandTextSearch,
            mark.niceClassSearch, mark.niceClasses, mark.applicationDate,
            mark.criteriaVersion
        ]);
        for (let i = 0; i < identity.length; i++) {
            hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619) >>> 0;
        }
    }
    return `${marks.length}:${hash.toString(16)}`;
}

async function invokeSearch(body) {
    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body });
    if (error) throw new Error(error.message || String(error));
    if (data?.state === 'failed') return data;
    if (!data || data.success !== true) throw new Error(data?.error || 'Arama servisi başarısız yanıt verdi.');
    return data;
}

async function searchRun(monitoredMarks, selectedBulletinId, onProgress) {
    if (!Array.isArray(monitoredMarks) || !monitoredMarks.length) throw new Error('İzleme listesi boş.');
    const key = storageKey(selectedBulletinId);
    const fingerprint = payloadFingerprint(monitoredMarks);
    const saved = getStored(key);
    let job = null;

    if (saved?.jobId && saved?.fingerprint === fingerprint) {
        try {
            const previous = await invokeSearch({
                action: 'resume', jobId: saved.jobId, selectedBulletinId
            });
            if (previous.status === 'processing' &&
                Number(previous.monitoredMarkCount) === monitoredMarks.length) {
                job = previous;
                console.info('[Marka taraması] Kesilmiş arama kaldığı yerden sürdürülüyor:', previous.jobId);
            }
        } catch (resumeError) {
            console.warn('[Marka taraması] Önceki arama sürdürülemedi, yeni iş açılıyor:', resumeError);
        }
    }

    if (!job) {
        store(key, null);
        job = await invokeSearch({
            action: 'start', monitoredMarks, selectedBulletinId
        });
    }
    if (!job.jobId || Number(job.monitoredMarkCount) !== monitoredMarks.length ||
        !Array.isArray(job.workerIds) || !job.workerIds.length) {
        throw new Error('Arama başlatma yanıtı eksik; iş başarıyla başlatılmış sayılmadı.');
    }
    store(key, { jobId: job.jobId, fingerprint, startedAt: Date.now() });
    console.info('[Marka taraması] Job/worker sayısı:', job.jobId, job.workerIds.length,
        'izlenen marka:', monitoredMarks.length, 'bülten kayıt:', job.totalBulletinRecords);

    const workerState = new Map(job.workerIds.map(id => [id, { progress: 0, results: 0 }]));
    const startedAt = Date.now();
    let aborted = false;
    const updateProgress = () => {
        const list = Array.from(workerState.values());
        const average = Math.floor(list.reduce((sum, item) => sum + item.progress, 0) / list.length);
        const results = list.reduce((sum, item) => sum + item.results, 0);
        if (typeof onProgress === 'function') onProgress({
            status: 'processing', progress: average, currentResults: results
        });
    };

    async function runWorker(workerId) {
        let consecutiveTransientErrors = 0;
        let nextDiagnosticProgress = 25;
        while (!aborted) {
            if (Date.now() - startedAt > MAX_JOB_MILLISECONDS) {
                throw new Error('Arama bir saat içinde sonuçlandırılamadı. Kayıtlar silinmedi; aynı bülteni seçerek devam edebilirsiniz.');
            }
            let response;
            try {
                response = await invokeSearch({ action: 'step', jobId: job.jobId, workerId });
                consecutiveTransientErrors = 0;
            } catch (error) {
                consecutiveTransientErrors++;
                // Sabit paket boyu korunur. Retry backend'in kalıcı cursor'una dayanır.
                // 35 kayıt bile CPU sınırını aşarsa bu, loglar üzerinden ayrı ele alınır.
                if (consecutiveTransientErrors >= MAX_TRANSIENT_ERRORS) {
                    throw new Error(`${workerId}: ${error.message} (${consecutiveTransientErrors} bağlantı hatası). Arama tamamlandı sayılmadı.`);
                }
                // Ağ geçidi/soğuk başlangıç hatası nedeniyle önceki istek tamamlanmış
                // olabilir. Retry daima backend'in kalıcı cursor'una bakar.
                await delay(Math.min(8000, 800 * Math.pow(2, consecutiveTransientErrors)));
                continue;
            }
            const prior = workerState.get(workerId) || { progress: 0, results: 0 };
            workerState.set(workerId, {
                progress: Math.max(prior.progress, Number(response.progress || 0)),
                results: Math.max(prior.results, Number(response.resultsCount || 0))
            });
            updateProgress();
            if (Number(response.progress || 0) >= nextDiagnosticProgress || response.state === 'completed') {
                console.info('[Marka taraması] Worker verimliliği:', workerId, {
                    ilerleme: response.progress,
                    okunanPaket: response.processedThisStep,
                    sabitPaketBoyutu: response.batchSize || 35,
                    hesaplamaMs: response.computationMs,
                    onHazirlikKullanildi: response.warmPreparation
                });
                nextDiagnosticProgress = Math.floor(Number(response.progress || 0) / 25) * 25 + 25;
            }
            if (response.state === 'completed') return;
            if (response.state === 'failed') throw new Error(`${workerId}: ${response.error || 'Worker başarısız.'}`);
            if (response.state === 'locked') {
                await delay(Math.max(1200, Math.min(5000, Number(response.waitMs || 2500))));
            } else if (response.state !== 'pending') {
                throw new Error(`Bilinmeyen worker durumu: ${response.state}`);
            }
        }
    }

    // Gerçekten eşzamanlı 10 worker çalışır. Edge Function kendi kendini
    // çağırmaz; başarısız bir çağrı boşa düşen gizli job üretmez.
    const outcomes = await Promise.allSettled(job.workerIds.map(async workerId => {
        try { await runWorker(workerId); }
        catch (error) { aborted = true; throw error; }
    }));
    const failures = outcomes.filter(o => o.status === 'rejected');
    if (failures.length) {
        const reason = failures.map(o => o.reason?.message || String(o.reason)).join(' | ');
        // Job kaydı duruyorsa aynı kriterlerle sonraki sefer kaldığı yerden devam edilebilir.
        throw new Error(`Marka araması eksik kaldı. ${reason}`);
    }
    const verified = await invokeSearch({ action: 'verify', jobId: job.jobId });
    if (verified.status !== 'completed' || Number(verified.completedWorkers) !== job.workerIds.length) {
        throw new Error(`Kalıcı sonuç ve worker kapsamı doğrulanamadı (${verified.completedWorkers}/${job.workerIds.length}). Arama tamamlandı sayılmadı.`);
    }
    store(key, null);
    if (typeof onProgress === 'function') onProgress({
        status: 'downloading', progress: 100,
        currentResults: Number(verified.currentResults || 0),
        message: 'Tüm izlenen markalar tarandı, kalıcı kayıtlar doğrulandı. Sonuçlar getiriliyor...'
    });
    console.info('[Marka taraması] Başarıyla tamamlandı:', job.jobId, verified.currentResults);
    return true;
}

export async function runTrademarkSearch(monitoredMarks, selectedBulletinId, onProgress) {
    if (activeSearch) return activeSearch;
    activeSearch = searchRun(monitoredMarks, selectedBulletinId, onProgress);
    try { return await activeSearch; }
    finally { activeSearch = null; }
}
