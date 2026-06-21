-- SceneOne: add public_listing to submissions + admin RLS policy
-- Run in Supabase SQL editor at app.supabase.com

-- 1. Add public_listing column to submissions
alter table submissions
  add column if not exists public_listing boolean default false;

-- 2. Index for fast dashboard queries
create index if not exists submissions_public_listing_idx
  on submissions (public_listing)
  where public_listing = true;

-- 3. Allow admin (Will) to update any profile (for exec verification)
create policy if not exists "Admin can update any profile" on profiles
  for update using (auth.email() = 'w1lldebeest3@gmail.com');

-- 4. Allow admin to read all profiles
create policy if not exists "Admin can read all profiles" on profiles
  for select using (auth.email() = 'w1lldebeest3@gmail.com');
