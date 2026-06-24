# Deploy Progress — Staged Stripe Infrastructure

Resume point tracker. **Read this first** to see exactly where the last session
stopped. Commits are local only — nothing pushed, no live Supabase/Stripe changes
made by the assistant.

## Status

- **Step A — DONE.** `.gitignore` + `supabase/.env.example` committed as `9e55bdf`.
- **Security review — DONE, all 5 points PASS.** No hardcoded secrets in staged files; `.gitignore` covers `.env` and history is clean (no `.env` ever committed); create-checkout/create-portal enforce own-account-only via verified JWT; stripe-webhook verifies Stripe signature on raw body; `verify_jwt` correct per function (checkout/portal = true, webhook = false).
- **Step B — code committed `cc475a2`; DEPLOYED (live, ACTIVE v1).** create-checkout reviewed (PASS). Secrets pushed to Supabase.
- **Step C — code committed `ab68e0a`; DEPLOYED + WIRED (live, ACTIVE v3).** stripe-webhook reviewed (PASS). Webhook endpoint registered in Stripe sandbox (destination "creative-sensation", 4 events). STRIPE_WEBHOOK_SECRET set on line 22 and pushed; webhook redeployed to pick it up.
- **Step D — code committed `6a1eeab`; DEPLOYED (live, ACTIVE v1).** create-portal reviewed (PASS). Stripe Customer Portal not yet enabled.

## ✅ Deploy done (2026-06-24): secrets pushed; all functions ACTIVE. Webhook registered + signing secret deployed.
## ✅ SANDBOX TEST PASSED (2026-06-24): Get Writer -> Stripe Checkout ($12, correct price, email prefilled)
##    -> paid with 4242 -> webhook fired -> profiles row created with plan='writer' + stripe_customer_id='cus_...'.
##    Full money path verified end-to-end. The "profiles row" gotcha did NOT occur (upsert created the row;
##    role has a default). create-checkout, stripe-webhook, and the DB write all confirmed working in test mode.
##
## ▶️ REMAINING STEPS:
##   1. [Stripe, you] Enable Customer Portal: Settings -> Billing -> Customer portal -> Activate (allow "cancel subscription"). Needed for the "Manage Plan" button. (Test the portal via create-portal after.)
##   2. [GO LIVE — wide awake, real money] Swap supabase/.env to LIVE values:
##        - STRIPE_SECRET_KEY = sk_live_...
##        - STRIPE_WRITER_PRICE_ID / STRIPE_PRO_PRICE_ID = LIVE-mode price_ ids (create/activate products in live mode)
##        - Create a SEPARATE live-mode webhook endpoint (same URL + 4 events) -> its whsec_ -> STRIPE_WEBHOOK_SECRET
##      Then: supabase secrets set --env-file ./supabase/.env --project-ref zzsjgaijrngxkaqakplm  (re-push)
##            supabase functions deploy stripe-webhook --project-ref zzsjgaijrngxkaqakplm          (re-deploy)
##      NOTE: one .env — switching to live keys ends sandbox/4242 testing. Test fully first (DONE).
##   3. [git push, you] Publish landing.html to sceneone.net (GitHub Pages). Currently NOT pushed.
##   4. [UX gap found during test] Logged-in writers have NO persistent "Upgrade" button — pricing screen is
##      only reachable pre-login ("See pricing") or after hitting the monthly limit ("See Plans"). Consider a
##      persistent "Upgrade" link in the signed-in header to reduce the conversion leak. (Not yet built.)
- **Step E — code committed `937284f`; live-verify pending.** landing.html wiring reviewed (PASS). "Confirmed working against deployed functions" needs the functions deployed first; until then buttons fall back to hosted Payment Links.
- **Step F — DONE.** `SCENEONE-HOW-THIS-WORKS.md` plain-English explainer written and committed.

## Remaining = live deploy (YOUR action — needs your real keys + Stripe dashboard)
All source is committed locally. Nothing pushed or deployed by the assistant.
Follow STRIPE-SETUP.md:
1. `cp supabase/.env.example supabase/.env` and fill in real TEST keys (gitignored — never commit it).
2. `supabase secrets set --env-file ./supabase/.env --project-ref zzsjgaijrngxkaqakplm`
3. Deploy the 3 functions:
   `supabase functions deploy create-checkout --project-ref zzsjgaijrngxkaqakplm`
   `supabase functions deploy stripe-webhook  --project-ref zzsjgaijrngxkaqakplm`
   `supabase functions deploy create-portal   --project-ref zzsjgaijrngxkaqakplm`
4. Register the webhook in Stripe -> Developers -> Webhooks:
   URL: https://zzsjgaijrngxkaqakplm.supabase.co/functions/v1/stripe-webhook
   Events: checkout.session.completed, customer.subscription.updated,
           customer.subscription.deleted, invoice.payment_failed
   Then put the whsec_ signing secret in supabase/.env, re-push secrets, re-deploy stripe-webhook.
5. Enable Stripe Customer Portal (Settings -> Billing -> Customer portal) so "Manage Plan" works.
6. Test round-trip with card 4242 4242 4242 4242; confirm profiles.plan updates.
7. `git push` to publish the landing.html wiring to sceneone.net (GitHub Pages).
8. Watch the "profiles row" gotcha (writers may lack a profiles row — see STRIPE-SETUP.md backfill SQL).

## What the assistant will NOT do without explicit go-ahead
- `git push` (publishes to sceneone.net via GitHub Pages).
- `supabase functions deploy` / `secrets set` (need your real keys in supabase/.env).
- Live Stripe dashboard actions (webhook registration, Customer Portal enable).
