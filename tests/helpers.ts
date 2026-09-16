// Shared fixtures for the local suites.
//
// Every helper that deletes is scoped to a branch or to this file's own phone
// prefix. The gate in tests/setup.ts has already refused to run against
// anything but a local `*_test` database by the time any of this executes.

import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bookings,
  branches,
  customers,
  services,
  staff,
  stations,
  ticketCounters,
} from "@/lib/db/schema";
import { UTC_OFFSET_HOURS, riyadhDateKey } from "@/lib/time";

/**
 * Distinct from the check scripts' `0500000001`, so a stray row left by one
 * cannot be mistaken for — or deleted as — a fixture of the other.
 */
export const TEST_PHONE = "0500000090";
const PHONE_PREFIX = "050000009%";

export type Fixtures = {
  branchA: string;
  branchB: string;
  /** Two distinct active services, most expensive first. */
  svcA: { id: string; priceHalalas: number; durationMin: number };
  svcB: { id: string; priceHalalas: number; durationMin: number };
  chairsA: number;
  chairsB: number;
};

/** The seeded world these suites are written against. */
export async function fixtures(): Promise<Fixtures> {
  const branchRows = await db.select().from(branches).orderBy(branches.id);
  const serviceRows = await db.select().from(services).where(eq(services.active, true));
  const chairRows = await db.select().from(stations).where(eq(stations.active, true));

  if (branchRows.length < 2) throw new Error("these suites need two seeded branches");
  if (serviceRows.length < 2) throw new Error("these suites need two active services");

  const [branchA, branchB] = branchRows;
  const [svcA, svcB] = serviceRows;

  return {
    branchA: branchA.id,
    branchB: branchB.id,
    svcA: { id: svcA.id, priceHalalas: svcA.priceHalalas, durationMin: svcA.durationMin },
    svcB: { id: svcB.id, priceHalalas: svcB.priceHalalas, durationMin: svcB.durationMin },
    chairsA: chairRows.filter((c) => c.branchId === branchA.id).length,
    chairsB: chairRows.filter((c) => c.branchId === branchB.id).length,
  };
}

/**
 * Empty the branches these suites use.
 *
 * Deletes every booking at the branch, not only the ones a test made — the same
 * bluntness the check scripts use, and the reason the database has to be named
 * `*_test`. `ticket_counters` is deliberately left alone: it is a monotonic
 * counter and the assertions read deltas across it, never absolute numbers.
 */
export async function reset(...branchIds: string[]): Promise<void> {
  if (branchIds.length) {
    await db.delete(bookings).where(inArray(bookings.branchId, branchIds));
  }
  await db.delete(customers).where(like(customers.phone, PHONE_PREFIX));
}

/** Where each branch's queue has got to, so a test can assert it moved by one. */
export async function counters(
  branchIds: string[],
  day: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select()
    .from(ticketCounters)
    .where(and(inArray(ticketCounters.branchId, branchIds), eq(ticketCounters.day, day)));
  return Object.fromEntries(
    branchIds.map((id) => [id, rows.find((r) => r.branchId === id)?.next ?? 1]),
  );
}

/**
 * Inverse of formatTicketNo, so "B99" and "C1" compare as consecutive.
 * The counter survives `reset`, so which side of a letter boundary a fixture
 * lands on is luck — comparing the digits alone would fail there.
 */
export const ticketOrdinal = (t: string): number =>
  (t.charCodeAt(0) - 65) * 99 + Number(t.slice(1));

/** A fixed instant far enough out that no seeded row shares it. 09:00 Riyadh. */
export const FUTURE = Date.UTC(2031, 4, 14, 6, 0);

/**
 * Today in Riyadh at `hour` local, as a UTC instant.
 *
 * assignIfToday only acts on today, so the staffing suite cannot use FUTURE.
 * Built from the Riyadh date key rather than from `new Date()` directly, so a
 * run just before or after UTC midnight still lands on the day the salon is
 * having.
 */
export function todayAt(hour: number): Date {
  const [y, m, d] = riyadhDateKey(new Date()).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - UTC_OFFSET_HOURS, 0, 0, 0));
}

/** The rows of a group, oldest first — the order createBookings wrote them in. */
export async function groupRows(groupId: string) {
  return db
    .select()
    .from(bookings)
    .where(eq(bookings.groupId, groupId))
    .orderBy(bookings.createdAt, bookings.id);
}

/** Technicians on a branch's floor, for the staffing assertions. */
export async function techniciansAt(branchId: string) {
  return db
    .select()
    .from(staff)
    .where(and(eq(staff.branchId, branchId), eq(staff.role, "technician"), eq(staff.active, true)));
}
