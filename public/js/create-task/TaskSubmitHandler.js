import { showNotification } from '../../utils.js';
import { TaskValidator } from './TaskValidator.js';
import { authService, taskService, accrualService, ipRecordsService, supabase } from '../../supabase-config.js';
import { TASK_IDS, RELATED_PARTY_REQUIRED, asId } from './TaskConstants.js';
import { getSelectedNiceClasses } from '../nice-classification.js'; 
import { addMonthsToDate, findNextWorkingDay, isWeekend, isHoliday, TURKEY_HOLIDAYS } from '../../utils.js';

export class TaskSubmitHandler {
    constructor(dataManager, uiManager) {
        this.dataManager = dataManager;
        this.uiManager = uiManager;
        this.validator = new TaskValidator();
        this.selectedParentTransactionId = null;
    }

    setupValidationListeners() {
        const form = document.getElementById('createTaskForm');
        if (form) {
            form.addEventListener('input', () => {
                const isValid = this.validator.validateForm();
                const submitBtn = document.getElementById('submitTaskBtn');
                if (submitBtn) submitBtn.disabled = !isValid;
            });
        }
    }

    generateUUID() {
        return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).substr(2, 16);
    }

    async handleFormSubmit(e, state) {
        e.preventDefault();
        console.log('🚀 [DEBUG] handleFormSubmit tetiklendi (Tam Supabase Uyumlu).');
        
        const { 
            selectedTaskType, selectedIpRecord, selectedRelatedParties, selectedRelatedParty,
            selectedApplicants, priorities, uploadedFiles, accrualData
        } = state; // isFreeTransaction state'den çıkarıldı

        // 🔥 ÇÖZÜM 3: Ücretsiz işlem bilgisini anlık olarak DOM'dan (ekrandan) okuyoruz
        const isFreeTransaction = document.getElementById('isFreeTransaction')?.checked || false;

        if (!selectedTaskType) { alert('Geçerli bir işlem tipi seçmediniz.'); return; }

        const submitBtn = document.getElementById('saveTaskBtn') || document.getElementById('submitTaskBtn');
        if (submitBtn) submitBtn.disabled = true;

        try {
            const assignedTo = document.getElementById('assignedTo')?.value;
            const assignedUser = state.allUsers.find(u => u.id === assignedTo);
            
            let taskTitle = document.getElementById('taskTitle')?.value;
            let taskDesc = document.getElementById('taskDescription')?.value;

            if (selectedTaskType.alias === 'Başvuru' && selectedTaskType.ipType === 'trademark') {
                const brandText = document.getElementById('brandExampleText')?.value;
                taskTitle = brandText ? `${brandText} Marka Başvurusu` : selectedTaskType.alias;
                taskDesc = taskDesc || `'${brandText || 'Yeni'}' markası için başvuru işlemi.`;
            } else {
                const recordTitle = selectedIpRecord ? (selectedIpRecord.title || selectedIpRecord.brand_name || selectedIpRecord.markName) : '';
                taskTitle = taskTitle || (recordTitle ? `${recordTitle} ${selectedTaskType.alias || selectedTaskType.name}` : (selectedTaskType.alias || selectedTaskType.name));
                if (!taskDesc) taskDesc = `${selectedTaskType.alias || selectedTaskType.name} işlemi.`;
            }

            let ipAppNo = "-", ipTitle = "-", ipAppName = "-";
            if (selectedIpRecord) {
                ipAppNo = selectedIpRecord.application_number || selectedIpRecord.applicationNo || "-";
                ipTitle = selectedIpRecord.title || selectedIpRecord.brand_name || "-";
                if (Array.isArray(selectedIpRecord.applicants) && selectedIpRecord.applicants.length > 0) ipAppName = selectedIpRecord.applicants[0].name || "-";
                else if (selectedIpRecord.client && selectedIpRecord.client.name) ipAppName = selectedIpRecord.client.name;
            } else if (selectedTaskType.alias === 'Başvuru' && selectedTaskType.ipType === 'trademark') {
                ipTitle = document.getElementById('brandExampleText')?.value || taskTitle || "-";
                if (selectedApplicants && selectedApplicants.length > 0) ipAppName = selectedApplicants[0].name || "-";
            }

            // 🔥 1. KULLANICIYI DOĞRU EŞLEŞTİRME (FK Hatasını Engeller)
            const session = await authService.getCurrentSession();
            const currentUserEmail = session?.user?.email;
            const dbUser = state.allUsers.find(u => u.email === currentUserEmail);
            const userNameOrEmail = dbUser?.display_name || dbUser?.name || currentUserEmail || 'Sistem';

            // 🔥 2. SÜTUN İSİMLERİ SUPABASE İLE %100 EŞLEŞTİRİLDİ
            let taskData = {
                task_type_id: String(selectedTaskType.id),
                title: taskTitle,
                description: taskDesc,
                priority: document.getElementById('taskPriority')?.value || 'medium',
                assigned_to: assignedUser ? assignedUser.id : null,
                status: 'open',
                ip_record_id: selectedIpRecord ? selectedIpRecord.id : null,
                
                details: {
                    assigned_to_email: assignedUser ? assignedUser.email : null,
                    ip_record_title: selectedIpRecord ? (selectedIpRecord.title || selectedIpRecord.brand_name) : taskTitle,
                    iprecord_application_no: ipAppNo,
                    iprecord_title: ipTitle,
                    iprecord_applicant_name: ipAppName,
                    documents: [],
                    history: [{
                        action: "Görev oluşturuldu",
                        timestamp: new Date().toISOString(),
                        userEmail: userNameOrEmail
                    }]
                }
            };

            // 🔥 3. TARİH KONTROLÜ (Boşsa set etme, doluysa formatla)
            const manualDueDate = document.getElementById('taskDueDate')?.value;
            if (manualDueDate && manualDueDate.trim() !== '') {
                let parsedDate;
                if (manualDueDate.includes('.')) {
                    const parts = manualDueDate.split('.');
                    parsedDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`); // TR Format
                } else {
                    parsedDate = new Date(manualDueDate);
                }
                
                if (!isNaN(parsedDate.getTime())) {
                    taskData.official_due_date = parsedDate.toISOString();
                    taskData.operational_due_date = parsedDate.toISOString();
                }
            }

            this._enrichTaskWithParties(taskData, selectedTaskType, selectedRelatedParties, selectedRelatedParty, selectedIpRecord);

            if (selectedTaskType.alias === 'Başvuru' && selectedTaskType.ipType === 'trademark') {
                if (selectedApplicants && selectedApplicants.length > 0) {
                    taskData.task_owner_id = String(selectedApplicants[0].id);
                    taskData.details.related_party_name = selectedApplicants[0].name;
                }
            }
            
            const isRawBulletinRecord = selectedIpRecord && (selectedIpRecord.source === 'bulletin' || selectedIpRecord._source === 'bulletin') && !selectedIpRecord.portfolio_status;
            if (isRawBulletinRecord) {
                const newRealRecordId = await this._createRecordFromBulletin(selectedIpRecord);
                if (newRealRecordId) {
                    taskData.ip_record_id = newRealRecordId;
                    state.selectedIpRecord.id = newRealRecordId;
                }
            }

            if (selectedTaskType.alias === 'Başvuru' && selectedTaskType.ipType === 'trademark') {
                const newRecordId = await this._handleTrademarkApplication(state, taskData);
                if (!newRecordId) throw new Error("Marka kaydı oluşturulamadı.");
                taskData.ip_record_id = newRecordId;
            }

            await this._calculateTaskDates(taskData, selectedTaskType, selectedIpRecord);

            // 1. ÖNCE GÖREVİ (TASK) VERİTABANINA YAZ Kİ BİZE BİR ID VERSİN
            const taskResult = await taskService.addTask(taskData);
            if (!taskResult.success) throw new Error(taskResult.error);
            const newTaskId = taskResult.data.id;

            // 2. DOSYALARI OLUŞAN GÖREVİN ID'Sİ İLE "tasks/TASK_ID/" DİZİNİNE YÜKLE
            if (uploadedFiles && uploadedFiles.length > 0) {
                const docs = [];
                const taskDocInserts = [];
                
                for (const fileObj of uploadedFiles) {
                    const file = fileObj.file || fileObj;
                    const docId = this.generateUUID();
                    const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                    
                    // 🔥 ÇÖZÜM: 'documents' bucket'ı altında 'tasks/TASK_ID/' klasörü
                    let storagePath = `tasks/${newTaskId}/${Date.now()}_${docId}_${cleanFileName}`;

                    const url = await this.dataManager.uploadFileToStorage(file, storagePath);
                    if (url) {
                        docs.push({ id: docId, name: file.name, url: url, storagePath: storagePath, type: fileObj.isEpats ? 'epats_document' : 'standard_document' });
                        
                        taskDocInserts.push({
                            task_id: String(newTaskId),
                            document_name: file.name,
                            document_url: url,
                            document_type: fileObj.isEpats ? 'epats_document' : 'task_document'
                        });

                        if (fileObj.isEpats) {
                            taskData.details.epats_doc_url = url;
                            taskData.details.epats_doc_name = file.name;
                        }
                    }
                }
                
                // URL'leri taskData objesine ekle (Aşağıdaki işlem ve dava modüllerine paslamak için)
                taskData.details.documents = docs;

                // Dosyaları SQL'deki task_documents tablosuna kaydet
                if (taskDocInserts.length > 0) {
                    await supabase.from('task_documents').insert(taskDocInserts);
                }
                
                // Görevin detaylarını (JSON) yeni dosya URL'leri ile güncelle
                await supabase.from('tasks').update({ details: taskData.details }).eq('id', newTaskId);
            }

            // Dava İşlemleri
            if (selectedTaskType.ipType === 'suit' || String(selectedTaskType.id) === '49') {
                await this._handleSuitCreation(state, taskData, newTaskId);
            }

            // 🔥 4. İŞLEM OLUŞTUR VE TASK'A BAĞLA
            if (taskData.ip_record_id) {
                const txId = await this._addTransactionToPortfolio(taskData.ip_record_id, selectedTaskType, newTaskId, state, taskData.details.documents);
                if (txId) {
                    // Task tablosundaki transaction_id'yi güncelle
                    await supabase.from('tasks').update({ transaction_id: txId }).eq('id', newTaskId);
                }

                // 🔥 ÇÖZÜM 2: WIPO/ARIPO alt kayıtları (child) için de teker teker transaction (işlem) oluştur
                if (state.createdChildRecordIds && state.createdChildRecordIds.length > 0) {
                    console.log(`🌐 ${state.createdChildRecordIds.length} adet Child (Alt) Kayıt için işlem (Transaction) oluşturuluyor...`);
                    for (const childId of state.createdChildRecordIds) {
                        // Aynı evraklar ve task detaylarıyla child için de transaction atıyoruz
                        await this._addTransactionToPortfolio(childId, selectedTaskType, newTaskId, state, taskData.details.documents);
                    }
                }
            }

            await this._handleAccrualLogic(newTaskId, taskData.title, selectedTaskType, state, accrualData, isFreeTransaction);

            showNotification('İş başarıyla oluşturuldu!', 'success');
            setTimeout(() => { window.location.href = 'task-management.html'; }, 1500);

        } catch (error) {
            console.error('Submit Hatası:', error);
            showNotification('İşlem sırasında hata: ' + error.message, 'error');
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    async _resolveImageUrl(path) {
        if (!path) return null;
        if (/^https?:\/\//i.test(path)) return path;
        try {
            const { data } = supabase.storage.from('brand_images').getPublicUrl(path);
            return data ? data.publicUrl : path;
        } catch (e) { return path; }
    }

    async _createRecordFromBulletin(bulletinRecord) {
        try {
            const rawImageSource = bulletinRecord.imagePath || bulletinRecord.imageUrl || bulletinRecord.image || bulletinRecord.brandImageUrl || null;
            const brandImageUrl = await this._resolveImageUrl(rawImageSource);

            let ownerStr = 'Bilinmeyen Sahip';
            if (Array.isArray(bulletinRecord.holders) && bulletinRecord.holders.length > 0) {
                ownerStr = bulletinRecord.holders.map(h => typeof h === 'object' ? (h.name || h.holderName || h.title) : h).join(', ');
            } else if (bulletinRecord.holder || bulletinRecord.applicantName) {
                ownerStr = bulletinRecord.holder || bulletinRecord.applicantName;
            }

            const newRecordData = {
                title: bulletinRecord.markName || bulletinRecord.title || `Başvuru No: ${bulletinRecord.applicationNo}`,
                type: 'trademark',
                portfoyStatus: 'active',
                status: 'published_in_bulletin', 
                recordOwnerType: 'third_party',
                applicationNumber: bulletinRecord.applicationNo || bulletinRecord.applicationNumber || null,
                applicationDate: bulletinRecord.applicationDate || bulletinRecord.adDate || null,
                brandText: bulletinRecord.markName || null,
                brandImageUrl: brandImageUrl,
                description: `Bülten Sahibi: ${ownerStr}`, 
                createdFrom: 'bulletin_record', 
                createdAt: new Date().toISOString()
            };

            const result = await ipRecordsService.createRecordFromDataEntry(newRecordData);
            return result.success ? result.id : null;
        } catch (error) { return null; }
    }

    async _handleAccrualLogic(taskId, taskTitle, taskType, state, accrualData, isFree) {
        if (isFree) return; 

        const offFee = parseFloat(accrualData?.officialFee?.amount || accrualData?.officialFee || 0);
        const srvFee = parseFloat(accrualData?.serviceFee?.amount || accrualData?.serviceFee || 0);

        const hasValidAccrualData = accrualData && (offFee > 0 || srvFee > 0);

        if (hasValidAccrualData) {
            const session = await authService.getCurrentSession();
            const dbUser = state.allUsers.find(u => u.email === session?.user?.email);
            
            const newAccrualId = await accrualService._getNextAccrualId();

            const finalAccrual = {
                id: String(newAccrualId),
                task_id: String(taskId),
                status: 'unpaid',
                accrual_type: 'task_accrual',
                tp_invoice_party_id: accrualData.tpInvoiceParty?.id || null,
                service_invoice_party_id: accrualData.serviceInvoiceParty?.id || null,
                created_by_uid: dbUser ? dbUser.id : null,
                
                official_fee_amount: offFee,
                official_fee_currency: accrualData.officialFee?.currency || 'TRY',
                service_fee_amount: srvFee,
                service_fee_currency: accrualData.serviceFee?.currency || 'TRY',
                
                total_amount: accrualData.totalAmount ? (Array.isArray(accrualData.totalAmount) ? accrualData.totalAmount : [accrualData.totalAmount]) : [],
                remaining_amount: accrualData.totalAmount ? (Array.isArray(accrualData.totalAmount) ? accrualData.totalAmount : [accrualData.totalAmount]) : [],
                
                vat_rate: Number(accrualData.vatRate) || 20,
                apply_vat_to_official_fee: Boolean(accrualData.applyVatToOfficialFee),
                is_foreign_transaction: Boolean(accrualData.isForeignTransaction),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            try {
                const { error: accError } = await supabase.from('accruals').insert(finalAccrual);
                if (accError) throw accError;
                console.log("✅ Tahakkuk başarıyla kaydedildi.");

                // ======================================================
                // 🔥 DEBUG (LOGLAMA) BÖLÜMÜ BAŞLIYOR
                // ======================================================
                console.log("======== TAHAKKUK EVRAK YÜKLEME DEBUG ========");
                console.log("1. Gelen tüm accrualData objesi:", accrualData);
                console.log("2. accrualData.files durumu:", accrualData.files);
                
                if (!accrualData.files || accrualData.files.length === 0) {
                    console.warn("⚠️ DİKKAT: Forma dosya eklenmesine rağmen 'accrualData.files' boş geliyor! AccrualFormManager dosyayı yakalayamıyor olabilir.");
                } else {
                    console.log(`3. Yüklenecek ${accrualData.files.length} adet dosya bulundu. Yükleme başlıyor...`);
                    
                    const docInserts = [];
                    for (const fileObj of accrualData.files) {
                        const file = fileObj.file || fileObj; 
                        console.log(`➡️ İşlenen Dosya: ${file.name} (Boyut: ${file.size} byte, Tip: ${file.type})`);
                        
                        const cleanFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                        const storagePath = `accruals/${newAccrualId}/${Date.now()}_${cleanFileName}`;
                        
                        console.log(`   Yükleme Yolu: documents/${storagePath}`);
                        
                        const { error: uploadError } = await supabase.storage
                            .from('documents')
                            .upload(storagePath, file, { cacheControl: '3600', upsert: true });

                        if (uploadError) {
                            console.error(`   ❌ Storage Yükleme Hatası (${file.name}):`, uploadError);
                            continue; 
                        }
                        
                        console.log(`   ✅ Dosya Storage'a yüklendi.`);
                        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(storagePath);
                        
                        if (urlData && urlData.publicUrl) {
                            console.log(`   🔗 Public URL Alındı: ${urlData.publicUrl}`);
                            docInserts.push({
                                accrual_id: String(newAccrualId),
                                document_name: file.name,
                                document_url: urlData.publicUrl,
                                document_type: file.type || 'other'
                            });
                        }
                    }

                    console.log("4. Veritabanına (accrual_documents) yazılacak dizi:", docInserts);
                    if (docInserts.length > 0) {
                        const { error: docError } = await supabase.from('accrual_documents').insert(docInserts);
                        if (docError) {
                            console.error("❌ accrual_documents tablosuna yazılamadı:", docError);
                        } else {
                            console.log(`✅ ${docInserts.length} evrak başarıyla veritabanına eklendi!`);
                        }
                    }
                }
                console.log("==============================================");
                // ======================================================

            } catch (err) {
                console.error("❌ Tahakkuk kaydedilemedi:", err);
            }
            return; 
        }

        // --- Tahakkuk Girilmediyse "Tahakkuk Oluşturma Görevi" Ata ---
        let assignedUid = null, assignedEmail = "Atanmamış";
        try {
            const rule = await this.dataManager.getAssignmentRule("53");
            if (rule && rule.assigneeIds && rule.assigneeIds.length > 0) {
                const user = state.allUsers.find(u => u.id === rule.assigneeIds[0]);
                if (user) { assignedUid = user.id; assignedEmail = user.email; }
            }
        } catch (e) { }

        let accAppNo = "-", accTitle = taskTitle, accAppName = "-";
        if (state.selectedIpRecord) {
            const sip = state.selectedIpRecord;
            accAppNo = sip.application_number || sip.applicationNo || sip.appNo || sip.caseNo || "-";
            accTitle = sip.title || sip.brand_name || sip.markName || taskTitle;
            if (Array.isArray(sip.applicants) && sip.applicants.length > 0) accAppName = sip.applicants[0].name || "-";
            else if (sip.client && sip.client.name) accAppName = sip.client.name;
        }

        // 🔥 YENİ 1: Görev Sahibini (Müvekkil/Rakip) State Üzerinden Güvenle Bulma
        let targetOwnerId = null;
        if (state.selectedRelatedParties && state.selectedRelatedParties.length > 0) {
            targetOwnerId = String(state.selectedRelatedParties[0].id);
        } else if (state.selectedIpRecord) {
            if (state.selectedIpRecord.client_id) {
                targetOwnerId = String(state.selectedIpRecord.client_id);
            } else if (state.selectedIpRecord.applicants && state.selectedIpRecord.applicants.length > 0) {
                const firstApp = state.selectedIpRecord.applicants[0];
                targetOwnerId = String(firstApp.id || firstApp.person_id || (firstApp.persons && firstApp.persons.id));
            }
        } else if (state.selectedApplicants && state.selectedApplicants.length > 0) {
            targetOwnerId = String(state.selectedApplicants[0].id);
        }

        const accrualTaskData = {
            task_type_id: "53", 
            title: `Tahakkuk Oluşturma: ${taskTitle}`,
            description: `"${taskTitle}" işi oluşturuldu ancak tahakkuk girilmedi. Lütfen finansal kaydı oluşturun.`,
            priority: 'high',
            status: 'pending',
            assigned_to: assignedUid,
            ip_record_id: state.selectedIpRecord ? state.selectedIpRecord.id : null,
            task_owner_id: targetOwnerId, 
            details: {
                assigned_to_email: assignedEmail,
                iprecord_application_no: accAppNo,
                iprecord_title: accTitle,
                iprecord_applicant_name: accAppName,
                parent_task_id: String(taskId) 
            }
        };

        // 1. Görevi oluştur
        const accResult = await taskService.addTask(accrualTaskData);
        
        // 🔥 ÇÖZÜM: details kolonunun veritabanı tarafından ezilmesini engellemek için, 
        // görev oluştuktan hemen sonra Supabase'e doğrudan müdahale edip JSON'u güncelliyoruz.
        if (accResult && accResult.success) {
            const newAccTaskId = accResult.data?.id || accResult.id;
            
            if (newAccTaskId) {
                // Veritabanının o saniye oluşturduğu güncel JSON'u çek
                const { data: dbData } = await supabase.from('tasks').select('details').eq('id', newAccTaskId).single();
                let mergedDetails = dbData?.details || {};
                
                // Silinmesini istemediğimiz verileri zorla içine yaz
                mergedDetails.assigned_to_email = assignedEmail;
                mergedDetails.iprecord_application_no = accAppNo;
                mergedDetails.iprecord_title = accTitle;
                mergedDetails.iprecord_applicant_name = accAppName;
                mergedDetails.parent_task_id = String(taskId); // <- ASIL HEDEFİMİZ (İşin koptuğu yer)
                
                // Güvenli bir şekilde geri yükle
                await supabase.from('tasks').update({ details: mergedDetails }).eq('id', newAccTaskId);
            }
        }
    }

    async _calculateTaskDates(taskData, taskType, ipRecord) {
        try {
            const isRenewal = String(taskType.id) === '22' || /yenileme/i.test(taskType.name);
            if (isRenewal && ipRecord) {
                const rawDate = ipRecord.renewal_date || ipRecord.renewalDate || ipRecord.registration_date || ipRecord.application_date;
                let baseDate = rawDate ? new Date(rawDate) : new Date();
                if (isNaN(baseDate.getTime())) baseDate = new Date();
                if (baseDate < new Date()) baseDate.setFullYear(baseDate.getFullYear() + 10);

                const official = findNextWorkingDay(baseDate, TURKEY_HOLIDAYS);
                const operational = new Date(official);
                operational.setDate(operational.getDate() - 3);

                taskData.official_due_date = official.toISOString();
                taskData.operational_due_date = operational.toISOString();
            }
        } catch (e) { }
    }

    _enrichTaskWithParties(taskData, taskType, relatedParties, singleParty, ipRecord) {
        const tIdStr = String(taskType.id);
        
        let finalOwnerId = null;
        let finalOwnerName = null;

        // 1. STRATEJİ: Formda açıkça "İlgili Kişi / Müvekkil / Sahip" seçilmişse onu al.
        if (relatedParties && relatedParties.length > 0) {
            finalOwnerId = String(relatedParties[0].id);
            finalOwnerName = relatedParties[0].name;
            
            if (RELATED_PARTY_REQUIRED.has(tIdStr)) {
                taskData.details.related_party_id = finalOwnerId;
                taskData.details.related_party_name = finalOwnerName;
            }
        } 
        // 2. STRATEJİ: Seçilmediyse, doğrudan IP Record'un (Varlığın) sahibine/müvekkiline bak.
        else if (ipRecord) {
            // A) 3. Taraf dosyasıysa (Rakipse) veya atanmış müvekkil varsa
            if (ipRecord.client_id) {
                finalOwnerId = String(ipRecord.client_id);
                finalOwnerName = ipRecord.client?.name || "Müvekkil";
            } 
            // B) Kendi dosyamızsa ve başvuru sahibi varsa
            else if (ipRecord.applicants && ipRecord.applicants.length > 0) {
                const firstApp = ipRecord.applicants[0];
                finalOwnerId = String(firstApp.id || firstApp.person_id || (firstApp.persons && firstApp.persons.id));
                finalOwnerName = firstApp.name || (firstApp.persons && firstApp.persons.name) || "Başvuru Sahibi";
            }
        }

        // 🔥 Şelale mantığıyla bulunan en geçerli ID'yi Task Owner olarak set et
        if (finalOwnerId) {
            taskData.task_owner_id = finalOwnerId;
        }

        // Karşı Taraf (Rakip) Bilgisi (İtiraz işlemleri için)
        if (['7', '19', '20'].includes(tIdStr)) {
            const opponent = singleParty || (relatedParties && relatedParties.length > 1 ? relatedParties[1] : null);
            if (opponent) {
                taskData.details.opponent_id = opponent.id;
                taskData.details.opponent_name = opponent.name;
            }
        }
    }

    async _handleTrademarkApplication(state, taskData) {
        // 🔥 ÇÖZÜM 3: selectedCountries state'den çekildi
        const { selectedApplicants, priorities, uploadedFiles, selectedCountries } = state;
        
        const newRecordId = this.generateUUID();

        let brandImageUrl = null;
        const brandImgInput = document.getElementById('brandExample');
        let brandFile = null;
        
        if (brandImgInput && brandImgInput.files && brandImgInput.files.length > 0) {
            brandFile = brandImgInput.files[0];
        } else if (uploadedFiles && uploadedFiles.length > 0) {
            brandFile = uploadedFiles[0].file || uploadedFiles[0];
        }

        if (brandFile) {
            const cleanFileName = brandFile.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const storagePath = `${newRecordId}/${Date.now()}_${cleanFileName}`;
            
            try {
                const { error: uploadError } = await supabase.storage
                    .from('brand_images')
                    .upload(storagePath, brandFile, { cacheControl: '3600', upsert: true });

                if (!uploadError) {
                    const { data: urlData } = supabase.storage.from('brand_images').getPublicUrl(storagePath);
                    if (urlData && urlData.publicUrl) {
                        brandImageUrl = urlData.publicUrl;
                        console.log("✅ Marka görseli 'brand_images' bucket'ına yüklendi:", brandImageUrl);
                    }
                } else {
                    console.error("❌ Marka görseli yükleme hatası:", uploadError);
                }
            } catch (e) {
                console.error("❌ Marka görseli yüklenirken hata oluştu:", e);
            }
        }

        const brandType = document.getElementById('brandType')?.value || '';
        const brandCategory = document.getElementById('brandCategory')?.value || '';
        const visualDescription = document.getElementById('brandExampleText')?.value?.trim() || ''; 
        const nonLatin = document.getElementById('nonLatinAlphabet')?.value || '';
        
        let cleanBrandName = visualDescription;
        if (!cleanBrandName && taskData.title) {
                cleanBrandName = taskData.title.replace(/ Marka Başvurusu$/i, '').trim();
        }

        // 🔥 ÇÖZÜM 1: Ülke ve Menşe (Origin) atamaları WIPO/ARIPO'ya uygun hale getirildi
        let origin = document.getElementById('originSelect')?.value || 'TÜRKPATENT';
        let originCountry = 'TR'; 
        
        if (origin === 'Yurtdışı Ulusal' || origin === 'FOREIGN_NATIONAL') {
            origin = 'FOREIGN_NATIONAL';
            originCountry = document.getElementById('countrySelect')?.value || '';
        } else if (origin === 'WIPO' || origin === 'ARIPO') {
            originCountry = ''; // WIPO/ARIPO ana kaydı için ülke kodu boş (null) bırakılır
        }

        let goodsAndServicesByClass = [];
        try {
            const rawNiceClasses = getSelectedNiceClasses();
            
            if (Array.isArray(rawNiceClasses)) {
                goodsAndServicesByClass = rawNiceClasses.reduce((acc, item) => {
                    let classNo = NaN;
                    let rawText = '';
                    
                    const match = String(item).match(/(?:sınıf|class)?\s*\(?(\d+)\)?\s*[-:]?\s*([\s\S]*)/i);
                    
                    if (match) {
                        classNo = parseInt(match[1]);
                        rawText = match[2] ? match[2].trim() : '';
                    } else {
                        classNo = parseInt(item);
                    }

                    if (!isNaN(classNo)) {
                        let classObj = acc.find(obj => obj.classNo === classNo);
                        if (!classObj) {
                            classObj = { classNo, items: [] };
                            acc.push(classObj);
                        }
                        if (rawText && rawText !== '-' && rawText !== '') {
                            const lines = rawText.split(/[\n]/).map(l => l.trim()).filter(Boolean);
                            lines.forEach(line => {
                                const cleanLine = line.replace(/^\)+|\)+$/g, '').trim(); 
                                if (cleanLine && !classObj.items.includes(cleanLine)) {
                                    classObj.items.push(cleanLine);
                                }
                            });
                        }
                    }
                    return acc;
                }, []).sort((a, b) => a.classNo - b.classNo);
            }
        } catch (e) { 
            console.error("❌ Sınıf ayrıştırma hatası:", e);
        }

        const applicantsData = selectedApplicants.map(p => ({ id: p.id }));

        const newRecordData = {
            id: newRecordId, 
            title: cleanBrandName,
            brandText: cleanBrandName,
            type: 'trademark',
            recordOwnerType: 'self',
            portfoyStatus: 'active',
            status: 'filed',
            applicationDate: new Date().toISOString().split('T')[0],
            
            // 🔥 DÜZELTME: Veritabanına '-' yerine temiz bir şekilde null gönderiyoruz
            applicationNumber: null, 
            
            renewalDate: (() => {
                const d = new Date();
                d.setFullYear(d.getFullYear() + 10);
                return d.toISOString().split('T')[0];
            })(),
            brandType: brandType,
            brandCategory: brandCategory,
            nonLatinAlphabet: nonLatin !== '', 
            brandImageUrl: brandImageUrl, 
            origin: origin,
            countryCode: originCountry,
            createdFrom: 'create_task', 
            
            applicants: applicantsData,
            goodsAndServicesByClass: goodsAndServicesByClass,
            priorities: priorities || []
        };

        // 1. Ana Kaydı (Parent) Veritabanına Yaz
        const result = await ipRecordsService.createRecordFromDataEntry(newRecordData);

        // WIPO veya ARIPO seçildiyse, seçilen ülkeler için Child (Alt) kayıtları oluştur
        if (result.success && ['WIPO', 'ARIPO'].includes(origin) && selectedCountries && selectedCountries.length > 0) {
            console.log(`🌐 ${origin} Menşeli ${selectedCountries.length} adet Child (Alt) Kayıt Oluşturuluyor...`);
            
            // 🔥 ÇÖZÜM 1: Oluşan alt kayıtların ID'lerini state üzerinde bir listede topluyoruz
            state.createdChildRecordIds = [];

            for (const country of selectedCountries) {
                const childId = this.generateUUID();
                const childCountryCode = typeof country === 'object' ? (country.code || country.id || country.name) : country;
                
                const childData = {
                    ...newRecordData,
                    id: childId,
                    parentId: newRecordId, 
                    transactionHierarchy: 'child', 
                    countryCode: childCountryCode, 
                    wipoIR: null, 
                    aripoIR: null 
                };
                
                const childResult = await ipRecordsService.createRecordFromDataEntry(childData);
                if (childResult.success) {
                    console.log(`✅ ${childCountryCode} için alt kayıt başarıyla oluşturuldu (ID: ${childId})`);
                    // 🔥 Başarıyla oluşan child ID'sini listeye ekle
                    state.createdChildRecordIds.push(childId);
                } else {
                    console.error(`❌ ${childCountryCode} alt kaydı oluşturulamadı:`, childResult.error);
                }
            }
        }

        return result.success ? result.id : null;
    }
    
    async _handleSuitCreation(state, taskData, taskId) {
        if (!['49', '54', '55', '56', '57', '58'].includes(String(state.selectedTaskType.id))) return; 
        const client = state.selectedRelatedParties && state.selectedRelatedParties.length > 0 ? state.selectedRelatedParties[0] : null;
        const courtSelect = document.getElementById('courtName');
        const customInput = document.getElementById('customCourtInput');
        const finalCourtName = courtSelect?.value === 'other' ? customInput?.value.trim() : courtSelect?.value;

        const suitRow = {
            id: this.generateUUID(),
            file_no: document.getElementById('suitCaseNo')?.value || null,
            court_name: finalCourtName,
            plaintiff: document.getElementById('clientRole')?.value === 'davaci' ? client?.name : document.getElementById('opposingParty')?.value,
            defendant: document.getElementById('clientRole')?.value === 'davali' ? client?.name : document.getElementById('opposingParty')?.value,
            subject: taskData.title,
            status: 'continue',
            title: taskData.title,
            transaction_type_id: state.selectedTaskType.id,
            suit_type: state.selectedTaskType.alias || state.selectedTaskType.name,
            client_id: client ? client.id : null,
            related_task_id: taskId,
            created_at: new Date().toISOString()
        };
        const { data: newSuit } = await supabase.from('suits').insert(suitRow).select('id').single();
        if(newSuit) await this._addTransactionToPortfolio(newSuit.id, state.selectedTaskType, taskId, state, taskData.details.documents);
    }

    async _addTransactionToPortfolio(recordId, taskType, taskId, state, taskDocuments = []) {
        let hierarchy = 'parent', parentId = null;
        if (['8', '21', '37'].includes(String(taskType.id)) && this.selectedParentTransactionId) { hierarchy = 'child'; parentId = this.selectedParentTransactionId; }

        // 🔥 KULLANICI DOĞRULAMASI (FK HATASI BURADA ÇÖZÜLDÜ)
        const session = await authService.getCurrentSession();
        const dbUser = state.allUsers.find(u => u.email === session?.user?.email);

        const transactionData = {
            id: this.generateUUID(), 
            ip_record_id: String(recordId),
            transaction_type_id: String(taskType.id),
            description: `${taskType.name} işlemi.`,
            transaction_hierarchy: hierarchy,
            parent_id: parentId,
            task_id: String(taskId),
            user_id: dbUser ? dbUser.id : null, // Geçerli ID
            user_email: session?.user?.email || null,
            user_name: dbUser ? (dbUser.display_name || dbUser.name) : null,
            transaction_date: new Date().toISOString()
        };

        try {
            const { data: newTx, error: txError } = await supabase.from('transactions').insert(transactionData).select('id').single();
            if (txError) throw txError;

            if (taskDocuments.length > 0) {
                const docInserts = taskDocuments.map(d => ({
                    transaction_id: newTx.id, document_name: d.name, document_url: d.url, document_type: 'other'
                }));
                await supabase.from('transaction_documents').insert(docInserts);
            }
            return newTx.id; 
        } catch (error) { return null; }
    }
}