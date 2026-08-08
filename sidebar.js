document.addEventListener('DOMContentLoaded', () => {
  const sideDock = document.getElementById('sideDock');

  if (!sideDock) {
    return;
  }

  sideDock.innerHTML = `
    <nav class="pill-nav" aria-label="Primary navigation">
      <a class="pill-item" href="dashboard.html" data-label="Dashboard">
        <span class="pill-highlight" aria-hidden="true"></span>
        <span class="pill-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x="3.5" y="3.5" width="7" height="7" rx="1.6"></rect>
            <rect x="13.5" y="3.5" width="7" height="4.7" rx="1.5"></rect>
            <rect x="13.5" y="11.2" width="7" height="9.3" rx="1.6"></rect>
            <rect x="3.5" y="13.5" width="7" height="7" rx="1.6"></rect>
          </svg>
        </span>
        <span class="pill-label">Dashboard</span>
      </a>

      <a class="pill-item" href="brand.html" data-label="Brand">
        <span class="pill-highlight" aria-hidden="true"></span>
        <span class="pill-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M4 5.7c2.7-1.2 5.4-.7 8 1.2v12.2c-2.6-1.9-5.3-2.4-8-1.2V5.7Z"></path>
            <path d="M20 5.7c-2.7-1.2-5.4-.7-8 1.2v12.2c2.6-1.9 5.3-2.4 8-1.2V5.7Z"></path>
            <path d="M12 7v12"></path>
          </svg>
        </span>
        <span class="pill-label">Brand</span>
      </a>

      <a class="pill-item" href="approvals.html" data-label="Requests &amp; Screening">
        <span class="pill-highlight" aria-hidden="true"></span>
        <span class="pill-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 3.2 19 6v5.2c0 4.25-2.8 7.55-7 9.6-4.2-2.05-7-5.35-7-9.6V6l7-2.8Z"></path>
            <path d="m8.8 12 2.05 2.05 4.4-4.45"></path>
          </svg>
        </span>
        <span class="pill-label">Requests &amp; Screening</span>
      </a>

      <a class="pill-item" href="assets.html" data-label="Assets">
        <span class="pill-highlight" aria-hidden="true"></span>
        <span class="pill-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M3.5 7.2h6.3l1.7 2h9v8.6a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.2Z"></path>
            <path d="M3.5 9.2h17"></path>
            <path d="M6.6 5h4.8l1.6 2.2"></path>
          </svg>
        </span>
        <span class="pill-label">Assets</span>
      </a>

      <span class="pill-divider" aria-hidden="true"></span>

      <a class="pill-item" href="profile-settings.html" data-label="Account">
        <span class="pill-highlight" aria-hidden="true"></span>
        <span class="pill-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="8" r="3.35"></circle>
            <path d="M5.2 19.6c.55-3.65 3.05-5.55 6.8-5.55s6.25 1.9 6.8 5.55"></path>
            <path d="M4 20.5h16"></path>
          </svg>
        </span>
        <span class="pill-label">Account</span>
      </a>
    </nav>
  `;

  const currentFilename = window.location.pathname.split('/').pop();

  sideDock.querySelectorAll('.pill-item').forEach((link) => {
    const linkFilename = new URL(
      link.getAttribute('href'),
      window.location.href
    ).pathname.split('/').pop();

    if (linkFilename === currentFilename) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    }
  });
});
