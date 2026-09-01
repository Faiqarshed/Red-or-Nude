// The invoice email itself — HTML and a plain-text twin.
//
// Written for mail clients, not browsers: tables for layout, inline styles only,
// no flexbox/grid, no web fonts, no external images. Gmail strips <style> blocks
// in some views and Outlook's renderer is Word's, so anything cleverer than this
// arrives broken for a share of customers.
//
// Direction follows the customer's language — the whole document flips to RTL
// for Arabic, which is why alignment is expressed as `start`/`end` variables
// rather than hardcoded left/right.

import type { Localized } from "@/lib/db/schema";
import { formatSAR } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import type { InvoiceData } from "./data";

const RED = "#b80007";
const INK = "#1a1a1a";
const CREAM = "#fdf8f4";

type Lang = "ar" | "en";

const T = {
  ar: {
    subject: (n: string) => `فاتورتك من ريد أور نيود — ${n}`,
    preview: "فاتورة حجزك، وتفاصيل موعدك.",
    title: "فاتورة ضريبية مبسطة",
    greeting: (name: string | null) => (name ? `أهلاً ${name}،` : "أهلاً،"),
    intro: "تم استلام دفعتك وتأكيد حجزك. هذه فاتورتك:",
    invoiceNo: "رقم الفاتورة",
    issuedAt: "تاريخ الإصدار",
    appointment: "موعدك",
    method: "طريقة الدفع",
    reference: "الرقم المرجعي",
    guest: (i: number) => `الضيفة ${i}`,
    ticket: "رقم التذكرة",
    station: "الكرسي",
    technician: "الفنية",
    item: "البند",
    amount: "المبلغ (ر.س)",
    lineTotal: "الإجمالي",
    discount: "خصم الحجز الثنائي",
    promoDiscount: (code: string) => `خصم (${code})`,
    subtotal: "المجموع قبل الضريبة",
    vat: (p: number) => `ضريبة القيمة المضافة ${p}٪`,
    total: "الإجمالي المدفوع",
    vatNote: "الأسعار شاملة ضريبة القيمة المضافة.",
    vatNumber: "الرقم الضريبي",
    footer: "هذه رسالة آلية، يُرجى عدم الرد عليها.",
    methods: { card: "بطاقة ائتمانية", mada: "مدى", stc: "STC Pay", apple: "Apple Pay" },
  },
  en: {
    subject: (n: string) => `Your Red or Nude invoice — ${n}`,
    preview: "Your booking invoice and appointment details.",
    title: "Simplified Tax Invoice",
    greeting: (name: string | null) => (name ? `Hi ${name},` : "Hi,"),
    intro: "We've received your payment and your booking is confirmed. Here's your invoice:",
    invoiceNo: "Invoice no.",
    issuedAt: "Issued",
    appointment: "Appointment",
    method: "Payment method",
    reference: "Reference",
    guest: (i: number) => `Guest ${i}`,
    ticket: "Ticket",
    station: "Chair",
    technician: "Technician",
    item: "Item",
    amount: "Amount (SAR)",
    lineTotal: "Total",
    discount: "Group booking discount",
    promoDiscount: (code: string) => `Discount (${code})`,
    subtotal: "Subtotal (excl. VAT)",
    vat: (p: number) => `VAT ${p}%`,
    total: "Total paid",
    vatNote: "All prices are VAT-inclusive.",
    vatNumber: "VAT no.",
    footer: "This is an automated message — please don't reply.",
    methods: { card: "Credit / debit card", mada: "Mada", stc: "STC Pay", apple: "Apple Pay" },
  },
} satisfies Record<Lang, Record<string, unknown>>;

/** Customer data lands inside an HTML document — never interpolate it raw. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const pick = (value: Localized | null, lang: Lang): string => value?.[lang] ?? "";

export type RenderedEmail = { subject: string; html: string; text: string };

export function renderInvoiceEmail(data: InvoiceData): RenderedEmail {
  const lang = data.customer.lang;
  const t = T[lang];
  const rtl = lang === "ar";
  const dir = rtl ? "rtl" : "ltr";
  const start = rtl ? "right" : "left";
  const end = rtl ? "left" : "right";

  const money = (h: number) => formatSAR(h, { decimals: true });
  const methodLabel = data.method ? t.methods[data.method] : "—";
  const multi = data.guests.length > 1;

  // One line for everything taken off, named after the code when there was one.
  // A guest on a group booking with a promo has both inside this figure; the
  // booking row stores them added together, so the invoice reports them that way
  // rather than inventing a split it cannot substantiate.
  const discountLabel = data.promoCode ? t.promoDiscount(data.promoCode) : t.discount;

  // ---- HTML ---------------------------------------------------------------

  const metaRow = (label: string, value: string) => `
    <tr>
      <td style="padding:6px 0;font-size:13px;color:rgba(26,26,26,0.5);text-align:${start};">${esc(label)}</td>
      <td style="padding:6px 0;font-size:13px;font-weight:600;color:${INK};text-align:${end};" dir="ltr">${esc(value)}</td>
    </tr>`;

  const guestBlocks = data.guests
    .map((g, i) => {
      const lines = g.lines
        .map(
          (l) => `
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:14px;color:${INK};text-align:${start};">${esc(pick(l.label, lang))}</td>
          <td style="padding:9px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:14px;color:${INK};text-align:${end};" dir="ltr">${esc(money(l.amountHalalas))}</td>
        </tr>`,
        )
        .join("");

      const discount =
        g.discountHalalas > 0
          ? `
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:14px;color:${RED};text-align:${start};">${esc(discountLabel)}</td>
          <td style="padding:9px 0;border-bottom:1px solid rgba(0,0,0,0.05);font-size:14px;font-weight:600;color:${RED};text-align:${end};" dir="ltr">−${esc(money(g.discountHalalas))}</td>
        </tr>`
          : "";

      const heading = multi
        ? `<p style="margin:0 0 10px;font-size:14px;font-weight:700;color:${RED};text-align:${start};">${esc(t.guest(i + 1))}</p>`
        : "";

      const chips = [
        g.ticketNo ? `${t.ticket}: <strong>${esc(g.ticketNo)}</strong>` : null,
        g.stationLabel ? `${t.station}: <strong>${esc(g.stationLabel)}</strong>` : null,
        g.technicianName ? `${t.technician}: <strong>${esc(g.technicianName)}</strong>` : null,
        `${t.reference}: <strong>${esc(g.code)}</strong>`,
      ]
        .filter(Boolean)
        .join(" &nbsp;·&nbsp; ");

      return `
      <div style="margin:0 0 18px;padding:18px;background:${CREAM};border-radius:14px;">
        ${heading}
        <p style="margin:0 0 12px;font-size:12px;color:rgba(26,26,26,0.55);text-align:${start};">${chips}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td style="padding:0 0 8px;font-size:11px;letter-spacing:0.05em;text-transform:uppercase;color:rgba(26,26,26,0.4);text-align:${start};">${esc(t.item)}</td>
            <td style="padding:0 0 8px;font-size:11px;letter-spacing:0.05em;text-transform:uppercase;color:rgba(26,26,26,0.4);text-align:${end};">${esc(t.amount)}</td>
          </tr>
          ${lines}
          ${discount}
          <tr>
            <td style="padding:10px 0 0;font-size:14px;font-weight:700;color:${INK};text-align:${start};">${esc(t.lineTotal)}</td>
            <td style="padding:10px 0 0;font-size:14px;font-weight:700;color:${INK};text-align:${end};" dir="ltr">${esc(money(g.totalHalalas))}</td>
          </tr>
        </table>
      </div>`;
    })
    .join("");

  const totalsRow = (label: string, value: string, strong = false) => `
    <tr>
      <td style="padding:7px 0;font-size:${strong ? "16px" : "13px"};font-weight:${strong ? "700" : "400"};color:${strong ? INK : "rgba(26,26,26,0.55)"};text-align:${start};">${esc(label)}</td>
      <td style="padding:7px 0;font-size:${strong ? "16px" : "13px"};font-weight:${strong ? "700" : "600"};color:${strong ? RED : INK};text-align:${end};" dir="ltr">${esc(value)}</td>
    </tr>`;

  const sellerLines = [
    data.seller.name,
    pick(data.seller.branchName, lang),
    pick(data.seller.branchAddress, lang),
    data.seller.vatNumber ? `${t.vatNumber}: ${data.seller.vatNumber}` : null,
  ].filter(Boolean) as string[];

  const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.subject(data.number))}</title>
</head>
<body style="margin:0;padding:0;background:#f4f0ec;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(t.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0ec;padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">

      <tr><td style="background:${RED};padding:26px 28px;">
        <p style="margin:0;font-size:20px;font-weight:800;color:#ffffff;text-align:${start};">RED OR NUDE</p>
        <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.75);text-align:${start};">${esc(t.title)}</p>
      </td></tr>

      <tr><td style="padding:26px 28px 0;">
        <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:${INK};text-align:${start};">${esc(t.greeting(data.customer.name))}</p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(t.intro)}</p>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:22px;">
          ${metaRow(t.invoiceNo, data.number)}
          ${metaRow(t.issuedAt, formatDateTime(data.issuedAt, lang))}
          ${metaRow(t.appointment, formatDateTime(data.startsAt, lang))}
          ${metaRow(t.method, methodLabel)}
        </table>
      </td></tr>

      <tr><td style="padding:0 28px;">${guestBlocks}</td></tr>

      <tr><td style="padding:0 28px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:2px solid rgba(0,0,0,0.06);padding-top:8px;">
          ${totalsRow(t.subtotal, money(data.subtotalHalalas))}
          ${totalsRow(t.vat(data.vatPercent), money(data.vatHalalas))}
          ${totalsRow(t.total, money(data.totalHalalas), true)}
        </table>
        <p style="margin:10px 0 0;font-size:11px;color:rgba(26,26,26,0.4);text-align:${start};">${esc(t.vatNote)}</p>
      </td></tr>

      <tr><td style="padding:22px 28px 26px;">
        <div style="border-top:1px solid rgba(0,0,0,0.06);padding-top:16px;">
          ${sellerLines
            .map(
              (line) =>
                `<p style="margin:0 0 3px;font-size:12px;color:rgba(26,26,26,0.45);text-align:${start};">${esc(line)}</p>`,
            )
            .join("")}
          <p style="margin:12px 0 0;font-size:11px;color:rgba(26,26,26,0.35);text-align:${start};">${esc(t.footer)}</p>
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  // ---- plain text ---------------------------------------------------------

  const textLines: string[] = [
    t.title.toUpperCase(),
    "",
    t.greeting(data.customer.name),
    t.intro,
    "",
    `${t.invoiceNo}: ${data.number}`,
    `${t.issuedAt}: ${formatDateTime(data.issuedAt, lang)}`,
    `${t.appointment}: ${formatDateTime(data.startsAt, lang)}`,
    `${t.method}: ${methodLabel}`,
    "",
  ];

  for (const [i, g] of data.guests.entries()) {
    if (multi) textLines.push(`— ${t.guest(i + 1)} —`);
    if (g.ticketNo) textLines.push(`${t.ticket}: ${g.ticketNo}`);
    if (g.stationLabel) textLines.push(`${t.station}: ${g.stationLabel}`);
    if (g.technicianName) textLines.push(`${t.technician}: ${g.technicianName}`);
    textLines.push(`${t.reference}: ${g.code}`);
    for (const l of g.lines) textLines.push(`  ${pick(l.label, lang)}  ${money(l.amountHalalas)}`);
    if (g.discountHalalas > 0) textLines.push(`  ${discountLabel}  −${money(g.discountHalalas)}`);
    textLines.push(`  ${t.lineTotal}: ${money(g.totalHalalas)}`, "");
  }

  textLines.push(
    `${t.subtotal}: ${money(data.subtotalHalalas)}`,
    `${t.vat(data.vatPercent)}: ${money(data.vatHalalas)}`,
    `${t.total}: ${money(data.totalHalalas)} SAR`,
    "",
    t.vatNote,
    "",
    ...sellerLines,
    "",
    t.footer,
  );

  return { subject: t.subject(data.number), html, text: textLines.join("\n") };
}
