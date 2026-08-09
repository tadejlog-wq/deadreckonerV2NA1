// ============================================================
// Deadreckoner — auth guard.
// Loaded on every authenticated app page. Redirects signed-out
// visitors to the landing page before app content is usable.
// ============================================================
(() => {
  const LANDING = 'index.html';

  function hideBody() {
    document.documentElement.style.visibility = 'hidden';
  }
  function showBody() {
    document.documentElement.style.visibility = '';
  }

  hideBody();

  async function check() {
    // Wait for supabase-client.js to register itself.
    let tries = 0;
    while (!window.deadreckonerDB && tries < 50) {
      await new Promise((r) => setTimeout(r, 40));
      tries++;
    }
    if (!window.deadreckonerDB) { showBody(); return; }

    const client = window.deadreckonerDB.getClient();
    if (!client) { showBody(); return; }

    const { data } = await client.auth.getSession();
    if (!data || !data.session) {
      window.location.replace(LANDING);
      return;
    }
    showBody();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
})();
