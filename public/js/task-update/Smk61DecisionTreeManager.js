import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

const UX_PACKAGE_VERSION = '6.1.7';

const GOODS_SIMILARITY_OPTIONS = [
  ['', 'Seçiniz...'], ['identical', 'Aynı / özdeş'], ['high', 'Yüksek'],
  ['medium', 'Orta'], ['low', 'Düşük'], ['none', 'Benzer değil']
];
const GOODS_CRITERIA_OPTIONS = [
  ['nature', 'Nitelik / özellik'], ['purpose', 'Amaç'], ['use_method', 'Kullanım biçimi'],
  ['complementary', 'Tamamlayıcılık'], ['competitive', 'Rekabet / ikame'],
  ['distribution_channels', 'Dağıtım / satış kanalları'], ['relevant_public', 'İlgili tüketici kesimi']
];
const DISTINCTIVENESS_OPTIONS = [
  ['', 'Seçiniz...'], ['high', 'Yüksek ayırt edicilik'], ['normal', 'Normal ayırt edicilik'],
  ['weak', 'Zayıf ayırt edicilik'], ['descriptive', 'Tanımlayıcı nitelikte'], ['non_distinctive', 'Ayırt edici değil']
];
const ELEMENT_DISTINCTIVENESS_OPTIONS = [
  ['', 'Seçiniz...'], ['high', 'Yüksek ayırt edicilik'], ['normal', 'Normal ayırt edicilik'],
  ['weak', 'Zayıf ayırt edicilik'], ['descriptive', 'Tanımlayıcı nitelikte'], ['non_distinctive', 'Ayırt edici değil'],
  ['not_assessed', 'Bu unsur hakkında ayırt edicilik tespiti yapmıyorum'], ['not_applicable', 'Uygulanamaz / ek unsur yok']
];
const ADDITIONAL_ROLE_OPTIONS = [
  ['', 'Seçiniz...'], ['negligible', 'İhmal edilebilir / tali'], ['secondary_distinctive', 'İkincil fakat ayırt edici'],
  ['co_dominant', 'Birlikte baskın'], ['dominant', 'Baskın unsur'], ['not_assessed', 'Bu unsurun rolü hakkında tespit yapmıyorum'],
  ['not_applicable', 'Uygulanamaz / ek unsur yok']
];
const INDEPENDENT_ROLE_OPTIONS = [
  ['', 'Seçiniz...'], ['yes', 'Evet'], ['no', 'Hayır'], ['uncertain', 'Sınırda / ayrıca değerlendirme gerekli'],
  ['not_applicable', 'Uygulanamaz']
];
const SIGN_SIMILARITY_OPTIONS = [
  ['', 'Seçiniz...'], ['high', 'Yüksek'], ['medium', 'Orta'], ['low', 'Düşük'],
  ['none', 'Benzerlik yok'], ['no_comparison', 'Karşılaştırılamıyor']
];
const PUBLIC_TYPE_OPTIONS = [
  ['', 'Seçiniz...'], ['general', 'Genel tüketici'], ['professional', 'Profesyonel / uzman'], ['mixed', 'Karma tüketici grubu']
];
const ATTENTION_OPTIONS = [['', 'Seçiniz...'], ['low', 'Düşük'], ['normal', 'Normal'], ['high', 'Yüksek']];
const GLOBAL_OPTIONS = [
  ['', 'Seçiniz...'], ['exists', 'Karıştırılma ihtimali var'], ['borderline', 'Sınırda / tartışmalı'],
  ['does_not_exist', 'Karıştırılma ihtimali yok']
];
const ASSOCIATION_OPTIONS = [
  ['', 'Seçiniz...'], ['exists', 'İlişkilendirilme ihtimali var'], ['borderline', 'Sınırda / tartışmalı'],
  ['does_not_exist', 'İlişkilendirilme ihtimali yok']
];
const STEPS = [
  [1, 'Müstenit Haklar'], [2, 'Mal / Hizmet'], [3, 'İşaretler'], [4, 'Tüketici'], [5, 'Genel Sonuç']
];
const STYLE_ID = 'evreka-smk61-guided-617-styles';

export class Smk61DecisionTreeManager {
  constructor(taskId, workspace) {
    this.taskId = String(taskId);
    this.workspace = workspace;
    this.mount = document.getElementById('smk61DecisionTreeMount');
    this.context = null;
    this.activeStep = 1;
    this.dirty = false;
  }

  async init() {
    if (!this.mount) return;
    const grounds = this.workspace?.case?.selected_grounds || [];
    if (!grounds.includes('SMK_6_1')) {
      this.mount.innerHTML = '<div class="opp61-disabled-note"><i class="fas fa-info-circle mr-2"></i>SMK 6/1 seçili olmadığı için 6/1 hukuki analiz alanı gösterilmiyor.</div>';
      return;
    }
    this.ensureStyles();
    await this.load();
  }

  ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      .o617{--i:#162033;--m:#667085;--b:#dde4ee;--p:#2457d6;--ps:#edf3ff;--g:#18794e;--gs:#ecf8f2;--w:#9a6700;--ws:#fff8e6;color:var(--i);font-size:14px}
      .o617-card{border:1px solid var(--b);border-radius:16px;background:#fff;box-shadow:0 8px 28px rgba(16,24,40,.06);overflow:hidden}
      .o617-head{display:flex;justify-content:space-between;gap:20px;padding:22px 24px 18px;border-bottom:1px solid var(--b);background:linear-gradient(135deg,#fff,#f7faff)}
      .o617-eye{font-size:11px;font-weight:800;letter-spacing:.09em;color:var(--p);text-transform:uppercase}.o617-title{font-size:20px;font-weight:800;margin:4px 0}.o617-sub{color:var(--m);line-height:1.5;max-width:760px}
      .o617-ver{border:1px solid #cdd9f5;background:var(--ps);color:var(--p);border-radius:999px;padding:7px 10px;font-size:11px;font-weight:800;white-space:nowrap}
      .o617-saved{padding:10px 24px;border-bottom:1px solid var(--b)}.o617-saved-row{display:flex;justify-content:space-between;gap:12px;align-items:center}.o617-pill{border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700}.o617-pill.ok{background:var(--gs);color:var(--g)}.o617-pill.warn{background:var(--ws);color:var(--w)}
      .o617-dirty{display:none;color:var(--w);font-size:12px;font-weight:700}.o617-dirty.on{display:inline-flex;gap:6px;align-items:center}.o617-stale{margin-top:8px;padding:9px 11px;border-radius:10px;background:#fff1f0;color:#b42318;font-size:12px;font-weight:600}
      .o617-rdet{margin-top:8px;font-size:12px;color:var(--m)}.o617-rdet summary{cursor:pointer;font-weight:700;color:#44506a}.o617-rdet ul{margin:6px 0 0 20px;padding:0}
      .o617-prog{padding:18px 24px 16px;border-bottom:1px solid var(--b)}.o617-prog-head{display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:var(--m)}.o617-track{height:6px;border-radius:999px;background:#e8edf5;overflow:hidden;margin:10px 0 14px}.o617-bar{height:100%;background:var(--p);width:0;transition:width .2s}
      .o617-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.o617-tab{border:1px solid var(--b);background:#fff;border-radius:12px;padding:9px 8px;min-height:58px;text-align:left;cursor:pointer}.o617-tab.active{border-color:#8ba8eb;background:var(--ps)}.o617-tab.done{border-color:#b9e0cf;background:#fbfffd}.o617-tab-in{display:flex;gap:8px;align-items:center}.o617-num{width:26px;height:26px;border-radius:50%;background:#eef2f7;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800}.o617-tab.active .o617-num{background:var(--p);color:#fff}.o617-tab.done .o617-num{background:var(--g);color:#fff}.o617-tab b{display:block;font-size:12px}.o617-tab small{color:var(--m);font-size:10px}
      .o617-layout{display:grid;grid-template-columns:minmax(0,1fr) 290px}.o617-main{padding:22px 24px 24px;min-width:0}.o617-side{position:sticky;top:12px;border-left:1px solid var(--b);background:#fbfcfe;padding:20px 18px;min-height:520px}.o617-panel{display:none}.o617-panel.active{display:block}
      .o617-kick{font-size:11px;font-weight:800;color:var(--p);text-transform:uppercase;letter-spacing:.06em}.o617-ptitle{font-size:18px;font-weight:800;margin:3px 0 5px}.o617-help{color:var(--m);line-height:1.5;margin-bottom:18px}
      .o617-box,.o617-goods{border:1px solid var(--b);border-radius:14px;background:#fff;padding:16px;margin-bottom:14px}.o617-soft{background:#f7f9fc}.o617-boxhead,.o617-ghead{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:12px}.o617-ctitle{font-weight:800;color:#26334d}.o617-meta{font-size:12px;color:var(--m);line-height:1.45;margin-top:3px}
      .o617-confirm,.o617-switch{display:inline-flex;gap:8px;align-items:center;border:1px solid var(--b);background:#f7f9fc;border-radius:10px;padding:8px 10px;font-size:12px;font-weight:700;cursor:pointer}.o617-confirm input,.o617-switch input{width:16px;height:16px}.o617-auto{padding:9px 10px;border-radius:9px;font-size:12px;margin-top:8px}.o617-auto.bad{background:#fff1f0;color:#b42318}.o617-auto.warn{background:var(--ws);color:var(--w)}
      .o617-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.o617-label{display:flex;justify-content:space-between;gap:10px;margin-bottom:6px;font-size:12px;font-weight:800;color:#344054}.o617-req{font-size:10px;color:var(--m);font-weight:600}.o617-input,.o617-select,.o617-text{width:100%;border:1px solid #cfd8e6;border-radius:10px;background:#fff;color:var(--i);padding:9px 10px;outline:none}.o617-text{resize:vertical}.o617-input:focus,.o617-select:focus,.o617-text:focus{border-color:#7b9be5;box-shadow:0 0 0 3px rgba(36,87,214,.1)}
      .o617-hidden{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important}.o617-choices{display:flex;flex-wrap:wrap;gap:7px}.o617-choice{border:1px solid #d4dce8;background:#fff;border-radius:10px;padding:8px 10px;color:#475467;font-size:12px;font-weight:700;cursor:pointer}.o617-choice.sel{border-color:#7f9fe9;background:var(--ps);color:var(--p)}.o617-result .o617-choice{flex:1 1 150px;min-height:46px;text-align:left}
      .o617-chips{display:flex;flex-wrap:wrap;gap:7px}.o617-chip{position:relative;cursor:pointer}.o617-chip input{position:absolute;opacity:0}.o617-chip span{display:inline-flex;border:1px solid #d4dce8;border-radius:999px;padding:7px 10px;background:#fff;color:#475467;font-size:11px;font-weight:700}.o617-chip input:checked+span{border-color:#7f9fe9;background:var(--ps);color:var(--p)}.o617-markgrp{padding-bottom:10px;margin-bottom:10px;border-bottom:1px dashed #d8e0ec}.o617-markgrp:last-child{border:0;margin:0;padding:0}.o617-marktitle{font-size:11px;font-weight:800;margin-bottom:6px;color:#3d4b64}
      .o617-class{display:inline-flex;border-radius:999px;padding:5px 9px;background:#eef2f7;font-size:11px;font-weight:800}.o617-details{border:1px solid #e2e8f0;border-radius:10px;background:#fafbfc;margin:10px 0 14px}.o617-details summary{padding:9px 11px;cursor:pointer;font-size:11px;font-weight:700;color:#475467}.o617-gtext{border-top:1px solid #e2e8f0;padding:10px 11px;font-size:11px;color:#596579;line-height:1.5;white-space:pre-wrap}
      .o617-scope{margin-top:14px;padding:13px;border:1px solid #cfdcf7;border-radius:12px;background:#f8faff}.o617-scope.d-none{display:none!important}.o617-note{display:flex;gap:8px;align-items:flex-start;padding:9px 10px;border-radius:9px;background:#eef4ff;color:#365486;font-size:11px;line-height:1.45;margin-bottom:12px}
      .o617-adv{margin-top:16px;border:1px solid var(--b);border-radius:13px;overflow:hidden}.o617-adv summary{cursor:pointer;display:flex;justify-content:space-between;gap:12px;padding:13px 14px;font-weight:800;background:#fbfcfe}.o617-advbody{border-top:1px solid var(--b);padding:15px}.o617-ab{border-radius:999px;padding:4px 8px;background:var(--ws);color:var(--w);font-size:10px;font-weight:800}.o617-adv.done .o617-ab{background:var(--gs);color:var(--g)}.o617-elements{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}.o617-element{border:1px solid var(--b);border-radius:12px;background:#f7f9fc;padding:13px}.o617-etitle{font-size:12px;font-weight:800;margin-bottom:10px}
      .o617-stepstatus{margin-top:18px;border-radius:11px;padding:10px 12px;font-size:12px}.o617-stepstatus.ok{background:var(--gs);color:var(--g)}.o617-stepstatus.bad{background:var(--ws);color:var(--w)}.o617-stepstatus ul{margin:6px 0 0 18px;padding:0}.o617-nav{display:flex;justify-content:space-between;gap:12px;margin-top:18px;padding-top:16px;border-top:1px solid var(--b)}.o617-btn{border:1px solid #cdd7e6;background:#fff;border-radius:10px;padding:9px 13px;font-size:12px;font-weight:800;color:#344054;cursor:pointer}.o617-btn.pri{background:var(--p);border-color:var(--p);color:#fff}.o617-btn:disabled{opacity:.45}
      .o617-side-title{font-size:11px;font-weight:800;letter-spacing:.06em;color:var(--m);text-transform:uppercase;margin-bottom:12px}.o617-sgroup{padding:11px 0;border-bottom:1px solid #e4e9f1}.o617-sgroup:last-child{border:0}.o617-slabel{font-size:10px;font-weight:800;color:var(--m);text-transform:uppercase;margin-bottom:5px}.o617-svalue{font-size:12px;line-height:1.45;color:#344054;font-weight:700}.o617-sline{display:flex;justify-content:space-between;gap:10px;margin:4px 0;font-size:11px}.o617-sline strong{text-align:right}.o617-ready{margin-top:14px;padding:10px;border-radius:10px;background:#f7f9fc;font-size:11px;color:var(--m)}.o617-ready.ok{background:var(--gs);color:var(--g)}
      .o617-review{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:16px}.o617-rc{border:1px solid var(--b);border-radius:12px;background:#f7f9fc;padding:12px}.o617-rl{font-size:10px;color:var(--m);text-transform:uppercase;font-weight:800;margin-bottom:6px}.o617-rv{font-size:12px;color:#344054;font-weight:700;line-height:1.45}.o617-save{margin-top:16px;border:1px solid #bcd1ff;border-radius:14px;background:#f6f9ff;padding:14px}.o617-savehead{display:flex;justify-content:space-between;align-items:center;gap:12px}.o617-savebtn{border:0;border-radius:10px;background:var(--p);color:#fff;padding:10px 15px;font-weight:800;font-size:12px;cursor:pointer;min-width:170px}
      @media(max-width:1120px){.o617-layout{grid-template-columns:1fr}.o617-side{position:static;border-left:0;border-top:1px solid var(--b);min-height:0}}
      @media(max-width:820px){.o617-head,.o617-prog,.o617-main{padding-left:16px;padding-right:16px}.o617-tabs{grid-template-columns:1fr 1fr}.o617-tab:last-child{grid-column:span 2}.o617-grid,.o617-elements,.o617-review{grid-template-columns:1fr}.o617-head,.o617-boxhead,.o617-ghead,.o617-savehead{flex-direction:column}}
    `;
    document.head.appendChild(s);
  }

  async invoke(action, payload = {}) {
    const { data, error } = await supabase.functions.invoke('opposition-analysis', {
      body: { action, taskId: this.taskId, payload }
    });
    if (error) throw new Error(error.message || '6/1 analiz servisine ulaşılamadı.');
    if (!data?.success) throw new Error(data?.error || '6/1 analiz işlemi başarısız oldu.');
    return data.context;
  }

  async load() {
    this.renderLoading();
    try {
      this.context = await this.invoke('get');
      this.dirty = false;
      this.render();
    } catch (error) {
      console.error('SMK 6/1 analiz yükleme hatası:', error);
      this.renderError(error.message);
    }
  }

  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }
  optionList(options, selected) {
    return options.map(([v,l]) => `<option value="${this.escape(v)}" ${v===selected?'selected':''}>${this.escape(l)}</option>`).join('');
  }
  label(options, value, fallback='Seçilmedi') {
    return options.find(([v]) => String(v)===String(value??''))?.[1] || fallback;
  }
  value(id) { return String(this.mount.querySelector(`#${id}`)?.value || '').trim(); }

  renderLoading() {
    this.ensureStyles();
    this.mount.innerHTML = '<div class="o617"><div class="o617-card" style="padding:28px;text-align:center;color:#667085"><i class="fas fa-spinner fa-spin mr-2"></i>SMK 6/1 hukuki analiz çalışma alanı hazırlanıyor...</div></div>';
  }
  renderError(message) {
    this.ensureStyles();
    this.mount.innerHTML = `<div class="o617"><div class="o617-card" style="padding:22px"><div class="alert alert-danger mb-0"><strong>6/1 analiz motoru yüklenemedi.</strong><br>${this.escape(message)}<div class="mt-3"><button id="o617Retry" class="btn btn-sm btn-outline-danger"><i class="fas fa-redo mr-1"></i>Tekrar Dene</button></div></div></div></div>`;
    this.mount.querySelector('#o617Retry')?.addEventListener('click', () => this.load());
  }

  readinessHtml() {
    const r = this.context?.readiness || {}, blockers=r.blockers||[], warnings=r.warnings||[], ok=r.canDraft===true;
    return `<div class="o617-saved"><div class="o617-saved-row"><span class="o617-pill ${ok?'ok':'warn'}"><i class="fas ${ok?'fa-check-circle':'fa-exclamation-circle'} mr-1"></i>Son kayıt: ${ok?'dilekçe üretimine hazır':'analiz tamamlanmadı'}</span><span id="o617Dirty" class="o617-dirty ${this.dirty?'on':''}"><i class="fas fa-circle" style="font-size:6px"></i>Kaydedilmemiş değişiklikler</span></div>
      ${this.context?.stale?'<div class="o617-stale"><i class="fas fa-sync-alt mr-1"></i>Müstenit haklar veya rakip kapsam değişmiş. Analizi güncelleyip yeniden kaydedin.</div>':''}
      ${(blockers.length||warnings.length)?`<details class="o617-rdet"><summary>Son kayıt denetimi: ${blockers.length} eksik/hata · ${warnings.length} uyarı</summary>${blockers.length?`<ul>${blockers.map(x=>`<li>${this.escape(x)}</li>`).join('')}</ul>`:''}${warnings.length?`<ul>${warnings.map(x=>`<li>${this.escape(x)}</li>`).join('')}</ul>`:''}</details>`:''}</div>`;
  }

  progressHtml() {
    return `<div class="o617-prog"><div class="o617-prog-head"><span>Hukuki analiz akışı</span><strong id="o617Pct" style="color:#2457d6">%0 tamamlandı</strong></div><div class="o617-track"><div id="o617Bar" class="o617-bar"></div></div><div class="o617-tabs">${STEPS.map(([n,t])=>`<button type="button" class="o617-tab" data-step="${n}"><span class="o617-tab-in"><span class="o617-num">${n}</span><span><b>${t}</b><small>Bekliyor</small></span></span></button>`).join('')}</div></div>`;
  }

  choice(id, options, selected='', className='', result=false) {
    return `<div class="o617-choicegrp ${result?'o617-result':''}" data-choice="${id}"><select id="${id}" class="o617-hidden ${className}" tabindex="-1">${this.optionList(options,selected)}</select><div class="o617-choices">${options.filter(([v])=>v!=='').map(([v,l])=>`<button type="button" class="o617-choice ${v===selected?'sel':''}" data-value="${this.escape(v)}">${this.escape(l)}</button>`).join('')}</div></div>`;
  }

  priorRightsHtml() {
    const rights=this.context?.priorRights||[], rows=this.context?.formData?.priorRightsReview||[];
    if (!rights.length) return '<div class="o617-box o617-soft">Seçili müstenit hak bulunmuyor.</div>';
    return rights.map(right=>{
      const review=rows.find(x=>String(x.ipRecordId)===String(right.id))||{}, blockers=right.autoChecks?.blockers||[], warnings=right.autoChecks?.warnings||[];
      const cls=(right.classes||[]).map(x=>`Sınıf ${x.classNo}`).join(' · ');
      return `<div class="o617-box opp61-prior-review" data-prior-id="${this.escape(right.id)}"><div class="o617-boxhead"><div><div class="o617-ctitle">${this.escape(right.markText||'-')}</div><div class="o617-meta">Başvuru: ${this.escape(right.applicationNo||'-')} · Tescil: ${this.escape(right.registrationNo||'-')} · Statü: ${this.escape(right.status||'-')}</div>${cls?`<div class="o617-meta">${this.escape(cls)}</div>`:''}</div><label class="o617-confirm"><input type="checkbox" class="opp61-prior-confirm" ${review.confirmedEligible?'checked':''}><span>Uygunluğu teyit edildi</span></label></div>
        ${blockers.length?`<div class="o617-auto bad">${blockers.map(x=>`<div><i class="fas fa-times-circle mr-1"></i>${this.escape(x)}</div>`).join('')}</div>`:''}${warnings.length?`<div class="o617-auto warn">${warnings.map(x=>`<div><i class="fas fa-exclamation-triangle mr-1"></i>${this.escape(x)}</div>`).join('')}</div>`:''}
        <div style="margin-top:12px"><div class="o617-label"><span>Kısa not</span><span class="o617-req">opsiyonel</span></div><textarea class="o617-text opp61-prior-note" rows="2" placeholder="Bu hak bakımından gerekiyorsa kısa not...">${this.escape(review.note||'')}</textarea></div></div>`;
    }).join('');
  }

  priorClasses(selectedKeys=[]) {
    const selected=new Set(selectedKeys||[]), rights=this.context?.priorRights||[];
    return rights.map(right=>`<div class="o617-markgrp"><div class="o617-marktitle">${this.escape(right.markText||right.applicationNo||right.id)}${right.applicationNo?` · ${this.escape(right.applicationNo)}`:''}</div><div class="o617-chips">${(right.classes||[]).map(cls=>{const key=`${right.id}:${Number(cls.classNo)}`;return `<label class="o617-chip"><input type="checkbox" class="opp61-prior-class-check" value="${this.escape(key)}" ${selected.has(key)?'checked':''}><span>Sınıf ${this.escape(cls.classNo)}</span></label>`}).join('')}</div></div>`).join('');
  }
  criteria(selected=[]) {
    const set=new Set(selected||[]);
    return `<div class="o617-chips">${GOODS_CRITERIA_OPTIONS.map(([v,l])=>`<label class="o617-chip"><input type="checkbox" class="opp61-criteria-check" value="${v}" ${set.has(v)?'checked':''}><span>${this.escape(l)}</span></label>`).join('')}</div>`;
  }

  goodsHtml() {
    const rows=this.context?.formData?.goodsAssessments||[];
    if (!rows.length) return '<div class="o617-box o617-soft">Rakip başvurunun tam mal/hizmet kapsamı bulunamadı.</div>';
    return rows.map(row=>{
      const no=Number(row.opponentClassNo), sim=row.similarityLevel==='not_assessed'?'':(row.similarityLevel||'');
      return `<div class="o617-goods opp61-goods-card" data-opponent-class="${no}"><div class="o617-ghead"><div><span class="o617-class">Rakip Sınıf ${no}</span><div class="o617-meta">Benzerlik ve ret kapsamını birlikte değerlendirin.</div></div><label class="o617-switch"><input type="checkbox" class="opp61-refusal-check" ${row.requestedRefusal?'checked':''}><span>Ret talep et</span></label></div>
        <details class="o617-details"><summary>Rakip sınıfın tam mal/hizmet metnini göster</summary><div class="o617-gtext">${this.escape(row.opponentText||'Metin bulunamadı.')}</div></details>
        <div class="o617-box o617-soft"><div class="o617-label"><span>1. Benzerlik derecesi</span><span class="o617-req">zorunlu</span></div>${this.choice(`o617Sim-${no}`,GOODS_SIMILARITY_OPTIONS,sim,'opp61-similarity-select')}</div>
        <div class="o617-grid"><div><div class="o617-label"><span>2. Dayanılan müstenit sınıf(lar)</span><span class="o617-req">benzerlik varsa zorunlu</span></div><div class="o617-box o617-soft">${this.priorClasses(row.matchedPriorClasses||[])}</div></div><div><div class="o617-label"><span>3. Benzerlik kriterleri</span><span class="o617-req">benzerlik varsa zorunlu</span></div><div class="o617-box o617-soft">${this.criteria(row.criteria||[])}</div></div></div>
        <div class="o617-scope opp61-refusal-scope ${row.requestedRefusal?'':'d-none'}"><div class="o617-note"><i class="fas fa-shield-alt"></i><div><strong>Exact ret kapsamı.</strong> Ret talep ediyorsanız sınıfın tamamı mı yoksa belirli mal/hizmetler mi reddedilecek açıkça seçin.</div></div><div class="o617-label"><span>Ret kapsamı</span><span class="o617-req">ret isteniyorsa zorunlu</span></div>${this.choice(`o617Scope-${no}`,[['','Seçiniz...'],['full_class','Sınıfın tamamı'],['partial','Kısmi kapsam']],row.refusalScopeMode||'','opp61-refusal-scope-mode')}
          <div class="opp61-partial-scope-box ${row.refusalScopeMode==='partial'?'':'d-none'}" style="margin-top:12px"><div class="o617-label"><span>Reddini istediğimiz exact mal/hizmet metni</span><span class="o617-req">birebir metin</span></div><textarea class="o617-text opp61-refusal-scope-text" rows="5" placeholder="Resmî mal/hizmet metninden aynen kopyalayın.">${this.escape(row.refusalScopeText||'')}</textarea></div><div class="opp61-full-scope-note ${row.refusalScopeMode==='full_class'?'':'d-none'}"><div class="o617-meta" style="margin-top:10px">Sistem bu sınıf için kayıtlı tam mal/hizmet metnini kullanacaktır.</div></div></div>
        <div style="margin-top:14px"><div class="o617-label"><span>Kısa dosya notu</span><span class="o617-req">opsiyonel</span></div><textarea class="o617-text opp61-goods-note" rows="2">${this.escape(row.note||'')}</textarea></div></div>`;
    }).join('');
  }

  advancedMissing(sign={}) {
    return [sign.commonElementDistinctiveness,sign.independentDistinctiveRole,sign.clientDominantElements,sign.opponentDominantElements,sign.clientAdditionalElements,sign.clientAdditionalDistinctiveness,sign.clientAdditionalRole,sign.opponentAdditionalElements,sign.opponentAdditionalDistinctiveness,sign.opponentAdditionalRole].filter(v=>!String(v??'').trim()).length;
  }

  signHtml() {
    const s=this.context?.formData?.signAssessment||{}, miss=this.advancedMissing(s);
    return `<div class="o617-box o617-soft"><div class="o617-grid"><div><div class="o617-label"><span>Ortak unsur(lar)</span><span class="o617-req">zorunlu</span></div><input id="opp61CommonElements" class="o617-input" value="${this.escape(s.commonElements||'')}" placeholder="Örn: Z"></div><div><div class="o617-label"><span>Farklı unsur(lar)</span><span class="o617-req">zorunlu</span></div><input id="opp61Differences" class="o617-input" value="${this.escape(s.differences||'')}" placeholder="Örn: ŞARJ / PREMIUM CARS; yoksa 'yok'"></div></div></div>
      <div class="o617-box"><div class="o617-ctitle" style="margin-bottom:12px">Benzerlik sonuçları</div><div class="o617-grid">${[['opp61Visual','Görsel',s.visualSimilarity],['opp61Aural','İşitsel',s.auralSimilarity],['opp61Conceptual','Kavramsal',s.conceptualSimilarity],['opp61Overall','Genel izlenim',s.overallSimilarity]].map(([id,l,v])=>`<div><div class="o617-label"><span>${l}</span><span class="o617-req">zorunlu</span></div>${this.choice(id,SIGN_SIMILARITY_OPTIONS,v||'')}</div>`).join('')}</div></div>
      <details id="o617Adv" class="o617-adv ${miss===0?'done':''}" ${miss>0?'open':''}><summary><span><i class="fas fa-sliders-h mr-2"></i>İleri unsur analizi</span><span id="o617AdvBadge" class="o617-ab">${miss===0?'tamamlandı':`${miss} zorunlu alan eksik`}</span></summary><div class="o617-advbody"><div class="o617-note"><i class="fas fa-user-check"></i><div><strong>Avukat bulgusu.</strong> AI bu bölümde öneri üretmez. Seçtiğiniz nitelendirmeler dilekçede bağlayıcı bulgu olarak kullanılır.</div></div>
        <div class="o617-grid"><div><div class="o617-label"><span>Ortak unsurun ayırt ediciliği</span><span class="o617-req">zorunlu</span></div><select id="opp61Distinctiveness" class="o617-select">${this.optionList(DISTINCTIVENESS_OPTIONS,s.commonElementDistinctiveness||'')}</select></div><div><div class="o617-label"><span>Ortak unsurun bağımsız ayırt edici rolü</span><span class="o617-req">zorunlu</span></div><select id="opp61IndependentRole" class="o617-select">${this.optionList(INDEPENDENT_ROLE_OPTIONS,s.independentDistinctiveRole||'')}</select></div><div><div class="o617-label"><span>Müstenit markanın baskın / ayırt edici unsuru</span><span class="o617-req">zorunlu</span></div><input id="opp61ClientDominant" class="o617-input" value="${this.escape(s.clientDominantElements||'')}"></div><div><div class="o617-label"><span>Rakip markanın baskın / ayırt edici unsuru</span><span class="o617-req">zorunlu</span></div><input id="opp61OpponentDominant" class="o617-input" value="${this.escape(s.opponentDominantElements||'')}"></div></div>
        <div class="o617-elements"><div class="o617-element"><div class="o617-etitle">Müstenit markadaki ek unsur(lar)</div>${this.elementFields('Client',s.clientAdditionalElements,s.clientAdditionalDistinctiveness,s.clientAdditionalRole)}</div><div class="o617-element"><div class="o617-etitle">Rakip markadaki ek unsur(lar)</div>${this.elementFields('Opponent',s.opponentAdditionalElements,s.opponentAdditionalDistinctiveness,s.opponentAdditionalRole)}</div></div></div></details>
      <div style="margin-top:14px"><div class="o617-label"><span>İşaret analizi notu</span><span class="o617-req">opsiyonel</span></div><textarea id="opp61SignNote" class="o617-text" rows="3">${this.escape(s.note||'')}</textarea></div>`;
  }

  elementFields(prefix,text,dist,role) {
    return `<div style="margin-bottom:10px"><div class="o617-label"><span>Ek unsur metni</span><span class="o617-req">zorunlu</span></div><input id="opp61${prefix}AdditionalElements" class="o617-input" value="${this.escape(text||'')}" placeholder="Yoksa 'yok'"></div><div style="margin-bottom:10px"><div class="o617-label"><span>Ayırt edicilik</span><span class="o617-req">zorunlu</span></div><select id="opp61${prefix}AdditionalDistinctiveness" class="o617-select">${this.optionList(ELEMENT_DISTINCTIVENESS_OPTIONS,dist||'')}</select></div><div><div class="o617-label"><span>Rol</span><span class="o617-req">zorunlu</span></div><select id="opp61${prefix}AdditionalRole" class="o617-select">${this.optionList(ADDITIONAL_ROLE_OPTIONS,role||'')}</select></div>`;
  }

  publicHtml() {
    const v=this.context?.formData?.publicAssessment||{};
    return `<div class="o617-box"><div class="o617-label"><span>İlgili tüketici kesimi</span><span class="o617-req">zorunlu</span></div>${this.choice('opp61PublicType',PUBLIC_TYPE_OPTIONS,v.publicType||'','',true)}</div><div class="o617-box"><div class="o617-label"><span>Dikkat düzeyi</span><span class="o617-req">zorunlu</span></div>${this.choice('opp61Attention',ATTENTION_OPTIONS,v.attentionLevel||'','',true)}</div><div><div class="o617-label"><span>Tüketici / dikkat düzeyi notu</span><span class="o617-req">opsiyonel</span></div><textarea id="opp61PublicNote" class="o617-text" rows="3">${this.escape(v.note||'')}</textarea></div>`;
  }

  globalHtml() {
    const v=this.context?.formData?.globalAssessment||{};
    return `<div id="o617Review" class="o617-review"></div><div class="o617-box"><div class="o617-label"><span>Karıştırılma ihtimali sonucu</span><span class="o617-req">zorunlu</span></div>${this.choice('opp61GlobalConclusion',GLOBAL_OPTIONS,v.conclusion||'','',true)}</div><div class="o617-box"><div class="o617-label"><span>İlişkilendirilme ihtimali</span><span class="o617-req">zorunlu</span></div>${this.choice('opp61Association',ASSOCIATION_OPTIONS,v.associationLikelihood||'','',true)}</div><div class="o617-box"><div class="o617-label"><span>Avukatın dosyaya özgü kısa değerlendirmesi</span><span class="o617-req">yaklaşık 3–8 cümle</span></div><textarea id="opp61LawyerMerits" class="o617-text" rows="7" placeholder="Dosyada gerçekten kritik olan noktaları yazın. AI bu teşhisi değiştirmez.">${this.escape(v.lawyerMerits||'')}</textarea><div class="o617-meta">Bu alan Sol'un olgusal ve hukuki sınırını belirleyen temel avukat girdilerindendir.</div></div><div class="o617-save"><div class="o617-savehead"><div><div class="o617-ctitle">6/1 hukuki analiz kaydı</div><div class="o617-meta">Kaydetme sonrasında backend tüm alanları deterministik olarak yeniden denetler.</div></div><button id="opp61SaveBtn" type="button" class="o617-savebtn"><i class="fas fa-check-double mr-2"></i>Analizi Kaydet</button></div></div>`;
  }

  panel(no,title,help,body) {
    return `<section class="o617-panel" data-panel="${no}"><div class="o617-kick">Adım ${no} / 5</div><h5 class="o617-ptitle">${this.escape(title)}</h5><div class="o617-help">${this.escape(help)}</div>${body}<div class="o617-stepstatus" data-status="${no}"></div><div class="o617-nav"><button type="button" class="o617-btn" data-prev ${no===1?'disabled':''}><i class="fas fa-arrow-left mr-1"></i>Önceki</button>${no<5?'<button type="button" class="o617-btn pri" data-next>Sonraki<i class="fas fa-arrow-right ml-1"></i></button>':'<button type="button" class="o617-btn" data-goto="1">Baştan gözden geçir</button>'}</div></section>`;
  }

  render() {
    this.ensureStyles();
    if (!this.context?.enabled) {
      this.mount.innerHTML='<div class="o617"><div class="o617-card" style="padding:22px">SMK 6/1 gerekçesi artık seçili değil. Çalışma alanını kaydedip sayfayı yenileyin.</div></div>';
      return;
    }
    const rights=(this.context.priorRights||[]).length, classes=(this.context?.opponent?.goodsByClass||[]).length;
    this.mount.innerHTML=`<div class="o617"><div class="o617-card"><div class="o617-head"><div><div class="o617-eye">SMK 6/1 · GUIDED DECISION TREE</div><div class="o617-title">Karıştırılma İhtimali Hukuki Analizi</div><div class="o617-sub">Avukat hukuki teşhisi verir. Sistem yalnızca eksikleri kontrol eder ve kaydedilmiş teşhisi dilekçe motoruna aktarır. AI bu ekranda hukuki bulgu önermez.</div></div><div class="o617-ver"><i class="fas fa-route mr-1"></i>UX ${UX_PACKAGE_VERSION}</div></div>${this.readinessHtml()}${this.progressHtml()}<div class="o617-layout"><main class="o617-main">${this.panel(1,'Müstenit Hakların Uygunluğu',`${rights} seçili hak. Her seçili hakkın itiraza dayanak olmaya uygunluğunu teyit edin.`,this.priorRightsHtml())}${this.panel(2,'Mal / Hizmet Karşılaştırması ve Ret Kapsamı',`${classes} rakip sınıf. Benzerlik sonucunu uzman belirler; sistem yalnızca seçiminizi ve dayanak kriterlerini kaydeder.`,`<div class="o617-note"><i class="fas fa-info-circle"></i><div><strong>Uzman bulgusu esastır.</strong> “Orta”, “yüksek” veya başka bir benzerlik düzeyi AI tarafından belirlenmez.</div></div>${this.goodsHtml()}`)}${this.panel(3,'İşaretlerin Karşılaştırılması','Önce benzerlik sonuçlarını girin. Baskın unsur, ayırt edicilik ve ek unsur rolleri “İleri unsur analizi” altında tutulur.',this.signHtml())}${this.panel(4,'İlgili Tüketici ve Dikkat Düzeyi','İlgili tüketici kesimini ve temel dikkat düzeyini seçin. Gerekirse dosyaya özgü nüansı kısa notta açıklayın.',this.publicHtml())}${this.panel(5,'Bütüncül Değerlendirme ve Sonuç','Aşağıdaki özetten girdiğiniz hukuki bulguları kontrol edin; sonra global sonucu ve avukat değerlendirmesini kaydedin.',this.globalHtml())}</main><aside class="o617-side"><div class="o617-side-title">Canlı Hukuki Özet</div><div id="o617Summary"></div></aside></div></div></div>`;
    this.bindEvents();
    this.setStep(this.activeStep,false);
    this.updateState();
  }

  bindEvents() {
    this.mount.querySelectorAll('.o617-choicegrp').forEach(group=>{
      const select=group.querySelector('select');
      group.querySelectorAll('.o617-choice').forEach(btn=>btn.addEventListener('click',()=>{
        if(!select)return; select.value=btn.dataset.value||''; group.querySelectorAll('.o617-choice').forEach(x=>x.classList.toggle('sel',x===btn)); select.dispatchEvent(new Event('change',{bubbles:true}));
      }));
    });
    this.mount.querySelectorAll('.opp61-refusal-check').forEach(x=>x.addEventListener('change',e=>this.syncScope(e.target.closest('.opp61-goods-card'))));
    this.mount.querySelectorAll('.opp61-refusal-scope-mode').forEach(x=>x.addEventListener('change',e=>this.syncScope(e.target.closest('.opp61-goods-card'))));
    this.mount.querySelectorAll('.o617-tab').forEach(x=>x.addEventListener('click',()=>this.setStep(Number(x.dataset.step))));
    this.mount.querySelectorAll('[data-next]').forEach(x=>x.addEventListener('click',()=>this.setStep(Math.min(5,this.activeStep+1))));
    this.mount.querySelectorAll('[data-prev]').forEach(x=>x.addEventListener('click',()=>this.setStep(Math.max(1,this.activeStep-1))));
    this.mount.querySelectorAll('[data-goto]').forEach(x=>x.addEventListener('click',()=>this.setStep(Number(x.dataset.goto))));
    this.mount.querySelectorAll('input,select,textarea').forEach(el=>{
      const ev=(el.tagName==='TEXTAREA'||(el.tagName==='INPUT'&&el.type==='text'))?'input':'change';
      el.addEventListener(ev,()=>{this.dirty=true;this.updateState()});
    });
    this.mount.querySelector('#opp61SaveBtn')?.addEventListener('click',()=>this.save());
  }

  setStep(no,scroll=true) {
    this.activeStep=Math.max(1,Math.min(5,Number(no)||1));
    this.mount.querySelectorAll('.o617-panel').forEach(p=>p.classList.toggle('active',Number(p.dataset.panel)===this.activeStep));
    this.mount.querySelectorAll('.o617-tab').forEach(t=>t.classList.toggle('active',Number(t.dataset.step)===this.activeStep));
    this.updateState();
    if(scroll)this.mount.querySelector(`.o617-panel[data-panel="${this.activeStep}"]`)?.scrollIntoView({behavior:'smooth',block:'start'});
  }

  syncScope(card) {
    if(!card)return;
    const requested=card.querySelector('.opp61-refusal-check')?.checked===true, mode=card.querySelector('.opp61-refusal-scope-mode')?.value||'';
    card.querySelector('.opp61-refusal-scope')?.classList.toggle('d-none',!requested);
    card.querySelector('.opp61-partial-scope-box')?.classList.toggle('d-none',!requested||mode!=='partial');
    card.querySelector('.opp61-full-scope-note')?.classList.toggle('d-none',!requested||mode!=='full_class');
  }

  localStatus() {
    const st={};
    const rights=[...this.mount.querySelectorAll('.opp61-prior-review')], m1=[];
    if(!rights.length)m1.push('Seçili müstenit marka bulunmuyor.');
    rights.forEach(card=>{if(card.querySelector('.opp61-prior-confirm')?.checked!==true){const r=(this.context?.priorRights||[]).find(x=>String(x.id)===String(card.dataset.priorId));m1.push(`${r?.markText||r?.applicationNo||'Müstenit hak'} uygunluğu teyit edilmedi.`)}});
    st[1]={complete:!m1.length,missing:m1};

    const cards=[...this.mount.querySelectorAll('.opp61-goods-card')], m2=[];
    if(!cards.length)m2.push('Rakip mal/hizmet kapsamı bulunamadı.');
    cards.forEach(card=>{const no=card.dataset.opponentClass,sim=card.querySelector('.opp61-similarity-select')?.value||'';if(!sim){m2.push(`Sınıf ${no}: benzerlik derecesi seçilmedi.`);return}if(sim!=='none'){if(!card.querySelectorAll('.opp61-prior-class-check:checked').length)m2.push(`Sınıf ${no}: dayanılan müstenit sınıf seçilmedi.`);if(!card.querySelectorAll('.opp61-criteria-check:checked').length)m2.push(`Sınıf ${no}: benzerlik kriteri seçilmedi.`)}if(card.querySelector('.opp61-refusal-check')?.checked){const mode=card.querySelector('.opp61-refusal-scope-mode')?.value||'';if(!mode)m2.push(`Sınıf ${no}: ret kapsamı seçilmedi.`);if(mode==='partial'&&!String(card.querySelector('.opp61-refusal-scope-text')?.value||'').trim())m2.push(`Sınıf ${no}: kısmi ret metni girilmedi.`)}});
    st[2]={complete:!m2.length,missing:m2};

    const m3=[];
    [['opp61CommonElements','Ortak unsur(lar)'],['opp61Differences','Farklı unsur(lar)'],['opp61ClientDominant','Müstenit markanın baskın/ayırt edici unsuru'],['opp61OpponentDominant','Rakip markanın baskın/ayırt edici unsuru'],['opp61ClientAdditionalElements','Müstenit markanın ek unsurları'],['opp61OpponentAdditionalElements','Rakip markanın ek unsurları']].forEach(([id,l])=>{if(!this.value(id))m3.push(`${l} girilmedi.`)});
    [['opp61Distinctiveness','Ortak unsurun ayırt ediciliği'],['opp61IndependentRole','Bağımsız ayırt edici rol'],['opp61ClientAdditionalDistinctiveness','Müstenit ek unsur ayırt ediciliği'],['opp61ClientAdditionalRole','Müstenit ek unsur rolü'],['opp61OpponentAdditionalDistinctiveness','Rakip ek unsur ayırt ediciliği'],['opp61OpponentAdditionalRole','Rakip ek unsur rolü'],['opp61Visual','Görsel benzerlik'],['opp61Aural','İşitsel benzerlik'],['opp61Conceptual','Kavramsal benzerlik'],['opp61Overall','Genel izlenim benzerliği']].forEach(([id,l])=>{if(!this.value(id))m3.push(`${l} seçilmedi.`)});
    st[3]={complete:!m3.length,missing:m3};

    const m4=[];if(!this.value('opp61PublicType'))m4.push('İlgili tüketici kesimi seçilmedi.');if(!this.value('opp61Attention'))m4.push('Dikkat düzeyi seçilmedi.');st[4]={complete:!m4.length,missing:m4};
    const m5=[],con=this.value('opp61GlobalConclusion'),ass=this.value('opp61Association'),mer=this.value('opp61LawyerMerits'),ref=this.mount.querySelectorAll('.opp61-refusal-check:checked').length;
    if(!con)m5.push('Karıştırılma ihtimali sonucu seçilmedi.');if(!ass)m5.push('İlişkilendirilme ihtimali sonucu seçilmedi.');if(mer.length<30)m5.push('Dosyaya özgü avukat değerlendirmesi çok kısa veya boş.');if(['exists','borderline'].includes(con)&&!ref)m5.push('Karıştırılma ihtimali sonucuna rağmen ret kapsamı yok.');if(con==='does_not_exist'&&ref)m5.push('Karıştırılma ihtimali yok sonucu ile ret talebi uyumsuz.');st[5]={complete:!m5.length,missing:m5};
    return st;
  }

  summaryData() {
    const rights=this.context?.priorRights||[];
    const prior=[...this.mount.querySelectorAll('.opp61-prior-review')].map(card=>{const r=rights.find(x=>String(x.id)===String(card.dataset.priorId));return{name:r?.markText||r?.applicationNo||'Müstenit hak',app:r?.applicationNo||'',confirmed:card.querySelector('.opp61-prior-confirm')?.checked===true}});
    const goods=[...this.mount.querySelectorAll('.opp61-goods-card')].map(card=>({classNo:card.dataset.opponentClass,similarity:card.querySelector('.opp61-similarity-select')?.value||'',refusal:card.querySelector('.opp61-refusal-check')?.checked===true,scope:card.querySelector('.opp61-refusal-scope-mode')?.value||''}));
    return {prior,goods,sign:{common:this.value('opp61CommonElements'),visual:this.value('opp61Visual'),aural:this.value('opp61Aural'),conceptual:this.value('opp61Conceptual'),overall:this.value('opp61Overall')},pub:{type:this.value('opp61PublicType'),attention:this.value('opp61Attention')},global:{con:this.value('opp61GlobalConclusion'),ass:this.value('opp61Association')}};
  }

  updateState() {
    const st=this.localStatus(), done=STEPS.filter(([n])=>st[n]?.complete).length,pct=Math.round(done/5*100);
    const bar=this.mount.querySelector('#o617Bar'),pt=this.mount.querySelector('#o617Pct');if(bar)bar.style.width=`${pct}%`;if(pt)pt.textContent=`%${pct} tamamlandı`;
    this.mount.querySelectorAll('.o617-tab').forEach(tab=>{const n=Number(tab.dataset.step),ok=st[n]?.complete===true;tab.classList.toggle('done',ok);const num=tab.querySelector('.o617-num'),small=tab.querySelector('small');if(num)num.innerHTML=ok?'<i class="fas fa-check"></i>':String(n);if(small)small.textContent=ok?'Tamam':`${st[n]?.missing?.length||0} eksik`});
    STEPS.forEach(([n])=>{const el=this.mount.querySelector(`[data-status="${n}"]`),x=st[n];if(!el)return;el.className=`o617-stepstatus ${x.complete?'ok':'bad'}`;el.innerHTML=x.complete?'<i class="fas fa-check-circle mr-1"></i>Bu adımın zorunlu alanları tamamlandı.':`<strong>${x.missing.length} zorunlu nokta eksik.</strong>${x.missing.length?`<ul>${x.missing.slice(0,6).map(a=>`<li>${this.escape(a)}</li>`).join('')}${x.missing.length>6?`<li>+ ${x.missing.length-6} diğer eksik</li>`:''}</ul>`:''}`});
    const advIds=['opp61Distinctiveness','opp61IndependentRole','opp61ClientDominant','opp61OpponentDominant','opp61ClientAdditionalElements','opp61ClientAdditionalDistinctiveness','opp61ClientAdditionalRole','opp61OpponentAdditionalElements','opp61OpponentAdditionalDistinctiveness','opp61OpponentAdditionalRole'], miss=advIds.filter(id=>!this.value(id)).length,adv=this.mount.querySelector('#o617Adv'),ab=this.mount.querySelector('#o617AdvBadge');adv?.classList.toggle('done',miss===0);if(ab)ab.textContent=miss===0?'tamamlandı':`${miss} zorunlu alan eksik`;
    this.mount.querySelector('#o617Dirty')?.classList.toggle('on',this.dirty);
    this.updateSummary(st);this.updateReview(st);
  }

  updateSummary(st) {
    const t=this.mount.querySelector('#o617Summary');if(!t)return;const d=this.summaryData(),conf=d.prior.filter(x=>x.confirmed).length,refs=d.goods.filter(x=>x.refusal),all=STEPS.every(([n])=>st[n]?.complete);
    t.innerHTML=`<div class="o617-sgroup"><div class="o617-slabel">Müstenit haklar</div><div class="o617-svalue">${conf} / ${d.prior.length} hak teyit edildi</div>${d.prior.slice(0,3).map(x=>`<div class="o617-sline"><span>${this.escape(x.name)}</span><strong>${x.confirmed?'✓':'—'}</strong></div>`).join('')}</div><div class="o617-sgroup"><div class="o617-slabel">Mal / hizmet</div>${d.goods.map(x=>`<div class="o617-sline"><span>Sınıf ${this.escape(x.classNo)}</span><strong>${this.escape(this.label(GOODS_SIMILARITY_OPTIONS,x.similarity,'—'))}</strong></div>`).join('')}<div class="o617-meta">Ret: ${refs.length?refs.map(x=>`Sınıf ${x.classNo}${x.scope==='full_class'?' tamamı':x.scope==='partial'?' kısmi':''}`).join(' · '):'seçilmedi'}</div></div><div class="o617-sgroup"><div class="o617-slabel">İşaretler</div><div class="o617-sline"><span>Ortak unsur</span><strong>${this.escape(d.sign.common||'—')}</strong></div><div class="o617-sline"><span>Görsel</span><strong>${this.escape(this.label(SIGN_SIMILARITY_OPTIONS,d.sign.visual,'—'))}</strong></div><div class="o617-sline"><span>İşitsel</span><strong>${this.escape(this.label(SIGN_SIMILARITY_OPTIONS,d.sign.aural,'—'))}</strong></div><div class="o617-sline"><span>Kavramsal</span><strong>${this.escape(this.label(SIGN_SIMILARITY_OPTIONS,d.sign.conceptual,'—'))}</strong></div><div class="o617-sline"><span>Genel</span><strong>${this.escape(this.label(SIGN_SIMILARITY_OPTIONS,d.sign.overall,'—'))}</strong></div></div><div class="o617-sgroup"><div class="o617-slabel">Tüketici</div><div class="o617-svalue">${this.escape(this.label(PUBLIC_TYPE_OPTIONS,d.pub.type))}</div><div class="o617-meta">Dikkat: ${this.escape(this.label(ATTENTION_OPTIONS,d.pub.attention,'seçilmedi'))}</div></div><div class="o617-sgroup"><div class="o617-slabel">Sonuç</div><div class="o617-svalue">${this.escape(this.label(GLOBAL_OPTIONS,d.global.con))}</div><div class="o617-meta">İlişkilendirme: ${this.escape(this.label(ASSOCIATION_OPTIONS,d.global.ass,'seçilmedi'))}</div></div><div class="o617-ready ${all?'ok':''}">${all?'<i class="fas fa-check-circle mr-1"></i>Zorunlu alanlar yerel kontrolde tamam. Kaydettiğinizde backend kesin denetimi yapacak.':'<i class="fas fa-info-circle mr-1"></i>Bu özet kaydedilmemiş form girdilerini de gösterir.'}</div>`;
  }

  updateReview(st) {
    const t=this.mount.querySelector('#o617Review');if(!t)return;const d=this.summaryData(),rights=d.prior.filter(x=>x.confirmed).map(x=>`${x.name}${x.app?` · ${x.app}`:''}`),goods=d.goods.map(x=>`Sınıf ${x.classNo}: ${this.label(GOODS_SIMILARITY_OPTIONS,x.similarity,'seçilmedi')}`).join(' · '),sign=`Görsel: ${this.label(SIGN_SIMILARITY_OPTIONS,d.sign.visual,'—')} · İşitsel: ${this.label(SIGN_SIMILARITY_OPTIONS,d.sign.aural,'—')} · Kavramsal: ${this.label(SIGN_SIMILARITY_OPTIONS,d.sign.conceptual,'—')} · Genel: ${this.label(SIGN_SIMILARITY_OPTIONS,d.sign.overall,'—')}`,pub=`${this.label(PUBLIC_TYPE_OPTIONS,d.pub.type)} · Dikkat: ${this.label(ATTENTION_OPTIONS,d.pub.attention,'seçilmedi')}`,ref=d.goods.filter(x=>x.refusal).map(x=>`Sınıf ${x.classNo}${x.scope==='full_class'?' — tamamı':x.scope==='partial'?' — kısmi':''}`),done=STEPS.filter(([n])=>st[n]?.complete).length;
    t.innerHTML=[[ 'Müstenit haklar',rights.length?rights.join(' · '):'Henüz teyit edilmiş hak yok'],['Mal / hizmet',goods||'Değerlendirme yok'],['İşaretler',sign],['Tüketici',pub],['Ret kapsamı',ref.length?ref.join(' · '):'Ret kapsamı seçilmedi'],['Analiz tamamlama',`${done} / 5 adım tamamlandı`]].map(([l,v])=>`<div class="o617-rc"><div class="o617-rl">${l}</div><div class="o617-rv">${this.escape(v)}</div></div>`).join('');
  }

  collectPayload() {
    const priorRightsReview=[...this.mount.querySelectorAll('.opp61-prior-review')].map(card=>({ipRecordId:card.dataset.priorId,confirmedEligible:card.querySelector('.opp61-prior-confirm')?.checked===true,note:card.querySelector('.opp61-prior-note')?.value||''}));
    const goodsAssessments=[...this.mount.querySelectorAll('.opp61-goods-card')].map(card=>({opponentClassNo:Number(card.dataset.opponentClass),similarityLevel:card.querySelector('.opp61-similarity-select')?.value||'not_assessed',matchedPriorClasses:[...card.querySelectorAll('.opp61-prior-class-check:checked')].map(el=>el.value),criteria:[...card.querySelectorAll('.opp61-criteria-check:checked')].map(el=>el.value),requestedRefusal:card.querySelector('.opp61-refusal-check')?.checked===true,refusalScopeMode:card.querySelector('.opp61-refusal-scope-mode')?.value||'',refusalScopeText:card.querySelector('.opp61-refusal-scope-text')?.value||'',note:card.querySelector('.opp61-goods-note')?.value||''}));
    return {priorRightsReview,goodsAssessments,signAssessment:{commonElements:this.value('opp61CommonElements'),differences:this.value('opp61Differences'),commonElementDistinctiveness:this.value('opp61Distinctiveness'),clientDominantElements:this.value('opp61ClientDominant'),opponentDominantElements:this.value('opp61OpponentDominant'),clientAdditionalElements:this.value('opp61ClientAdditionalElements'),clientAdditionalDistinctiveness:this.value('opp61ClientAdditionalDistinctiveness'),clientAdditionalRole:this.value('opp61ClientAdditionalRole'),opponentAdditionalElements:this.value('opp61OpponentAdditionalElements'),opponentAdditionalDistinctiveness:this.value('opp61OpponentAdditionalDistinctiveness'),opponentAdditionalRole:this.value('opp61OpponentAdditionalRole'),independentDistinctiveRole:this.value('opp61IndependentRole'),visualSimilarity:this.value('opp61Visual'),auralSimilarity:this.value('opp61Aural'),conceptualSimilarity:this.value('opp61Conceptual'),overallSimilarity:this.value('opp61Overall'),note:this.value('opp61SignNote')},publicAssessment:{publicType:this.value('opp61PublicType'),attentionLevel:this.value('opp61Attention'),note:this.value('opp61PublicNote')},globalAssessment:{conclusion:this.value('opp61GlobalConclusion'),associationLikelihood:this.value('opp61Association'),lawyerMerits:this.value('opp61LawyerMerits')}};
  }

  stepForBlocker(message) {
    const t=String(message||'').toLocaleLowerCase('tr-TR');
    if(t.includes('müstenit hak')||t.includes('seçili müstenit marka'))return 1;
    if(t.includes('rakip sınıf')||t.includes('mal/hizmet')||t.includes('ret kapsam'))return 2;
    if(t.includes('ortak unsur')||t.includes('baskın')||t.includes('ayırt edici')||t.includes('işaret')||t.includes('görsel')||t.includes('işitsel')||t.includes('kavramsal'))return 3;
    if(t.includes('tüketici')||t.includes('dikkat düzeyi'))return 4;
    return 5;
  }

  async save() {
    const button=this.mount.querySelector('#opp61SaveBtn'), payload=this.collectPayload();
    if(button){button.disabled=true;button.innerHTML='<i class="fas fa-spinner fa-spin mr-2"></i>Analiz kontrol ediliyor...'}
    try {
      this.context=await this.invoke('save',payload);this.dirty=false;const r=this.context?.readiness||{};this.activeStep=r.canDraft?5:this.stepForBlocker(r.blockers?.[0]||'');this.render();window.dispatchEvent(new CustomEvent('opposition-analysis-saved',{detail:{taskId:this.taskId}}));
      if(r.canDraft)showNotification('SMK 6/1 analizi tamamlandı. Dosya dilekçe üretimine hazır.','success');else showNotification(`SMK 6/1 analizi kaydedildi; ${r.blockers?.length||0} eksik/hata kaldı.`,'warning');
    } catch(error) {
      console.error('SMK 6/1 analiz kayıt hatası:',error);showNotification('6/1 analiz kayıt hatası: '+error.message,'error');if(button){button.disabled=false;button.innerHTML='<i class="fas fa-check-double mr-2"></i>Analizi Kaydet'}
    }
  }
}
