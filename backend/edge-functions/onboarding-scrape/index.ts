// ============================================================
// Deadreckoner — onboarding-scrape Edge Function
//
// Deploy with: supabase functions deploy onboarding-scrape
// Requires these secrets set on the Supabase project:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...  (usually auto-available as SUPABASE_SERVICE_ROLE_KEY)
//
// Called from the browser via:
//   supabase.functions.invoke('onboarding-scrape', { body: { company_url } })
//
// What it does:
// 1. Fetches the company's homepage HTML.
// 2. Pulls out candidate brand signals: logo <img> tags, colors
//    referenced in inline styles/CSS variables, font-family
//    declarations, and a short text excerpt (title/meta description)
//    for voice-and-tone analysis.
// 3. Sends those candidates to Claude, asking it to classify each
//    one against the Deadreckoner taxonomy (category + slot) with
//    a confidence score and a one-sentence reason.
// 4. Writes the results into scrape_candidates for human review —
//    this function never auto-approves anything.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TAXONOMY_CATEGORIES = [
  'Logo Usage', 'Color', 'Typography', 'Photography', 'Iconography',
  'Illustration', 'Voice & Tone', 'Templates', 'Motion', 'Audio', '3D Assets'
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { company_url } = await req.json();
    if (!company_url || typeof company_url !== 'string') {
      return jsonResponse({ error: 'company_url is required' }, 400);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) {
      return jsonResponse({ error: 'ANTHROPIC_API_KEY is not configured on this project.' }, 500);
    }

    // Client scoped to the calling user (to resolve their workspace_id via RLS-safe auth call).
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return jsonResponse({ error: 'Could not resolve the calling user.' }, 401);
    }
    const workspaceId = userData.user.app_metadata?.workspace_id;
    if (!workspaceId) {
      return jsonResponse({ error: 'Signed-in user has no workspace_id set in app_metadata.' }, 400);
    }

    // Service-role client for writing scrape_candidates (bypasses RLS — this is the
    // one place in the whole system that legitimately needs service_role, and it
    // never touches the browser).
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    await adminClient.from('workspaces').update({ onboarding_status: 'scraping' }).eq('id', workspaceId);

    // ── 1. Fetch and lightly parse the target page ──────────
    const pageRes = await fetch(company_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DeadreckonerBot/1.0; +https://deadreckoner.dev)' }
    });
    if (!pageRes.ok) {
      await adminClient.from('workspaces').update({ onboarding_status: 'pending' }).eq('id', workspaceId);
      return jsonResponse({ error: `Could not fetch ${company_url} (status ${pageRes.status})` }, 502);
    }
    const html = await pageRes.text();

    const candidates = extractCandidates(html, company_url);
    if (candidates.length === 0) {
      await adminClient.from('workspaces').update({ onboarding_status: 'pending' }).eq('id', workspaceId);
      return jsonResponse({ error: 'No candidate brand assets found on that page.' }, 200);
    }

    // ── 2. Ask Claude to classify every candidate at once ────
    const classification = await classifyWithClaude(candidates, anthropicKey);

    // ── 3. Write results for human review ────────────────────
    const rows = classification.map((c) => ({
      workspace_id: workspaceId,
      source_url: company_url,
      asset_type: c.asset_type,
      raw_value: c.raw_value,
      storage_path: null, // populated by a follow-up download step if the candidate is an image and gets accepted
      proposed_category: c.proposed_category,
      proposed_slot: c.proposed_slot,
      confidence: c.confidence,
      reasoning: c.reasoning,
      review_status: 'pending'
    }));

    const { error: insertError } = await adminClient.from('scrape_candidates').insert(rows);
    if (insertError) {
      return jsonResponse({ error: 'Failed to save scrape candidates: ' + insertError.message }, 500);
    }

    await adminClient.from('workspaces').update({ onboarding_status: 'reviewing' }).eq('id', workspaceId);
    await adminClient.from('events').insert({
      workspace_id: workspaceId,
      user_id: userData.user.id,
      event_type: 'onboarding.scrape_completed',
      metadata: { company_url, candidate_count: rows.length }
    });

    return jsonResponse({ candidate_count: rows.length });
  } catch (err) {
    console.error('onboarding-scrape error:', err);
    return jsonResponse({ error: String(err) }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Very deliberately simple, regex-based extraction rather than a full DOM parser —
// Deno Edge Functions have a cold-start budget, and this only needs to find
// candidates, not perfectly parse arbitrary HTML. Claude does the real judgment
// call on what's actually usable.
function extractCandidates(html: string, baseUrl: string) {
  const candidates: Array<{ asset_type: string; raw_value: string }> = [];

  // Logo-ish images: anything with "logo" in its src, alt, or class.
  const imgMatches = html.matchAll(/<img[^>]*>/gi);
  for (const m of imgMatches) {
    const tag = m[0];
    if (/logo/i.test(tag)) {
      const srcMatch = tag.match(/src=["']([^"']+)["']/i);
      if (srcMatch) {
        candidates.push({ asset_type: 'image', raw_value: resolveUrl(srcMatch[1], baseUrl) });
      }
    }
  }

  // Colors: hex codes appearing in inline styles or <style> blocks.
  const hexMatches = new Set(
    Array.from(html.matchAll(/#[0-9a-f]{6}\b/gi)).map((m) => m[0].toUpperCase())
  );
  for (const hex of hexMatches) {
    candidates.push({ asset_type: 'color', raw_value: hex });
  }

  // Fonts: font-family declarations.
  const fontMatches = new Set(
    Array.from(html.matchAll(/font-family:\s*([^;"'}]+)/gi)).map((m) => m[1].trim())
  );
  for (const font of fontMatches) {
    if (font.length < 60) candidates.push({ asset_type: 'font', raw_value: font });
  }

  // A short text excerpt for voice/tone — page title + meta description.
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  if (titleMatch) candidates.push({ asset_type: 'text', raw_value: titleMatch[1].trim() });
  if (descMatch) candidates.push({ asset_type: 'text', raw_value: descMatch[1].trim() });

  // Cap it — this is meant to surface a reasonable starting set, not scrape exhaustively.
  return candidates.slice(0, 40);
}

function resolveUrl(maybeRelative: string, base: string) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

async function classifyWithClaude(
  candidates: Array<{ asset_type: string; raw_value: string }>,
  apiKey: string
) {
  const prompt = `You are classifying brand assets found on a company's website into a fixed taxonomy, for a brand governance tool called Deadreckoner.

Taxonomy categories: ${TAXONOMY_CATEGORIES.join(', ')}.

For each candidate below, decide:
- proposed_category: the single best-fitting category from the list above.
- proposed_slot: a short, specific slot name within that category (e.g. "Primary Logo", "Primary Palette", "Heading Typeface").
- confidence: your confidence in this classification, from 0.0 to 1.0.
- reasoning: one short sentence explaining why, for a human reviewer.

If a candidate is not actually a usable brand asset (e.g. a decorative color used once, a generic stock font with no clear brand role), still classify it as best you can but give it a low confidence score rather than omitting it.

Candidates:
${JSON.stringify(candidates, null, 2)}

Respond ONLY with a JSON array, one object per candidate, in the same order, each with exactly these fields: asset_type, raw_value, proposed_category, proposed_slot, confidence, reasoning. No preamble, no markdown fences, just the JSON array.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? '[]';
  const cleaned = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse Claude response as JSON:', text);
    // Fail safe: return every candidate unclassified rather than losing them entirely.
    return candidates.map((c) => ({
      ...c,
      proposed_category: null,
      proposed_slot: null,
      confidence: 0,
      reasoning: 'Claude response could not be parsed — needs manual classification.'
    }));
  }
}
