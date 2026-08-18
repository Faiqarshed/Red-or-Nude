// Outbound messaging seam — WhatsApp and email.
//
// Deliberately the same shape as lib/payments/index.ts: nothing here talks to a
// real provider yet (Unifonic vs Meta's Cloud API is still open, see
// docs/ADMIN-PANEL.md), but everything *around* the provider is real. Every
// place that should send a message already calls `notify()`, so landing a real
// one is a single new file implementing NotifyDriver plus a line in getDriver().
//
// Until then the log driver prints what would have been sent, which is enough to
// verify the call sites in development and harmless in production.

import { logDriver } from "./log";

export type NotifyChannel = "whatsapp" | "email";

export type NotifyTemplate =
  /** The booking reference and ticket, right after payment. */
  | "booking-confirmed"
  /** The card code and occasion message, to the recipient. */
  | "gift-card"
  /** A nudge a few days before a refill window closes. */
  | "refill-reminder";

export type NotifyMessage = {
  channel: NotifyChannel;
  /** Email address or phone number, depending on the channel. */
  to: string;
  template: NotifyTemplate;
  lang: "ar" | "en";
  /** Template variables. Kept loose — each provider maps these its own way. */
  data: Record<string, unknown>;
};

export type NotifyResult = { ok: boolean };

export type NotifyDriver = {
  send(message: NotifyMessage): Promise<NotifyResult>;
};

/** Branch on `process.env.NOTIFY_DRIVER` here once there is a real driver. */
function getDriver(): NotifyDriver {
  return logDriver;
}

/**
 * Send a message, and never let a messaging failure break the thing that
 * triggered it. A paid booking must confirm whether or not the receipt goes
 * out, so this swallows errors and returns them instead of throwing.
 */
export async function notify(message: NotifyMessage): Promise<NotifyResult> {
  // Nothing to send to. Not an error — plenty of customers give one contact,
  // not both.
  if (!message.to.trim()) return { ok: false };

  try {
    return await getDriver().send(message);
  } catch (err) {
    console.error(`[notify] ${message.template} to ${message.channel} failed`, err);
    return { ok: false };
  }
}
