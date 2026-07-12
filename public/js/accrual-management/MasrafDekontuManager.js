// public/js/accrual-management/MasrafDekontuManager.js
import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

export class MasrafDekontuManager {
    static async generateAndSave(accrual, person, uiManager) {
        uiManager.toggleLoading(true);
        try {
            // 1. html2pdf kütüphanesini dinamik yükle
            await this._loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');

            // 2. Dekont No Üretimi (Sayaç Motoru)
            const currentYear = new Date().getFullYear();
            const counterId = `masraf_dekont_${currentYear}`;
            let sequenceNo = 1;
            
            try {
                const { data: counterData } = await supabase.from('counters').select('last_id').eq('id', counterId).maybeSingle();
                sequenceNo = (counterData?.last_id || 0) + 1;
                await supabase.from('counters').upsert({ id: counterId, last_id: sequenceNo }, { onConflict: 'id' });
            } catch(e) {
                console.warn("Sayaç güncellenemedi.");
                sequenceNo = Date.now().toString().slice(-4);
            }

            const dekontNo = `${currentYear}-${accrual.id}-${sequenceNo}`;

            // 3. Kalemleri Çek ve FİLTRELE
            let allItems = accrual.items || [];
            
            // 🔥 KRİTİK NOKTA: Sadece Hukuk Danışmanlık ve Hizmet OLMAYANLARI alıyoruz (Masraf, Harç, Kur Farkı vb.)
            let expenseItems = allItems.filter(i => {
                const type = (i.fee_type || '').toLowerCase();
                return !(type === 'hukuk danışmanlık' || type === 'hizmet');
            });

            if (expenseItems.length === 0) {
                showNotification("Bu tahakkukta masraf dekontuna eklenebilecek bir kalem bulunamadı.", "warning");
                return false;
            }

            // 4. Tablo Satırlarını Oluştur ve Genel Toplamı Hesapla
            let tableRowsHtml = '';
            let totalMap = {}; 

            expenseItems.forEach((item, index) => {
                const qty = Number(item.quantity) || 1;
                const rate = Number(item.unit_price) || 0;
                const cur = item.currency || 'TRY';
                const vatRate = Number(item.vat_rate || 0);
                
                const baseAmount = rate * qty;
                const taxAmount = baseAmount * (vatRate / 100);
                const finalAmount = baseAmount + taxAmount;

                totalMap[cur] = (totalMap[cur] || 0) + finalAmount;
                
                let itemName = item.item_name || item.fee_type || '-';
                
                tableRowsHtml += `
                    <tr>
                        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center; color: #666; font-size: 12px;">${index + 1}</td>
                        <td style="padding: 10px; border-bottom: 1px solid #ddd; color: #666; font-size: 12px;">${itemName}</td>
                        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: center; color: #666; font-size: 12px;">${qty}</td>
                        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; color: #666; font-size: 12px;">${rate.toFixed(2)} ${cur}</td>
                        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; color: #666; font-size: 12px;">%${vatRate}</td>
                        <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; color: #666; font-size: 12px;">${finalAmount.toFixed(2)} ${cur}</td>
                    </tr>
                `;
            });

            const balanceStrs = Object.entries(totalMap).map(([c, a]) => uiManager._formatMoney(a, c));
            const balanceDisplay = balanceStrs.length > 0 ? balanceStrs.join(' + ') : '0.00 TRY';

            // 5. Logoyu Çek
            const logoUrl = window.location.origin + '/evreka-hukuk.png';
            const base64Logo = await this._getBase64Image(logoUrl);
            const logoHtml = base64Logo 
                ? `<img src="${base64Logo}" alt="EVREKA" style="max-height: 55px; object-fit: contain; margin-bottom: 15px;">` 
                : `<h1 style="margin: 0; font-size: 28px; color: #1e3c72; letter-spacing: 2px;">EVREKA</h1>`;

            const subjectText = accrual.invoiceDescription || accrual.description || accrual.subject || accrual.taskTitle || 'Hukuki İşlem Masrafları';

            // 🔥 YENİ: SAS Kodu varsa tabloya eklenecek HTML satırı oluşturulur
            const orderCodeHtml = accrual.orderCode ? `
                <tr>
                    <td style="padding: 5px 15px 5px 0; color: #333; font-size: 13px; font-weight: bold;">SAS / Sipariş No:</td>
                    <td style="padding: 5px 0; color: #666; font-size: 12px; font-weight: bold;">${accrual.orderCode}</td>
                </tr>
            ` : '';

            // 6. PDF İçin HTML Tasarımı (Türkçe)
            const container = document.createElement('div');
            container.innerHTML = `
                <div id="dekontContent" style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; background: white; width: 800px; margin: 0 auto; box-sizing: border-box;">
                    
                        <div style="display: flex; justify-content: space-between; margin-bottom: 40px;">
                        <div>
                            ${logoHtml}
                            <p style="margin: 0 0 10px 0; color: #333; font-size: 13px; font-weight: bold;">Av. ALİ KÜÇÜKŞAHİN</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">TCKN: 65536071542 | Çankaya V.D.</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">YDA CENTER, Kızılırmak Mah. 1443. Cadde, 9/A3 Lobi</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">8. Kat. No:281 ÇANKAYA ANKARA /TÜRKİYE</p>
                            <p style="margin: 2px 0; color: #666; font-size: 12px;">alikucuksahin@evrekapatent.com</p>
                        </div>
                        <div style="text-align: left;">
                            <h2 style="font-size: 20px; color: #333; margin-top: 0; margin-bottom: 15px; font-weight: bold; letter-spacing: 1.5px;">MASRAF DEKONTU</h2>
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 5px 15px 5px 0; color: #333; font-size: 13px; font-weight: bold;">Dekont No:</td>
                                    <td style="padding: 5px 0; color: #666; font-size: 12px;">${dekontNo}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 5px 15px 5px 0; color: #333; font-size: 13px; font-weight: bold;">Tarih:</td>
                                    <td style="padding: 5px 0; color: #666; font-size: 12px;">${new Date().toLocaleDateString('tr-TR')}</td>
                                </tr>
                                ${orderCodeHtml}
                            </table>
                        </div>
                    </div>

                    <div style="margin-bottom: 40px; width: 60%;">
                        <p style="margin: 0 0 5px 0; color: #666; font-size: 12px;">Sayın:</p>
                        <p style="margin: 0 0 5px 0; color: #333; font-size: 13px; font-weight: bold;">${person.name}</p>
                        <p style="margin: 0; line-height: 1.5; color: #666; font-size: 12px;">${person.address || ''}</p>
                        <p style="margin: 0; line-height: 1.5; color: #666; font-size: 12px;">${person.province || ''} / ${person.countryCode || 'TR'}</p>
                    </div>

                    <div style="background-color: #f9f9f9; padding: 15px; margin-bottom: 30px; border-left: 4px solid #1e3c72; line-height: 1.5; color: #666; font-size: 12px;">
                        <strong>İşlem Özeti: </strong>${subjectText}
                    </div>

                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                        <thead>
                            <tr>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: center; width: 5%; color: #333; font-size: 13px; font-weight: bold;">#</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: left; width: 45%; color: #333; font-size: 13px; font-weight: bold;">Kalem & Açıklama</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: center; width: 10%; color: #333; font-size: 13px; font-weight: bold;">Adet</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: right; width: 15%; color: #333; font-size: 13px; font-weight: bold;">B. Fiyat</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: right; width: 10%; color: #333; font-size: 13px; font-weight: bold;">KDV</th>
                                <th style="background-color: #f4f4f4; padding: 10px; border-bottom: 2px solid #ddd; border-top: 2px solid #ddd; text-align: right; width: 15%; color: #333; font-size: 13px; font-weight: bold;">Tutar</th>
                            </tr>
                        </thead>
                        <tbody>${tableRowsHtml}</tbody>
                    </table>

                    <div style="display: flex; justify-content: flex-end; margin-bottom: 30px;">
                        <table style="width: 40%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 10px; color: #333; font-size: 13px; font-weight: bold; border-top: 2px solid #333;">GENEL TOPLAM</td>
                                <td style="padding: 10px; color: #333; font-size: 14px; font-weight: bold; border-top: 2px solid #333; text-align: right;">${balanceDisplay}</td>
                            </tr>
                        </table>
                    </div>

                    <div style="line-height: 1.6; padding-top: 20px; border-top: 1px solid #eee;">
                        <p style="margin: 0 0 8px 0; color: #333; font-size: 13px; font-weight: bold;">Banka Hesap Bilgileri</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">Alıcı:</strong> Av. ALİ KÜÇÜKŞAHİN</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">Banka:</strong> VAKIFBANK - Abidinpaşa / ANKARA</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">Para Birimi:</strong> Türk Lirası (TRY)</p>
                        <p style="margin: 2px 0; color: #666; font-size: 12px;"><strong style="color: #333; font-weight: bold;">IBAN:</strong> TR62 0001 5001 5800 7342 3745 41</p>
                    </div>
                </div>
            `;

            container.style.position = 'absolute';
            container.style.left = '-9999px';
            document.body.appendChild(container);

            // 7. PDF Üret
            const opt = {
                margin: 0,
                filename: `Masraf_Dekontu_${dekontNo}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };

            const pdfBlob = await html2pdf().set(opt).from(container.querySelector('#dekontContent')).output('blob');
            document.body.removeChild(container);

            // 8. Storage'a Yükle ve Kaydet
            const fileName = `masraf_dekontu_${dekontNo}_${Date.now()}.pdf`;
            const filePath = `accruals/${accrual.id}/${fileName}`;

            const { error: uploadError } = await supabase.storage.from('documents').upload(filePath, pdfBlob, { contentType: 'application/pdf' });
            if (uploadError) throw uploadError;

            const { data: urlData } = supabase.storage.from('documents').getPublicUrl(filePath);

            const { error: dbError } = await supabase.from('accrual_documents').insert({
                accrual_id: String(accrual.id),
                document_name: `Masraf Dekontu #${dekontNo}.pdf`,
                document_url: urlData.publicUrl,
                document_type: 'masraf_dekontu'
            });

            if (dbError) throw dbError;

            showNotification('Masraf Dekontu başarıyla oluşturuldu ve eklere eklendi.', 'success');
            
            window.open(urlData.publicUrl, '_blank');

            return true;

        } catch (error) {
            console.error("Masraf Dekontu Hatası:", error);
            showNotification('Masraf Dekontu oluşturulurken hata: ' + error.message, 'error');
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
            return '';
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