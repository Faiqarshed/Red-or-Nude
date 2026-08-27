// The customer session token (brief §2.8).
//
// An encrypted JWT in an httpOnly cookie, minted with Auth.js's own `encode` /
// `decode`. Those are already a dependency and already what the staff side runs
// on (lib/auth/config.ts sets `strategy: "jwt"`), so this adds no package and
// no hand-written crypto to a path where hand-written crypto is exactly the
// wrong instinct.
//
// **This is not the staff Auth.js instance and must never become it.**
// currentStaff() in lib/auth/guard.ts returns any `session.user` as staff, and
// /admin itself carries no capability gate — a customer signed into the staff
// instance would land on the staff dashboard. Two audiences, two token spaces.
//
// The two are separated by SALT, not merely by cookie name. Auth.js derives the
// encryption key from `secret + salt`, so a staff token handed to `readSession`
// fails to decrypt rather than decoding into something this code then has to be
// careful about. Swapping the cookies by hand is a five-second test; do it.
//
// Why a token and not a sessions table: every authenticated request loads the
// customer row anyway — blocked flag, points balance, bookings — so a stateless
// token costs no extra query, and the revocation a table would buy is already
// covered by `customers.blocked`. Rotating AUTH_SECRET signs everyone out.

import "server-only";
import { encode, decode } from "next-auth/jwt";

/** Cookie name. Distinct from Auth.js's own, which is `authjs.session-token`. */
export const ACCOUNT_COOKIE = "ron_account";

/** Key separation from the staff token. Changing this signs every customer out. */
const SALT = ACCOUNT_COOKIE;

/**
 * How long a customer stays signed in.
 *
 * Thirty days: a salon booking is a monthly-ish habit, so a shorter window
 * mostly means re-authenticating every visit for no attacker it stops. The
 * session does gate a points wallet that converts to money, which is why it is
 * thirty and not a year. Change this constant and both the cookie's Max-Age and
 * the token's own `exp` move together.
 */
export const SESSION_TTL_S = 30 * 24 * 60 * 60;

/**
 * The short-lived proof that an address was verified, used between the code and
 * the profile form at signup.
 *
 * It exists because the OTP is consumed on its first successful verify, while
 * `customers.phone` is NOT NULL — so the row cannot be created until the
 * profile fields arrive on a second request, and that second request needs to
 * prove the first one happened. Fifteen minutes is long enough to type a name.
 */
export const SIGNUP_TTL_S = 15 * 60;

function secret(): string {
  const value = process.env.AUTH_SECRET?.trim();
  if (!value) {
    // Loud, and fatal in production. An empty key does not fail closed — it
    // mints tokens anyone can forge, which is worse than no sign-in at all.
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET is not set — refusing to mint customer sessions");
    }
    // Development only, so `npm run dev` works from a fresh clone before the
    // env file is filled in. Never reachable in a deployed build.
    return "dev-only-insecure-secret";
  }
  return value;
}

/** Mint a 30-day session token for a customer. */
export function mintSession(customerId: string): Promise<string> {
  return encode({ token: { sub: customerId }, secret: secret(), salt: SALT, maxAge: SESSION_TTL_S });
}

/**
 * Read a session token. Returns the customer id, or null for anything wrong —
 * expired, tampered with, minted under a different salt, or absent.
 *
 * Never throws: a bad cookie is an ordinary event (an old token after a secret
 * rotation, a truncated value) and it means "signed out", not "error page".
 */
export async function readSession(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const claims = await decode({ token, secret: secret(), salt: SALT });
    // `decode` already rejects an expired token; this is the belt to that
    // braces, and it is also what catches a token with no subject at all.
    return typeof claims?.sub === "string" && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

/** Mint the 15-minute ticket that carries a verified address to the signup form. */
export function mintSignupTicket(email: string): Promise<string> {
  return encode({
    token: { sub: `signup:${email.trim().toLowerCase()}` },
    secret: secret(),
    salt: SALT,
    maxAge: SIGNUP_TTL_S,
  });
}

/** Read a signup ticket back to the address it was minted for, or null. */
export async function readSignupTicket(token: string | undefined): Promise<string | null> {
  const subject = await readSession(token);
  // The `signup:` prefix is load-bearing: without it a *session* token would be
  // accepted here, letting a signed-in customer register an address they never
  // proved they own.
  return subject?.startsWith("signup:") ? subject.slice("signup:".length) : null;
}
