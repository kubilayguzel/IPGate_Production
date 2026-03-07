/**
 * Simple Loading Animation - Tech Company Style
 * (CSS runtime inject'li sürüm)
 */

function ensureStyles() {
  if (document.getElementById('simple-loading-style')) return;

  const style = document.createElement('style');
  style.id = 'simple-loading-style';
  style.textContent = `
    .simple-loading-overlay {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(17, 24, 39, 0.45);
      backdrop-filter: blur(3px);
      -webkit-backdrop-filter: blur(3px);
      z-index: 2147483647;
      opacity: 0;
      transition: opacity .2s ease;
    }
    .simple-loading-overlay.show { opacity: 1; }

    .simple-loading-content {
      background: #ffffff;
      border-radius: 16px;
      padding: 20px 24px;
      box-shadow: 0 10px 40px rgba(0,0,0,.18);
      min-width: 280px;
      max-width: 90vw;
      text-align: center;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    }

    .loading-spinner {
      width: 40px; height: 40px;
      border-radius: 999px;
      border: 4px solid #e5e7eb;
      border-top-color: #3b82f6;
      animation: simpleloading-spin 1s linear infinite;
      margin: 0 auto 12px auto;
    }
    @keyframes simpleloading-spin { to { transform: rotate(360deg); } }

    .loading-text   { font-weight: 600; font-size: 16px; margin-bottom: 6px; }
    .loading-subtext{ font-size: 13px; color: #4b5563; margin-bottom: 8px; }

    .loading-cancel {
      margin-top: 6px;
      border: 0;
      padding: 8px 12px;
      border-radius: 10px;
      background: #ef4444;
      color: #fff;
      cursor: pointer;
    }
  `;
  document.head.appendChild(style);
}

class SimpleLoading {
  constructor() {
    this.overlay = null;
    this.onCancel = null;
  }

  // Hem show({text: '...'}) hem de show('Başlık', 'Alt Başlık') formatını destekler
  show(optionsOrText = {}, subtextIfText = '') {
    ensureStyles(); // ✅ CSS'i bir kez enjekte et

    let options = {};
    if (typeof optionsOrText === 'string') {
        options = {
            text: optionsOrText,
            subtext: subtextIfText
        };
    } else {
        options = optionsOrText || {};
    }

    const {
      text = 'İşlem yapılıyor',
      subtext = '', // Varsayılan boş olsun
      onCancel = null
    } = options;

    this.onCancel = onCancel;

    // Eğer daha önce açılmışsa içeriği güncelle
    if (this.overlay) {
        this.update(text, subtext);
        return;
    }

    this.overlay = document.createElement('div');
    this.overlay.className = 'simple-loading-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-live', 'polite');
    this.overlay.setAttribute('aria-label', 'Yükleniyor');

    this.overlay.innerHTML = `
      <div class="simple-loading-content">
        <div class="loading-spinner" aria-hidden="true"></div>
        <div class="loading-text">${text}</div>
        <div class="loading-subtext">${subtext}</div>
        ${onCancel ? '<button class="loading-cancel" id="loadingCancel">İptal</button>' : ''}
      </div>
    `;

    document.body.appendChild(this.overlay);
    
    if (onCancel) {
      const cancelBtn = this.overlay.querySelector('#loadingCancel');
      cancelBtn?.addEventListener('click', () => {
        this.hide();
        onCancel();
      });
    }

    // Animasyon için küçük gecikme
    setTimeout(() => {
      if (this.overlay) this.overlay.classList.add('show');
    }, 10);
  }

  updateText(text, subtext) {
    if (!this.overlay) return;

    const textEl = this.overlay.querySelector('.loading-text');
    const subtextEl = this.overlay.querySelector('.loading-subtext');
    
    if (textEl && text) {
      textEl.textContent = text;
    }
    if (subtextEl) {
      subtextEl.textContent = subtext || '';
    }
  }

  // Uyumluluk için alias
  update(text, subtext) {
      this.updateText(text, subtext);
  }

  showSuccess(message) {
    if (!this.overlay) return;

    const content = this.overlay.querySelector('.simple-loading-content');
    if(content) {
        content.style.background = 'linear-gradient(145deg, #dcfce7, #bbf7d0)';
        content.innerHTML = `
        <div style="color: #16a34a; font-size: 28px; margin-bottom: 12px;">✓</div>
        <div class="loading-text" style="background: linear-gradient(135deg, #166534, #16a34a); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Tamamlandı</div>
        <div class="loading-subtext">${message}</div>
        `;
    }

    setTimeout(() => this.hide(), 2000);
  }

  showError(message) {
    if (!this.overlay) return;

    const content = this.overlay.querySelector('.simple-loading-content');
    if(content) {
        content.style.background = 'linear-gradient(145deg, #fecaca, #fca5a5)';
        content.innerHTML = `
        <div style="color: #dc2626; font-size: 28px; margin-bottom: 12px;">✗</div>
        <div class="loading-text" style="background: linear-gradient(135deg, #991b1b, #dc2626); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Hata Oluştu</div>
        <div class="loading-subtext">${message}</div>
        <button class="loading-cancel" style="background:#fff; color:#dc2626; margin-top:10px;" onclick="document.querySelector('.simple-loading-overlay').remove()">Kapat</button>
        `;
    }
  }

  hide() {
    if (!this.overlay) return;

    this.overlay.classList.remove('show');
    
    const overlayToRemove = this.overlay;
    this.overlay = null; // Referansı hemen temizle

    setTimeout(() => {
      if (overlayToRemove && overlayToRemove.parentNode) {
        overlayToRemove.parentNode.removeChild(overlayToRemove);
      }
    }, 300);
  }
}

// Global exportlar (Hem Script tag hem Module desteği için)
if (typeof window !== 'undefined') {
  // 1. Sınıfın kendisi (new SimpleLoading() yapmak isteyenler için)
  window.SimpleLoading = SimpleLoading;

  // 2. TEKİL ÖRNEK (Singleton) - trademark-similarity-search.js bunu kullanacak
  // Böylece import etmeden direkt window üzerinden erişebileceğiz.
  window.SimpleLoadingController = new SimpleLoading();

  // 3. Yardımcı Fonksiyon (Her çağrıda yeni instance) - tp-file-transfer.js için
  window.showSimpleLoading = (text, subtext, onCancel) => {
    const loading = new SimpleLoading();
    loading.show({ text, subtext, onCancel });
    return loading;
  };
  
  // 4. Alias (tp-file-transfer.js'in beklediği isim)
  window.showLoadingWithCancel = window.showSimpleLoading;
}
