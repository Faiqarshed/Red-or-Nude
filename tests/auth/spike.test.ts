import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { Fixtures } from "../helpers/fixtures";
import { mintSignupTicket } from "@/lib/account/session";

const fx = new Fixtures();
afterEach(() => fx.cleanup());

it("register onto a phone that already has a different verified email", async () => {
  const victim = await fx.customer({ verified: true, name: "Victim", phone: "0551112233", email: "victim@example.test" });
  const ticket = await mintSignupTicket("attacker@example.test");
  const { POST } = await import("@/app/api/account/register/route");
  const res = await POST(new Request("http://x/api/account/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
    body: JSON.stringify({ ticket, name: "Attacker", phone: "0551112233" }),
  }));
  console.log("STATUS", res.status, JSON.stringify(await res.json()));
  const [row] = await db.select().from(customers).where(eq(customers.id, victim.id));
  console.log("VICTIM ROW NOW:", JSON.stringify({ name: row?.name, email: row?.email, verified: !!row?.emailVerifiedAt }));
});
