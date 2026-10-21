/**
 * Sistem Raporları > Müvekkile Ait İşler
 * Kaynak: tasks.task_owner_id => persons.id; işlem türü: transaction_types.id.
 * Tahakkuk işleri: tasks.id T ile başlayan kayıtlar (T-1127 vb.) hariçtir.
 * Bu modül hiçbir veri değiştirmez; yalnızca SELECT sorguları yapar.
 */
import { supabase } from '../../supabase-config.js';

const PAGE_SIZE = 500;
const DISPLAY_PAGE_SIZE = 75;
const STATUS_LABELS = {
    pending: 'İşlem Bekliyor',
    awaiting_client_approval: 'Onay Bekliyor',
    open: 'Açık / Talimat Bekliyor',
    completed: 'Tamamlandı',
    client_approval_closed: 'Müvekkil Onayıyla Kapatıldı',
    cancelled: 'İptal Edildi'
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const dateLabel = value => {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('tr-TR').format(date);
};
const dateTimeLabel = value => {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('tr-TR', {dateStyle:'short', timeStyle:'short'}).format(date);
};
const isoLocalMidnight = (dateValue, nextDay = false) => {
    const date = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(date.getTime())) throw new Error('Geçersiz tarih seçimi.');
    if (nextDay) date.setDate(date.getDate() + 1);
    return date.toISOString();
};
const loadExternalScript = async (src, present) => {
    if (present()) return;
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
        await new Promise((resolve, reject) => {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            // Sayfa bu dosyayı önceden indirmiş olabilir.
            if (present()) resolve();
        });
        return;
    }
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Rapor dışa aktarma kütüphanesi yüklenemedi.'));
        document.head.appendChild(script);
    });
};

export class ClientTasksReport {
    constructor() {
        this.selectedClients = new Map();
        this.rows = [];
        this.dateFrom = '';
        this.dateTo = '';
        this.sortKey = 'created_at';
        this.sortAscending = false;
        this.page = 0;
        this.searchTimer = null;
        this.searchSequence = 0;
        this._thead = null;
    }

    renderFilters(containerId) {
        const root = document.getElementById(containerId);
        root.innerHTML = `
            <div class="col-lg-7 mb-3">
                <label for="ctClientSearch" class="font-weight-bold text-dark">Müvekkil Ara ve Ekle</label>
                <div class="position-relative">
                    <input id="ctClientSearch" type="search" class="form-control" autocomplete="off"
                        placeholder="Müvekkil adı yazın (en az 2 karakter)..." aria-label="Müvekkil ara" />
                    <div id="ctClientResults" class="list-group position-absolute w-100 shadow-sm" role="listbox"
                        style="display:none;z-index:1050;max-height:240px;overflow-y:auto;background:white;"></div>
                </div>
            </div>
            <div class="col-sm-6 col-lg-2 mb-3">
                <label for="ctDateFrom" class="font-weight-bold text-dark">Oluşturulma - Başlangıç</label>
                <input id="ctDateFrom" type="date" class="form-control" value="${escapeHtml(this.dateFrom)}" />
            </div>
            <div class="col-sm-6 col-lg-2 mb-3">
                <label for="ctDateTo" class="font-weight-bold text-dark">Oluşturulma - Bitiş</label>
                <input id="ctDateTo" type="date" class="form-control" value="${escapeHtml(this.dateTo)}" />
            </div>
            <div class="col-lg-1 mb-3">
                <button type="button" id="btnGenerateReport" class="btn btn-success btn-block"
                    style="white-space:nowrap;" ${this.selectedClients.size ? '' : 'disabled'}>Üret</button>
            </div>
            <div class="col-12 mb-2">
                <label class="font-weight-bold text-dark mb-2">Seçilen Müvekkiller <small class="text-muted">(birden çok seçim yapabilirsiniz)</small></label>
                <div id="ctSelectedClients" class="p-2 border rounded d-flex flex-wrap align-items-center" style="gap:8px;min-height:51px;background:#f8faff;"></div>
                <small class="text-muted mt-2 d-block">İki tarih de isteğe bağlıdır; bitiş günü dahildir. İş numarası T ile başlayan tahakkuk görevleri rapora alınmaz.</small>
            </div>`;
        this._renderSelected();
        const searchInput = document.getElementById('ctClientSearch');
        const results = document.getElementById('ctClientResults');
        searchInput.addEventListener('input', () => {
            clearTimeout(this.searchTimer);
            const token = ++this.searchSequence;
            const term = searchInput.value.trim();
            if (term.length < 2) { results.style.display = 'none'; results.textContent = ''; return; }
            this.searchTimer = setTimeout(() => this._searchClients(term, token, results), 320);
        });
        results.addEventListener('click', event => {
            const item = event.target.closest('button[data-person-id]');
            if (!item) return;
            const id = item.dataset.personId;
            const name = item.dataset.personName;
            if (id && name) this.selectedClients.set(id, name);
            this._renderSelected();
            searchInput.value = '';
            results.style.display = 'none';
            ++this.searchSequence;
        });
        document.getElementById('ctSelectedClients').addEventListener('click', event => {
            const item = event.target.closest('button[data-remove-person]');
            if (!item) return;
            this.selectedClients.delete(item.dataset.removePerson);
            this._renderSelected();
        });
        document.getElementById('ctDateFrom').addEventListener('change', e => { this.dateFrom = e.target.value; });
        document.getElementById('ctDateTo').addEventListener('change', e => { this.dateTo = e.target.value; });
        document.getElementById('btnGenerateReport').addEventListener('click', () => {
            window.MainReportController?.executeReport(this);
        });
    }

    async _searchClients(term, token, results) {
        try {
            const escapedTerm = term.replace(/[%_\\]/g, '\\$&');
            const {data, error} = await supabase.from('persons')
                .select('id,name').ilike('name', `%${escapedTerm}%`).order('name').limit(20);
            if (token !== this.searchSequence || !results.isConnected) return;
            if (error) throw error;
            if (!data?.length) {
                results.innerHTML = '<div class="p-3 text-muted small">Müvekkil bulunamadı.</div>';
            } else {
                results.innerHTML = data.map(p => `<button type="button" role="option" class="list-group-item list-group-item-action"
                    data-person-id="${escapeHtml(p.id)}" data-person-name="${escapeHtml(p.name)}">
                    <span class="font-weight-bold">${escapeHtml(p.name)}</span>
                    <small class="text-muted ml-2">${escapeHtml(String(p.id).slice(0, 8))}</small>
                </button>`).join('');
            }
            results.style.display = 'block';
        } catch (error) {
            if (token !== this.searchSequence || !results.isConnected) return;
            console.error('[ClientTasksReport] Müvekkil arama hatası:', error);
            results.innerHTML = '<div class="p-3 text-danger small">Müvekkil araması başarısız. Lütfen tekrar deneyin.</div>';
            results.style.display = 'block';
        }
    }

    _renderSelected() {
        const root = document.getElementById('ctSelectedClients');
        if (!root) return;
        root.innerHTML = this.selectedClients.size
            ? Array.from(this.selectedClients, ([id, name]) => `<span class="d-inline-flex align-items-center border rounded bg-white px-2 py-1" style="gap:8px;">
                <span title="${escapeHtml(id)}">${escapeHtml(name)} <small class="text-muted">(${escapeHtml(String(id).slice(0,8))})</small></span>
                <button type="button" class="btn btn-link btn-sm text-danger p-0" aria-label="Müvekkili kaldır" data-remove-person="${escapeHtml(id)}">&times;</button>
            </span>`).join('')
            : '<span class="text-muted small px-2">Henüz müvekkil seçilmedi.</span>';
        const button = document.getElementById('btnGenerateReport');
        if (button) button.disabled = this.selectedClients.size === 0;
    }

    async fetchData() {
        const clientIds = Array.from(this.selectedClients.keys());
        if (!clientIds.length) throw new Error('En az bir müvekkil seçmelisiniz.');
        if (this.dateFrom && this.dateTo && this.dateFrom > this.dateTo) {
            throw new Error('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
        }
        const fromIso = this.dateFrom ? isoLocalMidnight(this.dateFrom) : null;
        const untilExclusive = this.dateTo ? isoLocalMidnight(this.dateTo, true) : null;
        const taskById = new Map();
        const columns = 'id,title,description,task_type_id,status,priority,task_owner_id,ip_record_id,created_at,delivery_date,official_due_date,operational_due_date,assigned_to';
        // Tüm sayfaları getir: Supabase / PostgREST'in varsayılan 1000 satır sınırına takılmayız.
        for (let i = 0; i < clientIds.length; i += 20) {
            const ids = clientIds.slice(i, i + 20);
            let offset = 0;
            while (true) {
                let request = supabase.from('tasks').select(columns)
                    .in('task_owner_id', ids)
                    .not('id', 'ilike', 'T%')
                    .order('created_at', {ascending: false})
                    .order('id', {ascending: false})
                    .range(offset, offset + PAGE_SIZE - 1);
                if (fromIso) request = request.gte('created_at', fromIso);
                if (untilExclusive) request = request.lt('created_at', untilExclusive);
                const {data, error} = await request;
                if (error) throw new Error('Görevler yüklenemedi: ' + error.message);
                for (const task of (data || [])) {
                    if (task?.id && !/^T/i.test(String(task.id)) && ids.includes(String(task.task_owner_id))) {
                        taskById.set(String(task.id), task);
                    }
                }
                if (window.MainReportController?.currentStrategy === this) {
                    const button = document.getElementById('btnGenerateReport');
                    if (button) button.textContent = `Yükleniyor (${taskById.size})...`;
                }
                if (!data || data.length < PAGE_SIZE) break;
                offset += PAGE_SIZE;
            }
        }
        const tasks = Array.from(taskById.values());
        const typeMap = new Map();
        const types = [...new Set(tasks.map(t => String(t.task_type_id || '')).filter(Boolean))];
        for (let i = 0; i < types.length; i += 80) {
            const {data, error} = await supabase.from('transaction_types')
                .select('id,name,alias').in('id', types.slice(i, i + 80));
            if (error) throw new Error('İşlem türleri yüklenemedi: ' + error.message);
            for (const item of (data || [])) typeMap.set(String(item.id), item);
        }
        const portfolioMap = new Map();
        const recordIds = [...new Set(tasks.map(t => String(t.ip_record_id || '')).filter(Boolean))];
        for (let i = 0; i < recordIds.length; i += 60) {
            // Portföy zenginleştirmesi opsiyonel; görüntüleme izni olmayan kayıtlar görevi gizlememeli.
            const {data, error} = await supabase.from('portfolio_list_view')
                .select('id,brand_name,application_number').in('id', recordIds.slice(i, i + 60));
            if (error) {
                console.warn('[ClientTasksReport] Portföy bilgisi alınamadı:', error);
                break;
            }
            for (const item of (data || [])) portfolioMap.set(String(item.id), item);
        }
        this.rows = tasks.map(t => {
            const type = typeMap.get(String(t.task_type_id)) || {};
            const portfolio = portfolioMap.get(String(t.ip_record_id)) || {};
            return {
                id: String(t.id),
                client: this.selectedClients.get(String(t.task_owner_id)) || String(t.task_owner_id),
                clientId: String(t.task_owner_id),
                type: type.name || type.alias || t.title || `İşlem türü ${t.task_type_id || 'belirsiz'}`,
                title: t.title || '',
                description: t.description || '',
                applicationNo: portfolio.application_number || '',
                mark: portfolio.brand_name || '',
                status: STATUS_LABELS[t.status] || t.status || '-',
                rawStatus: t.status || '',
                priority: t.priority || '',
                created_at: t.created_at || '',
                deliveryDate: t.delivery_date || '',
                officialDue: t.official_due_date || '',
                operationalDue: t.operational_due_date || '',
                assignedTo: t.assigned_to || ''
            };
        });
        this._sortRows();
        this.page = 0;
    }

    _sortRows() {
        const factor = this.sortAscending ? 1 : -1;
        const key = this.sortKey;
        this.rows.sort((a, b) => String(a[key] || '').localeCompare(String(b[key] || ''), 'tr', {numeric:true}) * factor);
    }

    renderTable(containerId, theadId, tbodyId) {
        document.getElementById('oppReportTabs')?.remove();
        const thead = document.getElementById(theadId);
        const tbody = document.getElementById(tbodyId);
        document.getElementById('reportResultTitle').textContent = `Müvekkile Ait İşler — ${this.rows.length.toLocaleString('tr-TR')} kayıt`;
        // İtiraz raporunun eski th.sortable tıklama olayıyla çakışmamak için ayrı class.
        if (this._thead !== thead) {
            this._thead = thead;
            thead.addEventListener('click', event => {
                if (window.MainReportController?.currentStrategy !== this) return;
                const button = event.target.closest('[data-client-task-sort]');
                if (!button) return;
                const newKey = button.dataset.clientTaskSort;
                this.sortAscending = this.sortKey === newKey ? !this.sortAscending : newKey !== 'created_at';
                this.sortKey = newKey;
                this._sortRows();
                this.page = 0;
                this._renderBody(tbody);
            });
        }
        thead.innerHTML = `<tr>
            <th><button type="button" class="btn btn-link btn-sm font-weight-bold p-0" data-client-task-sort="id">İş No</button></th>
            <th><button type="button" class="btn btn-link btn-sm font-weight-bold p-0" data-client-task-sort="client">Müvekkil</button></th>
            <th>İşlem Adı</th>
            <th>Marka / Dosya</th>
            <th><button type="button" class="btn btn-link btn-sm font-weight-bold p-0" data-client-task-sort="created_at">Oluşturulma</button></th>
            <th>Son Tarih</th>
            <th><button type="button" class="btn btn-link btn-sm font-weight-bold p-0" data-client-task-sort="status">Durum</button></th>
        </tr>`;
        this._renderBody(tbody);
    }

    _renderBody(tbody) {
        const pageCount = Math.max(1, Math.ceil(this.rows.length / DISPLAY_PAGE_SIZE));
        this.page = Math.min(this.page, pageCount - 1);
        const visible = this.rows.slice(this.page * DISPLAY_PAGE_SIZE, (this.page + 1) * DISPLAY_PAGE_SIZE);
        tbody.innerHTML = visible.length ? visible.map(row => `<tr>
            <td style="white-space:nowrap;"><a href="task-update.html?id=${encodeURIComponent(row.id)}" class="font-weight-bold" target="_blank" rel="noopener noreferrer">${escapeHtml(row.id)}</a></td>
            <td>${escapeHtml(row.client)}</td>
            <td><strong>${escapeHtml(row.type)}</strong>${row.title && row.title !== row.type ? `<div class="text-muted small">${escapeHtml(row.title)}</div>` : ''}</td>
            <td>${escapeHtml(row.mark || '-')} ${row.applicationNo ? `<div class="text-muted small">${escapeHtml(row.applicationNo)}</div>` : ''}</td>
            <td style="white-space:nowrap;">${escapeHtml(dateTimeLabel(row.created_at))}</td>
            <td style="white-space:nowrap;">${escapeHtml(dateLabel(row.officialDue || row.operationalDue || row.deliveryDate))}</td>
            <td><span class="badge badge-light border" style="white-space:normal;">${escapeHtml(row.status)}</span></td>
        </tr>`).join('') : '<tr><td colspan="7" class="text-center py-5 text-muted">Bu kriterlere uygun iş bulunamadı.</td></tr>';
        let pager = document.getElementById('clientTasksPager');
        if (!pager) {
            pager = document.createElement('div');
            pager.id = 'clientTasksPager';
            pager.className = 'px-3 pb-3 d-flex flex-wrap align-items-center justify-content-between';
            const tableWrapper = document.getElementById('dynamicReportTable').closest('.table-responsive');
            tableWrapper.insertAdjacentElement('afterend', pager);
            pager.addEventListener('click', event => {
                const button = event.target.closest('button[data-client-page]');
                if (!button || window.MainReportController?.currentStrategy !== this) return;
                this.page = Math.min(Math.max(0, this.page + Number(button.dataset.clientPage)), Math.ceil(this.rows.length / DISPLAY_PAGE_SIZE) - 1 || 0);
                this._renderBody(tbody);
            });
        }
        pager.innerHTML = `<small class="text-muted">Toplam ${this.rows.length.toLocaleString('tr-TR')} iş · Excel/PDF tüm sonuçları içerir.</small>
            <div class="d-flex align-items-center" style="gap:10px;">
                <button type="button" class="btn btn-outline-secondary btn-sm" data-client-page="-1" ${this.page === 0 ? 'disabled' : ''}>Önceki</button>
                <span class="small">${this.page + 1} / ${pageCount}</span>
                <button type="button" class="btn btn-outline-secondary btn-sm" data-client-page="1" ${this.page >= pageCount - 1 ? 'disabled' : ''}>Sonraki</button>
            </div>`;
    }

    async exportExcel() {
        await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js', () => !!window.ExcelJS);
        await loadExternalScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js', () => !!window.saveAs);
        const workbook = new window.ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Müvekkile Ait İşler', {views:[{state:'frozen',ySplit:1}]});
        sheet.columns = [
            {header:'İş No',key:'id',width:16}, {header:'Müvekkil',key:'client',width:36},
            {header:'İşlem Adı',key:'type',width:32}, {header:'Görev Başlığı',key:'title',width:36},
            {header:'Görev Açıklaması',key:'description',width:38}, {header:'Marka / Dosya',key:'mark',width:30},
            {header:'Başvuru No',key:'applicationNo',width:20}, {header:'Oluşturulma Tarihi',key:'created',width:24},
            {header:'Resmi Son Tarih',key:'officialDue',width:18}, {header:'Operasyonel Son Tarih',key:'operationalDue',width:22},
            {header:'Teslim Tarihi',key:'deliveryDate',width:17}, {header:'Durum',key:'status',width:24},
            {header:'Öncelik',key:'priority',width:13}, {header:'Müvekkil Person ID',key:'clientId',width:38}
        ];
        sheet.getRow(1).eachCell(cell => {
            cell.font = {bold:true,color:{argb:'FFFFFFFF'}};
            cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1A2B4C'}};
            cell.alignment = {vertical:'middle',wrapText:true};
        });
        sheet.getRow(1).height = 30;
        for (const row of this.rows) sheet.addRow({
            id:row.id,client:row.client,type:row.type,title:row.title,description:row.description,
            mark:row.mark,applicationNo:row.applicationNo,created:dateTimeLabel(row.created_at),
            officialDue:dateLabel(row.officialDue),operationalDue:dateLabel(row.operationalDue),
            deliveryDate:dateLabel(row.deliveryDate),status:row.status,priority:row.priority,clientId:row.clientId
        });
        sheet.autoFilter = {from:'A1',to:'N1'};
        const content = await workbook.xlsx.writeBuffer();
        window.saveAs(new Blob([content]), `Muvekkile_Ait_Isler_${new Date().toISOString().slice(0,10)}.xlsx`);
    }

    async exportPDF() {
        await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', () => !!window.jspdf);
        await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.29/jspdf.plugin.autotable.min.js', () => !!window.jspdf?.jsPDF?.API?.autoTable);
        const doc = new window.jspdf.jsPDF({orientation:'landscape',format:'a3'});
        const ascii = value => String(value || '-').replace(/[ĞğÜüŞşİıÖöÇç]/g, c => ({'Ğ':'G','ğ':'g','Ü':'U','ü':'u','Ş':'S','ş':'s','İ':'I','ı':'i','Ö':'O','ö':'o','Ç':'C','ç':'c'}[c]));
        doc.setFontSize(14);
        doc.text('MUVEKKILE AIT ISLER', 14, 16);
        doc.setFontSize(9);
        doc.text(`Toplam: ${this.rows.length}  |  Olusturulma: ${this.dateFrom || 'Baslangic yok'} - ${this.dateTo || 'Bitis yok'}`, 14, 23);
        doc.autoTable({
            startY: 29,
            head:[['Is No','Muvekkil','Islem Adi','Marka / Dosya','Basvuru No','Olusturulma','Son Tarih','Durum']],
            body:this.rows.map(r => [ascii(r.id),ascii(r.client),ascii(r.type),ascii(r.mark),ascii(r.applicationNo),dateTimeLabel(r.created_at),dateLabel(r.officialDue || r.operationalDue || r.deliveryDate),ascii(r.status)]),
            styles:{fontSize:8,cellPadding:2,overflow:'linebreak'},
            headStyles:{fillColor:[26,43,76]}
        });
        doc.save(`Muvekkile_Ait_Isler_${new Date().toISOString().slice(0,10)}.pdf`);
    }
}
