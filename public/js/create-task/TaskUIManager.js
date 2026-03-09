import { TASK_IDS, RELATED_PARTY_REQUIRED, PARTY_LABEL_BY_ID, asId } from './TaskConstants.js';
import { getSelectedNiceClasses } from '../nice-classification.js';
import { COURTS_LIST } from '../../utils.js';

export class TaskUIManager {
    constructor() {
        this.container = document.getElementById('conditionalFieldsContainer');
    }

    clearContainer() {
        if (this.container) this.container.innerHTML = '';
    }

    // --- 1. MARKA BAŞVURU FORMU (SEKMELİ YAPI) ---
    renderTrademarkApplicationForm() {
        if (!this.container) return;
        this.container.innerHTML = `
        <div class="form-section" style="padding: 0 !important; background: transparent; border: none; box-shadow: none;">
            <ul class="nav nav-tabs" id="myTaskTabs" role="tablist">
                <li class="nav-item"><a class="nav-link active" id="brand-info-tab" data-toggle="tab" href="#brand-info"><i class="fas fa-tag mr-1"></i>Marka Bilgileri</a></li>
                <li class="nav-item"><a class="nav-link" id="goods-services-tab" data-toggle="tab" href="#goods-services"><i class="fas fa-list-ul mr-1"></i>Mal/Hizmet Seçimi</a></li>
                <li class="nav-item"><a class="nav-link" id="applicants-tab" data-toggle="tab" href="#applicants"><i class="fas fa-users mr-1"></i>Başvuru Sahibi</a></li>
                <li class="nav-item"><a class="nav-link" id="priority-tab" data-toggle="tab" href="#priority"><i class="fas fa-star mr-1"></i>Rüçhan</a></li>
                <li class="nav-item"><a class="nav-link" id="accrual-tab" data-toggle="tab" href="#accrual"><i class="fas fa-file-invoice-dollar mr-1"></i>Tahakkuk/Diğer</a></li>
                <li class="nav-item"><a class="nav-link" id="summary-tab" data-toggle="tab" href="#summary"><i class="fas fa-check-double mr-1"></i>Özet</a></li>
            </ul>
            <div class="tab-content mt-3 tab-content-card shadow-sm bg-white" id="myTaskTabContent" style="border-radius: 0 0 16px 16px; border: 1px solid #e1e8ed; padding: 25px;">
                ${this._getBrandInfoTabHtml()}
                ${this._getGoodsServicesTabHtml()}
                ${this._getApplicantsTabHtml()}
                ${this._getPriorityTabHtml()}
                ${this._getAccrualTabHtml()}
                <div class="tab-pane fade" id="summary" role="tabpanel"><div id="summaryContent" class="form-section"></div></div>
            </div>
        </div>
        <div id="formActionsContainer" class="premium-footer-actions mt-4">
            <button type="button" id="cancelBtn" class="btn btn-secondary btn-lg rounded-pill px-4"><i class="fas fa-times mr-2"></i>İptal</button>
            <button type="button" id="nextTabBtn" class="btn btn-primary btn-lg rounded-pill px-5 shadow"><i class="fas fa-arrow-right mr-2"></i>İlerle</button>
        </div>`;
    }

    // --- 2. DİĞER İŞLEMLER (STANDART FORM) ---
    renderBaseForm(taskTypeName, taskTypeId, isLawsuitTask, allTransactionTypes) { 
        if (!this.container) return;

        const taskIdStr = asId(taskTypeId);
        const needsRelatedParty = RELATED_PARTY_REQUIRED.has(taskIdStr);
        const partyLabel = PARTY_LABEL_BY_ID[taskIdStr] || 'İlgili Taraf';

        let contentHtml = '';
        contentHtml += this._getAssetSearchHtml();

        if (isLawsuitTask) {
            contentHtml += this._getLawsuitClientHtml();
            contentHtml += this._getLawsuitDetailsHtml(taskTypeId, allTransactionTypes);
            contentHtml += this._getLawsuitOpponentHtml();
        } else if (needsRelatedParty) {
            contentHtml += this._getGenericRelatedPartyHtml(partyLabel);
        }

        contentHtml += this._getAccrualCardHtml();
        contentHtml += this._getJobDetailsHtml();
        
        // 🔥 ÇÖZÜM: Standart formların butonları kalıcı eklendi
        contentHtml += `
        <div id="formActionsContainer" class="premium-footer-actions mt-4">
            <button type="button" id="cancelBtn" class="btn btn-secondary btn-lg rounded-pill px-4"><i class="fas fa-times mr-2"></i>İptal</button>
            <button type="submit" id="saveTaskBtn" class="btn btn-success btn-lg rounded-pill px-5 shadow"><i class="fas fa-check-double mr-2"></i>İşi Oluştur ve Kaydet</button>
        </div>`;

        this.container.innerHTML = contentHtml;
    }

    renderOtherTaskForm(taskType) {
        if (!this.container) return;
        const typeId = String(taskType.id);
        let customFields = '';

        const ownerSearchHtml = `
            <div class="form-group mt-4 border-top pt-4">
                <label class="form-label text-primary font-weight-bold"><i class="fas fa-user-tag mr-2"></i>İşlem Yapılacak Sahip (Müvekkil)</label>
                <div class="d-flex" style="gap:15px; align-items:flex-start;">
                    <div class="search-input-wrapper" style="flex:1;">
                        <input type="text" id="ownerSearchInput" class="form-input" placeholder="Kişi veya Firma ara...">
                        <div id="ownerSearchResults" class="search-results-list" style="display:none;"></div>
                    </div>
                    <button type="button" id="addNewOwnerBtn" class="btn btn-add-person"><i class="fas fa-plus mr-1"></i> Yeni Kişi</button>
                </div>
                <div class="mt-3">
                    <label class="form-label" style="font-size: 0.85rem; color: #64748b;">Seçilen Sahipler</label>
                    <div id="selectedOwnerListContainer" class="selected-items-container">
                        <div class="empty-state text-center py-3 border rounded bg-light"><small class="text-muted m-0">Henüz sahip seçilmedi.</small></div>
                    </div>
                </div>
            </div>`;

        if (typeId === '79') {
            customFields = `<div class="form-grid"><div class="form-group full-width"><label class="form-label font-weight-bold">Yeni Unvan</label><input type="text" id="newTitleInput" class="form-input" placeholder="Yeni unvanı giriniz..."></div></div>${ownerSearchHtml}`;
        } else if (typeId === '80') {
            customFields = `<div class="form-grid"><div class="form-group"><label class="form-label font-weight-bold">Yeni Nevi (Tür)</label><input type="text" id="newTypeInput" class="form-input" placeholder="Örn: A.Ş., Ltd. Şti..."></div><div class="form-group"><label class="form-label font-weight-bold">Vergi Numarası</label><input type="text" id="taxNumberInput" class="form-input" placeholder="Vergi numarasını giriniz..." maxlength="11"></div></div>${ownerSearchHtml}`;
        } else if (typeId === '82') {
            customFields = `<div class="form-grid"><div class="form-group full-width"><label class="form-label font-weight-bold">Açık Adres</label><textarea id="newAddressText" class="form-textarea" rows="3" placeholder="Mahalle, Cadde, Sokak..."></textarea></div><div class="form-group"><label class="form-label font-weight-bold">Ülke</label><select id="newAddressCountry" class="form-select"><option value="">Seçiniz...</option></select></div><div class="form-group"><label class="form-label font-weight-bold">İl / Şehir</label><select id="newAddressCity" class="form-select" disabled><option value="">Önce Ülke Seçiniz...</option></select></div></div>${ownerSearchHtml}`;
        } else if (typeId === '81') {
            customFields = `<div class="form-grid"><div class="form-group"><label class="form-label font-weight-bold">Araştırılacak Marka/Kelime</label><input type="text" id="searchKeywordInput" class="form-input" placeholder="Araştırma yapılacak ibare..."></div><div class="form-group"><label class="form-label font-weight-bold">Sınıflar (Opsiyonel)</label><input type="text" id="searchClassesInput" class="form-input" placeholder="Örn: 05, 35 (Virgülle ayırın)"></div></div>`;
        }

        // 🔥 ÇÖZÜM: Diğer formların butonları kalıcı eklendi
        this.container.innerHTML = `
        <div class="premium-card mb-4">
            <div class="card-header-custom"><span><i class="fas fa-layer-group text-primary mr-2"></i>${taskType.name || 'İşlem Detayları'}</span></div>
            <div class="card-body-custom">
                <div id="assetSearchContainer">${this._getAssetSearchHtml(true)}</div>
                <div class="mt-4 p-4 bg-light border rounded shadow-sm">
                    <h6 class="text-primary font-weight-bold mb-4 border-bottom pb-2"><i class="fas fa-pen-nib mr-2"></i>Değişiklik / İşlem Bilgileri</h6>
                    ${customFields}
                </div>
                <div class="mt-4">${this._getAccrualCardHtml(true)}</div>
                <div class="mt-4">${this._getJobDetailsHtml(true)}</div>
            </div>
        </div>
        <div id="formActionsContainer" class="premium-footer-actions mt-4">
            <button type="button" id="cancelBtn" class="btn btn-secondary btn-lg rounded-pill px-4"><i class="fas fa-times mr-2"></i>İptal</button>
            <button type="submit" id="saveTaskBtn" class="btn btn-success btn-lg rounded-pill px-5 shadow"><i class="fas fa-check-double mr-2"></i>İşi Oluştur ve Kaydet</button>
        </div>`;
    }

    renderSelectedOwners(owners) {
        const container = document.getElementById('selectedOwnerListContainer');
        if (!container) return;
        if (!owners || owners.length === 0) {
            container.innerHTML = `<div class="empty-state text-center py-3 border rounded bg-light"><small class="text-muted m-0">Henüz sahip seçilmedi.</small></div>`;
            return;
        }
        container.innerHTML = owners.map(p => `
            <div class="selected-item mb-2">
                <div><i class="fas fa-user-tag mr-2 text-info"></i><span class="font-weight-bold">${p.name}</span></div>
                <button type="button" class="remove-selected-item-btn remove-owner-btn" data-id="${p.id}" title="Kaldır"><i class="fas fa-times"></i></button>
            </div>`).join('');
    }

    _getBrandInfoTabHtml() {
        return `
        <div class="tab-pane fade show active" id="brand-info" role="tabpanel">
            <div class="info-group mb-5">
                <h6 class="text-primary font-weight-bold mb-4 border-bottom pb-2"><i class="fas fa-info-circle mr-2"></i>Temel Özellikler</h6>
                <div class="form-grid">
                    <div class="form-group"><label class="form-label">Marka Tipi</label><select class="form-select" id="brandType"><option value="Sadece Kelime">Sadece Kelime</option><option value="Sadece Şekil">Sadece Şekil</option><option value="Şekil + Kelime" selected>Şekil + Kelime</option><option value="Ses">Ses</option><option value="Hareket">Hareket</option><option value="Renk">Renk</option><option value="Üç Boyutlu">Üç Boyutlu</option></select></div>
                    <div class="form-group"><label class="form-label">Marka Türü</label><select class="form-select" id="brandCategory"><option value="Ticaret/Hizmet Markası" selected>Ticaret/Hizmet Markası</option><option value="Garanti Markası">Garanti Markası</option><option value="Ortak Marka">Ortak Marka</option></select></div>
                    <div class="form-group"><label class="form-label">Marka Örneği Yazılı İfadesi</label><input type="text" class="form-input" id="brandExampleText" placeholder="Marka adını giriniz..."></div>
                    <div class="form-group"><label class="form-label">Latin Alfabesi Dışı Harf Var Mı?</label><input type="text" class="form-input" id="nonLatinAlphabet" placeholder="Yoksa boş bırakın"></div>
                </div>
            </div>

            <div class="info-group mb-5">
                <h6 class="text-primary font-weight-bold mb-4 border-bottom pb-2"><i class="fas fa-image mr-2"></i>Marka Görseli</h6>
                <div class="form-group full-width">
                    <div id="brand-example-drop-zone" class="brand-upload-frame">
                        <input type="file" id="brandExample" accept="image/*" style="display:none;">
                        <i class="fas fa-cloud-upload-alt fa-3x text-muted mb-3"></i>
                        <div class="font-weight-bold text-dark" style="font-size: 1.1em;">Marka örneğini buraya sürükleyin veya seçmek için tıklayın</div>
                        <div class="text-muted mt-2 small">İstenen format: 591x591px, 300 DPI, JPEG.</div>
                    </div>
                    <div id="brandExamplePreviewContainer" class="mt-4 text-center" style="display:none;">
                        <img id="brandExamplePreview" src="#" style="max-width:250px; max-height:250px; border:1px solid #e2e8f0; padding:5px; border-radius:12px; background: #fff; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                        <br><button id="removeBrandExampleBtn" type="button" class="btn btn-sm btn-danger mt-3 rounded-pill px-3"><i class="fas fa-trash mr-1"></i> Görseli Kaldır</button>
                    </div>
                </div>
            </div>

            <div class="info-group">
                <h6 class="text-primary font-weight-bold mb-4 border-bottom pb-2"><i class="fas fa-tasks mr-2"></i>Özel Talepler</h6>
                <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label">Önyazı Talebi</label>
                        <div class="d-flex" style="gap: 20px;">
                            <div class="custom-control custom-radio"><input class="custom-control-input" type="radio" name="coverLetterRequest" id="coverVar" value="var"><label class="custom-control-label" for="coverVar">Var</label></div>
                            <div class="custom-control custom-radio"><input class="custom-control-input" type="radio" name="coverLetterRequest" id="coverYok" value="yok" checked><label class="custom-control-label" for="coverYok">Yok</label></div>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Muvafakat Talebi</label>
                        <div class="d-flex" style="gap: 20px;">
                            <div class="custom-control custom-radio"><input class="custom-control-input" type="radio" name="consentRequest" id="consentVar" value="var"><label class="custom-control-label" for="consentVar">Var</label></div>
                            <div class="custom-control custom-radio"><input class="custom-control-input" type="radio" name="consentRequest" id="consentYok" value="yok" checked><label class="custom-control-label" for="consentYok">Yok</label></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    _getGoodsServicesTabHtml() {
        return `
        <div class="tab-pane fade" id="goods-services" role="tabpanel">
            <div class="nice-classification-container">
                <div class="row">
                    <div class="col-12">
                        <div class="classification-panel mb-3">
                            <div class="panel-header"><h5 class="mb-0"><i class="fas fa-list-ul mr-2"></i>Nice Classification</h5></div>
                            <div class="search-section">
                                <div class="input-group">
                                    <input type="text" class="form-control border-right-0" id="niceClassSearch" placeholder="Sınıf numarası veya açıklama ara...">
                                    <div class="input-group-append"><button class="btn btn-outline-secondary border-left-0" type="button" id="clearSearchBtn"><i class="fas fa-times"></i></button></div>
                                </div>
                            </div>
                            <div class="scrollable-list" id="niceClassificationList" style="max-height: 400px; overflow-y: auto; padding: 0;"></div>
                        </div>
                    </div>
                </div>
                <div class="row">
                    <div class="col-12">
                        <div class="selected-classes-panel">
                            <div class="panel-header d-flex justify-content-between align-items-center">
                                <div><h5 class="mb-0"><i class="fas fa-check-circle mr-2"></i>Seçilen Sınıflar</h5></div>
                                <button type="button" class="btn btn-outline-light btn-sm" id="clearAllClassesBtn" style="display: none;" title="Temizle"><i class="fas fa-trash"></i> Temizle</button>
                            </div>
                            <div class="scrollable-list bg-light" id="selectedNiceClasses" style="max-height: 400px; overflow-y: auto; padding: 15px;">
                                <div class="empty-state text-center py-4"><i class="fas fa-clipboard-list fa-2x text-muted mb-2"></i><p class="text-muted m-0">Henüz sınıf seçilmedi</p></div>
                            </div>
                        </div>
                        <div class="mt-4 p-4 bg-white border rounded shadow-sm">
                            <label class="form-label font-weight-bold text-primary"><i class="fas fa-edit mr-2"></i>Özel Tanım</label>
                            <textarea class="form-textarea mt-2" id="customClassInput" rows="3" placeholder="Özel mal/hizmet tanımı..." maxlength="50000"></textarea>
                            <div class="d-flex justify-content-between align-items-center mt-3">
                                <small class="text-muted"><span id="customClassCharCount">0</span> / 50,000 karakter</small>
                                <button type="button" class="btn btn-secondary btn-sm rounded-pill px-3" id="addCustomClassBtn"><i class="fas fa-plus mr-1"></i> Özel Tanım Ekle</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    _getApplicantsTabHtml() {
        return `
        <div class="tab-pane fade" id="applicants" role="tabpanel">
            <div class="info-group">
                <div class="d-flex justify-content-between align-items-center mb-4 border-bottom pb-2">
                    <h6 class="text-primary font-weight-bold m-0"><i class="fas fa-users mr-2"></i>Başvuru Sahipleri</h6>
                    <button type="button" id="addNewApplicantBtn" class="btn btn-add-person btn-sm"><i class="fas fa-plus mr-1"></i> Yeni Kişi Ekle</button>
                </div>
                <div class="form-group full-width">
                    <label class="form-label">Başvuru Sahibi Ara</label>
                    <div class="search-input-wrapper">
                        <input type="text" id="applicantSearchInput" class="form-input" placeholder="İsim veya e-mail ile ara...">
                        <div id="applicantSearchResults" class="search-results-list" style="display:none;"></div>
                    </div>
                </div>
                <div class="form-group full-width mt-4">
                    <label class="form-label">Seçilen Başvuru Sahipleri</label>
                    <div id="selectedApplicantsList" class="selected-items-container border rounded bg-light p-2">
                        <div class="empty-state text-center py-3"><p class="text-muted m-0 small">Henüz seçim yapılmadı.</p></div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    _getPriorityTabHtml() {
        return `
        <div class="tab-pane fade" id="priority" role="tabpanel">
            <div class="info-group">
                <div class="d-flex justify-content-between align-items-center mb-4 border-bottom pb-2">
                    <h6 class="text-primary font-weight-bold m-0"><i class="fas fa-star mr-2"></i>Rüçhan Bilgileri</h6>
                    <button type="button" id="addPriorityBtn" class="btn btn-secondary btn-sm"><i class="fas fa-plus mr-1"></i> Rüçhan Ekle</button>
                </div>
                <div class="form-grid">
                    <div class="form-group"><label class="form-label">Rüçhan Tipi</label><select class="form-select" id="priorityType"><option value="başvuru">Başvuru</option><option value="sergi">Sergi</option></select></div>
                    <div class="form-group"><label class="form-label" id="priorityDateLabel">Rüçhan Tarihi</label><input type="text" class="form-input" id="priorityDate" placeholder="gg.aa.yyyy" data-datepicker autocomplete="off"></div>
                    <div class="form-group"><label class="form-label">Rüçhan Ülkesi</label><select class="form-select" id="priorityCountry"><option value="">Seçiniz...</option></select></div>
                    <div class="form-group"><label class="form-label">Rüçhan Numarası</label><input type="text" class="form-input" id="priorityNumber" placeholder="Örn: 2023/12345"></div>
                </div>
                <div class="form-group full-width mt-4">
                    <label class="form-label">Eklenen Rüçhanlar</label>
                    <div id="addedPrioritiesList" class="selected-items-container border rounded bg-light p-2">
                        <div class="empty-state text-center py-3"><p class="text-muted m-0 small">Henüz rüçhan bilgisi eklenmedi.</p></div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    _getAccrualTabHtml() {
        return `<div class="tab-pane fade" id="accrual" role="tabpanel">${this._getAccrualCardHtml(true)}${this._getJobDetailsHtml(true)}</div>`;
    }

    _getAssetSearchHtml(isInner = false) {
        const wrapClass = isInner ? '' : 'premium-card mb-4';
        const content = `
            ${!isInner ? `<div class="card-header-custom" id="card-asset"><span><i class="fas fa-cube text-info mr-2"></i> 2. İşleme Konu Varlık</span></div>` : ''}
            <div class="${isInner ? '' : 'card-body-custom'}">
                <div class="form-group full-width">
                    <label class="form-label">Portföyden Ara</label>
                    <div class="search-input-wrapper">
                        <input type="text" id="ipRecordSearch" class="form-input" placeholder="Marka adı, başvuru no...">
                        <div id="ipRecordSearchResults" class="search-results-list" style="display:none;"></div>
                    </div>
                    <div id="selectedIpRecordContainer" class="mt-3" style="display:none;">
                        <div class="d-flex justify-content-between align-items-center p-3 border rounded bg-white shadow-sm" style="border-color: #bde0fe !important; background-color: #eff6ff !important;">
                            <div class="d-flex align-items-center">
                                <div class="mr-3">
                                    <img id="selectedIpRecordImage" src="" style="width: 50px; height: 50px; object-fit: contain; border: 1px solid #ccc; border-radius: 8px; display:none; background-color: #fff;">
                                    <div id="selectedIpRecordPlaceholder" style="width: 50px; height: 50px; background-color: #fff; border: 1px dashed #ccc; border-radius: 8px; display:flex; align-items:center; justify-content:center; color:#adb5bd;"><i class="fas fa-image" style="font-size: 20px;"></i></div>
                                </div>
                                <div><h5 class="mb-1 font-weight-bold" id="selectedIpRecordLabel" style="font-size: 1.05rem; color: #1e3a8a;"></h5><div class="text-muted small">Başvuru No: <strong id="selectedIpRecordNumber" style="color: #334155;"></strong></div></div>
                            </div>
                            <button type="button" class="remove-selected-item-btn" id="clearSelectedIpRecord" title="Kaldır"><i class="fas fa-times"></i></button>
                        </div>
                    </div>
                </div>
                <div id="wipoAripoParentContainer" class="form-group full-width mt-4" style="display:none;">
                    <label class="form-label">Eklenen Ülkeler <span class="badge badge-primary ml-1" id="wipoAripoChildCount">0</span></label>
                    <div id="wipoAripoChildList" class="selected-items-container border rounded bg-light p-2"></div>
                </div>
            </div>`;
        return isInner ? content : `<div class="${wrapClass}">${content}</div>`;
    }

    _getLawsuitClientHtml() {
        return `
        <div class="premium-card mb-4" id="clientSection">
            <div class="card-header-custom"><span><i class="fas fa-user-shield text-success mr-2"></i> 3. Müvekkil Bilgileri</span></div>
            <div class="card-body-custom">
                <div class="form-grid"><div class="form-group"><label class="form-label">Rol</label><select id="clientRole" class="form-select"><option value="davaci">Davacı</option><option value="davali">Davalı</option></select></div></div>
                <div class="form-group full-width mt-4">
                    <label class="form-label">Müvekkil Ara</label>
                    <div class="d-flex" style="gap:15px; align-items:flex-start;">
                        <div class="search-input-wrapper" style="flex:1;">
                            <input type="text" id="personSearchInput" class="form-input" placeholder="Müvekkil adı, e-posta...">
                            <div id="personSearchResults" class="search-results-list" style="display:none;"></div>
                        </div>
                        <button type="button" id="addNewPersonBtn" class="btn btn-add-person"><i class="fas fa-plus mr-1"></i> Yeni Kişi</button>
                    </div>
                </div>
                <div class="form-group full-width mt-3">
                    <label class="form-label">Seçilen Müvekkil</label>
                    <div id="relatedPartyList" class="selected-items-container">
                        <div class="empty-state text-center py-3 border rounded bg-light"><small class="text-muted m-0">Seçim yapılmadı.</small></div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    _getLawsuitDetailsHtml(taskTypeId, allTransactionTypes) {
        const isYargitayTask = String(taskTypeId) === '60';
        const courtOptions = COURTS_LIST.map(group => `
            <optgroup label="${group.label}">
                ${group.options.map(opt => `<option value="${opt.value}" ${opt.value === 'Yargıtay' && isYargitayTask ? 'selected' : ''}>${opt.text}</option>`).join('')}
            </optgroup>
        `).join('');

        return `
        <div class="premium-card mb-4" style="border-left: 5px solid #dc3545;">
            <div class="card-header-custom" style="color: #dc3545;"><span><i class="fas fa-gavel mr-2"></i> 4. Dava Bilgileri</span></div>
            <div class="card-body-custom">
                <div class="form-grid">
                    <div class="form-group full-width">
                        <label class="form-label">Mahkeme</label>
                        <select id="courtName" class="form-select"><option value="">Seçiniz...</option>${courtOptions}</select>
                        <input type="text" id="customCourtInput" class="form-input mt-2" placeholder="Mahkeme adını tam olarak yazınız..." style="display:none; border-color: #3b82f6;">
                    </div>
                    <div class="form-group"><label class="form-label">Dava Tarihi (Açılış)</label><input type="text" id="suitOpeningDate" class="form-input" placeholder="gg.aa.yyyy" data-datepicker></div>
                    <div class="form-group"><label class="form-label">Esas No</label><input type="text" id="suitCaseNo" class="form-input" placeholder="Henüz yoksa boş bırakın"></div>
                    <div class="form-group full-width mt-3">
                        <label class="form-label" style="font-weight:600;"><i class="fas fa-paperclip mr-2 text-secondary"></i>Dava Evrakları (PDF)</label>
                        <div class="custom-file">
                            <input type="file" class="custom-file-input" id="suitDocument" multiple accept=".pdf">
                            <label class="custom-file-label" for="suitDocument" style="border-radius: 10px; border-color: #cbd5e1; padding: 10px; height: auto;">Dosya Seçiniz...</label>
                        </div>
                        <small class="text-muted mt-2 d-block">Dava dilekçesi vb. evrakları buradan yükleyebilirsiniz.</small>
                        <div id="suitDocumentList" class="mt-3"></div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    _getLawsuitOpponentHtml() {
        return `
        <div class="premium-card mb-4">
            <div class="card-header-custom"><span><i class="fas fa-fist-raised text-warning mr-2"></i> 5. Karşı Taraf</span></div>
            <div class="card-body-custom">
                <div class="form-grid">
                    <div class="form-group"><label class="form-label">Karşı Taraf</label><input type="text" id="opposingParty" class="form-input" placeholder="Firma/Kişi Adı"></div>
                    <div class="form-group"><label class="form-label">Vekili</label><input type="text" id="opposingCounsel" class="form-input" placeholder="Vekil Adı"></div>
                </div>
            </div>
        </div>`;
    }

    _getGenericRelatedPartyHtml(label) {
        return `
        <div class="premium-card mb-4" id="relatedPartySection">
            <div class="card-header-custom"><span><i class="fas fa-user-friends text-success mr-2"></i> 3. ${label}</span></div>
            <div class="card-body-custom">
                <div class="form-group full-width">
                    <label class="form-label">Kişi Ara</label>
                    <div class="d-flex" style="gap:15px; align-items:flex-start;">
                        <div class="search-input-wrapper" style="flex:1;">
                            <input type="text" id="personSearchInput" class="form-input" placeholder="İsim, e-posta...">
                            <div id="personSearchResults" class="search-results-list" style="display:none;"></div>
                        </div>
                        <button type="button" id="addNewPersonBtn" class="btn btn-add-person"><i class="fas fa-plus mr-1"></i> Yeni Kişi</button>
                    </div>
                </div>
                <div class="form-group full-width mt-4">
                    <label class="form-label">Seçilenler <span id="relatedPartyCount" class="badge badge-primary ml-1">0</span></label>
                    <div id="relatedPartyList" class="selected-items-container">
                        <div class="empty-state text-center py-3 border rounded bg-light"><small class="text-muted m-0">Seçim yapılmadı.</small></div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    _getAccrualCardHtml(isInner = false) {
        const wrapClass = isInner ? '' : 'premium-card mb-4';
        const content = `
            ${!isInner ? `<div class="card-header-custom"><span><i class="fas fa-file-invoice-dollar text-success mr-2"></i> Tahakkuk / Finansal Bilgiler</span></div>` : ''}
            <div class="${isInner ? '' : 'card-body-custom'}">
                ${isInner ? `<h6 class="text-primary font-weight-bold mb-4 border-bottom pb-2"><i class="fas fa-file-invoice-dollar mr-2"></i>Tahakkuk / Finansal Bilgiler</h6>` : ''}
                
                <div class="accrual-controls mb-4 p-4 bg-light border rounded shadow-sm">
                    <div class="d-flex align-items-center justify-content-between flex-wrap gap-3">
                        <div class="custom-control custom-checkbox mr-3" style="transform: scale(1.1); margin-left: 10px;">
                            <input class="custom-control-input" type="checkbox" id="isFreeTransaction">
                            <label class="custom-control-label font-weight-bold text-dark user-select-none" for="isFreeTransaction" style="cursor:pointer; padding-top: 2px;">
                                Ücretsiz İşlem (Tahakkuk Oluşmayacak)
                            </label>
                        </div>
                        <button type="button" id="toggleAccrualFormBtn" class="btn btn-outline-primary btn-sm rounded-pill px-4">
                            <i class="fas fa-chevron-down mr-2"></i> Tahakkuk Formu Aç
                        </button>
                    </div>
                    <div class="text-muted mt-3 small"><i class="fas fa-info-circle text-info mr-1"></i> Not: Formu açmazsanız veya "Ücretsiz" seçmezseniz, otomatik olarak "Tahakkuk Oluşturma" görevi atanacaktır.</div>
                </div>

                <div id="accrualToggleWrapper" style="display:none; border: 1px solid #e2e8f0; border-radius: 12px; padding: 25px; margin-top: 20px; background: #fff;">
                    <div id="createTaskAccrualContainer"></div>
                </div>
            </div>`;
        return isInner ? content : `<div class="${wrapClass}">${content}</div>`;
    }

    _getJobDetailsHtml(isInner = false) {
        const wrapClass = isInner ? 'mt-4' : 'premium-card mb-4';
        const content = `
            ${!isInner ? `<div class="card-header-custom"><span><i class="fas fa-tasks text-warning mr-2"></i> İş Detayları</span></div>` : ''}
            <div class="${isInner ? '' : 'card-body-custom'}">
                ${isInner ? `<h6 class="text-primary font-weight-bold mb-4 border-bottom pb-2"><i class="fas fa-tasks mr-2"></i>İş Detayları</h6>` : ''}
                <div class="form-grid">
                    <div class="form-group"><label class="form-label">Öncelik</label><select id="taskPriority" class="form-select"><option value="medium">Orta</option><option value="high">Yüksek</option><option value="urgent">Acil</option></select></div>
                    <div class="form-group"><label class="form-label">Atanacak Uzman</label><select id="assignedTo" class="form-select"><option value="">Seçiniz...</option></select></div>
                    <div class="form-group full-width"><label class="form-label">İç Son Tarih (Hedef)</label><input type="text" id="taskDueDate" class="form-input datepicker" placeholder="gg.aa.yyyy" autocomplete="off"></div> 
                </div>
            </div>`;
        return isInner ? content : `<div class="${wrapClass}">${content}</div>`;
    }

    updateButtonsAndTabs(isLastTab) {
        const container = document.getElementById('formActionsContainer');
        if (container) {
            container.innerHTML = !isLastTab ?
                `<button type="button" id="cancelBtn" class="btn btn-secondary btn-lg rounded-pill px-4"><i class="fas fa-times mr-2"></i>İptal</button>
                 <button type="button" id="nextTabBtn" class="btn btn-primary btn-lg rounded-pill px-5 shadow"><i class="fas fa-arrow-right mr-2"></i>İlerle</button>` :
                `<button type="button" id="cancelBtn" class="btn btn-secondary btn-lg rounded-pill px-4"><i class="fas fa-times mr-2"></i>İptal</button>
                 <button type="submit" id="saveTaskBtn" class="btn btn-success btn-lg rounded-pill px-5 shadow" disabled><i class="fas fa-check-double mr-2"></i>İşi Oluştur ve Kaydet</button>`;
        }
    }

    populateDropdown(elementId, items, valueKey, textKey, defaultText = 'Seçiniz...') {
        const el = document.getElementById(elementId);
        if (!el) return;
        el.innerHTML = `<option value="">${defaultText}</option>`;
        items.forEach(item => {
            const option = document.createElement('option');
            option.value = item[valueKey];
            option.textContent = item[textKey];
            el.appendChild(option);
        });
        el.disabled = false;
    }

    updateAssetSearchLabel(sourceType) {
        const label = document.querySelector('#card-asset span');
        const input = document.getElementById('ipRecordSearch');
        const searchLabel = document.querySelector('#card-asset')?.nextElementSibling?.querySelector('label.form-label') || document.querySelector('#assetSearchContainer label.form-label');

        if (sourceType === 'suits') {
            if (label) label.innerHTML = '<i class="fas fa-gavel text-danger mr-2"></i> 2. İşleme Konu Dava';
            if (searchLabel) searchLabel.textContent = 'Dava Dosyası Ara';
            if (input) input.placeholder = 'Dosya no, mahkeme adı...';
        } else {
            if (label) label.innerHTML = '<i class="fas fa-cube text-info mr-2"></i> 2. İşleme Konu Varlık';
            if (searchLabel) searchLabel.textContent = 'Portföyden Ara';
            if (input) input.placeholder = 'Marka adı, başvuru no...';
        }
    }

    renderAssetSearchResults(items, onSelect, sourceType = 'ipRecords') {
        const container = document.getElementById('ipRecordSearchResults'); 
        if (!container) return;

        if (!items || items.length === 0) {
            container.innerHTML = '<div class="p-3 text-muted text-center">Sonuç bulunamadı.</div>';
            container.style.display = 'block';
            return;
        }

        container.innerHTML = items.map(item => {
            let badge = '', title = '', subTitle = '', extraInfo = '';
            if (sourceType === 'suits' || item._source === 'suit') {
                badge = '<span class="badge badge-danger float-right">Dava</span>';
                title = item.displayCourt || 'Mahkeme Bilgisi Yok';
                subTitle = `Dosya: <strong class="text-dark">${item.displayFileNumber}</strong>`;
                if (item.displayClient) extraInfo += `<div class="text-muted small mt-1"><i class="fas fa-user-tie mr-1"></i>Müvekkil: ${item.displayClient}</div>`;
                if (item.opposingParty && item.opposingParty !== '-') extraInfo += `<div class="text-muted small"><i class="fas fa-user-shield mr-1"></i>Karşı: ${item.opposingParty}</div>`;
            } else {
                const isThirdParty = String(item.recordOwnerType || '').toLowerCase() === 'third_party';
                badge = (item._source === 'bulletin' || isThirdParty) ? '<span class="badge badge-warning float-right">Bülten</span>' : '<span class="badge badge-info float-right">Portföy</span>';
                title = item.title || item.markName || '-';
                subTitle = item.applicationNumber || item.applicationNo || '-';
            }

            return `
            <div class="search-result-item" data-id="${item.id}" data-source="${item._source}">
                ${badge}
                <div class="font-weight-bold text-primary" style="font-size: 1.05rem;">${title}</div>
                <div class="mt-1 text-dark">${subTitle}</div>
                ${extraInfo}
            </div>`;
        }).join('');
        
        container.style.display = 'block';
        container.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => {
                const record = items.find(i => i.id === el.dataset.id);
                onSelect(record, el.dataset.source);
                container.style.display = 'none';
            });
        });
    }

    renderSelectedRelatedParties(parties) {
        const list = document.getElementById('relatedPartyList');
        const countEl = document.getElementById('relatedPartyCount');
        if (!list) return;
        if (!parties || parties.length === 0) {
            list.innerHTML = `<div class="empty-state text-center py-3 border rounded bg-light"><small class="text-muted m-0">Seçim yapılmadı.</small></div>`;
        } else {
            list.innerHTML = parties.map(p => `
                <div class="selected-item mb-2">
                    <span class="font-weight-bold text-primary"><i class="fas fa-user-tie mr-2"></i>${p.name}</span>
                    <button type="button" class="remove-selected-item-btn remove-party" data-id="${p.id}"><i class="fas fa-times"></i></button>
                </div>`).join('');
        }
        if (countEl) countEl.textContent = parties ? parties.length : 0;
    }
    
    renderSelectedApplicants(applicants) {
        const container = document.getElementById('selectedApplicantsList');
        if (!container) return;
        if (!applicants || applicants.length === 0) {
            container.innerHTML = `<div class="empty-state text-center py-3"><p class="text-muted m-0 small">Seçim yok.</p></div>`;
            return;
        }
        container.innerHTML = applicants.map(p => `
            <div class="selected-item mb-2">
                <span class="font-weight-bold text-primary"><i class="fas fa-user mr-2"></i>${p.name}</span>
                <button type="button" class="remove-selected-item-btn" data-id="${p.id}"><i class="fas fa-times"></i></button>
            </div>`).join('');
    }

    renderPriorities(priorities) {
        const container = document.getElementById('addedPrioritiesList');
        if (!container) return;
        if (!priorities || priorities.length === 0) {
            container.innerHTML = `<div class="empty-state text-center py-3"><p class="text-muted m-0 small">Yok.</p></div>`;
            return;
        }
        container.innerHTML = priorities.map(p => `
            <div class="selected-item mb-2">
                <span class="font-weight-bold text-dark"><i class="fas fa-star text-warning mr-2"></i>${p.type} - ${p.country} - ${p.number}</span>
                <button type="button" class="remove-selected-item-btn remove-priority-btn" data-id="${p.id}"><i class="fas fa-times"></i></button>
            </div>`).join('');
    }

    renderWipoAripoChildRecords(children) {
        const container = document.getElementById('wipoAripoChildList');
        const badge = document.getElementById('wipoAripoChildCount');
        const parent = document.getElementById('wipoAripoParentContainer');
        if (!container) return;
        
        if (!children || children.length === 0) {
            if(parent) parent.style.display = 'none';
            container.innerHTML = '';
            if(badge) badge.textContent = '0';
            return;
        }
        if(parent) parent.style.display = 'block';
        if(badge) badge.textContent = children.length;
        
        container.innerHTML = children.map(c => `
            <div class="selected-item mb-2">
                <span class="font-weight-bold text-dark"><i class="fas fa-globe-europe text-info mr-2"></i>${c.country} - ${c.applicationNumber||'-'}</span>
                <button type="button" class="remove-selected-item-btn remove-wipo-child-btn" data-id="${c.id}"><i class="fas fa-times"></i></button>
            </div>`).join('');
    }

    renderUploadedFiles(files) {
        const container = document.getElementById('suitDocumentList');
        const label = document.querySelector('.custom-file-label[for="suitDocument"]');
        if (label) label.textContent = files.length > 0 ? `${files.length} dosya seçildi` : 'Dosya Seçiniz...';
        if (!container) return;
        if (!files || files.length === 0) { container.innerHTML = ''; return; }

        container.innerHTML = files.map((file, index) => `
            <div class="selected-item mb-2" style="background-color: #fff; border-color: #e2e8f0;">
                <div class="d-flex align-items-center overflow-hidden">
                    <i class="fas fa-file-pdf text-danger mr-3" style="font-size: 1.5rem;"></i>
                    <div style="overflow: hidden;">
                        <div class="text-truncate font-weight-bold text-dark" title="${file.name}">${file.name}</div>
                        <small class="text-muted">${(file.size / 1024 / 1024).toFixed(2)} MB</small>
                    </div>
                </div>
                <button type="button" class="remove-selected-item-btn remove-file-btn" data-index="${index}" title="Listeden Kaldır"><i class="fas fa-times"></i></button>
            </div>
        `).join('');
    }

    fillAndLockLawsuitFields(suit) {
        const details = suit.suitDetails || {};
        const clientName = suit.client?.name || suit.clientName || ''; 
        const courtSelect = document.getElementById('courtName');
        const customInput = document.getElementById('customCourtInput');
        const courtVal = details.court || suit.court || '';

        if (courtSelect) {
            let optionFound = false;
            for (let i = 0; i < courtSelect.options.length; i++) {
                if (courtSelect.options[i].value === courtVal) { courtSelect.selectedIndex = i; optionFound = true; break; }
            }
            if (!optionFound && courtVal) {
                courtSelect.value = 'other';
                if (customInput) { customInput.style.display = 'block'; customInput.value = courtVal; customInput.disabled = true; }
            } else if (customInput) { customInput.style.display = 'none'; customInput.value = ''; }
            courtSelect.disabled = true; 
        }

        const fields = { 'subjectOfLawsuit': details.description || '', 'opposingParty': details.opposingParty || suit.opposingParty || '', 'opposingCounsel': details.opposingCounsel || '', 'clientRole': suit.clientRole || '' };
        for (const [id, val] of Object.entries(fields)) {
            const el = document.getElementById(id);
            if (el) { el.value = val; el.disabled = true; }
        }

        const searchInput = document.getElementById('personSearchInput');
        const addBtn = document.getElementById('addNewPersonBtn');
        const listDiv = document.getElementById('relatedPartyList');

        if (searchInput) { searchInput.value = ''; searchInput.disabled = true; searchInput.placeholder = 'Dava dosyasından otomatik çekildi...'; }
        if (addBtn) addBtn.disabled = true;

        if (listDiv && clientName) {
            listDiv.innerHTML = `
                <div class="selected-item mb-2" style="background-color: #f8fafc; border-color: #cbd5e1;">
                    <div><i class="fas fa-user-lock mr-2 text-secondary"></i><strong class="text-dark">${clientName}</strong></div>
                    <span class="badge badge-secondary ml-2">Dava Müvekkili</span>
                </div>`;
        }
    }

    unlockAndClearLawsuitFields() {
        const courtSelect = document.getElementById('courtName');
        const customInput = document.getElementById('customCourtInput');
        if (courtSelect) { courtSelect.disabled = false; courtSelect.value = ''; }
        if (customInput) { customInput.value = ''; customInput.disabled = false; customInput.style.display = 'none'; }

        ['subjectOfLawsuit', 'opposingParty', 'opposingCounsel', 'clientRole'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.value = ''; el.disabled = false; }
        });

        const searchInput = document.getElementById('personSearchInput');
        const addBtn = document.getElementById('addNewPersonBtn');
        const listDiv = document.getElementById('relatedPartyList');

        if (searchInput) { searchInput.disabled = false; searchInput.placeholder = 'İsim, e-posta...'; }
        if (addBtn) addBtn.disabled = false;
        if (listDiv) listDiv.innerHTML = ''; 
    }

    renderSummaryTab(state) {
        const container = document.getElementById('summaryContent');
        if (!container) return;
        
        const brandName = document.getElementById('brandExampleText')?.value || '-';
        const brandType = document.getElementById('brandType')?.value || '-';
        const brandCategory = document.getElementById('brandCategory')?.value || '-';
        const nonLatin = document.getElementById('nonLatinAlphabet')?.value || '-';
        
        const assignedToId = document.getElementById('assignedTo')?.value;
        const assignedUser = state.allUsers.find(u => u.id === assignedToId);
        const taskType = state.selectedTaskType?.alias || state.selectedTaskType?.name || '-';
        
        let origin = document.getElementById('originSelect')?.value || '-';
        if (origin === 'Yurtdışı Ulusal') {
            const countrySelect = document.getElementById('countrySelect');
            origin += ` (${countrySelect.options[countrySelect.selectedIndex]?.text})`;
        }

        const classes = typeof getSelectedNiceClasses === 'function' ? getSelectedNiceClasses() : [];
        const classHtml = classes.length > 0 ? `<div style="max-height: 150px; overflow-y: auto;">${classes.map(c => `<div class="border-bottom py-1">${c}</div>`).join('')}</div>` : '<span class="text-danger">Seçim Yok</span>';
        const applicants = state.selectedApplicants && state.selectedApplicants.length > 0 ? state.selectedApplicants.map(a => a.name).join(', ') : '<span class="text-danger">Seçilmedi</span>';

        let priorityHtml = 'Yok';
        if (state.priorities && state.priorities.length > 0) {
            priorityHtml = '<ul class="pl-3 mb-0">' + state.priorities.map(p => `<li><strong>${p.type}:</strong> ${p.country} - ${p.number} (${p.date})</li>`).join('') + '</ul>';
        }

        let imageSection = '';
        if (state.uploadedFiles && state.uploadedFiles.length > 0) {
            const file = state.uploadedFiles[0];
            const imgUrl = URL.createObjectURL(file);
            imageSection = `
                <div class="card shadow-sm border-0" style="border-radius: 12px; overflow: hidden;">
                    <div class="card-header bg-light text-center border-0"><h6 class="mb-0 text-dark font-weight-bold">Marka Örneği</h6></div>
                    <div class="card-body text-center p-3">
                        <div style="background-color: #f8f9fa; border: 1px dashed #ccc; display: inline-block; padding: 5px; border-radius: 8px;">
                            <img src="${imgUrl}" alt="Marka" class="img-fluid" style="max-height: 200px; object-fit: contain;">
                        </div>
                    </div>
                </div>`;
        } else {
            imageSection = `<div class="alert alert-warning text-center rounded" style="border-radius: 12px;"><i class="fas fa-image fa-2x mb-2"></i><br>Marka görseli yüklenmedi.</div>`;
        }

        container.innerHTML = `
            <div class="row">
                <div class="col-lg-8">
                    <div class="card shadow-sm mb-3 border-0" style="border-radius: 12px; overflow: hidden;">
                        <div class="card-header bg-white border-bottom p-3">
                            <h6 class="mb-0 text-primary font-weight-bold"><i class="fas fa-info-circle mr-2"></i>Başvuru Özeti</h6>
                        </div>
                        <div class="card-body p-0">
                            <table class="table table-striped table-hover mb-0 border-0">
                                <tbody>
                                    <tr><th style="width: 30%;" class="pl-4">Marka Adı</th><td class="text-primary font-weight-bold" style="font-size: 1.1em;">${brandName}</td></tr>
                                    <tr><th class="pl-4">İşlem Tipi</th><td>${taskType}</td></tr>
                                    <tr><th class="pl-4">Marka Tipi / Türü</th><td>${brandType} / ${brandCategory}</td></tr>
                                    ${nonLatin !== '-' ? `<tr><th class="pl-4">Latin Dışı Karakter</th><td>${nonLatin}</td></tr>` : ''}
                                    <tr><th class="pl-4">Menşe</th><td>${origin}</td></tr>
                                    <tr><th class="pl-4">Atanan Uzman</th><td>${assignedUser?.displayName || assignedUser?.email || '<span class="text-danger">Seçilmedi</span>'}</td></tr>
                                    <tr><th class="pl-4">Başvuru Sahipleri</th><td>${applicants}</td></tr>
                                    <tr><th class="pl-4">Nice Sınıfları (${classes.length})</th><td>${classHtml}</td></tr>
                                    <tr><th class="pl-4">Rüçhan Bilgileri</th><td>${priorityHtml}</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                <div class="col-lg-4">
                    ${imageSection}
                    <div class="mt-3 p-3 bg-light rounded border text-muted small"><i class="fas fa-check-double mr-1"></i>Lütfen yukarıdaki bilgileri kontrol ediniz. "İş Oluştur ve Kaydet" butonuna bastığınızda işlem başlatılacaktır.</div>
                </div>
            </div>`;
    }

    showParentSelectionModal(transactions, title) {
        const modal = document.getElementById('selectParentModal');
        const list = document.getElementById('parentListContainer');
        const modalTitle = document.getElementById('selectParentModalLabel');
        if (!modal || !list) return;

        if (modal.parentElement !== document.body) document.body.appendChild(modal);
        modal.style.zIndex = '1055'; 

        if(modalTitle) modalTitle.textContent = title || 'İşlem Seçimi';
        list.innerHTML = '';
        
        transactions.forEach(tx => {
            const li = document.createElement('li');
            li.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center p-3 mb-2 rounded border';
            li.style.cursor = 'pointer';
            
            let dateDisplay = '-';
            const rawDate = tx.creationDate || tx.timestamp; 
            if (rawDate) {
                try {
                    if (rawDate.toDate && typeof rawDate.toDate === 'function') dateDisplay = rawDate.toDate().toLocaleDateString('tr-TR');
                    else {
                        const d = new Date(rawDate);
                        if (!isNaN(d)) dateDisplay = d.toLocaleDateString('tr-TR');
                    }
                } catch (e) { }
            }
            
            li.innerHTML = `
                <div>
                    <h6 class="mb-0 font-weight-bold text-primary" style="font-size: 1.05rem;">${tx.transactionTypeName || tx.type || 'İşlem'}</h6>
                    <small class="text-muted" style="font-size: 0.8rem;">Ref: ${tx.id.substring(0,6)}...</small>
                </div>
                <div class="text-right">
                    <span class="badge badge-light border p-2 px-3 text-dark" style="font-size: 0.9rem; border-radius: 8px;"><i class="far fa-calendar-alt text-primary mr-1"></i> ${dateDisplay}</span>
                    <i class="fas fa-chevron-right text-muted ml-3"></i>
                </div>`;
            
            li.onclick = () => document.dispatchEvent(new CustomEvent('parentTransactionSelected', { detail: { id: tx.id } }));
            list.appendChild(li);
        });
        
        if (window.$) {
            $(modal).modal({ backdrop: 'static', keyboard: false });
            $(modal).modal('show');
            setTimeout(() => { document.querySelectorAll('.modal-backdrop').forEach(bd => { bd.style.zIndex = '1050'; document.body.appendChild(bd); }); }, 100);
        } else {
            modal.style.display = 'block'; modal.classList.add('show'); document.body.classList.add('modal-open');
        }
    }

    hideParentSelectionModal() {
        const modal = document.getElementById('selectParentModal');
        if (window.$) $(modal).modal('hide');
        else {
            if (modal) { modal.style.display = 'none'; modal.classList.remove('show'); }
            document.body.classList.remove('modal-open');
            const backdrop = document.getElementById('custom-backdrop');
            if (backdrop) backdrop.remove();
        }
    }
}