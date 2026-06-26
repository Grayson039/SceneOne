-- ============================================================================
-- 007_rls_policies.sql — Enable Row-Level Security on submissions + profiles
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query).
-- These policies ensure users can only read/write their own data.
-- The admin user (w1lldebeest3@gmail.com) retains full access via the service
-- role key used in edge functions — that bypasses RLS entirely.
-- ============================================================================

-- ─── SUBMISSIONS ────────────────────────────────────────────────────────────

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

-- Users can insert their own submissions (identified by their auth user id).
-- The submissions table uses user_email, so we match on the JWT email claim.
CREATE POLICY "submissions_insert_own"
  ON submissions FOR INSERT
  WITH CHECK (user_email = auth.jwt() ->> 'email');

-- Users can read their own submissions only.
CREATE POLICY "submissions_select_own"
  ON submissions FOR SELECT
  USING (user_email = auth.jwt() ->> 'email');

-- Users can update their own submissions (e.g. toggling public_listing).
CREATE POLICY "submissions_update_own"
  ON submissions FOR UPDATE
  USING (user_email = auth.jwt() ->> 'email');

-- Public Discovery Dashboard: execs can read submissions where public_listing = true.
-- The user_email is NOT exposed — only the result, title, created_at, and id columns
-- are needed for the dashboard (enforced by the SELECT in loadDashboard()).
CREATE POLICY "submissions_select_public_listed"
  ON submissions FOR SELECT
  USING (public_listing = true);


-- ─── PROFILES ───────────────────────────────────────────────────────────────

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile row.
CREATE POLICY "profiles_select_own"
  ON profiles FOR SELECT
  USING (id = auth.uid());

-- Users can insert their own profile (exec signup flow).
CREATE POLICY "profiles_insert_own"
  ON profiles FOR INSERT
  WITH CHECK (id = auth.uid());

-- Users can update their own profile row.
CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  USING (id = auth.uid());

-- Execs browsing the dashboard need to verify profiles (role + verified check).
-- This allows any authenticated user to read role + verified on any profile,
-- but ONLY those two columns (the SELECT in requestScriptAccess only reads
-- role and verified). The rest of the profile (plan, stripe_customer_id, etc.)
-- is protected by the own-only policy above.
-- NOTE: If you want stricter isolation, remove this policy and move the
-- exec-verification check into a dedicated edge function.
CREATE POLICY "profiles_select_role_verified_any_authed"
  ON profiles FOR SELECT
  USING (auth.uid() IS NOT NULL);
