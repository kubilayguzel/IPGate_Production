// public/js/indexing/international-hierarchy-compat.js
// AŞAMA 3R HOTFIX V2
//
// WIPO / ARIPO parent-child kullanıcı deneyimini eski güvenli davranışına
// geri getirir ve büyük ailelerde kullanılabilir hale getirir.
//
// V2:
// - IR numarasıyla aramada 50 child'ı dropdown'a yığmak yerine aile tek satır gösterilir.
// - "X ülke kaydı" bilgisi görünür.
// - Aile satırına tıklayınca modal açılır.
// - Modal TÜM child'ları listeler; 10/12 kayıt sınırı yoktur.
// - Modal içinde ülke / kod / başvuru no / marka adı ile filtreleme vardır.
// - Parent + child seçimi mevcut selectRecord() akışını kullanır.
// - Dava ortak araması ve normal IP indeksleme akışı korunur.

import './smart-record-search.js';
import { DocumentReviewManager } from './document-review-manager.js';
import { supabase } from '../../supabase-config.js';

const proto = DocumentReviewManager.prototype;

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function norm(value) {
    return String(value || '')
        .toLocaleLowerCase('tr-TR')
        .replace(/\s+/g, ' ')
        .trim();
}

function compact(value) {
    return norm(value).replace(/[^0-9a-zçğıöşü]/gi, '');
}

function getOrigin(record) {
    return String(record?.origin || '').toUpperCase().trim();
}

function getHierarchy(record) {
    return String(
        record?.transactionHierarchy ||
        record?.transaction_hierarchy ||
        'parent'
    ).toLowerCase().trim();
}

function getParentId(record) {
    return String(
        record?.parentId ||
        record?.parent_id ||
        ''
    ).trim();
}

function getInternationalNumber(record) {
    return String(
        record?.internationalRegNumber ||
        record?.wipoIR ||
        record?.wipo_ir ||
        record?.aripoIR ||
        record?.aripo_ir ||
        ''
    ).trim();
}

function normalizeInternationalNumber(value) {
    return String(value || '')
        .replace(/[^0-9a-z]/gi, '')
        .toUpperCase();
}

function getApplicationNumber(record) {
    return String(
        record?.applicationNumber ||
        record?.application_number ||
        record?.registrationNumber ||
        record?.registration_number ||
        ''
    ).trim();
}

function getTitle(record) {
    return (
        record?.title ||
        record?.brandText ||
        record?.brand_name ||
        record?.markName ||
        record?.details?.brand_name ||
        '(İsimsiz)'
    );
}

function countryCodeOf(record) {
    return String(
        record?.countryCode ||
        record?.country_code ||
        record?.country ||
        ''
    ).toUpperCase().trim();
}

function countryName(manager, record) {
    const code = countryCodeOf(record);

    if (!code) return '-';

    return (
        manager?.countryMap?.get?.(code) ||
        manager?.countryMap?.get?.(code.toLowerCase()) ||
        code
    );
}

function isInternationalRecord(record) {
    const origin = getOrigin(record);

    return (
        ['WIPO', 'ARIPO', 'WO', 'AP'].some(
            (token) => origin.includes(token)
        ) ||
        Boolean(getInternationalNumber(record))
    );
}

function uniqueById(records) {
    const seen = new Set();

    return (records || []).filter((record) => {
        const key = String(record?.id || '');

        if (!key || seen.has(key)) return false;

        seen.add(key);
        return true;
    });
}

function sortChildrenByCountry(manager, children) {
    return [...children].sort((a, b) => {
        const ca = countryName(manager, a);
        const cb = countryName(manager, b);

        return ca.localeCompare(cb, 'tr', {
            sensitivity: 'base'
        });
    });
}

function ensureStyles() {
    if (document.getElementById('internationalHierarchyCompatStyles')) return;

    const style = document.createElement('style');
    style.id = 'internationalHierarchyCompatStyles';

    style.textContent = `
        .smart-international-family {
            background: #f8fbff;
            border-left: 3px solid #4e73df;
        }

        .smart-international-family:hover {
            background: #f1f6ff;
        }

        .smart-family-count {
            flex: 0 0 auto;
            display: inline-flex;
            align-items: center;
            border-radius: 999px;
            padding: 4px 9px;
            font-size: .68rem;
            font-weight: 800;
            color: #1d4ed8;
            background: #eff6ff;
            border: 1px solid #bfdbfe;
        }

        .smart-hierarchy-row {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-top: 4px;
            font-size: .71rem;
            color: #64748b;
            min-width: 0;
        }

        .smart-hierarchy-badge {
            display: inline-flex;
            align-items: center;
            flex: 0 0 auto;
            border-radius: 999px;
            padding: 2px 7px;
            font-size: .64rem;
            font-weight: 800;
            border: 1px solid currentColor;
        }

        .smart-hierarchy-badge.is-parent {
            color: #1d4ed8;
            background: #eff6ff;
        }

        .smart-hierarchy-badge.is-child {
            color: #b45309;
            background: #fff7ed;
        }

        #internationalFamilyTools {
            padding: 12px 14px;
            background: #fff;
            border: 1px solid #e3e6f0;
            border-radius: 9px;
            margin-bottom: 12px;
        }

        #internationalFamilySearch {
            border-radius: 8px;
        }

        #internationalFamilyCount {
            font-size: .76rem;
            color: #64748b;
            font-weight: 700;
            white-space: nowrap;
        }

        #wipoSelectionList {
            max-height: 55vh !important;
            overflow-y: auto !important;
            padding-right: 4px;
        }

        .international-family-item .country-title {
            font-size: .91rem;
            font-weight: 800;
            color: #263449;
        }

        .international-family-item .record-title {
            font-size: .78rem;
            color: #475569;
        }

        .international-family-item .record-meta {
            font-size: .72rem;
            color: #858796;
        }

        .international-family-hidden {
            display: none !important;
        }
    `;

    document.head.appendChild(style);
}

function familyKey(record) {
    const hierarchy = getHierarchy(record);
    const parentId = getParentId(record);

    if (hierarchy === 'child' && parentId) {
        return `parent:${parentId}`;
    }

    if (hierarchy === 'parent' && record?.id) {
        return `parent:${record.id}`;
    }

    const ir = normalizeInternationalNumber(
        getInternationalNumber(record)
    );

    return ir ? `ir:${ir}` : null;
}

function getFamily(manager, seedRecord) {
    if (!seedRecord) {
        return {
            parent: null,
            children: []
        };
    }

    const all = manager.allRecords || [];
    const seedHierarchy = getHierarchy(seedRecord);
    const seedParentId = getParentId(seedRecord);
    const seedIr = normalizeInternationalNumber(
        getInternationalNumber(seedRecord)
    );

    let parent = null;

    if (seedHierarchy === 'parent') {
        parent = seedRecord;
    } else if (seedParentId) {
        parent = all.find(
            (record) => String(record.id) === seedParentId
        ) || null;
    }

    if (!parent && seedIr) {
        parent = all.find((record) => {
            return (
                getHierarchy(record) === 'parent' &&
                normalizeInternationalNumber(
                    getInternationalNumber(record)
                ) === seedIr
            );
        }) || null;
    }

    const parentId = parent?.id
        ? String(parent.id)
        : seedParentId;

    const targetIr = normalizeInternationalNumber(
        getInternationalNumber(parent || seedRecord)
    ) || seedIr;

    const children = uniqueById(
        all.filter((record) => {
            if (getHierarchy(record) !== 'child') return false;

            if (
                parentId &&
                getParentId(record) === parentId
            ) {
                return true;
            }

            if (!targetIr) return false;

            return (
                normalizeInternationalNumber(
                    getInternationalNumber(record)
                ) === targetIr
            );
        })
    );

    return {
        parent,
        children
    };
}

function matchingInternationalFamilies(manager, query) {
    const qCompact = normalizeInternationalNumber(query);

    if (!qCompact || qCompact.length < 4) return [];

    const candidates = (manager.allRecords || []).filter((record) => {
        if (!isInternationalRecord(record)) return false;

        const ir = normalizeInternationalNumber(
            getInternationalNumber(record)
        );

        if (!ir) return false;

        return (
            ir === qCompact ||
            ir.includes(qCompact) ||
            qCompact.includes(ir)
        );
    });

    if (candidates.length === 0) return [];

    const families = new Map();

    for (const candidate of candidates) {
        const family = getFamily(manager, candidate);
        const anchor = family.parent || candidate;
        const key =
            familyKey(anchor) ||
            familyKey(candidate) ||
            `record:${candidate.id}`;

        if (!families.has(key)) {
            families.set(key, {
                parent: family.parent,
                children: family.children,
                seed: candidate
            });
        }
    }

    return [...families.values()]
        .map((family) => {
            const anchor =
                family.parent ||
                family.seed;

            return {
                ...family,
                anchor,
                ir: getInternationalNumber(anchor),
                title: getTitle(anchor),
                childCount: family.children.length
            };
        })
        .sort((a, b) => {
            return b.childCount - a.childCount;
        });
}

function familyRowHtml(family) {
    const anchor = family.anchor;
    const origin = anchor?.origin || 'WIPO';

    return `
        <div
            class="smart-result-item smart-international-family"
            data-international-family="true"
            data-record-id="${esc(anchor?.id || '')}"
        >
            <div
                class="smart-result-icon"
                style="color:#1d4ed8;background:#eff6ff;border-color:#bfdbfe;"
            >
                <i class="fas fa-globe-americas"></i>
            </div>

            <div class="smart-result-main">
                <div
                    style="display:flex;gap:6px;align-items:center;min-width:0;"
                >
                    <span
                        class="smart-hierarchy-badge is-parent"
                    >
                        <i class="fas fa-sitemap mr-1"></i>
                        ULUSLARARASI AİLE
                    </span>

                    <span
                        class="smart-result-title"
                        title="${esc(family.title)}"
                    >
                        ${esc(family.title)}
                    </span>
                </div>

                <div class="smart-result-line">
                    <strong>IR:</strong>
                    ${esc(family.ir || '-')}
                    · ${esc(origin)}
                </div>

                <div class="smart-result-line">
                    <i class="fas fa-mouse-pointer mr-1"></i>
                    Tıklayın; tüm ülke kayıtlarını modalda seçin.
                </div>
            </div>

            <span class="smart-family-count">
                <i class="fas fa-flag mr-1"></i>
                ${family.childCount} ülke
            </span>
        </div>
    `;
}

function insertFamilySection(manager, families) {
    const container = document.getElementById(
        'manualSearchResults'
    );

    if (!container || families.length === 0) return;

    // Aynı IR ailesine ait child/parent kayıtlarını normal portföy listesinde
    // tekrar göstermeyelim. Böylece kullanıcı 50 kayıt arasında parent aramaz.
    const familyIds = new Set();

    for (const family of families) {
        if (family.parent?.id) {
            familyIds.add(String(family.parent.id));
        }

        for (const child of family.children) {
            if (child?.id) {
                familyIds.add(String(child.id));
            }
        }
    }

    container
        .querySelectorAll(
            '.smart-result-item[data-entity="ip"]'
        )
        .forEach((item) => {
            if (
                familyIds.has(
                    String(item.dataset.id || '')
                )
            ) {
                item.remove();
            }
        });

    // Varsa boş kalmış Portföy Kayıtları başlığını temizle.
    const sections = [
        ...container.querySelectorAll(
            '.smart-result-section'
        )
    ];

    for (const section of sections) {
        const label = norm(
            section.firstElementChild?.textContent
        );

        if (label !== 'portföy kayıtları') continue;

        let cursor = section.nextElementSibling;
        let count = 0;

        while (
            cursor &&
            !cursor.classList.contains(
                'smart-result-section'
            )
        ) {
            if (
                cursor.classList.contains(
                    'smart-result-item'
                )
            ) {
                count += 1;
            }

            cursor = cursor.nextElementSibling;
        }

        if (count === 0) {
            section.remove();
        } else {
            const countEl =
                section.lastElementChild;

            if (countEl) {
                countEl.textContent = String(count);
            }
        }
    }

    const wrapper = document.createElement('div');

    wrapper.innerHTML = `
        <div class="smart-result-section">
            <span>Uluslararası Aileler</span>
            <span>${families.length}</span>
        </div>
        ${families.map(familyRowHtml).join('')}
    `;

    const nodes = [
        ...wrapper.children
    ];

    for (let i = nodes.length - 1; i >= 0; i--) {
        container.insertBefore(
            nodes[i],
            container.firstChild
        );
    }

    container
        .querySelectorAll(
            '[data-international-family="true"]'
        )
        .forEach((row) => {
            row.addEventListener(
                'click',
                () => {
                    const recordId = String(
                        row.dataset.recordId || ''
                    );

                    const family = families.find(
                        (item) =>
                            String(
                                item.anchor?.id || ''
                            ) === recordId
                    );

                    if (!family) return;

                    manager._openInternationalFamilyModal(
                        family.parent ||
                        family.anchor,
                        family.children
                    );

                    container.style.display = 'none';
                }
            );
        });
}

if (!proto.__internationalHierarchyCompatPatchedV2) {
    Object.defineProperty(
        proto,
        '__internationalHierarchyCompatPatchedV2',
        {
            value: true,
            enumerable: false,
            configurable: false,
            writable: false
        }
    );

    const previousManualSearch =
        proto.handleManualSearch;

    const previousSelectRecordWithHierarchy =
        proto.selectRecordWithHierarchy;

    const previousOpenWipoSelectionModal =
        proto._openWipoSelectionModal;

    proto._openInternationalFamilyModal = function(
        parent,
        children
    ) {
        const modalEl =
            document.getElementById(
                'wipoSelectionModal'
            );

        const listEl =
            document.getElementById(
                'wipoSelectionList'
            );

        if (!modalEl || !listEl) {
            // HTML modalı yoksa eski güvenli fonksiyon.
            if (
                typeof previousOpenWipoSelectionModal ===
                'function'
            ) {
                previousOpenWipoSelectionModal.call(
                    this,
                    parent,
                    children
                );
            }

            return;
        }

        const uniqueChildren =
            sortChildrenByCountry(
                this,
                uniqueById(children)
            );

        const modalBody =
            modalEl.querySelector('.modal-body');

        let tools =
            document.getElementById(
                'internationalFamilyTools'
            );

        if (!tools && modalBody) {
            tools = document.createElement('div');
            tools.id = 'internationalFamilyTools';

            tools.innerHTML = `
                <div
                    class="d-flex justify-content-between align-items-center mb-2"
                    style="gap:10px;"
                >
                    <div
                        class="font-weight-bold text-dark"
                    >
                        <i
                            class="fas fa-globe-americas text-primary mr-1"
                        ></i>
                        Ülke / Ulusal Kayıt Seçimi
                    </div>

                    <div id="internationalFamilyCount"></div>
                </div>

                <div class="input-group input-group-sm">
                    <div class="input-group-prepend">
                        <span class="input-group-text bg-white">
                            <i class="fas fa-search text-primary"></i>
                        </span>
                    </div>

                    <input
                        type="text"
                        class="form-control"
                        id="internationalFamilySearch"
                        placeholder="Ülke, ülke kodu, başvuru no veya marka adı ara..."
                        autocomplete="off"
                    >
                </div>
            `;

            modalBody.insertBefore(
                tools,
                listEl
            );
        }

        const searchInput =
            document.getElementById(
                'internationalFamilySearch'
            );

        const countEl =
            document.getElementById(
                'internationalFamilyCount'
            );

        listEl.innerHTML = '';

        const allRows = [];

        if (parent) {
            const item =
                document.createElement('button');

            item.type = 'button';

            item.className =
                'list-group-item list-group-item-action d-flex justify-content-between align-items-center mb-2 border rounded shadow-sm international-family-item';

            item.dataset.search = norm([
                'uluslararası',
                'ana kayıt',
                getTitle(parent),
                getInternationalNumber(parent),
                parent.origin
            ].join(' '));

            item.innerHTML = `
                <div class="d-flex align-items-center">
                    <i
                        class="fas fa-globe-americas text-primary fa-lg mr-3"
                    ></i>

                    <div>
                        <div class="country-title">
                            Uluslararası Ana Kayıt
                        </div>

                        <div class="record-title">
                            ${esc(getTitle(parent))}
                        </div>

                        <div class="record-meta">
                            IR ${esc(getInternationalNumber(parent) || '-')}
                            · ${esc(parent.origin || '-')}
                        </div>
                    </div>
                </div>

                <span
                    class="badge badge-primary px-2 py-1"
                >
                    ANA KAYIT
                </span>
            `;

            item.addEventListener(
                'click',
                () => {
                    this.selectRecord(parent.id);

                    if (
                        typeof window.$ !== 'undefined'
                    ) {
                        window.$(
                            '#wipoSelectionModal'
                        ).modal('hide');
                    }
                }
            );

            listEl.appendChild(item);
            allRows.push(item);
        }

        for (const child of uniqueChildren) {
            const country =
                countryName(this, child);

            const countryCode =
                countryCodeOf(child);

            const applicationNo =
                getApplicationNumber(child);

            const ir =
                getInternationalNumber(child);

            const title =
                getTitle(child);

            const item =
                document.createElement('button');

            item.type = 'button';

            item.className =
                'list-group-item list-group-item-action d-flex justify-content-between align-items-center mb-2 border rounded shadow-sm international-family-item';

            item.dataset.search = norm([
                country,
                countryCode,
                applicationNo,
                ir,
                title,
                child.origin
            ].join(' '));

            item.innerHTML = `
                <div class="d-flex align-items-center">
                    <i
                        class="fas fa-flag text-danger fa-lg mr-3"
                    ></i>

                    <div>
                        <div class="country-title">
                            ${esc(country)}
                            ${
                                countryCode &&
                                countryCode !== country
                                    ? `<span class="text-muted font-weight-normal">(${esc(countryCode)})</span>`
                                    : ''
                            }
                        </div>

                        <div class="record-title">
                            ${esc(title)}
                        </div>

                        <div class="record-meta">
                            ${
                                applicationNo
                                    ? `Başvuru No: ${esc(applicationNo)} · `
                                    : ''
                            }
                            IR: ${esc(ir || '-')}
                            · ${esc(child.origin || '-')}
                        </div>
                    </div>
                </div>

                <span
                    class="badge badge-light border px-2 py-1"
                >
                    ULUSAL
                </span>
            `;

            item.addEventListener(
                'click',
                () => {
                    this.selectRecord(child.id);

                    if (
                        typeof window.$ !== 'undefined'
                    ) {
                        window.$(
                            '#wipoSelectionModal'
                        ).modal('hide');
                    }
                }
            );

            listEl.appendChild(item);
            allRows.push(item);
        }

        const updateCount = () => {
            const visibleChildren =
                allRows.filter((row, index) => {
                    if (
                        parent &&
                        index === 0
                    ) {
                        return false;
                    }

                    return !row.classList.contains(
                        'international-family-hidden'
                    );
                }).length;

            if (countEl) {
                countEl.textContent =
                    `${visibleChildren} / ${uniqueChildren.length} ulusal kayıt`;
            }
        };

        if (searchInput) {
            searchInput.value = '';

            searchInput.oninput = () => {
                const q = norm(
                    searchInput.value
                );

                allRows.forEach((row) => {
                    const matches =
                        !q ||
                        String(
                            row.dataset.search || ''
                        ).includes(q);

                    row.classList.toggle(
                        'international-family-hidden',
                        !matches
                    );
                });

                updateCount();
            };
        }

        updateCount();

        // Modal başlığını daha açıklayıcı hale getir.
        const titleEl =
            modalEl.querySelector(
                '.modal-title'
            );

        if (titleEl) {
            titleEl.innerHTML = `
                <i class="fas fa-sitemap mr-2"></i>
                Uluslararası Kayıt / Ülke Seçimi
                <small class="text-muted ml-2">
                    ${esc(getInternationalNumber(parent) || '')}
                </small>
            `;
        }

        if (
            typeof window.$ !== 'undefined'
        ) {
            window.$(
                '#wipoSelectionModal'
            ).modal('show');

            setTimeout(() => {
                searchInput?.focus();
            }, 250);
        }
    };

    // Eski fonksiyona yapılan tüm çağrıları da yeni modal UX'ine yönlendir.
    proto._openWipoSelectionModal = function(
        parent,
        children
    ) {
        return this._openInternationalFamilyModal(
            parent,
            children
        );
    };

    proto.handleManualSearch = async function(
        query
    ) {
        const result =
            await previousManualSearch.call(
                this,
                query
            );

        const families =
            matchingInternationalFamilies(
                this,
                query
            );

        if (families.length > 0) {
            insertFamilySection(
                this,
                families
            );
        }

        return result;
    };

    proto.selectRecordWithHierarchy = async function(
        record
    ) {
        if (
            !record ||
            !isInternationalRecord(record) ||
            getHierarchy(record) !== 'parent'
        ) {
            return previousSelectRecordWithHierarchy.call(
                this,
                record
            );
        }

        const family =
            getFamily(this, record);

        if (family.children.length > 0) {
            this._openInternationalFamilyModal(
                family.parent || record,
                family.children
            );

            return;
        }

        // allRecords'ta child bulunamazsa DB fallback.
        if (
            window.SimpleLoadingController
        ) {
            window.SimpleLoadingController.show({
                text: 'Alt ülke kayıtları yükleniyor...'
            });
        }

        try {
            const parentId =
                String(record.id || '');

            const parentIr =
                normalizeInternationalNumber(
                    getInternationalNumber(record)
                );

            const {
                data: childrenData,
                error
            } = await supabase
                .from('ip_records')
                .select(`
                    *,
                    details:ip_record_trademark_details(brand_name)
                `)
                .eq(
                    'transaction_hierarchy',
                    'child'
                );

            if (error) throw error;

            const children =
                (childrenData || []).filter(
                    (child) => {
                        if (
                            String(
                                child.parent_id || ''
                            ) === parentId
                        ) {
                            return true;
                        }

                        if (!parentIr) return false;

                        return (
                            normalizeInternationalNumber(
                                child.wipo_ir ||
                                child.aripo_ir
                            ) === parentIr
                        );
                    }
                );

            if (children.length > 0) {
                this._openInternationalFamilyModal(
                    record,
                    children
                );

                return;
            }

            return previousSelectRecordWithHierarchy.call(
                this,
                record
            );

        } catch (error) {
            console.error(
                '[WIPO/ARIPO FAMILY HOTFIX V2]',
                error
            );

            return previousSelectRecordWithHierarchy.call(
                this,
                record
            );

        } finally {
            if (
                window.SimpleLoadingController
            ) {
                window.SimpleLoadingController.hide();
            }
        }
    };

    ensureStyles();
}
