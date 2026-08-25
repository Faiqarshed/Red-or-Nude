// The verification code email.
//
// Same conventions as lib/invoice/template.ts — tables, inline styles, no
// external images, RTL for Arabic — and sent through lib/email/ like everything
// else. See that file's header for why email HTML is written this way.
//
// Unlike the invoice, this one must NOT fail silently: if the code does not
// arrive the customer is stuck at a dialog they cannot pass, so the caller is
// told whether it went out and surfaces that.

import "server-only";
import { sendMail } from "@/lib/email";
import type { SendMailResult } from "@/lib/email/types";
import { OTP_TTL_MS } from "@/lib/otp";

const RED = "#b80007";
const CREAM = "#fdf8f4";

const T = {
  ar: {
    subject: (code: string) => `${code} — رمز التحقق من ريد أور نيود`,
    title: "رمز التحقق",
    intro: "استخدمي هذا الرمز لعرض تفاصيل حجزك:",
    minutes: (n: number) => `الرمز صالح لمدة ${n} دقائق، ولمرة واحدة فقط.`,
    ignore: "إذا لم تطلبي هذا الرمز، تجاهلي هذه الرسالة — لم يتم فتح أي شيء.",
    footer: "هذه رسالة آلية، يُرجى عدم الرد عليها.",
  },
  en: {
    subject: (code: string) => `${code} — your Red or Nude verification code`,
    title: "Verification code",
    intro: "Use this code to see your booking details:",
    minutes: (n: number) => `It works once, and expires in ${n} minutes.`,
    ignore: "If you didn't ask for this code, ignore this email — nothing was opened.",
    footer: "This is an automated message — please don't reply.",
  },
} as const;

function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendOtpEmail(input: {
  to: string;
  toName?: string | null;
  code: string;
  lang: "ar" | "en";
}): Promise<SendMailResult> {
  const t = T[input.lang];
  const rtl = input.lang === "ar";
  const start = rtl ? "right" : "left";
  const minutes = Math.round(OTP_TTL_MS / 60_000);

  const html = `<!DOCTYPE html>
<html lang="${input.lang}" dir="${rtl ? "rtl" : "ltr"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f0ec;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0ec;padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;overflow:hidden;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
      <tr><td style="background:${RED};padding:22px 28px;">
        <p style="margin:0;font-size:18px;font-weight:800;color:#ffffff;text-align:${start};">RED OR NUDE</p>
      </td></tr>
      <tr><td style="padding:26px 28px 0;">
        <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:rgba(26,26,26,0.65);text-align:${start};">${esc(t.intro)}</p>
      </td></tr>
      <tr><td style="padding:0 28px;">
        <div style="background:${CREAM};border-radius:14px;padding:22px;text-align:center;">
          <p style="margin:0;font-size:34px;font-weight:800;letter-spacing:0.28em;color:${RED};" dir="ltr">${esc(input.code)}</p>
        </div>
        <p style="margin:12px 0 0;font-size:12px;color:rgba(26,26,26,0.5);text-align:${start};">${esc(t.minutes(minutes))}</p>
      </td></tr>
      <tr><td style="padding:20px 28px 26px;">
        <div style="border-top:1px solid rgba(0,0,0,0.06);padding-top:14px;">
          <p style="margin:0 0 6px;font-size:12px;color:rgba(26,26,26,0.5);text-align:${start};">${esc(t.ignore)}</p>
          <p style="margin:0;font-size:11px;color:rgba(26,26,26,0.35);text-align:${start};">${esc(t.footer)}</p>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [t.title, "", t.intro, "", input.code, "", t.minutes(minutes), t.ignore, "", t.footer].join("\n");

  const result = await sendMail({
    to: input.to,
    toName: input.toName,
    // The code is in the subject too: most clients preview it, so a customer can
    // read it without leaving the page they are being asked to type it into.
    subject: t.subject(input.code),
    html,
    text,
    replyTo: process.env.MAIL_REPLY_TO?.trim() || null,
    tags: ["booking-otp"],
  });

  // Development only (`next dev`; never true for `next start` or a deployed
  // build). Without SMTP configured sendMail refuses, the caller returns 502,
  // and the customer is stuck at a dialog they cannot pass — which makes the
  // whole sign-in flow untestable on a fresh clone. Printing the code to the
  // server console is the standard local escape hatch.
  //
  // Guarded on NODE_ENV *and* on mail having actually failed, so a configured
  // dev box behaves exactly like production and no code is ever printed
  // alongside a message that really went out.
  if (!result.ok && process.env.NODE_ENV !== "production") {
    console.warn(`[otp] DEV ONLY — code for ${input.to} is ${input.code}`);
    return { ok: true, id: "dev-console" };
  }

  return result;
}
