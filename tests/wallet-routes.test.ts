// Whose credit a purchase route spends (docs/WALLET-PLAN.md, step 5): only the
// signed-in session's. The membership and chair routes take an amount from the
// browser, never a wallet: an email or customer id in the request is ignored,
// and signed out there is no wallet to spend. The chair's QR proves she is at
// the chair, not who she is.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

let signedIn: { id: string; email: string; name: string | null; phone: string } | null = null;
vi.mock("@/lib/account/guard", () => ({ currentCustomer: async () => signedIn }));

import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, bookings, customers, packs, stations, walletTxns } from "@/lib/db/schema";
import { walletBalance } from "@/lib/wallet";
import { POST as buyPack } from "@/app/api/packs/route";
import { POST as buyTreat } from "@/app/api/station/treat/route";
import { fixtures, reset, taggedAddon, type Fixtures } from "./helpers";

const SARA = "sara-routes@test.local";
const NOURA = "noura-routes@test.local";
const TAG = "zz-wallet-routes";
let f: Fixtures;
let sara: { id: string; email: string; name: string | null; phone: string };
let nouraId: string;
let packId: string;
let chair: { id: string; token: string };
let treatId: string;

const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(new Request("http://test.local/api", { method: "POST", body: JSON.stringify(body) }));

async function clean() {
  await db.delete(walletTxns).where(inArray(walletTxns.ownerEmail, [SARA, NOURA]));
  await db.delete(customers).where(inArray(customers.email, [SARA, NOURA]));
  await db.delete(packs).where(eq(packs.sort, 971));
  await db.delete(addons).where(like(addons.image, `${TAG}%`));
}

beforeEach(async () => {
  f = await fixtures();
  await reset(f.branchA, f.branchB);
  await clean();
  signedIn = null;
  const [s] = await db
    .insert(customers)
    .values({ phone: "0500000081", email: SARA, emailVerifiedAt: new Date() })
    .returning();
  sara = { id: s.id, email: SARA, name: null, phone: s.phone };
  const [n] = await db
    .insert(customers)
    .values({ phone: "0500000082", email: NOURA, emailVerifiedAt: new Date() })
    .returning({ id: customers.id });
  nouraId = n.id;
  // Noura has credit; Sara, who is signed in, has none.
  await db.insert(walletTxns).values({ customerId: nouraId, ownerEmail: NOURA, deltaHalalas: 5_000, reason: "correction", note: "test" });

  [{ id: packId }] = await db
    .insert(packs)
    .values({ name: { ar: "باقة", en: "Routes pack" }, priceHalalas: 50_000, validDays: 90, active: true, sort: 971 })
    .returning({ id: packs.id });

  const [c] = await db
    .select({ id: stations.id, token: stations.qrToken })
    .from(stations)
    .where(and(eq(stations.branchId, f.branchA), eq(stations.active, true)))
    .limit(1);
  chair = { id: c.id, token: c.token as string };
  treatId = await taggedAddon(TAG, "coffee", true, { active: true, priceHalalas: 1_000, durationMin: 0 });
  // A visit in progress at that chair, so the chair accepts an order.
  await db.insert(bookings).values({
    code: `RON-WR${Math.floor(Math.random() * 1_000_000)}`,
    branchId: f.branchA,
    customerId: sara.id,
    stationId: chair.id,
    serviceId: f.svcA.id,
    startsAt: new Date(Date.now() - 30 * 60_000),
    endsAt: new Date(Date.now() + 30 * 60_000),
    status: "in_progress",
    source: "web",
    serviceName: { ar: "اختبار", en: "test" },
    totalHalalas: 20_000,
  });
});

afterAll(async () => {
  const g = await fixtures();
  await reset(g.branchA, g.branchB);
  await clean();
});

describe("a membership bought with credit", () => {
  it("spends no wallet signed out", async () => {
    const res = await post(buyPack, { packId, walletHalalas: 5_000 });
    expect(res.status).toBe(401);
    expect((await walletBalance(NOURA)).available).toBe(5_000);
  });

  it("spends the session's wallet, never one the request names", async () => {
    signedIn = sara;
    const res = await post(buyPack, { packId, walletHalalas: 5_000, email: NOURA, customerId: nouraId });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "wallet-changed", walletBalance: 0 });
    expect((await walletBalance(NOURA)).available).toBe(5_000);
  });
});

describe("a chair treat bought with credit", () => {
  it("spends no wallet signed out, though the QR is valid", async () => {
    const res = await post(buyTreat, { token: chair.token, addonIds: [treatId], walletHalalas: 1_000 });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signed-out" });
    expect((await walletBalance(NOURA)).available).toBe(5_000);
  });

  it("spends the session's wallet, never one the request names", async () => {
    signedIn = sara;
    const res = await post(buyTreat, { token: chair.token, addonIds: [treatId], walletHalalas: 1_000, email: NOURA, customerId: nouraId });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wallet-changed" });
    expect((await walletBalance(NOURA)).available).toBe(5_000);
  });
});
