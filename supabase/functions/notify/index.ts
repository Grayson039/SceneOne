// ============================================================================
// notify — transactional email for SceneOne via Resend
// ----------------------------------------------------------------------------
// Requires RESEND_API_KEY secret set in Supabase dashboard.
// All callers must provide a valid JWT. Email addresses come from DB only,
// never from the request body, so the caller can't spoof destinations.
//
// Actions:
//   request_received  → email writer that an exec requested their script
//   request_resolved  → email exec that writer approved or declined
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FROM = 'SceneOne <notifications@sceneone.net>';
const RESEND_URL = 'https://api.resend.com/emails';

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

async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('RESEND_API_KEY not configured');
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // Verify JWT
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

  try {
    const { action, request_id } = await req.json();
    if (!request_id) return json({ error: 'Missing request_id' }, 400);

    // Fetch the read_request with submission + writer info from DB — never trust body for emails
    const { data: rr, error: rrErr } = await admin
      .from('read_requests')
      .select('id, exec_name, exec_email, status, submissions(title, user_email)')
      .eq('id', request_id)
      .single();
    if (rrErr || !rr) return json({ error: 'Request not found' }, 404);

    const scriptTitle = (rr.submissions as { title: string; user_email: string } | null)?.title ?? 'your script';
    const writerEmail = (rr.submissions as { title: string; user_email: string } | null)?.user_email;
    const execName   = rr.exec_name ?? 'A reader';
    const execEmail  = rr.exec_email;

    if (action === 'request_received') {
      // Email the writer
      if (!writerEmail) return json({ error: 'No writer email' }, 400);
      await sendEmail(
        writerEmail,
        `New access request for ${scriptTitle}`,
        `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#141416;color:#ECECEC;padding:40px 24px;max-width:560px;margin:0 auto;">
          <div style="font-size:22px;font-weight:900;margin-bottom:24px;">Scene<span style="color:#3EEDE7;">One</span></div>
          <h2 style="font-size:18px;font-weight:700;margin-bottom:8px;">New reader request</h2>
          <p style="color:#A6A6B2;font-size:14px;line-height:1.7;"><strong style="color:#ECECEC;">${execName}</strong> (${execEmail}) has requested access to read <strong style="color:#ECECEC;">${scriptTitle}</strong>.</p>
          <p style="color:#A6A6B2;font-size:14px;line-height:1.7;">You have <strong style="color:#ECECEC;">72 hours</strong> to respond. No response = auto-decline.</p>
          <a href="https://sceneone.net" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#3EEDE7;color:#000;font-weight:700;font-size:14px;border-radius:8px;text-decoration:none;">Review Request →</a>
          <p style="color:#555;font-size:11px;margin-top:32px;">Approval grants read-only access for 14 days. No rights transfer.</p>
        </body></html>`,
      );
    } else if (action === 'request_resolved') {
      // Email the exec
      if (!execEmail) return json({ error: 'No exec email' }, 400);
      const approved = rr.status === 'approved';
      const subject = approved
        ? `Your request for ${scriptTitle} was approved`
        : `Your request for ${scriptTitle} was declined`;
      const body = approved
        ? `<p style="color:#A6A6B2;font-size:14px;line-height:1.7;">The writer has approved your access request for <strong style="color:#ECECEC;">${scriptTitle}</strong>. You now have read-only access for <strong style="color:#ECECEC;">14 days</strong>.</p>
           <a href="https://sceneone.net" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#3EEDE7;color:#000;font-weight:700;font-size:14px;border-radius:8px;text-decoration:none;">Read Script →</a>`
        : `<p style="color:#A6A6B2;font-size:14px;line-height:1.7;">The writer has declined your access request for <strong style="color:#ECECEC;">${scriptTitle}</strong> at this time.</p>
           <a href="https://sceneone.net" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#1C1C1F;color:#ECECEC;font-weight:700;font-size:14px;border-radius:8px;text-decoration:none;border:1px solid #333;">Browse Other Scripts →</a>`;
      await sendEmail(
        execEmail,
        subject,
        `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#141416;color:#ECECEC;padding:40px 24px;max-width:560px;margin:0 auto;">
          <div style="font-size:22px;font-weight:900;margin-bottom:24px;">Scene<span style="color:#3EEDE7;">One</span></div>
          <h2 style="font-size:18px;font-weight:700;margin-bottom:8px;">${subject}</h2>
          ${body}
          <p style="color:#555;font-size:11px;margin-top:32px;">SceneOne · <a href="https://sceneone.net/privacy.html" style="color:#555;">Privacy</a></p>
        </body></html>`,
      );
    } else {
      return json({ error: `Unknown action: ${action}` }, 400);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('notify error:', (err as Error).message);
    return json({ error: 'Internal error' }, 500);
  }
});
