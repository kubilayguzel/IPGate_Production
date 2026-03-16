// public/js/client-portal/PortfolioManager.js
import { supabase } from '../../supabase-config.js';

export class PortfolioManager {
    // 1. Portföyü (Marka, Patent, Tasarım) Çek (KUSURSUZ İLİŞKİSEL MİMARİ)
    async getPortfolios(clientIds) {
        if (!clientIds || clientIds.length === 0) return [];

        try {
            // 🔥 MİMARİ DEVRİM: 
            // 2 ayrı sorgu (ve binlerce ID'yi URL'ye sığdırma) yerine; 
            // Supabase'in "Inner Join" (!inner) özelliğini kullanıyoruz.
            // Sadece müşterinin bağlı olduğu kayıtlar doğrudan PostgreSQL içinde süzülüp tek sorguda geliyor.
            const { data, error } = await supabase
                .from('ip_records')
                .select(`
                    id, 
                    ip_type, 
                    origin, 
                    status, 
                    country_code, 
                    application_number, 
                    registration_number, 
                    wipo_ir, 
                    aripo_ir,
                    application_date, 
                    renewal_date, 
                    transaction_hierarchy, 
                    parent_id,
                    created_at,
                    ip_record_trademark_details (brand_name, brand_image_url),
                    ip_record_classes (class_no),
                    ip_record_applicants!inner (
                        order_index,
                        persons (id, name, type)
                    )
                `)
                .in('ip_record_applicants.person_id', clientIds) // Sadece bu ID'lere sahip olanları getir!
                .order('created_at', { ascending: false });

            if (error) throw error;

            // Arayüzün beklediği CamelCase formata (eski view formatına) çevir
            return data.map(record => {
                // Detay tablosu (Array veya obje olarak gelebilir)
                const details = Array.isArray(record.ip_record_trademark_details) 
                    ? record.ip_record_trademark_details[0] 
                    : (record.ip_record_trademark_details || {});

                // Görsel Fallback
                let imageUrl = details.brand_image_url;
                if (!imageUrl || imageUrl.trim() === '') {
                    imageUrl = `https://kadxvkejzctwymzeyrrl.supabase.co/storage/v1/object/public/brand_images/${record.id}/logo.png`;
                }

                // Sınıfları virgüllü metne çevir ve sırala
                const classesArray = record.ip_record_classes 
                    ? record.ip_record_classes.map(c => c.class_no).filter(Boolean).sort((a,b) => a - b)
                    : [];
                
                // Başvuru sahiplerini indeks sırasına göre düzenle
                const sortedApplicants = (record.ip_record_applicants || []).sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
                const applicantsArray = sortedApplicants.map(a => ({
                    id: a.persons?.id,
                    name: a.persons?.name,
                    personType: a.persons?.type
                }));

                // Ortak (Registration) Numara
                const regNo = record.registration_number || record.wipo_ir || record.aripo_ir || '-';

                return {
                    id: record.id,
                    type: record.ip_type,
                    origin: record.origin || 'TÜRKPATENT',
                    country: record.country_code,
                    title: details.brand_name || '-',
                    brandImageUrl: imageUrl,
                    applicationNumber: record.application_number || '-',
                    registrationNumber: regNo,
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