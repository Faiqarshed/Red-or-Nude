// StreamPay's tax invoice PDF (lib/payments/invoice-pdf.ts), with their three
// hops faked: short link → invoice page, consent → pdf_link, pdf_link → file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taxInvoicePdf } from "@/lib/payments/invoice-pdf";

const CONSENT = "f3aabb8b-32ee-4e72-8e5e-9ae49d8e9b34";

function streampay(file: string) {
  return vi.fn(async (url: string) => {
    if (url.includes("/s/")) {
      const page = new Response("<html></html>");
      Object.defineProperty(page, "url", { value: `https://billing.streampay.sa/v2/invoice-consent/${CONSENT}?organization_id=x` });
      return page;
    }
    if (url.includes(`/consent/${CONSENT}/payment-pdf`)) {
      return Response.json({ status: "completed", pdf_link: "https://storage.googleapis.com/inv.pdf" });
    }
    return new Response(file);
  });
}

describe("tax invoice PDF", () => {
  beforeEach(() => {
    vi.stubEnv("SMTP_HOST", "smtp.test");
    vi.stubEnv("SMTP_USER", "u");
    vi.stubEnv("SMTP_PASSWORD", "p");
    vi.stubEnv("PAYMENTS_ALERT_EMAIL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("follows the invoice link to the PDF and returns the file", async () => {
    vi.stubGlobal("fetch", streampay("%PDF-1.7 invoice"));
    const pdf = await taxInvoicePdf("https://streampay.sa/s/puMKb");
    expect(pdf?.filename).toBe("tax-invoice.pdf");
    expect(pdf?.content.toString()).toBe("%PDF-1.7 invoice");
  });

  it("gives up (so the email says so) when what comes back is not a PDF", async () => {
    vi.stubGlobal("fetch", streampay("<html>expired</html>"));
    expect(await taxInvoicePdf("https://streampay.sa/s/puMKb")).toBeNull();
  });

  it("doesn't fetch at all without a link or without mail", async () => {
    const fetch = streampay("%PDF-");
    vi.stubGlobal("fetch", fetch);
    expect(await taxInvoicePdf(null)).toBeNull();
    vi.stubEnv("SMTP_HOST", "");
    expect(await taxInvoicePdf("https://streampay.sa/s/puMKb")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
