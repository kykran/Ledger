# Trainer Tally

Sessions, packages, monthly bills and studio rent for personal trainers, counted from Google Calendar.

One codebase, two homes:

| | claude.ai version (today) | Hosted version (launch) |
|---|---|---|
| Runs in | a Claude artifact | your own domain on Vercel |
| Sign-in | the viewer's Claude account | Continue with Google |
| Calendar | the viewer's Claude Google Calendar connector | Google Calendar API (read-only) |
| Data | artifact database, private per viewer | Supabase, private per trainer (row-level security) |
| Built from | `src/app.js` + `src/adapter-claude.js` | `src/app.js` + `src/adapter-hosted.js` |

`src/app.js` holds all the logic and screens. Each adapter only answers "where is the data" and "how do I read the calendar". Change the app once and both versions get it.

```
src/
  app.js              engine + UI (shared)
  styles.css          design (shared; cream light + dark)
  shell.html          page frame (shared)
  adapter-claude.js   claude.ai storage + calendar
  adapter-hosted.js   Supabase storage + /api/calendar
api/
  calendar.js         Google Calendar proxy (read-only)
  auth/store-token.js keeps the Google refresh token server-side
  billing/*.js        Stripe checkout, portal, webhook
supabase/schema.sql   tables + row-level security
scripts/build-artifact.mjs   builds the single-file claude.ai page
public/privacy.html   privacy policy draft (needed for Google review)
```

## Update the claude.ai version

```
npm run build:artifact     # writes dist-artifact/index.html
```
Then ask Claude to republish that file to the existing Trainer Tally link. Data paths never change, so everyone's data carries over.

## Launch the hosted version

About an hour of clicking, in this order.

### 1. Supabase (database + login)
1. Create a project at supabase.com.
2. SQL Editor → paste `supabase/schema.sql` → Run.
3. Project Settings → API: copy the **Project URL**, **anon public key** and **service_role key**.

### 2. Google Cloud (calendar access)
1. console.cloud.google.com → new project "Trainer Tally".
2. APIs & Services → Library → enable **Google Calendar API**.
3. OAuth consent screen → External. App name, support email, logo, your domain, and the privacy URL (`https://YOUR-DOMAIN/privacy.html`). Scopes: add `.../auth/calendar.readonly`. Under **Test users**, add Tatjana and anyone else testing (up to 100).
4. Credentials → Create OAuth client ID → Web application.
   Authorized redirect URI: `https://YOUR-PROJECT.supabase.co/auth/v1/callback`
5. Copy the **Client ID** and **Client secret**.
6. Back in Supabase: Authentication → Providers → Google → paste them → enable.
   Authentication → URL Configuration → Site URL `https://YOUR-DOMAIN`, and add `http://localhost:3000` for local testing.

### 3. Vercel (hosting)
1. Push this folder to a GitHub repo, then import it at vercel.com.
2. Settings → Environment Variables: add everything in `.env.example`.
3. Deploy. Add your domain under Settings → Domains, then set `APP_URL` to it.

### 4. Stripe ($3/month), when you're ready to charge
Do all of this in a **sandbox** first, then repeat in live mode.
1. Product catalog → create **Trainer Tally**, recurring price **$3.00 / month**. Copy the **price ID** (`price_...`).
2. Developers → API keys → copy the **secret key** into Vercel as `STRIPE_SECRET_KEY` (never paste it into chat or commit it).
3. Developers → Webhooks → Add endpoint `https://YOUR-DOMAIN/api/billing/webhook`, events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_failed`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Settings → Billing → **Customer portal**: turn on invoice history, update payment method, and cancel (at period end).
5. Settings → Billing → **Subscriptions and emails**: turn on Smart Retries, emails for failed payments and expiring cards, and "Email finalized invoices / successful payments" so subscribers get receipts.
6. Optional: turn on Stripe Tax and set `STRIPE_AUTOMATIC_TAX=true` (Massachusetts taxes SaaS; check with your accountant).
7. Set `VITE_BILLING_ENABLED=true`. When the trial should start counting, set `REQUIRE_SUBSCRIPTION=true`; new sign-ups get `TRIAL_DAYS` free.

How access works: the webhook re-reads each subscription from Stripe and stores `access_until` (end of the paid period + 2 days). `active`, `trialing` and `past_due` (while Stripe retries the card) keep the app unlocked; `canceled`, `unpaid` and expired checkouts lock it once `access_until` passes. A subscriber who taps Subscribe again is sent to the portal, not a second subscription.

Test cards: `4242 4242 4242 4242` succeeds, `4000 0000 0000 0341` fails on renewal. Any future date and any CVC.

### 5. Google verification (before strangers can sign in)
While the consent screen is in **Testing**, only listed test users can sign in. To open it to everyone, click **Publish app** and submit for verification. `calendar.readonly` is a *sensitive* scope: Google asks for the privacy policy, a short screen recording of the sign-in and how calendar data is used, and domain verification. Typical turnaround is a few weeks. No paid security audit is needed for this scope.

## Studio side (`/studio.html`)

For studio owners who rent space to trainers. Run `supabase/studio.sql` once after `schema.sql`.

- The owner signs in with Google and picks the studio's shared calendar.
- Each session is credited to whoever created the event, so trainers should book with their own Google account. A trainer can have more than one booking account (e.g. a partner who books for them).
- Rent per trainer per month: studio default or per-trainer deal (per session, flat monthly, or none). Statements go out as text or email; payments are logged by hand.
- Room usage: average spots in use per hour against capacity, busiest slots and quiet prime time.
- Invites: the owner sends a link (`/?join=CODE`). The trainer signs in to Trainer Tally, is linked to their row, and sees the same statement under Billing. Links are created only by `/api/studio/join`; row-level security lets a linked trainer read only their own row.

## Moving a trainer from claude.ai to hosted
In the claude.ai version: Settings → **Download backup (.json)**.
In the hosted version, after sign-in: first setup screen → **Restore from a backup** (or Settings → Restore a backup).

## Local development
```
npm install
npx vercel link        # once
npx vercel env pull .env.local
npm run dev            # app + /api on http://localhost:3000
```

## Background sync and automatic emails

- `supabase/automation.sql` adds synced events (`calendar_events`), the email outbox, client links, and an hourly job.
- Every hour, Supabase calls `/api/cron/hourly`. For each trainer it re-syncs the calendar (35 days back to 70 ahead; full history the first time) and queues anything due, in the trainer's time zone:
  - **Weekly summary** – Saturday from 8pm.
  - **Monthly reconciliation** – 2 days before the month ends, from 8am.
  - **Renewal reminders** – to clients whose package hit the renewal flag, 9am–7pm. Mode per trainer: off, "draft for my OK" (default) or automatic. Per-client opt-out.
- Emails go out through Resend once `RESEND_API_KEY` and `MAIL_FROM` are set. Until then they wait in the app under Settings → Automatic messages.
- **Client pages**: `/s/<token>` shows a client their sessions left and upcoming dates (no prices). Created and turned off from the client sheet.
