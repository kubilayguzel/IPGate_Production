// js/templates/form-templates.js
import {COURTS_LIST } from '../../utils.js';

export const FormTemplates = {
    getTrademarkForm: () => `
        <div class="form-section" style="padding: 0 !important; background: transparent; border: none; box-shadow: none;">
            <ul class="nav nav-tabs" id="portfolioTabs" role="tablist">
                <li class="nav-item">
                    <a class="nav-link active" id="brand-info-tab" data-toggle="tab" href="#brand-info" role="tab"><i class="fas fa-tag mr-1"></i>Marka Bilgileri</a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" id="applicants-tab" data-toggle="tab" href="#applicants" role="tab"><i class="fas fa-users mr-1"></i>Başvuru Sahipleri</a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" id="priority-tab" data-toggle="tab" href="#priority" role="tab"><i class="fas fa-star mr-1"></i>Rüçhan</a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" id="goods-services-tab" data-toggle="tab" href="#goods-services" role="tab"><i class="fas fa-list-ul mr-1"></i>Mal ve Hizmetler</a>
                </li>
            </ul>
            
            <div class="tab-content tab-content-card shadow-sm" id="portfolioTabContent">
                
                <div class="tab-pane fade show active" id="brand-info" role="tabpanel">
                    
                    <div class="info-group mb-5">
                        <h6 class="text-primary font-weight-bold mb-4 border-bottom pb-2">
                            <i class="fas fa-info-circle mr-2"></i>Temel Özellikler
                        </h6>
                        <div class="form-grid">
                            <div class="form-group">
                                <label for="brandExampleText" class="form-label">Marka Metni</label>
                                <input type="text" id="brandExampleText" class="form-input" placeholder="Marka adını girin">
                            </div>
                            <div class="form-group">
                                <label for="brandType" class="form-label">Marka Tipi</label>
                                <select id="brandType" class="form-select">
                                    <option value="Şekil + Kelime" selected>Şekil + Kelime</option>
                                    <option value="Kelime">Kelime</option>
                                    <option value="Şekil">Şekil</option>
                                    <option value="Üç Boyutlu">Üç Boyutlu</option>
                                    <option value="Renk">Renk</option>
                                    <option value="Ses">Ses</option>
                                    <option value="Hareket">Hareket</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label for="brandCategory" class="form-label">Marka Türü</label>
                                <select id="brandCategory" class="form-select">
                                    <option value="Ticaret/Hizmet Markası" selected>Ticaret/Hizmet Markası</option>
                                    <option value="Garanti Markası">Garanti Markası</option>
                                    <option value="Ortak Marka">Ortak Marka</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label for="trademarkStatus" class="form-label">Durum</label>
                                <select id="trademarkStatus" class="form-select"></select>
                            </div>
                        </div>
                    </div>

                    <div class="info-group mb-5">
                        <h6 class="text-primary font-weight-bold mb-4 border-bottom pb-2">
                            <i class="fas fa-calendar-alt mr-2"></i>Resmi Numaralar ve Tarihler
                        </h6>
                        <div class="form-grid">
                            <div id="applicationNumberWrapper" class="form-group">
                                <label id="applicationNumberLabel" for="applicationNumber" class="form-label">Başvuru Numarası</label>
                                <input type="text" id="applicationNumber" class="form-input" placeholder="Başvuru numarasını girin">
                            </div>
                            <div class="form-group">
                                <label for="applicationDate" class="form-label">Başvuru Tarihi</label>
                                <input type="text" id="applicationDate" class="form-input" placeholder="gg.aa.yyyy" data-datepicker>
                            </div>
                            <div id="registrationNumberWrapper" class="form-group">
                                <label id="registrationNumberLabel" for="registrationNumber" class="form-label">Tescil Numarası</label>
                                <input type="text" id="registrationNumber" class="form-input" placeholder="Tescil numarasını girin">
                            </div>
                            <div class="form-group">
                                <label for="registrationDate" class="form-label">Tescil Tarihi</label>
                                <input type="text" id="registrationDate" class="form-input" placeholder="gg.aa.yyyy" data-datepicker>
                            </div>
                            <div class="form-group">
                                <label for="renewalDate" class="form-label">Yenileme Tarihi</label>
                                <input type="text" id="renewalDate" class="form-input" placeholder="gg.aa.yyyy" data-datepicker>
                            </div>
                            <div class="form-group">
                                <label for="bulletinNo" class="form-label">Bülten No</label>
                                <input id="bulletinNo" type="text" class="form-input" placeholder="Örn. 1">
                            </div>
                            <div class="form-group">
                                <label for="bulletinDate" class="form-label">Bülten Tarihi</label>
                                <input id="bulletinDate" type="text" class="form-input" placeholder="gg.aa.yyyy" data-datepicker>
                            </div>
                        </div>
                    </div>

                    <div class="info-group">
                        <h6 class="text-primary font-weight-bold mb-4 border-bottom pb-2">
                            <i class="fas fa-image mr-2"></i>Görsel ve Açıklama
                        </h6>
                        <div class="form-grid">
                            <div class="form-group full-width">
                                <label class="form-label">Marka Görseli</label>
                                <div class="brand-upload-frame">
                                    <input type="file" id="brandExample" accept="image/*" style="display: none;">
                                    <div id="brandExampleUploadArea" class="upload-area">
                                        <i class="fas fa-cloud-upload-alt fa-2x text-muted"></i>
                                        <p class="mt-2 mb-0">Dosya seçmek için tıklayın veya sürükleyip bırakın</p>
                                        <small class="text-muted">PNG, JPG, JPEG dosyaları kabul edilir</small>
                                    </div>
                                    <div id="brandExamplePreviewContainer" style="display: none;" class="text-center mt-3">
                                        <img id="brandExamplePreview" src="" alt="Marka Örneği" style="max-width: 200px; max-height: 200px; border: 1px solid #ddd; border-radius: 8px;">
                                        <br>
                                        <button type="button" id="removeBrandExampleBtn" class="btn btn-danger btn-sm mt-2">
                                            <i class="fas fa-trash"></i> Kaldır
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div class="form-group full-width">
                                <label for="brandDescription" class="form-label">Marka Açıklaması</label>
                                <textarea id="brandDescription" class="form-textarea" rows="3" placeholder="Marka hakkında açıklama girin"></textarea>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="tab-pane fade" id="applicants" role="tabpanel">
                    <div class="d-flex justify-content-between align-items-center mb-4">
                        <h6 class="text-primary font-weight-bold m-0"><i class="fas fa-users mr-2"></i>Başvuru Sahipleri</h6>
                        <button type="button" class="btn-add-person btn-small" id="addApplicantBtn">
                            <i class="fas fa-plus mr-1"></i> Yeni Kişi Ekle
                        </button>
                    </div>
                    <div class="form-group">
                        <label for="applicantSearch" class="form-label">Başvuru Sahibi Ara</label>
                        <div class="search-input-wrapper">
                            <input type="text" id="applicantSearch" class="form-input" placeholder="İsim veya e-mail ile ara...">
                            <div id="applicantSearchResults" class="search-results-list" style="display: none;"></div>
                        </div>
                    </div>
                    <div id="selectedApplicantsContainer" class="selected-items-container">
                        <div class="empty-state text-center py-4">
                            <i class="fas fa-users fa-2x text-muted mb-2"></i>
                            <p class="text-muted m-0">Henüz başvuru sahibi seçilmedi</p>
                        </div>
                    </div>
                </div>
                
                <div class="tab-pane fade" id="priority" role="tabpanel">
                    <div class="info-group">
                        <div class="d-flex justify-content-between align-items-center mb-4 border-bottom pb-2">
                            <h6 class="text-primary font-weight-bold m-0"><i class="fas fa-star mr-2"></i>Rüçhan Bilgileri</h6>
                            <button type="button" id="addPriorityBtn" class="btn btn-secondary btn-sm">
                                <i class="fas fa-plus mr-1"></i> Rüçhan Ekle
                            </button>
                        </div>
                        <p class="text-muted mb-4 small">Birden fazla rüçhan hakkı ekleyebilirsiniz.</p>
                        
                        <div class="form-grid">
                            <div class="form-group">
                                <label for="priorityType" class="form-label">Rüçhan Tipi</label>
                                <select class="form-select" id="priorityType">
                                    <option value="başvuru" selected>Başvuru</option>
                                    <option value="sergi">Sergi</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label for="priorityDate" class="form-label" id="priorityDateLabel">Rüçhan Tarihi</label>
                                <input type="text" class="form-input" id="priorityDate" placeholder="gg.aa.yyyy" data-datepicker>
                            </div>
                            <div class="form-group">
                                <label for="priorityCountry" class="form-label">Rüçhan Ülkesi</label>
                                <select class="form-select" id="priorityCountry">
                                    <option value="">Seçiniz...</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label for="priorityNumber" class="form-label">Rüçhan Numarası</label>
                                <input type="text" class="form-input" id="priorityNumber" placeholder="Örn: 2023/12345">
                            </div>
                        </div>
                        
                        <div class="form-group full-width mt-4">
                            <label class="form-label">Eklenen Rüçhan Hakları</label>
                            <div id="addedPrioritiesList" class="selected-items-container border rounded bg-light p-2">
                                <div class="empty-state text-center py-3">
                                    <p class="text-muted m-0 small">Henüz rüçhan bilgisi eklenmedi.</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="tab-pane fade" id="goods-services" role="tabpanel">
                    <div class="nice-classification-container">
                        <div class="row">
                            <div class="col-12">
                                <div class="classification-panel mb-3">
                                    <div class="panel-header">
                                        <h5 class="mb-0"><i class="fas fa-list-ul mr-2"></i>Nice Classification - Mal ve Hizmet Sınıfları</h5>
                                        <small class="text-white-50">1-45 arası sınıflardan seçim yapın</small>
                                    </div>
                                    <div class="search-section">
                                        <div class="input-group">
                                            <input type="text" class="form-control border-right-0" id="niceClassSearch" placeholder="🔍 Sınıf numarası veya açıklama ara...">
                                            <div class="input-group-append">
                                                <button class="btn btn-outline-secondary border-left-0" type="button" id="clearSearchBtn">
                                                    <i class="fas fa-times"></i>
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="scrollable-list" id="niceClassificationList" style="max-height: 500px; overflow-y: auto; padding: 0;">
                                        <div class="text-center py-5">
                                            <div class="spinner-border text-secondary"></div>
                                            <div class="mt-2 text-muted">Veriler yükleniyor...</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="row">
                            <div class="col-12">
                                <div class="selected-classes-panel">
                                    <div class="panel-header">
                                        <div class="d-flex justify-content-between align-items-center">
                                            <div>
                                                <h5 class="mb-0"><i class="fas fa-check-circle mr-2"></i>Seçilen Sınıflar</h5>
                                                <small class="text-white-50">Toplam: <span id="selectedClassCount">0</span></small>
                                            </div>
                                            <button type="button" class="btn btn-outline-light btn-sm" id="clearAllClassesBtn" style="display: none;" title="Tüm seçimleri temizle">
                                                <i class="fas fa-trash"></i> Temizle
                                            </button>
                                        </div>
                                    </div>
                                    <div class="scrollable-list bg-light" id="selectedNiceClasses" style="max-height: 400px; overflow-y: auto; padding: 15px;">
                                        <div class="empty-state text-center py-4">
                                            <i class="fas fa-clipboard-list fa-2x text-muted mb-2"></i>
                                            <p class="text-muted m-0">Henüz sınıf seçilmedi</p>
                                        </div>
                                    </div>
                                </div>
                                
                                <div class="mt-4 p-4 bg-white border rounded shadow-sm">
                                    <label class="form-label font-weight-bold text-primary"><i class="fas fa-edit mr-2"></i>Özel Tanım</label>
                                    <textarea class="form-textarea mt-2" id="customClassInput" rows="3" placeholder="Listede olmayan özel bir mal/hizmet tanımı ekleyin..." maxlength="50000"></textarea>
                                    <div class="d-flex justify-content-between align-items-center mt-3">
                                        <small class="text-muted"><span id="customClassCharCount">0</span> / 50,000 karakter</small>
                                        <button type="button" class="btn btn-secondary btn-sm rounded-pill px-3" id="addCustomClassBtn">
                                            <i class="fas fa-plus mr-1"></i> Özel Tanım Ekle
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `,
    getPatentForm: () => `
        <div class="premium-card mt-4">
            <div class="card-header-custom">
                <span><i class="fas fa-lightbulb text-warning mr-2"></i> Patent Bilgileri</span>
            </div>
            <div class="card-body-custom">
                <div class="form-grid">
                    <div class="form-group full-width">
                        <label for="patentTitle" class="form-label">Patent Başlığı</label>
                        <input type="text" id="patentTitle" class="form-input" placeholder="Patent başlığını girin">
                    </div>
                    <div class="form-group">
                        <label for="patentApplicationNumber" class="form-label">Başvuru Numarası</label>
                        <input type="text" id="patentApplicationNumber" class="form-input" placeholder="Başvuru numarasını girin">
                    </div>
                    <div class="form-group full-width">
                        <label for="patentDescription" class="form-label">Patent Açıklaması</label>
                        <textarea id="patentDescription" class="form-textarea" rows="4" placeholder="Patent hakkında detaylı açıklama girin"></textarea>
                    </div>
                </div>
            </div>
        </div>
    `,
    getDesignForm: () => `
        <div class="premium-card mt-4">
            <div class="card-header-custom">
                <span><i class="fas fa-drafting-compass text-info mr-2"></i> Tasarım Bilgileri</span>
            </div>
            <div class="card-body-custom">
                <div class="form-grid">
                    <div class="form-group full-width">
                        <label for="designTitle" class="form-label">Tasarım Başlığı</label>
                        <input type="text" id="designTitle" class="form-input" placeholder="Tasarım başlığını girin">
                    </div>
                    <div class="form-group">
                        <label for="designApplicationNumber" class="form-label">Başvuru Numarası</label>
                        <input type="text" id="designApplicationNumber" class="form-input" placeholder="Başvuru numarasını girin">
                    </div>
                    <div class="form-group full-width">
                        <label for="designDescription" class="form-label">Tasarım Açıklaması</label>
                        <textarea id="designDescription" class="form-textarea" rows="4" placeholder="Tasarım hakkında detaylı açıklama girin"></textarea>
                    </div>
                </div>
            </div>
        </div>
    `,

    getSuitFields: (taskName) => {
        const courtOptions = COURTS_LIST.map(group => `
            <optgroup label="${group.label}">
                ${group.options.map(opt => `<option value="${opt.value}">${opt.text}</option>`).join('')}
            </optgroup>
        `).join('');

        return `
        <div class="premium-card mb-4" id="suitDetailsCard">
            <div class="card-header-custom">
                <span><i class="fas fa-balance-scale text-success mr-2"></i>3. Mahkeme ve Dava Detayları</span>
            </div>
            <div class="card-body-custom">
                <div class="form-grid">
                    <div class="form-group full-width">
                        <label for="suitCourt" class="form-label">Mahkeme</label>
                <select id="suitCourt" name="suitCourt" class="form-select" required>
                    <option value="">Seçiniz...</option>
                    ${courtOptions}
                </select>
                <input type="text" id="customCourtInput" class="form-input mt-2" placeholder="Mahkeme adını yazınız..." style="display:none;">
            </div>

            <div class="form-group">
                <label for="opposingParty" class="form-label">Karşı Taraf</label>
                <input type="text" id="opposingParty" class="form-input">
            </div>
            <div class="form-group">
                <label for="opposingCounsel" class="form-label">Karşı Taraf Vekili</label>
                <input type="text" id="opposingCounsel" class="form-input">
            </div>

            <div class="form-group">
                <label for="suitStatusSelect" class="form-label">Dava Durumu</label>
                <select id="suitStatusSelect" class="form-select" required>
                    <option value="">Seçiniz...</option>
                </select>
            </div>

            <div class="form-group">
                <label for="suitCaseNo" class="form-label">Esas No</label>
                <input type="text" class="form-input" id="suitCaseNo">
            </div>

            <div class="form-group">
                <label for="suitOpeningDate" class="form-label">Dava Tarihi (Açılış)</label>
                <input type="text" class="form-input" id="suitOpeningDate" placeholder="gg.aa.yyyy" data-datepicker required>
            </div>

            <div class="form-group full-width mt-3">
                <label class="form-label text-dark" style="font-weight:600;"><i class="fas fa-paperclip mr-2"></i>Dava Evrakları</label>
                <div class="custom-file">
                    <input type="file" class="custom-file-input" id="suitDocument" multiple>
                    <label class="custom-file-label" for="suitDocument" style="border-radius: 10px; border-color: #cbd5e1; height: auto; padding: 10px;">Dosya Seçiniz...</label>
                </div>
                <small class="text-muted d-block mt-2">Dava dilekçesi, tensip zaptı vb. evrakları buraya yükleyebilirsiniz.</small>
            </div>
        </div>
      </div>
    </div>`;
    },

    getClientSection: () => `
        <div class="premium-card mb-4" id="clientSection">
            <div class="card-header-custom">
                <span><i class="fas fa-user-shield text-primary mr-2"></i>1. Müvekkil Bilgileri</span>
            </div>
            <div class="card-body-custom">
                <div class="form-grid">
                    <div class="form-group">
                        <label for="clientRole" class="form-label">Müvekkil Rolü</label>
                        <select id="clientRole" name="clientRole" class="form-select" required>
                            <option value="">Seçiniz...</option>
                            <option value="davaci">Davacı (Plaintiff)</option>
                            <option value="davali">Davalı (Defendant)</option>
                        </select>
                    </div>
                </div>
                
                <div class="form-group full-width mt-4">
                    <label for="suitClientSearch" class="form-label">Müvekkil Ara</label>
                    <div class="d-flex" style="gap:15px; align-items:flex-start;">
                        <div class="search-input-wrapper" style="flex:1;">
                            <input type="text" id="suitClientSearch" class="form-input" placeholder="Müvekkil adı, e-posta..." autocomplete="off">
                            <div id="suitClientSearchResults" class="search-results-list" style="display:none;"></div> 
                        </div>
                        <button type="button" id="addNewPersonBtn" class="btn btn-add-person"><i class="fas fa-plus mr-1"></i> Yeni Kişi</button>
                    </div>
                </div>

                <div id="selectedSuitClient" class="selected-item d-none mt-3">
                    <div>
                        <span class="text-muted mr-2">Seçilen:</span>
                        <span id="selectedSuitClientName" class="font-weight-bold text-primary"></span>
                    </div>
                    <button type="button" class="remove-selected-item-btn" id="clearSuitClient">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>
        </div>
    `,

    getSubjectAssetSection: () => `
        <div class="premium-card mb-4" id="subjectAssetSection" style="overflow: visible !important;">
            <div class="card-header-custom">
                <span><i class="fas fa-briefcase text-info mr-2"></i>2. Dava Konusu (Portföy Varlığı)</span>
            </div>
            <div class="card-body-custom" style="overflow: visible !important;">
                <div class="form-group full-width" style="position: relative; z-index: 1050;">
                    <label for="subjectAssetSearch" class="form-label">Portföyden Varlık Ara</label>
                    <div class="search-input-wrapper" style="position: relative;">
                        <input type="text" id="subjectAssetSearch" class="form-input" placeholder="Başlık, numara, tip..." autocomplete="off">
                        <div id="subjectAssetSearchResults" class="search-results-list" style="display:none; position: absolute; top: 100%; left: 0; right: 0; z-index: 99999; background: white; border: 1px solid #cbd5e1; border-radius: 5px; max-height: 300px; overflow-y: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.25); margin-top: 5px;"></div> 
                    </div>
                </div>
                <div id="selectedSubjectAsset" class="selected-item d-none mt-3">
                    <div>
                        <span class="text-muted mr-2">Seçilen:</span>
                        <span id="selectedSubjectAssetName" class="font-weight-bold text-primary"></span>
                        <small class="text-muted ml-2">(<span id="selectedSubjectAssetType"></span> - <span id="selectedSubjectAssetNumber"></span>)</small>
                    </div>
                    <button type="button" class="remove-selected-item-btn" id="clearSubjectAsset">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>
        </div>
    `,
    getSuitForm: () => `<div id="suitFormContainer"></div>`
};