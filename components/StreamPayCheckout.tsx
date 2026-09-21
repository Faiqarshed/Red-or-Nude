"use client";

// StreamPay's checkout, embedded where the card form used to be.
//
// The card number never touches this origin: StreamPay's Embed SDK renders the
// payment link in its own iframe (docs.streampay.sa/embedded-checkout). All
// this component does is mount it and poll /api/payments/status until it is
// decided — that endpoint asks StreamPay itself, so nothing in the browser is
// trusted to say "paid". If the SDK will not load, the whole page goes to the
// hosted checkout instead and comes back as `back?paid=<ref>`, which
// usePaymentReturn picks up.

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    Stream?: { Checkout(opts: { paymentLink: string; container: string | Element }): void };
  }
}

const SDK = "https://stream-embed.streampay.sa/sdk/embed.min.js";

export type PaymentOutcome =
  | { status: "paid"; result: Record<string, unknown> & { kind: string } }
  | { status: "failed"; error: string };

let sdk: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  if (window.Stream) return Promise.resolve();
  sdk ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      sdk = null;
      reject(new Error("streampay-sdk"));
    };
    document.head.appendChild(s);
  });
  return sdk;
}

/**
 * Ask every 3 seconds until it is decided, or until `alive()` says stop.
 * `maxTries` bounds the wait after a return, where it should settle at once.
 */
async function pollPayment(ref: string, alive: () => boolean, maxTries = Infinity): Promise<PaymentOutcome | null> {
  for (let i = 0; i < maxTries && alive(); i++) {
    try {
      const res = await fetch(`/api/payments/status?ref=${encodeURIComponent(ref)}`, { cache: "no-store" });
      const data = await res.json();
      if (data.status === "paid" || data.status === "failed") return data;
    } catch {
      /* a blip; ask again */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return alive() ? { status: "failed", error: "unconfirmed" } : null;
}

export default function StreamPayCheckout({
  url,
  paymentRef,
  onDone,
}: {
  url: string;
  paymentRef: string;
  onDone: (outcome: PaymentOutcome) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let alive = true;
    loadSdk()
      .then(() => {
        if (!alive || !box.current || !window.Stream) return;
        box.current.innerHTML = "";
        window.Stream.Checkout({ paymentLink: url, container: box.current });
      })
      // No SDK (blocked, offline CDN): the hosted page does the same job.
      .catch(() => {
        if (alive) window.location.href = url;
      });
    void pollPayment(paymentRef, () => alive).then((o) => o && alive && done.current(o));
    return () => {
      alive = false;
    };
  }, [url, paymentRef]);

  return <div ref={box} className="min-h-[320px] overflow-hidden rounded-[20px] bg-white" />;
}

/**
 * The page came back from the hosted checkout as `...?paid=<ref>`. Settle that
 * and hand the outcome over, once, then drop the param so a reload does not
 * replay it.
 */
export function usePaymentReturn(onDone: (outcome: PaymentOutcome) => void) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("paid");
    if (!ref) return;
    params.delete("paid");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    void pollPayment(ref, () => true, 20).then((o) => o && done.current(o));
  }, []);
}
