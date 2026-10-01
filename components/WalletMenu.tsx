"use client";

// Her wallet in the header, on every page, signed in only: the balance on a
// pill, and a menu that says where it came from (gift cards, refunds as credit,
// what she spent) and its last movements. Read from GET /api/wallet/quote, the
// session's own wallet; the account screen has the full card.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { formatSAR } from "@/lib/money";
import { formatDateLabel } from "@/lib/booking";
import { riyadhDateKey } from "@/lib/time";
import type { AccountWallet } from "@/lib/wallet";
import { Riyal, WalletIcon } from "@/components/icons";

/** Movements the menu lists; /account/wallet lists them all. */
const MENU_ROWS = 4;

export default function WalletMenu() {
  const { c, dir, lang } = useI18n();
  const a = c.account;
  const reasons = a.moneyReasons as Record<string, string>;
  const [wallet, setWallet] = useState<AccountWallet | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch("/api/wallet/quote")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.signedIn) setWallet(d);
      })
      .catch(() => {
        /* the header works without it */
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!wallet) return null;

  const sources = (Object.keys(a.moneySources) as (keyof typeof a.moneySources)[]).filter(
    (k) => wallet.sources[k] !== 0,
  );

  return (
    <div ref={box} className="relative">
      <button
        dir="ltr"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${a.moneyTitle}: ${formatSAR(wallet.available)} SAR`}
        className={`flex items-center gap-1.5 rounded-full border-[1.5px] px-4 py-1.5 font-display text-[15px] font-extrabold transition-colors ${
          open ? "border-red bg-red text-white" : "border-red/30 bg-white/70 text-red hover:border-red"
        }`}
      >
        <WalletIcon className="h-4 w-4" />
        <Riyal className="h-3.5 w-3.5" />
        {formatSAR(wallet.available)}
      </button>

      {open && (
        <div
          dir={dir}
          className="absolute right-0 top-full z-50 mt-3 w-[min(340px,calc(100vw-2.5rem))] overflow-hidden rounded-[20px] bg-white text-start shadow-[0_20px_50px_rgba(184,0,7,0.15)]"
        >
          <div className="bg-gradient-to-b from-[#fbeaea] to-transparent p-5 pb-4">
            <p className="text-[12px] font-semibold uppercase tracking-wider text-ink/45">{a.moneyTitle}</p>
            <p
              className={`mt-1 flex items-baseline gap-1.5 font-display text-3xl font-extrabold ${
                wallet.available > 0 ? "text-red" : "text-ink/25"
              }`}
            >
              <Riyal className="h-5 w-5 shrink-0" />
              {formatSAR(wallet.available)}
            </p>
            <p className="mt-1 text-[12px] text-ink/55">{wallet.available > 0 ? a.moneyUse : a.moneyEmpty}</p>
          </div>

          {sources.length > 0 && (
            <div className="px-5 pb-4">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-ink/45">{a.moneySourcesTitle}</h3>
              <ul className="mt-2 space-y-1.5">
                {sources.map((k) => (
                  <Row key={k} label={a.moneySources[k]} halalas={wallet.sources[k]} strong />
                ))}
              </ul>
            </div>
          )}

          {wallet.history.length > 0 && (
            <div className="border-t border-black/[0.06] px-5 py-4">
              <h3 className="text-[12px] font-semibold uppercase tracking-wider text-ink/45">{a.moneyHistory}</h3>
              <ul className="mt-2 space-y-1.5">
                {wallet.history.slice(0, MENU_ROWS).map((h, i) => (
                  <Row
                    key={i}
                    label={reasons[h.reason] ?? h.reason}
                    sub={formatDateLabel(riyadhDateKey(new Date(h.at)), lang)}
                    halalas={h.halalas}
                  />
                ))}
              </ul>
            </div>
          )}

          <Link
            href={wallet.count > MENU_ROWS ? "/account/wallet" : "/account"}
            onClick={() => setOpen(false)}
            className="block border-t border-black/[0.06] px-5 py-3 text-[13px] font-semibold text-red hover:bg-red/[0.04]"
          >
            {/* Says when it listed fewer than there are, so a sum above is
                never left with nothing here to explain it. */}
            {wallet.count > MENU_ROWS ? a.moneySeeAllCount.replace("{n}", String(wallet.count)) : a.moneySeeAll}
          </Link>
        </div>
      )}
    </div>
  );
}

function Row({ label, sub, halalas, strong }: { label: string; sub?: string; halalas: number; strong?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 text-[13px]">
      <span className={`min-w-0 truncate ${strong ? "font-semibold text-ink/80" : "text-ink/70"}`}>
        {label}
        {sub && <span className="text-ink/40"> · {sub}</span>}
      </span>
      <span dir="ltr" className={`shrink-0 font-semibold ${halalas > 0 ? "text-red" : "text-ink"}`}>
        {halalas > 0 ? "+" : "−"}
        {formatSAR(Math.abs(halalas))}
      </span>
    </li>
  );
}
