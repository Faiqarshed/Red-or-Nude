"use client";

// Her whole wallet: what she holds, where it came from, and every movement,
// filtered to what came in or what went out.

import Link from "next/link";
import { useState } from "react";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { Riyal } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { formatDateLabel } from "@/lib/booking";
import { formatSAR } from "@/lib/money";
import { riyadhDateKey } from "@/lib/time";
import type { AccountWallet } from "@/lib/wallet";

const FILTER_TEST = {
  all: () => true,
  added: (h: AccountWallet["history"][number]) => h.halalas > 0,
  spent: (h: AccountWallet["history"][number]) => h.halalas < 0,
};
type Filter = keyof typeof FILTER_TEST;

export default function WalletHistoryView({ wallet }: { wallet: AccountWallet }) {
  const { c, lang } = useI18n();
  const a = c.account;
  const reasons = a.moneyReasons as Record<string, string>;
  const [filter, setFilter] = useState<Filter>("all");
  const sources = (Object.keys(a.moneySources) as (keyof typeof a.moneySources)[]).filter(
    (k) => wallet.sources[k] !== 0,
  );
  const shown = wallet.history.filter(FILTER_TEST[filter]);

  return (
    <main className="min-h-screen bg-cream">
      <SiteHeader />

      <div className="mx-auto max-w-[760px] px-6 pb-20 pt-[120px] md:px-12">
        <Link href="/account" className="text-[13px] font-semibold text-red transition-opacity hover:opacity-70">
          <span aria-hidden className="inline-block rtl:rotate-180">‹</span> {a.moneyBack}
        </Link>

        {/* What she holds and where it came from, the same figures the header shows. */}
        <section className="mt-4 overflow-hidden rounded-[20px] bg-white text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
          <div className="bg-gradient-to-b from-[#fbeaea] to-transparent p-6">
            <h1 className="font-display text-2xl font-extrabold text-ink">{a.moneyPageTitle}</h1>
            <p
              className={`mt-3 flex items-baseline gap-1.5 font-display text-4xl font-extrabold ${
                wallet.available > 0 ? "text-red" : "text-ink/25"
              }`}
            >
              <Riyal className="h-6 w-6 shrink-0" />
              {formatSAR(wallet.available)}
            </p>
            <p className="mt-1.5 text-[12px] text-ink/55">{wallet.available > 0 ? a.moneyUse : a.moneyEmpty}</p>
          </div>
          {sources.length > 0 && (
            // A list on a phone, a label and its amount on one line; from sm,
            // one row of equal tiles however many sources she has, amounts on
            // the bottom edge so a label that wraps doesn't lift its amount.
            <div className="grid gap-2 px-6 pb-6 sm:auto-cols-fr sm:grid-flow-col sm:gap-3">
              {sources.map((k) => (
                <div
                  key={k}
                  className="flex items-center justify-between gap-3 rounded-[14px] bg-cream/70 px-4 py-3 sm:flex-col sm:items-start sm:gap-1"
                >
                  <p className="text-[12px] leading-snug text-ink/55">{a.moneySources[k]}</p>
                  <p
                    dir="ltr"
                    className={`shrink-0 text-start font-display text-lg font-extrabold ${
                      wallet.sources[k] > 0 ? "text-red" : "text-ink"
                    }`}
                  >
                    {wallet.sources[k] > 0 ? "+" : "−"}
                    {formatSAR(Math.abs(wallet.sources[k]))}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="mt-6 flex flex-wrap gap-2">
          {(Object.keys(FILTER_TEST) as Filter[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors ${
                filter === key ? "bg-red text-white" : "bg-white text-ink/70 ring-1 ring-black/[0.08] hover:ring-red/40"
              }`}
            >
              {a.moneyFilters[key]} ({wallet.history.filter(FILTER_TEST[key]).length})
            </button>
          ))}
        </div>

        <section className="mt-4 rounded-[20px] bg-white px-6 py-2 text-start shadow-[0_10px_30px_rgba(184,0,7,0.05)]">
          {shown.length === 0 ? (
            <p className="py-6 text-sm text-ink/55">{a.moneyNoMatch}</p>
          ) : (
            <ul className="divide-y divide-black/[0.06]">
              {shown.map((h, i) => (
                <li key={i} className="flex items-center justify-between gap-3 py-3.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{reasons[h.reason] ?? h.reason}</span>
                    <span className="block text-[12px] text-ink/45">
                      {formatDateLabel(riyadhDateKey(new Date(h.at)), lang)}
                    </span>
                  </span>
                  <span
                    dir="ltr"
                    className={`shrink-0 font-display text-base font-extrabold ${h.halalas > 0 ? "text-red" : "text-ink"}`}
                  >
                    {h.halalas > 0 ? "+" : "−"}
                    {formatSAR(Math.abs(h.halalas))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
