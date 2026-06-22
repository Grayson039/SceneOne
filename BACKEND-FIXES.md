# SceneOne — Backend Security Fixes (read me first)

Plain-English guide. Nothing in here has touched your live site yet — these are
prepared files you deploy when you're ready. Take it slow; do one section at a
time.

---

## The one-sentence problem

Your "plan limits" (Free = 1/mo, Writer = 5/mo, Pro = unlimited) only exist in
the **browser**, and your database has **no place to store a user's plan** — so
a logged-in Free user can run unlimited analyses (you pay Anthropic for each),
and Stripe upgrades have nowhere real to be recorded.

This is the exact thing Sako warned about: billing + access control can't be
faked on the frontend. They have to live on the server.

---

## What I prepared for you (already committed to the repo)

| File | What it does | Risk |
|------|--------------|------|
| `supabase/migrations/004_billing_and_usage.sql` | Adds the missing `plan`, `stripe_customer_id`, `plan_renews_at`, `user_id` columns + a usage-counting helper | Safe / additive — adds only, deletes nothing |
| `supabase/functions/grade-script/index.hardened.ts` | A copy of your edge function that enforces plan limits **on the server** before spending money on Claude | None until you deploy it |
| `BACKEND-FIXES.md` | This guide | — |

Your existing, working `index.ts` is untouched, so the live site keeps working
exactly as it does now until you choose to deploy.

---

## Do these 2 steps when you're back (~5 min)

### Step 1 — Add the database columns (no command line)
1. Go to **supabase.com → your project → SQL Editor → New query**
2. Open `supabase/migrations/004_billing_and_usage.sql`, copy everything, paste, **Run**
3. To make your own account Pro for testing, run (replace the id):
   ```sql
   update public.profiles set plan = 'pro' where id = 'YOUR-AUTH-USER-ID';
   ```
   (Your user id is in Supabase → Authentication → Users.)

### Step 2 — Deploy the hardened function
This needs the Supabase CLI on your machine. One-time setup, then one command.
```bash
# one-time (if you don't have it):  npm install -g supabase   then:  supabase login
cd path/to/SceneOne
mv supabase/functions/grade-script/index.ts supabase/functions/grade-script/index.OLD.ts
mv supabase/functions/grade-script/index.hardened.ts supabase/functions/grade-script/index.ts
supabase functions deploy grade-script --project-ref zzsjgaijrngxkaqakplm
```
**Test right after:** run the sample script on sceneone.net — it should still
produce a report. Then, as a Free user, run a 2nd analysis — it should be
blocked with an "upgrade" message. That's the fix working.

**Rollback if anything looks off:** put `index.OLD.ts` back as `index.ts` and
re-run the deploy command. You're back to today's working version.

---

## What still needs you + Sako (the genuinely hard part — do it together)

These are **decisions and Stripe wiring**, not things I should guess at alone:

1. **The anonymous demo decision.** The landing page runs the sample with no
   login = anyone could abuse it and run up your Claude bill. Pick one:
   (a) leave open, (b) require login + make the sample a pre-saved static
   report, (c) 1 free anonymous run then login. (Marked in the hardened file.)

2. **The Stripe webhook.** "Payments upgrade accounts" needs a server endpoint
   that listens to Stripe and writes `plan` in the database. It must:
   - verify Stripe's signature (so fakes can't grant Pro for free)
   - be idempotent (Stripe retries events)
   - handle the money-leak events: `invoice.payment_failed` (card declines →
     downgrade), `customer.subscription.deleted` (cancel → downgrade),
     `customer.subscription.updated` (up/downgrade → adjust plan)
   This is what Sako called the "nightmare." It's worth building carefully with
   him rather than vibe-coding. Once the `plan` column exists (Step 1), the
   webhook just writes to it.

3. **Row-Level Security (RLS) audit.** Confirm a logged-in user can only read/
   write their **own** rows in `profiles` and `submissions` (except the public
   Discovery listings). I left this OUT of the migration on purpose — a wrong
   RLS rule can break the live app, so it should be checked against your current
   policies, not applied blind.

---

## TL;DR
- **Done + safe:** the DB foundation + a server-enforced version of the function.
- **You do:** run one SQL file, run one deploy command (Steps 1–2).
- **With Sako:** the demo decision, the Stripe webhook, the RLS check.
