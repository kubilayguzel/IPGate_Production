// IPGate - Belge Yükleme ve Yönetimi / Manuel İşlem: Dava Portföyü uyarlaması
// Mevcut marka/patent/tasarım manuel indeksleme davranışı DEĞİŞTİRİLMEZ.
// Dava kayıtları için görev ve müvekkil e-postası üretmeyen ayrı kayıt yolu.
import { ManuelPdfTransactionManager } from './manuel-pdf-transaction-manager.js';
import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

const proto = ManuelPdfTransactionManager.prototype;
if (!proto.__manualLitigationExtensionInstalled) {
    Object.defineProperty(proto, '__manualLitigationExtensionInstalled', { value: true });

    const nativeSearch = proto.searchRecords;
    const nativeSelect = proto.selectRecord;
    const nativeClear = proto.clearSelectedRecordManual;
    const nativePopulate = proto.populateManualTransactionTypeSelect;
    const nativeChildren = proto.updateManualChildOptions;
    const nativeParents = proto.updateManualParentOptions;
    const nativeCheck = proto.checkFormCompleteness;
    const nativeSubmit = proto.handleManualTransactionSubmit;

    const FIRST = new Set(['49', '54', '55', '56', '57', '58']);
    const PARENTS = new Set([...FIRST, '59', '60']);
    const STAGE = { '59': 'appeal', '60': 'cassation' };
    // PDF zorunluluğu yalnız DAVA MANUEL alt işlemlerine uygulanır.
    // Marka/patent/tasarım manuel işlemleri ve yalnız yeni ana aşama kaydı etkilenmez.
    const REQUIRED_PDF_CHILDREN = new Set([
        '61', '62', '63', '70', '71', '76', '77',
        '92', '93', '94', '95', '96', '97'
    ]);
    const parentTypes = tx => PARENTS.has(String(tx?.transaction_type_id || tx?.type || '')) && String(tx?.transaction_hierarchy || tx?.transactionHierarchy || 'parent') === 'parent';
    const stageOf = id => FIRST.has(String(id)) ? 'first_instance' : STAGE[String(id)] || null;
    const displayStage = key => ({ first_instance: 'İlk Derece', appeal: 'İstinaf', cassation: 'Yargıtay' }[key] || '-');
    const pad = x => String(x).padStart(2, '0');
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[c]));
    const newOption = (value, label) => { const o = document.createElement('option'); o.value = String(value); o.textContent = label; return o; };
    const ttype = (m, id) => (m.allTransactionTypes || []).find(t => String(t.id) === String(id));
    const txDate = tx => tx?.transaction_date || tx?.timestamp || tx?.created_at;
    const txType = tx => String(tx?.transaction_type_id || tx?.type || '');
    const stageParentRows = m => (m.currentRecordTransactions || []).filter(parentTypes);
    const selectedStage = () => document.getElementById('specificManualTransactionType')?.value || '';
    const selectedChild = () => document.getElementById('manualChildTransactionType')?.value || '';
    const selectedParent = () => document.getElementById('manualExistingParentSelect')?.value || '';
    const pendingPdfFiles = m => (m.uploadedFilesMap.get('manual-indexing-pane') || [])
        .filter(item => item?.fileObject && (item.fileObject.type === 'application/pdf' || /\.pdf$/i.test(item.fileObject.name || '')));
    const requiresPdf = childId => REQUIRED_PDF_CHILDREN.has(String(childId || ''));

    function parseDateTR(value) {
        const raw = String(value || '').trim();
        let year, month, day;
        let m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
        if (m) [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
        else {
            m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
            if (!m) return null;
            [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
        }
        const parsed = new Date(Date.UTC(year, month - 1, day));
        if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
        return { iso: `${year}-${pad(month)}-${pad(day)}T09:00:00.000Z`, date: `${year}-${pad(month)}-${pad(day)}` };
    }

    function ensureExtras() {
        if (document.getElementById('manualSuitExtra')) return;
        const host = document.getElementById('manualParentSelectContainer');
        if (!host) return;
        const extra = document.createElement('div');
        extra.id = 'manualSuitExtra';
        extra.style.display = 'none';
        extra.innerHTML = `
          <div class="alert alert-info py-2 px-3 mb-3 small" id="manualSuitHelp">
            <strong>Dava geçmişini tamamla:</strong> Ana aşama ve alt işlemi seçin. Bu kayıt <strong>yeni görev veya müvekkil e-postası oluşturmaz</strong>; PDF yalnızca işlem geçmişine bağlanır.
          </div>
          <div class="form-group" id="manualSuitPredecessorGroup" style="display:none">
            <label class="form-label" for="manualSuitPredecessor"><strong>Bağlanacak Önceki Yargılama Aşaması</strong> <span class="text-danger">*</span></label>
            <select id="manualSuitPredecessor" class="form-select shadow-sm"></select>
            <small class="text-muted">İstinaf ilk dereceye, Yargıtay istinafa bağlanır. Böylece aşamalar akordeonda birlikte görünür.</small>
          </div>
          <div class="form-group" id="manualSuitInitiatorGroup" style="display:none">
            <label class="form-label" for="manualSuitInitiator">Kanun Yoluna Başvuran</label>
            <select id="manualSuitInitiator" class="form-select shadow-sm">
              <option value="unknown">Belirtilmedi</option><option value="client">Müvekkil</option>
              <option value="opponent">Karşı taraf</option><option value="both">Her iki taraf</option>
            </select>
          </div>
          <div class="form-group" id="manualSuitDecisionGroup" style="display:none">
            <label class="form-label" for="manualSuitDecisionResult"><strong>Karar Bilgileri</strong></label>
            <select id="manualSuitDecisionResult" class="form-select shadow-sm mb-2" style="display:none">
              <option value="">-- Hüküm / Karar --</option>
              <option value="accept">Kabul</option><option value="partial_accept">Kısmen Kabul</option><option value="reject">Ret</option>
            </select>
            <select id="manualSuitClientOutcome" class="form-select shadow-sm">
              <option value="">-- Müvekkil Açısından Sonuç --</option>
              <option value="favorable">Lehe</option>
              <option value="partially_favorable">Kısmen Lehe / Kısmen Aleyhe</option>
              <option value="unfavorable">Aleyhe</option>
            </select>
            <small class="text-muted">Karar sonucunun girilmesi geçmişi tamamlar; kanun yolu veya görev otomatik başlatılmaz.</small>
          </div>
          <div id="manualSuitValidation" class="small text-danger mb-2" role="status"></div>
        `;
        host.insertAdjacentElement('afterend', extra);
        const fileList = document.getElementById('fileListManual');
        if (fileList && !document.getElementById('manualSuitPdfRequirement')) {
            const tip = document.createElement('div');
            tip.id = 'manualSuitPdfRequirement';
            tip.className = 'small mt-2 mb-2';
            tip.style.display = 'none';
            tip.setAttribute('role', 'status');
            fileList.insertAdjacentElement('afterend', tip);
        }
        for (const id of ['manualSuitPredecessor','manualSuitInitiator','manualSuitDecisionResult','manualSuitClientOutcome']) {
            document.getElementById(id)?.addEventListener('change', () => {
                if (id === 'manualSuitDecisionResult') {
                    const role = String(window.manuelPdfTransactionManager?.selectedRecordManual?.client_role || '').toLowerCase();
                    const result = document.getElementById('manualSuitDecisionResult').value;
                    const computed = role === 'davaci' ? { accept:'favorable', partial_accept:'partially_favorable', reject:'unfavorable' }[result]
                        : role === 'davali' ? { accept:'unfavorable', partial_accept:'partially_favorable', reject:'favorable' }[result] : null;
                    if (computed) document.getElementById('manualSuitClientOutcome').value = computed;
                }
                window.manuelPdfTransactionManager?.checkFormCompleteness();
            });
        }
    }

    function refreshPredecessors(manager) {
        ensureExtras();
        const suit = manager.selectedRecordManual?._isSuit === true;
        const extra = document.getElementById('manualSuitExtra');
        if (!extra) return;
        extra.style.display = suit ? 'block' : 'none';
        const pdfTip = document.getElementById('manualSuitPdfRequirement');
        if (pdfTip) pdfTip.style.display = suit ? 'block' : 'none';
        if (!suit) return;

        const type = selectedStage();
        const parent = selectedParent();
        const newStage = parent === 'CREATE_NEW';
        const priorType = type === '59' ? 'first_instance' : type === '60' ? 'appeal' : null;
        const wrap = document.getElementById('manualSuitPredecessorGroup');
        const dropdown = document.getElementById('manualSuitPredecessor');
        const iniWrap = document.getElementById('manualSuitInitiatorGroup');
        wrap.style.display = newStage && priorType ? 'block' : 'none';
        iniWrap.style.display = newStage && priorType ? 'block' : 'none';
        if (wrap.style.display === 'block') {
            const selected = dropdown.value;
            const prev = stageParentRows(manager).filter(t => stageOf(txType(t)) === priorType);
            dropdown.replaceChildren(newOption('', `-- ${displayStage(priorType)} ana işlemini seçin --`));
            for (const tx of prev) dropdown.add(newOption(tx.id, `${ttype(manager,txType(tx))?.alias || tx.description || displayStage(priorType)} · ${new Date(txDate(tx)).toLocaleDateString('tr-TR')}`));
            dropdown.value = prev.some(tx=>String(tx.id)===selected) ? selected : prev.length===1 ? String(prev[0].id) : '';
        }
        const decisionGroup = document.getElementById('manualSuitDecisionGroup');
        const child = selectedChild();
        decisionGroup.style.display = ['76','77'].includes(child) ? 'block' : 'none';
        document.getElementById('manualSuitDecisionResult').style.display = child==='76' ? 'block' : 'none';
    }

    function suitTypeChildren(m, parentTypeId) {
        const stage = stageOf(parentTypeId);
        if (!stage) return [];
        return (m.allTransactionTypes || []).filter(t => {
            if (String(t.ip_type) !== 'suit' || t.hierarchy !== 'child') return false;
            const id = String(t.id);
            // Bu iki iş türü standart görev tamamlanmasında önceki aşamaya bağlıdır.
            // Geçmişi MANUEL girerken dilekçe yeni açılmış kanun yolu aşamasının altında gösterilir.
            if (id === '93') return stage === 'appeal';
            if (id === '96') return stage === 'cassation';
            const scopes = Array.isArray(t.suit_stage_scope) ? t.suit_stage_scope : [];
            return scopes.includes(stage);
        }).sort((a,b) => Number(a.id)-Number(b.id));
    }

    proto.searchRecords = async function(q) {
        await nativeSearch.call(this, q);
        const raw = String(q || '').trim();
        if (raw.length < 3 || raw !== String(document.getElementById('recordSearchInputManual')?.value || '').trim()) return;
        const box = document.getElementById('searchResultsContainerManual');
        if (!box) return;
        try {
            const safe = raw.replace(/[%,()\\]/g, ' ').trim();
            if (safe.length < 3) return;
            const { data, error } = await supabase.from('suits')
                .select('id,title,file_no,court_name,suit_type,client_role,transaction_type_id')
                .or(`title.ilike.%${safe}%,file_no.ilike.%${safe}%`).limit(12);
            if (error) { console.warn('[MANUAL LITIGATION] Dava araması:',error); return; }
            if (raw !== String(document.getElementById('recordSearchInputManual')?.value || '').trim()) return;
            if (!data?.length) return;
            if (!box.querySelector('.search-result-item')) box.replaceChildren();
            const header = document.createElement('div');
            header.className = 'dropdown-header font-weight-bold bg-light border-bottom';
            header.textContent = '⚖️ Dava Portföyü';
            box.appendChild(header);
            for (const suit of data) {
                const item = document.createElement('div');
                item.className = 'search-result-item';
                item.style.cssText = 'padding:10px 15px;cursor:pointer;border-bottom:1px solid #eee';
                item.innerHTML = `<strong>${esc(suit.file_no || 'Dosya numarası yok')}</strong><div class="small">${esc(suit.title || suit.suit_type || 'Dava')} · ${esc(suit.court_name || '')}</div>`;
                item.addEventListener('mousedown', e => { e.preventDefault(); this.selectRecord({ ...suit, _isSuit: true }); box.style.display = 'none'; });
                box.appendChild(item);
            }
            box.style.display = 'block';
        } catch(e) { console.error('[MANUAL LITIGATION] Arama hatası:',e); }
    };

    proto.selectRecord = async function(record) {
        if (!record?._isSuit) {
            const pdfTip = document.getElementById('manualSuitPdfRequirement');
            if (pdfTip) pdfTip.style.display = 'none';
            return nativeSelect.call(this,record);
        }
        this.selectedRecordManual = {
            ...record, _isSuit: true, title: record.title || record.suit_type || 'Dava',
            applicationNumber: record.file_no || '-', client_role: record.client_role || null
        };
        this._manualSuitTransactionsReady = false;
        const search = document.getElementById('recordSearchInputManual'); if(search) search.value='';
        const empty = document.getElementById('selectedRecordEmptyManual'); if(empty) empty.style.display='none';
        const container = document.getElementById('selectedRecordContainerManual'); if(container) container.style.display='block';
        document.getElementById('selectedRecordLabelManual').textContent = this.selectedRecordManual.title;
        document.getElementById('selectedRecordNumberManual').textContent = record.file_no || '-';
        document.getElementById('selectedRecordImageManual').style.display='none';
        document.getElementById('selectedRecordPlaceholderManual').style.display='flex';
        try {
            if (!this.allTransactionTypes?.length) {
                const { data, error } = await supabase.from('transaction_types').select('*');
                if(error) throw error;
                this.allTransactionTypes = data || [];
            }
            const { data, error } = await supabase.from('transactions')
                .select('id,ip_record_id,transaction_type_id,transaction_hierarchy,parent_id,description,transaction_date,created_at,task_id,suit_context')
                .eq('ip_record_id',String(record.id)).order('transaction_date',{ascending:false});
            if(error) throw error;
            if(this.selectedRecordManual?.id !== record.id) return;
            this.currentRecordTransactions=(data||[]).map(t=>({ ...t, type:String(t.transaction_type_id), transactionHierarchy:t.transaction_hierarchy, timestamp:txDate(t) }));
            this._manualSuitTransactionsReady=true;
            this.populateManualTransactionTypeSelect();
        } catch(e) {
            console.error('[MANUAL LITIGATION] Dava geçmişi yüklenemedi:',e);
            showNotification('Dava işlemleri yüklenemedi: '+e.message,'error');
        }
        this.checkFormCompleteness();
    };

    proto.clearSelectedRecordManual = function() {
        const wasSuit = this.selectedRecordManual?._isSuit;
        const r = nativeClear.call(this);
        if (wasSuit) {
            this._manualSuitTransactionsReady=false;
            this.currentRecordTransactions=[];
            document.getElementById('manualSuitExtra')?.style.setProperty('display','none');
            document.getElementById('manualSuitPdfRequirement')?.style.setProperty('display','none');
            nativePopulate.call(this);
        }
        return r;
    };

    proto.populateManualTransactionTypeSelect = function() {
        if(!this.selectedRecordManual?._isSuit) return nativePopulate.call(this);
        const parent = document.getElementById('specificManualTransactionType');
        if(!parent) return;
        parent.replaceChildren(newOption('','-- Dava aşamasını seçin --'));
        const selectedRoot = this.selectedRecordManual.transaction_type_id;
        const rows = (this.allTransactionTypes || []).filter(t=>t.ip_type==='suit' && t.hierarchy==='parent' && PARENTS.has(String(t.id)));
        for(const t of rows) parent.add(newOption(t.id, `${displayStage(stageOf(t.id))} · ${t.alias||t.name}`));
        const rootTypes = stageParentRows(this);
        const suggested = rootTypes.find(t=>FIRST.has(txType(t)))?.transaction_type_id || selectedRoot;
        if(rows.some(t=>String(t.id)===String(suggested))) parent.value=String(suggested);
        this.updateManualChildOptions();
        refreshPredecessors(this);
    };

    proto.updateManualChildOptions = function() {
        if(!this.selectedRecordManual?._isSuit) return nativeChildren.call(this);
        const child = document.getElementById('manualChildTransactionType');
        const selected = child?.value;
        if(!child) return;
        child.replaceChildren(newOption('','-- Sadece yeni ana aşama oluştur --'));
        for(const t of suitTypeChildren(this,selectedStage())) child.add(newOption(t.id, `${t.alias||t.name} (${t.id})`));
        child.disabled=!selectedStage();
        if([...child.options].some(o=>o.value===selected)) child.value=selected;
        this.updateManualParentOptions();
        this.updateCancellationNoticeFields?.();
    };

    proto.updateManualParentOptions = function() {
        if(!this.selectedRecordManual?._isSuit) return nativeParents.call(this);
        ensureExtras();
        const wrap=document.getElementById('manualParentSelectContainer');
        const select=document.getElementById('manualExistingParentSelect');
        const type=selectedStage();
        if(!select||!wrap) return;
        wrap.style.display=type?'block':'none';
        const current=select.value;
        select.replaceChildren(newOption('','-- Ana aşama seçin --'));
        const already=stageParentRows(this).filter(t=>txType(t)===type);
        for(const tx of already) select.add(newOption(tx.id, `${ttype(this,type)?.alias||'Ana aşama'} · ${new Date(txDate(tx)).toLocaleDateString('tr-TR')}`));
        // Bir yargılama aşaması varken aynı aşamanın farklı türde kopyası açılmaz.
        const wholeStage=stageParentRows(this).filter(t=>stageOf(txType(t))===stageOf(type));
        if(type && !wholeStage.length) select.add(newOption('CREATE_NEW',`+ Yeni ${displayStage(stageOf(type))} aşaması oluştur`));
        const ids=[...select.options].map(o=>o.value);
        select.value=(current && ids.includes(current))?current:already.length===1?String(already[0].id):
            ids.includes('CREATE_NEW')?'CREATE_NEW':'';
        refreshPredecessors(this);
        this.checkFormCompleteness();
    };

    proto.checkFormCompleteness = function() {
        if(!this.selectedRecordManual?._isSuit) return nativeCheck.call(this);
        refreshPredecessors(this);
        const type=selectedStage(),parent=selectedParent(),child=selectedChild();
        const date=parseDateTR(document.getElementById('manualTransactionDeliveryDate')?.value);
        let problem='';
        if(!this._manualSuitTransactionsReady) problem='Dava işlem geçmişi yükleniyor.';
        else if(!type) problem='Yargılama aşaması seçin.';
        else if(!parent) problem='Mevcut bir ana işlem seçin veya yeni aşama oluşturun.';
        else if(parent!=='CREATE_NEW' && !child) problem='Mevcut ana aşama zaten kayıtlı; eklemek istediğiniz alt işlemi seçin.';
        else if(parent==='CREATE_NEW' && ['59','60'].includes(type) && !document.getElementById('manualSuitPredecessor')?.value)
            problem=`Yeni ${displayStage(stageOf(type))} aşamasını önceki yargılama aşamasına bağlayın.`;
        else if(!date) problem='Geçerli bir işlem tarihi girin (gg.aa.yyyy).';
        else if(['76','77'].includes(child) && !document.getElementById('manualSuitClientOutcome')?.value)
            problem='Kararın müvekkil açısından sonucunu seçin.';
        else if(child==='76' && !document.getElementById('manualSuitDecisionResult')?.value)
            problem='Kararın hüküm sonucunu seçin.';
        else if(requiresPdf(child) && pendingPdfFiles(this).length===0)
            problem=`${ttype(this,child)?.alias || ttype(this,child)?.name || 'Seçilen alt işlem'} (${child}) için PDF eklenmesi zorunludur.`;
        const pdfTip = document.getElementById('manualSuitPdfRequirement');
        if (pdfTip) {
            const typeName = ttype(this,child)?.alias || ttype(this,child)?.name || 'Alt işlem';
            const count = pendingPdfFiles(this).length;
            pdfTip.textContent = !child
                ? 'Yalnız ana aşama kaydı: PDF isteğe bağlı.'
                : requiresPdf(child)
                    ? count ? `PDF zorunlu · ${typeName} (${child}) · ${count} PDF eklendi.`
                            : `PDF ZORUNLU · ${typeName} (${child}) için en az bir PDF ekleyin.`
                    : `PDF isteğe bağlı · ${typeName} (${child}).`;
            pdfTip.className = 'small mt-2 mb-2 ' + (requiresPdf(child) && count===0 ? 'text-danger font-weight-bold' : 'text-muted');
        }
        const btn=document.getElementById('saveManualTransactionBtn');
        if(btn){btn.disabled=!!problem;btn.style.opacity=problem?'0.6':'1';}
        const message=document.getElementById('manualSuitValidation');if(message)message.textContent=problem;
    };

    proto.handleManualTransactionSubmit = async function() {
        if(!this.selectedRecordManual?._isSuit) return nativeSubmit.call(this);
        const button=document.getElementById('saveManualTransactionBtn');
        if(!button||button.dataset.busy==='1') return;
        this.checkFormCompleteness();
        if(button.disabled){
            showNotification(document.getElementById('manualSuitValidation')?.textContent || 'Dava için zorunlu alanları tamamlayın.','warning');
            return;
        }
        const rec=this.selectedRecordManual;
        const id=String(rec.id),type=selectedStage(),child=selectedChild(),parentSel=selectedParent();
        const date=parseDateTR(document.getElementById('manualTransactionDeliveryDate')?.value);
        const note=document.getElementById('manualTransactionNotes')?.value?.trim() || '';
        const previous=document.getElementById('manualSuitPredecessor')?.value || null;
        const initiator=document.getElementById('manualSuitInitiator')?.value || 'unknown';
        const files=this.uploadedFilesMap.get('manual-indexing-pane') || [];
        const user=this.currentUser;
        const uuid=()=>crypto.randomUUID();
        const created=[];
        button.dataset.busy='1';button.disabled=true;
        const oldHtml=button.innerHTML;button.innerHTML='<i class="fas fa-spinner fa-spin mr-1"></i> Dava geçmişi kaydediliyor...';
        let transactionId=null,stageId=null;
        try{
            if(!date)throw new Error('İşlem tarihi geçersiz.');
            // Kaydetme anında da zorunluluğu doğrula; buton/DOM kontrolü tek başına yeterli değildir.
            // Bu kontrol veritabanına ana/alt işlem yazılmadan önce yapılır.
            if(requiresPdf(child) && pendingPdfFiles(this).length===0) {
                throw new Error(`${ttype(this,child)?.alias || ttype(this,child)?.name || 'Alt işlem'} (${child}) için PDF eklemek zorunludur.`);
            }
            // Kayıt türünü kesin olarak doğrula; görev ve e-posta mekanizmasına hiç girme.
            const {data:suit,error:suitErr}=await supabase.from('suits').select('id').eq('id',id).maybeSingle();
            if(suitErr||!suit)throw new Error('Dava kaydı doğrulanamadı.');
            const stageType=ttype(this,type),childType=child?ttype(this,child):null;
            if(stageType?.ip_type!=='suit'||stageType.hierarchy!=='parent'||!PARENTS.has(type))throw new Error('Geçersiz dava ana işlemi.');
            if(child && !suitTypeChildren(this,type).some(t=>String(t.id)===child))throw new Error('Bu alt işlem seçilen yargılama aşamasına ait değil.');
            if(parentSel==='CREATE_NEW'){
                if((this.currentRecordTransactions||[]).some(t=>stageOf(txType(t))===stageOf(type)))throw new Error('Bu aşamaya ait işlem zaten mevcut. Önce kayıt hiyerarşisini kontrol edin.');
                if(['59','60'].includes(type)){
                    const prevTx=stageParentRows(this).find(t=>String(t.id)===previous);
                    const required=type==='59'?'first_instance':'appeal';
                    if(!prevTx||stageOf(txType(prevTx))!==required)throw new Error('Önceki yargılama aşaması geçersiz.');
                }
                stageId=uuid();
                const parentContext={stage:stageOf(type),stage_initiator:initiator,
                    transition_source:'manual_entry',previous_stage: type==='59'?'first_instance':type==='60'?'appeal':null,
                    previous_stage_parent_id: previous||null};
                const {error}=await supabase.from('transactions').insert({
                    id:stageId,ip_record_id:id,transaction_type_id:type,transaction_hierarchy:'parent',
                    parent_id:['59','60'].includes(type)?previous:null,description:stageType.alias||stageType.name,
                    transaction_date:date.iso,user_id:user.id,user_email:user.email||null,
                    note:'[Manuel dava geçmişi · ana aşama]',task_id:null,suit_context:parentContext
                });
                if(error)throw new Error('Ana yargılama aşaması kaydedilemedi: '+error.message);
                created.push(stageId);
            }else{
                stageId=parentSel;
                const tx=stageParentRows(this).find(t=>String(t.id)===stageId);
                if(!tx||txType(tx)!==type)throw new Error('Seçilen ana işlem güncel listede bulunamadı.');
                if(!child)throw new Error('Mevcut ana işlemin tekrar oluşturulması engellendi.');
            }
            if(child){
                transactionId=uuid();
                const context={stage:stageOf(type),parent_stage_transaction_id:stageId,
                    source:'manual_entry',stage_initiator:initiator};
                if(['76','77'].includes(child)){
                    context.client_outcome=document.getElementById('manualSuitClientOutcome')?.value;
                    if(child==='76')context.decision_result=document.getElementById('manualSuitDecisionResult')?.value;
                    if(child==='77')context.stage_initiator=stageParentRows(this).find(t=>String(t.id)===stageId)?.suit_context?.stage_initiator || initiator;
                }
                const {error}=await supabase.from('transactions').insert({
                    id:transactionId,ip_record_id:id,transaction_type_id:child,transaction_hierarchy:'child',
                    parent_id:stageId,description:childType.alias||childType.name,note:note||null,
                    transaction_date:date.iso,user_id:user.id,user_email:user.email||null,
                    task_id:null,suit_context:context
                });
                if(error)throw new Error('Dava alt işlemi kaydedilemedi: '+error.message);
                created.push(transactionId);
            }
            // PDF, ilgili ALT işleme bağlanır. Sadece ana aşama kaydediliyorsa ana işleme bağlanır.
            // Dava için incoming_documents kaydı YAZILMAZ: bu kayıt e-posta motorunun
            // trigger'ıdır; geçmiş PDF'i transaction_documents üzerinden zaten görünür.
            const targetId=transactionId||stageId;
            for(const item of files){
                const file=item.fileObject;
                if(!file||(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf'))throw new Error('Yalnız PDF dosyası eklenebilir.');
                const cleanName=file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
                const path=`incoming_documents/${user.id}/${Date.now()}_${uuid()}_${cleanName}`;
                const {error:uploadError}=await supabase.storage.from('documents').upload(path,file);
                if(uploadError)throw new Error('PDF yüklenemedi: '+uploadError.message);
                const {data:urlData}=supabase.storage.from('documents').getPublicUrl(path);
                const publicUrl=urlData?.publicUrl;
                if(!publicUrl)throw new Error('PDF adresi alınamadı.');
                const {error:docErr}=await supabase.from('transaction_documents').insert({
                    transaction_id:targetId,document_name:file.name,document_url:publicUrl,
                    document_type:'application/pdf',document_designation:childType?.document_designation_default||childType?.name||'Dava PDF'
                });
                if(docErr)throw new Error('PDF işlem bağlantısı oluşturulamadı: '+docErr.message);
            }
            showNotification(`Dava geçmişi kaydedildi${files.length?` (${files.length} PDF)`:''}. Görev ve müvekkil e-postası oluşturulmadı.`,'success');
            this.uploadedFilesMap.set('manual-indexing-pane',[]);
            this.renderUploadedFilesList('manual-indexing-pane');
            const dateInput=document.getElementById('manualTransactionDeliveryDate'); if(dateInput)dateInput.value='';
            const noteEl=document.getElementById('manualTransactionNotes');if(noteEl)noteEl.value='';
            // Seçimi koruyarak arka arkaya geçmiş işlem girilmesini kolaylaştır.
            const {data:txData,error:reloadError}=await supabase.from('transactions')
                .select('id,ip_record_id,transaction_type_id,transaction_hierarchy,parent_id,description,transaction_date,created_at,task_id,suit_context')
                .eq('ip_record_id',id).order('transaction_date',{ascending:false});
            if(!reloadError && this.selectedRecordManual?.id===id){
                this.currentRecordTransactions=(txData||[]).map(t=>({...t,type:String(t.transaction_type_id),transactionHierarchy:t.transaction_hierarchy,timestamp:txDate(t)}));
                this.updateManualParentOptions();
            }
        }catch(error){
            console.error('[MANUAL LITIGATION] Kayıt hatası',error);
            const extra=created.length?` Kaydedilmiş transaction ID: ${created.join(', ')}. Tekrar kaydetmeden önce geçmişi kontrol edin.`:'';
            showNotification(`Manuel dava kaydı tamamlanamadı: ${error.message}.${extra}`,'error');
        }finally{
            button.dataset.busy='';button.innerHTML=oldHtml;this.checkFormCompleteness();
        }
    };
}
