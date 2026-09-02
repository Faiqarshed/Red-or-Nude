// Fixture builders shared by every test file.
//
// The rule this file exists to enforce: **never empty a table.** The check
// scripts under scripts/ build their fixtures with
// `db.delete(bookings).where(eq(bookings.branchId, …))`, which is what deleted
// eighty real bookings on 2026-09-01. Here every insert is recorded and torn
// down by id, so a test only ever removes rows it created — even when pointed
// at a database that already has data in it.
//
// Usage:
//
//   const fx = new Fixtures();
//   afterEach(() => fx.cleanup());
//
//   const branch = await fx.branch();          // + hours + 2 stations
//   const svc    = await fx.service({ priceHalalas: 25_000 });
//   const tech   = await fx.staff("technician", branch.id);

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  addons,

  bookings,
  branchHours,
  branches,
  closures,
  customers,
  giftCards,
  loyaltyTxns,
  otps,
  payments,
  promoCodes,
  reviews,
  services,
  staff,
  staffTimeOff,
  stations,
  type Localized,
  type StaffRole,
} from "@/lib/db/schema";

/** Unique per test run, so two files never fight over a phone number. */
let seq = 0;
export const tag = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

const loc = (en: string): Localized => ({ ar: en, en });

// Reverse-dependency order. Anything created by a test is deleted from the
// bottom of this list upward, so children go before the rows they reference.
// booking_addons is absent deliberately: it has no id column (composite PK) and
// cascades from bookings, so deleting the booking takes it.
const TEARDOWN_ORDER = [
  loyaltyTxns,
  reviews,
  payments,
  bookings,
  otps,
  giftCards,
  promoCodes,
  closures,
  staffTimeOff,
  stations,
  branchHours,
  addons,
  services,
  customers,
  staff,
  branches,
] as const;

type Table = (typeof TEARDOWN_ORDER)[number];

export class Fixtures {
  private created = new Map<Table, string[]>();

  private track<T extends { id: string }>(table: Table, row: T): T {
    const ids = this.created.get(table) ?? [];
    ids.push(row.id);
    this.created.set(table, ids);
    return row;
  }

  /** A branch with a full week of 10:00–22:00 hours and `stationCount` chairs. */
  async branch(opts: { stationCount?: number; name?: string } = {}) {
    const [row] = await db
      .insert(branches)
      .values({
        name: loc(opts.name ?? `Test Branch ${tag()}`),
        address: loc("1 Test Street, Riyadh"),
      })
      .returning();
    this.track(branches, row);

    // weekday 0 = Saturday, matching the site's calendar (schema.ts:168).
    for (let weekday = 0; weekday < 7; weekday++) {
      const [h] = await db
        .insert(branchHours)
        .values({ branchId: row.id, weekday, opens: "10:00:00", closes: "22:00:00" })
        .returning();
      this.track(branchHours, h);
    }

    const chairs = [];
    for (let i = 0; i < (opts.stationCount ?? 2); i++) {
      const [s] = await db
        .insert(stations)
        .values({ branchId: row.id, label: `Chair ${i + 1}`, sort: i })
        .returning();
      chairs.push(this.track(stations, s));
    }

    return { ...row, stations: chairs };
  }

  async service(opts: Partial<typeof services.$inferInsert> = {}) {
    const [row] = await db
      .insert(services)
      .values({
        name: loc(`Test Service ${tag()}`),
        priceHalalas: 25_000,
        durationMin: 60,
        ...opts,
      })
      .returning();
    return this.track(services, row);
  }

  async addon(opts: Partial<typeof addons.$inferInsert> = {}) {
    const [row] = await db
      .insert(addons)
      .values({ name: loc(`Test Addon ${tag()}`), priceHalalas: 5_000, ...opts })
      .returning();
    return this.track(addons, row);
  }

  /**
   * A customer. Phones are unique in the schema, so the default is generated —
   * pass one explicitly only when the test is about that number.
   *
   * `verified: true` stamps emailVerifiedAt, which is what turns a customer row
   * into a sign-in-able account (schema.ts:340).
   */
  async customer(opts: Partial<typeof customers.$inferInsert> & { verified?: boolean } = {}) {
    const { verified, ...rest } = opts;
    const [row] = await db
      .insert(customers)
      .values({
        phone: `05${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        name: "Test Customer",
        email: `${tag()}@example.test`,
        ...(verified ? { emailVerifiedAt: new Date() } : {}),
        ...rest,
      })
      .returning();
    return this.track(customers, row);
  }

  /** Staff emails are unique; the default is generated for the same reason. */
  async staff(role: StaffRole, branchId: string | null = null, opts: Partial<typeof staff.$inferInsert> = {}) {
    const [row] = await db
      .insert(staff)
      .values({ name: `Test ${role}`, email: `${tag()}@staff.test`, role, branchId, ...opts })
      .returning();
    return this.track(staff, row);
  }

  async booking(opts: Partial<typeof bookings.$inferInsert> & { branchId: string }) {
    const startsAt = opts.startsAt ?? new Date(Date.now() + 3_600_000);
    const [row] = await db
      .insert(bookings)
      .values({
        // Not truncated: tag() puts its uniqueness counter last, so slicing is
        // exactly how two bookings made in the same millisecond collide on
        // bookings_code_unique.
        code: `RON-${tag().toUpperCase()}`,
        startsAt,
        endsAt: opts.endsAt ?? new Date(new Date(startsAt).getTime() + 3_600_000),
        ...opts,
      })
      .returning();
    return this.track(bookings, row);
  }

  /** Record a row this test caused some *other* code path to insert. */
  claim(table: Table, id: string) {
    const ids = this.created.get(table) ?? [];
    ids.push(id);
    this.created.set(table, ids);
  }

  /** Every row this instance created, and nothing else. Safe to call twice. */
  async cleanup() {
    for (const table of TEARDOWN_ORDER) {
      const ids = this.created.get(table);
      if (!ids?.length) continue;
      await db.delete(table).where(inArray(table.id, ids));
    }
    this.created.clear();
  }

  /** Bookings the code under test created against a branch this fixture owns. */
  async claimBookingsOf(branchId: string) {
    const rows = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.branchId, branchId));
    for (const r of rows) this.claim(bookings, r.id);
  }
}
