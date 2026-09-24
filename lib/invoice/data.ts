// Assembling the booking confirmation for a bill that has already been paid.
//
// Everything here is read back out of the booking rows rather than recomputed
// from the catalog: `serviceName`, `servicePriceHalalas`, the add-on snapshots
// and the VAT split were all frozen at booking time precisely so an invoice
// reprinted next year still says what the customer was charged today.
//
// It is not a tax invoice. StreamPay issues that for every payment (numbered,
// ZATCA-compliant, with its QR code), and this email links to it. One tax
// document per sale, so there is no second set of VAT figures to disagree with
// theirs: no invoice number, no VAT lines, no VAT number here. Prices are
// VAT-inclusive and the email says so.

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bookingAddons,
  bookings,
  branches,
  customers,
  payments,
  promoCodes,
  staff,
  stations,
  type Localized,
} from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";
import type { PaymentMethod } from "@/lib/payments";
import { membershipsLeft, packsSpentOn, type MembershipLeft } from "@/lib/packs";

export type InvoiceLine = { label: Localized; amountHalalas: number };

export type InvoiceGuest = {
  code: string;
  ticketNo: string | null;
  stationLabel: string | null;
  /**
   * Who will be doing the work, when that is already known.
   *
   * Null is the ordinary case for anything past today: assignIfToday only
   * fills a technician in on the day itself, because an assignment made a
   * week ahead cannot see who will be on leave by then. The template omits
   * the line rather than promising a name the salon has not picked yet.
   */
  technicianName: string | null;
  lines: InvoiceLine[];
  discountHalalas: number;
  totalHalalas: number;
};

export type InvoiceData = {
  seller: {
    name: string;
    branchName: Localized | null;
    branchAddress: Localized | null;
    branchPhone: string | null;
  };
  customer: {
    name: string | null;
    email: string;
    phone: string | null;
    lang: "ar" | "en";
  };
  startsAt: Date;
  method: PaymentMethod | null;
  providerRef: string | null;
  guests: InvoiceGuest[];
  /**
   * The discount code applied to this bill, if any. Names the discount line —
   * "Discount (EID25)" rather than a deduction the customer has to take on
   * trust. Null when the only reduction was the group discount.
   */
  promoCode: string | null;
  discountHalalas: number;
  totalHalalas: number;
  /** StreamPay's tax invoice for this payment, when the gateway gave one. */
  taxInvoiceUrl: string | null;
  /**
   * The memberships a credit came off for this booking, with what is left on
   * each. This email is the "you used a credit" message: it goes out the moment
   * the booking the credit paid for is confirmed, so it is not sent twice.
   */
  memberships: MembershipLeft[];
};

/**
 * Build the invoice for one bill. `bookingIds` is every guest on it — one id for
 * a single booking, two for a group, in the order the tickets were handed out.
 *
 * Returns null when there is nothing to send to: no customer email means no
 * invoice, which is a normal outcome for walk-ins and admin-created bookings
 * rather than an error.
 */
export async function buildBookingInvoice(bookingIds: string[]): Promise<InvoiceData | null> {
  if (bookingIds.length === 0) return null;

  const rows = await db.select().from(bookings).where(inArray(bookings.id, bookingIds));
  if (rows.length === 0) return null;

  // Caller order is the ticket order; the WHERE IN above doesn't preserve it.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = bookingIds.map((id) => byId.get(id)).filter(Boolean) as typeof rows;
  const anchor = ordered[0];

  const [customer] = anchor.customerId
    ? await db.select().from(customers).where(eq(customers.id, anchor.customerId)).limit(1)
    : [];
  const email = customer?.email?.trim();
  if (!email) return null;

  const [branch] = await db.select().from(branches).where(eq(branches.id, anchor.branchId)).limit(1);

  const stationIds = ordered.map((b) => b.stationId).filter(Boolean) as string[];
  const chairs = stationIds.length
    ? await db
        .select({ id: stations.id, label: stations.label })
        .from(stations)
        .where(inArray(stations.id, stationIds))
    : [];
  const labelOf = new Map(chairs.map((c) => [c.id, c.label]));

  // Read live rather than snapshotted, like the promo code below. The invoice
  // is built after assignIfToday has run, so a booking taken for today already
  // knows whose it is — which is exactly the case this line exists for.
  const techIds = ordered.map((b) => b.technicianId).filter(Boolean) as string[];
  const techs = techIds.length
    ? await db
        .select({ id: staff.id, name: staff.name })
        .from(staff)
        .where(inArray(staff.id, techIds))
    : [];
  const techOf = new Map(techs.map((t) => [t.id, t.name]));

  const extras = await db
    .select()
    .from(bookingAddons)
    .where(inArray(bookingAddons.bookingId, bookingIds));

  // Any paid row on this bill carries the method and the gateway's reference —
  // a group shares one charge, so they all say the same thing.
  const [paid] = await db
    .select({ method: payments.method, providerRef: payments.providerRef, raw: payments.raw })
    .from(payments)
    .where(and(inArray(payments.bookingId, bookingIds), eq(payments.status, "paid")))
    .limit(1);

  // Read live rather than snapshotted: unlike a price, the code's *name* is not
  // something an edit can falsify — and the amount it took off is already frozen
  // in `discountHalalas`.
  const [promo] = anchor.promoCodeId
    ? await db
        .select({ code: promoCodes.code })
        .from(promoCodes)
        .where(eq(promoCodes.id, anchor.promoCodeId))
        .limit(1)
    : [];

  const { business_legal_name } = await getSettings(["business_legal_name"]);

  const guests: InvoiceGuest[] = ordered.map((b) => {
    const lines: InvoiceLine[] = [];

    if (b.serviceName) {
      lines.push({ label: b.serviceName, amountHalalas: b.servicePriceHalalas });
    }
    for (const extra of extras.filter((e) => e.bookingId === b.id)) {
      if (extra.name) lines.push({ label: extra.name, amountHalalas: extra.priceHalalas });
    }
    if (b.removalPriceHalalas > 0) {
      lines.push({
        label: { ar: "إزالة", en: "Removal" },
        amountHalalas: b.removalPriceHalalas,
      });
    }

    return {
      code: b.code,
      ticketNo: b.ticketNo,
      stationLabel: b.stationId ? (labelOf.get(b.stationId) ?? null) : null,
      technicianName: b.technicianId ? (techOf.get(b.technicianId) ?? null) : null,
      lines,
      discountHalalas: b.discountHalalas,
      totalHalalas: b.totalHalalas,
    };
  });

  const sum = (pick: (g: InvoiceGuest) => number) => guests.reduce((n, g) => n + pick(g), 0);
  const invoiceUrl = (paid?.raw as { invoiceUrl?: unknown } | null)?.invoiceUrl;
  const memberships = anchor.customerId
    ? await membershipsLeft(anchor.customerId, await packsSpentOn(bookingIds))
    : [];

  return {
    seller: {
      name: business_legal_name,
      branchName: branch?.name ?? null,
      branchAddress: branch?.address ?? null,
      branchPhone: branch?.phone ?? null,
    },
    customer: {
      name: customer.name,
      email,
      phone: customer.phone,
      lang: customer.lang,
    },
    startsAt: anchor.startsAt,
    method: paid?.method ?? null,
    providerRef: paid?.providerRef ?? null,
    guests,
    promoCode: promo?.code ?? null,
    discountHalalas: sum((g) => g.discountHalalas),
    totalHalalas: sum((g) => g.totalHalalas),
    taxInvoiceUrl: typeof invoiceUrl === "string" ? invoiceUrl : null,
    memberships,
  };
}
