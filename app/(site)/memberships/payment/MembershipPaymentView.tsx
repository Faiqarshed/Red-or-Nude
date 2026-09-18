"use client";

// The membership checkout: what she is buying, how she is paying, and what to do
// with it afterwards.
//
// Same shape as the booking payment screen next door — summary on one side,
// methods on the other — so the two purchases on this site feel like one salon.
//
// Signing in is a wall here, unlike everywhere else, and that is the feature:
// credits live on a customer account, so there is nowhere to put them for a
// guest. Said before the card form rather than after it.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods, { methodIdFor } from "@/components/PaymentMethods";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import { formatDateLabel } from "@/lib/booking";
import type { PublicPack } from "@/lib/catalog";
import PackLines from "../PackLines";

export default function MembershipPaymentView({
  pack,
  signedIn,
}: {
  pack: PublicPack;
  signedIn: boolean;
}) {
  const { c, lang } = useI18n();
  const p = c.payment;
  const k = c.packs;
  const router = useRouter();

  const [method, setMethod] = useState(p.cardTitle);
  const [cardValid, setCardValid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The charge went through and the credits may not have. The button stays
   * off for good: the only thing pressing it again can do is charge her twice.
   */
  const [paidNotGranted, setPaidNotGranted] = useState(false);
  /** When she bought it — the expiry on the success panel counts from here. */
  const [boughtAt, setBoughtAt] = useState<number | null>(null);

  const confirm = async () => {
    if (submitting || paidNotGranted) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId: pack.id, method: methodIdFor(method, p) }),
      });

      if (res.ok) {
        setBoughtAt(Date.now());
        // Her account and the shelf both say something different now.
        router.refresh();
        return;
      }

      const data = await res.json().catch(() => ({}));
      // Nothing was charged on a decline, so retrying is safe and cheap.
      if (data.error === "signed-out") setError(k.signInFirst);
      else if (data.error === "payment-declined") setError(k.declined);
      else if (data.error === "paid-not-granted") {
        setPaidNotGranted(true);
        setError(k.paidNotGranted);
      }
      // Anything else may have happened before or after the charge — a thrown
      // gateway call, a dropped connection — so she is sent to check her account
      // before retrying, not told outright to try again.
      else setError(k.failed);
    } catch {
      setError(k.failed);
    } finally {
      setSubmitting(false);
    }
  };

  const saving = pack.listPriceSar - pack.priceSar;

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-page px-6 pt-[120px] md:px-12 lg:px-16">
        <h1 className="text-start font-display text-3xl font-extrabold text-ink">{p.title}</h1>
      </div>

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-8 md:px-12 lg:grid-cols-[1fr_380px] lg:px-16">
        {/* -- what she is buying ------------------------------------------- */}
        <section className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="font-display text-lg font-extrabold text-ink">{k.chosen}</h2>

          <div className="mt-4 flex gap-4">
            <div
              className="h-[96px] w-[96px] shrink-0 rounded-[14px] bg-[#e7d9c9] bg-cover bg-center bg-no-repeat"
              style={pack.img ? { backgroundImage: `url(${pack.img})` } : undefined}
            />
            <div className="min-w-0">
              <p className="font-display text-lg font-extrabold text-ink">
                {pick(pack.name, lang)}
              </p>
              {pack.description && (
                <p className="mt-1 text-[13px] text-ink/55">{pick(pack.description, lang)}</p>
              )}
              <p className="mt-2 text-[12px] text-ink/45">
                {k.validFor.replace("{n}", String(pack.validDays))}
              </p>
            </div>
          </div>

          {/* What is in it, spelled out. Credits are per service, so a line per
              service is not a detail — it is the product. */}
          <div className="mt-5 border-t border-black/[0.05] pt-3">
            <PackLines lines={pack.lines} />
          </div>

          <div className="mt-4 flex items-end justify-between gap-3 border-t border-black/[0.05] pt-4">
            <span className="text-sm text-ink/55">{p.total}</span>
            <span className="flex flex-col items-end">
              <span className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
                <Riyal className="h-5 w-5" />
                {pack.priceSar}
              </span>
              {saving > 0 && (
                <span className="flex items-center gap-1 text-[12px] font-semibold text-[#2f6b3f]">
                  {k.save}
                  <Riyal className="h-3 w-3" />
                  {saving}
                </span>
              )}
            </span>
          </div>

          {/* The things customers get wrong, said where they are spending. The
              late-cancellation rule is the one nobody expects of a prepaid
              credit, so it is said before she pays rather than when it bites. */}
          <p className="mt-4 rounded-[12px] bg-cream/70 p-3 text-[12px] leading-relaxed text-ink/55">
            {k.limits}. {k.lateCancel}
          </p>
        </section>

        {/* -- and how she is paying ---------------------------------------- */}
        <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          {boughtAt ? (
            // What she has, until when, and how to spend it — "Bought" alone
            // left her to guess all three. No receipt step: the credits are
            // already on her account by the time this renders.
            <div className="rounded-[14px] bg-[#fbeaea] p-5 text-start">
              <p className="font-display text-lg font-extrabold text-red">{k.bought}</p>
              <div className="mt-3">
                <PackLines lines={pack.lines} />
              </div>
              {/* Counted the way buyPack counts it, and sliced to a UTC date the
                  way the account page slices expiresAt, so the two screens name
                  the same day. */}
              <p className="mt-2 text-[12px] text-ink/55">
                {k.expiresOn.replace(
                  "{date}",
                  formatDateLabel(
                    new Date(boughtAt + pack.validDays * 86_400_000).toISOString().slice(0, 10),
                    lang,
                  ),
                )}
              </p>
              <p className="mt-3 text-[13px] leading-relaxed text-ink/65">{k.boughtNote}</p>
              <Link
                href="/booking"
                className="mt-4 block rounded-[12px] bg-red-grad py-3 text-center text-sm font-bold text-white"
              >
                {k.bookNow}
              </Link>
              <Link
                href="/account"
                className="mt-3 block text-center text-[12px] font-semibold text-red underline underline-offset-4"
              >
                {k.seeAccount}
              </Link>
            </div>
          ) : !signedIn ? (
            // The wall, said plainly and before anything is filled in.
            <div className="rounded-[14px] bg-[#fbeaea] p-5 text-center">
              <p className="text-sm text-ink/70">{k.signInFirst}</p>
              <Link
                // Straight back to this membership once she is in. Without it
                // she landed on her account and had to find the shelf again.
                href={`/account?next=${encodeURIComponent(`/memberships/payment?pack=${pack.id}`)}`}
                className="mt-3 inline-block rounded-[12px] bg-red-grad px-5 py-2.5 text-sm font-bold text-white"
              >
                {k.signIn}
              </Link>
            </div>
          ) : (
            <>
              <PaymentMethods onMethodChange={setMethod} onValidityChange={setCardValid} />

              {error && (
                <p
                  role="alert"
                  className="mt-3 rounded-[12px] bg-red/[0.08] px-4 py-3 text-xs text-red"
                >
                  {error}
                </p>
              )}

              <button
                type="button"
                onClick={confirm}
                disabled={submitting || !cardValid || paidNotGranted}
                className={`mt-5 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                  submitting || !cardValid || paidNotGranted
                    ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                    : "bg-red-grad text-white hover:opacity-90"
                }`}
              >
                {submitting ? k.paying : p.confirmPay}
              </button>

              <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-ink/45">
                <Lock className="h-3.5 w-3.5" />
                {p.secure}
              </p>
            </>
          )}
        </aside>
      </div>

      <SiteFooter />
    </main>
  );
}
