// public/js/leaves-manager.js
// İzin Yönetimi - güvenli bakiye, kişi bazlı yönetim ve eksi bakiye koruması

import { waitForAuthUser, supabase } from '../supabase-config.js';
import { loadSharedLayout } from './layout-loader.js';
import { TURKEY_HOLIDAYS, isWeekend, isHoliday } from '../utils.js';

document.addEventListener('DOMContentLoaded', async () => {
    const user = await waitForAuthUser({ requireAuth: true, redirectTo: 'index.html' });
    if (!user) return;

    await loadSharedLayout({ activeMenuLink: 'leaves.html' });

    let userRole = 'user';
    try {
        const { data: userData, error } = await supabase
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single();

        if (error) throw error;
        if (userData?.role) userRole = userData.role;
    } catch (e) {
        console.error('Rol okunamadı:', e);
    }

    const isManager = userRole === 'superadmin';
    const teamTabItem = document.getElementById('teamLeavesTabItem');
    if (isManager && teamTabItem) teamTabItem.style.display = 'block';

    let currentUserBalance = null;
    let teamUsers = [];
    let teamLeaves = [];
    let teamBalances = new Map();
    let selectedTeamUserId = '';

    $('#requestLeaveModal').on('show.bs.modal', function (e) {
        if (userRole === 'superadmin') {
            e.preventDefault();
            Swal.fire({
                title: 'Patronlara İzin Yok!',
                text: 'İzin almana gerek yok. Sen patron adamsın :)',
                icon: 'info',
                confirmButtonText: 'Haklısın 😎',
                confirmButtonColor: '#1e3c72'
            });
        }
    });

    const startDateInput = document.getElementById('leaveStartDate');
    const endDateInput = document.getElementById('leaveEndDate');
    const daysInput = document.getElementById('leaveDays');

    function numberOrZero(value) {
        const n = Number.parseFloat(value);
        return Number.isFinite(n) ? n : 0;
    }

    function parseLocalDate(dateText) {
        if (!dateText) return null;
        const parts = String(dateText).split('-').map(Number);
        if (parts.length !== 3 || parts.some(v => !Number.isFinite(v))) return null;
        return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
    }

    function formatDateTR(dateText) {
        const d = parseLocalDate(dateText);
        return d ? d.toLocaleDateString('tr-TR') : '-';
    }

    // Kanuni toplam hak ediş:
    // tamamlanan 1-5. hizmet yılları: 14'er gün
    // tamamlanan 6-14. hizmet yılları: 20'şer gün
    // tamamlanan 15. yıl ve sonrası: 26'şar gün
    function calculateStatutoryEarned(hireDateText, asOf = new Date()) {
        const hireDate = parseLocalDate(hireDateText);
        if (!hireDate || asOf < hireDate) return 0;

        let completedYears = asOf.getFullYear() - hireDate.getFullYear();
        const anniversaryThisYear = new Date(
            hireDate.getFullYear() + completedYears,
            hireDate.getMonth(),
            hireDate.getDate(),
            12, 0, 0, 0
        );

        if (asOf < anniversaryThisYear) completedYears -= 1;
        if (completedYears < 1) return 0;

        const firstBand = Math.min(completedYears, 5) * 14;
        const secondBand = Math.max(Math.min(completedYears, 14) - 5, 0) * 20;
        const thirdBand = Math.max(completedYears - 14, 0) * 26;

        return firstBand + secondBand + thirdBand;
    }

    function normalizeBalanceRow(row) {
        if (!row) return null;

        const statutoryEarned = row.earned_annual_leave !== undefined && row.earned_annual_leave !== null
            ? numberOrZero(row.earned_annual_leave)
            : calculateStatutoryEarned(row.hire_date);

        const manualAdjustment = numberOrZero(row.manual_adjustment);
        const used = numberOrZero(row.used_annual_leave);
        const totalEarned = statutoryEarned + manualAdjustment;

        return {
            userId: row.user_id,
            hireDate: row.hire_date,
            statutoryEarned,
            manualAdjustment,
            totalEarned,
            used,
            remaining: totalEarned - used
        };
    }

    async function getBalanceForUser(targetUserId) {
        // Yeni SQL kurulduysa her açılışta DB tarafında da senkronize eder.
        try {
            const { data, error } = await supabase.rpc('get_user_leave_balance', {
                p_user_id: targetUserId
            });

            if (!error && data) {
                const row = Array.isArray(data) ? data[0] : data;
                if (row) return normalizeBalanceRow(row);
            }

            // SQL henüz uygulanmadıysa ekranı bozma; mevcut tabloya düş.
            if (error) {
                console.warn('get_user_leave_balance RPC kullanılamadı, tablo fallback kullanılacak:', error.message);
            }
        } catch (e) {
            console.warn('Bakiye RPC hatası, tablo fallback kullanılacak:', e);
        }

        const { data, error } = await supabase
            .from('user_leave_balances')
            .select('*')
            .eq('user_id', targetUserId)
            .maybeSingle();

        if (error) throw error;
        if (!data) return null;

        // Eski DB fonksiyonu geçmiş kıdemi doldurmamış olsa bile ekranda doğru hak göster.
        const statutoryEarned = calculateStatutoryEarned(data.hire_date);
        return normalizeBalanceRow({
            ...data,
            earned_annual_leave: statutoryEarned
        });
    }

    function paintBalance(balance, ownerLabel = 'Benim Bakiyem', targetUserId = '') {
        const earnedEl = document.getElementById('statEarned');
        const usedEl = document.getElementById('statUsed');
        const remainingEl = document.getElementById('statRemaining');
        const hireDateEl = document.getElementById('hireDateText');
        const ownerEl = document.getElementById('balanceOwnerText');

        if (ownerEl) ownerEl.textContent = ownerLabel;

        if (!balance) {
            earnedEl.textContent = '0';
            usedEl.textContent = '0';
            remainingEl.textContent = '0';
            hireDateEl.textContent = 'İşe giriş tarihi sistemde tanımlı değil.';
            console.warn('[LEAVE-BALANCE] Kayıt bulunamadı', { targetUserId, ownerLabel });
            return;
        }

        const earned = numberOrZero(balance.totalEarned);
        const used = numberOrZero(balance.used);
        const remaining = earned - used;

        earnedEl.textContent = earned;
        usedEl.textContent = used;
        remainingEl.textContent = remaining;

        remainingEl.classList.toggle('text-danger', remaining < 0);
        remainingEl.classList.toggle('text-success', remaining >= 0);

        hireDateEl.textContent = `İşe Giriş: ${formatDateTR(balance.hireDate)}`;

        console.info('[LEAVE-BALANCE]', {
            authenticatedUserId: user.id,
            targetUserId: targetUserId || balance.userId,
            ownerLabel,
            earned,
            used,
            remaining,
            rawBalance: balance
        });
    }

    async function loadLeaveBalance() {
        try {
            currentUserBalance = await getBalanceForUser(user.id);
            paintBalance(currentUserBalance, 'Benim Bakiyem', user.id);
        } catch (error) {
            console.error('Bakiye yükleme hatası:', error);
            paintBalance(null, 'Benim Bakiyem', user.id);
        }
        return currentUserBalance;
    }

    function calculateNetWorkingDays() {
        const startDate = parseLocalDate(startDateInput.value);
        const endDate = parseLocalDate(endDateInput.value);

        if (!startDate || !endDate) {
            daysInput.value = '';
            return;
        }

        if (endDate < startDate) {
            daysInput.value = '';
            return;
        }

        let totalWorkingDays = 0;
        const currentDate = new Date(startDate);

        while (currentDate <= endDate) {
            if (!isWeekend(currentDate) && !isHoliday(currentDate, TURKEY_HOLIDAYS)) {
                totalWorkingDays += 1;
            }
            currentDate.setDate(currentDate.getDate() + 1);
        }

        daysInput.value = totalWorkingDays;
    }

    startDateInput?.addEventListener('change', calculateNetWorkingDays);
    endDateInput?.addEventListener('change', calculateNetWorkingDays);

    async function loadMyLeaves() {
        try {
            const { data, error } = await supabase
                .from('leave_requests')
                .select('*')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (error) throw error;

            const tbody = document.getElementById('myLeavesTableBody');

            if (!data?.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Henüz bir izin talebiniz bulunmuyor.</td></tr>';
                return;
            }

            tbody.innerHTML = data.map(leave => `
                <tr>
                    <td><strong>${escapeHtml(leave.leave_type)}</strong></td>
                    <td>${formatDateTR(leave.start_date)}</td>
                    <td>${formatDateTR(leave.end_date)}</td>
                    <td><span class="badge badge-light border">${numberOrZero(leave.requested_days)} Gün</span></td>
                    <td class="text-muted small">${escapeHtml(leave.description || '-')}</td>
                    <td>${getStatusBadge(leave.status)}</td>
                    <td class="text-muted small">${formatDateTR(String(leave.created_at || '').slice(0, 10))}</td>
                </tr>
            `).join('');
        } catch (error) {
            console.error('İzinleri yükleme hatası:', error);
            const tbody = document.getElementById('myLeavesTableBody');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger py-4">İzinler yüklenemedi: ${escapeHtml(error.message)}</td></tr>`;
            }
        }
    }

    function buildTeamUserOptions() {
        const filter = document.getElementById('teamUserFilter');
        if (!filter) return;

        const previous = selectedTeamUserId || filter.value || '';

        filter.innerHTML = [
            '<option value="">Tüm Personel</option>',
            ...teamUsers.map(u => {
                const label = u.display_name || u.email || u.id;
                return `<option value="${escapeHtml(u.id)}">${escapeHtml(label)}</option>`;
            })
        ].join('');

        if (teamUsers.some(u => u.id === previous)) {
            filter.value = previous;
            selectedTeamUserId = previous;
        } else {
            filter.value = '';
            selectedTeamUserId = '';
        }
    }

    async function refreshSelectedTeamBalanceSummary() {
        const summary = document.getElementById('teamUserBalanceSummary');
        if (!summary) return;

        if (!selectedTeamUserId) {
            summary.innerHTML = '<span class="text-muted">Bir personel seçerseniz hak edilen, kullanılan ve kalan yıllık izin burada gösterilir.</span>';
            paintBalance(currentUserBalance, 'Benim Bakiyem', user.id);
            return;
        }

        const person = teamUsers.find(u => u.id === selectedTeamUserId);
        const personName = person?.display_name || person?.email || 'Personel';

        let balance = null;
        try {
            balance = await getBalanceForUser(selectedTeamUserId);
            if (balance) teamBalances.set(selectedTeamUserId, balance);
        } catch (e) {
            console.error('Personel bakiye yükleme hatası:', e);
        }

        if (!balance) {
            summary.innerHTML = `
                <strong>${escapeHtml(personName)}</strong>
                <span class="ml-2 text-warning">İşe giriş tarihi / izin bakiyesi tanımlı değil.</span>
            `;
            paintBalance(null, `${personName} - Bakiye`, selectedTeamUserId);
            return;
        }

        paintBalance(balance, `${personName} - Bakiye`, selectedTeamUserId);

        const remaining = numberOrZero(balance.totalEarned) - numberOrZero(balance.used);
        const remainingClass = remaining < 0 ? 'text-danger' : 'text-success';
        summary.innerHTML = `
            <strong>${escapeHtml(personName)}</strong>
            <span class="ml-3">İşe Giriş: <b>${formatDateTR(balance.hireDate)}</b></span>
            <span class="ml-3">Hak Edilen: <b>${balance.totalEarned}</b></span>
            <span class="ml-3">Kullanılan: <b>${balance.used}</b></span>
            <span class="ml-3 ${remainingClass}">Kalan: <b>${remaining}</b></span>
        `;
    }

    function renderTeamLeaves() {
        const tbody = document.getElementById('teamLeavesTableBody');
        if (!tbody) return;

        const filtered = selectedTeamUserId
            ? teamLeaves.filter(l => l.user_id === selectedTeamUserId)
            : teamLeaves;

        if (!filtered.length) {
            const text = selectedTeamUserId
                ? 'Seçili personele ait izin talebi bulunmuyor.'
                : 'Onay bekleyen veya geçmiş ekip izni bulunmuyor.';
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">${text}</td></tr>`;
            return;
        }

        const userMap = new Map(teamUsers.map(u => [u.id, u]));

        tbody.innerHTML = filtered.map(leave => {
            const person = userMap.get(leave.user_id);
            const personName = person?.display_name || person?.email || 'Bilinmeyen Personel';

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
                    <td><strong>${escapeHtml(personName)}</strong></td>
                    <td>${escapeHtml(leave.leave_type)}</td>
                    <td>${formatDateTR(leave.start_date)} - ${formatDateTR(leave.end_date)}</td>
                    <td><span class="badge badge-info">${numberOrZero(leave.requested_days)} Gün</span></td>
                    <td class="text-muted small">${escapeHtml(leave.description || '-')}</td>
                    <td>${getStatusBadge(leave.status)}</td>
                    <td class="text-center">${actionButtons}</td>
                </tr>
            `;
        }).join('');

        document.querySelectorAll('.btn-approve').forEach(btn => {
            btn.addEventListener('click', e => updateLeaveStatus(e.currentTarget.dataset.id, 'approved'));
        });

        document.querySelectorAll('.btn-reject').forEach(btn => {
            btn.addEventListener('click', e => updateLeaveStatus(e.currentTarget.dataset.id, 'rejected'));
        });

        document.querySelectorAll('.btn-cancel-leave').forEach(btn => {
            btn.addEventListener('click', e => updateLeaveStatus(e.currentTarget.dataset.id, 'cancelled'));
        });

        document.querySelectorAll('.btn-edit-leave').forEach(btn => {
            btn.addEventListener('click', async e => {
                const leaveId = e.currentTarget.dataset.id;
                const oldDays = numberOrZero(e.currentTarget.dataset.days);

                const { value: newDays } = await Swal.fire({
                    title: 'İzin Süresini Güncelle',
                    html: `Mevcut Olarak Onaylanan: <b>${oldDays} Gün</b><br><br>Yeni izin süresini (Gün) giriniz:`,
                    input: 'number',
                    inputValue: oldDays,
                    inputAttributes: { step: '0.5', min: '0.5' },
                    showCancelButton: true,
                    confirmButtonText: 'Güncelle',
                    cancelButtonText: 'Vazgeç',
                    inputValidator: value => {
                        const parsed = Number.parseFloat(value);
                        if (!Number.isFinite(parsed) || parsed <= 0) return 'Gün sayısı 0’dan büyük olmalıdır.';
                        return null;
                    }
                });

                const parsedNewDays = Number.parseFloat(newDays);
                if (!Number.isFinite(parsedNewDays) || parsedNewDays === oldDays) return;

                try {
                    const { error } = await supabase
                        .from('leave_requests')
                        .update({
                            requested_days: parsedNewDays,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', leaveId);

                    if (error) throw error;

                    await Swal.fire('Başarılı', 'İzin süresi güncellendi ve bakiye yeniden hesaplandı.', 'success');
                    await loadTeamLeaves();
                } catch (err) {
                    showDbError(err);
                }
            });
        });
    }

    async function loadTeamLeaves() {
        if (!isManager) return;

        try {
            const [usersResult, leavesResult, balancesResult] = await Promise.all([
                supabase
                    .from('users')
                    .select('id, display_name, email, role, disabled')
                    .order('display_name', { ascending: true }),
                supabase
                    .from('leave_requests')
                    .select('*')
                    .order('created_at', { ascending: false }),
                supabase
                    .from('user_leave_balances')
                    .select('*')
            ]);

            if (usersResult.error) throw usersResult.error;
            if (leavesResult.error) throw leavesResult.error;
            if (balancesResult.error) throw balancesResult.error;

            teamUsers = (usersResult.data || [])
                .filter(u => u.role !== 'client' && u.role !== 'superadmin' && !u.disabled);

            teamLeaves = leavesResult.data || [];

            teamBalances = new Map(
                (balancesResult.data || []).map(row => {
                    const normalized = normalizeBalanceRow({
                        ...row,
                        earned_annual_leave: calculateStatutoryEarned(row.hire_date)
                    });
                    return [row.user_id, normalized];
                })
            );

            buildTeamUserOptions();
            renderTeamLeaves();
            await refreshSelectedTeamBalanceSummary();
        } catch (error) {
            console.error('Ekip izinleri yükleme hatası:', error);
            const tbody = document.getElementById('teamLeavesTableBody');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger py-4">Ekip izinleri yüklenemedi: ${escapeHtml(error.message)}</td></tr>`;
            }
        }
    }

    document.getElementById('teamUserFilter')?.addEventListener('change', async e => {
        selectedTeamUserId = e.target.value || '';
        renderTeamLeaves();
        await refreshSelectedTeamBalanceSummary();
    });

    document.getElementById('my-leaves-tab')?.addEventListener('shown.bs.tab', () => {
        paintBalance(currentUserBalance, 'Benim Bakiyem', user.id);
    });

    document.getElementById('team-leaves-tab')?.addEventListener('shown.bs.tab', async () => {
        await refreshSelectedTeamBalanceSummary();
    });

    async function updateLeaveStatus(leaveId, newStatus) {
        const actionTexts = {
            approved: 'onaylamak',
            rejected: 'reddetmek',
            cancelled: 'iptal etmek (bakiyeyi iade etmek)'
        };

        if (!confirm(`Bu izin talebini ${actionTexts[newStatus] || 'güncellemek'} istediğinize emin misiniz?`)) return;

        try {
            const { error } = await supabase
                .from('leave_requests')
                .update({
                    status: newStatus,
                    approved_by: user.id,
                    updated_at: new Date().toISOString()
                })
                .eq('id', leaveId);

            if (error) throw error;

            await Swal.fire('Başarılı!', 'İşlem başarıyla gerçekleştirildi.', 'success');

            await Promise.all([
                loadTeamLeaves(),
                loadLeaveBalance(),
                loadMyLeaves()
            ]);
        } catch (error) {
            showDbError(error);
        }
    }

    async function getPendingAnnualLeaveDays(targetUserId) {
        const { data, error } = await supabase
            .from('leave_requests')
            .select('requested_days')
            .eq('user_id', targetUserId)
            .eq('leave_type', 'Yıllık İzin')
            .eq('status', 'pending');

        if (error) throw error;
        return (data || []).reduce((sum, row) => sum + numberOrZero(row.requested_days), 0);
    }

    document.getElementById('btnSubmitLeave')?.addEventListener('click', async () => {
        const type = document.getElementById('leaveType').value;
        const start = document.getElementById('leaveStartDate').value;
        const end = document.getElementById('leaveEndDate').value;
        const days = Number.parseFloat(document.getElementById('leaveDays').value);
        const desc = document.getElementById('leaveDescription').value?.trim() || '';

        if (!start || !end || !Number.isFinite(days) || days <= 0) {
            Swal.fire('Uyarı', 'Lütfen tarihleri ve gün sayısını eksiksiz girin.', 'warning');
            return;
        }

        const startDate = parseLocalDate(start);
        const endDate = parseLocalDate(end);

        if (!startDate || !endDate || endDate < startDate) {
            Swal.fire('Uyarı', 'Bitiş tarihi başlangıç tarihinden önce olamaz.', 'warning');
            return;
        }

        try {
            if (type === 'Yıllık İzin') {
                const balance = await getBalanceForUser(user.id);

                if (!balance?.hireDate) {
                    Swal.fire(
                        'İşe Giriş Tarihi Eksik',
                        'Yıllık izin talebi oluşturabilmek için Kullanıcı Yönetimi ekranında işe giriş tarihinizin tanımlı olması gerekir.',
                        'warning'
                    );
                    return;
                }

                const pendingDays = await getPendingAnnualLeaveDays(user.id);
                const requestableBalance = balance.remaining - pendingDays;

                if (days > requestableBalance + 0.0001) {
                    Swal.fire({
                        title: 'Yetersiz İzin Bakiyesi',
                        html: `
                            Hak edilen toplam: <b>${balance.totalEarned} gün</b><br>
                            Kullanılan: <b>${balance.used} gün</b><br>
                            Onay bekleyen: <b>${pendingDays} gün</b><br>
                            Yeni talep için kullanılabilir: <b>${Math.max(requestableBalance, 0)} gün</b><br><br>
                            Talep edilen: <b>${days} gün</b>
                        `,
                        icon: 'warning',
                        confirmButtonText: 'Tamam'
                    });
                    return;
                }
            }

            const { error } = await supabase
                .from('leave_requests')
                .insert({
                    user_id: user.id,
                    leave_type: type,
                    start_date: start,
                    end_date: end,
                    requested_days: days,
                    description: desc,
                    status: 'pending'
                });

            if (error) throw error;

            await Swal.fire('Başarılı', 'İzin talebiniz yöneticinize iletildi.', 'success');

            $('#requestLeaveModal').modal('hide');
            document.getElementById('leaveRequestForm').reset();

            await Promise.all([
                loadMyLeaves(),
                loadLeaveBalance()
            ]);
        } catch (error) {
            showDbError(error);
        }
    });

    function showDbError(error) {
        const message = error?.message || 'Bilinmeyen bir hata oluştu.';
        const isBalanceError = /izin bakiyesi|bakiye yetersiz|insufficient/i.test(message);

        Swal.fire(
            isBalanceError ? 'Yetersiz İzin Bakiyesi' : 'Hata',
            message,
            isBalanceError ? 'warning' : 'error'
        );
    }

    function getStatusBadge(status) {
        if (status === 'approved') return '<span class="status-badge status-approved"><i class="fas fa-check mr-1"></i>Onaylandı</span>';
        if (status === 'rejected') return '<span class="status-badge status-rejected"><i class="fas fa-times mr-1"></i>Reddedildi</span>';
        if (status === 'cancelled') return '<span class="badge badge-secondary p-2">İptal Edildi</span>';
        return '<span class="status-badge status-pending"><i class="fas fa-hourglass-half mr-1"></i>Onay Bekliyor</span>';
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    await Promise.all([
        loadLeaveBalance(),
        loadMyLeaves()
    ]);

    if (isManager) {
        await loadTeamLeaves();
    }
});
