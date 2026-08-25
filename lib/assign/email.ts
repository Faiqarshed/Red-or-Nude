// "You have a customer" — the mail a technician gets when reception checks
// someone in (brief §3.1).
//
// Same rules as lib/reviews/email.ts: tables for layout, inline styles only, no
// web fonts, no external images. Outlook renders with Word's engine.
//
// **Bilingual labels rather than a language choice.** `staff` carries no `lang`
// column, and adding one to send four words is not worth a migration. The body
// is almost entirely data — a ticket number, a chair, a time — so each label
// carries both languages and every technician can read it.

import "server-only";
import { esc } from "@/lib/email/html";
import { UTC_OFFSET_HOURS } from "@/lib/time";

const RED = "#b80007";
const INK = "#1a1a1a";
const CREAM = "#fdf8f4";

export type AssignmentEmailInput = {
  ticketNo: string | null;
  techName: string | null;
  customerName: string | null;
  serviceName: string | null;
  stationLabel: string | null;
  startsAt: Date;
};

export type RenderedEmail = { subject: string; html: string; text: string };

/** Riyadh wall clock, HH:MM. The salon has one timezone and it isn't UTC. */
function localTime(date: Date): string {
  return new Date(date.getTime() + UTC_OFFSET_HOURS * 3600_000).toISOString().slice(11, 16);
}

export function renderAssignmentEmail(input: AssignmentEmailInput): RenderedEmail {
  const ticket = input.ticketNo ?? "—";
  const time = localTime(input.startsAt);

  const rows: [string, string][] = [
    ["الخدمة / Service", input.serviceName ?? "—"],
    ["الكرسي / Station", input.stationLabel ?? "—"],
    ["الوقت / Time", time],
    ["العميلة / Customer", input.customerName ?? "—"],
  ];

  const subject = `تذكرة ${ticket} — عميلة بانتظارك / Ticket ${ticket} — customer waiting`;

  const cells = rows
    .map(
      ([label, value]) => `
          <tr>
            <td style="padding:6px 0;font-size:12px;color:#6b6b6b;">${esc(label)}</td>
            <td style="padding:6px 0;font-size:14px;color:${INK};font-weight:600;text-align:right;">${esc(value)}</td>
          </tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:${CREAM};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;padding:28px 24px;font-family:Arial,Helvetica,sans-serif;">
        <tr><td style="font-size:13px;color:#6b6b6b;padding-bottom:4px;">
          ${input.techName ? `${esc(input.techName)}،` : ""} عميلة بانتظارك — a customer is waiting for you
        </td></tr>
        <tr><td style="padding:12px 0 4px;">
          <div style="font-size:11px;color:#6b6b6b;">التذكرة / Ticket</div>
          <div style="font-size:40px;line-height:1.1;font-weight:800;color:${RED};letter-spacing:1px;">${esc(ticket)}</div>
        </td></tr>
        <tr><td style="padding-top:14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cells}</table>
        </td></tr>
        <tr><td style="padding-top:18px;font-size:12px;color:#6b6b6b;line-height:1.6;">
          أكّدي رقم التذكرة مع العميلة ثم اضغطي "بدء" في لوحة التحكم.<br/>
          Confirm the ticket number with her, then press Start in the panel.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `تذكرة / Ticket ${ticket}`,
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    'أكّدي رقم التذكرة مع العميلة ثم اضغطي "بدء".',
    "Confirm the ticket number with her, then press Start.",
  ].join("\n");

  return { subject, html, text };
}
