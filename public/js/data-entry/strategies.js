// js/data-entry/strategies.js

import { FormTemplates } from './form-templates.js';
import { getSelectedNiceClasses } from '../nice-classification.js';
import { STATUSES } from '../../utils.js';
import { supabase } from '../../supabase-config.js';

const getVal = (id) => document.getElementById(id)?.value?.trim() || null;

const formatDate = (dateStr) => {
    if (!dateStr) return null;
    const parts = dateStr.split('.');
    if (parts.length === 3) {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return dateStr;
};

const generateUUID = () => {
    return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).substr(2, 16);
};

class BaseStrategy {
    render(container) { container.innerHTML = ''; }
    collectData(ctx) { return {}; }
    validate(data) { return null; }
}

export class TrademarkStrategy extends BaseStrategy {
    render(container, isEditMode = false) {
        container.innerHTML = FormTemplates.getTrademarkForm();
        const stSel = document.getElementById('trademarkStatus');
        if (stSel) {
            const emptyOpt = '<option value="">Durum Seçiniz...</option>';
            const statusOptions = STATUSES.trademark.map(s => `<option value="${s.value}">${s.text}</option>`).join('');
            stSel.innerHTML = emptyOpt + statusOptions;
            if (!isEditMode) stSel.value = '';
        }
    }

    collectData(ctx) {
        return {
            title: getVal('brandExampleText'),
            brandText: getVal('brandExampleText'),
            brandType: getVal('brandType'),
            brandCategory: getVal('brandCategory'),
            status: getVal('trademarkStatus'),
            applicationNumber: getVal('applicationNumber'),
            applicationDate: formatDate(getVal('applicationDate')),
            registrationNumber: getVal('registrationNumber'),
            registrationDate: formatDate(getVal('registrationDate')),
            renewalDate: formatDate(getVal('renewalDate')),
            bulletinNo: getVal('bulletinNo'),
            bulletinDate: formatDate(getVal('bulletinDate')),
            description: getVal('brandDescription')
        };
    }

    validate(data) {
        if (!data.title) return "Marka metni/adı zorunludur.";
        return null;
    }
}

export class PatentStrategy extends BaseStrategy {
    render(container, isEditMode = false) {
        container.innerHTML = FormTemplates.getPatentForm();
        const stSel = document.getElementById('patentStatus');
        if (stSel) {
            const emptyOpt = '<option value="">Durum Seçiniz...</option>';
            const statusOptions = STATUSES.patent.map(s => `<option value="${s.value}">${s.text}</option>`).join('');
            stSel.innerHTML = emptyOpt + statusOptions;
            if (!isEditMode) stSel.value = '';
        }
    }

    collectData(ctx) {
        return {
            title: getVal('patentTitle'),
            status: getVal('patentStatus'),
            applicationNumber: getVal('patentApplicationNumber'),
            applicationDate: formatDate(getVal('patentApplicationDate')),
            registrationNumber: getVal('patentRegistrationNumber'),
            registrationDate: formatDate(getVal('patentRegistrationDate')),
            description: getVal('patentDescription')
        };
    }

    validate(data) {
        if (!data.title) return "Patent başlığı zorunludur.";
        return null;
    }
}

export class DesignStrategy extends BaseStrategy {
    render(container, isEditMode = false) {
        container.innerHTML = FormTemplates.getDesignForm();
        const stSel = document.getElementById('designStatus');
        if (stSel) {
            const emptyOpt = '<option value="">Durum Seçiniz...</option>';
            const statusOptions = STATUSES.design.map(s => `<option value="${s.value}">${s.text}</option>`).join('');
            stSel.innerHTML = emptyOpt + statusOptions;
            if (!isEditMode) stSel.value = '';
        }
    }

    collectData(ctx) {
        return {
            title: getVal('designTitle'),
            status: getVal('designStatus'),
            applicationNumber: getVal('designApplicationNumber'),
            applicationDate: formatDate(getVal('designApplicationDate')),
            registrationNumber: getVal('designRegistrationNumber'),
            registrationDate: formatDate(getVal('designRegistrationDate')),
            description: getVal('designDescription')
        };
    }

    validate(data) {
        if (!data.title) return "Tasarım başlığı zorunludur.";
        return null;
    }
}

export class SuitStrategy extends BaseStrategy {
    render(container, isEditMode = false) {
        container.innerHTML = FormTemplates.getSuitForm();
    }

    collectData(ctx) {
        const courtName = getVal('suitCourt');

        return {
            title: ctx.suitSubjectAsset?.title || ctx.suitSubjectAsset?.displayTitle || getVal('suitCaseNo') || 'Dava Dosyası',
            description: getVal('suitDescription') || '',
            transactionTypeId: ctx.suitSpecificTaskType?.id || getVal('specificTaskType'),

            // AŞAMA 1A:
            // Dava portföy kaydının müvekkili ve müvekkilin davadaki rolü artık
            // doğrudan suits tablosunun native alanlarına kaydedilir.
            clientId: ctx.suitClientPerson?.id || null,
            clientRole: getVal('clientRole'),

            // Bu alan DAVANIN KONUSU olan marka/patent/tasarım kaydını gösterir.
            // Dava transaction'larının kimliği olarak kullanılmaz.
            ipRecordId: ctx.suitSubjectAsset?.id || null,

            suitParties: window.suitPartiesData || { davaci: [], davali: [] },

            suitDetails: {
                caseNo: getVal('suitCaseNo'),
                courtName: courtName === 'other' ? getVal('customCourtInput') : courtName,
                suitType: ctx.suitSpecificTaskType?.alias || ctx.suitSpecificTaskType?.name || '',
                openingDate: formatDate(getVal('suitOpeningDate')),
                suitStatus: getVal('suitStatusSelect') || 'continue'
            }
        };
    }

    validate(data) {
        if (!data.clientRole) return 'Lütfen müvekkil rolünü (Davacı/Davalı) seçiniz.';
        if (!data.transactionTypeId) return 'Lütfen dava türünü (işlem tipi) seçiniz.';
        if (!data.suitDetails.courtName) return 'Lütfen mahkeme bilgisini giriniz/seçiniz.';
        return null;
    }

    async save(data) {
        // ---------------------------------------------------------------------
        // DÜZENLEME MODU - mevcut kaydı çoğaltmadan güvenli update
        // ---------------------------------------------------------------------
        // DataEntryModule düzenlemede data.id gönderiyor. Eski kod her durumda
        // yeni INSERT yaptığı için aynı davanın ikinci kez oluşma riski vardı.
        // Bu aşamada mevcut transaction geçmişine ve suit_parties listesine
        // dokunmuyoruz; sadece suits kaydının native alanlarını güncelliyoruz.
        if (data.id) {
            // Legacy düzenleme ekranı suitClientPerson / suitSubjectAsset state'ini
            // her zaman yeniden hydrate etmiyor. Bu yüzden null gelen ilişki alanlarını
            // mevcut kaydın üzerine yazmıyoruz; böylece eski client/ip bağlantıları
            // yanlışlıkla silinmez.
            const updatePayload = {
                updated_at: new Date().toISOString()
            };

            if (data.suitDetails.caseNo !== null && data.suitDetails.caseNo !== undefined) {
                updatePayload.file_no = data.suitDetails.caseNo || null;
            }
            if (data.suitDetails.courtName) updatePayload.court_name = data.suitDetails.courtName;
            if (data.suitDetails.suitStatus) updatePayload.status = data.suitDetails.suitStatus;
            if (data.title) updatePayload.title = data.title;
            if (data.transactionTypeId) updatePayload.transaction_type_id = String(data.transactionTypeId);
            if (data.suitDetails.suitType) updatePayload.suit_type = data.suitDetails.suitType;
            if (data.clientId) updatePayload.client_id = data.clientId;
            if (data.clientRole) updatePayload.client_role = data.clientRole;
            if (data.ipRecordId) updatePayload.ip_record_id = data.ipRecordId;
            if (data.description !== null && data.description !== undefined) {
                updatePayload.description = data.description || '';
            }
            if (data.suitDetails.openingDate) {
                updatePayload.opening_date = new Date(data.suitDetails.openingDate).toISOString();
            }

            const { error: updateError } = await supabase
                .from('suits')
                .update(updatePayload)
                .eq('id', String(data.id));

            if (updateError) {
                throw new Error('Dava güncellenirken hata oluştu: ' + updateError.message);
            }

            return String(data.id);
        }

        // ---------------------------------------------------------------------
        // YENİ DAVA
        // ---------------------------------------------------------------------
        const newSuitId = generateUUID();
        let initialTransactionId = null;
        let suitCreated = false;

        try {
            const openingDate = data.suitDetails.openingDate
                ? new Date(data.suitDetails.openingDate).toISOString()
                : new Date().toISOString();

            const now = new Date().toISOString();

            const suitRow = {
                id: newSuitId,
                file_no: data.suitDetails.caseNo || null,
                court_name: data.suitDetails.courtName,
                status: data.suitDetails.suitStatus || 'continue',
                title: data.title,
                transaction_type_id: String(data.transactionTypeId),
                suit_type: data.suitDetails.suitType || null,

                // Müvekkil ve müvekkilin dava rolü
                client_id: data.clientId || null,
                client_role: data.clientRole || null,

                // Yalnızca dava konusu IP hakkı
                ip_record_id: data.ipRecordId || null,

                description: data.description || '',
                opening_date: openingDate,
                created_at: now,
                updated_at: now
            };

            const { data: newSuit, error: suitError } = await supabase
                .from('suits')
                .insert(suitRow)
                .select('id')
                .single();

            if (suitError) {
                throw new Error('Dava kaydedilirken hata oluştu: ' + suitError.message);
            }

            suitCreated = true;

            // Taraflar ayrı tabloda tutulmaya devam eder.
            const partyInserts = [];
            const parties = data.suitParties || { davaci: [], davali: [] };

            const addParty = (party, role) => {
                if (!party) return;

                const partyId = party.id && party.id !== 'free_text'
                    ? String(party.id)
                    : null;

                const partyName = String(party.name || '').trim();
                if (!partyId && !partyName) return;

                partyInserts.push({
                    suit_id: newSuitId,
                    role,
                    person_id: partyId,
                    free_text_name: partyName || null
                });
            };

            (parties.davaci || []).forEach(p => addParty(p, 'davaci'));
            (parties.davali || []).forEach(p => addParty(p, 'davali'));

            if (partyInserts.length > 0) {
                const { error: partyError } = await supabase
                    .from('suit_parties')
                    .insert(partyInserts);

                if (partyError) {
                    throw new Error('Dava tarafları kaydedilirken hata oluştu: ' + partyError.message);
                }
            }

            // AŞAMA 1A'NIN ANA KURALI:
            // Dava transaction'ı DAVANIN KENDİ ID'sine bağlanır.
            // suits.ip_record_id ise dava konusu marka/patent/tasarım için korunur.
            initialTransactionId = generateUUID();

            const initialTransaction = {
                id: initialTransactionId,
                ip_record_id: newSuitId,
                transaction_type_id: String(data.transactionTypeId),
                description: 'Dava Açıldı: ' + (data.suitDetails.caseNo || ''),
                transaction_hierarchy: 'parent',
                parent_id: null,
                transaction_date: openingDate,
                created_at: now
            };

            const { error: txError } = await supabase
                .from('transactions')
                .insert(initialTransaction);

            if (txError) {
                throw new Error('Dava açılış işlemi oluşturulurken hata oluştu: ' + txError.message);
            }

            return newSuit.id;

        } catch (error) {
            console.error('Dava Kayıt Hatası:', error);

            // Yarım kayıt bırakmamak için yalnızca BU oluşturma denemesinde
            // üretilen kayıtları geri alıyoruz. Mevcut eski kayıtlara dokunulmaz.
            if (initialTransactionId) {
                try {
                    await supabase
                        .from('transactions')
                        .delete()
                        .eq('id', initialTransactionId);
                } catch (cleanupTxError) {
                    console.warn('Dava transaction rollback uyarısı:', cleanupTxError);
                }
            }

            if (suitCreated) {
                try {
                    await supabase
                        .from('suits')
                        .delete()
                        .eq('id', newSuitId);
                } catch (cleanupSuitError) {
                    console.warn('Dava rollback uyarısı:', cleanupSuitError);
                }
            }

            throw error;
        }
    }
}
