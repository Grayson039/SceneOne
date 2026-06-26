// ============================================================================
// create-checkout — start a Stripe Checkout Session for the signed-in user
// ----------------------------------------------------------------------------
// Flow:
//   1. Frontend "Get Writer / Get Pro" button calls this with { plan }.
//   2. We identify the user from their Supabase JWT (sent automatically by
//      supabaseClient.functions.invoke).
//   3. We create a Stripe Checkout Session in subscription mode, stamped with
//      the Supabase user id (client_reference_id) so the webhook can match the
//      payment back to this exact account when it completes.
//   4. We return { url }; the frontend redirects the browser there.
//
// Secrets required (set via `supabase secrets set`):
//   STRIPE_SECRET_KEY, STRIPE_WRITER_PRICE_ID, STRIPE_PRO_PRICE_ID, SITE_URL
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are auto-injected.
// ============================================================================

import Stripe from 'https://esm.sh/stripe@17?target=deno&no-check';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': 'https://sceneone.net',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  // Deno needs Stripe's fetch-based HTTP client (no Node http).
  httpClient: Stripe.createFetchHttpClient(),
});

// Which Stripe Price each plan maps to. Configured via env so no IDs are hardcoded.
const PRICE_BY_PLAN: Record<string, string | undefined> = {
  writer: Deno.env.get('STRIPE_WRITER_PRICE_ID'),
  pro: Deno.env.get('STRIPE_PRO_PRICE_ID'),
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { plan } = await req.json();
    const priceId = PRICE_BY_PLAN[plan];
    if (!priceId) {
      return json({ error: `Plan "${plan}" is not available for checkout.` }, 400);
    }

    // ----- Identify the signed-in user from their JWT -----------------------
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return json({ error: 'You must be signed in to upgrade.' }, 401);
    }

    // ----- Reuse an existing Stripe customer if we already have one ---------
    // (Avoids creating a duplicate customer every time the user upgrades.)
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    let existingCustomerId: string | null = null;
    try {
      const { data: profile } = await admin
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', user.id)
        .maybeSingle();
      existingCustomerId = profile?.stripe_customer_id ?? null;
    } catch (_e) {
      // No profile row yet (e.g. writers don't get one at signup). Fine — the
      // webhook will create/populate it on checkout.session.completed.
    }

    const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://sceneone.net';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // The load-bearing link: which SceneOne account this payment belongs to.
      client_reference_id: user.id,
      // Stamp it on the subscription too, so renewal/cancel webhooks can resolve
      // the user even without client_reference_id.
      subscription_data: { metadata: { supabase_user_id: user.id, plan } },
      metadata: { supabase_user_id: user.id, plan },
      // Attach to the known customer, or prefill their email for a new one.
      ...(existingCustomerId
        ? { customer: existingCustomerId }
        : { customer_email: user.email ?? undefined }),
      allow_promotion_codes: true,
      success_url: `${SITE_URL}/landing.html?checkout=success`,
      cancel_url: `${SITE_URL}/landing.html?checkout=cancelled`,
    });

    return json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err); // full detail server-side only
    return json({ error: 'Could not start checkout. Please try again.' }, 500);
  }
});
