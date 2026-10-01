// "Did it go through?" is asked every 3 seconds by every open checkout, and
// each unpaid ask can cost StreamPay three calls. So an undecided answer is
// reused for a few seconds, and a decided one never is: it must reach her the
// moment it is known, and is cheap to read again.

import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const { answers, settlePayment } = vi.hoisted(() => {
  const answers: { status: string }[] = [];
  return { answers, settlePayment: vi.fn(async () => answers.shift() ?? { status: "pending" }) };
});
vi.mock("@/lib/payments/settle", () => ({ settlePayment }));

import { GET } from "@/app/api/payments/status/route";

const ask = async (ref: string) =>
  (await GET(new Request(`http://test.local/api/payments/status?ref=${ref}`, { headers: { "x-forwarded-for": ref } }))).json();

describe("asking whether a payment went through", () => {
  it("reuses an undecided answer for a few seconds, then asks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const ref = randomUUID();
      settlePayment.mockClear();
      expect(await ask(ref)).toEqual({ status: "pending" });
      expect(await ask(ref)).toEqual({ status: "pending" });
      expect(settlePayment).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_001);
      await ask(ref);
      expect(settlePayment).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reuses a decided answer", async () => {
    const ref = randomUUID();
    settlePayment.mockClear();
    answers.push({ status: "paid" }, { status: "paid" });
    expect(await ask(ref)).toEqual({ status: "paid" });
    expect(await ask(ref)).toEqual({ status: "paid" });
    expect(settlePayment).toHaveBeenCalledTimes(2);
  });

  it("refuses a ref that is not a payment's", async () => {
    const res = await GET(new Request("http://test.local/api/payments/status?ref=not-a-uuid"));
    expect(res.status).toBe(400);
  });
});
