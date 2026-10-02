// The settle job also archives StreamPay products retired over an hour ago
// (lib/payments/streampay.ts). It runs after the settling, says how many, and
// a StreamPay hiccup while archiving never fails the run: the settling is the
// net under every payment, and the archiving can wait for the next run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { archiveRetiredProducts } = vi.hoisted(() => ({ archiveRetiredProducts: vi.fn() }));
vi.mock("@/lib/payments/streampay", () => ({ archiveRetiredProducts }));
vi.mock("@/lib/payments/reconcile", () => ({
  reconcilePayments: async () => ({ checked: 0, refunded: 0 }),
  reportPaymentProblems: async () => 0,
}));

import { GET } from "@/app/api/cron/settle-pending/route";

const env = process.env as Record<string, string | undefined>;
const run = () => GET(new Request("http://test.local/api/cron/settle-pending", { headers: { authorization: "Bearer cron-test" } }));
let was: string | undefined;

beforeEach(() => {
  was = env.CRON_SECRET;
  env.CRON_SECRET = "cron-test";
  archiveRetiredProducts.mockReset();
});
afterEach(() => {
  env.CRON_SECRET = was;
});

describe("the settle job archiving retired products", () => {
  it("archives them and says how many", async () => {
    archiveRetiredProducts.mockResolvedValue(3);
    const res = await run();
    expect(await res.json()).toMatchObject({ ok: true, archived: 3 });
    expect(archiveRetiredProducts).toHaveBeenCalledTimes(1);
  });

  it("still finishes the run when archiving fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    archiveRetiredProducts.mockRejectedValue(new Error("StreamPay down"));
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, archived: 0 });
  });
});
