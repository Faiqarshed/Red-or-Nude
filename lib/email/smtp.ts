// SMTP transport — Gmail, Zoho, Brevo, Mailjet, or any relay that speaks SMTP.
// The only outbound mail path.
//
// Implements the contract in ./types.ts: never throws, and reports why it could
// not send rather than raising. Selected by lib/email/index.ts.
//
// Uses nodemailer because SMTP is not something to hand-roll — AUTH mechanisms,
// STARTTLS negotiation, MIME encoding and quoted-printable are all places to get
// it quietly wrong, and Arabic subject lines have to be RFC 2047 encoded or they
// arrive as mojibake.
//
// Node runtime only. nodemailer opens TCP sockets, which the Edge runtime has
// no API for, so any route that sends mail must not declare `runtime = "edge"`.

import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import type { SendMailInput, SendMailResult } from "./types";

/**
 * Cached on globalThis so dev hot-reload doesn't open a new pool per reload, the
 * same reason lib/db/index.ts does it. A pooled connection also means a group of
 * emails reuses one TLS handshake instead of paying for it each time.
 */
const globalForMail = globalThis as unknown as { __ronSmtp?: Transporter };

function getTransport(): Transporter | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;

  if (!host || !user || !pass) return null;
  if (globalForMail.__ronSmtp) return globalForMail.__ronSmtp;

  // 465 is implicit TLS; 587 (and 25) start plaintext and upgrade via STARTTLS.
  const port = Number(process.env.SMTP_PORT) || 587;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    pool: true,
    maxConnections: 3,
    // The customer is waiting on the payment response behind this call.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  globalForMail.__ronSmtp = transport;
  return transport;
}

/** `Sara <sara@example.com>`, with anything that would break the header stripped. */
function address(email: string, name?: string | null): string {
  const clean = name?.trim().replace(/["<>\\\r\n]/g, "");
  return clean ? `${clean} <${email}>` : email;
}

export async function sendMailViaSmtp(input: SendMailInput): Promise<SendMailResult> {
  const transport = getTransport();
  if (!transport) {
    console.warn("[mail] SMTP_HOST/SMTP_USER/SMTP_PASSWORD not set — skipping", input.subject);
    return { ok: false, reason: "not-configured" };
  }

  // Most relays refuse a From that isn't the authenticated mailbox, so this
  // falls back to the SMTP user rather than a brand address that would bounce.
  const fromEmail = process.env.MAIL_FROM_EMAIL?.trim() || process.env.SMTP_USER!.trim();
  const fromName = process.env.MAIL_FROM_NAME?.trim() || "Red or Nude";

  try {
    const info = await transport.sendMail({
      from: address(fromEmail, fromName),
      to: address(input.to, input.toName),
      subject: input.subject,
      html: input.html,
      // The text part is the one written by our templates, never auto-derived.
      text: input.text,
      replyTo: input.replyTo || undefined,
      // Tags have no SMTP equivalent; kept as a header so they still show up in
      // a relay's own reporting if it reads custom headers.
      headers: input.tags?.length ? { "X-Entity-Ref-ID": input.tags.join(",") } : undefined,
    });

    // A relay can accept the message and still reject individual recipients.
    if (info.rejected?.length) {
      const detail = info.rejected.join(", ");
      console.error(`[mail] SMTP rejected ${detail}`);
      return { ok: false, reason: "rejected", detail };
    }

    return { ok: true, id: info.messageId ?? "" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[mail] SMTP send failed:", detail);

    // 5xx replies are permanent (bad credentials, refused sender); 4xx and
    // socket errors are worth retrying. Only the first is our problem to fix.
    const permanent = /\b5\d\d\b/.test(detail) || /invalid login|auth/i.test(detail);
    return { ok: false, reason: permanent ? "rejected" : "failed", detail };
  }
}
