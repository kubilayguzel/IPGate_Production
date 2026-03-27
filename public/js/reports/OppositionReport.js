import { supabase } from '../../supabase-config.js';

export class OppositionReport {
    constructor() {
        this.selectedClients = new Map();
        this.reportData = [];
        this.targetTaskTypes = [7, 8, 9, 19, 20, 21, 37, 38, 39]; 
        
        // ORTAK STATÜ ÇEVİRİ HARİTASI
        this.statusMap = { 
            'pending': 'İşlem Bekliyor', 
            'awaiting_client_approval': 'Onay Bekliyor', 
            'open': 'Açık / Talimat Bekliyor', 
            'completed': 'Tamamlandı',
            'client_approval_closed': 'Müvekkil Onayıyla Kapatıldı',
            'müvekkil onayı - kapatıldı': 'Müvekkil Onayıyla Kapatıldı',
            'cancelled': 'İptal Edildi'
        };
    }

    // 1. ARAMA VE FİLTRE EKRANINI ÇİZ
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

    // 2. VERİLERİ ÇEK VE YENİ TERTEMİZ ŞEMAYA GÖRE HARMANLA
    async fetchData() {
        console.log("🚀 Rapor Üretimi Başladı...");
        const clientIds = Array.from(this.selectedClients.keys());
        
        console.log("1. Görevler çekiliyor...");
        const { data: tasks, error } = await supabase
            .from('tasks')
            .select('id, title, status, created_at, task_type_id, details, ip_record_id, task_owner_id')
            .in('task_type_id', this.targetTaskTypes)
            .in('task_owner_id', clientIds);

        if (error) {
            console.error("❌ Görevler çekilirken hata:", error);
            throw error;
        }
        if (!tasks || tasks.length === 0) { 
            console.warn("⚠️ Kriterlere uygun görev bulunamadı.");
            this.reportData = []; 
            return; 
        }
        console.log(`✅ ${tasks.length} adet görev bulundu.`);

        const { data: txTypes } = await supabase.from('transaction_types').select('id, name, alias').in('id', this.targetTaskTypes);
        const txTypesMap = new Map();
        if (txTypes) txTypes.forEach(t => txTypesMap.set(String(t.id), t));

        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const rawIpRecordIds = [...new Set(tasks.map(t => t.ip_record_id).filter(Boolean))];
        const ipRecordIds = rawIpRecordIds.filter(id => uuidRegex.test(id)); 

        const ipMap = new Map();
        let appNosToFetch = [];

        if (ipRecordIds.length > 0) {
            console.log("3. IP Records çekiliyor...");
            const { data: ipRecords, error: ipError } = await supabase
                .from('ip_records')
                .select('id, application_number, record_owner_type')
                .in('id', ipRecordIds);
                
            if (ipError) console.error("❌ ip_records hatası:", ipError);
            else if (ipRecords) {
                ipRecords.forEach(ip => {
                    ipMap.set(ip.id, ip);
                    if (ip.application_number) appNosToFetch.push(ip.application_number);
                });
            }
        }

        tasks.forEach(t => {
            let details = {};
            if (t.details) {
                if (typeof t.details === 'string') {
                    try { details = JSON.parse(t.details); } catch(e) {}
                    if (typeof details === 'string') { try { details = JSON.parse(details); } catch(e) {} }
                } else if (typeof t.details === 'object') {
                    details = t.details;
                }
            }
            t._parsedDetails = details; 
            const appNo = details.target_app_no || details.iprecordApplicationNo || details.targetAppNo || details.application_number;
            if (appNo) appNosToFetch.push(appNo);
        });

        const tmDetailsMap = new Map();
        if (ipRecordIds.length > 0) {
            const { data: tmDetails, error: tmError } = await supabase
                .from('ip_record_trademark_details')
                .select('ip_record_id, brand_name')
                .in('ip_record_id', ipRecordIds);
            if (!tmError && tmDetails) tmDetails.forEach(tm => tmDetailsMap.set(tm.ip_record_id, tm));
        }

        const rawOwnerIds = [...new Set(tasks.map(t => t.task_owner_id).filter(Boolean))];
        const ownerIds = rawOwnerIds.filter(id => uuidRegex.test(id));
        const personsMap = new Map();
        if (ownerIds.length > 0) {
            const { data: persons, error: pError } = await supabase.from('persons').select('id, name').in('id', ownerIds);
            if (!pError && persons) persons.forEach(p => personsMap.set(p.id, p));
        }

        const bulletinMap = new Map();
        appNosToFetch = [...new Set(appNosToFetch.filter(Boolean))]; 
        if (appNosToFetch.length > 0) {
            const { data: bulletinRecords, error: bError } = await supabase
                .from('trademark_bulletin_records')
                .select('application_number, bulletin_id, holders')
                .in('application_number', appNosToFetch);
            if (!bError && bulletinRecords) {
                bulletinRecords.forEach(br => bulletinMap.set(br.application_number, br));
            }
        }

        console.log("✅ Tüm veriler çekildi, JSON ve Kurallar harmanlanıyor...");

        // 🔥 YENİ VE TEMİZ ŞEMAYA GÖRE HARMANLAMA 🔥
        this.reportData = tasks.map(t => {
            const details = t._parsedDetails || {};
            const typeObj = txTypesMap.get(String(t.task_type_id)) || {};
            const ipRecord = ipMap.get(t.ip_record_id) || {};
            const tmDetail = tmDetailsMap.get(t.ip_record_id) || {};
            const personObj = personsMap.get(t.task_owner_id) || {};
            
            const taskType = typeObj.alias || typeObj.name || `Tip ${t.task_type_id}`;
            
            // Başvuru Numarası: Öncelik ip_records tablosunda, yoksa detaylarda
            let appNo = ipRecord.application_number || details.target_app_no || details.iprecordApplicationNo || details.targetAppNo || details.application_number || '-';
            if (String(appNo).trim().toLowerCase() === 'undefined') appNo = '-';

            const bulletinRecord = appNo !== '-' ? bulletinMap.get(appNo) : null;

            // Bülten Numarası: Öncelik yeni temizlenen 'bulletin_no' alanında
            let bultenNo = details.bulletin_no || details.bulletinNo || bulletinRecord?.bulletin_id || details.brandInfo?.opposedMarkBulletinNo || '-';
            if (String(bultenNo).trim().toLowerCase() === 'undefined') bultenNo = '-';

            // Talep Sahibi (Görev Sahibi)
            let talepSahibi = personObj.name || '-';
            
            // Marka Sahibi (Rakip)
            // 1. ÖNCELİK: Sizin için özel oluşturduğumuz TPE API onaylı 'opposed_mark_owner'
            let markaSahibi = details.opposed_mark_owner || '-';
            
            // 2. ÖNCELİK (Diğer görev tipleri için eski fallback'ler):
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
                    if (details.iprecordApplicantName) {
                        markaSahibi = details.iprecordApplicantName;
                    } else if (ipRecord.record_owner_type === 'third_party') {
                        markaSahibi = details.relatedPartyName || details.competitorOwner || '-';
                    } else {
                        markaSahibi = personObj.name || '-';
                    }
                }
            }

            // Marka Adı
            let markaAdi = tmDetail.brand_name || details.recordTitle || details.iprecordTitle || details.related_ip_record_title || details.objectionTarget || '-';

            if (String(markaAdi).trim().toLowerCase() === 'undefined') markaAdi = '-';
            if (String(markaSahibi).trim().toLowerCase() === 'undefined') markaSahibi = '-';

            return {
                taskType, bultenNo, markaAdi, appNo, talepSahibi, markaSahibi,
                status: t.status, createdAt: t.created_at
            };
        }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        console.log("🎯 Rapor verisi başarıyla oluşturuldu!");
    }

    // 3. EKRANA ÇİZ 
    renderTable(containerId, theadId, tbodyId) {
        const thead = document.getElementById(theadId);
        const tbody = document.getElementById(tbodyId);

        thead.innerHTML = `<tr>
            <th>Tarih</th>
            <th>İşlem Tipi</th>
            <th>Bülten No</th>
            <th>Başvuru No</th>
            <th>Marka Adı</th>
            <th>Talep Sahibi</th>
            <th>Marka Sahibi</th>
            <th>Durum</th>
        </tr>`;
        
        if (this.reportData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4">Kriterlere uygun itiraz işlemi bulunamadı.</td></tr>';
            return;
        }

        tbody.innerHTML = this.reportData.map(row => `
            <tr>
                <td style="white-space: nowrap;">${new Date(row.createdAt).toLocaleDateString('tr-TR')}</td>
                <td><strong class="text-primary">${row.taskType}</strong></td>
                <td>${row.bultenNo !== '-' ? `<span class="badge badge-light border">${row.bultenNo}</span>` : '-'}</td>
                <td><span class="text-muted">${row.appNo}</span></td>
                <td><span class="font-weight-bold">${row.markaAdi}</span></td>
                <td>${row.talepSahibi}</td>
                <td>${row.markaSahibi}</td>
                <td><span class="badge badge-secondary">${this.statusMap[row.status] || row.status}</span></td>
            </tr>
        `).join('');
    }

    // 4. EXCEL VE PDF ÇIKTILARI
    async exportExcel() {
        if (!window.ExcelJS) await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js');
        if (!window.saveAs) await this._loadScript('https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js');
        
        const workbook = new window.ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('İtiraz Raporu', { views: [{ showGridLines: false }] });
        
        worksheet.columns = [
            { header: 'No', key: 'no', width: 6 },
            { header: 'Tarih', key: 'date', width: 15 },
            { header: 'İşlem Tipi', key: 'type', width: 35 },
            { header: 'Bülten No', key: 'bultenNo', width: 12 },
            { header: 'Başvuru No', key: 'appNo', width: 20 },
            { header: 'Marka Adı', key: 'brand', width: 35 },
            { header: 'Talep Sahibi', key: 'talep', width: 45 },
            { header: 'Marka Sahibi', key: 'hedef', width: 45 },
            { header: 'Durum', key: 'status', width: 20 }
        ];

        worksheet.spliceRows(1, 0, [], [], [], []);
        worksheet.mergeCells('A1:I2');
        const titleCell = worksheet.getCell('A1');
        titleCell.value = 'MÜVEKKİL İTİRAZ SÜREÇLERİ RAPORU';
        titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF1E3C72' } };
        titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

        const headerRow = worksheet.getRow(5);
        headerRow.height = 30;
        headerRow.eachCell({ includeEmpty: true }, (cell) => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3C72' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        });

        this.reportData.forEach((row, i) => {
            const dataRow = worksheet.addRow({ 
                no: i + 1,
                date: new Date(row.createdAt).toLocaleDateString('tr-TR'), 
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
        window.saveAs(new Blob([buffer]), `Itiraz_Raporu_${new Date().toISOString().slice(0,10)}.xlsx`);
    }

    async exportPDF() {
        if (!window.jspdf) await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        if (!window.jspdf.jsPDF.API.autoTable) await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.29/jspdf.plugin.autotable.min.js');

        const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        
        const tr = (text) => String(text || '-').replace(/Ğ/g,'G').replace(/ğ/g,'g').replace(/Ü/g,'U').replace(/ü/g,'u').replace(/Ş/g,'S').replace(/ş/g,'s').replace(/İ/g,'I').replace(/ı/g,'i').replace(/Ö/g,'O').replace(/ö/g,'o').replace(/Ç/g,'C').replace(/ç/g,'c');

        doc.setFillColor(30, 60, 114);
        doc.rect(0, 0, 297, 18, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.setTextColor(255, 255, 255);
        doc.text('MUVEKKIL ITIRAZ SURECLERI RAPORU', 14, 12.5);

        const rows = this.reportData.map((row, i) => [
            i + 1,
            new Date(row.createdAt).toLocaleDateString('tr-TR'), 
            tr(row.taskType),
            tr(row.bultenNo !== '-' ? row.bultenNo : ''),
            tr(row.appNo),
            tr(row.markaAdi), 
            tr(row.talepSahibi), 
            tr(row.markaSahibi), 
            tr(this.statusMap[row.status] || row.status)
        ]);

        doc.autoTable({ 
            startY: 25, 
            head: [['No', 'Tarih', 'Islem Tipi', 'Bulten', 'Basvuru No', 'Marka Adi', 'Talep Sahibi', 'Marka Sahibi', 'Durum']], 
            body: rows,
            theme: 'grid',
            styles: { font: 'helvetica', fontSize: 7, textColor: [55, 55, 55], valign: 'middle' },
            headStyles: { fillColor: [30, 60, 114], textColor: 255, fontStyle: 'bold', halign: 'center' },
            columnStyles: {
                0: { cellWidth: 8, halign: 'center' },
                1: { cellWidth: 16, halign: 'center' },
                2: { cellWidth: 32 },
                3: { cellWidth: 12, halign: 'center' },
                4: { cellWidth: 20 },
                5: { cellWidth: 35 },
                6: { cellWidth: 55 },
                7: { cellWidth: 55 },
                8: { cellWidth: 22 }
            }
        });
        doc.save(`Itiraz_Raporu_${new Date().toISOString().slice(0,10)}.pdf`);
    }

    _loadScript(src) {
        return new Promise((res, rej) => {
            if (document.querySelector(`script[src="${src}"]`)) return res();
            const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s);
        });
    }
}