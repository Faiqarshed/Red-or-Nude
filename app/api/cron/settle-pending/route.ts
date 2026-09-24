// Settles checkouts nobody came back for (lib/payments/reconcile.ts).
//
// vercel.json calls it every two days with `?report=1`, which also mails
// PAYMENTS_ALERT_EMAIL anything a person has to refund by hand. Safe to run any
// number of times, concurrently — settle is idempotent — so it can also be
// called by hand: curl -H "Authorization: Bearer $CRON_SECRET" <site>/api/cron/settle-pending

import { NextResponse } from "next/server";
import { reconcilePayments, reportPaymentProblems } from "@/lib/payments/reconcile";
import { cronDenied } from "@/lib/cron";
import { archiveRetiredProducts } from "@/lib/payments/streampay";

export const dynamic = "force-dynamic";
// A run talks to StreamPay once or twice per stale checkout; the loop stops
// starting new ones at 40 s.
export const maxDuration = 60;

export async function GET(request: Request) {
  // Anyone can call a public URL; this keeps it to our clock.
  const denied = cronDenied(request);
  if (denied) return denied;

  const result = await reconcilePayments();
  // Products replaced or switched off over an hour ago (lib/payments/streampay.ts).
  const archived = await archiveRetiredProducts().catch((err) => {
    console.error("[cron] could not archive retired StreamPay products", err);
    return 0;
  });
  const problems = new URL(request.url).searchParams.has("report") ? await reportPaymentProblems() : undefined;

  // "Still running" to an outside monitor (healthchecks.io). The job is the net
  // under every payment; if it stops — a wrong secret, a broken deploy — the
  // monitor emails when this ping does not arrive, instead of nobody noticing.
  const ping = process.env.HEALTHCHECK_URL?.trim();
  if (ping) await fetch(ping, { signal: AbortSignal.timeout(5_000) }).catch(() => {});

  return NextResponse.json({ ok: true, ...result, archived, problems });
}
