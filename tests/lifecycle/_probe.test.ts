import { afterEach, expect, it, vi } from "vitest";
import { Fixtures } from "../helpers/fixtures";

vi.mock("server-only", () => ({}));

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined) }),
}));

const actor = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/auth/index", () => ({ auth: async () => (actor.current ? { user: actor.current } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const fx = new Fixtures();
afterEach(() => fx.cleanup());

it("probe: route handler", async () => {
  const { POST } = await import("@/app/api/my-bookings/route");
  const branch = await fx.branch();
  const svc = await fx.service();
  const b = await fx.booking({ branchId: branch.id, serviceId: svc.id, status: "confirmed" });
  const res = await POST(new Request("http://x/api/my-bookings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
    body: JSON.stringify({ code: b.code }),
  }));
  expect(res.status).toBe(200);
  expect((await res.json()).bookings).toHaveLength(1);
});

it("probe: server action", async () => {
  const { setBookingStatus } = await import("@/app/(admin)/admin/(shell)/bookings/actions");
  const branch = await fx.branch();
  const ceo = await fx.staff("ceo", branch.id);
  actor.current = { id: ceo.id, name: ceo.name, email: ceo.email, role: "ceo", branchId: branch.id };
  const b = await fx.booking({ branchId: branch.id, status: "confirmed", startsAt: new Date(Date.now() - 60_000) });
  expect(await setBookingStatus(b.id, "checked_in")).toEqual({ ok: true });
});

it("probe: session cookie", async () => {
  const { ACCOUNT_COOKIE, mintSession } = await import("@/lib/account/session");
  const { currentCustomer } = await import("@/lib/account/guard");
  const cust = await fx.customer({ verified: true });
  jar.set(ACCOUNT_COOKIE, await mintSession(cust.id));
  expect((await currentCustomer())?.id).toBe(cust.id);
});
