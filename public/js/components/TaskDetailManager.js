// public/js/components/TaskDetailManager.js

import { supabase, ipRecordsService } from "../../supabase-config.js";
import { formatToTRDate } from "../../utils.js";

export class TaskDetailManager {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        
        this.statusDisplayMap = {
            'open': 'Açık', 'in-progress': 'Devam Ediyor', 'completed': 'Tamamlandı',
            'pending': 'Beklemede', 'cancelled': 'İptal Edildi', 'on-hold': 'Askıda',
            'awaiting-approval': 'Onay Bekliyor', 'awaiting_client_approval': 'Müvekkil Onayı Bekliyor',
            'client_approval_opened': 'Müvekkil Onayı - Açıldı', 'client_approval_closed': 'Müvekkil Onayı - Kapatıldı',
            'client_no_response_closed': 'Müvekkil Cevaplamadı - Kapatıldı'
        };
    }

    showLoading() {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="d-flex flex-column align-items-center justify-content-center py-5">
                <div class="spinner-border text-primary mb-3" role="status"></div>
                <h6 class="text-muted font-weight-normal">Yükleniyor...</h6>
            </div>`;
    }

    showError(message) {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="alert alert-light border-danger text-danger d-flex align-items-center m-3 shadow-sm" role="alert">
                <i class="fas fa-exclamation-circle mr-3 fa-lg"></i>
                <div>${message}</div>
            </div>`;
    }

    _formatMoney(amountData) {
        if (!amountData) return '0 TRY';
        if (Array.isArray(amountData)) {
            if (amountData.length === 0) return '0 TRY';
            return amountData.map(x => `${x.amount || 0} ${x.currency || 'TRY'}`).join(' + ');
        }
        if (typeof amountData === 'object') {
            return `${amountData.amount || 0} ${amountData.currency || 'TRY'}`;
        }
        return `${amountData} TRY`;
    }

    async render(task, options = {}) {
        if (!this.container) return;
        if (!task) { this.showError('İş kaydı bulunamadı.'); return; }

        this.showLoading();

        try {
            const modalContent = this.container.closest('.modal-content');
            
            // Eğer görev türü 2 (Marka Başvurusu) ise modalı devasa yap
            if (modalContent) {
                if (String(task.taskType) === '2') {
                    modalContent.style.maxWidth = '95%'; 
                    modalContent.style.width = '1400px'; 
                    modalContent.style.margin = 'auto';
                } else {
                    modalContent.style.maxWidth = ''; // Diğer işlerde orijinal boyut
                    modalContent.style.width = '';
                }
            }

            if (String(task.taskType) === '66') {
                await this._renderEvaluationEditor(task);
                return;
            }

            // 🔥 MARKA BAŞVURUSU (TİP 2) İÇİN DEVASA ÖZET EKRANI
            if (String(task.taskType) === '2') {
                await this._renderApplicationSummary(task, options);
                return;
            }

            // STANDART İŞ DETAYI GÖRÜNÜMÜ
            let { ipRecord, transactionType, assignedUser, accruals = [] } = options;

            let targetRecordId = task.ip_record_id || task.related_ip_record_id || task.relatedIpRecordId;
            if (!targetRecordId && (String(task.taskType) === '53' || (task.title || '').toLowerCase().includes('tahakkuk'))) {
                let detailsObj = typeof task.details === 'string' ? JSON.parse(task.details) : (task.details || {});
                let parentId = detailsObj.relatedTaskId || task.relatedTaskId || detailsObj.parent_task_id;
                if (parentId) {
                    try {
                        const { data: pTask } = await supabase.from('tasks').select('ip_record_id, related_ip_record_id').eq('id', String(parentId)).single();
                        if (pTask) targetRecordId = pTask.ip_record_id || pTask.related_ip_record_id;
                    } catch(e) {}
                }
            }

            if (!ipRecord && targetRecordId) {
                try {
                    const { data: ipDoc } = await supabase.from('ip_records').select('*').eq('id', String(targetRecordId)).maybeSingle();
                    if (ipDoc) ipRecord = ipDoc;
                    else {
                        const { data: suitDoc } = await supabase.from('suits').select('*').eq('id', String(targetRecordId)).maybeSingle();
                        if (suitDoc) ipRecord = suitDoc;
                    }
                } catch (e) { console.warn("IP Record fetch error:", e); }
            }

            let relatedPartyTxt = task.relatedPartyName || task.iprecordApplicantName || '-';
            const assignedName = assignedUser ? (assignedUser.displayName || assignedUser.email) : (task.assignedTo_email || 'Atanmamış');
            const relatedRecordTxt = ipRecord ? (ipRecord.application_number || ipRecord.title || ipRecord.brand_name) : 'İlgili kayıt bulunamadı';
            const taskTypeDisplay = transactionType ? (transactionType.alias || transactionType.name) : (task.taskType || '-');
            const statusText = this.statusDisplayMap[task.status] || task.status;

            const styles = {
                container: `font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #333; background-color: #f8f9fa; padding: 20px;`,
                card: `background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.03); margin-bottom: 20px; overflow: hidden;`,
                cardHeader: `padding: 15px 20px; border-bottom: 1px solid #eee; display: flex; align-items: center; font-size: 0.95rem; font-weight: 700; color: #1e3c72; background-color: #fff;`,
                cardBody: `padding: 20px;`,
                label: `display: block; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: #8898aa; margin-bottom: 6px; letter-spacing: 0.5px;`,
                valueBox: `background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 6px; padding: 12px 16px; font-size: 0.95rem; font-weight: 500; color: #2d3748; display: flex; align-items: center; min-height: 45px;`
            };

            const accrualsHtml = this._generateAccrualsHtml(accruals);
            const docsContent = this._generateDocsHtml(task);

            const html = `
            <div style="${styles.container}">
                <div style="${styles.card} padding: 20px; display: flex; justify-content: space-between; align-items: center; border-top: 4px solid #1e3c72;">
                    <div>
                        <h5 class="mb-1" style="font-weight: 700; color: #2d3748;">${task.title || 'Başlıksız Görev'}</h5>
                        <div class="text-muted small">
                            <span class="mr-3"><i class="fas fa-hashtag mr-1"></i>${task.id}</span>
                            <span><i class="far fa-clock mr-1"></i>${this._formatDate(task.createdAt || task.created_at)}</span>
                        </div>
                    </div>
                    <span class="badge badge-pill px-3 py-2" style="font-size: 0.85rem; background-color: #1e3c72; color: #fff;">
                        ${statusText}
                    </span>
                </div>

                <div style="${styles.card}">
                    <div style="${styles.cardHeader}">
                        <i class="fas fa-star mr-2 text-warning"></i> TEMEL BİLGİLER
                    </div>
                    <div style="${styles.cardBody}">
                        <div class="mb-4">
                            <label style="${styles.label}">İLGİLİ TARAF / MÜVEKKİL</label>
                            <div style="${styles.valueBox} border-left: 4px solid #1e3c72;">
                                 <i class="fas fa-user-tie text-primary mr-3 fa-lg" style="color: #1e3c72 !important;"></i>
                                 <span style="font-size: 1.1rem; font-weight: 600;">${relatedPartyTxt}</span>
                            </div>
                        </div>

                        ${task.oppositionOwner ? `
                        <div class="mb-4">
                            <label style="${styles.label}">İTİRAZ SAHİBİ (KARŞI TARAF)</label>
                            <div style="${styles.valueBox} border-left: 4px solid #d63384; background-color: #fff0f6;">
                                 <i class="fas fa-user-shield mr-3 fa-lg" style="color: #d63384 !important;"></i>
                                 <span style="font-size: 1.1rem; font-weight: 600; color: #d63384;">${task.oppositionOwner}</span>
                            </div>
                        </div>` : ''}

                        <div>
                            <label style="${styles.label}">İLGİLİ VARLIK (DOSYA)</label>
                            <div style="${styles.valueBox}">
                                 <i class="fas fa-folder text-muted mr-3"></i>
                                 <span style="font-size: 1rem; font-weight: 500;">${relatedRecordTxt}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div style="${styles.card}">
                    <div style="${styles.cardHeader}">
                        <i class="fas fa-list-alt mr-2 text-muted"></i> GÖREV DETAYLARI
                    </div>
                    <div style="${styles.cardBody}">
                        <div class="row">
                            <div class="col-md-4 mb-3">
                                <label style="${styles.label}">İŞ TİPİ</label>
                                <div style="${styles.valueBox}">${taskTypeDisplay}</div>
                            </div>
                            <div class="col-md-4 mb-3">
                                <label style="${styles.label}">ATANAN KİŞİ</label>
                                <div style="${styles.valueBox}">
                                    <i class="fas fa-user-circle text-muted mr-2"></i>${assignedName}
                                </div>
                            </div>
                            <div class="col-md-4 mb-3">
                                <label style="${styles.label}">RESMİ BİTİŞ</label>
                                <div style="${styles.valueBox}">
                                    <i class="far fa-calendar-alt text-muted mr-2"></i>
                                    <span class="${task.officialDueDate || task.official_due_date ? 'text-danger font-weight-bold' : 'text-muted'}">
                                        ${this._formatDate(task.officialDueDate || task.official_due_date)}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div>
                            <label style="${styles.label}">AÇIKLAMA</label>
                            <div style="${styles.valueBox} height: auto; align-items: flex-start; min-height: 60px; white-space: pre-wrap; line-height: 1.6; color: #525f7f;">${task.description || 'Açıklama girilmemiş.'}</div>
                        </div>
                    </div>
                </div>

                <div style="${styles.card}">
                    <div style="${styles.cardHeader}">
                        <i class="fas fa-paperclip mr-2 text-muted"></i> BELGELER
                    </div>
                    <div style="${styles.cardBody}">
                        ${docsContent}
                    </div>
                </div>

                <div style="${styles.card} margin-bottom: 0;">
                    <div style="${styles.cardHeader}">
                        <i class="fas fa-coins mr-2 text-muted"></i> TAHAKKUKLAR
                    </div>
                    <div style="${styles.cardBody}">
                        ${accrualsHtml}
                    </div>
                </div>
            </div>`;

            this.container.innerHTML = html;

        } catch (error) {
            console.error("Render hatası:", error);
            this.showError("Detaylar yüklenirken bir hata oluştu: " + error.message);
        }
    }

    // =========================================================================
    // 🔥 MARKA BAŞVURUSU İÇİN ÖZEL, GENİŞ, PREMIUM ÖZET EKRANI
    // =========================================================================
    async _renderApplicationSummary(task, options) {
        let targetRecordId = task.ip_record_id || task.related_ip_record_id || task.relatedIpRecordId;
        
        let fullRecord = {};
        if (targetRecordId) {
            const res = await ipRecordsService.getRecordById(targetRecordId);
            if (res && res.success) fullRecord = res.data;
        }

        let tmDetails = {};
        if (targetRecordId) {
            const { data } = await supabase.from('ip_record_trademark_details').select('*').eq('ip_record_id', targetRecordId).maybeSingle();
            if (data) tmDetails = data;
        }
        
        let details = {};
        try {
            details = typeof task.details === 'string' ? JSON.parse(task.details) : (task.details || {});
        } catch(e) {}

        const brandName = tmDetails.brand_name || fullRecord.title || details.brandText || task.title || '-';
        const brandType = tmDetails.brand_type || fullRecord.brandType || details.brandType || '-';
        const brandCategory = tmDetails.brand_category || fullRecord.brandCategory || details.brandCategory || '-';
        const origin = fullRecord.origin || details.origin || '-';
        
        let nonLatin = '-';
        if (tmDetails.non_latin_alphabet !== undefined) nonLatin = tmDetails.non_latin_alphabet ? 'Evet' : 'Hayır';
        else if (details.nonLatinAlphabet) nonLatin = details.nonLatinAlphabet;

        const coverLetter = tmDetails.cover_letter_request || details.coverLetterRequest || '-';
        const consent = tmDetails.consent_request || details.consentRequest || '-';

        // 🔥 GÜÇLENDİRİLMİŞ OLUŞTURAN (CREATED_BY) KONTROLÜ
        // Yeni görevlerde task.created_by doludur, eskilerde ise history (işlem geçmişi) tablosuna bakar.
        let createdByTxt = task.created_by;
        if (!createdByTxt && task.history && task.history.length > 0) {
            createdByTxt = task.history[0].userEmail || task.history[0].user_id;
        }
        createdByTxt = createdByTxt || 'Sistem';

        // --- LİSTELER (Sahipler, Rüçhanlar ve Sınıflar) ---
        const applicants = (fullRecord.applicants && fullRecord.applicants.length > 0) ? fullRecord.applicants : (details.applicants || []);
        
        // 🔥 YENİ: BAŞVURU SAHİBİ TC/VKN/TPE VE DOĞUM TARİHİ BİLGİLERİ EKLENDİ
        const applicantsHtml = applicants.length > 0 
            ? applicants.map(a => {
                let detailsArr = [];
                if (a.tckn) detailsArr.push(`TCKN: <strong>${a.tckn}</strong>`);
                if (a.taxNo || a.tax_no) detailsArr.push(`VKN: <strong>${a.taxNo || a.tax_no}</strong>`);
                if (a.tpeNo || a.tpe_no) detailsArr.push(`TPE No: <strong>${a.tpeNo || a.tpe_no}</strong>`);
                
                // 🔥 YENİ: Doğum tarihi varsa, formatlayarak diziye ekle
                if (a.birthDate || a.birth_date) {
                    detailsArr.push(`D.Tarihi: <strong>${this._formatDate(a.birthDate || a.birth_date)}</strong>`);
                }
                
                let extraHtml = detailsArr.length > 0 
                    ? `<div class="text-muted mt-2" style="font-size: 0.95rem;">${detailsArr.join(' <span class="mx-2 text-light">|</span> ')}</div>` 
                    : '';

                return `<div class="p-3 border rounded bg-light mb-2 d-flex align-items-center shadow-sm">
                    <i class="fas fa-user-tie fa-2x mr-4 text-secondary"></i>
                    <div>
                        <strong class="text-dark d-block" style="font-size: 1.15rem;">${a.name}</strong>
                        ${extraHtml}
                    </div>
                </div>`;
            }).join('') 
            : '<span class="text-danger small font-weight-bold">Seçilmedi</span>';

        const priorities = (fullRecord.priorities && fullRecord.priorities.length > 0) ? fullRecord.priorities : (details.priorities || []);
        const prioritiesHtml = priorities.length > 0 
            ? priorities.map(p => `<div class="p-3 border rounded bg-light mb-2"><i class="fas fa-globe-europe mr-2 text-info"></i><strong class="text-dark">${p.country || p.priority_country}</strong> - ${p.type || 'Rüçhan'} (${p.number || p.priority_number} / ${p.date || p.priority_date})</div>`).join('') 
            : '<span class="text-muted small font-italic">Rüçhan bilgisi eklenmemiş.</span>';

        // EŞYA LİSTESİ / SINIFLAR
        const classes = (fullRecord.goodsAndServicesByClass && fullRecord.goodsAndServicesByClass.length > 0) 
            ? fullRecord.goodsAndServicesByClass 
            : (details.goodsAndServicesByClass || []);
            
        let classesHtml = '';
        if (classes.length > 0) {
            classesHtml = classes.map(c => {
                const classNum = c.classNo || c;
                const items = c.items && Array.isArray(c.items) && c.items.length > 0 
                    ? `<ul class="mt-3 mb-0 pl-4" style="font-size: 0.95rem; color: #495057; line-height: 1.6;">${c.items.map(item => `<li class="mb-2">${item}</li>`).join('')}</ul>`
                    : '<div class="text-muted small mt-2"><i class="fas fa-info-circle mr-1"></i> Sınıfa ait özel alt kalem (eşya) seçilmemiş, standart sınıf kaydedilmiş.</div>';

                return `
                <div class="mb-4 p-4 border rounded shadow-sm" style="background-color: #f8fafc; border-color: #e2e8f0 !important;">
                    <span class="badge p-2 px-3 text-white shadow-sm" style="background-color: #3b82f6; font-size: 1.1rem; border-radius: 8px;">
                        <i class="fas fa-cube mr-1"></i> Sınıf ${classNum}
                    </span>
                    ${items}
                </div>`;
            }).join('');
        } else {
            classesHtml = '<div class="alert alert-danger font-weight-bold"><i class="fas fa-exclamation-triangle mr-2"></i>Sınıf seçimi yapılmamış.</div>';
        }

        const customClasses = tmDetails.description || fullRecord.description || details.customClasses || '';

        // --- GÖRSEL ---
        let imageUrl = tmDetails.brand_image_url || fullRecord.brandImageUrl || details.brandImageUrl || null;
        if (!imageUrl && task.documents && task.documents.length > 0) {
            const imgDoc = task.documents.find(d => d.type === 'marka_ornegi' || d.name.match(/\.(jpg|jpeg|png)$/i));
            if (imgDoc) imageUrl = imgDoc.url || imgDoc.downloadURL;
        }

        let imageSection = '';
        if (imageUrl) {
            imageSection = `
                <div class="text-center">
                    <div style="background: #f8f9fa; border: 1px dashed #cbd5e1; padding: 10px; border-radius: 12px; display: inline-block; width: 100%;">
                        <img src="${imageUrl}" class="img-fluid rounded" style="max-height: 300px; width: auto; object-fit: contain; background: #fff;" />
                    </div>
                    <div class="mt-4">
                        <a href="${imageUrl}" target="_blank" download="marka_ornegi" class="btn btn-primary btn-lg rounded-pill px-4 shadow w-100 font-weight-bold">
                            <i class="fas fa-download mr-2"></i>Görseli İndir
                        </a>
                    </div>
                </div>
            `;
        } else {
            imageSection = `<div class="alert alert-warning text-center rounded border-warning py-5"><i class="fas fa-image fa-3x mb-3 text-warning"></i><br><strong class="d-block">Görsel Bulunamadı</strong>Marka görseli sisteme yüklenmemiş.</div>`;
        }

        // --- FİNAL HTML ---
        const html = `
        <div class="application-summary-container p-3" style="background: #f4f7f9; border-radius: 0 0 16px 16px;">
            
            <div class="alert alert-info border-info shadow-sm mb-4 d-flex align-items-center" style="font-size: 1.05rem;">
                <i class="fas fa-info-circle fa-2x mr-3 text-info"></i>
                <div>
                    <strong>Resmi Kurum Başvurusu Ekrani:</strong> Bu ekrandaki tüm verileri kullanarak ilgili kuruma marka başvurusunu gerçekleştirebilirsiniz. Sınıf listeleri ve ekli belgeler sayfanın altındadır.
                </div>
            </div>

            <div class="row">
                
                <div class="col-lg-8">
                    
                    <div class="card shadow-sm border-0 mb-4" style="border-radius: 16px; overflow: hidden;">
                        <div class="card-header bg-white border-bottom p-4">
                            <h5 class="mb-0 text-primary font-weight-bold"><i class="fas fa-tag mr-2"></i>Marka Bilgileri</h5>
                        </div>
                        <div class="card-body p-0">
                            <table class="table table-striped table-hover mb-0 border-0" style="font-size: 1.05rem;">
                                <tbody>
                                    <tr><th style="width: 35%;" class="pl-4 py-3">Marka Adı</th><td class="text-primary font-weight-bold py-3" style="font-size: 1.3em;">${brandName}</td></tr>
                                    <tr><th class="pl-4 py-3 align-middle">Menşe</th><td class="py-3 align-middle">${origin}</td></tr>
                                    <tr><th class="pl-4 py-3 align-middle">Marka Tipi / Türü</th><td class="py-3 align-middle">${brandType} <span class="mx-2 text-muted">/</span> ${brandCategory}</td></tr>
                                    <tr><th class="pl-4 py-3 align-middle">Latin Dışı Karakter</th><td class="py-3 align-middle font-weight-bold ${nonLatin === 'Evet' ? 'text-danger' : 'text-success'}">${nonLatin}</td></tr>
                                    <tr><th class="pl-4 py-3 align-middle">Önyazı Talebi</th><td class="py-3 align-middle">${coverLetter}</td></tr>
                                    <tr><th class="pl-4 py-3 align-middle">Muvafakat Talebi</th><td class="py-3 align-middle">${consent}</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div class="card shadow-sm border-0 mb-4" style="border-radius: 16px; overflow: hidden;">
                        <div class="card-header bg-white border-bottom p-4">
                            <h5 class="mb-0 text-success font-weight-bold"><i class="fas fa-users mr-2"></i>Başvuru Sahipleri</h5>
                        </div>
                        <div class="card-body p-4">
                            ${applicantsHtml}
                        </div>
                    </div>

                    <div class="card shadow-sm border-0 mb-4" style="border-radius: 16px; overflow: hidden;">
                        <div class="card-header bg-white border-bottom p-4">
                            <h5 class="mb-0 text-warning font-weight-bold"><i class="fas fa-star mr-2"></i>Rüçhan Bilgileri</h5>
                        </div>
                        <div class="card-body p-4">
                            ${prioritiesHtml}
                        </div>
                    </div>
                </div>

                <div class="col-lg-4">
                    
                    <div class="card shadow-sm border-0 mb-4" style="border-radius: 16px; overflow: hidden;">
                        <div class="card-header bg-white border-bottom p-4 text-center">
                            <h5 class="mb-0 text-dark font-weight-bold">Marka Örneği</h5>
                        </div>
                        <div class="card-body p-4 bg-white">
                            ${imageSection}
                        </div>
                    </div>

                    <div class="card shadow-sm border-0 mb-4" style="border-radius: 16px; overflow: hidden;">
                        <div class="card-header bg-white border-bottom p-4">
                            <h6 class="mb-0 text-dark font-weight-bold"><i class="fas fa-info-circle mr-2 text-secondary"></i>Görev Özeti</h6>
                        </div>
                        <div class="card-body p-4" style="font-size: 1rem; line-height: 1.8;">
                            <p class="mb-2 text-muted">Oluşturan: <strong class="text-dark ml-2">${createdByTxt}</strong></p>
                            <p class="mb-2 text-muted">Atanan: <strong class="text-primary ml-2">${options.assignedUser?.displayName || task.assignedTo_email || 'Atanmamış'}</strong></p>
                            <p class="mb-2 text-muted">Öncelik: <strong class="text-dark ml-2">${task.priority}</strong></p>
                            <p class="mb-0 text-muted">Son Tarih: <strong class="text-danger ml-2">${this._formatDate(task.officialDueDate || task.official_due_date)}</strong></p>
                        </div>
                    </div>

                </div>
            </div>

            <div class="row mt-2">
                <div class="col-12">
                    <div class="card shadow-sm border-0 mb-4" style="border-radius: 16px; overflow: hidden;">
                        <div class="card-header bg-white border-bottom p-4">
                            <h5 class="mb-0 text-dark font-weight-bold"><i class="fas fa-folder-open mr-2 text-primary"></i>Ekli Diğer Belgeler</h5>
                        </div>
                        <div class="card-body p-4 bg-light">
                            ${this._generateDocsHtml(task, true)}
                        </div>
                    </div>
                </div>

                <div class="col-12">
                    <div class="card shadow-sm border-0 mb-4" style="border-radius: 16px; overflow: hidden;">
                        <div class="card-header bg-white border-bottom p-4 d-flex justify-content-between align-items-center">
                            <h4 class="mb-0 text-info font-weight-bold"><i class="fas fa-list-ol mr-2"></i>Mal ve Hizmet Sınıfları (Eşya Listesi)</h4>
                            <span class="badge badge-info p-2" style="font-size: 1rem;">Toplam Sınıf: ${classes.length}</span>
                        </div>
                        <div class="card-body p-4">
                            ${classesHtml}
                            
                            ${customClasses ? `
                            <div class="mt-4 p-4 border rounded shadow-sm" style="background: #fff8e1; border-color: #ffecb3 !important;">
                                <h6 class="font-weight-bold text-dark mb-3"><i class="fas fa-edit mr-2 text-warning"></i>Özel Tanım (Elle Eklenen):</h6>
                                <p class="m-0 text-dark" style="line-height: 1.8; font-size: 1.05rem;">${customClasses}</p>
                            </div>` : ''}
                        </div>
                    </div>
                </div>
            </div>

        </div>
        `;
        
        this.container.innerHTML = html;
    }


    // --- YARDIMCI FONKSİYONLAR AŞAĞIDA DEVAM EDİYOR ---
    async _renderEvaluationEditor(task) {
        this.showLoading();
        try {
            // 🔥 ÇÖZÜM: Mail taslağını task içinden değil, doğrudan mail tablosundaki 'associated_task_id' üzerinden buluyoruz!
            const { data: mail } = await supabase.from('mail_notifications')
                .select('*')
                .eq('associated_task_id', String(task.id))
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!mail) throw new Error("İlişkili mail taslağı bulunamadı.");

            this.container.innerHTML = `
                <div class="card shadow-sm border-0">
                    <div class="card-header bg-white border-bottom py-3">
                        <div class="d-flex justify-content-between align-items-center">
                            <h5 class="mb-0 text-dark font-weight-bold"><i class="fas fa-edit mr-2 text-primary"></i>Değerlendirme Editörü</h5>
                            <span class="badge badge-light border">ID: ${task.id}</span>
                        </div>
                    </div>
                    <div class="card-body bg-white p-4">
                        <div class="mb-4">
                            <label class="d-block small font-weight-bold text-muted text-uppercase mb-2">KONU</label>
                            <input type="text" class="form-control font-weight-bold text-dark" value="${mail.subject}" readonly style="background-color: #f8f9fa;">
                        </div>
                        <div class="mb-4">
                             <label class="d-block small font-weight-bold text-muted text-uppercase mb-2">İÇERİK DÜZENLEME</label>
                             <div id="eval-body-editor" contenteditable="true" class="form-control p-3" style="min-height: 400px; height: auto; border: 1px solid #ced4da; line-height: 1.6;">${mail.body}</div>
                        </div>
                        <div class="d-flex justify-content-end pt-3 border-top">
                            <button id="btn-save-draft" class="btn btn-secondary px-4 mr-2 shadow-sm">
                                <i class="fas fa-save mr-2"></i>Kaydet (Taslak)
                            </button>
                            <button id="btn-submit-final" class="btn btn-success px-4 font-weight-bold shadow-sm">
                                <i class="fas fa-check-circle mr-2"></i>Kaydet ve İşi Bitir
                            </button>
                        </div>
                    </div>
                </div>
            `;
            
            // mail.id bilgisini kaydetme ve bitirme fonksiyonlarına aktarıyoruz
            document.getElementById('btn-save-draft').onclick = () => this._saveEvaluationDraft(task, mail.id);
            document.getElementById('btn-submit-final').onclick = () => this._submitEvaluationFinal(task, mail.id);
        } catch (e) { 
            this.showError("Hata: " + e.message); 
        }
    }

    async _saveEvaluationDraft(task, mailId) {
        const newBody = document.getElementById('eval-body-editor').innerHTML;
        const btn = document.getElementById('btn-save-draft');
        const originalText = btn.innerHTML;
        try {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Kaydediliyor...';
            
            // 🔥 ÇÖZÜM: 'updated_at' sütunu olmadığı için payload'dan çıkarıldı.
            const { data, error } = await supabase.from('mail_notifications').update({ 
                body: newBody
            }).eq('id', mailId).select('id');
            
            if (error) throw new Error(error.message);
            if (!data || data.length === 0) throw new Error("Veritabanı kısıtlaması: Mail taslağı güncellenemedi.");
            
            btn.innerHTML = '<i class="fas fa-check mr-2"></i>Kaydedildi';
            btn.classList.replace('btn-secondary', 'btn-info');
            setTimeout(() => {
                btn.disabled = false;
                btn.innerHTML = originalText;
                btn.classList.replace('btn-info', 'btn-secondary');
            }, 2000);
        } catch (e) {
            alert("Kaydetme hatası: " + e.message);
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }

    async _submitEvaluationFinal(task, mailId) {
        const newBody = document.getElementById('eval-body-editor').innerHTML;
        const btn = document.getElementById('btn-submit-final');
        if (!confirm("İşi tamamlayıp taslağı onaya göndermek üzeresiniz. Emin misiniz?")) return;
        
        try {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>İşleniyor...';
            
            // 🔥 ÇÖZÜM: 'updated_at' sütunu mail tablosunda olmadığı için buradan silindi.
            const updatePayload = { 
                body: newBody, 
                status: "pending", 
                mode: "auto",
                is_draft: false,
                is_held: false
            };
            
            const { data: mailData, error: mailErr } = await supabase
                .from('mail_notifications')
                .update(updatePayload)
                .eq('id', mailId)
                .select(); 
            
            if (mailErr) throw new Error("Mail tablosu hatası: " + mailErr.message);
            if (!mailData || mailData.length === 0) {
                throw new Error("Veritabanı kısıtlaması: Güncelleme yapılmadı.");
            }

            // Görevler tablosunda updated_at var, o yüzden burada kalabilir.
            const { data: taskData, error: taskErr } = await supabase
                .from('tasks')
                .update({ 
                    status: "completed", 
                    updated_at: new Date().toISOString() 
                })
                .eq('id', String(task.id))
                .select();

            if (taskErr) throw new Error("Görev tablosu hatası: " + taskErr.message);
            
            alert("İşlem başarıyla tamamlandı. Mail gönderime hazır.");
            window.location.reload(); 

        } catch (e) {
            console.error("Hata Detayı:", e);
            alert("Hata: " + e.message);
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-check-circle mr-2"></i>Kaydet ve İşi Bitir';
        }
    }

    // 🔥 BELGELERİ YANYANA (FLEX/GRID) DİZEN GÜNCELLENMİŞ FONKSİYON
    _generateDocsHtml(task, isHorizontal = false) {
        let items = [];
        const docs = task.documents || [];
        const epatsDoc = docs.find(d => d.type === 'epats_document');
        const epatsUrl = epatsDoc?.downloadURL || epatsDoc?.url;

        const cardStyle = isHorizontal 
            ? "flex: 1 1 300px; min-width: 300px; max-width: 400px; margin-bottom: 0 !important;" 
            : "margin-bottom: 0.5rem;";

        if (epatsDoc && epatsUrl) {
            items.push(`
                <a href="${epatsUrl}" target="_blank" class="d-flex align-items-center justify-content-between p-3 rounded text-decoration-none bg-white border shadow-sm" style="border-left: 4px solid #d63384 !important; ${cardStyle}">
                    <div class="d-flex align-items-center">
                        <i class="fas fa-file-pdf text-danger fa-2x mr-3"></i>
                        <div class="text-truncate">
                            <span class="d-block text-dark font-weight-bold" style="font-size: 1rem;">EPATS Belgesi</span>
                            <span class="d-block text-muted small text-truncate">${epatsDoc.name}</span>
                        </div>
                    </div>
                    <i class="fas fa-external-link-alt text-muted ml-2"></i>
                </a>
            `);
        }

        docs.filter(d => d.type !== 'epats_document').forEach(file => {
            const fUrl = file.downloadURL || file.url;
            if (fUrl) {
                items.push(`
                    <a href="${fUrl}" target="_blank" class="d-flex align-items-center justify-content-between p-3 rounded text-decoration-none bg-white border shadow-sm" style="${cardStyle}">
                        <div class="d-flex align-items-center overflow-hidden">
                            <i class="fas fa-paperclip text-muted fa-2x mr-3"></i>
                            <div class="text-truncate" style="max-width: 200px;">
                                <span class="d-block text-dark font-weight-bold" style="font-size: 1rem;">Dosya</span>
                                <small class="text-muted text-truncate d-block">${file.name || 'Adsız'}</small>
                            </div>
                        </div>
                        <i class="fas fa-download text-muted ml-2"></i>
                    </a>
                `);
            }
        });

        if (items.length === 0) {
            return `<div class="text-muted small font-italic p-2">Ekli belge bulunmuyor.</div>`;
        }

        if (isHorizontal) {
            return `<div class="d-flex flex-wrap" style="gap: 15px;">${items.join('')}</div>`;
        } else {
            return items.join('');
        }
    }

    _generateAccrualsHtml(accruals) {
        if (!accruals || accruals.length === 0) {
            return `<div class="text-muted small font-italic p-2">Bağlı tahakkuk bulunmuyor.</div>`;
        }

        return accruals.map(acc => {
            let statusColor = '#f39c12'; 
            let statusText = 'Ödenmedi';
            if(acc.status === 'paid') { statusColor = '#27ae60'; statusText = 'Ödendi'; }
            else if(acc.status === 'cancelled') { statusColor = '#95a5a6'; statusText = 'İptal'; }
            
            const amountStr = this._formatMoney(acc.totalAmount || acc.total_amount);

            return `
            <div class="d-flex justify-content-between align-items-center p-3 mb-2 rounded bg-white border">
                <div class="d-flex align-items-center">
                    <span class="badge badge-light border mr-3">#${acc.id}</span>
                    <span class="font-weight-bold text-dark" style="font-size: 0.95rem;">${amountStr}</span>
                </div>
                <div class="text-right">
                    <span class="badge badge-pill text-white" style="background-color: ${statusColor}; font-size: 0.75rem;">${statusText}</span>
                    <div class="text-muted small mt-1">${this._formatDate(acc.createdAt || acc.created_at)}</div>
                </div>
            </div>`;
        }).join('');
    }

    _formatDate(dateVal) {
        return formatToTRDate(dateVal);
    }
}