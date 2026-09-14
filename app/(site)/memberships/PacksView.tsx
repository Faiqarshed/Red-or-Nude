"use client";

// The membership shelf.
//
// Browsing only: choosing one takes her to /memberships/payment, the same way
// every other purchase on this site reaches a payment screen. The checkout used
// to live here as an aside, which put a card form on a page whose job is to be
// read, and made the shelf narrower to fit it.
//
// Signing in is a wall on the payment screen, not on this one: nothing here
// needs an account, and a shelf that refuses to be browsed is a shelf nobody
// browses. The note in the sidebar says it before she gets there.

import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { pick } from "@/lib/localized";
import type { PublicPack } from "@/lib/catalog";
import PackLines from "./PackLines";
import type { Localized } from "@/lib/localized";

type Credit = { serviceName: Localized | null; left: number };

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
  const k = c.packs;

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-page px-6 pt-[120px] md:px-12 lg:px-16">
        <h1 className="text-start font-display text-3xl font-extrabold text-ink">{k.title}</h1>
        <p className="mt-2 max-w-[620px] text-start text-sm text-ink/55">{k.sub}</p>
      </div>

      <div className="mx-auto grid max-w-page gap-8 px-6 pb-20 pt-8 md:px-12 lg:grid-cols-[1fr_340px] lg:px-16">
        <div className="grid gap-5 sm:grid-cols-2">
          {packs.length === 0 && <p className="text-start text-sm text-ink/45">{k.empty}</p>}

          {packs.map((pack) => {
            const saving = pack.listPriceSar - pack.priceSar;
            return (
              <div
                key={pack.id}
                // `group` so the capsule at the foot can answer a hover anywhere
                // on the card rather than only on itself. `relative` anchors the
                // stretched link below.
                className="group relative flex flex-col rounded-[20px] bg-white p-5 text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)] ring-1 ring-black/[0.04] transition-all focus-within:ring-red/40 hover:shadow-[0_14px_36px_rgba(184,0,7,0.12)] hover:ring-red/40"
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

                {/* What is in it, spelled out — and each service opens, since
                    six of something is only worth buying once she knows what
                    the something is. */}
                <div className="mt-4 border-t border-black/[0.05] pt-2">
                  <PackLines lines={pack.lines} />
                </div>

                {/* The rules that decide whether it suits her, on the card she is
                    deciding with. They used to sit in the sidebar, which on a
                    phone is below every card on the page. */}
                <p className="mt-3 text-[11px] leading-relaxed text-ink/45">
                  {k.validFor.replace("{n}", String(pack.validDays))} · {k.limits}
                </p>

                <div className="mt-4 flex items-end justify-between gap-3 border-t border-black/[0.05] pt-3">
                  <span className="flex items-center gap-1 font-display text-2xl font-extrabold text-red">
                    <Riyal className="h-5 w-5" />
                    {pack.priceSar}
                  </span>
                  {/* Said as a saving, not a struck-through number she has to
                      subtract herself. */}
                  {saving > 0 && (
                    <span className="flex items-center gap-1 text-[12px] font-semibold text-[#2f6b3f]">
                      {k.save}
                      <Riyal className="h-3 w-3" />
                      {saving}
                    </span>
                  )}
                </div>

                {/* The one link on the card, stretched over all of it by its
                    `after:` layer, so a tap anywhere still buys. The card itself
                    used to be the anchor, but the service rows are buttons now,
                    and a button inside an anchor is invalid HTML that keyboard
                    and screen-reader users both trip over. The rows sit above
                    the layer on `z-10`. */}
                <Link
                  href={`/memberships/payment?pack=${pack.id}`}
                  className="mt-4 inline-flex items-center justify-center rounded-full border-[2px] border-red px-5 py-1.5 font-display text-[13px] font-semibold text-red transition-colors after:absolute after:inset-0 after:rounded-[20px] after:content-[''] focus-visible:outline-none group-hover:bg-red group-hover:text-white"
                >
                  {k.buy}
                </Link>
              </div>
            );
          })}
        </div>

        {/* The column the checkout used to occupy. What belongs beside a shelf is
            what she came to check and what she is about to get wrong: how much
            she has left, and how a credit is actually spent. */}
        <aside className="h-fit space-y-5 lg:sticky lg:top-[110px]">
          {credits.length > 0 && (
            <div className="rounded-[20px] bg-white p-5 text-start ring-1 ring-black/[0.04]">
              <p className="mb-3 font-display text-base font-extrabold text-red">{k.yours}</p>
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
          )}

          {/* The question this page kept producing: a customer buys a membership
              and then pays full price at the till, because spending a credit is a
              checkbox on another screen and nothing here ever mentioned it.

              Not on an empty shelf, and nor is the sign-in note: both are about
              buying, and there is nothing to buy. */}
          {packs.length > 0 && (
          <div className="rounded-[20px] bg-white p-5 text-start ring-1 ring-black/[0.04]">
            <p className="font-display text-base font-extrabold text-red">{k.howTitle}</p>
            <ol className="mt-3 space-y-3">
              {k.howSteps.map((step, i) => (
                <li key={i} className="flex gap-3 text-[13px] leading-relaxed text-ink/70">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-red/10 font-display text-[11px] font-extrabold text-red">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
          )}

          {/* Said here rather than at the card form, where it would be a refusal
              instead of a heads-up. */}
          {!signedIn && packs.length > 0 && (
            <div className="rounded-[20px] bg-[#fbeaea] p-5 text-center">
              <p className="text-sm text-ink/70">{k.signInFirst}</p>
              <Link
                // Back to the shelf afterwards, not left on the account page.
                href="/account?next=/memberships"
                className="mt-3 inline-block rounded-[12px] bg-red-grad px-5 py-2.5 text-sm font-bold text-white"
              >
                {k.signIn}
              </Link>
            </div>
          )}
        </aside>
      </div>

      <SiteFooter />
    </main>
  );
}
