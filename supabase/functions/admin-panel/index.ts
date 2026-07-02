// ============================================================================
// admin-panel — server-side enforced admin API
// ----------------------------------------------------------------------------
// All requests must carry a valid Supabase JWT for willgrayson039@gmail.com.
// Email check happens server-side using the verified JWT claim — not client JS.
// Uses service-role key for all DB operations so RLS is bypassed safely.
//
// Actions (passed as JSON body { action, ... }):
//   load          → returns { profiles, submissions }
//   set_verified  → { id, value } updates profiles.verified
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL = 'willgrayson039@gmail.com';

const CORS = {
  'Access-Control-Allow-Origin': 'https://sceneone.net',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // ── Verify JWT and confirm admin identity ──────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);
  if (user.email !== ADMIN_EMAIL) return json({ error: 'Forbidden' }, 403);

  // ── Admin confirmed — use service role for DB operations ──────────────────
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'load') {
      const [profilesRes, submissionsRes] = await Promise.all([
        admin
          .from('profiles')
          .select('id, role, display_name, company, title, imdb_url, verified, created_at')
          .order('created_at', { ascending: false }),
        admin
          .from('submissions')
          .select('id, public_listing, user_email')
          .eq('status', 'complete'),
      ]);

      if (profilesRes.error) throw profilesRes.error;
      if (submissionsRes.error) throw submissionsRes.error;

      return json({ profiles: profilesRes.data, submissions: submissionsRes.data });
    }

    if (action === 'set_verified') {
      const { id, value } = body;
      if (!id || typeof value !== 'boolean') {
        return json({ error: 'Missing id or value' }, 400);
      }
      const { error } = await admin
        .from('profiles')
        .update({ verified: value })
        .eq('id', id);

      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);

  } catch (err) {
    console.error('admin-panel error:', (err as Error).message);
    return json({ error: 'Internal error' }, 500);
  }
});
