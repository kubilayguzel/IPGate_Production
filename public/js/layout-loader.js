// public/js/layout-loader.js

const LAYOUT_CACHE_KEY = 'app_layout_v2_html';
const MENU_CACHE_KEY = 'app_layout_v2_menu';

const menuItems = [
  { id: 'dashboard', text: 'Dashboard', link: 'dashboard.html', icon: 'fas fa-tachometer-alt', category: 'Ana Menü' },
  { id: 'portfolio-management-accordion', text: 'Portföy Yönetimi', icon: 'fas fa-folder', category: 'Portföy Yönetimi', subItems: [{ id: 'portfolio', text: 'Portföy', link: 'portfolio.html' }, { id: 'data-entry', text: 'Yeni Kayıt', link: 'data-entry.html' }, { id: 'tp-file-transfer', text: 'TPE Dosya Aktarımı', link: 'tp-file-transfer.html' }, { id: 'excel-upload', text: 'Excel ile Yükle', link: 'excel-upload.html', adminOnly: true }] },
  { id: 'reminders', text: 'Hatırlatmalar', link: 'reminders.html', icon: 'fas fa-bell', category: 'Yönetim' },
  { id: 'task-management-accordion', text: 'İş Yönetimi', icon: 'fas fa-briefcase', category: 'Yönetim', subItems: [{ id: 'task-management', text: 'İş Yönetimi', link: 'task-management.html' }, { id: 'my-tasks', text: 'İşlerim', link: 'my-tasks.html' }, { id: 'create-task', text: 'Yeni İş Oluştur', link: 'create-task.html', specialClass: 'new-task-link' }] },
  { id: 'new-tasks-accordion', text: 'Görevler', icon: 'fas fa-clipboard-check', category: 'Yönetim', subItems: [{ id: 'scheduled-tasks', text: 'Zamanlanmış Görevler', link: 'scheduled-tasks.html' }, { id: 'triggered-tasks', text: 'Tetiklenen Görevler', link: 'triggered-tasks.html' }, { id: 'client-notifications', text: 'Müvekkil Bildirimleri', link: 'notifications.html' }] },
  { id: 'person-management-accordion', text: 'Kişi Yönetimi', icon: 'fas fa-users', category: 'Yönetim', subItems: [{ id: 'persons', text: 'Kişiler Yönetimi', link: 'persons.html' }, { id: 'user-management', text: 'Kullanıcı Yönetimi', link: 'user-management.html', superAdminOnly: true }] },
  { id: 'accruals', text: 'Tahakkuklarım', link: 'accruals.html', icon: 'fas fa-file-invoice-dollar', category: 'Finans' },
  { id: 'indexing', text: 'Belge İndeksleme', link: 'bulk-indexing-page.html', icon: 'fas fa-folder-open', category: 'Araçlar' },
  { id: 'bulletin-management-accordion', text: 'Bülten Yönetimi', icon: 'fas fa-book', category: 'Araçlar', subItems: [{ id: 'bulletin-upload', text: 'Bülten Yükleme/Silme', link: 'bulletin-upload.html' }, { id: 'bulletin-search', text: 'Bülten Sorgulama', link: 'bulletin-search.html' }] },
  { id: 'monitoring-accordion', text: 'İzleme', icon: 'fas fa-eye', category: 'Araçlar', subItems: [{ id: 'trademark-similarity-search', text: 'Marka İzleme', link: 'trademark-similarity-search.html' }, { id: 'monitoring-trademarks', text: 'Marka İzleme Listesi', link: 'monitoring-trademarks.html' }] },
  { id: 'reports', text: 'Raporlar', link: '#', icon: 'fas fa-chart-line', category: 'Araçlar', disabled: true },
  { id: 'settings', text: 'Ayarlar', link: '#', icon: 'fas fa-cog', category: 'Araçlar', disabled: true }
];

export async function loadSharedLayout() {
  const placeholder = document.getElementById('layout-placeholder');
  if (!placeholder) return;

  // 1) Cache varsa hızlı bas
  const cachedHTML = localStorage.getItem(LAYOUT_CACHE_KEY);
  const cachedMenu = localStorage.getItem(MENU_CACHE_KEY);

  if (cachedHTML) {
    placeholder.innerHTML = cachedHTML;
    if (cachedMenu) {
      const sidebarNav = placeholder.querySelector('.sidebar-nav');
      if (sidebarNav) {
        sidebarNav.innerHTML = cachedMenu;
        setupFastMenuInteractions();
        highlightActiveMenu(window.location.pathname.split('/').pop());
      }
    }
  }

  try {
    const { authService, supabase } = await import('../supabase-config.js');

    // 2) Layout'u fetch et, değiştiyse DOM + cache güncelle
    await fetchAndApplyLayout(placeholder, cachedHTML);

    // Layout DOM'a basıldıktan sonra bağımlılıkları ekle
    ensureDatepickerDeps();

    // 3) Kullanıcıyı mümkünse Supabase session'dan al; yoksa localStorage fallback
    const user = await resolveCurrentUser({ authService, supabase });
    if (!user) return;

    updateUserInfo(user);

    const sidebarNav = document.querySelector('.sidebar-nav');
    if (sidebarNav) {
      renderMenu(sidebarNav, user.role || 'user');
      localStorage.setItem(MENU_CACHE_KEY, sidebarNav.innerHTML);
      setupFastMenuInteractions();
      await setupMenuBadges(supabase, user.id);
      highlightActiveMenu(window.location.pathname.split('/').pop());
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.onclick = (e) => {
        e.preventDefault();
        authService?.signOut?.();
        // localStorage temizliği (UI anında güncellensin)
        localStorage.removeItem('currentUser');
        localStorage.removeItem(MENU_CACHE_KEY);
        window.location.href = 'index.html';
      };
    }

  } catch (error) {
    console.error('Layout yükleme hatası:', error);
  }
}

async function fetchAndApplyLayout(placeholder, currentHTML) {
  try {
    const response = await fetch('shared_layout_parts.html', { cache: 'no-cache' });
    if (!response.ok) return;

    let html = await response.text();
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');

    // İlk yükleme: DOM'a bas
    if (!currentHTML) {
      placeholder.innerHTML = html;
      localStorage.setItem(LAYOUT_CACHE_KEY, html);
      return;
    }

    // Değişiklik varsa DOM + cache güncelle
    if (html !== currentHTML) {
      placeholder.innerHTML = html;
      localStorage.setItem(LAYOUT_CACHE_KEY, html);
    }
  } catch (e) {
    // sessiz geç
  }
}

async function resolveCurrentUser({ authService, supabase }) {
  // 1) authService varsa tercih et
  if (authService?.getCurrentUser) {
    try {
      const u = await authService.getCurrentUser();
      if (u) return u;
    } catch (_) {}
  }

  // 2) Supabase session/user dene
  if (supabase?.auth?.getUser) {
    try {
      const { data, error } = await supabase.auth.getUser();
      if (!error && data?.user) {
        // Eğer projende kullanıcı rolü users tablosunda tutuluyorsa
        // burada users tablosundan rol çekebilirsin. Şimdilik localStorage fallback ile birleştiriyoruz.
        const cached = getLocalUser();
        return cached && cached.id === data.user.id
          ? cached
          : { id: data.user.id, email: data.user.email, displayName: data.user.user_metadata?.full_name || data.user.email };
      }
    } catch (_) {}
  }

  // 3) localStorage fallback
  return getLocalUser();
}

function getLocalUser() {
  const localData = localStorage.getItem('currentUser');
  return localData ? JSON.parse(localData) : null;
}

function updateUserInfo(user) {
  const userNameEl = document.getElementById('userName');
  const userRoleEl = document.getElementById('userRole');
  const userAvatarEl = document.getElementById('userAvatar');

  if (userNameEl) userNameEl.textContent = user.displayName || (user.email ? user.email.split('@')[0] : 'Kullanıcı');
  if (userRoleEl) userRoleEl.textContent = user.role?.charAt(0).toUpperCase() + user.role?.slice(1) || 'Kullanıcı';
  if (userAvatarEl) userAvatarEl.textContent = (user.displayName || user.email?.charAt(0) || 'U').charAt(0).toUpperCase();
}

function renderMenu(container, userRole) {
  let currentCategory = '';
  container.innerHTML = '';

  menuItems.forEach(item => {
    if (item.category && item.category !== currentCategory) {
      const catTitle = document.createElement('div');
      catTitle.className = 'nav-category-title';
      catTitle.textContent = item.category;
      container.appendChild(catTitle);
      currentCategory = item.category;
    }

    if ((item.adminOnly && userRole !== 'admin' && userRole !== 'superadmin') ||
        (item.superAdminOnly && userRole !== 'superadmin')) return;

    const hasSubItems = item.subItems && item.subItems.length > 0;
    let linkClass = 'sidebar-nav-item' + (item.specialClass ? ` ${item.specialClass}` : '');

    if (hasSubItems) {
      container.innerHTML += `
        <div class="accordion">
          <div class="accordion-header">
            <span class="nav-icon"><i class="${item.icon}"></i></span>
            <span>${item.text}</span>
          </div>
          <div class="accordion-content">
            ${item.subItems.map(si =>
              `<a href="${si.link}" class="${si.specialClass || ''}" id="menu-link-${si.id}">
                <span>${si.text}</span>
                <span class="menu-badge" id="badge-${si.id}">0</span>
              </a>`
            ).join('')}
          </div>
        </div>`;
    } else {
      container.innerHTML += `
        <a href="${item.link}" class="${linkClass}" id="menu-link-${item.id}"
           ${item.disabled ? 'style="opacity: 0.5; cursor: not-allowed;"' : ''}>
          <span class="nav-icon"><i class="${item.icon}"></i></span>
          <span>${item.text}</span>
          <span class="menu-badge" id="badge-${item.id}">0</span>
        </a>`;
    }
  });
}

function setupFastMenuInteractions() {
  const sidebar = document.querySelector('.sidebar-nav');
  if (!sidebar || sidebar.dataset.bound) return;
  sidebar.dataset.bound = "true";

  sidebar.onclick = (e) => {
    const header = e.target.closest('.accordion-header');
    if (!header) return;

    const content = header.nextElementSibling;
    const isActive = header.classList.contains('active');

    if (isActive) {
      header.classList.remove('active');
      content.style.maxHeight = '0';
    } else {
      sidebar.querySelectorAll('.accordion-header.active').forEach(h => h.classList.remove('active'));
      sidebar.querySelectorAll('.accordion-content').forEach(c => c.style.maxHeight = '0');
      header.classList.add('active');
      content.style.maxHeight = content.scrollHeight + 'px';
    }
  };
}

function highlightActiveMenu(currentPage) {
  document.querySelectorAll('.sidebar-nav-item, .accordion-content a').forEach(link => link.classList.remove('active'));

  let parentAccordion = null;
  document.querySelectorAll('.sidebar-nav-item, .accordion-content a').forEach(link => {
    const href = link.getAttribute('href');
    if (href && href.split('/').pop() === currentPage) {
      link.classList.add('active');
      if (link.closest('.accordion')) parentAccordion = link.closest('.accordion');
    }
  });

  if (parentAccordion) {
    parentAccordion.querySelector('.accordion-header')?.classList.add('active');
    const content = parentAccordion.querySelector('.accordion-content');
    if (content) content.style.maxHeight = content.scrollHeight + 'px';
  }
}

async function setupMenuBadges(supabase, userId) {
  if (!supabase) return;

  try {
    // --- YENİ EKLENEN: Hatırlatmalar (Belirsiz Kullanıcı) Rozeti ---
    if (userId) {
      // 1. Önce giriş yapan kullanıcının rolünü kontrol et
      const { data: userProfile } = await supabase
        .from('users')
        .select('role')
        .eq('id', userId)
        .single();

      // 2. Sadece yetkili kişiler (admin/superadmin) bu rozeti görebilsin
      if (userProfile && (userProfile.role === 'superadmin' || userProfile.role === 'admin')) {
        const { count: pendingCount } = await supabase
          .from('users')
          .select('*', { count: 'exact', head: true })
          .eq('role', 'belirsiz');

        // 'reminders' id'li menü öğesine rozeti ekle (uygulamanın yerleşik UI fonksiyonu ile)
        updateBadgeUI('reminders', pendingCount || 0);
      }
    }
    // ----------------------------------------------------------------

    // Mevcut Tetiklenen Görevler Rozeti
    const { count: triggeredCount } = await supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'awaiting_client_approval');

    updateBadgeUI('triggered-tasks', triggeredCount || 0);

    // Mevcut Müvekkil Bildirimleri Rozeti
    const { count: mailCount } = await supabase
      .from('mail_notifications')
      .select('*', { count: 'exact', head: true })
      .in('status', ['awaiting_client_approval', 'missing_info', 'evaluation_pending']);

    updateBadgeUI('client-notifications', mailCount || 0);

    // Mevcut Benim İşlerim Rozeti
    if (userId) {
      const { count: myTasksCount } = await supabase
        .from('tasks')
        .select('*', { count: 'exact', head: true })
        .eq('assigned_to', userId)
        .in('status', ['open', 'in-progress', 'pending']);

      updateBadgeUI('my-tasks', myTasksCount || 0);
    }
  } catch (e) {
    // badge sorguları RLS yüzünden patlarsa sessiz geç
    console.warn("Badge güncellenirken bir sorun oluştu:", e);
  }
}

function updateBadgeUI(menuId, count) {
  const badgeEl = document.getElementById(`badge-${menuId}`);
  if (badgeEl) {
    badgeEl.textContent = count;
    badgeEl.style.display = count > 0 ? 'inline-block' : 'none';
  }
}

async function ensureDatepickerDeps() {
  const head = document.head;

  if (!document.querySelector('link[data-evreka="flatpickr-css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css';
    link.setAttribute('data-evreka', 'flatpickr-css');
    head.appendChild(link);
  }

  const loadScript = (src, attr) => new Promise(res => {
    if (document.querySelector(`script[${attr}]`)) return res();
    const s = document.createElement('script');
    s.src = src;
    s.setAttribute(attr.split('=')[0], attr.split('=')[1]?.replace(/"/g, '') || attr);
    s.onload = () => res();
    head.appendChild(s);
  });

  await loadScript('https://cdn.jsdelivr.net/npm/flatpickr', 'data-evreka="flatpickr-js"');
  if (!(window.flatpickr?.l10ns?.tr)) await loadScript('https://cdn.jsdelivr.net/npm/flatpickr/dist/l10n/tr.js', 'data-evreka="flatpickr-tr"');
  if (!window.EvrekaDatePicker) await loadScript('js/date-pickers.js', 'data-evreka="evreka-datepickers"');

  window.EvrekaDatePicker?.init();
}

// şimdilik stublar kalsın
export async function ensurePersonModal() {}
export function openPersonModal(onSaved) {}
export function closePersonModal() {}