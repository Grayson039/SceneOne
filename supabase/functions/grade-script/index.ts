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

    // Truncate to ~80k chars to stay within context limits
    const scriptTruncated = script_text.slice(0, 80000);

    const systemPrompt = `You are SceneOne, a professional script coverage AI. You analyze screenplays using proportional structural analysis — NOT page-exact Save the Cat beat sheets. Every script is evaluated on its own terms: a 75-page thriller and a 120-page drama follow different rhythms.

Your grading framework has five pillars (20% each):
1. ACT_PROPORTION — Does the story breathe at the right pace? Are setup, confrontation, and resolution balanced for this specific script?
2. THE_ENGINE — Is there a clear, compelling dramatic question driving the story forward from page 1?
3. ESCALATION — Does each act raise the stakes? Does conflict compound rather than repeat?
4. THE_PIVOT — Is there a genuine turning point that changes everything? Does it land emotionally and structurally?
5. THE_PAYOFF — Does the ending feel earned? Do all major threads resolve in a satisfying, non-arbitrary way?

Scene-level analysis: For each scene cluster, test: (a) value reversal — does the scene end in a different emotional/moral position than it started? (b) cause-effect logic — does each scene follow from the previous with "therefore" or "but" (not "and then")?

Score each pillar 0–100. Derive overall score as weighted average (equal weights). Be honest — scores in the 60s are common for drafts. Reserve 85+ for genuinely exceptional work.

Return ONLY valid JSON with this exact structure:
{
  "overall_score": <integer 0-100>,
  "score_interpretation": "<one-line reading of the score, e.g. 'Strong foundation with structural opportunities'>",
  "scores": {
    "act_proportion": <integer>,
    "the_engine": <integer>,
    "escalation": <integer>,
    "the_pivot": <integer>,
    "the_payoff": <integer>
  },
  "logline": "<2-3 sentence structural logline — what the protagonist wants, what stands in the way, what's at stake>",
  "story_dna": "<one crisp sentence naming the core dramatic engine of THIS script>",
  "win_statement": "<2-3 sentences on the script's single biggest strength — be specific, cite a moment or technique>",
  "pacing_scores": [<array of exactly 60 integers 0-100, representing scene momentum from start to finish>],
  "categories": [
    {
      "name": "Act Proportion",
      "score": <integer>,
      "notes": "<2-3 sentences of specific, actionable feedback>"
    },
    {
      "name": "The Engine",
      "score": <integer>,
      "notes": "<2-3 sentences>"
    },
    {
      "name": "Escalation",
      "score": <integer>,
      "notes": "<2-3 sentences>"
    },
    {
      "name": "The Pivot",
      "score": <integer>,
      "notes": "<2-3 sentences>"
    },
    {
      "name": "The Payoff",
      "score": <integer>,
      "notes": "<2-3 sentences>"
    }
  ]
}`;

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
        max_tokens: 2048,
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

    // Extract JSON from the response (handle markdown code blocks)
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
