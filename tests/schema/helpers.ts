// Fixtures for the database layer itself.
//
// Every other agent tests a constraint by driving the application at it. This
// area tests the constraint directly, so it needs to insert into all 34 tables
// — including the fourteen the shared `Fixtures` class has never heard of
// (audit_log, refunds, gift_card_txns, ticket_counters, settings, …). Widening
// the shared one is off limits, so the graph below is the local answer.
//
// Two rules carried over from tests/helpers/fixtures.ts, for the same reason
// (the 2026-09-01 incident, see scripts/_test-db.ts):
//
//   • nothing is ever deleted without a WHERE naming a primary key we inserted
//   • teardown walks insertion order backwards, so children go before parents
//
// `sample(name)` returns a row that is valid for its table *today*. Every
// constraint test starts from one and breaks exactly one thing, which is what
// makes a failure name the constraint rather than the fixture.

import { and, eq, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import type { Localized } from "@/lib/db/schema";

/** Unique per run, so two files never collide on a phone or an email. */
let seq = 0;
export const tag = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

export const loc = (en: string): Localized => ({ ar: en, en });

// ------------------------------------------------------------ the tables ----

/**
 * Every `pgTable` exported from lib/db/schema.ts, discovered rather than
 * listed. A migration that adds a 35th table is covered by every loop in this
 * area the moment it lands — which is the point of testing the schema and not
 * the code that happens to use it.
 */
export const TABLES: Record<string, PgTable> = Object.fromEntries(
  Object.entries(schema)
    .filter(([, v]) => isPgTable(v))
    .map(([, v]) => [getTableConfig(v as PgTable).name, v as PgTable]),
);

function isPgTable(v: unknown): v is PgTable {
  return typeof v === "object" && v !== null && Symbol.for("drizzle:Name") in v
    && Symbol.for("drizzle:Columns") in v;
}

/** Property key → column, the shape Drizzle inserts want. */
export const cols = (t: PgTable): Record<string, PgColumn> =>
  (t as unknown as { [k: symbol]: Record<string, PgColumn> })[Symbol.for("drizzle:Columns")];

/** The primary key columns of a table, single or composite. */
export function pkColumns(t: PgTable): PgColumn[] {
  const cfg = getTableConfig(t);
  const composite = cfg.primaryKeys[0];
  if (composite) return composite.columns as PgColumn[];
  return Object.values(cols(t)).filter((c) => c.primary);
}

// --------------------------------------------------------------- the graph --

/**
 * One of everything, created on demand and torn down by primary key.
 *
 * Parents are memoised: a constraint test on `bookings` needs a branch and a
 * service, and creating a fresh pair per case would be forty branches for one
 * file's worth of assertions.
 */
export class Graph {
  private inserted: Array<{ table: PgTable; where: SQL }> = [];
  private cache = new Map<string, Record<string, unknown>>();

  /** Insert a row, remember how to delete exactly it, hand it back. */
  async add<T extends PgTable>(table: T, values: Record<string, unknown>) {
    const [row] = await (db.insert(table) as any).values(values).returning();
    this.remember(table, row);
    return row as Record<string, unknown>;
  }

  /** Record a row some other code path inserted, so teardown still owns it. */
  remember(table: PgTable, row: Record<string, unknown>) {
    const byName = cols(table);
    const clauses = pkColumns(table).map((pk) => {
      const key = Object.keys(byName).find((k) => byName[k].name === pk.name)!;
      return eq(pk, row[key] as never);
    });
    this.inserted.push({ table, where: and(...clauses)! });
  }

  /** Reverse insertion order: a child is always removed before its parent. */
  async cleanup() {
    for (const { table, where } of this.inserted.reverse()) {
      await db.delete(table).where(where);
    }
    this.inserted = [];
    this.cache.clear();
  }

  private async once(key: string, make: () => Promise<Record<string, unknown>>) {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const row = await make();
    this.cache.set(key, row);
    return row;
  }

  branch = () =>
    this.once("branch", () =>
      this.add(schema.branches, { name: loc(`Schema Branch ${tag()}`), address: loc("1 Test St, Riyadh") }),
    );

  station = async () =>
    this.once("station", async () =>
      this.add(schema.stations, { branchId: (await this.branch()).id, label: "Chair 1" }),
    );

  staff = () =>
    this.once("staff", () =>
      this.add(schema.staff, { name: "Schema Tech", email: `${tag()}@staff.test`, role: "technician" }),
    );

  service = () =>
    this.once("service", () =>
      this.add(schema.services, { name: loc(`Schema Service ${tag()}`), priceHalalas: 25_000 }),
    );

  addon = () =>
    this.once("addon", () =>
      this.add(schema.addons, { name: loc(`Schema Addon ${tag()}`), priceHalalas: 5_000 }),
    );

  removalType = () =>
    this.once("removalType", () =>
      this.add(schema.removalTypes, { name: loc(`Schema Removal ${tag()}`), priceHalalas: 3_000 }),
    );

  designCollection = () =>
    this.once("designCollection", () =>
      this.add(schema.designCollections, { name: loc(`Schema Collection ${tag()}`) }),
    );

  design = async () =>
    this.once("design", async () =>
      this.add(schema.designs, { name: loc(`Schema Design ${tag()}`), addonId: (await this.addon()).id }),
    );

  customer = () =>
    this.once("customer", () =>
      this.add(schema.customers, { phone: randomPhone(), name: "Schema Customer", email: `${tag()}@example.test` }),
    );

  promoCode = () =>
    this.once("promoCode", () =>
      this.add(schema.promoCodes, { code: `SCHEMA${tag().toUpperCase()}`, type: "percent", value: 10 }),
    );

  giftCardDesign = () =>
    this.once("giftCardDesign", () =>
      this.add(schema.giftCardDesigns, { name: loc(`Schema Card ${tag()}`) }),
    );

  giftCard = () =>
    this.once("giftCard", () =>
      this.add(schema.giftCards, {
        code: `GC${tag().toUpperCase()}`,
        initialHalalas: 50_000,
        balanceHalalas: 50_000,
      }),
    );

  booking = async () =>
    this.once("booking", async () =>
      this.add(schema.bookings, {
        code: `RON-${tag().toUpperCase()}`,
        branchId: (await this.branch()).id,
        serviceId: (await this.service()).id,
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 7_200_000),
      }),
    );

  /** A booking of its own, for the tables that may not share one. */
  newBooking = async () =>
    this.add(schema.bookings, {
      code: `RON-${tag().toUpperCase()}`,
      branchId: (await this.branch()).id,
      serviceId: (await this.service()).id,
      startsAt: new Date(Date.now() + 3_600_000),
      endsAt: new Date(Date.now() + 7_200_000),
    });

  payment = async () =>
    this.once("payment", async () =>
      this.add(schema.payments, { bookingId: (await this.booking()).id, amountHalalas: 25_000 }),
    );

  /**
   * A row that satisfies every constraint on `name` as the schema stands.
   *
   * Booking-shaped rows deliberately leave `stationId` null: the partial unique
   * index on (station_id, starts_at) would otherwise make two sample bookings
   * collide, and that index has its own tests.
   */
  async sample(name: string): Promise<Record<string, unknown>> {
    switch (name) {
      case "staff":
        return { name: "Schema Staff", email: `${tag()}@staff.test` };
      case "staff_time_off":
        return { staffId: (await this.staff()).id, startsOn: "2026-09-10", endsOn: "2026-09-12" };
      case "audit_log":
        return { actorName: "Schema Actor", action: "update", entity: "bookings" };
      case "branches":
        return { name: loc(`B ${tag()}`), address: loc("1 Test St") };
      case "branch_hours":
        // weekday 6 = Friday; the shared branch fixture does not pre-fill hours,
        // but branch_hours_day_unique means a table-wide loop must not reuse one.
        return { branchId: (await this.branch()).id, weekday: nextWeekday(), opens: "10:00:00", closes: "22:00:00" };
      case "stations":
        return { branchId: (await this.branch()).id, label: `Chair ${tag()}` };
      case "closures":
        return { branchId: (await this.branch()).id, startsAt: new Date(), endsAt: new Date(Date.now() + 86_400_000) };
      case "services":
        return { name: loc(`S ${tag()}`), priceHalalas: 25_000 };
      case "addons":
        return { name: loc(`A ${tag()}`), priceHalalas: 5_000 };
      case "removal_types":
        return { name: loc(`R ${tag()}`), priceHalalas: 3_000 };
      case "service_addons":
        return { serviceId: (await this.service()).id, addonId: (await this.addon()).id };
      case "design_collections":
        return { name: loc(`DC ${tag()}`) };
      case "designs":
        return { name: loc(`D ${tag()}`), addonId: (await this.addon()).id };
      case "customers":
        return { phone: randomPhone(), email: `${tag()}@example.test` };
      case "bookings":
        return {
          code: `RON-${tag().toUpperCase()}`,
          branchId: (await this.branch()).id,
          serviceId: (await this.service()).id,
          startsAt: new Date(Date.now() + 3_600_000),
          endsAt: new Date(Date.now() + 7_200_000),
        };
      case "ticket_counters":
        return { branchId: (await this.branch()).id, day: nextDay() };
      case "otps":
        return {
          subject: `email:${tag()}@example.test`,
          codeHash: "not-a-real-hash",
          expiresAt: new Date(Date.now() + 600_000),
        };
      case "booking_addons":
        return { bookingId: (await this.booking()).id, addonId: (await this.addon()).id };
      case "reviews":
        // A fresh booking every time, not the memoised one: reviews_booking_unique
        // means two sample rows sharing a booking collide on *that* constraint,
        // and the duplicate-token test would then pass for the wrong reason.
        return { bookingId: (await this.newBooking()).id };
      case "payments":
        return { bookingId: (await this.booking()).id, amountHalalas: 25_000 };
      case "refunds":
        return { paymentId: (await this.payment()).id, amountHalalas: 5_000 };
      case "gift_card_designs":
        return { name: loc(`GCD ${tag()}`) };
      case "gift_card_values":
        return { amountHalalas: 50_000 };
      case "gift_cards":
        return { code: `GC${tag().toUpperCase()}`, initialHalalas: 50_000, balanceHalalas: 50_000 };
      case "gift_card_txns":
        return { giftCardId: (await this.giftCard()).id, deltaHalalas: -5_000 };
      case "loyalty_txns":
        return { customerId: (await this.customer()).id, deltaPoints: 10 };
      case "promo_codes":
        return { code: `P${tag().toUpperCase()}`, value: 10 };
      case "content_blocks":
        return { key: `schema.${tag()}`, value: loc("copy") };
      case "offers":
        return { title: loc("Offer") };
      case "faqs":
        return { question: loc("Q?"), answer: loc("A.") };
      case "pages":
        return { slug: `schema-${tag()}`, title: loc("T"), body: loc("B") };
      case "subscribers":
        return { email: `${tag()}@example.test` };
      case "media":
        return { path: `schema/${tag()}.webp` };
      case "settings":
        return { key: `schema.${tag()}`, value: { on: true } };
      default:
        throw new Error(`tests/schema/helpers.ts has no sample row for "${name}" — a new table needs one`);
    }
  }
}

/** Never a real customer's number, and unique enough for customers_phone_unique. */
export const randomPhone = () => `05${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

let weekday = 0;
const nextWeekday = () => weekday++ % 7;

let dayOffset = 0;
const nextDay = () =>
  new Date(Date.UTC(2030, 0, 1 + dayOffset++)).toISOString().slice(0, 10);

// ------------------------------------------------------- asserting refusal --

/** The four Postgres classes every constraint in this schema fails with. */
export const PG = {
  unique: "23505",
  foreignKey: "23503",
  notNull: "23502",
  restrict: "23503",
  badEnum: "22P02",
  checkViolation: "23514",
} as const;

/**
 * The SQLSTATE, wherever Drizzle buried it.
 *
 * Drizzle wraps a driver failure in its own error and hangs the postgres-js one
 * off `cause`, so reading `.code` off the top gets undefined and every
 * constraint test passes for the wrong reason — "it threw" instead of "it threw
 * 23505". Walk the chain until a five-character SQLSTATE turns up.
 */
function pgCode(err: unknown): string | undefined {
  for (let e = err, hops = 0; e && hops < 5; e = (e as { cause?: unknown }).cause, hops++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/**
 * Run something that must be refused, and say *which* refusal it was.
 *
 * "it threw" is not enough: a fixture typo throws too, and a test that accepts
 * any error passes for the wrong reason on the day the constraint is dropped.
 */
export async function refuses(
  what: () => Promise<unknown>,
  code: (typeof PG)[keyof typeof PG],
  message: string,
): Promise<void> {
  let caught: unknown;
  try {
    await what();
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) throw new Error(`${message} — but the database accepted it`);
  const got = pgCode(caught);
  if (got !== code) {
    throw new Error(
      `${message} — expected Postgres ${code}, got ${got ?? "no code"}: ${(caught as Error).message}`,
    );
  }
}

/** Rows still present, by primary key. Used to prove a delete rule fired. */
export async function countWhere(table: PgTable, where: SQL): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(table as any).where(where);
  return rows[0]?.n ?? 0;
}
