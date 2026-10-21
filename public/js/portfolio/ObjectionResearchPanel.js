// Yalnızca Portföy > İtirazlar sekmesindeki araştırma filtrelerinin görünümü.
// Hukuki durum/karar değerlerini hesaplamaz veya değiştirmez.
export class ObjectionResearchPanel {
    constructor() {
        this.filters = this.emptyFilters();
        this.fields = {
            oppClientMark: 'clientMark', oppOpposedMark: 'opposedMark',
            oppAppNumber: 'applicationNumber', oppNiceClass: 'niceClass',
            oppProcessType: 'processType', oppClientRole: 'clientRole',
            oppStatus: 'status', oppDecisionOnly: 'decisionOnly',
            oppIncludeArchived: 'includeArchived'
        };
        this.bound = false;
    }

    emptyFilters() {
        return { clientMark: '', opposedMark: '', applicationNumber: '', niceClass: '',
            processType: '', clientRole: '', status: '', decisionOnly: false,
            includeArchived: false };
    }

    attach(onChange) {
        if (this.bound) return;
        const panel = document.getElementById('oppositionResearchPanel');
        if (!panel) return;
        this.bound = true;
        let pending;
        Object.entries(this.fields).forEach(([id, key]) => {
            const control = document.getElementById(id);
            if (!control) return;
            const apply = () => {
                this.filters[key] = control.type === 'checkbox' ? control.checked : control.value;
                onChange();
            };
            if (control.type === 'search') {
                control.addEventListener('input', () => {
                    clearTimeout(pending);
                    pending = setTimeout(apply, 250);
                });
            } else control.addEventListener('change', apply);
        });
        document.getElementById('oppClearFilters')?.addEventListener('click', () => {
            this.filters = this.emptyFilters();
            Object.keys(this.fields).forEach(id => {
                const field = document.getElementById(id);
                if (!field) return;
                if (field.type === 'checkbox') field.checked = false;
                else field.value = '';
            });
            onChange();
        });
    }

    get includeArchived() {
        return this.filters.includeArchived;
    }

    filter(records) {
        const f = this.filters;
        const contains = (source, term) => String(source || '').toLocaleLowerCase('tr-TR')
            .includes(String(term).trim().toLocaleLowerCase('tr-TR'));
        const matchesClasses = (row, term) => {
            if (!term) return true;
            const classNumber = Number(String(term).trim());
            if (!Number.isInteger(classNumber) || classNumber < 1 || classNumber > 45) return false;
            const values = `${row.niceClassesText || ''},${row.clientClassesText || ''}`;
            return values.split(',').some(v => Number(v.trim()) === classNumber);
        };
        return records.filter(row =>
            (!f.clientMark || contains(row.clientMark, f.clientMark)) &&
            (!f.opposedMark || contains(row.opposedMark || row.title, f.opposedMark)) &&
            (!f.applicationNumber || contains(row.applicationNumber, f.applicationNumber) ||
                contains(row.clientMarkNumber, f.applicationNumber)) &&
            matchesClasses(row, f.niceClass) &&
            (!f.processType || row.transactionTypeId === f.processType) &&
            (!f.clientRole || row.clientRole === f.clientRole) &&
            (!f.status || row.statusText === f.status) &&
            (!f.decisionOnly || row.hasDecision === true)
        );
    }

    update({ active, allRows, filteredCount, loadError }) {
        const panel = document.getElementById('oppositionResearchPanel');
        if (panel) panel.style.display = active ? 'block' : 'none';
        document.querySelector('.portfolio-table-container')?.classList.toggle('opposition-wide', active);
        const controls = ['toggleRecordStatusBtn', 'addToMonitoringBtn', 'btnExportSelected'];
        for (const id of controls) {
            const element = document.getElementById(id);
            if (element) element.style.display = active ? 'none' : '';
        }
        const selection = document.getElementById('selectAllCheckbox')?.closest('div');
        if (selection) selection.style.display = active ? 'none' : '';
        if (!active) return;

        // Mevcut durum alanını olduğu gibi kullanır; durum hesaplamasına müdahale etmez.
        const statusControl = document.getElementById('oppStatus');
        if (statusControl) {
            const statuses = [...new Set(allRows.map(row => row.statusText).filter(Boolean))]
                .sort((a, b) => a.localeCompare(b, 'tr'));
            const signature = JSON.stringify(statuses);
            if (statusControl.dataset.values !== signature) {
                const current = this.filters.status;
                statusControl.replaceChildren();
                const generalOption = document.createElement('option');
                generalOption.value = '';
                generalOption.textContent = 'Tüm durumlar';
                statusControl.appendChild(generalOption);
                for (const status of statuses) {
                    const option = document.createElement('option');
                    option.value = status;
                    option.textContent = status;
                    statusControl.appendChild(option);
                }
                if (!statuses.includes(current)) this.filters.status = '';
                statusControl.value = this.filters.status;
                statusControl.dataset.values = signature;
            }
        }
        const count = document.getElementById('oppositionResultCount');
        if (count) {
            count.textContent = loadError ? `Veri yükleme hatası: ${loadError}` :
                `${filteredCount.toLocaleString('tr-TR')} / ${allRows.length.toLocaleString('tr-TR')} itiraz`;
        }
    }
}
