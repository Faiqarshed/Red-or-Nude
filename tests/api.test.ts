// The wire, for both fixes.
//
// The engine knowing which guest lost her chair is worth nothing if the answer
// stops at the route. These drive `POST /api/bookings` as a real Request and
// read the JSON the browser would read — the last hop, and the one a test of
// createBookings alone cannot see.
//
// The session is the only thing mocked. Everything else — zod, the database,
// the reservation loop — is the real path.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/account/guard", () => ({
  // Signed out: the ordinary case, and enough for every assertion here.
  currentCustomer: async () => null,
}));

import { POST } from "@/app/api/bookings/route";
import { createBooking } from "@/lib/bookings";
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
    body: JSON.stringify(body),
  });
}

async function fillBranch(branchId: string, chairs: number, at: number) {
  for (let i = 0; i < chairs; i++) {
    const made = await createBooking({
      branchId,
      serviceId: f.svcA.id,
      addonIds: [],
      startsAt: new Date(at).toISOString(),
      customer: { phone: TEST_PHONE },
      source: "walk_in",
    });
    expect(made.ok).toBe(true);
  }
}

describe("POST /api/bookings", () => {
  it("seats a party and answers 201", async () => {
    const res = await POST(
      post({
        branchId: f.branchA,
        startsAt: new Date(FUTURE).toISOString(),
        customer: { phone: TEST_PHONE, email: "t@example.com" },
        members: [
          { serviceId: f.svcA.id, addonIds: [] },
          { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
        ],
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bookings).toHaveLength(2);
    expect(body.groupId).toBeTruthy();
  });

  it("sends guestIndex to the browser on a lost chair", async () => {
    await fillBranch(f.branchB, f.chairsB, FUTURE);

    const res = await POST(
      post({
        branchId: f.branchA,
        startsAt: new Date(FUTURE).toISOString(),
        customer: { phone: TEST_PHONE, email: "t@example.com" },
        members: [
          { serviceId: f.svcA.id, addonIds: [] },
          // Nowhere left to sit over there.
          { serviceId: f.svcB.id, addonIds: [], branchId: f.branchB },
        ],
      }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("slot-taken");
    // The whole point of the fix, at the only layer the customer can see.
    expect(body.guestIndex).toBe(1);
  });

  it("points at the third guest when it is the third who cannot sit", async () => {
    await fillBranch(f.branchB, f.chairsB, FUTURE);

    const res = await POST(
      post({
        branchId: f.branchA,
        startsAt: new Date(FUTURE).toISOString(),
        customer: { phone: TEST_PHONE, email: "t@example.com" },
        members: [
          { serviceId: f.svcA.id, addonIds: [] },
          { serviceId: f.svcB.id, addonIds: [] },
          { serviceId: f.svcA.id, addonIds: [], branchId: f.branchB },
        ],
      }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).guestIndex).toBe(2);
  });

  it("does not invent a guest for a refusal that is not about one", async () => {
    const res = await POST(
      post({
        branchId: f.branchA,
        startsAt: new Date(FUTURE).toISOString(),
        customer: { phone: TEST_PHONE, email: "t@example.com" },
        members: [
          { serviceId: f.svcA.id, addonIds: [] },
          {
            serviceId: f.svcB.id,
            addonIds: [],
            startsAt: new Date(FUTURE + 26 * 3600_000).toISOString(),
          },
        ],
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("different-day");
    expect(body.guestIndex).toBeUndefined();
  });

  it("accepts four guests and refuses five", async () => {
    const member = { serviceId: f.svcA.id, addonIds: [] as string[] };
    const base = {
      branchId: f.branchA,
      startsAt: new Date(FUTURE).toISOString(),
      customer: { phone: TEST_PHONE, email: "t@example.com" },
    };

    const four = await POST(post({ ...base, members: Array(4).fill(member) }));
    expect(four.status).toBe(201);

    await reset(f.branchA, f.branchB);

    const five = await POST(post({ ...base, members: Array(5).fill(member) }));
    expect(five.status).toBe(400);
    expect((await five.json()).error).toBe("invalid");
  });

  it("rejects a body that is not JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid-json");
  });

  it("holds web bookings pending, so nothing is confirmed before payment", async () => {
    const res = await POST(
      post({
        branchId: f.branchA,
        startsAt: new Date(FUTURE).toISOString(),
        customer: { phone: TEST_PHONE, email: "t@example.com" },
        members: [{ serviceId: f.svcA.id, addonIds: [] }],
      }),
    );
    expect(res.status).toBe(201);

    const { db } = await import("@/lib/db");
    const { bookings } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const id = (await res.json()).bookings[0].id;
    const [row] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);

    expect(row.status).toBe("pending");
    expect(row.ticketNo).toBeNull();
  });
});
