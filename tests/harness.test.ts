// Proves the harness itself, so a red suite is never blamed on the plumbing.
//
// Three things have to hold before any other test file means anything: the
// _test-db gate rewrote DATABASE_URL to the throwaway database, the fixtures
// can insert through the real Drizzle client, and cleanup() removes exactly
// what it created and nothing more.

import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { branches, customers } from "@/lib/db/schema";
import { Fixtures } from "./helpers/fixtures";

const fx = new Fixtures();
afterEach(() => fx.cleanup());

it("runs against the throwaway database, never DATABASE_URL from .env", () => {
  expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(/_test$/);
});

it("builds a branch with hours and chairs", async () => {
  const branch = await fx.branch({ stationCount: 3 });
  expect(branch.stations).toHaveLength(3);

  const [read] = await db.select().from(branches).where(eq(branches.id, branch.id));
  expect(read.name).toEqual({ ar: expect.any(String), en: expect.any(String) });
});

it("cleanup removes what it created and leaves a bystander row alone", async () => {
  // A row this Fixtures instance does not own — it must survive cleanup().
  const [bystander] = await db
    .insert(customers)
    .values({ phone: `0599${Date.now().toString().slice(-6)}`, name: "Bystander" })
    .returning();

  const mine = await fx.customer();
  await fx.cleanup();

  expect(await db.select().from(customers).where(eq(customers.id, mine.id))).toHaveLength(0);
  expect(await db.select().from(customers).where(eq(customers.id, bystander.id))).toHaveLength(1);

  await db.delete(customers).where(eq(customers.id, bystander.id));
});
