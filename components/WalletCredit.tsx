"use client";

// "Pay with wallet": she types how much of her credit to spend, or takes the
// most it can pay. On every checkout: a booking, a membership, a gift card, a
// treat from the chair. Shown to a signed-in customer with credit to spend.
//
// What she may type is walletSpendOk (lib/money.ts), the rule the server
// applies to the same bill; the most is walletCovers. The purchase sends the
// amount and is refused if the server disagrees, so a balance another tab
// spent is corrected here, never charged.

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { formatSAR, HALALAS_PER_SAR, walletCovers, walletSpendOk } from "@/lib/money";
import { Riyal, WalletIcon } from "@/components/icons";

/** Her credit's amount field. Reports what she typed, in halalas, and whether it may be spent. */
export function WalletAmount({
  available,
  billHalalas,
  onChange,
}: {
  available: number;
  billHalalas: number;
  onChange: (halalas: number, ok: boolean) => void;
}) {
  const { c } = useI18n();
  const p = c.payment;
  const [text, setText] = useState("");
  const max = walletCovers(billHalalas, available);
  const typed = text.trim() === "" ? 0 : Math.round(Number(text) * HALALAS_PER_SAR);
  const ok = Number.isFinite(typed) && walletSpendOk(typed, billHalalas, available);

  useEffect(() => {
    onChange(ok ? typed : 0, ok);
    // The parent's setter, not a dependency: re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed, ok]);

  const hint = !ok
    ? typed > available
      ? p.walletOverBalance.replace("{sar}", formatSAR(available))
      : available >= billHalalas
        ? p.walletUpToOrAll.replace("{max}", formatSAR(max)).replace("{all}", formatSAR(billHalalas))
        : p.walletUpTo.replace("{max}", formatSAR(max))
    : typed === 0
      ? null
      : typed === billHalalas
        ? p.walletCoversAll
        : p.walletRest.replace("{sar}", formatSAR(billHalalas - typed));

  return (
    <div className="rounded-[14px] border border-black/[0.08] p-3 text-start">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[14px] font-bold text-ink">
          <WalletIcon className="h-4 w-4 text-red" />
          {p.walletPay}
        </span>
        <span className="flex items-center gap-1 text-[12px] text-ink/50">
          {p.walletBalance}
          <Riyal className="h-3 w-3" />
          <span dir="ltr" className="font-semibold text-ink/70">
            {formatSAR(available)}
          </span>
        </span>
      </div>
      <div className="mt-2 flex gap-2">
        <label
          dir="ltr"
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-[12px] border px-3.5 ${
            ok ? "border-black/[0.08] focus-within:border-red/40" : "border-red/50"
          }`}
        >
          <Riyal className="h-3.5 w-3.5 shrink-0 text-ink/40" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder="0"
            aria-label={p.walletPay}
            className="min-w-0 flex-1 bg-transparent py-2.5 text-sm font-semibold text-ink outline-none placeholder:text-ink/30"
          />
        </label>
        <button
          type="button"
          onClick={() => setText(String(max / HALALAS_PER_SAR))}
          disabled={max <= 0 || typed === max}
          className="shrink-0 rounded-[12px] border border-red/30 px-4 text-[13px] font-bold text-red transition-colors hover:bg-red/[0.04] disabled:opacity-40"
        >
          {p.walletMax.replace("{sar}", formatSAR(max))}
        </button>
      </div>
      {hint && (
        <p role={ok ? undefined : "alert"} className={`mt-2 text-[12px] ${ok ? "text-ink/55" : "text-red"}`}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** Her credit on a purchase: the field, and what it pays. */
export function useWalletCredit(priceHalalas: number) {
  const { c } = useI18n();
  const [available, setAvailable] = useState(0);
  const [pick, setPick] = useState({ halalas: 0, ok: true });
  /** The balance could not be read. Said rather than hidden: no field reads as "no credit". */
  const [down, setDown] = useState(false);

  useEffect(() => {
    void fetch("/api/wallet/quote")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        if (d?.signedIn) setAvailable(d.available ?? 0);
      })
      // Paying by card still works. A guest sees this too when it fails (who
      // she is was in the answer that did not come); rare, and still true.
      .catch(() => setDown(true));
  }, []);

  return {
    /** What her credit pays of the price: send it with the purchase. */
    halalas: pick.halalas,
    /** False while what she typed can't be spent: hold the Pay button. */
    ok: pick.ok,
    /** The server's figure, after a `wallet-changed` refusal. */
    refused: (balance: unknown) => {
      if (typeof balance === "number") setAvailable(balance);
    },
    /** The field, or nothing when there is no credit to use. */
    field:
      available > 0 && priceHalalas > 0 ? (
        <WalletAmount
          available={available}
          billHalalas={priceHalalas}
          onChange={(halalas, ok) => setPick({ halalas, ok })}
        />
      ) : down && priceHalalas > 0 ? (
        <p className="px-1 text-[12px] text-ink/55">{c.payment.walletUnavailable}</p>
      ) : null,
  };
}
