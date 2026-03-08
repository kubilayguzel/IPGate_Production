// public/js/portfolio/TransactionHelper.js
export class TransactionHelper {
    
    // 1. İşlemle (Transaction) Doğrudan İlişkili Evrakları Okur
    static getDirectDocuments(transaction) {
        const docs = [];
        const seenKeys = new Set(); // 🔥 YENİ: URL ve İsim bazlı akıllı filtreleme için

        const addDoc = (d, source = 'direct') => {
            if (!d) return;
            const rawUrl = d.document_url || d.file_url || d.url || d.fileUrl || d.downloadURL || d.path;
            if (!rawUrl) return;

            const name = d.document_name || d.file_name || d.name || d.fileName || 'Belge';

            // 🔥 ÇÖZÜM 1: URL'nin sonundaki ?t=123 gibi değişken parametreleri atarak sadece ana dosya yolunu alıyoruz
            const cleanUrl = rawUrl.split('?')[0].toLowerCase();
            
            // 🔥 ÇÖZÜM 2: Dosya ismini temizle (küçük harfe çevir ve boşlukları al)
            const cleanName = name.trim().toLowerCase();

            // Kontrol anahtarları oluştur
            const keyUrl = `url_${cleanUrl}`;
            const keyName = `name_${cleanName}`;

            // Eğer bu dosya (URL olarak) daha önce eklenmediyse:
            if (!seenKeys.has(keyUrl)) {
                
                // Ekstra Güvenlik: Eğer dosya ismi jenerik "belge" değilse ve bu isimde bir dosya zaten eklendiyse tekrar ekleme
                if (cleanName !== 'belge' && cleanName !== 'resmi yazı' && seenKeys.has(keyName)) {
                    return; 
                }

                seenKeys.add(keyUrl);
                if (cleanName !== 'belge' && cleanName !== 'resmi yazı') {
                    seenKeys.add(keyName);
                }

                docs.push({ 
                    name: name, 
                    url: rawUrl, // Ekranda tıklanabilmesi için orijinal (parametreleri olan) linki kullanıyoruz
                    type: d.document_type || d.type || 'document', 
                    source: source 
                });
            }
        };

        // A. YENİ ŞEMA: 'transaction_documents' tablosundan JOIN ile gelen belgeler
        if (Array.isArray(transaction.transaction_documents)) {
            transaction.transaction_documents.forEach(td => addDoc(td, 'direct'));
        }

        // B. YEDEK (MIGRATION): Eski JSON formatında kalan belgeler
        if (Array.isArray(transaction.documents)) {
            transaction.documents.forEach(d => addDoc(d, 'direct'));
        }

        // C. STATİK LİNKLER: Ana tabloya düz string olarak kaydedilmiş URL'ler
        if (transaction.relatedPdfUrl || transaction.related_pdf_url) {
            addDoc({ name: 'Resmi Yazı', url: transaction.relatedPdfUrl || transaction.related_pdf_url, type: 'official' }, 'direct');
        }
        if (transaction.oppositionPetitionFileUrl || transaction.opposition_petition_file_url) {
            addDoc({ name: 'İtiraz Dilekçesi', url: transaction.oppositionPetitionFileUrl || transaction.opposition_petition_file_url, type: 'petition' }, 'direct');
        }
        if (transaction.oppositionEpatsPetitionFileUrl || transaction.opposition_epats_petition_file_url) {
            addDoc({ name: 'Karşı ePATS Dilekçesi', url: transaction.oppositionEpatsPetitionFileUrl || transaction.opposition_epats_petition_file_url, type: 'epats' }, 'direct');
        }

        return docs;
    }

    // 2. Görev (Task) Tablosundan Gelen Resim/PDF'leri Okur
    static async getTaskDocuments(transaction) {
        const docs = [];
        const seenKeys = new Set(); // 🔥 Görev belgeleri için de akıllı filtre
        
        const taskData = transaction.task_data;
        if (!taskData) return docs;

        const addDoc = (d, source = 'task') => {
            if (!d) return;
            const rawUrl = d.url || d.downloadURL || d.fileUrl || d.path || d.document_url; 
            if (!rawUrl) return;

            const name = d.name || d.fileName || d.document_name || 'Görev Belgesi';

            const cleanUrl = rawUrl.split('?')[0].toLowerCase();
            const cleanName = name.trim().toLowerCase();

            const keyUrl = `url_${cleanUrl}`;
            const keyName = `name_${cleanName}`;

            if (!seenKeys.has(keyUrl)) {
                if (cleanName !== 'görev belgesi' && cleanName !== 'belge' && cleanName !== 'epats belgesi' && seenKeys.has(keyName)) {
                    return;
                }

                seenKeys.add(keyUrl);
                if (cleanName !== 'görev belgesi' && cleanName !== 'belge' && cleanName !== 'epats belgesi') {
                    seenKeys.add(keyName);
                }

                docs.push({ 
                    name: name, 
                    url: rawUrl, 
                    type: d.type || d.document_type || 'document', 
                    source: source 
                });
            }
        };

        // Görev içindeki JSONB belge dizisi (Eğer metin olarak geldiyse parse et)
        let taskDocs = taskData.documents || taskData.task_documents;
        if (typeof taskDocs === 'string') {
            try { taskDocs = JSON.parse(taskDocs); } catch(e) { taskDocs = []; }
        }

        if (Array.isArray(taskDocs)) {
            taskDocs.forEach(d => addDoc(d, 'task'));
        }

        // Yassı ePATS Belgesi
        if (taskData.epats_doc_url || taskData.epats_doc_download_url) {
            addDoc({ 
                name: taskData.epats_doc_name || 'ePats Belgesi', 
                url: taskData.epats_doc_url || taskData.epats_doc_download_url, 
                type: 'epats' 
            }, 'task');
        }

        // Eski (Legacy) Data Fallback
        if (taskData.details) {
            if (taskData.details.epatsDocument) addDoc(taskData.details.epatsDocument, 'task');
            if (Array.isArray(taskData.details.documents)) taskData.details.documents.forEach(d => addDoc(d, 'task'));
        }

        return docs;
    }

    // 3. Tüm Belgeleri Birleştirir
    static async getDocuments(transaction) {
        const directDocs = this.getDirectDocuments(transaction);
        const taskDocs = await this.getTaskDocuments(transaction);
        return [...directDocs, ...taskDocs];
    }

    // 4. İşlemleri Ana (Parent) ve Alt (Child) Olarak Gruplar ve Tarihe Göre Sıralar
    static organizeTransactions(transactions) {
        const parents = transactions.filter(t => t.transactionHierarchy === 'parent' || !t.parentId || !t.parent_id);
        const childrenMap = {};

        transactions.forEach(t => {
            const pId = t.parentId || t.parent_id;
            if (pId) {
                if (!childrenMap[pId]) childrenMap[pId] = [];
                childrenMap[pId].push(t);
            }
        });

        const parseDateVal = (val) => {
            if (!val) return 0;
            const parsed = new Date(val).getTime();
            return isNaN(parsed) ? 0 : parsed;
        };

        const sortByDateDesc = (a, b) => {
            const dateA = parseDateVal(a.timestamp || a.date || a.created_at);
            const dateB = parseDateVal(b.timestamp || b.date || b.created_at);
            return dateB - dateA;
        };

        parents.sort(sortByDateDesc);
        Object.values(childrenMap).forEach(list => list.sort(sortByDateDesc));

        return { parents, childrenMap };
    }
}