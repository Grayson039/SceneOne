-- ============================================================================
-- 008_submissions_user_id.sql
-- ----------------------------------------------------------------------------
-- Adds a user_id column to submissions so plan-limit counting is tied to the
-- Supabase auth user ID rather than the user's email address. Counting by email
-- means a user who changes their email resets their monthly counter — counting
-- by user_id is correct and tamper-proof.
--
-- Also updates the RLS policies on submissions to use user_id instead of
-- user_email where possible, so they work even before the frontend backfill.
--
-- Run in Supabase SQL Editor BEFORE redeploying grade-script.
-- ============================================================================

-- 1. Add the column (nullable so existing rows don't break)
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2. Backfill existing rows: match on user_email → auth.users.email
UPDATE submissions s
SET user_id = u.id
FROM auth.users u
WHERE s.user_email = u.email
  AND s.user_id IS NULL;

-- 3. Drop the old email-based RLS policies and replace with user_id-based ones
DROP POLICY IF EXISTS "submissions_insert_own"          ON submissions;
DROP POLICY IF EXISTS "submissions_select_own"          ON submissions;
DROP POLICY IF EXISTS "submissions_update_own"          ON submissions;
DROP POLICY IF EXISTS "submissions_select_public_listed" ON submissions;

-- Users can insert their own submissions
CREATE POLICY "submissions_insert_own"
  ON submissions FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can read their own submissions
CREATE POLICY "submissions_select_own"
  ON submissions FOR SELECT
  USING (user_id = auth.uid());

-- Users can update their own submissions (e.g. toggling public_listing)
CREATE POLICY "submissions_update_own"
  ON submissions FOR UPDATE
  USING (user_id = auth.uid());

-- Execs can read publicly listed submissions on the Discovery Dashboard
CREATE POLICY "submissions_select_public_listed"
  ON submissions FOR SELECT
  USING (public_listing = true);
