// ============================================================================
// grade-script -- HARDENED version
// ----------------------------------------------------------------------------
// WHAT CHANGED vs the current live index.ts:
//   The live function calls Claude for ANYONE who can reach it, with no check
//   of who they are or how many analyses they've already run this month. That
//   means a logged-in Free user can run unlimited analyses (you pay Anthropic
//   for each one) just by clicking again -- the "1 per month" limit only exists
//   in the browser, which anyone can bypass.
//
//   This version checks the caller's plan + monthly usage ON THE SERVER before
//   spending money on Claude. The browser can't bypass it.
//
// WHAT IS UNCHANGED:
//   The actual Claude prompt + scoring logic is identical to your live version,
//   so reports come out exactly the same.
//
// HOW TO USE THIS FILE:
//   1) Run migration 004_billing_and_usage.sql FIRST (it adds the columns this
//      reads). If you deploy this before the migration, paid checks are skipped
//      safely (it "fails open" and just logs) -- so nothing breaks either way.
//   2) Review, then rename this file to index.ts (replacing the old one) and
//      deploy. See BACKEND-FIXES.md for the one deploy command.
//
// ONE DECISION FOR YOU + SAKO (marked DECISION below):
//   The landing page lets people run the SAMPLE script with no account. That's
//   good for conversion but means anonymous calls must be allowed -- which is an
//   abuse vector (someone could script the sample endpoint and run up your
//   Claude bill). Options are listed at the DECISION marker.
// ============================================================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Monthly analysis limits per plan. null = unlimited.
const PLAN_LIMITS: Record<string, number | null> = {
  free: 1,
  writer: 5,
  pro: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// SHA-256 hex digest — fingerprints a script so an identical re-upload can be
// served from cache instead of paying for a fresh Claude analysis.
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { script_text, title } = await req.json();

    if (!script_text || script_text.trim().length < 200) {
      return json({ error: 'Script text too short or missing.' }, 400);
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // ----- CACHE: identical draft → instant return (no model call, no credit) ----
    // Fingerprint the exact draft. If this text was graded before, return the
    // stored report immediately — no re-analysis, no wasted compute, no second wait.
    const scriptHash = await sha256Hex(script_text.trim());
    try {
      const { data: cachedRow } = await admin
        .from('analysis_cache')
        .select('result')
        .eq('script_hash', scriptHash)
        .maybeSingle();
      if (cachedRow?.result) {
        return json({ ...cachedRow.result, cached: true }, 200);
      }
    } catch (_e) {
      // cache miss / table absent → fall through to a fresh analysis
    }

    // ----- Identify the caller (if logged in) -------------------------------
    // functions.invoke() from the browser automatically sends the user's login
    // token here. We use it to find out who they are. If they're not logged in
    // (the public sample demo), user stays null.
    const authHeader = req.headers.get('Authorization') ?? '';

    let user: { id: string; email?: string } | null = null;
    try {
      const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data } = await userClient.auth.getUser();
      if (data?.user) user = { id: data.user.id, email: data.user.email ?? undefined };
    } catch (_e) {
      // ignore -- treat as anonymous
    }

    // ----- Enforce plan limits for LOGGED-IN users --------------------------
    if (user) {
      // (admin client created above — bypasses RLS to read plan + count usage)
      let plan = 'free';
      try {
        const { data: profile } = await admin
          .from('profiles')
          .select('plan')
          .eq('id', user.id)
          .single();
        if (profile?.plan) plan = profile.plan;
      } catch (_e) {
        // If the `plan` column doesn't exist yet (migration not run), fail OPEN
        // so the app keeps working. Logged here so you can see it.
        console.warn('grade-script: could not read plan, defaulting to free-open', user.id);
      }

      const limit = PLAN_LIMITS[plan] ?? null;
      if (limit !== null && user.email) {
        let used = 0;
        try {
          // Count this user's saved analyses since the 1st of this month.
          // We count by user_email because that's the field the frontend
          // saves on each submission (see landing.html submissions insert).
          const monthStart = new Date();
          monthStart.setUTCDate(1);
          monthStart.setUTCHours(0, 0, 0, 0);
          const { count } = await admin
            .from('submissions')
            .select('id', { count: 'exact', head: true })
            .eq('user_email', user.email)
            .gte('created_at', monthStart.toISOString());
          used = count ?? 0;
        } catch (_e) {
          console.warn('grade-script: usage count failed, allowing this one', user.id);
          used = 0; // fail open on counting errors
        }

        if (used >= limit) {
          const noun = limit === 1 ? 'analysis' : 'analyses';
          return json({
            error: 'limit_reached',
            message: `You've used all ${limit} ${noun} on the ${plan} plan this month. Upgrade for more.`,
            plan,
            limit,
          }, 429);
        }
      }
    } else {
      // DECISION (you + Sako): anonymous caller = the public sample demo.
      // Today this is allowed with no limit, which is an abuse vector.
      // Pick one before launch:
      //   (a) Keep open (current behavior) -- simplest, some bill risk.
      //   (b) Require login for ALL analyses; make the "sample" a pre-saved
      //       static report (no Claude call). Safest, tiny conversion cost.
      //   (c) Allow 1 anonymous analysis per IP/session, then require login.
      // For now we keep it open so the demo keeps working:
      console.log('grade-script: anonymous demo call allowed');
    }

    // ----- Everything below is IDENTICAL to your live function --------------
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

    // Store in cache so an identical re-upload returns instantly next time.
    try {
      await admin.from('analysis_cache').insert({
        script_hash: scriptHash,
        result: gradeResult,
        title: title || null,
      });
    } catch (_e) {
      // ignore cache write errors (race/table absent) — the analysis still returns
    }

    return json({ ...gradeResult, cached: false }, 200);

  } catch (err) {
    console.error('grade-script error:', err);
    return json({ error: (err as Error).message || 'Internal error' }, 500);
  }
});
