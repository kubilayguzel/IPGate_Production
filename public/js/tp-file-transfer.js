// public/js/tp-file-transfer.js

import { supabase, personService, ipRecordsService } from './supabase-config.js';
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

const basvuruNoInput = _el('basvuruNoInput');
const sahipNoInput = _el('ownerIdInput');
const loadingEl = _el('loading');
const singleResultContainer = _el('singleResultContainer');
const singleResultInner = _el('singleResultInner');

let allPersons = [];
let selectedRelatedParties = [];
let currentOwnerResults = []; 

async function init() {
  try {
    const personsResult = await personService.getPersons();
    allPersons = Array.isArray(personsResult.data) ? personsResult.data : [];
    setupEventListeners();
  } catch (error) { console.error("Veri yüklenirken hata oluştu:", error); }
}

function setupEventListeners() {
  document.addEventListener('click', (e) => {
    if (e.target.id === 'queryBtn' || e.target.id === 'bulkQueryBtn') { e.preventDefault(); handleQuery(); }
    if (e.target.id === 'savePortfolioBtn') { e.preventDefault(); handleSaveToPortfolio(); }
  });
}

async function handleSaveToPortfolio() {
  const checkedBoxes = document.querySelectorAll('.record-checkbox:checked');
  if (checkedBoxes.length === 0) return alert('Kaydetmek için en az bir kayıt seçin.');
  
  const selectedIndexes = Array.from(checkedBoxes).map(cb => parseInt(cb.dataset.index));
  const selectedRecords = selectedIndexes.map(index => currentOwnerResults[index]).filter(Boolean);
  
  const relatedParties = selectedRelatedParties.map(person => ({ id: person.id, name: person.name, email: person.email || null }));
  
  let successCount = 0;
  
  for (const record of selectedRecords) {
      try {
        const mappedRecord = await mapTurkpatentToIPRecord(record, relatedParties);        
        if (!mappedRecord) continue;
        
        const result = await ipRecordsService.createRecordFromDataEntry(mappedRecord);
        if (result.success) {
            successCount++;
        }
      } catch (error) { console.error('Kayıt işlenirken hata:', error); }
  }
 
  alert(`${successCount} kayıt başarıyla portföye eklendi.`);
  currentOwnerResults = [];
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
    _showBlock(loadingEl);
    _hideBlock(singleResultContainer);
    window.open(`https://www.turkpatent.gov.tr/arastirma-yap?form=trademark&auto_query=${encodeURIComponent(sahipNo)}&query_type=sahip&source=${encodeURIComponent(window.location.origin)}`, '_blank');
  } else {
    alert('Lütfen sadece bir alan doldurun.');
  }
}

document.addEventListener('DOMContentLoaded', init);