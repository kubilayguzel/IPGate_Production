// public/js/client-portal/PortfolioManager.js
import { supabase } from '../../supabase-config.js';

export class PortfolioManager {
    // 1. Portföyü (Marka, Patent, Tasarım) Çek (VIEW KULLANARAK)
    async getPortfolios(clientIds) {
        if (!clientIds || clientIds.length === 0) return [];

        try {
            // Adım 1: Bu müşterilere ait markaların ID'lerini bul
            const { data: appData, error: appError } = await supabase
                .from('ip_record_applicants')
                .select('ip_record_id')
                .in('person_id', clientIds);

            if (appError) throw appError;

            const ipIds = [...new Set(appData.map(a => a.ip_record_id))];
            if (ipIds.length === 0) return [];

            // Adım 2: Bulunan ID'leri VIEW üzerinden detaylı çek
            const { data, error } = await supabase
                .from('portfolio_list_view')
                .select('*')
                .in('id', ipIds)
                .order('created_at', { ascending: false });

            if (error) throw error;

            // Adım 3: Arayüzün beklediği CamelCase formata çevir
            return data.map(record => {
                // Görsel Fallback
                let imageUrl = record.brand_image_url;
                if (!imageUrl || imageUrl.trim() === '') {
                    imageUrl = `https://guicrctynauzxhyfpdfe.supabase.co/storage/v1/object/public/brand_images/${record.id}/logo.png`;
                }

                // Sınıfları metne çevir
                const classesArray = Array.isArray(record.nice_classes) ? record.nice_classes.filter(n => n != null) : [];
                
                // Başvuru sahiplerini JSON'dan çıkar
                let applicantsArray = [];
                try {
                    applicantsArray = Array.isArray(record.applicants_json) ? record.applicants_json : JSON.parse(record.applicants_json || '[]');
                } catch(e) {}

                return {
                    id: record.id,
                    type: record.ip_type,
                    origin: record.origin || 'TÜRKPATENT',
                    country: record.country_code,
                    title: record.brand_name || '-',
                    brandImageUrl: imageUrl,
                    applicationNumber: record.application_number || '-',
                    registrationNumber: record.registration_number || record.wipo_ir || record.aripo_ir || '-',
                    applicationDate: record.application_date,
                    renewalDate: record.renewal_date,
                    status: record.status,
                    classes: classesArray.join(', ') || '-',
                    transactionHierarchy: record.transaction_hierarchy,
                    parentId: record.parent_id,
                    applicants: applicantsArray
                };
            });
        } catch (error) {
            console.error("Portföy çekilirken hata:", error);
            return [];
        }
    }

    // 2. Davaları (Suits) Çek
    async getSuits(clientIds) {
        if (!clientIds || clientIds.length === 0) return [];

        try {
            const { data, error } = await supabase
                .from('suits')
                .select('*')
                .in('client_id', clientIds)
                .order('created_at', { ascending: false });

            if (error) throw error;

            return data.map(suit => ({
                id: String(suit.id),
                caseNo: suit.file_no || '-',
                title: suit.title || 'Dava',
                court: suit.court_name || '-',
                opposingParty: suit.defendant || suit.opposing_party || '-',
                openingDate: suit.created_at,
                suitStatus: suit.status || 'Devam Ediyor',
                client: { id: suit.client_id }
            }));
        } catch (error) {
            console.error("Davalar çekilirken hata:", error);
            return [];
        }
    }
}