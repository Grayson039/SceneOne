# SceneOne — Session Handoff

**Date:** 2026-06-28  
**Repo:** Grayson039/SceneOne  
**Live site:** sceneone.net  
**Dev branch:** `claude/new-session-bwjyg4`

---

## What was built this session

### PRs merged to main
| PR | What |
|----|------|
| #6 | Case study screen count 10 → 13 |
| #7 | Turnstile CAPTCHA fix (hidden tab render) + exec dashboard redesign live |
| #8 | Screenplay Typewriter loader + Spotlight/Noir loader + case study updated to 4 loaders |
| #9 | CAPTCHA await fix — all auth calls now `await _tsAwaitToken()` (polls up to 5s for token) |

---

## Current known issues

### CAPTCHA on exec sign-in (priority)
- Error: "captcha protection: request disallowed (no captcha_token found)"
- **Root cause history:** Turnstile widget was rendering into a hidden element (tab was inactive), then token wasn't ready at click time.
- **What's been fixed:** Widget re-renders on tab switch (PR #7), iframe detection prevents stale widget cache (PR #8), auth calls now await token up to 5s (PR #9).
- **If still broken after PR #9:** The Turnstile site key `0x4AAAAADrnusj8lT1xi7OE` may be set to "invisible" mode in Cloudflare dashboard but something is blocking auto-completion. Next step: check Cloudflare Turnstile dashboard → Analytics to see if challenges are being issued/passed, or switch widget type to "managed" which shows a visible checkbox the user clicks.

---

## App architecture

- **Single file app:** `landing.html` (~6100 lines) — all 13 screens, CSS, and JS in one file
- **Case study:** `index.html` — portfolio/case study page at sceneone.net
- **Auth:** Supabase (`supabaseClient`) with Cloudflare Turnstile CAPTCHA
- **Payments:** Stripe Checkout (live keys, Writer $12 `price_1TkaV3E4u9LEUFy00vJ8PcEM`, Pro $29 `price_1TkaVrE4u9LEUFy0zVlay8Lg`)
- **Deployment:** GitHub Pages from `main` branch

## 13 Screens
1. `screen-landing` — Home
2. `screen-welcome` — Writer sign in/up
3. `screen-onboard` — Writer onboarding
4. `screen-pricing` — Pricing plans
5. `screen-exec-signup` — Exec sign in/up (2 tabs: Create Account / Sign In)
6. `screen-exec-onboard` — Exec onboarding
7. `screen-upload` — Script upload
8. `screen-processing` — 4 randomized cinematic loaders
9. `screen-dashboard` — Discovery dashboard
10. `screen-writer-profile` — Writer profile
11. `screen-exec-profile` — Reader/exec dashboard (bento layout)
12. `screen-report` — Script report
13. `screen-requests` — Exec requests

## 4 Cinematic Loaders (rotate randomly)
1. **Film Countdown** — `runCountdown()` — retro film leader with ticker
2. **Clapperboard** — `runClapper()` — clapperboard slap animation
3. **Screenplay Draft** — `runTypewriter()` — screenplay page scrolls up as text types
4. **Spotlight/Noir** — `runSpotlight()` — dark spotlight beam with cinematic phrases

## Key functions
- `goTo(id)` — switches screens
- `startProcessing()` — kicks off upload + picks random loader
- `handleExecSignIn()` / `handleWriterSignIn()` — auth
- `switchExecTab(tab)` — toggles Create Account / Sign In tabs, triggers Turnstile render
- `_tsAwaitToken(key, maxMs)` — polls for Turnstile token before auth call
- `loadDashboard()` — populates discovery dashboard
- `handleSignOut()` — signs out and returns to landing

## Turnstile CAPTCHA keys
- Site key: `0x4AAAAADrnusj8lT1xi7OE`
- Widget IDs: `ts-writer-signup`, `ts-writer-login`, `ts-exec-signup`, `ts-exec-signin`
- Token keys: `writerSignup`, `writerLogin`, `execSignup`, `execSignin`

---

## Deferred / future work
- Real data integration on exec dashboard (currently all placeholder/static)
- `approveRequest` / `declineRequest` not persisted to Supabase
- Admin gate is client-side only (architectural fix needed)
- Footer legal links point to `#`
- Fallback Stripe payment links are placeholders

---

## IMPORTANT: Never open "old landing"
The old `landing.html` backup is so large it crashes sessions. Never read it.
