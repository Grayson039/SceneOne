# Deploy Progress — Staged Stripe Infrastructure

Resume point tracker. **Read this first** to see exactly where the last session
stopped. One line per checkpoint. Commits are local only — nothing pushed, no
live Supabase/Stripe changes made by the assistant.

## Status

- **Step A — DONE.** `.gitignore` + `supabase/.env.example` committed as `9e55bdf`.
- **Security review — DONE, all 5 points PASS.** No hardcoded secrets in staged files; `.gitignore` covers `.env` and history is clean; create-checkout/create-portal enforce own-account-only via verified JWT; stripe-webhook verifies Stripe signature on raw body; `verify_jwt` correct per function (checkout/portal = true, webhook = false).
- **Step B — code committed locally; LIVE DEPLOY pending (user action).** create-checkout reviewed (PASS). Not yet `supabase functions deploy`-ed.
- **Step C — code committed locally; LIVE DEPLOY + webhook registration pending (user action).** stripe-webhook reviewed (PASS). Webhook URL not yet registered in Stripe dashboard.
- **Step D — code committed locally; LIVE DEPLOY pending (user action).** create-portal reviewed (PASS). Customer Portal not yet enabled in Stripe.
- **Step E — pending.** landing.html wiring (startCheckout / manageSubscription / checkout-return) reviewed (PASS), commit pending.
- **Step F — pending.** SCENEONE-HOW-THIS-WORKS.md explainer not yet written.

## What the assistant will NOT do without explicit go-ahead
- `git push` (this repo publishes to sceneone.net via GitHub Pages on push).
- `supabase functions deploy` / `supabase secrets set` (need your real keys in `supabase/.env`, which only you have).
- Anything in the live Stripe dashboard (webhook registration, Customer Portal enable) — those are manual steps for you; see STRIPE-SETUP.md.

## Next action when resuming
Continue with Step E (commit landing.html) then Step F (write explainer doc),
then hand off the live-deploy checklist. See STRIPE-SETUP.md for deploy commands.
