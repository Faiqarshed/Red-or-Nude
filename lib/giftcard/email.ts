// The gift card email — the card itself, delivered.
//
// Same bargain as lib/invoice/: built and rendered server-side, sent through
// lib/email/ (SMTP), and totally failure-isolated. It runs after the buyer has
// been charged and the card has been issued, so the card is real and spendable
// whether or not the mail lands. Nothing here throws.
//
// Two recipients, two different emails:
//   • the recipient gets the card — the code, the amount, the occasion message
//   • the buyer gets a short receipt confirming it was sent, and the code too,
//     so a wrong address or a spam folder isn't an unrecoverable loss
//
// Written for mail clients, not browsers: tables, inline styles, no external
// images. See the header of lib/invoice/template.ts for why.

import "server-only";
import { esc } from "@/lib/email/html";
import { sendMail } from "@/lib/email";
import { siteOrigin } from "@/lib/site";

const RED = "#b80007";
const INK = "#1a1a1a";
const CREAM = "#fdf8f4";

type Lang = "ar" | "en";

export type GiftCardEmailInput = {
  code: string;
  amountSar: number;
  senderName?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  buyerEmail?: string | null;
  message?: string | null;
  lang: Lang;
  expiresAt?: Date | null;
};

const T = {
  ar: {
    toSubject: (from: string | null) =>
      from ? `${from} أرسل لكِ بطاقة هدية من ريد أور نيود 🎁` : "بطاقة هدية من ريد أور نيود 🎁",
    buyerSubject: "تم إرسال بطاقة الهدية",
    preview: "بطاقة هدية في انتظارك.",
    greeting: (name: string | null) => (name ? `أهلاً ${name}،` : "أهلاً،"),
    intro: (from: string | null) =>
      from ? `${from} أرسل لكِ بطاقة هدية.` : "لديكِ بطاقة هدية.",
    buyerIntro: (to: string | null) =>
      to ? `أرسلنا بطاقة الهدية إلى ${to}. هذه نسختك من التفاصيل.` : "تم إصدار بطاقة الهدية.",
    valueLabel: "قيمة البطاقة",
    codeLabel: "رقم البطاقة",
    howTo: "اذكري رقم البطاقة عند الحجز أو في الفرع لاستخدام الرصيد.",
    expires: "صالحة حتى",
    messageTitle: "رسالة لكِ",
    sar: "ر.س",
    footer: "هذه رسالة آلية، يُرجى عدم الرد عليها.",
  },
  en: {
    toSubject: (from: string | null) =>
      from ? `${from} sent you a Red or Nude gift card 🎁` : "A Red or Nude gift card 🎁",
    buyerSubject: "Your gift card is on its way",
    preview: "A gift card is waiting for you.",
    greeting: (name: string | null) => (name ? `Hi ${name},` : "Hi,"),
    intro: (from: string | null) => (from ? `${from} sent you a gift card.` : "You have a gift card."),
    buyerIntro: (to: string | null) =>
      to ? `We've sent the gift card to ${to}. Here's your copy of the details.` : "Your gift card has been issued.",
    valueLabel: "Card value",
    codeLabel: "Card number",
    howTo: "Quote the card number when booking, or at the branch, to spend the balance.",
    expires: "Valid until",
    messageTitle: "Your message",
    sar: "SAR",
    footer: "This is an automated message — please don't reply.",
  },
} satisfies Record<Lang, Record<string, unknown>>;

/** Exported so scripts/preview-giftcard.ts can render it without sending. */
export function renderGiftCardEmail(input: GiftCardEmailInput, forBuyer = false) {
  const lang = input.lang;
  const t = T[lang];
  const rtl = lang === "ar";
  const dir = rtl ? "rtl" : "ltr";
  const start = rtl ? "right" : "left";

  const from = input.senderName?.trim() || null;
  const intro = forBuyer ? t.buyerIntro(input.recipientEmail ?? null) : t.intro(from);
  const greetName = forBuyer ? from : (input.recipientName?.trim() || null);
  const subject = forBuyer ? t.buyerSubject : t.toSubject(from);

  const expiry = input.expiresAt
    ? new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn" : "en-GB", {
        dateStyle: "medium",
        timeZone: "Asia/Riyadh",
      }).format(input.expiresAt)
    : null;

  const messageBlock =
    !forBuyer && input.message?.trim()
      ? `
      <div style="margin:0 0 20px;padding:16px 18px;background:${CREAM};border-radius:14px;">
        <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.05em;text-transform:uppercase;color:rgba(26,26,26,0.4);text-align:${start};">${esc(t.messageTitle)}</p>
        <p style="margin:0;font-size:14px;line-height:1.6;font-style:italic;color:${INK};text-align:${start};">&ldquo;${esc(input.message.trim())}&rdquo;</p>
      </div>`
      : "";

  const cardImage = `${siteOrigin()}/api/gift-card-image?amount=${encodeURIComponent(input.amountSar)}`;

  const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f0ec;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(t.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0ec;padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">

      <tr><td style="background:${RED};padding:26px 28px;">
        <p style="margin:0;font-size:20px;font-weight:800;color:#ffffff;text-align:${start};">RED OR NUDE</p>
      </td></tr>

      <tr><td style="padding:26px 28px 0;">
        <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:${INK};text-align:${start};">${esc(t.greeting(greetName))}</p>
        <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(intro)}</p>
      </td></tr>

      <!-- The card itself, rendered to a PNG by /api/gift-card-image. Most
           clients block remote images until the reader allows them, so the
           code and amount are repeated as real text below — the email has to
           be usable with images off. -->
      <tr><td style="padding:0 28px;">
        <img
          src="${cardImage}"
          alt="${esc(t.valueLabel)}: ${input.amountSar} ${esc(t.sar)}"
          width="544"
          style="display:block;width:100%;max-width:544px;height:auto;border-radius:18px;"
        />
      </td></tr>

      <tr><td style="padding:16px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:14px;background:${CREAM};">
          <tr><td style="padding:16px 20px;text-align:center;">
            <p style="margin:0 0 4px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(26,26,26,0.45);">${esc(t.codeLabel)}</p>
            <p style="margin:0 0 10px;font-size:22px;font-weight:700;letter-spacing:0.12em;color:${RED};" dir="ltr">${esc(input.code)}</p>
            <p style="margin:0;font-size:13px;color:rgba(26,26,26,0.5);">${esc(t.valueLabel)}: <strong style="color:${INK};" dir="ltr">${input.amountSar} ${esc(t.sar)}</strong></p>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:20px 28px 0;">
        ${messageBlock}
        <p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(t.howTo)}</p>
        ${expiry ? `<p style="margin:0;font-size:12px;color:rgba(26,26,26,0.45);text-align:${start};">${esc(t.expires)}: <span dir="ltr">${esc(expiry)}</span></p>` : ""}
      </td></tr>

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

  const text = [
    t.greeting(greetName),
    intro,
    "",
    `${t.valueLabel}: ${input.amountSar} ${t.sar}`,
    `${t.codeLabel}: ${input.code}`,
    ...(!forBuyer && input.message?.trim() ? ["", `${t.messageTitle}: "${input.message.trim()}"`] : []),
    "",
    t.howTo,
    ...(expiry ? [`${t.expires}: ${expiry}`] : []),
    "",
    t.footer,
  ].join("\n");

  return { subject, html, text };
}

export type GiftCardEmailOutcome = {
  /** Did the person receiving the gift actually get it? */
  recipient: "sent" | "skipped" | "failed";
  buyer: "sent" | "skipped" | "failed";
};

/**
 * Deliver an issued gift card. Never throws: the buyer has already been charged
 * and the card already exists, so a mail failure is logged loudly for a manual
 * resend rather than surfaced as an error.
 */
export async function sendGiftCardEmails(
  input: GiftCardEmailInput,
): Promise<GiftCardEmailOutcome> {
  const out: GiftCardEmailOutcome = { recipient: "skipped", buyer: "skipped" };

  const send = async (to: string, forBuyer: boolean) => {
    const { subject, html, text } = renderGiftCardEmail(input, forBuyer);
    const result = await sendMail({
      to,
      toName: forBuyer ? input.senderName : input.recipientName,
      subject,
      html,
      text,
      replyTo: process.env.MAIL_REPLY_TO?.trim() || null,
      tags: [forBuyer ? "gift-card-receipt" : "gift-card"],
    });
    if (!result.ok) {
      // Loud: someone paid for a gift that did not arrive.
      console.error(
        `[giftcard] ${input.code} to ${to} was not delivered:`,
        result.reason,
        result.detail ?? "",
      );
      return "failed" as const;
    }
    console.info(`[giftcard] ${input.code} sent to ${to}`);
    return "sent" as const;
  };

  try {
    if (input.recipientEmail?.trim()) {
      out.recipient = await send(input.recipientEmail.trim(), false);
    }
    // Only if it is a different address — buying one for yourself should not
    // land the same card in your inbox twice.
    const buyer = input.buyerEmail?.trim().toLowerCase();
    if (buyer && buyer !== input.recipientEmail?.trim().toLowerCase()) {
      out.buyer = await send(buyer, true);
    }
  } catch (err) {
    console.error("[giftcard] could not send the gift card email", err);
  }

  return out;
}
