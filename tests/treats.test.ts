// Coffee on the technician's ticket.
//
// The salon's complaint, in their words: "for coffee we wanna add it to the
// tech lady when she opens the tickets for details — she will see she added
// coffee and treats so she will provide it for her."
//
// It was already being *sold* at checkout. What it was not doing was arriving
// as anything she could act on: loadMyDay read `booking_addons.name` with no
// join onto the catalogue, so a coffee landed in the same grey pill row as a
// gel removal and nothing distinguished an errand from the work.
//
// The load-bearing case is the deleted catalogue row. `booking_addons.addon_id`
// is `on delete set null`, so the join that tells a treat from an add-on can
// come back empty for something that really was one — and the ticket must still
// show what was bought rather than dropping it.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, bookingAddons, bookings, customers } from "@/lib/db/schema";
import { loadMyDay } from "@/app/(admin)/admin/(shell)/my-day/data";
import { fixtures, reset, techniciansAt, todayAt, type Fixtures } from "./helpers";

let f: Fixtures;
let technicianId: string;

/** This file's own catalogue rows, so cleanup can never reach a real one. */
const TAG = "zz-treat-test";
const tagged = like(addons.image, `${TAG}%`);

/** A catalogue row of either kind, marked by its image so it is findable. */
async function catalogRow(label: string, atCheckout: boolean): Promise<string> {
  const [row] = await db
    .insert(addons)
    .values({
      name: { ar: label, en: label },
      priceHalalas: 1000,
      durationMin: 0,
      atCheckout,
      // Doubles as this file's cleanup marker and, for a treat, as the picture
      // the technician is shown.
      image: `${TAG}/${label}.webp`,
      active: false,
    })
    .returning({ id: addons.id });
  return row.id;
}

/** One booking on today's floor for our technician, with the given add-ons. */
async function bookWith(items: { addonId: string | null; name: string }[]): Promise<string> {
  // A plain insert, not an upsert: `customers_guest_phone_unique` is a PARTIAL
  // index (guests only), so ON CONFLICT (phone) has no constraint to match.
  // reset() clears this file's phone prefix before every test anyway.
  const [guest] = await db
    .insert(customers)
    .values({ phone: "0500000096" })
    .returning({ id: customers.id });

  const startsAt = todayAt(11);
  const [booking] = await db
    .insert(bookings)
    .values({
      code: `RON-TREAT${Math.floor(Math.random() * 100_000)}`,
      branchId: f.branchA,
      customerId: guest.id,
      technicianId,
      serviceId: f.svcA.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      status: "confirmed",
      source: "web",
      serviceName: { ar: "اختبار", en: "test" },
      totalHalalas: 20_000,
    })
    .returning({ id: bookings.id });

  for (const item of items) {
    await db.insert(bookingAddons).values({
      bookingId: booking.id,
      addonId: item.addonId,
      // Snapshotted at the time of sale, exactly as createBookings writes it.
      name: { ar: item.name, en: item.name },
      priceHalalas: 1000,
    });
  }
  return booking.id;
}

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
  await db.delete(addons).where(tagged);
  const techs = await techniciansAt(f.branchA);
  if (techs.length === 0) throw new Error("this suite needs a technician at branch A");
  technicianId = techs[0].id;
});

afterAll(async () => {
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
  await db.delete(addons).where(tagged);
  await db.delete(customers).where(eq(customers.phone, "0500000096"));
});

describe("what the technician is shown", () => {
  it("puts a treat on its own line and leaves nail work in the pills", async () => {
    const coffee = await catalogRow("hot-coffee", true);
    const removal = await catalogRow("gel-removal", false);
    await bookWith([
      { addonId: coffee, name: "Hot coffee & a treat" },
      { addonId: removal, name: "Gel removal" },
    ]);

    const [card] = await loadMyDay(technicianId);

    expect(card.treats.map((t) => t.name.en)).toEqual(["Hot coffee & a treat"]);
    expect(card.addons.map((a) => a.en)).toEqual(["Gel removal"]);
  });

  it("shows the treat's own picture, because she is fetching a specific drink", async () => {
    const coffee = await catalogRow("iced-coffee", true);
    await bookWith([{ addonId: coffee, name: "Iced coffee & a treat" }]);

    const [card] = await loadMyDay(technicianId);

    expect(card.treats[0].imageUrl).toContain(TAG);
  });

  it("carries both treats when she ordered two", async () => {
    const hot = await catalogRow("hot", true);
    const cold = await catalogRow("cold", true);
    await bookWith([
      { addonId: hot, name: "Hot coffee & a treat" },
      { addonId: cold, name: "Iced coffee & a treat" },
    ]);

    const [card] = await loadMyDay(technicianId);

    expect(card.treats).toHaveLength(2);
    expect(card.addons).toEqual([]);
  });

  it("leaves both lists empty when nothing was added", async () => {
    await bookWith([]);

    const [card] = await loadMyDay(technicianId);

    // Empty arrays, not nulls — the view renders nothing for either, and a
    // stray heading over an empty row is worse than no row.
    expect(card.treats).toEqual([]);
    expect(card.addons).toEqual([]);
  });

  // What actually protects the join, which is not what the column says.
  //
  // `booking_addons.addon_id` is declared `on delete set null`, so the obvious
  // worry is a treat losing its catalogue row and becoming unidentifiable. That
  // cannot happen: addon_id is half of booking_addons' PRIMARY KEY, so it is
  // implicitly NOT NULL and the delete is refused before the FK rule is reached.
  // The admin surfaces that refusal as "in-use" (catalog/actions.ts).
  //
  // Pinned here because the two clauses contradict each other, and a future
  // reader relaxing the primary key would silently arm the case the column text
  // promises. If this test starts failing, the fallback in data.ts is suddenly
  // load-bearing.
  it("refuses to delete a catalogue row that has already been sold", async () => {
    const coffee = await catalogRow("doomed", true);
    await bookWith([{ addonId: coffee, name: "Hot coffee & a treat" }]);

    await expect(db.delete(addons).where(eq(addons.id, coffee))).rejects.toThrow();

    // So the ticket keeps both the line and its picture, permanently.
    const [card] = await loadMyDay(technicianId);
    expect(card.treats.map((t) => t.name.en)).toEqual(["Hot coffee & a treat"]);
    expect(card.treats[0].imageUrl).toContain(TAG);
  });

  // The same primary key, doing a second job — one that Phase 4 was going to
  // add an index for. Two rows of the same treat on one booking are impossible,
  // so a double-tapped "add a coffee" cannot produce two coffees.
  it("cannot record the same treat twice on one booking", async () => {
    const coffee = await catalogRow("double", true);
    const bookingId = await bookWith([{ addonId: coffee, name: "Hot coffee & a treat" }]);

    await expect(
      db.insert(bookingAddons).values({
        bookingId,
        addonId: coffee,
        name: { ar: "Hot coffee & a treat", en: "Hot coffee & a treat" },
        priceHalalas: 1000,
      }),
    ).rejects.toThrow();
  });

  it("keeps every price out of the technician's payload", async () => {
    const coffee = await catalogRow("priced", true);
    await bookWith([{ addonId: coffee, name: "Hot coffee & a treat" }]);

    const [card] = await loadMyDay(technicianId);

    // Asserted on the shape rather than by eye: technicians don't see revenue,
    // and a treat line must not be the thing that smuggles a number in.
    const flat = JSON.stringify(card);
    expect(flat).not.toContain("1000");
    expect(flat).not.toContain("20000");
    expect(Object.keys(card)).not.toContain("totalHalalas");
    for (const treat of card.treats) {
      expect(Object.keys(treat).sort()).toEqual(["imageUrl", "name"]);
    }
  });
});

describe("the catalogue rows behind them", () => {
  it("ships a hot and a cold treat, both free of duration", async () => {
    // Migration 0023. A treat with a duration would move ends_at under a
    // booking that is already being held, so zero is not cosmetic.
    const rows = await db
      .select({ name: addons.name, durationMin: addons.durationMin, active: addons.active })
      .from(addons)
      .where(and(eq(addons.atCheckout, true), eq(addons.active, true)));

    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.durationMin).toBe(0);

    const names = rows.map((r) => (r.name as { en: string }).en.toLowerCase());
    expect(names.some((n) => n.includes("hot"))).toBe(true);
    expect(names.some((n) => n.includes("iced") || n.includes("cold"))).toBe(true);
  });

  it("keeps the treats out of any service's add-on list", async () => {
    // They are offered at checkout instead of beside the services. A treat that
    // leaked into the service add-ons would be charged inside the discount
    // stack, which is the one thing lib/bookings.ts holds them out of.
    const checkoutIds = (
      await db.select({ id: addons.id }).from(addons).where(eq(addons.atCheckout, true))
    ).map((r) => r.id);

    const { serviceAddons } = await import("@/lib/db/schema");
    const leaked = await db
      .select({ addonId: serviceAddons.addonId })
      .from(serviceAddons)
      .where(inArray(serviceAddons.addonId, checkoutIds));

    expect(leaked).toEqual([]);
  });
});
