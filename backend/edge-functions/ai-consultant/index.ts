// ============================================================
// Deadreckoner — ai-consultant Edge Function
//
// Deploy with: supabase functions deploy ai-consultant
// Requires: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// Replaces the hardcoded mock response in assets.html's chat UI
// ("I'm processing your request. In production this sends to the
// ai-consultant Edge Function...") with a real Claude call that's
// grounded in the workspace's actual brand rules — this is the
// "brand-constrained" behavior the chat UI already promises.
//
// Called from the browser via:
//   supabase.functions.invoke('ai-consultant', { body: { message, conversation_history } })
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { callLLM } from '../_shared/llm.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { message, conversation_history } = await req.json();
    if (!message || typeof message !== 'string') {
      return jsonResponse({ error: 'message is required' }, 400);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return jsonResponse({ error: 'Could not resolve the calling user.' }, 401);
    }
    const workspaceId = userData.user.app_metadata?.workspace_id;

    // Ground the assistant in this workspace's actual approved brand data —
    // this is what "brand-constrained" means in practice: it answers from
    // real rules and real maturity state, not generic brand advice.
    let brandContext = 'No brand rules have been approved yet for this workspace — answer from general brand governance best practice, and mention that specifics will improve once rules are approved.';
    if (workspaceId) {
      const { data: submissions } = await userClient
        .from('asset_submissions')
        .select('slot_name, category, status')
        .eq('workspace_id', workspaceId)
        .eq('status', 'approved');

      if (submissions && submissions.length > 0) {
        brandContext = `This workspace has ${submissions.length} approved brand asset(s) so far: ${submissions.map((s: any) => `${s.slot_name} (${s.category})`).join(', ')}. Answer with awareness of what's already approved versus still missing.`;
      }
    }

    const systemPrompt = `You are the Brand AI Consultant inside Deadreckoner, a brand governance platform. You help the user with three things: generating on-brand asset ideas, auditing files against brand standards, and answering questions about brand rules and next steps toward full brand maturity.

Context for this workspace: ${brandContext}

Keep responses concise and practical — this is a chat panel, not a report. If the user asks you to generate an asset, describe what you'd produce and note that actual file generation happens through the taxonomy grid's upload flow, not directly in this chat. If asked about brand rules, be specific about what's approved versus still open.`;

    const messages = [
      ...(Array.isArray(conversation_history) ? conversation_history : []),
      { role: 'user', content: message }
    ];

    const result = await callLLM(systemPrompt, messages, 1024);

    if (result.error) {
      return jsonResponse({ error: result.error }, 502);
    }
    const replyText = result.text;

    if (workspaceId) {
      const adminClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      await adminClient.from('events').insert({
        workspace_id: workspaceId,
        user_id: userData.user.id,
        event_type: 'ai_consultant.message_sent',
        metadata: { message_length: message.length }
      });
    }

    return jsonResponse({ reply: replyText });
  } catch (err) {
    console.error('ai-consultant error:', err);
    return jsonResponse({ error: String(err) }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
