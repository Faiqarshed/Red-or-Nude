// Fixtures and mocks the admin suite needs and the shared Fixtures class does
// not carry: a staff session to invoke a Server Action as, a spy on
// revalidatePath, and a reader for the audit trail.
//
// Every admin Server Action starts with requireCan(), which reads the session
// through auth() in lib/auth/index.ts. So the whole suite mocks that one module
// and drives the role from here — the real guard, the real capability matrix,
// the real WHERE clauses, only the cookie faked.
//
// Read the note on `asNobody` before writing a signed-out test. It is not as
// simple as "return no session".

import { vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auditLog,
  loyaltyTxns,
  payments,
  reviews,
  type StaffRole,
} from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";

export type Actor = {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  branchId: string | null;
};

/** Who auth() will say is signed in. Null is a signed-out visitor. */
let actor: Actor | null = null;

/** The stand-in for `auth()` — install it with `vi.mock("@/lib/auth", …)`. */
export const authMock = vi.fn(async () => (actor ? { user: actor } : null));

export const signInMock = vi.fn(async () => undefined);
export const signOutMock = vi.fn(async () => undefined);

/** The whole `@/lib/auth` surface, so one line in each test file installs it. */
export const authModuleMock = {
  auth: authMock,
  signIn: signInMock,
  signOut: signOutMock,
  handlers: {},
};

export function actingAs(a: Actor | null): void {
  actor = a;
}

/** Build a session for a staff row the fixtures made. */
export function sessionFor(row: {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  branchId: string | null;
}): Actor {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    branchId: row.branchId,
  };
}

/**
 * A signed-out visitor — and the reason it takes more than clearing the actor.
 *
 * `currentStaff()` falls back to `devFallbackStaff()` whenever NODE_ENV is not
 * "production", which hands an unauthenticated caller the seeded CEO so `next
 * dev` needs no login. Under vitest NODE_ENV is "test", so a bare "no session"
 * test would silently run as the CEO and pass for the wrong reason.
 *
 * Stubbing NODE_ENV is therefore part of the attack, not a workaround: what a
 * deployed panel does to an unauthenticated caller is what we are asserting.
 * `restoreSession()` puts it back.
 */
export function asNobody(): void {
  actor = null;
  vi.stubEnv("NODE_ENV", "production");
}

export function restoreSession(): void {
  actor = null;
  vi.unstubAllEnvs();
}

// ---------------------------------------------------------- next/cache ------

export const revalidatePathMock = vi.fn();
export const revalidateTagMock = vi.fn();
export const nextCacheMock = {
  revalidatePath: revalidatePathMock,
  revalidateTag: revalidateTagMock,
  unstable_cache: (fn: unknown) => fn,
};

/** `next/headers` outside a request: enough for anything that peeks at it. */
export const nextHeadersMock = {
  cookies: () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: () => new Map(),
};

// -------------------------------------------------------------- audit -------

/** Phase 10 lens 12: every privileged action has to leave a trail. */
export async function auditRowsFor(entity: string, entityId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)))
    .orderBy(desc(auditLog.createdAt));
}

/**
 * Audit rows are not fixtures — the code under test writes them — so they have
 * to be swept by entity id or they accumulate in a shared database.
 */
export async function forgetAudit(entity: string, entityId: string) {
  await db
    .delete(auditLog)
    .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)));
}

// ------------------------------------------------- money-bearing children ---
//
// deleteBooking refuses a booking carrying any of these three. The shared
// Fixtures class builds none of them, so they live here — claimed against the
// fixture instance so cleanup() still removes exactly what a test created.

export async function payFor(fx: Fixtures, bookingId: string, status: "paid" | "failed" = "paid") {
  const [row] = await db
    .insert(payments)
    .values({ bookingId, amountHalalas: 25_000, status, provider: "manual" })
    .returning();
  fx.claim(payments, row.id);
  return row;
}

export async function reviewOf(fx: Fixtures, bookingId: string, submitted: boolean) {
  const [row] = await db
    .insert(reviews)
    .values({
      bookingId,
      serviceRating: submitted ? 5 : null,
      submittedAt: submitted ? new Date() : null,
    })
    .returning();
  fx.claim(reviews, row.id);
  return row;
}

export async function pointsOn(fx: Fixtures, customerId: string, bookingId: string) {
  const [row] = await db
    .insert(loyaltyTxns)
    .values({ customerId, bookingId, deltaPoints: 30, reason: "visit" })
    .returning();
  fx.claim(loyaltyTxns, row.id);
  return row;
}

/** The four roles, in the order lib/auth/rbac.ts lists them. */
export const ROLES: StaffRole[] = ["ceo", "admin", "receptionist", "technician"];
