// public/js/persons/PersonDataManager.js
import { personService, commonService, storageService, supabase } from '../../supabase-config.js'; 


export class PersonDataManager {
    async fetchPersons() {
        // Tek persons sorgusu; onceki uygulama bir kez personService.getPersons(),
        // ikinci kez persons.id/portfolio_manager_user_id cekiyordu.
        // Bagimsiz veriler paralel yuklenir; ulke veya kullanici listesi
        // hatasi kisi listesinin yuklenmesini engellemez.
        const [personsResult, countriesResult, usersResult] = await Promise.allSettled([
            supabase.from('persons').select('*').order('name', { ascending: true }),
            commonService.getCountries(),
            supabase.from('users').select('id, display_name, email, disabled')
        ]);

        if (personsResult.status !== 'fulfilled') {
            console.error('Kisiler yuklenemedi:', personsResult.reason);
            return { success: false, error: String(personsResult.reason) };
        }
        if (personsResult.value.error) {
            console.error('Kisiler yuklenemedi:', personsResult.value.error);
            return { success: false, error: personsResult.value.error.message };
        }

        const rawPersons = personsResult.value.data || [];
        const countryRows = countriesResult.status === 'fulfilled' && countriesResult.value?.success
            ? (countriesResult.value.data || []) : [];
        if (countriesResult.status === 'rejected' || (countriesResult.value && !countriesResult.value.success)) {
            console.warn('Ulke sozlugu yuklenemedi; ulke kodlari gosterilecek.');
        }
        const countryMap = new Map(countryRows.filter(c => c?.code).map(c => [
            String(c.code).toUpperCase(), c.name || c.label || c.code
        ]));

        const userRows = usersResult.status === 'fulfilled' && !usersResult.value.error
            ? (usersResult.value.data || []) : [];
        if (usersResult.status === 'rejected' || usersResult.value?.error) {
            console.warn('Portfoy yoneticileri alinamadi; kisi listesi yuklenmeye devam edecek.');
        }
        const userMap = new Map(userRows.map(user => [user.id, user]));

        const mappedPersons = rawPersons.map(p => {
            const managerId = p.portfolio_manager_user_id || null;
            const manager = managerId ? userMap.get(managerId) : null;
            return {
                id: p.id,
                name: p.name,
                type: p.type,
                nationalityType: p.nationality_type || 'domestic',
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
                is_evaluation_required: p.is_evaluation_required,
                has_tevkifat: p.has_tevkifat,
                requires_sas_code: p.requires_sas_code,
                priceListId: p.price_list_id,
                petitionControllerUserId: p.petition_controller_user_id || null,
                countryName: p.country_code
                    ? countryMap.get(String(p.country_code).toUpperCase()) || p.country_code
                    : null,
                portfolioManagerUserId: managerId,
                portfolioManagerName: manager?.display_name || null,
                portfolioManagerEmail: manager?.email || null,
                portfolioManagerDisabled: manager ? !!manager.disabled : false,
                hasExplicitPortfolioManager: !!managerId
            };
        });

        return { success: true, data: mappedPersons };
    }

    async deletePerson(id) {
        return await personService.deletePerson(id);
    }

    async getCountries() {
        const res = await commonService.getCountries();
        return res.success ? res.data : [];
    }

    async getProvinces(countryCode) {
        if (!/^(TR|TUR)$/i.test(countryCode)) return [];

        const { data, error } = await supabase.from('common').select('data').in('id', ['provinces_TR', 'cities_TR', 'turkey_provinces']);

        if (error || !data || data.length === 0) return [];
        return data[0].data.list || data[0].data.provinces || [];
    }

    async getDistricts(provinceName) {
        if (!provinceName) return [];

        try {
            const { data: cityData } = await supabase.from('common').select('data').eq('id', 'cities_TR').single();
            if (!cityData || !cityData.data || !cityData.data.list) return [];

            const cities = cityData.data.list;
            const cityIndex = cities.findIndex(c => c.localeCompare(provinceName, 'tr', { sensitivity: 'base' }) === 0);

            if (cityIndex === -1) return [];
            const ilId = String(cityIndex + 1);

            const { data: distData, error } = await supabase.from('common').select('data').eq('id', 'districts').single();

            if (error || !distData || !distData.data) return [];

            let districtsArray = distData.data;
            if (typeof districtsArray === 'string') {
                districtsArray = JSON.parse(districtsArray);
            }

            return districtsArray.filter(d => String(d.il_id) === ilId);

        } catch (error) {
            console.error("İlçeler çekilirken hata:", error);
            return [];
        }
    }

    async getRelatedPersons(personId) {
        return await personService.getRelatedPersons(personId);
    }

    async uploadDocument(file, personId) {
        if (!personId) personId = 'temp_' + Date.now(); 

        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `persons/${personId}/${fileName}`;

        const uploadRes = await storageService.uploadFile('documents', filePath, file);

        if (!uploadRes.success) throw new Error(uploadRes.error);
        return uploadRes.url;
    }

    async deleteDocument(fileUrl) {
        if (!fileUrl) return;
        try {
            const urlObj = new URL(fileUrl);
            const pathParts = urlObj.pathname.split('/documents/');
            if (pathParts.length > 1) {
                const filePath = pathParts[1];
                await supabase.storage.from('documents').remove([filePath]);
            }
        } catch (error) {
            console.error("Dosya silinemedi:", error);
        }
    }
}