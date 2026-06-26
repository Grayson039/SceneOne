# SceneOne Security Audit & Hardening Report
**Date:** June 26, 2026  
**Status:** All issues fixed — requires deployment + one SQL migration to go live

---

## What We Did and Why

### 1. Row-Level Security (RLS) on Database Tables
**File:** `supabase/migrations/007_rls_policies.sql` *(run this in Supabase SQL Editor)*

**The problem:** Your Supabase anon key is public — it's in the HTML so any browser can use it. That's normal and expected. But without RLS, that key could be used to read *every script, report, and email address* in your database. Any curious person who opened DevTools and ran `supabase.from('submissions').select('*')` would get all of it — every user's uploaded scripts and AI reports.

**What we fixed:** Added policies so each user can only see and edit their own data. Scripts are private by default. The only exception is submissions marked `public_listing = true`, which execs are allowed to see (that's the whole point of the Discovery Dashboard). Your edge functions still have full access via the service role key, so grading and billing continue to work exactly as before.

---

### 2. XSS (Cross-Site Scripting) via User Data in HTML
**File:** `landing.html` — added `esc()` helper, patched 5 locations

**The problem:** The Discovery Dashboard and script history were building HTML by dropping user-controlled values (script titles, loglines, story DNA film names) directly into the page using template literals. If someone named their script `<img src=x onerror='steal your cookies'>`, that code would run in every user's browser who viewed the dashboard. This is called Stored XSS — one attacker poisons the page for everyone.

**What we fixed:** Added a single `esc()` function at the top of the script block that converts dangerous characters (`< > & " '`) into safe HTML entities. All five places where user data touched innerHTML now call `esc()` first. The text displays identically to users — only the dangerous interpretation is removed.

---

### 3. CORS Locked to sceneone.net
**Files:** `grade-script/index.ts`, `create-checkout/index.ts`, `create-portal/index.ts`

**The problem:** All three edge functions had `Access-Control-Allow-Origin: *`, meaning any website on the internet could call them. A malicious site could silently trigger API calls using a logged-in user's credentials (their auth token) without them knowing — running up your Anthropic bill or initiating payment flows on their behalf.

**What we fixed:** Changed to `https://sceneone.net` only. Localhost is also allowed so local development still works. Any request from a different origin is rejected by the browser before it even sends.

---

### 4. Anonymous Demo Rate Limiting
**File:** `grade-script/index.ts`

**The problem:** The public sample demo (no login required) had zero rate limiting. A simple script could call it thousands of times in a row — you'd get a massive Anthropic bill with no way to stop it. One for-loop could cost hundreds of dollars in minutes.

**What we fixed:** Added a rate limiter using Deno KV (built-in key-value storage) that allows 1 demo call per IP address per 5 minutes. Logged-in users are unaffected — this only applies to anonymous demo calls. If someone hits the limit, they get a friendly message suggesting they create a free account instead.

---

### 5. Server-Side Script Size Limit
**File:** `grade-script/index.ts`

**The problem:** There was no maximum on how large a script could be. Someone could send a 50MB payload to the edge function — it would try to parse and tokenize all of it, potentially causing slow responses or out-of-memory crashes.

**What we fixed:** Added a 500,000 character hard cap (~500KB) server-side. Real screenplays are 50–120 pages and typically 50–80KB. This limit is well above any real script but stops abuse.

---

### 6. Server-Side PDF Validation
**File:** `grade-script/index.ts`

**The problem:** The PDF check (only accept `.pdf` files) existed only in the browser. Any developer with `curl` or Postman could bypass it and send any file type directly to the API. The function would then pass arbitrary binary data to the Claude API, which could behave unpredictably.

**What we fixed:** The function now checks the PDF "magic bytes" (`%PDF`) on any base64-encoded file the frontend sends alongside the extracted text. If the file doesn't start with those bytes, it's rejected before reaching Claude. The frontend check remains as a UX convenience (immediate error message), but the server is now the real enforcement layer.

---

## What Still Needs Your Manual Action

### Run the SQL migration (required — most important)
Go to your Supabase dashboard → SQL Editor → paste and run `007_rls_policies.sql`. This activates the database protection. Nothing else in this report matters as much as this one step — without it, your database is still open.

### Redeploy the three edge functions
```
supabase functions deploy grade-script --project-ref zzsjgaijrngxkaqakplm
supabase functions deploy create-checkout --project-ref zzsjgaijrngxkaqakplm
supabase functions deploy create-portal --project-ref zzsjgaijrngxkaqakplm
```

### Push landing.html to production
```
git add landing.html
git commit -m "Security: escape user data in innerHTML to prevent XSS"
git push
```

---

## What Was Already Good

These things were correctly implemented and did not need changes:
- **Anthropic API key** — server-side only, never in client code ✓
- **Stripe webhook signature verification** — correctly validates every Stripe event ✓  
- **Service role key isolation** — only used inside edge functions, never exposed to the browser ✓
- **analysis_cache table** — already had RLS enabled with no public policies (service-role access only) ✓
- **Password reset** — correctly does not reveal whether an email address is registered ✓

---

## Summary Table

| Issue | Severity | Fixed In | Status |
|-------|----------|----------|--------|
| No RLS on submissions table | Critical | `007_rls_policies.sql` | Needs SQL migration |
| No RLS on profiles table | Critical | `007_rls_policies.sql` | Needs SQL migration |
| XSS via script title in innerHTML | High | `landing.html` | Needs git push |
| XSS via logline/story DNA in innerHTML | High | `landing.html` | Needs git push |
| CORS open to all origins | Medium | All 3 edge functions | Needs redeploy |
| No anonymous demo rate limit | Medium | `grade-script/index.ts` | Needs redeploy |
| No server-side script size limit | Medium | `grade-script/index.ts` | Needs redeploy |
| No server-side PDF validation | Medium | `grade-script/index.ts` | Needs redeploy |
