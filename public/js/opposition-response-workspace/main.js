import { authService, supabase } from '../../supabase-config.js';
import { loadSharedLayout } from '../layout-loader.js';
import { showNotification } from '../../utils.js';
import { ProfessionalOppositionResponseDocument } from './ProfessionalOppositionResponseDocument.js';

const STAGES = ['sources', 'claims', 'findings', 'draft'];

class OppositionResponseStudioController {
    constructor() {
        this.taskId = null;
        this.workspace = null;
        this.activeStage = 'sources';
        this.word = new ProfessionalOppositionResponseDocument();
    }

    async init() {
        await loadSharedLayout({ activeMenuLink: 'my-tasks.html' });
        const session = await authService.getCurrentSession();
        if (!session) {
            window.location.href = 'index.html';
            return;
        }

        this.taskId = new URLSearchParams(window.location.search).get('id');
        if (!this.taskId) {
            this.renderFatal('Task ID bulunamadı.');
            return;
        }

        const detail = document.getElementById('responseTaskDetailLink');
        if (detail) detail.href = `task-update.html?id=${encodeURIComponent(this.taskId)}`;

        this.bindNavigation();
        await this.reload();

        const hash = window.location.hash.replace('#', '');
        this.setStage(STAGES.includes(hash) ? hash : 'sources', { updateHash: false });
    }

    async invoke(name, body) {
        const { data, error } = await supabase.functions.invoke(name, { body });

        if (error) {
            let serverMessage = '';
            try {
                const response = error.context;
                if (response && typeof response.clone === 'function') {
                    const cloned = response.clone();
                    const contentType = cloned.headers?.get?.('content-type') || '';
                    if (contentType.includes('application/json')) {
                        const payload = await cloned.json();
                        serverMessage = payload?.error || payload?.message || '';
                    } else {
                        serverMessage = (await cloned.text()).trim();
                    }
                }
            } catch (parseError) {
                console.warn(`[${name}] Edge Function hata gövdesi okunamadı`, parseError);
            }

            throw new Error(serverMessage || error.message || `${name} çağrısı başarısız.`);
        }

        if (data?.success === false || data?.ok === false) {
            throw new Error(data?.error || `${name} çağrısı başarısız.`);
        }
        return data;
    }

    async reload() {
        try {
            const data = await this.invoke('opposition-response-workspace', {
                action: 'get',
                taskId: this.taskId
            });
            this.workspace = data.workspace;
            this.renderAll();
        } catch (error) {
            console.error(error);
            this.renderFatal(error.message);
        }
    }

    bindNavigation() {
        document.querySelectorAll('.response-nav-item').forEach(btn => {
            btn.addEventListener('click', () => this.setStage(btn.dataset.stage));
        });
        window.addEventListener('hashchange', () => {
            const stage = window.location.hash.replace('#', '');
            if (STAGES.includes(stage)) this.setStage(stage, { updateHash: false });
        });
    }

    setStage(stage, { updateHash = true } = {}) {
        if (!STAGES.includes(stage)) return;
        this.activeStage = stage;
        document.querySelectorAll('.response-nav-item').forEach(btn => {
            const active = btn.dataset.stage === stage;
            btn.classList.toggle('is-active', active);
            if (active) btn.setAttribute('aria-current', 'step');
            else btn.removeAttribute('aria-current');
        });
        document.querySelectorAll('.response-stage').forEach(panel => {
            panel.classList.toggle('is-active', panel.dataset.stagePanel === stage);
        });
        if (updateHash) {
            history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${stage}`);
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    renderAll() {
        this.renderHeader();
        this.renderSources();
        this.renderClaims();
        this.renderFindings();
        this.renderDraft();
        this.refreshStatuses();
    }

    renderHeader() {
        const ws = this.workspace || {};
        const title = document.getElementById('responseStudioTitle');
        const subtitle = document.getElementById('responseStudioSubtitle');
        const meta = document.getElementById('responseCaseMeta');

        const mark = ws.applicant?.markText || 'Marka başvurusu';
        const appNo = ws.applicant?.applicationNo || '-';
        const applicantNames = (ws.applicant?.applicants || []).map(x => x.name).filter(Boolean).join(', ') || 'Müvekkil';
        const stage = ws.procedureStage === 'yidk_appeal' ? 'YİDK Karşı Görüşü' : 'Yayına İtiraza Karşı Görüş';

        if (title) title.textContent = `${applicantNames} · ${mark}`;
        if (subtitle) subtitle.textContent = `${stage} · Başvuru No: ${appNo}`;
        if (meta) {
            meta.innerHTML = `
                <span class="response-meta-chip"><i class="fas fa-hashtag"></i> İş ${this.escape(ws.task?.id || this.taskId)}</span>
                <span class="response-meta-chip is-stage"><i class="fas fa-balance-scale"></i> ${this.escape(stage)}</span>
                <span class="response-meta-chip is-deadline"><i class="far fa-calendar-alt"></i> Resmî Son Tarih: ${this.escape(this.formatDate(ws.task?.officialDueDate))}</span>
                <span class="response-meta-chip"><i class="fas fa-file-alt"></i> ${Number(ws.documents?.length || 0)} kaynak belge</span>
            `;
        }
        document.title = `IPGATE - ${mark} İtiraza Karşı Görüş`;
    }

    renderSources() {
        const mount = document.getElementById('responseSourcesMount');
        const badge = document.getElementById('responseBundleBadge');
        if (!mount) return;

        const ws = this.workspace || {};
        const bundle = ws.sourceBundle || {};
        const required = new Set(bundle.required || []);
        const docs = [...(ws.documents || [])].sort((a, b) => {
            const order = { official_notice: 1, epats_opposition: 2, opposition_petition: 3, office_decision: 4, previous_response: 5, proof_of_use_evidence: 6, other: 99 };
            return (order[a.role] || 99) - (order[b.role] || 99);
        });

        if (badge) {
            badge.textContent = bundle.complete ? 'Kaynak Paket Hazır' : 'Kaynak Belge Eksik';
            badge.className = `response-badge ${bundle.complete ? 'ready' : 'blocked'}`;
        }

        const roleCards = docs.map(doc => `
            <div class="response-source">
                <div>
                    <div class="response-source-title">${this.escape(this.roleLabel(doc.role))}</div>
                    <div class="response-source-meta">${this.escape(doc.document_name || '-')} ${doc.source_date ? `· ${this.escape(this.formatDate(doc.source_date))}` : ''}</div>
                </div>
                <div class="d-flex align-items-center" style="gap:6px;">
                    ${required.has(doc.role) ? '<span class="response-pill ok">ZORUNLU</span>' : '<span class="response-pill">DESTEK</span>'}
                    <a class="btn btn-sm btn-outline-secondary" href="${this.attr(doc.source_url)}" target="_blank" rel="noopener"><i class="fas fa-eye"></i></a>
                </div>
            </div>
        `).join('');

        const missing = (bundle.missing || []).map(role => `<span class="response-pill bad">${this.escape(this.roleLabel(role))}</span>`).join(' ');
        const warnings = (bundle.warnings || []).map(w => `<div class="alert alert-warning py-2 px-3 mt-2 mb-0" style="font-size:10px;">${this.escape(w)}</div>`).join('');

        mount.innerHTML = `
            <div class="response-grid">
                <div class="response-card">
                    <h3>Usul ve Dosya</h3>
                    <div class="response-muted"><strong>Aşama:</strong> ${this.escape(ws.procedureStage === 'yidk_appeal' ? 'YİDK / Karara İtiraza Karşı Görüş' : 'Markalar Dairesi / Yayına İtiraza Karşı Görüş')}</div>
                    <div class="response-muted mt-2"><strong>Başvuru:</strong> ${this.escape(ws.applicant?.applicationNo || '-')} · ${this.escape(ws.applicant?.markText || '-')}</div>
                    <div class="response-muted mt-2"><strong>Başvuru Sahibi:</strong> ${this.escape((ws.applicant?.applicants || []).map(x => x.name).join(', ') || '-')}</div>
                    ${missing ? `<div class="mt-3"><div class="response-muted mb-1"><strong>Eksik zorunlu belgeler:</strong></div>${missing}</div>` : ''}
                    ${warnings}
                </div>
                <div class="response-card">
                    <h3>Source Bundle</h3>
                    ${roleCards || '<div class="response-empty">İlişkili belge bulunamadı.</div>'}
                </div>
            </div>
            <div class="response-actionbar">
                <button id="runResponseExtraction" class="btn btn-success" ${bundle.complete ? '' : 'disabled'}>
                    <i class="fas fa-magic mr-2"></i>${ws.claims?.length ? 'Belge Analizini Yenile' : 'Belgeleri Analiz Et'}
                </button>
                <button id="refreshResponseSources" class="btn btn-outline-secondary"><i class="fas fa-sync-alt mr-2"></i>Kaynakları Yenile</button>
            </div>
            ${!bundle.complete ? '<div class="alert alert-danger mt-3 mb-0" style="font-size:11px;">Kaynak paket tamamlanmadan AI hukuki analize geçmez. Eksik belge indeksleme akışında tamamlanmalıdır.</div>' : ''}
        `;

        document.getElementById('runResponseExtraction')?.addEventListener('click', () => this.runExtraction());
        document.getElementById('refreshResponseSources')?.addEventListener('click', () => this.reload());
    }

    renderClaims() {
        const mount = document.getElementById('responseClaimsMount');
        if (!mount) return;
        const ws = this.workspace || {};
        const extracted = ws.case?.extracted_case || {};
        const opponent = ws.case?.party_snapshot?.opponent;
        const priors = ws.priorMarks || [];
        const claims = ws.claims || [];

        if (!priors.length && !claims.length) {
            mount.innerHTML = `
                <div class="response-empty">
                    <i class="fas fa-file-search fa-2x mb-2"></i><br>
                    Henüz belge analizi yapılmadı. Kaynak Dosya adımından belgeleri analiz edin.
                </div>
            `;
            return;
        }

        const conflicts = (extracted.conflicts || []).map(c => `
            <div class="alert alert-warning py-2 px-3 mb-2" style="font-size:10px;">
                <strong>${this.escape(c.field || 'Kaynak çelişkisi')}:</strong> EPATS: ${this.escape(c.epatsValue || '-')} · Diğer: ${this.escape(c.otherValue || '-')}<br>
                <span>${this.escape(c.resolution || 'EPATS bilgisi esas alınmıştır.')}</span>
            </div>
        `).join('');

        const priorHtml = priors.map(mark => {
            const scope = (mark.relied_scope || []).map(row => `Sınıf ${this.escape(row.classNo ?? row.class_no ?? '-')}: ${this.escape(row.itemsText ?? row.items_text ?? '')}`).join('<br>');
            return `
                <div class="response-prior">
                    <div class="d-flex justify-content-between align-items-start" style="gap:10px;">
                        <div>
                            <div class="response-prior-name">${this.escape(mark.mark_text || 'Marka adı belirtilmemiş')}</div>
                            <div class="response-prior-meta">
                                Başvuru: ${this.escape(mark.application_no || '-')} · Tescil: ${this.escape(mark.registration_no || '-')} · IR: ${this.escape(mark.international_registration_no || '-')}
                            </div>
                            <div class="response-prior-meta">Sahip: ${this.escape(mark.owner_name || '-')} · Kaynak: ${mark.source_kind === 'lawyer' ? 'Avukat eklemesi' : 'AI belge çıkarımı'}</div>
                            <div class="response-prior-meta">Sicil kapsamı: ${mark.registry_resolution_status === 'resolved' ? 'IP GATE kaydıyla doğrulandı' : mark.registry_resolution_status === 'not_found' ? 'IP GATE sicil kaydı bulunamadı — dayanılan kapsam esas alınır' : mark.registry_resolution_status === 'needs_review' ? 'İnceleme gerekli' : 'Henüz doğrulanmadı'}</div>
                        </div>
                        ${mark.source_kind === 'lawyer' ? `<button class="btn btn-sm btn-outline-danger" data-remove-prior="${this.attr(mark.id)}"><i class="fas fa-times"></i></button>` : ''}
                    </div>
                    ${scope ? `<div class="response-muted mt-2">${scope}</div>` : ''}
                </div>
            `;
        }).join('');

        const claimsHtml = claims.map(claim => `
            <div class="response-claim">
                <div class="response-claim-ground">${this.escape(claim.legal_ground)} · ${this.escape(this.claimTypeLabel(claim.claim_type))}</div>
                <div class="response-claim-text">${this.escape(claim.claim_text)}</div>
                ${claim.challenged_finding ? `<div class="response-muted mt-2"><strong>YİDK'da eleştirilen Daire bulgusu:</strong> ${this.escape(claim.challenged_finding)}</div>` : ''}
                <div class="response-claim-source">Kaynak sayfa ${this.escape(claim.source_page || '-')} · ${this.escape(claim.source_excerpt || '')}</div>
            </div>
        `).join('');

        const yidk = ws.procedureStage === 'yidk_appeal' ? `
            <div class="response-section">
                <div class="response-section-head"><strong>YİDK Savunma Devamlılığı</strong></div>
                <div class="response-section-body">
                    <div class="response-muted"><strong>Önceki karşı görüş bulundu:</strong> ${extracted.yidkContinuity?.previousResponseFound ? 'Evet' : 'Hayır'}</div>
                    ${extracted.yidkContinuity?.previousDefenseSummary ? `<div class="response-muted mt-2"><strong>Önceki savunma:</strong> ${this.escape(extracted.yidkContinuity.previousDefenseSummary)}</div>` : ''}
                    ${extracted.yidkContinuity?.officeDecisionSummary ? `<div class="response-muted mt-2"><strong>Markalar Dairesi kararı:</strong> ${this.escape(extracted.yidkContinuity.officeDecisionSummary)}</div>` : ''}
                </div>
            </div>
        ` : '';

        mount.innerHTML = `
            ${conflicts}
            <div class="response-grid">
                <div class="response-card">
                    <h3>Taraflar</h3>
                    <div class="response-muted"><strong>Başvuru sahibi:</strong> ${this.escape((ws.applicant?.applicants || []).map(x => x.name).join(', ') || '-')}</div>
                    <div class="response-muted mt-2"><strong>İtiraz eden:</strong> ${this.escape(opponent?.name || '-')}</div>
                    <div class="response-muted mt-2"><strong>Karşı taraf vekili:</strong> ${this.escape(opponent?.representativeName || '-')}</div>
                    <div class="response-muted mt-2">Karşı taraf için EPATS birincil kaynaktır.</div>
                </div>
                <div class="response-card">
                    <h3>İleri Sürülen Gerekçeler</h3>
                    <div>${(extracted.legalGrounds || []).map(g => `<span class="response-pill ok mr-1 mb-1">${this.escape(g)}</span>`).join('') || '<span class="response-muted">Belirlenemedi.</span>'}</div>
                </div>
            </div>

            <div class="response-section mt-3">
                <div class="response-section-head">
                    <strong>Mesnet Markalar</strong>
                    <button id="addLawyerPriorMark" class="btn btn-sm btn-outline-primary"><i class="fas fa-plus mr-1"></i>Mesnet Marka Ekle</button>
                </div>
                <div class="response-section-body">${priorHtml || '<div class="response-empty">Mesnet marka bulunamadı.</div>'}</div>
            </div>

            <div class="response-section">
                <div class="response-section-head"><strong>Karşı Taraf İddiaları</strong><span class="response-pill">${claims.length} iddia</span></div>
                <div class="response-section-body">${claimsHtml || '<div class="response-empty">Kaynaklı iddia bulunamadı.</div>'}</div>
            </div>
            ${yidk}
        `;

        document.getElementById('addLawyerPriorMark')?.addEventListener('click', () => this.openAddPriorModal());
        mount.querySelectorAll('[data-remove-prior]').forEach(btn => {
            btn.addEventListener('click', () => this.deactivatePriorMark(btn.dataset.removePrior));
        });
    }

    renderFindings() {
        const mount = document.getElementById('responseFindingsMount');
        if (!mount) return;
        const ws = this.workspace || {};
        if (!ws.claims?.length) {
            mount.innerHTML = '<div class="response-empty">Önce belge analizi tamamlanmalıdır.</div>';
            return;
        }

        const lf = ws.case?.lawyer_findings || {};
        const sign = lf.smk61?.signAssessment || {};
        const goods = lf.smk61?.goodsAssessment || {};
        const consumer = lf.smk61?.relevantConsumer || {};
        const global = lf.smk61?.globalAssessment || {};
        const publicationStage = ws.procedureStage === 'publication_opposition';

        mount.innerHTML = `
            ${publicationStage ? `
                <div class="response-checkbox mb-3">
                    <input id="proofOfUseRequested" type="checkbox" ${ws.case?.proof_of_use_requested ? 'checked' : ''}>
                    <div>
                        <strong>Kullanım ispatı talep edilsin</strong>
                        <small>İşaretlenirse dilekçede tek bir genel talep yer alır: karşı tarafın itirazına dayanak gösterdiği mesnet markaların dayanılan tüm mal ve hizmetleri bakımından kullanım ispatı talep edilir. Marka bazında seçim bu arayüzde yapılmaz.</small>
                    </div>
                </div>
            ` : `
                <div class="alert alert-info" style="font-size:10px;">
                    YİDK karşı görüş aşamasında yeni kullanım ispatı talebi oluşturulmaz. Sistem önceki karşı görüşteki savunma çizgisini ve Markalar Dairesi kararını dikkate alır.
                </div>
            `}

            <div class="response-grid">
                <div class="response-card">
                    <h3>İşaretler</h3>
                    ${this.selectField('lawyerSignSimilarity', 'İşaretlerin bütünsel benzerliği', sign.overallSimilarity, [
                        ['', 'AI değerlendirsin'], ['none', 'Benzer değil'], ['low', 'Düşük'], ['medium', 'Orta'], ['high', 'Yüksek']
                    ])}
                    ${this.selectField('lawyerCommonStrength', 'Ortak unsurun ayırt edici gücü', sign.commonElementStrength, [
                        ['', 'AI değerlendirsin'], ['very_low', 'Çok düşük / zayıf'], ['low', 'Düşük'], ['normal', 'Normal'], ['high', 'Yüksek']
                    ])}
                    ${this.textareaField('lawyerSignNote', 'İşaretlere ilişkin avukat notu', sign.note)}
                </div>

                <div class="response-card">
                    <h3>Mal ve Hizmetler</h3>
                    ${this.selectField('lawyerGoodsSimilarity', 'Genel emtia/hizmet sonucu', goods.overallSimilarity, [
                        ['', 'AI değerlendirsin'], ['not_similar', 'Benzer değil'], ['partially_similar', 'Kısmen benzer'], ['similar', 'Benzer']
                    ])}
                    ${this.textareaField('lawyerGoodsNote', 'Mal/hizmet karşılaştırmasına ilişkin avukat notu', goods.note)}
                </div>

                <div class="response-card">
                    <h3>İlgili Tüketici</h3>
                    ${this.selectField('lawyerAttention', 'Dikkat düzeyi', consumer.attentionLevel, [
                        ['', 'AI değerlendirsin'], ['low', 'Düşük'], ['average', 'Ortalama'], ['high', 'Yüksek'], ['mixed', 'Mal/hizmete göre değişken']
                    ])}
                    ${this.textareaField('lawyerConsumerNote', 'İlgili tüketiciye ilişkin avukat notu', consumer.note)}
                </div>

                <div class="response-card">
                    <h3>Bütünsel Sonuç</h3>
                    ${this.selectField('lawyerGlobalConfusion', 'Karıştırılma ihtimali', global.confusion, [
                        ['', 'AI değerlendirsin'], ['no', 'Yok'], ['borderline', 'Sınırda'], ['yes', 'Var']
                    ])}
                    ${this.textareaField('lawyerGlobalNote', 'Bütünsel değerlendirme notu', global.note)}
                    ${this.textareaField('lawyerOtherGrounds', 'Diğer itiraz gerekçelerine ilişkin not', lf.otherGroundsNote)}
                </div>
            </div>

            <div class="response-actionbar">
                <button id="saveResponseFindings" class="btn btn-primary"><i class="fas fa-save mr-2"></i>Savunma Bulgularını Kaydet</button>
                <span class="response-muted align-self-center">Boş alanlar AI tarafından hukuken değerlendirilecektir.</span>
            </div>
        `;

        document.getElementById('saveResponseFindings')?.addEventListener('click', () => this.saveFindings());
    }

    renderDraft() {
        const mount = document.getElementById('responseDraftMount');
        if (!mount) return;
        const ws = this.workspace || {};
        if (!ws.claims?.length) {
            mount.innerHTML = '<div class="response-empty">Önce belge analizi tamamlanmalıdır.</div>';
            return;
        }

        const reasoning = ws.case?.current_reasoning;
        const petition = ws.case?.current_draft;
        const qa = ws.case?.qa_report;

        let qaHtml = '';
        if (qa) {
            qaHtml = `
                <div class="response-qa ${qa.finalPass ? 'pass' : 'fail'}">
                    <strong>${qa.finalPass ? 'STRICT QA PASS' : 'STRICT QA FAIL'}</strong>
                    ${(qa.blockers || []).length ? `<ul>${qa.blockers.map(x => `<li>${this.escape(x)}</li>`).join('')}</ul>` : ''}
                    ${(qa.warnings || []).length ? `<ul>${qa.warnings.map(x => `<li>Uyarı: ${this.escape(x)}</li>`).join('')}</ul>` : ''}
                </div>
            `;
        }

        mount.innerHTML = `
            <div class="response-actionbar mb-3">
                <button id="runResponseReasoning" class="btn btn-outline-success"><i class="fas fa-brain mr-2"></i>${reasoning ? 'Hukuki Analizi Yenile' : 'Hukuki Analizi Çalıştır'}</button>
                <button id="generateResponseDraft" class="btn btn-success" ${reasoning ? '' : 'disabled'}><i class="fas fa-file-signature mr-2"></i>Karşı Görüş Dilekçesi Oluştur</button>
                <button id="exportResponseWord" class="btn btn-outline-primary" ${qa?.finalPass === true && petition ? '' : 'disabled'}><i class="fas fa-file-word mr-2"></i>Profesyonel Word</button>
            </div>

            ${reasoning ? `
                <div class="response-section">
                    <div class="response-section-head"><strong>Sol Defense Reasoning</strong><span class="response-pill ok">HAZIR</span></div>
                    <div class="response-section-body">
                        <div class="response-muted"><strong>Savunma teorisi:</strong> ${this.escape(reasoning.defenseTheory || reasoning.executiveSummary || '-')}</div>
                        <div class="response-muted mt-2"><strong>Genel sonuç:</strong> ${this.escape(reasoning.overallConclusion || '-')}</div>
                    </div>
                </div>
            ` : '<div class="alert alert-secondary" style="font-size:10px;">Önce doğrulanmış authority research + Sol hukuki reasoning çalıştırılacaktır.</div>'}

            ${qaHtml}
            ${petition ? `<div class="response-draft-text">${this.escape(petition)}</div>` : '<div class="response-empty">Henüz karşı görüş taslağı oluşturulmadı.</div>'}
        `;

        document.getElementById('runResponseReasoning')?.addEventListener('click', () => this.runReasoning());
        document.getElementById('generateResponseDraft')?.addEventListener('click', () => this.generateDraft());
        document.getElementById('exportResponseWord')?.addEventListener('click', () => this.exportWord());
    }

    async runExtraction() {
        const btn = document.getElementById('runResponseExtraction');
        await this.busy(btn, 'Belgeler okunuyor...', async () => {
            await this.invoke('opposition-response-analyze', { taskId: this.taskId });
            showNotification('Karşı tarafın itirazı, mesnet markaları ve iddiaları belgelerden çıkarıldı.', 'success');
            await this.reload();
            this.setStage('claims');
        });
    }

    async saveFindings() {
        const proof = document.getElementById('proofOfUseRequested')?.checked === true;
        const lawyerFindings = this.sparse({
            smk61: {
                signAssessment: {
                    overallSimilarity: this.value('lawyerSignSimilarity'),
                    commonElementStrength: this.value('lawyerCommonStrength'),
                    note: this.value('lawyerSignNote')
                },
                goodsAssessment: {
                    overallSimilarity: this.value('lawyerGoodsSimilarity'),
                    note: this.value('lawyerGoodsNote')
                },
                relevantConsumer: {
                    attentionLevel: this.value('lawyerAttention'),
                    note: this.value('lawyerConsumerNote')
                },
                globalAssessment: {
                    confusion: this.value('lawyerGlobalConfusion'),
                    note: this.value('lawyerGlobalNote')
                }
            },
            otherGroundsNote: this.value('lawyerOtherGrounds')
        }) || {};

        const btn = document.getElementById('saveResponseFindings');
        await this.busy(btn, 'Kaydediliyor...', async () => {
            const data = await this.invoke('opposition-response-workspace', {
                action: 'save-lawyer-settings',
                taskId: this.taskId,
                payload: {
                    proofOfUseRequested: this.workspace.procedureStage === 'publication_opposition' ? proof : false,
                    lawyerFindings
                }
            });
            this.workspace = data.workspace;
            showNotification('Savunma bulguları kaydedildi.', 'success');
            this.renderAll();
            this.setStage('draft');
        });
    }

    async runReasoning() {
        const btn = document.getElementById('runResponseReasoning');
        await this.busy(btn, 'Research + Sol çalışıyor...', async () => {
            await this.invoke('opposition-response-reasoning', {
                taskId: this.taskId,
                allowWebSearch: true
            });
            showNotification('Hukuki savunma reasoning’i tamamlandı.', 'success');
            await this.reload();
            this.setStage('draft');
        });
    }

    async generateDraft() {
        const btn = document.getElementById('generateResponseDraft');
        await this.busy(btn, 'Dilekçe hazırlanıyor...', async () => {
            const data = await this.invoke('opposition-response-draft', { taskId: this.taskId });
            showNotification(data.qaReport?.finalPass ? 'Karşı görüş dilekçesi hazır ve Strict QA PASS.' : 'Dilekçe üretildi; Strict QA blocker bulundu.', data.qaReport?.finalPass ? 'success' : 'warning');
            await this.reload();
            this.setStage('draft');
        });
    }

    async exportWord() {
        const ws = this.workspace;
        try {
            await this.word.generate({
                documentData: {
                    procedureStage: ws.procedureStage,
                    applicant: ws.applicant,
                    opponentParty: ws.case?.party_snapshot?.opponent,
                    priorMarks: ws.priorMarks,
                    task: ws.task
                },
                petitionText: ws.case?.current_draft,
                qaReport: ws.case?.qa_report
            });
            showNotification('Profesyonel Word belgesi oluşturuldu.', 'success');
        } catch (error) {
            console.error(error);
            showNotification('Word oluşturulamadı: ' + error.message, 'error');
        }
    }

    openAddPriorModal() {
        const backdrop = document.createElement('div');
        backdrop.className = 'response-modal-backdrop';
        backdrop.innerHTML = `
            <div class="response-modal" role="dialog" aria-modal="true">
                <h3>Mesnet Marka Ekle</h3>
                <div class="response-muted mb-3">Bu alan yalnız AI dilekçedeki bir mesnet hakkı atladıysa kullanılır.</div>
                ${this.inputField('manualPriorMarkText', 'Marka', '')}
                ${this.inputField('manualPriorApplicationNo', 'Başvuru No', '')}
                ${this.inputField('manualPriorRegistrationNo', 'Tescil No', '')}
                ${this.inputField('manualPriorIrNo', 'IR No', '')}
                ${this.inputField('manualPriorOwner', 'Marka Sahibi', '')}
                ${this.inputField('manualPriorGrounds', 'Gerekçeler (virgülle)', 'SMK_6_1')}
                <div class="response-modal-actions">
                    <button class="btn btn-light border" data-close-modal>Vazgeç</button>
                    <button class="btn btn-primary" data-save-prior>Kaydet</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        const close = () => backdrop.remove();
        backdrop.querySelector('[data-close-modal]')?.addEventListener('click', close);
        backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
        backdrop.querySelector('[data-save-prior]')?.addEventListener('click', async () => {
            const button = backdrop.querySelector('[data-save-prior]');
            await this.busy(button, 'Kaydediliyor...', async () => {
                await this.invoke('opposition-response-workspace', {
                    action: 'add-prior-mark',
                    taskId: this.taskId,
                    payload: {
                        markText: document.getElementById('manualPriorMarkText')?.value,
                        applicationNo: document.getElementById('manualPriorApplicationNo')?.value,
                        registrationNo: document.getElementById('manualPriorRegistrationNo')?.value,
                        internationalRegistrationNo: document.getElementById('manualPriorIrNo')?.value,
                        ownerName: document.getElementById('manualPriorOwner')?.value,
                        legalGrounds: String(document.getElementById('manualPriorGrounds')?.value || '').split(',').map(x => x.trim()).filter(Boolean)
                    }
                });
                await this.invoke('opposition-response-prior-rights', { taskId: this.taskId });
                await this.reload();
                close();
                this.renderAll();
                this.setStage('claims');
                showNotification('Mesnet marka avukat eklemesi olarak kaydedildi.', 'success');
            });
        });
    }

    async deactivatePriorMark(id) {
        if (!id) return;
        const data = await this.invoke('opposition-response-workspace', {
            action: 'deactivate-prior-mark', taskId: this.taskId, payload: { priorMarkId: id }
        });
        this.workspace = data.workspace;
        this.renderAll();
        this.setStage('claims');
    }

    refreshStatuses() {
        const ws = this.workspace || {};
        this.setStatus('sources', ws.sourceBundle?.complete ? 'Hazır' : `${(ws.sourceBundle?.missing || []).length} eksik`, ws.sourceBundle?.complete, !ws.sourceBundle?.complete);
        const extracted = (ws.claims || []).length > 0;
        this.setStatus('claims', extracted ? 'Hazır' : '—', extracted, false);
        this.setStatus('findings', extracted ? 'Hazır' : '—', extracted, false);
        const qa = ws.case?.qa_report;
        this.setStatus('draft', qa?.finalPass ? 'QA PASS' : ws.case?.current_draft ? 'QA kontrol' : ws.case?.current_reasoning ? 'Reasoning' : '—', qa?.finalPass === true, Boolean(ws.case?.current_draft && !qa?.finalPass));
    }

    setStatus(stage, label, ready = false, warning = false) {
        const el = document.querySelector(`[data-stage-status="${stage}"]`);
        if (!el) return;
        el.textContent = label;
        el.classList.toggle('is-ready', ready);
        el.classList.toggle('is-warning', !ready && warning);
    }

    async busy(button, label, fn) {
        const old = button?.innerHTML;
        if (button) {
            button.disabled = true;
            button.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${this.escape(label)}`;
        }
        try {
            await fn();
        } catch (error) {
            console.error(error);
            showNotification(error.message || 'İşlem başarısız.', 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.innerHTML = old;
            }
        }
    }

    selectField(id, label, value, options) {
        return `
            <div class="response-field">
                <label for="${this.attr(id)}">${this.escape(label)}</label>
                <select id="${this.attr(id)}">
                    ${options.map(([v, t]) => `<option value="${this.attr(v)}" ${String(value ?? '') === String(v) ? 'selected' : ''}>${this.escape(t)}</option>`).join('')}
                </select>
            </div>
        `;
    }

    textareaField(id, label, value) {
        return `
            <div class="response-field">
                <label for="${this.attr(id)}">${this.escape(label)}</label>
                <textarea id="${this.attr(id)}" placeholder="Boş bırakılırsa AI hukuki değerlendirme yapar.">${this.escape(value || '')}</textarea>
            </div>
        `;
    }

    inputField(id, label, value) {
        return `
            <div class="response-field">
                <label for="${this.attr(id)}">${this.escape(label)}</label>
                <input id="${this.attr(id)}" type="text" value="${this.attr(value || '')}">
            </div>
        `;
    }

    value(id) {
        return String(document.getElementById(id)?.value || '').trim();
    }

    sparse(value) {
        if (Array.isArray(value)) {
            const a = value.map(v => this.sparse(v)).filter(v => v !== undefined);
            return a.length ? a : undefined;
        }
        if (value && typeof value === 'object') {
            const result = {};
            for (const [k, v] of Object.entries(value)) {
                const clean = this.sparse(v);
                if (clean !== undefined) result[k] = clean;
            }
            return Object.keys(result).length ? result : undefined;
        }
        if (value === null || value === undefined || String(value).trim() === '') return undefined;
        return value;
    }

    roleLabel(role) {
        return ({
            official_notice: 'Kurum Karşı Görüş Tebligatı',
            opposition_petition: 'Karşı Taraf İtiraz / Karara İtiraz Dilekçesi',
            epats_opposition: 'EPATS Resmî İtiraz Belgesi',
            office_decision: 'Markalar Dairesi Kararı',
            previous_response: 'Önceki İtiraza Karşı Görüş',
            proof_of_use_evidence: 'Kullanım İspatı Delilleri',
            other: 'Diğer Belge'
        })[role] || role || '-';
    }

    claimTypeLabel(type) {
        return String(type || '').replaceAll('_', ' ');
    }

    formatDate(value) {
        if (!value) return '-';
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('tr-TR');
    }

    escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
    }

    attr(value) {
        return this.escape(value).replace(/`/g, '&#096;');
    }

    renderFatal(message) {
        const shell = document.querySelector('.response-studio-shell');
        if (shell) {
            shell.innerHTML = `<div style="padding:28px;width:100%;"><div class="alert alert-danger mb-0"><strong>Response Studio açılamadı.</strong><div class="mt-2">${this.escape(message)}</div></div></div>`;
        }
        showNotification('İtiraza Karşı Görüş Studio açılamadı: ' + message, 'error');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const controller = new OppositionResponseStudioController();
    window.__oppositionResponseStudioController = controller;
    await controller.init();
});
