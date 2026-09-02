// Every admin Server Action is a public HTTP endpoint. This file treats them
// that way.
//
// The sidebar hides what a role cannot reach and the drawer greys out the
// buttons it must not offer, and neither of those is access control: a Server
// Action is a POST to a URL anyone who has read the page's JavaScript can call.
// So each of the 43 guarded actions is invoked here three ways —
//
//   * signed out entirely,
//   * signed in as each of the four roles in turn,
//   * as an ordinary technician, who reaches none of the privileged screens,
//
// and the set of roles that gets through is asserted to be *exactly* the set
// lib/auth/rbac.ts grants the capability to. Not "a technician is refused",
// which stays green when a capability is quietly widened, but the whole row.
//
// What would be easy to break: adding an action to one of these files and
// forgetting `requireCan`. Nothing else in the codebase would notice — the
// screen would work, the tests would pass, and the endpoint would be open. Add
// a new action, add it to ACTIONS below, or this file is lying by omission.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.mock("@/lib/auth", async () => (await import("./helpers")).authModuleMock);
vi.mock("next/cache", async () => (await import("./helpers")).nextCacheMock);
vi.mock("next/headers", async () => (await import("./helpers")).nextHeadersMock);

import { db } from "@/lib/db";
import { auditLog, bookings, branchHours, stations, type StaffRole } from "@/lib/db/schema";
import { can, type Capability } from "@/lib/auth/rbac";
import { Fixtures } from "../helpers/fixtures";
import { ROLES, actingAs, asNobody, restoreSession, sessionFor, type Actor } from "./helpers";

import * as availability from "@/app/(admin)/admin/(shell)/availability/actions";
import * as bookingsActions from "@/app/(admin)/admin/(shell)/bookings/actions";
import * as catalog from "@/app/(admin)/admin/(shell)/catalog/actions";
import * as customersActions from "@/app/(admin)/admin/(shell)/customers/actions";
import * as floor from "@/app/(admin)/admin/(shell)/floor/actions";
import * as frontDesk from "@/app/(admin)/admin/(shell)/front-desk/actions";
import * as giftCardsActions from "@/app/(admin)/admin/(shell)/gift-cards/actions";
import * as mediaActions from "@/app/(admin)/admin/(shell)/media/actions";
import * as myDay from "@/app/(admin)/admin/(shell)/my-day/actions";
import * as promoCodes from "@/app/(admin)/admin/(shell)/promo-codes/actions";
import * as staffActions from "@/app/(admin)/admin/(shell)/staff/actions";

/**
 * A uuid that is not a row in any table.
 *
 * Every action here checks the capability *before* it looks anything up, so a
 * caller who gets past the guard lands on "not-found" and changes nothing. That
 * is what makes it safe to fire all 43 actions as all four roles against a
 * shared database.
 */
const NOWHERE = "00000000-0000-4000-8000-000000000000";

type Surface = {
  /** `<file>.<export>`, so a failure names the file to open. */
  name: string;
  /** The capability lib/auth/rbac.ts is asked for. */
  cap: Capability;
  run: () => Promise<unknown>;
};

const ACTIONS: Surface[] = [
  // ---- availability: the opening hours, the chairs, the Eid closures -------
  { name: "availability.saveBranchHours", cap: "availability.manage", run: () => availability.saveBranchHours({ branchId: NOWHERE, weekday: 0, opens: "10:00", closes: "22:00", closed: false }) },
  { name: "availability.addStation", cap: "availability.manage", run: () => availability.addStation(NOWHERE, "") },
  { name: "availability.setStationActive", cap: "availability.manage", run: () => availability.setStationActive(NOWHERE, false) },
  { name: "availability.deleteStation", cap: "availability.manage", run: () => availability.deleteStation(NOWHERE) },
  { name: "availability.addClosure", cap: "availability.manage", run: () => availability.addClosure({ branchId: null, from: "bad", to: "bad" }) },
  { name: "availability.deleteClosure", cap: "availability.manage", run: () => availability.deleteClosure(NOWHERE) },

  // ---- bookings -----------------------------------------------------------
  // setBookingStatus asks for bookings.manage and then asks a second question
  // for anything that is not the desk's own two moves. The second question is
  // pinned in bookings.test.ts; this row is the front door.
  { name: "bookings.setBookingStatus", cap: "bookings.manage", run: () => bookingsActions.setBookingStatus(NOWHERE, "checked_in") },
  { name: "bookings.rescheduleBooking", cap: "bookings.reschedule", run: () => bookingsActions.rescheduleBooking({ id: NOWHERE, startsAt: "not-a-date" }) },
  { name: "bookings.resolveNoShow", cap: "bookings.manage", run: () => bookingsActions.resolveNoShow({ id: NOWHERE }) },
  { name: "bookings.createWalkIn", cap: "bookings.manage", run: () => bookingsActions.createWalkIn({ branchId: NOWHERE, serviceId: NOWHERE, startsAt: "not-a-date", phone: "" }) },
  { name: "bookings.rescheduleNoShow", cap: "bookings.reschedule", run: () => bookingsActions.rescheduleNoShow({ id: NOWHERE, startsAt: "not-a-date" }) },
  { name: "bookings.deleteBooking", cap: "bookings.delete", run: () => bookingsActions.deleteBooking(NOWHERE) },

  // ---- catalog: the price list the public booking page reads ---------------
  { name: "catalog.saveCatalogItem", cap: "catalog.manage", run: () => catalog.saveCatalogItem({ kind: "service", name: { ar: "", en: "" }, priceSar: -1, durationMin: -1, active: true, sort: 0 }) },
  { name: "catalog.setCatalogActive", cap: "catalog.manage", run: () => catalog.setCatalogActive("service", NOWHERE, false) },
  { name: "catalog.deleteCatalogItem", cap: "catalog.manage", run: () => catalog.deleteCatalogItem("service", NOWHERE) },
  { name: "catalog.moveCatalogItem", cap: "catalog.manage", run: () => catalog.moveCatalogItem("service", NOWHERE, "up") },

  // ---- customers ----------------------------------------------------------
  { name: "customers.updateCustomer", cap: "customers.manage", run: () => customersActions.updateCustomer({ id: NOWHERE, name: null, email: null, notes: null, blocked: false }) },

  // ---- floor: sending a technician home ------------------------------------
  { name: "floor.sendHome", cap: "bookings.checkin", run: () => floor.sendHome(NOWHERE) },
  { name: "floor.bringBack", cap: "bookings.checkin", run: () => floor.bringBack(NOWHERE) },

  // ---- front desk ----------------------------------------------------------
  // findTicket reads a customer's name and appointment out of the database, so
  // it is guarded exactly as hard as the writes beside it.
  { name: "front-desk.findTicket", cap: "bookings.checkin", run: () => frontDesk.findTicket(NOWHERE, "A1") },
  { name: "front-desk.checkInTicket", cap: "bookings.checkin", run: () => frontDesk.checkInTicket(NOWHERE) },
  { name: "front-desk.closeTicket", cap: "bookings.checkin", run: () => frontDesk.closeTicket(NOWHERE) },
  { name: "front-desk.assignTechnician", cap: "bookings.checkin", run: () => frontDesk.assignTechnician(NOWHERE, NOWHERE) },

  // ---- gift cards: issuing is the desk's, moving a balance is not ----------
  { name: "gift-cards.issueCard", cap: "giftcards.issue", run: () => giftCardsActions.issueCard({ amountSar: 0 }) },
  { name: "gift-cards.adjustCard", cap: "giftcards.adjust", run: () => giftCardsActions.adjustCard({ id: NOWHERE, amountSar: 0, reason: "" }) },
  { name: "gift-cards.cancelCard", cap: "giftcards.adjust", run: () => giftCardsActions.cancelCard(NOWHERE) },
  { name: "gift-cards.addGiftValue", cap: "giftcards.adjust", run: () => giftCardsActions.addGiftValue(-1) },
  { name: "gift-cards.deleteGiftValue", cap: "giftcards.adjust", run: () => giftCardsActions.deleteGiftValue(NOWHERE) },
  { name: "gift-cards.saveGiftDesign", cap: "giftcards.adjust", run: () => giftCardsActions.saveGiftDesign({ nameAr: "", nameEn: "", active: true }) },
  { name: "gift-cards.deleteGiftDesign", cap: "giftcards.adjust", run: () => giftCardsActions.deleteGiftDesign(NOWHERE) },

  // ---- media ---------------------------------------------------------------
  { name: "media.listMedia", cap: "media.manage", run: () => mediaActions.listMedia() },
  { name: "media.uploadMedia", cap: "media.manage", run: () => mediaActions.uploadMedia(new FormData()) },
  { name: "media.updateMediaAlt", cap: "media.manage", run: () => mediaActions.updateMediaAlt(NOWHERE, { ar: "أ", en: "a" }) },
  { name: "media.deleteMedia", cap: "media.manage", run: () => mediaActions.deleteMedia(NOWHERE) },

  // ---- my day: the technician's two buttons --------------------------------
  { name: "my-day.startService", cap: "bookings.own", run: () => myDay.startService(NOWHERE) },
  { name: "my-day.finishService", cap: "bookings.own", run: () => myDay.finishService(NOWHERE) },

  // ---- promo codes ---------------------------------------------------------
  { name: "promo-codes.savePromoCode", cap: "marketing.manage", run: () => promoCodes.savePromoCode({ code: "!!", type: "percent", value: 1, active: true }) },
  { name: "promo-codes.setPromoActive", cap: "marketing.manage", run: () => promoCodes.setPromoActive(NOWHERE, false) },

  // ---- staff ---------------------------------------------------------------
  { name: "staff.saveStaff", cap: "staff.manage", run: () => staffActions.saveStaff({ name: "", email: "nope", role: "technician", active: true }) },
  { name: "staff.setStaffActive", cap: "staff.manage", run: () => staffActions.setStaffActive(NOWHERE, false) },
  { name: "staff.deleteStaff", cap: "staff.manage", run: () => staffActions.deleteStaff(NOWHERE) },
  { name: "staff.addTimeOff", cap: "staff.manage", run: () => staffActions.addTimeOff({ staffId: NOWHERE, startsOn: "bad", endsOn: "bad" }) },
  { name: "staff.removeTimeOff", cap: "staff.manage", run: () => staffActions.removeTimeOff(NOWHERE) },
];

/**
 * Did the guard turn this call away?
 *
 * Anything else — an invalid payload, a row that isn't there, a foreign key
 * complaint — means the caller got *through* the guard, which is the only
 * question this file asks. Deliberately not "did it return ok", because most of
 * these are fired at a uuid that doesn't exist and are supposed to say so.
 */
async function wasForbidden(surface: Surface): Promise<boolean> {
  try {
    await surface.run();
    return false;
  } catch (err) {
    return err instanceof Error && err.name === "ForbiddenError";
  }
}

const fx = new Fixtures();
const sessions = {} as Record<StaffRole, Actor>;

beforeAll(async () => {
  // One branch, so the pinned roles are pinned to something real rather than
  // reading as CEO — see the branch-scope suite for why a null branch matters.
  const branch = await fx.branch();
  for (const role of ROLES) {
    const row = await fx.staff(role, role === "ceo" ? null : branch.id);
    sessions[role] = sessionFor(row);
  }
});

afterEach(() => restoreSession());

afterAll(async () => {
  // The actions that got through wrote audit rows against NOWHERE. They are not
  // fixtures — the code under test made them — so they are swept by entity id.
  await db.delete(auditLog).where(eq(auditLog.entityId, NOWHERE));
  await fx.cleanup();
});

describe("a signed-out visitor reaches nothing", () => {
  // Attack: POST the Server Action's endpoint with no session cookie at all.
  // Middleware would have redirected a browser; it never sees a direct POST,
  // and middleware.ts:1-3 says as much itself.
  it.each(ACTIONS.map((a) => [a.name, a] as const))("%s refuses an anonymous caller", async (_n, surface) => {
    asNobody();
    expect(await wasForbidden(surface)).toBe(true);
  });
});

describe("the set of roles that gets through is the set rbac.ts grants", () => {
  // Attack: sign in as the lowest-privilege account the salon issues and call
  // every action in the panel, including the ones whose screens that account
  // cannot open.
  it.each(ACTIONS.map((a) => [a.name, a] as const))("%s admits exactly its capability holders", async (_n, surface) => {
    for (const role of ROLES) {
      actingAs(sessions[role]);
      const forbidden = await wasForbidden(surface);
      const allowed = can(role, surface.cap);
      expect(
        forbidden,
        allowed
          ? `a ${role} holds ${surface.cap} and must be able to call ${surface.name}`
          : `a ${role} does not hold ${surface.cap} and must not reach ${surface.name}`,
      ).toBe(!allowed);
    }
  });
});

describe("an ordinary technician, invoking screens she cannot open", () => {
  // Phase 6.2 item 8 stated the other way round: the technician's own two
  // buttons are the *only* thing in the panel she may call.
  it("reaches her own two buttons and nothing else", async () => {
    actingAs(sessions.technician);

    const reachable: string[] = [];
    for (const surface of ACTIONS) {
      if (!(await wasForbidden(surface))) reachable.push(surface.name);
    }

    expect(reachable.sort()).toEqual(["my-day.finishService", "my-day.startService"]);
  });
});

describe("the capability matrix itself", () => {
  // These are the grants the glossary flags as reading backwards. check-roles.ts
  // asserts them too; they are repeated here because this suite is what runs in
  // CI, and a rule proved in a script nobody runs is not proved.
  it("admin may delete a booking but may not move one or set its status", () => {
    expect(can("admin", "bookings.delete"), "an admin can remove a mistake").toBe(true);
    expect(can("admin", "bookings.reschedule"), "an admin does not move an appointment — brief §3.3").toBe(false);
    expect(can("admin", "bookings.status"), "an admin does not overwrite a booking's status").toBe(false);
  });

  it("the front desk keeps the reschedule it lost and got back", () => {
    expect(can("receptionist", "bookings.reschedule"), "the desk moves the appointment, or the ticket number is lost").toBe(true);
    expect(can("receptionist", "bookings.delete"), "the front desk cancels bookings, it does not delete them").toBe(false);
    expect(can("receptionist", "bookings.status"), "the desk checks in and closes; it does not rewrite the record").toBe(false);
  });

  it("a receptionist sees neither the revenue dashboard nor the technicians' timings", () => {
    expect(can("receptionist", "dashboard.view"), "/admin renders the desk the front desk, not the dashboard").toBe(false);
    expect(can("receptionist", "dashboard.revenue"), "takings are not the counter's business").toBe(false);
    expect(can("receptionist", "staff.performance"), "the front desk does not see KPIs").toBe(false);
  });

  it("an admin's revenue is granted, not withheld — the branch filter is the query's job", () => {
    // docs/ADMIN-PANEL.md §7 reads "branch only" for a manager's dashboard, and
    // lib/auth/rbac.ts:76-78 says how that is done: the capability is granted
    // and the figure is filtered by branchId in the query. Withholding the
    // capability instead would show an admin a zero and call it revenue.
    expect(can("admin", "dashboard.revenue"), "an admin sees takings — their own branch's").toBe(true);
    expect(can("admin", "staff.performance"), "an admin reads the floor's timings").toBe(true);
  });

  it("admin is not god mode", () => {
    expect(can("admin", "settings.manage")).toBe(false);
    expect(can("admin", "audit.view")).toBe(false);
  });

  it("nobody without a role holds anything", () => {
    const every: Capability[] = [
      "dashboard.view", "dashboard.revenue", "bookings.view", "bookings.manage",
      "bookings.checkin", "bookings.reschedule", "bookings.status", "bookings.delete",
      "bookings.own", "availability.manage", "catalog.manage", "designs.manage",
      "media.manage", "customers.manage", "giftcards.issue", "giftcards.adjust",
      "staff.manage", "staff.performance", "branches.manage", "content.manage",
      "marketing.manage", "payments.view", "payments.refund", "settings.manage",
      "audit.view",
    ];
    for (const cap of every) {
      expect(can(null, cap), `a signed-out visitor cannot ${cap}`).toBe(false);
      expect(can(undefined, cap), `an unknown role cannot ${cap}`).toBe(false);
    }
  });
});

describe("cross-origin invocation", () => {
  // Phase 6.2 item 7. A Server Action invoked from another origin is refused by
  // the Next runtime's Origin/Host comparison, not by anything in these files —
  // so what a direct call can honestly prove is that the runtime doing it is a
  // patched one and that nothing has widened the allowlist.
  it("runs a Next release that carries the CVE-2025-29927 fix and the action origin check", async () => {
    const { dependencies } = await import("../../package.json");
    const [major, minor, patch] = dependencies.next.replace(/^\^|~/, "").split(".").map(Number);
    // Patched in 14.2.25 for the 14 line.
    expect(major, "the Server Action origin check landed in Next 14").toBeGreaterThanOrEqual(14);
    if (major === 14) {
      expect(minor * 1000 + patch, "next must be at or above 14.2.25 — CVE-2025-29927").toBeGreaterThanOrEqual(2 * 1000 + 25);
    }
  });

  it("next.config declares no serverActions.allowedOrigins wildcard", async () => {
    const { readFileSync } = await import("node:fs");
    const config = readFileSync("next.config.mjs", "utf-8");
    // Absent is correct: the default is same-origin only. A "*" here would hand
    // every action in the panel to any page on the internet.
    expect(config, "an allowedOrigins wildcard would defeat the CSRF check").not.toMatch(/allowedOrigins[\s\S]{0,80}\*/);
  });
});

describe("the login surface", () => {
  // app/(admin)/admin/actions.ts is the one file here with no requireCan, and
  // that is correct — it *is* the authentication. What it must not do is leak
  // which half of the credentials was wrong.
  it("reports one opaque failure, never which of email or password was wrong", async () => {
    const mod = await import("@/app/(admin)/admin/actions");
    expect(typeof mod.loginAction).toBe("function");
    expect(typeof mod.signOutAction).toBe("function");

    const src = (await import("node:fs")).readFileSync("app/(admin)/admin/actions.ts", "utf-8");
    // Two error strings and no third: "invalid" for bad credentials, "error"
    // for anything else. No user-enumeration channel.
    expect(src.match(/"invalid"|"error"/g)?.length ?? 0).toBeGreaterThan(0);
    expect(src, "the login action must not echo the submitted email back").not.toMatch(/error:.*formData/);
  });
});

// A guard against this file going stale: if someone adds an export to one of
// the twelve action files and not to ACTIONS above, the count moves and this
// fails. Better a red line here than an untested endpoint.
it("covers every exported Server Action in the twelve admin action files", async () => {
  const modules: Record<string, Record<string, unknown>> = {
    availability, bookings: bookingsActions, catalog, customers: customersActions,
    floor, "front-desk": frontDesk, "gift-cards": giftCardsActions, media: mediaActions,
    "my-day": myDay, "promo-codes": promoCodes, staff: staffActions,
  };

  const exported: string[] = [];
  for (const [file, mod] of Object.entries(modules)) {
    for (const [key, value] of Object.entries(mod)) {
      if (typeof value === "function") exported.push(`${file}.${key}`);
    }
  }

  const covered = new Set(ACTIONS.map((a) => a.name));
  const missing = exported.filter((n) => !covered.has(n));
  expect(missing, "every exported action needs a row in ACTIONS").toEqual([]);
});

// Nothing this file did should have survived it, beyond the fixtures.
it("created no row against the nonexistent id, whatever got past the guards", async () => {
  // Every action above is invoked against NOWHERE — a well-formed uuid that is
  // not a row. The ones a role *is* allowed to call therefore run their real
  // body against nothing, and must come back empty-handed rather than writing
  // an orphan. Foreign keys enforce most of it; this asserts they are actually
  // declared on the tables these actions reach for.
  //
  // Deliberately not asserted over audit_log: entity_id carries no foreign key
  // by design (it has to survive the row it describes being deleted), so
  // entries against NOWHERE legitimately exist here and are swept in afterAll.
  const orphans = await Promise.all([
    db.select({ id: stations.id }).from(stations).where(eq(stations.branchId, NOWHERE)),
    db.select({ id: branchHours.id }).from(branchHours).where(eq(branchHours.branchId, NOWHERE)),
    db.select({ id: bookings.id }).from(bookings).where(eq(bookings.branchId, NOWHERE)),
    db.select({ id: stations.id }).from(stations).where(eq(stations.id, NOWHERE)),
    db.select({ id: bookings.id }).from(bookings).where(eq(bookings.id, NOWHERE)),
  ]);
  expect(orphans.flat(), "an action wrote a row against an id that is not a row").toEqual([]);
});
