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

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { Content } from "@/lib/dictionary";
import { declineReason, type DeclineReason } from "@/lib/payments/decline";

declare global {
  interface Window {
    Stream?: { Checkout(opts: { paymentLink: string; container: string | Element }): void };
  }
}

const SDK = "https://stream-embed.streampay.sa/sdk/embed.min.js";

export type PaymentOutcome =
  | { status: "paid"; result: Record<string, unknown> & { kind: string } }
  | {
      status: "failed";
      error: string;
      /** Declined, but the same checkout can still be paid — re-open it. */
      checkout?: { ref: string; url: string };
      /** Why, when the bank said: see declineMessage. */
      reason?: DeclineReason;
    };

/** The customer-facing line for a decline, or null when the bank gave no reason. */
export function declineMessage(d: Content["payDecline"], o: PaymentOutcome): string | null {
  if (o.status !== "failed" || !o.reason) return null;
  return d[o.reason];
}

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
 * Ask every 3 seconds for a minute, then every 10, until it is decided or
 * `alive()` says stop.
 * `maxTries` bounds the wait after a return, where it should settle at once.
 * `declined`: StreamPay sent her back saying it failed, with the bank's words
 * ("" when it gave none). A checkout still open then means "try another card",
 * not "still processing" — answered at once, with the reason.
 */
async function pollPayment(
  ref: string,
  alive: () => boolean,
  maxTries = Infinity,
  declined: string | null = null,
  /** Set here while waiting between asks: calling it asks again now. */
  wake: { now: () => void } = { now: () => {} },
): Promise<PaymentOutcome | null> {
  for (let i = 0; i < maxTries && alive(); i++) {
    try {
      const res = await fetch(`/api/payments/status?ref=${encodeURIComponent(ref)}`, { cache: "no-store" });
      const data = await res.json();
      if (data.status === "paid" || data.status === "failed") return data;
      if (declined !== null && data.status === "pending") {
        return {
          status: "failed",
          error: "payment-declined",
          checkout: data.checkout,
          reason: declineReason(declined),
        };
      }
    } catch {
      /* a blip; ask again */
    }
    await new Promise<void>((r) => {
      const t = setTimeout(r, i < 20 ? 3000 : 10_000);
      wake.now = () => {
        clearTimeout(t);
        r();
      };
    });
  }
  return alive() ? { status: "failed", error: "unconfirmed" } : null;
}

export default function StreamPayCheckout({
  url,
  paymentRef,
  onDone,
  onConfirming,
  onReady,
  autoScroll = true,
}: {
  url: string;
  paymentRef: string;
  onDone: (outcome: PaymentOutcome) => void;
  /** StreamPay said paid inside the embed: the page shows its loader until onDone. */
  onConfirming?: () => void;
  /** StreamPay's form has loaded in the embed (or it gave up waiting): stop hiding it. */
  onReady?: () => void;
  /** Off where the page scrolls itself, to keep what sits above the checkout in view. */
  autoScroll?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const confirming = useRef(onConfirming);
  confirming.current = onConfirming;
  const readyCb = useRef(onReady);
  readyCb.current = onReady;
  // StreamPay's checkout picks its language from `?language=` (ar | en); left
  // out, it opens in Arabic whatever the site is showing.
  const { lang } = useI18n();
  const link = new URL(url);
  link.searchParams.set("language", lang);
  const src = link.toString();

  useEffect(() => {
    // It appears below the fold once Pay is pressed; bring it into view.
    if (autoScroll) box.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    let alive = true;
    // Ready once the SDK's iframe has loaded. Ten seconds at most: a slow
    // form shown late beats a loader that never lifts.
    let readied = false;
    const ready = () => {
      if (readied || !alive) return;
      readied = true;
      readyCb.current?.();
    };
    const giveUp = setTimeout(ready, 10_000);
    const watch = new MutationObserver(() => {
      const frame = box.current?.querySelector("iframe");
      if (!frame) return;
      watch.disconnect();
      frame.addEventListener("load", ready, { once: true });
    });
    if (box.current) watch.observe(box.current, { childList: true, subtree: true });
    loadSdk()
      .then(() => {
        if (!alive || !box.current || !window.Stream) return;
        box.current.innerHTML = "";
        window.Stream.Checkout({ paymentLink: src, container: box.current });
      })
      // No SDK (blocked, offline CDN): the hosted page does the same job.
      .catch(() => {
        if (alive) window.location.href = src;
      });
    // Our return page, loaded inside the embed once she has paid, says so
    // (app/api/payments/return): ask now instead of at the next poll.
    const wake = { now: () => {} };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.streampayReturn !== paymentRef) return;
      if (e.data.paid) confirming.current?.();
      wake.now();
    };
    window.addEventListener("message", onMessage);
    void pollPayment(paymentRef, () => alive, Infinity, null, wake).then((o) => o && alive && done.current(o));
    return () => {
      alive = false;
      clearTimeout(giveUp);
      watch.disconnect();
      window.removeEventListener("message", onMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- autoScroll is read once, on mount
  }, [src, paymentRef]);

  // scroll-mt clears the fixed site header when it scrolls into view.
  return <div ref={box} className="min-h-[320px] scroll-mt-32 overflow-hidden rounded-[20px] bg-white" />;
}

/**
 * The page came back from the hosted checkout as `...?paid=<ref>`. Settle that
 * and hand the outcome over, once, then drop the params so a reload does not
 * replay it. True while it is still finding out, so the page can say so.
 *
 * `returning` is `?paid=` as the server saw it (the page's searchParams): the
 * page is then drawn with the loader already up, rather than showing the form
 * until its JavaScript runs.
 */
export function usePaymentReturn(onDone: (outcome: PaymentOutcome) => void, returning: boolean): boolean {
  const done = useRef(onDone);
  done.current = onDone;
  const [checking, setChecking] = useState(returning);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("paid");
    // Nothing to leave alone, not "not returning": in development React runs
    // this twice, and the second run, finding `?paid=` already dropped below,
    // took the loader down while the first run's check was still out — step 1
    // showed for seconds before step 2. `checking` starts from the server's
    // view of the URL, so it is only ever turned off by an answer.
    if (!ref) return;
    const declined = params.get("declined") === "1" ? (params.get("why") ?? "") : null;
    for (const k of ["paid", "declined", "why"]) params.delete(k);
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    setChecking(true);
    // ~11 minutes: past the hold window, by when StreamPay has answered or the
    // hold is gone. Giving up after one minute told her "unconfirmed" for what
    // was usually a payment StreamPay had not written down yet.
    void pollPayment(ref, () => true, 80, declined).then((o) => {
      // Paid: the loader stays up while the page leaves for the success popup,
      // instead of flashing the spent checkout on the way.
      if (o?.status !== "paid") setChecking(false);
      if (o) done.current(o);
    });
  }, []);
  return checking;
}
