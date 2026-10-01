"use client";

// "Use my credit" on a purchase (docs/WALLET-PLAN.md, step 5): a membership, a
// gift card, a treat from the chair. Shown to a signed-in customer with credit
// to spend.
//
// What it pays is walletCovers (lib/money.ts), the rule the server applies to
// the same price. The purchase sends that figure and is refused if the server's
// differs, so a balance another tab spent is corrected here, never charged.

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { formatSAR, walletCovers } from "@/lib/money";

export function useWalletCredit(priceHalalas: number) {
  const { c } = useI18n();
  const p = c.payment;
  const [available, setAvailable] = useState(0);
  const [on, setOn] = useState(false);

  useEffect(() => {
    void fetch("/api/wallet/quote")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.signedIn) setAvailable(d.available ?? 0);
      })
      .catch(() => {
        /* an extra; paying by card works without it */
      });
  }, []);

  const halalas = on ? walletCovers(priceHalalas, available) : 0;

  return {
    /** What her credit pays of the price: send it with the purchase. */
    halalas,
    /** The server's figure, after a `wallet-changed` refusal. */
    refused: (balance: unknown) => {
      if (typeof balance === "number") setAvailable(balance);
    },
    /** The switch, or nothing when there is no credit to use. */
    toggle:
      available > 0 ? (
        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-[12px] border border-black/[0.08] px-3.5 py-3 text-start has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red/30">
          <span className="text-[13px] font-semibold text-ink">
            {p.walletUse.replace("{sar}", formatSAR(available))}
          </span>
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => setOn(e.target.checked)}
            className="h-4 w-4 accent-red"
          />
        </label>
      ) : null,
  };
}
