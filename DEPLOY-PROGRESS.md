# Deploy Progress — Staged Stripe Infrastructure

Resume point tracker. **Read this first** to see exactly where the last session
stopped. Commits are local only — nothing pushed, no live Supabase/Stripe changes
made by the assistant.

## Status

- **Step A — DONE.** `.gitignore` + `supabase/.env.example` committed as `9e55bdf`.
- **Security review — DONE, all 5 points PASS.** No hardcoded secrets in staged files; `.gitignore` covers `.env` and history is clean (no `.env` ever committed); create-checkout/create-portal enforce own-account-only via verified JWT; stripe-webhook verifies Stripe signature on raw body; `verify_jwt` correct per function (checkout/portal = true, webhook = false).
- **Step B — code committed `cc475a2`; DEPLOYED (live, ACTIVE v1).** create-checkout reviewed (PASS). Secrets pushed to Supabase.
- **Step C — code committed `ab68e0a`; DEPLOYED (live, ACTIVE v1) — but NOT yet functional: webhook endpoint not registered in Stripe + STRIPE_WEBHOOK_SECRET still REPLACE_ME on line 22.** stripe-webhook reviewed (PASS).
- **Step D — code committed `6a1eeab`; DEPLOYED (live, ACTIVE v1).** create-portal reviewed (PASS). Stripe Customer Portal not yet enabled.

## ✅ Deploy done (2026-06-24): secrets pushed; create-checkout / stripe-webhook / create-portal all ACTIVE v1.
## ▶️ NEXT MANUAL STEPS (Stripe dashboard — only you can do these):
##   1. Register webhook: Stripe (test) -> Developers -> Webhooks -> Add endpoint
##      URL: https://zzsjgaijrngxkaqakplm.supabase.co/functions/v1/stripe-webhook
##      Events: checkout.session.completed, customer.subscription.updated,
##              customer.subscription.deleted, invoice.payment_failed
##      Then copy its whsec_ signing secret into supabase/.env line 22, and re-run:
##        supabase secrets set --env-file ./supabase/.env --project-ref zzsjgaijrngxkaqakplm
##        supabase functions deploy stripe-webhook --project-ref zzsjgaijrngxkaqakplm
##   2. Enable Stripe Customer Portal: Settings -> Billing -> Customer portal -> Activate.
##   3. Test: sign in, Get Writer, pay with 4242 4242 4242 4242, confirm profiles.plan updates.
##   4. git push to publish landing.html to sceneone.net (currently NOT pushed).
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
