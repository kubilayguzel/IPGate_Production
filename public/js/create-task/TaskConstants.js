// public/js/create-task/TaskConstants.js

// İşlem Tipi ID'leri (Kodda magic string kullanmamak için)
export const TASK_IDS = {
    DEVIR: '5',
    LISANS: '10',
    REHIN_TEMINAT: '13',
    BIRLESME: '3',
    VERASET: '18',
    YAYIMA_ITIRAZIN_YENIDEN_INCELENMESI: '19',
    ITIRAZ_YAYIN: '20',
    KARARA_ITIRAZ: '7',
    UCUNCU_KISI_GORUSU: '1',
    KARARA_ITIRAZ_GERI_CEKME: '8',
    KULLANIM_DELILI_SUNMA: '9',
    SICIL_SURETI: '14',
    TANINMISLIK_TESPITI: '15',
    YAYINA_ITIRAZI_GERI_CEKME: '21',
    EKSIKLIK_GIDERME: '25',
    ITIRAZA_EK_BELGE: '37',
    KULLANIM_ISPATI_DELILI_SUNMA: '39'
};

// İlgili Taraf (Related Party) seçimi zorunlu olan işlem tipleri
export const RELATED_PARTY_REQUIRED = new Set([
    TASK_IDS.DEVIR,
    TASK_IDS.LISANS,
    TASK_IDS.REHIN_TEMINAT,
    TASK_IDS.BIRLESME,
    TASK_IDS.VERASET,
    TASK_IDS.YAYIMA_ITIRAZIN_YENIDEN_INCELENMESI,
    TASK_IDS.ITIRAZ_YAYIN,
    TASK_IDS.KARARA_ITIRAZ,
    TASK_IDS.UCUNCU_KISI_GORUSU,
    TASK_IDS.KARARA_ITIRAZ_GERI_CEKME,
    TASK_IDS.KULLANIM_DELILI_SUNMA,
    TASK_IDS.SICIL_SURETI,
    TASK_IDS.TANINMISLIK_TESPITI,
    TASK_IDS.YAYINA_ITIRAZI_GERI_CEKME,
    TASK_IDS.EKSIKLIK_GIDERME,
    TASK_IDS.ITIRAZA_EK_BELGE,
    TASK_IDS.ITIRAZA_EK_BELGE,
    TASK_IDS.KULLANIM_ISPATI_DELILI_SUNMA
]);

// İşlem tipine göre arayüzde görünecek etiketler
export const PARTY_LABEL_BY_ID = {
    [TASK_IDS.DEVIR]: 'Devralan Taraf',
    [TASK_IDS.LISANS]: 'Lisans Alan Taraf',
    [TASK_IDS.REHIN_TEMINAT]: 'Rehin Alan Taraf',
    [TASK_IDS.BIRLESME]: 'Birleşilen Taraf',
    [TASK_IDS.VERASET]: 'Mirasçı',
    [TASK_IDS.YAYIMA_ITIRAZIN_YENIDEN_INCELENMESI]: 'İtiraz Sahibi',
    [TASK_IDS.ITIRAZ_YAYIN]: 'İtiraz Sahibi',
    [TASK_IDS.KARARA_ITIRAZ]: 'İtiraz Sahibi',
    [TASK_IDS.UCUNCU_KISI_GORUSU]: 'Talep Sahibi',
    [TASK_IDS.KARARA_ITIRAZ_GERI_CEKME]: 'Talep Sahibi',
    [TASK_IDS.KULLANIM_DELILI_SUNMA]: 'Talep Sahibi',
    [TASK_IDS.SICIL_SURETI]: 'Talep Sahibi',
    [TASK_IDS.TANINMISLIK_TESPITI]: 'Talep Sahibi',
    [TASK_IDS.YAYINA_ITIRAZI_GERI_CEKME]: 'Talep Sahibi',
    [TASK_IDS.EKSIKLIK_GIDERME]: 'Talep Sahibi',
    [TASK_IDS.ITIRAZA_EK_BELGE]: 'Talep Sahibi',
    [TASK_IDS.KULLANIM_ISPATI_DELILI_SUNMA]: 'Talep Sahibi'
};

// --- Yardımcı Fonksiyonlar ---

// Değeri güvenli bir şekilde string ID'ye çevirir
export const asId = (v) => String(v ?? '');

// Firebase Storage indirme URL'sinden dosya yolunu (path) çıkarır
export function __pathFromDownloadURL(url) {
    try {
        const m = String(url).match(/\/o\/(.+?)\?/);
        return m ? decodeURIComponent(m[1]) : null; // örn: brand-examples/1727040100000_x.jpg
    } catch { return null; }
}