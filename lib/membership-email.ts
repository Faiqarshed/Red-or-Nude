// The membership emails: the one sent when a membership is bought, and the
// "what you have left" block the booking confirmation carries when a credit
// paid for the booking (lib/invoice/template.ts).
//
// Same bargain as lib/giftcard/email.ts: server-rendered, sent over SMTP, and
// failure-isolated. The membership is hers the moment it is granted, so nothing
// here throws into the purchase.

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerPacks, customers, type Localized } from "@/lib/db/schema";
import { esc } from "@/lib/email/html";
import { brandedEmail, CREAM, INK, RED, sendReceipt, textTail } from "@/lib/email/shell";
import { formatSAR } from "@/lib/money";
import { taxInvoiceOf } from "@/lib/payments/invoice-pdf";
import { membershipsLeft, type MembershipLeft } from "@/lib/packs";
import { formatDate } from "@/lib/time";


type Lang = "ar" | "en";

const T = {
  ar: {
    subject: (pack: string) => `عضويتك في ريد أور نيود — ${pack}`,
    title: "تأكيد العضوية",
    greeting: (name: string | null) => (name ? `أهلاً ${name}،` : "أهلاً،"),
    intro: "شكراً لكِ! عضويتك مفعّلة الآن، وهذا ما تشمله:",
    leftOf: (left: number, granted: number) => `متبقٍ ${left} من ${granted}`,
    validUntil: (d: string) => `صالحة حتى ${d}`,
    paid: "المبلغ المدفوع",
    sar: "ر.س",
    howTo: "احجزي أياً من هذه الخدمات وأنتِ مسجلة الدخول، وسيُخصم الرصيد تلقائياً.",
    vatNote: "الأسعار شاملة ضريبة القيمة المضافة.",
  },
  en: {
    subject: (pack: string) => `Your Red or Nude membership — ${pack}`,
    title: "Membership confirmed",
    greeting: (name: string | null) => (name ? `Hi ${name},` : "Hi,"),
    intro: "Thank you! Your membership is active. Here's what it includes:",
    leftOf: (left: number, granted: number) => `${left} of ${granted} left`,
    validUntil: (d: string) => `Valid until ${d}`,
    paid: "Paid",
    sar: "SAR",
    howTo: "Book any of these services while signed in and the credit comes off by itself.",
    vatNote: "All prices include VAT.",
  },
} satisfies Record<Lang, Record<string, unknown>>;

const pick = (v: Localized | null, lang: Lang) => v?.[lang] ?? "";

/** One membership's balance, per service. Shared with the booking confirmation. */
export function membershipHtml(m: MembershipLeft, lang: Lang): string {
  const t = T[lang];
  const start = lang === "ar" ? "right" : "left";
  const end = lang === "ar" ? "left" : "right";
  const rows = m.lines
    .map(
      (l) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:14px;color:${INK};text-align:${start};">${esc(pick(l.serviceName, lang))}</td>
          <td style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:14px;font-weight:600;color:${l.left > 0 ? INK : "rgba(26,26,26,0.4)"};text-align:${end};">${esc(t.leftOf(l.left, l.granted))}</td>
        </tr>`,
    )
    .join("");
  return `
      <div style="margin:0 0 14px;padding:16px 18px;background:${CREAM};border-radius:14px;">
        <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:${RED};text-align:${start};">${esc(pick(m.packName, lang))}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table>
        <p style="margin:10px 0 0;font-size:12px;color:rgba(26,26,26,0.5);text-align:${start};">${esc(t.validUntil(formatDate(m.expiresAt, lang)))}</p>
      </div>`;
}

export function membershipText(m: MembershipLeft, lang: Lang): string[] {
  const t = T[lang];
  return [
    pick(m.packName, lang),
    ...m.lines.map((l) => `  ${pick(l.serviceName, lang)}: ${t.leftOf(l.left, l.granted)}`),
    `  ${t.validUntil(formatDate(m.expiresAt, lang))}`,
  ];
}

export type MembershipEmailInput = {
  customerName: string | null;
  lang: Lang;
  priceHalalas: number;
  taxInvoiceUrl: string | null;
  pdfAttached: boolean;
  membership: MembershipLeft;
};

export function renderMembershipEmail(input: MembershipEmailInput) {
  const { lang, membership: m } = input;
  const t = T[lang];
  const start = lang === "ar" ? "right" : "left";
  const paid = `${formatSAR(input.priceHalalas, { decimals: true })} ${t.sar}`;
  const subject = t.subject(pick(m.packName, lang));

  const html = brandedEmail({
    lang,
    subject,
    title: t.title,
    taxInvoiceUrl: input.taxInvoiceUrl,
    pdfAttached: input.pdfAttached,
    body: `
        <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:${INK};text-align:${start};">${esc(t.greeting(input.customerName))}</p>
        <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(t.intro)}</p>
        ${membershipHtml(m, lang)}
        <p style="margin:4px 0 0;font-size:14px;font-weight:700;color:${INK};text-align:${start};">${esc(t.paid)}: <span dir="ltr" style="color:${RED};">${esc(paid)}</span></p>
        <p style="margin:6px 0 0;font-size:11px;color:rgba(26,26,26,0.4);text-align:${start};">${esc(t.vatNote)}</p>
        <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(t.howTo)}</p>`,
  });

  const text = [
    t.greeting(input.customerName),
    t.intro,
    "",
    ...membershipText(m, lang),
    "",
    `${t.paid}: ${paid}`,
    t.vatNote,
    "",
    t.howTo,
    ...textTail(lang, input.taxInvoiceUrl, input.pdfAttached),
  ].join("\n");

  return { subject, html, text };
}

/**
 * Tell her what she bought. Never throws: she was charged and the membership
 * is granted, so a mail failure is logged loudly for a manual resend.
 */
export async function sendMembershipEmail(customerPackId: string, paymentId: string): Promise<void> {
  try {
    const [cp] = await db.select().from(customerPacks).where(eq(customerPacks.id, customerPackId)).limit(1);
    if (!cp) return;
    const [customer] = await db.select().from(customers).where(eq(customers.id, cp.customerId)).limit(1);
    const to = customer?.email?.trim();
    if (!to) return;
    const { url: invoiceUrl, pdf } = await taxInvoiceOf(paymentId);
    const [membership] = await membershipsLeft(cp.customerId, [cp.id]);
    if (!membership) return;

    const { subject, html, text } = renderMembershipEmail({
      customerName: customer.name,
      lang: customer.lang,
      priceHalalas: cp.priceHalalas,
      taxInvoiceUrl: invoiceUrl,
      pdfAttached: !!pdf,
      membership,
    });
    await sendReceipt("membership-purchase", { to, toName: customer.name, subject, html, text, attachments: pdf ? [pdf] : undefined });
  } catch (err) {
    console.error("[membership] could not build or send the membership email", err);
  }
}
