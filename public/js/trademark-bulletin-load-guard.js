// public/js/trademark-bulletin-load-guard.js
// Bulletin selection stability guard.
// Keeps the existing trademark-similarity-search.js loading mechanism intact,
// but serializes bulletin change loads and retries transient/blank failures.

(() => {
    'use strict';

    if (window.__IPGATE_BULLETIN_LOAD_GUARD__) return;
    window.__IPGATE_BULLETIN_LOAD_GUARD__ = true;

    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
    const wrappedListeners = new WeakMap();

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const isTargetListener = (target, type, listener) => {
        return target instanceof HTMLSelectElement &&
            target.id === 'bulletinSelect' &&
            type === 'change' &&
            typeof listener === 'function' &&
            listener.name === 'checkCacheAndToggleButtonStates';
    };

    const makeGuardedListener = (listener) => {
        let running = false;
        let pendingJob = null;
        let sequence = 0;

        const guarded = async function(event) {
            const select = this;
            const selectedValue = String(select?.value || '');
            const seq = ++sequence;

            // Always keep only the latest pending selection. If another bulletin is
            // selected while a request is running, the newest selection runs last.
            pendingJob = { event, select, selectedValue, seq };
            if (running) return;

            running = true;
            try {
                // Small coalescing window prevents rapid dropdown changes from
                // launching unnecessary back-to-back loads.
                await sleep(60);

                while (pendingJob) {
                    const job = pendingJob;
                    pendingJob = null;

                    if (!job.selectedValue || String(job.select.value || '') !== job.selectedValue) {
                        continue;
                    }

                    let attempt = 0;
                    const maxAttempts = 3;

                    while (attempt < maxAttempts) {
                        attempt += 1;

                        // A fresh bulletin load should create its own success/error state.
                        // Clearing only the message area does not alter the existing result
                        // loading mechanism or its data structures.
                        const info = document.getElementById('infoMessageContainer');
                        if (info) info.innerHTML = '';

                        try {
                            await listener.call(job.select, job.event);
                        } catch (err) {
                            console.warn('[BulletinLoadGuard] Bülten yükleme çağrısı hata verdi:', err);
                        }

                        // A newer selection arrived while this request was running.
                        // Do not retry the stale bulletin; process the newest one next.
                        if (pendingJob || String(job.select.value || '') !== job.selectedValue) {
                            break;
                        }

                        const successVisible = !!info?.querySelector('.info-message.success');
                        const errorVisible = !!info?.querySelector('.info-message.error');
                        const startBtn = document.getElementById('startSearchBtn');
                        const researchBtn = document.getElementById('researchBtn');

                        // Legitimate "no cache yet" state: the page enables first search
                        // and keeps re-search disabled. This is not a load failure.
                        const legitimateNoCache = !errorVisible && !successVisible &&
                            startBtn && startBtn.disabled === false &&
                            researchBtn && researchBtn.disabled === true;

                        if (successVisible || legitimateNoCache) {
                            break;
                        }

                        if (attempt < maxAttempts) {
                            console.warn(`[BulletinLoadGuard] ${job.selectedValue} sonuçları tamamlanmadı; yeniden deneniyor (${attempt + 1}/${maxAttempts}).`);
                            await sleep(attempt === 1 ? 250 : 650);
                        }
                    }
                }
            } finally {
                running = false;

                // A selection can arrive between the loop exit and finally block.
                // Re-dispatch once so the latest value cannot remain unprocessed.
                if (pendingJob) {
                    const latest = pendingJob;
                    pendingJob = null;
                    queueMicrotask(() => {
                        latest.select.dispatchEvent(new Event('change', { bubbles: true }));
                    });
                }
            }
        };

        return guarded;
    };

    EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (isTargetListener(this, type, listener)) {
            let wrapped = wrappedListeners.get(listener);
            if (!wrapped) {
                wrapped = makeGuardedListener(listener);
                wrappedListeners.set(listener, wrapped);
            }
            return nativeAddEventListener.call(this, type, wrapped, options);
        }
        return nativeAddEventListener.call(this, type, listener, options);
    };

    EventTarget.prototype.removeEventListener = function(type, listener, options) {
        const wrapped = typeof listener === 'function' ? wrappedListeners.get(listener) : null;
        return nativeRemoveEventListener.call(this, type, wrapped || listener, options);
    };
})();
