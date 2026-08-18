// Mail transport seam.
//
// One transport: SMTP (lib/email/smtp.ts). Everything that sends mail imports
// `sendMail` from here rather than from the transport directly, so adding or
// swapping a provider stays a one-file change — the same reason lib/payments/
// and lib/notify/ are shaped this way.
//
// Deliverability note: landing in an inbox rather than spam is about SPF/DKIM on
// the sending domain, not about which transport carries the message. Gmail
// rewrites `From` to the authenticated mailbox, so mail currently arrives from
// that address rather than the brand. See docs/INVOICE-EMAIL.md §6.

import "server-only";
import type { SendMailInput, SendMailResult } from "./types";

export type { SendMailInput, SendMailResult } from "./types";

export type MailTransport = "smtp" | "none";

/** Reported by scripts/check-mail.ts so a misconfigured box says so out loud. */
export function activeTransport(): MailTransport {
  const configured =
    process.env.SMTP_HOST?.trim() && process.env.SMTP_USER?.trim() && process.env.SMTP_PASSWORD;
  return configured ? "smtp" : "none";
}

/**
 * Send one email. Never throws — mail is a side effect of work that has already
 * happened (a charge taken, a card issued), so a provider outage must never turn
 * a completed transaction into an error.
 *
 * The transport is imported lazily: nodemailer opens TCP sockets and cannot be
 * bundled into an Edge route, so loading it unconditionally would break one.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  if (activeTransport() === "none") {
    console.warn(
      "[mail] SMTP is not configured — set SMTP_HOST, SMTP_USER and SMTP_PASSWORD. Skipping:",
      input.subject,
    );
    return { ok: false, reason: "not-configured" };
  }

  const { sendMailViaSmtp } = await import("./smtp");
  return sendMailViaSmtp(input);
}
