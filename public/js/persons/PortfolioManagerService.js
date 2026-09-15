import { supabase } from '../../supabase-config.js';

/**
 * Müvekkil -> Portföy Yöneticisi ilişkisini yöneten servis.
 *
 * Veri modeli:
 * persons.portfolio_manager_user_id -> users.id
 */
export const portfolioManagerService = {
    /**
     * Portföy yöneticisi olarak atanabilecek aktif kullanıcıları getirir.
     * Kullanıcı talebi gereği yalnızca role === 'client' olanlar hariç tutulur.
     * disabled === true olan kullanıcılar yeni atamalarda gösterilmez.
     */
    async getAssignableUsers() {
        try {
            const { data, error } = await supabase
                .from('users')
                .select('id, email, display_name, role, disabled')
                .order('display_name', { ascending: true, nullsFirst: false });

            if (error) throw error;

            const users = (data || [])
                .filter(user => user.role !== 'client' && user.disabled !== true)
                .sort((a, b) => {
                    const aName = (a.display_name || a.email || '').toLocaleLowerCase('tr-TR');
                    const bName = (b.display_name || b.email || '').toLocaleLowerCase('tr-TR');
                    return aName.localeCompare(bName, 'tr-TR');
                });

            return { success: true, data: users };
        } catch (error) {
            console.error('Portföy yöneticisi kullanıcı listesi alınamadı:', error);
            return { success: false, error: error.message || String(error), data: [] };
        }
    },

    /** Kişiye atanmış portföy yöneticisinin user id'sini getirir. */
    async getPersonPortfolioManager(personId) {
        try {
            const { data, error } = await supabase
                .from('persons')
                .select('portfolio_manager_user_id')
                .eq('id', personId)
                .single();

            if (error) throw error;

            return {
                success: true,
                data: data?.portfolio_manager_user_id || null
            };
        } catch (error) {
            console.error('Portföy yöneticisi bilgisi alınamadı:', error);
            return { success: false, error: error.message || String(error), data: null };
        }
    },

    /**
     * Daha önce atanmış fakat sonradan pasif hale gelmiş bir kullanıcıyı
     * düzenleme ekranında kaybetmemek için tek kullanıcı bilgisini getirir.
     */
    async getUserById(userId) {
        if (!userId) return { success: true, data: null };

        try {
            const { data, error } = await supabase
                .from('users')
                .select('id, email, display_name, role, disabled')
                .eq('id', userId)
                .single();

            if (error) throw error;
            return { success: true, data };
        } catch (error) {
            console.error('Portföy yöneticisi kullanıcı bilgisi alınamadı:', error);
            return { success: false, error: error.message || String(error), data: null };
        }
    },

    /**
     * Portföy yöneticisini kaydeder.
     * Boş değer atanırsa ilişki kaldırılır.
     * Yeni atamada client veya disabled kullanıcıya izin verilmez.
     */
    async setPersonPortfolioManager(personId, userId) {
        try {
            const normalizedUserId = userId || null;

            if (normalizedUserId) {
                const { data: selectedUser, error: userError } = await supabase
                    .from('users')
                    .select('id, role, disabled')
                    .eq('id', normalizedUserId)
                    .single();

                if (userError) throw userError;
                if (!selectedUser) throw new Error('Seçilen kullanıcı bulunamadı.');
                if (selectedUser.role === 'client') {
                    throw new Error('Client rolündeki kullanıcı portföy yöneticisi olarak atanamaz.');
                }
                if (selectedUser.disabled === true) {
                    throw new Error('Pasif kullanıcı portföy yöneticisi olarak atanamaz.');
                }
            }

            const { error } = await supabase
                .from('persons')
                .update({
                    portfolio_manager_user_id: normalizedUserId,
                    updated_at: new Date().toISOString()
                })
                .eq('id', personId);

            if (error) throw error;
            return { success: true };
        } catch (error) {
            console.error('Portföy yöneticisi kaydedilemedi:', error);
            return { success: false, error: error.message || String(error) };
        }
    }
};
