import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { branches, services, stations } from "@/lib/db/schema";
import { confirmBookingPayment } from "@/lib/payments/confirm";
import { createBookings } from "@/lib/bookings";

describe("harness", () => {
  it("reaches the test database and the modules under test", async () => {
    expect(process.env.DATABASE_URL).toMatch(/_test$/);
    expect(typeof confirmBookingPayment).toBe("function");
    expect(typeof createBookings).toBe("function");
    const [b, s, st] = await Promise.all([
      db.select().from(branches),
      db.select().from(services),
      db.select().from(stations),
    ]);
    expect(b.length).toBeGreaterThanOrEqual(2);
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(st.length).toBeGreaterThanOrEqual(2);
  });
});
