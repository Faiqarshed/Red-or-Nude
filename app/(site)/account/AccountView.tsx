"use client";

// One screen for signing in, signing up, and everything an account holds.
//
// Sign-in and sign-up are the *same form*, and that is a security decision as
// much as a UX one. Two forms means one says "that email is already registered"
// and the other says "no account found" — and either sentence lets someone walk
// a list of addresses and learn who is a customer of this salon. Here the
// customer types an email, gets a code, and only *after* the code is verified
// does the screen learn whether to ask for a profile. See
// app/api/account/otp/route.ts.

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PhoneField from "@/components/PhoneField";
import BookingCard, { RefillDialog, partyOf } from "@/components/booking/BookingCard";
import { Lock, Riyal } from "@/components/icons";
import OtpInput from "@/components/OtpInput";
import { ACCOUNT_OTP_TTL_MS } from "@/lib/otp-length";
import { useI18n } from "@/lib/i18n";
import Link from "next/link";
import { pick } from "@/lib/localized";
import type { Localized } from "@/lib/localized";
import { formatDateLabel } from "@/lib/booking";
import type { BookingSummary } from "@/lib/booking";
import { toNationalDigits, toStoredPhone, validateSaudiMobile } from "@/lib/phone";
import { REWARDS } from "@/lib/rewards";
import TextInput from "@/components/TextInput";
import {
  birthdayRange,
  checkBirthday,
  checkEmail,
  checkPersonName,
  EMAIL_MAX,
  EMAIL_TEXT,
  PERSON_NAME_MAX,
  PERSON_TEXT,
} from "@/lib/admin/validate";
import { formatDateKey, riyadhDateKey } from "@/lib/time";
import { validationMessages } from "@/lib/validation-messages";

type Customer = {
  name: string | null;
  email: string;
  phone: string;
  birthday: string | null;
};

/** One membership line she can still spend. Serialised, so the date is a string. */
type Credit = {
  customerPackId: string;
  packName: Localized;
  serviceId: string;
  serviceName: Localized | null;
  left: number;
  granted: number;
  expiresAt: string;
};

export default function AccountView({
  customer,
  balance = 0,
  credits = [],
  history = [],
}: {
  customer?: Customer;
  balance?: number;
  credits?: Credit[];
  history?: BookingSummary[];
}) {
  return customer ? (
    <SignedIn customer={customer} balance={balance} credits={credits} history={history} />
  ) : (
    <SignedOut />
  );
}

// ---------------------------------------------------------------- signed in --

/** Bookings shown before "Show all". Three rows of two on a desktop. */
const BOOKINGS_PREVIEW = 6;

/**
 * What she can filter her bookings by, each the question she comes with:
 * what is coming up, what can I refill now, what is behind me. "Refill" reads
 * the server's own `hasRefill`, so the chip can never offer a refill the refill
 * button would not.
 */
const BOOKING_FILTER_TEST = {
  all: () => true,
  upcoming: (r: BookingSummary) => ["pending", "confirmed", "checked_in", "in_progress"].includes(r.status),
  refill: (r: BookingSummary) => r.hasRefill,
  past: (r: BookingSummary) => ["completed", "cancelled", "no_show"].includes(r.status),
};
type BookingFilter = keyof typeof BOOKING_FILTER_TEST;

function SignedIn({
  customer,
  balance,
  credits,
  history,
}: {
  customer: Customer;
  balance: number;
  credits: Credit[];
  history: BookingSummary[];
}) {
  const { c, lang } = useI18n();
  const a = c.account;
  const router = useRouter();

  const [verifying, setVerifying] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BookingFilter>("all");

  const q = query.trim().toLowerCase();
  const shown = history.filter(
    (r) =>
      BOOKING_FILTER_TEST[filter](r) &&
      (!q ||
        [pick(r.serviceName, lang), r.code, r.ticketNo ?? ""].some((s) => s.toLowerCase().includes(q))),
  );

  // Whether a booking can still be cancelled was decided when this page
  // rendered, so a tab left open all afternoon keeps offering a button whose
  // deadline has passed — and the customer only finds out by pressing it. Re-read
  // while she is actually looking: on the minute, and the moment she comes back
  // to the tab, which is when a page has usually gone stalest.
  useEffect(() => {
    const reread = () => document.visibilityState === "visible" && router.refresh();
    const id = setInterval(reread, 60_000);
    document.addEventListener("visibilitychange", reread);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [router]);

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/account/signout", { method: "POST" });
      // A full document navigation, not router.push/refresh. The header's
      // signed-in state comes from the *layout*, and Next's client router cache
      // keeps layout segments across a soft navigation — so a refresh can leave
      // a signed-out page wearing a signed-in header. Signing in and out happens
      // rarely enough that one real page load is the cheap, correct answer.
      window.location.assign("/");
    } catch {
      setSigningOut(false);
    }
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-page px-6 pb-20 pt-[120px] md:px-12 lg:px-16">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="text-start">
            <h1 className="font-display text-3xl font-extrabold text-ink">
              {customer.name || a.title}
            </h1>
            <p className="mt-1 text-sm text-ink/55" dir="ltr">
              {customer.email}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
            className="rounded-[12px] border border-black/[0.08] px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:border-red/40 disabled:opacity-40"
          >
            {a.signOut}
          </button>
        </div>

        {/* Two columns from lg: the bookings, which grow without limit, get the
            width; the wallet, memberships and details, which do not, sit beside
            them. One 760px column left the sides of a desktop empty and stacked
            every booking between the wallet and the form.

            Three grid items rather than two columns, so a phone still reads
            wallet → bookings → details: the side panels are split in two, and
            the bookings span both of their rows. `self-start` on each, or a
            short panel stretches to the height of the booking list. */}
        <div className="mt-8 grid items-start gap-8 lg:grid-cols-[1fr_380px] lg:grid-rows-[auto_1fr]">
          {/* -- the wallet and her memberships ------------------------------ */}
          <div className="space-y-6 self-start lg:col-start-2 lg:row-start-1">
            <Wallet balance={balance} />
            <Memberships credits={credits} />
          </div>

          {/* -- the bookings ---------------------------------------------- */}
          <section className="self-start lg:col-start-1 lg:row-span-2 lg:row-start-1">
            <h2 className="text-start font-display text-lg font-extrabold text-ink">
              {a.bookingsTitle}
            </h2>

            {history.length === 0 && (
              <p className="mt-4 text-start text-sm text-ink/55">{a.noBookings}</p>
            )}

            {/* Find one: by name, reference or ticket, and by what she can do
                with it. In the browser — the page already holds her whole
                history (50 at most), so a query per keystroke buys nothing.
                Only once there is enough to need finding. */}
            {history.length > BOOKINGS_PREVIEW && (
              <div className="mt-4 space-y-3">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={a.searchBookings}
                  aria-label={a.searchBookings}
                  className="w-full rounded-[12px] border border-black/[0.08] bg-white px-4 py-3 text-start text-sm text-ink outline-none placeholder:text-ink/35 focus:border-red/40"
                />
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(BOOKING_FILTER_TEST) as BookingFilter[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={filter === key}
                      onClick={() => setFilter(key)}
                      className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors ${
                        filter === key
                          ? "bg-red text-white"
                          : "bg-white text-ink/70 ring-1 ring-black/[0.08] hover:ring-red/40"
                      }`}
                    >
                      {a.bookingFilters[key]} ({history.filter(BOOKING_FILTER_TEST[key]).length})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {history.length > 0 && shown.length === 0 && (
              <p className="mt-4 text-start text-sm text-ink/55">{a.noMatch}</p>
            )}

            {/* Side by side once there is room for two cards at a readable
                width, which halves how far a long history scrolls. Cards in a
                row stretch to one height, so their buttons line up. */}
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              {(showAll ? shown : shown.slice(0, BOOKINGS_PREVIEW)).map((r) => (
                <BookingCard
                  key={r.code}
                  row={r}
                  // From the full history, not the visible slice: a party split
                  // by "Show all" is still one party.
                  party={partyOf(history, r)}
                  lang={lang}
                  onOpenRefill={() => setVerifying(r.code)}
                  // The page is a server component, so re-reading it *is* the
                  // refresh — a cancellation changes the status, the time and the
                  // chair at once, and the server is the only thing that knows all
                  // three. It also re-reads the balance, which a cancellation moves.
                  onChanged={() => router.refresh()}
                />
              ))}
            </div>

            {/* The rest behind one tap. Newest first, so what is hidden is the
                oldest — the visits she is least likely to be looking for. */}
            {shown.length > BOOKINGS_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="mt-4 w-full rounded-[12px] border border-black/[0.08] bg-white py-3 text-center text-[13px] font-semibold text-ink transition-colors hover:border-red/40"
              >
                {showAll ? a.showFewer : a.showAll.replace("{n}", String(shown.length))}
              </button>
            )}
          </section>

          {/* -- the details ----------------------------------------------- */}
          <div className="self-start lg:col-start-2 lg:row-start-2">
            <ProfileForm customer={customer} />
          </div>
        </div>
      </div>

      {verifying && <RefillDialog code={verifying} onClose={() => setVerifying(null)} />}

      <SiteFooter />
    </main>
  );
}

/**
 * What her memberships have left, grouped by the membership she bought.
 *
 * The shelf shows this too, but the shelf is where she goes to *buy* one. This
 * is where she goes to check — and until this section existed, a customer who
 * bought a membership had nowhere to see it except the page that sold it to her,
 * which reads as the purchase not having landed.
 *
 * Grouped by purchase rather than listed flat, because credits are per service
 * and not interchangeable (lib/packs.ts): three gel polishes and one manicure is
 * two lines under one heading, never four of anything. A flat list of services
 * would imply a single pool, which is exactly the thing the ledger refuses.
 *
 * Empty renders nothing at all — an account page is not the place to advertise,
 * and the shelf is one tap away from the header card either way.
 */
function Memberships({ credits }: { credits: Credit[] }) {
  const { c, lang } = useI18n();
  const k = c.packs;

  if (credits.length === 0) return null;

  // One block per purchase, in the order packCredits sorted them: nearest
  // deadline first, so the one she should spend next is the one she reads first.
  const byPurchase = new Map<string, Credit[]>();
  for (const credit of credits) {
    byPurchase.set(credit.customerPackId, [...(byPurchase.get(credit.customerPackId) ?? []), credit]);
  }

  return (
    <section className="rounded-[20px] bg-white p-6 text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-lg font-extrabold text-ink">{k.yours}</h2>
        <Link
          href="/memberships"
          className="shrink-0 text-[13px] font-semibold text-red transition-opacity hover:opacity-70"
        >
          {k.browse}
        </Link>
      </div>

      <div className="mt-4 space-y-4">
        {[...byPurchase.values()].map((lines) => (
          <div key={lines[0].customerPackId} className="rounded-[14px] bg-cream/60 p-4">
            <p className="font-display text-base font-extrabold text-red">
              {pick(lines[0].packName, lang)}
            </p>
            <ul className="mt-2 space-y-2.5">
              {lines.map((credit) => {
                // What she has spent, from what she was sold. Never negative: a
                // credit handed back on a cancellation can only bring `left`
                // back up to what the purchase granted, never past it.
                const used = Math.max(0, credit.granted - credit.left);
                const pct = credit.granted > 0 ? (used / credit.granted) * 100 : 0;
                return (
                  <li key={credit.serviceId}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate text-ink">
                        {credit.serviceName ? pick(credit.serviceName, lang) : "—"}
                      </span>
                      <span className="shrink-0 font-semibold text-ink">
                        {k.leftCount.replace("{n}", String(credit.left))}
                      </span>
                    </div>
                    {/* How far through it she is, with the count on the bar's
                        own line — two lines a service rather than three, so a
                        membership of many services stays short.
                        `insetInlineStart` rather than `left`, so it fills
                        right-to-left in Arabic with no second code path — the
                        wallet bar above does the same. */}
                    <div className="mt-1 flex items-center gap-3">
                      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.06]">
                        <div
                          className="absolute top-0 h-full rounded-full bg-red/70"
                          style={{ insetInlineStart: 0, width: `${pct}%` }}
                        />
                      </div>
                      <span className="shrink-0 text-[11px] text-ink/45">
                        {k.usedOf
                          .replace("{used}", String(used))
                          .replace("{n}", String(credit.granted))}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {/* The deadline, because a credit is dead the moment it passes and
                nothing sweeps it — she is owed the date, not a surprise. In
                red with a countdown for the last two weeks, which is when the
                date alone stops being enough to act on. */}
            {(() => {
              const days = Math.ceil((Date.parse(lines[0].expiresAt) - Date.now()) / 86_400_000);
              return (
                <p className={`mt-3 text-[12px] ${days <= 14 ? "font-semibold text-red" : "text-ink/50"}`}>
                  {k.expiresOn.replace("{date}", formatDateLabel(lines[0].expiresAt.slice(0, 10), lang))}
                  {days <= 14 && ` · ${c.history.daysLeft.replace("{n}", String(days))}`}
                </p>
              );
            })()}
          </div>
        ))}
      </div>

      {/* A purchase that runs out vanishes from this list — packCredits keeps
          only what can still be spent. Said once, so a membership that is gone
          reads as finished rather than lost. */}
      <p className="mt-4 text-[11px] text-ink/40">{k.dropOff}</p>
    </section>
  );
}

/**
 * The wallet, as a ladder you can see yourself climbing.
 *
 * One track from zero to the dearest rung, with a marker at each reward. The
 * markers sit at their *true* proportion of the track (100 points is a fifth of
 * the way to 500, and looks it) rather than at even thirds — even spacing would
 * flatter the numbers and make the last rung look one step away when it is
 * twice the distance of the one before.
 *
 * Everything here is direction-agnostic: `insetInlineStart` rather than `left`,
 * so the bar fills right-to-left in Arabic without a second code path.
 */
function Wallet({ balance }: { balance: number }) {
  const { c } = useI18n();
  const a = c.account;

  const top = REWARDS.length ? REWARDS[REWARDS.length - 1].points : 0;
  const pct = (n: number) => (top > 0 ? Math.min(100, (n / top) * 100) : 0);
  const next = REWARDS.find((r) => r.points > balance) ?? null;

  // Animate the fill up from zero on mount. The bar arriving already full is a
  // static image; watching it climb is the whole point of showing progress.
  // Two lines and a CSS transition — no animation library for one bar.
  const [grown, setGrown] = useState(false);
  useEffect(() => setGrown(true), []);

  return (
    <section className="overflow-hidden rounded-[20px] bg-white text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
      <div className="bg-gradient-to-b from-[#fbeaea] to-transparent p-6 pb-7">
        <h2 className="font-display text-lg font-extrabold text-ink">{a.walletTitle}</h2>

        <p className="mt-3 font-display text-4xl font-extrabold text-red">
          {a.walletPoints.replace("{n}", String(balance))}
        </p>

        <p className="mt-1.5 text-[12px] text-ink/55">
          {balance === 0
            ? a.walletEmpty
            : next
              ? a.nextReward
                  .replace("{n}", String(next.points - balance))
                  .replace("{percent}", String(next.percent))
              : a.allUnlocked}
        </p>

        {/* the track */}
        <div className="relative mt-7 h-2.5 rounded-full bg-black/[0.07]">
          <div
            className="absolute inset-y-0 rounded-full bg-red-grad transition-[width] duration-1000 ease-out"
            style={{ insetInlineStart: 0, width: `${grown ? pct(balance) : 0}%` }}
          />

          {REWARDS.map((r) => {
            const unlocked = balance >= r.points;
            return (
              <span
                key={r.points}
                // Nudged back by half its own width rather than translated:
                // a -50% transform would push it the wrong way under RTL.
                style={{ insetInlineStart: `${pct(r.points)}%`, marginInlineStart: -7 }}
                className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 transition-colors duration-500 ${
                  unlocked ? "border-red bg-white" : "border-black/[0.12] bg-white"
                }`}
              >
                {unlocked && (
                  <span className="absolute inset-[2px] rounded-full bg-red-grad" />
                )}
              </span>
            );
          })}
        </div>

        {/* the numbers under it */}
        <div className="relative mt-2.5 h-4">
          {REWARDS.map((r) => (
            <span
              key={r.points}
              style={{ insetInlineStart: `${pct(r.points)}%`, marginInlineStart: -20, width: 40 }}
              className={`absolute text-center text-[11px] font-semibold tabular-nums ${
                balance >= r.points ? "text-red" : "text-ink/35"
              }`}
              dir="ltr"
            >
              {r.points}
            </span>
          ))}
        </div>
      </div>

      {/* The rungs. Locked ones are shown, never hidden — a reward you can see
          is the reason to come back, which is the whole point of the scheme. */}
      <div className="px-6 pb-6">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-ink/45">
          {a.ladderTitle}
        </h3>
        <ul className="mt-3 space-y-2">
          {REWARDS.map((r) => {
            const unlocked = balance >= r.points;
            return (
              <li
                key={r.points}
                className={`flex items-center justify-between gap-3 rounded-[14px] px-4 py-3 text-[13px] transition-colors ${
                  unlocked ? "bg-[#e8f3ec] text-[#2f7a4d]" : "bg-black/[0.04] text-ink/50"
                }`}
              >
                <span className="flex items-center gap-2.5 font-semibold">
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                      unlocked ? "bg-[#2f7a4d] text-white" : "bg-black/[0.08] text-ink/40"
                    }`}
                  >
                    {unlocked ? (
                      <svg viewBox="0 0 24 24" className="h-3 w-3" aria-hidden>
                        <path
                          d="M20 6L9 17l-5-5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <Lock className="h-2.5 w-2.5" />
                    )}
                  </span>
                  {a.rewardRow
                    .replace("{points}", String(r.points))
                    .replace("{percent}", String(r.percent))}
                </span>
                <span className="shrink-0 text-[11px] font-semibold">
                  {unlocked
                    ? a.ladderUnlocked
                    : a.ladderLocked.replace("{n}", String(r.points - balance))}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * Name, birthday and mobile, edited in place.
 *
 * Email is deliberately NOT in this form — it is the identity, so it gets the
 * two-step flow below. See app/api/account/email/route.ts for why.
 */
function ProfileForm({ customer }: { customer: Customer }) {
  const { c, lang } = useI18n();
  const a = c.account;
  const router = useRouter();

  const [name, setName] = useState(customer.name ?? "");
  // The form works in the 9 national digits PhoneField expects; the stored
  // shape is `05XXXXXXXX`, so it converts on the way in and on the way out.
  const [phone, setPhone] = useState(toNationalDigits(customer.phone));
  const [birthday, setBirthday] = useState(customer.birthday ?? "");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [tried, setTried] = useState(false);

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const say = (key: string | undefined): string =>
    (a.errors as Record<string, string>)[toCamel(key ?? "failed")] ?? a.errors.failed;

  const dirty =
    name.trim() !== (customer.name ?? "") ||
    toStoredPhone(phone) !== customer.phone ||
    (birthday || null) !== customer.birthday;

  const errors = profileErrors(lang, a, { name, phone, birthday });
  const canSave = dirty && !busy;

  const save = async () => {
    if (!canSave) return;
    setTried(true);
    if (errors.name || errors.phone || errors.birthday) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/account/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: toStoredPhone(phone),
          birthday: birthday || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 429 ? a.errors.tooMany : say(data.error));
        return;
      }
      setSaved(true);
      // The name is the page heading too, so the server has to re-render for
      // the change to show everywhere rather than only in this input.
      router.refresh();
    } catch {
      setError(a.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-[20px] bg-white p-6 text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
      <h2 className="font-display text-lg font-extrabold text-ink">{a.myDetails}</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="mt-4 space-y-4"
      >
        <TextInput
          label={a.nameLabel}
          opts={PERSON_TEXT}
          max={PERSON_NAME_MAX}
          error={errors.name}
          showError={tried}
          autoComplete="name"
          value={name}
          onChange={(v) => {
            setName(v);
            setSaved(false);
          }}
        />

        <PhoneField
          label={a.phoneLabel}
          value={phone}
          onChange={(v) => {
            setPhone(v);
            setSaved(false);
          }}
          required
          showError={phoneTouched || tried}
          onBlur={() => setPhoneTouched(true)}
        />

        <BirthdayInput
          value={birthday}
          error={errors.birthday}
          onChange={(v) => {
            setBirthday(v);
            setSaved(false);
          }}
        />

        <button
          type="submit"
          disabled={!canSave}
          className={`w-full rounded-[12px] py-3 text-center text-sm font-bold transition-opacity ${
            canSave
              ? "bg-red-grad text-white hover:opacity-90"
              : "cursor-not-allowed bg-black/[0.06] text-ink/40"
          }`}
        >
          {busy ? a.saving : a.save}
        </button>

        {saved && <p className="text-[12px] font-semibold text-[#2f7a4d]">{a.saved}</p>}
        {error && (
          <p role="alert" className="rounded-[12px] bg-red/[0.08] px-4 py-3 text-xs text-red">
            {error}
          </p>
        )}
      </form>

      <EmailForm currentEmail={customer.email} lang={lang} />
    </section>
  );
}

/**
 * Changing the address, in two steps.
 *
 * A code goes to the NEW address and the account is not touched until it comes
 * back. Anything less would let a signed-in customer point their invoices at
 * someone else's inbox — and squat that person's address into the bargain,
 * since the partial unique index would then stop the real owner signing up.
 */
function EmailForm({ currentEmail, lang }: { currentEmail: string; lang: "ar" | "en" }) {
  const { c } = useI18n();
  const a = c.account;
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const timer = useCodeTimer();
  useEffect(() => {
    if (timer.expired) setCode("");
  }, [timer.expired]);

  const emailError =
    checkEmail(validationMessages[lang], a.emailLabel, email, { required: true }) ??
    (email.trim().toLowerCase() === currentEmail.toLowerCase() ? a.errors.sameEmail : undefined);

  const say = (key: string | undefined): string =>
    (a.errors as Record<string, string>)[toCamel(key ?? "failed")] ?? a.errors.failed;

  const reset = () => {
    setOpen(false);
    setStep("email");
    setEmail("");
    setCode("");
    setError(null);
    setTried(false);
  };

  const request = async () => {
    if (busy) return;
    setTried(true);
    if (emailError) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), lang }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 429 ? a.errors.tooMany : say(data.error));
        return;
      }
      setSentTo(data.sentTo ?? null);
      setCode("");
      setStep("code");
      timer.start();
    } catch {
      setError(a.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (busy || code.length !== 6 || timer.expired) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/email/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 429 ? a.errors.tooMany : say(data.error));
        setCode("");
        return;
      }
      reset();
      // The address is the subheading and is what the invoice uses, so this has
      // to come back from the server rather than be patched in place.
      router.refresh();
    } catch {
      setError(a.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 border-t border-black/[0.06] pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="block text-[12px] text-ink/55">{a.emailLabel}</span>
          <span className="text-sm font-semibold text-ink" dir="ltr">
            {currentEmail}
          </span>
        </div>
        <button
          type="button"
          onClick={() => (open ? reset() : setOpen(true))}
          className="rounded-[12px] border border-black/[0.08] px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:border-red/40"
        >
          {open ? a.cancelEdit : a.changeEmailAction}
        </button>
      </div>

      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (step === "email" ? request() : confirm());
          }}
          className="mt-4"
        >
          <p className="mb-3 text-[12px] text-ink/50">{a.changeEmailNote}</p>

          {step === "email" ? (
            <>
              <TextInput
                label={a.emailLabel}
                opts={EMAIL_TEXT}
                max={EMAIL_MAX}
                error={emailError}
                showError={tried}
                placeholder={a.newEmailPlaceholder}
                value={email}
                onChange={setEmail}
              />
              <Submit disabled={busy} label={busy ? a.sending : a.sendCode} />
            </>
          ) : (
            <>
              <p className="mb-3 text-[13px] text-ink/60">
                {a.codeSentTo.replace("{email}", sentTo ?? email)}
              </p>
              <OtpInput value={code} onChange={setCode} />
              <CodeCountdown timer={timer} />
              <Submit disabled={busy || code.length !== 6 || timer.expired} label={busy ? a.sending : a.verify} />
              <div className="mt-4 text-[12px]">
                <ResendButton timer={timer} busy={busy} onClick={() => void request()} />
              </div>
            </>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded-[12px] bg-red/[0.08] px-4 py-3 text-xs text-red">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

// --------------------------------------------------------------- signed out --

type Step = "email" | "code" | "profile";

function SignedOut() {
  const { c, lang } = useI18n();
  const a = c.account;

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  /** Proof the address was verified, carried to the profile form. Never shown. */
  const [ticket, setTicket] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [birthday, setBirthday] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailTried, setEmailTried] = useState(false);
  const [profileTried, setProfileTried] = useState(false);
  const timer = useCodeTimer();
  // The server has discarded it; a half-typed one would only earn "expired".
  useEffect(() => {
    if (timer.expired) setCode("");
  }, [timer.expired]);

  // The same checks the API runs (lib/account/fields.ts), said before sending.
  const emailError = checkEmail(validationMessages[lang], a.emailLabel, email, { required: true });
  const errors = profileErrors(lang, a, { name, phone, birthday });

  /** Map a server error code to a sentence. Unknown codes fall back rather than blank. */
  const say = (key: string | undefined): string =>
    (a.errors as Record<string, string>)[toCamel(key ?? "failed")] ?? a.errors.failed;

  const sendCode = async () => {
    if (busy) return;
    setEmailTried(true);
    if (emailError) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), lang }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 429 ? a.errors.tooMany : say(data.error));
        return;
      }
      setSentTo(data.sentTo ?? null);
      setCode("");
      setStep("code");
      timer.start();
    } catch {
      setError(a.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (busy || code.length !== 6 || timer.expired) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 429 ? a.errors.tooMany : say(data.error));
        setCode("");
        return;
      }

      if (data.needsProfile) {
        setTicket(data.ticket);
        setStep("profile");
        return;
      }

      // Signed in. A full document navigation so the layout re-renders with the
      // Profile pill — see the note in signOut above.
      window.location.assign(nextPath());
    } catch {
      setError(a.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    if (busy || !ticket) return;
    setProfileTried(true);
    if (errors.name || errors.phone || errors.birthday) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket,
          name: name.trim(),
          phone: toStoredPhone(phone),
          birthday: birthday || null,
          lang,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(say(data.error));
        // The ticket is spent or stale — send them back to the start rather
        // than leaving them on a form that can no longer submit.
        if (data.error === "ticket-expired" || data.error === "already-registered") {
          setTicket(null);
          setStep("email");
        }
        return;
      }
      window.location.assign(nextPath());
    } catch {
      setError(a.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-[520px] px-6 pb-20 pt-[120px] md:px-12">
        <h1 className="text-start font-display text-3xl font-extrabold text-ink">
          {step === "profile" ? a.profileTitle : a.title}
        </h1>
        <p className="mt-2 text-start text-sm text-ink/55">
          {step === "profile" ? a.profileSub : a.sub}
        </p>

        <div className="mt-7 rounded-[20px] bg-white p-6 text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
          {step === "email" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendCode();
              }}
            >
              <TextInput
                label={a.emailLabel}
                opts={EMAIL_TEXT}
                max={EMAIL_MAX}
                error={emailError}
                showError={emailTried}
                hint={a.emailIdentityNote}
                autoComplete="email"
                value={email}
                onChange={setEmail}
              />
              <Submit disabled={busy} label={busy ? a.sending : a.sendCode} />
            </form>
          )}

          {step === "code" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <p className="mb-4 text-[13px] text-ink/60">
                {a.codeSentTo.replace("{email}", sentTo ?? email)}
              </p>
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-ink/55">{a.codeLabel}</span>
                <OtpInput value={code} onChange={setCode} />
              </label>
              <CodeCountdown timer={timer} />
              <Submit disabled={busy || code.length !== 6 || timer.expired} label={busy ? a.sending : a.verify} />

              <div className="mt-4 flex items-center justify-between gap-3 text-[12px]">
                <ResendButton timer={timer} busy={busy} onClick={() => void sendCode()} />
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setError(null);
                  }}
                  className="text-ink/45 underline underline-offset-4 hover:text-red"
                >
                  {a.changeEmail}
                </button>
              </div>
            </form>
          )}

          {step === "profile" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void register();
              }}
              className="space-y-4"
            >
              <TextInput
                label={a.nameLabel}
                opts={PERSON_TEXT}
                max={PERSON_NAME_MAX}
                error={errors.name}
                showError={profileTried}
                autoComplete="name"
                value={name}
                onChange={setName}
              />

              <PhoneField label={a.phoneLabel} value={phone} onChange={setPhone} required showError={profileTried} />

              <BirthdayInput value={birthday} error={errors.birthday} onChange={setBirthday} />

              <Submit disabled={busy} label={busy ? a.sending : a.createAccount} />
            </form>
          )}

          {error && (
            <p role="alert" className="mt-4 rounded-[12px] bg-red/[0.08] px-4 py-3 text-xs text-red">
              {error}
            </p>
          )}
        </div>

        {/* The advert. Shown signed out on purpose — this is the reason to make
            an account, so hiding it behind one would be backwards. */}
        {/* One row of tiles, not a stacked list: it sits under the form and
            must not outweigh it. */}
        <section className="mt-6 rounded-[20px] bg-white/60 px-5 py-4 text-start">
          <h2 className="flex items-center gap-2 font-display text-base font-extrabold text-ink">
            <Riyal className="h-3.5 w-3.5 text-red" />
            {a.walletTitle}
          </h2>
          <p className="mt-1 text-[12px] text-ink/50">{a.walletHowTo}</p>
          <ul className="mt-3 grid grid-cols-3 gap-2">
            {REWARDS.map((r) => (
              <li key={r.points} className="rounded-[12px] bg-black/[0.04] px-2 py-2 text-center">
                <span className="block text-sm font-extrabold text-ink" dir="ltr">
                  {r.percent}%
                </span>
                <span className="block text-[11px] text-ink/50">
                  {a.walletPoints.replace("{n}", String(r.points))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}

/**
 * The profile's checks, shared by sign-up and "My details" and matching
 * lib/account/fields.ts. `phone` is PhoneField's own code; it says the sentence.
 */
function profileErrors(
  lang: "ar" | "en",
  a: { nameLabel: string; birthdayLabel: string },
  f: { name: string; phone: string; birthday: string },
) {
  const v = validationMessages[lang];
  return {
    name: checkPersonName(v, a.nameLabel, f.name),
    phone: validateSaudiMobile(f.phone) ?? undefined,
    birthday: checkBirthday(v, a.birthdayLabel, f.birthday, riyadhDateKey(), (k) => formatDateKey(k, lang)),
  };
}

/** The browser's own date input, bounded to the range checkBirthday accepts. */
function BirthdayInput({ value, error, onChange }: { value: string; error?: string; onChange: (v: string) => void }) {
  const { c } = useI18n();
  const { earliest, latest } = birthdayRange(riyadhDateKey());
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] text-ink/55">{c.account.birthdayLabel}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type="date"
        min={earliest}
        max={latest}
        dir="ltr"
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-[12px] border bg-white px-4 py-3 text-left text-sm text-ink outline-none ${
          error ? "border-red/60" : "border-black/[0.08] focus:border-red/40"
        }`}
      />
      <span className={`mt-1.5 block text-[11px] ${error ? "text-red" : "text-ink/40"}`}>
        {error ?? c.account.birthdayNote}
      </span>
    </label>
  );
}

type CodeTimer = { left: number; expired: boolean; time: string; start: () => void };

/**
 * The code's minute, counted down. It starts when a code is sent and matches
 * ACCOUNT_OTP_TTL_MS, the moment the server discards that code.
 */
function useCodeTimer(): CodeTimer {
  const [endsAt, setEndsAt] = useState(0);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!endsAt) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= endsAt) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [endsAt]);

  const left = endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0;
  return {
    left,
    expired: endsAt > 0 && left === 0,
    time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`,
    start: () => {
      const t = Date.now();
      setNow(t);
      setEndsAt(t + ACCOUNT_OTP_TTL_MS);
    },
  };
}

function CodeCountdown({ timer }: { timer: CodeTimer }) {
  const { c } = useI18n();
  return timer.expired ? (
    <p role="alert" className="mt-2 text-start text-[12px] text-red">
      {c.account.codeExpired}
    </p>
  ) : (
    <p className="mt-2 text-start text-[12px] tabular-nums text-ink/45">
      {c.account.codeExpiresIn.replace("{time}", timer.time)}
    </p>
  );
}

/** Held until the current code has expired, so only one code is ever live. */
function ResendButton({ timer, busy, onClick }: { timer: CodeTimer; busy: boolean; onClick: () => void }) {
  const { c } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || !timer.expired}
      className="text-ink/45 underline underline-offset-4 hover:text-red disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40"
    >
      {timer.expired ? c.account.resend : `${c.account.resend} (${timer.time})`}
    </button>
  );
}

function Submit({ disabled, label }: { disabled: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className={`mt-5 w-full rounded-[12px] py-3 text-center text-sm font-bold transition-opacity ${
        disabled ? "cursor-not-allowed bg-black/[0.06] text-ink/40" : "bg-red-grad text-white hover:opacity-90"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Where to go once signed in: `?next=` when a page sent her here to sign in
 * (the membership checkout does), else the account itself.
 *
 * Resolved against this origin and refused if it lands anywhere else, so a
 * crafted link cannot use the sign-in form to bounce a customer off-site —
 * `//evil.example` and `/\evil.example` both parse to another host.
 */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next) return "/account";
  const url = new URL(next, window.location.origin);
  return url.origin === window.location.origin ? url.pathname + url.search : "/account";
}

/** `too-many` → `tooMany`, so an API error code indexes the strings directly. */
function toCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}
