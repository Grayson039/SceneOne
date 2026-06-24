// ============================================================================
// create-portal — open the Stripe Customer Portal for the signed-in user
// ----------------------------------------------------------------------------
// This is how subscribers cancel, change plan, or update their card. We do NOT
// build a custom cancel UI — Stripe's hosted portal handles it (PCI-safe,
// proration, dunning, reactivation). When the user cancels there, Stripe fires
// `customer.subscription.deleted`, which the stripe-webhook function already
// catches and downgrades the account to free. So "tell the backend someone
// unsubscribed" happens automatically via the existing webhook — no extra route.
//
// Flow: frontend "Manage Plan" button → this function → returns a portal URL →
// browser redirects there.
//
// Secrets required: STRIPE_SECRET_KEY, SITE_URL. SUPABASE_* are auto-injected.
// Prereq: enable the Customer Portal once in Stripe Dashboard → Settings →
//   Billing → Customer portal.
// ============================================================================

import Stripe from 'https://esm.sh/stripe@17?target=deno&no-check';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    // ----- Identify the signed-in user -----
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: 'You must be signed in.' }, 401);

    // ----- Find their Stripe customer id -----
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile?.stripe_customer_id) {
      return json({ error: 'No active subscription found for this account.' }, 404);
    }

    const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://sceneone.net';

    const portal = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${SITE_URL}/landing.html`,
    });

    return json({ url: portal.url });
  } catch (err) {
    console.error('create-portal error:', err);
    return json({ error: (err as Error).message || 'Could not open the billing portal.' }, 500);
  }
});
