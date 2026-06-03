// public/js/accrual-management/DebitNoteManager.js
import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

export class DebitNoteManager {
    static async generateAndSave(accrual, person, uiManager) {
        uiManager.toggleLoading(true);
        try {
            // 1. html2pdf kütüphanesini dinamik yükle (PDF oluşturmak için)
            await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');

            // 2. Kurları ve Toplamları Hesapla
            let expectedForeignTotals = {}; 
            let foreignItems = (accrual.items || []).filter(i => i.fee_type === 'Yurtdışı Maliyet');
            if (foreignItems.length === 0) foreignItems = (accrual.items || []).filter(i => i.fee_type !== 'Hizmet');
            
            if (foreignItems.length > 0) {
                foreignItems.forEach(i => {
                    const c = i.currency || 'EUR';
                    const amt = Number(i.total_amount) || 0;
                    const vatMult = accrual.applyVatToOfficialFee ? (1 + (Number(i.vat_rate || accrual.vatRate || 0) / 100)) : 1;
                    expectedForeignTotals[c] = (expectedForeignTotals[c] || 0) + (amt * vatMult);
                });
            }

            const balanceStrs = Object.entries(expectedForeignTotals).map(([c, a]) => uiManager._formatMoney(a, c));
            const balanceDisplay = balanceStrs.length > 0 ? balanceStrs.join(' + ') : '0.00 EUR';

            // 3. Tablo Satırlarını Oluştur
            let tableRowsHtml = '';
            if (foreignItems.length > 0) {
                foreignItems.forEach((item, index) => {
                    const qty = Number(item.quantity) || 1;
                    const rate = Number(item.unit_price) || 0;
                    const amount = Number(item.total_amount) || 0;
                    const cur = item.currency || 'EUR';
                    
                    tableRowsHtml += `
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center;">${index + 1}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd;">${item.item_name || '-'}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center;">${qty}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">${rate.toFixed(2)} ${cur}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">${amount.toFixed(2)} ${cur}</td>
                        </tr>
                    `;
                });
            }

            // 4. PDF İçin HTML Tasarımı (Neomark Şablonu)
            const container = document.createElement('div');
            container.innerHTML = `
                <div id="debitNoteContent" style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #333; font-size: 14px; background: white; width: 800px; margin: 0 auto;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 40px;">
                        <div>
                            <h1 style="margin: 0; font-size: 28px; color: #1e3c72; letter-spacing: 2px;">EVREKA</h1>
                            <p style="font-weight: bold; margin-bottom: 10px; font-size:13px; color:#333;">Intellectual Property & Law</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">Business Number: [VERGİ_NO]</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">Kavaklıdere Mah. Tunalı Hilmi Cad.</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">Ankara, 06680, Türkiye</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">info@evrekagroup.com</p>
                        </div>
                        <div style="text-align: left;">
                            <h2 style="font-size: 24px; color: #333; margin-bottom: 5px; font-weight: normal; letter-spacing: 1px;">DEBIT NOTE</h2>
                            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                                <tr><th style="text-align: left; padding: 5px 15px 5px 0; color: #555;">Note No.:</th><td style="padding: 5px 0;">${accrual.id}</td></tr>
                                <tr><th style="text-align: left; padding: 5px 15px 5px 0; color: #555;">Note Date:</th><td style="padding: 5px 0;">${new Date().toLocaleDateString('en-GB')}</td></tr>
                                <tr><th style="text-align: left; padding: 5px 15px 5px 0; color: #555;">Terms:</th><td style="padding: 5px 0;">Due on Receipt</td></tr>
                            </table>
                        </div>
                    </div>

                    <div style="margin-bottom: 40px; width: 50%;">
                        <p style="margin-bottom: 5px; color: #777;">To:</p>
                        <strong style="display: block; margin-bottom: 10px; font-size: 16px;">${person.name}</strong>
                        <p style="margin: 0; line-height: 1.5;">${person.address || ''}</p>
                        <p style="margin: 0; line-height: 1.5;">${person.countryCode || ''}</p>
                    </div>

                    <div style="background-color: #f9f9f9; padding: 15px; margin-bottom: 30px; border-left: 4px solid #1e3c72; line-height: 1.5;">
                        ${accrual.invoiceDescription || accrual.description || accrual.subject || accrual.taskTitle || 'Professional Services'}
                    </div>

                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 40px;">
                        <thead>
                            <tr>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: center; width: 5%;">#</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: left; width: 55%;">Item & Description</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: center; width: 10%;">Qty</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: right; width: 15%;">Rate</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: right; width: 15%;">Amount</th>
                            </tr>
                        </thead>
                        <tbody>${tableRowsHtml}</tbody>
                    </table>

                    <div style="display: flex; justify-content: space-between;">
                        <div style="width: 55%; font-size: 13px; line-height: 1.8; color: #555; margin-top: 10px;">
                            <h4 style="color: #333; margin-bottom: 10px; margin-top: 0;">Bank details for payment via wire transfer</h4>
                            <strong>Beneficiary:</strong> EVREKA Intellectual Property & Law, Ankara, Turkey<br>
                            <strong>IBAN (EUR):</strong> TR 6200 0100 1983 9142 7604 5002<br>
                            <strong>IBAN (USD):</strong> TR 3500 0100 1983 9142 7604 5003<br>
                            <strong>SWIFT:</strong> TCZBTR2A<br>
                            <strong>Bank Name:</strong> T.C. Ziraat Bankası<br>
                            <strong>Bank Branch:</strong> Keklikpınarı / ANKARA<br>
                        </div>
                        
                        <table style="width: 40%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 10px; border-bottom: 1px solid #ddd;">Sub Total</td>
                                <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">${balanceDisplay}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px; font-weight: bold; font-size: 16px; border-top: 2px solid #333;">Balance Due</td>
                                <td style="padding: 10px; font-weight: bold; font-size: 16px; border-top: 2px solid #333; text-align: right;">${balanceDisplay}</td>
                            </tr>
                        </table>
                    </div>
                </div>
            `;

            // HTML'i ekranda gizlice oluştur
            container.style.position = 'absolute';
            container.style.left = '-9999px';
            document.body.appendChild(container);

            // 5. html2pdf ile PDF Blob üret
            const opt = {
                margin: 0,
                filename: `Debit_Note_${accrual.id}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };

            const pdfBlob = await html2pdf().set(opt).from(container.querySelector('#debitNoteContent')).output('blob');
            document.body.removeChild(container); // Gizli HTML'i temizle

            // 6. Supabase Storage'a Yükle
            const fileName = `debit_note_${accrual.id}_${Date.now()}.pdf`;
            const filePath = `accruals/${accrual.id}/${fileName}`;

            const { error: uploadError } = await supabase.storage.from('documents').upload(filePath, pdfBlob, { contentType: 'application/pdf' });
            if (uploadError) throw uploadError;

            const { data: urlData } = supabase.storage.from('documents').getPublicUrl(filePath);

            // 7. Accrual Documents tablosuna kaydet (Tahakkuk içine ekli belge olarak düşer)
            const { error: dbError } = await supabase.from('accrual_documents').insert({
                accrual_id: String(accrual.id),
                document_name: `Debit Note #${accrual.id}.pdf`,
                document_url: urlData.publicUrl,
                document_type: 'debit_note'
            });

            if (dbError) throw dbError;

            showNotification('Debit Note başarıyla oluşturuldu ve tahakkuka eklendi.', 'success');
            return true;

        } catch (error) {
            console.error("Debit Note Hatası:", error);
            showNotification('Debit Note oluşturulurken hata: ' + error.message, 'error');
            return false;
        } finally {
            uiManager.toggleLoading(false);
        }
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