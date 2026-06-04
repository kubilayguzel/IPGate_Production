// public/js/accrual-management/DebitNoteManager.js
import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

export class DebitNoteManager {
    static async generateAndSave(accrual, person, uiManager) {
        uiManager.toggleLoading(true);
        try {
            // 1. html2pdf kütüphanesini dinamik yükle (PDF oluşturmak için)
            await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');

            // 2. Note No: Yıl - TahakkukNo - SıraNo Üretimi (Sayaç Motoru)
            const currentYear = new Date().getFullYear();
            const counterId = `debit_notes_${currentYear}`;
            let sequenceNo = 1;
            
            try {
                // Veritabanından bu yıla ait en son kaçıncı Debit Note'u kestiğimizi soruyoruz
                const { data: counterData } = await supabase.from('counters').select('last_id').eq('id', counterId).maybeSingle();
                sequenceNo = (counterData?.last_id || 0) + 1; // Üzerine 1 ekle
                // Sayacı güncelle ki bir sonraki işlemde aynısını vermesin
                await supabase.from('counters').upsert({ id: counterId, last_id: sequenceNo }, { onConflict: 'id' });
            } catch(e) {
                console.warn("Sayaç güncellenemedi, zaman damgası kullanılacak.");
                sequenceNo = Date.now().toString().slice(-4);
            }

            // Örnek: 2026-720-1
            const noteNo = `${currentYear}-${accrual.id}-${sequenceNo}`;

            // 3. Kurları ve Toplamları Hesapla
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

            // 4. Tablo Satırlarını Oluştur (Kapsamlı İngilizce Çeviri ile)
            let tableRowsHtml = '';
            if (foreignItems.length > 0) {
                foreignItems.forEach((item, index) => {
                    const qty = Number(item.quantity) || 1;
                    const rate = Number(item.unit_price) || 0;
                    const amount = Number(item.total_amount) || 0;
                    const cur = item.currency || 'EUR';
                    
                    // İngilizce Çeviri Motoruna Gönder
                    const englishItemName = this._translateToEnglish(item.item_name || '-');
                    
                    tableRowsHtml += `
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center;">${index + 1}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd;">${englishItemName}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center;">${qty}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">${rate.toFixed(2)} ${cur}</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right;">${amount.toFixed(2)} ${cur}</td>
                        </tr>
                    `;
                });
            }

            // 🔥 ÇÖZÜM 5 (LOGO): Logoyu hatasız basmak için Base64 formatına çeviriyoruz. 
            // html2pdf, Base64 formattaki resimleri daha sağlıklı pdf'e basar.
            const logoUrl = new URL('evreka-logo.png', window.location.href).href;
            const base64Logo = await this._getBase64Image(logoUrl);
            const logoHtml = base64Logo 
                ? `<img src="${base64Logo}" alt="EVREKA" style="max-height: 55px; object-fit: contain; margin-bottom: 10px;">` 
                : `<h1 style="margin: 0; font-size: 28px; color: #1e3c72; letter-spacing: 2px;">EVREKA</h1>`;

            const subjectText = this._translateToEnglish(accrual.invoiceDescription || accrual.description || accrual.subject || accrual.taskTitle || 'Professional Services');

            // 5. PDF İçin HTML Tasarımı (Sizin özel adres bilgileriniz ve banka detayı korundu)
            const container = document.createElement('div');
            container.innerHTML = `
                <div id="debitNoteContent" style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; color: #333; font-size: 14px; background: white; width: 800px; margin: 0 auto;">
                    
                    <div style="display: flex; justify-content: space-between; margin-bottom: 40px;">
                        <div>
                            ${logoHtml}
                            <p style="font-weight: bold; margin-bottom: 10px; font-size:13px; color:#333;">EVREKA Intellectual Property & Law</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">Tax Number:3830788579</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">Address: YDA CENTER, Kızılırmak Mahallesi Dumlupınar Bulvarı</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">1443. Cadde 9/A3 Lobi 8.Kat No:281 Çankaya/ANKARA</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">Ankara, 06680, Türkiye</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">info@evrekagroup.com</p>
                        </div>
                        <div style="text-align: left;">
                            <h2 style="font-size: 24px; color: #333; margin-bottom: 5px; font-weight: normal; letter-spacing: 1px;">DEBIT NOTE</h2>
                            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                                <tr><th style="text-align: left; padding: 5px 15px 5px 0; color: #555;">Note No.:</th><td style="padding: 5px 0;">${noteNo}</td></tr>
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
                        ${subjectText}
                    </div>

                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
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

                    <div style="display: flex; justify-content: flex-end; margin-bottom: 40px;">
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

                    <div style="font-size: 13px; line-height: 1.8; color: #555; border-top: 1px solid #ddd; padding-top: 20px; clear: both;">
                        <h4 style="color: #333; margin-bottom: 10px; margin-top: 0; font-size: 14px;">Bank details for payment via wire transfer</h4>
                        <strong>Beneficiary:</strong> EVREKA PATENT DANIŞMANLIK LİMİTED ŞİRKETİ, Ankara, Turkey<br>
                        <strong>IBAN (EUR):</strong> TR 6200 0100 1983 9142 7604 5002<br>
                        <strong>IBAN (USD):</strong> TR 3500 0100 1983 9142 7604 5003<br>
                        <strong>SWIFT:</strong> TCZBTR2A<br>
                        <strong>Bank Name:</strong> T.C. Ziraat Bankası<br>
                        <strong>Bank Branch:</strong> Keklikpınarı / ANKARA<br>
                    </div>
                </div>
            `;

            // HTML'i ekranda gizlice oluştur (html2pdf'in görebilmesi için)
            container.style.position = 'absolute';
            container.style.left = '-9999px';
            document.body.appendChild(container);

            // 6. html2pdf ile PDF Blob üret
            const opt = {
                margin: 0,
                filename: `Debit_Note_${noteNo}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };

            const pdfBlob = await html2pdf().set(opt).from(container.querySelector('#debitNoteContent')).output('blob');
            document.body.removeChild(container);

            // 7. Supabase Storage'a Yükle
            const fileName = `debit_note_${noteNo}_${Date.now()}.pdf`;
            const filePath = `accruals/${accrual.id}/${fileName}`;

            const { error: uploadError } = await supabase.storage.from('documents').upload(filePath, pdfBlob, { contentType: 'application/pdf' });
            if (uploadError) throw uploadError;

            const { data: urlData } = supabase.storage.from('documents').getPublicUrl(filePath);

            // 8. Accrual Documents tablosuna kaydet
            const { error: dbError } = await supabase.from('accrual_documents').insert({
                accrual_id: String(accrual.id),
                document_name: `Debit Note #${noteNo}.pdf`,
                document_url: urlData.publicUrl,
                document_type: 'debit_note'
            });

            if (dbError) throw dbError;

            showNotification('Debit Note başarıyla oluşturuldu ve tahakkuka eklendi.', 'success');
            
            // 🔥 YENİ: Başarıyla oluşturulduktan sonra YENİ SEKMEYE PDF'i gönder
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

    // 🔥 ÇÖZÜM 5 (LOGO): Resmi Base64'e çeviren yardımcı fonksiyon
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

    // 🔥 ÇÖZÜM 3 (ÇEVİRİ): Türkçe Karakterlere Dirençli Gelişmiş Çeviri Motoru
    static _translateToEnglish(text) {
        if (!text) return '-';
        let t = text;
        
        const dict = {
            'yurtdışı maliyet': 'Foreign Cost',
            'yurtdışı vekil ücreti': 'Foreign Attorney Fee',
            'yurtdışı resmi ücret': 'Foreign Official Fee',
            'resmi ücret tutarı': 'Official Fee Amount',
            'resmi ücret': 'Official Fee',
            'hizmet bedeli': 'Service Fee',
            'vekil ücreti': 'Attorney Fee',
            'hizmet ücreti': 'Service Fee',
            'hukuk danışmanlık': 'Legal Consultancy',
            'markasının yenilenmesi': 'Trademark Renewal',
            'marka yenileme': 'Trademark Renewal',
            'marka tescili': 'Trademark Registration',
            'marka tescil': 'Trademark Registration',
            'başvurusu': 'Application',
            'sayılı': 'No.',
            'markası': 'Trademark',
            'patent': 'Patent',
            'tasarım': 'Design',
            'masraf': 'Disbursements / Expenses'
        };

        const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
        
        keys.forEach(k => {
            // Türkçe ı, İ, ş, ğ gibi harfleri regex içinde esnek yakala
            const regexStr = k.split('').map(char => {
                if (char === 'i' || char === 'İ') return '[iİIı]';
                if (char === 'ı' || char === 'I') return '[ıIİi]';
                if (char === 'ş' || char === 'Ş') return '[şŞsS]';
                if (char === 'ğ' || char === 'Ğ') return '[ğĞgG]';
                if (char === 'ü' || char === 'Ü') return '[üÜuU]';
                if (char === 'ö' || char === 'Ö') return '[öÖoO]';
                if (char === 'ç' || char === 'Ç') return '[çÇcC]';
                return char;
            }).join('');
            
            const regex = new RegExp(regexStr, 'gi');
            t = t.replace(regex, dict[k]);
        });
        
        return t;
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