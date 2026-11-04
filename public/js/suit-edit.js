// IPGate - Mevcut dava kaydi duzenleme
// Yalniz suits ve istenen suit_parties satirlarini gunceller.
// transactions, tasks, suits.ip_record_id, suit_documents HICBIR zaman degistirilmez.
import { supabase } from '../supabase-config.js';
import { STATUSES } from '../utils.js';

const params = new URLSearchParams(window.location.search);
const suitId = params.get('id');
const el = id => document.getElementById(id);
let suit = null;
let parties = [];
let persons = new Map();
let ready = false;
let querySeq = 0;

function notice(message, kind = 'error') {
    const area = el('notice');
    area.textContent = message;
    area.className = kind;
    area.style.display = 'block';
}
function textValue(id) { return (el(id)?.value || '').trim(); }
function dateInput(value) {
    if (!value) return '';
    const iso = String(value).match(/^\d{4}-\d{2}-\d{2}/);
    return iso ? iso[0] : '';
}
function nameOf(p) {
    return persons.get(String(p.person_id || '')) || p.free_text_name || '(İsimsiz taraf)';
}
function ensurePartyLoaded(raw) {
    return {
        id: raw.id || null,
        localId: raw.id ? String(raw.id) : crypto.randomUUID(),
        role: raw.role === 'davali' ? 'davali' : 'davaci',
        person_id: raw.person_id ? String(raw.person_id) : null,
        free_text_name: raw.free_text_name || null,
        removed: false,
        persisted: !!raw.id
    };
}
function selectedClientParty() {
    const selected = document.querySelector('input[name="primaryClient"]:checked');
    return selected ? parties.find(p => p.localId === selected.value && !p.removed) || null : null;
}

function renderParties() {
    for (const [role, containerId] of [['davaci','plaintiffs'], ['davali','defendants']]) {
        const container = el(containerId);
        container.replaceChildren();
        const matches = parties.filter(p => !p.removed && p.role === role);
        if (!matches.length) {
            const empty = document.createElement('p');
            empty.className = 'muted';
            empty.textContent = 'Henüz taraf yok.';
            container.appendChild(empty);
        }
        for (const party of matches) {
            const row = document.createElement('div');
            row.className = 'party-row';
            const person = document.createElement('div');
            person.className = 'person';
            person.textContent = nameOf(party);
            const help = document.createElement('small');
            help.textContent = party.person_id ? 'Kayıtlı kişi' : 'Serbest taraf';
            person.appendChild(help);
            row.appendChild(person);
            if (party.person_id) {
                const label = document.createElement('label');
                label.className = 'primary-label';
                label.title = 'Bu davanın birincil müvekkili';
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = 'primaryClient';
                radio.value = party.localId;
                radio.checked = party.localId === window.__selectedClientPartyId ||
                    (!window.__selectedClientPartyId &&
                    String(suit?.client_id || '') === party.person_id &&
                    String(suit?.client_role || '') === role);
                radio.addEventListener('change', () => {
                    window.__selectedClientPartyId = radio.value;
                });
                label.appendChild(radio);
                label.append('Müvekkil');
                row.appendChild(label);
            }
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.title = 'Taraf listesinden çıkar';
            remove.textContent = '✕';
            remove.addEventListener('click', () => {
                if (window.__selectedClientPartyId === party.localId) {
                    window.__selectedClientPartyId = null;
                }
                party.removed = true;
                renderParties();
            });
            row.appendChild(remove);
            container.appendChild(row);
        }
    }
}

function addParty(personId, name) {
    const role = el('partyRole').value;
    const normalizedId = personId ? String(personId) : null;
    const normalizedName = String(name || '').trim();
    if (!normalizedId && !normalizedName) return;
    const duplicate = parties.some(p => !p.removed && p.role === role &&
        (normalizedId ? p.person_id === normalizedId :
        !p.person_id && String(p.free_text_name || '').toLocaleLowerCase('tr-TR') === normalizedName.toLocaleLowerCase('tr-TR')));
    if (duplicate) { notice('Bu kişi seçilen tarafta zaten mevcut.', 'info'); return; }
    parties.push(ensurePartyLoaded({role,person_id:normalizedId,free_text_name:normalizedName || null}));
    if (normalizedId) persons.set(normalizedId, normalizedName);
    renderParties();
    el('personSearch').value = '';
    el('results').hidden = true;
}

async function searchPersons(query) {
    const seq = ++querySeq;
    const results = el('results');
    results.replaceChildren();
    if (query.length < 2) { results.hidden = true; return; }
    const { data, error } = await supabase
        .from('persons').select('id, name')
        .ilike('name', `%${query.replace(/[%,]/g, '')}%`).limit(12);
    if (seq !== querySeq) return;
    if (error) { notice('Kişi araması başarısız: '+error.message); return; }
    results.hidden = false;
    for (const item of data || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = item.name || String(item.id);
        button.addEventListener('click', () => addParty(item.id, item.name));
        results.appendChild(button);
    }
    if (!(data || []).length) {
        const msg = document.createElement('p');
        msg.className = 'muted';
        msg.style.padding = '8px';
        msg.textContent = 'Kayıtlı kişi bulunamadı.';
        results.appendChild(msg);
    }
}

async function load() {
    el('saveBtn').disabled = true;
    window.__selectedClientPartyId = null;
    if (!suitId) { notice('Dava ID belirtilmedi.'); return; }
    el('detailLink').href = `suit-detail.html?id=${encodeURIComponent(suitId)}`;
    try {
        const {data:auth} = await supabase.auth.getUser();
        if (!auth?.user) throw new Error('Oturum bulunamadı. Önce IPGate üzerinden giriş yapın.');
        const [{data:suitData,error:suitError},{data:partyData,error:partyError}] = await Promise.all([
            supabase.from('suits').select('*').eq('id',suitId).maybeSingle(),
            supabase.from('suit_parties').select('*').eq('suit_id',suitId).order('created_at',{ascending:true})
        ]);
        if (suitError) throw suitError;
        if (partyError) throw partyError;
        if (!suitData) throw new Error('Dava kaydı bulunamadı veya okuma yetkiniz yok.');
        suit=suitData;
        parties=(partyData || []).map(ensurePartyLoaded);
        const ids=[...new Set([
            ...parties.map(p=>p.person_id).filter(Boolean),
            suit.client_id
        ].filter(Boolean).map(String))];
        if (ids.length) {
            const {data:names,error:namesError}=await supabase.from('persons').select('id,name').in('id',ids);
            if (namesError) throw namesError;
            for (const p of names || []) persons.set(String(p.id),p.name || String(p.id));
        }
        el('title').value=suit.title || '';
        el('fileNo').value=suit.file_no || '';
        el('court').value=suit.court_name || '';
        el('opened').value=dateInput(suit.opening_date);
        el('description').value=suit.description || '';
        el('suitType').value=suit.suit_type || '';
        el('asset').value=suit.ip_record_id || '(Bağlı varlık yok)';
        el('subtitle').textContent=`${suit.file_no || 'Dosya no yok'} · ${suit.court_name || 'Mahkeme tanımsız'}`;
        const statusSelect=el('status');
        const options=(STATUSES?.litigation || []);
        for (const o of options) {
            const option=document.createElement('option');
            option.value=o.value;
            option.textContent=o.text || o.value;
            statusSelect.appendChild(option);
        }
        if (suit.status && !options.some(o=>o.value===suit.status)) {
            const extra=document.createElement('option');
            extra.value=suit.status;
            extra.textContent=suit.status+' (mevcut değer)';
            statusSelect.appendChild(extra);
        }
        statusSelect.value=suit.status || 'continue';
        if (suit.client_id && !parties.some(p=>p.person_id===String(suit.client_id) && p.role===suit.client_role)) {
            notice(`Bu davanın birincil müvekkili (${persons.get(String(suit.client_id)) || suit.client_id}) taraf listesinde yer almıyor. Mevcut bağlantı korunur; değiştirmek isterseniz müvekkili ilgili tarafa ekleyin.`, 'info');
        }
        renderParties();
        ready=true;
        el('saveBtn').disabled=false;
    } catch(e) {
        console.error('[SUIT EDIT] Yükleme başarısız:',e);
        notice('Dava yüklenemedi: '+(e?.message || String(e)));
    }
}

async function save(event) {
    event.preventDefault();
    if (!ready) return;
    const title=textValue('title'), court=textValue('court');
    if (!title || !court) { notice('Dava başlığı ve mahkeme zorunludur.'); return; }
    const primary=selectedClientParty();
    const stillHasOriginal=parties.some(p=>!p.removed && p.person_id===String(suit.client_id||'') && p.role===suit.client_role);
    if (!primary && suit.client_id && !stillHasOriginal) {
        notice('Birincil müvekkil taraf listesinden çıkarılmış. Lütfen kayıtlı bir tarafı birincil müvekkil olarak seçin.');
        return;
    }
    const saveBtn=el('saveBtn');
    saveBtn.disabled=true;
    saveBtn.textContent='Kaydediliyor…';
    try {
        const payload={
            title,
            file_no:textValue('fileNo') || null,
            court_name:court,
            description:el('description').value || '',
            status:el('status').value,
            opening_date:el('opened').value ? new Date(el('opened').value+'T12:00:00Z').toISOString() : null,
            updated_at:new Date().toISOString()
        };
        if (primary) {
            payload.client_id=primary.person_id;
            payload.client_role=primary.role;
        }
        // suit_type, ip_record_id ve transaction_type_id AYNEN KORUNUR.
        const {error:updateError}=await supabase.from('suits').update(payload).eq('id',String(suitId));
        if (updateError) throw new Error('Dava ana kaydı güncellenemedi: '+updateError.message);

        const toAdd=parties.filter(p=>!p.removed && !p.persisted);
        const toDelete=parties.filter(p=>p.removed && p.persisted);
        // Önce INSERT, sonra DELETE. Böylece ekleme başarısızsa mevcut taraflar silinmez.
        if (toAdd.length) {
            const inserts=toAdd.map(p=>({
                suit_id:String(suitId),role:p.role,
                person_id:p.person_id || null,
                free_text_name:p.free_text_name || (p.person_id ? persons.get(p.person_id) : null) || null
            }));
            const {error:addError}=await supabase.from('suit_parties').insert(inserts);
            if (addError) throw new Error('Dava bilgileri kaydedildi ancak yeni taraf eklenemedi: '+addError.message);
        }
        if (toDelete.length) {
            const ids=toDelete.map(p=>p.id);
            const {error:deleteError}=await supabase.from('suit_parties').delete().eq('suit_id',String(suitId)).in('id',ids);
            if (deleteError) throw new Error('Dava bilgileri kaydedildi ancak çıkarılan taraflar silinemedi: '+deleteError.message);
        }
        try { localStorage.setItem('crossTabUpdatedRecordId',String(suitId)); }
        catch (err) { console.warn('Liste otomatik yenileme bildirimi gönderilemedi:',err); }
        notice('Dava kaydı ve taraflar başarıyla güncellendi. İşlem geçmişine ve belgelere dokunulmadı.', 'success');
        // Listeyi ve parti state'ini yenile; ikinci Kaydet'te ayni kisiler tekrar eklenmesin.
        ready=false;
        await load();
        notice('Dava kaydı başarıyla güncellendi.', 'success');
    } catch(e) {
        console.error('[SUIT EDIT] Kaydetme hatası:',e);
        notice(e?.message || String(e));
    } finally {
        saveBtn.disabled=!ready;
        saveBtn.textContent='Değişiklikleri Kaydet';
    }
}

el('personSearch').addEventListener('input',e=>searchPersons(e.target.value.trim()));
el('addFree').addEventListener('click',()=>{
    const name=prompt('Eklenecek davacı/davalının adı veya unvanı:');
    if (name?.trim()) addParty(null,name.trim());
});
el('suitForm').addEventListener('submit',save);
load();
