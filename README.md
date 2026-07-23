# Red Or Nude — Frontend

Frontend replica of the **Red Or Nude** Figma design, built with **Next.js (App Router)** + **Tailwind CSS**, RTL Arabic. Layout, colors, sizes, and text are taken directly from the Figma file via the Figma design API.

## Run

```bash
npm install
npm run dev            # http://localhost:3000
```

## Real assets (images)

Images render from `/public` with the exact filenames the app expects. To pull the
real images straight from Figma, run the fetch script with your Figma token
(the token stays on your machine — it is only read from the environment):

```bash
FIGMA_TOKEN=your_token node scripts/fetch-assets.mjs
```

Get a token at Figma → Settings → Security → Personal access tokens. Until the
assets are present, every image degrades gracefully (colored placeholder / gradient).

Expected files: `hero-hands.png`, `map-riyadh.png`, `eid-offers.png`,
`service-1.png … service-4.png`.

## Fonts

The Figma fonts are **DG Agnadeen** (display) and **Lama Sans** (body) — licensed
fonts, not on Google Fonts. Drop the `.woff2` files into `/public/fonts` (see the
`@font-face` names in `app/globals.css`) and they load automatically. Without them,
the app falls back to **Cairo**.

## Design tokens (read from Figma)

- Background: `#FFFAF0` (cream)
- Brand red: `#B80007` → `#520003` (gradient)
- Text: `#181717`
- Blue accent: `#69A7C4`
- Card radius: `36px`

## Deploying

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Supabase setup, environment
variables, migrations, and what still has to be finished before real customers
(payments and confirmations are not wired up).

## Admin panel

Staff backoffice at `/admin`, built inside this app. Full design in
[`docs/ADMIN-PANEL.md`](docs/ADMIN-PANEL.md); phase 0 (database, auth, shell,
audit trail, seed) is in place.

### Setup

```bash
cp .env.example .env.local     # fill in DATABASE_URL + AUTH_SECRET
openssl rand -base64 32        # → AUTH_SECRET

npm run db:generate            # SQL migration from lib/db/schema.ts
npm run db:migrate             # apply it
npm run db:seed                # import everything the static site hardcodes
npm run dev                    # → http://localhost:3000/admin
```

`db:seed` creates the first owner account from `SEED_OWNER_EMAIL` /
`SEED_OWNER_PASSWORD` and copies the current services, add-ons, removal types,
branches, gift-card options and all 122 bilingual copy keys into the database. It
is safe to re-run.

Other scripts: `npm run db:push` (prototype without a migration file),
`npm run db:studio` (browse the data).

### Notes

- Money is stored as **integer halalas** (1 SAR = 100). Format with `formatSAR`
  in `lib/money.ts`.
- Roles are `owner | manager | receptionist | technician`; the capability matrix
  lives in `lib/auth/rbac.ts` and is enforced server-side via `lib/auth/guard.ts`.
  Middleware only redirects anonymous visitors — it is not the access boundary.
- The panel is bilingual and flips `dir` like the public site. Use logical
  utilities (`ps/pe`, `start/end`, `text-start`) in every admin component.
- **Uploads** go to Supabase Storage when `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` are set, and to `/public/uploads` otherwise. The
  local fallback is for development only — it does not survive a serverless
  deploy, and the Media screen warns when it is active.
- A `"use server"` module may only export async functions. Shared constants and
  types belong in a plain module (see `lib/media.ts`), or they arrive in the
  client as unusable server references.
- `/booking` is a server component: it calls `getPublicCatalog()` and hands the
  data to `BookingView`. Catalog edits in the admin appear on the site with no
  deploy.
- **Availability** is computed in one place (`lib/availability.ts`) and used by
  both the public calendar and the admin, so they cannot disagree. Timestamps are
  stored UTC; branch hours are local wall-clock (Riyadh is UTC+3, no DST).
- Booking prices are **snapshotted** onto the row at creation. Never join the
  catalogue to display what a past booking cost.
- Gift card balances are a cached total of `gift_card_txns`. Never write
  `balance_halalas` without adding a ledger row in the same transaction — use
  `adjustGiftCardBalance` in `lib/giftcards.ts`.
- Staff writes enforce role hierarchy server-side (no escalation, no orphaning
  the last owner, no self-lockout). The UI mirrors it; the server decides.
- The app has **two root layouts**, so each route group needs its own
  `not-found.tsx` plus a `[...notFound]` catch-all. Without them an unmatched URL
  escapes both groups and falls through to the pages-router document, which this
  build does not emit — every 404 becomes a 500.

## Status

- [x] Foundation (RTL, fonts, palette, Tailwind tokens)
- [x] Screen 1 — Landing page: header, hero, booking cards, marquee, branch map, Eid offers, services, footer
- [ ] Remaining desktop screens
- [ ] Mobile responsive breakpoints
- [x] Admin P0 — schema, auth, RBAC, shell, audit log, seed
- [x] Admin P2 — media library + catalog CRUD, public site reads from the DB
- [x] Admin P1 — availability engine, bookings calendar, walk-ins, real booking writes
- [x] Admin — gift cards (ledger-backed), customers, staff
- [ ] Admin — designs, content, branches, settings, payments gateway

## Structure

```
app/
  (site)/      layout.tsx (RTL + fonts) · page.tsx (landing) · booking · gift-card
  (admin)/     admin shell, login, dashboard, audit log
  globals.css  shared by both halves
components/    SiteHeader · SiteFooter · Marquee · Logo · icons
  sections/    Hero · BranchMap · Offers · Services
  admin/       Shell · Sidebar · Topbar · ui primitives
lib/
  db/          schema.ts · seed.ts · client
  auth/        Auth.js config · rbac · guard
  admin/       admin i18n + strings
scripts/       fetch-assets.mjs   (pull real images from Figma)
```

The site and the admin are separate route groups so each owns its own `<html>`,
and their language providers can't fight over `document.documentElement.dir`.
