// Driving the application's own entry points from a test.
//
// Route handlers and Server Actions are ordinary functions, but they read the
// request context out of `next/headers` and announce their writes through
// `next/cache`, neither of which exists outside a Next server. This module owns
// the three mocks that stand in for them, plus the two request builders, so a
// suite declares them in four lines instead of reinventing a cookie jar.
//
// The mocks are objects rather than `vi.mock` calls because `vi.mock` is
// hoisted above every import: a test file must make the call itself, and can
// only reach shared state through a dynamic import inside the factory.
//
//   vi.mock("next/headers", async () => (await import("../helpers/app")).headersMock);
//   vi.mock("next/cache",   async () => (await import("../helpers/app")).cacheMock);
//   vi.mock("@/lib/auth",   async () => (await import("../helpers/app")).authMock);
//
//   beforeEach(resetAppContext);

import type { SessionStaff } from "@/lib/auth/guard";

/** Cookies the "browser" is holding. Written by set(), read by the handler. */
export const jar = new Map<string, string>();

/** Request headers the handler will see, for the ones it reads via headers(). */
export const inboundHeaders = new Headers();

/** Who `auth()` reports as signed in. Null is signed out. */
export const actor: { current: SessionStaff | null } = { current: null };

/** Every revalidatePath/revalidateTag the code under test fired. */
export const revalidated: Array<{ kind: "path" | "tag"; value: string }> = [];

/** Wipe all of the above. Call in beforeEach or state leaks between cases. */
export function resetAppContext() {
  jar.clear();
  inboundHeaders.forEach((_, k) => inboundHeaders.delete(k));
  actor.current = null;
  revalidated.length = 0;
}

export const headersMock = {
  cookies: () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: (name: string | { name: string; value: string }, value?: string) =>
      typeof name === "string" ? jar.set(name, value ?? "") : jar.set(name.name, name.value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: () => inboundHeaders,
};

export const cacheMock = {
  revalidatePath: (value: string) => void revalidated.push({ kind: "path", value }),
  revalidateTag: (value: string) => void revalidated.push({ kind: "tag", value }),
  unstable_cache:
    <T extends (...a: never[]) => unknown>(fn: T) =>
    (...a: Parameters<T>) =>
      fn(...a),
};

export const authMock = {
  auth: async () => (actor.current ? { user: actor.current } : null),
};

/** Sign in as this staff row for the rest of the test. */
export function signInAs(staff: {
  id: string;
  name: string;
  email: string;
  role: SessionStaff["role"];
  branchId: string | null;
}) {
  actor.current = { ...staff };
}

// ------------------------------------------------------------- requests -----

/**
 * A JSON POST.
 *
 * Every public route throttles on `clientIp`, which reads x-forwarded-for — so
 * each case gets its own address by default. Sharing one would make the
 * eleventh test in a file fail with 429 for reasons that have nothing to do
 * with what it is asserting; pass an explicit `ip` when the throttle IS the
 * subject.
 */
let ipSeq = 0;
export const nextIp = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

export function post(
  url: string,
  body: unknown,
  opts: { ip?: string; cookie?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": opts.ip ?? nextIp(),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function get(
  url: string,
  opts: { ip?: string; cookie?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(url, {
    headers: {
      "x-forwarded-for": opts.ip ?? nextIp(),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
  });
}

/** Status and parsed body together — the pair almost every assertion wants. */
export async function read(res: Response): Promise<{ status: number; body: any }> {
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}
