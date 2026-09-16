// What the endpoint does when the caller is not the website.
//
// Every assertion here sends something no screen would ever produce. The bar is
// not "returns an error" — it is that nothing is written, nothing is charged and
// nothing crashes into a 500. A validation layer that rejects politely and a
// validation layer that half-accepts look identical until you check the table
// afterwards, so each of these checks the table afterwards.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";

vi.mock("@/lib/account/guard", () => ({ currentCustomer: async () => null }));

import { db } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { POST } from "@/app/api/bookings/route";
import { FUTURE, TEST_PHONE, fixtures, reset, type Fixtures } from "./helpers";

let f: Fixtures;

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
});

function post(body: unknown): Request {
  return new Request("http://localhost/api/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Nothing was written at either branch. */
async function nothingWritten() {
  const rows = await db
    .select()
    .from(bookings)
    .where(inArray(bookings.branchId, [f.branchA, f.branchB]));
  return rows.length === 0;
}

const good = () => ({
  branchId: f.branchA,
  startsAt: new Date(FUTURE).toISOString(),
  customer: { phone: TEST_PHONE, email: "t@example.com" },
  members: [{ serviceId: f.svcA.id, addonIds: [] }],
});

describe("bodies no screen would send", () => {
  const cases: [string, () => unknown][] = [
    ["an empty object", () => ({})],
    ["null", () => null],
    ["an array instead of an object", () => []],
    ["a string instead of an object", () => '"hello"'],
    ["no members at all", () => ({ ...good(), members: [] })],
    ["members that is not a list", () => ({ ...good(), members: "two" })],
    ["a branch that is not a uuid", () => ({ ...good(), branchId: "not-a-uuid" })],
    ["a branch that does not exist", () => ({ ...good(), branchId: randomUUID() })],
    ["a start that is not a date", () => ({ ...good(), startsAt: "tomorrow-ish" })],
    ["a start that is empty", () => ({ ...good(), startsAt: "" })],
    ["a phone that is not a phone", () => ({ ...good(), customer: { phone: "hello", email: "t@e.com" } })],
    ["no phone at all", () => ({ ...good(), customer: { email: "t@e.com" } })],
    [
      "a service that is not a uuid",
      () => ({ ...good(), members: [{ serviceId: "../../etc/passwd", addonIds: [] }] }),
    ],
    [
      "a service id carrying sql",
      () => ({ ...good(), members: [{ serviceId: "'; drop table bookings; --", addonIds: [] }] }),
    ],
    [
      "more add-ons than the cap",
      () => ({
        ...good(),
        members: [{ serviceId: f.svcA.id, addonIds: Array(50).fill(f.svcA.id) }],
      }),
    ],
    [
      "a guest branch that is not a uuid",
      () => ({ ...good(), members: [{ serviceId: f.svcA.id, addonIds: [], branchId: "nope" }] }),
    ],
    [
      "a guest start that is not a date",
      () => ({ ...good(), members: [{ serviceId: f.svcA.id, addonIds: [], startsAt: "later" }] }),
    ],
    [
      "a pack id that is not a uuid",
      () => ({ ...good(), members: [{ serviceId: f.svcA.id, addonIds: [], customerPackId: "mine" }] }),
    ],
    ["five guests", () => ({ ...good(), members: Array(5).fill({ serviceId: f.svcA.id, addonIds: [] }) })],
    [
      "a hundred guests",
      () => ({ ...good(), members: Array(100).fill({ serviceId: f.svcA.id, addonIds: [] }) }),
    ],
    ["redeemPoints as a negative number", () => ({ ...good(), redeemPoints: -500 })],
    ["redeemPoints as a fraction", () => ({ ...good(), redeemPoints: 1.5 })],
    ["a promo code longer than the column", () => ({ ...good(), promoCode: "X".repeat(500) })],
    ["notes longer than the column", () => ({ ...good(), notes: "n".repeat(5000) })],
    ["a station token that is not a uuid", () => ({ ...good(), stationToken: "sticker" })],
  ];

  it.each(cases)("refuses %s without writing anything", async (_name, build) => {
    const res = await POST(post(build()));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status, "a bad request must not become a server error").toBeLessThan(500);
    expect(await nothingWritten()).toBe(true);
  });
});

describe("things that are valid but adversarial", () => {
  it("does not seat a guest at a branch that does not exist", async () => {
    const res = await POST(
      post({
        ...good(),
        members: [
          {
            serviceId: f.svcA.id,
            addonIds: [],
            branchId: randomUUID(),
          },
          { serviceId: f.svcB.id, addonIds: [] },
        ],
      }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await nothingWritten()).toBe(true);
  });

  it("refuses a party whose guests are on different days", async () => {
    const res = await POST(
      post({
        ...good(),
        members: [
          { serviceId: f.svcA.id, addonIds: [] },
          {
            serviceId: f.svcB.id,
            addonIds: [],
            startsAt: new Date(FUTURE + 5 * 24 * 3600_000).toISOString(),
          },
        ],
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("different-day");
    expect(await nothingWritten()).toBe(true);
  });

  it("ignores unknown fields rather than choking on them", async () => {
    const res = await POST(
      post({ ...good(), isAdmin: true, totalHalalas: 1, discountPercent: 100 }),
    );
    expect(res.status).toBe(201);

    // And the price came from the catalogue, not from the body.
    const rows = await db
      .select()
      .from(bookings)
      .where(inArray(bookings.branchId, [f.branchA, f.branchB]));
    expect(rows).toHaveLength(1);
    expect(rows[0].totalHalalas).toBeGreaterThan(1);
  });

  it("cannot be told what a service costs", async () => {
    const res = await POST(
      post({
        ...good(),
        members: [{ serviceId: f.svcA.id, addonIds: [], priceHalalas: 1, servicePriceHalalas: 1 }],
      }),
    );
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(bookings)
      .where(inArray(bookings.branchId, [f.branchA, f.branchB]));
    expect(rows[0].servicePriceHalalas).toBe(f.svcA.priceHalalas);
  });

  it("cannot spend somebody else's pack by naming it", async () => {
    // Signed out, so there is no ledger to spend from at all. The credit must be
    // ignored rather than honoured — the owner comes from the session, never the
    // body.
    const res = await POST(
      post({
        ...good(),
        members: [
          {
            serviceId: f.svcA.id,
            addonIds: [],
            customerPackId: randomUUID(),
          },
        ],
      }),
    );
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(bookings)
      .where(inArray(bookings.branchId, [f.branchA, f.branchB]));
    expect(rows[0].servicePriceHalalas, "a stranger's pack paid for a service").toBe(
      f.svcA.priceHalalas,
    );
  });

  it("holds a booking pending however the request is dressed up", async () => {
    const res = await POST(post({ ...good(), status: "confirmed", source: "walk_in" }));
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(bookings)
      .where(inArray(bookings.branchId, [f.branchA, f.branchB]));
    expect(rows[0].status, "the body talked its way past payment").toBe("pending");
    expect(rows[0].source).toBe("web");
    expect(rows[0].ticketNo).toBeNull();
  });
});
