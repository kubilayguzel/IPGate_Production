// public/js/persons/PersonDataManager.js
import { personService, commonService, storageService, supabase } from '../../supabase-config.js'; 


export class PersonDataManager {
    async fetchPersons() { 
        const baseResult = await personService.getPersons();
        if (!baseResult.success) return baseResult;

        try {
            // Kişi -> portföy yöneticisi ilişkisini ayrıca çekiyoruz.
            // Böylece merkezi personService yapısını değiştirmeden Kişi Yönetimi ekranını zenginleştiriyoruz.
            const [{ data: personLinks, error: personLinksError }, { data: users, error: usersError }] = await Promise.all([
                supabase
                    .from('persons')
                    .select('id, portfolio_manager_user_id'),
                supabase
                    .from('users')
                    .select('id, display_name, email, disabled')
            ]);

            if (personLinksError) throw personLinksError;
            if (usersError) throw usersError;

            const userMap = new Map((users || []).map(user => [user.id, user]));
            const managerByPerson = new Map(
                (personLinks || []).map(person => [person.id, person.portfolio_manager_user_id])
            );

            const enrichedData = (baseResult.data || []).map(person => {
                const savedManagerId = managerByPerson.get(person.id) || null;
                const savedManager = savedManagerId ? userMap.get(savedManagerId) : null;

                return {
                    ...person,
                    // Liste yalnızca veritabanındaki GERÇEK atamayı gösterir.
                    // portfolio_manager_user_id NULL ise kullanıcı "Atanmadı" olarak gösterilir.
                    portfolioManagerUserId: savedManagerId,
                    portfolioManagerName: savedManager?.display_name || null,
                    portfolioManagerEmail: savedManager?.email || null,
                    portfolioManagerDisabled: savedManager ? !!savedManager.disabled : false,
                    hasExplicitPortfolioManager: !!savedManagerId
                };
            });

            return { success: true, data: enrichedData };
        } catch (error) {
            console.error('Portföy yöneticileri yüklenirken hata:', error);

            // Liste tamamen bozulmasın. İlişki verisi okunamazsa temel kişi listesini yine göster.
            // Bu durumda sahte/default bir atama göstermiyoruz.
            return {
                success: true,
                data: (baseResult.data || []).map(person => ({
                    ...person,
                    portfolioManagerUserId: null,
                    portfolioManagerName: null,
                    portfolioManagerEmail: null,
                    portfolioManagerDisabled: false,
                    hasExplicitPortfolioManager: false
                }))
            };
        }
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