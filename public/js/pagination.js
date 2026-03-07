// js/pagination.js - Yeniden kullanılabilir pagination sistemi

export default class Pagination {
    constructor(options = {}) {
        // 1. Varsayılan metinleri tanımla
        const defaultStrings = {
            first: 'İlk',
            previous: 'Önceki',
            next: 'Sonraki',
            last: 'Son',
            pageInfo: 'Sayfa {current} / {total}',
            itemsInfo: 'Toplam {total} kayıt ({start}-{end} arası gösteriliyor)',
            itemsPerPage: 'Sayfa başına:',
            noResults: 'Gösterilecek kayıt bulunamadı'
        };

        // 2. Ayarları oluştur
        this.options = {
            // Varsayılan genel ayarlar
            itemsPerPage: 20,
            maxVisiblePages: 5,
            containerId: 'paginationContainer',
            onPageChange: () => {},
            showFirstLast: true,
            showPrevNext: true,
            showPageInfo: true,
            showItemsPerPageSelector: true,
            itemsPerPageOptions: [10, 20, 50, 100,1000],
            
            // Kullanıcıdan gelen ana ayarları (örn: itemsPerPage) varsayılanların üzerine yaz
            ...options,

            // 3. 'strings' objesini özel olarak birleştir (Deep Merge)
            // Kullanıcıdan gelen options.strings varsa, varsayılanların üzerine ekle.
            // Böylece kullanıcının göndermediği metinler varsayılan olarak kalır.
            strings: {
                ...defaultStrings,
                ...(options.strings || {})
            }
        };

        this.currentPage = 1;
        this.totalItems = 0;
        this.totalPages = 0;
        this.container = null;

        this.init();
    }

    init() {
        this.container = document.getElementById(this.options.containerId);
        if (!this.container) {
            console.error(`Pagination container '${this.options.containerId}' bulunamadı!`);
            return;
        }
        this.injectCSS();
    }

    injectCSS() {
        const cssId = 'pagination-styles';
        if (document.getElementById(cssId)) return;
        
        const style = document.createElement('style');
        style.id = cssId;
        style.textContent = `
            .pagination-wrapper { display: flex; flex-flow: row wrap; justify-content: space-between; align-items: center; padding: 15px; margin-top:20px; background: rgba(255, 255, 255, 0.9); border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
            .pagination-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
            .pagination-nav { display: flex; align-items: center; gap: 5px; }
            .pagination-btn { padding: 8px 12px; border: 1px solid #ddd; background: white; color: #333; border-radius: 6px; cursor: pointer; font-size: 14px; transition: all 0.2s ease; text-decoration: none; display: inline-flex; align-items: center; min-width: 40px; justify-content: center; }
            .pagination-btn:hover:not(:disabled) { background: #f0f5ff; border-color: #0056b3; transform: translateY(-1px); }
            .pagination-btn.current { background: #007bff; color: white; border-color: #007bff; font-weight: 600; }
            .pagination-btn:disabled { background: #f8f9fa; color: #6c757d; cursor: not-allowed; opacity: 0.6; }
            .pagination-ellipsis { padding: 8px 4px; color: #6c757d; }
            .pagination-info { font-size: 14px; color: #555; text-align: right;}
            .pagination-items-per-page { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #555; }
            .pagination-items-select { padding: 6px 8px; border-radius: 6px; border: 1px solid #ccc; }
            .pagination-no-results { width:100%; text-align: center; padding: 20px; color: #666; font-style: italic; }
        `;
        document.head.appendChild(style);
    }

    update(totalItems) {
        this.totalItems = totalItems;
        this.totalPages = this.getTotalPages();
        if (this.currentPage > this.totalPages) {
            this.currentPage = this.totalPages || 1;
        }
        this.render();
    }

    getTotalPages() {
        return Math.ceil(this.totalItems / this.options.itemsPerPage);
    }

    getCurrentPageData(allData) {
        const startIndex = (this.currentPage - 1) * this.options.itemsPerPage;
        const endIndex = startIndex + this.options.itemsPerPage;
        return allData.slice(startIndex, endIndex);
    }
    
    getStartIndex() {
        return (this.currentPage - 1) * this.options.itemsPerPage;
    }

    getEndIndex() {
        return Math.min(this.currentPage * this.options.itemsPerPage, this.totalItems);
    }

    render() {
        if (!this.container) return;

        if (this.totalItems === 0) {
            this.container.innerHTML = `<div class="pagination-wrapper"><div class="pagination-no-results">${this.options.strings.noResults}</div></div>`;
            return;
        }
        
        this.container.innerHTML = this.generatePaginationHTML();
        this.attachEventListeners();
    }

    generatePaginationHTML() {
        let infoHtml = '';
        if (this.options.showPageInfo) {
            infoHtml = `<div class="pagination-info">${this.options.strings.itemsInfo.replace('{total}', this.totalItems).replace('{start}', this.getStartIndex() + 1).replace('{end}', this.getEndIndex())}</div>`;
        }

        let controlsHtml = this.totalPages > 1 ? `<div class="pagination-nav">${this.generateNavigationButtons()}</div>` : '';
        let selectorHtml = '';
        if (this.options.showItemsPerPageSelector) {
            selectorHtml = `<div class="pagination-items-per-page">
                <span>${this.options.strings.itemsPerPage}</span>
                <select class="pagination-items-select">
                    ${this.options.itemsPerPageOptions.map(opt => `<option value="${opt}" ${opt === this.options.itemsPerPage ? 'selected' : ''}>${opt}</option>`).join('')}
                </select>
            </div>`;
        }
        
        return `<div class="pagination-wrapper">
                    ${selectorHtml}
                    <div class="pagination-controls">${controlsHtml}</div>
                    ${infoHtml}
                </div>`;
    }

    generateNavigationButtons() {
        let buttons = '';
        if (this.options.showFirstLast) buttons += this.createNavButton(this.options.strings.first, 1);
        if (this.options.showPrevNext) buttons += this.createNavButton(this.options.strings.previous, this.currentPage - 1);
        buttons += this.generatePageNumbers();
        if (this.options.showPrevNext) buttons += this.createNavButton(this.options.strings.next, this.currentPage + 1);
        if (this.options.showFirstLast) buttons += this.createNavButton(this.options.strings.last, this.totalPages);
        return buttons;
    }

    createNavButton(text, page) {
        const isDisabled = (page < 1 || page > this.totalPages || page === this.currentPage);
        return `<button class="pagination-btn" data-page="${page}" ${isDisabled ? 'disabled' : ''}>${text}</button>`;
    }

    generatePageNumbers() {
        let pages = '';
        const { maxVisiblePages } = this.options;
        const current = this.currentPage;
        const total = this.totalPages;

        if (total <= maxVisiblePages) {
            for (let i = 1; i <= total; i++) pages += this.createPageButton(i);
        } else {
            let start = Math.max(1, current - Math.floor(maxVisiblePages / 2));
            let end = Math.min(total, start + maxVisiblePages - 1);
            if (end - start + 1 < maxVisiblePages) start = Math.max(1, end - maxVisiblePages + 1);

            if (start > 1) {
                pages += this.createPageButton(1);
                if (start > 2) pages += `<span class="pagination-ellipsis">...</span>`;
            }
            for (let i = start; i <= end; i++) pages += this.createPageButton(i);
            if (end < total) {
                if (end < total - 1) pages += `<span class="pagination-ellipsis">...</span>`;
                pages += this.createPageButton(total);
            }
        }
        return pages;
    }

    createPageButton(page) {
        return `<button class="pagination-btn ${page === this.currentPage ? 'current' : ''}" data-page="${page}">${page}</button>`;
    }

    attachEventListeners() {
        this.container.addEventListener('click', (e) => {
            const button = e.target.closest('.pagination-btn');
            if (button && !button.disabled) this.goToPage(parseInt(button.dataset.page));
        });
        this.container.querySelector('.pagination-items-select')?.addEventListener('change', (e) => {
            this.setItemsPerPage(parseInt(e.target.value));
        });
    }

    goToPage(page) {
        if (page === this.currentPage) return;
        this.currentPage = page;
        this.render();
        this.options.onPageChange(this.currentPage, this.options.itemsPerPage);
    }

    setItemsPerPage(itemsPerPage) {
        const oldFirstItemIndex = (this.currentPage - 1) * this.options.itemsPerPage;
        this.options.itemsPerPage = itemsPerPage;
        this.totalPages = this.getTotalPages();
        this.currentPage = Math.max(1, Math.floor(oldFirstItemIndex / itemsPerPage) + 1);
        this.render();
        this.options.onPageChange(this.currentPage, this.options.itemsPerPage);
    }

    // SINIF İÇİNE TAŞINAN YARDIMCI METODLAR
    reset() {
        this.goToPage(1);
    }

    destroy() {
        if (this.container) this.container.innerHTML = '';
    }

    getCurrentPage() {
        return this.currentPage;
    }

    getItemsPerPage() {
        return this.options.itemsPerPage;
    }

    getTotalItems() {
        return this.totalItems;
    }
}