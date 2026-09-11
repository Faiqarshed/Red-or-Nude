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
import type { PublicPack } from "@/lib/catalog";

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
  const [done, setDone] = useState(false);

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId: pack.id, method: methodIdFor(method, p) }),
      });

      if (res.ok) {
        setDone(true);
        // Her account and the shelf both say something different now.
        router.refresh();
        return;
      }

      const data = await res.json().catch(() => ({}));
      // Nothing was granted on a decline, so retrying is safe and cheap.
      if (data.error === "signed-out") setError(k.signInFirst);
      else if (data.error === "payment-declined") setError(p.declined);
      else setError(p.bookingFailed);
    } catch {
      setError(p.bookingFailed);
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
          <h2 className="font-display text-lg font-extrabold text-ink">{p.summaryTitle}</h2>

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
          <ul className="mt-5 space-y-1.5 border-t border-black/[0.05] pt-4">
            {pack.lines.map((line) => (
              <li
                key={line.serviceId}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="truncate text-ink/70">{pick(line.name, lang)}</span>
                <span className="shrink-0 font-semibold text-ink">×{line.quantity}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-end justify-between gap-3 border-t border-black/[0.05] pt-4">
            <span className="text-sm text-ink/55">{p.total}</span>
            <span className="text-end">
              {saving > 0 && (
                <span className="block text-[12px] text-ink/40 line-through">
                  {pack.listPriceSar}
                </span>
              )}
              <span className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
                <Riyal className="h-5 w-5" />
                {pack.priceSar}
              </span>
            </span>
          </div>

          {/* The thing customers get wrong, said where they are spending. */}
          <p className="mt-4 rounded-[12px] bg-cream/70 p-3 text-[12px] leading-relaxed text-ink/55">
            {k.howNote}
          </p>
        </section>

        {/* -- and how she is paying ---------------------------------------- */}
        <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          {done ? (
            <div className="rounded-[14px] bg-[#fbeaea] p-5 text-center">
              <p className="font-display text-lg font-extrabold text-red">{k.bought}</p>
              <p className="mt-2 text-sm text-ink/60">{k.boughtNote}</p>
              <Link
                href="/booking"
                className="mt-4 inline-block rounded-[12px] bg-red-grad px-5 py-2.5 text-sm font-bold text-white"
              >
                {p.newBooking}
              </Link>
            </div>
          ) : !signedIn ? (
            // The wall, said plainly and before anything is filled in.
            <div className="rounded-[14px] bg-[#fbeaea] p-5 text-center">
              <p className="text-sm text-ink/70">{k.signInFirst}</p>
              <Link
                href="/account"
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
                disabled={submitting || !cardValid}
                className={`mt-5 block w-full rounded-[12px] py-3.5 text-center text-sm font-bold transition-opacity ${
                  submitting || !cardValid
                    ? "cursor-not-allowed bg-black/[0.06] text-ink/40"
                    : "bg-red-grad text-white hover:opacity-90"
                }`}
              >
                {submitting ? p.confirming : p.confirmPay}
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
