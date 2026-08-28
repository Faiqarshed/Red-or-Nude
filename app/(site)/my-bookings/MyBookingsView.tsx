"use client";

import Link from "next/link";
import { useState } from "react";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import BookingCard, { RefillDialog } from "@/components/booking/BookingCard";
import { useI18n } from "@/lib/i18n";
import type { BookingSummary } from "@/lib/booking";

// The refill button lives in BookingCard and nowhere else — that is the whole
// point of the feature: it is not a catalogue item, it is something a past
// booking earns. Whether it shows, and the countdown on it, both come from the
// server's refillDaysLeft() so the button can never promise what the API would
// refuse.
//
// This screen is the *guest* way in: a reference typed into a form. A signed-in
// customer is redirected to /account by page.tsx, which lists the same cards
// without the reference step.

export default function MyBookingsView() {
  const { c, lang } = useI18n();
  const h = c.history;

  const [code, setCode] = useState("");
  const [rows, setRows] = useState<BookingSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The reference whose refill is being unlocked, if the dialog is open. */
  const [verifying, setVerifying] = useState<string | null>(null);
  // Reading is open: the reference alone opens the booking, no code, no wait.
  // What the code guards is *changing* one — see BookingCard.
  const lookup = async (reference: string) => {
    const trimmed = reference.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/my-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });

      if (res.ok) {
        const data = await res.json();
        setRows(data.bookings as BookingSummary[]);
        return;
      }

      setRows(null);
      if (res.status === 404) setError(h.notFound);
      else if (res.status === 429) setError(h.tooMany);
      else setError(h.failed);
    } catch {
      setRows(null);
      setError(h.failed);
    } finally {
      setLoading(false);
    }
  };

  // Nothing is remembered between visits. The reference is the credential for a
  // booking, and this page is reachable by anyone on a shared or public browser
  // — leaving the last one prefilled hands the next person a working key, and
  // re-running the lookup on mount opens someone else's booking unprompted.
  // It lives in the customer's inbox; they can paste it again.
  const clear = () => {
    setRows(null);
    setCode("");
    setError(null);
  };

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-[760px] px-6 pb-20 pt-[120px] md:px-12">
        <h1 className="text-start font-display text-3xl font-extrabold text-ink">{h.title}</h1>
        <p className="mt-2 text-start text-sm text-ink/55">{h.sub}</p>

        {/* The only way into an account from the site chrome, now that the
            header carries no account pill. This screen is where a signed-out
            customer looking for their bookings ends up, which makes it the one
            place the offer is actually useful — a signed-in customer never sees
            it, because page.tsx redirects them to /account. */}
        <p className="mt-3 text-start text-[13px] text-ink/50">
          <Link href="/account" className="font-semibold text-red underline underline-offset-4">
            {c.account.signIn}
          </Link>{" "}
          {c.account.signInPrompt}
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void lookup(code);
          }}
          className="mt-6 flex flex-col gap-3 sm:flex-row"
        >
          <label className="flex-1 text-start">
            <span className="mb-1.5 block text-[12px] text-ink/55">{h.codeLabel}</span>
            <input
              value={code}
              // References are uppercase and drawn from a 32-character alphabet
              // with no I/O/0/1, so lowercase input is always a case slip.
              onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 20))}
              dir="ltr"
              maxLength={20}
              autoComplete="off"
              spellCheck={false}
              placeholder="RON-4F2K"
              className="w-full rounded-[12px] border border-black/[0.08] bg-white px-4 py-3 text-left text-sm uppercase tracking-wider text-ink outline-none placeholder:text-ink/30 focus:border-red/40"
            />
          </label>
          <button
            type="submit"
            disabled={loading || !code.trim()}
            className={`h-[46px] self-end rounded-[12px] px-8 text-sm font-bold transition-opacity ${
              loading || !code.trim()
                ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                : "bg-red-grad text-white hover:opacity-90"
            }`}
          >
            {loading ? h.loading : h.view}
          </button>
        </form>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-[12px] bg-red/[0.08] px-4 py-3 text-start text-xs text-red"
          >
            {error}
          </p>
        )}

        {rows && (
          <div className="mt-8 space-y-4">
            {rows.length === 0 && <p className="text-start text-sm text-ink/55">{h.empty}</p>}

            {rows.map((r) => (
              <BookingCard
                key={r.code}
                row={r}
                lang={lang}
                onOpenRefill={() => setVerifying(r.code)}
                // Re-runs the same lookup rather than patching the row in place:
                // a cancellation or a move changes the status, the time and the
                // chair at once, and the server is the only thing that knows all
                // three. One extra request beats three fields drifting.
                onChanged={() => void lookup(code)}
              />
            ))}

            <button
              type="button"
              onClick={clear}
              className="mt-2 text-[12px] text-ink/45 underline underline-offset-4 hover:text-red"
            >
              {h.forget}
            </button>
          </div>
        )}
      </div>

      {verifying && <RefillDialog code={verifying} onClose={() => setVerifying(null)} />}

      <SiteFooter />
    </main>
  );
}
