# Deployment

What it takes to put Red Or Nude — site **and** admin panel — on the internet.

Target stack: **Vercel** (app) + **Supabase** (Postgres + Storage). Anything that
runs Node 20+ works; the Supabase-specific parts are the connection string and
the storage bucket.

---

## 0. Read this first

The app is functionally complete for **taking bookings**, but two things are not
finished, and both matter before real customers touch it:

1. **No money is collected.** The payment screens are UI only — there is no
   gateway. `POST /api/bookings` creates a confirmed booking and
   `POST /api/gift-cards` issues a real redeemable code, both without charging
   anyone. Deploying today means a customer can book, and gift cards can be
   issued, for free.
2. **Nothing is sent to the customer.** The success screen says details will be
   sent to their phone. No SMS, WhatsApp or email is wired up. The booking
   reference exists only on that screen and in the admin.

Either deploy as an **internal/staff tool plus a preview of the public site**, or
finish payments and messaging first. See §8.

---

## 1. Supabase project

Create a project at supabase.com (region: **Frankfurt or Bahrain** — closest to
Riyadh; latency to the DB is on every page render).

### 1a. Connection strings

Project Settings → Database → Connection string. You need **both**:

| Use | Port | Where |
|---|---|---|
| The app at runtime | **6543** (transaction pooler) | `DATABASE_URL` on Vercel |
| Migrations & seed | **5432** (session pooler / direct) | your terminal only |

`lib/db/index.ts` detects port 6543 / `pgbouncer` in the URL and disables
prepared statements automatically — the pooler cannot use them. Do not "fix"
that by switching the app to 5432; a serverless app on a direct connection will
exhaust the connection limit.

### 1b. Storage bucket

Storage → New bucket:

- Name: **`media`** (or set `SUPABASE_STORAGE_BUCKET` to whatever you name it)
- **Public: on** — `mediaUrl()` builds
  `.../storage/v1/object/public/<bucket>/<key>`, so a private bucket renders
  broken images everywhere.

Uploads use the **service role key**, which bypasses row-level security. That key
is server-only and must never be exposed to the browser — it is read in
`lib/storage/index.ts` inside a `"use server"` boundary, never in a client
component. Do not prefix it with `NEXT_PUBLIC_`.

---

## 2. Environment variables

Set these in Vercel → Project → Settings → Environment Variables (Production, and
Preview if you want previews to work).

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | **yes** | Supabase pooled URI, port **6543** |
| `AUTH_SECRET` | **yes** | `openssl rand -base64 32` — **generate a fresh one** |
| `AUTH_URL` | **yes** | `https://your-domain.com` (no trailing slash) |
| `SUPABASE_URL` | for uploads | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | for uploads | Settings → API → `service_role` |
| `SUPABASE_STORAGE_BUCKET` | no | defaults to `media` |
| `SEED_OWNER_EMAIL` | seed only | first owner login |
| `SEED_OWNER_PASSWORD` | seed only | 8+ chars, **not** the dev one |
| `FIGMA_TOKEN` | no | only for `scripts/fetch-assets.mjs` |

Without the two `SUPABASE_*` keys the app still runs — it silently falls back to
writing uploads to `/public/uploads` on local disk, which on Vercel vanishes on
every deploy and is not shared between instances. The Media screen shows an
amber banner when that fallback is active. **Set the keys.**

The `AUTH_SECRET` and owner password used in local development were generated for
convenience and are in `.env.local`. Do not carry either into production.

---

## 3. Create the schema

Migrations do **not** run automatically on deploy, on purpose — a build step that
can alter production data is a bad default. Run them from your machine against
the production database, using the **5432** URL:

```bash
DATABASE_URL="postgresql://postgres:...@...:5432/postgres" npm run db:migrate
```

Environment variables take precedence over `.env.local`, so this targets
production without editing any files.

Then seed once — this creates the first owner account and imports the catalogue,
branches, opening hours, chairs, gift-card options and all 122 bilingual copy
keys:

```bash
DATABASE_URL="postgresql://...:5432/postgres" \
SEED_OWNER_EMAIL="you@salon.com" \
SEED_OWNER_PASSWORD="a-real-password" \
npm run db:seed
```

The seed is safe to re-run: it skips catalogue and branch data once branches
exist, and upserts settings, content and the owner account.

For later schema changes: `npm run db:generate` locally (commits a SQL file under
`drizzle/`), then `db:migrate` against production. Never use `db:push` on a
production database — it diffs and applies without a reviewable migration file.

---

## 4. Deploy the app

```bash
git push        # connect the repo in Vercel, or:
npx vercel --prod
```

No `next.config.mjs` changes are needed. The app uses plain `<img>` for
media rather than `next/image`, so there are no `remotePatterns` to configure.

Framework preset: Next.js. Build command `npm run build`. Node 20 or 22.

---

## 5. First run checklist

1. Visit `https://your-domain.com/admin/login` and sign in as the seeded owner.
2. **Change that password immediately** (Staff → your account).
3. Availability → confirm opening hours and chair count per branch. The seed
   guesses 9:00–23:00 daily and 4 chairs, taken from the copy on the site.
4. Catalog → fill in the **Arabic service names**. The seed copied English into
   the Arabic column because `lib/booking.ts` only ever had English; rows in that
   state show an amber badge.
5. Media → upload a real image for anything still using the placeholder art.
6. Book a test appointment on the public site, confirm it appears in
   Admin → Bookings, then cancel it.
7. Create real staff accounts and delete any you don't need.

---

## 6. Before real customers

Ordered by how much damage skipping them causes.

- **Payment gateway.** Moyasar or Tap — both cover mada, STC Pay and Apple Pay,
  which the UI already advertises. Until this exists, bookings and gift cards are
  free.
- **Rate limiting on `/api/bookings` and `/api/gift-cards`.** They are public,
  unauthenticated and write to the database. Nothing currently stops a script
  filling every chair for the next month or minting gift cards. Vercel Firewall
  rate limits, or a per-IP/per-phone check, before launch.
- **Booking confirmations.** Unifonic for SMS/WhatsApp in KSA. The success screen
  already promises this.
- **ZATCA e-invoicing.** A legal obligation for B2C in Saudi Arabia. Confirm the
  requirement for this business before you take the first riyal.
- **Backups.** Supabase's free tier retains very little. Enable point-in-time
  recovery, or schedule `pg_dump`. This database is the salon's appointment book.
- **A custom domain + HTTPS** (Vercel handles the certificate) and `AUTH_URL`
  updated to match, or sign-in redirects will point at the wrong host.

---

## 7. Costs, roughly

| | Free tier | When you'll outgrow it |
|---|---|---|
| Vercel Hobby | $0 | Commercial use requires **Pro, $20/mo** |
| Supabase Free | $0 | 500 MB DB, 1 GB storage, **pauses after 7 days idle** |
| Supabase Pro | $25/mo | No pausing, daily backups, 8 GB DB |

The pausing is the real constraint: a free Supabase project goes to sleep and the
first request after that fails. For a live salon, budget **~$45/month** for
Vercel Pro + Supabase Pro.

---

## 8. Deploying as staff-only first

A reasonable middle path, given payments are unfinished: put the whole thing up,
use the admin for real, and keep the public booking flow off.

The simplest lever is to have `/booking` and `/gift-card` return 404 in
production while `/admin` stays live — e.g. a `notFound()` guard behind an env
flag in those two server pages. The salon gets a working appointment book with
walk-in entry today, and the public flow switches on when payments land.
