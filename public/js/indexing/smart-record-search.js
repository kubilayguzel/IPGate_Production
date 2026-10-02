// public/js/indexing/smart-record-search.js
// AŞAMA 3R - Marka / Patent / Tasarım / Dava ortak akıllı arama.
// document-review-manager.js değiştirilmez.
// Dava seçimi bu aşamada salt-okunurdur.

import { DocumentReviewManager } from './document-review-manager.js';
import { SuitRecordMatcher } from './suit-record-matcher.js';
import { supabase } from '../../supabase-config.js';
import { showNotification, formatToTRDate } from '../../utils.js';

const proto = DocumentReviewManager.prototype;
const suitMatcher = new SuitRecordMatcher();

function esc(v) {
    return String(v ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function one(v){ return Array.isArray(v) ? (v[0] || null) : (v || null); }
function norm(v){ return String(v || '').toLocaleLowerCase('tr-TR').replace(/\s+/g,' ').trim(); }
function compact(v){ return norm(v).replace(/[^0-9a-zçğıöşü]/gi,''); }

function canonicalType(r){
    const t = String(r?.type || r?.ipType || r?.ip_type || '').toLocaleLowerCase('tr-TR').trim();
    if (['trademark','marka'].includes(t)) return 'trademark';
    if (['patent','utility','utility_model','faydalı model','faydali model'].includes(t)) return 'patent';
    if (['design','tasarım','tasarim'].includes(t)) return 'design';
    return t || 'other';
}

function meta(type){
    return {
        trademark:{label:'MARKA',icon:'fa-copyright',color:'#1d4ed8'},
        patent:{label:'PATENT',icon:'fa-lightbulb',color:'#92400e'},
        design:{label:'TASARIM',icon:'fa-drafting-compass',color:'#047857'},
        suit:{label:'DAVA',icon:'fa-gavel',color:'#9a3412'}
    }[type] || {label:'PORTFÖY',icon:'fa-folder',color:'#475569'};
}

function displayNo(r){
    return r?.applicationNumber || r?.application_number ||
           r?.registrationNumber || r?.registration_number ||
           r?.wipoIR || r?.wipo_ir || r?.aripoIR || r?.aripo_ir || '-';
}

function applicantText(r){
    if (r?.applicantName && r.applicantName !== '-') return r.applicantName;
    const arr = Array.isArray(r?.applicants) ? r.applicants : [];
    const names = arr.map(a => typeof a === 'string' ? a : (a?.name || a?.applicantName || '')).filter(Boolean);
    return names.join(', ') || '-';
}

function scoreIp(query, r){
    const q = norm(query), qc = compact(query);
    const title = norm(r.title || r.brandText || r.markName);
    const no = norm(displayNo(r)), noc = compact(displayNo(r));
    const applicant = norm(applicantText(r));
    const fields = [
        title, no, applicant, norm(r.origin), norm(canonicalType(r)),
        norm(r.registrationNumber), norm(r.wipoIR), norm(r.aripoIR)
    ].filter(Boolean);
    const hay = fields.join(' | ');
    const hayc = compact(hay);
    const tokens = q.split(/\s+/).filter(Boolean);
    if (!tokens.every(t => hay.includes(t)) && !(qc.length >= 3 && hayc.includes(qc))) return null;

    let score = 10;
    if (no && no === q) score += 150;
    else if (noc && noc === qc) score += 145;
    else if (no && no.includes(q)) score += 105;

    if (title && title === q) score += 130;
    else if (title && title.startsWith(q)) score += 110;
    else if (title && title.includes(q)) score += 90;

    if (applicant && applicant.includes(q)) score += 70;
    return score;
}

function addStyles(){
    if (document.getElementById('smartIndexingSearchStyles')) return;
    const s = document.createElement('style');
    s.id = 'smartIndexingSearchStyles';
    s.textContent = `
        #smartSearchFilters{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
        .smart-filter-chip{border:1px solid #d9e0ea;background:#fff;color:#596579;border-radius:999px;padding:4px 10px;font-size:.73rem;font-weight:700;cursor:pointer}
        .smart-filter-chip.active{background:#4e73df;border-color:#4e73df;color:#fff}
        .smart-result-section{padding:7px 12px;background:#f8fafc;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:.69rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;display:flex;justify-content:space-between}
        .smart-result-item{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;border-bottom:1px solid #eef1f5}
        .smart-result-item:hover{background:#f8fafc}
        .smart-suit-result{background:#fffdfa}.smart-suit-result:hover{background:#fff7ed}
        .smart-result-icon{width:36px;height:36px;flex:0 0 36px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;background:#f8fafc;border:1px solid #e2e8f0}
        .smart-result-main{min-width:0;flex:1}
        .smart-result-title,.smart-result-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .smart-result-title{font-size:.88rem;font-weight:800;color:#263449}
        .smart-result-line{font-size:.73rem;color:#7a8494;margin-top:2px}
        .smart-type-badge{display:inline-flex;align-items:center;border-radius:999px;padding:2px 7px;font-size:.66rem;font-weight:800;border:1px solid currentColor}
        .litigation-readonly-badge{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:.72rem;font-weight:800;white-space:nowrap}
        #litigationReadOnlyNotice{border-radius:10px;border:1px solid #f5c46b;background:#fff8e8;color:#7c5200}
        #litigationReadonlyParentSummary{border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;padding:10px 12px;margin-top:8px}
        #litigationReadonlyParentSummary ul{padding-left:18px;margin:6px 0 0}
        .smart-empty{padding:16px 12px;text-align:center;color:#8a94a3;font-size:.82rem}
    `;
    document.head.appendChild(s);
}

function ensureFilters(manager){
    const input = document.getElementById('manualSearchInput');
    if (!input) return;
    const group = input.closest('.form-group');
    if (!group || document.getElementById('smartSearchFilters')) return;

    const wrap = document.createElement('div');
    wrap.id = 'smartSearchFilters';
    [['all','Tümü'],['trademark','Marka'],['patent','Patent'],['design','Tasarım'],['suit','Dava']]
      .forEach(([value,label])=>{
        const b=document.createElement('button');
        b.type='button'; b.className='smart-filter-chip'; b.dataset.filter=value; b.textContent=label;
        if (value === (manager.smartSearchFilter || 'all')) b.classList.add('active');
        b.onclick=()=>{
            manager.smartSearchFilter=value;
            wrap.querySelectorAll('.smart-filter-chip').forEach(x=>x.classList.toggle('active',x.dataset.filter===value));
            const q=input.value.trim();
            if(q.length>=2) manager.handleManualSearch(q);
        };
        wrap.appendChild(b);
      });
    const results=document.getElementById('manualSearchResults');
    group.insertBefore(wrap, results || null);
}

function section(label,count){
    return `<div class="smart-result-section"><span>${esc(label)}</span><span>${count}</span></div>`;
}

function ipHtml(r){
    const t=canonicalType(r), m=meta(t), title=r.title||r.brandText||r.markName||'(İsimsiz Kayıt)';
    return `
      <div class="smart-result-item" data-entity="ip" data-id="${esc(r.id)}">
        <div class="smart-result-icon" style="color:${m.color}"><i class="fas ${m.icon}"></i></div>
        <div class="smart-result-main">
          <div style="display:flex;gap:6px;align-items:center;min-width:0">
            <span class="smart-type-badge" style="color:${m.color}">${m.label}</span>
            <span class="smart-result-title" title="${esc(title)}">${esc(title)}</span>
          </div>
          <div class="smart-result-line"><strong>No:</strong> ${esc(displayNo(r))} · ${esc(r.origin||'-')}</div>
          <div class="smart-result-line" title="${esc(applicantText(r))}"><i class="fas fa-user-tie mr-1"></i>${esc(applicantText(r))}</div>
        </div>
      </div>`;
}

function suitHtml(s){
    const sub=s._subjectRecord||{}, sm=meta(canonicalType(sub));
    const subTitle=sub.title||sub.brandText||'(Dava konusu portföy kaydı yok)';
    const parties=[s._clientName,...(s._partyNames||[])].filter(Boolean);
    const partyText=[...new Set(parties)].join(', ')||'-';
    const subNo=displayNo(sub);
    return `
      <div class="smart-result-item smart-suit-result" data-entity="suit" data-id="${esc(s.id)}">
        <div class="smart-result-icon" style="color:#9a3412;background:#fff7ed;border-color:#fed7aa"><i class="fas fa-gavel"></i></div>
        <div class="smart-result-main">
          <div style="display:flex;gap:6px;align-items:center;min-width:0">
            <span class="smart-type-badge" style="color:#9a3412">DAVA</span>
            <span class="smart-result-title">${esc(s.file_no||s.title||'Dava Dosyası')}</span>
          </div>
          <div class="smart-result-line"><i class="fas fa-landmark mr-1"></i>${esc(s.court_name||'Mahkeme belirtilmemiş')} · ${esc(s.suit_type||'Dava')}</div>
          <div class="smart-result-line" title="${esc(subTitle)}"><i class="fas ${sm.icon} mr-1" style="color:${sm.color}"></i><strong>Konu:</strong> ${esc(subTitle)}${subNo!=='-'?` · ${esc(subNo)}`:''}</div>
          <div class="smart-result-line" title="${esc(partyText)}"><i class="fas fa-users mr-1"></i>${esc(partyText)}</div>
        </div>
        <div class="litigation-readonly-badge"><i class="fas fa-lock mr-1"></i>Salt Okunur</div>
      </div>`;
}

if (!proto.__smartIndexingSearchStage3RPatched) {
    Object.defineProperty(proto,'__smartIndexingSearchStage3RPatched',{value:true});

    const originalLoadAllRecords=proto.loadAllRecords;
    const originalSelectRecord=proto.selectRecord;
    const originalRenderHeader=proto.renderHeader;
    const originalHandleSave=proto.handleSave;

    proto.loadAllRecords=async function(){
        await originalLoadAllRecords.call(this);
        this.smartSearchFilter=this.smartSearchFilter||'all';
        const subjectMap=new Map((this.allRecords||[]).map(r=>[String(r.id),r]));

        try{
            const {data:suits,error:suitErr}=await supabase.from('suits').select(`
                id,title,file_no,court_name,description,suit_type,status,origin,opening_date,
                client_role,opposing_party,opposing_counsel,client_id,ip_record_id,task_id,
                transaction_type_id,created_at,updated_at
            `).order('updated_at',{ascending:false});
            if(suitErr) throw suitErr;

            const rows=suits||[];
            const clientIds=[...new Set(rows.map(x=>x.client_id).filter(Boolean).map(String))];
            const clientMap=new Map();
            if(clientIds.length){
                const {data:persons}=await supabase.from('persons').select('id,name').in('id',clientIds);
                (persons||[]).forEach(p=>clientMap.set(String(p.id),p.name||'-'));
            }

            const {data:parties,error:partyErr}=await supabase.from('suit_parties').select(`
                suit_id,role,person_id,free_text_name,persons(name)
            `);
            if(partyErr) console.warn('[AŞAMA 3R] Dava tarafları okunamadı:',partyErr);

            const partyMap=new Map();
            for(const p of (parties||[])){
                const sid=String(p.suit_id||''); if(!sid) continue;
                const person=one(p.persons);
                const name=person?.name||p.free_text_name||null; if(!name) continue;
                if(!partyMap.has(sid)) partyMap.set(sid,[]);
                if(!partyMap.get(sid).includes(name)) partyMap.get(sid).push(name);
            }

            this.allSuits=rows.map(s=>({
                ...s,
                entityType:'suit',
                _clientName:s.client_id?(clientMap.get(String(s.client_id))||'-'):'-',
                _partyNames:partyMap.get(String(s.id))||[],
                _subjectRecord:s.ip_record_id?(subjectMap.get(String(s.ip_record_id))||null):null
            }));
        }catch(e){
            console.warn('[AŞAMA 3R] Dava araması yüklenemedi; IP araması korunuyor:',e);
            this.allSuits=[];
        }

        addStyles();
        ensureFilters(this);
    };

    proto.handleManualSearch=async function(query){
        const container=document.getElementById('manualSearchResults');
        if(!container) return;
        ensureFilters(this);

        const q=String(query||'').trim();
        if(q.length<2){ container.style.display='none'; container.innerHTML=''; return; }

        const filter=this.smartSearchFilter||'all';
        const ipMatches=(this.allRecords||[])
            .map(r=>({r,score:scoreIp(q,r),type:canonicalType(r)}))
            .filter(x=>x.score!==null && (filter==='all'||filter===x.type))
            .sort((a,b)=>b.score-a.score)
            .slice(0,filter==='all'?12:20)
            .map(x=>x.r);

        const suitMatches=(filter==='all'||filter==='suit')
            ? suitMatcher.findMatches(q,this.allSuits||[],filter==='suit'?20:10)
            : [];

        if(!ipMatches.length&&!suitMatches.length){
            container.innerHTML='<div class="smart-empty"><i class="fas fa-search mr-1"></i>Arama kriterine uygun kayıt bulunamadı.</div>';
            container.style.display='block'; return;
        }

        let html='';
        if(ipMatches.length) html+=section('Portföy Kayıtları',ipMatches.length)+ipMatches.map(ipHtml).join('');
        if(suitMatches.length) html+=section('Dava Dosyaları',suitMatches.length)+suitMatches.map(suitHtml).join('');
        container.innerHTML=html;

        container.querySelectorAll('[data-entity="ip"]').forEach(el=>{
            el.onclick=async()=>{
                const r=ipMatches.find(x=>String(x.id)===String(el.dataset.id));
                if(!r)return; container.style.display='none'; await this.selectRecordWithHierarchy(r);
            };
        });
        container.querySelectorAll('[data-entity="suit"]').forEach(el=>{
            el.onclick=async()=>{
                const s=suitMatches.find(x=>String(x.id)===String(el.dataset.id));
                if(!s)return; container.style.display='none'; await this.selectSuitReadOnly(s);
            };
        });
        container.style.display='block';
    };

    proto._setSuitReadOnlyUi=function(enabled){
        const analysis=document.getElementById('analysisResults');
        if(enabled){
            if(!this._litigationStage3UiSnapshot){
                const save=document.getElementById('saveTransactionBtn');
                this._litigationStage3UiSnapshot={
                    save:save?{html:save.innerHTML,className:save.className,disabled:save.disabled}:null,
                    date:document.getElementById('detectedDate')?.disabled??false,
                    parent:document.getElementById('parentTransactionSelect')?.disabled??false,
                    notes:document.getElementById('transactionNotes')?.disabled??false
                };
            }
            if(!document.getElementById('litigationReadOnlyNotice')&&analysis){
                const n=document.createElement('div');
                n.id='litigationReadOnlyNotice'; n.className='alert mb-4';
                n.innerHTML='<i class="fas fa-lock mr-2"></i><strong>Dava dosyası seçildi.</strong><br><small>Ortak aramada bulunabilir; fakat indeksleme yazması henüz kapalıdır.</small>';
                analysis.insertBefore(n,analysis.firstChild);
            }
            const save=document.getElementById('saveTransactionBtn');
            if(save){save.disabled=true;save.classList.remove('btn-primary','btn-success');save.classList.add('btn-secondary');save.innerHTML='<i class="fas fa-lock mr-2"></i>Dava İndeksleme Yazması Kapalı';}
            const date=document.getElementById('detectedDate'); if(date) date.disabled=true;
            const parent=document.getElementById('parentTransactionSelect'); if(parent) parent.disabled=true;
            const child=document.getElementById('detectedType'); if(child){child.disabled=true;child.innerHTML='<option value="">-- Sonraki aşamada aktif edilecek --</option>';}
            const notes=document.getElementById('transactionNotes'); if(notes) notes.disabled=true;
            const deadline=document.getElementById('calculatedDeadlineDisplay'); if(deadline) deadline.value='';
            const opposition=document.getElementById('oppositionSection'); if(opposition) opposition.style.display='none';
            const proof=document.getElementById('proofOfUseSection'); if(proof) proof.style.display='none';
            const registry=document.getElementById('registry-editor-section'); if(registry) registry.style.display='none';
        }else{
            document.getElementById('litigationReadOnlyNotice')?.remove();
            document.getElementById('litigationReadonlyParentSummary')?.remove();
            const snap=this._litigationStage3UiSnapshot;
            const save=document.getElementById('saveTransactionBtn');
            if(snap?.save&&save){save.innerHTML=snap.save.html;save.className=snap.save.className;save.disabled=snap.save.disabled;}
            const date=document.getElementById('detectedDate'); if(date) date.disabled=snap?.date??false;
            const parent=document.getElementById('parentTransactionSelect'); if(parent) parent.disabled=snap?.parent??false;
            const child=document.getElementById('detectedType'); if(child){child.disabled=true;child.innerHTML='<option value="">-- Önce Ana İşlem Seçiniz --</option>';}
            const notes=document.getElementById('transactionNotes'); if(notes) notes.disabled=snap?.notes??false;
            this._litigationStage3UiSnapshot=null;
        }
    };

    proto.selectSuitReadOnly=async function(suit){
        if(!suit?.id)return;
        this.matchedEntityType='suit';
        this.matchedSuit=suit;
        this.matchedRecord={
            id:String(suit.id),entityType:'suit',ipType:'suit',
            title:suit.title||suit.file_no||'Dava Dosyası',
            applicationNumber:suit.file_no||'',application_number:suit.file_no||'',
            resolvedNames:suit._clientName||'-'
        };
        const input=document.getElementById('manualSearchInput');
        if(input) input.value=suit.file_no||suit.title||'';
        this._setSuitReadOnlyUi(true);
        this.renderHeader();
        await this.loadSuitParentTransactionsReadOnly(String(suit.id));
        showNotification(`Dava dosyası seçildi: ${suit.file_no||suit.title||suit.id}. Salt okunur.`,'info');
    };

    proto.loadSuitParentTransactionsReadOnly=async function(suitId){
        const parent=document.getElementById('parentTransactionSelect'); if(!parent)return;
        document.getElementById('litigationReadonlyParentSummary')?.remove();
        parent.disabled=true; parent.innerHTML='<option value="">Dava işlemleri okunuyor...</option>';
        try{
            const {data,error}=await supabase.from('transactions').select(`
                id,ip_record_id,transaction_type_id,transaction_hierarchy,parent_id,
                description,note,transaction_date,created_at,task_id
            `).eq('ip_record_id',String(suitId)).order('transaction_date',{ascending:false});
            if(error)throw error;
            this.currentTransactions=data||[];
            const parents=this.currentTransactions.filter(tx=>String(tx.transaction_hierarchy||'parent').toLowerCase()==='parent');
            parent.innerHTML=`<option value="">${parents.length} ana işlem bulundu · salt okunur</option>`;
            const box=document.createElement('div'); box.id='litigationReadonlyParentSummary'; box.className='small text-muted';
            if(!parents.length) box.innerHTML='<i class="fas fa-info-circle mr-1"></i>Bu dava dosyasında parent transaction bulunamadı.';
            else box.innerHTML='<div><i class="fas fa-folder-open mr-1"></i><strong>Mevcut dava ana işlemleri:</strong></div><ul>'+
                parents.map(tx=>{
                    const type=(this.allTransactionTypes||[]).find(t=>String(t.id)===String(tx.transaction_type_id));
                    const label=type?.alias||type?.name||tx.description||`İşlem ${tx.transaction_type_id||''}`;
                    const date=formatToTRDate(tx.transaction_date||tx.created_at);
                    return `<li><strong>${esc(label)}</strong>${date?` · ${esc(date)}`:''}</li>`;
                }).join('')+'</ul>';
            parent.insertAdjacentElement('afterend',box);
        }catch(e){
            console.warn('[AŞAMA 3R] Dava transaction geçmişi okunamadı:',e);
            parent.innerHTML='<option value="">Dava işlemleri okunamadı</option>';
        }
    };

    proto.renderHeader=function(){
        if(this.matchedEntityType!=='suit'||!this.matchedSuit) return originalRenderHeader.call(this);
        const s=this.matchedSuit, sub=s._subjectRecord||{};
        const subjectTitle=sub.title||sub.brandText||'-', subjectNo=displayNo(sub);
        const fileName=document.getElementById('fileNameDisplay');
        if(fileName) fileName.textContent=this.pdfData?.fileName||'Dosya yükleniyor...';
        const box=document.getElementById('matchInfoDisplay'); if(!box)return;
        const parties=(s._partyNames||[]).join(', ')||'-';
        box.innerHTML=`
          <div class="d-flex align-items-center w-100">
            <div class="mr-3 border rounded bg-white shadow-sm d-flex align-items-center justify-content-center" style="width:70px;height:70px;flex:0 0 70px"><i class="fas fa-gavel fa-2x text-warning"></i></div>
            <div class="flex-grow-1 overflow-hidden">
              <div class="d-flex align-items-center flex-wrap mb-1" style="gap:7px">
                <h6 class="mb-0 text-dark font-weight-bold">${esc(s.file_no||s.title||'Dava Dosyası')}</h6>
                <span class="litigation-readonly-badge"><i class="fas fa-lock mr-1"></i>DAVA · SALT OKUNUR</span>
              </div>
              <div class="small text-dark mb-1"><strong>Mahkeme:</strong> ${esc(s.court_name||'-')}</div>
              <div class="small text-dark mb-1"><strong>Dava Konusu:</strong> ${esc(subjectTitle)}${subjectNo!=='-'?` · ${esc(subjectNo)}`:''}</div>
              <div class="small text-muted"><i class="fas fa-user-tie mr-1"></i>Müvekkil: ${esc(s._clientName||'-')}</div>
              <div class="small text-muted text-truncate" title="${esc(parties)}"><i class="fas fa-users mr-1"></i>Taraflar: ${esc(parties)}</div>
            </div>
            <div class="ml-2"><a href="suit-detail.html?id=${encodeURIComponent(String(s.id))}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-warning"><i class="fas fa-external-link-alt mr-1"></i>Dava Detayı</a></div>
          </div>`;
    };

    proto.selectRecord=async function(recordId){
        if(this.matchedEntityType==='suit') this._setSuitReadOnlyUi(false);
        this.matchedEntityType='ip_record'; this.matchedSuit=null;
        return originalSelectRecord.call(this,recordId);
    };

    proto.handleSave=async function(...args){
        if(this.matchedEntityType==='suit'){
            showNotification('Güvenlik kilidi: Dava dosyaları ortak aramada bulunabilir ancak henüz indekslenemez.','warning');
            return;
        }
        return originalHandleSave.apply(this,args);
    };

    addStyles();
}