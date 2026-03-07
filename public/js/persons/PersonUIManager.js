// public/js/persons/PersonUIManager.js
import { PersonDataManager } from './PersonDataManager.js';
import Pagination from '../pagination.js';

export class PersonUIManager {
    constructor() {
        this.dataManager = new PersonDataManager();
        this.allPersons = [];      
        this.filteredData = [];    
        
        this.sortColumn = 'name';
        this.sortDirection = 'asc';

        this.pagination = new Pagination({
            containerId: 'paginationContainer',
            itemsPerPage: 10,
            onPageChange: () => this.renderTable()
        });
    }

    async loadPersons() {
        const res = await this.dataManager.fetchPersons();
        if (res.success) {
            this.allPersons = res.data;
            this.filteredData = [...this.allPersons];
            
            if (this.pagination) {
                this.pagination.totalItems = this.allPersons.length;
                this.pagination.currentPage = 1;
            }
            
            this.applyFiltersAndSort();
        }
    }

    async deletePerson(id) {
        try {
            const tableBody = document.getElementById('personsTableBody');
            if(tableBody) tableBody.style.opacity = '0.5';

            // Firebase personService yerine yazdığımız Supabase fonksiyonunu çağırıyoruz
            const result = await this.dataManager.deletePerson(id);

            if (result.success) {
                await this.loadPersons();
                if(window.showNotification) window.showNotification('Kişi başarıyla silindi.', 'success');
            } else {
                alert("Silme işlemi başarısız: " + result.error);
            }
        } catch (error) {
            console.error("Silme hatası:", error);
            alert("Bir hata oluştu: " + error.message);
        } finally {
            // Hata olsa da olmasa da opaklığı düzelt
            const tableBody = document.getElementById('personsTableBody');
            if(tableBody) tableBody.style.opacity = '1';
        }
    }

    filterPersons(query) {
        const term = query.toLowerCase().trim();
        
        if (!term) {
            this.filteredData = [...this.allPersons];
        } else {
            this.filteredData = this.allPersons.filter(p => 
                (p.name || '').toLowerCase().includes(term) ||
                (p.email || '').toLowerCase().includes(term) ||
                (p.tckn || p.taxNo || '').includes(term) ||
                (p.tpeNo || '').includes(term)
            );
        }
        this.pagination.currentPage = 1;
        this.applyFiltersAndSort();
    }

    handleSort(column) {
        if (this.sortColumn === column) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortColumn = column;
            this.sortDirection = 'asc';
        }
        this.applyFiltersAndSort();
    }

    applyFiltersAndSort() {
        const term = document.getElementById('personSearchInput')?.value || '';
        let sourceData = term ? [...this.filteredData] : [...this.allPersons];

        sourceData.sort((a, b) => {
            let valA = (a[this.sortColumn] || '').toString().toLowerCase();
            let valB = (b[this.sortColumn] || '').toString().toLowerCase();
            if (valA < valB) return this.sortDirection === 'asc' ? -1 : 1;
            if (valA > valB) return this.sortDirection === 'asc' ? 1 : -1;
            return 0;
        });

        this.filteredData = sourceData;
        
        if (this.pagination) {
            this.pagination.update(this.filteredData.length);
        }
        
        this.renderTable();
    }

    renderTable() {
        const tableBody = document.getElementById('personsTableBody');
        if (!tableBody) return;

        tableBody.innerHTML = '';
        const paginatedData = this.pagination.getCurrentPageData(this.filteredData);

        if (paginatedData.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-muted">Kayıt bulunamadı.</td></tr>';
            return;
        }

        const startIndex = this.pagination.getStartIndex();

        paginatedData.forEach((p, index) => {
            const row = `
                <tr>
                    <td class="text-muted small">${startIndex + index + 1}</td>
                    <td><span class="font-weight-bold text-dark">${p.name}</span></td>
                    <td>${p.tckn || p.taxNo || '<span class="text-light">-</span>'}</td>
                    <td>${p.tpeNo || '<span class="text-light">-</span>'}</td>
                    <td class="small">${p.email || '-'}</td>
                    <td><span class="badge badge-pill ${p.type === 'gercek' ? 'badge-soft-primary' : 'badge-soft-success'}">${p.type === 'gercek' ? 'Gerçek' : 'Tüzel'}</span></td>
                    <td class="text-right">
                        <button class="action-btn edit-btn btn-sm mr-1" data-id="${p.id}" title="Düzenle">
                            <i class="fas fa-edit edit-btn" data-id="${p.id}"></i>
                        </button>
                        <button class="action-btn delete-btn btn-sm" data-id="${p.id}" title="Sil">
                            <i class="fas fa-trash-alt delete-btn" data-id="${p.id}"></i>
                        </button>
                    </td>
                </tr>`;
            tableBody.insertAdjacentHTML('beforeend', row);
        });
    }
}