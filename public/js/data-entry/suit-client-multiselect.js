/**
 * IPGate / Dava portföyü - çoklu müvekkil, mevcut Kayıt Formu.
 * Eklendiği sayfada yalnız ipType=suit iken aktiftir.
 * Müvekkiller = kayıtlı persons içeren dava taraflarından işaretlenenler.
 * İlk işaretlenen otomatik birincil olur; radyo ile değiştirilebilir.
 * DB yazımları public.sync_suit_clients RPC ile atomik gerçekleştirilir.
 */
import { supabase } from '../../supabase-config.js';
import { SuitStrategy } from './strategies.js';

const editMode = !!new URLSearchParams(location.search).get('editSuit');
const $ = id => document.getElementById(id);
const clean = value => String(value ?? '').trim();
const validRole = role => role === 'davaci' || role === 'davali';
const keyFor = (role, personId) => `${role}|${personId}`;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

class SuitClientSelector {
    constructor() {
        this.selected = new Map();
        this.primaryKey = null;
        this.names = new Map();
        this.initializedExisting = !editMode;
        this.blockingError = null;
        this.legacy = null;
        this.lastRole = '';
        this.renderPending = false;
        this.lastRoot = null;
        this.watching = false;
        this.initialized = false;
    }

    active() { return $('ipTypeSelect')?.value === 'suit'; }
    parties() {
        const state = window.suitPartiesData;
        const all = new Map();
        for (const role of ['davaci', 'davali']) {
            for (const person of state?.[role] || []) {
                const id = person?.id && person.id !== 'free_text' ? String(person.id) : null;
                if (!id) continue;
                const key = keyFor(role, id);
                all.set(key, {person_id: id, role, name: clean(person.name) || this.names.get(id) || id});
            }
        }
        return all;
    }

    normalize() {
        if (!this.initializedExisting) return;
        const current = this.parties();
        const previous = new Map(this.selected);
        this.selected.clear();
        for (const [key, client] of previous) {
            if (current.has(key)) {
                this.selected.set(key, current.get(key));
            } else {
                // Bir taraf davacıdan davalıya taşındıysa, aynı kişi ile ilişkiyi sürdür.
                const alternative = [...current.values()].filter(p => p.person_id === client.person_id);
                if (alternative.length === 1) this.selected.set(keyFor(alternative[0].role, client.person_id), alternative[0]);
            }
        }
        if (!this.selected.has(this.primaryKey)) {
            const previousPrimary = previous.get(this.primaryKey);
            const moved = previousPrimary && [...this.selected.keys()].find(k => this.selected.get(k)?.person_id === previousPrimary.person_id);
            this.primaryKey = moved || this.selected.keys().next().value || null;
        }
    }

    choose(key, checked) {
        const party = this.parties().get(key);
        if (!party) return;
        if (checked) {
            this.selected.set(key, party);
            if (!this.primaryKey) this.primaryKey = key;
        } else {
            this.selected.delete(key);
            if (this.primaryKey === key) this.primaryKey = this.selected.keys().next().value || null;
        }
        this.legacy = null;
        this.scheduleRender();
    }

    makeBadge(role, index, person, row) {
        const id = person?.id && person.id !== 'free_text' ? String(person.id) : null;
        if (!id || !row) return;
        const key = keyFor(role, id);
        row.classList.add('ipgate-party-person-row');
        row.dataset.ipgateClientKey = key;
        let actions = row.querySelector('.ipgate-client-row-actions');
        if (!actions) {
            actions = document.createElement('span');
            actions.className = 'ipgate-client-row-actions';
            const remove = row.querySelector('.suit-party-remove-btn');
            if (remove) remove.before(actions);
            else row.append(actions);
            const label = document.createElement('label');
            label.className = 'ipgate-client-check';
            const check = document.createElement('input');
            check.type = 'checkbox'; check.className = 'ipgate-client-select';
            check.setAttribute('aria-label', `${person.name} müvekkilimiz`);
            check.addEventListener('change', () => this.choose(key, check.checked));
            label.append(check, document.createTextNode(' Müvekkilimiz'));
            const radioLabel = document.createElement('label');
            radioLabel.className = 'ipgate-client-primary-label';
            const radio = document.createElement('input');
            radio.type = 'radio'; radio.name = 'ipgateSuitPrimary';
            radio.className = 'ipgate-client-primary';
            radio.setAttribute('aria-label', `${person.name} birincil müvekkil`);
            radio.addEventListener('change', () => {
                if (!this.selected.has(key)) this.selected.set(key, party);
                this.primaryKey = key; this.legacy = null; this.scheduleRender();
            });
            radioLabel.append(radio, document.createTextNode(' Birincil'));
            actions.append(label, radioLabel);
        }
        const check = actions.querySelector('.ipgate-client-select');
        const radio = actions.querySelector('.ipgate-client-primary');
        if (check) check.checked = this.selected.has(key);
        if (radio) {
            radio.checked = this.primaryKey === key;
            radio.disabled = !this.selected.has(key);
        }
        row.classList.toggle('ipgate-client-selected', this.selected.has(key));
    }

    ensurePanel() {
        const card = $('clientSection');
        if (!card) return;
        const oldSearch = $('suitClientSearch')?.closest('.form-group');
        if (oldSearch) oldSearch.style.display = 'none';
        const oldSelected = $('selectedSuitClient');
        if (oldSelected) oldSelected.style.display = 'none';
        const role = $('clientRole');
        if (role) {
            role.disabled = false;
            const label = card.querySelector('label[for="clientRole"]');
            if (label) label.textContent = 'Birincil müvekkilin dava sıfatı';
        }
        const obsolete = $('ipgatePrimarySuitClient')?.closest('.form-group');
        if (obsolete) obsolete.style.display = 'none';
        if (!$('ipgateMultiClientInfo')) {
            const box = document.createElement('div');
            box.id = 'ipgateMultiClientInfo';
            box.className = 'ipgate-client-info';
            box.innerHTML = '<strong>Birden fazla müvekkil:</strong> Aşağıdaki Davacılar/Davalılar listesindeki kayıtlı kişilerin yanından <b>Müvekkilimiz</b> kutusunu işaretleyin. İlk işaretlediğiniz otomatik birincil olur. İsterseniz <b>Birincil</b> seçeneğiyle değiştirebilirsiniz.';
            (card.querySelector('.card-body-custom') || card).prepend(box);
            const summary = document.createElement('div');
            summary.id = 'ipgateMultiClientSummary';
            summary.className = 'ipgate-client-summary';
            (card.querySelector('.card-body-custom') || card).append(summary);
        }
    }

    scheduleRender() {
        if (this.renderPending) return;
        this.renderPending = true;
        queueMicrotask(() => { this.renderPending = false; this.render(); });
    }

    render() {
        if (!this.active()) return;
        this.ensurePanel();
        this.normalize();
        const state = window.suitPartiesData;
        for (const [role, containerId] of [['davaci','plaintiffsContainer'],['davali','defendantsContainer']]) {
            const container = $(containerId);
            (state?.[role] || []).forEach((person, index) => {
                const row = [...(container?.children || [])].find(el => el.querySelector?.(`.suit-party-remove-btn[data-role="${role}"][data-index="${index}"]`));
                this.makeBadge(role, index, person, row);
            });
        }
        const p = this.selected.get(this.primaryKey);
        const role = $('clientRole');
        if (role && p && role.value !== p.role) role.value = p.role;
        const summary = $('ipgateMultiClientSummary');
        if (summary) {
            if (p) {
                summary.textContent = `${this.selected.size} müvekkil seçili. Birincil: ${p.name} (${p.role === 'davaci' ? 'Davacı' : 'Davalı'}).`;
            } else if (this.legacy) {
                summary.textContent = `Mevcut birincil müvekkil: ${this.legacy.name}. Müvekkili değiştirmek için kişiyi taraf listesine ekleyip işaretleyin.`;
            } else {
                summary.textContent = 'Henüz müvekkil seçilmedi. İlk işaretlenen otomatik birincil olacaktır.';
            }
        }
    }

    movePrimaryTo(role) {
        if (!validRole(role) || !this.primaryKey || !this.selected.has(this.primaryKey)) return;
        const old = this.selected.get(this.primaryKey);
        if (old.role === role) return;
        const state = window.suitPartiesData;
        if (!state?.[old.role] || !state?.[role]) return;
        const i = state[old.role].findIndex(p => String(p.id) === old.person_id);
        if (i === -1) return;
        const moved = state[old.role].splice(i,1)[0];
        if (!state[role].some(p => String(p.id) === old.person_id)) state[role].push(moved);
        this.selected.delete(this.primaryKey);
        const nextKey = keyFor(role, old.person_id);
        this.selected.set(nextKey, {...old,role});
        this.primaryKey = nextKey;
        // Dava tarafı seçim nesnesini değiştirmeden, yalnızca ilgili listeyi tekrar çiz.
        for (const [r, containerId] of [['davaci','plaintiffsContainer'],['davali','defendantsContainer']]) {
            const container = $(containerId);
            if (!container) continue;
            container.replaceChildren();
            if (!state[r].length) {
                const empty = document.createElement('div');
                empty.className = 'text-muted small text-center mt-2';
                empty.textContent = 'Henüz taraf eklenmedi.';
                container.append(empty);
            }
            state[r].forEach((person, index) => {
                const row = document.createElement('div');
                row.className = 'd-flex justify-content-between align-items-center p-1 mb-1 border-bottom bg-white';
                const name = document.createElement('span');
                name.className = 'small font-weight-bold';
                name.textContent = person.name;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'btn btn-xs text-danger border-0 suit-party-remove-btn';
                remove.dataset.role = r;
                remove.dataset.index = index;
                remove.textContent = '×';
                row.append(name,remove);
                container.append(row);
            });
        }
        this.scheduleRender();
    }

    getSelection() {
        this.normalize();
        if (this.blockingError) throw new Error(this.blockingError);
        const rows = [...this.selected.values()].map(p => ({person_id:p.person_id,role:p.role}));
        if (!rows.length || !this.primaryKey || !this.selected.has(this.primaryKey)) {
            throw new Error('En az bir kayıtlı müvekkili işaretleyin. Birincil müvekkil otomatik atanacaktır.');
        }
        const p = this.selected.get(this.primaryKey);
        return {members:rows, primary:{person_id:p.person_id,role:p.role}, name:p.name};
    }

    async initExisting(suit) {
        this.blockingError = null;
        const {data,error} = await supabase.from('suit_clients')
            .select('person_id,role,is_primary').eq('suit_id',suit.id);
        if (error) {
            this.blockingError = 'suit_clients tablosu okunamadı. Önce çoklu müvekkil migrasyonunu uygulayın: ' + error.message;
            this.initializedExisting = true;
            this.scheduleRender();
            throw new Error(this.blockingError);
        }
        this.selected.clear();
        this.primaryKey = null;
        for (const row of data || []) {
            const personId = clean(row.person_id);
            if (!personId || !validRole(row.role)) continue;
            const key = keyFor(row.role,personId);
            const party = this.parties().get(key);
            if (party) {
                this.selected.set(key,party);
                if (row.is_primary) this.primaryKey = key;
            }
        }
        if (suit.client_id && validRole(suit.client_role)) {
            const k = keyFor(suit.client_role,suit.client_id);
            const party = this.parties().get(k);
            if (party) {
                if (!this.selected.has(k)) this.selected.set(k,party);
                if (!this.primaryKey) this.primaryKey = k;
            } else {
                this.legacy = {id:suit.client_id, role:suit.client_role, name:suit.client_id};
            }
        }
        this.initializedExisting = true;
        if (!this.primaryKey && this.selected.size) this.primaryKey = this.selected.keys().next().value;
        this.scheduleRender();
    }

    install() {
        if (this.initialized) return;
        this.initialized = true;
        const style = document.createElement('style');
        style.id = 'ipgateSuitClientsStyle';
        style.textContent = `
        .ipgate-client-info {background:#f0f5ff;border:1px solid #d5e2ff;border-radius:8px;padding:12px 14px;font-size:13px;color:#24476d;line-height:1.5;margin:0 0 15px;}
        .ipgate-client-summary {background:#f3faf6;border:1px solid #cbe9d6;padding:11px 13px;border-radius:8px;color:#185d3c;font-size:13px;margin-top:14px;font-weight:600;}
        .ipgate-party-person-row {gap:6px;flex-wrap:wrap;}
        .ipgate-party-person-row.ipgate-client-selected {background:#ecf7f2 !important;border-radius:5px;}
        .ipgate-party-person-row > span:first-child {flex:1 1 150px;}
        .ipgate-client-row-actions {display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;margin-right:4px;}
        .ipgate-client-row-actions label {display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap;margin:0;}
        .ipgate-client-check {color:#0b6545;}
        .ipgate-client-primary-label {color:#244a8a;}
        .ipgate-client-row-actions input {accent-color:#195da8;cursor:pointer;}
        .ipgate-client-primary-label:has(input:disabled) {opacity:.38;cursor:default;}
        `;
        document.head.append(style);
        document.addEventListener('change',e => {
            if (e.target?.id !== 'clientRole' || !this.active()) return;
            if (this.primaryKey) this.movePrimaryTo(e.target.value);
        });
        const observer = new MutationObserver(mutations => {
            if (!this.active()) return;
            const changed = mutations.some(m => {
                if (!m.addedNodes.length && !m.removedNodes.length) return false;
                const target = m.target instanceof Element ? m.target : m.target.parentElement;
                if (target?.closest?.('#plaintiffsContainer,#defendantsContainer')) return true;
                return [...m.addedNodes].some(node => node.nodeType === 1 &&
                    (['clientSection','suitPartySelector'].includes(node.id) ||
                     !!node.querySelector?.('#clientSection,#suitPartySelector')));
            });
            if (changed) this.scheduleRender();
        });
        observer.observe(document.body,{childList:true,subtree:true});
        this.scheduleRender();
    }
}

const controller = new SuitClientSelector();
window.ipgateSuitClients = controller;
const run = () => controller.install();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',run,{once:true});
else run();

// Dava oluşturma akışını koruyarak öncelikli müvekkili mevcut native alanlara aktar.
const collect = SuitStrategy.prototype.collectData;
SuitStrategy.prototype.collectData = function(ctx) {
    const data = collect.call(this,ctx);
    if (ctx?.editingRecordId || editMode) return data;
    try {
        const choice = controller.getSelection();
        data.clientId = choice.primary.person_id;
        data.clientRole = choice.primary.role;
        data.clientName = choice.name;
    } catch (error) {
        data.clientId = null;
        data.__clientSelectionError = error.message;
    }
    return data;
};
const baseValidate = SuitStrategy.prototype.validate;
SuitStrategy.prototype.validate = function(data, ctx) {
    if (data.__clientSelectionError) return data.__clientSelectionError;
    return baseValidate.call(this, data, ctx);
};
const baseSave = SuitStrategy.prototype.save;
SuitStrategy.prototype.save = async function(data) {
    if (data.id || editMode) return baseSave.call(this,data);
    const choice = controller.getSelection();
    // Migration eksikse dava/transaction oluşturmadan dur.
    const {error:probeError} = await supabase.from('suit_clients').select('id').limit(1);
    if (probeError) throw new Error('Çoklu müvekkil altyapısı hazır değil: '+probeError.message);
    const suitId = await baseSave.call(this,data);
    const {error} = await supabase.rpc('sync_suit_clients',{
        p_suit_id:String(suitId),
        p_members:choice.members,
        p_primary_person_id:choice.primary.person_id,
        p_primary_role:choice.primary.role
    });
    if (error) throw new Error(`Dava ${suitId} oluşturuldu, ancak müvekkil ilişkileri kaydedilemedi: ${error.message}. Tekrar yeni dava oluşturmayın; bu davayı Düzenle üzerinden tamamlayın.`);
    return suitId;
};
