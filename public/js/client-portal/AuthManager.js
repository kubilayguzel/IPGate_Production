// public/js/client-portal/data/AuthManager.js
import { supabase, authService } from '../../supabase-config.js';

export class AuthManager {
    constructor() {
        this.user = null;
        this.linkedClients = [];
    }

    // Kullanıcı oturumunu doğrula
    async initSession() {
        const session = await authService.getCurrentSession();
        if (!session) return false;
        this.user = session.user;
        return true;
    }

    // Kullanıcının bağlı olduğu müvekkil firmaları çek
    async getLinkedClients() {
        try {
            const { data, error } = await supabase
                .from('user_person_links')
                .select(`
                    person_id, 
                    persons (id, name)
                `)
                .eq('user_id', this.user.id);

            if (error) throw error;

            if (data && data.length > 0) {
                this.linkedClients = data
                    .filter(link => link.persons) // Silinmiş persons kayıtlarını ele
                    .map(link => ({
                        id: link.persons.id,
                        name: link.persons.name
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name));
            } else {
                this.linkedClients = [];
            }
            return this.linkedClients;
        } catch (error) {
            console.error('Müşteri bağlantıları çekilirken hata:', error);
            return [];
        }
    }
}