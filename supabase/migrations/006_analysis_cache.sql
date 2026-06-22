-- ============================================================================
-- 006_analysis_cache.sql
-- Backs the "fingerprint + instant cache" feature. The grade-script function
-- hashes each uploaded draft (SHA-256). If that exact text was graded before,
-- it returns the stored report instantly — no Claude call, no plan credit used.
--
-- Only the edge function (service role) reads/writes this table. RLS is enabled
-- with NO policies, so it is invisible to the public API; the service role
-- bypasses RLS. Safe + additive.
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

create table if not exists public.analysis_cache (
  script_hash text primary key,          -- SHA-256 of the trimmed script text
  result      jsonb not null,            -- the full coverage report
  title       text,
  created_at  timestamptz not null default now()
);

-- Lock it down: service-role only (edge function), invisible to anon/auth API.
alter table public.analysis_cache enable row level security;
