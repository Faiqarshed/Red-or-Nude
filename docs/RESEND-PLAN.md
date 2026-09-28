# Resend plan

## Context
All mail goes through `sendMail` (`lib/email/index.ts`). About 11 places call it: codes, invoices, gift cards, refunds, owner alerts, review invites, refill reminders. Only `lib/email/smtp.ts` knows the transport: nodemailer over Gmail SMTP. Two problems with that:
- Gmail rewrites `From` to the Gmail mailbox, so mail never comes from the brand;
- Gmail caps sending at about 500 recipients a day.

Goal: send through Resend. Built and tested on **our** Resend account first, then moved to the **client's** account and domain with a settings change only.

Fixed decisions:
- **No new dependency.** Resend's HTTP API is called with `fetch`, the same way `lib/payments/streampay.ts` talks to StreamPay.
- **Callers don't change.** The transport is picked in `lib/email/index.ts`, the seam it was built for.
- **SMTP stays as the fallback** until the client's domain is live and has run for 1–2 weeks.

## Phase 0: our account (10 min)
- Resend account on `humayunbaig046@gmail.com`; an API key with **sending access** only.
- Local `.env`:
  ```
  RESEND_API_KEY=re_...            # our test key, local only
  MAIL_FROM_EMAIL=onboarding@resend.dev
  MAIL_FROM_NAME=Red or Nude
  ```
- **Limit:** with `onboarding@resend.dev`, Resend delivers only to the account's own address. Every test uses `humayunbaig046@gmail.com` as the customer email, gift card recipient and owner-alert address. Anything else is refused.

## Phase 1: code (about 1 day, one PR)
1. **`lib/email/resend.ts`**: the transport. Same contract as `smtp.ts` (`./types.ts`): never throws, and says why it could not send.
   - `from`, `to`, `reply_to`, `subject`, `html`, `text` mapped one to one;
   - `attachments` as base64 (the invoice PDF), with `content_id` for inline images (the wallet plan's gift card email);
   - `tags` as Resend tags, cleaned to letters, digits, `_` and `-`;
   - an `Idempotency-Key` when the caller has a natural key (`receipt:<ref>`), so a retry is not a second email;
   - errors: 4xx → `rejected`, 429 / 5xx / timeout → `failed`;
   - a 10 s timeout: a customer can be waiting on the payment response behind this call.
2. **`lib/email/index.ts`**: `activeTransport()` returns `resend` when `RESEND_API_KEY` is set, else `smtp` when SMTP is configured, else `none`.
3. **Refill-reminder cron** (`/api/cron/refill-reminders`): it mails the whole customer list, and Resend's default limit is about 2 requests a second. Throttle the loop, or use the batch endpoint (up to 100 per call, no attachments).
4. **`scripts/check-mail.ts`**: prints the active transport and sends one test mail.
5. **`.env.example`**: the Resend settings documented beside the SMTP ones.
6. **Tests** (fake Resend server): field mapping, attachments, tags, each error class, timeout, idempotency key.

## Phase 2: test on our account (about 2 hours)
Every email to our inbox, in **Arabic and English**, opened in Gmail and Outlook:

| Email | Check |
|---|---|
| Sign-in / booking code | arrives quickly, code readable |
| Booking invoice | PDF attached and opens |
| Gift card | image shows, code correct |
| Refund notice | amount correct |
| Owner alert | arrives |
| Review invite | link works |
| Refill reminder (cron) | several in a row, all delivered, no rate-limit errors |

For every one: the Arabic subject is not garbled, it lands in the inbox and not spam, and a reply goes to `MAIL_REPLY_TO`.

## Phase 3: the client's domain (under an hour of ours, plus DNS time)
1. Agree the sending address with the client. Suggested: a subdomain, `no-reply@mail.<their-domain>`, so sending reputation stays off their main domain and their existing SPF record is untouched.
2. In the client's Resend account (`hsagri20@gmail.com`): add the domain in the **EU region** (`eu-west-1`, the closest to Saudi). Send the client the DNS records: DKIM, SPF (return path) and DMARC at `p=none`.
3. Once Resend shows the domain **Verified**, production settings:
   ```
   RESEND_API_KEY=<client's key>
   MAIL_FROM_EMAIL=no-reply@mail.<their-domain>
   MAIL_REPLY_TO=<salon's inbox>
   ```
4. Phase 2's table again, to a real customer address (not the account owner's).

## Phase 4: live and clean-up
- Production on Resend. `SMTP_*` stays set for 1–2 weeks; rolling back is removing `RESEND_API_KEY`.
- Then a small PR removes `smtp.ts`, nodemailer and the `SMTP_*` settings.
- Later: Resend's bounce webhook. A bounce is the best sign of a mistyped email, and could feed the wallet's "Needs your decision" page (`docs/WALLET-PLAN.md`).

## Risks
| Risk | Handling |
|---|---|
| The client's DNS takes long | Production stays on SMTP until the domain is verified; the code is ready either way |
| Our test key reaches production | Production only ever gets the client's key; ours lives in local `.env` |
| Rate limit on the reminder cron | Throttle or batch (Phase 1, step 3) |
| A new domain lands in spam | Transactional mail only at first, DMARC at `p=none`, Resend's dashboard watched for the first week |

## Open
1. The client's sending domain, and who manages its DNS (needed for Phase 3 only).
