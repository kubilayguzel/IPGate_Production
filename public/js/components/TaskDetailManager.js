// public/js/components/TaskDetailManager.js

import { supabase } from "../../supabase-config.js";
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
            if (String(task.taskType) === '66') {
                await this._renderEvaluationEditor(task);
                return;
            }

            let { ipRecord, transactionType, assignedUser, accruals = [] } = options;

            // 🔥 YENİ SUPABASE ENTEGRASYONU: Asıl İşin Portföyünü Bulma (Type 53 Tahakkuk İşleri İçin)
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

            // Eğer veritabanından ilişkili IP Record'u (Marka, Patent, Dava) çekmemiz gerekiyorsa:
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

            // --- Veri Formatlama ---
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

    async _renderEvaluationEditor(task) {
        this.showLoading();
        try {
            const { data: mail } = await supabase.from('mail_notifications').select('*').eq('id', task.mail_notification_id).maybeSingle();
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
            
            document.getElementById('btn-save-draft').onclick = () => this._saveEvaluationDraft(task);
            document.getElementById('btn-submit-final').onclick = () => this._submitEvaluationFinal(task);
        } catch (e) { 
            this.showError("Hata: " + e.message); 
        }
    }

    async _saveEvaluationDraft(task) {
        const newBody = document.getElementById('eval-body-editor').innerHTML;
        const btn = document.getElementById('btn-save-draft');
        const originalText = btn.innerHTML;
        try {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Kaydediliyor...';
            await supabase.from('mail_notifications').update({ body: newBody, updated_at: new Date().toISOString() }).eq('id', task.mail_notification_id);
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

    async _submitEvaluationFinal(task) {
        const newBody = document.getElementById('eval-body-editor').innerHTML;
        const btn = document.getElementById('btn-submit-final');
        if (!confirm("İşi tamamlayıp taslağı onaya göndermek üzeresiniz. Emin misiniz?")) return;
        try {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>İşleniyor...';
            await supabase.from('mail_notifications').update({ body: newBody, status: "awaiting_client_approval", updated_at: new Date().toISOString() }).eq('id', task.mail_notification_id);
            await supabase.from('tasks').update({ status: "completed", updated_at: new Date().toISOString() }).eq('id', String(task.id));
            alert("İşlem başarıyla tamamlandı. Mail onaya sunuldu.");
            window.location.reload(); 
        } catch (e) {
            alert("Güncelleme hatası: " + e.message);
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-check-circle mr-2"></i>Kaydet ve İşi Bitir';
        }
    }

    _generateDocsHtml(task) {
        let items = [];
        const docs = task.documents || [];
        const epatsDoc = docs.find(d => d.type === 'epats_document');
        const epatsUrl = epatsDoc?.downloadURL || epatsDoc?.url;

        if (epatsDoc && epatsUrl) {
            items.push(`
                <a href="${epatsUrl}" target="_blank" class="d-flex align-items-center justify-content-between p-3 mb-2 rounded text-decoration-none bg-white border" style="border-left: 3px solid #d63384 !important;">
                    <div class="d-flex align-items-center">
                        <i class="fas fa-file-pdf text-danger fa-lg mr-3"></i>
                        <div class="text-truncate">
                            <span class="d-block text-dark font-weight-bold" style="font-size: 0.9rem;">EPATS Belgesi</span>
                            <span class="d-block text-muted small text-truncate">${epatsDoc.name}</span>
                        </div>
                    </div>
                    <i class="fas fa-external-link-alt text-muted small"></i>
                </a>
            `);
        }

        docs.filter(d => d.type !== 'epats_document').forEach(file => {
            const fUrl = file.downloadURL || file.url;
            if (fUrl) {
                items.push(`
                    <a href="${fUrl}" target="_blank" class="d-flex align-items-center justify-content-between p-3 mb-2 rounded text-decoration-none bg-white border">
                        <div class="d-flex align-items-center overflow-hidden">
                            <i class="fas fa-paperclip text-muted fa-lg mr-3"></i>
                            <div class="text-truncate" style="max-width: 250px;">
                                <span class="d-block text-dark font-weight-bold" style="font-size: 0.9rem;">Dosya</span>
                                <small class="text-muted text-truncate d-block">${file.name || 'Adsız'}</small>
                            </div>
                        </div>
                        <i class="fas fa-download text-muted small"></i>
                    </a>
                `);
            }
        });

        return items.length ? items.join('') : `<div class="text-muted small font-italic p-2">Ekli belge bulunmuyor.</div>`;
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