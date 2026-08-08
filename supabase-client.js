// ============================================================
// Deadreckoner — shared Supabase client.
//
// SETUP REQUIRED before this does anything real:
// 1. Run backend/schema.sql in your Supabase project's SQL editor.
// 2. Replace the two placeholder values below with your actual
//    project URL and anon/publishable key (Project Settings > API).
//    Never put a service_role key here — this file ships to the browser.
// 3. Create two Storage buckets in the Supabase dashboard:
//    "request-attachments" and "asset-submissions" (both private,
//    accessed only through signed URLs / RLS-scoped policies).
// 4. Every signed-in user needs `workspace_id` set in their
//    app_metadata (Supabase Dashboard > Authentication > Users, or
//    via your own signup flow) for the RLS policies in schema.sql
//    to actually scope data per-tenant. Until that's wired, requests
//    and asset submissions will fail RLS checks for real users —
//    this file will still work for local testing against a
//    service-role-created test row, but treat that as a stopgap,
//    not the real auth story.
// ============================================================

const SUPABASE_URL = 'YOUR_SUPABASE_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

let _client = null;

function getClient() {
  if (_client) return _client;
  if (typeof window.supabase === 'undefined') {
    console.error('Supabase JS SDK not loaded. Add this to <head> before supabase-client.js:\n<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>');
    return null;
  }
  if (SUPABASE_URL === 'YOUR_SUPABASE_PROJECT_URL' || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') {
    console.warn('supabase-client.js: placeholder credentials still in place — backend calls will fail until these are set.');
  }
  _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

// ── REQUESTS ──────────────────────────────────────────────

async function dbSubmitRequest({ title, type, priority, description, files }) {
  const client = getClient();
  if (!client) return { error: 'Supabase client not configured.' };

  const { data: userData } = await client.auth.getUser();
  const workspaceId = userData?.user?.app_metadata?.workspace_id;
  if (!workspaceId) {
    return { error: 'No workspace found for the current user — sign in, or check app_metadata.workspace_id is set.' };
  }

  const { data: request, error } = await client
    .from('requests')
    .insert({
      workspace_id: workspaceId,
      title,
      type,
      priority,
      description,
      file_count: files ? files.length : 0,
      created_by: userData.user.id
    })
    .select()
    .single();

  if (error) return { error: error.message };

  dbLogEvent('request.submitted', { entityType: 'request', entityId: request.id, metadata: { type, priority } });

  if (files && files.length > 0) {
    for (const file of files) {
      const path = `${workspaceId}/${request.id}/${file.name}`;
      const { error: uploadError } = await client.storage
        .from('request-attachments')
        .upload(path, file);
      if (uploadError) {
        console.error('Attachment upload failed for', file.name, uploadError.message);
        continue;
      }
      await client.from('request_attachments').insert({
        request_id: request.id,
        file_name: file.name,
        storage_path: path,
        size_bytes: file.size
      });
    }
  }

  return { data: request };
}

async function dbLoadRequests() {
  const client = getClient();
  if (!client) return { error: 'Supabase client not configured.', data: [] };

  const { data, error } = await client
    .from('requests')
    .select('*')
    .order('updated_at', { ascending: false });

  return { data: data || [], error: error?.message };
}

async function dbUpdateRequestStatus(requestId, newStatus) {
  const client = getClient();
  if (!client) return { error: 'Supabase client not configured.' };

  const { error } = await client
    .from('requests')
    .update({ status: newStatus })
    .eq('id', requestId);

  return { error: error?.message };
}

// ── ASSET SUBMISSIONS ─────────────────────────────────────

async function dbSubmitAssetSlot({ slotId, slotName, category, files }) {
  const client = getClient();
  if (!client) return { error: 'Supabase client not configured.' };

  const { data: userData } = await client.auth.getUser();
  const workspaceId = userData?.user?.app_metadata?.workspace_id;
  if (!workspaceId) {
    return { error: 'No workspace found for the current user — sign in, or check app_metadata.workspace_id is set.' };
  }

  const { data: submission, error } = await client
    .from('asset_submissions')
    .insert({
      workspace_id: workspaceId,
      slot_id: slotId,
      slot_name: slotName,
      category,
      submitted_by: userData.user.id
    })
    .select()
    .single();

  if (error) return { error: error.message };

  dbLogEvent('asset_submission.created', { entityType: 'asset_submission', entityId: submission.id, metadata: { slot_id: submission.slot_id, category } });

  if (files && files.length > 0) {
    for (const file of files) {
      const path = `${workspaceId}/${submission.id}/${file.name}`;
      const { error: uploadError } = await client.storage
        .from('asset-submissions')
        .upload(path, file);
      if (uploadError) {
        console.error('Submission file upload failed for', file.name, uploadError.message);
        continue;
      }
      await client.from('asset_submission_files').insert({
        submission_id: submission.id,
        file_name: file.name,
        storage_path: path,
        size_bytes: file.size
      });
    }
  }

  return { data: submission };
}

// ── LANDING PAGE SIGNUPS ──────────────────────────────────
// Public insert, no auth required — matches the "signups_public_insert" policy.

async function dbSubmitSignup(email) {
  const client = getClient();
  if (!client) return { error: 'Supabase client not configured.' };

  const { error } = await client
    .from('signups')
    .insert({ email, source: 'landing_page' });

  if (error) {
    if (error.code === '23505') {
      // unique constraint on email — treat as a soft success, not a failure
      return { data: true };
    }
    return { error: error.message };
  }
  dbLogEvent('signup.completed', { entityType: 'signup', metadata: { source: 'landing_page' } });
  return { data: true };
}

// ── EVENT LOGGING ─────────────────────────────────────────
// Fire-and-forget: log every meaningful action for the events table.
// Never awaited by callers — logging failures should never block the UI.

async function dbLogEvent(eventType, { entityType, entityId, metadata } = {}) {
  const client = getClient();
  if (!client) return;
  try {
    const { data: userData } = await client.auth.getUser();
    const workspaceId = userData?.user?.app_metadata?.workspace_id || null;
    await client.from('events').insert({
      workspace_id: workspaceId,
      user_id: userData?.user?.id || null,
      event_type: eventType,
      entity_type: entityType || null,
      entity_id: entityId || null,
      metadata: metadata || {}
    });
  } catch (e) {
    console.warn('Event log failed (non-blocking):', eventType, e);
  }
}

// ── ROLE / CURRENT USER ───────────────────────────────────

async function dbGetCurrentUserRole() {
  const client = getClient();
  if (!client) return { role: null };
  const { data: userData } = await client.auth.getUser();
  if (!userData?.user) return { role: null };
  const workspaceId = userData.user.app_metadata?.workspace_id;
  if (!workspaceId) return { role: null };

  const { data, error } = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userData.user.id)
    .single();

  if (error) return { role: null, error: error.message };
  return { role: data?.role || null };
}

// Call once per page load on any page with admin-only controls.
// Hides elements marked [data-admin-only] unless the current user is an admin.
async function dbApplyRoleGating() {
  const { role } = await dbGetCurrentUserRole();
  const isAdmin = role === 'admin';
  document.querySelectorAll('[data-admin-only]').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  document.querySelectorAll('[data-member-or-admin]').forEach(el => {
    el.style.display = (role === 'admin' || role === 'member') ? '' : 'none';
  });
  return role;
}

// ── WORKSPACE CREATION (first-time onboarding) ────────────

async function dbCreateWorkspace(companyName, companyUrl) {
  const client = getClient();
  if (!client) return { error: 'Supabase client not configured.' };

  const { data, error } = await client.functions.invoke('create-workspace', {
    body: { company_name: companyName, company_url: companyUrl }
  });

  if (error) return { error: error.message };

  // The user's session JWT was issued before app_metadata.workspace_id existed —
  // refresh it now, or every RLS-scoped call made right after this will fail.
  const { error: refreshError } = await client.auth.refreshSession();
  if (refreshError) {
    console.warn('Session refresh after workspace creation failed — a manual reload may be needed:', refreshError.message);
  }

  return { data };
}

// ── AI CONSULTANT CHAT ────────────────────────────────────

async function dbAskConsultant(message, conversationHistory) {
  const client = getClient();
  if (!client) return { error: 'Supabase client not configured.' };

  const { data, error } = await client.functions.invoke('ai-consultant', {
    body: { message, conversation_history: conversationHistory || [] }
  });

  if (error) return { error: error.message };
  return { data };
}

// ── ONBOARDING / SCRAPE PIPELINE ──────────────────────────

async function dbStartOnboardingScrape(companyUrl) {
  const client = getClient();
  if (!client) return { error: 'Supabase client not configured.' };

  // Calls the "onboarding-scrape" Edge Function — see backend/edge-functions/onboarding-scrape/
  const { data, error } = await client.functions.invoke('onboarding-scrape', {
    body: { company_url: companyUrl }
  });

  if (error) return { error: error.message };
  return { data };
}

async function dbLoadScrapeCandidates() {
  const client = getClient();
  if (!client) return { data: [], error: 'Supabase client not configured.' };

  const { data, error } = await client
    .from('scrape_candidates')
    .select('*')
    .eq('review_status', 'pending')
    .order('confidence', { ascending: false });

  return { data: data || [], error: error?.message };
}

async function dbReviewScrapeCandidate(candidateId, decision) {
  const client = getClient();
  if (!client) return { error: 'Supabase client not configured.' };

  const { error } = await client
    .from('scrape_candidates')
    .update({ review_status: decision })
    .eq('id', candidateId);

  if (!error) dbLogEvent('scrape_candidate.' + decision, { entityType: 'scrape_candidate', entityId: candidateId });
  return { error: error?.message };
}

// Expose on window so existing inline scripts can call these without a bundler.
window.deadreckonerDB = {
  getClient,
  submitRequest: dbSubmitRequest,
  loadRequests: dbLoadRequests,
  updateRequestStatus: dbUpdateRequestStatus,
  submitAssetSlot: dbSubmitAssetSlot,
  submitSignup: dbSubmitSignup,
  logEvent: dbLogEvent,
  getCurrentUserRole: dbGetCurrentUserRole,
  applyRoleGating: dbApplyRoleGating,
  createWorkspace: dbCreateWorkspace,
  askConsultant: dbAskConsultant,
  startOnboardingScrape: dbStartOnboardingScrape,
  loadScrapeCandidates: dbLoadScrapeCandidates,
  reviewScrapeCandidate: dbReviewScrapeCandidate
};
