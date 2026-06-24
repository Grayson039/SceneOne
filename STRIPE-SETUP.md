# SceneOne — Stripe Checkout Setup

This wires real subscription checkout to the app: the **Get Writer / Get Pro**
buttons open a Stripe Checkout Session tied to the signed-in account, and a
webhook writes the user's `plan` into `profiles` when payment succeeds.

**Nothing here is deployed yet.** Build is in the working tree for review. Do the
steps below to make it live. Use **Stripe TEST mode first**, verify, then switch
to live keys.

---

## What got added

| File | What it does |
|---|---|
| `supabase/functions/create-checkout/index.ts` | Creates a Checkout Session for the signed-in user (stamps their user id). |
| `supabase/functions/stripe-webhook/index.ts` | Verifies Stripe's signature, writes `plan` / `stripe_customer_id` / `plan_renews_at` to `profiles`. Catches cancellations (`customer.subscription.deleted`) and downgrades to free. |
| `supabase/functions/create-portal/index.ts` | Opens the Stripe Customer Portal so subscribers can cancel / change plan / update card. Cancelling fires the webhook above. |
| `supabase/config.toml` | `verify_jwt = false` for the webhook (Stripe sends no Supabase JWT), `true` for the others. |
| `supabase/.env.example` | Template for the secrets below. Copy to `supabase/.env` (gitignored). |
| `.gitignore` | Stops `.env` / secrets ever being committed to this **public** repo. |
| `landing.html` | Buttons now call `startCheckout('writer'|'pro')`; falls back to the old Payment Links if the function isn't reachable. |

---

## Step 1 — Gather 4 Stripe values (TEST mode)

From <https://dashboard.stripe.com/test> (toggle **Test mode** on):

1. **Secret key** — Developers → API keys → `sk_test_…`
2. **Writer Price ID** — Products → your $12/mo product → the recurring price → `price_…`
3. **Pro Price ID** — Products → your $29/mo product → `price_…`
4. **Webhook signing secret** — created in Step 4 (`whsec_…`). Leave blank for now.

> You already have live Payment Links, so the Products likely exist. If they
> don't exist in **test** mode, create the two recurring prices there first.

## Step 2 — Put them in `supabase/.env`

```sh
cp supabase/.env.example supabase/.env
# edit supabase/.env and fill in the real values (this file is gitignored)
```

## Step 3 — Push secrets + deploy the functions

```sh
# Push secrets to the live project
supabase secrets set --env-file ./supabase/.env --project-ref zzsjgaijrngxkaqakplm

# Deploy the new functions
supabase functions deploy create-checkout --project-ref zzsjgaijrngxkaqakplm
supabase functions deploy stripe-webhook  --project-ref zzsjgaijrngxkaqakplm
supabase functions deploy create-portal   --project-ref zzsjgaijrngxkaqakplm
```

### Enable the Customer Portal (one-time)

For the **Manage Plan** button (cancel / change plan / update card) to work,
turn the portal on once: Stripe Dashboard → Settings → Billing → **Customer
portal** → activate, and allow "cancel subscription". No code or secret needed —
`create-portal` uses `STRIPE_SECRET_KEY` + `SITE_URL`. When a user cancels there,
Stripe fires `customer.subscription.deleted` and the webhook downgrades them to
free automatically.

## Step 4 — Register the webhook in Stripe

Stripe Dashboard → Developers → **Webhooks** → **Add endpoint**:

- **Endpoint URL:**
  `https://zzsjgaijrngxkaqakplm.supabase.co/functions/v1/stripe-webhook`
- **Events to send:**
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`

> **Dunning / grace period:** a failed renewal does NOT revoke access immediately.
> Stripe retries the card over a window you control at Stripe → Settings → Billing
> → **Manage failed payments** (set the retry schedule and what happens when
> retries run out — cancel the subscription). When retries are exhausted and the
> subscription cancels, the webhook downgrades the account to free. Turn on the
> "email customer about failed payments" option there so users are prompted to
> update their card.

Click **Add endpoint**, then copy its **Signing secret** (`whsec_…`).
Put it in `supabase/.env` as `STRIPE_WEBHOOK_SECRET`, then re-push + re-deploy:

```sh
supabase secrets set --env-file ./supabase/.env --project-ref zzsjgaijrngxkaqakplm
supabase functions deploy stripe-webhook --project-ref zzsjgaijrngxkaqakplm
```

## Step 5 — Test the round-trip (test mode)

1. Sign in to the app with a real test account.
2. Click **Get Writer**. You should land on Stripe Checkout.
3. Pay with test card **4242 4242 4242 4242**, any future expiry, any CVC.
4. You're redirected back to `…/landing.html?checkout=success`.
5. In Supabase → Table editor → `profiles`, confirm that user's `plan` is now
   `writer` and `stripe_customer_id` is set.
6. Watch the webhook deliveries in Stripe (Developers → Webhooks → your endpoint)
   and the function logs (`supabase functions logs stripe-webhook`).

## Step 6 — Go live

Repeat with **live** keys (`sk_live_…`, live Price IDs) and a **live** webhook
endpoint/secret. Re-push secrets, re-deploy.

---

## ⚠️ Important: the "profiles row" dependency

**Writers don't get a `profiles` row at signup today** (only execs do, via
`_createExecProfile`). The webhook handles this by *upserting* the billing
columns if no row exists — **but that upsert will fail if your `profiles` table
has a NOT NULL column without a default** (most likely `role`).

`002_profiles.sql` isn't in this repo (it was run directly in the dashboard), so
I couldn't verify the constraints. Two ways to be safe:

**A. Backfill once** so every existing user has a row (run in SQL Editor —
adjust columns to match your actual `profiles` schema):

```sql
insert into public.profiles (id, role, plan)
select u.id, 'writer', 'free'
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;
```

If that errors on a missing NOT NULL column, add it to the column list. If it
runs clean, the webhook's `update` path will always find a row.

**B. (Recommended, follow-up)** create a `profiles` row at *writer* signup too,
mirroring the exec flow — so new users always have one. I can add that once you
confirm the `profiles` columns (paste me `002_profiles.sql` or the table
definition and I'll wire it).

If a payment ever lands without the plan applying, the function log prints a
`profiles upsert failed …` line naming the user + Stripe customer, and you can
re-send the event from Stripe → Webhooks → the delivery → **Resend**.

---

## Safety notes

- No API keys are in any committed file. `supabase/.env` is gitignored.
- The webhook authenticates by Stripe signature; it rejects forged calls (400).
- It uses the service-role key (server-side only) to write `plan` — it does not
  touch RLS or the table schema.
- Frontend buttons fall back to the existing hosted Payment Links if the
  function is unreachable, so they're never dead — though only the
  function path auto-applies the upgrade (Payment Links would need the webhook’s
  `client_reference_id`, which they don’t carry).
