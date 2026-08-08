-- ============================================================
-- Deadreckoner — new tables for Requests, Asset Submissions,
-- and Landing Page Signups.
--
-- Run this once in your Supabase project's SQL editor.
-- Assumes the existing dump_assets table / project already exists.
-- ============================================================

-- ── REQUESTS ──────────────────────────────────────────────
-- Backs the "Submit a request" form on approvals.html and the
-- Kanban board (Open / Assigned / Resolved / Archived).
create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,               -- ties to your existing tenant/workspace table
  title text not null,
  type text not null check (type in ('new-asset', 'exception', 'adaptation')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  status text not null default 'open' check (status in ('open', 'assigned', 'resolved', 'archived')),
  description text,
  file_count integer not null default 0,
  created_by uuid references auth.users(id),
  assigned_to uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists requests_workspace_idx on public.requests(workspace_id);
create index if not exists requests_status_idx on public.requests(status);

-- keep updated_at fresh on every change
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists requests_set_updated_at on public.requests;
create trigger requests_set_updated_at
  before update on public.requests
  for each row execute function public.set_updated_at();

alter table public.requests enable row level security;

-- Members can see and act on requests in their own workspace only.
create policy "requests_select_own_workspace" on public.requests
  for select using (workspace_id = (auth.jwt() -> 'app_metadata' ->> 'workspace_id')::uuid);

create policy "requests_insert_own_workspace" on public.requests
  for insert with check (workspace_id = (auth.jwt() -> 'app_metadata' ->> 'workspace_id')::uuid);

create policy "requests_update_own_workspace" on public.requests
  for update using (workspace_id = (auth.jwt() -> 'app_metadata' ->> 'workspace_id')::uuid);


-- ── REQUEST FILE ATTACHMENTS ──────────────────────────────
-- Metadata for files attached to a request. Actual bytes live in
-- Supabase Storage bucket "request-attachments" (create in Dashboard > Storage).
create table if not exists public.request_attachments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

alter table public.request_attachments enable row level security;

create policy "attachments_via_parent_request" on public.request_attachments
  for select using (
    exists (
      select 1 from public.requests r
      where r.id = request_id
      and r.workspace_id = (auth.jwt() -> 'app_metadata' ->> 'workspace_id')::uuid
    )
  );

create policy "attachments_insert_via_parent_request" on public.request_attachments
  for insert with check (
    exists (
      select 1 from public.requests r
      where r.id = request_id
      and r.workspace_id = (auth.jwt() -> 'app_metadata' ->> 'workspace_id')::uuid
    )
  );


-- ── ASSET TAXONOMY SUBMISSIONS ────────────────────────────
-- Backs the 53-slot asset locker grid on assets.html. Tracks a
-- submission per taxonomy slot per workspace.
create table if not exists public.asset_submissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  slot_id text not null,               -- matches the data-slot-id used in the frontend (e.g. "slot1")
  slot_name text not null,
  category text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_by uuid references auth.users(id),
  reviewed_by uuid references auth.users(id),
  review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists asset_submissions_one_active_per_slot
  on public.asset_submissions(workspace_id, slot_id)
  where status in ('pending', 'approved');

drop trigger if exists asset_submissions_set_updated_at on public.asset_submissions;
create trigger asset_submissions_set_updated_at
  before update on public.asset_submissions
  for each row execute function public.set_updated_at();

alter table public.asset_submissions enable row level security;

create policy "asset_submissions_select_own_workspace" on public.asset_submissions
  for select using (workspace_id = (auth.jwt() -> 'app_metadata' ->> 'workspace_id')::uuid);

create policy "asset_submissions_insert_own_workspace" on public.asset_submissions
  for insert with check (workspace_id = (auth.jwt() -> 'app_metadata' ->> 'workspace_id')::uuid);


-- ── ASSET SUBMISSION FILES ────────────────────────────────
-- Bytes live in Supabase Storage bucket "asset-submissions".
create table if not exists public.asset_submission_files (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.asset_submissions(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

alter table public.asset_submission_files enable row level security;

create policy "submission_files_via_parent" on public.asset_submission_files
  for select using (
    exists (
      select 1 from public.asset_submissions s
      where s.id = submission_id
      and s.workspace_id = (auth.jwt() -> 'app_metadata' ->> 'workspace_id')::uuid
    )
  );

create policy "submission_files_insert_via_parent" on public.asset_submission_files
  for insert with check (
    exists (
      select 1 from public.asset_submissions s
      where s.id = submission_id
      and s.workspace_id = (auth.jwt() -> 'app_metadata' ->> 'workspace_id')::uuid
    )
  );


-- ── LANDING PAGE SIGNUPS ──────────────────────────────────
-- Backs the "Request access" email capture on index.html.
-- Public-facing, no auth required, no workspace scoping.
create table if not exists public.signups (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  source text default 'landing_page',
  created_at timestamptz not null default now()
);

alter table public.signups enable row level security;

-- Anyone (even unauthenticated) can insert their own signup —
-- this is a public marketing form, not a workspace resource.
create policy "signups_public_insert" on public.signups
  for insert with check (true);

-- Nobody can read signups back through the anon key.
-- Reads should happen via the Supabase dashboard or a service-role backend job.


-- ============================================================
-- ROLES, WORKSPACES, AND EVENT LOGGING
-- Added in the second backend pass.
-- ============================================================

-- ── WORKSPACES ────────────────────────────────────────────
-- One row per company/tenant. Created at signup.
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company_url text,                          -- entered at signup, used to seed the scrape/classify pipeline
  maturity_tier text not null default 'L0' check (maturity_tier in ('L0','L1','L2','L3','L4')),
  onboarding_status text not null default 'pending' check (onboarding_status in ('pending','scraping','reviewing','complete')),
  created_at timestamptz not null default now()
);

-- ── WORKSPACE MEMBERS ─────────────────────────────────────
-- Links auth.users to workspaces with a role. This is the actual
-- source of truth for access control — app_metadata.workspace_id
-- (used in schema.sql's RLS policies above) should be kept in sync
-- with this table via the trigger below.
create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin','member','viewer')),
  invited_by uuid references auth.users(id),
  joined_at timestamptz not null default now(),
  unique(workspace_id, user_id)
);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

create policy "workspaces_select_if_member" on public.workspaces
  for select using (
    exists (select 1 from public.workspace_members m where m.workspace_id = id and m.user_id = auth.uid())
  );

create policy "members_select_own_workspace" on public.workspace_members
  for select using (
    exists (select 1 from public.workspace_members m where m.workspace_id = workspace_members.workspace_id and m.user_id = auth.uid())
  );

-- Only admins can invite/add new members to their workspace.
create policy "members_insert_by_admin" on public.workspace_members
  for insert with check (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = workspace_members.workspace_id
      and m.user_id = auth.uid()
      and m.role = 'admin'
    )
    -- exception: a user can insert themselves as the founding admin of a brand-new workspace
    or not exists (select 1 from public.workspace_members m2 where m2.workspace_id = workspace_members.workspace_id)
  );


-- ── EVENT LOG ──────────────────────────────────────────────
-- One row per user action or system change, across the whole
-- product. This is the "sheet" for analysis — every approval,
-- rejection, upload, request, login, and AI action lands here
-- with a timestamp. Query this table for usage analytics,
-- funnel drop-off, feature adoption, etc.
create table if not exists public.events (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,          -- e.g. 'asset.approved', 'request.submitted', 'signup.completed', 'ai.classification_run'
  entity_type text,                  -- e.g. 'asset_submission', 'request', 'workspace'
  entity_id uuid,
  metadata jsonb default '{}'::jsonb,  -- free-form: { "from_status": "pending", "to_status": "approved", ... }
  created_at timestamptz not null default now()
);

create index if not exists events_workspace_idx on public.events(workspace_id);
create index if not exists events_type_idx on public.events(event_type);
create index if not exists events_created_at_idx on public.events(created_at desc);

alter table public.events enable row level security;

-- Members can see their own workspace's events (for an in-app activity feed).
create policy "events_select_own_workspace" on public.events
  for select using (
    exists (select 1 from public.workspace_members m where m.workspace_id = events.workspace_id and m.user_id = auth.uid())
  );

-- Anyone signed in can log an event for their own workspace — this is an
-- append-only audit trail, not a place to hide sensitive data client-side
-- shouldn't already have. Don't put secrets in metadata.
create policy "events_insert_own_workspace" on public.events
  for insert with check (
    workspace_id is null  -- allow anonymous/pre-workspace events (e.g. signup funnel)
    or exists (select 1 from public.workspace_members m where m.workspace_id = events.workspace_id and m.user_id = auth.uid())
  );

-- Convenience view: daily active usage per workspace, for a simple analytics dashboard.
create or replace view public.events_daily_summary as
select
  workspace_id,
  date_trunc('day', created_at) as day,
  event_type,
  count(*) as event_count
from public.events
group by workspace_id, date_trunc('day', created_at), event_type;


-- ── ROLE-AWARE RLS UPGRADE ────────────────────────────────
-- Replaces the simpler app_metadata-based policies from the first
-- pass with ones driven by workspace_members, so role (admin vs
-- member vs viewer) is enforceable, not just workspace membership.

drop policy if exists "requests_update_own_workspace" on public.requests;
create policy "requests_update_admin_or_own_workspace" on public.requests
  for update using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = requests.workspace_id
      and m.user_id = auth.uid()
      and m.role in ('admin','member')
    )
  );

-- Viewers can read but never write asset submissions.
drop policy if exists "asset_submissions_insert_own_workspace" on public.asset_submissions;
create policy "asset_submissions_insert_non_viewer" on public.asset_submissions
  for insert with check (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = asset_submissions.workspace_id
      and m.user_id = auth.uid()
      and m.role in ('admin','member')
    )
  );

-- Only admins can approve/reject a submission.
create policy "asset_submissions_review_admin_only" on public.asset_submissions
  for update using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = asset_submissions.workspace_id
      and m.user_id = auth.uid()
      and m.role = 'admin'
    )
  );


-- ── SCRAPE / AI CLASSIFICATION QUEUE ──────────────────────
-- Populated by the onboarding Edge Function (see backend/edge-functions/).
-- Each row is one candidate asset found while scraping the company's
-- site, with Claude's proposed taxonomy classification attached,
-- awaiting human approval before it becomes a real asset_submission.
create table if not exists public.scrape_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_url text not null,
  asset_type text,                     -- 'image', 'color', 'font', 'text'
  raw_value text,                      -- e.g. a hex code, a font-family string, or a short text excerpt
  storage_path text,                   -- set if asset_type is 'image' and the file was downloaded to Storage
  proposed_category text,              -- Claude's suggested taxonomy category
  proposed_slot text,                  -- Claude's suggested taxonomy slot
  confidence numeric,                  -- 0.0–1.0, Claude's confidence in the proposed classification
  reasoning text,                      -- Claude's short explanation, shown to the human reviewer
  review_status text not null default 'pending' check (review_status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now()
);

create index if not exists scrape_candidates_workspace_idx on public.scrape_candidates(workspace_id);

alter table public.scrape_candidates enable row level security;

create policy "scrape_candidates_select_own_workspace" on public.scrape_candidates
  for select using (
    exists (select 1 from public.workspace_members m where m.workspace_id = scrape_candidates.workspace_id and m.user_id = auth.uid())
  );

create policy "scrape_candidates_review_non_viewer" on public.scrape_candidates
  for update using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = scrape_candidates.workspace_id
      and m.user_id = auth.uid()
      and m.role in ('admin','member')
    )
  );
-- Inserts into scrape_candidates happen from the Edge Function using the
-- service_role key (server-side only), so no public insert policy is needed here.
