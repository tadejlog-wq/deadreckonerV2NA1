// ============================================================
// Deadreckoner — brand.html AI scrape-review panel.
// Kept as its own file (rather than inline) so brand.html can keep
// a strict script-src 'self' CSP with no 'unsafe-inline'.
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  if (!window.deadreckonerDB) return;

  const { role } = await window.deadreckonerDB.getCurrentUserRole();
  const canReview = role === 'admin' || role === 'member';

  const section = document.querySelector('#sec-scrape-review');
  const grid = document.querySelector('#scrapeReviewGrid');
  const countEl = document.querySelector('#scrapeReviewCount');
  if (!section || !grid) return;

  const { data: candidates, error } = await window.deadreckonerDB.loadScrapeCandidates();
  if (error || !candidates || candidates.length === 0) return;

  section.style.display = '';
  countEl.textContent = candidates.length + (candidates.length === 1 ? ' suggestion' : ' suggestions');

  candidates.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'scrape-card';
    card.dataset.candidateId = c.id;

    let previewHtml = '';
    if (c.asset_type === 'image') {
      previewHtml = `<div class="scrape-card-preview"><img src="${c.raw_value}" alt="" loading="lazy" onerror="this.parentElement.textContent='Preview unavailable'"></div>`;
    } else if (c.asset_type === 'color') {
      previewHtml = `<div class="scrape-card-preview"><div class="scrape-card-swatch" style="background:${c.raw_value}"></div></div>`;
    } else if (c.asset_type === 'font') {
      previewHtml = `<div class="scrape-card-preview"><span class="scrape-card-font" style="font-family:'${c.raw_value.replace(/'/g, "\\'")}'">Aa Bb Cc</span></div>`;
    } else {
      previewHtml = `<div class="scrape-card-preview"><span class="scrape-card-font" style="font-size:12px;color:var(--text-secondary)">"${escapeHtml(truncate(c.raw_value, 80))}"</span></div>`;
    }

    const confidencePct = Math.round((c.confidence || 0) * 100);

    card.innerHTML = `
      ${previewHtml}
      <span class="scrape-card-category">${escapeHtml(c.proposed_category || 'Uncategorized')}</span>
      <span class="scrape-card-slot">${escapeHtml(c.proposed_slot || 'Unnamed slot')}</span>
      <span class="scrape-card-confidence">${confidencePct}% confidence</span>
      <p class="scrape-card-reasoning">${escapeHtml(c.reasoning || '')}</p>
      <div class="scrape-card-actions" ${canReview ? '' : 'style="display:none"'}>
        <button class="scrape-action-btn accept" data-action="accept">Accept</button>
        <button class="scrape-action-btn reject" data-action="reject">Reject</button>
      </div>
    `;

    grid.appendChild(card);
  });

  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('.scrape-action-btn');
    if (!btn) return;
    const card = btn.closest('.scrape-card');
    const candidateId = card.dataset.candidateId;
    const decision = btn.dataset.action === 'accept' ? 'accepted' : 'rejected';

    card.classList.add('processed');
    await window.deadreckonerDB.reviewScrapeCandidate(candidateId, decision);

    const remaining = grid.querySelectorAll('.scrape-card:not(.processed)').length;
    countEl.textContent = remaining + (remaining === 1 ? ' suggestion' : ' suggestions');
    if (remaining === 0) {
      setTimeout(() => { section.style.display = 'none'; }, 400);
    }
  });
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}
