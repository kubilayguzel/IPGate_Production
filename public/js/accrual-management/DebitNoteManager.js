// public/js/accrual-management/DebitNoteManager.js
import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

export class DebitNoteManager {
    static async generateAndSave(accrual, person, uiManager) {
        uiManager.toggleLoading(true);
        try {
            // 1. html2pdf kütüphanesini dinamik yükle
            await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');

            // 2. Note No Üretimi (Sayaç Motoru)
            const currentYear = new Date().getFullYear();
            const counterId = `debit_notes_${currentYear}`;
            let sequenceNo = 1;
            
            try {
                const { data: counterData } = await supabase.from('counters').select('last_id').eq('id', counterId).maybeSingle();
                sequenceNo = (counterData?.last_id || 0) + 1;
                await supabase.from('counters').upsert({ id: counterId, last_id: sequenceNo }, { onConflict: 'id' });
            } catch(e) {
                console.warn("Sayaç güncellenemedi.");
                sequenceNo = Date.now().toString().slice(-4);
            }

            const noteNo = `${currentYear}-${accrual.id}-${sequenceNo}`;

            // 3. Kalemleri Çek
            let billableItems = accrual.items || [];
            
            if (billableItems.length === 0) {
                if (accrual.officialFee && accrual.officialFee.amount > 0) {
                    billableItems.push({ fee_type: 'TP Harç', item_name: 'Official Fee', unit_price: accrual.officialFee.amount, quantity: 1, total_amount: accrual.officialFee.amount, currency: accrual.officialFee.currency, vat_rate: 0 });
                }
                if (accrual.serviceFee && accrual.serviceFee.amount > 0) {
                    billableItems.push({ fee_type: 'Hizmet', item_name: 'Service Fee', unit_price: accrual.serviceFee.amount, quantity: 1, total_amount: accrual.serviceFee.amount, currency: accrual.serviceFee.currency, vat_rate: accrual.vatRate || 20 });
                }
            }

            // 4. Tablo Satırlarını Oluştur ve Genel Toplamı Hesapla
            let tableRowsHtml = '';
            let expectedForeignTotals = {}; 

            if (billableItems.length > 0) {
                billableItems.forEach((item, index) => {
                    const qty = Number(item.quantity) || 1;
                    const rate = Number(item.unit_price) || 0;
                    const cur = item.currency || 'EUR';
                    
                    const isTP = item.fee_type && (item.fee_type.includes('TP Hizmet') || item.fee_type.includes('TP Harç') || item.fee_type.includes('Resmi'));
                    const vatRate = isTP ? 0 : Number(item.vat_rate || 0);
                    
                    const baseAmount = rate * qty;
                    const taxAmount = baseAmount * (vatRate / 100);
                    const finalAmount = baseAmount + taxAmount;

                    expectedForeignTotals[cur] = (expectedForeignTotals[cur] || 0) + finalAmount;
                    
                    let englishItemName = item.item_name || '-';
                    const fType = item.fee_type || '';
                    
                    if (isTP) {
                        englishItemName = 'TURKPATENT Official Fee';
                    } else if (fType.includes('Hizmet') || fType.includes('Hukuk')) {
                        englishItemName = 'EVREKA Service Fee';
                    } else if (fType.includes('Yurtdışı Maliyet')) {
                        englishItemName = 'Foreign Attorney / Official Fee';
                    } else if (fType.includes('Masraf')) {
                        englishItemName = 'Disbursements / Expenses';
                    } else if (fType.includes('Kur Farkı')) {
                        englishItemName = 'Exchange Rate Difference';
                    } else {
                        englishItemName = this._translateToEnglish(englishItemName); 
                    }
                    
                    // Tipografi uygulandı: İnce Font (#666, 12px)
                    tableRowsHtml += `
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center; color: #666; font-size: 12px;">${index + 1}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; color: #666; font-size: 12px;">${englishItemName}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center; color: #666; font-size: 12px;">${qty}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; color: #666; font-size: 12px;">${rate.toFixed(2)} ${cur}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; color: #666; font-size: 12px;">%${vatRate}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; color: #666; font-size: 12px;">${finalAmount.toFixed(2)} ${cur}</td>
                        </tr>
                    `;
                });
            }

            const balanceStrs = Object.entries(expectedForeignTotals).map(([c, a]) => uiManager._formatMoney(a, c));
            const balanceDisplay = balanceStrs.length > 0 ? balanceStrs.join(' + ') : '0.00 EUR';

            // 5. Logoyu Çek
            const logoUrl = window.location.origin + '/evreka-logo.png';
            const base64Logo = await this._getBase64Image(logoUrl);
            const logoHtml = base64Logo 
                ? `<img src="${base64Logo}" alt="EVREKA" style="max-height: 55px; object-fit: contain; margin-bottom: 15px;">` 
                : `<h1 style="margin: 0; font-size: 28px; color: #1e3c72; letter-spacing: 2px;">EVREKA</h1>`;

            const subjectText = this._translateToEnglish(accrual.invoiceDescription || accrual.description || accrual.subject || accrual.taskTitle || 'Professional Services');

            // 6. PDF İçin HTML Tasarımı (Tipografi + Banka Konumu Güncellendi)
            const container = document.createElement('div');
            container.innerHTML = `
                <div id="debitNoteContent" style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; background: white; width: 800px; margin: 0 auto; box-sizing: border-box;">
                    
                    <div style="display: flex; justify-content: space-between; margin-bottom: 40px;">
                        <div>
                            ${logoHtml}
                            <p style="margin: 0 0 10px 0; color: #333; font-size: 13px; font-weight: bold;">EVREKA Intellectual Property & Law</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">Tax Number: 3830788579</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">YDA CENTER, Kızılırmak Mahallesi Dumlupınar Bulvarı</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">1443. Cadde 9/A3 Lobi 8.Kat No:281 Çankaya/ANKARA</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">Türkiye</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">info@evrekagroup.com</p>
                        </div>
                        <div style="text-align: left;">
                            <h2 style="font-size: 20px; color: #333; margin-top: 0; margin-bottom: 15px; font-weight: bold; letter-spacing: 1.5px;">DEBIT NOTE</h2>
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 5px 15px 5px 0; color: #333; font-size: 13px; font-weight: bold;">Note No.:</td>
                                    <td style="padding: 5px 0; color: #666; font-size: 12px;">${noteNo}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 5px 15px 5px 0; color: #333; font-size: 13px; font-weight: bold;">Note Date:</td>
                                    <td style="padding: 5px 0; color: #666; font-size: 12px;">${new Date().toLocaleDateString('en-GB')}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 5px 15px 5px 0; color: #333; font-size: 13px; font-weight: bold;">Terms:</td>
                                    <td style="padding: 5px 0; color: #666; font-size: 12px;">Due on Receipt</td>
                                </tr>
                            </table>
                        </div>
                    </div>

                    <div style="margin-bottom: 40px; width: 60%;">
                        <p style="margin: 0 0 5px 0; color: #666; font-size: 12px;">To:</p>
                        <p style="margin: 0 0 5px 0; color: #333; font-size: 13px; font-weight: bold;">${person.name}</p>
                        <p style="margin: 0; line-height: 1.5; color: #666; font-size: 12px;">${person.address || ''}</p>
                        <p style="margin: 0; line-height: 1.5; color: #666; font-size: 12px;">${person.countryCode || ''}</p>
                    </div>

                    <div style="background-color: #f9f9f9; padding: 15px; margin-bottom: 30px; border-left: 4px solid #1e3c72; line-height: 1.5; color: #666; font-size: 12px;">
                        ${subjectText}
                    </div>

                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                        <thead>
                            <tr>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: center; width: 5%; color: #333; font-size: 13px; font-weight: bold;">#</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: left; width: 45%; color: #333; font-size: 13px; font-weight: bold;">Item & Description</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: center; width: 10%; color: #333; font-size: 13px; font-weight: bold;">Qty</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: right; width: 15%; color: #333; font-size: 13px; font-weight: bold;">Rate</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: right; width: 10%; color: #333; font-size: 13px; font-weight: bold;">Tax</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: right; width: 15%; color: #333; font-size: 13px; font-weight: bold;">Amount</th>
                            </tr>
                        </thead>
                        <tbody>${tableRowsHtml}</tbody>
                    </table>

                    <!-- Toplam Tablosu (Sağa dayalı) -->
                    <div style="display: flex; justify-content: flex-end; margin-bottom: 30px;">
                        <table style="width: 40%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 10px; border-bottom: 1px solid #ddd; color: #666; font-size: 12px;">Sub Total</td>
                                <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; color: #666; font-size: 12px;">${balanceDisplay}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px; color: #333; font-size: 13px; font-weight: bold; border-top: 2px solid #333;">Balance Due</td>
                                <td style="padding: 10px; color: #333; font-size: 14px; font-weight: bold; border-top: 2px solid #333; text-align: right;">${balanceDisplay}</td>
                            </tr>
                        </table>
                    </div>

                    <!-- Banka Detayları (Tamamen Balance Due Altında) -->
                    <div style="line-height: 1.6; padding-top: 20px; border-top: 1px solid #eee;">
                        <p style="margin: 0 0 8px 0; color: #333; font-size: 13px; font-weight: bold;">Bank details for payment via wire transfer</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">Beneficiary:</strong> EVREKA GROUP DANIŞMANLIK LİMİTED ŞİRKETİ, Ankara, Türkiye</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">IBAN (EUR):</strong> TR 0800 0150 0158 0480 2654 1634</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">IBAN (USD):</strong> TR 3200 0150 0158 0480 2335 7274</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">IBAN (CHF):</strong> TR 5600 0150 0158 0480 2654 1643</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">IBAN (GBP):</strong> TR 4000 0150 0158 0480 2654 1640</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">SWIFT:</strong> TVBATR2A</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">Bank Name:</strong> Türkiye Vakıflar Bankası T.A.O.</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">Bank Branch:</strong> Abidinpaşa / ANKARA</p>
                    </div>
                </div>
            `;

            container.style.position = 'absolute';
            container.style.left = '-9999px';
            document.body.appendChild(container);

            // 7. PDF Üret
            const opt = {
                margin: 0,
                filename: `Debit_Note_${noteNo}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };

            const pdfBlob = await html2pdf().set(opt).from(container.querySelector('#debitNoteContent')).output('blob');
            document.body.removeChild(container);

            // 8. Storage'a Yükle ve Kaydet
            const fileName = `debit_note_${noteNo}_${Date.now()}.pdf`;
            const filePath = `accruals/${accrual.id}/${fileName}`;

            const { error: uploadError } = await supabase.storage.from('documents').upload(filePath, pdfBlob, { contentType: 'application/pdf' });
            if (uploadError) throw uploadError;

            const { data: urlData } = supabase.storage.from('documents').getPublicUrl(filePath);

            const { error: dbError } = await supabase.from('accrual_documents').insert({
                accrual_id: String(accrual.id),
                document_name: `Debit Note #${noteNo}.pdf`,
                document_url: urlData.publicUrl,
                document_type: 'debit_note'
            });

            if (dbError) throw dbError;

            showNotification('Debit Note başarıyla oluşturuldu ve tahakkuka eklendi.', 'success');
            
            // 9. İndirme/Görüntüleme: Yeni sekmede aç
            window.open(urlData.publicUrl, '_blank');

            return true;

        } catch (error) {
            console.error("Debit Note Hatası:", error);
            showNotification('Debit Note oluşturulurken hata: ' + error.message, 'error');
            return false;
        } finally {
            uiManager.toggleLoading(false);
        }
    }

    static async _getBase64Image(url) {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            console.warn("Logo base64'e çevrilemedi, metin kullanılacak.", e);
            return '';
        }
    }

    static _translateToEnglish(text) {
        if (!text) return '-';
        let t = text;
        
        const dict = {
            'karara itiraz': 'Appeal against Decision',
            'yayına itiraz': 'Opposition to Publication',
            'itiraz': 'Opposition / Appeal',
            'savunma': 'Defense',
            'devir': 'Assignment',
            'unvan değişikliği': 'Change of Name',
            'adres değişikliği': 'Change of Address',
            'sureti': 'Certified Copy',
            'suret': 'Certified Copy',
            'rüçhan': 'Priority',
            'yenileme': 'Renewal',
            'tescili': 'Registration',
            'tescil': 'Registration',
            'başvuru': 'Application',
            'marka': 'Trademark'
        };

        const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
        
        keys.forEach(k => {
            const regexStr = k.split('').map(char => {
                if (char === 'i' || char === 'İ') return '[iİIı]';
                if (char === 'ı' || char === 'I') return '[ıIİi]';
                if (char === 'ş' || char === 'Ş') return '[şŞsS]';
                if (char === 'ğ' || char === 'Ğ') return '[ğĞgG]';
                if (char === 'ü' || char === 'Ü') return '[üÜuU]';
                if (char === 'ö' || char === 'Ö') return '[öÖoO]';
                if (char === 'ç' || char === 'Ç') return '[çÇcC]';
                if (char === ' ') return '\\s+';
                return char;
            }).join('');
            
            const regex = new RegExp(regexStr, 'gi');
            t = t.replace(regex, dict[k]);
        });
        
        return t.trim();
    }

    static _loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
            const script = document.createElement('script'); 
            script.src = src; script.onload = resolve; script.onerror = reject; 
            document.head.appendChild(script);
        });
    }
}