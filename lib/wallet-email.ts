// The wallet's emails (docs/WALLET-PLAN.md): credit from a cancellation or an
// undelivered chair purchase, and the owner's correction. Before the wallet
// there was no cancellation email at all; notifyCustomer only logs.
//
// Not a tax document: whether a credit note needs one is open with the
// accountant (docs/WALLET-PLAN.md, open question 2), so this carries no invoice.

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, customers, walletTxns } from "@/lib/db/schema";
import { esc } from "@/lib/email/html";
import { brandedEmail, INK, RED, sendReceipt, side } from "@/lib/email/shell";
import { formatSAR } from "@/lib/money";
import { siteOrigin } from "@/lib/site";
import { walletBalance, walletLaunched, walletOwner } from "@/lib/wallet";

type Lang = "ar" | "en";

const T = {
  ar: {
    subject: "أُضيف رصيد إلى محفظتك في ريد أور نيود",
    title: "أُضيف رصيد إلى محفظتك",
    greeting: (name: string | null) => (name ? `أهلاً ${name}،` : "أهلاً،"),
    yours: "أُلغي حجزك، وأضفنا ما دفعتِه إلى محفظتك:",
    salons: (why: string) => `اضطررنا إلى إلغاء حجزك، ونعتذر عن ذلك. السبب: ${why}. أضفنا ما دفعتِه إلى محفظتك:`,
    chair: "لم نتمكن من إضافة طلبك إلى زيارتك، فأضفنا ما دفعتِه إلى محفظتك:",
    chairSubject: "أُضيف ثمن طلبك إلى محفظتك في ريد أور نيود",
    added: "أُضيف إلى محفظتك",
    balance: "رصيدك الآن",
    sar: "ر.س",
    use: "يمكنك استخدامه في حجزك القادم، ولا تنتهي صلاحيته.",
    correctedSubject: "تم تعديل رصيد محفظتك في ريد أور نيود",
    corrected: "عدّلنا رصيد محفظتك:",
    correction: "التعديل",
    why: "السبب",
    signIn: (email: string, url: string) => `سجّلي الدخول بالبريد ${email} في ${url} لاستخدامه.`,
    footer: "ريد أور نيود",
  },
  en: {
    subject: "Credit added to your Red or Nude wallet",
    title: "Credit added to your wallet",
    greeting: (name: string | null) => (name ? `Hi ${name},` : "Hi,"),
    yours: "Your booking is cancelled, and what you paid is in your wallet:",
    salons: (why: string) => `We had to cancel your booking, and we're sorry. The reason: ${why}. What you paid is in your wallet:`,
    chair: "We couldn't add your order to your visit, so what you paid is in your wallet:",
    chairSubject: "Your order's price is in your Red or Nude wallet",
    added: "Added to your wallet",
    balance: "Your balance now",
    sar: "SAR",
    use: "Use it on your next booking. It never expires.",
    correctedSubject: "Your Red or Nude wallet was corrected",
    corrected: "We corrected your wallet balance:",
    correction: "Correction",
    why: "Reason",
    signIn: (email: string, url: string) => `Sign in with ${email} at ${url} to use it.`,
    footer: "Red or Nude",
  },
};

export type CreditEmailInput = {
  lang: Lang;
  name: string | null;
  amountHalalas: number;
  /** What she can spend now, never below zero. */
  balanceHalalas: number;
  /** The desk's reason when the salon cancelled; null when she did. */
  salonReason: string | null;
  /** Set for a guest: the email her credit waits under. Null for an account. */
  guestEmail: string | null;
  /** A chair purchase that could not be delivered, not a cancellation. */
  chair?: boolean;
};

export function renderCreditEmail(input: CreditEmailInput) {
  const t = T[input.lang];
  const { start } = side(input.lang);
  const money = (h: number) => `${formatSAR(h, { decimals: true })} ${t.sar}`;
  const intro = input.chair ? t.chair : input.salonReason ? t.salons(input.salonReason) : t.yours;
  const subject = input.chair ? t.chairSubject : t.subject;
  const signIn = input.guestEmail ? t.signIn(input.guestEmail, `${siteOrigin()}/account`) : null;

  const line = (label: string, value: string, strong = false) =>
    `<p style="margin:6px 0 0;font-size:14px;${strong ? "font-weight:700;" : ""}color:${INK};text-align:${start};">${esc(label)}: <span dir="ltr" style="color:${RED};">${esc(value)}</span></p>`;

  const html = brandedEmail({
    lang: input.lang,
    subject,
    title: t.title,
    taxInvoiceUrl: null,
    pdfAttached: false,
    body: `
        <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:${INK};text-align:${start};">${esc(t.greeting(input.name))}</p>
        <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(intro)}</p>
        ${line(t.added, money(input.amountHalalas), true)}
        ${line(t.balance, money(input.balanceHalalas))}
        <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(t.use)}${signIn ? ` ${esc(signIn)}` : ""}</p>`,
  });

  const text = [
    t.greeting(input.name),
    intro,
    "",
    `${t.added}: ${money(input.amountHalalas)}`,
    `${t.balance}: ${money(input.balanceHalalas)}`,
    "",
    t.use,
    ...(signIn ? [signIn] : []),
    "",
    t.footer,
  ].join("\n");

  return { subject, html, text };
}

/**
 * Tell her what the cancellation of these bookings put in her wallet: one
 * email per wallet it credited, for what the ledger actually holds. Call after
 * the transaction commits. Never throws: the credit is hers either way.
 */
export async function sendCancelCreditEmail(bookingIds: string[], salonReason: string | null = null): Promise<void> {
  try {
    if (bookingIds.length === 0) return;
    const credits = await db
      .select({
        customerId: walletTxns.customerId,
        ownerEmail: walletTxns.ownerEmail,
        deltaHalalas: walletTxns.deltaHalalas,
      })
      .from(walletTxns)
      .where(
        and(inArray(walletTxns.bookingId, bookingIds), inArray(walletTxns.reason, ["cancel-customer", "cancel-salon"])),
      );

    const wallets = new Map<string, { customerId: string; ownerEmail: string; amount: number }>();
    for (const c of credits) {
      const key = `${c.customerId}:${c.ownerEmail}`;
      const w = wallets.get(key) ?? { customerId: c.customerId, ownerEmail: c.ownerEmail, amount: 0 };
      w.amount += c.deltaHalalas;
      wallets.set(key, w);
    }

    for (const w of wallets.values()) {
      const [customer] = await db.select().from(customers).where(eq(customers.id, w.customerId)).limit(1);
      if (!customer) continue;
      const { subject, html, text } = renderCreditEmail({
        lang: customer.lang,
        name: customer.name,
        amountHalalas: w.amount,
        balanceHalalas: (await walletBalance(w.ownerEmail)).available,
        salonReason,
        guestEmail: customer.emailVerifiedAt ? null : w.ownerEmail,
      });
      await sendReceipt("wallet-cancel-credit", { to: w.ownerEmail, toName: customer.name, subject, html, text });
    }
  } catch (err) {
    console.error("[wallet] could not build or send the cancel credit email", err);
  }
}

/** Tell her the owner corrected her wallet, and why. Only once the wallet is live. Never throws. */
export async function sendCorrectionEmail(ownerEmail: string, halalas: number, reason: string): Promise<void> {
  try {
    if (!(await walletLaunched())) return;
    const customer = await walletOwner(ownerEmail);
    if (!customer) return;
    const { subject, html, text } = renderCorrectionEmail({
      lang: customer.lang,
      name: customer.name,
      halalas,
      balanceHalalas: (await walletBalance(ownerEmail)).available,
      reason,
    });
    await sendReceipt("wallet-correction", { to: ownerEmail, toName: customer.name, subject, html, text });
  } catch (err) {
    console.error("[wallet] could not build or send the correction email", err);
  }
}

export function renderCorrectionEmail(input: {
  lang: Lang;
  name: string | null;
  /** Signed: + into her wallet, − out of it. */
  halalas: number;
  balanceHalalas: number;
  reason: string;
}) {
  const t = T[input.lang];
  const { start } = side(input.lang);
  const sign = input.halalas < 0 ? "−" : "+";
  const money = (h: number) => `${formatSAR(h, { decimals: true })} ${t.sar}`;
  const line = (label: string, value: string, strong = false) =>
    `<p style="margin:6px 0 0;font-size:14px;${strong ? "font-weight:700;" : ""}color:${INK};text-align:${start};">${esc(label)}: <span dir="ltr" style="color:${RED};">${esc(value)}</span></p>`;

  const html = brandedEmail({
    lang: input.lang,
    subject: t.correctedSubject,
    title: t.correctedSubject,
    taxInvoiceUrl: null,
    pdfAttached: false,
    body: `
        <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:${INK};text-align:${start};">${esc(t.greeting(input.name))}</p>
        <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:rgba(26,26,26,0.6);text-align:${start};">${esc(t.corrected)}</p>
        ${line(t.correction, `${sign}${money(Math.abs(input.halalas))}`, true)}
        ${line(t.why, input.reason)}
        ${line(t.balance, money(input.balanceHalalas))}`,
  });

  const text = [
    t.greeting(input.name),
    t.corrected,
    "",
    `${t.correction}: ${sign}${money(Math.abs(input.halalas))}`,
    `${t.why}: ${input.reason}`,
    `${t.balance}: ${money(input.balanceHalalas)}`,
    "",
    t.footer,
  ].join("\n");

  return { subject: t.correctedSubject, html, text };
}

/** Tell her an undelivered chair purchase went to her wallet. Never throws. */
export async function sendChairCreditEmail(bookingId: string, amountHalalas: number): Promise<void> {
  try {
    const [visit] = await db
      .select({ customerId: bookings.customerId, ownerEmail: bookings.customerEmail })
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    if (!visit?.customerId || !visit.ownerEmail) return;
    const [customer] = await db.select().from(customers).where(eq(customers.id, visit.customerId)).limit(1);
    if (!customer) return;
    const { subject, html, text } = renderCreditEmail({
      lang: customer.lang,
      name: customer.name,
      amountHalalas,
      balanceHalalas: (await walletBalance(visit.ownerEmail)).available,
      salonReason: null,
      guestEmail: customer.emailVerifiedAt ? null : visit.ownerEmail,
      chair: true,
    });
    await sendReceipt("wallet-chair-credit", { to: visit.ownerEmail, toName: customer.name, subject, html, text });
  } catch (err) {
    console.error("[wallet] could not build or send the chair credit email", err);
  }
}
