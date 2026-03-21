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
const relatedPartyContainer = _el('relatedPartyContainer');

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

    // 🔥 EKSİK OLAN VE EKLENMESİ GEREKEN KISIM: Arayüz Değiştirici 🔥
    const transferRadios = document.querySelectorAll('input[name="transferOption"]');
    transferRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
        const singleFields = _el('singleFields');
        const bulkFields = _el('bulkFields');
        
        if (e.target.value === 'single') {
            _showBlock(singleFields);
            _hideBlock(bulkFields);
            sahipNoInput.value = ''; // Gizlenen kutuyu temizle ki hata yapmasın
        } else {
            _hideBlock(singleFields);
            _showBlock(bulkFields);
            basvuruNoInput.value = ''; // Gizlenen kutuyu temizle ki hata yapmasın
        }
        });
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

        // 🔥 YENİ: Toplam sayı belli olduğunda yükleme metnini güncelle
        if (msg.type === 'SORGU_BASLADI' && msg.data?.total) {
            const bulkLoading = _el('bulkLoading');
            const loadingText = bulkLoading?.querySelector('span.ml-2');
            _showBlock(bulkLoading);
            if (loadingText) {
                loadingText.innerHTML = `<strong>TPE veritabanı tarandı.</strong> Toplam <b>${msg.data.total}</b> kayıt çekilmeye başlanıyor...`;
            }
        }

        // 1. TEKİL SONUÇ GELDİĞİNDE
        if (msg.type === 'VERI_GELDI_BASVURU' || msg.type === 'VERI_GELDI_OPTS') {
            _hideBlock(loadingEl);
            _showBlock(singleResultContainer);
            _showBlock(relatedPartyContainer); 
            const data = Array.isArray(msg.data) ? msg.data[0] : msg.data;
            if (!data) return;
            currentOwnerResults = [data]; 
            renderSingleResult(data);
        }

        // 🔥 2. TOPLU (BATCH) SONUÇLAR GELDİĞİNDE - CANLI PROGRESS!
        if (msg.type === 'BATCH_VERI_GELDI_KISI') {
            const bulkLoading = _el('bulkLoading');
            const bulkContainer = _el('bulkResultsContainer');
            const { batch, isLastBatch, totalCompleted, totalExpected } = msg.data;
            
            // Yüzdelik İlerleme Güncellemesi
            if (!isLastBatch) {
                _showBlock(bulkLoading);
                const loadingText = bulkLoading?.querySelector('span.ml-2');
                if (loadingText) {
                    let percent = Math.round((totalCompleted / totalExpected) * 100);
                    loadingText.innerHTML = `<strong class="text-primary">%${percent}</strong> - Arka planda veriler çekiliyor (${totalCompleted} / ${totalExpected})...`;
                }
            } else {
                _hideBlock(bulkLoading);
                // Bir sonraki sorgu için metni sıfırla
                const loadingText = bulkLoading?.querySelector('span.ml-2');
                if (loadingText) loadingText.innerText = "Sonuçlar çekiliyor..."; 
            }

            _showBlock(bulkContainer);
            _showBlock(relatedPartyContainer); 
            
            // Tablonun üstündeki ufak bilgi metni (Header Meta)
            const metaEl = _el('bulkMeta');
            if (metaEl) {
                if (isLastBatch) {
                    metaEl.innerHTML = `<span class="text-success" style="font-weight:600;"><i class="fas fa-check-circle"></i> Yükleme Tamamlandı (${totalCompleted} Kayıt)</span>`;
                } else {
                    metaEl.innerHTML = `<span class="text-primary" style="font-weight:600;"><i class="fas fa-spinner fa-spin"></i> İşleniyor (${totalCompleted} / ${totalExpected})</span>`;
                }
            }
            
            renderBulkBatch(batch);
            
            if (isLastBatch) {
                const saveBtn = _el('savePortfolioBtn');
                if (saveBtn) saveBtn.disabled = false;
            }
        }

        if (msg.type === 'HATA_BASVURU' || msg.type === 'HATA_OPTS' || msg.type === 'HATA_KISI') {
            _hideBlock(loadingEl);
            _hideBlock(_el('bulkLoading'));
            alert("Sorgulama Hatası: " + (msg.data?.message || 'Sonuç bulunamadı.'));
        }
    });
}

// 🔥 YENİ EKLENEN KISIM: Tabloya Görselli Satır Ekleyen Fonksiyon
function renderBulkBatch(batch) {
    const tbody = _el('bulkResultsBody');
    if (!tbody) return;
    
    // Eğer ilk paketse tabloyu temizle
    if (currentOwnerResults.length === 0) tbody.innerHTML = '';

    batch.forEach(item => {
        currentOwnerResults.push(item); // Genel listeye ekle (Kaydederken kullanılacak)
        const index = currentOwnerResults.length - 1;
        
        // 🔥 GÖRSEL HTML'İ HAZIRLANIYOR
        const imgHtml = item.brandImageDataUrl 
            ? `<img src="${item.brandImageDataUrl}" alt="Logo" style="width:45px; height:45px; object-fit:contain; border-radius:4px; border:1px solid #ddd; background:#fff;">` 
            : `<div style="width:45px; height:45px; background:#f8f9fa; border-radius:4px; border:1px solid #ddd; display:flex; align-items:center; justify-content:center; color:#adb5bd; font-size:10px;">Yok</div>`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="checkbox" class="record-checkbox" data-index="${index}" checked></td>
            <td>${imgHtml}</td>
            <td><strong>${item.applicationNumber || '-'}</strong></td>
            <td>${item.brandName || '-'}</td>
            <td style="white-space:normal; max-width:200px;">${item.ownerName || '-'}</td>
            <td style="white-space:normal; max-width:200px;" class="text-muted">${item.agentInfo || '-'}</td> <td>${item.applicationDate || '-'}</td>
            <td>${item.registrationNumber || '-'}</td>
            <td><span class="badge badge-soft">${item.status || '-'}</span></td>
            <td style="white-space:normal; max-width:200px;">${item.niceClasses || '-'}</td>
        `;
        tbody.appendChild(tr);
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
            
            // 1. Ana Kaydı Oluştur
            const result = await ipRecordsService.createRecordFromDataEntry(mappedRecord);
            
            if (result.success) {
                // =======================================================
                // 🔥 YENİ: SADECE SCRAPER'A ÖZEL TRANSACTION KAYDI
                // Config'i bozmadan doğrudan bu sayfadan DB'ye yazıyoruz
                // =======================================================
                if (mappedRecord.transactions && mappedRecord.transactions.length > 0) {
                    const txRows = mappedRecord.transactions.map(tx => {
                        let typeId = tx.type || null;
                        if (!typeId && tx.description && tx.description.toLowerCase().includes('başvuru')) {
                            typeId = '2'; // Sistemdeki "Marka Başvurusu" tip ID'si
                        }

                        // Tarih formatını garantiye al
                        let txDate = new Date().toISOString();
                        if (tx.date) {
                            const parsedDate = new Date(tx.date);
                            if (!isNaN(parsedDate.getTime())) txDate = parsedDate.toISOString();
                        }

                        return {
                            id: crypto.randomUUID(),
                            ip_record_id: result.id, // Supabase'in yeni ürettiği dosya ID'si
                            transaction_type_id: typeId,
                            description: tx.description || 'Sistem Kaydı',
                            transaction_date: txDate,
                            transaction_hierarchy: 'parent'
                        };
                    });
                    
                    // İşlemleri (Transactions) doğrudan veritabanına ekle
                    const { error: txError } = await supabase.from('transactions').insert(txRows);
                    if (txError) console.error("İşlem geçmişi yazılamadı:", txError);
                }
                // =======================================================

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
    _hideBlock(relatedPartyContainer);
    window.open(`https://opts.turkpatent.gov.tr/trademark#bn=${encodeURIComponent(basvuruNo)}`, '_blank');
  } else if (sahipNo && !basvuruNo) {
    _showBlock(bulkLoadingEl || loadingEl);
    _hideBlock(singleResultContainer);
    _hideBlock(relatedPartyContainer);
    window.open(`https://www.turkpatent.gov.tr/arastirma-yap?form=trademark&auto_query=${encodeURIComponent(sahipNo)}&query_type=sahip&source=${encodeURIComponent(window.location.origin)}`, '_blank');
  } else {
    alert('Lütfen sadece bir alan doldurun.');
  }
}

document.addEventListener('DOMContentLoaded', init);