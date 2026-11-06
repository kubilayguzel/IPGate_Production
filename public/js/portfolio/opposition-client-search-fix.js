// public/js/portfolio/opposition-client-search-fix.js
// IPGate | İtirazlar sekmesi: itiraz sahibi müvekkilinin kimliğini görünür,
// filtrelenebilir ve aranabilir yapar. Dava hiyerarşisi, görev ve durum
// hesapları, mevcut kayıtlara ve veritabanına müdahale edilmez.
// Bu modül public/js/portfolio/main.js yüklenmeden önce import edilmelidir.

import { supabase } from '../../supabase-config.js';
import { PortfolioDataManager } from './PortfolioDataManager.js';
import { PortfolioRenderer } from './PortfolioRenderer.js';
import { ObjectionResearchPanel } from './ObjectionResearchPanel.js';

const LIMIT = 65;
const EMPTY_NAMES = new Set(['', '-', '—', 'belirtilmemiş', 'null', 'undefined', 'bilinmiyor']);

// İtirazlar sekmesi bir görev havuzu değildir: müvekkil onayını bekleyen ve
// henüz resmî başvurusu yapılmamış itiraz işlemleri bu listede görünmez.
const AWAITING_APPROVAL_STATUSES = new Set(['awaiting_client_approval', 'awaiting-approval']);
const RESULT_TRANSACTION_TYPES = new Set(['28', '29', '30', '31', '32', '33', '34', '35', '36', '50', '51', '52']);
const canonicalStatus = value => String(value ?? '').toLowerCase().trim();
const parseDetails = value => {
    if (!value) return {};
    if (typeof value === 'string') {
        try { const obj = JSON.parse(value); return obj && typeof obj === 'object' ? obj : {}; }
        catch (_) { return {}; }
    }
    return typeof value === 'object' ? value : {};
};
const hasFiledTask = task => {
    const details = parseDetails(task?.details);
    // EPATS'a sunulmuş evrakın birincil kaydı task_documents altında da olabilir.
    const submittedPdf = (Array.isArray(task?.task_documents) ? task.task_documents : []).some(doc =>
        String(doc?.document_type || doc?.type || '').toLocaleLowerCase('tr-TR') === 'epats_document' &&
        Boolean(doc?.document_url || doc?.url || doc?.storage_path));
    return canonicalStatus(task?.status) === 'completed' || submittedPdf ||
        details.completed_by_epats === true ||
        Boolean(details.epatsDocumentNo || details.epats_document_no ||
            details.epatsDocumentDate || details.epats_document_date);
};
const hasFiledDocument = tx => (Array.isArray(tx?.transaction_documents)
    ? tx.transaction_documents : []).some(doc => {
        const label = String(doc?.document_type || doc?.document_designation || '').toLocaleLowerCase('tr-TR');
        const name = String(doc?.document_name || '').toLocaleLowerCase('tr-TR');
        return Boolean(doc?.document_url) && (label.includes('epats') ||
            label.includes('kuruma sunul') || name.includes('epats'));
    });


const asText = value => String(value ?? '').trim();
const clean = value => {
    if (Array.isArray(value)) return value.map(clean).filter(Boolean).join(', ');
    if (value && typeof value === 'object') return clean(value.name || value.companyName || value.holderName || value.title);
    const name = asText(value);
    return EMPTY_NAMES.has(name.toLocaleLowerCase('tr-TR')) ? '' : name;
};

function fold(value) {
    return asText(value).toLocaleLowerCase('tr-TR').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/\s+/g, ' ').trim();
}

function unique(values) {
    return [...new Set(values.map(asText).filter(Boolean))];
}

function chunks(values) {
    const result = [];
    for (let i = 0; i < values.length; i += LIMIT) result.push(values.slice(i, i + LIMIT));
    return result;
}

// Eski kayıtların/RLS'nin bir yardımcı sorguyu engellemesi asıl itiraz
// listesini bozmamalıdır. Yalnızca eksik kimlik fallback'i devre dışı kalır.
async function readBatches(table, fields, ids, key, description) {
    const values = unique(ids);
    if (!values.length) return [];
    const groups = chunks(values);
    const output = [];
    for (let cursor = 0; cursor < groups.length; cursor += 4) {
        const batch = groups.slice(cursor, cursor + 4);
        const results = await Promise.all(batch.map(async values => {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            let timer;
            try {
                let query = supabase.from(table).select(fields).in(key, values);
                if (controller && typeof query.abortSignal === 'function') query = query.abortSignal(controller.signal);
                const { data, error } = await Promise.race([
                    query,
                    new Promise((_, reject) => {
                        timer = setTimeout(() => {
                            controller?.abort();
                            reject(new Error(`${description}: 12 sn içinde tamamlanmadı.`));
                        }, 12000);
                    })
                ]);
                if (error) throw error;
                return data || [];
            } catch (error) {
                console.warn(`[İtiraz Müvekkili] ${description} erişilemedi:`, error.message || error);
                return [];
            } finally {
                if (timer) clearTimeout(timer);
            }
        }));
        for (const result of results) output.push(...result);
    }
    return output;
}

function transactionEvidence(transaction) {
    const tasks = Array.isArray(transaction?.tasks)
        ? transaction.tasks : (transaction?.tasks ? [transaction.tasks] : []);
    const ids = tasks.map(t => t?.task_owner_id || t?.details?.task_owner_id).filter(Boolean);
    const sourceRecords = tasks.map(t =>
        t?.details?.source_ip_record_id || t?.details?.sourceIpRecordId).filter(Boolean);
    return {
        ownerIds: unique(ids),
        sourceRecordIds: unique(sourceRecords),
        taskIds: unique([transaction?.task_id, ...tasks.map(t => t?.id)]),
        rawOppositionOwner: clean(transaction?.opposition_owner),
        taskStatuses: tasks.map(t => canonicalStatus(t?.status)).filter(Boolean),
        filed: tasks.some(hasFiledTask) || hasFiledDocument(transaction),
        transactionTypeId: String(transaction?.transaction_type_id || '')
    };
}

// Var olan ham satır hazırlayıcısına yalnız kanıt bağlantıları eklenir.
// Özellikle rakip başvuru sahibinin adı clientName olarak ATANMAZ.
const dataProto = PortfolioDataManager.prototype;
if (!dataProto.__objectionClientSearchFixed20261106) {
    Object.defineProperty(dataProto, '__objectionClientSearchFixed20261106', { value: true });

    const originalCreateRow = dataProto._createObjectionRowDataFast;
    dataProto._createObjectionRowDataFast = function(record, tx, ...rest) {
        const row = originalCreateRow.call(this, record, tx, ...rest);
        row._oppositionClientEvidence = transactionEvidence(tx);
        return row;
    };

    const originalBuild = dataProto.buildObjectionRows;
    dataProto.buildObjectionRows = async function(forceRefresh = false) {
        const rows = await originalBuild.call(this, forceRefresh);
        if (!Array.isArray(rows) || !rows.length) return rows;
        if (!forceRefresh && this._lastClientNameHydratedRows === rows) return rows;

        const evidenceFor = row => row?._oppositionClientEvidence || {};
        const allRows = rows.flatMap(parent => [parent, ...(parent.children || [])]);
        const primaryOwnerIds = unique(allRows.flatMap(row => evidenceFor(row).ownerIds || []));
        const parentsMissingOwner = rows.filter(parent =>
            ![parent, ...(parent.children || [])].some(row =>
                (evidenceFor(row).ownerIds || []).length));
        const taskIdsForFallback = unique([
            ...parentsMissingOwner.flatMap(parent =>
                [parent, ...(parent.children || [])].flatMap(row =>
                    evidenceFor(row).taskIds || [])),
            // Eski transactions.task_id bağlantıları: görev JOIN'i gelmemişse
            // karar verirken durumun da ayrı okunması gerekir.
            ...allRows.filter(row => !(evidenceFor(row).taskStatuses || []).length)
                .flatMap(row => evidenceFor(row).taskIds || [])
        ]);

        // tasks(*) ilişkisi veya eski transactions.task_id eksik yüklenmişse
        // person bağını görev üzerinden tamamla.
        const missingTasks = await readBatches('tasks', 'id, task_owner_id, status, details',
            taskIdsForFallback, 'id', 'eski görev sahipliği/durumu');
        const ownersByTaskId = new Map(missingTasks.map(task => [String(task.id), asText(task.task_owner_id || task.details?.task_owner_id)]));
        const sourcesByTaskId = new Map(missingTasks.map(task => [String(task.id),
            asText(parseDetails(task.details)?.source_ip_record_id || parseDetails(task.details)?.sourceIpRecordId)]));
        const statusByTaskId = new Map(missingTasks.map(task => [String(task.id), canonicalStatus(task.status)]));
        const filedByTaskId = new Map(missingTasks.map(task => [String(task.id), hasFiledTask(task)]));

        for (const row of allRows) {
            const evidence = evidenceFor(row);
            evidence.ownerIds = unique([...(evidence.ownerIds || []),
                ...(evidence.taskIds || []).map(id => ownersByTaskId.get(String(id)))]);
            evidence.sourceRecordIds = unique([...(evidence.sourceRecordIds || []),
                ...(evidence.taskIds || []).map(id => sourcesByTaskId.get(String(id)))]);
            evidence.taskStatuses = unique([...(evidence.taskStatuses || []),
                ...(evidence.taskIds || []).map(id => statusByTaskId.get(String(id)))]);
            evidence.filed = Boolean(evidence.filed ||
                (evidence.taskIds || []).some(id => filedByTaskId.get(String(id))));
        }

        // İtiraza konu marka ile mesnet marka ayrı kişilere aittir.
        // Müvekkil ancak görev sahibi/opposition_cases veya açıkça bağlanmış
        // kaynak marka üzerinden bulunabilir.
        const unresolvedOutgoing = rows.filter(row => row.clientRole === 'İtiraz sahibi' &&
            ![row, ...(row.children || [])].some(child => evidenceFor(child).ownerIds?.length));
        const cases = await readBatches('opposition_cases', 'transaction_id, client_id',
            unresolvedOutgoing.map(row => row.id), 'transaction_id', 'itiraz dosyası müvekkil bağı');
        const caseOwnerIds = new Map();
        for (const item of cases) {
            const key = asText(item.transaction_id);
            if (!caseOwnerIds.has(key)) caseOwnerIds.set(key, []);
            if (item.client_id) caseOwnerIds.get(key).push(String(item.client_id));
        }

        const allOwnerIds = unique([
            ...primaryOwnerIds,
            ...allRows.flatMap(row => evidenceFor(row).ownerIds || []),
            ...[...caseOwnerIds.values()].flat()
        ]);
        const personNames = new Map();
        for (const [id, person] of this.personsMap || new Map()) {
            const name = clean(person?.name);
            if (name) personNames.set(String(id), name);
        }
        const personMissing = allOwnerIds.filter(id => !personNames.has(id));
        const personRows = await readBatches('persons', 'id, name', personMissing, 'id', 'müvekkil kişi adları');
        for (const person of personRows) {
            const name = clean(person.name);
            if (name) personNames.set(String(person.id), name);
        }

        // Kaynak portföy (sourceIpRecordId) müvekkilimizin dayanak markasıdır;
        // itiraza konu üçüncü taraf kaydının applicant_name alanı değildir.
        const sourceIdsNeeded = unique(rows.filter(parent =>
            parent.clientRole === 'İtiraz sahibi' &&
            ![parent, ...(parent.children || [])].some(row =>
                (evidenceFor(row).ownerIds || []).some(id => personNames.has(String(id))) ||
                (caseOwnerIds.get(String(parent.id)) || []).some(id => personNames.has(String(id))))
        ).flatMap(parent => [parent, ...(parent.children || [])]
            .flatMap(row => evidenceFor(row).sourceRecordIds || [])));
        const sourceNameById = new Map();
        const sourceFromLoaded = new Map((this.allRecords || []).map(record => [String(record.id), record]));
        for (const id of sourceIdsNeeded) {
            const rec = sourceFromLoaded.get(id);
            if (rec && rec.recordOwnerType !== 'third_party') {
                const name = clean(rec.formattedApplicantName || rec.applicantName);
                if (name) sourceNameById.set(id, name);
            }
        }
        const missingSource = sourceIdsNeeded.filter(id => !sourceNameById.has(id));
        const sourceRows = await readBatches('portfolio_list_view',
            'id, record_owner_type, applicant_names', missingSource, 'id', 'mesnet marka sahipleri');
        for (const record of sourceRows) {
            if (record.record_owner_type === 'third_party') continue;
            const name = clean(record.applicant_names);
            if (name) sourceNameById.set(String(record.id), name);
        }

        for (const parent of rows) {
            const linkedRows = [parent, ...(parent.children || [])];
            const evidence = linkedRows.map(evidenceFor);
            const outgoing = parent.clientRole === 'İtiraz sahibi';
            const incoming = parent.clientRole === 'Başvuru sahibi';
            const ownerIds = unique([
                ...evidence.flatMap(item => item.ownerIds || []),
                ...(caseOwnerIds.get(String(parent.id)) || [])
            ]);
            const verifiedNames = unique(ownerIds.map(id => personNames.get(id)).filter(Boolean));
            const sourceNames = unique(evidence.flatMap(item => (item.sourceRecordIds || [])
                .map(id => sourceNameById.get(id))).filter(Boolean));
            const rawOwnerNames = unique(evidence.map(item => clean(item.rawOppositionOwner)).filter(Boolean))
                .filter(name => fold(name) !== fold(parent.opponent));

            let name = '';
            let source = '';
            if (verifiedNames.length) {
                name = verifiedNames.join(', ');
                source = 'Görev/dosya müvekkil kimliği';
            } else if (outgoing && sourceNames.length) {
                name = sourceNames.join(', ');
                source = 'Mesnet marka sahibi';
            } else if (outgoing && rawOwnerNames.length) {
                // Otomatik itirazda opposition_owner müvekkilin adıdır.
                // Sadece İtiraz sahibi rolü doğrulandığında kullanılabilir.
                name = rawOwnerNames[0];
                source = 'İtiraz işlemindeki taraf kaydı';
            } else if (incoming) {
                name = clean(parent.applicantName);
                source = name ? 'Müvekkil marka başvuru sahibi' : '';
            }
            // Üçüncü kişi başvuru sahibini müvekkil gibi göstermeyelim.
            if (outgoing && fold(name) && fold(name) === fold(parent.opponent)) {
                name = '';
                source = '';
            }
            for (const row of linkedRows) {
                row.clientName = name;
                row.clientNameSource = source;
            }
        }
        // İtirazlar tablosuna onay bekleyen taslak işleri dahil etmeyelim.
        // Tamamlanmış/EPATS'a sunulmuş itiraz veya karar alt işlemi varsa
        // eski görev statüsü bekliyor kalsa bile gerçek itiraz görünür.
        const visibleRows = rows.filter(parent => {
            const related = [parent, ...(parent.children || [])];
            const parentStatuses = evidenceFor(parent).taskStatuses || [];
            const statuses = parentStatuses.length ? parentStatuses :
                unique(related.flatMap(row => evidenceFor(row).taskStatuses || []));
            if (!statuses.length || !statuses.every(status => AWAITING_APPROVAL_STATUSES.has(status))) {
                return true; // Görevsiz geçmiş itirazları ve ilerlemiş işler korunur.
            }
            const officialFilingOrDecision = related.some(row => Boolean(evidenceFor(row).filed)) ||
                (parent.children || []).some(child =>
                    RESULT_TRANSACTION_TYPES.has(String(evidenceFor(child).transactionTypeId || child.transactionTypeId || '')));
            return officialFilingOrDecision;
        });
        this.objectionRows = visibleRows;
        this._lastClientNameHydratedRows = visibleRows;
        return visibleRows;
    };

    // Orijinal portföy aramasına dokunmadan, İtirazlar sekmesinde yalnızca
    // müvekkil unvanıyla eşleşen kayıtları aynı sorgunun sonuçlarına ekle.
    // Böylece sütun filtreleri, pasif/arşiv seçimi ve diğer aramalar korunur.
    const originalFilter = dataProto.filterRecords;
    dataProto.filterRecords = function(typeFilter, searchTerm, columnFilters = {}, subTab = null, includeArchived = false) {
        const results = originalFilter.call(this, typeFilter, searchTerm, columnFilters, subTab, includeArchived);
        if (typeFilter !== 'objections' || !asText(searchTerm)) return results;
        const term = fold(searchTerm);
        const already = new Set(results.map(row => String(row.id)));
        const allowed = originalFilter.call(this, typeFilter, '', columnFilters, subTab, includeArchived);
        for (const row of allowed) {
            if (already.has(String(row.id)) || !fold(row.clientName).includes(term)) continue;
            results.push(row);
            already.add(String(row.id));
        }
        return results;
    };
}

const panelProto = ObjectionResearchPanel.prototype;
if (!panelProto.__objectionClientNameFilterFixed20261106) {
    Object.defineProperty(panelProto, '__objectionClientNameFilterFixed20261106', { value: true });
    const originalEmpty = panelProto.emptyFilters;
    panelProto.emptyFilters = function() {
        return { ...originalEmpty.call(this), clientName: '' };
    };
    const originalAttach = panelProto.attach;
    panelProto.attach = function(onChange) {
        // HTML alanı oluşturulduktan sonra aynı standart filtre/temizle davranışını kullan.
        this.fields.oppClientName = 'clientName';
        return originalAttach.call(this, onChange);
    };
    const originalPanelFilter = panelProto.filter;
    panelProto.filter = function(rows) {
        const standard = originalPanelFilter.call(this, rows);
        const name = fold(this.filters.clientName);
        return name ? standard.filter(row => fold(row.clientName).includes(name)) : standard;
    };
}

const rendererProto = PortfolioRenderer.prototype;
if (!rendererProto.__objectionClientNameRendererFixed20261106) {
    Object.defineProperty(rendererProto, '__objectionClientNameRendererFixed20261106', { value: true });
    const originalRender = rendererProto.renderObjectionRow;
    rendererProto.renderObjectionRow = function(row, ...args) {
        const tr = originalRender.call(this, row, ...args);
        const name = clean(row.clientName);
        if (!name) return tr;
        const partiesCell = tr?.querySelectorAll('td')?.[3];
        if (!partiesCell) return tr;
        const line = document.createElement('span');
        line.className = 'opp-cell-subline opp-client-person';
        const label = document.createElement('span');
        label.className = 'opp-cell-kicker';
        label.textContent = row.clientRole === 'İtiraz sahibi'
            ? 'İtiraz sahibi (müvekkil):' : 'Müvekkil (başvuru sahibi):';
        line.append(label, document.createTextNode(' ' + name));
        line.title = clean(row.clientNameSource);
        partiesCell.insertBefore(line, partiesCell.firstChild);
        return tr;
    };
}
