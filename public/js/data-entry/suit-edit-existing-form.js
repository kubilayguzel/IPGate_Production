/**
 * IPGate / Davalar - mevcut Portföy Kaydı formuyla düzenleme.
 * `?editSuit=<uuid>` dışında etkin değildir; yeni kayıt akışına dokunmaz.
 * Orijinal DataEntryModule sınıfını, SuitStrategy kodunu ve form alanlarını kullanır.
 * Sadece düzenleme Kaydet düğmesini yakalayarak MEVCUT suits/suit_parties kayıtlarını
 * günceller; yeni suit, transaction, task veya belge oluşturmaz.
 *
 * Sürüm 2026-11-04. Çoklu müvekkiller public.sync_suit_clients ile kaydedilir.
 */
import { supabase, waitForAuthUser } from '../../supabase-config.js';

const suitId = new URLSearchParams(location.search).get('editSuit');
if (suitId) {
    const $ = id => document.getElementById(id);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
    const normalized = value => clean(value).toLocaleLowerCase('tr-TR');
    const dateTR = value => {
        const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
        return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
    };
    const parseDate = value => {
        const raw = clean(value);
        if (!raw) return null;
        const m = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/) ||
            raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) throw new Error('Dava açılış tarihi gg.aa.yyyy biçiminde olmalıdır.');
        const iso = m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`;
        const dt = new Date(iso + 'T12:00:00Z');
        if (!Number.isFinite(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) {
            throw new Error('Geçersiz dava açılış tarihi.');
        }
        return dt.toISOString();
    };

    let originalSuit = null;
    let originalParties = [];
    const personNames = new Map();
    let clientId = null;
    let clientRole = null;
    let clientName = '';
    let assetId = null;
    let assetChanged = false;
    let hydrated = false;
    let saving = false;
    let partyObserver = null;

    function inform(message, type = 'info') {
        let box = $('ipgateSuitEditNotice');
        if (!box) {
            box = document.createElement('div');
            box.id = 'ipgateSuitEditNotice';
            box.setAttribute('role', 'status');
            box.style.cssText = 'border-radius:9px;padding:12px 16px;margin:12px 0;line-height:1.45;font-size:13px;';
            const header = document.querySelector('.page-header') || $('portfolioForm');
            header?.insertAdjacentElement('afterend', box);
        }
        const good = type === 'success';
        const bad = type === 'error';
        box.style.background = bad ? '#fff0f0' : good ? '#edf9f0' : '#eef4ff';
        box.style.border = bad ? '1px solid #e9b6b6' : good ? '1px solid #b8e3c3' : '1px solid #c9d9ef';
        box.style.color = bad ? '#8a1c1c' : good ? '#166534' : '#254c82';
        box.textContent = message;
    }

    // DataEntryModule'nin asenkron açılışını ve event listener'larını bekle.
    async function setupOriginalForm() {
        const ipType = $('ipTypeSelect');
        const taskSelect = $('specificTaskType');
        if (!ipType || !taskSelect) throw new Error('Portföy kayıt formu bulunamadı.');
        for (let i = 0; i < 90; i++) {
            if (ipType.value !== 'suit' || !$('clientSection') || taskSelect.options.length < 2) {
                ipType.value = 'suit';
                ipType.dispatchEvent(new Event('change', { bubbles: true }));
            }
            await sleep(170);
            if ($('clientSection') && taskSelect.options.length >= 2) return;
        }
        throw new Error('Dava kayıt formu hazırlanamadı. Sayfayı yeniden açın.');
    }

    function pickPartyKey(role, personId, name) {
        return personId ? `${role}|p:${String(personId)}` : `${role}|n:${normalized(name)}`;
    }

    function currentParties() {
        const state = window.suitPartiesData;
        if (!state || !Array.isArray(state.davaci) || !Array.isArray(state.davali)) {
            throw new Error('Dava tarafı seçicisi henüz hazır değil.');
        }
        const list = [];
        for (const role of ['davaci', 'davali']) {
            for (const party of state[role]) {
                const id = party.id && party.id !== 'free_text' ? String(party.id) : null;
                const name = clean(party.name);
                if (id || name) list.push({ role, person_id: id, free_text_name: name || null });
            }
        }
        return list;
    }

    function renderPartyList(role) {
        // DataEntryModule'nin SuitPartySelector'ı ile AYNI canlı dizi nesnesi.
        // Böylece normal '+' / Enter / X davranışı korunur.
        const container = role === 'davaci' ? $('plaintiffsContainer') : $('defendantsContainer');
        const source = window.suitPartiesData?.[role] || [];
        if (!container) return;
        container.replaceChildren();
        if (!source.length) {
            const empty = document.createElement('div');
            empty.className = 'text-muted small text-center mt-2';
            empty.textContent = 'Henüz taraf eklenmedi.';
            container.appendChild(empty);
            return;
        }
        source.forEach((party, index) => {
            const row = document.createElement('div');
            row.className = 'd-flex justify-content-between align-items-center p-1 mb-1 border-bottom bg-white';
            const name = document.createElement('span');
            name.className = 'small font-weight-bold';
            name.textContent = party.name;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'btn btn-xs text-danger border-0 suit-party-remove-btn';
            remove.dataset.role = role;
            remove.dataset.index = String(index);
            remove.setAttribute('aria-label', `${party.name} tarafını kaldır`);
            remove.textContent = '×';
            row.append(name, remove);
            container.appendChild(row);
        });
    }

    function clientKey(id, role) { return `${role || ''}|${id || ''}`; }

    function refreshPrimaryOptions() {
        const select = $('ipgatePrimarySuitClient');
        if (!select) return;
        const currentKey = clientKey(clientId, clientRole);
        const options = [];
        const added = new Set();
        for (const p of currentParties()) {
            if (!p.person_id) continue;
            const key = clientKey(p.person_id, p.role);
            if (added.has(key)) continue;
            added.add(key);
            options.push({ key, name: personNames.get(p.person_id) || p.free_text_name || p.person_id, role: p.role });
        }
        if (clientId && !added.has(currentKey)) {
            options.unshift({ key: currentKey, name: clientName || personNames.get(clientId) || clientId, role: clientRole, legacy: true });
        }
        select.replaceChildren();
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '-- Birincil müvekkili seçin --';
        select.appendChild(blank);
        for (const item of options) {
            const option = document.createElement('option');
            option.value = item.key;
            option.textContent = `${item.name} (${item.role === 'davaci' ? 'Davacı' : 'Davalı'})${item.legacy ? ' – taraf listesinde yok' : ''}`;
            select.appendChild(option);
        }
        select.value = currentKey && options.some(p => p.key === currentKey) ? currentKey : '';
    }

    function showClientSelected(name) {
        const holder = $('selectedSuitClient');
        const label = $('selectedSuitClientName');
        const search = $('suitClientSearch');
        if (label) label.textContent = name || '';
        if (holder) {
            holder.classList.toggle('d-none', !name);
            holder.classList.toggle('d-flex', !!name);
            holder.style.display = name ? 'flex' : 'none';
        }
        if (search) search.style.display = name ? 'none' : 'block';
    }

    async function loadNameMap(rows, primary) {
        const ids = [...new Set([...rows.map(p => p.person_id), primary].filter(Boolean).map(String))];
        if (!ids.length) return;
        const { data, error } = await supabase.from('persons').select('id,name').in('id', ids);
        if (error) throw new Error('Dava tarafı kişi adları yüklenemedi: ' + error.message);
        for (const p of data || []) personNames.set(String(p.id), p.name || String(p.id));
    }

    function hydrateParties(rows) {
        const state = window.suitPartiesData;
        if (!state) throw new Error('Dava tarafları yüklenemedi.');
        for (const role of ['davaci', 'davali']) {
            state[role].splice(0);
            for (const p of rows.filter(p => p.role === role)) {
                const id = p.person_id ? String(p.person_id) : 'free_text';
                const name = clean(personNames.get(id) || p.free_text_name || id);
                if (name) state[role].push({ id, name });
            }
            renderPartyList(role);
        }
    }

    async function hydrateSubjectAsset() {
        if (!assetId) return;
        let name = `Portföy kaydı (${assetId})`, number = '-';
        try {
            const { data } = await supabase.from('portfolio_list_view')
                .select('id,brand_name,application_number,ip_type')
                .eq('id', assetId).maybeSingle();
            if (data) { name = data.brand_name || name; number = data.application_number || '-'; }
        } catch (err) { console.warn('Bağlı IP kaydı adı okunamadı:', err); }
        if ($('selectedSubjectAssetName')) $('selectedSubjectAssetName').textContent = name;
        if ($('selectedSubjectAssetType')) $('selectedSubjectAssetType').textContent = 'Mevcut IP kaydı';
        if ($('selectedSubjectAssetNumber')) $('selectedSubjectAssetNumber').textContent = number;
        $('selectedSubjectAsset')?.classList.remove('d-none');
        $('selectedSubjectAsset')?.classList.add('d-flex');
        if ($('selectedSubjectAsset')) $('selectedSubjectAsset').style.display = 'flex';
        if ($('subjectAssetSearch')) $('subjectAssetSearch').style.display = 'none';
    }

    function addEditTitleField() {
        const card = $('suitDetailsCard');
        if (!card || $('ipgateSuitTitle')) return;
        const group = document.createElement('div');
        group.className = 'form-group full-width';
        group.style.marginBottom = '16px';
        const label = document.createElement('label');
        label.className = 'form-label';
        label.htmlFor = 'ipgateSuitTitle';
        label.textContent = 'Dava Başlığı';
        const input = document.createElement('input');
        input.id = 'ipgateSuitTitle';
        input.className = 'form-input';
        input.type = 'text';
        input.required = true;
        input.value = originalSuit?.title || '';
        group.append(label, input);
        const notesGroup = document.createElement('div');
        notesGroup.className = 'form-group full-width';
        const notesLabel = document.createElement('label');
        notesLabel.className = 'form-label';
        notesLabel.htmlFor = 'suitDescription';
        notesLabel.textContent = 'Dava Açıklaması / Not';
        const notesInput = document.createElement('textarea');
        notesInput.id = 'suitDescription';
        notesInput.className = 'form-input';
        notesInput.rows = 3;
        notesInput.value = originalSuit?.description || '';
        notesGroup.append(notesLabel, notesInput);
        const body = card.querySelector('.card-body-custom') || card;
        body.prepend(notesGroup);
        body.prepend(group);
    }

    function addPrimaryPicker() {
        const card = $('clientSection');
        if (!card || $('ipgatePrimarySuitClient')) return;
        const block = document.createElement('div');
        block.className = 'form-group full-width mt-3';
        const label = document.createElement('label');
        label.htmlFor = 'ipgatePrimarySuitClient';
        label.className = 'form-label';
        label.textContent = 'Taraflar arasından birincil müvekkil (mevcut sistemde tek kişi)';
        const select = document.createElement('select');
        select.id = 'ipgatePrimarySuitClient';
        select.className = 'form-select';
        select.addEventListener('change', () => {
            if (!select.value) {
                clientId = null; clientRole = null; clientName = '';
                showClientSelected('');
                return;
            }
            const split = select.value.indexOf('|');
            clientRole = select.value.slice(0, split);
            clientId = select.value.slice(split + 1);
            clientName = personNames.get(clientId) || select.selectedOptions[0]?.textContent?.split(' (')[0] || clientId;
            if ($('clientRole')) $('clientRole').value = clientRole;
            showClientSelected(clientName);
        });
        const small = document.createElement('div');
        small.className = 'small text-muted mt-2';
        small.textContent = 'Çoklu müvekkil desteği, suit_clients veritabanı migrasyonu ve ayrı UI güncellemesiyle açılacaktır. Mevcut görevler için birincil müvekkil korunur.';
        block.append(label, select, small);
        (card.querySelector('.card-body-custom') || card).appendChild(block);
        refreshPrimaryOptions();
    }

    function hideUnsupportedFileUpload() {
        const input = $('suitDocument');
        const group = input?.closest('.form-group');
        if (group) {
            group.style.display = 'none';
            const info = document.createElement('p');
            info.className = 'small text-muted mt-3';
            info.textContent = 'Mevcut dava evrakları ve işlem geçmişi bu düzenlemede korunur. Evrak ekleme için dava detayındaki/indeksleme ekranındaki belge işlemlerini kullanın.';
            group.insertAdjacentElement('afterend', info);
        }
    }

    async function load() {
        if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(suitId)) throw new Error('Geçersiz dava kayıt ID’si.');
        await waitForAuthUser();
        const [{ data: s, error: se }, { data: p, error: pe }] = await Promise.all([
            supabase.from('suits').select('*').eq('id', suitId).maybeSingle(),
            supabase.from('suit_parties').select('*').eq('suit_id', suitId).order('created_at', { ascending: true })
        ]);
        if (se) throw new Error('Dava kaydı okunamadı: ' + se.message);
        if (pe) throw new Error('Davacı/davalı listesi okunamadı: ' + pe.message);
        if (!s) throw new Error('Dava bulunamadı veya okuma yetkiniz yok.');
        originalSuit = s;
        originalParties = p || [];
        clientId = s.client_id ? String(s.client_id) : null;
        clientRole = s.client_role || null;
        assetId = s.ip_record_id || null;
        await loadNameMap(originalParties, clientId);
        clientName = personNames.get(clientId) || clientId || '';
        await setupOriginalForm();
        const taskSel = $('specificTaskType');
        if (!s.transaction_type_id || ![...taskSel.options].some(opt => opt.value === String(s.transaction_type_id))) {
            throw new Error('Bu davanın kayıtlı spesifik iş tipi mevcut form seçeneklerinde bulunmuyor. Güvenlik nedeniyle düzenleme başlatılmadı.');
        }
        taskSel.value = String(s.transaction_type_id);
        taskSel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(40);
        if (!$('suitPartySelector') || !window.suitPartiesData) throw new Error('Dava bilgileri formu yüklenemedi.');
        const court = $('suitCourt');
        if (court) {
            const known = [...court.options].some(opt => opt.value === s.court_name);
            court.value = known ? s.court_name : 'other';
            court.dispatchEvent(new Event('change', { bubbles: true }));
            if (!known && $('customCourtInput')) {
                $('customCourtInput').value = s.court_name || '';
                $('customCourtInput').style.display = 'block';
            }
        }
        if ($('suitCaseNo')) $('suitCaseNo').value = s.file_no || '';
        if ($('suitStatusSelect')) {
            const statusSel = $('suitStatusSelect');
            if (s.status && ![...statusSel.options].some(opt => opt.value === s.status)) {
                statusSel.add(new Option(s.status + ' (mevcut)', s.status));
            }
            statusSel.value = s.status || 'continue';
        }
        if ($('suitOpeningDate')) {
            const opening = $('suitOpeningDate');
            const iso = String(s.opening_date || '').slice(0, 10);
            opening.value = dateTR(iso);
            if (opening._flatpickr && iso) opening._flatpickr.setDate(iso, true, 'Y-m-d');
        }
        if ($('clientRole')) $('clientRole').value = clientRole || '';
        showClientSelected(clientName);
        hydrateParties(originalParties);
        await hydrateSubjectAsset();
        addEditTitleField();
        if (!window.ipgateSuitClients) throw new Error('Çoklu müvekkil seçim modülü yüklenemedi.');
        await window.ipgateSuitClients.initExisting(s);
        hideUnsupportedFileUpload();
        // Düzenleme modunda müvekkil yalnızca TARAF listesinden seçilir.
        // Eski tekli arama/kişi oluşturma kontrolleri ikinci bir bağımsız seçim
        // gibi davranıp istemsiz client_id değişimine yol açmasın.
        const legacyClientSearch = $('suitClientSearch')?.closest('.form-group');
        if (legacyClientSearch) legacyClientSearch.style.display = 'none';
        if ($('clearSuitClient')) $('clearSuitClient').style.display = 'none';
        // Birincil müvekkilin Davacı/Davalı sıfatı değiştirilince ilgili kişi
        // diğer taraf grubuna taşınır; çoklu seçim modülü alanı yönetir.
        if ($('clientRole')) $('clientRole').disabled = false;
        // Mevcut transaction türü, dava ID ve ilişkili görev geçmişi değiştirilemez.
        $('ipTypeSelect').disabled = true;
        taskSel.disabled = true;
        if ($('originSelect')) $('originSelect').disabled = true;
        const title = document.querySelector('.page-title');
        if (title) title.textContent = 'Dava Portföy Kaydı Düzenle';
        const subtitle = document.querySelector('.page-subtitle');
        if (subtitle) subtitle.textContent = `${s.file_no || 'Esas no yok'} · ${s.court_name || 'Mahkeme belirtilmemiş'} — mevcut dava kayıt formu`;
        if ($('savePortfolioBtn')) $('savePortfolioBtn').textContent = 'Değişiklikleri Kaydet';
        const cancel = document.querySelector('.premium-footer-actions button[onclick]');
        if (cancel) cancel.setAttribute('onclick', "window.location.href='portfolio.html?activeTab=litigation'");
        const containers = [$('plaintiffsContainer'), $('defendantsContainer')].filter(Boolean);
        partyObserver = new MutationObserver(() => refreshPrimaryOptions());
        for (const container of containers) partyObserver.observe(container, { childList: true });
        hydrated = true;
        inform('Mevcut dava bilgileri yüklendi. Dava numarası, mahkeme, açıklama, taraflar ve birincil müvekkil bu formdan düzenlenebilir. İlgili işlemler, görevler ve belgeler korunur.');
    }

    // Sadece düzenleme modunda veri kaybını engelleyen kontrollü kayıt.
    async function save() {
        if (saving || !hydrated) return;
        let clientSelection;
        try {
            if (!window.ipgateSuitClients) throw new Error('Çoklu müvekkil seçimi yüklenemedi.');
            clientSelection = window.ipgateSuitClients.getSelection();
            clientId = clientSelection.primary.person_id;
            clientRole = clientSelection.primary.role;
            clientName = clientSelection.name;
        } catch (error) {
            inform(error.message || 'Müvekkil seçiminde hata oluştu.', 'error');
            return;
        }
        const title = clean($('ipgateSuitTitle')?.value);
        const caseNo = clean($('suitCaseNo')?.value);
        const court = $('suitCourt')?.value === 'other' ? clean($('customCourtInput')?.value) : clean($('suitCourt')?.value);
        const status = clean($('suitStatusSelect')?.value);
        if (!title || !court || !status) {
            inform('Dava başlığı, mahkeme ve durum alanları zorunludur.', 'error');
            return;
        }
        if (clientId && !clientRole) {
            inform('Birincil müvekkil için Davacı/Davalı rolü seçilmeli.', 'error');
            return;
        }
        // Var olan birincil müvekkil taraf listesinde yoksa ve kullanıcı onu
        // değiştirmediyse mevcut ilişki aynen korunur.
        if (originalSuit.client_id && !clientId) {
            inform('Birincil müvekkil boş bırakılamaz. İlgili tarafı veya mevcut müvekkili seçin.', 'error');
            return;
        }
        let opened;
        try { opened = parseDate($('suitOpeningDate')?.value); }
        catch (e) { inform(e.message, 'error'); return; }
        if (!opened && originalSuit.opening_date) {
            inform('Dava açılış tarihi boş bırakılamaz.', 'error');
            return;
        }
        // Form içinde yazılıp Enter'a basılmamış isimleri de kaybetme.
        for (const [role, inputId, buttonRole] of [
            ['davaci', 'plaintiffInput', 'davaci'], ['davali', 'defendantInput', 'davali']
        ]) {
            const input = $(inputId);
            if (clean(input?.value)) {
                // Orijinal SuitPartySelector'ın serbest giriş butonunu kullan.
                $('suitPartySelector')?.querySelector(`.suit-free-party-btn[data-role="${buttonRole}"]`)?.click();
            }
        }
        const desired = currentParties();
        const clientChanged = clientId !== (originalSuit.client_id || null) || clientRole !== (originalSuit.client_role || null);
        if (clientId && clientRole && clientChanged && !desired.some(p => p.person_id === clientId && p.role === clientRole)) {
            desired.push({ role: clientRole, person_id: clientId, free_text_name: clientName || personNames.get(clientId) || null });
        }
        const oldKeys = new Set(originalParties.filter(p => ['davaci', 'davali'].includes(p.role)).map(p => pickPartyKey(p.role,p.person_id,p.free_text_name)));
        const desiredKeys = new Set(desired.map(p => pickPartyKey(p.role,p.person_id,p.free_text_name)));
        const inserts = desired.filter(p => !oldKeys.has(pickPartyKey(p.role,p.person_id,p.free_text_name)));
        const deletions = originalParties.filter(p => ['davaci', 'davali'].includes(p.role) && !desiredKeys.has(pickPartyKey(p.role,p.person_id,p.free_text_name)));
        const btn = $('savePortfolioBtn');
        saving = true;
        if (btn) { btn.disabled = true; btn.textContent = 'Kaydediliyor…'; }
        try {
            const payload = {
                title,
                file_no: caseNo || null,
                court_name: court,
                status,
                description: $('suitDescription')?.value ?? originalSuit.description ?? '',
                updated_at: new Date().toISOString()
            };
            // Açılış günü aynıysa orijinal saat/zaman dilimi değerini koru.
            const originalDay = String(originalSuit.opening_date || '').slice(0, 10);
            const newDay = opened ? opened.slice(0, 10) : '';
            if (originalDay !== newDay) payload.opening_date = opened;
            // client_id/client_role alanları aşağıdaki atomik sync_suit_clients RPC'sinde güncellenir.
            if (assetChanged) payload.ip_record_id = assetId || null;
            // Önce eklemeler: insert başarısız olursa mevcut taraflar silinmez.
            if (inserts.length) {
                const { error } = await supabase.from('suit_parties').insert(inserts.map(p => ({
                    suit_id: suitId,
                    role: p.role,
                    person_id: p.person_id,
                    free_text_name: p.free_text_name
                })));
                if (error) throw new Error('Yeni taraflar kaydedilemedi: ' + error.message);
            }
            const { error: suitError } = await supabase.from('suits').update(payload).eq('id', suitId);
            if (suitError) throw new Error('Dava ana bilgileri güncellenemedi: ' + suitError.message);
            // Kaydedilen yeni taraflar artık mevcuttur. Çoklu müvekkil ve birincil
            // seçim, tek DB transaction'ında (RPC) tutarlı biçimde güncellenir.
            const { error: clientsError } = await supabase.rpc('sync_suit_clients', {
                p_suit_id: String(suitId),
                p_members: clientSelection.members,
                p_primary_person_id: clientSelection.primary.person_id,
                p_primary_role: clientSelection.primary.role
            });
            if (clientsError) throw new Error('Müvekkiller güncellenemedi: ' + clientsError.message);
            if (deletions.length) {
                const { error: delError } = await supabase.from('suit_parties')
                    .delete().eq('suit_id', suitId).in('id', deletions.map(p => p.id));
                if (delError) throw new Error('Dava kaydı güncellendi ancak çıkarılan taraflar silinemedi: ' + delError.message);
            }
            try { localStorage.setItem('crossTabUpdatedRecordId', suitId); }
            catch (err) { console.warn('Dava listesine yenileme bilgisi gönderilemedi:', err); }
            inform('Dava bilgileri güncellendi. İşlem geçmişi, görevler ve mevcut belgeler korunmuştur.', 'success');
            await sleep(600);
            location.href = 'portfolio.html?activeTab=litigation';
        } catch (err) {
            console.error('[IPGate same-form suit edit] Kayıt hatası:', err);
            inform('Kayıt tamamlanamadı: ' + (err?.message || String(err)) + '. Taraf eklemesi gerçekleşmiş olabilir; yeniden kaydetmeden önce sayfayı yenileyerek mevcut bilgileri kontrol edin.', 'error');
        } finally {
            saving = false;
            if (btn) { btn.disabled = false; btn.textContent = 'Değişiklikleri Kaydet'; }
        }
    }

    // Capture fazı: normal yeni dava oluşturma/transaction açma handler'ı çalışmaz.
    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('#savePortfolioBtn')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            void save();
            return;
        }
        const clientChoice = target.closest('#suitClientSearchResults [data-person-id]');
        if (clientChoice) {
            clientId = clientChoice.dataset.personId || null;
            clientName = clean(clientChoice.querySelector('strong')?.textContent || '');
            clientRole = $('clientRole')?.value || clientRole;
            if (clientId && clientName) personNames.set(clientId, clientName);
            queueMicrotask(refreshPrimaryOptions);
        }
        const assetChoice = target.closest('#subjectAssetSearchResults .search-result-item[data-id]');
        if (assetChoice) { assetId = assetChoice.dataset.id || null; assetChanged = true; }
        if (target.closest('#clearSubjectAsset')) { assetId = null; assetChanged = true; }
        if (target.closest('#clearSuitClient')) { clientId = null; clientName = ''; clientRole = null; queueMicrotask(refreshPrimaryOptions); }
    }, true);

    const startEditForm = () => {
        void load().catch(err => {
            console.error('[IPGate same-form suit edit] Açılış hatası:', err);
            inform('Dava düzenleme formu açılamadı: ' + (err?.message || String(err)), 'error');
            if ($('savePortfolioBtn')) $('savePortfolioBtn').disabled = true;
        });
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startEditForm, { once: true });
    } else {
        startEditForm();
    }
}
