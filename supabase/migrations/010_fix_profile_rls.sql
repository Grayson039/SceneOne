-- ============================================================================
-- 010_fix_profile_rls.sql
-- ----------------------------------------------------------------------------
-- Fixes the overly broad cross-user SELECT policy introduced in 009.
--
-- The prior policy (profiles_select_role_verified_authed_only) had condition:
--   id = auth.uid() OR auth.uid() IS NOT NULL
-- which simplifies to auth.uid() IS NOT NULL — any authenticated user could
-- read ALL columns (including plan, stripe_customer_id) of ANY profile row.
--
-- The cross-user read in requestScriptAccess() reads the CURRENT USER's own
-- profile (.eq('id', _currentUser.id)), so the cross-user policy is not
-- needed. The own-row policy (profiles_select_own from 007) covers it.
--
-- This migration drops the cross-user policy entirely, leaving only own-row
-- access for full column reads.
-- ============================================================================

DROP POLICY IF EXISTS "profiles_select_role_verified_authed_only" ON profiles;

-- Ensure own-row policy exists (idempotent — 007 creates it, but guard here).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'profiles'
      AND policyname = 'profiles_select_own'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "profiles_select_own"
        ON profiles FOR SELECT
        USING (id = auth.uid())
    $policy$;
  END IF;
END;
$$;
