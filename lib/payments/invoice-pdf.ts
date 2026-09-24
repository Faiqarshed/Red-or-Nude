// StreamPay's tax invoice as a PDF, attached to our receipts.
//
// Not in their public API (PaymentDto.pdf_link comes back null). This is what
// the Download button on StreamPay's own invoice page calls, and it needs no
// key. Because it is undocumented it is best-effort: any failure returns null,
// the email says the PDF could not be attached and keeps the link, and the
// owner is told once an hour so a changed endpoint gets noticed.

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { payments } from "@/lib/db/schema";
import { activeTransport } from "@/lib/email";
import { alertOwner } from "./alert";
import { base } from "./streampay";

export type PdfAttachment = { filename: string; content: Buffer };

/** The tax invoice a paid payment carries (verify() saved its link): the link, and the PDF when it could be fetched. */
export async function taxInvoiceOf(paymentId: string): Promise<{ url: string | null; pdf: PdfAttachment | null }> {
  const [payment] = await db.select({ raw: payments.raw }).from(payments).where(eq(payments.id, paymentId)).limit(1);
  const url = (payment?.raw as { invoiceUrl?: unknown } | null)?.invoiceUrl;
  const link = typeof url === "string" ? url : null;
  return { url: link, pdf: await taxInvoicePdf(link) };
}

/** Their page polls for up to 60 s; ours runs inside a payment request. */
const WAIT_MS = 20_000;
const POLL_MS = 2_000;
const MAX_BYTES = 5_000_000;

export async function taxInvoicePdf(invoiceUrl: string | null): Promise<PdfAttachment | null> {
  // No mail going out, nothing to attach it to: don't make her wait for it.
  if (!invoiceUrl || activeTransport() === "none") return null;
  const deadline = Date.now() + WAIT_MS;
  const within = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  try {
    // The short link redirects to the invoice page; its address carries the consent id.
    const page = await fetch(invoiceUrl, { cache: "no-store", signal: within() });
    await page.body?.cancel();
    const consent = /\/invoice-consent\/([0-9a-f-]{36})/i.exec(page.url)?.[1];
    if (!consent) throw new Error(`no consent id in ${page.url}`);

    while (Date.now() < deadline) {
      const res = await fetch(`${base()}/api/v2/consumer_portal/consent/${consent}/payment-pdf`, {
        cache: "no-store",
        signal: within(),
      });
      const body = res.ok ? ((await res.json()) as { status?: string; pdf_link?: string }) : null;
      if (body?.status === "completed" && body.pdf_link?.startsWith("https://")) {
        const file = await fetch(body.pdf_link, { cache: "no-store", signal: within() });
        const content = Buffer.from(await file.arrayBuffer());
        if (!file.ok || content.length > MAX_BYTES || content.subarray(0, 5).toString() !== "%PDF-") {
          throw new Error(`not a PDF (${file.status}, ${content.length} bytes)`);
        }
        return { filename: "tax-invoice.pdf", content };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(`not ready after ${WAIT_MS / 1000} s`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await alertOwner("invoice-pdf", "tax invoice PDF not attached", `${invoiceUrl}: ${why}\nThe email went out with the link instead.`);
    return null;
  }
}
