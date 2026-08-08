// ============================================================
// Deadreckoner — shared LLM caller, used by ai-consultant,
// onboarding-scrape, and drive-dump-processor.
//
// Why this exists: if Claude usage limits become a problem before
// the product is done, you can switch providers per-function
// without touching the calling code — just set LLM_PROVIDER.
//
// Configure with:
//   supabase secrets set LLM_PROVIDER=anthropic   (default)
//   supabase secrets set LLM_PROVIDER=openai       (ChatGPT)
//   supabase secrets set LLM_PROVIDER=gemini       (Google)
//   supabase secrets set LLM_PROVIDER=ollama       (self-hosted, see note below)
//
// Then set whichever key that provider needs:
//   ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / OLLAMA_BASE_URL
//
// Ollama note: Ollama runs locally on your machine by default, which
// an Edge Function running on Supabase's servers can't reach. To use
// it here, either (a) expose your local Ollama through a tunnel
// (ngrok, Tailscale Funnel, Cloudflare Tunnel) and set OLLAMA_BASE_URL
// to that public URL, or (b) run Ollama on a small cloud VM instead
// of your own machine. Without one of those, treat Ollama as a
// local-only option for testing prompts before they hit production,
// not a swap-in for these Edge Functions.
//
// Perplexity isn't wired here — it's built for web-search-grounded
// Q&A, not classification/chat completions in the shape this app
// needs. If you want it for something specific (e.g. researching a
// company before onboarding), that's a different, smaller function —
// ask and it can be added separately.
//
// All four cloud providers below return the same shape:
//   { text: string, error?: string }
// so callers never need to know which provider actually ran.
// ============================================================

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMResult {
  text: string;
  error?: string;
}

export async function callLLM(
  systemPrompt: string,
  messages: LLMMessage[],
  maxTokens = 1024
): Promise<LLMResult> {
  const provider = Deno.env.get('LLM_PROVIDER') || 'anthropic';

  switch (provider) {
    case 'openai':
      return callOpenAI(systemPrompt, messages, maxTokens);
    case 'gemini':
      return callGemini(systemPrompt, messages, maxTokens);
    case 'ollama':
      return callOllama(systemPrompt, messages, maxTokens);
    case 'anthropic':
    default:
      return callAnthropic(systemPrompt, messages, maxTokens);
  }
}

async function callAnthropic(systemPrompt: string, messages: LLMMessage[], maxTokens: number): Promise<LLMResult> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return { text: '', error: 'ANTHROPIC_API_KEY not configured.' };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages
    })
  });

  if (!res.ok) return { text: '', error: `Anthropic API error (${res.status}): ${await res.text()}` };
  const data = await res.json();
  return { text: data.content?.[0]?.text ?? '' };
}

async function callOpenAI(systemPrompt: string, messages: LLMMessage[], maxTokens: number): Promise<LLMResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) return { text: '', error: 'OPENAI_API_KEY not configured.' };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  });

  if (!res.ok) return { text: '', error: `OpenAI API error (${res.status}): ${await res.text()}` };
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content ?? '' };
}

async function callGemini(systemPrompt: string, messages: LLMMessage[], maxTokens: number): Promise<LLMResult> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return { text: '', error: 'GEMINI_API_KEY not configured.' };

  // Gemini has no separate "system" role in the basic generateContent call —
  // prepend it to the first user turn instead.
  const contents = messages.map((m, i) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: i === 0 ? `${systemPrompt}\n\n${m.content}` : m.content }]
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } })
    }
  );

  if (!res.ok) return { text: '', error: `Gemini API error (${res.status}): ${await res.text()}` };
  const data = await res.json();
  return { text: data.candidates?.[0]?.content?.parts?.[0]?.text ?? '' };
}

async function callOllama(systemPrompt: string, messages: LLMMessage[], _maxTokens: number): Promise<LLMResult> {
  const baseUrl = Deno.env.get('OLLAMA_BASE_URL');
  if (!baseUrl) return { text: '', error: 'OLLAMA_BASE_URL not configured — see the note at the top of this file.' };
  const model = Deno.env.get('OLLAMA_MODEL') || 'llama3.1';

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: false
    })
  });

  if (!res.ok) return { text: '', error: `Ollama error (${res.status}): ${await res.text()}` };
  const data = await res.json();
  return { text: data.message?.content ?? '' };
}
