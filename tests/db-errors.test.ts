// Reading which constraint a write tripped.
//
// Not a nicety. Three screens tell the user the one thing they can act on —
// "that code already exists", "another active item already has this name" — by
// naming the constraint that refused them, and the way to find that name is not
// obvious: drizzle wraps the driver's error, so `err.message` holds the SQL it
// attempted and Postgres' own message hangs off `err.cause`.
//
// Matching `err.message` is what the promo-code screen did, and it never once
// matched: every duplicate code showed a bare "something went wrong". So this
// goes through a real violation against a real Postgres rather than a
// hand-built error object — a fake one would have passed the old code too.

import "./as-staff";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import { db } from "@/lib/db";
import { promoCodes, services } from "@/lib/db/schema";
import { violatedConstraint } from "@/lib/db/errors";
import { nameLike } from "./helpers";

const CODE = "ZZDBERRTEST";
const NAME = "zz-db-error-test";

async function wipe() {
  await db.delete(promoCodes).where(like(promoCodes.code, `${CODE}%`));
  await db.delete(services).where(nameLike(services, `${NAME}%`));
}

/** Run something that must fail, and hand back what it threw. */
async function thrown(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  throw new Error("expected that write to be refused");
}

beforeEach(wipe);
afterAll(wipe);

describe("violatedConstraint", () => {
  it("names the unique index a duplicate promo code trips", async () => {
    await db.insert(promoCodes).values({ code: CODE, type: "percent", value: 10 });

    const err = await thrown(() =>
      db.insert(promoCodes).values({ code: CODE, type: "percent", value: 20 }),
    );

    expect(violatedConstraint(err)).toBe("promo_codes_code_unique");
    // The half that was wrong before: the name is nowhere in `message`, so the
    // old `err.message.includes(...)` could only ever return false.
    expect((err as Error).message).not.toContain("promo_codes_code_unique");
  });

  it("names the partial index a duplicate active catalogue name trips", async () => {
    const row = { name: { ar: NAME, en: NAME }, priceHalalas: 100, durationMin: 30 };
    await db.insert(services).values(row);

    const err = await thrown(() => db.insert(services).values(row));

    expect(violatedConstraint(err)).toBe("services_active_name_en_unique");
  });

  it("returns null for an error that broke no constraint", async () => {
    // Everything else the admin catches: a dropped connection, a bad cast, a
    // bug. These must fall through to the generic message rather than be
    // reported as a name clash.
    expect(violatedConstraint(new Error("connection terminated"))).toBeNull();
    expect(violatedConstraint(null)).toBeNull();
    expect(violatedConstraint(undefined)).toBeNull();
    expect(violatedConstraint("not an error at all")).toBeNull();
  });
});

describe("the duplicate promo code reaches the screen", () => {
  it("is reported as a duplicate, not as a failure", async () => {
    // The end of the chain this file exists for: the constraint name is read,
    // matched, and turned into the one sentence the marketing screen can show.
    const { savePromoCode } = await import(
      "@/app/(admin)/admin/(shell)/promo-codes/actions"
    );

    const first = await savePromoCode({
      code: CODE,
      type: "percent",
      value: 10,
      minTotalSar: 0,
      active: true,
    });
    expect(first.ok).toBe(true);

    const second = await savePromoCode({
      code: CODE,
      type: "percent",
      value: 20,
      minTotalSar: 0,
      active: true,
    });

    expect(second).toEqual({ ok: false, error: "duplicate" });
  });
});
