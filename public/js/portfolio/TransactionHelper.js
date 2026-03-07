// public/js/portfolio/TransactionHelper.js
export class TransactionHelper {
    
    // 1. İşlemle (Transaction) Doğrudan İlişkili Evrakları Okur
    static getDirectDocuments(transaction) {
        const docs = [];
        const seenUrls = new Set();

        const addDoc = (d, source = 'direct') => {
            if (!d) return;
            // Yeni SQL şeması alan adlarına (document_url vb.) tam uyum
            const url = d.document_url || d.file_url || d.url || d.fileUrl || d.downloadURL || d.path;
            
            if (url && !seenUrls.has(url)) {
                seenUrls.add(url);
                docs.push({ 
                    name: d.document_name || d.file_name || d.name || d.fileName || 'Belge', 
                    url: url, 
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
        const seenUrls = new Set();
        
        // İşleme JOIN ile bağlanmış görev verisi
        const taskData = transaction.task_data;
        if (!taskData) return docs;

        const addDoc = (d, source = 'task') => {
            if (!d) return;
            const url = d.url || d.downloadURL || d.fileUrl || d.path || d.document_url; 
            if (url && !seenUrls.has(url)) {
                seenUrls.add(url);
                docs.push({ 
                    name: d.name || d.fileName || d.document_name || 'Görev Belgesi', 
                    url: url, 
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
        // Parent = transactionHierarchy alanı 'parent' olan veya parentId'si olmayanlar
        const parents = transactions.filter(t => t.transactionHierarchy === 'parent' || !t.parentId || !t.parent_id);
        const childrenMap = {};

        transactions.forEach(t => {
            const pId = t.parentId || t.parent_id;
            if (pId) {
                if (!childrenMap[pId]) childrenMap[pId] = [];
                childrenMap[pId].push(t);
            }
        });

        // 🔥 YENİ: Firebase kalıntıları temizlendi, doğrudan standart Date objesi ile sıralama yapılıyor
        const parseDateVal = (val) => {
            if (!val) return 0;
            const parsed = new Date(val).getTime();
            return isNaN(parsed) ? 0 : parsed;
        };

        const sortByDateDesc = (a, b) => {
            const dateA = parseDateVal(a.timestamp || a.date || a.created_at);
            const dateB = parseDateVal(b.timestamp || b.date || b.created_at);
            return dateB - dateA; // En yeni işlem en üstte
        };

        parents.sort(sortByDateDesc);
        Object.values(childrenMap).forEach(list => list.sort(sortByDateDesc));

        return { parents, childrenMap };
    }
}