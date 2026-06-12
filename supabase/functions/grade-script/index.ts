import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { script_text, title } = await req.json();

    if (!script_text || script_text.trim().length < 200) {
      return new Response(JSON.stringify({ error: 'Script text too short or missing.' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const scriptTruncated = script_text.slice(0, 80000);

    const systemPrompt = `You are SceneOne, a professional script coverage AI. Analyze the screenplay and return ONLY valid JSON — no markdown, no commentary, just the JSON object.

Evaluate five dimensions:
- structure: Does the story hit the right beats at the right proportional moments? Is setup/confrontation/resolution balanced?
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
        max_tokens: 3000,
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

    return new Response(JSON.stringify(gradeResult), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('grade-script error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Internal error' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
