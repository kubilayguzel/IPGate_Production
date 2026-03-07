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
            clientRole: getVal('clientRole'),
            client: ctx.suitClientPerson,
            transactionTypeId: ctx.suitSpecificTaskType?.id || getVal('specificTaskType'),
            ipRecordId: ctx.suitSubjectAsset?.id || null, // Eğer portföyden seçildiyse
            suitDetails: {
                caseNo: getVal('suitCaseNo'),
                courtName: courtName === 'other' ? getVal('customCourtInput') : courtName,
                suitType: ctx.suitSpecificTaskType?.name || '',
                opposingParty: getVal('opposingParty'),
                opposingCounsel: getVal('opposingCounsel'),
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
        try {
            const suitRow = {
                id: generateUUID(),
                file_no: data.suitDetails.caseNo || null,
                court_name: data.suitDetails.courtName,
                plaintiff: data.clientRole === 'davaci' ? data.client?.name : data.suitDetails.opposingParty,
                defendant: data.clientRole === 'davali' ? data.client?.name : data.suitDetails.opposingParty,
                subject: data.title,
                status: data.suitDetails.suitStatus,
                title: data.title,
                transaction_type_id: data.transactionTypeId,
                suit_type: data.suitDetails.suitType,
                client_role: data.clientRole,
                client_id: data.client?.id || null,
                ip_record_id: data.ipRecordId,
                description: data.description || '',
                opposing_party: data.suitDetails.opposingParty || '',
                opposing_counsel: data.suitDetails.opposingCounsel || '',
                opening_date: data.suitDetails.openingDate ? new Date(data.suitDetails.openingDate).toISOString() : new Date().toISOString(),
                created_at: new Date().toISOString()
            };

            const { data: newSuit, error: suitError } = await supabase.from('suits').insert(suitRow).select('id').single();
            if (suitError) throw new Error("Dava kaydedilirken hata oluştu: " + suitError.message);
            const newSuitId = newSuit.id;

            const initialTransaction = {
                ip_record_id: data.ipRecordId || newSuitId, 
                transaction_type_id: data.transactionTypeId,
                description: "Dava Açıldı: " + (data.suitDetails.caseNo || ''),
                transaction_hierarchy: 'parent',
                task_id: null, 
                transaction_date: suitRow.opening_date,
                created_at: suitRow.opening_date
            };

            await supabase.from('transactions').insert(initialTransaction);
            return newSuitId;

        } catch (error) {
            console.error('Dava Kayıt Hatası:', error);
            throw error;
        }
    }
}