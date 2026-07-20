# Screen manifest — Red Or Nude (Figma OPT 1 page, 10:10162)

Node id → route → status. Desktop-2 = 1920×1080 app screens; Desktop = long pages.

## Progress
- ✅ `/` landing (108:4082)
- ✅ `/booking` — **interactive**; reproduces the many booking-state frames
  (439:10744, 209:278, 269:1734, …) via live selection + total. Summary cells
  open pop-ups for removal (264:302) and schedule/date-time (235:758); the
  Seasonal Catalogue add-on opens the التصاميم الموسمية pop-up (439:11053).
  The real selection is persisted (sessionStorage) and carried to payment.
- ✅ `/booking/payment` — payment method + card form (276:1902 / 276:6624) and
  success confirmation modal (276:6765); both render the real booking selection.
- ✅ `/gift-card` (317:7234) — interactive value/design/details.
- ✅ Booking pop-ups: schedule/date picker, removal, seasonal designs.
- ▶ Next distinct screens to build: home variants (75:12219, 180:287, 180:525,
  276:6950), mobile landing (147:4276), tablet "Simplify Booking Page" set.

Booking-flow components live in `components/booking/` (Modal, ScheduleModal,
RemovalModal, DesignsModal); shared data + state in `lib/booking.ts`.

## Internationalization (Arabic ⇄ English)
The whole site is bilingual with an in-place toggle (English / عربي button in the
header). Implementation:
- `lib/i18n.tsx` — `LanguageProvider` (localStorage-persisted, sets `<html dir>`)
  + `useI18n()` hook exposing `{ lang, dir, c, setLang, toggle }`.
- `lib/dictionary.ts` — all copy for both languages (`content.ar` / `content.en`;
  `en` is type-checked against the `ar` shape). English mirrors LTR.
- Components use logical Tailwind utilities (`text-start`, `ps/pe`, `start-0`) so
  layout follows `dir`. Header/footer/BranchMap have small per-lang tweaks where
  the design isn't a pure mirror (logo stays left; branch heading differs).
- Known gap: the Offers carousel (`Offers.tsx`) is baked images with Arabic text
  ("عروض عيد الأضحى"); an English offers image set would be needed for full parity.

## Long desktop pages (1920 wide)
| Node | Size | Route | Status |
|------|------|-------|--------|
| 108:4082 | 1920×5316 | `/` (landing) | ✅ done |
| 75:12219 | 1920×5656 | `/home-alt` | ⬜ |
| 180:287  | 1920×5612 | `/home-v2` | ⬜ |
| 180:525  | 1920×5612 | `/home-v3` | ⬜ |
| 276:6950 | 1920×5316 | `/home-v4` | ⬜ |

## Booking-flow screens (Desktop-2, 1920×1080) — top rows
| Node | x | Route | Status |
|------|---|-------|--------|
| 439:10744 | 4234/-1521 | `/booking` | ✅ done |
| 209:278 | 4234 | `/flow/2` | ⬜ |
| 264:403 | 6194 | `/flow/3` | ⬜ |
| 264:737 | 8154 | `/flow/4` | ⬜ |
| 267:1048 | 10114 | `/flow/5` | ⬜ |
| 267:1394 | 12074 | `/flow/6` | ⬜ |
| 269:1734 | 14034 | `/flow/7` | ⬜ |
| 269:2036 | 15994 | `/flow/8` | ⬜ |
| 272:1597 | 17954 | `/flow/9` | ⬜ |
| 276:1902 | 19914 | `/flow/10` | ⬜ |
| 276:6624 | 21874 | `/flow/11` | ⬜ |
| 276:6765 | 23834 | `/flow/12` | ⬜ |
| 317:7234 | 4234 (r2) | `/flow/13` | ⬜ |
| 325:7705 | 6194 (r2) | `/flow/14` | ⬜ |
| 325:8088 | 8154 (r2) | `/flow/15` | ⬜ |
| 276:7187 | 4234 (r3) | `/flow/16` | ⬜ |
| 284:2037 | 6194 (r3) | `/flow/17` | ⬜ |
| 284:2345 | 8154 (r3) | `/flow/18` | ⬜ |
| 284:2656 | 10114 (r3) | `/flow/19` | ⬜ |
| 284:3047 | 12074 (r3) | `/flow/20` | ⬜ |
| 288:2766 | 14034 (r3) | `/flow/21` | ⬜ |
| 288:3147 | 15994 (r3) | `/flow/22` | ⬜ |
| 288:3452 | 17954 (r3) | `/flow/23` | ⬜ |
| 288:3757 | 19914 (r3) | `/flow/24` | ⬜ |
| 317:6837 | 21874 (r3) | `/flow/25` | ⬜ |
| 317:7004 | 23834 (r3) | `/flow/26` | ⬜ |
| 336:12782 | 4234 (r4) | `/flow/27` | ⬜ |
| 336:13019 | 6194 (r4) | `/flow/28` | ⬜ |
| 336:13093 | 8154 (r4) | `/flow/29` | ⬜ |
| 433:9679 | 4404 | `/flow/30` | ⬜ |

## Mobile / tablet
| Node | Size | Route | Status |
|------|------|-------|--------|
| 147:4276 | 430×4715 | mobile landing (responsive of `/`) | ⬜ |
| 235:678 / 234:425 / 236:996 / 236:1231 / 236:1102 / 241:2061 / 234:179 / 345:13820 / 345:13565 / 284:6785 | 1180 wide | "Simplify Booking Page" tablet screens | ⬜ |

## Overlays
| Node | Size | Note | Status |
|------|------|------|--------|
| 439:11053 | 962×847 | POP UP modal | ⬜ |
