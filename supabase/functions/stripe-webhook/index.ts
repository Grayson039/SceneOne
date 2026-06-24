// ============================================================================
// stripe-webhook — fulfil subscription payments by updating profiles.plan
// ----------------------------------------------------------------------------
// Stripe calls this endpoint directly (no Supabase JWT) whenever a billing
// event happens. We authenticate by verifying Stripe's signature, then write
// the user's plan into the database with the service-role key.
//
// IMPORTANT — deploy config: this function MUST run with verify_jwt = false
// (see supabase/config.toml), otherwise Supabase rejects Stripe's unauthenticated
// POST with a 401 before our code ever runs.
//
// Events handled:
//   checkout.session.completed   → set plan to what they bought + save customer id
//   customer.subscription.updated → keep plan + renewal date in sync; downgrade if inactive
//   customer.subscription.deleted → downgrade to free
//
// Secrets required: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//   STRIPE_WRITER_PRICE_ID, STRIPE_PRO_PRICE_ID. SUPABASE_* are auto-injected.
// ============================================================================

import Stripe from 'https://esm.sh/stripe@17?target=deno&no-check';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});
// Deno has no Node crypto — Stripe provides a Web Crypto signature verifier.
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// Map a Stripe Price ID back to our plan name, so we trust the actual line item
// (not just metadata) when deciding what the customer is entitled to.
const PLAN_BY_PRICE: Record<string, string> = {};
{
  const w = Deno.env.get('STRIPE_WRITER_PRICE_ID');
  const p = Deno.env.get('STRIPE_PRO_PRICE_ID');
  if (w) PLAN_BY_PRICE[w] = 'writer';
  if (p) PLAN_BY_PRICE[p] = 'pro';
}

function customerIdOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === 'string' ? v : v.id;
}

// Apply a plan change to the user's profile.
//   - Update by user id when we have it (the reliable path).
//   - If no profiles row exists yet (writers don't get one at signup), upsert
//     the billing columns. If your profiles table has NOT NULL columns without
//     defaults (e.g. `role`), this upsert will fail — that's logged loudly so
//     you can backfill. See STRIPE-SETUP.md "Profiles row" note.
async function applyPlan(
  userId: string | null,
  customerId: string | null,
  patch: Record<string, unknown>,
) {
  if (userId) {
    const { data, error } = await admin
      .from('profiles')
      .update(patch)
      .eq('id', userId)
      .select('id');
    if (error) { console.error('profiles update failed:', error.message); return; }
    if (data && data.length > 0) return; // updated an existing row — done

    // No row for this user — create one with the billing fields.
    const { error: upErr } = await admin
      .from('profiles')
      .upsert({ id: userId, ...patch }, { onConflict: 'id' });
    if (upErr) {
      console.error(
        `profiles upsert failed for user ${userId} — plan NOT applied. ` +
        `Likely a NOT NULL column (e.g. role) without a default. Backfill needed. ` +
        `Stripe customer ${customerId}. Error: ${upErr.message}`,
      );
    }
    return;
  }

  if (customerId) {
    const { error } = await admin
      .from('profiles')
      .update(patch)
      .eq('stripe_customer_id', customerId);
    if (error) console.error('profiles update by customer failed:', error.message);
    return;
  }

  console.error('applyPlan: no user id and no customer id — cannot fulfil event.');
}

Deno.serve(async (req) => {
  const sig = req.headers.get('stripe-signature');
  const body = await req.text(); // raw body required for signature verification

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig!,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', (err as Error).message);
    return new Response('Invalid signature', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const userId = s.client_reference_id || (s.metadata?.supabase_user_id ?? null);
        const customerId = customerIdOf(s.customer as any);

        let plan = (s.metadata?.plan as string | undefined) ?? undefined;
        let renewsAt: string | null = null;

        // Prefer the real subscription's price over metadata.
        if (s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription as string);
          const priceId = sub.items.data[0]?.price?.id;
          if (priceId && PLAN_BY_PRICE[priceId]) plan = PLAN_BY_PRICE[priceId];
          if (sub.current_period_end) {
            renewsAt = new Date(sub.current_period_end * 1000).toISOString();
          }
        }

        if (!plan) { console.error('checkout.session.completed: could not resolve plan'); break; }

        await applyPlan(userId, customerId, {
          plan,
          stripe_customer_id: customerId,
          plan_renews_at: renewsAt,
        });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = (sub.metadata?.supabase_user_id as string | undefined) ?? null;
        const customerId = customerIdOf(sub.customer as any);
        const priceId = sub.items.data[0]?.price?.id;
        const boughtPlan = priceId ? PLAN_BY_PRICE[priceId] : undefined;
        // `past_due` = a renewal payment failed but Stripe is still retrying it
        // (the dunning grace window — length is set in Stripe → Billing). Keep
        // access during that window; only revoke on a terminal unpaid state.
        const entitled = ['active', 'trialing', 'past_due'].includes(sub.status);
        const renewsAt = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;

        const patch: Record<string, unknown> = { plan_renews_at: renewsAt };
        if (entitled && boughtPlan) patch.plan = boughtPlan;
        if (!entitled) patch.plan = 'free'; // canceled / unpaid / incomplete_expired → lose access
        if (customerId) patch.stripe_customer_id = customerId;

        await applyPlan(userId, customerId, patch);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = (sub.metadata?.supabase_user_id as string | undefined) ?? null;
        const customerId = customerIdOf(sub.customer as any);
        await applyPlan(userId, customerId, { plan: 'free', plan_renews_at: null });
        break;
      }

      case 'invoice.payment_failed': {
        // A renewal charge was declined. Do NOT revoke access here — Stripe
        // retries the card over the next several days (dunning, configured in
        // Stripe → Settings → Billing → Manage failed payments). Access is pulled
        // only when those retries are exhausted and the subscription moves to a
        // terminal state (handled by customer.subscription.updated/deleted above).
        // Stripe can also email the customer to update their card during dunning.
        const inv = event.data.object as Stripe.Invoice;
        const customerId = customerIdOf(inv.customer as any);
        console.warn(
          `invoice.payment_failed — customer ${customerId}, subscription ${inv.subscription}, ` +
          `attempt ${inv.attempt_count}. In grace/retry window; access retained for now.`,
        );
        break;
      }

      default:
        // Other events (invoice.paid, etc.) are acknowledged but not acted on.
        break;
    }
  } catch (err) {
    // Returning 500 tells Stripe to retry later — good for transient failures.
    console.error('Webhook handler error:', (err as Error).message);
    return new Response('Handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
