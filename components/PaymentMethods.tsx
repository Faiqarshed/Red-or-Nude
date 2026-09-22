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

/** mada, Visa, Mastercard, Apple Pay — what the checkout accepts, as marks. */
export function PayLogos({ small = false }: { small?: boolean }) {
  const h = small ? "h-5" : "h-7";
  return (
    <div dir="ltr" className="flex flex-wrap items-center gap-2.5">
      <span className="rounded-md bg-[#eef3f7] px-2 py-1 text-left leading-none">
        <span className={`block font-bold text-[#1a3668] ${small ? "text-[8px]" : "text-[10px]"}`}>مدى</span>
        <span className={`block font-extrabold tracking-tight ${small ? "text-[10px]" : "text-[12px]"}`}>
          <span className="text-[#84bd00]">ma</span>
          <span className="text-[#00a1e0]">da</span>
        </span>
      </span>
      <span
        aria-label="Visa"
        className={`grid place-items-center rounded-md bg-white px-2 font-extrabold italic tracking-tight text-[#1a1f71] ring-1 ring-black/10 ${
          small ? "h-5 text-[11px]" : "h-7 text-[15px]"
        }`}
      >
        VISA
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/pay/mastercard.webp" alt="Mastercard" className={`${h} w-auto`} />
      {/* The full Apple Pay mark, not the bare apple: the apple alone reads as
          "Apple", and the payment method is Apple Pay. */}
      <span
        aria-label="Apple Pay"
        className={`flex items-center gap-[2px] rounded-md bg-black px-2 font-semibold text-white ${
          small ? "h-5 text-[11px]" : "h-7 text-[14px]"
        }`}
      >
        <svg aria-hidden viewBox="0 0 24 24" className={small ? "h-3 w-3" : "h-4 w-4"} fill="currentColor">
          <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
        </svg>
        Pay
      </span>
    </div>
  );
}

export default function PaymentMethods({
  checkout,
  onDone,
  autoScroll,
  heading = true,
}: {
  checkout: { ref: string; url: string } | null;
  onDone: (outcome: PaymentOutcome) => void;
  autoScroll?: boolean;
  /** Off where the page already titles this panel. */
  heading?: boolean;
}) {
  const { c } = useI18n();
  const p = c.payment;

  return (
    <section>
      {heading && <h2 className="mb-6 text-start font-display text-2xl font-extrabold text-ink">{p.title}</h2>}

      {checkout ? (
        <StreamPayCheckout url={checkout.url} paymentRef={checkout.ref} onDone={onDone} autoScroll={autoScroll} />
      ) : (
        <div className="rounded-[20px] bg-white p-6 text-start ring-1 ring-black/[0.05]">
          <PayLogos />
          <p className="mt-3 text-[13px] text-ink/55">{p.methodsNote}</p>
        </div>
      )}
    </section>
  );
}
