// public/js/reports/ClientReportAdminManager.js

import { supabase } from '../../supabase-config.js';

export class ClientReportAdminManager {
    constructor() {
            this.portalUsers = [];
            this.reportConfigs = [];
            
            // RAPOR TÜRLERİ VE İSTEDİKLERİ PARAMETRELER
            this.REPORT_SCHEMAS = {
                'bulletin_search': {
                    fields: [
                        { id: 'client_nos', type: 'textarea', label: 'Aranacak Client Numaraları', placeholder: 'Virgülle ayırarak giriniz (Örn: 7978125, 1122334)', required: true }
                    ]
                },
                'status_based': { // Gelecekte eklenebilecek örnek bir rapor
                    fields: [
                        { id: 'target_status', type: 'select', label: 'Hangi Statüdeki Kayıtlar?', options: ['Başvuru', 'Tescilli', 'İtiraz Aşamasında'], required: true },
                        { id: 'min_date', type: 'date', label: 'Şu Tarihten Sonrakiler (Opsiyonel)', required: false }
                    ]
                }
            };

            this.init();
        }

    async init() {
        this.bindEvents();
        await this.loadPortalUsers();
        await this.loadReportConfigs();
    }

    bindEvents() {
        // 1. YENİ RAPOR OLUŞTUR BUTONU (Modal Açılışı ve Temizlik)
        document.getElementById('btnCreateClientReport').addEventListener('click', () => {
            document.getElementById('clientReportForm').reset();
            document.getElementById('reportConfigId').value = '';
            document.getElementById('clientReportModalLabel').innerHTML = '<i class="fas fa-plus"></i> Yeni Müvekkil Rapor Paketi'; // Başlığı sıfırla
            
            document.querySelectorAll('.user-checkbox').forEach(cb => cb.checked = false);
            
            const dynamicContainer = document.getElementById('dynamicCriteriaContainer');
            if (dynamicContainer) {
                dynamicContainer.innerHTML = '';
                dynamicContainer.style.display = 'none';
            }
            
            $('#clientReportModal').modal('show');
        });

        // 2. KAYDET BUTONU
        document.getElementById('btnSaveClientReport').addEventListener('click', () => this.saveReportConfig());

        // 3. SİL VE DÜZENLE BUTONLARI (Tablo üzerinden Event Delegation)
        document.getElementById('clientReportsTableBody').addEventListener('click', (e) => {
            // Silme İşlemi
            const deleteBtn = e.target.closest('.delete-report-btn');
            if (deleteBtn) {
                const id = deleteBtn.dataset.id;
                if(confirm('Bu rapor paketini silmek istediğinize emin misiniz? (Atanan müvekkiller bu raporu artık göremez.)')) {
                    this.deleteReportConfig(id);
                }
                return; // Silme işlemi yapıldıysa düzenlemeye bakmaya gerek yok
            }

            // Düzenleme İşlemi (YENİ EKLENDİ)
            const editBtn = e.target.closest('.edit-report-btn');
            if (editBtn) {
                const id = editBtn.dataset.id;
                this.openEditModal(id);
            }
        });

        // 4. DİNAMİK FORM OLUŞTURUCU (Rapor türü seçildiğinde tetiklenir)
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

        $('#reportAssignedUsers').on('change', () => this.handleAssignedUsersChange());
    }

    // YENİ FONKSİYON: Mevcut verilerle modalı doldurur
    openEditModal(id) {
        // Hafızadaki rapor listesinden ilgili raporu bul
        const config = this.reportConfigs.find(c => c.id === id);
        if (!config) return;

        // 1. Formu ve kullanıcıları temizle
        document.getElementById('clientReportForm').reset();
        document.querySelectorAll('.user-checkbox').forEach(cb => cb.checked = false);
        
        // 2. Statik alanları doldur (ID, Adı, Türü)
        document.getElementById('reportConfigId').value = config.id;
        document.getElementById('reportName').value = config.name;
        
        // 3. Türü seç ve JS'ye "sanki kullanıcı tıklamış gibi" change eventi gönder. 
        // Bu sayede dinamik inputlar ekrana çizilir.
        const typeSelect = document.getElementById('reportType');
        typeSelect.value = config.report_type;
        typeSelect.dispatchEvent(new Event('change'));

        // 4. Ekrana çizilen dinamik inputların içini veritabanındaki criteria objesiyle doldur
        if (config.criteria) {
            for (const [key, value] of Object.entries(config.criteria)) {
                const input = document.querySelector(`.dynamic-field[data-key="${key}"]`);
                if (input) {
                    // Veri Array (dizi) ise arasına virgül koyup textarea'ya yaz (Örn: client_nos)
                    input.value = Array.isArray(value) ? value.join(', ') : value;
                }
            }
        }

        // 5. Kayıtlı kullanıcıların checkbox'larını işaretle
        if (config.client_report_assignments && config.client_report_assignments.length > 0) {
            config.client_report_assignments.forEach(assignment => {
                const cb = document.getElementById(`user-${assignment.user_id}`);
                if (cb) cb.checked = true;
            });
        }

        // Modalı aç ve başlığı değiştir
        document.getElementById('clientReportModalLabel').innerHTML = '<i class="fas fa-edit"></i> Rapor Paketini Güncelle';
        $('#clientReportModal').modal('show');
    }

    async loadPortalUsers() {
        try {
            // users tablosundan verileri çekiyoruz. 
            // Sadece role = 'client' olanları filtreliyoruz ki adminler listede kalabalık yapmasın.
            const { data, error } = await supabase
                .from('users')
                .select('id, email, display_name, role')
                .eq('role', 'client') 
                .order('display_name');
            
            if (error) throw error;
            this.portalUsers = data || [];
            
            const container = document.getElementById('portalUsersContainer');
            container.innerHTML = '';
            
            if (this.portalUsers.length === 0) {
                container.innerHTML = '<div class="text-muted small">Sistemde portal kullanıcısı (client) bulunamadı.</div>';
                return;
            }

            this.portalUsers.forEach(user => {
                // full_name yerine display_name kullanıyoruz
                const nameDisplay = user.display_name ? `${user.display_name} (${user.email})` : user.email;
                container.innerHTML += `
                    <div class="custom-control custom-checkbox mb-2">
                        <input type="checkbox" class="custom-control-input user-checkbox" id="user-${user.id}" value="${user.id}">
                        <label class="custom-control-label" for="user-${user.id}" style="cursor:pointer;">
                            <i class="fas fa-user-tie text-secondary mr-1"></i> ${nameDisplay}
                        </label>
                    </div>
                `;
            });
        } catch (error) {
            console.error('Kullanıcılar yüklenemedi:', error);
            document.getElementById('portalUsersContainer').innerHTML = '<div class="text-danger small">Kullanıcılar yüklenirken bir hata oluştu.</div>';
        }
    }

    async loadReportConfigs() {
        try {
            const tbody = document.getElementById('clientReportsTableBody');
            
            // Konfigürasyonları ve ona bağlı atamaları tek seferde çekiyoruz (Foreign Key)
            const { data, error } = await supabase
                .from('client_report_configs')
                .select(`
                    *,
                    client_report_assignments ( user_id )
                `)
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
        const id = document.getElementById('reportConfigId').value; // UPDATE İÇİN ID
        const name = document.getElementById('reportName').value.trim();
        const type = document.getElementById('reportType').value;
        
        if (!name || !type) return alert('Lütfen Rapor Adı ve Türünü doldurun.');

        // 1. DİNAMİK KRİTERLERİ TOPLAMA
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
                // client_nos verisini virgülle bölüp array yapalım
                if (key === 'client_nos') {
                    criteriaObj[key] = val.split(',').map(n => n.trim()).filter(n => n.length > 0);
                } else {
                    criteriaObj[key] = val;
                }
            }
        });

        if (hasError) return alert('Lütfen zorunlu kriter alanlarını doldurun.');

        const selectedUserIds = Array.from(document.querySelectorAll('.user-checkbox:checked')).map(cb => cb.value);

        const btn = document.getElementById('btnSaveClientReport');
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Kaydediliyor...';
        btn.disabled = true;

        try {
            let configData = null;

            if (id) {
                // ================== GÜNCELLEME (UPDATE) İŞLEMİ ==================
                const { data, error } = await supabase
                    .from('client_report_configs')
                    .update({
                        name: name,
                        report_type: type,
                        criteria: criteriaObj,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', id)
                    .select()
                    .single();

                if (error) throw error;
                configData = data;

                // Atamaları güncellemek için en temiz yol: Önce bu rapora ait tüm eski atamaları silmek
                const { error: delError } = await supabase
                    .from('client_report_assignments')
                    .delete()
                    .eq('report_id', id);
                if (delError) throw delError;

            } else {
                // ================== YENİ KAYIT (INSERT) İŞLEMİ ==================
                const { data, error } = await supabase
                    .from('client_report_configs')
                    .insert([{
                        name: name,
                        report_type: type,
                        criteria: criteriaObj
                    }])
                    .select()
                    .single();

                if (error) throw error;
                configData = data;
            }

            // ================== KULLANICI ATAMALARINI EKLE ==================
            // (Hem insert hem update için ortak adım)
            if (selectedUserIds.length > 0 && configData) {
                const assignments = selectedUserIds.map(uid => ({
                    report_id: configData.id,
                    user_id: uid
                }));
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
            // RLS ve ON DELETE CASCADE ayarlandığı için config'i silmek atamaları da silecektir.
            const { error } = await supabase.from('client_report_configs').delete().eq('id', id);
            if (error) throw error;
            this.loadReportConfigs(); // Tabloyu yenile
        } catch (error) {
            console.error('Silme Hatası:', error);
            alert('Silinirken bir hata oluştu.');
        }
    }

    async handleAssignedUsersChange(preselectedClients = []) {
        const selectedUsers = $('#reportAssignedUsers').val() || [];
        const container = $('#reportTargetClientsContainer');
        const listDiv = $('#reportTargetClientsList');

        if (selectedUsers.length === 0) {
            container.hide();
            listDiv.empty();
            return;
        }

        try {
            // Seçilen kullanıcıların yetkili olduğu tüm firmaları çek
            const { data: links, error } = await supabase
                .from('user_person_links')
                .select('person_id, persons(name)')
                .in('user_id', selectedUsers);

            if (error) throw error;

            // Firmaları tekilleştir
            const uniqueClients = new Map();
            links.forEach(link => {
                if (link.persons) uniqueClients.set(link.person_id, link.persons.name);
            });

            listDiv.empty();
            if (uniqueClients.size === 0) {
                listDiv.html('<div class="text-muted small">Bu kullanıcıların yetkili olduğu bir firma bulunamadı.</div>');
            } else {
                uniqueClients.forEach((name, id) => {
                    const isChecked = preselectedClients.includes(id) ? 'checked' : '';
                    listDiv.append(`
                        <div class="custom-control custom-checkbox mb-1">
                            <input type="checkbox" class="custom-control-input target-client-cb" id="tc_${id}" value="${id}" ${isChecked}>
                            <label class="custom-control-label" for="tc_${id}">${name}</label>
                        </div>
                    `);
                });
            }
            container.show();
        } catch (err) {
            console.error("Müvekkiller çekilemedi:", err);
        }
    }
}