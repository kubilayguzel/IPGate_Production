// public/js/dashboard/executive-dashboard.js

import { supabase } from '../../supabase-config.js';
import { showNotification } from '../../utils.js';

console.log("Executive Dashboard Manager Yüklendi.");

// State object to hold current filter values
const state = {
    startDate: null,
    endDate: null,
    rawTaskDistributionData: [], // To hold raw data for click events
    taskDistributionChart: null // To hold the chart instance
};

/**
 * Rastgele ve çekici renkler üretir.
 * @param {number} count - Üretilecek renk sayısı.
 * @returns {string[]} - Hex formatında renk dizisi.
 */
const generateCoolColors = (count) => {
    const colors = [
        '#4A90E2', '#50E3C2', '#F5A623', '#F8E71C', '#D0021B',
        '#BD10E0', '#9013FE', '#4A4A4A', '#B8E986', '#7ED321',
        '#9B9B9B', '#007BFF', '#28A745', '#DC3545', '#FFC107',
        '#17A2B8', '#6610F2', '#FD7E14', '#20C997', '#E83E8C'
    ];
    // Eğer istenen renk sayısı mevcut paletten fazlaysa, rastgele renkler üret
    while (colors.length < count) {
        colors.push('#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'));
    }
    return colors.slice(0, count);
};

/**
 * Görev dağılımı verilerini çeker ve grafiği oluşturur.
 */
async function renderTaskDistributionChart(data) {
    const chartContainer = document.getElementById('taskDistributionChart');
    if (!chartContainer) return;

    // Store raw data for click events
    state.rawTaskDistributionData = data;

    // Destroy previous chart instance if it exists
    if (state.taskDistributionChart) {
        state.taskDistributionChart.destroy();
    }

    if (!data || data.length === 0) {
        const ctx = chartContainer.getContext('2d');
        ctx.clearRect(0, 0, chartContainer.width, chartContainer.height);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#9B9B9B';
        ctx.font = '16px Montserrat';
        ctx.fillText('Seçilen kriterlere uygun görev dağılım verisi bulunamadı.', chartContainer.width / 2, chartContainer.height / 2);
        return;
    }

    const labels = data.map(d => d.user_name);
    const allStatuses = [...new Set(data.flatMap(d => Object.keys(d.status_counts)))];
    const statusColors = generateCoolColors(allStatuses.length);

    const datasets = allStatuses.map((status, index) => ({
        label: status,
        data: data.map(d => d.status_counts[status] || 0),
        backgroundColor: statusColors[index],
    }));

    state.taskDistributionChart = new Chart(chartContainer, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: 'Kullanıcı Bazında Görev Statü Dağılımı' },
                tooltip: { mode: 'index', intersect: false },
                },
                onClick: (evt) => {
                    const points = state.taskDistributionChart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true);
                    if (points.length) {
                        const firstPoint = points[0];
                        const user = state.rawTaskDistributionData[firstPoint.index];
                        if (user && user.user_id) {
                            showUserDetailModal(user.user_id, user.user_name);
                        }
                    }
            },
            scales: {
                x: { stacked: true },
                y: { stacked: true, beginAtZero: true }
            }
        }
    });
}

async function updateDashboardData() {
    try {
        const { data, error } = await supabase.rpc('get_task_distribution_stats', {
            start_date_param: state.startDate,
            end_date_param: state.endDate
        });
        if (error) throw error;
        await renderTaskDistributionChart(data);
    } catch (error) {
        console.error('Görev dağılımı grafiği hatası:', error);
        showNotification('Görev dağılımı verileri yüklenemedi.', 'error');
        chartContainer.innerHTML = '<p class="text-danger">Grafik yüklenirken bir hata oluştu.</p>';
    }
}

/**
 * Görev tamamlama sürelerini çeker ve tabloyu oluşturur.
 */
async function renderCompletionTimeTable() {
    const tableBody = document.getElementById('completionTimeTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = '<tr><td colspan="5" class="text-center"><i class="fas fa-spinner fa-spin"></i> Yükleniyor...</td></tr>';

    try {
        const { data, error } = await supabase.rpc('get_task_completion_time_stats');
        if (error) throw error;

        if (!data || data.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Analiz edilecek tamamlanmış görev verisi bulunamadı.</td></tr>';
            return;
        }

        tableBody.innerHTML = data.map(row => `
            <tr>
                <td><strong>${row.user_name}</strong></td>
                <td class="text-center">${row.completed_task_count}</td>
                <td class="text-center font-weight-bold text-primary">${row.avg_completion_days} gün</td>
                <td class="text-center text-success">${row.min_completion_days} gün</td>
                <td class="text-center text-danger">${row.max_completion_days} gün</td>
            </tr>
        `).join('');

    } catch (error) {
        console.error('Görev tamamlama süresi tablosu hatası:', error);
        showNotification('Görev tamamlama süreleri yüklenemedi.', 'error');
        tableBody.innerHTML = '<tr><td colspan="5" class="text-center text-danger">Veriler yüklenirken bir hata oluştu.</td></tr>';
    }
}

/**
 * Fetches user-specific data and displays it in a modal.
 * @param {string} userId - The UUID of the user.
 * @param {string} userName - The display name of the user.
 */
async function showUserDetailModal(userId, userName) {
    const modal = $('#userDetailModal');
    const modalTitle = $('#modalUserName');
    const modalBody = $('#modalBodyContent');

    modalTitle.text(`${userName} - İş Detayları`);
    modalBody.html('<div class="text-center p-5"><i class="fas fa-spinner fa-spin fa-3x"></i><p class="mt-2">Veriler yükleniyor...</p></div>');
    modal.modal('show');

    try {
        const { data, error } = await supabase.rpc('get_user_task_details', { user_id_param: userId });
        if (error) throw error;

        const stats = data.task_distribution.status_counts;
        const totalTasks = data.task_distribution.total_tasks;
        const completion = data.completion_stats;
        const recentTasks = data.recent_tasks;

        let statsHtml = '<div class="row">';
        for (const [status, count] of Object.entries(stats)) {
            statsHtml += `
                <div class="col-md-4 mb-3">
                    <div class="card shadow-sm">
                        <div class="card-body text-center">
                            <h4 class="card-title font-weight-bold">${count}</h4>
                            <p class="card-text text-muted small text-uppercase">${status}</p>
                        </div>
                    </div>
                </div>
            `;
        }
        statsHtml += '</div>';

        let recentTasksHtml = '<ul class="list-group list-group-flush">';
        if (recentTasks && recentTasks.length > 0) {
            recentTasks.forEach(task => {
                recentTasksHtml += `
                    <li class="list-group-item d-flex justify-content-between align-items-center">
                        <div>
                            <a href="task-update.html?id=${task.id}" target="_blank" class="font-weight-bold">${task.title}</a>
                            <small class="d-block text-muted">Son Tarih: ${task.due_date ? new Date(task.due_date).toLocaleDateString('tr-TR') : '-'}</small>
                        </div>
                        <span class="badge badge-primary badge-pill">${task.status}</span>
                    </li>
                `;
            });
        } else {
            recentTasksHtml += '<li class="list-group-item text-muted text-center">Aktif görev bulunmuyor.</li>';
        }
        recentTasksHtml += '</ul>';

        modalBody.html(`
            <h5 class="mb-3 text-primary">Genel İstatistikler</h5>
            <div class="row mb-4">
                <div class="col-md-6"><strong>Toplam Atanmış Görev:</strong> <span class="font-weight-bold">${totalTasks}</span></div>
                <div class="col-md-6"><strong>Ort. Tamamlama Süresi:</strong> <span class="font-weight-bold">${completion.avg_completion_days || 0} gün</span></div>
            </div>
            <h5 class="mb-3 text-primary">Duruma Göre Görev Dağılımı</h5>
            ${statsHtml}
            <h5 class="mt-4 mb-3 text-primary">Son Aktif Görevler</h5>
            ${recentTasksHtml}
        `);

    } catch (error) {
        console.error('Kullanıcı detayları alınamadı:', error);
        modalBody.html('<div class="alert alert-danger">Kullanıcı detayları yüklenirken bir hata oluştu.</div>');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // Chart.js kütüphanesinin yüklendiğinden emin ol
    if (typeof Chart === 'undefined') {
        console.error('Chart.js kütüphanesi bulunamadı! Lütfen HTML dosyanıza ekleyin.');
        return;
    }

    // 🔥 PERFORMANS İYİLEŞTİRMESİ: Verileri sırayla değil, aynı anda (Promise.all) çekiyoruz.
    try {
        await Promise.all([
            updateDashboardData(),
            renderCompletionTimeTable()
        ]);
    } catch (err) {
        console.error("Dashboard yüklenirken hata:", err);
    }

    // Filtreleme butonlarının dinleyicileri
    document.getElementById('applyTaskFilters')?.addEventListener('click', async () => {
        state.startDate = document.getElementById('startDateFilter').value || null;
        state.endDate = document.getElementById('endDateFilter').value || null;
        
        const btn = document.getElementById('applyTaskFilters');
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        btn.disabled = true;

        await updateDashboardData();

        btn.innerHTML = originalHtml;
        btn.disabled = false;
    });

    document.getElementById('clearTaskFilters')?.addEventListener('click', () => {
        document.getElementById('startDateFilter').value = '';
        document.getElementById('endDateFilter').value = '';
        state.startDate = null;
        state.endDate = null;
        updateDashboardData();
    });
});