import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

// TODO: Kendi URL ve Anon Key'inizi buraya girin
const supabaseUrl = 'https://kadxvkejzctwymzeyrrl.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNzg0NDgsImV4cCI6MjA4Nzc1NDQ0OH0.PFSzq8hOc14HgYwwF_ZR3v82ZzegKcoN4Vqw2wR2ZP0';

export const supabase = createClient(supabaseUrl, supabaseKey);
console.log('🚀 Supabase Motoru Başarıyla Çalıştı!');

// --- YENİ: Sınırsız ve Işık Hızında Önbellek (IndexedDB) Motoru ---
export const localCache = {
    async get(key) {
        return new Promise((resolve) => {
            const req = indexedDB.open('IPGateDB', 1);
            req.onupgradeneeded = (e) => e.target.result.createObjectStore('store');
            req.onsuccess = (e) => {
                try {
                    const db = e.target.result;
                    const tx = db.transaction('store', 'readonly');
                    const req2 = tx.objectStore('store').get(key);
                    req2.onsuccess = () => {
                        if (!req2.result) return resolve(null);
                        // Geriye dönük uyumluluk: Eğer eskiden kalma string (metin) kayıt varsa çevir, yoksa doğrudan ver!
                        if (typeof req2.result === 'string') {
                            try { resolve(JSON.parse(req2.result)); } catch(err) { resolve(null); }
                        } else {
                            resolve(req2.result);
                        }
                    };
                    req2.onerror = () => resolve(null);
                } catch(err) { resolve(null); }
            };
            req.onerror = () => resolve(null);
        });
    },
    async set(key, value) {
        return new Promise((resolve) => {
            const req = indexedDB.open('IPGateDB', 1);
            req.onupgradeneeded = (e) => e.target.result.createObjectStore('store');
            req.onsuccess = (e) => {
                try {
                    const db = e.target.result;
                    const tx = db.transaction('store', 'readwrite');
                    // 🔥 JSON.stringify kullanmadan doğrudan objeyi saklıyoruz! (100x daha hızlı)
                    tx.objectStore('store').put(value, key);
                    tx.oncomplete = () => resolve(true);
                } catch(err) { resolve(false); }
            };
            req.onerror = () => resolve(false);
        });
    },
    async remove(key) {
        return new Promise((resolve) => {
            const req = indexedDB.open('IPGateDB', 1);
            req.onsuccess = (e) => {
                try {
                    const db = e.target.result;
                    const tx = db.transaction('store', 'readwrite');
                    tx.objectStore('store').delete(key);
                    tx.oncomplete = () => resolve(true);
                } catch(err) { resolve(false); }
            };
            req.onerror = () => resolve(false);
        });
    }
};

window.localCache = localCache;

// --- YENİ: SUPABASE AUTH SERVICE ---
export const authService = {
    // Aktif oturumu Supabase'den güvenli şekilde getir
    async getCurrentSession() {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) console.error("Oturum kontrol hatası:", error);
        return session;
    },

    // Güvenli Çıkış Yapma
    async signOut() {
        try {
            // Önbellekleri temizle
            if (window.localCache) {
                try { await window.localCache.remove('ip_records_cache'); } catch(e) {}
            }
            sessionStorage.clear();
            localStorage.clear();
            
            // Supabase'den çıkış yap
            const { error } = await supabase.auth.signOut();
            if (error) throw error;
            
            // Giriş sayfasına yönlendir
            window.location.replace('index.html');
        } catch (error) {
            console.error("Çıkış yapılırken hata oluştu:", error);
            window.location.replace('index.html');
        }
    },
};

// ==========================================
// YÖNLENDİRME VE OTURUM BEKLEME YARDIMCILARI
// ==========================================

export async function waitForAuthUser({ requireAuth = true, redirectTo = 'index.html', graceMs = 0 } = {}) {
    const session = await authService.getCurrentSession();
    
    if (requireAuth && !session) {
        window.location.replace(redirectTo);
        return null;
    }

    if (session) {
        const { data: userProfile, error } = await supabase
            .from('users')
            .select('role')
            .eq('id', session.user.id)
            .single();

        // 🔥 YENİ: Ağ (Firewall) engeli tespit edilirse kullanıcıyı uyar
        if (error) {
            console.error("Veritabanı bağlantı hatası (Ağ engeli olabilir):", error);
            if (error.message.includes('Failed to fetch') || error.message.includes('Network')) {
                alert("SİSTEM UYARISI: Kurum ağınız (Wi-Fi / Firewall) güvenlik nedeniyle veritabanı bağlantımızı engelliyor. Lütfen mobil veriye geçin veya IT departmanından 'supabase.co' adresine izin vermesini isteyin.");
            }
        }

        const userRole = userProfile ? userProfile.role : 'belirsiz';
        const currentPath = window.location.pathname;

        if (userRole === 'belirsiz' && !currentPath.includes('client-pending.html')) {
            window.location.replace('client-pending.html');
            return null;
        }

        if (userRole === 'client' && !currentPath.includes('client-portal.html')) {
            window.location.replace('client-portal.html');
            return null;
        }

        if (userRole !== 'belirsiz' && userRole !== 'client') {
            if (currentPath.includes('client-pending.html') || currentPath.includes('client-portal.html')) {
                window.location.replace('dashboard.html'); 
                return null;
            }
        }
    }

    return session ? session.user : null;
}

export function redirectOnLogout(redirectTo = 'index.html', graceMs = 0) {
    // Supabase Auth Listener ile anlık çıkış (başka sekmeden çıkış yapılsa bile) takibi
    supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT' || !session) {
            window.location.replace(redirectTo);
        }
    });
}

// ==========================================
// PORTFÖY VE ORTAK MODÜL SERVİSLERİ
// ==========================================

// 1. KİŞİLER (PERSONS) SERVİSİ
export const personService = {
    async getPersons() {
        const { data, error } = await supabase.from('persons').select('*').order('name', { ascending: true });
        if (error) {
            console.error("Kişiler çekilemedi:", error);
            return { success: false, error: error.message };
        }
        
        // YENİ ŞEMA: person_type yerine type, tax_no yerine taxNo (UI camelCase bekliyor)
        const mappedData = data.map(p => ({
            id: p.id, 
            name: p.name, 
            type: p.type, 
            tckn: p.tckn, 
            taxOffice: p.tax_office,
            taxNo: p.tax_no, 
            tpeNo: p.tpe_no,
            email: p.email, 
            phone: p.phone, 
            address: p.address, 
            countryCode: p.country_code, 
            province: p.province,
            is_evaluation_required: p.is_evaluation_required
            // NOT: 'documents' ve 'details' yeni şemada kaldırıldığı için çıkarıldı.
        }));
        return { success: true, data: mappedData };
    },

    async getPersonById(id) {
        // 🔥 YENİ DB YAPISI: İlişkili person_documents tablosundaki vekaletnameleri de (JOIN ile) çekiyoruz
        const { data, error } = await supabase
            .from('persons')
            .select(`
                *,
                person_documents (*)
            `)
            .eq('id', id)
            .single();
            
        if (error) return { success: false, error: error.message };
        
        // Arayüzün (UI) beklediği formata çeviriyoruz
        const mappedDocuments = (data.person_documents || []).map(doc => ({
            id: doc.id,
            fileName: doc.file_name,
            documentType: doc.document_type,
            url: doc.url,
            countryCode: doc.country_code,
            validityDate: doc.validity_date
        }));

        const mappedData = {
            id: data.id, 
            name: data.name, 
            type: data.type, 
            tckn: data.tckn, 
            birthDate: data.birth_date,
            taxOffice: data.tax_office,
            taxNo: data.tax_no, 
            tpeNo: data.tpe_no,
            email: data.email, 
            phone: data.phone, 
            address: data.address, 
            countryCode: data.country_code, 
            province: data.province,
            is_evaluation_required: data.is_evaluation_required,
            documents: mappedDocuments // 🔥 Belgeleri arayüze iletiyoruz
        };
        return { success: true, data: mappedData };
    },

    async addPerson(personData) {
        // 🔥 YENİ: Ön yüzden (Modal'dan) bir ID gelirse onu kullan, gelmezse yeni üret
        const newPersonId = personData.id || crypto.randomUUID(); 
        
        const payload = {
            id: newPersonId, 
            name: personData.name, 
            type: personData.type, 
            tckn: personData.tckn || null, 
            birth_date: personData.birthDate || null,
            tax_office: personData.taxOffice || null,
            tax_no: personData.taxNo || null,
            tpe_no: personData.tpeNo || null, 
            email: personData.email || null, 
            phone: personData.phone || null,
            address: personData.address || null, 
            country_code: personData.countryCode || null, 
            province: personData.province || null,
            is_evaluation_required: personData.is_evaluation_required || false
        };

        // 1. Önce Kişiyi Kaydet
        const { data, error } = await supabase.from('persons').insert(payload).select('id').single();
        if (error) return { success: false, error: error.message };

        // 2. Belgeleri `person_documents` tablosuna kaydet
        if (personData.documents && personData.documents.length > 0) {
            const docsPayload = personData.documents.map(doc => ({
                person_id: newPersonId,
                file_name: doc.fileName || doc.name || 'Belge',
                document_type: doc.documentType || doc.type || 'vekaletname',
                url: doc.url,
                country_code: doc.countryCode || null,
                validity_date: doc.validityDate || null
            }));
            
            await supabase.from('person_documents').insert(docsPayload);
        }

        return { success: true, data: { id: newPersonId } };
    },

    async updatePerson(id, personData) {
        const payload = {
            name: personData.name, 
            type: personData.type, 
            tckn: personData.tckn || null, 
            birth_date: personData.birthDate || null,
            tax_office: personData.taxOffice || null,
            tax_no: personData.taxNo || null,
            tpe_no: personData.tpeNo || null, 
            email: personData.email || null, 
            phone: personData.phone || null,
            address: personData.address || null, 
            country_code: personData.countryCode || null, 
            province: personData.province || null, 
            is_evaluation_required: personData.is_evaluation_required || false,
            updated_at: new Date().toISOString()
        };
        
        Object.keys(payload).forEach(key => { 
            if (payload[key] === undefined || payload[key] === '') payload[key] = null; 
        });

        // 1. Kişiyi Güncelle
        const { error } = await supabase.from('persons').update(payload).eq('id', id);
        if (error) {
            console.error("🔴 SUPABASE UPDATE HATASI:", error);
            alert("Kayıt Başarısız: " + error.message);
            return { success: false, error: error.message };
        }

        // 🔥 YENİ DB YAPISI: Belgeleri `person_documents` tablosuna güncelle
        if (personData.documents) {
            // Önce bu kişiye ait eski belgeleri siliyoruz, sonra formdan gelen güncel listeyi yazıyoruz (Senkronizasyon)
            await supabase.from('person_documents').delete().eq('person_id', id);
            
            if (personData.documents.length > 0) {
                const docsPayload = personData.documents.map(doc => ({
                    person_id: id,
                    file_name: doc.fileName || doc.name || 'Belge',
                    document_type: doc.documentType || doc.type || 'vekaletname',
                    url: doc.url,
                    country_code: doc.countryCode || null,
                    validity_date: doc.validityDate || null
                }));
                
                await supabase.from('person_documents').insert(docsPayload);
            }
        }
        
        return { success: true };
    },

    async deletePerson(id) {
        const { error } = await supabase.from('persons').delete().eq('id', id);
        if (error) return { success: false, error: error.message };
        return { success: true };
    },

    // --- İLGİLİ KİŞİLER (RELATED PERSONS & TO/CC) SERVİSİ ---
    async getRelatedPersons(personId) {
        const { data, error } = await supabase.from('persons_related').select('*').eq('person_id', personId);
        if (error) return [];
        return data; 
    },

    async saveRelatedPersons(personId, draft, loaded, toDelete) {
        try {
            // 1. Silinecekler
            if (toDelete && toDelete.length > 0) {
                const { error } = await supabase.from('persons_related').delete().in('id', toDelete);
                if (error) throw error;
            }
            
            // 2. Güncellenecekler
            if (loaded && loaded.length > 0) {
                for (const r of loaded) {
                    if (r.id) {
                        const { id, person_id, created_at, ...updateData } = r;
                        Object.keys(updateData).forEach(key => { 
                            if (updateData[key] === undefined || updateData[key] === '') updateData[key] = null; 
                        });
                        const { error } = await supabase.from('persons_related').update(updateData).eq('id', id);
                        if (error) throw error;
                    }
                }
            }
            
            // 3. Yeni Eklenecekler
            if (draft && draft.length > 0) {
                const inserts = draft.map(d => ({
                    id: crypto.randomUUID(),
                    person_id: personId, 
                    name: d.name || null, 
                    email: d.email || null, 
                    phone: d.phone || null,
                    resp_trademark: d.resp_trademark || false, 
                    resp_patent: d.resp_patent || false, 
                    resp_design: d.resp_design || false, 
                    resp_litigation: d.resp_litigation || false, 
                    resp_finance: d.resp_finance || false,
                    notify_trademark_to: d.notify_trademark_to || false, 
                    notify_trademark_cc: d.notify_trademark_cc || false,
                    notify_patent_to: d.notify_patent_to || false, 
                    notify_patent_cc: d.notify_patent_cc || false,
                    notify_design_to: d.notify_design_to || false, 
                    notify_design_cc: d.notify_design_cc || false,
                    notify_finance_to: d.notify_finance_to || false, 
                    notify_finance_cc: d.notify_finance_cc || false
                }));
                const { error } = await supabase.from('persons_related').insert(inserts);
                if (error) throw error;
            }
            return { success: true };
        } catch(e) {
            console.error("🔴 RELATED PERSONS KAYIT HATASI:", e);
            return { success: false, error: e.message };
        }
    },
    
    // ==========================================
    // MÜVEKKİL PORTALI: KULLANICI-FİRMA EŞLEŞTİRME SERVİSLERİ
    // ==========================================
    
    async linkUserToPersons(userId, personsWithPermissions) {
        try {
            // 1. Önce kullanıcının eski bağlantılarını temizle (Temiz sayfa)
            await supabase.from('user_person_links').delete().eq('user_id', userId);

            // 2. Yeni bağlantılar varsa tabloya ekle
            if (personsWithPermissions && personsWithPermissions.length > 0) {
                const inserts = personsWithPermissions.map(p => ({
                    user_id: userId,
                    person_id: p.personId || p.id,
                    perm_view: p.permissions?.view !== false, // Varsayılan true
                    perm_approval: p.permissions?.approval || false,
                    is_primary: p.isPrimary || false
                }));
                const { error } = await supabase.from('user_person_links').insert(inserts);
                if (error) throw error;
            }
            return { success: true };
        } catch (error) {
            console.error("Kullanıcı eşleştirme hatası:", error);
            return { success: false, error: error.message };
        }
    },

    async getLinkedPersons(userId) {
        try {
            // JOIN sorgusu ile hem link bilgilerini hem de kişi (person) detaylarını tek seferde alıyoruz
            const { data, error } = await supabase
                .from('user_person_links')
                .select(`
                    perm_approval,
                    perm_view,
                    is_primary,
                    person_id,
                    persons (*)
                `)
                .eq('user_id', userId);

            if (error) throw error;
            if (!data || data.length === 0) return { success: true, data: [] };

            // Arayüzün (UI) beklediği formata haritalıyoruz
            const mappedData = data.filter(link => link.persons).map(link => ({
                id: link.persons.id,
                name: link.persons.name,
                type: link.persons.type,
                email: link.persons.email,
                permissions: {
                    view: link.perm_view,
                    approval: link.perm_approval
                },
                isPrimary: link.is_primary
            }));

            return { success: true, data: mappedData };
        } catch (error) {
            console.error("Bağlı kişiler çekilirken hata:", error);
            return { success: false, error: error.message };
        }
    },

    async unlinkUserFromAllPersons(userId) {
        try {
            const { error } = await supabase.from('user_person_links').delete().eq('user_id', userId);
            if (error) throw error;
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    async getPersonsByIds(personIds = []) {
        if (!personIds || personIds.length === 0) return { success: true, data: [] };
        try {
            const { data, error } = await supabase.from('persons').select('*').in('id', personIds);
            if (error) throw error;
            
            // UI formatına (camelCase) çevir
            const mappedData = data.map(p => ({
                id: p.id, 
                name: p.name, 
                type: p.type, 
                tckn: p.tckn,
                taxOffice: p.tax_office, 
                taxNo: p.tax_no, 
                email: p.email,
                phone: p.phone, 
                address: p.address, 
                countryCode: p.country_code
            }));
            
            return { success: true, data: mappedData };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
};

// 2. İŞLEM TİPLERİ (TRANSACTION TYPES) SERVİSİ
export const transactionTypeService = {
    async getTransactionTypes() {
        const CACHE_KEY = 'transaction_types_cache';
        if (window.localCache) {
            const cached = await window.localCache.get(CACHE_KEY);
            // 24 saat boyunca bu listeyi tekrar DB'den çekme
            if (cached && cached.data && (Date.now() - cached.timestamp < 86400000)) return { success: true, data: cached.data };
        }

        const { data, error } = await supabase.from('transaction_types').select('*');
        if (error) return { success: false, data: [] };
        
        const mappedData = data.map(t => ({
            id: String(t.id),
            name: t.name,
            alias: t.alias,
            ipType: t.ip_type, 
            ip_type: t.ip_type, 
            applicableToMainType: t.applicable_to_main_type || (t.ip_type ? [t.ip_type] : []),
            hierarchy: t.hierarchy,
            isTopLevelSelectable: t.is_top_level_selectable,
            code: t.id, 
            ...t.details 
        }));

        if (window.localCache) await window.localCache.set(CACHE_KEY, { timestamp: Date.now(), data: mappedData });
        return { success: true, data: mappedData };
    }
};

// 3. ORTAK (COMMON) VERİLER SERVİSİ
export const commonService = {
    async getCountries() {
        const CACHE_KEY = 'countries_cache';
        if (window.localCache) {
            const cached = await window.localCache.get(CACHE_KEY);
            // 24 saat boyunca ülkeleri tekrar DB'den çekme
            if (cached && cached.data && (Date.now() - cached.timestamp < 86400000)) return { success: true, data: cached.data };
        }

        const { data, error } = await supabase.from('common').select('data').eq('id', 'countries').single();
        if (error || !data) return { success: false, data: [] };
        
        const list = data.data.list || [];
        if (window.localCache) await window.localCache.set(CACHE_KEY, { timestamp: Date.now(), data: list });
        return { success: true, data: list };
    }
};

// ==========================================
// 4. PORTFÖY (IP RECORDS) SERVİSİ
// ==========================================
export const ipRecordsService = {

    // ==========================================
    // AKILLI DUPLİKASYON KONTROLLÜ ANA KAYIT OLUŞTURUCU
    // ==========================================
    async createRecord(recordData) {
        try {
            // YENİ GÜVENLİK AĞI: Veritabanına gitmeden önce applicantIds dizisini otomatik oluştur
            if (recordData.applicants && Array.isArray(recordData.applicants)) {
                recordData.applicantIds = recordData.applicants.map(app => app.id).filter(Boolean);
            }

            let isDuplicateFound = false;
            let existingId = null;
            let existingOwnerType = null;
            
            // Verileri Güvenli Hale Getir
            const origin = (recordData.origin || 'TÜRKPATENT').trim().toUpperCase();
            const hierarchy = recordData.transactionHierarchy || 'parent';
            const appNo = (recordData.applicationNumber || '').trim();
            const wipoIr = (recordData.wipoIR || '').trim();
            const aripoIr = (recordData.aripoIR || '').trim();
            const countryCode = (recordData.countryCode || recordData.country || '').trim();

            // Supabase Sorgu Hazırlığı
            let query = supabase.from('ip_records').select('id, record_owner_type').limit(1);
            let shouldCheck = false;

            // --- KURAL 1: WIPO veya ARIPO ise ---
            if (origin.includes('WIPO') || origin.includes('ARIPO')) {
                
                // Parent Kayıt Kontrolü
                if (hierarchy === 'parent') {
                    if (origin.includes('WIPO') && wipoIr) {
                        query = query.eq('transaction_hierarchy', 'parent').eq('wipo_ir', wipoIr);
                        shouldCheck = true;
                    } else if (origin.includes('ARIPO') && aripoIr) {
                        query = query.eq('transaction_hierarchy', 'parent').eq('aripo_ir', aripoIr);
                        shouldCheck = true;
                    }
                } 
                // Child (Alt) Kayıt Kontrolü
                else if (hierarchy === 'child' && countryCode) {
                    query = query.eq('transaction_hierarchy', 'child').eq('country_code', countryCode);
                    
                    let orParts = [];
                    // Tırnak içine alıyoruz ki TR2023/123, veya 1,234 gibi numaralar SQL'i bozmasın
                    if (appNo) orParts.push(`application_number.eq."${appNo}"`);
                    if (wipoIr) orParts.push(`wipo_ir.eq."${wipoIr}"`);
                    if (aripoIr) orParts.push(`aripo_ir.eq."${aripoIr}"`);
                    
                    if (orParts.length > 0) {
                        query = query.or(orParts.join(','));
                        shouldCheck = true;
                    }
                }
            } 
            // --- KURAL 2: TÜRKPATENT, Yurtdışı Ulusal, EUIPO vb. ---
            else {
                if (appNo) {
                    query = query.eq('application_number', appNo);
                    shouldCheck = true;
                }
            }

            // Eğer sorgu kriterleri karşılandıysa veritabanına sor
            if (shouldCheck) {
                const { data: duplicateData, error: dupError } = await query;

                if (!dupError && duplicateData && duplicateData.length > 0) {
                    isDuplicateFound = true;
                    existingId = duplicateData[0].id;
                    existingOwnerType = duplicateData[0].record_owner_type;
                }
            }

            // Sonuç Değerlendirmesi
            if (isDuplicateFound) {
                console.log("🔍 Duplikasyon kontrolü eşleşti:", { existingId, origin, hierarchy });
                
                const isFromDataEntry = recordData.createdFrom === 'data_entry' || !recordData.createdFrom;
                if (isFromDataEntry) {
                    return { 
                        success: false, 
                        error: `Girdiğiniz kriterlere (${appNo || wipoIr || aripoIr}) sahip bir kayıt sistemde zaten mevcut. Duplikasyon önlemek için yeni kayıt oluşturulamadı.`,
                        isDuplicate: true,
                        existingRecordId: existingId,
                        existingRecordType: existingOwnerType
                    };
                }
                
                const isFromOpposition = recordData.createdFrom === 'opposition_automation' || recordData.createdFrom === 'bulletin_record';
                if (isFromOpposition) {
                    console.log("✅ İtiraz sonucu - mevcut kayıt kullanılacak, yeni kayıt oluşturulmayacak");
                    return {
                        success: true,
                        id: existingId,               
                        isExistingRecord: true,
                        message: `Kayıt zaten mevcut; işlem var olan kayıt üzerinden devam edecek.`
                    };
                }
                
                return { success: false, error: `Girdiğiniz bilgilere sahip bir kayıt zaten mevcut.`, isDuplicate: true };
            }
            
            // 3. Duplikasyon yoksa, veriyi mevcut createRecordFromDataEntry metoduna yolla
            return await this.createRecordFromDataEntry(recordData);
            
        } catch (error) {
            console.error("❌ IP kaydı oluşturulurken hata:", error);
            return { success: false, error: error.message };
        }
    },
    
// A) Tüm Portföyü Getir (Listeleme İçin) — 🚀 VIEW OPTİMİZASYONU
    async getRecords(forceRefresh = false) {
        
        // 🚀 4 ayrı JOIN yerine tek düz view sorgusu
        const { data, error } = await supabase
            .from('portfolio_list_view')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            console.error("Kayıtlar çekilemedi:", error);
            return { success: false, data: [] };
        }

        const mappedData = data.map(record => {
            // applicants_json DB'den hazır jsonb olarak geliyor
            let applicantsArray = [];
            try {
                applicantsArray = Array.isArray(record.applicants_json)
                    ? record.applicants_json
                    : JSON.parse(record.applicants_json || '[]');
            } catch(e) { applicantsArray = []; }

            // nice_classes DB'den integer[] olarak geliyor
            const classesArray = Array.isArray(record.nice_classes)
                ? record.nice_classes.filter(n => n != null)
                : [];

            // brand_image_url fallback
            let imageUrl = record.brand_image_url;
            if (!imageUrl || imageUrl.trim() === '') {
                imageUrl = `https://guicrctynauzxhyfpdfe.supabase.co/storage/v1/object/public/brand_images/${record.id}/logo.png`;
            }

            return {
                id: record.id,
                type: record.ip_type,
                origin: record.origin,
                status: record.status,
                portfoyStatus: record.portfolio_status,
                recordOwnerType: record.record_owner_type,
                applicationNumber: record.application_number,
                applicationDate: record.application_date,
                registrationNumber: record.registration_number,
                registrationDate: record.registration_date,
                renewalDate: record.renewal_date,
                country: record.country_code,
                wipoIR: record.wipo_ir,
                aripoIR: record.aripo_ir,
                transactionHierarchy: record.transaction_hierarchy,
                parentId: record.parent_id,

                title: record.brand_name || '',
                brandText: record.brand_name || '',
                brandImageUrl: imageUrl,

                bulletinNo: null,
                bulletinDate: null,

                niceClasses: classesArray,
                applicants: applicantsArray,
                applicantName: record.applicant_names || '-',

                createdAt: record.created_at,
                updatedAt: record.updated_at
            };
        });

        return { success: true, data: mappedData, from: 'server' };
    },
    
    // B) Tek Bir Kaydı Çeker (Detay Sayfası İçin) - 🚀 400 Hatasına Karşı Güvenli Hale Getirildi
    async getRecordById(id) {
        // 1. Önce ana tabloyu (ip_records) çek
        const { data: record, error } = await supabase
            .from('ip_records')
            .select('*')
            .eq('id', id)
            .single();

        if (error) return { success: false, error: error.message };

        // 2. İlişkili tabloları Supabase'i yormadan paralel olarak ayrı ayrı çek
        const [tmDetailsRes, applicantsRes, classesRes, prioritiesRes, bulletinsRes] = await Promise.all([
            supabase.from('ip_record_trademark_details').select('*').eq('ip_record_id', id),
            supabase.from('ip_record_applicants').select('*').eq('ip_record_id', id),
            supabase.from('ip_record_classes').select('*').eq('ip_record_id', id),
            supabase.from('ip_record_priorities').select('*').eq('ip_record_id', id),
            supabase.from('ip_record_bulletins').select('*').eq('ip_record_id', id)
        ]);

        let tmDetails = tmDetailsRes.data && tmDetailsRes.data.length > 0 ? tmDetailsRes.data[0] : {};

        // 3. Başvuru Sahipleri İçin Kişi Bilgilerini (persons) Çek
        let applicantsArray = [];
        if (applicantsRes.data && applicantsRes.data.length > 0) {
            const personIds = applicantsRes.data.map(a => a.person_id).filter(Boolean);
            if (personIds.length > 0) {
                // 🔥 YENİ: birth_date kolonu da eklendi
                const { data: personsData } = await supabase.from('persons').select('id, name, type, address, email, tckn, tax_no, tpe_no, birth_date').in('id', personIds);
                if (personsData) {
                    applicantsArray = applicantsRes.data.map(app => {
                        const person = personsData.find(p => p.id === app.person_id);
                        return person ? {
                            id: person.id, 
                            name: person.name, 
                            email: person.email,
                            address: person.address,
                            tckn: person.tckn,
                            taxNo: person.tax_no,
                            tpeNo: person.tpe_no,
                            birthDate: person.birth_date // 🔥 YENİ: Objeye eklendi
                        } : null;
                    }).filter(Boolean);
                }
            }
        }

        const gsbc = classesRes.data ? classesRes.data.map(c => ({
            classNo: c.class_no, items: c.items || []
        })) : [];

        const priorities = prioritiesRes.data ? prioritiesRes.data.map(p => ({
            id: p.id, country: p.priority_country, date: p.priority_date, number: p.priority_number
        })) : [];

        const bulletins = bulletinsRes.data ? bulletinsRes.data.map(b => ({
            id: b.id, bulletinNo: b.bulletin_no, bulletinDate: b.bulletin_date
        })) : [];

        let imageUrl = tmDetails.brand_image_url;
        if (!imageUrl || imageUrl.trim() === '') {
            imageUrl = `https://guicrctynauzxhyfpdfe.supabase.co/storage/v1/object/public/brand_images/${record.id}/logo.png`;
        }

        const mappedData = {
            id: record.id, 
            ipType: record.ip_type,
            type: record.ip_type,
            origin: record.origin,
            status: record.status,
            portfoyStatus: record.portfolio_status,
            recordOwnerType: record.record_owner_type,
            applicationNumber: record.application_number, 
            applicationDate: record.application_date,
            registrationNumber: record.registration_number, 
            registrationDate: record.registration_date, 
            renewalDate: record.renewal_date,
            country: record.country_code,
            countryCode: record.country_code,
            wipoIR: record.wipo_ir,
            aripoIR: record.aripo_ir,
            transactionHierarchy: record.transaction_hierarchy,
            parentId: record.parent_id,

            title: tmDetails.brand_name || record.title || '',
            brandText: tmDetails.brand_name || record.title || '',
            brandType: tmDetails.brand_type || '',
            brandCategory: tmDetails.brand_category || '',
            brandImageUrl: imageUrl,
            trademarkImage: imageUrl,
            description: tmDetails.description || '',

            niceClasses: gsbc.map(g => parseInt(g.classNo)),
            goodsAndServicesByClass: gsbc, 
            applicants: applicantsArray, 
            priorities: priorities,
            bulletins: bulletins,

            createdAt: record.created_at, 
            updatedAt: record.updated_at
        };

        return { success: true, data: mappedData };
    },

    // C) Yeni Kayıt Ekle (Tablolara Bölüştürerek Yazar)
    async createRecordFromDataEntry(data) {
        const newRecordId = data.id || crypto.randomUUID();

        // 1. ANA TABLO (ip_records)
        const dbPayload = {
            id: newRecordId,
            ip_type: data.ipType || data.type || 'trademark',
            origin: data.origin || null,
            portfolio_status: data.portfoyStatus || 'active',
            status: data.status || null,
            record_owner_type: data.recordOwnerType || 'self',
            application_number: data.applicationNumber || null,
            application_date: data.applicationDate || null,
            registration_number: data.registrationNumber || null,
            registration_date: data.registrationDate || null,
            renewal_date: data.renewalDate || null,
            country_code: data.country || data.countryCode || null,
            wipo_ir: data.wipoIR || null,
            aripo_ir: data.aripoIR || null,
            parent_id: data.parentId || null,
            transaction_hierarchy: data.transactionHierarchy || 'parent',
            created_from: data.createdFrom || 'data_entry'
        };

        Object.keys(dbPayload).forEach(k => dbPayload[k] === undefined && delete dbPayload[k]);

        const { error: mainError } = await supabase.from('ip_records').insert(dbPayload);
        if (mainError) return { success: false, error: mainError.message };

        // 2. MARKA DETAYLARI (ip_record_trademark_details)
        if (dbPayload.ip_type === 'trademark') {
            const tmPayload = {
                ip_record_id: newRecordId,
                brand_name: data.title || data.brandText || null,
                brand_type: data.brandType || null,
                brand_category: data.brandCategory || null,
                brand_image_url: data.brandImageUrl || null,
                description: data.description || null
            };
            Object.keys(tmPayload).forEach(k => tmPayload[k] === undefined && delete tmPayload[k]);
            await supabase.from('ip_record_trademark_details').insert(tmPayload);
        }

        // 3. BAŞVURU SAHİPLERİ (ip_record_applicants)
        if (data.applicants && Array.isArray(data.applicants) && data.applicants.length > 0) {
            const appRows = data.applicants.map((app, i) => ({ 
                ip_record_id: newRecordId, person_id: app.id, order_index: i 
            }));
            await supabase.from('ip_record_applicants').insert(appRows);
        }

        // 4. SINIFLAR VE EŞYALAR (ip_record_classes)
        if (data.goodsAndServicesByClass && Array.isArray(data.goodsAndServicesByClass)) {
            const classRows = data.goodsAndServicesByClass.map(c => ({ 
                id: crypto.randomUUID(), 
                ip_record_id: newRecordId, 
                class_no: parseInt(c.classNo), 
                items: Array.isArray(c.items) ? c.items : [] 
            }));
            
            if (classRows.length > 0) {
                const { error: classError } = await supabase.from('ip_record_classes').insert(classRows);
                if (classError) {
                    console.error("❌ Sınıflar (ip_record_classes) tabloya yazılamadı:", classError);
                } else {
                    console.log(`✅ ${classRows.length} adet sınıf başarıyla ip_record_classes tablosuna kaydedildi.`);
                }
            }
        }

        // 5. RÜÇHANLAR (ip_record_priorities)
        if (data.priorities && Array.isArray(data.priorities) && data.priorities.length > 0) {
            const priorityRows = data.priorities.map(p => ({
                id: crypto.randomUUID(), // 🔥 ÇÖZÜM 1: Eksik ID eklendi
                ip_record_id: newRecordId, 
                priority_country: p.country, 
                priority_date: p.date, 
                priority_number: p.number
            }));
            await supabase.from('ip_record_priorities').insert(priorityRows);
        }

        // 6. BÜLTEN VERİLERİ (ip_record_bulletins)
        if (data.bulletinNo || data.bulletinDate) {
            await supabase.from('ip_record_bulletins').insert({
                id: crypto.randomUUID(),
                ip_record_id: newRecordId,
                bulletin_no: data.bulletinNo || null,
                bulletin_date: data.bulletinDate || null
            });
        }

        // 🔥 ÇÖZÜM 2: CACHE_KEY hatası düzeltildi
        if (window.localCache) await window.localCache.remove('ip_records_cache');
        return { success: true, id: newRecordId };
    },

    // D) Mevcut Kaydı Güncelle
    async updateRecord(id, updateData) {
        // 1. ANA TABLO GÜNCELLEMESİ
        const dbPayload = {};
        
        if (updateData.ipType !== undefined || updateData.type !== undefined) dbPayload.ip_type = updateData.ipType || updateData.type;
        if (updateData.origin !== undefined) dbPayload.origin = updateData.origin;
        if (updateData.portfoyStatus !== undefined) dbPayload.portfolio_status = updateData.portfoyStatus;
        if (updateData.status !== undefined) dbPayload.status = updateData.status;
        if (updateData.recordOwnerType !== undefined) dbPayload.record_owner_type = updateData.recordOwnerType;
        if (updateData.applicationNumber !== undefined) dbPayload.application_number = updateData.applicationNumber;
        if (updateData.applicationDate !== undefined) dbPayload.application_date = updateData.applicationDate;
        if (updateData.registrationNumber !== undefined) dbPayload.registration_number = updateData.registrationNumber;
        if (updateData.registrationDate !== undefined) dbPayload.registration_date = updateData.registrationDate;
        if (updateData.renewalDate !== undefined) dbPayload.renewal_date = updateData.renewalDate;
        if (updateData.wipoIR !== undefined) dbPayload.wipo_ir = updateData.wipoIR;
        if (updateData.aripoIR !== undefined) dbPayload.aripo_ir = updateData.aripoIR;
        if (updateData.country !== undefined || updateData.countryCode !== undefined) dbPayload.country_code = updateData.country || updateData.countryCode;
        
        dbPayload.updated_at = new Date().toISOString();
        Object.keys(dbPayload).forEach(k => dbPayload[k] === undefined && delete dbPayload[k]);

        if (Object.keys(dbPayload).length > 1) { 
            const { error } = await supabase.from('ip_records').update(dbPayload).eq('id', id);
            if (error) return { success: false, error: error.message };
        }

        // 2. MARKA DETAYLARI GÜNCELLEMESİ
        const isTrademark = updateData.ipType === 'trademark' || updateData.type === 'trademark' || (updateData.title !== undefined);
        if (isTrademark) {
            const tmPayload = { ip_record_id: id };
            if (updateData.title !== undefined || updateData.brandText !== undefined) tmPayload.brand_name = updateData.title || updateData.brandText;
            if (updateData.brandType !== undefined) tmPayload.brand_type = updateData.brandType;
            if (updateData.brandCategory !== undefined) tmPayload.brand_category = updateData.brandCategory;
            if (updateData.brandImageUrl !== undefined) tmPayload.brand_image_url = updateData.brandImageUrl;
            if (updateData.description !== undefined) tmPayload.description = updateData.description;

            Object.keys(tmPayload).forEach(k => tmPayload[k] === undefined && delete tmPayload[k]);

            if (Object.keys(tmPayload).length > 1) {
                await supabase.from('ip_record_trademark_details').upsert(tmPayload, { onConflict: 'ip_record_id' });
            }
        }

        // 3. BAŞVURU SAHİPLERİNİ YENİDEN YAZ
        if (updateData.applicants && Array.isArray(updateData.applicants)) {
            await supabase.from('ip_record_applicants').delete().eq('ip_record_id', id);
            if (updateData.applicants.length > 0) {
                const appRows = updateData.applicants.map((app, i) => ({ ip_record_id: id, person_id: app.id, order_index: i }));
                await supabase.from('ip_record_applicants').insert(appRows);
            }
        }

        // 4. SINIFLARI YENİDEN YAZ
        if (updateData.goodsAndServicesByClass && Array.isArray(updateData.goodsAndServicesByClass)) {
            await supabase.from('ip_record_classes').delete().eq('ip_record_id', id);
            if (updateData.goodsAndServicesByClass.length > 0) {
                const classRows = updateData.goodsAndServicesByClass.map(c => ({ 
                    id: crypto.randomUUID(), // 🔥 ÇÖZÜM 1: Eksik ID eklendi
                    ip_record_id: id, 
                    class_no: parseInt(c.classNo), 
                    items: Array.isArray(c.items) ? c.items : [] 
                }));
                await supabase.from('ip_record_classes').insert(classRows);
            }
        }

        // 5. RÜÇHANLARI YENİDEN YAZ
        if (updateData.priorities && Array.isArray(updateData.priorities)) {
            await supabase.from('ip_record_priorities').delete().eq('ip_record_id', id);
            if (updateData.priorities.length > 0) {
                const priorityRows = updateData.priorities.map(p => ({ 
                    id: crypto.randomUUID(), // 🔥 ÇÖZÜM 1: Eksik ID eklendi
                    ip_record_id: id, 
                    priority_country: p.country, 
                    priority_date: p.date, 
                    priority_number: p.number 
                }));
                await supabase.from('ip_record_priorities').insert(priorityRows);
            }
        }

        // 6. BÜLTEN VERİLERİNİ YENİDEN YAZ
        if (updateData.bulletinNo !== undefined || updateData.bulletinDate !== undefined) {
            await supabase.from('ip_record_bulletins').delete().eq('ip_record_id', id);
            if (updateData.bulletinNo || updateData.bulletinDate) {
                await supabase.from('ip_record_bulletins').insert({
                    id: crypto.randomUUID(),
                    ip_record_id: id,
                    bulletin_no: updateData.bulletinNo || null,
                    bulletin_date: updateData.bulletinDate || null
                });
            }
        }

        if (window.localCache) await window.localCache.remove('ip_records_cache');
        return { success: true };
    },

    // İşlem Geçmişi (Bol Loglu Hata Ayıklama Versiyonu)
    async getRecordTransactions(recordId) {
        console.log("-----------------------------------------");
        console.log("🔍 GET RECORD TRANSACTIONS BAŞLADI");
        console.log("1. Aranan Record ID:", recordId);
        
        if (!recordId) {
            console.warn("❌ Record ID yok!");
            return { success: false, message: 'Kayıt ID yok.' };
        }
        
        try {
            console.log("2. Transactions tablosuna istek atılıyor...");
            const { data: txData, error: txError } = await supabase
                .from('transactions')
                .select('*')
                .eq('ip_record_id', String(recordId))
                .order('created_at', { ascending: false });

            console.log("3. Transactions Sorgu Sonucu:", txData);
            if (txError) {
                console.error("❌ Transactions Sorgu Hatası:", txError);
                throw txError;
            }
            
            let finalTransactions = txData || [];

            // EĞER MİGRASYON ÖNCESİ ESKİ BİR KAYITSA:
            if (finalTransactions.length === 0) {
                console.log("⚠️ Transactions tablosu boş. Eski JSON yedeğine (old_transactions) bakılıyor...");
                const { data: recordFallback } = await supabase
                    .from('ip_records')
                    .select('old_transactions')
                    .eq('id', String(recordId))
                    .single();
                
                console.log("4. Eski JSON yedeği (old_transactions):", recordFallback?.old_transactions);
                if (recordFallback && recordFallback.old_transactions && Array.isArray(recordFallback.old_transactions)) {
                    console.log("✅ Eski yedekten veriler yüklendi.");
                    return { success: true, data: recordFallback.old_transactions };
                }
                console.log("❌ Eski yedek de boş. İşlem geçmişi yok.");
                return { success: true, data: [] };
            }

            const txIds = finalTransactions.map(t => t.id).filter(Boolean);
            const taskIds = [...new Set(finalTransactions.map(t => t.task_id).filter(Boolean))];
            
            console.log("5. Toplanan Transaction ID'leri:", txIds);
            console.log("6. Toplanan Task ID'leri:", taskIds);

            console.log("7. İlişkili belgeler ve görevler çekiliyor (Promise.all)...");
            const [docsRes, tasksRes, taskDocsRes] = await Promise.all([
                txIds.length > 0 
                    ? supabase.from('transaction_documents').select('*').in('transaction_id', txIds)
                    : Promise.resolve({ data: [] }),
                taskIds.length > 0 
                    ? supabase.from('tasks').select('*').in('id', taskIds) 
                    : Promise.resolve({ data: [] }),
                taskIds.length > 0 
                    ? supabase.from('task_documents').select('*').in('task_id', taskIds) 
                    : Promise.resolve({ data: [] })
            ]);

            if (docsRes.error) console.error("❌ Evrak Çekme Hatası:", docsRes.error);
            if (tasksRes.error) console.error("❌ Görev Çekme Hatası:", tasksRes.error);
            if (taskDocsRes.error) console.error("❌ Görev Evrakı Çekme Hatası:", taskDocsRes.error);

            const safeDocs = docsRes.data || [];
            const safeTasks = tasksRes.data || [];
            const safeTaskDocs = taskDocsRes.data || [];
            
            console.log("8. Çekilen transaction_documents sayısı:", safeDocs.length);
            console.log("9. Çekilen tasks sayısı:", safeTasks.length);
            console.log("10. Çekilen task_documents sayısı:", safeTaskDocs.length);

            console.log("11. Veriler birleştiriliyor (Mapping)...");
            const mappedData = finalTransactions.map(t => {
                const dateVal = t.transaction_date || t.created_at;
                const txDocs = safeDocs.filter(d => d.transaction_id === t.id);
                
                let taskObj = safeTasks.find(task => task.id === t.task_id) || null;
                if (taskObj) {
                    taskObj.task_documents = safeTaskDocs.filter(d => d.task_id === taskObj.id);
                }
                
                return {
                    ...t, 
                    id: t.id, 
                    type: String(t.transaction_type_id || ''), 
                    transactionHierarchy: t.transaction_hierarchy || 'parent', 
                    parentId: t.parent_id || null, 
                    timestamp: dateVal, 
                    date: dateVal,
                    userEmail: t.user_email || t.user_name || 'Sistem',
                    transaction_documents: txDocs, 
                    task_data: taskObj
                };
            });
            
            console.log("12. BİRLEŞTİRİLMİŞ FİNAL VERİ:", mappedData);
            console.log("-----------------------------------------");
            return { success: true, data: mappedData };
        } catch (error) {
            console.error("❌ İŞLEM GEÇMİŞİ ÇEKME ANA HATASI:", error);
            return { success: false, error: error.message };
        }
    },
    
    async getTransactionsForRecord(recordId) {
        const res = await this.getRecordTransactions(recordId);
        return { success: res.success, transactions: res.data, error: res.error };
    },

    async getRecordsByType(typeFilter) {
        const res = await this.getRecords();
        if(!res.success) return res;
        return { success: true, data: res.data.filter(r => r.type === typeFilter) };
    },
    
    async deleteParentWithChildren(parentId) {
        const { error: childrenError } = await supabase.from('ip_records').delete().eq('parent_id', parentId);
        if (childrenError) return { success: false, error: childrenError.message };
        
        const { error } = await supabase.from('ip_records').delete().eq('id', parentId);
        if (error) return { success: false, error: error.message };
        
        // 🔥 ÇÖZÜM: Kayıt silindiğinde önbelleği temizle ki liste güncellensin!
        if (window.localCache) {
            await window.localCache.remove('ip_records_cache');
        }
        
        return { success: true };
    },
    
    // YENİ İŞLEM (TRANSACTION) EKLEME KÖPRÜSÜ
    async addTransactionToRecord(recordId, txData) {
        const payload = {
            ip_record_id: recordId,
            transaction_type_id: txData.type || txData.transactionTypeId,
            description: txData.description,
            transaction_hierarchy: txData.transactionHierarchy || 'parent',
            parent_id: txData.parentId || null,
            transaction_date: new Date().toISOString()
        };
        const { error } = await supabase.from('transactions').insert(payload);
        if (error) throw error;
        return { success: true };
    }

};



// 5. İZLEME (MONITORING) SERVİSİ
export const monitoringService = {
    async addMonitoringItem(recordData) {
        // KURAL 1: Orijinal markanın sınıflarını al ve sayıya çevir
        let originalClasses = Array.isArray(recordData.nice_classes) 
            ? recordData.nice_classes.map(c => parseInt(c)).filter(n => !isNaN(n)) 
            : [];
        
        let searchClasses = [...originalClasses];

        // KURAL 2: Eğer 1 ile 34 arasında herhangi bir sınıf varsa, listeye 35. sınıfı da ekle
        const hasGoodsClass = searchClasses.some(c => c >= 1 && c <= 34);
        if (hasGoodsClass && !searchClasses.includes(35)) {
            searchClasses.push(35);
        }

        const payload = {
            id: crypto.randomUUID(), 
            ip_record_id: recordData.ip_record_id,
            
            // 🔥 ÇÖZÜM: search_mark_name alanı payload'dan (veritabanı paketinden) çıkarıldı.
            // Aranacak ibareler (brand_text_search) kısmına varsayılan olarak markanın kendi adını ekliyoruz.
            brand_text_search: recordData.mark_name ? [String(recordData.mark_name)] : [], 
            nice_class_search: searchClasses 
        };

        const { error } = await supabase.from('monitoring_trademarks').insert(payload);
        
        if (error) {
            console.error("İzlemeye Ekleme SQL Hatası Detayı:", JSON.stringify(error, null, 2));
            return { success: false, error: error.message || error.details };
        }
        return { success: true };
    }
};

// 6. DAVA (LITIGATION) SERVİSİ
export const suitService = {
    async getSuits() {
        const { data, error } = await supabase.from('suits').select('*').order('created_at', { ascending: false });
        if (error) {
            console.error("Davalar çekilemedi:", error);
            return { success: false, data: [] };
        }
        
        const mappedData = data.map(s => ({
            id: s.id,
            ...s.details, // Esnek json verilerini dışarı aç
            type: 'litigation',
            status: s.status,
            suitType: s.details?.suitType || '-',
            caseNo: s.file_no || '-',
            court: s.court_name || '-',
            client: { name: s.details?.client?.name || '-' },
            opposingParty: s.defendant || s.details?.opposingParty || '-',
            openedDate: s.created_at
        }));

        return { success: true, data: mappedData };
    }
};

// ==========================================
// 7. İŞLEMLER (TRANSACTIONS) SERVİSİ
// ==========================================

export const transactionService = {
    async getObjectionData() {
        const PARENT_TYPES = ['7', '19', '20'];
        
        // 🔥 ÇÖZÜM 2: transaction_documents(*) eklendi
        const { data: parents, error: parentError } = await supabase
            .from('transactions')
            .select('*, transaction_documents(*)')
            .in('transaction_type_id', PARENT_TYPES)
            .limit(10000); 
            
        if (parentError) return { success: false, error: parentError.message };

        const { data: children, error: childError } = await supabase
            .from('transactions')
            .select('*, transaction_documents(*)')
            .eq('transaction_hierarchy', 'child')
            .limit(10000); 

        const formatData = (rows) => rows.map(r => ({
            id: r.id,
            recordId: r.ip_record_id,
            parentId: r.parent_id || (r.details && r.details.parentId) || null,
            type: r.transaction_type_id || (r.details && r.details.type), 
            transactionHierarchy: r.transaction_hierarchy,
            timestamp: r.transaction_date || r.created_at,
            oppositionOwner: r.opposition_owner,
            documents: r.transaction_documents || [], // Evraklar eklendi
            ...r.details 
        }));

        return { 
            success: true, 
            parents: formatData(parents || []), 
            children: formatData(children || []) 
        };
    }
};

// ==========================================
// 8. GÖREV (TASK) SERVİSİ
// ==========================================
export const taskService = {
    async getAllUsers() {
        const { data, error } = await supabase.from('users').select('id, email, display_name');
        if (error) return { success: false, data: [] };
        return { success: true, data: data.map(u => ({ id: u.id, email: u.email, displayName: u.display_name || u.email })) };
    },

    // 🔥 ADIM 2 DETAYLI LOGLAMALI HARİTALAMA
    async _enrichTasksWithRelations(tasks) {
        if (!tasks || tasks.length === 0) return [];

        const recordIds = [...new Set(tasks.map(t => t.ip_record_id).filter(Boolean))];
        const ownerIds = [...new Set(tasks.map(t => t.task_owner_id).filter(Boolean))];

        let recordsMap = {};
        let personsMap = {};

        // 1. GÖREV SAHİBİNİ ÇEK (task_owner_id)
        if (ownerIds.length > 0) {
            const { data: persons } = await supabase.from('persons').select('id, name').in('id', ownerIds);
            if (persons) persons.forEach(p => { personsMap[p.id] = p.name; });
        }

        // 2. PORTFÖY VERİLERİNİ ÇEK
        if (recordIds.length > 0) {

            // A) Başvuru Numaraları
            const { data: ipRecords } = await supabase.from('ip_records').select('id, application_number').in('id', recordIds);
            
            // B) Marka İsimleri
            const { data: tmDetails } = await supabase.from('ip_record_trademark_details').select('ip_record_id, brand_name').in('ip_record_id', recordIds);
            
            // C) Başvuru Sahipleri (ip_record_applicants)
            const { data: applicants, error: appErr } = await supabase.from('ip_record_applicants')
                .select('ip_record_id, person_id')
                .in('ip_record_id', recordIds);

            if (appErr) console.error("❌ ip_record_applicants Hatası:", appErr);

            // Başvuru sahiplerinin isimlerini persons tablosundan alalım
            let appPersonsMap = {};
            if (applicants && applicants.length > 0) {
                const appPersonIds = [...new Set(applicants.map(a => a.person_id).filter(Boolean))];

                if (appPersonIds.length > 0) {
                    const { data: appPersons, error: persErr } = await supabase.from('persons').select('id, name').in('id', appPersonIds);
                    if (persErr) console.error("❌ persons (applicant) Hatası:", persErr);
                    
                    if (appPersons) appPersons.forEach(p => appPersonsMap[p.id] = p.name);
                }
            } else {
                console.log("⚠️ DİKKAT: ip_record_applicants tablosu bu ip_record_id'ler için BOŞ döndü!");
            }

            // Javascript eşleştirmesi
            if (ipRecords) {
                ipRecords.forEach(ip => {
                    const detail = (tmDetails || []).find(d => d.ip_record_id === ip.id);
                    
                    const apps = (applicants || []).filter(a => a.ip_record_id === ip.id);
                    const applicantNames = apps.map(a => appPersonsMap[a.person_id]).filter(Boolean).join(', ');

                    recordsMap[ip.id] = {
                        appNo: ip.application_number,
                        brandName: detail ? detail.brand_name : null,
                        applicantFallback: applicantNames || null
                    };
                });
            }

            // D) Davalar (suits) - Portföyde bulunamayan id'leri davalarda ararız
            const foundIpIds = Object.keys(recordsMap);
            const missingIds = recordIds.filter(id => !foundIpIds.includes(id));
            if (missingIds.length > 0) {
                const { data: suits } = await supabase.from('suits').select('id, file_no, title, court_name, client_id').in('id', missingIds);
                if (suits) {
                    const suitClientIds = [...new Set(suits.map(s => s.client_id).filter(Boolean))];
                    let suitClientMap = {};
                    if (suitClientIds.length > 0) {
                        const { data: sPersons } = await supabase.from('persons').select('id, name').in('id', suitClientIds);
                        if (sPersons) sPersons.forEach(p => suitClientMap[p.id] = p.name);
                    }

                    suits.forEach(s => {
                        recordsMap[s.id] = {
                            appNo: s.file_no,
                            brandName: s.title || s.court_name,
                            applicantFallback: suitClientMap[s.client_id] || null
                        };
                    });
                }
            }
        }

        // 3. UI Formatına Hazırla
        return tasks.map(t => {
            const ipId = t.ip_record_id || t.related_ip_record_id || (t.details && t.details.ip_record_id);
            const ownerId = t.task_owner_id || t.task_owner || t.related_party_id || (t.details && t.details.task_owner_id);
            
            const recordData = recordsMap[ipId] || {};
            const ownerName = personsMap[ownerId] || null;
            const d = t.details || {};

            const finalAppNo = recordData.appNo || d.application_number || "-";
            const finalBrandName = recordData.brandName || d.brand_name || t.title || "-";
            const finalApplicant = ownerName || recordData.applicantFallback || d.applicant_name || "-";

            return {
                ...t, 
                id: String(t.id),
                title: t.title,
                description: t.description,
                taskType: String(t.task_type_id || t.task_type),
                status: t.status,
                priority: t.priority,
                dueDate: t.operational_due_date || t.official_due_date,
                officialDueDate: t.official_due_date,
                operationalDueDate: t.operational_due_date,
                deliveryDate: t.delivery_date,
                assignedTo_uid: t.assigned_to, 
                relatedIpRecordId: ipId,
                relatedPartyId: ownerId, // 🔥 ÇÖZÜM 1: UI formunda seçili taraf artık gözükecek
                transactionId: t.transaction_id,
                history: d.history || [],
                documents: d.documents || [], 
                createdAt: t.created_at,
                updatedAt: t.updated_at,
                
                iprecordApplicationNo: finalAppNo,
                iprecordTitle: finalBrandName,
                iprecordApplicantName: finalApplicant
            };
        });
    },

    async getTasksForUser(uid) {
        const { data, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
        if (error) return { success: false, error: error.message };
        return { success: true, data: await this._enrichTasksWithRelations(data) };
    },

    async getTasksByStatus(status, uid = null) {
        let query = supabase.from('tasks').select('*').eq('status', status).order('created_at', { ascending: false });
        
        // 🔥 KRİTİK DÜZELTME: assigned_to_uid yerine veritabanındaki doğru kolon olan assigned_to kullanıldı
        if (uid) query = query.eq('assigned_to', uid); 
        
        const { data, error } = await query;
        if (error) return { success: false, error: error.message };
        return { success: true, data: await this._enrichTasksWithRelations(data) };
    },

    async getTaskById(taskId) {
        const { data: taskData, error } = await supabase.from('tasks').select('*').eq('id', String(taskId)).single();
        if (error) return { success: false, error: error.message };
        
        const enrichedData = await this._enrichTasksWithRelations([taskData]);
        const task = enrichedData[0];

        const [docsRes, histRes] = await Promise.all([
            supabase.from('task_documents').select('*').eq('task_id', String(taskId)),
            supabase.from('task_history').select('*').eq('task_id', String(taskId)).order('created_at', { ascending: true })
        ]);

        task.documents = (docsRes.data || []).map(d => ({
            id: d.id, name: d.document_name, url: d.document_url, downloadURL: d.document_url,
            type: d.document_type, uploadedAt: d.uploaded_at,
            storagePath: d.document_url?.includes('/public/') ? d.document_url.split('/public/')[1] : ''
        }));

        task.history = (histRes.data || []).map(h => ({
            id: h.id, action: h.action, userEmail: h.user_id, timestamp: h.created_at
        }));

        // 🔥 İtiraz Sahibi (Opposition Owner) Bulma Mantığı (Temizlenmiş)
        let oppositionOwner = null;
        try {
            const { data: subTrans } = await supabase
                .from('transactions')
                .select('parent_id')
                .eq('task_id', String(taskId))
                .limit(1)
                .maybeSingle();

            if (subTrans && subTrans.parent_id) {
                const { data: parentTrans } = await supabase
                    .from('transactions')
                    .select('opposition_owner')
                    .eq('id', subTrans.parent_id)
                    .maybeSingle();

                if (parentTrans && parentTrans.opposition_owner) {
                    const ownerData = parentTrans.opposition_owner;
                    if (String(ownerData).includes('-') && String(ownerData).length > 20) {
                        const { data: personData } = await supabase
                            .from('persons')
                            .select('name')
                            .eq('id', ownerData)
                            .maybeSingle();
                        oppositionOwner = personData ? personData.name : ownerData;
                    } else {
                        oppositionOwner = ownerData;
                    }
                }
            }
        } catch (transErr) {
            console.error("İtiraz sahibi eşleştirilirken hata oluştu:", transErr);
        }

        task.oppositionOwner = oppositionOwner || null;
        return { success: true, data: task };
    },

    async addTask(taskData) {
        try {
            // 🔥 YENİ: Oturumu alıp created_by (Oluşturan) bilgisini kesin olarak kaydediyoruz
            const { data: { session } } = await supabase.auth.getSession();
            const createdByUser = session?.user?.email || 'Sistem';

            const nextId = await this._getNextTaskId(taskData.taskType || taskData.task_type_id);
            const payload = {
                id: nextId, 
                title: taskData.title,
                description: taskData.description || null,
                task_type_id: String(taskData.taskType || taskData.task_type_id),
                status: taskData.status || 'open',
                priority: taskData.priority || 'normal',
                official_due_date: taskData.officialDueDate || taskData.official_due_date || null,
                operational_due_date: taskData.operationalDueDate || taskData.operational_due_date || null,
                assigned_to: taskData.assignedTo_uid || taskData.assigned_to || null,
                ip_record_id: taskData.relatedIpRecordId || taskData.ip_record_id ? String(taskData.relatedIpRecordId || taskData.ip_record_id) : null,
                task_owner_id: taskData.relatedPartyId || taskData.task_owner_id || null,
                transaction_id: taskData.transactionId || taskData.transaction_id ? String(taskData.transactionId || taskData.transaction_id) : null,
                details: { target_accrual_id: taskData.target_accrual_id || taskData.targetAccrualId || null },
                created_by: taskData.createdBy || taskData.created_by || createdByUser // 🔥 EKLENDİ
            };
            
            Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });
            const { data, error } = await supabase.from('tasks').insert(payload).select('id').single();
            if (error) throw error;

            if (taskData.history && taskData.history.length > 0) {
                const histToInsert = taskData.history.map(h => ({
                    task_id: data.id, action: h.action, user_id: h.userEmail, created_at: h.timestamp || new Date().toISOString(), details: {}
                }));
                await supabase.from('task_history').insert(histToInsert);
            }

            return { success: true, data: { id: data.id } };
        } catch (error) { return { success: false, error: error.message }; }
    },
    
    async createTask(taskData) { return await this.addTask(taskData); },

    async updateTask(taskId, updateData) {
        try {
            const payload = {
                title: updateData.title,
                description: updateData.description,
                task_type_id: updateData.taskType ? String(updateData.taskType) : undefined,
                status: updateData.status,
                priority: updateData.priority,
                official_due_date: updateData.officialDueDate || updateData.official_due_date,
                operational_due_date: updateData.operationalDueDate || updateData.operational_due_date,
                assigned_to: updateData.assignedTo_uid || updateData.assigned_to,
                ip_record_id: updateData.relatedIpRecordId ? String(updateData.relatedIpRecordId) : undefined,
                transaction_id: updateData.transactionId ? String(updateData.transactionId) : undefined,
                task_owner_id: updateData.relatedPartyId ? String(updateData.relatedPartyId) : undefined,
                updated_at: new Date().toISOString()
            };

            Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });
            const { error } = await supabase.from('tasks').update(payload).eq('id', String(taskId));
            if (error) throw error;

            // DÖKÜMANLARI TABLOYA SENKRONİZE ET
            if (updateData.documents !== undefined) {
                await supabase.from('task_documents').delete().eq('task_id', String(taskId));
                if (updateData.documents.length > 0) {
                    const docsToInsert = updateData.documents.map(d => ({
                        task_id: String(taskId),
                        document_name: d.name,
                        document_url: d.url || d.downloadURL,
                        document_type: d.type || 'task_document'
                    }));
                    await supabase.from('task_documents').insert(docsToInsert);
                }
            }

            // 🔥 ÇÖZÜM 2 (Devamı): GEÇMİŞTE SADECE YENİLERİ EKLE (409 Hatasını Engeller)
            if (updateData.history && updateData.history.length > 0) {
                const newHistories = updateData.history.filter(h => !h.id); 
                
                if (newHistories.length > 0) {
                    // Mevcut oturumdan kullanıcının gerçek ID'sini alalım
                    const { data: { session } } = await supabase.auth.getSession();
                    const currentUserId = session?.user?.id;

                    const histToInsert = newHistories.map(h => ({
                        task_id: String(taskId),
                        action: h.action,
                        // 🔥 KRİTİK: Email yerine session'dan gelen gerçek USER ID'yi yazıyoruz
                        user_id: currentUserId || h.userEmail, 
                        created_at: h.timestamp || new Date().toISOString(),
                        details: { user_email: h.userEmail } // E-postayı yedek olarak details içine atabiliriz
                    }));

                    const { error: histError } = await supabase
                        .from('task_history')
                        .insert(histToInsert);
                    
                    if (histError) console.error("❌ History Hatası:", histError.message);
                }
            }

            return { success: true };
        } catch (error) { 
            return { success: false, error: error.message }; 
        }
    },

    async _getNextTaskId(taskType) {
        try {
            const isAccrualTask = String(taskType) === '53';
            const counterId = isAccrualTask ? 'tasks_accruals' : 'tasks';
            const prefix = isAccrualTask ? 'T-' : '';

            const { data: counterData } = await supabase.from('counters').select('last_id').eq('id', counterId).single();

            let nextNum = (counterData?.last_id || 0) + 1;
            let isFree = false;
            let finalId = '';
            
            while (!isFree) {
                finalId = `${prefix}${nextNum}`; 
                const { data: existingTask } = await supabase.from('tasks').select('id').eq('id', finalId).maybeSingle(); 
                if (!existingTask) isFree = true; else nextNum++; 
            }

            await supabase.from('counters').upsert({ id: counterId, last_id: nextNum }, { onConflict: 'id' });
            return finalId;
        } catch (e) {
            const fallbackId = String(Date.now()).slice(-6); 
            return String(taskType) === '53' ? `T-${fallbackId}` : fallbackId;
        }
    }
};

// ==========================================
// 9. TAHAKKUK (ACCRUAL) SERVİSİ
// ==========================================
// ==========================================
// 9. TAHAKKUK (ACCRUAL) SERVİSİ
// ==========================================
export const accrualService = {
    
    async _getNextAccrualId() {
        try {
            const counterId = 'accruals'; 
            const { data: counterData } = await supabase.from('counters').select('last_id').eq('id', counterId).single();

            let nextNum = (counterData?.last_id || 0) + 1;
            let isFree = false;
            let finalId = '';
            
            while (!isFree) {
                finalId = String(nextNum); 
                const { data: existingAccrual } = await supabase.from('accruals').select('id').eq('id', finalId).maybeSingle(); 
                if (!existingAccrual) isFree = true;
                else nextNum++; 
            }

            await supabase.from('counters').upsert({ id: counterId, last_id: nextNum }, { onConflict: 'id' });
            return finalId;
        } catch (e) {
            return String(Date.now()).slice(-6); 
        }
    },

    async addAccrual(accrualData) {
        try {
            const nextId = await this._getNextAccrualId();
            
            const payload = { 
                id: nextId,
                task_id: String(accrualData.taskId),
                status: accrualData.status || 'unpaid',
                accrual_type: accrualData.accrualType || null,
                payment_date: accrualData.paymentDate || null,
                evreka_invoice_no: accrualData.evrekaInvoiceNo || null,
                tpe_invoice_no: accrualData.tpeInvoiceNo || null,
                tp_invoice_party_id: accrualData.tpInvoicePartyId || null,
                service_invoice_party_id: accrualData.serviceInvoicePartyId || null,
                official_fee_amount: accrualData.officialFeeAmount || 0,
                official_fee_currency: accrualData.officialFeeCurrency || 'TRY',
                service_fee_amount: accrualData.serviceFeeAmount || 0,
                service_fee_currency: accrualData.serviceFeeCurrency || 'TRY',
                
                // 🔥 YENİ DB MANTIĞI: Dizi (Array) formatını doğrudan kaydediyoruz. 
                // Eğer formdan boş gelirse varsayılan olarak [{ amount: 0, currency: 'TRY' }] yazar.
                total_amount: accrualData.totalAmount || [{ amount: 0, currency: 'TRY' }],
                remaining_amount: accrualData.remainingAmount || [{ amount: 0, currency: 'TRY' }],
                
                vat_rate: accrualData.vatRate || 0,
                apply_vat_to_official_fee: accrualData.applyVatToOfficialFee || false,
                is_foreign_transaction: accrualData.isForeignTransaction || false
            };

            Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });

            const { data, error } = await supabase.from('accruals').insert(payload).select('id').single();
            if (error) throw error;
            return { success: true, data: { id: data.id } };
        } catch (error) {
            console.error("Tahakkuk ekleme hatası:", error);
            return { success: false, error: error.message };
        }
    },

    async updateAccrual(id, updateData) {
        try {
            const payload = {
                status: updateData.status,
                accrual_type: updateData.accrualType,
                payment_date: updateData.paymentDate,
                evreka_invoice_no: updateData.evrekaInvoiceNo,
                tpe_invoice_no: updateData.tpeInvoiceNo,
                tp_invoice_party_id: updateData.tpInvoicePartyId,
                service_invoice_party_id: updateData.serviceInvoicePartyId,
                official_fee_amount: updateData.officialFeeAmount,
                official_fee_currency: updateData.officialFeeCurrency,
                service_fee_amount: updateData.serviceFeeAmount,
                service_fee_currency: updateData.serviceFeeCurrency,
                
                // 🔥 YENİ DB MANTIĞI: Sadece diziyi güncelliyoruz, ayrı currency kolonları yok.
                total_amount: updateData.totalAmount,
                remaining_amount: updateData.remainingAmount,
                
                vat_rate: updateData.vatRate,
                apply_vat_to_official_fee: updateData.applyVatToOfficialFee,
                is_foreign_transaction: updateData.isForeignTransaction,
                updated_at: new Date().toISOString()
            };

            Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });

            const { error } = await supabase.from('accruals').update(payload).eq('id', String(id));
            if (error) throw error;
            return { success: true };
        } catch (error) {
            console.error("Tahakkuk güncelleme hatası:", error);
            return { success: false, error: error.message };
        }
    },

    async getAccrualsByTaskId(taskId) {
        console.log(`=== TAHAKKUK (ACCRUAL) DEBUG - TASK ID: ${taskId} ===`);
        try {
            const { data, error } = await supabase.from('accruals').select('*').eq('task_id', String(taskId));
            
            if (error) {
                console.error("Supabase'den çekerken hata:", error);
                throw error;
            }
            
            const mappedData = data.map(acc => ({
                id: acc.id,
                taskId: acc.task_id,
                status: acc.status,
                accrualType: acc.accrual_type,
                
                // 🔥 YENİ DB MANTIĞI: Supabase'den gelen JSONB dizisini OLDUĞU GİBİ arayüze paslıyoruz.
                // TaskDetailManager'daki _formatMoney() fonksiyonu bu diziyi otomatik olarak "15150 TRY" şekline çevirecek.
                totalAmount: acc.total_amount, 
                remainingAmount: acc.remaining_amount,
                
                officialFeeAmount: acc.official_fee_amount,
                officialFeeCurrency: acc.official_fee_currency,
                serviceFeeAmount: acc.service_fee_amount,
                serviceFeeCurrency: acc.service_fee_currency,
                tpInvoicePartyId: acc.tp_invoice_party_id,
                serviceInvoicePartyId: acc.service_invoice_party_id,
                createdAt: acc.created_at,
                updatedAt: acc.updated_at
            }));
            
            console.log("UI İçin Haritalanmış Veri:", mappedData);
            return { success: true, data: mappedData };
        } catch (error) {
            console.error("Tahakkukları getirme hatası:", error);
            return { success: false, error: error.message, data: [] };
        }
    }
};

// ==========================================
// 10. MERKEZİ MAİL ALICISI HESAPLAMA SERVİSİ
// ==========================================

// ==========================================
// 10. MERKEZİ MAİL ALICISI HESAPLAMA SERVİSİ
// ==========================================
export const mailService = {
    async resolveMailRecipients(ipRecordId, taskType, clientId = null) {
        console.log(`\n======================================================`);
        console.log(`[MAIL SERVICE] 🚀 BAŞLIYOR...`);
        console.log(`[MAIL SERVICE] Gelen Parametreler -> ipRecordId: ${ipRecordId}, taskType: ${taskType}, clientId (TaskOwner): ${clientId}`);
        
        let toList = [];
        let ccList = [];
        let targetPersonIds = [];

        try {
            const { data: ipRecord, error: ipErr } = await supabase.from('ip_records').select('record_owner_type, ip_type').eq('id', ipRecordId).maybeSingle();
            
            if (ipErr) console.error(`[MAIL SERVICE] ❌ ip_records sorgu hatası:`, ipErr);
            if (!ipRecord) {
                console.warn(`[MAIL SERVICE] ⚠️ IP Record bulunamadı! ID: ${ipRecordId}`);
                return { to: [], cc: [] };
            }

            const ipType = ipRecord.ip_type || 'trademark';
            const isThirdParty = ipRecord.record_owner_type === 'third_party';
            console.log(`[MAIL SERVICE] 📋 Dosya Bilgisi -> ipType: ${ipType}, isThirdParty: ${isThirdParty}`);

            // Task Owner arayüzden iletildiyse doğrudan hedefe ekle
            if (clientId) {
                targetPersonIds.push(clientId);
                console.log(`[MAIL SERVICE] 🎯 Arayüzden clientId (Task Owner) geldi: ${clientId}`);
            }

            // Kendi dosyamızsa ve Task Owner gelmediyse başvuru sahiplerine bak
            if (!isThirdParty && targetPersonIds.length === 0) {
                console.log(`[MAIL SERVICE] 🔍 Kendi dosyamız. Başvuru sahipleri (applicants) aranıyor...`);
                const { data: applicants } = await supabase.from('ip_record_applicants').select('person_id').eq('ip_record_id', ipRecordId);
                if (applicants && applicants.length > 0) {
                    applicants.forEach(app => targetPersonIds.push(app.person_id));
                }
            }

            // KESİN KURAL: Sadece persons_related tablosuna bakılır.
            if (targetPersonIds.length > 0) {
                console.log(`[MAIL SERVICE] 🕵️ persons_related (İlgili Kişiler) tablosu taranıyor... Aranan person_id'ler:`, targetPersonIds);
                
                const { data: relatedPersons, error: relErr } = await supabase.from('persons_related').select('*').in('person_id', targetPersonIds);

                if (relErr) console.error(`[MAIL SERVICE] ❌ persons_related sorgu hatası:`, relErr);

                if (relatedPersons && relatedPersons.length > 0) {
                    console.log(`[MAIL SERVICE] ✅ persons_related tablosunda ${relatedPersons.length} adet kayıt BULUNDU.`);
                    console.log(`[MAIL SERVICE] 📦 Dönen Ham Veri:`, JSON.stringify(relatedPersons, null, 2));

                    relatedPersons.forEach(related => {
                        const email = related.email ? related.email.trim().toLowerCase() : null;
                        if (!email) {
                            console.log(`[MAIL SERVICE] ⏭️ ATLANDI: Kayıt var ama email adresi boş. (ID: ${related.id})`);
                            return;
                        }

                        let isResponsible = false, notifyTo = false, notifyCc = false;

                        if (ipType === 'trademark') {
                            isResponsible = related.resp_trademark;
                            notifyTo = related.notify_trademark_to;
                            notifyCc = related.notify_trademark_cc;
                        } else if (ipType === 'patent') {
                            isResponsible = related.resp_patent;
                            notifyTo = related.notify_patent_to;
                            notifyCc = related.notify_patent_cc;
                        } else if (ipType === 'design') {
                            isResponsible = related.resp_design;
                            notifyTo = related.notify_design_to;
                            notifyCc = related.notify_design_cc;
                        }

                        console.log(`[MAIL SERVICE] ⚙️ EŞLEŞTİRME -> Email: ${email} | Tür: ${ipType} | Sorumlu mu?: ${isResponsible} | TO İzni: ${notifyTo} | CC İzni: ${notifyCc}`);

                        if (isResponsible) {
                            if (notifyTo) {
                                console.log(`[MAIL SERVICE] 🎯 KABUL EDİLDİ (TO): ${email}`);
                                toList.push(email);
                            }
                            if (notifyCc) {
                                console.log(`[MAIL SERVICE] 🎯 KABUL EDİLDİ (CC): ${email}`);
                                ccList.push(email);
                            }
                            if (!notifyTo && !notifyCc) {
                                console.log(`[MAIL SERVICE] 🚫 REDDEDİLDİ: Sorumlu ama TO ve CC izni False.`);
                            }
                        } else {
                            console.log(`[MAIL SERVICE] 🚫 REDDEDİLDİ: Bu türden (${ipType}) sorumlu değil (False).`);
                        }
                    });
                } else {
                    console.warn(`[MAIL SERVICE] ⚠️ DİKKAT: persons_related tablosunda bu person_id'ler için HİÇBİR KAYIT YOK! Veritabanında ilgili kişi eklenmemiş.`);
                }
            } else {
                console.warn(`[MAIL SERVICE] ⚠️ targetPersonIds listesi boş! Aranacak kimse yok.`);
            }

            console.log(`[MAIL SERVICE] 🏢 Evreka içi CC (evreka_mail_cc_list) kontrolü yapılıyor...`);
            const { data: internalCcs } = await supabase.from('evreka_mail_cc_list').select('email, transaction_types');
            if (internalCcs && internalCcs.length > 0) {
                internalCcs.forEach(internal => {
                    if (internal.email) {
                        const types = internal.transaction_types || [];
                        if (types.includes('All') || types.includes(String(taskType)) || types.includes(Number(taskType))) {
                            ccList.push(internal.email.trim().toLowerCase());
                        }
                    }
                });
            }

            toList = [...new Set(toList)].filter(Boolean);
            ccList = [...new Set(ccList)].filter(Boolean);
            ccList = ccList.filter(email => !toList.includes(email));

            console.log(`[MAIL SERVICE] 🎉 FİNAL LİSTE => TO:`, toList, `| CC:`, ccList);
            console.log(`======================================================\n`);
            
            return { to: toList, cc: ccList };
        } catch (error) {
            console.error(`[MAIL SERVICE] ❌ KRİTİK HATA:`, error);
            return { to: [], cc: [] };
        }
    }
};

// ==========================================
// 11. MERKEZİ EVRAK (ATTACHMENT) ÇÖZÜMLEME SERVİSİ
// ==========================================
export const attachmentService = {
    async resolveAttachments(transactionId, sourceDocumentId) {
        console.log(`[ATTACHMENT SERVICE] Evraklar çözümleniyor... txId: ${transactionId}, sourceId: ${sourceDocumentId}`);
        let attachments = [];
        let transactionIdsToFetch = [];

        try {
            if (transactionId) {
                transactionIdsToFetch.push(transactionId);
                
                // 1. İşlem Tipini (Type) ve Ana İşlemi (Parent) Bul
                const { data: txData } = await supabase
                    .from('transactions')
                    .select('transaction_type_id, parent_id')
                    .eq('id', transactionId)
                    .maybeSingle();
                
                // 🔥 KURAL: Sadece Tip 27 ise Parent evraklarını çek
                if (txData && String(txData.transaction_type_id) === '27' && txData.parent_id) {
                    transactionIdsToFetch.push(txData.parent_id);
                    console.log(`[ATTACHMENT SERVICE] Tip 27 algılandı. Ana İşlem (Parent) evrakları listeye eklendi: ${txData.parent_id}`);
                } else {
                    console.log(`[ATTACHMENT SERVICE] Tip 27 değil (İşlem Tipi: ${txData?.transaction_type_id || 'Bilinmiyor'}). Sadece kendi evrakı alınacak.`);
                }

                // 2. Belirlenen işlemlerin evraklarını çek
                const { data: txDocs } = await supabase
                    .from('transaction_documents')
                    .select('document_name, document_url')
                    .in('transaction_id', transactionIdsToFetch);
                    
                if (txDocs && txDocs.length > 0) {
                    txDocs.forEach(d => attachments.push({ name: d.document_name, url: d.document_url }));
                }
            }

            // 3. Gelen ana evrakı (Tebliğ edilen PDF) kontrol et
            if (sourceDocumentId) {
                const { data: docData } = await supabase
                    .from('incoming_documents')
                    .select('file_name, file_url')
                    .eq('id', sourceDocumentId)
                    .maybeSingle();
                    
                if (docData && docData.file_url) {
                    attachments.push({ name: docData.file_name || 'Tebliğ Evrakı.pdf', url: docData.file_url });
                }
            }

            // 4. Temizlik (Aynı URL'ye sahip dosyaları teke düşür - Deduplication)
            const uniqueAttachments = [];
            const urls = new Set();
            for (const att of attachments) {
                if (att.url && !urls.has(att.url)) {
                    urls.add(att.url);
                    uniqueAttachments.push(att);
                }
            }

            console.log(`[ATTACHMENT SERVICE] Toplam ${uniqueAttachments.length} benzersiz evrak bulundu.`);
            return uniqueAttachments;
        } catch (err) {
            console.error(`[ATTACHMENT SERVICE] Hata:`, err);
            return [];
        }
    }
};

// ==========================================
// 12.MERKEZİ STORAGE (DOSYA YÜKLEME) SERVİSİ
// ==========================================
export const storageService = {
    // path formatı: 'persons/KISI_ID/belge.pdf' veya 'tasks/TASK_ID/evrak.pdf'
    async uploadFile(bucketName, path, file) {
        try {
            const { data, error } = await supabase.storage
                .from(bucketName)
                .upload(path, file, {
                    cacheControl: '3600',
                    upsert: true // Aynı isimde dosya varsa üzerine yazar
                });

            if (error) throw error;

            // Yüklenen dosyanın public URL'ini al
            const { data: urlData } = supabase.storage
                .from(bucketName)
                .getPublicUrl(path);

            return { success: true, url: urlData.publicUrl };
        } catch (error) {
            console.error(`[STORAGE] Dosya yükleme hatası (${path}):`, error);
            return { success: false, error: error.message };
        }
    }
};

// ==========================================
// 13: ADMİN & KULLANICI YÖNETİMİ SERVİSİ
// ==========================================
export const adminService = {
    // Sadece rolü 'belirsiz' olanları getir
    async getPendingUsers() {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('role', 'belirsiz')
            .order('created_at', { ascending: false });
            
        if (error) {
            console.error("Bekleyen kullanıcılar çekilemedi:", error);
            return { success: false, data: [] };
        }
        return { success: true, data };
    },

    // Kullanıcıyı onayla (Varsayılan olarak 'user' yetkisi verir)
    async approveUser(userId, newRole = 'user') {
        const { error } = await supabase
            .from('users')
            .update({ role: newRole })
            .eq('id', userId);
            
        if (error) return { success: false, error: error.message };
        return { success: true };
    }
};

// ==========================================
// 14: HATIRLATMALAR (REMINDERS) SERVİSİ
// ==========================================
export const reminderService = {
    async getReminders(userId) {
        const { data, error } = await supabase
            .from('reminders')
            .select('*')
            .eq('user_id', userId)
            .order('due_date', { ascending: true });
            
        if (error) {
            console.error("Hatırlatmalar çekilemedi:", error);
            return { success: false, data: [] };
        }
        
        const mappedData = data.map(r => {
            // DB'de category sütunu olmadığı için description'ın başına ekliyoruz [KATEGORİ] Açıklama
            let category = 'KİŞİSEL NOT';
            let desc = r.description || '';
            if (desc.startsWith('[')) {
                const endIdx = desc.indexOf(']');
                if (endIdx > -1) {
                    category = desc.substring(1, endIdx);
                    desc = desc.substring(endIdx + 1).trim();
                }
            }
            
            return {
                id: r.id,
                title: r.title,
                description: desc,
                category: category,
                dueDate: r.due_date,
                status: r.status === 'completed' ? 'completed' : 'active',
                isRead: r.status === 'read' || r.status === 'completed'
            };
        });
        return { success: true, data: mappedData };
    },

    async addReminder(data) {
        const payload = {
            id: crypto.randomUUID(),
            title: data.title,
            // Kategoriyi açıklamanın içine yediriyoruz
            description: `[${data.category || 'KİŞİSEL NOT'}] ${data.description || ''}`,
            due_date: data.dueDate,
            status: 'active',
            user_id: data.userId
        };
        
        const { error } = await supabase.from('reminders').insert(payload);
        if (error) return { success: false, error: error.message };
        return { success: true };
    },

    async updateReminder(id, updates) {
        const payload = { updated_at: new Date().toISOString() };
        
        if (updates.status) payload.status = updates.status;
        if (updates.isRead !== undefined) {
            payload.status = updates.isRead ? 'read' : 'active';
        }
        // İşlem tamamlandıysa üstüne yazmasın
        if (updates.status === 'completed') payload.status = 'completed';

        const { error } = await supabase.from('reminders').update(payload).eq('id', id);
        return { success: !error };
    }
};