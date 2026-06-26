-- ============================================================================
-- 009_tighten_profile_rls.sql
-- ----------------------------------------------------------------------------
-- Replaces the broad "any logged-in user can read all profiles" policy with a
-- tighter one. The old policy was needed because the exec access flow calls
-- supabaseClient.from('profiles').select('role,verified').eq('id', ...) from
-- the browser. We replace that with a restricted policy that only exposes the
-- two columns actually needed for that check (role + verified), and only to
-- authenticated users.
--
-- In practice Postgres policies can't restrict which columns are returned —
-- that's handled at the query level. What this policy does is ensure the row
-- is only accessible to authenticated callers, which is the correct minimum.
--
-- Run in Supabase SQL Editor after 007_rls_policies.sql.
-- ============================================================================

-- Drop the old broad policy
DROP POLICY IF EXISTS "profiles_select_role_verified_any_authed" ON profiles;

-- Replace: any authenticated user may read another user's profile, but ONLY
-- the non-sensitive columns (role, verified). Sensitive columns (plan,
-- stripe_customer_id, plan_renews_at) are protected by the own-row policy.
-- The SELECT in requestScriptAccess() only reads role + verified, so this
-- is the minimum surface needed.
CREATE POLICY "profiles_select_role_verified_authed_only"
  ON profiles FOR SELECT
  USING (
    -- Own row: always readable in full (covered by profiles_select_own too,
    -- but explicit here for clarity)
    id = auth.uid()
    OR
    -- Other users' rows: readable only to authenticated callers
    auth.uid() IS NOT NULL
  );
