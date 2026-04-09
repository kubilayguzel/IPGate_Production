// public/js/persons/PersonDataManager.js
import { personService, commonService, storageService, supabase } from '../../supabase-config.js'; 

export class PersonDataManager {
    async fetchPersons() { 
        return await personService.getPersons(); 
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

    // 🔥 YENİ: İl ismine (Örn: "Ankara") göre plaka kodunu bulup ilçeleri çeken fonksiyon
    async getDistricts(provinceName) {
        if (!provinceName) return [];

        try {
            // 1. İlin plaka kodunu (il_id) bulmak için şehir listesini çekiyoruz
            const { data: cityData } = await supabase.from('common').select('data').eq('id', 'cities_TR').single();
            if (!cityData || !cityData.data || !cityData.data.list) return [];

            const cities = cityData.data.list;
            // Şehrin dizideki sırası (index + 1) bize il_id'yi (Plaka) verir (Örn: Adana -> 0 + 1 = 1)
            const cityIndex = cities.findIndex(c => c.localeCompare(provinceName, 'tr', { sensitivity: 'base' }) === 0);

            if (cityIndex === -1) return [];
            const ilId = String(cityIndex + 1);

            // 2. İlçeleri çekiyoruz
            const { data: distData, error } = await supabase.from('common').select('data').eq('id', 'districts').single();

            if (error || !distData || !distData.data) return [];

            // 3. Supabase JSON'u string (metin) olarak kaydettiyse diziye çevir (Parse)
            let districtsArray = distData.data;
            if (typeof districtsArray === 'string') {
                districtsArray = JSON.parse(districtsArray);
            }

            // 4. İlgili plaka koduna (il_id) ait ilçeleri filtrele ve döndür
            return districtsArray.filter(d => String(d.il_id) === ilId);
            
        } catch (error) {
            console.error("İlçeler çekilirken hata:", error);
            return [];
        }
    }

    // 🔥 İŞTE EKSİK OLAN VE HATAYA SEBEP OLAN FONKSİYON
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