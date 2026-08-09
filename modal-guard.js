// ============================================================
// Deadreckoner — modal guard.
// 1. Suppresses the floating nav + advisor while any modal is open.
// 2. Warns before navigating away from a form with unsaved input.
// ============================================================
(() => {
  const SELECTORS = '.modal-backdrop.open, .popup-overlay.open, .popup-overlay[style*="display: grid"]';

  function anyModalOpen() {
    return !!document.querySelector('.modal-backdrop.open, .popup-overlay.open');
  }

  function sync() {
    const open = anyModalOpen();
    document.querySelectorAll('.side-dock, .advisor-wrap').forEach((el) => {
      el.style.opacity = open ? '0' : '';
      el.style.pointerEvents = open ? 'none' : '';
      el.setAttribute('aria-hidden', open ? 'true' : 'false');
    });
  }

  const mo = new MutationObserver(sync);
  mo.observe(document.documentElement, {
    attributes: true, subtree: true, attributeFilter: ['class', 'style']
  });
  document.addEventListener('DOMContentLoaded', sync);
  sync();

  // ── Unsaved-input protection ──────────────────────────────
  function isDirty() {
    const fields = document.querySelectorAll(
      '.rf-modal input, .rf-modal textarea, .slot-modal input, .ob-modal input'
    );
    for (const f of fields) {
      if (f.type === 'file') continue;
      if (f.value && f.value.trim() !== '') return true;
    }
    return false;
  }

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (!anyModalOpen() || !isDirty()) return;
    if (!confirm('You have unsaved changes. Leave this page and discard them?')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
})();
