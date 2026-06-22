-- ============================================================================
-- 004_billing_and_usage.sql
-- Adds the billing + usage foundation that the app currently has NO database
-- backing for. Without this, "plan limits" and "Stripe upgrades" have nowhere
-- to live, so they can only be faked on the frontend (= not real enforcement).
--
-- This migration is SAFE and ADDITIVE:
--   * every statement uses "IF NOT EXISTS" — running it twice does nothing bad
--   * it does NOT drop, rename, or delete anything
--   * it does NOT change RLS (that's handled separately + carefully — see
--     BACKEND-FIXES.md, because a wrong RLS change can break the live app)
--
-- HOW TO RUN (no command line needed):
--   Supabase dashboard -> your project -> SQL Editor -> New query
--   -> paste this whole file -> Run.
-- ============================================================================

-- 1) PLAN TIER on profiles -- the single source of truth for what a user is
--    allowed to do. Stripe's webhook will write to this column on upgrade,
--    and the grade-script function will read it to enforce limits.
alter table public.profiles
  add column if not exists plan text not null default 'free';   -- 'free' | 'writer' | 'pro'

-- Link to Stripe so the webhook can match a payment back to this user.
alter table public.profiles
  add column if not exists stripe_customer_id text;

-- When the current paid period ends (used to downgrade on cancel/expiry).
alter table public.profiles
  add column if not exists plan_renews_at timestamptz;

-- 2) Make submissions reliably attributable to a user.
--    Right now submissions are saved with `user_email` only, which can be null
--    and isn't a stable key. Add a real user_id so usage can be counted per
--    user and protected by RLS.
alter table public.submissions
  add column if not exists user_id uuid references auth.users(id);

-- 3) Helper the edge function calls to enforce monthly limits.
--    Counts how many analyses THIS user has run in the current calendar month.
create or replace function public.analyses_this_month(uid uuid)
returns integer
language sql
stable
set search_path = ''   -- pin search_path (Supabase security advisor best practice)
as $$
  select count(*)::int
  from public.submissions
  where user_id = uid
    and created_at >= date_trunc('month', now());
$$;

-- ============================================================================
-- After running this:
--   * existing users all become plan = 'free' (the safe default)
--   * to make yourself 'pro' for testing, run:
--       update public.profiles set plan = 'pro' where id = 'YOUR-AUTH-USER-ID';
-- ============================================================================
