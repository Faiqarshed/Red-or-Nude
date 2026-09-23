// "Added to your visit": the email after buying from the chair (lib/station-treat.ts).
//
// To the customer on the booking, not to whoever scanned: the token proves
// presence at a table, and this is her visit. Failure-isolated like the other
// receipts — the items are already on her visit whether or not the mail lands.

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, payments } from "@/lib/db/schema";
import { esc } from "@/lib/email/html";
import { brandedEmail, INK, RED, sendReceipt, side, textTail } from "@/lib/email/shell";
import { formatSAR } from "@/lib/money";
import { taxInvoicePdf } from "@/lib/payments/invoice-pdf";
import type { TreatItem } from "@/lib/payments/purchase";
import { TIMEZONE } from "@/lib/time";

type Lang = "ar" | "en";

const T = {
  ar: {
    subject: "أُضيفت إلى زيارتك في ريد أور نيود",
    title: "تمت الإضافة إلى زيارتك",
    greeting: (name: string | null) => (name ? `أهلاً ${name}،` : "أهلاً،"),
    intro: "شكراً لكِ! أضفنا هذه إلى زيارتك اليوم:",
    extraMin: (n: number) => `+${n} دقيقة`,
    paid: "المبلغ المدفوع",
    sar: "ر.س",
    vatNote: "الأسعار شاملة ضريبة القيمة المضافة.",
    howTo: "المشروبات تصلك إلى طاولتك، والإضافات تُنجز قبل انتهاء موعدك.",
    newEnd: (t: string) => `موعدك ينتهي الآن الساعة ${t}.`,
  },
  en: {
    subject: "Added to your Red or Nude visit",
    title: "Added to your visit",
    greeting: (name: string | null) => (name ? `Hi ${name},` : "Hi,"),
    intro: "Thank you! We've added these to your visit today:",
    extraMin: (n: number) => `+${n} min`,
    paid: "Paid",
    sar: "SAR",
    vatNote: "All prices include VAT.",
    howTo: "Treats come to your table, and add-ons are done before you finish.",
    newEnd: (t: string) => `Your appointment now finishes at ${t}.`,
  },
};

export type VisitEmailInput = {
  customerName: string | null;
  lang: Lang;
  items: TreatItem[];
  /** Her finish time after the add-ons, when they moved it. */
  endsAt: Date | null;
  taxInvoiceUrl: string | null;
  pdfAttached: boolean;
};

export function renderVisitEmail(input: VisitEmailInput) {
  const { lang, items } = input;
  const t = T[lang];
  const { start, end } = side(lang);
  const money = (h: number) => `${formatSAR(h, { decimals: true })} ${t.sar}`;
  const total = money(items.reduce((n, i) => n + i.priceHalalas, 0));
  const endsAt = input.endsAt
    ? new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn" : "en-GB", { timeStyle: "short", timeZone: TIMEZONE }).format(input.endsAt)
    : null;
  const label = (i: TreatItem) => `${i.name[lang]}${i.durationMin > 0 ? ` (${t.extraMin(i.durationMin)})` : ""}`;

  const rows = items
    .map(
      (i) => `
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:14px;color:${INK};text-align:${start};">${esc(label(i))}</td>
          <td style="padding:9px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:14px;color:${INK};text-align:${end};" dir="ltr">${esc(money(i.priceHalalas))}</td>
        </tr>`,
    )
    .join("");

  const html = brandedEmail({
    lang,
    subject: t.subject,
    title: t.title,
    taxInvoiceUrl: input.taxInvoiceUrl,
    pdfAttached: input.pdfAttached,
    body: `
        <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:${INK};text-align:${start};">${esc(t.greeting(input.customerName))}</p>
        <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(t.intro)}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table>
        <p style="margin:12px 0 0;font-size:14px;font-weight:700;color:${INK};text-align:${start};">${esc(t.paid)}: <span dir="ltr" style="color:${RED};">${esc(total)}</span></p>
        <p style="margin:6px 0 0;font-size:11px;color:rgba(26,26,26,0.4);text-align:${start};">${esc(t.vatNote)}</p>
        <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(t.howTo)}${endsAt ? ` ${esc(t.newEnd(endsAt))}` : ""}</p>`,
  });

  const text = [
    t.greeting(input.customerName),
    t.intro,
    "",
    ...items.map((i) => `  ${label(i)}: ${money(i.priceHalalas)}`),
    "",
    `${t.paid}: ${total}`,
    t.vatNote,
    "",
    endsAt ? `${t.howTo} ${t.newEnd(endsAt)}` : t.howTo,
    ...textTail(lang, input.taxInvoiceUrl, input.pdfAttached),
  ].join("\n");

  return { subject: t.subject, html, text };
}

/** Tell her what was added to her visit. Never throws. */
export async function sendVisitEmail(bookingId: string, paymentId: string, items: TreatItem[]): Promise<void> {
  try {
    const [b] = await db
      .select({ customerId: bookings.customerId, endsAt: bookings.endsAt })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .limit(1);
    if (!b?.customerId) return;
    const [customer] = await db.select().from(customers).where(eq(customers.id, b.customerId)).limit(1);
    const to = customer?.email?.trim();
    if (!to) return;
    const [payment] = await db.select({ raw: payments.raw }).from(payments).where(eq(payments.id, paymentId)).limit(1);
    const url = (payment?.raw as { invoiceUrl?: unknown } | null)?.invoiceUrl;
    const invoiceUrl = typeof url === "string" ? url : null;
    const pdf = await taxInvoicePdf(invoiceUrl);

    const { subject, html, text } = renderVisitEmail({
      customerName: customer.name,
      lang: customer.lang,
      items,
      endsAt: items.some((i) => i.durationMin > 0) ? b.endsAt : null,
      taxInvoiceUrl: invoiceUrl,
      pdfAttached: !!pdf,
    });
    await sendReceipt("visit-addition", { to, toName: customer.name, subject, html, text, attachments: pdf ? [pdf] : undefined });
  } catch (err) {
    console.error("[visit] could not build or send the visit email", err);
  }
}
