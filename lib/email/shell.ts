// The branded frame the short transactional emails share: red header, body,
// optional "View your tax invoice" button, footer. Written for mail clients —
// tables and inline styles only (see lib/invoice/template.ts for why).
//
// `body` is HTML the caller has already escaped.

import { esc } from "./html";
import { sendMail, type SendMailInput } from "./index";

export const RED = "#b80007";
export const INK = "#1a1a1a";
export const CREAM = "#fdf8f4";

type Lang = "ar" | "en";

const TAX = {
  ar: {
    taxInvoice: "عرض الفاتورة الضريبية",
    attached: "فاتورتك الضريبية مرفقة بهذه الرسالة (PDF)، وتصدر عن StreamPay، مزوّد خدمة الدفع لدينا.",
    notAttached: "تعذّر إرفاق فاتورتك الضريبية (PDF) بهذه الرسالة. يمكنك فتحها وتنزيلها من الزر أعلاه، وتصدر عن StreamPay، مزوّد خدمة الدفع لدينا.",
    footer: "هذه رسالة آلية، يُرجى عدم الرد عليها.",
  },
  en: {
    taxInvoice: "View your tax invoice",
    attached: "Your tax invoice is attached to this email as a PDF. It's issued by StreamPay, our payment provider.",
    notAttached: "We couldn't attach your tax invoice PDF to this email. You can open and download it with the button above. It's issued by StreamPay, our payment provider.",
    footer: "This is an automated message — please don't reply.",
  },
};

export const side = (lang: Lang) => (lang === "ar" ? { start: "right", end: "left" } : { start: "left", end: "right" });

/**
 * The "View your tax invoice" button and the line under it, which says whether
 * the PDF is attached. `pdfAttached` false with a url means the fetch failed
 * (lib/payments/invoice-pdf.ts), so she is told to use the button instead.
 */
export function taxInvoiceHtml(lang: Lang, url: string | null, pdfAttached: boolean, padding = "18px 28px 0"): string {
  if (!url) return "";
  const t = TAX[lang];
  return `      <tr><td style="padding:${padding};">
        <a href="${esc(url)}" style="display:block;padding:13px 16px;border-radius:12px;background:${RED};color:#ffffff;font-size:14px;font-weight:700;text-align:center;text-decoration:none;">${esc(t.taxInvoice)}</a>
        <p style="margin:8px 0 0;font-size:11px;color:rgba(26,26,26,0.45);text-align:center;">${esc(pdfAttached ? t.attached : t.notAttached)}</p>
      </td></tr>`;
}

/** The invoice lines of the plain-text twin. */
export function taxInvoiceText(lang: Lang, url: string | null, pdfAttached: boolean): string[] {
  const t = TAX[lang];
  return url ? ["", `${t.taxInvoice}: ${url}`, pdfAttached ? t.attached : t.notAttached] : [];
}

export function brandedEmail(input: {
  lang: Lang;
  subject: string;
  title: string;
  body: string;
  taxInvoiceUrl: string | null;
  pdfAttached: boolean;
}): string {
  const { lang } = input;
  const t = TAX[lang];
  const { start } = side(lang);
  return `<!DOCTYPE html>
<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(input.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f0ec;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0ec;padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
      <tr><td style="background:${RED};padding:26px 28px;">
        <p style="margin:0;font-size:20px;font-weight:800;color:#ffffff;text-align:${start};">RED OR NUDE</p>
        <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.75);text-align:${start};">${esc(input.title)}</p>
      </td></tr>
      <tr><td style="padding:26px 28px 0;">${input.body}</td></tr>
${taxInvoiceHtml(lang, input.taxInvoiceUrl, input.pdfAttached)}
      <tr><td style="padding:22px 28px 26px;">
        <div style="border-top:1px solid rgba(0,0,0,0.06);padding-top:14px;">
          <p style="margin:0;font-size:11px;color:rgba(26,26,26,0.35);text-align:${start};">${esc(t.footer)}</p>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** The plain-text twin's tail: the invoice link and the footer. */
export function textTail(lang: Lang, taxInvoiceUrl: string | null, pdfAttached: boolean): string[] {
  return [...taxInvoiceText(lang, taxInvoiceUrl, pdfAttached), "", TAX[lang].footer];
}

/**
 * Send a receipt and log the outcome. Never throws: it runs after the money
 * moved and the thing was delivered, so a failure is logged for a manual resend.
 */
export async function sendReceipt(tag: string, mail: Omit<SendMailInput, "replyTo" | "tags">) {
  const result = await sendMail({ ...mail, replyTo: process.env.MAIL_REPLY_TO?.trim() || null, tags: [tag] });
  if (!result.ok) console.error(`[${tag}] to ${mail.to} was not delivered:`, result.reason, result.detail ?? "");
  else console.info(`[${tag}] sent to ${mail.to}`);
}
