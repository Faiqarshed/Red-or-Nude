"use client";

// The two-step payment frame every checkout page shares: the step bar, the
// payment column (StreamPay's checkout and the reason the last attempt failed)
// and the two modals — checking on return from the bank, and a failed payment.

import { useEffect, useRef, useState } from "react";
import { PayLogos } from "./PaymentMethods";
import StreamPayCheckout, { type PaymentOutcome } from "./StreamPayCheckout";
import { ClockIcon, Lock } from "./icons";
import { useI18n } from "@/lib/i18n";

/** Step 2's main column: what to do, why the last try failed, and the checkout. */
export function PayStep({
  checkout,
  onDone,
  notice,
  info = null,
  sub,
}: {
  checkout: { ref: string; url: string; expiresAt?: string };
  onDone: (outcome: PaymentOutcome) => void;
  notice: string | null;
  /** Not a failure: said calmly, and only while there is no failure to say. */
  info?: string | null;
  sub: string;
}) {
  const { c } = useI18n();
  const p = c.payment;
  // The timer is the deadline, so reaching it ends this checkout here: StreamPay
  // does not (it took a card after its link's valid_until, sandbox 2026-09-25).
  // Ended as a failure with its own reason, so each page closes the form and
  // offers Pay again the way it does after a decline.
  const done = useRef(onDone);
  done.current = onDone;
  const timeUp = () => done.current({ status: "failed", error: "payment-declined", reason: "timedOut" });
  return (
    <section className="min-w-0 space-y-4">
      <div className="text-start">
        <h1 className="font-display text-2xl font-extrabold text-ink sm:text-3xl">{p.payTitle}</h1>
        <p className="mt-1.5 max-w-[560px] text-[13px] leading-relaxed text-ink/55 sm:text-sm">{sub}</p>
        {checkout.expiresAt && <TimeLeft until={checkout.expiresAt} onEnd={timeUp} />}
      </div>

      {notice && (
        <p role="alert" className="flex gap-2.5 rounded-[16px] bg-red/[0.07] px-4 py-3 text-start text-[13px] leading-relaxed text-red ring-1 ring-red/15">
          <span aria-hidden className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-red text-[11px] font-extrabold text-white">
            !
          </span>
          <span>{notice}</span>
        </p>
      )}

      {!notice && info && (
        <p role="status" className="flex gap-2.5 rounded-[16px] bg-ink/[0.04] px-4 py-3 text-start text-[13px] leading-relaxed text-ink/70 ring-1 ring-black/[0.06]">
          <span aria-hidden className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink/60 text-[11px] font-extrabold text-white">
            i
          </span>
          <span>{info}</span>
        </p>
      )}

      <div className="overflow-hidden rounded-[24px] bg-white p-2 shadow-[0_20px_50px_rgba(184,0,7,0.06)] ring-1 ring-black/[0.04] sm:p-4">
        <StreamPayCheckout url={checkout.url} paymentRef={checkout.ref} onDone={onDone} autoScroll={false} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="flex items-center gap-1.5 text-[12px] text-ink/50">
          <Lock className="h-3.5 w-3.5" />
          {p.secure}
        </p>
        <PayLogos small />
      </div>
    </section>
  );
}

/** How long this checkout stays payable. At 0:00 `onEnd` closes it. */
function TimeLeft({ until, onEnd }: { until: string; onEnd: () => void }) {
  const { c } = useI18n();
  const [left, setLeft] = useState(() => Date.parse(until) - Date.now());
  useEffect(() => {
    const tick = setInterval(() => setLeft(Date.parse(until) - Date.now()), 1000);
    return () => clearInterval(tick);
  }, [until]);
  const over = !(left > 0);
  const end = useRef(onEnd);
  end.current = onEnd;
  useEffect(() => {
    if (over) end.current();
  }, [over]);
  if (over) return null;
  const s = Math.floor(left / 1000);
  // The last minute in red: that is when it is worth hurrying.
  const last = s < 60;
  return (
    <div className="mt-3 inline-flex items-center gap-3 rounded-[16px] bg-white px-4 py-2.5 text-start shadow-[0_8px_24px_rgba(184,0,7,0.06)] ring-1 ring-black/[0.04]" aria-live="off">
      <ClockIcon className={`h-6 w-6 shrink-0 ${last ? "text-red" : "text-ink/50"}`} />
      <div>
        <p className="text-[12px] font-semibold text-ink/55">{c.payment.timeLeft}</p>
        <p className={`font-display text-2xl font-extrabold tabular-nums leading-tight ${last ? "text-red" : "text-ink"}`} dir="ltr">
          {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
        </p>
      </div>
      <p className="max-w-[200px] border-s border-black/[0.08] ps-3 text-[11px] leading-snug text-ink/50">{c.payment.timeLeftHint}</p>
    </div>
  );
}

/** "1 Details — 2 Payment": where she is, at a glance. */
export function Steps({ current, labels }: { current: 1 | 2; labels: [string, string] }) {
  return (
    <ol className="inline-flex items-center gap-2.5 rounded-full bg-white/80 px-4 py-2 text-[12px] font-semibold shadow-[0_8px_24px_rgba(184,0,7,0.06)] ring-1 ring-black/[0.04] sm:gap-3 sm:text-[13px]">
      {labels.map((label, i) => {
        const n = i + 1;
        const reached = n <= current;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={n === current ? "step" : undefined}>
            {i > 0 && <span aria-hidden className={`h-px w-6 sm:w-10 ${reached ? "bg-red" : "bg-black/15"}`} />}
            <span
              className={`grid h-6 w-6 place-items-center rounded-full text-[12px] ${
                reached ? "bg-red text-white" : "bg-black/[0.06] text-ink/45"
              }`}
            >
              {n}
            </span>
            <span className={n === current ? "text-ink" : "text-ink/45"}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Coming back from the bank: said in front, so the page behind never looks idle. */
export function CheckingModal() {
  const { c } = useI18n();
  const p = c.payment;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4 backdrop-blur-sm">
      <div role="status" className="w-full max-w-[360px] rounded-[24px] bg-white p-8 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]">
        <span aria-hidden className="mx-auto block h-12 w-12 animate-spin rounded-full border-[3px] border-red/15 border-t-red" />
        <p className="mt-5 font-display text-lg font-extrabold text-ink">{p.checkingPayment}</p>
        <p className="mt-1 text-[13px] text-ink/55">{p.checkingSub}</p>
      </div>
    </div>
  );
}

/**
 * A payment that did not complete, and why. In front of everything, because it
 * is the answer to the one thing she just did; the same words stay above the
 * checkout once this closes.
 */
export function PayNoticeModal({ message, retry, onClose }: { message: string; retry: boolean; onClose: () => void }) {
  const { c } = useI18n();
  const p = c.payment;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/30 px-4 py-10 backdrop-blur-sm"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pay-notice-title"
        aria-describedby="pay-notice-body"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] rounded-[24px] bg-white p-7 text-center shadow-[0_40px_100px_rgba(0,0,0,0.25)]"
      >
        <span aria-hidden className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-red/10 font-display text-2xl font-extrabold text-red">
          !
        </span>
        <h3 id="pay-notice-title" className="font-display text-xl font-extrabold text-ink">
          {p.payFailedTitle}
        </h3>
        <p id="pay-notice-body" className="mt-3 text-sm leading-relaxed text-ink/65">
          {message}
        </p>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="mt-6 w-full rounded-[12px] bg-red-grad py-3.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
        >
          {retry ? p.tryAgain : p.close}
        </button>
      </div>
    </div>
  );
}
