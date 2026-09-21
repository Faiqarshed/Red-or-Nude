"use client";

// The "Select payment method" panel on every checkout.
//
// Before Pay is pressed it says what she can pay with. After, it holds
// StreamPay's embedded checkout — card, mada and Apple Pay are all chosen and
// entered there, inside StreamPay's iframe, so no card data ever reaches this
// origin and we stay out of PCI scope.
//
// This panel does not submit. There is exactly one Pay button per page and it
// lives in the summary; pressing it is what produces `checkout`.

import { useI18n } from "@/lib/i18n";
import StreamPayCheckout, { type PaymentOutcome } from "./StreamPayCheckout";

export default function PaymentMethods({
  checkout,
  onDone,
}: {
  checkout: { ref: string; url: string } | null;
  onDone: (outcome: PaymentOutcome) => void;
}) {
  const { c } = useI18n();
  const p = c.payment;

  return (
    <section>
      <h2 className="mb-6 text-start font-display text-2xl font-extrabold text-ink">{p.title}</h2>

      {checkout ? (
        <StreamPayCheckout url={checkout.url} paymentRef={checkout.ref} onDone={onDone} />
      ) : (
        <div className="rounded-[20px] bg-white p-6 text-start ring-1 ring-black/[0.05]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-md bg-[#eef3f7] px-2 py-1 text-left leading-none">
              <span className="block text-[10px] font-bold text-[#1a3668]">مدى</span>
              <span className="block text-[12px] font-extrabold tracking-tight">
                <span className="text-[#84bd00]">ma</span>
                <span className="text-[#00a1e0]">da</span>
              </span>
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/pay/mastercard.webp" alt="Mastercard" className="h-7 w-auto" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/pay/apple.webp" alt="Apple Pay" className="h-6 w-auto" />
          </div>
          <p className="mt-3 text-[13px] text-ink/55">{p.methodsNote}</p>
        </div>
      )}
    </section>
  );
}
