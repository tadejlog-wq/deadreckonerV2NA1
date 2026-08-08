// ============================================================
// Deadreckoner — drive-dump-processor Edge Function
//
// Deploy with: supabase functions deploy drive-dump-processor
// Requires these secrets:
//   supabase secrets set GCP_SA_CREDENTIALS='{"type":"service_account",...}'
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// This extends the existing drive-webhook pattern (which already scans
// the dump folder and classifies via Claude Haiku) with the piece that
// was missing: AUTO-RENAMING files in Drive to a consistent convention
// once classified, so the dump folder itself becomes organized, not
// just the database record pointing at it.
//
// IMPORTANT: this assumes a `dump_assets` table already exists (per
// the existing drive-webhook). The exact column names below are best-
// guess based on what drive-webhook is known to populate — reconcile
// column names against the real table before deploying. If in doubt,
// run this against a duplicate/staging table first.
//
// Naming convention applied on rename:
//   {category-slug}_{slot-slug}_{original-name-sanitized}.{ext}
//   e.g. "IMG_4821.png" classified as Logo Usage / Primary Logo becomes
//        "logo-usage_primary-logo_img-4821.png"
//
// Triggered the same way as drive-webhook (Drive push notification,
// or a scheduled poll) — call with no body, it scans the whole dump
// folder for anything not yet processed.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DUMP_FOLDER_ID = Deno.env.get('DRIVE_DUMP_FOLDER_ID') ?? '1NK_14oGSPvnwc95gaDH-WHBueawU0RFD';

const TAXONOMY_CATEGORIES = [
  'Logo Usage', 'Color', 'Typography', 'Photography', 'Iconography',
  'Illustration', 'Voice & Tone', 'Templates', 'Motion', 'Audio', '3D Assets'
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    let workspaceId: string | null = null;
    try {
      const body = await req.json();
      workspaceId = body?.workspace_id ?? null;
    } catch {
      // no body — fine, this can run as a scheduled scan across all workspaces later.
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    const gcpCredsRaw = Deno.env.get('GCP_SA_CREDENTIALS');

    if (!anthropicKey) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured.' }, 500);
    if (!gcpCredsRaw) return jsonResponse({ error: 'GCP_SA_CREDENTIALS not configured.' }, 500);

    const gcpCreds = JSON.parse(gcpCredsRaw);
    const accessToken = await getGoogleAccessToken(gcpCreds);
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // ── 1. List files in the dump folder ──────────────────────
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q='${DUMP_FOLDER_ID}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,webViewLink,thumbnailLink)`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) {
      return jsonResponse({ error: `Drive API list failed: ${await listRes.text()}` }, 502);
    }
    const { files } = await listRes.json();
    if (!files || files.length === 0) {
      return jsonResponse({ processed: 0, message: 'Dump folder is empty.' });
    }

    // ── 2. Skip files already processed (already in dump_assets) ──
    const { data: existing } = await adminClient
      .from('dump_assets')
      .select('drive_file_id')
      .in('drive_file_id', files.map((f: any) => f.id));
    const alreadyProcessed = new Set((existing || []).map((r: any) => r.drive_file_id));
    const newFiles = files.filter((f: any) => !alreadyProcessed.has(f.id));

    if (newFiles.length === 0) {
      return jsonResponse({ processed: 0, message: 'No new files since last scan.' });
    }

    // ── 3. Classify each new file with Claude ──────────────────
    const classifications = await classifyFiles(newFiles, anthropicKey);

    let processedCount = 0;
    for (let i = 0; i < newFiles.length; i++) {
      const file = newFiles[i];
      const classification = classifications[i] ?? {
        proposed_category: null, proposed_slot: null, confidence: 0, reasoning: 'Classification unavailable.'
      };

      // ── 4. Rename the file in Drive to the consistent convention ──
      const newName = buildFileName(file.name, classification.proposed_category, classification.proposed_slot);
      let renamedName = file.name;
      if (newName !== file.name) {
        const renameRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: newName })
        });
        if (renameRes.ok) {
          renamedName = newName;
        } else {
          console.warn(`Rename failed for ${file.id}:`, await renameRes.text());
        }
      }

      // ── 5. Upsert into dump_assets ──────────────────────────
      // Column names are a best guess matching the existing drive-webhook
      // pattern — verify against the real table before relying on this.
      const { error: upsertError } = await adminClient.from('dump_assets').upsert({
        drive_file_id: file.id,
        workspace_id: workspaceId,
        original_name: file.name,
        renamed_to: renamedName,
        mime_type: file.mimeType,
        thumbnail_link: file.thumbnailLink ?? null,
        drive_web_view_link: file.webViewLink ?? null,
        proposed_category: classification.proposed_category,
        proposed_slot: classification.proposed_slot,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
        review_status: 'pending',
        processed_at: new Date().toISOString()
      }, { onConflict: 'drive_file_id' });

      if (upsertError) {
        console.error(`Upsert failed for ${file.id}:`, upsertError.message);
        continue;
      }
      processedCount++;
    }

    if (workspaceId) {
      await adminClient.from('events').insert({
        workspace_id: workspaceId,
        event_type: 'drive_dump.processed',
        metadata: { file_count: processedCount }
      });
    }

    return jsonResponse({ processed: processedCount, skipped: files.length - newFiles.length });
  } catch (err) {
    console.error('drive-dump-processor error:', err);
    return jsonResponse({ error: String(err) }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

function slugify(str: string) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function buildFileName(originalName: string, category: string | null, slot: string | null) {
  const dotIdx = originalName.lastIndexOf('.');
  const ext = dotIdx > -1 ? originalName.slice(dotIdx) : '';
  const base = dotIdx > -1 ? originalName.slice(0, dotIdx) : originalName;

  if (!category || !slot) return originalName; // don't rename what we couldn't classify

  const catSlug = slugify(category);
  const slotSlug = slugify(slot);
  const baseSlug = slugify(base);
  return `${catSlug}_${slotSlug}_${baseSlug}${ext}`;
}

async function classifyFiles(files: Array<{ name: string; mimeType: string }>, apiKey: string) {
  const candidates = files.map((f) => ({ file_name: f.name, mime_type: f.mimeType }));

  const prompt = `Classify these files, dumped into a brand asset folder, against this taxonomy: ${TAXONOMY_CATEGORIES.join(', ')}.

For each file, infer the most likely category and a specific slot name from its filename and MIME type alone (you don't have the file contents). Be conservative — if the filename gives no real signal, use low confidence rather than guessing confidently.

Files:
${JSON.stringify(candidates, null, 2)}

Respond ONLY with a JSON array, same order, each object with: proposed_category, proposed_slot, confidence (0.0-1.0), reasoning (one sentence). No markdown fences, no preamble.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', // matches the existing drive-webhook's model choice — cheap, fast, good enough for filename-only inference
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    console.error('Claude classification failed:', await res.text());
    return files.map(() => ({ proposed_category: null, proposed_slot: null, confidence: 0, reasoning: 'Classification call failed.' }));
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? '[]';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return files.map(() => ({ proposed_category: null, proposed_slot: null, confidence: 0, reasoning: 'Could not parse classification response.' }));
  }
}

// Minimal Google service-account JWT flow — no external deps, matches
// how the existing GCP service account (parabolic-rope-422820-m1) is
// already used elsewhere in this project for Drive access.
async function getGoogleAccessToken(creds: any) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const unsigned = `${encode(header)}.${encode(claimSet)}`;
  const key = await importPrivateKey(creds.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned)
  );
  const encodedSig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${encodedSig}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Failed to get Google access token: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

async function importPrivateKey(pem: string) {
  const pemContents = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}
