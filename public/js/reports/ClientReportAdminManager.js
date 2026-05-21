// public/js/reports/ClientReportAdminManager.js

import { supabase } from '../../supabase-config.js';

export class ClientReportAdminManager {
    constructor() {
        this.allPortalUsers = [];
        this.allPersons = [];
        this.reportConfigs = [];
        
        // Seçilenleri tutacağımız listeler
        this.selectedUsers = [];
        this.selectedClients = [];
        
        // RAPOR TÜRLERİ VE İSTEDİKLERİ PARAMETRELER
        this.REPORT_SCHEMAS = {
            'bulletin_search': {
                fields: [
                    { id: 'client_nos', type: 'textarea', label: 'Aranacak Client Numaraları', placeholder: 'Virgülle ayırarak giriniz (Örn: 7978125, 1122334)', required: true }
                ]
            },
            'status_based': {
                fields: [
                    { id: 'target_status', type: 'select', label: 'Hangi Statüdeki Kayıtlar?', options: ['Başvuru', 'Tescilli', 'İtiraz Aşamasında'], required: true },
                    { id: 'min_date', type: 'date', label: 'Şu Tarihten Sonrakiler (Opsiyonel)', required: false }
                ]
            }
        };

        this.init();
    }

    async init() {
        await this.loadPortalUsers();
        await this.loadPersons();
        this.bindEvents();
        await this.loadReportConfigs();
    }

    bindEvents() {
        // 1. YENİ RAPOR OLUŞTUR BUTONU
        document.getElementById('btnCreateClientReport').addEventListener('click', () => {
            document.getElementById('clientReportForm').reset();
            document.getElementById('reportConfigId').value = '';
            document.getElementById('clientReportModalLabel').innerHTML = '<i class="fas fa-plus"></i> Yeni Müvekkil Rapor Paketi';
            
            // Listeleri ve rozetleri temizle
            this.selectedUsers = [];
            this.selectedClients = [];
            this.renderSelectedUsers();
            this.renderSelectedClients();
            
            const dynamicContainer = document.getElementById('dynamicCriteriaContainer');
            if (dynamicContainer) {
                dynamicContainer.innerHTML = '';
                dynamicContainer.style.display = 'none';
            }
            
            $('#clientReportModal').modal('show');
        });

        // 2. KAYDET BUTONU
        document.getElementById('btnSaveClientReport').addEventListener('click', () => this.saveReportConfig());

        // 3. SİL VE DÜZENLE BUTONLARI
        document.getElementById('clientReportsTableBody').addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('.delete-report-btn');
            if (deleteBtn) {
                const id = deleteBtn.dataset.id;
                if(confirm('Bu rapor paketini silmek istediğinize emin misiniz?')) {
                    this.deleteReportConfig(id);
                }
                return;
            }

            const editBtn = e.target.closest('.edit-report-btn');
            if (editBtn) {
                this.openEditModal(editBtn.dataset.id);
            }
        });

        // 4. DİNAMİK FORM OLUŞTURUCU
        document.getElementById('reportType').addEventListener('change', (e) => {
            const selectedType = e.target.value;
            const container = document.getElementById('dynamicCriteriaContainer');
            container.innerHTML = ''; 
            const schema = this.REPORT_SCHEMAS[selectedType];
            
            if (schema && schema.fields && schema.fields.length > 0) {
                container.style.display = 'block'; 
                schema.fields.forEach(field => {
                    const isReq = field.required ? '<span class="text-danger">*</span>' : '';
                    let inputHtml = '';
                    
                    if (field.type === 'textarea') {
                        inputHtml = `<textarea class="form-control dynamic-field" data-key="${field.id}" rows="2" placeholder="${field.placeholder || ''}" ${field.required ? 'required' : ''}></textarea>`;
                    } else if (field.type === 'select') {
                        const optionsHtml = field.options.map(opt => `<option value="${opt}">${opt}</option>`).join('');
                        inputHtml = `<select class="form-control dynamic-field" data-key="${field.id}" ${field.required ? 'required' : ''}>${optionsHtml}</select>`;
                    } else {
                        inputHtml = `<input type="${field.type}" class="form-control dynamic-field" data-key="${field.id}" placeholder="${field.placeholder || ''}" ${field.required ? 'required' : ''}>`;
                    }

                    container.innerHTML += `
                        <div class="form-group mb-3">
                            <label class="font-weight-bold">${field.label} ${isReq}</label>
                            ${inputHtml}
                        </div>
                    `;
                });
            } else {
                container.style.display = 'none';
            }
        });

        // 5. ARAMA İŞLEMLERİ (Kullanıcılar ve Müvekkiller)
        this.setupSearch('userSearchInput', 'userSearchResults', this.allPortalUsers, (user) => {
            if (!this.selectedUsers.find(u => u.id === user.id)) {
                this.selectedUsers.push({ id: user.id, name: user.display_name || user.email });
                this.renderSelectedUsers();
            }
        }, ['display_name', 'email']);

        this.setupSearch('clientSearchInput', 'clientSearchResults', this.allPersons, (person) => {
            if (!this.selectedClients.find(c => c.id === person.id)) {
                this.selectedClients.push({ id: person.id, name: person.name });
                this.renderSelectedClients();
            }
        }, ['name']);

        // Rozetleri (Badge) silme işlemleri
        document.getElementById('portalUsersContainer').addEventListener('click', (e) => {
            if (e.target.classList.contains('remove-user')) {
                const id = e.target.dataset.id;
                this.selectedUsers = this.selectedUsers.filter(u => String(u.id) !== String(id));
                this.renderSelectedUsers();
            }
        });

        document.getElementById('reportTargetClientsList').addEventListener('click', (e) => {
            if (e.target.classList.contains('remove-client')) {
                const id = e.target.dataset.id;
                this.selectedClients = this.selectedClients.filter(c => String(c.id) !== String(id));
                this.renderSelectedClients();
            }
        });
    }

    // Arama motorunu kuran ortak yardımcı fonksiyon
    setupSearch(inputId, resultsId, dataArray, onSelect, searchKeys) {
        const input = document.getElementById(inputId);
        const results = document.getElementById(resultsId);
        if (!input || !results) return;

        input.addEventListener('input', (e) => {
            const val = e.target.value.toLowerCase().trim();
            if (val.length < 2) {
                results.style.display = 'none';
                return;
            }
            
            const matches = dataArray.filter(item => 
                searchKeys.some(key => (item[key] || '').toLowerCase().includes(val))
            ).slice(0, 10);

            if (matches.length === 0) {
                results.innerHTML = '<div class="list-group-item text-muted p-2">Sonuç bulunamadı</div>';
            } else {
                results.innerHTML = matches.map(item => `
                    <a href="#" class="list-group-item list-group-item-action p-2 search-result-item" data-id="${item.id}">
                        ${searchKeys.map(k => item[k]).filter(Boolean).join(' - ')}
                    </a>
                `).join('');
            }
            results.style.display = 'block';
        });

        results.addEventListener('click', (e) => {
            e.preventDefault();
            const itemEl = e.target.closest('.search-result-item');
            if (itemEl) {
                const id = itemEl.dataset.id;
                const item = dataArray.find(x => String(x.id) === String(id));
                if (item) onSelect(item);
                input.value = '';
                results.style.display = 'none';
            }
        });

        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !results.contains(e.target)) {
                results.style.display = 'none';
            }
        });
    }

    renderSelectedUsers() {
        const container = document.getElementById('portalUsersContainer');
        if (!container) return;
        container.innerHTML = this.selectedUsers.map(u => `
            <span class="badge badge-primary p-2 mr-2 mb-2 d-inline-flex align-items-center" style="font-size: 0.9em; border-radius: 8px;">
                ${u.name} <i class="fas fa-times ml-2 remove-user" data-id="${u.id}" style="cursor: pointer;"></i>
            </span>
        `).join('');
    }

    renderSelectedClients() {
        const container = document.getElementById('reportTargetClientsList');
        if (!container) return;
        container.innerHTML = this.selectedClients.map(c => `
            <span class="badge badge-success p-2 mr-2 mb-2 d-inline-flex align-items-center" style="font-size: 0.9em; border-radius: 8px;">
                ${c.name} <i class="fas fa-times ml-2 remove-client" data-id="${c.id}" style="cursor: pointer;"></i>
            </span>
        `).join('');
    }

    openEditModal(id) {
        const config = this.reportConfigs.find(c => c.id === id);
        if (!config) return;

        // Formu ve listeleri temizle
        document.getElementById('clientReportForm').reset();
        this.selectedUsers = [];
        this.selectedClients = [];
        
        document.getElementById('reportConfigId').value = config.id;
        document.getElementById('reportName').value = config.name;
        
        const typeSelect = document.getElementById('reportType');
        typeSelect.value = config.report_type;
        typeSelect.dispatchEvent(new Event('change'));

        if (config.criteria) {
            for (const [key, value] of Object.entries(config.criteria)) {
                const input = document.querySelector(`.dynamic-field[data-key="${key}"]`);
                if (input) input.value = Array.isArray(value) ? value.join(', ') : value;
            }
        }

        // Atanmış kullanıcıları rozet olarak ekle
        if (config.client_report_assignments && config.client_report_assignments.length > 0) {
            config.client_report_assignments.forEach(assignment => {
                const user = this.allPortalUsers.find(u => String(u.id) === String(assignment.user_id));
                if (user) this.selectedUsers.push({ id: user.id, name: user.display_name || user.email });
            });
        }
        this.renderSelectedUsers();

        // Atanmış müvekkilleri rozet olarak ekle
        const targetClients = config.criteria?.target_portal_clients || [];
        if (targetClients.length > 0) {
            targetClients.forEach(cid => {
                const person = this.allPersons.find(p => String(p.id) === String(cid));
                if (person) {
                    this.selectedClients.push({ id: person.id, name: person.name });
                } else {
                    this.selectedClients.push({ id: cid, name: `Firma ID: ${cid}` });
                }
            });
        }
        this.renderSelectedClients();

        document.getElementById('clientReportModalLabel').innerHTML = '<i class="fas fa-edit"></i> Rapor Paketini Güncelle';
        $('#clientReportModal').modal('show');
    }

    async loadPortalUsers() {
        try {
            const { data, error } = await supabase
                .from('users')
                .select('id, email, display_name, role')
                .eq('role', 'client') 
                .order('display_name');
            if (error) throw error;
            this.allPortalUsers = data || [];
        } catch (error) { console.error('Kullanıcılar yüklenemedi:', error); }
    }

    async loadPersons() {
        try {
            const { data, error } = await supabase
                .from('persons')
                .select('id, name')
                .order('name');
            if (error) throw error;
            this.allPersons = data || [];
        } catch (error) { console.error('Müvekkiller yüklenemedi:', error); }
    }

    async loadReportConfigs() {
        try {
            const tbody = document.getElementById('clientReportsTableBody');
            const { data, error } = await supabase
                .from('client_report_configs')
                .select(`*, client_report_assignments ( user_id )`)
                .order('created_at', { ascending: false });

            if (error) throw error;
            this.reportConfigs = data || [];
            tbody.innerHTML = '';
            
            if (this.reportConfigs.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">Henüz oluşturulmuş bir müvekkil raporu bulunmuyor.</td></tr>`;
                return;
            }

            this.reportConfigs.forEach(config => {
                const clientNos = config.criteria?.client_nos || [];
                const assignedCount = config.client_report_assignments?.length || 0;
                const typeDisplay = config.report_type === 'bulletin_search' ? 'Bülten Sorgusu' : config.report_type;

                tbody.innerHTML += `
                    <tr>
                        <td class="font-weight-bold">${config.name}</td>
                        <td><span class="badge badge-info">${typeDisplay}</span></td>
                        <td>
                            <div class="text-truncate" style="max-width: 250px;" title="${clientNos.join(', ')}">
                                ${clientNos.length > 0 ? clientNos.join(', ') : '-'}
                            </div>
                        </td>
                        <td><span class="badge badge-secondary">${assignedCount} Kullanıcı</span></td>
                        <td class="text-center">
                            <button class="btn btn-sm btn-outline-primary edit-report-btn mr-1" data-id="${config.id}">
                                <i class="fas fa-edit"></i> Düzenle
                            </button>
                            <button class="btn btn-sm btn-outline-danger delete-report-btn" data-id="${config.id}">
                                <i class="fas fa-trash"></i> Sil
                            </button>
                        </td>
                    </tr>
                `;
            });
        } catch (error) {
            console.error('Raporlar yüklenemedi:', error);
            document.getElementById('clientReportsTableBody').innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">Raporlar yüklenirken hata oluştu.</td></tr>`;
        }
    }

    async saveReportConfig() {
        const id = document.getElementById('reportConfigId').value; 
        const name = document.getElementById('reportName').value.trim();
        const type = document.getElementById('reportType').value;
        
        if (!name || !type) return alert('Lütfen Rapor Adı ve Türünü doldurun.');

        const criteriaObj = {};
        let hasError = false;

        document.querySelectorAll('.dynamic-field').forEach(input => {
            const key = input.dataset.key;
            let val = input.value.trim();

            if (input.required && !val) {
                hasError = true;
                input.classList.add('is-invalid');
            } else {
                input.classList.remove('is-invalid');
                if (key === 'client_nos') {
                    criteriaObj[key] = val.split(',').map(n => n.trim()).filter(n => n.length > 0);
                } else {
                    criteriaObj[key] = val;
                }
            }
        });

        if (hasError) return alert('Lütfen zorunlu kriter alanlarını doldurun.');

        // Yeni rozet (seçim) sisteminden ID'leri topla
        const selectedUserIds = this.selectedUsers.map(u => u.id);
        const targetPortalClients = this.selectedClients.map(c => c.id);
        criteriaObj.target_portal_clients = targetPortalClients;

        const btn = document.getElementById('btnSaveClientReport');
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Kaydediliyor...';
        btn.disabled = true;

        try {
            let configData = null;

            if (id) {
                const { data, error } = await supabase.from('client_report_configs')
                    .update({ name: name, report_type: type, criteria: criteriaObj, updated_at: new Date().toISOString() })
                    .eq('id', id).select().single();
                if (error) throw error;
                configData = data;

                await supabase.from('client_report_assignments').delete().eq('report_id', id);
            } else {
                const { data, error } = await supabase.from('client_report_configs')
                    .insert([{ name: name, report_type: type, criteria: criteriaObj }])
                    .select().single();
                if (error) throw error;
                configData = data;
            }

            if (selectedUserIds.length > 0 && configData) {
                const assignments = selectedUserIds.map(uid => ({ report_id: configData.id, user_id: uid }));
                const { error: assignError } = await supabase.from('client_report_assignments').insert(assignments);
                if (assignError) throw assignError;
            }

            $('#clientReportModal').modal('hide');
            this.loadReportConfigs();
            
        } catch (error) {
            console.error('Kayıt/Güncelleme Hatası:', error);
            alert('İşlem sırasında bir hata oluştu: ' + error.message);
        } finally {
            btn.innerHTML = 'Kaydet';
            btn.disabled = false;
        }
    }

    async deleteReportConfig(id) {
        try {
            const { error } = await supabase.from('client_report_configs').delete().eq('id', id);
            if (error) throw error;
            this.loadReportConfigs(); 
        } catch (error) {
            console.error('Silme Hatası:', error);
            alert('Silinirken bir hata oluştu.');
        }
    }
}