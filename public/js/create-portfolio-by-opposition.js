// public/js/create-portfolio-by-opposition.js

import { supabase, ipRecordsService, authService } from '../supabase-config.js';

class PortfolioByOppositionCreator {
    constructor() {
        this.db = supabase;
        console.log('✅ PortfolioByOpposition: Supabase initialized');
    }

    async resolveImageUrl(path) {
        if (!path) return null;
        if (/^https?:\/\//i.test(path)) return path;

        try {
            const { data } = this.db.storage.from('brand_images').getPublicUrl(path);
            return data.publicUrl;
        } catch (e) {
            console.warn('⚠️ getPublicUrl başarısız, path dönülüyor:', e);
            return path;
        }
    }

    async createThirdPartyPortfolioFromBulletin(bulletinRecordId, transactionId) {
        try {
            console.log('🔄 3.taraf portföy kaydı oluşturuluyor...', { bulletinRecordId, transactionId });

            const bulletinData = await this.getBulletinRecord(bulletinRecordId);
            if (!bulletinData.success) return { success: false, error: bulletinData.error };

            let bulletinDate = null;
            try {
                if (bulletinData.data.bulletin_no) {
                    const { data: bSnap } = await this.db.from('trademark_bulletins').select('bulletin_date').eq('bulletin_no', bulletinData.data.bulletin_no).single();
                    if (bSnap) bulletinDate = bSnap.bulletin_date || null;
                }
            } catch (err) { console.warn('⚠️ Bulletin tarihi alınamadı:', err); }

            const portfolioData = await this.mapBulletinToPortfolio(bulletinData.data, transactionId, bulletinDate);
            const result = await this.createPortfolioRecord(portfolioData, transactionId);
            if (!result.success) return { success: false, error: result.error };

            const already = !!(result.isExistingRecord || result.isDuplicate);
            const taskUpdate = await this.updateTaskWithNewPortfolioRecord(transactionId, result.recordId, portfolioData.title);

            if (!taskUpdate.success) {
                return { success: true, recordId: result.recordId, isExistingRecord: already, message: 'Kayıt oluşturuldu ancak iş güncellenemedi.', warning: taskUpdate.error };
            }

            return { success: true, recordId: result.recordId, isExistingRecord: already, message: already ? 'Mevcut kayıt eşleşti.' : 'Kayıt oluşturuldu.' };

        } catch (error) {
            console.error('❌ 3.taraf portföy kaydı oluşturma hatası:', error);
            return { success: false, error: `Hata: ${error.message}` };
        }
    }

    async updateTaskWithNewPortfolioRecord(taskId, newPortfolioId, portfolioTitle) {
        try {
            const { error } = await this.db.from('tasks').update({
                related_ip_record_id: newPortfolioId,
                iprecord_title: portfolioTitle,
                updated_at: new Date().toISOString()
            }).eq('id', taskId);

            if (error) throw error;
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async getBulletinRecord(bulletinRecordId) {
        try {
            const { data, error } = await this.db.from('trademark_bulletin_records').select('*').eq('id', bulletinRecordId).single();
            if (error || !data) return { success: false, error: 'Bulletin kaydı bulunamadı' };
            return { success: true, data };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async mapBulletinToPortfolio(bulletinData, transactionId, bulletinDate = null) {
        const now = new Date().toISOString();
        const brandImageUrl = await this.resolveImageUrl(bulletinData.image_path);

        let holders = bulletinData.holders;
        if (typeof holders === 'string') holders = holders.split(',').map(h => h.trim());

        const applicants = Array.isArray(holders) ? holders.map(h => ({ name: h, id: `holder_${Date.now()}` })) : [];

        const classes = typeof bulletinData.nice_classes === 'string' ? bulletinData.nice_classes.split(/[\s,]+/).filter(Boolean) : (bulletinData.nice_classes || []);
        const goodsAndServices = classes.map(c => ({ niceClass: c, description: `Sınıf ${c}`, status: 'active' }));

        return {
            title: bulletinData.mark_name || `Başvuru: ${bulletinData.application_no}`,
            type: 'trademark',
            portfoyStatus: 'active',
            status: 'published_in_bulletin',
            recordOwnerType: 'third_party',
            applicationNumber: bulletinData.application_no || null,
            applicationDate: bulletinData.application_date || null,
            brandText: bulletinData.mark_name || null,
            brandImageUrl,
            description: `Yayına itiraz (İş ID: ${transactionId}) için oluşturulan kayıt.`,
            applicants,
            goodsAndServices,
            details: { sourceBulletinRecordId: bulletinData.id, relatedTransactionId: transactionId, brandInfo: { opposedMarkBulletinNo: bulletinData.bulletin_no, opposedMarkBulletinDate: bulletinDate } },
            createdAt: now,
            createdBy: 'opposition_automation',
            createdFrom: 'bulletin_record'
        };
    }

    async createPortfolioRecord(portfolioData, transactionId = null) {
        try {
            const result = await ipRecordsService.createRecordFromOpposition(portfolioData);
            if (result.success && result.id) {
                const u = authService.getCurrentUser();
                await ipRecordsService.addTransactionToRecord(result.id, {
                    type: '20',
                    designation: 'Yayına İtiraz',
                    description: 'Yayına İtiraz',
                    transactionHierarchy: 'parent',
                    taskId: String(transactionId),
                    timestamp: new Date().toISOString(),
                    userId: u?.id || 'anonymous',
                    userEmail: u?.email || 'system'
                });
                return { success: true, recordId: result.id, isExistingRecord: result.isExistingRecord };
            }
            return { success: false, error: result.error, isDuplicate: result.isDuplicate };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

if (typeof window !== 'undefined') {
    window.PortfolioByOppositionCreator = PortfolioByOppositionCreator;
    window.portfolioByOppositionCreator = new PortfolioByOppositionCreator();
}

export default PortfolioByOppositionCreator;