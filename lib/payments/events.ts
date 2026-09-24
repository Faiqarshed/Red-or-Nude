import "server-only";

// The payment log's second writer (the first is the trigger on `payments`, see
// paymentEvents in lib/db/schema.ts): what happens that is not a payment row
// changing. A webhook arriving, an alert, a refund StreamPay refused, a settle
// run, a StreamPay product made or archived, a receipt sent.

import { db } from "@/lib/db";
import { paymentEvents } from "@/lib/db/schema";

/** What went wrong, as text a log can hold (an Error serialises to `{}`). */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Never throws: a record of what happened must not be able to stop it happening. */
export async function logPaymentEvent(kind: string, detail: Record<string, unknown>, ref?: string | null): Promise<void> {
  try {
    await db.insert(paymentEvents).values({ kind, detail, providerRef: ref ?? null });
  } catch (err) {
    console.error(`[payments] could not log ${kind}`, err);
  }
}
