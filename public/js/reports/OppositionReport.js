import { supabase } from '../../supabase-config.js';

export class OppositionReport {
    constructor() {
        this.selectedClients = new Map();
        this.reportDataThirdParty = []; 
        this.reportDataSelf = [];       
        this.activeTab = 'third_party'; 
        
        this.targetTaskTypes = [7, 8, 9, 19, 20, 21, 37, 38, 39]; 
        this.sortCol = 'taskId'; 
        this.sortAsc = false;    
        this._isSortBound = false; 

        this.statusMap = { 
            'pending': 'İşlem Bekliyor', 
            'awaiting_client_approval': 'Onay Bekliyor', 
            'open': 'Açık / Talimat Bekliyor', 
            'completed': 'Tamamlandı',
            'client_approval_closed': 'Müvekkil Onayıyla Kapatıldı',
            'müvekkil onayı - kapatıldı': 'Müvekkil Onayıyla Kapatıldı',
            'cancelled': 'İptal Edildi'
        };

        this.statusColors = {
            'pending': 'background-color: #fff3cd; color: #856404; border: 1px solid #ffeeba;',
            'awaiting_client_approval': 'background-color: #cff4fc; color: #055160; border: 1px solid #b6effb;',
            'open': 'background-color: #e2e3e5; color: #41464b; border: 1px solid #d3d6d8;',
            'completed': 'background-color: #d1e7dd; color: #0f5132; border: 1px solid #badbcc;',
            'cancelled': 'background-color: #f8d7da; color: #842029; border: 1px solid #f5c2c7;'
        };
    }

    renderFilters(containerId) {
        const container = document.getElementById(containerId);
        container.innerHTML = `
            <div class="col-md-8 mb-3">
                <label class="form-label font-weight-bold text-primary"><i class="fas fa-user-tie mr-2"></i>Müvekkil Ara ve Ekle</label>
                <div class="search-input-wrapper w-100">
                    <input type="text" id="clientSearchInput" class="form-input" placeholder="Müvekkil adı yazın...">
                    <div id="clientSearchResults" class="search-results-list" style="display:none;"></div>
                </div>
            </div>
            <div class="col-md-4 mb-3 d-flex align-items-end">
                <button id="btnGenerateReport" class="btn btn-success btn-lg btn-block rounded-pill shadow-sm" disabled>
                    <i class="fas fa-play mr-2"></i> Raporu Üret
                </button>
            </div>
            <div class="col-md-12 mt-3">
                <label class="form-label font-weight-bold">Seçilen Müvekkiller</label>
                <div id="selectedClientsTags" class="selected-items-container border rounded bg-light p-3">
                    <div class="empty-state text-center py-3"><small class="text-muted m-0">Henüz müvekkil seçilmedi.</small></div>
                </div>
            </div>
        `;
        this.attachFilterEvents();
    }

    attachFilterEvents() {
        const searchInput = document.getElementById('clientSearchInput');
        const resultsDiv = document.getElementById('clientSearchResults');
        const btnGenerate = document.getElementById('btnGenerateReport');

        let timeout = null;
        searchInput.addEventListener('keyup', (e) => {
            clearTimeout(timeout);
            const val = e.target.value.trim();
            if (val.length < 3) { resultsDiv.style.display = 'none'; return; }
            timeout = setTimeout(async () => {
                const { data } = await supabase.from('persons').select('id, name').ilike('name', `%${val}%`).limit(10);
                if (data && data.length > 0) {
                    resultsDiv.innerHTML = data.map(c => `<div class="search-result-item p-2 border-bottom client-result-item" data-id="${c.id}" data-name="${c.name}" style="cursor:pointer;">${c.name}</div>`).join('');
                    resultsDiv.style.display = 'block';
                } else {
                    resultsDiv.innerHTML = '<div class="p-2 text-muted">Sonuç bulunamadı</div>';
                    resultsDiv.style.display = 'block';
                }
            }, 400);
        });

        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('client-result-item')) {
                const id = e.target.dataset.id;
                const name = e.target.dataset.name;
                this.selectedClients.set(id, name);
                this.updateTagsUI();
                searchInput.value = '';
                resultsDiv.style.display = 'none';
                btnGenerate.disabled = false;
            } else if (e.target.closest('.remove-client')) {
                const btn = e.target.closest('.remove-client');
                this.selectedClients.delete(btn.dataset.id);
                this.updateTagsUI();
                if (this.selectedClients.size === 0) btnGenerate.disabled = true;
            } else if (!e.target.closest('.search-input-wrapper')) {
                if (resultsDiv) resultsDiv.style.display = 'none';
            }
        });

        btnGenerate.addEventListener('click', () => {
            if (window.MainReportController) window.MainReportController.executeReport(this);
        });
    }

    updateTagsUI() {
        const container = document.getElementById('selectedClientsTags');
        if (this.selectedClients.size === 0) {
            container.innerHTML = '<div class="empty-state text-center py-3"><small class="text-muted m-0">Henüz müvekkil seçilmedi.</small></div>';
            return;
        }
        let html = '';
        this.selectedClients.forEach((name, id) => {
            html += `
            <div class="selected-item mb-2 d-flex justify-content-between align-items-center p-2 bg-white border rounded">
                <span class="font-weight-bold text-primary"><i class="fas fa-user-tie mr-2"></i>${name}</span>
                <button type="button" class="remove-selected-item-btn remove-client btn btn-sm text-danger" style="background:transparent; border:none;" data-id="${id}">
                    <i class="fas fa-times pointer-events-none"></i>
                </button>
            </div>`;
        });
        container.innerHTML = html;
    }

    async fetchData() {
        const clientIds = Array.from(this.selectedClients.keys());
        const { data: tasks, error } = await supabase.from('v_tasks_dashboard').select('*').in('task_type_id', this.targetTaskTypes).in('task_owner_id', clientIds);

        if (error) throw error;
        if (!tasks || tasks.length === 0) { 
            this.reportDataThirdParty = [];
            this.reportDataSelf = [];
            return; 
        }

        const { data: txTypes } = await supabase.from('transaction_types').select('id, name, alias').in('id', this.targetTaskTypes);
        const txTypesMap = new Map();
        if (txTypes) txTypes.forEach(t => txTypesMap.set(String(t.id), t));

        let appNosToFetch = [...new Set(tasks.map(t => t.iprecordApplicationNo).filter(Boolean))];
        const bulletinMap = new Map();
        
        if (appNosToFetch.length > 0) {
            const { data: bulletinRecords } = await supabase
                .from('trademark_bulletin_records')
                .select('application_number, bulletin_id, holders')
                .in('application_number', appNosToFetch);
            if (bulletinRecords) {
                bulletinRecords.forEach(br => bulletinMap.set(br.application_number, br));
            }
        }

        this.reportDataThirdParty = [];
        this.reportDataSelf = [];

        tasks.forEach(t => {
            let details = {};
            if (t.details) {
                try { details = typeof t.details === 'string' ? JSON.parse(t.details) : t.details; } catch(e) {}
            }
            
            const typeObj = txTypesMap.get(String(t.task_type_id)) || {};
            const taskType = typeObj.alias || typeObj.name || `Tip ${t.task_type_id}`;
            const appNo = t.iprecordApplicationNo || '-';
            const markaAdi = t.iprecordTitle || '-';
            const talepSahibi = t.iprecordApplicantName || '-';
            const bultenNo = t.bulletinNo || '-';
            const completedAt = t.epatsDocumentDate || '-';

            // 🔥 ÇÖZÜM: Genişletilmiş İtiraz Sahibi (Fallback) Taraması
            let markaSahibiDisplay = '-';
            
            if (t.recordOwnerType === 'self') {
                // Portföye gelen itiraz: itiraz eden kişiyi (oppositionOwner) göster
                markaSahibiDisplay = t.oppositionOwner || details.opposition_owner || details.oppositionOwner || details.relatedPartyName || details.competitorOwner || '-';
            } else {
                // Rakip markaya itiraz: markanın sahibini (opposedMarkOwner) göster
                markaSahibiDisplay = t.opposedMarkOwner || details.opposed_mark_owner || details.opposedMarkOwner || '-';
                
                // TPE Bülten Yedeklemesi
                if (markaSahibiDisplay === '-' || !markaSahibiDisplay) {
                    const bulletinRecord = appNo !== '-' ? bulletinMap.get(appNo) : null;
                    if (bulletinRecord && bulletinRecord.holders) {
                        try {
                            const holdersArr = typeof bulletinRecord.holders === 'string' ? JSON.parse(bulletinRecord.holders) : bulletinRecord.holders;
                            if (Array.isArray(holdersArr) && holdersArr.length > 0) {
                                markaSahibiDisplay = holdersArr.map(h => h.holderName).filter(Boolean).join(', ');
                            }
                        } catch(e) {}
                    }
                    if (markaSahibiDisplay === '-' || !markaSahibiDisplay) {
                        markaSahibiDisplay = details.relatedPartyName || details.competitorOwner || '-';
                    }
                }
            }

            const rowData = {
                taskId: t.id, 
                taskType, bultenNo, markaAdi, appNo, talepSahibi, 
                markaSahibi: markaSahibiDisplay,
                status: t.status, createdAt: t.created_at, completedAt
            };

            if (t.recordOwnerType === 'self') this.reportDataSelf.push(rowData);
            else this.reportDataThirdParty.push(rowData);
        });

        this.applySorting();
    }

    applySorting() {
        const sortFn = (a, b) => {
            let valA = a[this.sortCol];
            let valB = b[this.sortCol];

            if (this.sortCol === 'createdAt' || this.sortCol === 'completedAt') {
                valA = valA === '-' ? 0 : new Date(valA).getTime();
                valB = valB === '-' ? 0 : new Date(valB).getTime();
                return (valA - valB) * (this.sortAsc ? 1 : -1);
            } 
            return String(valA || '').localeCompare(String(valB || ''), undefined, { numeric: true, sensitivity: 'base' }) * (this.sortAsc ? 1 : -1);
        };

        this.reportDataThirdParty.sort(sortFn);
        this.reportDataSelf.sort(sortFn);
    }

    renderTable(containerId, theadId, tbodyId) {
        const container = document.getElementById(containerId);
        const thead = document.getElementById(theadId);
        const tbody = document.getElementById(tbodyId);

        if (!document.getElementById('oppReportTabs')) {
            const tabsHtml = `
                <ul class="nav nav-tabs mb-3" id="oppReportTabs" style="border-bottom: 2px solid #dee2e6;">
                    <li class="nav-item">
                        <a class="nav-link active font-weight-bold" href="#" data-tab="third_party" style="color: #1e3c72;">
                            <i class="fas fa-shield-alt mr-1"></i> 3. Taraf Başvurularına İtirazlar <span class="badge badge-primary ml-1" id="countThirdParty">0</span>
                        </a>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link font-weight-bold" href="#" data-tab="self" style="color: #6c757d;">
                            <i class="fas fa-briefcase mr-1"></i> Portföye Gelen İtirazlar <span class="badge badge-secondary ml-1" id="countSelf">0</span>
                        </a>
                    </li>
                </ul>
            `;
            container.insertAdjacentHTML('afterbegin', tabsHtml);

            document.getElementById('oppReportTabs').addEventListener('click', (e) => {
                const tabLink = e.target.closest('a.nav-link');
                if (!tabLink) return;
                e.preventDefault();
                document.querySelectorAll('#oppReportTabs a.nav-link').forEach(a => {
                    a.classList.remove('active');
                    a.style.color = '#6c757d';
                    a.querySelector('.badge').classList.replace('badge-primary', 'badge-secondary');
                });
                tabLink.classList.add('active');
                tabLink.style.color = '#1e3c72';
                tabLink.querySelector('.badge').classList.replace('badge-secondary', 'badge-primary');
                this.activeTab = tabLink.dataset.tab;
                this.updateTableContent(thead, tbody);
            });
        }

        if (!this._isSortBound) {
            thead.addEventListener('click', (e) => {
                const th = e.target.closest('th.sortable');
                if (!th) return;
                const col = th.dataset.sort;
                if (this.sortCol === col) this.sortAsc = !this.sortAsc; 
                else { this.sortCol = col; this.sortAsc = true; }
                this.applySorting();
                this.updateTableContent(thead, tbody);
            });
            this._isSortBound = true;
        }

        document.getElementById('countThirdParty').textContent = this.reportDataThirdParty.length;
        document.getElementById('countSelf').textContent = this.reportDataSelf.length;
        this.updateTableContent(thead, tbody);
    }

    updateTableContent(thead, tbody) {
        const activeData = this.activeTab === 'third_party' ? this.reportDataThirdParty : this.reportDataSelf;
        const col1Header = this.activeTab === 'third_party' ? 'İtiraz Sahibi' : 'Başvuru Sahibi';
        const col2Header = this.activeTab === 'third_party' ? 'Marka Sahibi' : 'İtiraz Sahibi';

        const getSortIcon = (col) => {
            if (this.sortCol !== col) return '<i class="fas fa-sort text-muted ml-1" style="opacity: 0.3;"></i>';
            return this.sortAsc ? '<i class="fas fa-sort-up ml-1 text-primary"></i>' : '<i class="fas fa-sort-down ml-1 text-primary"></i>';
        };

        thead.innerHTML = `<tr>
            <th class="sortable" data-sort="taskId" style="cursor:pointer;">İş No ${getSortIcon('taskId')}</th>
            <th class="sortable" data-sort="createdAt" style="cursor:pointer;">Oluşturulma ${getSortIcon('createdAt')}</th>
            <th class="sortable" data-sort="completedAt" style="cursor:pointer;">Tamamlanma ${getSortIcon('completedAt')}</th>
            <th class="sortable" data-sort="taskType" style="cursor:pointer;">İşlem Tipi ${getSortIcon('taskType')}</th>
            <th class="sortable" data-sort="bultenNo" style="cursor:pointer;">Bülten No ${getSortIcon('bultenNo')}</th>
            <th class="sortable" data-sort="appNo" style="cursor:pointer;">Başvuru No ${getSortIcon('appNo')}</th>
            <th class="sortable" data-sort="markaAdi" style="cursor:pointer;">Marka Adı ${getSortIcon('markaAdi')}</th>
            <th class="sortable" data-sort="talepSahibi" style="cursor:pointer;">${col1Header} ${getSortIcon('talepSahibi')}</th>
            <th class="sortable" data-sort="markaSahibi" style="cursor:pointer;">${col2Header} ${getSortIcon('markaSahibi')}</th>
            <th class="sortable" data-sort="status" style="cursor:pointer;">Durum ${getSortIcon('status')}</th>
        </tr>`;

        if (activeData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center py-5 text-muted">Kayıt bulunamadı.</td></tr>';
            return;
        }

        tbody.innerHTML = activeData.map(row => {
            let formattedCompleted = '-';
            if (row.completedAt !== '-') {
                const cDate = new Date(row.completedAt);
                formattedCompleted = isNaN(cDate) ? row.completedAt : cDate.toLocaleDateString('tr-TR');
            }
            const shortId = (row.taskId || '').split('-')[0].toUpperCase();
            const statusStyle = this.statusColors[row.status] || 'background-color: #f8f9fa; color: #6c757d; border: 1px solid #dee2e6;';

            return `
            <tr>
                <td title="${row.taskId}" style="font-family: inherit;">${shortId}</td>
                <td style="white-space: nowrap;">${new Date(row.createdAt).toLocaleDateString('tr-TR')}</td>
                <td style="white-space: nowrap; font-weight:600; color:#2E59D9;">${formattedCompleted}</td>
                <td><strong class="text-primary">${row.taskType}</strong></td>
                <td>${row.bultenNo}</td> 
                <td><span class="text-muted">${row.appNo}</span></td>
                <td><span class="font-weight-bold">${row.markaAdi}</span></td>
                <td>${row.talepSahibi}</td>
                <td>${row.markaSahibi}</td>
                <td><span class="badge" style="padding: 6px 10px; font-weight: 500; ${statusStyle}">${this.statusMap[row.status] || row.status}</span></td>
            </tr>
        `}).join('');
    }

    // 🔥 YENİ: Excel'de 2 Sekme Aynı Dosyaya Yazdırılıyor
    async exportExcel() {
        if (!window.ExcelJS) await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js');
        if (!window.saveAs) await this._loadScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js');
        
        const workbook = new window.ExcelJS.Workbook();

        // Her bir sekme için ayrı sayfa oluşturacak yardımcı fonksiyon
        const createSheet = (sheetName, data, isThirdParty) => {
            const worksheet = workbook.addWorksheet(sheetName, { views: [{ showGridLines: false }] });
            
            const colTalep = isThirdParty ? 'İtiraz Sahibi' : 'Başvuru Sahibi';
            const colHedef = isThirdParty ? 'Marka Sahibi' : 'İtiraz Sahibi';
            const reportTitle = isThirdParty ? '3. TARAF BAŞVURULARINA İTİRAZLAR' : 'PORTFÖYE GELEN İTİRAZLAR';

            worksheet.columns = [
                { header: 'No', key: 'no', width: 6 },
                { header: 'İş No', key: 'taskId', width: 12 },
                { header: 'Oluşturulma', key: 'createdDate', width: 15 },
                { header: 'Tamamlanma', key: 'completedDate', width: 15 },
                { header: 'İşlem Tipi', key: 'type', width: 30 },
                { header: 'Bülten No', key: 'bultenNo', width: 12 },
                { header: 'Başvuru No', key: 'appNo', width: 18 },
                { header: 'Marka Adı', key: 'brand', width: 30 },
                { header: colTalep, key: 'talep', width: 35 },
                { header: colHedef, key: 'hedef', width: 35 },
                { header: 'Durum', key: 'status', width: 20 }
            ];

            worksheet.spliceRows(1, 0, [], [], [], []);
            worksheet.mergeCells('A1:K2'); 
            const titleCell = worksheet.getCell('A1');
            titleCell.value = `MÜVEKKİL İTİRAZ RAPORU (${reportTitle})`;
            titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF1E3C72' } };
            titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

            const headerRow = worksheet.getRow(5);
            headerRow.height = 30;
            headerRow.eachCell({ includeEmpty: true }, (cell) => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C72' } };
                cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            });

            data.forEach((row, i) => {
                let fComp = '-';
                if (row.completedAt !== '-') {
                    const d = new Date(row.completedAt);
                    fComp = isNaN(d) ? row.completedAt : d.toLocaleDateString('tr-TR');
                }
                
                const dataRow = worksheet.addRow({ 
                    no: i + 1, 
                    taskId: (row.taskId || '').split('-')[0].toUpperCase(), 
                    createdDate: new Date(row.createdAt).toLocaleDateString('tr-TR'), 
                    completedDate: fComp, 
                    type: row.taskType, 
                    bultenNo: row.bultenNo !== '-' ? row.bultenNo : '',
                    appNo: row.appNo, 
                    brand: row.markaAdi, 
                    talep: row.talepSahibi, 
                    hedef: row.markaSahibi, 
                    status: this.statusMap[row.status] || row.status 
                });
                
                dataRow.eachCell(cell => {
                    cell.border = { bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } } };
                    cell.alignment = { vertical: 'middle', wrapText: true };
                });
            });
        };

        // İki sekmeyi de aynı Excel dosyasına sayfa sayfa (Sheet) yazdırıyoruz
        createSheet('3. Taraf İtirazlar', this.reportDataThirdParty, true);
        createSheet('Portföye Gelen İtirazlar', this.reportDataSelf, false);

        const buffer = await workbook.xlsx.writeBuffer();
        window.saveAs(new Blob([buffer]), `Tum_Itiraz_Raporlari_${new Date().toISOString().slice(0,10)}.xlsx`);
    }

    async exportPDF() {
        if (!window.jspdf) await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        if (!window.jspdf.jsPDF.API.autoTable) await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.29/jspdf.plugin.autotable.min.js');
        const activeData = this.activeTab === 'third_party' ? this.reportDataThirdParty : this.reportDataSelf;
        const reportTitle = this.activeTab === 'third_party' ? '3. TARAF BASVURULARINA ITIRAZLAR' : 'PORTFOYE GELEN ITIRAZLAR';
        const colTalep = this.activeTab === 'third_party' ? 'Itiraz Sahibi' : 'Basvuru Sahibi';
        const colHedef = this.activeTab === 'third_party' ? 'Marka Sahibi' : 'Itiraz Sahibi';

        const doc = new window.jspdf.jsPDF({ orientation: 'landscape', format: 'a4' });
        const tr = (t) => String(t || '-').replace(/Ğ/g,'G').replace(/ğ/g,'g').replace(/Ü/g,'U').replace(/ü/g,'u').replace(/Ş/g,'S').replace(/ş/g,'s').replace(/İ/g,'I').replace(/ı/g,'i').replace(/Ö/g,'O').replace(/ö/g,'o').replace(/Ç/g,'C').replace(/ç/g,'c');

        const rows = activeData.map((row, i) => {
            let fComp = '-';
            if (row.completedAt !== '-') {
                const d = new Date(row.completedAt);
                fComp = isNaN(d) ? row.completedAt : d.toLocaleDateString('tr-TR');
            }
            return [
                i + 1, (row.taskId || '').split('-')[0].toUpperCase(),
                new Date(row.createdAt).toLocaleDateString('tr-TR'), fComp,
                tr(row.taskType), tr(row.bultenNo), tr(row.appNo), tr(row.markaAdi), 
                tr(row.talepSahibi), tr(row.markaSahibi), tr(this.statusMap[row.status] || row.status)
            ];
        });

        doc.autoTable({ 
            head: [['No', 'Is No', 'Olusturma', 'Tamamlama', 'Islem Tipi', 'Bulten', 'Basvuru No', 'Marka Adi', colTalep, colHedef, 'Durum']], 
            body: rows,
            styles: { fontSize: 7 }
        });
        doc.save(`Itiraz_Raporu_${this.activeTab}.pdf`);
    }

    _loadScript(src) {
        return new Promise((res, rej) => {
            if (document.querySelector(`script[src="${src}"]`)) return res();
            const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
        });
    }
}