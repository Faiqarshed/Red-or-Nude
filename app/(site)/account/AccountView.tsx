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
import BookingCard, { RefillDialog } from "@/components/booking/BookingCard";
import { Lock, Riyal } from "@/components/icons";
import OtpInput from "@/components/OtpInput";
import { useI18n } from "@/lib/i18n";
import type { BookingSummary } from "@/lib/booking";
import { isValidSaudiMobile, toNationalDigits, toStoredPhone } from "@/lib/phone";
import { REWARDS } from "@/lib/rewards";

type Customer = {
  name: string | null;
  email: string;
  phone: string;
  birthday: string | null;
};

export default function AccountView({
  customer,
  balance = 0,
  history = [],
}: {
  customer?: Customer;
  balance?: number;
  history?: BookingSummary[];
}) {
  return customer ? (
    <SignedIn customer={customer} balance={balance} history={history} />
  ) : (
    <SignedOut />
  );
}

// ---------------------------------------------------------------- signed in --

function SignedIn({
  customer,
  balance,
  history,
}: {
  customer: Customer;
  balance: number;
  history: BookingSummary[];
}) {
  const { c, lang } = useI18n();
  const a = c.account;
  const router = useRouter();

  const [verifying, setVerifying] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

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

      <div className="mx-auto max-w-[760px] px-6 pb-20 pt-[120px] md:px-12">
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

        {/* -- the wallet ------------------------------------------------- */}
        <Wallet balance={balance} />

        {/* -- the bookings ---------------------------------------------- */}
        <h2 className="mt-10 text-start font-display text-lg font-extrabold text-ink">
          {a.bookingsTitle}
        </h2>

        <div className="mt-4 space-y-4">
          {history.length === 0 && <p className="text-start text-sm text-ink/55">{a.noBookings}</p>}

          {history.map((r) => (
            <BookingCard
              key={r.code}
              row={r}
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

        {/* -- the details ----------------------------------------------- */}
        <ProfileForm customer={customer} />
      </div>

      {verifying && <RefillDialog code={verifying} onClose={() => setVerifying(null)} />}

      <SiteFooter />
    </main>
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
    <section className="mt-8 overflow-hidden rounded-[20px] bg-white text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
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

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const say = (key: string | undefined): string =>
    (a.errors as Record<string, string>)[toCamel(key ?? "failed")] ?? a.errors.failed;

  const dirty =
    name.trim() !== (customer.name ?? "") ||
    toStoredPhone(phone) !== customer.phone ||
    (birthday || null) !== customer.birthday;

  const canSave = dirty && !busy && Boolean(name.trim()) && isValidSaudiMobile(phone);

  const save = async () => {
    if (!canSave) return;
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
    <section className="mt-10 rounded-[20px] bg-white p-6 text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
      <h2 className="font-display text-lg font-extrabold text-ink">{a.myDetails}</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="mt-4 space-y-4"
      >
        <label className="block">
          <span className="mb-1.5 block text-[12px] text-ink/55">{a.nameLabel}</span>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value.slice(0, 120));
              setSaved(false);
            }}
            autoComplete="name"
            className="w-full rounded-[12px] border border-black/[0.08] bg-white px-4 py-3 text-sm text-ink outline-none focus:border-red/40"
          />
        </label>

        <PhoneField
          label={a.phoneLabel}
          value={phone}
          onChange={(v) => {
            setPhone(v);
            setSaved(false);
          }}
          required
          showError={phoneTouched}
          onBlur={() => setPhoneTouched(true)}
        />

        <label className="block">
          <span className="mb-1.5 block text-[12px] text-ink/55">{a.birthdayLabel}</span>
          {/* The browser's own date input: it localises, it validates, and it
              hands back the YYYY-MM-DD the `date` column stores. */}
          <input
            value={birthday}
            onChange={(e) => {
              setBirthday(e.target.value);
              setSaved(false);
            }}
            type="date"
            max={new Date().toISOString().slice(0, 10)}
            dir="ltr"
            className="w-full rounded-[12px] border border-black/[0.08] bg-white px-4 py-3 text-left text-sm text-ink outline-none focus:border-red/40"
          />
          <span className="mt-1.5 block text-[11px] text-ink/40">{a.birthdayNote}</span>
        </label>

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

  const emailOk =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    email.trim().toLowerCase() !== currentEmail.toLowerCase();

  const say = (key: string | undefined): string =>
    (a.errors as Record<string, string>)[toCamel(key ?? "failed")] ?? a.errors.failed;

  const reset = () => {
    setOpen(false);
    setStep("email");
    setEmail("");
    setCode("");
    setError(null);
  };

  const request = async () => {
    if (busy || !emailOk) return;
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
    } catch {
      setError(a.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (busy || code.length !== 6) return;
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
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                inputMode="email"
                dir="ltr"
                maxLength={200}
                placeholder={a.newEmailPlaceholder}
                className="w-full rounded-[12px] border border-black/[0.08] bg-white px-4 py-3 text-left text-sm text-ink outline-none placeholder:text-ink/30 focus:border-red/40"
              />
              <Submit disabled={busy || !emailOk} label={busy ? a.sending : a.sendCode} />
            </>
          ) : (
            <>
              <p className="mb-3 text-[13px] text-ink/60">
                {a.codeSentTo.replace("{email}", sentTo ?? email)}
              </p>
              <OtpInput value={code} onChange={setCode} />
              <Submit disabled={busy || code.length !== 6} label={busy ? a.sending : a.verify} />
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

  // Loose on purpose — the server's zod schema is the real check. This only
  // decides whether the button is clickable.
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  /** Map a server error code to a sentence. Unknown codes fall back rather than blank. */
  const say = (key: string | undefined): string =>
    (a.errors as Record<string, string>)[toCamel(key ?? "failed")] ?? a.errors.failed;

  const sendCode = async () => {
    if (busy || !emailOk) return;
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
    } catch {
      setError(a.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (busy || code.length !== 6) return;
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
      window.location.assign("/account");
    } catch {
      setError(a.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    if (busy || !ticket || !name.trim() || !isValidSaudiMobile(phone)) return;
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
      window.location.assign("/account");
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
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-ink/55">{a.emailLabel}</span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  dir="ltr"
                  maxLength={200}
                  className="w-full rounded-[12px] border border-black/[0.08] bg-white px-4 py-3 text-left text-sm text-ink outline-none placeholder:text-ink/30 focus:border-red/40"
                />
              </label>
              <Submit disabled={busy || !emailOk} label={busy ? a.sending : a.sendCode} />
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
              <Submit disabled={busy || code.length !== 6} label={busy ? a.sending : a.verify} />

              <div className="mt-4 flex items-center justify-between gap-3 text-[12px]">
                <button
                  type="button"
                  onClick={() => void sendCode()}
                  disabled={busy}
                  className="text-ink/45 underline underline-offset-4 hover:text-red disabled:opacity-40"
                >
                  {a.resend}
                </button>
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
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-ink/55">{a.nameLabel}</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 120))}
                  autoComplete="name"
                  className="w-full rounded-[12px] border border-black/[0.08] bg-white px-4 py-3 text-sm text-ink outline-none focus:border-red/40"
                />
              </label>

              <PhoneField label={a.phoneLabel} value={phone} onChange={setPhone} required />

              <label className="block">
                <span className="mb-1.5 block text-[12px] text-ink/55">{a.birthdayLabel}</span>
                {/* The browser's own date input: it localises, it validates, and
                    it hands back the YYYY-MM-DD the `date` column stores. */}
                <input
                  value={birthday}
                  onChange={(e) => setBirthday(e.target.value)}
                  type="date"
                  max={new Date().toISOString().slice(0, 10)}
                  dir="ltr"
                  className="w-full rounded-[12px] border border-black/[0.08] bg-white px-4 py-3 text-left text-sm text-ink outline-none focus:border-red/40"
                />
                <span className="mt-1.5 block text-[11px] text-ink/40">{a.birthdayNote}</span>
              </label>

              <Submit
                disabled={busy || !name.trim() || !isValidSaudiMobile(phone)}
                label={busy ? a.sending : a.createAccount}
              />
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
        <section className="mt-8 rounded-[20px] bg-white/60 p-6 text-start">
          <h2 className="flex items-center gap-2 font-display text-lg font-extrabold text-ink">
            <Riyal className="h-4 w-4 text-red" />
            {a.walletTitle}
          </h2>
          <p className="mt-2 text-[12px] text-ink/50">{a.walletHowTo}</p>
          <ul className="mt-4 space-y-2">
            {REWARDS.map((r) => (
              <li
                key={r.points}
                className="rounded-[14px] bg-black/[0.04] px-4 py-3 text-[13px] font-semibold text-ink/60"
              >
                {a.rewardRow
                  .replace("{points}", String(r.points))
                  .replace("{percent}", String(r.percent))}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <SiteFooter />
    </main>
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

/** `too-many` → `tooMany`, so an API error code indexes the strings directly. */
function toCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}
