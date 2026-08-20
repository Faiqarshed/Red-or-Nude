// The rating invitation (brief §2.9) — sent when a receptionist presses End.
//
// Same bargain as lib/giftcard/email.ts and lib/invoice/template.ts: rendered
// server-side, delivered through lib/email/ over SMTP, and written for mail
// clients rather than browsers — tables for layout, inline styles only, no web
// fonts, no external images. Gmail strips <style> blocks in some views and
// Outlook renders with Word's engine.
//
// The five stars are real links, one per score, each landing on the review page
// with that rating pre-selected. An email that asks the customer to click
// through, load a page and *then* start deciding gets answered by almost nobody;
// one where the first click is already the answer gets answered.

import "server-only";
import { siteOrigin } from "@/lib/site";

const RED = "#b80007";
const INK = "#1a1a1a";
const CREAM = "#fdf8f4";

type Lang = "ar" | "en";

export type ReviewEmailInput = {
  token: string;
  customerName?: string | null;
  /** What they had, in their language. Null for a booking with no service row. */
  serviceName?: string | null;
  lang: Lang;
};

const T = {
  ar: {
    subject: "كيف كانت زيارتك؟",
    preview: "تقييمك يساعدنا على التحسّن.",
    greeting: (name: string | null) => (name ? `أهلاً ${name}،` : "أهلاً،"),
    intro: (service: string | null) =>
      service ? `شكراً لزيارتك. كيف كانت ${service}؟` : "شكراً لزيارتك. كيف كانت خدمتك؟",
    tapStar: "اختاري عدد النجوم — ثم يمكنك إضافة رأيك عن الفنية وكتابة ملاحظة.",
    button: "أضيفي تقييمك",
    thanks: "تقييمك يستغرق أقل من دقيقة، ويصل إلينا مباشرة.",
    footer: "هذه رسالة آلية، يُرجى عدم الرد عليها.",
  },
  en: {
    subject: "How was your visit?",
    preview: "Your rating helps us get better.",
    greeting: (name: string | null) => (name ? `Hi ${name},` : "Hi,"),
    intro: (service: string | null) =>
      service ? `Thanks for coming in. How was your ${service}?` : "Thanks for coming in. How was your service?",
    tapStar: "Pick a star — then you can rate your technician and leave a note.",
    button: "Leave your rating",
    thanks: "It takes under a minute and comes straight to us.",
    footer: "This is an automated message — please don't reply.",
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

export type RenderedEmail = { subject: string; html: string; text: string };

/** Exported separately from the sender so a script can render without sending. */
export function renderReviewEmail(input: ReviewEmailInput): RenderedEmail {
  const lang = input.lang;
  const t = T[lang];
  const rtl = lang === "ar";
  const dir = rtl ? "rtl" : "ltr";
  const start = rtl ? "right" : "left";

  const name = input.customerName?.trim() || null;
  const service = input.serviceName?.trim() || null;
  // Absolute: this link is read in an inbox, months later, from any device.
  const url = `${siteOrigin()}/review/${encodeURIComponent(input.token)}`;

  // Five separate links so the first click is the answer. The stars are text,
  // not images — a remote image is blocked by default in most clients, and a
  // rating email whose rating is invisible is a rating email nobody answers.
  const stars = [1, 2, 3, 4, 5]
    .map(
      (n) => `<a
        href="${url}?r=${n}"
        style="display:inline-block;padding:0 6px;font-size:34px;line-height:1;color:${RED};text-decoration:none;"
        aria-label="${n}"
      >&#9733;</a>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f0ec;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(t.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0ec;padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">

      <tr><td style="background:${RED};padding:26px 28px;">
        <p style="margin:0;font-size:20px;font-weight:800;color:#ffffff;text-align:${start};">RED OR NUDE</p>
      </td></tr>

      <tr><td style="padding:26px 28px 0;">
        <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:${INK};text-align:${start};">${esc(t.greeting(name))}</p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(t.intro(service))}</p>
      </td></tr>

      <tr><td style="padding:0 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:14px;background:${CREAM};">
          <tr><td style="padding:20px;text-align:center;">
            <div dir="ltr">${stars}</div>
            <p style="margin:12px 0 0;font-size:12px;color:rgba(26,26,26,0.5);">${esc(t.tapStar)}</p>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:20px 28px 0;text-align:center;">
        <a href="${url}" style="display:inline-block;padding:13px 30px;border-radius:12px;background:${RED};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">${esc(t.button)}</a>
        <p style="margin:12px 0 0;font-size:12px;color:rgba(26,26,26,0.45);">${esc(t.thanks)}</p>
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
    t.greeting(name),
    t.intro(service),
    "",
    t.tapStar,
    ...[1, 2, 3, 4, 5].map((n) => `${n}/5 → ${url}?r=${n}`),
    "",
    `${t.button}: ${url}`,
    "",
    t.footer,
  ].join("\n");

  return { subject: t.subject, html, text };
}
