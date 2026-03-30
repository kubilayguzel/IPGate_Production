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

        // Durum Metinleri
        this.statusMap = { 
            'pending': 'İşlem Bekliyor', 
            'awaiting_client_approval': 'Onay Bekliyor', 
            'open': 'Açık / Talimat Bekliyor', 
            'completed': 'Tamamlandı',
            'client_approval_closed': 'Müvekkil Onayıyla Kapatıldı',
            'müvekkil onayı - kapatıldı': 'Müvekkil Onayıyla Kapatıldı',
            'cancelled': 'İptal Edildi'
        };

        // 🔥 YENİ: Göz yormayan (Soft) Statü Renkleri
        this.statusColors = {
            'pending': 'background-color: #fff3cd; color: #856404; border: 1px solid #ffeeba;', // Soft Sarı
            'awaiting_client_approval': 'background-color: #cff4fc; color: #055160; border: 1px solid #b6effb;', // Soft Mavi
            'open': 'background-color: #e2e3e5; color: #41464b; border: 1px solid #d3d6d8;', // Soft Gri
            'completed': 'background-color: #d1e7dd; color: #0f5132; border: 1px solid #badbcc;', // Soft Yeşil
            'client_approval_closed': 'background-color: #e2e3e5; color: #41464b; border: 1px solid #d3d6d8;', // Soft Gri
            'müvekkil onayı - kapatıldı': 'background-color: #e2e3e5; color: #41464b; border: 1px solid #d3d6d8;', // Soft Gri
            'cancelled': 'background-color: #f8d7da; color: #842029; border: 1px solid #f5c2c7;' // Soft Kırmızı
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
                const { data } = await supabase.from('persons')
                    .select('id, name')
                    .ilike('name', `%${val}%`)
                    .limit(10);
                
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
        console.log("🚀 Rapor Üretimi Başladı (View Üzerinden)...");
        const clientIds = Array.from(this.selectedClients.keys());
        
        const { data: tasks, error } = await supabase
            .from('v_tasks_dashboard')
            .select('*')
            .in('task_type_id', this.targetTaskTypes)
            .in('task_owner_id', clientIds);

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
                if (typeof t.details === 'string') {
                    try { details = JSON.parse(t.details); } catch(e) {}
                } else if (typeof t.details === 'object') {
                    details = t.details;
                }
            }
            
            const typeObj = txTypesMap.get(String(t.task_type_id)) || {};
            const taskType = typeObj.alias || typeObj.name || `Tip ${t.task_type_id}`;
            
            let appNo = t.iprecordApplicationNo || details.target_app_no || '-';
            let markaAdi = t.iprecordTitle || details.recordTitle || '-';
            let talepSahibi = t.iprecordApplicantName || '-';

            const bulletinRecord = appNo !== '-' ? bulletinMap.get(appNo) : null;
            let bultenNo = t.bulletinNo || bulletinRecord?.bulletin_id || '-';
            let markaSahibi = t.opposedMarkOwner || '-';
            
            if (markaSahibi === '-' || !markaSahibi) {
                if (bulletinRecord && bulletinRecord.holders) {
                    try {
                        const holdersArr = typeof bulletinRecord.holders === 'string' ? JSON.parse(bulletinRecord.holders) : bulletinRecord.holders;
                        if (Array.isArray(holdersArr) && holdersArr.length > 0) {
                            markaSahibi = holdersArr.map(h => h.holderName).filter(Boolean).join(', ');
                        }
                    } catch(e) {}
                }
                if (markaSahibi === '-' || !markaSahibi) {
                    markaSahibi = details.relatedPartyName || details.competitorOwner || '-';
                }
            }

            let completedAt = t.epatsDocumentDate || details.epatsDocumentDate || '-';

            if (String(appNo).trim().toLowerCase() === 'undefined') appNo = '-';
            if (String(markaAdi).trim().toLowerCase() === 'undefined') markaAdi = '-';
            if (String(bultenNo).trim().toLowerCase() === 'undefined') bultenNo = '-';
            if (String(markaSahibi).trim().toLowerCase() === 'undefined') markaSahibi = '-';
            if (String(completedAt).trim().toLowerCase() === 'undefined' || completedAt === null) completedAt = '-';

            const rowData = {
                taskId: t.id, 
                taskType, bultenNo, markaAdi, appNo, talepSahibi, markaSahibi,
                status: t.status, createdAt: t.created_at, completedAt
            };

            if (t.recordOwnerType === 'self') {
                this.reportDataSelf.push(rowData);
            } else {
                this.reportDataThirdParty.push(rowData);
            }
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
                if (valA < valB) return this.sortAsc ? -1 : 1;
                if (valA > valB) return this.sortAsc ? 1 : -1;
                return 0;
            } 
            // 🔥 YENİ: Sayısal Duyarlı Sıralama (Örn: İş-2, İş-10'dan önce gelir)
            else if (this.sortCol === 'taskId' || this.sortCol === 'bultenNo') {
                valA = String(valA || '');
                valB = String(valB || '');
                return valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' }) * (this.sortAsc ? 1 : -1);
            } 
            else {
                valA = String(valA || '').toLowerCase();
                valB = String(valB || '').toLowerCase();
                if (valA < valB) return this.sortAsc ? -1 : 1;
                if (valA > valB) return this.sortAsc ? 1 : -1;
                return 0;
            }
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
                if (this.sortCol === col) {
                    this.sortAsc = !this.sortAsc; 
                } else {
                    this.sortCol = col;
                    this.sortAsc = true; 
                }
                
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
            <th class="sortable" data-sort="taskId" style="cursor:pointer; user-select:none;">İş No ${getSortIcon('taskId')}</th>
            <th class="sortable" data-sort="createdAt" style="cursor:pointer; user-select:none;">Oluşturulma ${getSortIcon('createdAt')}</th>
            <th class="sortable" data-sort="completedAt" style="cursor:pointer; user-select:none;">Tamamlanma ${getSortIcon('completedAt')}</th>
            <th class="sortable" data-sort="taskType" style="cursor:pointer; user-select:none;">İşlem Tipi ${getSortIcon('taskType')}</th>
            <th class="sortable" data-sort="bultenNo" style="cursor:pointer; user-select:none;">Bülten No ${getSortIcon('bultenNo')}</th>
            <th class="sortable" data-sort="appNo" style="cursor:pointer; user-select:none;">Başvuru No ${getSortIcon('appNo')}</th>
            <th class="sortable" data-sort="markaAdi" style="cursor:pointer; user-select:none;">Marka Adı ${getSortIcon('markaAdi')}</th>
            <th class="sortable" data-sort="talepSahibi" style="cursor:pointer; user-select:none;">${col1Header} ${getSortIcon('talepSahibi')}</th>
            <th class="sortable" data-sort="markaSahibi" style="cursor:pointer; user-select:none;">${col2Header} ${getSortIcon('markaSahibi')}</th>
            <th class="sortable" data-sort="status" style="cursor:pointer; user-select:none;">Durum ${getSortIcon('status')}</th>
        </tr>`;

        if (activeData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center py-5 text-muted"><i class="fas fa-folder-open mb-3" style="font-size:2rem;"></i><br>Bu sekmede gösterilecek itiraz işlemi bulunamadı.</td></tr>';
            return;
        }

        tbody.innerHTML = activeData.map(row => {
            let formattedCompleted = '-';
            if (row.completedAt !== '-') {
                const cDate = new Date(row.completedAt);
                if (!isNaN(cDate)) formattedCompleted = cDate.toLocaleDateString('tr-TR');
                else formattedCompleted = row.completedAt; 
            }

            const shortId = (row.taskId || '').split('-')[0].toUpperCase();
            
            // 🔥 YENİ: Soft Tonlarda Statü Kutusu
            const statusStyle = this.statusColors[row.status] || 'background-color: #f8f9fa; color: #6c757d; border: 1px solid #dee2e6;';

            return `
            <tr>
                <td title="${row.taskId}">${shortId}</td>
                <td style="white-space: nowrap;">${new Date(row.createdAt).toLocaleDateString('tr-TR')}</td>
                <td style="white-space: nowrap; font-weight:600; color:#2E59D9;">${formattedCompleted}</td>
                <td><strong class="text-primary">${row.taskType}</strong></td>
                <td>${row.bultenNo}</td> 
                <td><span class="text-muted">${row.appNo}</span></td>
                <td><span class="font-weight-bold">${row.markaAdi}</span></td>
                <td>${row.talepSahibi}</td>
                <td>${row.markaSahibi}</td>
                <td><span class="badge" style="padding: 6px 10px; font-weight: 500; letter-spacing: 0.3px; ${statusStyle}">${this.statusMap[row.status] || row.status}</span></td>
            </tr>
        `}).join('');
    }

    async exportExcel() {
        if (!window.ExcelJS) await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js');
        if (!window.saveAs) await this._loadScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js');
        
        const activeData = this.activeTab === 'third_party' ? this.reportDataThirdParty : this.reportDataSelf;
        const reportTitle = this.activeTab === 'third_party' ? '3. TARAF BAŞVURULARINA İTİRAZLAR' : 'PORTFÖYE GELEN İTİRAZLAR';
        
        const colTalep = this.activeTab === 'third_party' ? 'İtiraz Sahibi' : 'Başvuru Sahibi';
        const colHedef = this.activeTab === 'third_party' ? 'Marka Sahibi' : 'İtiraz Sahibi';

        const workbook = new window.ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('İtiraz Raporu', { views: [{ showGridLines: false }] });
        
        worksheet.columns = [
            { header: 'No', key: 'no', width: 6 },
            { header: 'İş No', key: 'taskId', width: 12 },
            { header: 'Oluşturulma Tarihi', key: 'createdDate', width: 17 },
            { header: 'Tamamlanma Tarihi', key: 'completedDate', width: 17 },
            { header: 'İşlem Tipi', key: 'type', width: 35 },
            { header: 'Bülten No', key: 'bultenNo', width: 12 },
            { header: 'Başvuru No', key: 'appNo', width: 20 },
            { header: 'Marka Adı', key: 'brand', width: 35 },
            { header: colTalep, key: 'talep', width: 45 },
            { header: colHedef, key: 'hedef', width: 45 },
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

        activeData.forEach((row, i) => {
            let formattedCompleted = '-';
            if (row.completedAt !== '-') {
                const cDate = new Date(row.completedAt);
                if (!isNaN(cDate)) formattedCompleted = cDate.toLocaleDateString('tr-TR');
                else formattedCompleted = row.completedAt; 
            }

            const dataRow = worksheet.addRow({ 
                no: i + 1,
                taskId: (row.taskId || '').split('-')[0].toUpperCase(), 
                createdDate: new Date(row.createdAt).toLocaleDateString('tr-TR'), 
                completedDate: formattedCompleted,
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

        const buffer = await workbook.xlsx.writeBuffer();
        window.saveAs(new Blob([buffer]), `Itiraz_Raporu_${this.activeTab}_${new Date().toISOString().slice(0,10)}.xlsx`);
    }

    async exportPDF() {
        if (!window.jspdf) await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        if (!window.jspdf.jsPDF.API.autoTable) await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.29/jspdf.plugin.autotable.min.js');

        const activeData = this.activeTab === 'third_party' ? this.reportDataThirdParty : this.reportDataSelf;
        const reportTitle = this.activeTab === 'third_party' ? '3. TARAF BASVURULARINA ITIRAZLAR' : 'PORTFOYE GELEN ITIRAZLAR';
        
        const colTalep = this.activeTab === 'third_party' ? 'Itiraz Sahibi' : 'Basvuru Sahibi';
        const colHedef = this.activeTab === 'third_party' ? 'Marka Sahibi' : 'Itiraz Sahibi';

        const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const tr = (text) => String(text || '-').replace(/Ğ/g,'G').replace(/ğ/g,'g').replace(/Ü/g,'U').replace(/ü/g,'u').replace(/Ş/g,'S').replace(/ş/g,'s').replace(/İ/g,'I').replace(/ı/g,'i').replace(/Ö/g,'O').replace(/ö/g,'o').replace(/Ç/g,'C').replace(/ç/g,'c');

        doc.setFillColor(30, 60, 114);
        doc.rect(0, 0, 297, 18, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.setTextColor(255, 255, 255);
        doc.text(`MUVEKKIL ITIRAZ RAPORU (${reportTitle})`, 14, 12.5);

        const rows = activeData.map((row, i) => {
            let formattedCompleted = '-';
            if (row.completedAt !== '-') {
                const cDate = new Date(row.completedAt);
                if (!isNaN(cDate)) formattedCompleted = cDate.toLocaleDateString('tr-TR');
                else formattedCompleted = row.completedAt; 
            }

            return [
                i + 1,
                (row.taskId || '').split('-')[0].toUpperCase(),
                new Date(row.createdAt).toLocaleDateString('tr-TR'), 
                formattedCompleted,
                tr(row.taskType),
                tr(row.bultenNo !== '-' ? row.bultenNo : ''),
                tr(row.appNo),
                tr(row.markaAdi), 
                tr(row.talepSahibi), 
                tr(row.markaSahibi), 
                tr(this.statusMap[row.status] || row.status)
            ];
        });

        doc.autoTable({ 
            startY: 25, 
            head: [['No', 'Is No', 'Olusturulma\nTarihi', 'Tamamlanma\nTarihi', 'Islem Tipi', 'Bulten', 'Basvuru No', 'Marka Adi', colTalep, colHedef, 'Durum']], 
            body: rows,
            theme: 'grid',
            styles: { font: 'helvetica', fontSize: 7, textColor: [55, 55, 55], valign: 'middle' },
            headStyles: { fillColor: [30, 60, 114], textColor: 255, fontStyle: 'bold', halign: 'center' },
            columnStyles: {
                0: { cellWidth: 8, halign: 'center' },
                1: { cellWidth: 18, halign: 'center' },
                2: { cellWidth: 16, halign: 'center' },
                3: { cellWidth: 16, halign: 'center' },
                4: { cellWidth: 26 },
                5: { cellWidth: 12, halign: 'center' },
                6: { cellWidth: 18 },
                7: { cellWidth: 32 },
                8: { cellWidth: 40 },
                9: { cellWidth: 40 },
                10: { cellWidth: 18 }
            }
        });
        
        doc.save(`Itiraz_Raporu_${this.activeTab}_${new Date().toISOString().slice(0,10)}.pdf`);
    }

    _loadScript(src) {
        return new Promise((res, rej) => {
            if (document.querySelector(`script[src="${src}"]`)) return res();
            const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
        });
    }
}