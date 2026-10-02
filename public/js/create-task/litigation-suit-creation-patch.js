// public/js/create-task/litigation-suit-creation-patch.js
// AŞAMA 1B - Create Task > Dava oluşturma uyumluluk katmanı
//
// AMAÇ:
// - Mevcut TaskSubmitHandler.js dosyasını fiziksel olarak değiştirmeden,
//   yalnız dava oluşturma davranışını güvenli biçimde standardize etmek.
// - 49 ve 54-58 tiplerinde yeni suits kaydı oluşturmak.
// - 59/60 (İstinaf/Yargıtay) için yeni suit yaratmamak.
// - Görevi ve transaction'ı suit.id üzerine bağlamak.
// - suits.ip_record_id içinde yalnız dava konusu IP kaydını korumak.
// - Mevcut marka/patent/tasarım akışını aynen bırakmak.

import { TaskSubmitHandler } from './TaskSubmitHandler.js';
import { supabase } from '../../supabase-config.js';

const SUIT_CREATION_TYPE_IDS = new Set(['49', '54', '55', '56', '57', '58']);
const proto = TaskSubmitHandler.prototype;

// Aynı modül yanlışlıkla ikinci kez yüklenirse prototype'ı tekrar sarmalama.
if (!proto.__litigationStage1BPatched) {
    Object.defineProperty(proto, '__litigationStage1BPatched', {
        value: true,
        writable: false,
        configurable: false,
        enumerable: false
    });

    const originalAddTransactionToPortfolio = proto._addTransactionToPortfolio;

    const parseOpeningDate = (rawValue) => {
        const raw = String(rawValue || '').trim();
        if (!raw) return new Date().toISOString();

        let parsed = null;

        if (raw.includes('.')) {
            const parts = raw.split('.');
            if (parts.length === 3) {
                parsed = new Date(
                    Number(parts[2]),
                    Number(parts[1]) - 1,
                    Number(parts[0])
                );
            }
        } else {
            parsed = new Date(raw);
        }

        return parsed && !isNaN(parsed.getTime())
            ? parsed.toISOString()
            : new Date().toISOString();
    };

    proto._handleSuitCreation = async function(state, taskData, taskId) {
        const selectedTaskType = state?.selectedTaskType || {};
        const taskTypeId = String(selectedTaskType.id || '');

        // 59/60 ve diğer dava işlemleri yeni portföy dava kaydı yaratmaz.
        if (!SUIT_CREATION_TYPE_IDS.has(taskTypeId)) {
            return null;
        }

        const courtSelect =
            document.getElementById('courtName') ||
            document.getElementById('suitCourt');

        const customCourtInput = document.getElementById('customCourtInput');
        const courtValue = String(courtSelect?.value || '').trim();

        const courtName = courtValue === 'other'
            ? String(customCourtInput?.value || '').trim()
            : courtValue;

        const openingDate = parseOpeningDate(
            document.getElementById('suitOpeningDate')?.value
        );

        // Bu aşamada taskData.ip_record_id hâlâ dava konusu IP hakkını gösterir.
        // Değeri suits.ip_record_id içinde koruyoruz.
        const subjectIpRecordId =
            taskData?.ip_record_id ||
            state?.selectedIpRecord?.id ||
            null;

        const clientRole =
            document.getElementById('clientRole')?.value ||
            null;

        const clientId =
            taskData?.task_owner_id ||
            state?.selectedRelatedParties?.[0]?.id ||
            state?.selectedRelatedParty?.id ||
            null;

        const clientName =
            taskData?.details?.relatedPartyName ||
            taskData?.details?.related_party_name ||
            state?.selectedRelatedParties?.[0]?.name ||
            state?.selectedRelatedParty?.name ||
            null;

        const opposingParty =
            String(document.getElementById('opposingParty')?.value || '').trim() ||
            null;

        const opposingCounsel =
            String(document.getElementById('opposingCounsel')?.value || '').trim() ||
            null;

        const fileNo =
            String(document.getElementById('suitCaseNo')?.value || '').trim() ||
            null;

        const suitId = this.generateUUID();
        const now = new Date().toISOString();

        const suitRow = {
            id: suitId,
            title:
                taskData?.title ||
                selectedTaskType.alias ||
                selectedTaskType.name ||
                'Dava Dosyası',
            file_no: fileNo,
            court_name: courtName || null,
            description: taskData?.description || null,
            suit_type:
                selectedTaskType.alias ||
                selectedTaskType.name ||
                null,
            status:
                document.getElementById('suitStatusSelect')?.value ||
                'continue',
            origin: 'TURKEY',
            opening_date: openingDate,

            client_role: clientRole,
            opposing_party: opposingParty,
            opposing_counsel: opposingCounsel,
            client_id: clientId ? String(clientId) : null,

            // KRİTİK AYRIM:
            // suits.ip_record_id = dava konusu marka/patent/tasarım
            // transactions/tasks.ip_record_id = suit.id
            ip_record_id: subjectIpRecordId
                ? String(subjectIpRecordId)
                : null,

            task_id: String(taskId),
            transaction_type_id: taskTypeId,

            created_at: now,
            updated_at: now
        };

        const { data: insertedSuit, error: suitError } = await supabase
            .from('suits')
            .insert(suitRow)
            .select('id')
            .single();

        if (suitError) {
            throw new Error(
                'Dava kaydedilirken hata oluştu: ' + suitError.message
            );
        }

        let taskWasLinkedToSuit = false;

        try {
            // -------------------------------------------------------------
            // TARAFLAR
            // -------------------------------------------------------------
            const partyInserts = [];
            const seenParties = new Set();

            const pushParty = (role, personId, name) => {
                const cleanRole = String(role || '').trim();
                const cleanPersonId =
                    personId && personId !== 'free_text'
                        ? String(personId)
                        : null;
                const cleanName =
                    String(name || '').trim() ||
                    null;

                if (!cleanRole || (!cleanPersonId && !cleanName)) {
                    return;
                }

                const dedupeKey = [
                    cleanRole,
                    cleanPersonId || '',
                    (cleanName || '').toLocaleLowerCase('tr-TR')
                ].join('|');

                if (seenParties.has(dedupeKey)) {
                    return;
                }

                seenParties.add(dedupeKey);

                partyInserts.push({
                    suit_id: suitId,
                    role: cleanRole,
                    person_id: cleanPersonId,
                    free_text_name: cleanName
                });
            };

            // Data Entry tarzı çoklu taraf objesi mevcutsa onu da destekle.
            const partiesData =
                window.suitPartiesData ||
                { davaci: [], davali: [] };

            (partiesData.davaci || []).forEach((party) => {
                pushParty('davaci', party?.id, party?.name);
            });

            (partiesData.davali || []).forEach((party) => {
                pushParty('davali', party?.id, party?.name);
            });

            // Create Task ekranındaki gerçek müvekkili person_id ile kaydet.
            if (clientRole && (clientId || clientName)) {
                pushParty(clientRole, clientId, clientName);
            }

            // Create Task ekranındaki serbest karşı tarafı ters role ekle.
            if (opposingParty) {
                const opponentRole =
                    clientRole === 'davaci'
                        ? 'davali'
                        : clientRole === 'davali'
                            ? 'davaci'
                            : 'karsi_taraf';

                pushParty(opponentRole, null, opposingParty);
            }

            if (partyInserts.length > 0) {
                const { error: partyError } = await supabase
                    .from('suit_parties')
                    .insert(partyInserts);

                if (partyError) {
                    throw new Error(
                        'Dava tarafları kaydedilirken hata oluştu: ' +
                        partyError.message
                    );
                }
            }

            // Görevin ana portföy bağlantısını dava dosyasına geçir.
            // Transaction henüz oluşturulmadı; mevcut handler bunu hemen sonra yapacak.
            const { error: taskLinkError } = await supabase
                .from('tasks')
                .update({
                    ip_record_id: String(insertedSuit.id)
                })
                .eq('id', String(taskId));

            if (taskLinkError) {
                throw new Error(
                    'Görev dava dosyasına bağlanamadı: ' +
                    taskLinkError.message
                );
            }

            taskWasLinkedToSuit = true;

            // Mevcut handleFormSubmit akışının oluşturacağı TEK transaction'ın
            // suit.id üzerine yazılması için local taskData'yı da güncelle.
            taskData.ip_record_id = String(insertedSuit.id);

            // Tahakkuk/sonraki mevcut akışlar için de bu submit süresince
            // suit'i aktif kayıt bağlamı yap.
            state.selectedIpRecord = {
                id: String(insertedSuit.id),
                title: suitRow.title,
                file_no: suitRow.file_no,
                caseNo: suitRow.file_no,
                application_number: suitRow.file_no,
                client_id: suitRow.client_id,
                client: clientName
                    ? { name: clientName }
                    : null,
                type: 'suit',
                ipType: 'suit',
                _subjectIpRecordId:
                    suitRow.ip_record_id || null
            };

            // Bir sonraki _addTransactionToPortfolio çağrısında yalnız bu
            // yeni dava için ek güvenlik/rollback uygulanacak.
            this._litigationStage1BContext = {
                suitId: String(insertedSuit.id),
                taskId: String(taskId),
                subjectIpRecordId:
                    suitRow.ip_record_id || null
            };

            return String(insertedSuit.id);

        } catch (error) {
            // Eğer görev suit'e geçirilmişse eski dava konusu IP bağlantısını geri getir.
            if (taskWasLinkedToSuit) {
                try {
                    await supabase
                        .from('tasks')
                        .update({
                            ip_record_id:
                                subjectIpRecordId
                                    ? String(subjectIpRecordId)
                                    : null
                        })
                        .eq('id', String(taskId));
                } catch (restoreTaskError) {
                    console.warn(
                        '[LITIGATION 1B] Task rollback uyarısı:',
                        restoreTaskError
                    );
                }
            }

            // suit_parties FK CASCADE ile temizlenir.
            try {
                await supabase
                    .from('suits')
                    .delete()
                    .eq('id', String(insertedSuit.id));
            } catch (cleanupSuitError) {
                console.warn(
                    '[LITIGATION 1B] Suit rollback uyarısı:',
                    cleanupSuitError
                );
            }

            this._litigationStage1BContext = null;
            throw error;
        }
    };

    proto._addTransactionToPortfolio = async function(
        recordId,
        taskType,
        taskId,
        state,
        taskDocuments = []
    ) {
        const txId = await originalAddTransactionToPortfolio.call(
            this,
            recordId,
            taskType,
            taskId,
            state,
            taskDocuments
        );

        const ctx = this._litigationStage1BContext;
        const isCurrentNewSuitTransaction =
            ctx &&
            String(ctx.suitId) === String(recordId) &&
            String(ctx.taskId) === String(taskId);

        // Marka/patent/tasarım ve mevcut dava işlemleri:
        // Orijinal davranışı aynen koru.
        if (!isCurrentNewSuitTransaction) {
            return txId;
        }

        if (!txId) {
            // Parent transaction oluşmadıysa yarım dava bırakma.
            try {
                await supabase
                    .from('suits')
                    .delete()
                    .eq('id', String(ctx.suitId));
            } catch (cleanupSuitError) {
                console.warn(
                    '[LITIGATION 1B] Suit rollback uyarısı:',
                    cleanupSuitError
                );
            }

            try {
                await supabase
                    .from('tasks')
                    .update({
                        ip_record_id:
                            ctx.subjectIpRecordId
                                ? String(ctx.subjectIpRecordId)
                                : null,
                        transaction_id: null
                    })
                    .eq('id', String(ctx.taskId));
            } catch (restoreTaskError) {
                console.warn(
                    '[LITIGATION 1B] Task rollback uyarısı:',
                    restoreTaskError
                );
            }

            this._litigationStage1BContext = null;

            throw new Error(
                'Dava açılış işlemi (transaction) oluşturulamadı.'
            );
        }

        // Mevcut handleFormSubmit biraz sonra transaction_id yazacak.
        // Burada da doğrulayarak suit + task + transaction zincirini garanti ediyoruz.
        const { error: finalTaskLinkError } = await supabase
            .from('tasks')
            .update({
                ip_record_id: String(ctx.suitId),
                transaction_id: String(txId)
            })
            .eq('id', String(ctx.taskId));

        if (finalTaskLinkError) {
            try {
                await supabase
                    .from('transactions')
                    .delete()
                    .eq('id', String(txId));
            } catch (cleanupTxError) {
                console.warn(
                    '[LITIGATION 1B] Transaction rollback uyarısı:',
                    cleanupTxError
                );
            }

            try {
                await supabase
                    .from('suits')
                    .delete()
                    .eq('id', String(ctx.suitId));
            } catch (cleanupSuitError) {
                console.warn(
                    '[LITIGATION 1B] Suit rollback uyarısı:',
                    cleanupSuitError
                );
            }

            try {
                await supabase
                    .from('tasks')
                    .update({
                        ip_record_id:
                            ctx.subjectIpRecordId
                                ? String(ctx.subjectIpRecordId)
                                : null,
                        transaction_id: null
                    })
                    .eq('id', String(ctx.taskId));
            } catch (restoreTaskError) {
                console.warn(
                    '[LITIGATION 1B] Task rollback uyarısı:',
                    restoreTaskError
                );
            }

            this._litigationStage1BContext = null;

            throw new Error(
                'Dava transaction bağlantısı göreve yazılamadı: ' +
                finalTaskLinkError.message
            );
        }

        this._litigationStage1BContext = null;
        return txId;
    };
}
