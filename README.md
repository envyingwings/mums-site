# Booking Site Setup

Single-calendar appointment booking, static frontend (GitHub Pages) + Supabase backend.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → New Project (free tier is fine).
2. Once it's created, go to **SQL Editor** → New query, paste in the entire contents of `schema.sql`, and run it.
   - Edit the seed data at the bottom of `schema.sql` first (your working hours and services) — or run it as-is and edit later from the admin panel/table editor.
3. Go to **Settings → API**. Copy the **Project URL** and the **anon public** key.

## 2. Create your admin login

1. In Supabase: **Authentication → Users → Add user**.
2. Enter your own email and a password. This is what you'll use to log into `/admin.html`.
3. Leave "Auto Confirm User" checked so you don't need to click an email link.

## 3. Configure the site

Open `config.js` and fill in:
- `SUPABASE_URL` — the Project URL from step 1
- `SUPABASE_ANON_KEY` — the anon public key from step 1
- `BUSINESS_TIMEZONE` — your IANA timezone, e.g. `Europe/London`
- `BOOKING_WINDOW_DAYS`, `MIN_NOTICE_HOURS` — tune to taste

The anon key is safe to commit and expose publicly — it can only do what the Row Level Security policies in `schema.sql` allow (read active services/hours, read booking *times* only, and create bookings through the guarded function). It cannot read customer details or write directly to tables.

## 4. Run it locally to test

Any static file server works, e.g.:
```
npx serve .
```
Then open the local URL, make a test booking, and check it appears in **Supabase → Table Editor → bookings**. Then log into `admin.html` with the account from step 2 and confirm you can see and cancel it.

## 5. Deploy to GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo → **Settings → Pages** → Source: deploy from branch → pick `main` and `/ (root)`.
3. Your site will be live at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

Note: `config.js` will be publicly visible in your repo — that's expected and fine (see the note on the anon key above). Just never put your Supabase **service_role** key anywhere in this frontend code; only ever use the anon key here.

## Managing the business day-to-day

- **See/cancel bookings:** `yoursite.com/admin.html`, log in with the account you created.
- **Add/edit services:** easiest via Supabase → Table Editor → `services` table for now. (Could add an admin UI for this later if useful.)
- **Change working hours or add a day off:** Table Editor → `working_hours` / `closed_dates`.
- **Email confirmations:** not wired up yet — see "What's not included" below.

## What's not included yet

- **Email notifications.** Right now "confirmation" is only shown on-screen — no email actually gets sent to the customer or to you. The cleanest free option is a Supabase Edge Function triggered on insert, calling an email API (e.g. Resend has a free tier). I can build this next if you want it.
- **Rescheduling** by the customer (they'd need to cancel — which isn't self-serve either yet — and rebook, or you do it manually from admin).
- **Timezone display for customers** — times shown are always in your business timezone, not auto-detected from the visitor's browser. For a purely local/in-person business this is usually the right behavior; flag it if you serve remote customers across timezones.
- **Payment collection.** No Stripe integration; add if you need deposits.

None of these are hard to add on top of this foundation — happy to build any of them next.
