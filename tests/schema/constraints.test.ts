// Every constraint in lib/db/schema.ts, exercised directly against Postgres.
//
//   npx vitest run tests/schema
//
// What this file protects: the difference between a rule the schema *declares*
// and a rule the database *enforces*. Those two drift silently. A migration
// that recreates a table without its partial index, a `.notNull()` deleted
// while chasing a type error, a `unique()` that never made it into a generated
// migration — none of it breaks a build, none of it breaks a page, and the
// first symptom is two accounts on one email or two customers in one chair.
//
// So the loops below do not enumerate constraints by hand. They read them off
// the Drizzle table objects at run time and attack whatever is there, which
// means a 35th table or a 35th foreign key is covered the day it lands, and a
// constraint someone quietly removes stops being tested *and* shows up as a
// dropped case count rather than as a green suite.
//
// Phase 5 items 28–31.

import { afterAll, describe, expect, it } from "vitest";
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { Graph, PG, TABLES, cols, pkColumns, refuses, tag } from "./helpers";

const g = new Graph();
afterAll(() => g.cleanup());

const TABLE_NAMES = Object.keys(TABLES).sort();

/** Property key for a column, since Drizzle inserts are keyed by property. */
const keyOf = (t: PgTable, col: PgColumn) =>
  Object.keys(cols(t)).find((k) => cols(t)[k].name === col.name)!;

// ------------------------------------------------------ 28. unique -----------

describe("unique constraints refuse a duplicate", () => {
  // Every `unique()` declared in schema.ts, discovered rather than listed.
  const declared = TABLE_NAMES.flatMap((name) =>
    getTableConfig(TABLES[name]).uniqueConstraints.map((u) => ({ name, u })),
  );

  it("there are unique constraints to test at all", () => {
    // A schema.ts that lost every `unique()` would otherwise make this whole
    // describe block vacuously green.
    expect(declared.length, "schema.ts declares no unique constraints at all").toBeGreaterThan(10);
  });

  for (const { name, u } of declared) {
    const table = TABLES[name];
    it(`${u.name} — a second row with the same value is refused`, async () => {
      const first = await g.sample(name);
      const row = await g.add(table, first);
      // Copy only the constrained columns; everything else stays fresh so the
      // failure can only be this constraint.
      const second = await g.sample(name);
      for (const c of u.columns as PgColumn[]) {
        const k = keyOf(table, c);
        second[k] = row[k];
      }
      await refuses(
        () => (db.insert(table) as any).values(second),
        PG.unique,
        `${u.name} let a duplicate through`,
      );
    });
  }
});

describe("composite primary keys refuse a duplicate pair", () => {
  // service_addons, booking_addons and ticket_counters have no id — the pair
  // *is* the identity, and it is the only thing stopping a booking carrying the
  // same add-on twice or a branch handing out two counters for one day.
  const composite = TABLE_NAMES.filter((n) => getTableConfig(TABLES[n]).primaryKeys.length > 0);

  it("the three keyless tables are all still keyed by a pair", () => {
    expect(composite.sort()).toEqual(["booking_addons", "service_addons", "ticket_counters"]);
  });

  for (const name of composite) {
    it(`${name} — the same pair twice is refused`, async () => {
      const row = await g.sample(name);
      await g.add(TABLES[name], row);
      await refuses(
        () => (db.insert(TABLES[name]) as any).values(row),
        PG.unique,
        `${name} accepted the same primary key pair twice`,
      );
    });
  }
});

// ------------------------------------------------- 28b. the partial ones -----

describe("customers_account_email_unique — unique over verified emails only", () => {
  // schema.ts:350-366. Checkout upserts on phone and writes whatever email was
  // typed, so the same address legitimately lands on two rows. A blanket unique
  // index would turn a returning customer's second booking into a 500.

  it("two unverified rows may share an address — checkout depends on it", async () => {
    const email = `shared-${tag()}@example.test`;
    await g.add(TABLES.customers, { phone: `05${Date.now().toString().slice(-8)}`, email });
    const second = await g.sample("customers");
    second.email = email;
    // No emailVerifiedAt on either: neither is an account, so neither is indexed.
    await expect(g.add(TABLES.customers, second)).resolves.toBeTruthy();
  });

  it("two verified rows may not — that would be two accounts on one sign-in", async () => {
    const email = `account-${tag()}@example.test`;
    const first = await g.sample("customers");
    await g.add(TABLES.customers, { ...first, email, emailVerifiedAt: new Date() });
    const second = await g.sample("customers");
    await refuses(
      () => (db.insert(TABLES.customers) as any).values({ ...second, email, emailVerifiedAt: new Date() }),
      PG.unique,
      "a second verified account was created on an address that already had one",
    );
  });

  it("Sara@ and sara@ are the same account — the index is over lower(email)", async () => {
    const local = `sara-${tag()}`;
    const first = await g.sample("customers");
    await g.add(TABLES.customers, {
      ...first,
      email: `Sara.${local}@Example.Test`,
      emailVerifiedAt: new Date(),
    });
    const second = await g.sample("customers");
    await refuses(
      () =>
        (db.insert(TABLES.customers) as any).values({
          ...second,
          email: `sara.${local}@example.test`,
          emailVerifiedAt: new Date(),
        }),
      PG.unique,
      "case alone was enough to open a second account on the same address",
    );
  });

  it("verifying a row whose address a verified row already holds is refused", async () => {
    // The update path, not the insert path: the index has to catch both, or a
    // duplicate account arrives via /api/account/verify instead of signup.
    const email = `upgrade-${tag()}@example.test`;
    const held = await g.sample("customers");
    await g.add(TABLES.customers, { ...held, email, emailVerifiedAt: new Date() });
    const pending = await g.add(TABLES.customers, { ...(await g.sample("customers")), email });
    await refuses(
      () =>
        db
          .update(TABLES.customers as any)
          .set({ emailVerifiedAt: new Date() })
          .where(eq((TABLES.customers as any).id, pending.id)),
      PG.unique,
      "an unverified duplicate was allowed to verify into a second account",
    );
  });

  it("an unverified row may keep an address a verified row already holds", async () => {
    // The other half of the same rule: checkout must still be able to write it.
    const email = `mixed-${tag()}@example.test`;
    await g.add(TABLES.customers, { ...(await g.sample("customers")), email, emailVerifiedAt: new Date() });
    await expect(
      g.add(TABLES.customers, { ...(await g.sample("customers")), email }),
    ).resolves.toBeTruthy();
  });
});

describe("bookings_station_slot_unique — one chair, one start time", () => {
  // schema.ts:508-518. The real guarantee is the row lock in reserveStations;
  // this index is the backstop for anything that bypasses it.

  it("two live bookings cannot hold the same chair at the same minute", async () => {
    const branch = await g.branch();
    const station = await g.station();
    const startsAt = new Date("2030-03-01T10:00:00.000Z");
    const base = await g.sample("bookings");
    await g.add(TABLES.bookings, { ...base, branchId: branch.id, stationId: station.id, startsAt });
    const clash = await g.sample("bookings");
    await refuses(
      () =>
        (db.insert(TABLES.bookings) as any).values({
          ...clash,
          branchId: branch.id,
          stationId: station.id,
          startsAt,
        }),
      PG.unique,
      "the same chair was double-booked for the same minute",
    );
  });

  it("a cancelled booking gives its chair back", async () => {
    // Partial index: cancelling used to burn that chair-and-time for everyone.
    const branch = await g.branch();
    const station = await g.station();
    const startsAt = new Date("2030-03-02T10:00:00.000Z");
    await g.add(TABLES.bookings, {
      ...(await g.sample("bookings")),
      branchId: branch.id,
      stationId: station.id,
      startsAt,
      status: "cancelled",
    });
    await expect(
      g.add(TABLES.bookings, {
        ...(await g.sample("bookings")),
        branchId: branch.id,
        stationId: station.id,
        startsAt,
      }),
    ).resolves.toBeTruthy();
  });

  it("a no-show gives its chair back too", async () => {
    const branch = await g.branch();
    const station = await g.station();
    const startsAt = new Date("2030-03-03T10:00:00.000Z");
    await g.add(TABLES.bookings, {
      ...(await g.sample("bookings")),
      branchId: branch.id,
      stationId: station.id,
      startsAt,
      status: "no_show",
    });
    await expect(
      g.add(TABLES.bookings, {
        ...(await g.sample("bookings")),
        branchId: branch.id,
        stationId: station.id,
        startsAt,
      }),
    ).resolves.toBeTruthy();
  });

  it("two bookings with no chair assigned are fine — null is not a clash", async () => {
    // Nulls never collide in a btree index, which is what lets an unassigned
    // walk-in queue exist at all.
    const startsAt = new Date("2030-03-04T10:00:00.000Z");
    await g.add(TABLES.bookings, { ...(await g.sample("bookings")), startsAt });
    await expect(
      g.add(TABLES.bookings, { ...(await g.sample("bookings")), startsAt }),
    ).resolves.toBeTruthy();
  });
});

describe("bookings_refill_of_unique — one refill per booking", () => {
  it("a second live refill of the same appointment is refused", async () => {
    const original = await g.add(TABLES.bookings, await g.sample("bookings"));
    await g.add(TABLES.bookings, { ...(await g.sample("bookings")), refillOfBookingId: original.id });
    await refuses(
      async () =>
        (db.insert(TABLES.bookings) as any).values({
          ...(await g.sample("bookings")),
          refillOfBookingId: original.id,
        }),
      PG.unique,
      "one appointment was refilled twice",
    );
  });

  it("cancelling the refill gives the window back", async () => {
    const original = await g.add(TABLES.bookings, await g.sample("bookings"));
    await g.add(TABLES.bookings, {
      ...(await g.sample("bookings")),
      refillOfBookingId: original.id,
      status: "cancelled",
    });
    await expect(
      g.add(TABLES.bookings, { ...(await g.sample("bookings")), refillOfBookingId: original.id }),
    ).resolves.toBeTruthy();
  });
});

// ------------------------------------------------- 29. foreign keys ----------

describe("foreign keys refuse an orphan", () => {
  const fks = TABLE_NAMES.flatMap((name) =>
    getTableConfig(TABLES[name]).foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        name,
        column: ref.columns[0] as PgColumn,
        parent: getTableConfig(ref.foreignTable as PgTable).name,
        onDelete: fk.onDelete ?? "no action",
      };
    }),
  );

  it("the schema still declares the foreign keys it is supposed to", () => {
    // 34 as of 2026-09-02. A drop shows up here before it shows up as an orphan.
    expect(fks.length, "a foreign key disappeared from schema.ts").toBe(34);
  });

  for (const fk of fks) {
    it(`${fk.name}.${fk.column.name} → ${fk.parent} rejects an id nothing owns`, async () => {
      const table = TABLES[fk.name];
      const row = await g.sample(fk.name);
      row[keyOf(table, fk.column)] = "00000000-0000-4000-8000-000000000000";
      await refuses(
        () => (db.insert(table) as any).values(row),
        PG.foreignKey,
        `${fk.name}.${fk.column.name} accepted a ${fk.parent} that does not exist`,
      );
    });
  }
});

describe("the two uuid columns that look like foreign keys and are not", () => {
  // @characterization — undocumented, pins behaviour as of 2026-09-02.
  // See docs/_testing/known-bugs-schema.md BUG-SCHEMA-001 and -002.

  it("staff.branch_id accepts a branch that does not exist", async () => {
    // staffRelations declares `branch: one(branches)` (schema.ts:917) but the
    // column carries no `.references()`, so nothing stops a staff member being
    // pinned to a deleted branch — and scopedBranchId then filters on an id no
    // row has, showing that receptionist an empty salon.
    const row = await g.add(TABLES.staff, {
      ...(await g.sample("staff")),
      branchId: "00000000-0000-4000-8000-0000000000ff",
    });
    expect(row.branchId, "staff.branch_id has grown a foreign key — update this test and the bug log")
      .toBe("00000000-0000-4000-8000-0000000000ff");
  });

  it("payments.gift_card_id accepts a card that does not exist", async () => {
    // schema.ts:671 — a bare uuid beside bookingId, which does have one.
    const row = await g.add(TABLES.payments, {
      ...(await g.sample("payments")),
      giftCardId: "00000000-0000-4000-8000-0000000000fe",
    });
    expect(row.giftCardId, "payments.gift_card_id has grown a foreign key — update the bug log")
      .toBe("00000000-0000-4000-8000-0000000000fe");
  });
});

// ------------------------------------------------------ 30. not null ---------

describe("notNull columns refuse a null", () => {
  const required = TABLE_NAMES.flatMap((name) =>
    Object.values(cols(TABLES[name]))
      .filter((c) => c.notNull)
      .map((c) => ({ name, c })),
  );

  it("the schema still declares the required columns it is supposed to", () => {
    // 195 as of 2026-09-02, counting the created_at/updated_at pair on every
    // table. A drop is a column that has quietly become optional.
    expect(required.length, "a notNull disappeared from schema.ts").toBe(195);
  });

  for (const { name, c } of required) {
    it(`${name}.${c.name} may not be null`, async () => {
      const table = TABLES[name];
      const row = await g.sample(name);
      // Explicit null, not an omission: Postgres only applies a default when the
      // column is left out, so this reaches the constraint even on a defaulted
      // column like created_at or stations.qr_token.
      row[keyOf(table, c)] = null;
      await refuses(
        () => (db.insert(table) as any).values(row),
        PG.notNull,
        `${name}.${c.name} accepted a null`,
      );
    });
  }
});

it("booking_addons.addon_id is not null even though schema.ts never says so", async () => {
  // @characterization — the composite primary key (schema.ts:618) makes Postgres
  // add NOT NULL that the Drizzle column definition does not carry. Worth
  // pinning because the same column declares `onDelete: "set null"`, which the
  // two rules together make impossible. BUG-SCHEMA-003.
  const row = await g.sample("booking_addons");
  row.addonId = null;
  await refuses(
    () => (db.insert(TABLES.booking_addons) as any).values(row),
    PG.notNull,
    "an add-on line with no add-on was written to a booking",
  );
});

// --------------------------------------------------------- 31. enums ---------

describe("enum columns refuse a value outside the lifecycle", () => {
  const enumCols = TABLE_NAMES.flatMap((name) =>
    Object.values(cols(TABLES[name]))
      .filter((c) => c.columnType === "PgEnumColumn")
      .map((c) => ({ name, c })),
  );

  it("all eight enums from the glossary are actually wired to a column", () => {
    const used = new Set(enumCols.map(({ c }) => (c as any).enumValues.join("|")));
    // staff_role, booking_status, booking_source, payment_method,
    // payment_status, gift_card_status, promo_type, lang.
    expect(used.size, "an enum in schema.ts is no longer used by any column").toBe(8);
  });

  for (const { name, c } of enumCols) {
    it(`${name}.${c.name} rejects a status nobody defined`, async () => {
      const table = TABLES[name];
      const row = await g.sample(name);
      row[keyOf(table, c)] = "not_a_real_value";
      await refuses(
        () => (db.insert(table) as any).values(row),
        PG.badEnum,
        `${name}.${c.name} accepted a value outside its enum`,
      );
    });

    it(`${name}.${c.name} accepts every value the enum declares`, async () => {
      // The other direction: an enum value removed by a migration while the
      // application still writes it is the same outage seen from the other side.
      const table = TABLES[name];
      for (const value of (c as any).enumValues as string[]) {
        const row = await g.sample(name);
        row[keyOf(table, c)] = value;
        await expect(
          g.add(table, row),
          `${name}.${c.name} refused "${value}", which its own enum lists`,
        ).resolves.toBeTruthy();
      }
    });
  }
});

// ----------------------------------------------------- the table census ------

it("all 34 tables are reachable and every one has a sample row", async () => {
  // If this fails, a migration added a table and tests/schema/helpers.ts has no
  // row shape for it — which would make every loop above silently skip it.
  expect(TABLE_NAMES).toHaveLength(34);
  for (const name of TABLE_NAMES) {
    const row = await g.sample(name);
    expect(Object.keys(row).length, `${name} has an empty sample row`).toBeGreaterThan(0);
    const n = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(TABLES[name] as any);
    expect(typeof n[0].n, `${name} is not queryable`).toBe("number");
    expect(pkColumns(TABLES[name]).length, `${name} has no primary key`).toBeGreaterThan(0);
  }
});
