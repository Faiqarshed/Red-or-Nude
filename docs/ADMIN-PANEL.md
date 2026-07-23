# Red Or Nude — Admin Panel Plan

Design document for the operations + content backoffice. Everything the salon runs
on is managed from a single panel at `/admin`.

**Approach chosen:** custom admin inside this Next.js app (not a headless CMS).
Rationale in [§1](#1-why-custom).

---

## 0. Where we're starting from

The site today is a static frontend — `next`, `react`, `react-dom` and nothing
else. No database, no API route, no auth, no persistence. Every value the site
displays is a TypeScript literal:

| Data | Current home | Becomes |
|---|---|---|
| 4 services + prices | `lib/booking.ts:16` | `services` table |
| 5 add-ons | `lib/booking.ts:24` | `addons` table |
| Removal price `20` | `lib/booking.ts:33` | `removal_types` table |
| 12 seasonal designs (fake — 6 images cycled) | `lib/booking.ts:45` | `designs` + media |
| Calendar pinned to June 2026, 10:00–17:30 / 30 min | `lib/booking.ts:53-83` | `branch_hours` + availability engine |
| 2 branches, addresses, hours | `lib/dictionary.ts:29` | `branches` table |
| Gift card values + 4 designs | `app/gift-card/page.tsx:11` | `gift_card_designs`, `gift_cards` |
| All AR + EN copy (363 lines) | `lib/dictionary.ts` | `content_blocks` (localized JSON) |
| Eid offers | baked images, Arabic burned in | `offers` with per-locale image |
| A booking | `sessionStorage` — lost on tab close | `bookings` table |
| Payment | form that posts nowhere | `payments` + real gateway |
| Newsletter signup | discards the email | `subscribers` table |

So the work is **two projects in one**: build the backend the site never had, and
build the panel that drives it. The backend is the larger half. Plan accordingly.

---

## 1. Why custom

Three approaches were weighed.

**Headless CMS (Sanity / Strapi).** Fastest path for `dictionary.ts`, and
localization ships built in. But the core of a nail salon is *appointments* —
a per-branch day calendar, chair capacity, reschedules, no-shows. That is not
CMS-shaped. We'd build a second custom app anyway and staff would hold two
logins. Fails the "everything in one panel" requirement.

**Payload CMS 3.** Runs inside this Next.js app, Postgres-backed, first-class
AR/EN localization, generates its own admin UI — schemas instead of screens.
Genuinely fast. But the ops screens (drag-to-reschedule, walk-in check-in,
live chair utilization) fight the framework, and the admin chrome is Payload's.

**Custom `/admin` in this app — chosen.** One codebase, one deploy, one login.
Full control of the calendar UX, which is the part staff touch a hundred times a
day. And the RTL discipline the site already uses (`text-start`, `ps/pe`,
`start-0`) transfers directly — this matters because the staff read Arabic and
almost every off-the-shelf admin template is LTR-only.

Cost of the choice: we write the CRUD screens ourselves. Mitigated by generating
list/detail screens from a shared schema-driven table + form pattern (§6).

---

## 2. Stack

| Concern | Choice | Note |
|---|---|---|
| Database | Postgres via **Supabase** | Storage + Auth in the same product |
| ORM | **Drizzle** | SQL-first, typed, good migration story |
| Auth | **Auth.js** (credentials + magic link) | Staff only; RBAC in §7 |
| Mutations | **Server Actions** + `zod` | No REST layer to maintain for admin |
| Public API | Route handlers under `app/api/` | Booking/gift-card writes from the site |
| Tables | **TanStack Table** | Sorting, filtering, pagination, column visibility |
| Forms | **react-hook-form** + `zod` resolver | Shared schemas with server validation |
| Components | **shadcn/ui** | Owned source, restyled to brand, RTL-patchable |
| Charts | **Recharts** | Dashboard only |
| Media | Supabase Storage | Replaces the `/public/*.webp` workflow |
| Payments | **Moyasar** or **Tap** | Both cover mada + STC Pay + Apple Pay (KSA) |
| Messaging | **Unifonic** | WhatsApp/SMS appointment reminders |

Keep the site's existing Tailwind tokens (`cream`, `red`, `ink`, `sky`) — the
admin extends `tailwind.config.ts`, it does not fork it.

---

## 3. Data model

Written as Drizzle-flavoured sketches. `localized` = `jsonb` shaped
`{ ar: string, en: string }`, mirroring the `Content` type in `lib/dictionary.ts`
so the existing type-checking discipline (EN checked against AR's shape) carries
over.

### Identity & access

```
staff            id, name, email, phone, role, branch_id?, active, created_at
                 role ∈ owner | manager | receptionist | technician
sessions         (Auth.js standard)
audit_log        id, actor_id, action, entity, entity_id, diff jsonb, created_at
```

`audit_log` is not optional. Prices and bookings are money; every mutation
writes a row.

### Locations & capacity

```
branches         id, name localized, address localized, hours_note localized,
                 phone, lat, lng, map_image, sort, active
branch_hours     id, branch_id, weekday 0-6, opens time, closes time, closed bool
stations         id, branch_id, label, active          -- chairs; drives capacity
closures         id, branch_id?, starts_at, ends_at, reason localized
                 -- Eid, Ramadan hours, maintenance
```

`branch_hours` + `stations` + `closures` replace the hardcoded
`CAL_YEAR/CAL_MONTH/TIME_SLOTS` constants entirely. Slot generation moves
server-side (§5).

### Catalog

```
services         id, name localized, description localized, price_sar numeric,
                 duration_min int, image, sort, active
                 -- duration_min is new: the UI currently shows a flat "15 MIN"
addons           id, name localized, price_sar, image, is_seasonal bool, sort, active
removal_types    id, name localized, price_sar, sort, active
design_collections id, name localized, active_from, active_to, active
designs          id, collection_id, name localized, image, sort, active
service_addons   service_id, addon_id           -- which add-ons apply where
```

### Customers & bookings

```
customers        id, phone unique, name, email, lang ∈ ar|en, notes,
                 blocked bool, created_at
bookings         id, code, branch_id, customer_id, station_id?, technician_id?,
                 service_id, removal_type_id?, design_id?,
                 starts_at timestamptz, ends_at timestamptz,
                 status, subtotal, vat, total, source, notes, created_at
                 status ∈ pending | confirmed | in_progress | completed
                          | cancelled | no_show
                 source ∈ web | walk_in | phone
booking_addons   booking_id, addon_id, price_sar   -- price snapshotted at booking
```

Prices are **snapshotted onto the booking**, never joined live. Raising a service
price must not rewrite last month's revenue.

### Commerce

```
payments         id, booking_id?, gift_card_id?, provider, provider_ref,
                 method ∈ card|mada|stc|apple, amount, status, raw jsonb, created_at
refunds          id, payment_id, amount, reason, actor_id, created_at
gift_card_designs id, name localized, image, sort, active
gift_card_values id, amount_sar, sort, active        -- the 600/500/…/150 list
gift_cards       id, code, design_id, initial_amount, balance,
                 buyer_name, buyer_email, recipient_name, recipient_email,
                 message, status, expires_at, created_at
gift_card_txns   id, gift_card_id, booking_id?, delta, created_at
promo_codes      id, code, type ∈ percent|fixed, value, min_total,
                 starts_at, ends_at, max_uses, uses, active
```

### Content

```
content_blocks   id, key, value jsonb localized, updated_by, updated_at
                 -- key mirrors dictionary paths: "footer.aboutTitle", "hero.cards"
offers           id, title localized, image_ar, image_en, href, starts_at,
                 ends_at, sort, active
faqs             id, question localized, answer localized, sort, active
pages            id, slug, title localized, body localized, published
                 -- terms, privacy, careers
subscribers      id, email, first_name, last_name, lang, created_at, unsubscribed_at
media            id, path, alt localized, width, height, bytes, uploaded_by
settings         key, value jsonb   -- VAT rate, currency, timezone, slot length
```

`offers` carries **two images**. This closes the known gap in `docs/SCREENS.md`:
the carousel is currently baked artwork with عروض عيد الأضحى burned in, so the
English site shows Arabic.

---

## 4. Modules

Twelve sections in the sidebar.

**1 · Dashboard** — today's appointments by branch, chair utilization %, revenue
vs. last week, top services, upcoming bookings with no-show risk (customers with
prior no-shows), pending payments.

**2 · Bookings** — the module staff live in.
- Day and week calendar, per branch, columns = stations
- Drag to reschedule, resize to extend, click for a detail drawer
- List view with filters: status, branch, technician, date range, phone search
- Create walk-in in ≤3 clicks; mark completed / no-show; cancel with reason
- Detail drawer shows the full snapshot: service, add-ons, removal, design,
  technician, payment status, customer history

**3 · Availability** — branch hours per weekday, slot length, station count,
closures/blackouts, holiday hours. Preview pane renders the next 14 days of
generated slots so a manager can *see* the effect before saving.

**4 · Catalog** — services, add-ons, removal types. AR/EN name + description,
price, duration, image, active toggle, drag to reorder. Reordering is what
controls the public grid — no code deploy to promote a service.

**5 · Designs** — seasonal collections with date windows and a real image grid,
replacing the 12 placeholder entries.

**6 · Gift cards** — two tabs: *setup* (denominations, card designs) and
*issued* (code, balance, buyer/recipient, redemption ledger, manual adjust,
resend email).

**7 · Customers** — phone-keyed profiles, booking history, lifetime value,
internal notes, block toggle for repeat no-shows.

**8 · Staff** — technicians and their shifts, assignment to bookings, roles.

**9 · Branches** — the two Riyadh locations: name, address, hours, phone, map
pin, active.

**10 · Content** — `dictionary.ts` promoted to the DB, edited as **side-by-side
AR/EN fields** with a "copy from Arabic" affordance and a missing-translation
badge. Covers nav, hero cards, marquee, section headings, footer, FAQ, and the
long-form pages (terms, privacy).

**11 · Marketing** — offers/carousel with scheduling windows, promo codes,
newsletter subscribers with CSV export, reminder templates (AR/EN) for
WhatsApp/SMS.

**12 · Settings** — SAR + 15% VAT, `Asia/Riyadh` timezone, default slot length,
payment gateway keys, roles, audit log viewer. ZATCA e-invoicing is a known
KSA obligation — flagged here, scoped separately.

---

## 5. Availability engine

The one piece of real domain logic. Everything else is CRUD.

```
slotsFor(branchId, date) =
    branch_hours[weekday(date)]
  − closures overlapping date
  × stations (active)
  − bookings occupying that station/time
  → slots of settings.slot_length, filtered to now + lead_time
```

Lives in `lib/availability.ts`, called by both the public booking API and the
admin calendar so the two can never disagree. It replaces `CAL_LEAD_BLANKS`,
`CAL_FIRST_BOOKABLE`, `TIME_SLOTS` and the June-2026 pin in `lib/booking.ts`.

Booking creation runs in a transaction with a uniqueness constraint on
`(station_id, starts_at)` — two customers hitting confirm at the same second
must not both get the chair.

---

## 6. UI direction

**Layout.** Fixed sidebar (collapsible to icons), sticky topbar with branch
switcher + global search + user menu. Content max-width `1440px`. Editing happens
in **side drawers**, not full-page navigations — a receptionist mid-checkout
never loses their place in the list.

**Bilingual, both ways.** The admin itself toggles AR/EN and flips `dir`, reusing
the existing `LanguageProvider` pattern from `lib/i18n.tsx`. Every layout
utility must be logical (`ps/pe`, `start/end`, `text-start`) — the same rule the
public site already follows. shadcn components get audited for hardcoded
`left/right` on adoption.

**Colour.** Restrained. `cream #F1ECE3` page ground, white cards, `ink #181717`
text. `red #B80007` reserved for primary actions and destructive confirms only —
dense tables need neutral ground, and a red-saturated admin is unreadable after
an hour. `sky #69A7C4` for informational states. Status colours are their own
semantic scale (confirmed / in-progress / completed / cancelled / no-show), not
brand colours.

**Type.** DG Agnadeen stays for headings; body and all tabular data use a UI face
with proper tabular numerals — prices and times must align in columns.

**Interaction.**
- ⌘K command palette — "find booking by phone" is the #1 daily task
- Optimistic updates on status changes; toast with undo rather than a confirm
  dialog for reversible actions
- Confirm dialogs only for destructive + irreversible (refund, delete)
- Every list has: sticky filter bar, saved views, CSV export, empty state that
  explains what belongs there
- Keyboard-first calendar: arrow keys move, `n` creates, `esc` closes

**Density.** Two modes — comfortable for content editing, compact for the
bookings list. Persisted per user.

---

## 7. Roles

| | Owner | Manager | Receptionist | Technician |
|---|---|---|---|---|
| Dashboard + revenue | ✅ | branch only | ❌ | ❌ |
| Bookings CRUD | ✅ | ✅ | ✅ | own, status only |
| Availability | ✅ | ✅ | ❌ | ❌ |
| Catalog + prices | ✅ | ❌ | ❌ | ❌ |
| Gift cards issue/adjust | ✅ | ✅ | issue only | ❌ |
| Customers | ✅ | ✅ | ✅ | ❌ |
| Staff | ✅ | ✅ | ❌ | ❌ |
| Content / Marketing | ✅ | ✅ | ❌ | ❌ |
| Settings + audit log | ✅ | ❌ | ❌ | ❌ |

Enforced in the Server Action layer, not only in the UI. The sidebar hides what a
role can't reach, but the check that matters is server-side.

---

## 8. Build order

**P0 — Foundation. ✅ shipped.** Drizzle schema + migration (29 tables), Auth.js
credentials login, the §7 capability matrix enforced server-side, admin shell
(sidebar, topbar, RTL toggle, collapse), audit log viewer, and a re-runnable seed
that imports today's hardcoded data — 2 branches with hours and stations, 4
services, 5 add-ons, 3 removal types, 12 designs, 6 gift-card values, 4 card
designs, and 122 bilingual copy keys. Verified end to end against a live
Postgres: anonymous → login redirect, wrong password rejected, owner and
receptionist sessions differ in both nav and data, and a receptionist hitting
`/admin/audit` is turned away by the server, not just by a hidden link.

Deviations from this document, both deliberate:
- **Money is integer halalas**, not `numeric`. Postgres numeric is exact but
  Drizzle returns it as a string, so every call site would parse before doing
  arithmetic. Minor units keep the maths in plain JS numbers. See `lib/money.ts`.
- **`next` upgraded 14.2.5 → 14.2.35.** The pinned version carried
  CVE-2025-29927, a middleware authorization bypass — directly load-bearing once
  staff auth sits behind middleware.

Also new in P0 and worth knowing: `services.duration_min`. The static site shows
a flat "15 MIN" on every card, which can't hold across Acrylic and a Classic
Manicure. The seed sets realistic starting values; the availability engine
depends on them.

**P1 — Bookings & availability. ✅ shipped.** The availability engine
(`lib/availability.ts`), a day calendar with one column per chair, list view,
booking drawer with status transitions, walk-in creation, and an Availability
screen for opening hours, chairs and closures. The public `/booking` flow now
writes real bookings through `POST /api/bookings` instead of `sessionStorage`,
and its calendar reads `/api/availability` instead of a fixed June-2026 grid.

Verified against a live database: slots for a 90-minute service run 09:00–21:30
against 23:00 closing (the appointment must *finish* before close); four
concurrent bookings fill the four chairs and the fifth returns 409; overlapping
slots go unavailable and free up again after the last booking ends; VAT is split
out of the inclusive total so subtotal + VAT equals what the customer was shown.

Gaps added along the way, both of which the static site never had:
- **A branch selector on `/booking`.** A booking has to belong to a branch, and
  the page never asked which one.
- **Customer name and mobile at payment.** An appointment needs someone to
  belong to; `POST /api/bookings` validates Saudi mobile format.

Not yet built here: drag-to-reschedule (the `rescheduleBooking` action exists and
is audited, but the calendar doesn't yet drive it), technician assignment, and
the ⌘K "find booking by phone" palette.

**P2 — Catalog + Media. ✅ shipped (designs still pending).** Media library with
uploads behind a storage driver, and full CRUD for services, add-ons and removal
types — bilingual names, price, duration, image, active toggle, reordering,
delete. Critically, the **public booking page now reads these tables**: `/booking`
is a server component calling `getPublicCatalog()`, so a price or image changed
in `/admin/catalog` changes the live site with no deploy. Verified end to end
(edit → page reflects it).

Notes from the build:
- **Storage is driver-based.** `lib/storage` picks Supabase when `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` are set, and falls back to `/public/uploads`
  otherwise so the panel is usable before that project exists. The local driver
  does not survive a serverless deploy, and the Media screen says so on-screen.
- **Existing assets are registered, not migrated.** The seed inserts the 39
  images already committed under `/public` as media rows whose paths keep their
  leading slash; `mediaUrl()` passes those through untouched. Old and new art
  coexist in one picker.
- **Removal is priced per type.** The site had one flat `REMOVAL_PRICE = 20`;
  Gel, BIAB and Builder Gel can now be priced separately.
- Services and removal types referenced by a booking cannot be deleted (FK
  restrict) — deleting one would erase what a customer actually bought. The
  drawer catches that and tells the user to deactivate instead.

Still open in P2: the **Designs** module (seasonal collections). The public
designs pop-up already reads from the DB; only its admin screen is missing.

**P3 — Content.** `content_blocks`, side-by-side AR/EN editor, FAQ, pages,
offers with per-locale images. `lib/dictionary.ts` becomes a build-time cache /
fallback rather than the source of truth.

**P4 — Commerce. ◐ partly shipped.** Gift cards are done: issuance with a
ledger-backed balance, admin setup for denominations and card designs, a public
purchase flow at `/gift-card` that issues a real redeemable code, and a card
drawer with the transaction history and manual adjustment. Still open here:
Moyasar/Tap integration, payments + refunds, promo codes, and redeeming a gift
card against a booking (the ledger supports it; nothing calls it yet).

The balance column is a cached running total and every change writes a
`gift_card_txns` row in the same transaction, with the row locked `for update`
so two concurrent redemptions can't both read the same balance. Verified: a
redemption reduces the balance, an overdraw is refused, redeeming the exact
remainder flips the card to `redeemed`, and the balance column equals the ledger
sum throughout.

**Customers and Staff. ✅ shipped** (out of the original phase order, alongside
gift cards). Customers: phone-keyed profiles with booking counts, lifetime value
and no-show tallies computed from the bookings table rather than denormalised,
plus search, internal notes and a block toggle. The phone field is read-only in
the drawer — it is the identity key, and editing it would silently split a
customer's history.

Staff: accounts, roles, branch scoping, activation and password set. The guards
matter more than the screens, and all of them are enforced server-side:
- no one may grant a role above their own, or edit an account senior to theirs;
- the last active owner cannot be deactivated, demoted or deleted;
- you cannot deactivate or delete yourself out of the panel;
- password hashes are never returned to the client and never written to the
  audit diff.

**P5 — Growth.** Dashboard analytics, subscribers, WhatsApp/SMS reminders,
saved views, exports.

Each phase is independently shippable. After P2 the site no longer requires a
code deploy to change what customers see — that's the milestone worth aiming at.

---

## 9. Decisions still open

1. **Hosting** — Vercel + Supabase, or self-hosted? Affects cron (reminders) and
   file storage.
2. **Payment provider** — Moyasar vs. Tap. Both cover mada/STC/Apple Pay;
   differ on fees, settlement time, and dashboard quality.
3. **ZATCA e-invoicing** — required for KSA B2C. Phase 2 integration is a
   project of its own; confirm the obligation date before P4.
4. **Technician assignment** — do customers pick a technician at booking time, or
   does the salon assign after? Changes the availability engine's shape.
5. **Existing data** — is there a current booking system to migrate customers
   from, or do we start empty?
6. **Arabic service names** — surfaced while writing the seed: service and add-on
   names exist only in English in `lib/booking.ts` ("Acrylic", "BIAB", "Chrome"),
   and the same English string renders on the Arabic site. The seed copies it
   into both locales so nothing breaks, but the Arabic column needs filling in
   Catalog. Some of these may be intentional brand terms — the salon should
   decide which get translated.
