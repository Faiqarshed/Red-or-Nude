// Server actions, callable from a test.
//
// Every admin action opens with a capability check that reads the session
// cookie and closes with `revalidatePath`; a test run has neither. Import this
// first, before anything that loads an action, and the action runs as a staff
// member with every capability. `id: null` is a real actor shape —
// audit_log.actor_id is nullable for a customer who cancels her own booking —
// so the audit row still writes without a fake staff record.
import { vi } from "vitest";

vi.mock("@/lib/auth/guard", () => ({
  requireCan: async () => ({ id: null, name: "Test run" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
