import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

// 1. Uygulamanın şu an nerede çalıştığını tespit et
const hostname = window.location.hostname;
const isTestEnvironment = hostname === 'localhost' || hostname.includes('ipgate-supa-test.web.app');

// 2. Ortama göre Supabase URL ve Key belirle
const SUPABASE_URL = isTestEnvironment 
    ? 'https://guicrctynauzxhyfpdfe.supabase.co' // TEST Supabase URL'si
    : 'https://kadxvkejzctwymzeyrrl.supabase.co';    // CANLI Supabase URL'si

const SUPABASE_KEY = isTestEnvironment 
    ? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1aWNyY3R5bmF1enhoeWZwZGZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3MDQ3MjcsImV4cCI6MjA4NzI4MDcyN30.Zp1ZoXfsz6y6UcZtOAWlIWY2USjJ8x-0iogtizX0EkQ'                     // TEST Supabase Anon Key
    : 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthZHh2a2VqemN0d3ltemV5cnJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNzg0NDgsImV4cCI6MjA4Nzc1NDQ0OH0.PFSzq8hOc14HgYwwF_ZR3v82ZzegKcoN4Vqw2wR2ZP0'; // CANLI Supabase Anon Key

// 3. Dinamik bilgilerle Client oluştur
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
console.log(`🚀 Supabase Motoru Çalıştı! Ortam: ${isTestEnvironment ? 'TEST' : 'CANLI'}`);

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
            district: p.district,
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
            validityDate: doc.validity_date,
            authorizedParty: doc.authorized_party
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
            district: data.district,
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
            district: personData.district || null,
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
                validity_date: doc.validityDate || null,
                authorized_party: doc.authorizedParty || null
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
            district: personData.district || null,
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
                    validity_date: doc.validityDate || null,
                    authorized_party: doc.authorizedParty || null
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
            imageUrl = `${SUPABASE_URL}/storage/v1/object/public/brand_images/${record.id}/logo.png`;
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
        imageUrl = `${SUPABASE_URL}/storage/v1/object/public/brand_images/${record.id}/logo.png`;
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

        // 2. MARKA DETAYLARI GÜNCELLEMESİ (🔥 LOGO ÇÖZÜMÜ BURADA)
        const isTrademark = updateData.ipType === 'trademark' || updateData.type === 'trademark' || (updateData.title !== undefined);
        
        // Marka veya marka logosu gelmişse
        if (isTrademark || updateData.brandImageUrl || updateData.brand_image_url || updateData.image_url) {
            const tmPayload = { ip_record_id: id };
            if (updateData.title !== undefined || updateData.brandText !== undefined) tmPayload.brand_name = updateData.title || updateData.brandText;
            if (updateData.brandType !== undefined) tmPayload.brand_type = updateData.brandType;
            if (updateData.brandCategory !== undefined) tmPayload.brand_category = updateData.brandCategory;
            if (updateData.description !== undefined) tmPayload.description = updateData.description;

            // 🔥 ÇÖZÜM: Tüm potansiyel isimleri yakalayıp veritabanındaki tek sütuna atıyoruz
            const incomingImage = updateData.brandImageUrl || updateData.brand_image_url || updateData.image_url;
            if (incomingImage !== undefined) {
                tmPayload.brand_image_url = incomingImage;
            }

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
                    id: crypto.randomUUID(), 
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
                    id: crypto.randomUUID(), 
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
    
    // --- MEVCUT (KORUNAN) İTİRAZ FONKSİYONU ---
    async getObjectionData() {
        const PARENT_TYPES = ['7', '19', '20'];
        try {
            const [parentRes, childRes] = await Promise.all([
                supabase.from('transactions').select('*, transaction_documents(*), tasks(*, task_documents(*))').in('transaction_type_id', PARENT_TYPES).limit(10000),
                supabase.from('transactions').select('*, transaction_documents(*), tasks(*, task_documents(*))').eq('transaction_hierarchy', 'child').limit(10000)
            ]);

            if (parentRes.error) throw parentRes.error;
            if (childRes.error) throw childRes.error;

            const formatData = (rows) => rows.map(r => ({
                ...r, id: r.id, recordId: r.ip_record_id, parentId: r.parent_id || (r.details && r.details.parentId) || null,
                type: r.transaction_type_id || (r.details && r.details.type), transactionHierarchy: r.transaction_hierarchy,
                timestamp: r.transaction_date || r.created_at, oppositionOwner: r.opposition_owner,
                documents: r.transaction_documents || [], ...r.details 
            }));

            return { success: true, parents: formatData(parentRes.data || []), children: formatData(childRes.data || []) };
        } catch (error) {
            console.error("İtiraz verileri servisten çekilirken hata:", error);
            return { success: false, error: error.message };
        }
    },

    // 1. Akıllı Evrak Çıkarıcı (🔥 DÜZELTME: Sadece URL bazlı filtreleme)
    extractDocuments(transaction, taskData) {
        const docs = [];
        const seenUrls = new Set(); 

        // 🔥 YENİ KURAL 1: Bu işlem bir "İtiraz Bildirimi" (Tip 27) mi?
        const isType27 = String(transaction.transaction_type_id) === '27';

        const addDoc = (d, source = 'direct') => {
            if (!d) return;
            const rawUrl = d.document_url || d.file_url || d.url || d.fileUrl || d.downloadURL || d.path;
            if (!rawUrl) return;

            const name = d.document_name || d.file_name || d.name || d.fileName || 'Belge';
            const designation = d.document_designation || d.designation || '';
            const type = d.document_type || d.type || 'document';

            // 🔥 YENİ KURAL 2: Eğer İşlem 27 ise, Dilekçeleri Filtrele!
            // Sadece "Resmi Yazı"nın içeri girmesine izin veriyoruz.
            if (isType27) {
                const searchString = `${name} ${designation} ${type}`.toLowerCase();
                const isPetition = searchString.includes('itiraz') || 
                                   searchString.includes('epats') || 
                                   searchString.includes('dilekçe') ||
                                   type === 'opposition_petition' ||
                                   type === 'epats_document';
                
                // Eğer belge dilekçe/itiraz evrakıysa bu işlemin altına EKLEME! (Sadece Parent'ta kalsın)
                if (isPetition) return;
            }

            const cleanUrl = rawUrl.split('?')[0].toLowerCase(); 

            if (!seenUrls.has(cleanUrl)) {
                seenUrls.add(cleanUrl);
                docs.push({
                    id: d.id || crypto.randomUUID(),
                    // BONUS UI İYİLEŞTİRMESİ: Eğer "designation" (Resmi Yazı vs) varsa, o uzun ID'li dosya adı yerine onu göster
                    name: designation ? designation : name, 
                    url: rawUrl,
                    type: type,
                    source: source,
                    createdAt: d.created_at || d.uploaded_at || null
                });
            }
        };

        // A. İşlem Belgeleri
        if (Array.isArray(transaction.transaction_documents)) transaction.transaction_documents.forEach(td => addDoc(td, 'direct'));
        if (Array.isArray(transaction.documents)) transaction.documents.forEach(d => addDoc(d, 'direct'));
        
        // B. Statik Linkler
        if (transaction.relatedPdfUrl || transaction.related_pdf_url) addDoc({ name: 'Resmi Yazı', url: transaction.relatedPdfUrl || transaction.related_pdf_url, type: 'official_document' }, 'direct');
        if (transaction.oppositionPetitionFileUrl || transaction.opposition_petition_file_url) addDoc({ name: 'İtiraz Dilekçesi', url: transaction.oppositionPetitionFileUrl || transaction.opposition_petition_file_url, type: 'opposition_petition' }, 'direct');
        if (transaction.oppositionEpatsPetitionFileUrl || transaction.opposition_epats_petition_file_url) addDoc({ name: 'Karşı ePATS Dilekçesi', url: transaction.oppositionEpatsPetitionFileUrl || transaction.opposition_epats_petition_file_url, type: 'epats_document' }, 'direct');

        // C. Görev Belgeleri
        if (taskData) {
            let taskDocs = taskData.documents || taskData.task_documents;
            if (typeof taskDocs === 'string') { try { taskDocs = JSON.parse(taskDocs); } catch(e) { taskDocs = []; } }
            if (Array.isArray(taskDocs)) taskDocs.forEach(d => addDoc(d, 'task'));

            if (taskData.epats_doc_url || taskData.epats_doc_download_url) addDoc({ name: taskData.epats_doc_name || 'ePats Belgesi', url: taskData.epats_doc_url || taskData.epats_doc_download_url, type: 'epats_document' }, 'task');
            if (taskData.details) {
                if (taskData.details.epatsDocument) addDoc(taskData.details.epatsDocument, 'task');
                if (Array.isArray(taskData.details.documents)) taskData.details.documents.forEach(d => addDoc(d, 'task'));
            }
        }

        return docs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    },

    processAndOrganizeTransactions(transactions, tasks) {
        const processedTxs = transactions.map(tx => {
            // 🔥 MÜKEMMEL EŞLEŞTİRME (Veritabanındaki tüm ters ve düz bağlar)
            const relatedTask = tasks.find(t => 
                String(t.id) === String(tx.task_id) || 
                String(t.transaction_id) === String(tx.id) || 
                (t.details && String(t.details.triggeringTransactionId) === String(tx.id))
            );
            
            let isTrigger = false;

            if (relatedTask) {
                const taskTxId = relatedTask.transaction_id;
                const taskDetailsTxId = relatedTask.details ? relatedTask.details.triggeringTransactionId : null;
                // Bu işlem gerçekten tetikleyici mi? (İndeksleme)
                isTrigger = (String(taskTxId) === String(tx.id)) || (String(taskDetailsTxId) === String(tx.id));
            }

            // Tetikleyiciyse (İndeksleme) görevdeki belgeleri ona verme!
            const taskDataToExtract = isTrigger ? null : relatedTask;

            const typeObj = tx.transaction_types || {};
            return {
                ...tx,
                typeName: typeObj.alias || typeObj.name || `İşlem ${tx.transaction_type_id || ''}`,
                task_data: relatedTask || null,
                all_documents: this.extractDocuments(tx, taskDataToExtract) 
            };
        });

        // Hiyerarşiyi Kur (Parent & Child)
        const parents = processedTxs.filter(t => t.transaction_hierarchy === 'parent' || !t.parent_id);
        const children = processedTxs.filter(t => t.transaction_hierarchy === 'child' && t.parent_id);

        // Alt işlemleri kendi içinde tarihe göre (yeni en üstte olacak şekilde) sırala
        parents.forEach(p => {
            p.childrenData = children
                .filter(c => String(c.parent_id) === String(p.id))
                .sort((a, b) => new Date(b.transaction_date || b.created_at) - new Date(a.transaction_date || a.created_at));
        });

        // 🔥 YENİ: GRUP BAZLI ÖZEL SIRALAMA (Ana İşlemler İçin)
        return parents.sort((a, b) => {
            // Her işlemin ait olduğu grubu belirliyoruz
            const getGroup = (tx) => {
                const tId = String(tx.transaction_type_id || '');
                if (tId === '2') return 1; // 1. Öncelik: Başvuru
                if (['7', '19', '20'].includes(tId)) return 2; // 2. Öncelik: İtirazlar/Yenilemeler vs.
                return 3; // 3. Öncelik: Diğer hepsi
            };

            const groupA = getGroup(a);
            const groupB = getGroup(b);

            // Eğer grupları farklıysa, önceliği yüksek olan (küçük rakam) yukarı çıksın
            if (groupA !== groupB) {
                return groupA - groupB; 
            }

            // Eğer aynı gruptalarsa, kendi içlerinde tarihe göre (en yeni en üstte) sıralansınlar
            const dateA = new Date(a.transaction_date || a.created_at).getTime();
            const dateB = new Date(b.transaction_date || b.created_at).getTime();
            return dateB - dateA;
        });
    },

    async getTransactionsByIpRecord(ipRecordId) {
        try {
            const [txRes, taskRes] = await Promise.all([
                supabase.from('transactions').select('*, transaction_documents(*)').eq('ip_record_id', ipRecordId).order('transaction_date', { ascending: false }),
                // 🔥 DÜZELTME: task_documents(*) eklendi!
                supabase.from('tasks').select('*, task_documents(*)').eq('ip_record_id', ipRecordId)
            ]);
            
            if (txRes.error) throw txRes.error;
            if (taskRes.error) throw taskRes.error;

            return { success: true, data: this.processAndOrganizeTransactions(txRes.data || [], taskRes.data || []) };
        } catch (error) { return { success: false, error: error.message, data: [] }; }
    },

    async getTransactionsBulk(ipRecordIds) {
        if (!ipRecordIds || ipRecordIds.length === 0) return { success: true, data: [] };
        try {
            const [txRes, taskRes] = await Promise.all([
                supabase.from('transactions').select('*, transaction_documents(*)').in('ip_record_id', ipRecordIds).order('transaction_date', { ascending: false }),
                // 🔥 DÜZELTME: task_documents(*) eklendi!
                supabase.from('tasks').select('*, task_documents(*)').in('ip_record_id', ipRecordIds)
            ]);

            if (txRes.error) throw txRes.error;
            if (taskRes.error) throw taskRes.error;

            return { success: true, data: this.processAndOrganizeTransactions(txRes.data || [], taskRes.data || []) };
        } catch (error) { return { success: false, error: error.message, data: [] }; }
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

    // 🔥 ÇÖZÜM: Karmaşık haritalama fonksiyonu silindi. Veriyi doğrudan hazır View'dan alıyoruz.
    _mapTaskViewData(tasks) {
        return tasks.map(t => {
            const d = t.details || {};
            return {
                ...t,
                taskType: String(t.task_type_id || t.task_type),
                dueDate: t.operational_due_date || t.official_due_date,
                officialDueDate: t.official_due_date,
                operationalDueDate: t.operational_due_date,
                deliveryDate: t.delivery_date,
                assignedTo_uid: t.assigned_to, 
                relatedIpRecordId: t.ip_record_id,
                relatedPartyId: t.task_owner_id, 
                transactionId: t.transaction_id,
                history: d.history || [],
                documents: d.documents || []
            };
        });
    },

    async getTasksForUser(uid) {
        // Tarayıcıyı çökertmemek için son 2000 işi çekiyoruz (Tam çözüm için Server-Side Pagination gerekir)
        const { data, error } = await supabase.from('v_tasks_dashboard')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(2000); 

        if (error) return { success: false, error: error.message };
        return { success: true, data: this._mapTaskViewData(data) };
    },

    async getTasksByStatus(status, uid = null) {
        let query = supabase.from('v_tasks_dashboard')
            .select('*')
            .eq('status', status)
            .order('created_at', { ascending: false })
            .limit(2000);
            
        if (uid) query = query.eq('assigned_to', uid); 
        
        const { data, error } = await query;
        if (error) return { success: false, error: error.message };
        return { success: true, data: this._mapTaskViewData(data) };
    },

    async getTaskById(taskId) {
        // 🔥 ÇÖZÜM: 'tasks' tablosu yerine doğrudan hazır birleştirilmiş View'ımızdan (v_tasks_dashboard) çekiyoruz
        const { data: taskData, error } = await supabase.from('v_tasks_dashboard').select('*').eq('id', String(taskId)).single();
        if (error) return { success: false, error: error.message };
        
        // Sildiğimiz eski fonksiyon yerine, yeni hafif haritalama fonksiyonumuzu kullanıyoruz
        const mappedData = this._mapTaskViewData([taskData]);
        const task = mappedData[0];

        // 🔥 1. YENİLİK: Tahakkukun bağlı olduğu ana görevin ID'sini tespit et

        // 🔥 1. YENİLİK: Tahakkukun bağlı olduğu ana görevin ID'sini tespit et
        // 🔥 DÜZELTME: Artık hem 'parent_task_id' hem de 'relatedTaskId' kontrol ediliyor!
        const parentTaskId = task.details?.parent_task_id || task.details?.relatedTaskId || null;
        
        const taskIdsToFetch = [String(taskId)];
        if (parentTaskId) taskIdsToFetch.push(String(parentTaskId));

        // 🔥 2. YENİLİK: Hem mevcut görevin hem de ana görevin dokümanlarını çek
        const [docsRes, histRes, parentTaskRes] = await Promise.all([
            supabase.from('task_documents').select('*').in('task_id', taskIdsToFetch), 
            supabase.from('task_history').select('*').eq('task_id', String(taskId)).order('created_at', { ascending: true }),
            // Ana görevin tasks tablosundaki JSON belgelerini (ePATS) okumak için kendisini çek
            parentTaskId ? supabase.from('tasks').select('*').eq('id', String(parentTaskId)).maybeSingle() : Promise.resolve({ data: null })
        ]);

        // 🔥 3. YENİLİK: task_documents tablosundan gelen evrakları haritala
        task.documents = (docsRes.data || []).map(d => ({
            id: d.id, 
            name: d.task_id === String(taskId) ? d.document_name : `(Ana Görev) ${d.document_name}`, 
            url: d.document_url, 
            downloadURL: d.document_url,
            type: d.document_type, 
            uploadedAt: d.uploaded_at,
            storagePath: d.document_url?.includes('/public/') ? d.document_url.split('/public/')[1] : ''
        }));

        // 🔥 4. YENİLİK: Ana Görev'in (Parent Task) JSON datası içindeki ePATS veya ekstra evrakları yakala
        if (parentTaskRes.data) {
            const pTask = parentTaskRes.data;
            
            // Senaryo A: Yeni ePATS belge yapısı (details.epatsDocument)
            if (pTask.details && pTask.details.epatsDocument) {
                const epats = pTask.details.epatsDocument;
                if (!task.documents.some(d => d.url === epats.url)) {
                    task.documents.push({
                        id: crypto.randomUUID(),
                        name: `(Ana Görev) ${epats.name || 'ePATS Belgesi'}`,
                        url: epats.url,
                        downloadURL: epats.url,
                        type: epats.type || 'epats_document'
                    });
                }
            }
            
            // Senaryo B: Eski ePATS belge yapısı (epats_doc_url)
            if (pTask.epats_doc_url || pTask.epats_doc_download_url) {
                const epatsUrl = pTask.epats_doc_url || pTask.epats_doc_download_url;
                if (!task.documents.some(d => d.url === epatsUrl)) {
                    task.documents.push({
                        id: crypto.randomUUID(),
                        name: `(Ana Görev) ${pTask.epats_doc_name || 'ePATS Belgesi'}`,
                        url: epatsUrl,
                        downloadURL: epatsUrl,
                        type: 'epats_document'
                    });
                }
            }

            // Senaryo C: JSON içinde liste halinde tutulan ekstra belgeler (details.documents)
            if (pTask.details && Array.isArray(pTask.details.documents)) {
                pTask.details.documents.forEach(doc => {
                    if (doc.url && !task.documents.some(d => d.url === doc.url)) {
                        task.documents.push({
                            id: crypto.randomUUID(),
                            name: `(Ana Görev) ${doc.name || 'Belge'}`,
                            url: doc.url,
                            downloadURL: doc.url,
                            type: doc.type || 'document'
                        });
                    }
                });
            }
        }

        task.history = (histRes.data || []).map(h => ({
            id: h.id, action: h.action, userEmail: h.user_id, timestamp: h.created_at
        }));

        // 🔥 İtiraz Sahibi (Opposition Owner) Bulma Mantığı
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
        console.log(`\n=================================================`);
        console.log(`[TASK SERVICE] 🚀 addTask BAŞLADI.`);
        console.log(`[TASK SERVICE] 📦 Gelen Ham Veri (taskData):`, taskData);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            
            // 🔥 KORUMA 1: created_by (Oluşturan) her zaman UUID olmak zorundadır. Email yazılırsa DB reddeder!
            const createdByUser = session?.user?.id || null;

            // 🔥 KORUMA 2: assigned_to (Atanan) kişi veritabanında gerçekten var mı?
            // Test ortamında hardcoded ID'ler (örn: Selcan Hanım) bulunmayabilir. Sistem çökmek yerine işlemi yapana atar.
            let finalAssignedTo = taskData.assignedTo_uid || taskData.assigned_to || null;
            
            if (finalAssignedTo) {
                const { data: checkUser } = await supabase.from('users').select('id').eq('id', finalAssignedTo).maybeSingle();
                if (!checkUser) {
                    console.warn(`[TASK SERVICE] ⚠️ Atanan kullanıcı (${finalAssignedTo}) 'users' tablosunda yok! Görev size atanıyor.`);
                    finalAssignedTo = createdByUser; 
                }
            } else {
                finalAssignedTo = createdByUser; 
            }

            let isInserted = false;
            let insertedData = null;
            let retryCount = 0;
            const maxRetries = 15;

            while (!isInserted && retryCount < maxRetries) {
                const nextId = await this._getNextTaskId(taskData.taskType || taskData.task_type_id, retryCount);
                console.log(`[TASK SERVICE] 🎫 Üretilen / Denenecek Task ID: ${nextId}`);
                
            const payload = { 
                    id: nextId, 
                    title: taskData.title,
                    description: taskData.description || null,
                    task_type_id: String(taskData.taskType || taskData.task_type_id),
                    status: taskData.status || 'open',
                    priority: taskData.priority || 'normal',
                    official_due_date: taskData.officialDueDate || taskData.official_due_date || null,
                    operational_due_date: taskData.operationalDueDate || taskData.operational_due_date || null,
                    assigned_to: finalAssignedTo,
                    ip_record_id: taskData.relatedIpRecordId || taskData.ip_record_id ? String(taskData.relatedIpRecordId || taskData.ip_record_id) : null,
                    task_owner_id: taskData.relatedPartyId || taskData.task_owner_id || null,
                    transaction_id: taskData.transactionId || taskData.transaction_id ? String(taskData.transactionId || taskData.transaction_id) : null,
                    
                    // 🔥 ÇÖZÜM: Gelen details objesini KORU, eski target_accrual_id mantığını da güvenli bir şekilde içine yedir.
                    details: {
                        ...(taskData.details || {}),
                        target_accrual_id: taskData.target_accrual_id || taskData.targetAccrualId || taskData.details?.target_accrual_id || null
                    },
                    
                    created_by: taskData.createdBy || taskData.created_by || createdByUser
                };

                Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });
                console.log(`[TASK SERVICE] 📤 Supabase'e Gönderilecek INSERT Payload'u:`, payload);

                const { data, error } = await supabase.from('tasks').insert(payload).select('id').single();
                
                if (error) {
                    console.error(`[TASK SERVICE] ❌ INSERT HATASI ALINDI! (Deneme ${retryCount + 1})`);
                    console.error(`[TASK SERVICE] 🚨 HATA DETAYI:`, JSON.stringify(error, null, 2));

                    if (error.code === '23505' || error.message?.includes('duplicate')) {
                        console.warn(`[TASK SERVICE] ⚠️ 409 Çakışması! Yeni ID için retry yapılacak...`);
                        retryCount++;
                        await new Promise(r => setTimeout(r, 100)); 
                        continue;
                    }
                    
                    // Foreign Key veya başka bir hataysa fırlat
                    throw error; 
                }
                
                console.log(`[TASK SERVICE] ✅ INSERT BAŞARILI! Dönen Data:`, data);
                insertedData = data;
                isInserted = true;
            }

            if (!isInserted) {
                console.error(`[TASK SERVICE] ❌ ${maxRetries} deneme yapıldı ama başarılı olunamadı.`);
                throw new Error("Görev ID'si alınamadı, sistemde yoğun çakışma var.");
            }

            if (taskData.history && taskData.history.length > 0) {
                console.log(`[TASK SERVICE] 📜 Geçmiş (History) tablosuna yazılıyor...`);
                const histToInsert = taskData.history.map(h => ({
                    task_id: insertedData.id, 
                    action: h.action, 
                    user_id: createdByUser, // 🛡️ History tablosunda da UUID zorunlu
                    created_at: h.timestamp || new Date().toISOString(), 
                    details: { user_email: h.userEmail }
                }));
                await supabase.from('task_history').insert(histToInsert);
            }

            console.log(`[TASK SERVICE] 🎉 İŞLEM TAMAMLANDI.`);
            console.log(`=================================================\n`);
            return { success: true, data: { id: insertedData.id } };
        } catch (error) { 
            console.error(`[TASK SERVICE] 💥 CATCH BLOĞU (KRİTİK HATA):`, error);
            return { success: false, error: error }; 
        }
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

    async _getNextTaskId(taskType, currentRetry = 0) {
        console.log(`[TASK SERVICE] 🔢 _getNextTaskId Çalıştı -> type: ${taskType}, retry: ${currentRetry}`);
        try {
            const isAccrualTask = String(taskType) === '53';
            const counterId = isAccrualTask ? 'tasks_accruals' : 'tasks';
            const prefix = isAccrualTask ? 'T-' : '';

            const { data: counterData, error: counterErr } = await supabase.from('counters').select('last_id').eq('id', counterId).maybeSingle();
            
            if (counterErr) console.error(`[TASK SERVICE] ❌ Counter okuma hatası:`, counterErr);

            let nextNum = (counterData?.last_id || 0) + 1 + currentRetry;
            console.log(`[TASK SERVICE] 📊 Veritabanındaki last_id: ${counterData?.last_id || 0} | Hesaplanıp Denenecek Olan: ${nextNum}`);

            const { error: upsertErr } = await supabase.from('counters').upsert({ id: counterId, last_id: nextNum }, { onConflict: 'id' });
            
            if (upsertErr) console.error(`[TASK SERVICE] ❌ Counter güncelleme (upsert) hatası:`, upsertErr);

            return `${prefix}${nextNum}`;
        } catch (e) {
            console.error("[TASK SERVICE] 💥 _getNextTaskId Kritik Hata:", e);
            const fallbackId = String(Date.now()).slice(-6); 
            return String(taskType) === '53' ? `T-${fallbackId}` : fallbackId;
        }
    }
};

// 9. TAHAKKUK (ACCRUAL) SERVİSİ
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

    async _handleAccrualFiles(accrualId, files) {
        if (!files || files.length === 0) return;
        const docInserts = [];
        for (const fileObj of files) {
            const actualFile = fileObj instanceof File ? fileObj : fileObj.file;
            if (actualFile instanceof File || actualFile instanceof Blob) {
                const cleanFileName = actualFile.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                const filePath = `accruals/${accrualId}/${Date.now()}_${cleanFileName}`;
                const { error: uploadError } = await supabase.storage.from('documents').upload(filePath, actualFile);
                if (!uploadError) {
                    const { data: urlData } = supabase.storage.from('documents').getPublicUrl(filePath);
                    docInserts.push({ accrual_id: String(accrualId), document_name: actualFile.name, document_url: urlData.publicUrl, document_type: actualFile.type || 'other' });
                }
            }
        }
        if (docInserts.length > 0) await supabase.from('accrual_documents').insert(docInserts);
    },

    async deleteDocumentFully(documentId, fileUrl) {
        try {
            let filePath = '';
            if (fileUrl && fileUrl.includes('/documents/')) filePath = decodeURIComponent(fileUrl.split('/documents/')[1]);
            if (filePath) await supabase.storage.from('documents').remove([filePath]);
            if (documentId) await supabase.from('accrual_documents').delete().eq('id', String(documentId));
            return { success: true };
        } catch (error) { return { success: false, error: error.message }; }
    },

    async addAccrual(accrualData) {
        try {
            let isInserted = false, insertedData = null, retryCount = 0;
            while (!isInserted && retryCount < 5) {
                const nextId = accrualData.id || await this._getNextAccrualId();
                const payload = { 
                    id: nextId,
                    task_id: accrualData.taskId ? String(accrualData.taskId) : null,
                    status: accrualData.status || 'unpaid',
                    accrual_type: accrualData.accrualType || accrualData.type || null,
                    payment_date: accrualData.paymentDate || null,
                    evreka_invoice_no: accrualData.evrekaInvoiceNo || null,
                    tpe_invoice_no: accrualData.tpeInvoiceNo || null,
                    tp_invoice_party_id: accrualData.tpInvoicePartyId || null,
                    service_invoice_party_id: accrualData.serviceInvoicePartyId || null,
                    official_fee_amount: accrualData.officialFeeAmount || accrualData.officialFee?.amount || 0,
                    official_fee_currency: accrualData.officialFeeCurrency || accrualData.officialFee?.currency || 'TRY',
                    service_fee_amount: accrualData.serviceFeeAmount || accrualData.serviceFee?.amount || 0,
                    service_fee_currency: accrualData.serviceFeeCurrency || accrualData.serviceFee?.currency || 'TRY',
                    total_amount: accrualData.totalAmount || [{ amount: 0, currency: 'TRY' }],
                    remaining_amount: accrualData.remainingAmount || [{ amount: 0, currency: 'TRY' }],
                    vat_rate: accrualData.vatRate || 0,
                    apply_vat_to_official_fee: accrualData.applyVatToOfficialFee || false,
                    is_foreign_transaction: accrualData.isForeignTransaction || false,
                    description: accrualData.description || null 
                };
                Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });
                const { data, error } = await supabase.from('accruals').insert(payload).select('id').single();
                if (error) { if (error.code === '23505' || error.message?.includes('duplicate')) { retryCount++; continue; } throw error; }
                insertedData = data; isInserted = true;
            }

            if (!isInserted) throw new Error("Tahakkuk ID'si alınamadı.");

            // 🔥 YENİ: Alt Kalemleri (Fatura Satırlarını) Veritabanına Yaz
            if (accrualData.items && accrualData.items.length > 0) {
                const itemInserts = accrualData.items.map(item => ({
                    accrual_id: insertedData.id,
                    fee_type: item.fee_type,
                    item_name: item.item_name,
                    quantity: item.quantity,
                    unit_price: item.unit_price,
                    vat_rate: item.vat_rate,
                    total_amount: item.total_amount,
                    currency: item.currency || 'TRY'
                }));
                await supabase.from('accrual_items').insert(itemInserts);
            }

            if (accrualData.files && accrualData.files.length > 0) await this._handleAccrualFiles(insertedData.id, accrualData.files);
            return { success: true, data: { id: insertedData.id } };
        } catch (error) { return { success: false, error: error.message }; }
    },

    async updateAccrual(id, updateData) {
        try {
            const payload = {
                status: updateData.status,
                accrual_type: updateData.accrualType || updateData.type,
                payment_date: updateData.paymentDate,
                evreka_invoice_no: updateData.evrekaInvoiceNo,
                tpe_invoice_no: updateData.tpeInvoiceNo,
                tp_invoice_party_id: updateData.tpInvoicePartyId,
                service_invoice_party_id: updateData.serviceInvoicePartyId,
                official_fee_amount: updateData.officialFeeAmount || updateData.officialFee?.amount,
                official_fee_currency: updateData.officialFeeCurrency || updateData.officialFee?.currency,
                service_fee_amount: updateData.serviceFeeAmount || updateData.serviceFee?.amount,
                service_fee_currency: updateData.serviceFeeCurrency || updateData.serviceFee?.currency,
                total_amount: updateData.totalAmount,
                remaining_amount: updateData.remainingAmount,
                vat_rate: updateData.vatRate,
                apply_vat_to_official_fee: updateData.applyVatToOfficialFee,
                is_foreign_transaction: updateData.isForeignTransaction,
                description: updateData.description,
                updated_at: new Date().toISOString()
            };
            Object.keys(payload).forEach(key => { if (payload[key] === undefined) delete payload[key]; });
            const { error } = await supabase.from('accruals').update(payload).eq('id', String(id));
            if (error) throw error;

            // 🔥 YENİ: Eski Alt Kalemleri Sil ve Yenilerini Ekle (Senkronizasyon)
            if (updateData.items) {
                await supabase.from('accrual_items').delete().eq('accrual_id', String(id));
                if (updateData.items.length > 0) {
                    const itemInserts = updateData.items.map(item => ({
                        accrual_id: String(id),
                        fee_type: item.fee_type,
                        item_name: item.item_name,
                        quantity: item.quantity,
                        unit_price: item.unit_price,
                        vat_rate: item.vat_rate,
                        total_amount: item.total_amount,
                        currency: item.currency || 'TRY'
                    }));
                    await supabase.from('accrual_items').insert(itemInserts);
                }
            }

            if (updateData.files && updateData.files.length > 0) await this._handleAccrualFiles(id, updateData.files);
            return { success: true };
        } catch (error) { return { success: false, error: error.message }; }
    },

    async getAccrualsByTaskId(taskId) {
        try {
            // 🔥 YENİ: accrual_items(*) Eklendi!
            const { data, error } = await supabase.from('accruals').select('*, accrual_documents(*), accrual_items(*)').eq('task_id', String(taskId));
            if (error) throw error;
            return { success: true, data: this._mapAccrualsData(data) };
        } catch (error) { return { success: false, error: error.message, data: [] }; }
    },

    async getAccruals() {
        try {
            // 🔥 YENİ: accrual_items(*) Eklendi!
            const { data, error } = await supabase.from('accruals').select('*, accrual_documents(*), accrual_items(*)').order('created_at', { ascending: false });
            if (error) throw error;
            
            const personIds = [...new Set([...data.map(a => a.tp_invoice_party_id).filter(Boolean), ...data.map(a => a.service_invoice_party_id).filter(Boolean)])];
            let personsMap = {};
            if (personIds.length > 0) {
                const { data: persons } = await supabase.from('persons').select('id, name').in('id', personIds);
                if (persons) persons.forEach(p => personsMap[p.id] = p.name);
            }
            return { success: true, data: this._mapAccrualsData(data, personsMap) };
        } catch (error) { return { success: false, error: error.message, data: [] }; }
    },

    _mapAccrualsData(data, personsMap = {}) {
        return data.map(acc => ({
            id: acc.id,
            taskId: acc.task_id,
            status: acc.status,
            accrualType: acc.accrual_type,
            type: acc.accrual_type,
            totalAmount: acc.total_amount,
            remainingAmount: acc.remaining_amount,
            
            // 🔥 YENİ: Kalemler Eklendi
            items: acc.accrual_items || [], 

            officialFeeAmount: acc.official_fee_amount,
            officialFeeCurrency: acc.official_fee_currency,
            officialFee: { amount: acc.official_fee_amount, currency: acc.official_fee_currency },
            serviceFeeAmount: acc.service_fee_amount,
            serviceFeeCurrency: acc.service_fee_currency,
            serviceFee: { amount: acc.service_fee_amount, currency: acc.service_fee_currency },
            vatRate: acc.vat_rate,
            applyVatToOfficialFee: acc.apply_vat_to_official_fee,
            isForeignTransaction: acc.is_foreign_transaction,
            tpeInvoiceNo: acc.tpe_invoice_no,
            evrekaInvoiceNo: acc.evreka_invoice_no,
            tpInvoicePartyId: acc.tp_invoice_party_id,
            serviceInvoicePartyId: acc.service_invoice_party_id,
            tpInvoiceParty: acc.tp_invoice_party_id ? { id: acc.tp_invoice_party_id, name: personsMap[acc.tp_invoice_party_id] || 'Kayıtlı' } : null,
            serviceInvoiceParty: acc.service_invoice_party_id ? { id: acc.service_invoice_party_id, name: personsMap[acc.service_invoice_party_id] || 'Kayıtlı' } : null,
            paymentParty: personsMap[acc.service_invoice_party_id] || personsMap[acc.tp_invoice_party_id] || 'Bilinmeyen Müşteri',
            description: acc.description,
            files: acc.accrual_documents ? acc.accrual_documents.map(d => ({ id: d.id, name: d.document_name, url: d.document_url, type: d.document_type })) : [],
            createdAt: acc.created_at,
            updatedAt: acc.updated_at
        }));
    }
};

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
    async resolveAttachments(transactionId, sourceDocumentId, taskId = null) {
        let attachments = [];
        let transactionIdsToFetch = [];
        let activeTaskId = taskId;

        try {
            // 1. Transaction'dan Task ID kurtarma (Arayüz cache'e takılırsa Yedek Plan)
            if (transactionId) {
                transactionIdsToFetch.push(transactionId);
                const { data: txData } = await supabase.from('transactions').select('parent_id, task_id').eq('id', transactionId).maybeSingle();
                if (txData) {
                    if (txData.parent_id) transactionIdsToFetch.push(txData.parent_id);
                    if (!activeTaskId && txData.task_id) activeTaskId = txData.task_id; 
                }
            }

            // 2. TASK DOCUMENTS (Görevin kendi evrakları - ÖNCELİKLİ)
            if (activeTaskId) {
                const { data: taskDocs } = await supabase.from('task_documents').select('document_name, document_url').eq('task_id', activeTaskId);
                if (taskDocs && taskDocs.length > 0) {
                    taskDocs.forEach(d => attachments.push({ name: d.document_name, url: d.document_url }));
                    console.log(`[ATTACHMENT SERVICE] ${taskDocs.length} adet Task Evrakı Bulundu!`);
                }
            }

            // 3. TRANSACTION DOCUMENTS (İşlem evrakları)
            if (transactionIdsToFetch.length > 0) {
                const { data: txDocs } = await supabase.from('transaction_documents').select('document_name, document_url').in('transaction_id', transactionIdsToFetch);
                if (txDocs && txDocs.length > 0) {
                    txDocs.forEach(d => attachments.push({ name: d.document_name, url: d.document_url }));
                }
            }

            // 4. INCOMING DOCUMENTS (Tebliğ Evrakı)
            if (sourceDocumentId) {
                const { data: docData } = await supabase.from('incoming_documents').select('file_name, file_url').eq('id', sourceDocumentId).maybeSingle();
                if (docData && docData.file_url) attachments.push({ name: docData.file_name || 'Tebliğ Evrakı.pdf', url: docData.file_url });
            }

            // 5. TEKİLLEŞTİRME (Aynı dosyayı mükerrer göstermemek için)
            const uniqueAttachments = [];
            const urls = new Set();
            for (const att of attachments) {
                if (att.url && !urls.has(att.url)) {
                    urls.add(att.url);
                    uniqueAttachments.push(att);
                }
            }
            
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
window.supabase = supabase;

// ==========================================
// 15. MERKEZİ HESAPLAMA MOTORU (FEE CALCULATION ENGINE)
// ==========================================
export const feeCalculationService = {
    
    /**
     * Görev tipine ve müvekkil bilgisine göre fatura kalemlerini dinamik çeker.
     * @param {Object} params - { taskTypeId, clientId, recordId, extraParams }
     * @returns {Promise<Array>} Fatura alt kalemleri listesi
     */
    async calculateAccrualItems({ taskTypeId, clientId, recordId = null, extraParams = {} }) {
        console.log(`[CALCULATION ENGINE] 🚀 Hesaplama Başladı. Görev Tipi: ${taskTypeId}, Müvekkil: ${clientId}`);
        
        try {
            const taskObj = extraParams.task || {};
            const ipRecord = extraParams.ipRecord || {};
            
            // 🔥 1. ADIM EKLENTİSİ: GÖREV TİPİ 53 (TAHAKKUK OLUŞTURMA) İSE ASIL İŞİ BUL
            if (String(taskTypeId) === '53' || (taskObj.title && taskObj.title.toLowerCase().includes('tahakkuk'))) {
                let detailsObj = typeof taskObj.details === 'string' ? JSON.parse(taskObj.details) : (taskObj.details || {});
                let parentId = detailsObj.parent_task_id || detailsObj.relatedTaskId || taskObj.relatedTaskId;

                if (parentId) {
                    const { data: parentTask } = await supabase.from('tasks').select('task_type_id').eq('id', String(parentId)).single();
                    if (parentTask && parentTask.task_type_id) {
                        taskTypeId = parentTask.task_type_id; 
                        console.log(`[CALCULATION ENGINE] ✅ Asıl İş Bulundu! Yeni Görev Tipi: ${taskTypeId}`);
                    }
                }
            }
            
            // ---------------------------------------------------------
            // 1. ZAMAN TESPİTİ (Tarihe Göre Tarife Seçimi)
            // ---------------------------------------------------------
            let taskDate = new Date(); // Varsayılan olarak bugünü al
            
            // Eğer göreve ePATS belgesi eklenmişse onun tarihini (sunulduğu tarihi) baz al
            if (taskObj.epatsDocument && taskObj.epatsDocument.uploadedAt) {
                taskDate = new Date(taskObj.epatsDocument.uploadedAt);
            } 
            // Yoksa görevin oluşturulma tarihini al
            else if (taskObj.createdAt || taskObj.created_at) {
                taskDate = new Date(taskObj.createdAt || taskObj.created_at);
            }
            console.log(`[CALCULATION ENGINE] 🕒 İşlem Tarihi Olarak Baz Alınan Tarih: ${taskDate.toLocaleDateString('tr-TR')}`);

            // ---------------------------------------------------------
            // 2. SINIF VE CEZALI YENİLEME TESPİTİ
            // ---------------------------------------------------------
            let isPenalty = false;
            let finalClassCount = extraParams.classCount || 1;

            // Dosyanın sınıf sayısını otomatik bul
            if (ipRecord.niceClasses && Array.isArray(ipRecord.niceClasses)) {
                finalClassCount = ipRecord.niceClasses.length;
            }

            // Yenileme tarihi kontrolü (Görev tarihi, yenileme tarihini geçmişse CEZALIDIR)
            if (ipRecord.renewalDate || ipRecord.renewal_date) {
                const renDate = new Date(ipRecord.renewalDate || ipRecord.renewal_date);
                if (taskDate > renDate) {
                    isPenalty = true;
                    console.log(`[CALCULATION ENGINE] 🚨 Cezalı Yenileme Tespit Edildi! (İşlem: ${taskDate.toLocaleDateString('tr-TR')} > Bitiş: ${renDate.toLocaleDateString('tr-TR')})`);
                }
            }

            // 3. Haritaları Getir
            const { data: maps, error: mapErr } = await supabase
                .from('transaction_fee_maps')
                .select(`
                    calculation_rule,
                    fee_id,
                    fee_tariffs (*)
                `)
                .eq('transaction_type_id', String(taskTypeId));

            if (mapErr) throw mapErr;
            if (!maps || maps.length === 0) {
                console.log(`[CALCULATION ENGINE] ℹ️ Bu görev tipi (${taskTypeId}) için tanımlı otomatik ücret haritası bulunamadı.`);
                return []; 
            }

            // 4. Müvekkile Özel Fiyatları Çek (Eğer clientId varsa)
            let clientCustomFees = {};
            if (clientId) {
                const { data: customFees } = await supabase
                    .from('client_fee_tariffs')
                    .select('*')
                    .eq('client_id', String(clientId));
                
                if (customFees) {
                    customFees.forEach(cf => {
                        clientCustomFees[cf.fee_id] = { amount: cf.custom_amount, currency: cf.custom_currency };
                    });
                }
            }

            const accrualItems = [];

            for (const map of maps) {
                const tariff = map.fee_tariffs;
                if (!tariff) continue;

                // ---------------------------------------------------------
                // 🔥 TARİFEYİ ZAMANA GÖRE FİLTRELEME
                // ---------------------------------------------------------
                if (tariff.valid_from && new Date(tariff.valid_from) > taskDate) continue; // Tarife henüz başlamamış
                if (tariff.valid_to && new Date(tariff.valid_to) < taskDate) continue;     // Tarifenin süresi geçmiş (eski tarife)

                // --- A. Fiyat Belirleme (Standart vs Özel) ---
                let unitPrice = clientCustomFees[tariff.id] ? clientCustomFees[tariff.id].amount : tariff.amount;
                let currency = clientCustomFees[tariff.id] ? (clientCustomFees[tariff.id].currency || tariff.currency) : tariff.currency;
                let isCustomPrice = !!clientCustomFees[tariff.id];

                // --- B. Miktar (Quantity) Kuralları ---
                let quantity = 0;
                const rule = map.calculation_rule;

                switch (rule) {
                    // --- STANDART KURALLAR ---
                    case 'fixed': 
                        quantity = 1; 
                        break;
                    case 'per_class': 
                        quantity = finalClassCount > 0 ? finalClassCount : 1; 
                        break;
                    case 'second_class_only': 
                        quantity = finalClassCount >= 2 ? 1 : 0; 
                        break;
                    case 'extra_class_over_2': 
                        quantity = Math.max(0, finalClassCount - 2); 
                        break;
                    case 'extra_class_over_3': 
                        quantity = Math.max(0, finalClassCount - 3); 
                        break;
                    
                    // --- RÜÇHAN VE 35.05 İSTİSNALARI ---
                    case 'per_priority': 
                        quantity = extraParams.priorityCount || 0; 
                        break;
                    case 'class_35_retail_over_2': 
                        quantity = Math.max(0, (extraParams.retailClassCount || 0) - 2); 
                        break;

                    // --- YENİLEME KURALLARI (Cezalı vs Normal) ---
                    case 'fixed_normal': 
                        quantity = !isPenalty ? 1 : 0; 
                        break;
                    case 'fixed_penalty': 
                        quantity = isPenalty ? 1 : 0;  
                        break;
                    case 'extra_class_normal': 
                        quantity = !isPenalty ? Math.max(0, finalClassCount - 2) : 0; 
                        break;
                    case 'extra_class_penalty': 
                        quantity = isPenalty ? Math.max(0, finalClassCount - 2) : 0; 
                        break;

                    default:
                        console.warn(`[CALCULATION ENGINE] ⚠️ Bilinmeyen hesaplama kuralı: ${rule}`);
                        quantity = 1;
                        break;
                }

                // --- C. Kalemi Listeye Ekle (Sadece Miktarı 0'dan büyük olanlar yansır) ---
                if (quantity > 0) {
                    const vatRate = (tariff.fee_type === 'TP Harç') ? 0 : 20;

                    accrualItems.push({
                        fee_id: tariff.id,
                        fee_type: tariff.fee_type,
                        item_name: tariff.name,
                        quantity: quantity,
                        unit_price: parseFloat(unitPrice),
                        vat_rate: vatRate,
                        total_amount: parseFloat(unitPrice) * quantity,
                        currency: currency,
                        is_custom_price: isCustomPrice
                    });
                }
            }

            console.log(`[CALCULATION ENGINE] 🎉 Hesaplama Tamamlandı. Fatura Kalemleri:`, accrualItems);
            return accrualItems;

        } catch (error) {
            console.error(`[CALCULATION ENGINE] ❌ ÇATI HATASI:`, error);
            return [];
        }
    }
};

window.feeCalculationService = feeCalculationService;