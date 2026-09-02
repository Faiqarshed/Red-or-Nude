// The customer account surface, attacked rather than exercised.
//
// An account here IS a customer row with `email_verified_at` stamped — there is
// no accounts table (lib/db/schema.ts:340). That single fact is what makes this
// area delicate: the row the salon has been writing bookings against since the
// customer's first walk-in is the same row a stranger is trying to sign up on,
// and the key both paths agree on is a phone number.
//
// What would be easy to break: the four properties the route comments claim for
// themselves — the address comes from the ticket and never the body, a session
// token is not a signup ticket, the sign-in code is spent once, and no response
// tells an anonymous caller whether an address has an account. Each is asserted
// below by performing the attack it is supposed to stop.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, otps } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { post, read, resetAppContext, nextIp } from "../helpers/app";

vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);
// Never send mail from a test. The sink still records, so "did it send" is
// answerable; what it must not do is reach a real SMTP server.
const sent = vi.hoisted(() => [] as Array<{ to: string; code: string; lang: string }>);
vi.mock("@/lib/otp-email", () => ({
  sendOtpEmail: async (input: { to: string; code: string; lang: string }) => {
    sent.push(input);
    return { ok: true as const };
  },
}));

const fx = new Fixtures();

/**
 * The numbers this file registers against, listed so they can be cleared first.
 *
 * The register route inserts rows of its own, and a case that fails partway
 * leaves one behind that no Fixtures instance owns — which then collides with
 * customers_phone_unique on the next run and fails the *next* test instead.
 * Enumerated literally rather than matched with LIKE: deleting by a pattern is
 * how scripts/_test-db.ts came to exist.
 */
const PHONES = Array.from({ length: 12 }, (_, i) => `05120000${String(i).padStart(2, "0")}`);

beforeAll(async () => {
  await db.delete(customers).where(inArray(customers.phone, PHONES));
});

beforeEach(() => {
  resetAppContext();
  sent.length = 0;
});
afterEach(async () => {
  await fx.cleanup();
  await db.delete(customers).where(inArray(customers.phone, PHONES));
});

const REGISTER = "http://x/api/account/register";

/** The 15-minute proof that an address was verified. */
async function ticketFor(email: string) {
  const { mintSignupTicket } = await import("@/lib/account/session");
  return mintSignupTicket(email);
}

// ------------------------------------------------- register: the takeover ---

describe("POST /api/account/register", () => {
  it("takes the address from the ticket, never from the body", async () => {
    // The route's whole security property (its file comment). Posting a
    // different address alongside a valid ticket must not register that one.
    const { POST } = await import("@/app/api/account/register/route");
    const res = await POST(
      post(REGISTER, {
        ticket: await ticketFor("proven@example.test"),
        name: "Sara",
        phone: "0512000001",
        email: "notproven@example.test", // the attack: an unproven address
      }),
    );
    expect(res.status).toBe(200);

    const [row] = await db.select().from(customers).where(eq(customers.phone, "0512000001"));
    fx.claim(customers, row.id);
    expect(row.email, "the body's address was written instead of the ticket's").toBe(
      "proven@example.test",
    );
  });

  it("refuses a session token used as a signup ticket", async () => {
    // lib/account/session.ts calls the `signup:` prefix load-bearing: without
    // it a signed-in customer could register an address they never proved.
    const { mintSession } = await import("@/lib/account/session");
    const victim = await fx.customer({ verified: true });
    const { POST } = await import("@/app/api/account/register/route");
    const { status, body } = await read(
      await POST(
        post(REGISTER, { ticket: await mintSession(victim.id), name: "X", phone: "0512000002" }),
      ),
    );
    expect(status).toBe(401);
    expect(body.error).toBe("ticket-expired");
  });

  it("refuses a forged ticket", async () => {
    const { POST } = await import("@/app/api/account/register/route");
    const res = await POST(
      post(REGISTER, { ticket: "not.a.real.jwt", name: "X", phone: "0512000003" }),
    );
    expect(res.status).toBe(401);
  });

  it("keeps the guest row so a returning customer keeps their bookings", async () => {
    // The documented reason for upserting on phone: a guest who booked from
    // this number keeps their history instead of starting a second row.
    const guest = await fx.customer({ phone: "0512000004", name: "Guest", email: null });
    const { POST } = await import("@/app/api/account/register/route");
    await POST(
      post(REGISTER, {
        ticket: await ticketFor("guest@example.test"),
        name: "Guest Grown Up",
        phone: "0512000004",
      }),
    );
    const [row] = await db.select().from(customers).where(eq(customers.id, guest.id));
    expect(row.id, "a second row was started instead of claiming the guest's").toBe(guest.id);
    expect(row.emailVerifiedAt).not.toBeNull();
  });

  /**
   * ACCOUNT TAKEOVER — see docs/_testing/known-bugs-auth.md BUG-AUTH-001.
   *
   * The attack: prove an inbox you own, then register with someone else's phone
   * number. `onConflictDoUpdate` on `customers.phone` overwrites the victim's
   * name, email and emailVerifiedAt in place, and the attacker is handed a
   * session cookie for the victim's row — with their bookings, their loyalty
   * ledger and their history attached.
   *
   * The route expects the database to stop this. Its catch block reads
   * "Almost certainly the partial unique index: this phone's row already
   * carries a *different* verified address. One person, one account."
   * That index (schema.ts:361) forbids two *rows* sharing a verified address.
   * It cannot see one row's address being changed to a free one, so nothing
   * throws and the 409 is never reached.
   *
   * Marked `fails` deliberately: it asserts the behaviour the comment promises,
   * so the day the guard lands this test goes green and the fix is visible in
   * the diff rather than silent.
   */
  it.fails("refuses a phone whose row already has a different verified address", async () => {
    const victim = await fx.customer({
      verified: true,
      name: "Victim",
      phone: "0512000005",
      email: "victim@example.test",
    });

    const { POST } = await import("@/app/api/account/register/route");
    const { status } = await read(
      await POST(
        post(REGISTER, {
          ticket: await ticketFor("attacker@example.test"),
          name: "Attacker",
          phone: "0512000005",
        }),
      ),
    );
    expect(status, "the takeover was accepted").toBe(409);

    const [row] = await db.select().from(customers).where(eq(customers.id, victim.id));
    expect(row.email, "the victim's address was overwritten").toBe("victim@example.test");
    expect(row.name).toBe("Victim");
  });

  // @characterization — pins the takeover as it behaves on 2026-09-02, so the
  // register route is not silently changed in some third direction while
  // BUG-AUTH-001 is open. Delete this when the test above goes green.
  it("today, that same request takes the account over", async () => {
    const victim = await fx.customer({
      verified: true,
      name: "Victim",
      phone: "0512000006",
      email: "victim6@example.test",
    });
    const { POST } = await import("@/app/api/account/register/route");
    const { status, body } = await read(
      await POST(
        post(REGISTER, {
          ticket: await ticketFor("attacker6@example.test"),
          name: "Attacker",
          phone: "0512000006",
        }),
      ),
    );
    expect({ status, body }).toEqual({ status: 200, body: { ok: true } });

    const [row] = await db.select().from(customers).where(eq(customers.id, victim.id));
    expect(row.email).toBe("attacker6@example.test");
    expect(row.name).toBe("Attacker");
    expect(row.emailVerifiedAt).not.toBeNull();
  });

  it("ignores privileged columns posted alongside the profile", async () => {
    // Mass assignment: the body is spread into neither .values() nor .set(),
    // and this proves it stays that way.
    const { POST } = await import("@/app/api/account/register/route");
    await POST(
      post(REGISTER, {
        ticket: await ticketFor("mass@example.test"),
        name: "Sara",
        phone: "0512000007",
        blocked: true,
        id: "00000000-0000-0000-0000-000000000000",
        notes: "injected",
      }),
    );
    const [row] = await db.select().from(customers).where(eq(customers.phone, "0512000007"));
    fx.claim(customers, row.id);
    expect(row.blocked, "a caller set their own blocked flag").toBe(false);
    expect(row.notes, "a caller wrote a staff-only column").toBeNull();
    expect(row.id).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("refuses a phone that is not a Saudi mobile", async () => {
    const { POST } = await import("@/app/api/account/register/route");
    // 04x is a landline and cannot receive the SMS this number exists for;
    // +1 normalises to nine digits that do not start with 5.
    for (const phone of ["", "   ", "12345", "0412000001", "+15551234567"]) {
      const { status } = await read(
        await POST(post(REGISTER, { ticket: await ticketFor("p@example.test"), name: "X", phone })),
      );
      expect(status, `"${phone}" was accepted as a Saudi mobile`).toBe(400);
    }
  });

  // @characterization — lib/phone.ts:26 says trailing digits past nine are
  // "dropped rather than silently reordered". Dropping them is still silent:
  // a mistyped extra digit registers a *different* number without complaint,
  // and that number is what an OTP would be sent to. See BUG-AUTH-002.
  it("silently truncates a phone number with extra digits on the end", async () => {
    const { POST } = await import("@/app/api/account/register/route");
    const res = await POST(
      post(REGISTER, {
        ticket: await ticketFor("trunc@example.test"),
        name: "X",
        phone: "05120000119999",
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(customers).where(eq(customers.phone, "0512000011"));
    fx.claim(customers, row.id);
    expect(row.phone).toBe("0512000011");
  });

  it("refuses malformed JSON and a missing name", async () => {
    const { POST } = await import("@/app/api/account/register/route");
    expect((await POST(post(REGISTER, "{not json"))).status).toBe(400);
    const { status } = await read(
      await POST(post(REGISTER, { ticket: await ticketFor("n@example.test"), phone: "0512000008" })),
    );
    expect(status).toBe(400);
  });

  it("signs a blocked customer out rather than in", async () => {
    await fx.customer({ phone: "0512000009", blocked: true });
    const { POST } = await import("@/app/api/account/register/route");
    const { status, body } = await read(
      await POST(
        post(REGISTER, {
          ticket: await ticketFor("blocked@example.test"),
          name: "B",
          phone: "0512000009",
        }),
      ),
    );
    expect(status).toBe(403);
    expect(body.error).toBe("blocked");
  });

  it("throttles at ten attempts from one address", async () => {
    const { POST } = await import("@/app/api/account/register/route");
    const ip = "203.0.113.44";
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await POST(post(REGISTER, { ticket: "bad", name: "X", phone: "0512000010" }, { ip }));
      codes.push(res.status);
    }
    expect(codes.filter((c) => c === 429).length, "the eleventh attempt was not throttled")
      .toBeGreaterThan(0);
  });
});

// --------------------------------------------------- no enumeration oracle --

describe("POST /api/account/otp — the only entry point to an account", () => {
  it("answers identically for an address with an account and one without", async () => {
    const known = await fx.customer({ verified: true, email: "known@example.test" });
    expect(known.emailVerifiedAt).not.toBeNull();

    const { POST } = await import("@/app/api/account/otp/route");
    const a = await read(await POST(post("http://x/api/account/otp", { email: "known@example.test" })));
    const b = await read(await POST(post("http://x/api/account/otp", { email: "nobody@example.test" })));

    // Same status and same body shape — otherwise a stranger can walk a list of
    // addresses and learn who is a customer of this salon.
    expect(a.status).toBe(b.status);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
    expect(a.body.sent).toBe(b.body.sent);
  });

  it("holds a second code for the same address back for a minute", async () => {
    const { POST } = await import("@/app/api/account/otp/route");
    const email = `mailbomb${Date.now()}@example.test`;
    await POST(post("http://x/api/account/otp", { email }));
    const second = await read(await POST(post("http://x/api/account/otp", { email })));
    // Reported honestly rather than silently dropped — the route says so.
    expect(second.body.throttled).toBe(true);
    expect(sent.length, "a second email went out inside the window").toBe(1);
  });
});

// ------------------------------------------------------------ spending it ---

describe("POST /api/account/verify", () => {
  it("spends a code exactly once", async () => {
    const { issueOtp, emailSubject } = await import("@/lib/otp");
    const email = `once${Date.now()}@example.test`;
    const code = await issueOtp(emailSubject(email));

    const { POST } = await import("@/app/api/account/verify/route");
    const first = await read(await POST(post("http://x/api/account/verify", { email, code })));
    expect(first.status).toBe(200);

    // Replay. A consumed code must not verify a second time.
    const replay = await read(await POST(post("http://x/api/account/verify", { email, code })));
    expect(replay.status, "the same code verified twice").toBe(401);

    await db.delete(otps).where(eq(otps.subject, emailSubject(email)));
  });

  it("burns the code after five wrong guesses", async () => {
    const { issueOtp, emailSubject, OTP_MAX_ATTEMPTS } = await import("@/lib/otp");
    const email = `guess${Date.now()}@example.test`;
    const real = await issueOtp(emailSubject(email));
    const wrong = real === "000000" ? "111111" : "000000";

    const { POST } = await import("@/app/api/account/verify/route");
    const ip = nextIp();
    let last;
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      last = await read(await POST(post("http://x/api/account/verify", { email, code: wrong }, { ip })));
    }
    // The fifth wrong guess is the one that burns it.
    expect(last!.body.error).toBe("too-many-attempts");

    // And the real code is worthless afterwards — burning sets consumedAt, so
    // the next lookup finds no live code at all rather than a spent one.
    const { status, body } = await read(
      await POST(post("http://x/api/account/verify", { email, code: real }, { ip })),
    );
    expect(status).toBe(401);
    expect(body.error).toBe("no-code");

    await db.delete(otps).where(eq(otps.subject, emailSubject(email)));
  });

  it("refuses a code of the wrong length without touching the database", async () => {
    const { POST } = await import("@/app/api/account/verify/route");
    for (const code of ["", "1", "12345", "1234567"]) {
      const { status } = await read(
        await POST(post("http://x/api/account/verify", { email: "a@b.test", code })),
      );
      expect(status, `a ${code.length}-digit code reached the verifier`).toBe(400);
    }
  });
});

// --------------------------------------------------------------- sessions ---

describe("the customer session token", () => {
  it("does not accept a staff token, and the staff side does not accept ours", async () => {
    // Separated by SALT, not merely by cookie name — lib/account/session.ts
    // says to test exactly this by hand, so here it is in the suite instead.
    const { mintSession, readSession } = await import("@/lib/account/session");
    const { encode } = await import("next-auth/jwt");

    const staffToken = await encode({
      token: { sub: "some-staff-id" },
      secret: process.env.AUTH_SECRET || "dev-only-insecure-secret",
      salt: "authjs.session-token",
    });
    expect(await readSession(staffToken), "a staff token decoded as a customer").toBeNull();

    const customerToken = await mintSession("some-customer-id");
    const { decode } = await import("next-auth/jwt");
    await expect(
      decode({
        token: customerToken,
        secret: process.env.AUTH_SECRET || "dev-only-insecure-secret",
        salt: "authjs.session-token",
      }),
    ).rejects.toBeTruthy();
  });

  it("returns null for a tampered, truncated or absent token", async () => {
    const { mintSession, readSession } = await import("@/lib/account/session");
    const good = await mintSession("11111111-1111-1111-1111-111111111111");
    expect(await readSession(undefined)).toBeNull();
    expect(await readSession("")).toBeNull();
    expect(await readSession(good.slice(0, -4))).toBeNull();
    expect(await readSession(good + "x")).toBeNull();
    expect(await readSession(good), "a good token stopped working").toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("signs a blocked customer out on their very next request", async () => {
    // currentCustomer re-reads the row every request precisely so blocking is
    // immediate rather than waiting thirty days for the token to lapse.
    const { ACCOUNT_COOKIE, mintSession } = await import("@/lib/account/session");
    const { currentCustomer } = await import("@/lib/account/guard");
    const { jar } = await import("../helpers/app");

    const cust = await fx.customer({ verified: true });
    jar.set(ACCOUNT_COOKIE, await mintSession(cust.id));
    expect((await currentCustomer())?.id).toBe(cust.id);

    await db.update(customers).set({ blocked: true }).where(eq(customers.id, cust.id));
    expect(await currentCustomer(), "a blocked customer kept their session").toBeNull();
  });

  it("signs out an account whose email verification was withdrawn", async () => {
    const { ACCOUNT_COOKIE, mintSession } = await import("@/lib/account/session");
    const { currentCustomer } = await import("@/lib/account/guard");
    const { jar } = await import("../helpers/app");

    const cust = await fx.customer({ verified: true });
    jar.set(ACCOUNT_COOKIE, await mintSession(cust.id));
    await db.update(customers).set({ emailVerifiedAt: null }).where(eq(customers.id, cust.id));
    expect(await currentCustomer()).toBeNull();
  });

  it("does not resurrect a deleted customer", async () => {
    const { ACCOUNT_COOKIE, mintSession } = await import("@/lib/account/session");
    const { currentCustomer } = await import("@/lib/account/guard");
    const { jar } = await import("../helpers/app");

    const cust = await fx.customer({ verified: true });
    const token = await mintSession(cust.id);
    await db.delete(customers).where(eq(customers.id, cust.id));
    jar.set(ACCOUNT_COOKIE, token);
    expect(await currentCustomer()).toBeNull();
  });
});
