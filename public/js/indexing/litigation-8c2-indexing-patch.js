// public/js/indexing/litigation-8c2-indexing-patch.js
// AŞAMA 8C-2: DB-driven litigation stage/decision indexing patch.
// Stage yalnız 92/95 karşı taraf dilekçesi ile indekslemede veya 93/96 task completion DB trigger'ı ile açılır.

import './litigation-indexing-write.js';
import { DocumentReviewManager } from './document-review-manager.js';
import { supabase } from '../../supabase-config.js';
import { showNotification, STATUSES } from '../../utils.js';

const proto = DocumentReviewManager.prototype;
const FIRST_INSTANCE_PARENT_TYPES = new Set(['49','54','55','56','57','58']);
const STAGE_TYPES = Object.freeze({ appeal: '59', cassation: '60' });
const STAGE_LABELS = Object.freeze({ first_instance:'İlk Derece', appeal:'İstinaf', cassation:'Yargıtay' });

function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
function toIsoDate(raw){
  if(!raw)return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) return new Date(`${raw}T12:00:00`).toISOString();
  const p=String(raw).split(/[./]/);
  if(p.length===3&&p[2]?.length===4){const [d,m,y]=p;return new Date(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T12:00:00`).toISOString();}
  const dt=new Date(raw);return Number.isNaN(dt.getTime())?null:dt.toISOString();
}
function typeObject(m,id){return (m.allTransactionTypes||[]).find(x=>String(x.id)===String(id))||null;}
function typeName(m,id){const x=typeObject(m,id);return x?.alias||x?.name||`İşlem ${id}`;}
function isSuitTypeObject(x){if(!x)return false;const t=String(x.ip_type||x.ipType||'').toLowerCase().trim();return !t||t==='suit';}
function parseJsonObject(raw){
  if(!raw)return {};
  if(typeof raw==='object'&&!Array.isArray(raw))return raw;
  if(typeof raw==='string'){try{const p=JSON.parse(raw);return p&&typeof p==='object'&&!Array.isArray(p)?p:{};}catch{return {};}}
  return {};
}
function normalizeStringArray(raw){
  if(!raw)return [];
  if(Array.isArray(raw))return raw.map(String).filter(Boolean);
  if(typeof raw==='string'){
    try{const p=JSON.parse(raw);if(Array.isArray(p))return p.map(String).filter(Boolean);}catch{
      return raw.replace(/[{}]/g,'').split(',').map(x=>x.replace(/^"+|"+$/g,'').trim()).filter(Boolean);
    }
  }
  return [];
}
function suitEventKind(x){return String(x?.suit_event_kind||x?.suitEventKind||'').toLowerCase().trim();}
function suitStageScopes(x){return normalizeStringArray(x?.suit_stage_scope??x?.suitStageScope);}
function stageTransitionOnIndex(x){const v=String(x?.stage_transition_on_index||x?.stageTransitionOnIndex||'').toLowerCase().trim();return ['appeal','cassation'].includes(v)?v:null;}
function isParentTransaction(tx){return String(tx?.transaction_hierarchy||'parent').toLowerCase()==='parent';}
function stageKeyFromParentType(id){id=String(id||'');if(id==='60')return'cassation';if(id==='59')return'appeal';if(FIRST_INSTANCE_PARENT_TYPES.has(id))return'first_instance';return null;}
function stageRankFromParentType(id){const k=stageKeyFromParentType(id);return k==='cassation'?3:k==='appeal'?2:k==='first_instance'?1:0;}
function stageLabel(k){return STAGE_LABELS[k]||'Bilinmeyen Aşama';}
function supportedStageParents(rows){return (rows||[]).filter(tx=>isParentTransaction(tx)&&stageRankFromParentType(tx.transaction_type_id)>0);}
function findHighestStageParent(rows){const a=supportedStageParents(rows);if(!a.length)return null;return [...a].sort((x,y)=>{const r=stageRankFromParentType(y.transaction_type_id)-stageRankFromParentType(x.transaction_type_id);if(r)return r;return new Date(y.transaction_date||y.created_at||0)-new Date(x.transaction_date||x.created_at||0);})[0];}
function findDirectStageChild(rows,parentId,targetType){return (rows||[]).find(tx=>isParentTransaction(tx)&&String(tx.parent_id||'')===String(parentId||'')&&String(tx.transaction_type_id||'')===String(targetType||''))||null;}
function transitionPreviousStage(target){return target==='appeal'?'first_instance':target==='cassation'?'appeal':null;}
function transitionTargetType(target){return STAGE_TYPES[target]||null;}
function mergeInitiator(a,b){a=String(a||'').toLowerCase().trim();b=String(b||'').toLowerCase().trim();if(!a||a==='unknown')return b||'unknown';if(!b||b==='unknown')return a;if(a===b)return a;if(['client','opponent','both'].includes(a)&&['client','opponent','both'].includes(b))return'both';return a;}
function initiatorLabel(v){v=String(v||'').toLowerCase().trim();return v==='client'?'Müvekkil':v==='opponent'?'Karşı Taraf':v==='both'?'Her İki Taraf':'Belirtilmemiş';}
function decisionResultLabel(v){return ({accept:'Kabul',partial_accept:'Kısmen Kabul',reject:'Ret'})[v]||v||'-';}
function clientOutcomeLabel(v){return ({favorable:'Lehe',partially_favorable:'Kısmen Lehe / Kısmen Aleyhe',unfavorable:'Aleyhe'})[v]||v||'-';}
function normRole(v){return String(v||'').toLocaleLowerCase('tr-TR').trim();}
function mapFirstInstanceClientOutcome(role,result){role=normRole(role);result=String(result||'');if(result==='partial_accept')return'partially_favorable';if(role==='davaci'){if(result==='accept')return'favorable';if(result==='reject')return'unfavorable';}if(role==='davali'){if(result==='accept')return'unfavorable';if(result==='reject')return'favorable';}return null;}
function litigationStatusLabel(v){v=String(v||'').trim();if(!v)return'Belirtilmemiş';return (STATUSES?.litigation||[]).find(x=>String(x.value)===v)?.text||v;}
function isValidLitigationStatus(v){v=String(v||'').trim();return !v||(STATUSES?.litigation||[]).some(x=>String(x.value)===v);}

function canUseIncomingType(manager,typeObj,parentTx,rows){
  if(!typeObj||!parentTx||!isSuitTypeObject(typeObj))return false;
  const hierarchy=String(typeObj.hierarchy||'').toLowerCase().trim();if(hierarchy&&hierarchy!=='child')return false;
  const kind=suitEventKind(typeObj);if(!['incoming','decision'].includes(kind))return false;
  const currentStage=stageKeyFromParentType(parentTx.transaction_type_id);if(!currentStage)return false;
  const scopes=suitStageScopes(typeObj);const transition=stageTransitionOnIndex(typeObj);
  if(!transition)return scopes.includes(currentStage);
  if(currentStage===transition)return scopes.includes(currentStage);
  const previous=transitionPreviousStage(transition);if(currentStage!==previous)return false;
  return !findDirectStageChild(rows,parentTx.id,transitionTargetType(transition));
}

function ensurePatchStyles(){
  if(document.getElementById('litigation8C2Styles'))return;
  const s=document.createElement('style');s.id='litigation8C2Styles';s.textContent=`
  #litigationDecisionControl{border:1px solid #d8dee9;background:#fffdf7;border-radius:10px;padding:12px 14px;margin-bottom:1rem}
  #litigationDecisionControl .lit-decision-result{margin-top:7px;font-size:.75rem;color:#475467}
  #litigationDecisionControl .lit-decision-warning{margin-top:8px;padding:7px 9px;border:1px solid #f2dc8d;border-radius:7px;background:#fff8e1;color:#7c5d12;font-size:.72rem}
  #litigationStageControl .litigation-stage-transition-note{margin-top:8px;padding:7px 9px;border:1px solid #bfdbfe;border-radius:7px;background:#eff6ff;color:#1e40af;font-size:.72rem}`;
  document.head.appendChild(s);
}

if(!proto.__litigationStage8C2Patched){
  Object.defineProperty(proto,'__litigationStage8C2Patched',{value:true,writable:false,configurable:false,enumerable:false});
  ensurePatchStyles();
  const baseEnableSuitUi=proto._enableSuitIndexingWriteUi;

  // HOTFIX: suits.status indeksleme ekranında yönetilmez.
  // Status değerleri yalnız dava kayıt/güncelleme ekranında kullanılacaktır.
  proto._ensureLitigationStatusControl=function(){
    document.getElementById('litigationStatusControl')?.remove();
  };

  const baseLoadParents=proto.loadSuitParentTransactionsReadOnly;

  proto._enableSuitIndexingWriteUi=function(...args){
    const r=baseEnableSuitUi?.apply(this,args);
    document.getElementById('litigationStatusControl')?.remove();
    const child=document.getElementById('detectedType');
    if(child&&!child.dataset.litigation8c2DecisionBound){
      child.dataset.litigation8c2DecisionBound='true';
      child.addEventListener('change',()=>this._renderLitigationDecisionControl());
    }
    this._renderLitigationDecisionControl();return r;
  };

  proto._refreshLitigationStageControl=function(){
    const w=document.getElementById('litigationStageControl');const p=document.getElementById('parentTransactionSelect');if(!w||!p)return;
    const parent=(this.currentTransactions||[]).find(tx=>String(tx.id)===String(p.value||''))||null;
    const highest=findHighestStageParent(this.currentTransactions);
    const highKey=highest?stageKeyFromParentType(highest.transaction_type_id):null;
    const selectedKey=parent?stageKeyFromParentType(parent.transaction_type_id):null;
    const initiator=parent?.suit_context?.stage_initiator||null;
    w.innerHTML=`<label class="custom-label"><i class="fas fa-sitemap mr-1"></i>Yargılama Aşaması</label>
      <div class="litigation-stage-current"><strong>Dosyanın en üst aşaması:</strong> ${esc(stageLabel(highKey))}${selectedKey?` · <strong>Seçili parent:</strong> ${esc(stageLabel(selectedKey))}`:''}${initiator?` · <strong>Başlatan:</strong> ${esc(initiatorLabel(initiator))}`:''}</div>
      <div class="litigation-stage-transition-note"><i class="fas fa-shield-alt mr-1"></i>Aşama manuel olarak değiştirilmez. Karşı tarafın İstinaf/Temyiz dilekçesi indekslenirse veya EVREKA'nın kanun yolu işi tamamlanırsa yeni stage oluşturulur.</div>`;
  };

  proto.loadSuitParentTransactionsReadOnly=async function(suitId){
    await baseLoadParents.call(this,suitId);
    const {data,error}=await supabase.from('transactions').select('id, suit_context').eq('ip_record_id',String(suitId));
    if(!error){const m=new Map((data||[]).map(r=>[String(r.id),parseJsonObject(r.suit_context)]));this.currentTransactions=(this.currentTransactions||[]).map(tx=>({...tx,suit_context:m.get(String(tx.id))||parseJsonObject(tx.suit_context)}));}
    this._refreshLitigationStageControl();this.updateChildTransactionOptions();
  };

  proto.updateChildTransactionOptions=function(){
    if(this.matchedEntityType!=='suit')return;
    const p=document.getElementById('parentTransactionSelect');const c=document.getElementById('detectedType');if(!p||!c)return;
    const parent=(this.currentTransactions||[]).find(tx=>String(tx.id)===String(p.value||''))||null;
    if(!parent){c.disabled=true;c.innerHTML='<option value="">-- Önce Ana İşlem Seçiniz --</option>';this._refreshLitigationStageControl();this._renderLitigationDecisionControl();return;}
    const stage=stageKeyFromParentType(parent.transaction_type_id);
    const allowed=(this.allTransactionTypes||[]).filter(t=>canUseIncomingType(this,t,parent,this.currentTransactions)).sort((a,b)=>Number(a.order_index??0)-Number(b.order_index??0)||String(a.alias||a.name||'').localeCompare(String(b.alias||b.name||''),'tr'));
    c.innerHTML='<option value="">-- Gelen Evrak Türünü Seçiniz --</option>';
    for(const t of allowed){const o=document.createElement('option');o.value=String(t.id);const tr=stageTransitionOnIndex(t);const suffix=tr&&tr!==stage?` → ${stageLabel(tr)} aşamasını açar`:'';o.textContent=`${t.alias||t.name||`İşlem ${t.id}`}${suffix}`;c.appendChild(o);}
    c.disabled=allowed.length===0;this._refreshLitigationStageControl();this._renderLitigationDecisionControl();
    const d=document.getElementById('calculatedDeadlineDisplay');if(d)d.value=`Yargılama aşaması: ${stageLabel(stage)}`;
  };

  proto._renderLitigationDecisionControl=function(){
    let w=document.getElementById('litigationDecisionControl');const child=document.getElementById('detectedType');if(!child)return;
    const id=String(child.value||'');const t=typeObject(this,id);if(!t||suitEventKind(t)!=='decision'){w?.remove();return;}
    if(!w){w=document.createElement('div');w.id='litigationDecisionControl';const s=document.getElementById('litigationStatusControl');if(s)s.insertAdjacentElement('beforebegin',w);else child.closest('.form-group')?.insertAdjacentElement('afterend',w);}
    const cfg=parseJsonObject(t.suit_decision_config??t.suitDecisionConfig);
    const pid=document.getElementById('parentTransactionSelect')?.value||'';const parent=(this.currentTransactions||[]).find(tx=>String(tx.id)===String(pid))||null;
    const stage=parent?stageKeyFromParentType(parent.transaction_type_id):null;const initiator=parent?.suit_context?.stage_initiator||null;
    if(String(cfg.mode)==='role_mapped_first_instance'){
      const role=normRole(this.matchedSuit?.client_role || this.matchedSuit?.clientRole);const known=['davaci','davali'].includes(role);
      w.innerHTML=`<label class="custom-label"><i class="fas fa-balance-scale mr-1"></i>Karar Sonucu</label>
        <select id="litigationDecisionResultSelect" class="form-control shadow-sm"><option value="">-- Karar Sonucunu Seçiniz --</option><option value="accept">Kabul</option><option value="partial_accept">Kısmen Kabul</option><option value="reject">Ret</option></select>
        ${known?`<div class="lit-decision-result"><strong>Müvekkil rolü:</strong> ${role==='davaci'?'Davacı':'Davalı'} · <strong>Müvekkil açısından:</strong> <span id="litigationComputedClientOutcome">-</span></div>`:`<div class="lit-decision-result">Müvekkil rolü çözülemedi. Sonucu ayrıca müvekkil açısından seçin:</div><select id="litigationDecisionClientOutcomeFallbackSelect" class="form-control shadow-sm mt-2"><option value="">-- Müvekkil Açısından Sonuç --</option><option value="favorable">Lehe</option><option value="partially_favorable">Kısmen Lehe / Kısmen Aleyhe</option><option value="unfavorable">Aleyhe</option></select>`}
        <div class="lit-decision-warning">Karar sonucu kullanıcı tarafından set edilir. Sistem evrak metninden karar yönü tahmin etmez.</div>`;
      const ds=document.getElementById('litigationDecisionResultSelect');if(ds&&known)ds.onchange=()=>{const o=mapFirstInstanceClientOutcome(role,ds.value);const e=document.getElementById('litigationComputedClientOutcome');if(e)e.textContent=clientOutcomeLabel(o);this.updateCalculatedDeadline();};
      document.getElementById('litigationDecisionClientOutcomeFallbackSelect')?.addEventListener('change',()=>this.updateCalculatedDeadline());return;
    }
    w.innerHTML=`<label class="custom-label"><i class="fas fa-balance-scale mr-1"></i>Kararın Müvekkil Açısından Sonucu</label>
      <select id="litigationClientOutcomeSelect" class="form-control shadow-sm"><option value="">-- Sonucu Seçiniz --</option><option value="favorable">Lehe</option><option value="partially_favorable">Kısmen Lehe / Kısmen Aleyhe</option><option value="unfavorable">Aleyhe</option></select>
      <div class="lit-decision-result"><strong>Aşama:</strong> ${esc(stageLabel(stage))} · <strong>Aşamayı başlatan:</strong> ${esc(initiatorLabel(initiator))}</div>
      <div class="lit-decision-warning">Sonuç müvekkil açısından kullanıcı tarafından set edilir. Sistem ilam metninden otomatik sonuç çıkarmaz.</div>`;
    document.getElementById('litigationClientOutcomeSelect')?.addEventListener('change',()=>this.updateCalculatedDeadline());
  };

  proto._getLitigationDecisionContextFromUi=function(childTypeId,parentTx){
    const t=typeObject(this,childTypeId);const stage=parentTx?stageKeyFromParentType(parentTx.transaction_type_id):null;const base={valid:true,stage,decisionResult:null,clientOutcome:null,stageInitiator:parentTx?.suit_context?.stage_initiator||null};
    if(suitEventKind(t)!=='decision')return base;
    const cfg=parseJsonObject(t?.suit_decision_config??t?.suitDecisionConfig);
    if(String(cfg.mode)==='role_mapped_first_instance'){
      const result=document.getElementById('litigationDecisionResultSelect')?.value||'';if(!result)return{...base,valid:false,error:'Karar sonucunu seçin.'};
      const role=normRole(this.matchedSuit?.client_role || this.matchedSuit?.clientRole);let outcome=mapFirstInstanceClientOutcome(role,result);if(!outcome)outcome=document.getElementById('litigationDecisionClientOutcomeFallbackSelect')?.value||'';
      if(!outcome)return{...base,valid:false,error:'Kararın müvekkil açısından sonucunu seçin.'};return{...base,decisionResult:result,clientOutcome:outcome};
    }
    const outcome=document.getElementById('litigationClientOutcomeSelect')?.value||'';if(!outcome)return{...base,valid:false,error:'Kararın müvekkil açısından sonucunu seçin.'};return{...base,clientOutcome:outcome};
  };

  proto._handleLitigationIndexingSave=async function(){
    const suit=this.matchedSuit;const suitId=suit?.id?String(suit.id):null;const parentTxId=document.getElementById('parentTransactionSelect')?.value||'';const childTypeId=document.getElementById('detectedType')?.value||'';const deliveryRaw=document.getElementById('detectedDate')?.value||'';const notes=document.getElementById('transactionNotes')?.value?.trim()||'';const selectedSuitStatus=document.getElementById('litigationStatusSelect')?.value||'';const previousSuitStatus=suit?.status||null;
    if(selectedSuitStatus&&!isValidLitigationStatus(selectedSuitStatus)){showNotification('Seçilen dava durumu geçerli değil.','error');return;}
    if(!suitId){showNotification('Dava kaydı bulunamadı.','error');return;}
    if(!parentTxId||!childTypeId||!deliveryRaw){showNotification('Lütfen dava ana işlemini, gelen evrak türünü ve tebliğ tarihini seçin.','error');return;}
    const deliveryIso=toIsoDate(deliveryRaw);if(!deliveryIso){showNotification('Tebliğ tarihi geçerli değil.','error');return;}
    const parent=(this.currentTransactions||[]).find(tx=>String(tx.id)===String(parentTxId));if(!parent){showNotification('Seçilen dava ana işlemi bulunamadı.','error');return;}
    if(parent.ip_record_id&&String(parent.ip_record_id)!==suitId){showNotification('Güvenlik kontrolü başarısız: Ana işlem başka bir kayda bağlı.','error');return;}
    const childType=typeObject(this,childTypeId);if(!canUseIncomingType(this,childType,parent,this.currentTransactions)){showNotification('Seçilen evrak türü mevcut yargılama aşamasında kullanılamaz.','error');return;}
    const currentStage=stageKeyFromParentType(parent.transaction_type_id);const transition=stageTransitionOnIndex(childType);let newStageTypeId=null;let effectiveStage=currentStage;let effectiveParentTxId=String(parentTxId);let stageParentContext=parseJsonObject(parent.suit_context);
    if(transition){const previous=transitionPreviousStage(transition);if(currentStage===previous){const target=transitionTargetType(transition);if(findDirectStageChild(this.currentTransactions,parent.id,target)){showNotification(`${stageLabel(transition)} aşaması zaten mevcut. Lütfen aktif aşamayı seçerek devam edin.`,'warning');return;}newStageTypeId=target;effectiveStage=transition;}else if(currentStage===transition){effectiveStage=currentStage;}else{showNotification(`Bu evrak ${stageLabel(transition)} aşamasını başlatamaz; seçili parent ${stageLabel(currentStage)} aşamasındadır.`,'error');return;}}
    const decision=this._getLitigationDecisionContextFromUi(childTypeId,parent);if(!decision.valid){showNotification(decision.error||'Karar sonucu eksik.','warning');return;}
    const pdfUrl=this.pdfData?.fileUrl||this.pdfData?.file_url||this.pdfData?.downloadURL||this.pdfData?.download_url||null;if(!pdfUrl){showNotification('Gelen PDF bağlantısı bulunamadı. İşlem kaydedilmedi.','error');return;}
    const saveBtn=document.getElementById('saveTransactionBtn');if(saveBtn){saveBtn.disabled=true;saveBtn.innerHTML='<i class="fas fa-spinner fa-spin mr-2"></i>Dava Evrakı Kaydediliyor...';}
    let createdTx=null,createdStage=null,statusChanged=false,existingContextChanged=false,previousExistingContext=null;
    try{
      const childName=childType.alias||childType.name||`Dava Evrakı ${childTypeId}`;
      if(newStageTypeId){
        const stageResult=await this._addTransaction(suitId,{type:String(newStageTypeId),transactionHierarchy:'parent',parentId:String(parentTxId),description:stageLabel(effectiveStage),date:deliveryIso,taskId:null,notes:[`[Yargılama Aşaması Başlatıldı: ${stageLabel(effectiveStage)}]`,'[Başlatan: Karşı Taraf]',`[Kaynak Evrak: ${childName}]`,`[Önceki Parent: ${parentTxId}]`,'[Varlık Türü: suit]'].join('\n'),documents:[]});
        if(!stageResult?.success||!stageResult?.id)throw new Error(stageResult?.error||`${stageLabel(effectiveStage)} parent transaction oluşturulamadı.`);
        createdStage=String(stageResult.id);effectiveParentTxId=createdStage;stageParentContext={stage:effectiveStage,stage_initiator:'opponent',transition_source:'opponent_filing',source_document_id:String(this.pdfId||''),source_incoming_type:String(childTypeId),previous_stage:currentStage,previous_stage_parent_id:String(parentTxId)};
        const {error}=await supabase.from('transactions').update({suit_context:stageParentContext}).eq('id',createdStage);if(error)throw new Error(`Yeni stage context kaydedilemedi: ${error.message}`);
      }else if(transition&&currentStage===transition){
        previousExistingContext=parseJsonObject(parent.suit_context);stageParentContext={...previousExistingContext,stage:currentStage,stage_initiator:mergeInitiator(previousExistingContext.stage_initiator,'opponent'),last_transition_source:'opponent_filing',last_source_document_id:String(this.pdfId||'')};
        const {error}=await supabase.from('transactions').update({suit_context:stageParentContext}).eq('id',String(parentTxId));if(error)throw new Error(`Stage başlatan bilgisi güncellenemedi: ${error.message}`);existingContextChanged=true;
      }
      const tags=[`[Kaynak İşlem: ${newStageTypeId||parent.transaction_type_id}]`,`[Yargılama Aşaması: ${stageLabel(effectiveStage)}]`,'[Varlık Türü: suit]'];if(transition)tags.push('[Aşama Geçiş Kaynağı: Karşı Taraf Dilekçesi]');if(decision.decisionResult)tags.push(`[Karar Sonucu: ${decisionResultLabel(decision.decisionResult)}]`);if(decision.clientOutcome)tags.push(`[Müvekkil Açısından: ${clientOutcomeLabel(decision.clientOutcome)}]`);if(selectedSuitStatus&&selectedSuitStatus!==previousSuitStatus)tags.push(`[Dava Statüsü: ${previousSuitStatus||'-'} -> ${selectedSuitStatus}]`);const systemNote=[notes,...tags].filter(Boolean).join('\n');
      const txResult=await this._addTransaction(suitId,{type:String(childTypeId),transactionHierarchy:'child',parentId:String(effectiveParentTxId),description:childName,date:deliveryIso,taskId:null,notes:systemNote,documents:[{name:this.pdfData?.fileName||this.pdfData?.file_name||'Mahkeme Evrakı.pdf',url:pdfUrl,documentDesignation:childName}]});
      if(!txResult?.success||!txResult?.id)throw new Error(txResult?.error||'Dava child transaction kaydı oluşturulamadı.');createdTx=String(txResult.id);
      const childContext={stage:effectiveStage,stage_initiator:stageParentContext.stage_initiator||null,parent_stage_transaction_id:String(effectiveParentTxId)};if(transition){childContext.transition_source='opponent_filing';childContext.transition_target_stage=transition;}if(decision.decisionResult)childContext.decision_result=decision.decisionResult;if(decision.clientOutcome)childContext.client_outcome=decision.clientOutcome;
      {const {error}=await supabase.from('transactions').update({suit_context:childContext}).eq('id',createdTx);if(error)throw new Error(`Dava transaction context kaydedilemedi: ${error.message}`);}
      if(selectedSuitStatus&&selectedSuitStatus!==previousSuitStatus){const {error}=await supabase.from('suits').update({status:selectedSuitStatus,updated_at:new Date().toISOString()}).eq('id',suitId);if(error)throw new Error(`Dava durumu güncellenemedi: ${error.message}`);statusChanged=true;if(this.matchedSuit)this.matchedSuit.status=selectedSuitStatus;}
      {const {error}=await supabase.from('incoming_documents').update({status:'litigation_indexed',indexed_at:new Date().toISOString(),created_transaction_id:createdTx,ip_record_id:suitId,transaction_type_id:String(childTypeId),teblig_tarihi:deliveryIso}).eq('id',String(this.pdfId));if(error)throw new Error(`Gelen evrak kaydı güncellenemedi: ${error.message}`);}
      if(this.pdfData){this.pdfData.status='litigation_indexed';this.pdfData.ip_record_id=suitId;this.pdfData.matchedRecordId=suitId;this.pdfData.created_transaction_id=createdTx;this.pdfData.transaction_type_id=String(childTypeId);}
      if(saveBtn){saveBtn.disabled=true;saveBtn.classList.remove('btn-primary','btn-secondary');saveBtn.classList.add('btn-success');saveBtn.innerHTML='<i class="fas fa-check-circle mr-2"></i>Dava Evrakı İndekslendi';}
      const statusMsg=selectedSuitStatus&&selectedSuitStatus!==previousSuitStatus?` Dava durumu "${litigationStatusLabel(selectedSuitStatus)}" olarak güncellendi.`:'';const stageMsg=createdStage?` Yeni ${stageLabel(effectiveStage)} aşaması karşı taraf dilekçesi ile oluşturuldu.`:'';const decisionMsg=decision.clientOutcome?` Karar sonucu: ${clientOutcomeLabel(decision.clientOutcome)}.`:'';showNotification(`${childName} dava dosyasına başarıyla bağlandı.${stageMsg}${decisionMsg}${statusMsg}`,'success');
      if(existingContextChanged){const lp=(this.currentTransactions||[]).find(tx=>String(tx.id)===String(parentTxId));if(lp)lp.suit_context=stageParentContext;}
      const adds=[];if(createdStage)adds.push({id:createdStage,ip_record_id:suitId,transaction_type_id:String(newStageTypeId),transaction_hierarchy:'parent',parent_id:String(parentTxId),description:stageLabel(effectiveStage),note:`[Yargılama Aşaması Başlatıldı: ${stageLabel(effectiveStage)}]`,transaction_date:deliveryIso,task_id:null,suit_context:stageParentContext,created_at:new Date().toISOString()});adds.push({id:createdTx,ip_record_id:suitId,transaction_type_id:String(childTypeId),transaction_hierarchy:'child',parent_id:String(effectiveParentTxId),description:childName,note:systemNote,transaction_date:deliveryIso,task_id:null,suit_context:childContext,created_at:new Date().toISOString()});this.currentTransactions=[...(this.currentTransactions||[]),...adds];this._refreshLitigationStageControl();
    }catch(error){
      console.error('[LITIGATION AŞAMA 8C-2] Save hatası:',error);
      if(statusChanged){try{await supabase.from('suits').update({status:previousSuitStatus,updated_at:new Date().toISOString()}).eq('id',suitId);if(this.matchedSuit)this.matchedSuit.status=previousSuitStatus;}catch(e){console.warn('[LITIGATION 8C-2] Status rollback:',e);}}
      if(createdTx){await this._rollbackLitigationTransaction(createdTx);createdTx=null;}
      if(createdStage){await this._rollbackLitigationTransaction(createdStage);createdStage=null;}
      if(existingContextChanged){try{await supabase.from('transactions').update({suit_context:previousExistingContext||{}}).eq('id',String(parentTxId));}catch(e){console.warn('[LITIGATION 8C-2] Context rollback:',e);}}
      showNotification(`Dava indeksleme hatası: ${error.message||error}`,'error');if(saveBtn){saveBtn.disabled=false;saveBtn.classList.remove('btn-success','btn-secondary');saveBtn.classList.add('btn-primary');saveBtn.innerHTML='<i class="fas fa-gavel mr-2"></i>Dava Evrakını İndeksle';}
    }
  };
}
ensurePatchStyles();
console.log('[LITIGATION AŞAMA 8C-2] DB-driven stage/decision indexing patch aktif.');
