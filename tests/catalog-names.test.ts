// One active thing per name (client review, Sep 2026).
//
// The salon's words: "2 services with same name can not be active at same
// time." Two live rows reading "Gel Manicure" are indistinguishable in the
// walk-in drawer, on the booking grid and on the ticket, and the receptionist
// picking the wrong one puts the wrong price and the wrong duration on a real
// appointment.
//
// The guarantee is `services_active_name_en_unique` and its five siblings
// (drizzle/0025) — partial unique indexes over `active` rows only. An index and
// not a check inside the action, because two tabs that both read "that name is
// free" and both save is exactly what a check-then-write cannot see.
//
// So these tests go through the actions rather than around them: the index is
// what refuses, and `isDuplicateName` turning that refusal into a sentence the
// receptionist can act on is the part that silently rots if the index is ever
// renamed.

import "./as-staff";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, removalTypes, services } from "@/lib/db/schema";
import { nameLike } from "./helpers";

const { saveCatalogItem, setCatalogActive } = await import(
  "@/app/(admin)/admin/(shell)/catalog/actions"
);

/**
 * Every row this file writes starts with this. Names are the only column all
 * three tables share — `removal_types` has no image to hide a marker in — so
 * the prefix is the cleanup key as well as the test data.
 */
const TAG = "zz-name-test";

/** A name that is this file's and nobody else's. */
const named = (label: string) => ({ ar: `${TAG}-ar-${label}`, en: `${TAG}-${label}` });

async function wipe() {
  for (const table of [services, addons, removalTypes]) {
    await db.delete(table).where(nameLike(table, `${TAG}%`));
  }
}

/** Create one, expecting it to work, and hand back its id. */
async function create(
  kind: "service" | "addon" | "removal" | "upsell",
  name: { ar: string; en: string },
  active = true,
): Promise<string> {
  const res = await saveCatalogItem({
    kind,
    name,
    priceSar: 50,
    // Services are refused below five minutes; everything else may be zero.
    durationMin: kind === "service" ? 30 : 0,
    active,
    sort: 0,
  });
  if (!res.ok) throw new Error(`setup failed: ${res.error}`);
  return res.id;
}

beforeEach(wipe);
afterAll(wipe);

describe("one active row per name", () => {
  it("accepts the first one", async () => {
    const id = await create("service", named("a"));
    const [row] = await db.select().from(services).where(eq(services.id, id));
    expect(row.active).toBe(true);
  });

  it("refuses a second active service under the same English name", async () => {
    await create("service", named("a"));

    const res = await saveCatalogItem({
      kind: "service",
      // A different Arabic name, so only the English one collides. One name on
      // an English ticket is still one name.
      name: { ar: `${TAG}-ar-different`, en: `${TAG}-a` },
      priceSar: 90,
      durationMin: 45,
      active: true,
      sort: 1,
    });

    expect(res).toEqual({ ok: false, error: "duplicate-name" });
  });

  it("refuses a second active service under the same Arabic name", async () => {
    await create("service", named("a"));

    const res = await saveCatalogItem({
      kind: "service",
      name: { ar: `${TAG}-ar-a`, en: `${TAG}-quite-different` },
      priceSar: 90,
      durationMin: 45,
      active: true,
      sort: 1,
    });

    expect(res).toEqual({ ok: false, error: "duplicate-name" });
  });

  it("refuses a name that differs only in case or surrounding space", async () => {
    await create("service", named("Case"));

    const res = await saveCatalogItem({
      kind: "service",
      // Typed by a different person on a different day. The index lowercases
      // and trims, and zod has already trimmed, so both halves are covered.
      name: { ar: `${TAG}-ar-nothing`, en: `  ${TAG}-CASE  ` },
      priceSar: 90,
      durationMin: 45,
      active: true,
      sort: 1,
    });

    expect(res).toEqual({ ok: false, error: "duplicate-name" });
  });

  it("leaves the first row alone when the second is refused", async () => {
    const id = await create("service", named("a"));

    await saveCatalogItem({
      kind: "service",
      name: named("a"),
      priceSar: 999,
      durationMin: 45,
      active: true,
      sort: 1,
    });

    const rows = await db
      .select()
      .from(services)
      .where(nameLike(services, `${TAG}%`));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].priceHalalas).toBe(5000);
  });

  it("allows the name again once the first row is switched off", async () => {
    // How the salon renames a thing: the old row stays, off, holding its
    // booking history, and the new one takes the name.
    const first = await create("service", named("a"));
    const off = await setCatalogActive("service", first, false);
    expect(off.ok).toBe(true);

    const res = await saveCatalogItem({
      kind: "service",
      name: named("a"),
      priceSar: 90,
      durationMin: 45,
      active: true,
      sort: 1,
    });
    expect(res.ok).toBe(true);
  });

  it("lets a row keep its own name when it is edited", async () => {
    const id = await create("service", named("a"));

    // The commonest save of all — change the price, leave the name. A row must
    // not collide with itself.
    const res = await saveCatalogItem({
      kind: "service",
      id,
      name: named("a"),
      priceSar: 120,
      durationMin: 30,
      active: true,
      sort: 0,
    });

    expect(res).toEqual({ ok: true, id });
  });

  it("refuses switching a second row on under a taken name", async () => {
    // The other door into two live rows: both saved fine, one was off.
    const first = await create("service", named("a"));
    const second = await create("service", named("a"), false);
    expect(first).not.toBe(second);

    const res = await setCatalogActive("service", second, true);

    expect(res).toEqual({ ok: false, error: "duplicate-name" });
    const [row] = await db.select().from(services).where(eq(services.id, second));
    expect(row.active).toBe(false);
  });

  it("still switches a row on when its name is free", async () => {
    const id = await create("service", named("b"), false);
    const res = await setCatalogActive("service", id, true);

    expect(res.ok).toBe(true);
    const [row] = await db.select().from(services).where(eq(services.id, id));
    expect(row.active).toBe(true);
  });

  it("applies to add-ons and removal types too", async () => {
    for (const kind of ["addon", "removal"] as const) {
      await create(kind, named(kind));
      const res = await saveCatalogItem({
        kind,
        name: named(kind),
        priceSar: 10,
        durationMin: 0,
        active: true,
        sort: 1,
      });
      expect(res).toEqual({ ok: false, error: "duplicate-name" });
    }
  });

  it("counts a treat and an add-on as one namespace", async () => {
    // Treats are `addons` rows with `at_checkout` set, so they share the index.
    // Two live rows called "Iced coffee & a treat" are the same problem
    // whichever tab of the catalogue they were typed into.
    await create("upsell", named("coffee"));

    const res = await saveCatalogItem({
      kind: "addon",
      name: named("coffee"),
      priceSar: 10,
      durationMin: 15,
      active: true,
      sort: 1,
    });

    expect(res).toEqual({ ok: false, error: "duplicate-name" });
  });

  it("does not mistake a different name for a taken one", async () => {
    await create("addon", named("one"));
    const res = await saveCatalogItem({
      kind: "addon",
      name: named("two"),
      priceSar: 10,
      durationMin: 0,
      active: true,
      sort: 1,
    });
    expect(res.ok).toBe(true);

    const rows = await db
      .select()
      .from(addons)
      .where(nameLike(addons, `${TAG}%`));
    expect(rows).toHaveLength(2);
  });
});
