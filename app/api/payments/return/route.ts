// Where StreamPay sends the payer when the checkout ends, paid or not.
//
// Settles first — asking StreamPay, never believing the URL — so the booking is
// confirmed even if the page that opened the checkout is gone. Inside the
// embed's iframe that is all: the page around it is already polling
// /api/payments/status. Full-window (a bank page that broke out of the frame,
// or the no-SDK fallback), it sends her back to `back?paid=<ref>`.

import { z } from "zod";
import { settlePayment } from "@/lib/payments/settle";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ref = z.string().uuid().safeParse(url.searchParams.get("ref"));
  if (ref.success) {
    await settlePayment(ref.data).catch((err) => console.error("[payments] return settle failed", err));
  }

  // Only a path on this site — an absolute URL would make this an open redirect.
  // `\` too: browsers read `/\evil.com` as `//evil.com`.
  const b = url.searchParams.get("back") ?? "/";
  const back = /^\/(?![\/\\])/.test(b) ? b : "/";
  // StreamPay appends its own `status` (paid | failed …). Only a hint for the
  // page's message — the page still asks /api/payments/status before believing
  // anything, so a hand-edited URL cannot confirm a booking.
  // Its `message` is the bank's reason ("3DS: Card authentication declined.") —
  // the only one we get, since a failed attempt leaves no record at StreamPay.
  const why = (url.searchParams.get("message") ?? "").slice(0, 200);
  const declined =
    ref.success && (url.searchParams.get("status") ?? "paid") !== "paid"
      ? `&declined=1${why ? `&why=${encodeURIComponent(why)}` : ""}`
      : "";
  const to = ref.success ? `${back}${back.includes("?") ? "&" : "?"}paid=${ref.data}${declined}` : back;

  // `<` escaped so a crafted `back` cannot close the script tag.
  const js = JSON.stringify(to).replace(/</g, "\u003c");
  return new Response(`<!doctype html><script>if (window.top === window) location.replace(${js});</script>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
