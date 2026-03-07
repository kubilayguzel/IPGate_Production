/**
 * EVREKA Deadline Highlighter v1.0
 * Lightweight, configurable row-highlighting for "upcoming / overdue" date-based tasks.
 * Works with static tables, dynamic lists, and paginated content; auto-re-applies via MutationObserver.
 *
 * Usage (simple):
 *   DeadlineHighlighter.init({ timezone: 'Europe/Istanbul' });
 *   DeadlineHighlighter.registerList('tasks', {
 *     container: '#tasks-table',
 *     rowSelector: 'tbody tr',
 *     dateFields: [
 *       { name: 'operationalDue', selector: '[data-field="operationalDue"]' },
 *       { name: 'officialDue',    selector: '[data-field="officialDue"]' }
 *     ],
 *     strategy: 'earliest', // earliest | latest | officialOverOperational | function(dates, row){return selectedDate;}
 *     applyTo: 'row',       // row | cell
 *     showLegend: true
 *   });
 *
 * In each relevant cell, either:
 *  - Place the date as visible text in dd.mm.yyyy or ISO-8601 (YYYY-MM-DD) format, OR
 *  - Add attribute data-date="2025-09-07" to the element (recommended for reliability).
 *
 * The module computes the most urgent date per row (based on "strategy"), and applies a CSS class:
 *  evr-due-overdue  | evr-due-today | evr-due-3d | evr-due-7d | evr-due-30d  (else: no class)
 *
 * You can override/extend thresholds per list with the "thresholds" option.
 * See defaultThresholds below.
 */
(function (global) {
  'use strict';

  const DEFAULT_TZ = 'Europe/Istanbul';

  // --- Utilities ---
  const msPerDay = 24 * 60 * 60 * 1000;

  function parseTRDateLike(value) {
    if (!value) return null;
    const v = ('' + value).trim();
    // ISO first
    // Accept: YYYY-MM-DD or YYYY-MM-DDTHH:mm(:ss)?
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (iso) {
      const [_, y, m, d, hh='00', mm='00', ss='00'] = iso;
      // Treat as local (no TZ) at midnight unless time given
      return new Date(Number(y), Number(m)-1, Number(d), Number(hh), Number(mm), Number(ss));
    }
    // dd.mm.yyyy
    const tr = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (tr) {
      const [_, d, m, y] = tr;
      return new Date(Number(y), Number(m)-1, Number(d));
    }
    // dd/mm/yyyy
    const slash = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const [_, d, m, y] = slash;
      return new Date(Number(y), Number(m)-1, Number(d));
    }
    // Try Date.parse as last resort
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return new Date(t);
    return null;
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0,0,0,0);
    return d;
  }

  function dayDiff(from, to) {
    const a = startOfDay(from).getTime();
    const b = startOfDay(to).getTime();
    return Math.round((b - a) / msPerDay);
  }

  // --- YENİ: Satırın statüsünü kontrol et (Biten/Kapanan işleri boyamamak için) ---
  function isTaskFinished(row) {
    // İşlerin durumunu gösteren badge'leri arıyoruz (status-badge sınıfı)
    const statusBadge = row.querySelector('.status-badge');
    if (!statusBadge) return false; 

    const className = statusBadge.className.toLowerCase();

    // Sadece belirlediğimiz 4 kapalı statüden biriyse TRUE (bitti) döndür
    if (
        className.includes('status-completed') ||                  // Tamamlandı
        className.includes('status-cancelled') ||                  // İptal Edildi
        className.includes('status-client_approval_closed') ||     // Müvekkil Onayı - Kapatıldı
        className.includes('status-client_no_response_closed')     // Müvekkil Cevaplamadı - Kapatıldı
    ) {
      return true;
    }
    
    return false;
  }

  function throttle(fn, wait) {
    let last = 0, timer = null;
    return function(...args) {
      const now = Date.now();
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        last = now;
        if (timer) { clearTimeout(timer); timer = null; }
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
  }

  // --- Default thresholds ---
  // daysFrom/daysTo are inclusive, based on diffDays = (dueDate - today)
  const defaultThresholds = [
    { key: 'overdue', label: 'Geçti',    daysFrom: -99999, daysTo: -1,  className: 'evr-due-overdue',  priority: 100 },
    { key: 'today',   label: 'Bugün',    daysFrom: 0,      daysTo: 0,   className: 'evr-due-today',    priority: 90 },
    { key: 'd3',      label: '≤ 3 gün',  daysFrom: 1,      daysTo: 3,   className: 'evr-due-3d',       priority: 80 },
    { key: 'd7',      label: '≤ 7 gün',  daysFrom: 4,      daysTo: 7,   className: 'evr-due-7d',       priority: 70 },
  ];

  function pickThreshold(thresholds, diffDays) {
    for (const t of thresholds) {
      if (diffDays >= t.daysFrom && diffDays <= t.daysTo) return t;
    }
    return null;
  }

  // --- Core ---
  const lists = new Map();
  let settings = {
    timezone: DEFAULT_TZ,
    nowOverride: null, // for tests
  };

  function getToday() {
    if (settings.nowOverride instanceof Date) return startOfDay(settings.nowOverride);
    // JS Date is local time; we assume server/browser is in correct TZ.
    return startOfDay(new Date());
  }

  function resolveEl(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    if (target instanceof Element) return target;
    return null;
  }

  function getDateFromField(row, field) {
    // If developer provided a function:
    if (typeof field.getDate === 'function') {
      try { return field.getDate(row); } catch(e) { return null; }
    }
    // Else, find element by selector and parse from text or data-date
    const el = row.querySelector(field.selector);
    if (!el) return null;
    const iso = el.getAttribute('data-date');
    const raw = iso || el.textContent;
    return parseTRDateLike(raw);
  }

  function chooseDate(dates, row, strategy, fieldNames) {
    const valid = dates.filter(Boolean);
    if (valid.length === 0) return null;
    if (typeof strategy === 'function') return strategy(valid, row, fieldNames);

    switch (strategy) {
      case 'latest':
        return new Date(Math.max.apply(null, valid.map(d => d.getTime())));
      case 'officialOverOperational': {
        // If we have "officialDue" prefer it; else earliest
        const idx = fieldNames.indexOf('officialDue');
        if (idx !== -1 && dates[idx] instanceof Date) return dates[idx];
        return new Date(Math.min.apply(null, valid.map(d => d.getTime())));
      }
      case 'earliest':
      default:
        return new Date(Math.min.apply(null, valid.map(d => d.getTime())));
    }
  }

  function clearRowClasses(row) {
    row.classList.remove('evr-due-overdue','evr-due-today','evr-due-3d','evr-due-7d','evr-due-30d');
  }

  function applyClass(target, className) {
    if (target) target.classList.add(className);
  }

  function formatBadge(diffDays) {
    if (diffDays < 0) return `${Math.abs(diffDays)}g geç`;
    if (diffDays === 0) return `bugün`;
    return `${diffDays}g sonra`;
  }

  function ensureBadge(el) {
    let badge = el.querySelector('.evr-due-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'evr-due-badge';
      el.appendChild(badge);
    }
    return badge;
  }

  function renderLegend(container, thresholds) {
    const host = document.createElement('div');
    host.className = 'evr-due-legend';
    host.innerHTML = `
      <div class="evr-due-legend-title">Önem Durumu</div>
      <div class="evr-due-legend-items">
        ${thresholds.map(t => `
          <div class="evr-due-legend-item">
            <span class="evr-due-dot ${t.className}"></span>
            <span>${t.label}</span>
          </div>
        `).join('')}
      </div>
    `;
    // Insert before container if possible, else at top of container
    const parent = container.parentElement || container;
    parent.insertBefore(host, container);
  }

  function refreshList(list) {
    const {
      container, rowSelector, dateFields, thresholds,
      strategy, applyTo, onStatus, addBadgeTo, showLegend
    } = list;

    const el = resolveEl(container);
    if (!el) return;
    const rows = el.querySelectorAll(rowSelector);
    const today = getToday();

    rows.forEach(row => {
      clearRowClasses(row); // Her zaman önce eski boyaları temizle

      // YENİ: Eğer iş "Tamamlandı" veya "İptal" ise tarihi hiç kontrol etme, atla!
      if (isTaskFinished(row)) return; 

      const fieldNames = dateFields.map(f => f.name || '');
      const dates = dateFields.map(f => getDateFromField(row, f));
      const selected = chooseDate(dates, row, strategy, fieldNames);
      
      if (!selected) return;

      const diff = dayDiff(today, selected);
      const thr = pickThreshold(thresholds, diff);
      if (!thr) return;

      const target = (applyTo === 'cell' && addBadgeTo) ? row.querySelector(addBadgeTo) : row;
      if (!target) return;

      applyClass(target, thr.className);

      if (applyTo === 'cell' && addBadgeTo) {
        const cell = row.querySelector(addBadgeTo);
        if (cell) {
          const badge = ensureBadge(cell);
          badge.textContent = formatBadge(diff);
        }
      }

      if (typeof onStatus === 'function') {
        try {
          onStatus(row, { diffDays: diff, threshold: thr, selectedDate: selected, dates, fieldNames });
        } catch(e){ /* ignore */ }
      }
    });

    if (showLegend && !list._legendRendered) {
      renderLegend(el, thresholds);
      list._legendRendered = true;
    }
  }

  const refreshListThrottled = throttle((list) => refreshList(list), 100);

  function attachObserver(list) {
    const el = resolveEl(list.container);
    if (!el) return;
    if (list._observer) return; // already attached

    const obs = new MutationObserver(() => refreshListThrottled(list));
    obs.observe(el, { childList: true, subtree: true });
    list._observer = obs;
  }

  // --- Public API ---
  const DeadlineHighlighter = {
    init(opts = {}) {
      settings = Object.assign({}, settings, opts || {});
      return this;
    },

    /**
     * Register a new list/table to be highlighted.
     * @param {string} id - unique id
     * @param {object} config
     */
    registerList(id, config) {
      const cfg = Object.assign({
        thresholds: defaultThresholds.slice(),
        strategy: 'earliest',
        applyTo: 'row',
        showLegend: false,
        addBadgeTo: null, // selector of the cell to show badge when applyTo === 'cell'
      }, config || {});

      if (!cfg.container || !cfg.rowSelector || !cfg.dateFields || !cfg.dateFields.length) {
        console.warn('[DeadlineHighlighter] Missing required config for', id);
        return;
      }
      lists.set(id, cfg);
      // Initial pass & observer
      setTimeout(() => {
        refreshList(cfg);
        attachObserver(cfg);
      }, 0);
      return this;
    },

    /**
     * Force refresh (e.g., after data loads)
     */
    refresh(id) {
      if (id) {
        const list = lists.get(id);
        if (list) refreshList(list);
      } else {
        for (const list of lists.values()) refreshList(list);
      }
    },

    /**
     * Update thresholds globally or per-list
     */
    setThresholds(idOrArray, maybeArray) {
      if (Array.isArray(idOrArray)) {
        // global default override
        idOrArray && (defaultThresholds.length = 0, defaultThresholds.push(...idOrArray));
      } else {
        const list = lists.get(idOrArray);
        if (list && Array.isArray(maybeArray)) list.thresholds = maybeArray;
      }
      this.refresh();
    }
  };

  // Expose globally
  global.DeadlineHighlighter = DeadlineHighlighter;

})(window);