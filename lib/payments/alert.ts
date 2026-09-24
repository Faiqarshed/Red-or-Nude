// One email to the owner when a payment needs a person now, rather than in the
// daily report: money arriving on a payment we had written off, a status we do
// not recognise, StreamPay not answering.

import "server-only";
import { sendMail } from "@/lib/email";
import { esc } from "@/lib/email/html";

const sent = new Map<string, number>();

/**
 * At most one email per `key` an hour, so a problem that repeats every settle
 * run is one message. Never throws: an alert must not fail the payment path.
 *
 * ponytail: remembered per server instance, so several instances can each send
 * one. Move to a table if that ever becomes noise.
 */
export async function alertOwner(key: string, subject: string, text: string): Promise<void> {
  console.error(`[payments] ${subject}\n${text}`);
  const to = process.env.PAYMENTS_ALERT_EMAIL?.trim();
  const last = sent.get(key) ?? 0;
  if (!to || Date.now() - last < 3_600_000) return;
  sent.set(key, Date.now());
  try {
    await sendMail({ to, subject: `Payments: ${subject}`, text, html: `<pre>${esc(text)}</pre>`, tags: ["payments-alert"] });
  } catch (err) {
    console.error("[payments] alert email failed", err);
  }
}
