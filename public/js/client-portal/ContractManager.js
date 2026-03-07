// public/js/client-portal/data/ContractManager.js
import { supabase } from '../../supabase-config.js';

export class ContractManager {
    // Seçili müşteri ID'lerine göre vekaletnameleri çek
    async getContracts(clientIds) {
        if (!clientIds || clientIds.length === 0) return [];

        try {
            const { data, error } = await supabase
                .from('person_documents')
                .select(`
                    *,
                    persons (name)
                `)
                .in('person_id', clientIds)
                .order('validity_date', { ascending: false });

            if (error) throw error;

            // Arayüzün beklediği formata (CamelCase) çevir
            return data.map(doc => ({
                id: doc.id,
                ownerId: doc.person_id,
                ownerName: doc.persons?.name || 'Bilinmeyen Müşteri',
                type: doc.document_type,
                fileName: doc.file_name,
                url: doc.url,
                countryCode: doc.country_code,
                countryName: doc.country_code, // UI tarafında harita (map) ile asıl isme çevrilecek
                validityDate: doc.validity_date
            }));
        } catch (error) {
            console.error("Vekaletler çekilirken hata:", error);
            return [];
        }
    }
}