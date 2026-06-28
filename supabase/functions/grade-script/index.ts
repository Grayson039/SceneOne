// ============================================================================
// grade-script — HARDENED + SECURITY-PATCHED version
// ----------------------------------------------------------------------------
// Security changes vs prior version:
//   - CORS locked to sceneone.net (was '*')
//   - Max script size enforced server-side (500 KB)
//   - PDF magic-byte check on base64 payloads
//   - Anonymous demo rate-limited via Deno KV (1 req / IP / 5 min)
//   - Plan limits enforced server-side (unchanged from previous hardening)
//   - Cache-first, then plan check, then Claude (unchanged)
// ============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── CORS ─────────────────────────────────────────────────────────────────────
// Only the live site (and localhost for local dev) may call this function.
const ALLOWED_ORIGINS = ['https://sceneone.net', 'http://localhost', 'http://127.0.0.1'];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':'));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://sceneone.net',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

// ── Limits ───────────────────────────────────────────────────────────────────
const MAX_SCRIPT_CHARS = 500_000; // ~500 KB of text — well above any real screenplay
const SAMPLE_MAX_CHARS = 8_000;   // anonymous demo cap

// Monthly analysis limits per plan. null = unlimited.
const PLAN_LIMITS: Record<string, number | null> = {
  free:   1,
  writer: 5,
  pro:    null,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// SHA-256 hex — fingerprints the script text for the analysis cache.
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Anonymous demo rate limiter (Deno KV) ────────────────────────────────────
// Limits unauthenticated demo calls to 1 per IP per 5 minutes.
// Deno KV is in-process ephemeral storage — resets on function cold-start, which
// is fine for rate limiting (a cold start resets the counter, not the account).
// This prevents a simple loop from racking up Claude API charges.
let _kv: Deno.Kv | null = null;
async function getKv(): Promise<Deno.Kv | null> {
  if (_kv) return _kv;
  try { _kv = await Deno.openKv(); return _kv; } catch { return null; }
}

async function isAnonRateLimited(ip: string): Promise<boolean> {
  const kv = await getKv();
  if (!kv) return false; // KV unavailable → fail open (don't block legit users)

  const key = ['anon_demo_rate', ip];
  const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  const entry = await kv.get<number>(key);
  const now = Date.now();

  if (entry.value && now - entry.value < WINDOW_MS) {
    return true; // called within the last 5 minutes
  }

  await kv.set(key, now, { expireIn: WINDOW_MS });
  return false;
}

// ── Main handler ─────────────────────────────────────────────────────────────
serve(async (req) => {
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const body = await req.json();
    const { script_text, title, is_sample, script_b64 } = body;

    // ── Input validation ────────────────────────────────────────────────────

    if (!script_text || script_text.trim().length < 200) {
      return json({ error: 'Script text too short or missing.' }, 400, cors);
    }

    if (script_text.length > MAX_SCRIPT_CHARS) {
      return json({ error: `Script too large. Maximum is ${MAX_SCRIPT_CHARS / 1000}KB of text.` }, 413, cors);
    }

    // PDF magic-byte check: if the caller sent a base64-encoded file alongside
    // the extracted text, verify it's actually a PDF (starts with %PDF).
    // This prevents non-PDF file types from being processed.
    if (script_b64) {
      try {
        const bytes = atob(script_b64.slice(0, 8)); // decode just the header
        if (!bytes.startsWith('%PDF')) {
          return json({ error: 'Only PDF files are accepted.' }, 415, cors);
        }
      } catch {
        return json({ error: 'Invalid file encoding.' }, 400, cors);
      }
    }

    // ── Sample demo gate ────────────────────────────────────────────────────
    const isSampleDemo = is_sample === true && script_text.trim().length < SAMPLE_MAX_CHARS;

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── Cache: identical draft → instant return ─────────────────────────────
    const CACHE_VERSION = 'v2';
    const scriptHash = await sha256Hex(CACHE_VERSION + '\n' + script_text.trim());
    try {
      const { data: cachedRow } = await admin
        .from('analysis_cache')
        .select('result')
        .eq('script_hash', scriptHash)
        .maybeSingle();
      if (cachedRow?.result) {
        return json({ ...cachedRow.result, cached: true }, 200, cors);
      }
    } catch {
      // cache miss / table absent → fall through
    }

    // ── Identify caller ─────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    let user: { id: string; email?: string } | null = null;
    try {
      const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data } = await userClient.auth.getUser();
      if (data?.user) user = { id: data.user.id, email: data.user.email ?? undefined };
    } catch {
      // treat as anonymous
    }

    // ── Require auth for full (non-sample) analyses ─────────────────────────
    if (!user && !isSampleDemo) {
      return json({
        error: 'auth_required',
        message: 'Create a free account to analyze your full script.',
      }, 401, cors);
    }

    // ── Plan limits (logged-in users, non-sample) ───────────────────────────
    if (user && !isSampleDemo) {
      let plan = 'free';
      try {
        const { data: profile } = await admin
          .from('profiles')
          .select('plan')
          .eq('id', user.id)
          .single();
        if (profile?.plan) plan = profile.plan;
      } catch {
        console.warn('grade-script: could not read plan, defaulting to free-open', user.id);
      }

      const limit = PLAN_LIMITS[plan] ?? null;
      if (limit !== null) {
        let used = 0;
        try {
          const monthStart = new Date();
          monthStart.setUTCDate(1);
          monthStart.setUTCHours(0, 0, 0, 0);
          const { count } = await admin
            .from('submissions')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .gte('created_at', monthStart.toISOString());
          used = count ?? 0;
        } catch {
          console.warn('grade-script: usage count failed, allowing this one', user.id);
        }

        if (used >= limit) {
          const noun = limit === 1 ? 'analysis' : 'analyses';
          return json({
            error:   'limit_reached',
            message: `You've used all ${limit} ${noun} on the ${plan} plan this month. Upgrade for more.`,
            plan,
            limit,
          }, 429, cors);
        }
      }
    } else if (!user) {
      // ── Anonymous demo rate limit ─────────────────────────────────────────
      // 1 call per IP per 5 minutes. Prevents scripted abuse of the free demo.
      const ip =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('cf-connecting-ip') ??
        'unknown';

      if (await isAnonRateLimited(ip)) {
        return json({
          error:   'demo_rate_limited',
          message: 'Please wait a few minutes before trying the demo again. Create a free account for unlimited access.',
        }, 429, cors);
      }
    }

    // ── Claude analysis ─────────────────────────────────────────────────────
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const scriptTruncated = script_text.slice(0, 80000);

    const systemPrompt = `You are SceneOne, a professional script coverage AI grounded in Blake Snyder's "Save the Cat!" methodology — the 15-beat structure used across studio development. Analyze the screenplay and return ONLY valid JSON — no markdown, no commentary, just the JSON object.

Evaluate five dimensions:
- structure: Grade against Save the Cat's 15 beats — Opening Image, Theme Stated, Set-Up, Catalyst, Debate, Break into Two, B Story, Fun and Games, Midpoint, Bad Guys Close In, All Is Lost, Dark Night of the Soul, Break into Three, Finale, Final Image. Are the load-bearing beats present, and do they land at the right proportional moments (e.g. Catalyst ~10%, Midpoint ~50%, Break into Three ~75%)?
- conflict: Is opposition strong enough? Does antagonism compound rather than repeat?
- dialogue: Does it carry subtext? Does each character have a distinct voice?
- pacing: Does momentum hold? Are scenes doing double duty or stalling?
- visual: Is it showing, not just telling? Are action lines cinematic?

For each dimension, score 0–100. Be honest — 60s are common for drafts. Reserve 85+ for exceptional work.

Also provide a brief development-executive assessment, grounded in the actual script: its genre/subgenre, a rough production budget tier, the number of distinct named speaking characters, and a Recommend / Consider / Pass verdict with a one-line rationale an industry reader could act on.

Return this exact JSON structure:
{
  "overall_score": <integer 0-100>,
  "score_interpretation": "<one-line read of the score, e.g. 'Strong foundation with structural opportunities'>",
  "scores": {
    "structure": <integer>,
    "conflict": <integer>,
    "dialogue": <integer>,
    "pacing": <integer>,
    "visual": <integer>
  },
  "save_the_cat": {
    "summary": "<one line: how completely the script hits the 15-beat Save the Cat structure>",
    "strongest_beat": "<beat name — why it lands, with a page ref>",
    "weakest_beat": "<beat name — what's missing or soft, with a page ref>"
  },
  "exec": {
    "genre": "<primary genre / subgenre, e.g. 'Psychological Thriller / Drama'>",
    "budget_tier": "<rough production tier + range, e.g. 'Mid-range · $5M–$15M'>",
    "named_characters": <integer count of distinct named speaking characters>,
    "recommendation": "<exactly one of: Recommend, Consider, Pass>",
    "recommendation_note": "<1-2 sentences for an industry reader — what to do and why>"
  },
  "win_statement": "<2-3 sentences on the script's single biggest strength — cite a specific moment or technique>",
  "logline": "<2-3 sentence structural logline — what the protagonist wants, what stands in the way, what's at stake>",
  "story_dna": [
    { "film": "<comparable film title>", "pct": <integer 20-60> },
    { "film": "<comparable film title>", "pct": <integer 10-40> },
    { "film": "<comparable film title>", "pct": <integer 10-30> }
  ],
  "pacing_scores": [<array of exactly 60 integers 0-100, representing momentum scene by scene from start to finish — must reflect the actual script's rhythm>],
  "categories": {
    "structure": {
      "strength": "<1-2 sentences on what's working structurally>",
      "flag": "<1-2 sentences on the main structural issue>",
      "evidence": "<a specific line or moment from the script that illustrates the flag>",
      "fix": "<concrete, actionable revision suggestion>",
      "page_ref": "<page range, e.g. 'pp.12-15'>",
      "confidence": "<one of: high, medium, low>"
    },
    "conflict": {
      "strength": "<1-2 sentences>",
      "flag": "<1-2 sentences>",
      "evidence": "<specific quote or moment from the script>",
      "fix": "<actionable suggestion>",
      "page_ref": "<page range>",
      "confidence": "<high|medium|low>"
    },
    "dialogue": {
      "strength": "<1-2 sentences>",
      "flag": "<1-2 sentences>",
      "evidence": "<specific line of dialogue from the script>",
      "fix": "<actionable suggestion>",
      "page_ref": "<page range>",
      "confidence": "<high|medium|low>"
    },
    "pacing": {
      "strength": "<1-2 sentences>",
      "flag": "<1-2 sentences>",
      "evidence": "<specific scene or sequence>",
      "fix": "<actionable suggestion>",
      "page_ref": "<page range>",
      "confidence": "<high|medium|low>"
    },
    "visual": {
      "strength": "<1-2 sentences>",
      "flag": "<1-2 sentences>",
      "evidence": "<specific action line or direction from the script>",
      "fix": "<actionable suggestion>",
      "page_ref": "<page range>",
      "confidence": "<high|medium|low>"
    }
  },
  "revision_plan": [
    { "title": "<short action title>", "description": "<what to do and why>", "impact": "<High|Medium|Low> impact" },
    { "title": "<short action title>", "description": "<what to do and why>", "impact": "<High|Medium|Low> impact" },
    { "title": "<short action title>", "description": "<what to do and why>", "impact": "<High|Medium|Low> impact" }
  ]
}

CRITICAL: All content must be grounded in the actual screenplay provided. Quote real lines. Reference real scenes. Do not invent plot points.`;

    const userPrompt = `Title: ${title || 'Untitled Script'}

SCREENPLAY:
${scriptTruncated}

Analyze this screenplay and return the JSON coverage report.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    const anthropicData = await response.json();
    const rawText = anthropicData.content?.[0]?.text || '';

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in AI response');

    const gradeResult = JSON.parse(jsonMatch[0]);

    // Store in cache for instant re-uploads.
    try {
      await admin.from('analysis_cache').insert({
        script_hash: scriptHash,
        result: gradeResult,
        title: title || null,
      });
    } catch {
      // ignore cache write errors — analysis still returns
    }

    return json({ ...gradeResult, cached: false }, 200, cors);

  } catch (err) {
    const cors = corsHeaders(req);
    console.error('grade-script error:', err); // full detail server-side only
    return json({ error: 'Something went wrong. Please try again.' }, 500, cors);
  }
});
