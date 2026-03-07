// js/utils.js

// Bildirimleri göstermek için kullanılan fonksiyon
export function showNotification(message, type = 'info', duration = 3000) {
    const container = document.getElementById('notification-container');
    if (!container) {
        console.warn('Bildirim konteyneri bulunamadı: #notification-container');
        alert(message); // Fallback to alert if container not found
        return;
    }

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

    // Fallback: Eğer eleman 2 sn içinde DOM'dan kaldırılmışsa alert göster
    setTimeout(() => {
        if (!document.body.contains(notificationItem)) {
            alert(message);
        }
    }, 2000);

    // Otomatik olarak kaybolma
    if (effectiveDuration > 0) {
        setTimeout(() => {
            notificationItem.classList.add('hide');
            notificationItem.addEventListener('transitionend', () => notificationItem.remove());
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

// Görev durumları (task-management.html ve task-update.html'de kullanılır)
export const TASK_STATUSES = [
    { value: 'open', text: 'Açık' },
    { value: 'in-progress', text: 'Devam Ediyor' },
    { value: 'completed', text: 'Tamamlandı' },
    { value: 'pending', text: 'Beklemede' },
    { value: 'cancelled', text: 'İptal Edildi' },
    { value: 'on-hold', text: 'Askıda' },
    { value: 'awaiting_client_approval', text: 'Müvekkil Onayı Bekliyor' } // Yeni durum eklendi
];

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
    ]
};

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
    let imageColExcelIndex = -1; // 0-based index in the final Excel rowData array
    
    // Determine the columns to export and their final order in Excel
    headerCellsHtml.forEach((th) => {
        const headerText = th.textContent.trim();
        if (headerText === 'İşlemler') {
            return; // Skip Actions column
        }
        headersForExcel.push(headerText);
        if (headerText === 'Marka Görseli') {
            imageColExcelIndex = headersForExcel.length - 1; // 0-based index in headersForExcel
        }
    });
    worksheet.addRow(headersForExcel); // Add header row

    // Apply header style
    worksheet.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; // White font
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF1E3C72' } // Dark blue background (#1e3c72)
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    // 2. Add Table Data and Images
    const rowsHtml = table.querySelectorAll('tbody tr'); // Original table rows
    const imagePromises = [];

    rowsHtml.forEach((rowHtml) => {
        // Only process visible rows (filtered by display style)
        if (rowHtml.style.display === 'none') {
            return;
        }

        const rowData = new Array(headersForExcel.length).fill(''); // Excel'e gidecek satır verisi için boş dizi oluştur
        const cellsHtml = Array.from(rowHtml.children); // Cells of the current HTML row
        
        // Use a map for robust cell-to-header mapping
        const cellMap = new Map(); // Map: headerText -> cellElement
        headerCellsHtml.forEach((th, htmlColIndex) => {
            const headerText = th.textContent.trim();
            if (headerText !== 'İşlemler') { // Only map columns we intend to export
                cellMap.set(headerText, cellsHtml[htmlColIndex]);
            }
        });

        headersForExcel.forEach((headerLabel, excelColIndex) => {
            const cell = cellMap.get(headerLabel); // Get the corresponding HTML cell using headerLabel

            if (!cell) { // If HTML cell is missing for this column (e.g., dynamic column not rendered)
                rowData[excelColIndex] = ''; 
            } else if (headerLabel === 'Marka Görseli') { // Image column
                const imgElement = cell.querySelector('img.trademark-image-thumbnail');
                if (imgElement && imgElement.src) {
                    // Placeholder for the image cell in rowData. The image will be added separately.
                    rowData[excelColIndex] = ''; 
                    // Promise'i burada oluşturup, resolve içinde Excel'deki satır numarasını dinamik olarak alacağız
                    imagePromises.push(new Promise((resolve) => {
                        const img = new Image();
                        img.onload = () => {
                            const canvas = document.createElement('canvas');
                            const imgSize = 50; // Standard size for thumbnail in Excel
                            canvas.width = imgSize;
                            canvas.height = imgSize;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, imgSize, imgSize); 
                            const base64Data = canvas.toDataURL('image/png').split(';base64,')[1];
                            resolve({ 
                                base64: base64Data, 
                                excelCol: excelColIndex, // 0-based Excel column index for addImage
                                // rowHtmlElement'i döndürüp, sonraki adımda onun Excel'deki satır numarasını bulacağız.
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
                    rowData[excelColIndex] = cell.textContent.trim() || '-'; // Add text if no image
                }
            } else { // Other data columns
                rowData[excelColIndex] = cell.textContent.trim();
            }
        });
        worksheet.addRow(rowData); // Her görünür HTML satırı için bir Excel satırı ekle
        // actualExcelDataRowIndex kaldırıldı, addedRow.number kullanılacak
    });

    // Add images to Excel
    const loadedImages = await Promise.all(imagePromises);
    loadedImages.forEach(imgData => {
        if (imgData && imgData.base64) {
            const imageId = workbook.addImage({
                base64: imgData.base64,
                extension: 'png',
            });

            // Resmin ait olduğu HTML satırının Excel'deki gerçek satır numarasını bul
            // `rowHtmlElement`'in orijinal `rowsHtml` (visible olanlar) dizisindeki indeksini bulmalıyız.
            const rowIndexInVisibleHtmlRows = Array.from(table.querySelectorAll('tbody tr')).filter(r => r.style.display !== 'none').indexOf(imgData.rowHtmlElement);
            
            // `ExcelJS.Row` objesinin `number` özelliği 1-tabanlıdır.
            // İlk veri satırı (header sonrası) Excel'de 2. satır numarasında (index 1) yer alır.
            // Yani, (0-tabanlı visible HTML row index) + 2 = Excel'deki 1-tabanlı row number
            const excelRowNumber = rowIndexInVisibleHtmlRows + 2; 

            worksheet.addImage(imageId, {
                tl: { col: imgData.excelCol, row: excelRowNumber - 1 }, // `row` 0-tabanlı index bekler, o yüzden -1
                ext: { width: 50, height: 50 } // Resim boyutu
            });
            
            // Hücre yüksekliğini ayarla
            worksheet.getRow(excelRowNumber).height = 55; // Excel'deki 1-tabanlı rowNumber'ı kullan
        }
    });

    // Auto-adjust column widths
    worksheet.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, (cell) => {
            const columnText = cell.value ? cell.value.toString() : '';
            maxLength = Math.max(maxLength, columnText.length);
        });
        const headerLabel = headersForExcel[column.number - 1]; // Get header label (0-based array index)
        if (headerLabel && headerLabel.includes('Marka Görseli')) { 
            column.width = 10; // Fixed width for image column
        } else {
            column.width = Math.max(maxLength + 2, 10); 
        }
    });
    
    // Save the file
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

    // Clone the table content for printing
    const printContent = table.cloneNode(true);
    
    // Remove Actions column and filter row
    const headerRow = printContent.querySelector('thead tr#portfolioTableHeaderRow');
    const filterRow = printContent.querySelector('thead tr#portfolioTableFilterRow');

    let actionsHeaderIndex = -1;
    if (headerRow) {
        Array.from(headerRow.children).forEach((th, index) => {
            if (th.textContent.includes('İşlemler')) {
                actionsHeaderIndex = index;
                th.remove(); // Remove header cell
            }
        });
    }

    if (filterRow) {
        filterRow.remove(); // Remove filter row
    }
    
    if (actionsHeaderIndex !== -1) {
        Array.from(printContent.querySelectorAll('tbody tr')).forEach(row => {
            if (row.children[actionsHeaderIndex]) {
                row.children[actionsHeaderIndex].remove(); // Remove action cell from each row
            }
        });
    }

    // Reset trademark image styles for PDF export
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
// --- YENİ EKLENEN KISIM: Resmi Tatiller ve Tarih Hesaplama Fonksiyonları ---

// Türkiye'nin 2025 ve 2026 yılları için resmi tatiller listesi (YYYY-MM-DD formatında)
export const TURKEY_HOLIDAYS = [
    // 2025 Tatilleri
    "2025-01-01", // Yılbaşı
    "2025-03-30", // Ramazan Bayramı 1. Gün (Arife: 2025-03-29 - Cumartesi, yarım gün - hafta sonu)
    "2025-03-31", // Ramazan Bayramı 2. Gün
    "2025-04-01", // Ramazan Bayramı 3. Gün
    "2025-04-23", // Ulusal Egemenlik ve Çocuk Bayramı
    "2025-05-01", // Emek ve Dayanışma Günü
    "2025-05-19", // Atatürk'ü Anma, Gençlik ve Spor Bayramı
    "2025-06-06", // Kurban Bayramı 1. Gün (Arife: 2025-06-05 - Perşembe, yarım gün)
    "2025-06-07", // Kurban Bayramı 2. Gün (Cumartesi - hafta sonu)
    "2025-06-08", // Kurban Bayramı 3. Gün (Pazar - hafta sonu)
    "2025-06-09", // Kurban Bayramı 4. Gün
    "2025-07-15", // Demokrasi ve Milli Birlik Günü
    "2025-08-30", // Zafer Bayramı (Cumartesi - hafta sonu)
    "2025-10-29", // Cumhuriyet Bayramı (Arife: 2025-10-28 - Salı, yarım gün)

    // 2026 Tatilleri
    "2026-01-01", // Yılbaşı
    "2026-03-19", // Ramazan Bayramı 1. Gün (Arife: 2026-03-18 - Çarşamba, yarım gün)
    "2026-03-20", // Ramazan Bayramı 2. Gün
    "2026-03-21", // Ramazan Bayramı 3. Gün (Cumartesi - hafta sonu)
    "2026-03-22", // Ramazan Bayramı 4. Gün (Pazar - hafta sonu)
    "2026-04-23", // Ulusal Egemenlik ve Çocuk Bayramı
    "2026-05-01", // Emek ve Dayanışma Günü
    "2026-05-27", // Kurban Bayramı 1. Gün (Arife: 2026-05-26 - Salı, yarım gün)
    "2026-05-28", // Kurban Bayramı 2. Gün
    "2026-05-29", // Kurban Bayramı 3. Gün
    "2026-05-30", // Kurban Bayramı 4. Gün (Cumartesi - hafta sonu)
    "2026-07-15", // Demokrasi ve Milli Birlik Günü
    "2026-08-30", // Zafer Bayramı (Pazar - hafta sonu)
    "2026-10-29"  // Cumhuriyet Bayramı (Arife: 2026-10-28 - Çarşamba, yarım gün)
];

/**
 * Bir tarihin hafta sonu olup olmadığını kontrol eder.
 * @param {Date} date - Kontrol edilecek tarih objesi.
 * @returns {boolean} - Hafta sonu ise true, değilse false.
 */
export function isWeekend(date) {
    const day = date.getDay(); // 0 for Sunday, 6 for Saturday
    return day === 0 || day === 6;
}

/**
 * Bir tarihin resmi tatil olup olmadığını kontrol eder.
 * Tatiller TURKEY_HOLIDAYS dizisinde YYYY-MM-DD formatında olmalıdır.
 * @param {Date} date - Kontrol edilecek tarih objesi.
 * @param {string[]} holidays - YYYY-MM-DD formatında tatil tarihleri dizisi.
 * @returns {boolean} - Tatil ise true, değilse false.
 */
export function isHoliday(date, holidays) {
    // YENİ: Tarihin yerel yıl, ay ve gün bileşenlerini kullanarak string oluştur
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Ay 0'dan başladığı için +1
    const day = String(date.getDate()).padStart(2, '0');
    const dateString = `${year}-${month}-${day}`; // YYYY-MM-DD formatı

    return holidays.includes(dateString);
}

/**
 * Bir tarihe belirtilen ay kadar ekler.
 * Yerel saat diliminde güvenli ay hesaplaması yapar.
 * @param {Date} date - Başlangıç tarihi.
 * @param {number} months - Eklenecek ay sayısı.
 * @returns {Date} - Yeni tarih objesi.
 */
export function addMonthsToDate(date, months) {
    // Yerel saat diliminde güvenli ay hesaplaması
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    
    // Yeni tarih objesi oluştur
    const newDate = new Date(year, month + months, day);
    
    // Debug için log ekle
    console.log(`DEBUG addMonthsToDate: ${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')} + ${months} ay = ${newDate.getFullYear()}-${String(newDate.getMonth()+1).padStart(2,'0')}-${String(newDate.getDate()).padStart(2,'0')}`);
    
    return newDate;
}

/**
 * Belirtilen tarihten itibaren bir sonraki ilk iş gününü bulur (hafta sonu ve resmi tatil kontrolü yaparak).
 * @param {Date} startDate - Başlangıç tarihi.
 * @param {string[]} holidays - YYYY-MM-DD formatında tatil tarihleri dizisi.
 * @returns {Date} - Bir sonraki ilk iş günü.
 */
export function findNextWorkingDay(startDate, holidays) {
    let currentDate = new Date(startDate);
    
    // Saati ve dakikayı sıfırla, böylece tarih karşılaştırmaları doğru olur
    currentDate.setHours(0, 0, 0, 0); 

    while (isWeekend(currentDate) || isHoliday(currentDate, holidays)) {
        currentDate.setDate(currentDate.getDate() + 1); // Bir sonraki güne geç
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