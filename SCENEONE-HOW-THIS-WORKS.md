# How SceneOne's Stripe Billing Actually Works

A plain-English walkthrough of the payment system, written for someone who built
the frontend and product but is still getting comfortable with the backend. No
prior backend vocabulary assumed — every term is explained the first time it
shows up. Nothing here is dumbed down; it's just unpacked.

---

## First, what is an "edge function"?

An **edge function** is a small piece of code that runs on Supabase's servers
instead of in the user's browser. The landing page (`landing.html`) runs *in the
visitor's browser*, where anyone can open dev tools and read every line — so it
can never be trusted with secrets or with deciding who's allowed to do what. An
edge function runs *on a server you control*, privately, so it's the right place
to hold secret keys and make real decisions like "is this person actually a paying
subscriber?"

Think of it this way: the browser is the front counter where customers stand; the
edge function is the back office where the safe is kept. SceneOne has three of
them for billing.

---

## The three Stripe functions, and the story of a subscription

### 1. `create-checkout` — "I want to subscribe"

**What it does:** Builds a one-time, personalized Stripe payment page and hands
back its URL.

**The flow when a user clicks "Get Writer" or "Get Pro":**

1. The button calls `startCheckout('writer')` in the browser.
2. The browser first checks the user is signed in. If not, it asks them to sign
   in — because a payment that isn't tied to an account is useless (we'd have no
   idea whose plan to upgrade).
3. The browser calls the `create-checkout` edge function, passing which plan was
   clicked. It automatically attaches the user's **login token** (more on that
   below) so the function knows *exactly who is asking* — the user can't fake
   being someone else.
4. The function asks Stripe to create a **Checkout Session** — Stripe's hosted,
   PCI-compliant payment page — and crucially stamps it with the user's SceneOne
   account ID. That stamp is the thread that ties the whole thing together.
5. The function returns the Stripe URL, and the browser sends the user there to
   type in their card. **SceneOne never sees or handles the card number** —
   Stripe does. That's the entire point of using their hosted page.

If the function is ever unreachable (e.g. not deployed yet), the button quietly
falls back to a plain Stripe Payment Link so it's never a dead button.

### 2. `stripe-webhook` — "the payment actually went through"

Here's the subtle part: when the user pays on Stripe's page, **the browser
doesn't tell SceneOne the payment succeeded.** It can't be trusted to — anyone
could fake that message from their browser and get a free Pro plan. Instead,
**Stripe's own servers** send a message directly to SceneOne saying "this payment
completed." That message is called a **webhook** — Stripe phoning your back office
to report an event.

**What `stripe-webhook` does:** It listens for those calls from Stripe and, when a
real one arrives, writes the result into the database — flipping the user's plan
from `free` to `writer` or `pro`.

**The events it handles:**

- **Payment completed** (`checkout.session.completed`) → look up which account the
  payment was stamped with, confirm what they actually bought (by reading the real
  price on the subscription, not just trusting a label), and set their plan + save
  their Stripe customer ID + record when the plan next renews.
- **Subscription changed** (`customer.subscription.updated`) → keep the plan and
  renewal date in sync if they upgrade/downgrade, or downgrade them to `free` if
  the subscription has gone into a dead state.
- **Subscription cancelled** (`customer.subscription.deleted`) → set the plan back
  to `free`.
- **A renewal payment failed** (`invoice.payment_failed`) → *don't* cut them off
  yet (see the grace-period section below).

This is why upgrading "takes a few seconds" — the browser shows "payment received,"
but the actual plan change happens a moment later when Stripe's webhook call lands
and this function updates the database.

### 3. `create-portal` — "I want to cancel or change my plan"

**What it does:** Opens Stripe's hosted **Customer Portal** — their pre-built
screen where a subscriber can cancel, switch plans, or update their card.

**The flow when a user clicks "Manage Plan":**

1. The browser calls `create-portal`, again attaching the user's login token.
2. The function looks up *that user's* Stripe customer ID and asks Stripe for a
   portal link for them specifically.
3. The user is sent to Stripe's portal and does whatever they need.

We deliberately **don't build our own cancel/billing screens.** Stripe's portal
handles all the fiddly, risky billing UI (refunds, proration, card updates) safely.
And when a user cancels there, we don't need any special "they cancelled" code —
Stripe fires the **subscription cancelled** webhook above, which automatically
downgrades them to `free`. One mechanism, reused.

---

## Why the webhook checks Stripe's "signature" — and what it's protecting against

The webhook endpoint is **publicly reachable on the internet.** It has to be —
Stripe's servers need to be able to call it. But that means *anyone* on the
internet can also send it a POST request.

Without a check, someone could send a fake "payment succeeded for my account"
message straight to that URL and hand themselves a free Pro plan. That's a real,
easy attack on any naive webhook.

The protection: every genuine call from Stripe includes a **signature** — a
scrambled fingerprint of the message, generated using a shared secret that only
Stripe and SceneOne's server know (the "webhook signing secret"). Before trusting
a single byte of the message, the function recomputes that fingerprint and checks
it matches. If it doesn't match, the message is a forgery (or was tampered with in
transit) and the function rejects it immediately. So **the function trusts the
event only because the math proves it really came from Stripe**, not because the
message *says* it did.

(One detail that makes this work: the function reads the **raw, untouched** body of
the request to do this check. The fingerprint is computed over the exact bytes
Stripe sent — modifying or re-formatting them first would break the verification.)

---

## What `verify_jwt` means, and why two functions need it but one doesn't

A **JWT** ("JSON Web Token") is the tamper-proof login token a user's browser holds
after signing in. It proves "I am this specific logged-in user" without the server
having to store a session. When the browser calls an edge function, it can send
this token along.

`verify_jwt` is a per-function setting (in `supabase/config.toml`) that tells
Supabase: *"before you even run this function, reject anyone who doesn't present a
valid login token."* It's a gate at the door.

- **`create-checkout` and `create-portal` → `verify_jwt = true`.** These act *on
  behalf of a specific person* ("upgrade **my** account," "open **my** billing
  portal"). They must know — and be certain of — who's calling. The token answers
  that, and because Supabase verifies it, the user can't impersonate anyone else.
  The function then looks up the Stripe customer using *the verified user's own
  ID* — never an ID supplied in the request — so there's no way to act on someone
  else's account.

- **`stripe-webhook` → `verify_jwt = false`.** The caller here is **Stripe**, not a
  logged-in SceneOne user. Stripe has no SceneOne login and carries no JWT, so if
  this gate were on, Supabase would slam the door on every real webhook with a 401
  error before our code ran. Turning the JWT gate off is correct — **but it does
  *not* mean "no security."** This function uses the **signature check** described
  above as its door instead. Different caller, different (equally strict) proof of
  identity.

So: two functions are guarded by "prove you're a logged-in user," and one is
guarded by "prove you're really Stripe." Every function is protected — just
appropriately to who's supposed to be calling it.

---

## What ends up stored in the database, and why those three fields matter

When all this runs, the webhook writes three fields onto the user's row in the
`profiles` table:

| Field | What it holds | Why it matters |
|---|---|---|
| **`plan`** | `free`, `writer`, or `pro` | The single source of truth for what the user is allowed to do. The app reads this to enforce limits (e.g. how many script analyses they get). Without it, "plan limits" could only be faked in the browser — which anyone could bypass. This is what makes paywalls *real*. |
| **`stripe_customer_id`** | The user's ID *inside Stripe* (e.g. `cus_…`) | The link between a SceneOne account and its Stripe billing record. It's how `create-portal` knows which customer to open the billing portal for, and how renewal/cancellation webhooks find the right account again later. Without it, we couldn't connect a future Stripe event back to a user. |
| **`plan_renews_at`** | The date the current paid period ends | Lets the app know when access should lapse if billing stops, and lets you show the user honest info like "renews on May 3." It's kept in sync every time Stripe reports a renewal. |

Together they answer the three questions the product constantly needs: *What is
this user allowed to do? How do we reach their billing? When does it run out?*

---

## What the grace period does for a real user whose card fails

Cards fail all the time for boring reasons — expired card, hit a limit, bank
flagged it. If SceneOne instantly revoked a paying subscriber's access the moment
one renewal charge bounced, that would be a terrible, unfair experience for a
customer who fully intends to keep paying.

So when Stripe reports **a failed renewal payment** (`invoice.payment_failed`), the
webhook deliberately does **nothing to their access.** It just logs the event. The
user keeps their `writer`/`pro` plan.

Behind the scenes, Stripe enters a **dunning** period — it automatically retries
the card over the next several days (the exact schedule is configured in the Stripe
dashboard) and can email the customer asking them to update their card. This
retry-and-remind window is the **grace period.**

Only if *all* those retries are exhausted does Stripe give up and move the
subscription to a cancelled/unpaid state — and *that* fires the "subscription
cancelled/updated" webhook, which is where access finally drops to `free`.

**For a real user, the effect is:** a card hiccup doesn't lock them out
mid-month. They get a window and a nudge to fix their payment, and they only lose
access if they never do. It's the difference between "your card failed, you're
out" and "your card failed, here's a few days to sort it out" — the latter is what
keeps good customers from churning over a bank glitch.
