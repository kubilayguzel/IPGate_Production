// IPGate - Davalar tablosu: okunabilir sutunlar + gercek duzenleme sayfasina yonlendirme.
// Mevcut PortfolioController / litigation-hierarchy-patch davranisina dokunmaz.
// portfolio.html modul scripti icinde main.js'den ONCE yuklenmelidir.

const litigationActive = () =>
    !!document.querySelector('.tab-button[data-type="litigation"].active');

const style = document.createElement('style');
style.id = 'ipgate-litigation-ux-fixes';
style.textContent = `
body:has(.tab-button[data-type="litigation"].active) .portfolio-table-container {
    overflow-x: auto !important;
    overflow-y: visible;
    max-width: 100%;
}
body:has(.tab-button[data-type="litigation"].active) #portfolio-table {
    width: 100%;
    min-width: 1370px;
    table-layout: fixed;
    border-collapse: collapse;
}
body:has(.tab-button[data-type="litigation"].active) #portfolio-table th,
body:has(.tab-button[data-type="litigation"].active) #portfolio-table td {
    box-sizing: border-box;
    padding: 9px 7px !important;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    vertical-align: middle;
}
/* Kolonlar toplam %100; eski JS inline px genislikleri ezilir. */
body:has(.tab-button[data-type="litigation"].active) #portfolio-table tr > :nth-child(1) { width: 3% !important; }
body:has(.tab-button[data-type="litigation"].active) #portfolio-table tr > :nth-child(2) { width: 17% !important; }
body:has(.tab-button[data-type="litigation"].active) #portfolio-table tr > :nth-child(3) { width: 11% !important; }
body:has(.tab-button[data-type="litigation"].active) #portfolio-table tr > :nth-child(4) { width: 9% !important; }
body:has(.tab-button[data-type="litigation"].active) #portfolio-table tr > :nth-child(5) { width: 13% !important; }
body:has(.tab-button[data-type="litigation"].active) #portfolio-table tr > :nth-child(6) { width: 10% !important; }
body:has(.tab-button[data-type="litigation"].active) #portfolio-table tr > :nth-child(7) { width: 10% !important; }
body:has(.tab-button[data-type="litigation"].active) #portfolio-table tr > :nth-child(8) { width: 8% !important; }
body:has(.tab-button[data-type="litigation"].active) #portfolio-table tr > :nth-child(9) { width: 8% !important; }
body:has(.tab-button[data-type="litigation"].active) #portfolio-table tr > :nth-child(10) {
    width: 11% !important;
    min-width: 150px;
    overflow: visible !important;
    text-overflow: clip !important;
}
body:has(.tab-button[data-type="litigation"].active) #portfolio-table td:nth-child(10) > div {
    display: flex !important;
    justify-content: flex-end !important;
    align-items: center;
    flex-wrap: nowrap !important;
    gap: 4px !important;
    width: 100%;
    min-width: 0;
}
body:has(.tab-button[data-type="litigation"].active) #portfolio-table td:nth-child(10) .action-btn {
    box-sizing: border-box;
    flex: 0 0 37px;
    width: 37px;
    min-width: 37px;
    max-width: 37px;
    margin: 0 !important;
    padding: 5px 7px !important;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
body:has(.tab-button[data-type="litigation"].active) #portfolio-table td:nth-child(10) .action-btn i {
    display: inline-block !important;
    opacity: 1 !important;
    visibility: visible !important;
}
`;
(document.head || document.documentElement).appendChild(style);

// Capture asamasinda durdur: portfolio/main.js'deki edit-btn bubble handler'i
// yanlislikla suit-detail.html acmasin. Goster (view-btn) hic etkilenmez.
document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('#portfolioTableBody .action-btn.edit-btn');
    if (!button || !litigationActive()) return;

    const suitId = button.dataset.id;
    if (!suitId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    window.open(`data-entry.html?editSuit=${encodeURIComponent(suitId)}`, '_blank', 'noopener');
}, true);
