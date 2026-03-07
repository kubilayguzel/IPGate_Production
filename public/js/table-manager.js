// js/table-manager.js

class TableManager {
    constructor(options) {
        // Gerekli DOM element ID'leri
        this.tableId = options.tableId; // 'portfolio-table'
        this.tableBodyId = options.tableBodyId; // 'portfolioTableBody'
        this.tableHeaderRowId = options.tableHeaderRowId; // 'portfolioTableHeaderRow'
        this.tableFilterRowId = options.tableFilterRowId; // 'portfolioTableFilterRow'
        this.globalSearchInputId = options.globalSearchInputId; // 'searchBar' (opsiyonel)
        this.noRecordsMessageId = options.noRecordsMessageId; // 'noRecordsMessage'
        
        // Sütun tanımları: [{ key: 'id', label: 'ID', sortable: true, searchable: true, customFilter: (record, filterValue) => ... }]
        this.columnDefinitions = options.columnDefinitions;
        
        // Veri kaynağı (tüm kayıtlar)
        // Başlangıçta boş veya dışarıdan verilen değerle başlat
        this.allRecords = options.allRecords || []; 
        this.allPersons = options.allPersons || []; 
        this.allUsers = options.allUsers || []; 

        // Filtre ve sıralama durumları
        this.columnFilters = {};
        this.sortBy = { column: null, direction: 'asc' };
        this.globalSearchTerm = ''; // Global arama terimi
        
        // Debounce timeout'ları
        this.globalSearchTimeout = null;
        this.columnFilterTimeout = null;

        // Özel filtreleme veya sıralama için callback'ler
        this.customTypeFilter = options.customTypeFilter || null; 
        this.customSortLogic = options.customSortLogic || null; 
        this.customRecordHtml = options.customRecordHtml || null; 
        this.onRowClick = options.onRowClick || null; // Satır tıklaması için callback
    }

    initializeTable() {
        this.renderTableHeadersAndFilters(); // Başlıkları ve filtreleri oluştur
        this.setupTableEventListeners();    // Event listener'ları ayarla
        // Tabloyu başlangıçta mevcut verilerle render et
        this.applyFiltersAndSort();         
    }

    // Tablo verisini güncellemek ve yeniden render etmek için yeni metod
    setTableData(records) {
        this.allRecords = records;
        this.applyFiltersAndSort();
    }

    // Global arama sorgusunu ayarlamak için metod
    setSearchQuery(query) {
        this.globalSearchTerm = query.toLowerCase();
    }

    // Tablo başlıklarını ve filtre inputlarını dinamik olarak oluşturur
    renderTableHeadersAndFilters() {
        const tableHeaderRow = document.getElementById(this.tableHeaderRowId);
        
        if (!tableHeaderRow) {
            console.error(`Table header (ID: ${this.tableHeaderRowId}) not found. Please ensure this ID is present in your HTML.`);
            return; 
        }

        tableHeaderRow.innerHTML = ''; 

        let tableFilterRow = null;
        if (this.tableFilterRowId) { // tableFilterRowId varsa filtre satırını işlemeye çalış
            tableFilterRow = document.getElementById(this.tableFilterRowId);
            if (!tableFilterRow) {
                console.error(`Table filter row (ID: ${this.tableFilterRowId}) not found. Please ensure this ID is present in your HTML.`);
                return;
            }
            tableFilterRow.innerHTML = ''; // Filtre satırı bulunduysa içeriğini temizle
        }

        // Başlıkları ve filtre inputlarını oluştur
        this.columnDefinitions.forEach(col => {
            // Header Row (Başlıklar)
            const th = document.createElement('th');
            if (col.sortable) {
                th.classList.add('sortable-header');
                th.dataset.column = col.key;
            }
            th.textContent = col.label; 
            tableHeaderRow.appendChild(th);

            // Filter Row (Filtre Inputları) - Sadece filtre satırı varsa oluştur
            const thFilter = document.createElement('th');
            if (col.searchable && tableFilterRow) { // Sadece aranabilir ve filtre satırı varsa input oluştur
                const input = document.createElement('input');
                input.type = 'text';
                input.classList.add('column-filter');
                input.dataset.column = col.key;
                input.placeholder = `${col.label} ara...`;
                input.value = this.columnFilters[col.key] || ''; 
                thFilter.appendChild(input);
            }
            if (tableFilterRow) { // Sadece filtre satırı varsa thFilter'ı ekle
                tableFilterRow.appendChild(thFilter);
            }
        });
    }

    // Tablo event listener'larını ayarlar
    setupTableEventListeners() {
        // Genel arama çubuğu için debounced event listener
        if (this.globalSearchInputId) {
            const globalSearchInput = document.getElementById(this.globalSearchInputId);
            if (globalSearchInput) {
                globalSearchInput.addEventListener('input', (e) => {
                    clearTimeout(this.globalSearchTimeout);
                    this.globalSearchTimeout = setTimeout(() => {
                        this.globalSearchTerm = e.target.value.toLowerCase();
                        this.applyFiltersAndSort();
                    }, 300); // 300ms gecikme
                });
            }
        }

        // Sütun filtreleri için debounced event listener (delegation)
        // `<thead>` elementine event listener ekleyerek input değişikliklerini yakalayabiliriz
        const tableHeaderElement = document.getElementById(this.tableHeaderRowId);
        if (tableHeaderElement && tableHeaderElement.parentElement) {
            if (this.tableFilterRowId) { // Sadece filtre satırı varsa input olaylarını dinle
                tableHeaderElement.parentElement.addEventListener('input', (e) => {
                    if (e.target.classList.contains('column-filter')) {
                        clearTimeout(this.columnFilterTimeout);
                        this.columnFilterTimeout = setTimeout(() => {
                            const columnKey = e.target.dataset.column;
                            this.columnFilters[columnKey] = e.target.value.toLowerCase();
                            this.applyFiltersAndSort();
                        }, 300); // 300ms gecikme
                    }
                });
            }

            // Sıralama (Sorting) için event listener (delegation)
            tableHeaderElement.addEventListener('click', (e) => {
                const targetTh = e.target.closest('.sortable-header');
                if (targetTh) {
                    const columnKey = targetTh.dataset.column;
                    this.toggleSort(columnKey);
                }
            });
        }

        // Satır tıklaması için event delegation
        const tableBody = document.getElementById(this.tableBodyId);
        if (tableBody && this.onRowClick) {
            tableBody.addEventListener('click', (e) => {
                const row = e.target.closest('tr[data-id]'); // data-record-id yerine data-id kullanıldı
                if (row) {
                    // Eğer tıklanan element bir buton ise, onRowClick'i tetikleme (isteğe bağlı)
                    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
                        return; // Buton tıklaması ise satır tıklamasını engelle
                    }
                    this.onRowClick(row.dataset.id);
                }
            });
        }
    }

    // Sıralama yönünü değiştirir ve filtrelemeyi yeniden tetikler
    toggleSort(columnKey) {
        if (this.sortBy.column === columnKey) {
            this.sortBy.direction = this.sortBy.direction === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortBy.column = columnKey;
            this.sortBy.direction = 'asc';
        }
        this.applyFiltersAndSort(); 
    }

    // Filtreleri ve sıralamayı uygulayan ana fonksiyon
    applyFiltersAndSort() {
        const tableBody = document.getElementById(this.tableBodyId);
        const noRecordsMessage = document.getElementById(this.noRecordsMessageId);
        
        if (!tableBody || !noRecordsMessage) {
            console.error(`Table body (ID: ${this.tableBodyId}) or no records message (ID: ${this.noRecordsMessageId}) element not found.`);
            return;
        }

        let filteredRecords = [...this.allRecords]; // Tüm kayıtların bir kopyası üzerinde çalış

        // 1. Özel Tab/Tip Filtrelemesi (dışarıdan verilen callback)
        if (this.customTypeFilter) {
            filteredRecords = filteredRecords.filter(record => this.customTypeFilter(record));
        }

        // 2. Genel Arama Çubuğu Filtrelemesi
        if (this.globalSearchTerm) {
            filteredRecords = filteredRecords.filter(record => {
                const searchContent = this.getRecordSearchContent(record); // Tüm aranabilir alanları birleştir
                return searchContent.includes(this.globalSearchTerm);
            });
        }

        // 3. Sütun Bazlı Filtreleme - Sadece tableFilterRowId varsa ve searchable ise uygulanır
        if (this.tableFilterRowId) {
            filteredRecords = filteredRecords.filter(record => {
                return this.columnDefinitions.every(col => {
                    if (!col.searchable || !this.columnFilters[col.key]) {
                        return true; // Aranabilir değilse veya filtre boşsa True
                    }

                    let recordValue = this.getRecordValueForColumn(record, col.key);
                    // Değerin string olduğundan emin olun ve küçük harfe çevirerek karşılaştırın
                    return String(recordValue).toLowerCase().includes(this.columnFilters[col.key]);
                });
            });
        }

        // 4. Sıralama
        if (this.sortBy.column) {
            const sortColumn = this.sortBy.column;
            const sortDirection = this.sortBy.direction;
            
            filteredRecords.sort((a, b) => {
                // Özel sıralama mantığı varsa onu kullan
                if (this.customSortLogic && this.customSortLogic[sortColumn]) {
                    return this.customSortLogic[sortColumn](a, b, sortDirection, this.allPersons, this.allUsers);
                }

                // Varsayılan sıralama mantığı
                let valA = this.getRecordValueForColumn(a, sortColumn);
                let valB = this.getRecordValueForColumn(b, sortColumn);

                // Boş veya null değerleri sıralama sonunda göstermek için
                const isValANull = (valA === null || valA === undefined || valA === '');
                const isValBNull = (valB === null || valB === undefined || valB === '');

                if (isValANull && isValBNull) return 0;
                if (isValANull) return sortDirection === 'asc' ? 1 : -1; // Null sona
                if (isValBNull) return sortDirection === 'asc' ? -1 : 1; // Null sona

                if (typeof valA === 'string' && typeof valB === 'string') {
                    return sortDirection === 'asc' ? valA.localeCompare(valB, 'tr-TR') : valB.localeCompare(valA, 'tr-TR');
                } else if (typeof valA === 'number' && typeof valB === 'number') {
                    return sortDirection === 'asc' ? valA - valB : valB - valA;
                } else if (valA instanceof Date && valB instanceof Date) {
                    return sortDirection === 'asc' ? valA.getTime() - valB.getTime() : valB.getTime() - valA.getTime();
                }
                return 0; 
            });
        }
        
        // Sıralama ikonlarını güncelle
        document.querySelectorAll('.sortable-header').forEach(header => {
            header.classList.remove('asc', 'desc', 'inactive');
            if (header.dataset.column === this.sortBy.column) {
                header.classList.add(this.sortBy.direction);
            } else {
                header.classList.add('inactive');
            }
        });

        // Tablo içeriğini yeniden oluştur
        tableBody.innerHTML = ''; // Mevcut tüm satırları kaldır
        
        if (filteredRecords.length === 0) {
            noRecordsMessage.style.display = 'block';
            tableBody.style.display = 'none'; // Kayıt yoksa tablo gövdesini gizle
        } else {
            noRecordsMessage.style.display = 'none';
            tableBody.style.display = 'table-row-group'; // Kayıt varsa tablo gövdesini göster
            
            filteredRecords.forEach(record => {
                const row = document.createElement('tr'); // Her kayıt için yeni bir satır oluştur
                row.dataset.id = record.id; // Satır ID'sini data-id özelliğine ata
                
                // customRecordHtml callback'i varsa onu kullanarak satır içeriğini oluştur
                if (this.customRecordHtml) {
                    row.innerHTML = this.customRecordHtml(record, this.allPersons, this.allUsers);
                } else {
                    // customRecordHtml yoksa varsayılan olarak sütun tanımlarına göre içeriği oluştur
                    let rowContent = '';
                    this.columnDefinitions.forEach(col => {
                        let value = this.getRecordValueForColumn(record, col.key);
                        // Durum ve Öncelik gibi özel renklendirme gerektiren alanlar için
                        if (col.key === 'status') {
                            const statusClass = `status-${String(value).toLowerCase().replace(/ /g, '_')}`;
                            rowContent += `<td><span class="status-badge ${statusClass}">${value}</span></td>`;
                        } else if (col.key === 'priority') {
                            const priorityClass = `priority-${String(value).toLowerCase()}`;
                            rowContent += `<td><span class="priority-badge ${priorityClass}">${value}</span></td>`;
                        } else if (col.key === 'actions') {
                            // Aksiyon butonu örneği (eğer customRecordHtml'de işlenmiyorsa)
                            rowContent += `<td><button class="action-btn view-btn" data-id="${record.id}">Görüntüle</button></td>`;
                        } else {
                            rowContent += `<td>${value !== null && value !== undefined ? value : ''}</td>`;
                        }
                    });
                    row.innerHTML = rowContent;
                }
                tableBody.appendChild(row); // Yeni oluşturulan satırı tabloya ekle
            });
        }
    }

    // Bir kaydın arama içeriğini oluşturan yardımcı fonksiyon
    getRecordSearchContent(record) {
        const searchValues = [
            record.type, record.title, record.applicationNumber, record.status, record.description,
            record.patentClass, record.niceClass, record.copyrightType, record.designClass,
            // task-management sayfasından gelen aranabilir alanları da dahil et
            record.taskNumber, record.relatedIpRecord, record.taskType, record.assignedTo,
            record.operationalDueDate, record.officialDueDate, record.status,
            record.searchableTitle, record.searchableIpRecordTitle, record.searchableTaskType,
            record.searchableAssignedToEmail, record.searchableStatus
        ].filter(Boolean).map(val => String(val));

        const ownerNames = record.owners ? record.owners.map(owner => this.allPersons.find(p => p.id === owner.id)?.name || '').filter(Boolean).join(' ') : '';
        if (ownerNames) searchValues.push(ownerNames);

        return searchValues.join(' ').toLowerCase();
    }

    // Bir kayıt ve sütun anahtarı için değeri döndüren yardımcı fonksiyon
    getRecordValueForColumn(record, columnKey) {
        if (columnKey === 'owners' || columnKey === 'applicants') {
            // Hem 'owners' hem 'applicants' alanlarını kontrol et
            const list = record.applicants || record.owners || [];
            if (!Array.isArray(list)) return '';
            
            return list.map(item => {
                // ID varsa allPersons listesinden bul
                if (item.id && this.allPersons) {
                    const p = this.allPersons.find(person => person.id === item.id);
                    if (p) return p.name;
                }
                // Yoksa kayıttaki ismi kullan
                return item.name || '';
            }).filter(Boolean).join(', ');
        } else if (columnKey === 'applicationDate'|| columnKey === 'operationalDueDate' || columnKey === 'officialDueDate') {
            // Firestore Timestamp objesi ise Date objesine çevir
            return record[columnKey] ? new Date(record[columnKey]).toLocaleDateString('tr-TR') : null;
        } else if (columnKey === 'assignedTo') { // Görev yönetimi için, atanan kullanıcının UID'sini isme dönüştür
             const assignedUser = this.allUsers.find(u => u.id === record.assignedTo_uid);
             return assignedUser ? (assignedUser.displayName || assignedUser.email) : (record.assignedTo_email || '');
        } else if (columnKey === 'taskType') {
            // task.taskType zaten displayName olarak geliyor (task-management.html tarafında formatlandı)
            return record.taskType;
        }
        else {
            return record[columnKey] !== undefined ? record[columnKey] : null;
        }
    }
}

export { TableManager };