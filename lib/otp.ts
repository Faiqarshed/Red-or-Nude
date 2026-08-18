// One-time codes for opening a booking's private details at /my-bookings.
//
// The booking reference is a weak credential on its own — it travels in emails
// and gets forwarded — so anything past a booking's own summary is gated behind
// a code sent to the address on file. Reference + inbox is two factors without
// an account, which is the most that can be asked of a customer who never
// signed up.
//
// Rules, and why each one is here:
//   • the code is HASHED at rest — this table guards customer data, so a
//     database leak must not hand over live codes
//   • single use — consumed on the first successful verify
//   • 10 minutes — long enough to switch to an inbox, short enough that a
//     forwarded email is not a standing key
//   • 5 attempts — six digits is only a million, and an unlimited verify walks
//     it in minutes
//   • one live code per booking — requesting a new one invalidates the old,
//     so two emails can never both work

import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookingOtps } from "@/lib/db/schema";

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;

/** Six digits, zero-padded — `randomInt` is CSPRNG-backed, unlike Math.random. */
export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

/**
 * SHA-256, unsalted and unstretched — deliberately, unlike a password.
 *
 * A password hash is slow to resist offline cracking of a human-chosen secret.
 * This is a random six-digit value that dies in ten minutes: the whole keyspace
 * is a million entries, so any hash is trivially reversible by a table and
 * bcrypt would buy nothing except latency on a request the customer is waiting
 * for. What hashing does buy is that a leaked database dump has no *live* codes
 * in it, which is the realistic threat.
 */
function hash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Constant-time compare, so a wrong code can't be narrowed by response timing. */
function sameHash(a: string, b: string): boolean {
  // Uint8Array rather than Buffer: timingSafeEqual's types reject Buffer under
  // this @types/node, and the byte view is what it actually wants.
  const x = Uint8Array.from(Buffer.from(a, "hex"));
  const y = Uint8Array.from(Buffer.from(b, "hex"));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Issue a code for a booking, invalidating any earlier live one.
 * Returns the plaintext — the *only* moment it exists outside the email.
 */
export async function issueOtp(bookingId: string): Promise<string> {
  // Burn outstanding codes first: two valid codes in two inboxes is one more
  // way in than the customer asked for.
  await db
    .update(bookingOtps)
    .set({ consumedAt: new Date() })
    .where(and(eq(bookingOtps.bookingId, bookingId), isNull(bookingOtps.consumedAt)));

  const code = generateOtp();
  await db.insert(bookingOtps).values({
    bookingId,
    codeHash: hash(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  return code;
}

export type VerifyOtpResult =
  | { ok: true }
  /**
   * `no-code` covers expired, already-used and never-issued alike — the query
   * below filters all three out, so they are indistinguishable here and the
   * customer's next move is the same for each: ask for a new one.
   */
  | { ok: false; reason: "no-code" | "too-many-attempts" | "wrong" };

/**
 * Check a code and consume it on success.
 *
 * The reasons are deliberately distinguishable to the customer — "that code has
 * expired" and "that code is wrong" need different actions from them, and
 * neither tells an attacker anything they couldn't learn by requesting a code
 * themselves. What is *not* leaked is whether the reference exists at all; that
 * decision belongs to the caller.
 */
export async function verifyOtp(bookingId: string, code: string): Promise<VerifyOtpResult> {
  const [row] = await db
    .select()
    .from(bookingOtps)
    .where(
      and(
        eq(bookingOtps.bookingId, bookingId),
        isNull(bookingOtps.consumedAt),
        gt(bookingOtps.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(bookingOtps.createdAt))
    .limit(1);

  if (!row) return { ok: false, reason: "no-code" };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "too-many-attempts" };

  if (!sameHash(row.codeHash, hash(code.trim()))) {
    const attempts = row.attempts + 1;
    await db
      .update(bookingOtps)
      .set({
        attempts,
        // Out of attempts: burn it so a fresh request is the only way forward.
        consumedAt: attempts >= OTP_MAX_ATTEMPTS ? new Date() : null,
      })
      .where(eq(bookingOtps.id, row.id));
    return { ok: false, reason: attempts >= OTP_MAX_ATTEMPTS ? "too-many-attempts" : "wrong" };
  }

  await db.update(bookingOtps).set({ consumedAt: new Date() }).where(eq(bookingOtps.id, row.id));
  return { ok: true };
}

/** `f•••@gmail.com` — enough for "check that inbox", not enough to harvest. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "•••";
  return `${user.slice(0, 1)}${"•".repeat(Math.max(user.length - 1, 1))}@${domain}`;
}
