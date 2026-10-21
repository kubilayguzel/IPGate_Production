// Portföy / İtirazlar - veri tamamlama yardımcıları.
// Durum hesaplaması burada yapılmaz; mevcut PortfolioDataManager mantığı korunur.
import { supabase } from '../../supabase-config.js';

const PARENT_TYPES = ['7', '19', '20'];
const DECISION_TYPES = new Set(['28', '29', '30', '31', '32', '33', '34', '35', '36', '50', '51', '52']);
const PAGE_SIZE = 250;
const IN_BATCH = 65;

function firstTask(transaction) {
    const tasks = transaction?.tasks;
    return Array.isArray(tasks) ? (tasks.find(t => linkedId(t?.details, 'sourceIpRecordId', 'source_ip_record_id')) || tasks[0] || null) : (tasks || null);
}

function linkedId(details, camel, snake) {
    return details?.[snake] || details?.[camel] || null;
}

function isThirdParty(record) {
    return record?.recordOwnerType === 'third_party' ||
        ['third_party', 'published_in_bulletin'].includes(record?.portfoyStatus);
}

function normalizeClasses(classes) {
    return Array.isArray(classes)
        ? [...new Set(classes.map(c => Number(c)).filter(n => Number.isInteger(n) && n > 0))]
            .sort((a, b) => a - b).join(', ')
        : '';
}

function fmtDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('tr-TR');
}

// Birden fazla sayfayı sınırlı paralellikle okur; tek yavaş sorgu bütün arayüzü kilitlemez.
// Sıralama iki alanlıdır: created_at eşit olduğunda id, sayfa sınırının kararlı kalmasını sağlar.
const QUERY_TIMEOUT_MS = 16000;
const REQUEST_CONCURRENCY = 4;

async function timedQuery(query, description) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (controller && typeof query.abortSignal === 'function') query = query.abortSignal(controller.signal);
    let timer;
    try {
        return await Promise.race([
            Promise.resolve(query),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller?.abort();
                    reject(new Error(`${description}: veritabanı yanıt vermedi (16 sn).`));
                }, QUERY_TIMEOUT_MS);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function runBatches(items, batchSize, worker, concurrency = REQUEST_CONCURRENCY) {
    const batches = [];
    for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
    const results = new Array(batches.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
        while (cursor < batches.length) {
            const index = cursor++;
            results[index] = await worker(batches[index], index);
        }
    }));
    return results;
}

async function getAllPages(buildQuery, description = 'İtiraz kayıtları') {
    const result = [];
    const readPage = async offset => {
        const { data, error } = await timedQuery(
            buildQuery().range(offset, offset + PAGE_SIZE - 1), description);
        if (error) throw new Error(`${description}: ${error.message}`);
        return data || [];
    };
    const first = await readPage(0);
    result.push(...first);
    if (first.length < PAGE_SIZE) return result;

    // İstek sayısını kontrol altında tutarken ardışık sayfa beklemelerini azalt.
    for (let firstOffset = PAGE_SIZE; firstOffset < 200000; firstOffset += PAGE_SIZE * REQUEST_CONCURRENCY) {
        const pages = await Promise.all(Array.from({ length: REQUEST_CONCURRENCY }, (_, i) =>
            readPage(firstOffset + PAGE_SIZE * i)));
        for (const page of pages) {
            result.push(...page);
            if (page.length < PAGE_SIZE) return result;
        }
    }
    throw new Error(`${description}: veri sayısı güvenli sorgu sınırını geçti.`);
}

async function fillDirectTaskLinks(transactions) {
    // Bazı eski işlemler tasks.transaction_id yerine transactions.task_id kullanır.
    const incomplete = transactions.filter(tx => !firstTask(tx) && tx.task_id);
    if (!incomplete.length) return;
    const ids = [...new Set(incomplete.map(tx => String(tx.task_id)))];
    const tasksById = new Map();
    await runBatches(ids, IN_BATCH, async chunk => {
        const { data, error } = await timedQuery(supabase.from('tasks')
            .select('id, details, task_documents(*)').in('id', chunk), 'Bağlı görevler');
        if (error) {
            console.info('İtiraz görev bağı tamamlanamadı:', error.message);
            return;
        }
        for (const task of data || []) tasksById.set(String(task.id), task);
    });
    for (const tx of incomplete) {
        const task = tasksById.get(String(tx.task_id));
        if (task) tx.tasks = [task];
    }
}

export async function fetchObjectionTransactions() {
    const fields = '*, transaction_documents(*), tasks(*, task_documents(*))';
    const parents = await getAllPages(() => supabase.from('transactions').select(fields)
        .in('transaction_type_id', PARENT_TYPES)
        .order('created_at', { ascending: true }).order('id', { ascending: true }),
        'Ana itiraz işlemleri');

    // Önceki sürüm bütün işlemlerin alt kayıtlarını (itiraz dışındaki binlerce işlemi de)
    // yüklüyordu. Yalnızca listelenecek ana itirazlara bağlı alt işlemleri çek.
    const parentIds = [...new Set(parents.map(p => String(p.id)).filter(Boolean))];
    const childGroups = await runBatches(parentIds, IN_BATCH, async ids =>
        getAllPages(() => supabase.from('transactions').select(fields)
            .eq('transaction_hierarchy', 'child')
            .in('parent_id', ids)
            .order('created_at', { ascending: true }).order('id', { ascending: true }),
            'İtiraz alt işlemleri'));
    const children = childGroups.flat();
    await fillDirectTaskLinks([...parents, ...children]);
    return { parents, children };
}

export async function fetchObjectionRecordMap(existingRecords, transactions) {
    const records = new Map((existingRecords || []).map(r => [String(r.id), r]));
    const ids = new Set();
    for (const tx of transactions) {
        if (tx.ip_record_id) ids.add(String(tx.ip_record_id));
        const task = firstTask(tx);
        const details = task?.details || {};
        const own = linkedId(details, 'sourceIpRecordId', 'source_ip_record_id');
        const other = linkedId(details, 'competitorIpRecordId', 'competitor_ip_record_id');
        if (own) ids.add(String(own));
        if (other) ids.add(String(other));
    }

    const missing = [...ids].filter(id => !records.has(id));
    await runBatches(missing, IN_BATCH, async chunk => {
        const { data, error } = await timedQuery(supabase.from('portfolio_list_view')
            .select('id, ip_type, origin, status, portfolio_status, record_owner_type, application_number, application_date, brand_name, applicant_names, nice_classes')
            .in('id', chunk), 'İtiraz marka bilgileri');
        if (error) throw new Error(`İtiraz marka bilgileri alınamadı: ${error.message}`);
        for (const r of data || []) {
            records.set(String(r.id), {
                id: r.id, type: r.ip_type, origin: r.origin, status: r.status,
                portfoyStatus: r.portfolio_status, recordOwnerType: r.record_owner_type,
                applicationNumber: r.application_number, applicationDate: r.application_date,
                title: r.brand_name || '-', brandText: r.brand_name || '-',
                applicantName: r.applicant_names || '-', formattedApplicantName: r.applicant_names || '-',
                niceClasses: r.nice_classes || []
            });
        }
    });
    return records;
}

// Eski kayıtlarda bağlantı ana görevin değil, karar veya alt işlem görevinin içinde olabilir.
export function selectRelevantTask(parent, children) {
    const candidates = [firstTask(parent), ...children.map(firstTask)].filter(Boolean);
    return candidates.find(t => linkedId(t.details, 'sourceIpRecordId', 'source_ip_record_id')) ||
        candidates[0] || null;
}

// İşlemdeki opposition_owner her zaman karşı taraf değildir: otomatik açılan
// üçüncü kişi başvurusuna yönelik itirazlarda bu alan MÜVEKKİL adını taşır.
// Bu nedenle ancak yönü belli bir itirazda, doğru veri kaynağını kullanıyoruz.
function partyName(value) {
    if (Array.isArray(value)) {
        return value.map(partyName).filter(Boolean).join(', ');
    }
    if (value && typeof value === 'object') {
        return partyName(value.name || value.holderName || value.companyName || value.title);
    }
    const str = String(value ?? '').trim();
    return str && !['-', '—', 'null', 'undefined', 'belirtilmemiş'].includes(str.toLocaleLowerCase('tr-TR'))
        ? str : '';
}

function partyKey(value) {
    return partyName(value).toLocaleLowerCase('tr-TR')
        .replace(/[^a-z0-9çğıöşü]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

function firstOtherParty(candidates, clientNames = []) {
    const own = new Set(clientNames.map(partyKey).filter(Boolean));
    for (const candidate of candidates) {
        const name = partyName(candidate);
        if (name && !own.has(partyKey(name))) return name;
    }
    return '';
}

export function enrichObjectionRow(row, record, transaction, recordMap, fallbackTask = null, parentTypeId = null) {
    const ownTask = firstTask(transaction);
    const task = linkedId(ownTask?.details, 'sourceIpRecordId', 'source_ip_record_id') ? ownTask : (fallbackTask || ownTask);
    const details = task?.details || {};
    const ownId = linkedId(details, 'sourceIpRecordId', 'source_ip_record_id');
    const competitorId = linkedId(details, 'competitorIpRecordId', 'competitor_ip_record_id');
    const ownRecord = ownId ? recordMap.get(String(ownId)) : null;
    const competitorRecord = competitorId ? recordMap.get(String(competitorId)) : null;
    const recordId = String(record?.id || '');
    const matchesOwn = ownId && String(ownId) === recordId;
    const matchesCompetitor = competitorId && String(competitorId) === recordId;

    let role = 'Doğrulanamadı';
    if (matchesOwn) role = 'Başvuru sahibi';
    else if ((matchesCompetitor || isThirdParty(record)) && ownRecord && !matchesOwn) role = 'İtiraz sahibi';
    else if (record?.recordOwnerType === 'self' && !isThirdParty(record)) role = 'Başvuru sahibi';

    row.clientRole = role;
    row.clientMark = ownRecord?.title || (role === 'Başvuru sahibi' ? record?.title : '') || '';
    row.clientMarkNumber = ownRecord?.applicationNumber || (role === 'Başvuru sahibi' ? record?.applicationNumber : '') || '';
    row.opposedMark = competitorRecord?.title || (isThirdParty(record) ? record?.title : '') || '';
    row.niceClassesText = normalizeClasses(record?.niceClasses);
    row.clientClassesText = ownRecord ? normalizeClasses(ownRecord.niceClasses) :
        (role === 'Başvuru sahibi' ? row.niceClassesText : '');
    row.transactionTypeId = String(transaction?.transaction_type_id || '');
    row.taskId = task?.id || transaction?.task_id || '';
    row.roleSource = ownId ? 'Bağlı görev' :
        (role === 'Başvuru sahibi' ? 'Portföy sahipliği' : 'Kaynak bağlantısı bulunamadı');

    // Yön portföydeki başvuru kaydından belirlenir; yalnızca görev bağlantısı varsa
    // doğrulanmış ilişkiden yedek doğrulama yapılır. Emin olunmayan taraf boş kalır.
    const processType = String(parentTypeId ?? transaction?.transaction_type_id ?? '');
    row.objectionProcessType = processType;
    const outgoing = isThirdParty(record) || (matchesCompetitor && !!ownRecord);
    const incoming = !outgoing && (record?.recordOwnerType === 'self' || !!matchesOwn);
    row.partyDirection = outgoing ? 'outgoing' : (incoming ? 'incoming' : 'unknown');

    // Karara itiraz (tip 7): müvekkilin idari karara başvurusu, karşı taraf yok.
    // İşlem type 19 ve 20 ise başvuru sahibi / itiraz eden ayrımı korunur.
    row.opponent = '';
    if (processType === '20' || processType === '19') {
        if (outgoing) {
            // Bizim yaptığımız yayına itiraz: rakip başvurunun gerçek sahibi.
            // opposition_owner burada müvekkil olabildiği için ASLA kaynak değildir.
            row.opponent = firstOtherParty([
                competitorRecord?.formattedApplicantName, competitorRecord?.applicantName,
                record?.formattedApplicantName, record?.applicantName,
                details.opposed_mark_owner, details.opposedMarkOwner,
                details.opposedMarkApplicant, details.competitorOwner
            ], [transaction?.opposition_owner, details.oppositionOwner,
                ownRecord?.formattedApplicantName, ownRecord?.applicantName]);
        } else if (incoming) {
            // Bizim markamıza yöneltilen itiraz: itiraz eden kişi.
            row.opponent = firstOtherParty([
                transaction?.opposition_owner,
                details.opposition_owner, details.oppositionOwner
            ], [record?.formattedApplicantName, record?.applicantName,
                ownRecord?.formattedApplicantName, ownRecord?.applicantName]);
        }
    }

    const bulletinNumber = details.bulletin_no || details.bulletinNo;
    const bulletinDate = details.bulletin_date || details.bulletinDate;
    if ((!row.bulletinNo || row.bulletinNo === '-') && bulletinNumber) row.bulletinNo = String(bulletinNumber);
    if ((!row.bulletinDate || row.bulletinDate === '-') && bulletinDate) row.bulletinDate = fmtDate(bulletinDate);
    if ((!row.applicationNumber || row.applicationNumber === '-') && details.target_app_no) {
        row.applicationNumber = String(details.target_app_no);
    }
    return row;
}

export function containsObjectionDecision(transactions) {
    return transactions.some(tx => DECISION_TYPES.has(String(tx.transaction_type_id)));
}

export async function addCertainBulletins(rows) {
    const ids = [...new Set(rows.filter(row => row.bulletinNo === '-' || row.bulletinDate === '-')
        .map(row => row.recordId).filter(Boolean).map(String))];
    if (!ids.length) return;
    const grouped = new Map();
    try {
        await runBatches(ids, IN_BATCH, async chunk => {
            const { data, error } = await timedQuery(supabase.from('ip_record_bulletins')
                .select('ip_record_id, bulletin_no, bulletin_date')
                .in('ip_record_id', chunk), 'Bülten bilgileri');
            if (error) throw error;
            for (const b of data || []) {
                const id = String(b.ip_record_id);
                if (!grouped.has(id)) grouped.set(id, []);
                grouped.get(id).push(b);
            }
        });
        // Farklı bültenlerin karışmaması için yalnızca TEK kayıt bulunduğunda kullanılır.
        for (const row of rows) {
            const entries = grouped.get(String(row.recordId)) || [];
            if (entries.length !== 1) continue;
            const b = entries[0];
            if (row.bulletinNo === '-' && b.bulletin_no) row.bulletinNo = String(b.bulletin_no);
            if (row.bulletinDate === '-' && b.bulletin_date) row.bulletinDate = fmtDate(b.bulletin_date);
            for (const child of row.children || []) {
                if (child.bulletinNo === '-') child.bulletinNo = row.bulletinNo;
                if (child.bulletinDate === '-') child.bulletinDate = row.bulletinDate;
            }
        }
    } catch (error) {
        // Bazı şemalarda bu tablo bulunmayabilir; asıl itiraz listesini engellemeyiz.
        console.info('İtiraz bülten tamamlaması kullanılamadı:', error.message);
    }
}
