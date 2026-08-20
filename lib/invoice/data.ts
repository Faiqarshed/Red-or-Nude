// Assembling a simplified tax invoice from bookings that have already been paid.
//
// Everything here is read back out of the booking rows rather than recomputed
// from the catalog: `serviceName`, `servicePriceHalalas`, the add-on snapshots
// and the VAT split were all frozen at booking time precisely so an invoice
// reprinted next year still says what the customer was charged today.
//
// KSA prices are VAT-inclusive, so the invoice *reports* the VAT already inside
// the total — it never adds any. Per guest, subtotal + VAT = total, and the
// guests' figures sum to the bill; see docs/BOOKING-V2.md "The discount maths"
// for why the two guests' VAT may differ by a halala from VAT on the whole bill.

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
  stations,
  type Localized,
} from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";
import type { PaymentMethod } from "@/lib/payments";

export type InvoiceLine = { label: Localized; amountHalalas: number };

export type InvoiceGuest = {
  code: string;
  ticketNo: string | null;
  stationLabel: string | null;
  lines: InvoiceLine[];
  discountHalalas: number;
  subtotalHalalas: number;
  vatHalalas: number;
  totalHalalas: number;
};

export type InvoiceData = {
  /** Deterministic: the same booking always renders the same invoice number. */
  number: string;
  issuedAt: Date;
  vatPercent: number;
  seller: {
    name: string;
    vatNumber: string | null;
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
  subtotalHalalas: number;
  vatHalalas: number;
  discountHalalas: number;
  totalHalalas: number;
};

/**
 * `INV-202608-4F2K` — the issue month plus the anchor booking's code suffix.
 *
 * Derived rather than drawn from a counter so that no new table, migration or
 * lock sits in the payment path, and so a reprint is byte-identical. Uniqueness
 * rides on `bookings.code`, which is already unique.
 *
 * ponytail: ZATCA wants invoice numbers to be sequential within a taxpayer. This
 * is unique and stable but not sequential, so it needs replacing with a real
 * counter before the salon files these — alongside the QR/XML work that a
 * compliant simplified invoice also needs. Fine while the gateway is a stub.
 */
function invoiceNumber(code: string, issuedAt: Date): string {
  const month = `${issuedAt.getUTCFullYear()}${String(issuedAt.getUTCMonth() + 1).padStart(2, "0")}`;
  return `INV-${month}-${code.replace(/^RON-/, "")}`;
}

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

  const extras = await db
    .select()
    .from(bookingAddons)
    .where(inArray(bookingAddons.bookingId, bookingIds));

  // Any paid row on this bill carries the method and the gateway's reference —
  // a group shares one charge, so they all say the same thing.
  const [paid] = await db
    .select({ method: payments.method, providerRef: payments.providerRef })
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

  const { vat_percent, business_legal_name, vat_number } = await getSettings([
    "vat_percent",
    "business_legal_name",
    "vat_number",
  ]);

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
      lines,
      discountHalalas: b.discountHalalas,
      subtotalHalalas: b.subtotalHalalas,
      vatHalalas: b.vatHalalas,
      totalHalalas: b.totalHalalas,
    };
  });

  const sum = (pick: (g: InvoiceGuest) => number) => guests.reduce((n, g) => n + pick(g), 0);
  const issuedAt = new Date();

  return {
    number: invoiceNumber(anchor.code, issuedAt),
    issuedAt,
    vatPercent: vat_percent,
    seller: {
      name: business_legal_name,
      vatNumber: vat_number || null,
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
    subtotalHalalas: sum((g) => g.subtotalHalalas),
    vatHalalas: sum((g) => g.vatHalalas),
    discountHalalas: sum((g) => g.discountHalalas),
    totalHalalas: sum((g) => g.totalHalalas),
  };
}
