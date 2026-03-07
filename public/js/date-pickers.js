/**
 * Evreka Date Pickers (merkezi versiyon v4)
 * - gg.aa.yyyy maskesini silme dostu (backspace-friendly) şekilde uygular.
 * - Flatpickr takvimi ile tam uyumlu çalışır.
 * - Alanın tamamen silinmesine ve elle serbestçe düzenlenmesine izin verir.
 */
(function (w) {
  const DP = {
    init(root = document, userOpts = {}) {
      try {
        const nodes = Array.from(root.querySelectorAll('input[data-datepicker]'));
        nodes.forEach((el) => this.attach(el, userOpts));
      } catch (err) {
        console.warn('EvrekaDatePicker.init error:', err);
      }
    },

    attach(el, userOpts = {}) {
      try {
        if (!w.flatpickr) return;

        // ✅ Çift çalışmayı engelle
        if (el.dataset.dpInit === '1' || el._flatpickr) return;

        // Tarayıcı tarih seçicisini devre dışı bırak
        try { if (el.type === 'date') el.type = 'text'; } catch (e) {}
        el.setAttribute('inputmode', 'numeric');

        // Varsa eski altInput kalıntılarını temizle
        if (el.nextElementSibling && el.nextElementSibling.classList.contains('flatpickr-alt-input')) {
          el.nextElementSibling.remove();
        }

        const dateFormat = el.dataset.dateFormat || 'Y-m-d';
        const altFormat  = el.dataset.altFormat  || 'd.m.Y';
        const ddmmyyyyRegex = /^\d{2}\.\d{2}\.\d{4}$/;

        const fp = w.flatpickr(el, {
          dateFormat,
          altInput: true,
          altFormat,
          allowInput: true, // Elle girişe izin ver
          clickOpens: true,
          locale: 'tr',
          onClose: (selectedDates, dateStr, inst) => {
            const vis = inst.altInput ? inst.altInput.value : '';
            // Eğer alan tam gg.aa.yyyy formatında değilse ve boş değilse temizle (hatalı girişi engeller)
            if (vis && !ddmmyyyyRegex.test(vis)) {
              inst.clear();
            }
          },
          ...userOpts
        });

        el.dataset.dpInit = '1';

        if (fp && fp.altInput) {
          el.style.display = 'none'; 
          const alt = fp.altInput;
          alt.placeholder = 'gg.aa.yyyy';

          // 🔁 ESNEK MASKELEME MANTIĞI
          alt.addEventListener('input', (ev) => {
            // Sadece rakamları ayıkla
            let digits = alt.value.replace(/\D/g, '').slice(0, 8);
            let formatted = "";

            // Karakter sayısına göre maskeyi dinamik oluştur
            if (digits.length > 0) {
              formatted += digits.slice(0, 2);
              if (digits.length > 2) {
                formatted += "." + digits.slice(2, 4);
                if (digits.length > 4) {
                  formatted += "." + digits.slice(4, 8);
                }
              }
            }

            // Görüntülenen değeri güncelle (Sadece değer değişmişse - imleç kaymasını önler)
            if (alt.value !== formatted) {
              alt.value = formatted;
            }

            // Arka plandaki (hidden) inputu senkronize et
            if (ddmmyyyyRegex.test(formatted)) {
              const [dd, mm, yyyy] = formatted.split('.');
              el.value = `${yyyy}-${mm}-${dd}`; // Veritabanı formatı (ISO)
            } else {
              el.value = ''; // Eksikse arka planı boşalt
            }

            // Validatorleri tetikle
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });

          // Takvim tarihini manuel girişe göre anlık güncelleme (opsiyonel)
          alt.addEventListener('blur', () => {
            if (ddmmyyyyRegex.test(alt.value)) {
              fp.setDate(el.value, false);
            }
          });
        }
      } catch (err) {
        console.warn('EvrekaDatePicker.attach error:', err);
      }
    },

    refresh(root = document) {
      this.init(root);
    }
  };

  w.EvrekaDatePicker = w.EvrekaDatePicker || DP;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => w.EvrekaDatePicker.init());
  } else {
    w.EvrekaDatePicker.init();
  }
})(window);