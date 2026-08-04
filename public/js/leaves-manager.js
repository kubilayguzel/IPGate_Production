// public/js/leaves-manager.js

import { waitForAuthUser, supabase } from '../supabase-config.js';
import { loadSharedLayout } from './layout-loader.js';
import { TURKEY_HOLIDAYS, isWeekend, isHoliday } from '../utils.js'; // 🔥 YENİ: Tatil fonksiyonları eklendi

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Kullanıcıyı doğrula ve arayüzü yükle
    const user = await waitForAuthUser({ requireAuth: true, redirectTo: 'index.html' });
    if (!user) return;

    await loadSharedLayout({ activeMenuLink: 'leaves.html' });

    // 2. Kullanıcının rolünü Supabase'den kontrol et (Yönetici mi?)
    let userRole = 'user';
    try {
        const { data: userData } = await supabase.from('users').select('role').eq('id', user.id).single();
        if (userData && userData.role) userRole = userData.role;
    } catch (e) { console.error("Rol okunamadı:", e); }

    // Sadece patronlar (superadmin) onay ekranını görür
    const isManager = userRole === 'superadmin';
    if (isManager) {
        document.getElementById('teamLeavesTabItem').style.display = 'block';
    }

    // 🔥 YENİ: Patron izin almaya çalışırsa formu hiç açmadan mesajı göster
    $('#requestLeaveModal').on('show.bs.modal', function (e) {
        if (userRole === 'superadmin') {
            e.preventDefault(); // Modalin açılmasını engeller
            Swal.fire({
                title: 'Patronlara İzin Yok!',
                text: 'İzin almana gerek yok. Sen patron adamsın :)',
                icon: 'info',
                confirmButtonText: 'Haklısın 😎',
                confirmButtonColor: '#1e3c72'
            });
        }
    });

    // --- OTOMATİK İŞ GÜNÜ HESAPLAMA MOTORU ---
    const startDateInput = document.getElementById('leaveStartDate');
    const endDateInput = document.getElementById('leaveEndDate');
    const daysInput = document.getElementById('leaveDays');

    function calculateNetWorkingDays() {
        const startVal = startDateInput.value;
        const endVal = endDateInput.value;

        if (startVal && endVal) {
            const startDate = new Date(startVal);
            const endDate = new Date(endVal);

            // Bitiş tarihi başlangıçtan önceyse hesaplama yapma
            if (endDate < startDate) {
                daysInput.value = '';
                return;
            }

            let totalWorkingDays = 0;
            let currentDate = new Date(startDate);
            currentDate.setHours(0, 0, 0, 0);
            endDate.setHours(0, 0, 0, 0);

            // Başlangıçtan bitişe kadar gün gün döngü
            while (currentDate <= endDate) {
                // utils.js içindeki fonksiyonlarla Hafta Sonu ve Resmi Tatil kontrolü
                if (!isWeekend(currentDate) && !isHoliday(currentDate, TURKEY_HOLIDAYS)) {
                    totalWorkingDays += 1;
                }
                // Bir sonraki güne geç
                currentDate.setDate(currentDate.getDate() + 1);
            }

            // Hesaplanan net günü input'a yaz
            daysInput.value = totalWorkingDays;
        }
    }

    // Tarih alanları değiştiğinde hesaplamayı tetikle
    startDateInput.addEventListener('change', calculateNetWorkingDays);
    endDateInput.addEventListener('change', calculateNetWorkingDays);

    // --- TEMEL FONKSİYONLAR ---

    // Bakiyeyi Yükle
    async function loadLeaveBalance() {
        try {
            const { data, error } = await supabase.from('user_leave_balances').select('*').eq('user_id', user.id).single();
            
            if (error && error.code === 'PGRST116') {
                // Kayıt yoksa varsayılan göster
                document.getElementById('hireDateText').textContent = "İşe giriş tarihi sistemde tanımlı değil.";
                return;
            }

            if (data) {
                const totalEarned = parseFloat(data.earned_annual_leave || 0) + parseFloat(data.manual_adjustment || 0);
                const used = parseFloat(data.used_annual_leave || 0);
                const remaining = totalEarned - used;

                document.getElementById('statEarned').textContent = totalEarned;
                document.getElementById('statUsed').textContent = used;
                document.getElementById('statRemaining').textContent = remaining;

                const hireDate = new Date(data.hire_date).toLocaleDateString('tr-TR');
                document.getElementById('hireDateText').textContent = `İşe Giriş: ${hireDate}`;
            }
        } catch (error) {
            console.error("Bakiye yükleme hatası:", error);
        }
    }

    // Kendi İzinlerimi Yükle
    async function loadMyLeaves() {
        try {
            const { data, error } = await supabase.from('leave_requests').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
            if (error) throw error;

            const tbody = document.getElementById('myLeavesTableBody');
            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Henüz bir izin talebiniz bulunmuyor.</td></tr>';
                return;
            }

            tbody.innerHTML = data.map(leave => `
                <tr>
                    <td><strong>${leave.leave_type}</strong></td>
                    <td>${new Date(leave.start_date).toLocaleDateString('tr-TR')}</td>
                    <td>${new Date(leave.end_date).toLocaleDateString('tr-TR')}</td>
                    <td><span class="badge badge-light border">${leave.requested_days} Gün</span></td>
                    <td class="text-muted small">${leave.description || '-'}</td>
                    <td>${getStatusBadge(leave.status)}</td>
                    <td class="text-muted small">${new Date(leave.created_at).toLocaleDateString('tr-TR')}</td>
                </tr>
            `).join('');

        } catch (error) {
            console.error("İzinleri yükleme hatası:", error);
        }
    }

    // (Sadece Yöneticiler) Ekip İzinlerini Yükle
    async function loadTeamLeaves() {
        if (!isManager) return;
        try {
            // İlişkili users tablosundan personel adını da çekiyoruz (🔥 ÇÖZÜM: Hangi bağ olduğunu açıkça belirttik)
            const { data, error } = await supabase
                .from('leave_requests')
                .select('*, users!leave_requests_user_id_fkey(display_name, email)')
                .order('created_at', { ascending: false });
                
            if (error) throw error;

            const tbody = document.getElementById('teamLeavesTableBody');
            if (!data || data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Onay bekleyen ekip izni bulunmuyor.</td></tr>';
                return;
            }

            tbody.innerHTML = data.map(leave => {
                const personName = leave.users ? (leave.users.display_name || leave.users.email) : 'Bilinmeyen Personel';
                const sDate = new Date(leave.start_date).toLocaleDateString('tr-TR');
                const eDate = new Date(leave.end_date).toLocaleDateString('tr-TR');
                
                let actionButtons = '-';
                if (leave.status === 'pending') {
                    actionButtons = `
                        <div class="d-flex justify-content-center align-items-center" style="gap: 8px; white-space: nowrap;">
                            <button class="btn btn-sm btn-success btn-approve" data-id="${leave.id}" title="Onayla"><i class="fas fa-check"></i></button>
                            <button class="btn btn-sm btn-danger btn-reject" data-id="${leave.id}" title="Reddet"><i class="fas fa-times"></i></button>
                        </div>
                    `;
                } else if (leave.status === 'approved') {
                    actionButtons = `
                        <div class="d-flex justify-content-center align-items-center" style="gap: 8px; white-space: nowrap;">
                            <button class="btn btn-sm btn-warning btn-edit-leave text-dark" data-id="${leave.id}" data-days="${leave.requested_days}" title="Süreyi Düzenle"><i class="fas fa-edit"></i></button>
                            <button class="btn btn-sm btn-secondary btn-cancel-leave" data-id="${leave.id}" title="İzni İptal Et"><i class="fas fa-ban"></i></button>
                        </div>
                    `;
                }

                return `
                <tr>
                    <td><strong>${personName}</strong></td>
                    <td>${leave.leave_type}</td>
                    <td>${sDate} - ${eDate}</td>
                    <td><span class="badge badge-info">${leave.requested_days} Gün</span></td>
                    <td class="text-muted small">${leave.description || '-'}</td>
                    <td>${getStatusBadge(leave.status)}</td>
                    <td class="text-center">${actionButtons}</td>
                </tr>
            `}).join('');

            // Onay/Red Buton Dinleyicileri
            document.querySelectorAll('.btn-approve').forEach(btn => {
                btn.addEventListener('click', (e) => updateLeaveStatus(e.currentTarget.dataset.id, 'approved'));
            });
            document.querySelectorAll('.btn-reject').forEach(btn => {
                btn.addEventListener('click', (e) => updateLeaveStatus(e.currentTarget.dataset.id, 'rejected'));
            });

            // İptal Et Buton Dinleyicisi
            document.querySelectorAll('.btn-cancel-leave').forEach(btn => {
                btn.addEventListener('click', (e) => updateLeaveStatus(e.currentTarget.dataset.id, 'cancelled'));
            });

            // Düzenle (Süre Kısaltma/Uzatma) Buton Dinleyicisi
            document.querySelectorAll('.btn-edit-leave').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const leaveId = e.currentTarget.dataset.id;
                    const oldDays = e.currentTarget.dataset.days;
                    
                    const { value: newDays } = await Swal.fire({
                        title: 'İzin Süresini Güncelle',
                        html: `Mevcut Olarak Onaylanan: <b>${oldDays} Gün</b><br><br>Yeni izin süresini (Gün) giriniz:`,
                        input: 'number',
                        inputValue: oldDays,
                        inputAttributes: { step: '0.5', min: '0.5' },
                        showCancelButton: true,
                        confirmButtonText: 'Güncelle',
                        cancelButtonText: 'Vazgeç'
                    });

                    // Eğer yeni bir değer girildiyse ve eskisinden farklıysa
                    if (newDays && parseFloat(newDays) !== parseFloat(oldDays)) {
                        try {
                            const { error } = await supabase.from('leave_requests')
                                .update({ requested_days: parseFloat(newDays), updated_at: new Date().toISOString() })
                                .eq('id', leaveId);
                            
                            if (error) throw error;
                            Swal.fire('Başarılı', 'İzin süresi güncellendi ve personelin bakiyesi yeniden hesaplandı.', 'success');
                            await loadTeamLeaves();
                        } catch (err) {
                            Swal.fire('Hata', err.message, 'error');
                        }
                    }
                });
            });

        } catch (error) {
            console.error("Ekip izinleri yükleme hatası:", error);
        }
    }

    // İzin Durumunu Güncelle (Yönetici Aksiyonu)
    async function updateLeaveStatus(leaveId, newStatus) {
        let actionText = '';
        if (newStatus === 'approved') actionText = 'onaylamak';
        else if (newStatus === 'rejected') actionText = 'reddetmek';
        else if (newStatus === 'cancelled') actionText = 'iptal etmek (Bakiyeyi iade etmek)';

        if (!confirm(`Bu izin talebini ${actionText} istediğinize emin misiniz?`)) return;

        try {
            const { error } = await supabase.from('leave_requests')
                .update({ status: newStatus, approved_by: user.id, updated_at: new Date().toISOString() })
                .eq('id', leaveId);

            if (error) throw error;
            
            Swal.fire('Başarılı!', `İşlem başarıyla gerçekleştirildi.`, 'success');
            await loadTeamLeaves(); // Tabloyu yenile
            await loadLeaveBalance(); // (Eğer kendi iznini onayladıysa) Bakiyeyi yenile

        } catch (error) {
            Swal.fire('Hata', error.message, 'error');
        }
    }

    // Yeni İzin Talebi Gönderme
    document.getElementById('btnSubmitLeave').addEventListener('click', async () => {
        const type = document.getElementById('leaveType').value;
        const start = document.getElementById('leaveStartDate').value;
        const end = document.getElementById('leaveEndDate').value;
        const days = document.getElementById('leaveDays').value;
        const desc = document.getElementById('leaveDescription').value;

        if (!start || !end || !days) {
            Swal.fire('Uyarı', 'Lütfen tarihleri ve gün sayısını eksiksiz girin.', 'warning');
            return;
        }

        try {
            const { error } = await supabase.from('leave_requests').insert({
                user_id: user.id,
                leave_type: type,
                start_date: start,
                end_date: end,
                requested_days: parseFloat(days),
                description: desc,
                status: 'pending'
            });

            if (error) throw error;

            Swal.fire('Başarılı', 'İzin talebiniz yöneticinize iletildi.', 'success');
            $('#requestLeaveModal').modal('hide');
            document.getElementById('leaveRequestForm').reset();
            await loadMyLeaves();

        } catch (error) {
            Swal.fire('Hata', error.message, 'error');
        }
    });

    // Durum rozeti (UI Yardımcı)
    function getStatusBadge(status) {
        if (status === 'approved') return '<span class="status-badge status-approved"><i class="fas fa-check mr-1"></i>Onaylandı</span>';
        if (status === 'rejected') return '<span class="status-badge status-rejected"><i class="fas fa-times mr-1"></i>Reddedildi</span>';
        if (status === 'cancelled') return '<span class="badge badge-secondary p-2">İptal Edildi</span>';
        return '<span class="status-badge status-pending"><i class="fas fa-hourglass-half mr-1"></i>Onay Bekliyor</span>';
    }

    // --- BAŞLANGIÇ ÇAĞRILARI ---
    loadLeaveBalance();
    loadMyLeaves();
    if (isManager) loadTeamLeaves();
});