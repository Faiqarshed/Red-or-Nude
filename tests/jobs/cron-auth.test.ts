// The four scheduled jobs, treated as what they are: public URLs.
//
// Each one's own comment says it — "A cron endpoint is a public URL. Without
// this, anyone could reshuffle the salon's floor from the outside." The only
// thing between the internet and a job that marks customers as no-shows, mails
// every technician, or mints a month of ~90% staff discount codes is one string
// comparison against CRON_SECRET.
//
// So this file runs each route through the same eight refusals, driven off a
// table rather than written out four times — a fifth job added without a guard
// should fail here, which only happens if the list of jobs is discovered in one
// place. What would be easy to break: adding a cron route and forgetting the
// four lines, which nothing else in the codebase would notice.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, read } from "../helpers/app";

vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
vi.mock("next/cache", async () => (await import("../helpers/app")).cacheMock);
// Nothing may leave the box. Every job here either mails or notifies.
vi.mock("@/lib/notify", () => ({ notify: async () => {} }));
vi.mock("@/lib/email", () => ({ sendMail: async () => ({ ok: true }) }));
// Nothing mocks @/lib/assign/email on purpose: it exports renderAssignmentEmail,
// which is a pure template with no I/O of its own. The boundary that matters is
// sendMail above, and a mock naming an export the module does not have would be
// replaced silently and protect nothing.

const SECRET = "test-cron-secret-do-not-ship";

/** Every scheduled job, by the path a scheduler would call. */
const JOBS = [
  "assign-day",
  "refill-reminders",
  "staff-codes",
  "tech-reminders",
] as const;

const load = (job: string) => import(`@/app/api/cron/${job}/route`);
const url = (job: string) => `http://x/api/cron/${job}`;

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(JOBS)("GET /api/cron/%s", (job) => {
  it("refuses a caller with no authorization header", async () => {
    const { GET } = await load(job);
    const { status, body } = await read(await GET(get(url(job))));
    expect(status).toBe(401);
    expect(body.error).toBe("unauthorized");
  });

  it("refuses a wrong secret", async () => {
    const { GET } = await load(job);
    const res = await GET(get(url(job), { headers: { authorization: "Bearer wrong-secret" } }));
    expect(res.status).toBe(401);
  });

  it("refuses an empty bearer token", async () => {
    const { GET } = await load(job);
    const res = await GET(get(url(job), { headers: { authorization: "Bearer " } }));
    expect(res.status).toBe(401);
  });

  it("refuses the right secret without the Bearer scheme", async () => {
    // The comparison is against the whole header, so a bare secret is refused.
    // Pinned so nobody "helpfully" starts accepting both.
    const { GET } = await load(job);
    const res = await GET(get(url(job), { headers: { authorization: SECRET } }));
    expect(res.status).toBe(401);
  });

  it("refuses the secret in some other header", async () => {
    const { GET } = await load(job);
    const res = await GET(
      get(url(job), { headers: { "x-cron-secret": SECRET, "x-vercel-cron": "1" } }),
    );
    expect(res.status).toBe(401);
  });

  it("refuses a lowercase bearer scheme", async () => {
    // The comparison is a plain string equality against `Bearer <secret>`, so
    // the scheme is case-sensitive even though RFC 7235 says it should not be.
    // Pinned rather than reported: refusing too much is the safe direction, and
    // the only caller is a scheduler we configure ourselves.
    const { GET } = await load(job);
    const res = await GET(get(url(job), { headers: { authorization: `bearer ${SECRET}` } }));
    expect(res.status).toBe(401);
  });

  it("refuses everyone when CRON_SECRET is not configured", async () => {
    // Fails closed. An unset secret must not mean "no gate" — that is the
    // difference between a job nobody can run and one anybody can.
    vi.stubEnv("CRON_SECRET", "");
    const { GET } = await load(job);
    const withHeader = await GET(get(url(job), { headers: { authorization: "Bearer " } }));
    const withNothing = await GET(get(url(job)));
    expect(withHeader.status).toBe(401);
    expect(withNothing.status).toBe(401);
  });

  it("does not honour the middleware-bypass header", async () => {
    // CVE-2025-29927: Next trusted the internal x-middleware-subrequest header,
    // letting a caller skip middleware entirely. These routes never relied on
    // middleware — /admin is the only matcher — but the header must not be a
    // way past the secret either.
    const { GET } = await load(job);
    const res = await GET(
      get(url(job), {
        headers: {
          "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware",
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("lets the real scheduler through", async () => {
    // The other direction: a guard that refuses everyone is also broken.
    const { GET } = await load(job);
    const res = await GET(get(url(job), { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status, `${job} refused a correctly authorised call`).toBe(200);
  });
});

describe("the set of scheduled jobs", () => {
  it("is exactly the four this file knows about", async () => {
    // A fifth job added without a guard is the failure mode. Discovering the
    // directory here means it shows up as a failure in this file rather than
    // as a route nobody tested.
    const { readdirSync } = await import("node:fs");
    const found = readdirSync("app/api/cron", { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(found, "a cron route was added — give it the eight refusals above").toEqual(
      [...JOBS].sort(),
    );
  });

  /**
   * A job with a guard and no schedule never runs. Three of the four are
   * unscheduled and only two of those say so, which is the distinction this
   * table encodes — each entry is what the route's own header comment claims.
   */
  const SCHEDULING: Record<(typeof JOBS)[number], "scheduled" | "deliberately-not"> = {
    // "Schedule this for early morning in vercel.json" — and it is.
    "assign-day": "scheduled",
    // "Nothing schedules this yet — it sends through the notify seam, which is
    // a log driver until a real provider is configured."
    "refill-reminders": "deliberately-not",
    // "NOT scheduled in vercel.json. It wants a quarter-hourly run, and
    // Vercel's Hobby plan refuses any cron more frequent than once a day."
    "tech-reminders": "deliberately-not",
    // "Schedule this for the 1st of the month in vercel.json" — added
    // 2026-09-03, closing BUG-JOBS-001. Until then the monthly staff discount
    // codes had never been minted, and nothing errored to say so.
    "staff-codes": "scheduled",
  };

  it("matches what each route's comment says about its own schedule", async () => {
    const { readFileSync } = await import("node:fs");
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      crons?: Array<{ path: string; schedule: string }>;
    };
    const scheduled = new Set((vercel.crons ?? []).map((c) => c.path));

    const actual = Object.fromEntries(
      JOBS.map((j) => [j, scheduled.has(`/api/cron/${j}`) ? "scheduled" : "deliberately-not"]),
    );
    expect(actual).toEqual(SCHEDULING);
  });

  it("schedules staff-codes on the 1st, as its comment instructs", async () => {
    const { readFileSync } = await import("node:fs");
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      crons?: Array<{ path: string; schedule: string }>;
    };
    const entry = (vercel.crons ?? []).find((c) => c.path === "/api/cron/staff-codes");
    expect(entry, "staff-codes has no cron entry, so no staff code is ever issued").toBeDefined();
    // The month boundary the route's own comment specifies.
    expect(entry!.schedule).toBe("0 1 1 * *");
  });
});
