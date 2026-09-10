"use client";

// The pack shelf, and buying one.
//
// One page rather than the gift card's two: a gift card is built — an amount, a
// design, a recipient, a message — and a pack is chosen. There is nothing to
// configure, so a second screen would be a step that asks nothing.
//
// Signing in is a wall here, unlike everywhere else on this site, and that is
// the feature: credits live on a customer account, so there is nowhere to put
// them for a guest. Said before the buy button rather than after it.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PaymentMethods from "@/components/PaymentMethods";
import { Riyal, Lock } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import type { PublicPack } from "@/lib/catalog";
import type { Localized } from "@/lib/localized";

const METHOD_KEYS = ["cardTitle", "madaTitle", "stcTitle", "appleTitle"] as const;

type Credit = { serviceName: Localized | null; left: number; expiresAt: string };

export default function PacksView({
  packs,
  signedIn,
  credits,
}: {
  packs: PublicPack[];
  signedIn: boolean;
  credits: Credit[];
}) {
  const { c, lang } = useI18n();
  const p = c.payment;
  const k = c.packs;
  const router = useRouter();

  const [chosen, setChosen] = useState<PublicPack | null>(null);
  const [method, setMethod] = useState(p.cardTitle);
  const [cardValid, setCardValid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /** Which enum value the API wants for the label the customer clicked. */
  const methodCode = (): "card" | "mada" | "stc" | "apple" => {
    const i = METHOD_KEYS.findIndex((key) => p[key] === method);
    return (["card", "mada", "stc", "apple"] as const)[i === -1 ? 0 : i];
  };

  const confirm = async () => {
    if (!chosen || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId: chosen.id, method: methodCode() }),
      });

      if (res.ok) {
        setDone(true);
        // The shelf now says what she holds, and /my-bookings can spend it.
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

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-page px-6 pt-[120px] md:px-12 lg:px-16">
        <h1 className="text-start font-display text-3xl font-extrabold text-ink">{k.title}</h1>
        <p className="mt-2 max-w-[620px] text-start text-sm text-ink/55">{k.sub}</p>
      </div>

      {/* What she already has. Above the shelf on purpose: someone who came back
          to buy a second pack usually meant to check the first. */}
      {credits.length > 0 && (
        <div className="mx-auto mt-8 max-w-page px-6 md:px-12 lg:px-16">
          <div className="rounded-[20px] bg-white p-5 ring-1 ring-black/[0.04]">
            <p className="mb-3 text-start font-display text-base font-extrabold text-red">
              {k.yours}
            </p>
            <ul className="space-y-1.5">
              {credits.map((credit, i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate text-ink">
                    {credit.serviceName ? pick(credit.serviceName, lang) : "—"}
                  </span>
                  <span className="shrink-0 font-semibold text-ink">
                    {k.leftCount.replace("{n}", String(credit.left))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-8 md:px-12 lg:grid-cols-[1fr_360px] lg:px-16">
        <div className="grid gap-5 sm:grid-cols-2">
          {packs.length === 0 && (
            <p className="text-start text-sm text-ink/45">{k.empty}</p>
          )}

          {packs.map((pack) => {
            const picked = chosen?.id === pack.id;
            const saving = pack.listPriceSar - pack.priceSar;
            return (
              <button
                key={pack.id}
                type="button"
                onClick={() => setChosen(picked ? null : pack)}
                className={`flex flex-col rounded-[20px] bg-white p-5 text-start transition-all ${
                  picked
                    ? "ring-2 ring-red shadow-[0_14px_36px_rgba(184,0,7,0.18)]"
                    : "ring-1 ring-black/[0.04] shadow-[0_10px_30px_rgba(184,0,7,0.05)] hover:ring-red/40"
                }`}
              >
                <div
                  className="mb-4 h-[140px] w-full rounded-[14px] bg-[#e7d9c9] bg-cover bg-center bg-no-repeat"
                  style={pack.img ? { backgroundImage: `url(${pack.img})` } : undefined}
                />
                <p className="font-display text-lg font-extrabold text-ink">
                  {pick(pack.name, lang)}
                </p>
                {pack.description && (
                  <p className="mt-1 text-[13px] text-ink/55">{pick(pack.description, lang)}</p>
                )}

                {/* What is in it, spelled out. Credits are per service, so a
                    line per service is not a detail — it is the product. */}
                <ul className="mt-4 space-y-1 border-t border-black/[0.05] pt-3">
                  {pack.lines.map((line) => (
                    <li key={line.serviceId} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="truncate text-ink/70">{pick(line.name, lang)}</span>
                      <span className="shrink-0 font-semibold text-ink">×{line.quantity}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-4 flex items-end justify-between gap-3 border-t border-black/[0.05] pt-3">
                  <span className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
                    <Riyal className="h-5 w-5" />
                    {pack.priceSar}
                  </span>
                  <span className="text-end">
                    {saving > 0 && (
                      <span className="block text-[12px] text-ink/40 line-through">
                        {pack.listPriceSar}
                      </span>
                    )}
                    <span className="block text-[11px] text-ink/45">
                      {k.validFor.replace("{n}", String(pack.validDays))}
                    </span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <aside className="h-fit rounded-[24px] bg-white p-6 text-start shadow-[0_20px_50px_rgba(184,0,7,0.06)]">
          <h2 className="mb-5 text-center font-display text-2xl font-extrabold text-ink">
            {k.checkout}
          </h2>

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
          ) : !chosen ? (
            <p className="rounded-[14px] bg-cream/60 p-5 text-center text-sm text-ink/50">
              {k.pickOne}
            </p>
          ) : (
            <>
              <div className="rounded-[14px] bg-cream/70 p-4">
                <p className="text-[11px] text-ink/45">{k.chosen}</p>
                <p className="text-sm font-semibold text-ink">{pick(chosen.name, lang)}</p>
                <p className="mt-2 flex items-center gap-1 font-display text-2xl font-extrabold text-red">
                  <Riyal className="h-5 w-5" />
                  {chosen.priceSar}
                </p>
                <p className="mt-1 text-[11px] text-ink/45">
                  {k.validFor.replace("{n}", String(chosen.validDays))}
                </p>
              </div>

              <div className="mt-5">
                <PaymentMethods onMethodChange={setMethod} onValidityChange={setCardValid} />
              </div>

              {error && (
                <p role="alert" className="mt-3 rounded-[12px] bg-red/[0.08] px-4 py-3 text-xs text-red">
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
