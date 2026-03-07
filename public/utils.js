// js/utils.js

// Bildirimleri göstermek için kullanılan fonksiyon
export function showNotification(message, type = 'info', duration = 3000) {
    // 1. Konteyneri kontrol et, yoksa dinamik olarak oluştur
    let container = document.getElementById('notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'notification-container';
        document.body.appendChild(container);
        console.info('Bildirim konteyneri dinamik olarak oluşturuldu.');
    }
    container.classList.add('notification-container');

    // Sticky: Kritik mesajları minimum 15 sn göster
    const STICKY_PARTS = [
        'Doğrulama e-postası gönderildi',
        'Hesap oluşturuldu'
    ];
    let effectiveDuration = duration;
    if (STICKY_PARTS.some(p => (message || '').includes(p))) {
        if (!effectiveDuration || effectiveDuration < 15000) effectiveDuration = 15000;
    }

    const notificationItem = document.createElement('div');
    notificationItem.classList.add('notification-item', `notification-${type}`);
    notificationItem.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.classList.add('notification-close-btn');
    closeBtn.innerHTML = '&times;'; // '×'
    closeBtn.onclick = () => {
        notificationItem.classList.add('hide');
        notificationItem.addEventListener('transitionend', () => notificationItem.remove());
    };

    notificationItem.appendChild(closeBtn);
    container.appendChild(notificationItem);

    // Otomatik olarak kaybolma
    if (effectiveDuration > 0) {
        setTimeout(() => {
            if (notificationItem.parentElement) { // Eleman hala DOM'daysa kaldır
                notificationItem.classList.add('hide');
                notificationItem.addEventListener('transitionend', () => notificationItem.remove());
            }
        }, effectiveDuration);
    }
}

// Formlardaki tüm hata mesajlarını ve hata stillerini temizleyen fonksiyon
export function clearAllFieldErrors() {
    document.querySelectorAll('.error-message').forEach(el => {
        el.textContent = ''; // Hata mesajını temizle
        el.style.display = 'none'; // Hata mesajını gizle
    });
    document.querySelectorAll('.form-input, .form-select, .form-textarea').forEach(el => {
        el.classList.remove('error-field'); // Hata stilini kaldır
    });
}

// Belirli bir form alanında hata mesajını gösteren ve hata stilini uygulayan fonksiyon
export function showFieldError(fieldId, errorMessage) {
    const field = document.getElementById(fieldId);
    if (field) {
        field.classList.add('error-field'); // Alanı kırmızı kenarlıkla işaretle
        const errorContainer = field.nextElementSibling; // Genellikle hata mesajı input'un hemen sonrasındaki bir span veya div olur
        if (errorContainer && errorContainer.classList.contains('error-message')) {
            errorContainer.textContent = errorMessage;
            errorContainer.style.display = 'block';
        } else {
            // Eğer hata mesajı elementi yoksa, dinamik olarak oluştur
            const newErrorElement = document.createElement('div');
            newErrorElement.classList.add('error-message');
            newErrorElement.textContent = errorMessage;
            newErrorElement.style.display = 'block';
            field.parentNode.insertBefore(newErrorElement, field.nextSibling);
        }
    }
}

// Dosya boyutunu okunabilir formata çeviren fonksiyon
export function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Dosyayı Base64 Data URL'sine çeviren fonksiyon
export function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
    });
}

// Benzersiz UUID oluşturan fonksiyon
export function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export const TASK_STATUSES = [
    { value: 'open', text: 'Açık', color: 'primary' },
    { value: 'in-progress', text: 'Devam Ediyor', color: 'info' },
    { value: 'completed', text: 'Tamamlandı', color: 'success' },
    { value: 'pending', text: 'Beklemede', color: 'warning' },
    { value: 'cancelled', text: 'İptal Edildi', color: 'danger' },
    { value: 'archived', text: 'Arşivlendi', color: 'secondary' },
    { value: 'awaiting-approval', text: 'Onay Bekliyor', color: 'secondary' },
    { value: 'awaiting_client_approval', text: 'Müvekkil Onayı Bekliyor', color: 'warning' },
    { value: 'client_approval_opened', text: 'Müvekkil Onayı - Açıldı', color: 'info' },
    { value: 'client_approval_closed', text: 'Müvekkil Onayı - Kapatıldı', color: 'success' },
    { value: 'client_no_response_closed', text: 'Müvekkil Cevaplamadı - Kapatıldı', color: 'dark' }
];

export const TASK_STATUS_MAP = TASK_STATUSES.reduce((acc, status) => {
    acc[status.value] = status.text;
    return acc;
}, {});

// IP Kayıt durumları (data-entry.html'de kullanılır)
export const STATUSES = {
    patent: [
        { value: 'filed', text: 'Başvuru' },
        { value: 'pending', text: 'Beklemede' },
        { value: 'published', text: 'Yayınlandı' },
        { value: 'approved', text: 'Onaylandı' },
        { value: 'registered', text: 'Tescil Edildi' },
        { value: 'rejected', text: 'Reddedildi' },
        { value: 'expired', text: 'Koruma Süresi Bitti (Geçersiz)' },
        { value: 'invalid_not_renewed', text: 'Yenilenmedi (Geçersiz)' }
    ],
    trademark: [
        { value: 'filed', text: 'Başvuru' },
        { value: 'pending', text: 'Beklemede' },
        { value: 'published', text: 'Yayınlandı' },
        { value: 'opposition_filed', text: 'İtiraz Edildi' },
        { value: 'registered', text: 'Tescilli' },
        { value: 'refused', text: 'Reddedildi' },
        { value: 'partial_refusal', text: 'Kısmen Yayınlandı' },
        { value: 'rejected', text: 'Geçersiz' },
        { value: 'expired', text: 'Geçersiz (Yenilenmedi)'},
        { value: 'invalidated', text: 'Hükümsüz' }
    ],
    design: [
        { value: 'filed', text: 'Başvuru' },
        { value: 'pending', text: 'Beklemede' },
        { value: 'published', text: 'Yayınlandı' },
        { value: 'approved', text: 'Onaylandı' },
        { value: 'registered', text: 'Tescil Edildi' },
        { value: 'rejected', text: 'Reddedildi' },
        { value: 'expired', text: 'Koruma Süresi Bitti (Geçersiz)' },
        { value: 'invalid_not_renewed', text: 'Yenilenmedi (Geçersiz)' }
    ],
    copyright: [
        { value: 'registered', text: 'Tescil Edildi' },
        { value: 'pending', text: 'Beklemede' },
        { value: 'active', text: 'Aktif' },
        { value: 'expired', text: 'Süresi Doldu' }
    ],
    litigation: [
            // VALUE: Teknik kod (DB'ye yazılan), TEXT: Ekranda görünen
            { value: 'filed', text: 'Dava Açıldı', color: 'primary' },
            { value: 'continue', text: 'Devam Ediyor', color: 'info' },
            { value: 'expert_examination', text: 'Bilirkişi İncelemesinde', color: 'info' },
            { value: 'expert_report_pending', text: 'Bilirkişi Raporu Bekleniyor', color: 'warning' },
            { value: 'decision_pending', text: 'Karar Bekleniyor', color: 'danger' },
            { value: 'reasoned_judgment', text: 'Gerekçeli Karar Bekleniyor', color: 'warning' },
            { value: 'appeal', text: 'İstinaf Aşamasında', color: 'primary' },
            { value: 'cassation', text: 'Yargıtay Aşamasında', color: 'primary' },
            { value: 'remission', text: 'Bozma - Dosya Döndü', color: 'danger' },
            { value: 'decision', text: 'Karar Verildi', color: 'info' },
            { value: 'finalized', text: 'Kesinleşti', color: 'success' },
            { value: 'cancelled', text: 'İşlemden Kaldırıldı', color: 'secondary' }
        ]
    };

export const COURTS_LIST = [
    {
        label: 'Ankara',
        options: [
            { value: 'Ankara 1. FSHHM', text: 'Ankara 1. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'Ankara 2. FSHHM', text: 'Ankara 2. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'Ankara 3. FSHHM', text: 'Ankara 3. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'Ankara 4. FSHHM', text: 'Ankara 4. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'Ankara 5. FSHHM', text: 'Ankara 5. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'Ankara FSHCM', text: 'Ankara Fikri ve Sınai Haklar Ceza Mahkemesi' }
        ]
    },
    {
        label: 'İstanbul (Çağlayan)',
        options: [
            { value: 'İstanbul 1. FSHHM', text: 'İstanbul 1. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'İstanbul 2. FSHHM', text: 'İstanbul 2. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'İstanbul 3. FSHHM', text: 'İstanbul 3. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'İstanbul 4. FSHHM', text: 'İstanbul 4. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'İstanbul FSHCM', text: 'İstanbul Fikri ve Sınai Haklar Ceza Mahkemesi' }
        ]
    },
    {
        label: 'İstanbul (Anadolu)',
        options: [
            { value: 'İstanbul Anadolu 1. FSHHM', text: 'İstanbul Anadolu 1. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'İstanbul Anadolu 2. FSHHM', text: 'İstanbul Anadolu 2. Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'İstanbul Anadolu FSHCM', text: 'İstanbul Anadolu Fikri ve Sınai Haklar Ceza Mahkemesi' }
        ]
    },
    {
        label: 'İzmir',
        options: [
            { value: 'İzmir FSHHM', text: 'İzmir Fikri ve Sınai Haklar Hukuk Mahkemesi' },
            { value: 'İzmir FSHCM', text: 'İzmir Fikri ve Sınai Haklar Ceza Mahkemesi' }
        ]
    },
    {
        label: 'Bursa',
        options: [
            { value: 'Bursa FSHHM', text: 'Bursa Fikri ve Sınai Haklar Hukuk Mahkemesi' }
        ]
    },
    {
        label: 'Antalya',
        options: [
            { value: 'Antalya FSHHM', text: 'Antalya Fikri ve Sınai Haklar Hukuk Mahkemesi' }
        ]
    },
    {
        label: 'Yüksek Yargı / Diğer',
        options: [
            { value: 'Yargıtay', text: 'Yargıtay' },
            { value: 'istinaf', text: 'Bölge Adliye Mahkemesi (İstinaf)' },
            { value: 'other', text: 'Diğer (Manuel Giriş)' }
        ]
    }
];

// Excel dışa aktarma için (ExcelJS kütüphanesini kullanır)
export async function exportTableToExcel(tableId, filename = 'rapor') {
    const table = document.getElementById(tableId);
    if (!table) {
        console.error(`Tablo bulunamadı: #${tableId}`);
        showNotification(`Hata: '${tableId}' ID'li tablo bulunamadı.`, 'error');
        return;
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Veriler');

    const headerRowHtml = table.querySelector('thead tr#portfolioTableHeaderRow');
    const headerCellsHtml = Array.from(headerRowHtml.children);

    let headersForExcel = [];
    let imageColExcelIndex = -1; 
    
    headerCellsHtml.forEach((th) => {
        const headerText = th.textContent.trim();
        if (headerText === 'İşlemler') {
            return; 
        }
        headersForExcel.push(headerText);
        if (headerText === 'Marka Görseli') {
            imageColExcelIndex = headersForExcel.length - 1; 
        }
    });
    worksheet.addRow(headersForExcel); 

    worksheet.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; 
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF1E3C72' } 
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    const rowsHtml = table.querySelectorAll('tbody tr'); 
    const imagePromises = [];

    rowsHtml.forEach((rowHtml) => {
        if (rowHtml.style.display === 'none') {
            return;
        }

        const rowData = new Array(headersForExcel.length).fill(''); 
        const cellsHtml = Array.from(rowHtml.children); 
        
        const cellMap = new Map(); 
        headerCellsHtml.forEach((th, htmlColIndex) => {
            const headerText = th.textContent.trim();
            if (headerText !== 'İşlemler') { 
                cellMap.set(headerText, cellsHtml[htmlColIndex]);
            }
        });

        headersForExcel.forEach((headerLabel, excelColIndex) => {
            const cell = cellMap.get(headerLabel); 

            if (!cell) { 
                rowData[excelColIndex] = ''; 
            } else if (headerLabel === 'Marka Görseli') { 
                const imgElement = cell.querySelector('img.trademark-image-thumbnail');
                if (imgElement && imgElement.src) {
                    rowData[excelColIndex] = ''; 
                    imagePromises.push(new Promise((resolve) => {
                        const img = new Image();
                        img.onload = () => {
                            const canvas = document.createElement('canvas');
                            const imgSize = 50; 
                            canvas.width = imgSize;
                            canvas.height = imgSize;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, imgSize, imgSize); 
                            const base64Data = canvas.toDataURL('image/png').split(';base64,')[1];
                            resolve({ 
                                base64: base64Data, 
                                excelCol: excelColIndex, 
                                rowHtmlElement: rowHtml 
                            }); 
                        };
                        img.onerror = () => {
                            console.warn("Resim yüklenemedi veya erişilemedi:", imgElement.src);
                            resolve(null); 
                        };
                        img.src = imgElement.src;
                    }));
                } else {
                    rowData[excelColIndex] = cell.textContent.trim() || '-'; 
                }
            } else { 
                rowData[excelColIndex] = cell.textContent.trim();
            }
        });
        worksheet.addRow(rowData); 
    });

    const loadedImages = await Promise.all(imagePromises);
    loadedImages.forEach(imgData => {
        if (imgData && imgData.base64) {
            const imageId = workbook.addImage({
                base64: imgData.base64,
                extension: 'png',
            });

            const rowIndexInVisibleHtmlRows = Array.from(table.querySelectorAll('tbody tr')).filter(r => r.style.display !== 'none').indexOf(imgData.rowHtmlElement);
            const excelRowNumber = rowIndexInVisibleHtmlRows + 2; 

            worksheet.addImage(imageId, {
                tl: { col: imgData.excelCol, row: excelRowNumber - 1 }, 
                ext: { width: 50, height: 50 } 
            });
            
            worksheet.getRow(excelRowNumber).height = 55; 
        }
    });

    worksheet.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, (cell) => {
            const columnText = cell.value ? cell.value.toString() : '';
            maxLength = Math.max(maxLength, columnText.length);
        });
        const headerLabel = headersForExcel[column.number - 1]; 
        if (headerLabel && headerLabel.includes('Marka Görseli')) { 
            column.width = 10; 
        } else {
            column.width = Math.max(maxLength + 2, 10); 
        }
    });
    
    const buffer = await workbook.xlsx.writeBuffer();
    saveAs(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${filename}.xlsx`);
    
    showNotification(`Tablo başarıyla '${filename}.xlsx' olarak dışa aktarıldı!`, 'success');
}

// PDF dışa aktarma için (html2pdf.js kütüphanesini varsayar)
export function exportTableToPdf(tableId, filename = 'rapor') {
    const table = document.getElementById(tableId);
    if (!table) {
        console.error(`Tablo bulunamadı: #${tableId}`);
        showNotification(`Hata: '${tableId}' ID'li tablo bulunamadı.`, 'error');
        return;
    }

    const printContent = table.cloneNode(true);
    
    const headerRow = printContent.querySelector('thead tr#portfolioTableHeaderRow');
    const filterRow = printContent.querySelector('thead tr#portfolioTableFilterRow');

    let actionsHeaderIndex = -1;
    if (headerRow) {
        Array.from(headerRow.children).forEach((th, index) => {
            if (th.textContent.includes('İşlemler')) {
                actionsHeaderIndex = index;
                th.remove(); 
            }
        });
    }

    if (filterRow) {
        filterRow.remove(); 
    }
    
    if (actionsHeaderIndex !== -1) {
        Array.from(printContent.querySelectorAll('tbody tr')).forEach(row => {
            if (row.children[actionsHeaderIndex]) {
                row.children[actionsHeaderIndex].remove(); 
            }
        });
    }

    Array.from(printContent.querySelectorAll('img.trademark-image-thumbnail')).forEach(img => {
        img.style.transition = 'none';
        img.style.transform = 'none';
        img.style.position = 'static';
        img.style.zIndex = 'auto';
        img.style.boxShadow = 'none';
        img.style.border = 'none';
        img.style.backgroundColor = 'transparent';
        img.style.padding = '0';
        img.style.width = '50px'; 
        img.style.height = '50px';
        img.style.objectFit = 'contain';

        const wrapper = img.closest('.trademark-image-wrapper');
        if (wrapper) {
            wrapper.style.position = 'static';
            wrapper.style.overflow = 'hidden';
            wrapper.style.height = 'auto';
            wrapper.style.width = 'auto';
        }
    });

    const opt = {
        margin: 10,
        filename: `${filename}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { 
            scale: 2, 
            logging: true, 
            dpi: 192, 
            letterRendering: true,
            onclone: (document) => {
                document.querySelectorAll('.trademark-image-thumbnail').forEach(img => {
                    img.style.transition = 'none';
                    img.style.transform = 'none';
                    img.style.position = 'static';
                    img.style.zIndex = 'auto';
                    img.style.boxShadow = 'none';
                    img.style.border = 'none';
                    img.style.backgroundColor = 'transparent';
                    img.style.padding = '0';
                    img.style.width = '50px'; 
                    img.style.height = '50px';
                    img.style.objectFit = 'contain';

                    const wrapper = img.closest('.trademark-image-wrapper');
                    if (wrapper) {
                        wrapper.style.position = 'static';
                        wrapper.style.overflow = 'hidden';
                        wrapper.style.height = 'auto';
                        wrapper.style.width = 'auto';
                    }
                });
            }
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
    };

    html2pdf().from(printContent).set(opt).save();
    showNotification(`Tablo başarıyla '${filename}.pdf' olarak dışa aktarıldı!`, 'success');
}

// --- Resmi Tatiller ve Tarih Hesaplama Fonksiyonları ---

export const TURKEY_HOLIDAYS = [
    // 2025 Tatilleri
    "2025-01-01", 
    "2025-03-30", 
    "2025-03-31", 
    "2025-04-01", 
    "2025-04-23", 
    "2025-05-01", 
    "2025-05-19", 
    "2025-06-06", 
    "2025-06-07", 
    "2025-06-08", 
    "2025-06-09", 
    "2025-07-15", 
    "2025-08-30", 
    "2025-10-29", 

    // 2026 Tatilleri
    "2026-01-01", 
    "2026-03-19", 
    "2026-03-20", 
    "2026-03-21", 
    "2026-03-22", 
    "2026-04-23", 
    "2026-05-01", 
    "2026-05-27", 
    "2026-05-28", 
    "2026-05-29", 
    "2026-05-30", 
    "2026-07-15", 
    "2026-08-30", 
    "2026-10-29"  
];

export function isWeekend(date) {
    const day = date.getDay(); 
    return day === 0 || day === 6;
}

export function isHoliday(date, holidays) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); 
    const day = String(date.getDate()).padStart(2, '0');
    const dateString = `${year}-${month}-${day}`; 

    return holidays.includes(dateString);
}

export function addMonthsToDate(date, months) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    
    const newDate = new Date(year, month + months, day);
    console.log(`DEBUG addMonthsToDate: ${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')} + ${months} ay = ${newDate.getFullYear()}-${String(newDate.getMonth()+1).padStart(2,'0')}-${String(newDate.getDate()).padStart(2,'0')}`);
    
    return newDate;
}

export function findNextWorkingDay(startDate, holidays) {
    let currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0); 

    while (isWeekend(currentDate) || isHoliday(currentDate, holidays)) {
        currentDate.setDate(currentDate.getDate() + 1); 
    }
    return currentDate;
}

export const ORIGIN_TYPES = [
    { value: 'TÜRKPATENT', text: 'TÜRKPATENT' },
    { value: 'WIPO', text: 'WIPO' },
    { value: 'EUIPO', text: 'EUIPO' },
    { value: 'ARIPO', text: 'ARIPO' },
    { value: 'OAPI', text: 'OAPI' },
    { value: 'Yurtdışı Ulusal', text: 'Yurtdışı Ulusal' }
];

export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Supabase (PostgreSQL) ve standart JS Date uyumlu tarih formatlayıcı
 */
export function formatToTRDate(dateVal) {
    if (!dateVal) return '-';
    try {
        // 🔥 Eski Firestore .toDate() mantığı temizlendi, sadece native JS Date kullanılıyor
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return '-';
        
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
    } catch (e) { return '-'; }
}