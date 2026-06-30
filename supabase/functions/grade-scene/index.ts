import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { scene_text, dimension, original_flag, original_fix } = await req.json();

    if (!scene_text || scene_text.trim().length < 10) {
      return json({ error: 'Scene text is too short.' }, 400);
    }
    if (!dimension) {
      return json({ error: 'Dimension is required.' }, 400);
    }

    // Require authentication — this is writer-only, not a public demo
    const authHeader = req.headers.get('Authorization') ?? '';
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data } = await userClient.auth.getUser();
    if (!data?.user) {
      return json({ error: 'Authentication required.' }, 401);
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const dimLabels: Record<string, string> = {
      structure: 'Story Structure',
      conflict: 'Conflict',
      dialogue: 'Dialogue',
      pacing: 'Pacing',
      visual: 'Visual Writing',
    };
    const dimLabel = dimLabels[dimension] || dimension;

    const systemPrompt = `You are SceneOne, a professional screenplay coverage AI. A writer has rewritten a scene to address a specific issue. Evaluate whether their revision actually fixes the problem.

Be direct and honest — don't pad with generic praise. If it improved, say exactly how. If it didn't, say exactly why not.

Return ONLY valid JSON, no markdown:
{
  "improved": true or false,
  "assessment": "2-3 direct sentences evaluating how well the rewrite addresses the original issue",
  "next_step": "one specific, actionable suggestion for what to do next with this scene"
}`;

    const userPrompt = `DIMENSION BEING EVALUATED: ${dimLabel}

ORIGINAL ISSUE FLAGGED:
${original_flag || '(no flag provided)'}

ORIGINAL FIX SUGGESTION:
${original_fix || '(no fix provided)'}

WRITER'S REWRITTEN SCENE:
${scene_text.slice(0, 4000)}

Does this rewrite address the original issue? Evaluate it.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
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
    if (!jsonMatch) throw new Error('No JSON in AI response');

    const result = JSON.parse(jsonMatch[0]);
    return json(result);

  } catch (err) {
    console.error('grade-scene error:', err);
    return json({ error: (err as Error).message || 'Internal error' }, 500);
  }
});
