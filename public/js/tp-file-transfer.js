// public/js/tp-file-transfer.js

import { supabase, personService, ipRecordsService } from '../supabase-config.js';
import { mapTurkpatentToIPRecord } from './turkpatent-mapper.js';

function _el(id) { return document.getElementById(id); }
function _showBlock(el) { if(!el) return; el.classList.remove('hide'); el.style.display=''; }
function _hideBlock(el) { if(!el) return; el.classList.add('hide'); }

function fmtDateToTR(isoOrDDMMYYYY) {
  if(!isoOrDDMMYYYY) return '';
  if(/^\d{2}\.\d{2}\.\d{4}$/.test(isoOrDDMMYYYY)) return isoOrDDMMYYYY;
  const m = String(isoOrDDMMYYYY).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m) return `${m[3]}.${m[2]}.${m[1]}`;
  return String(isoOrDDMMYYYY);
}

// Element Tanımlamaları
const basvuruNoInput = _el('basvuruNoInput');
const sahipNoInput = _el('ownerIdInput');
const loadingEl = _el('loading');
const bulkLoadingEl = _el('bulkLoading');
const singleResultContainer = _el('singleResultContainer');
const singleResultInner = _el('singleResultInner');

// İlgili Taraf Elementleri
const relatedPartySearchInput = _el('relatedPartySearchInput');
const relatedPartySearchResults = _el('relatedPartySearchResults');
const relatedPartyList = _el('relatedPartyList');
const relatedPartyCount = _el('relatedPartyCount');
const addNewPersonBtn = _el('addNewPersonBtn');

let allPersons = [];
let selectedRelatedParties = [];
let currentOwnerResults = []; 

async function init() {
  try {
    await fetchPersons(); // Kişileri DB'den çek
    setupEventListeners();
    setupMessageListener(); 
  } catch (error) { console.error("Veri yüklenirken hata oluştu:", error); }
}

async function fetchPersons() {
    const personsResult = await personService.getPersons();
    allPersons = Array.isArray(personsResult.data) ? personsResult.data : [];
}

function setupEventListeners() {
  document.addEventListener('click', (e) => {
    if (e.target.id === 'queryBtn' || e.target.id === 'bulkQueryBtn') { e.preventDefault(); handleQuery(); }
    if (e.target.id === 'savePortfolioBtn') { e.preventDefault(); handleSaveToPortfolio(); }
  });

  // İlgili Taraf Arama Dinleyicisi
  if (relatedPartySearchInput) {
      relatedPartySearchInput.addEventListener('input', handlePersonSearch);
      
      // Boşluğa tıklanınca arama sonuçlarını gizle
      document.addEventListener('click', (e) => {
          if (!e.target.closest('.search-input-wrapper')) {
              _hideBlock(relatedPartySearchResults);
          }
      });
  }

  // Yeni Kişi Ekle Butonu Dinleyicisi
  if (addNewPersonBtn) {
      addNewPersonBtn.addEventListener('click', () => {
          window.open('persons.html', '_blank');
      });
  }

  // Sekmeye geri dönüldüğünde kişi listesini arka planda sessizce yenile
  window.addEventListener('focus', async () => {
      await fetchPersons();
  });
}

// 🔥 YENİ: İlgili Taraf Arama ve Filtreleme
function handlePersonSearch(e) {
    const term = e.target.value.toLowerCase().trim();
    if (term.length < 2) {
        _hideBlock(relatedPartySearchResults);
        return;
    }

    const filtered = allPersons.filter(p => 
        (p.name && p.name.toLowerCase().includes(term)) || 
        (p.email && p.email.toLowerCase().includes(term)) ||
        (p.tckn && p.tckn.includes(term)) ||
        (p.taxNo && p.taxNo.includes(term))
    ).slice(0, 10); // En fazla 10 sonuç göster

    if (filtered.length === 0) {
        relatedPartySearchResults.innerHTML = `<div class="p-2 text-muted text-center">Sistemde eşleşen kişi bulunamadı.</div>`;
    } else {
        relatedPartySearchResults.innerHTML = filtered.map(p => `
            <div class="search-result-item" data-id="${p.id}">
                <div style="font-weight: 600; color: #1e3c72;">${p.name}</div>
                <div style="font-size: 0.85em; color: #666; margin-top: 3px;">
                    ${p.email ? `<i class="fas fa-envelope mr-1"></i>${p.email}` : ''} 
                    ${p.tckn ? `<i class="fas fa-id-card mr-1 ml-2"></i>${p.tckn}` : ''}
                    ${p.taxNo ? `<i class="fas fa-building mr-1 ml-2"></i>${p.taxNo}` : ''}
                </div>
            </div>
        `).join('');
    }
    
    _showBlock(relatedPartySearchResults);

    // Çıkan sonuçlara tıklama özelliği ekle
    document.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', function() {
            const personId = this.getAttribute('data-id');
            const person = allPersons.find(p => String(p.id) === String(personId));
            if (person) addRelatedParty(person);
            
            relatedPartySearchInput.value = '';
            _hideBlock(relatedPartySearchResults);
        });
    });
}

// Seçilen Kişiyi Listeye Ekle
function addRelatedParty(person) {
    if (!selectedRelatedParties.some(p => String(p.id) === String(person.id))) {
        selectedRelatedParties.push(person);
        renderSelectedParties();
    } else {
        alert('Bu kişi zaten listeye eklendi!');
    }
}

// Seçilen Kişiyi Listeden Çıkar (Global fonksiyon olarak atıyoruz ki HTML onclick görebilsin)
window.removeRelatedParty = function(id) {
    selectedRelatedParties = selectedRelatedParties.filter(p => String(p.id) !== String(id));
    renderSelectedParties();
}

// Seçilen Kişileri Ekrana Bas
function renderSelectedParties() {
    if (!relatedPartyList) return;
    
    if (relatedPartyCount) {
        relatedPartyCount.textContent = selectedRelatedParties.length;
    }

    if (selectedRelatedParties.length === 0) {
        relatedPartyList.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-user-friends fa-3x text-muted mb-3"></i>
                <p class="text-muted">Henüz taraf eklenmedi.</p>
            </div>
        `;
        return;
    }

    relatedPartyList.innerHTML = selectedRelatedParties.map(p => `
        <div class="selected-item d-flex justify-content-between align-items-center">
            <div>
                <i class="fas fa-user-tie text-primary mr-2"></i>
                <strong>${p.name}</strong>
                <span class="text-muted ml-2" style="font-size: 0.85em;">${p.email || ''}</span>
            </div>
            <button type="button" class="remove-selected-item-btn" onclick="removeRelatedParty('${p.id}')">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `).join('');
}

// Eklentiden Gelen Mesaj Dinleyicisi
function setupMessageListener() {
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || msg.source !== 'tp-sorgu-eklentisi-2') return;

        if (msg.type === 'VERI_GELDI_BASVURU' || msg.type === 'VERI_GELDI_OPTS') {
            _hideBlock(loadingEl);
            _showBlock(singleResultContainer);

            const data = Array.isArray(msg.data) ? msg.data[0] : msg.data;
            if (!data) return;

            currentOwnerResults = [data]; 
            renderSingleResult(data);
        }

        if (msg.type === 'HATA_BASVURU' || msg.type === 'HATA_OPTS') {
            _hideBlock(loadingEl);
            alert("Sorgulama Hatası: " + (msg.data?.message || 'Sonuç bulunamadı.'));
        }
    });
}

function renderSingleResult(data) {
    if (!singleResultInner) return;
    
    singleResultInner.innerHTML = `
        <div class="hero">
            <div class="hero-img-wrap">
                <img src="${data.brandImageUrl || 'evreka-logo.png'}" class="hero-img" alt="Marka Görseli">
            </div>
            <div style="flex:1;">
                <h4 style="color:#1e3c72; margin-bottom:10px;">${data.brandName || 'İsimsiz Marka'}</h4>
                <div class="kv-grid">
                    <div class="kv-item"><div class="label">Başvuru Numarası</div><div class="value">${data.applicationNumber || '-'}</div></div>
                    <div class="kv-item"><div class="label">Başvuru Tarihi</div><div class="value">${data.applicationDate || '-'}</div></div>
                    <div class="kv-item"><div class="label">Durumu</div><div class="value"><span class="badge badge-soft">${data.status || '-'}</span></div></div>
                    <div class="kv-item owner-wide"><div class="label">Sahip</div><div class="value">${data.ownerName || '-'}</div></div>
                </div>
            </div>
        </div>
        <input type="checkbox" class="record-checkbox hide" data-index="0" checked>
    `;
    
    const saveBtn = _el('savePortfolioBtn');
    if(saveBtn) saveBtn.disabled = false; 
}

async function handleSaveToPortfolio() {
  const checkedBoxes = document.querySelectorAll('.record-checkbox:checked');
  if (checkedBoxes.length === 0) return alert('Kaydetmek için en az bir kayıt seçin.');
  
  const selectedIndexes = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.index));
  const selectedRecords = selectedIndexes.map(index => currentOwnerResults[index]).filter(Boolean);
  
  // Seçilen tarafları al ve formata uygun hale getir
  const relatedParties = selectedRelatedParties.map(person => ({ id: person.id, name: person.name, email: person.email || null }));
  
  let successCount = 0;
  
  for (const record of selectedRecords) {
      try {
        const mappedRecord = await mapTurkpatentToIPRecord(record, relatedParties);        
        if (!mappedRecord) continue;
        
        const result = await ipRecordsService.createRecordFromDataEntry(mappedRecord);
        if (result.success) {
            successCount++;
        } else {
            console.error("Kayıt veritabanına yazılamadı:", result.error);
        }
      } catch (error) { console.error('Kayıt işlenirken hata:', error); }
  }
 
  alert(`${successCount} kayıt başarıyla portföye eklendi.`);
  currentOwnerResults = [];
  selectedRelatedParties = []; // Seçilenleri temizle
  renderSelectedParties(); // Arayüzü temizle
  if (singleResultInner) singleResultInner.innerHTML = '';
  _hideBlock(singleResultContainer);
}

async function handleQuery() {
  const basvuruNo = (basvuruNoInput?.value || '').trim();
  const sahipNo = (sahipNoInput?.value || '').trim();
  
  if (basvuruNo && !sahipNo) {
    _showBlock(loadingEl);
    _hideBlock(singleResultContainer);
    window.open(`https://opts.turkpatent.gov.tr/trademark#bn=${encodeURIComponent(basvuruNo)}`, '_blank');
  } else if (sahipNo && !basvuruNo) {
    _showBlock(bulkLoadingEl || loadingEl);
    _hideBlock(singleResultContainer);
    window.open(`https://www.turkpatent.gov.tr/arastirma-yap?form=trademark&auto_query=${encodeURIComponent(sahipNo)}&query_type=sahip&source=${encodeURIComponent(window.location.origin)}`, '_blank');
  } else {
    alert('Lütfen sadece bir alan doldurun.');
  }
}

document.addEventListener('DOMContentLoaded', init);