// ============================================================
// Deadreckoner — create-workspace Edge Function
//
// Deploy with: supabase functions deploy create-workspace
//
// Why this needs to be a server-side function rather than a plain
// client insert: after creating the workspace, the founding user's
// auth.users.app_metadata.workspace_id needs to be set so every RLS
// policy in schema.sql (which reads auth.jwt() -> app_metadata ->>
// 'workspace_id') actually scopes their data correctly. Only the
// service_role key can update another user's app_metadata — that's
// why this can't just be a client-side insert into `workspaces`.
//
// Called from the browser via:
//   supabase.functions.invoke('create-workspace', { body: { company_name, company_url } })
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { company_name, company_url } = await req.json();
    if (!company_name || typeof company_name !== 'string') {
      return jsonResponse({ error: 'company_name is required' }, 400);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return jsonResponse({ error: 'Could not resolve the calling user.' }, 401);
    }
    const user = userData.user;

    if (user.app_metadata?.workspace_id) {
      return jsonResponse({ error: 'This user already belongs to a workspace.', workspace_id: user.app_metadata.workspace_id }, 409);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // 1. Create the workspace.
    const { data: workspace, error: wsError } = await adminClient
      .from('workspaces')
      .insert({ name: company_name, company_url: company_url || null })
      .select()
      .single();

    if (wsError) return jsonResponse({ error: 'Failed to create workspace: ' + wsError.message }, 500);

    // 2. Add the calling user as the founding admin.
    const { error: memberError } = await adminClient
      .from('workspace_members')
      .insert({ workspace_id: workspace.id, user_id: user.id, role: 'admin' });

    if (memberError) {
      // Roll back the orphaned workspace rather than leaving a half-created one behind.
      await adminClient.from('workspaces').delete().eq('id', workspace.id);
      return jsonResponse({ error: 'Failed to add founding admin: ' + memberError.message }, 500);
    }

    // 3. Stamp workspace_id onto the user's app_metadata so RLS policies work everywhere else.
    const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(user.id, {
      app_metadata: { ...user.app_metadata, workspace_id: workspace.id, role: 'admin' }
    });

    if (authUpdateError) {
      return jsonResponse({ error: 'Workspace created but app_metadata update failed: ' + authUpdateError.message, workspace_id: workspace.id }, 500);
    }

    await adminClient.from('events').insert({
      workspace_id: workspace.id,
      user_id: user.id,
      event_type: 'workspace.created',
      metadata: { company_name, company_url }
    });

    return jsonResponse({ workspace_id: workspace.id });
  } catch (err) {
    console.error('create-workspace error:', err);
    return jsonResponse({ error: String(err) }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
