-- ============================================================================
-- 005_fix_submissions_columns.sql
-- FIXES A SILENT BUG: the frontend saves each analysis with columns `title`
-- and `result`, but the submissions table only had `script_title` and
-- structured columns (overall_score, scores, ...). The save is wrapped in a
-- try/catch that only logs a warning, so every save was failing SILENTLY:
--   * user history never populated
--   * usage was never recorded -> plan limits in grade-script could never fire
--     (the monthly count was always 0)
--
-- This adds the two columns the app code actually uses, so saves succeed.
-- Safe + additive (IF NOT EXISTS) — adds only, changes nothing existing.
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

alter table public.submissions add column if not exists title  text;
alter table public.submissions add column if not exists result jsonb;

-- After this: run one analysis while logged in, then check that it saved:
--   select count(*) from public.submissions
--   where user_email = 'you@example.com'
--     and created_at >= date_trunc('month', now());
-- It should be 1. A second analysis that month (on the free plan) will then be
-- blocked by grade-script with a 429 "limit_reached" — that's enforcement working.
