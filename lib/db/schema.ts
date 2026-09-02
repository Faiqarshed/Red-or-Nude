// Database schema — see docs/ADMIN-PANEL.md §3.
//
// Money: every amount is an INTEGER count of halalas (1 SAR = 100 halalas).
// Postgres `numeric` would also be exact, but Drizzle hands it back as a string
// and every call site has to parse before it can do arithmetic. Integer minor
// units keep the maths in plain JS numbers and make VAT rounding explicit.
// Format for display with `formatSAR` in lib/money.ts — never with toFixed alone.
//
// Localized text is jsonb `{ ar, en }`, mirroring the Content shape in
// lib/dictionary.ts so the site's existing bilingual discipline carries over.

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  type AnyPgColumn,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type Localized = { ar: string; en: string };

/** jsonb column holding `{ ar, en }`. */
const localized = (name: string) => jsonb(name).$type<Localized>();

/** Every table gets these two; audit_log covers the "who". */
const stamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

// ---------------------------------------------------------------- enums -----

export const staffRole = pgEnum("staff_role", [
  "ceo",
  "admin",
  "receptionist",
  "technician",
]);

export const bookingStatus = pgEnum("booking_status", [
  "pending",
  "confirmed",
  // The customer is here and the receptionist has handed them to a technician,
  // who has not started yet. The gap between this and `in_progress` is the
  // salon's waiting time (brief §3.2).
  "checked_in",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
]);

export const bookingSource = pgEnum("booking_source", ["web", "walk_in", "phone"]);

export const paymentMethod = pgEnum("payment_method", ["card", "mada", "stc", "apple"]);

export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "paid",
  "failed",
  "refunded",
  "partially_refunded",
]);

export const giftCardStatus = pgEnum("gift_card_status", [
  "active",
  "redeemed",
  "expired",
  "cancelled",
]);

export const promoType = pgEnum("promo_type", ["percent", "fixed"]);

export const langEnum = pgEnum("lang", ["ar", "en"]);

// ------------------------------------------------------ identity & access ---

export const staff = pgTable(
  "staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    passwordHash: text("password_hash"),
    role: staffRole("role").notNull().default("receptionist"),
    // Managers/technicians are scoped to one branch; owners see everything.
    branchId: uuid("branch_id"),
    active: boolean("active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...stamps,
  },
  (t) => ({ emailUnique: unique("staff_email_unique").on(t.email) }),
);

/**
 * A staff member's days off (brief §3.3).
 *
 * Date-only, and a range rather than a single day: a day off is a day, not a
 * time range, and one row covers both a sick Tuesday and a fortnight away.
 * `ends_on` is inclusive — the same value in both columns is one day.
 *
 * Deliberately not `closures`, which is branch-wide and shuts the whole salon.
 * This is one person being elsewhere while the branch trades as normal.
 */
export const staffTimeOff = pgTable(
  "staff_time_off",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    reason: text("reason"),
    ...stamps,
  },
  (t) => ({ byStaff: index("staff_time_off_staff_idx").on(t.staffId, t.startsOn) }),
);

/** Append-only. Prices and bookings are money — every mutation writes a row. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => staff.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(), // denormalised: survives staff deletion
    action: text("action").notNull(), // create | update | delete | <domain verb>
    entity: text("entity").notNull(), // table name
    entityId: text("entity_id"),
    diff: jsonb("diff").$type<Record<string, { from: unknown; to: unknown }>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byEntity: index("audit_log_entity_idx").on(t.entity, t.entityId),
    byCreated: index("audit_log_created_idx").on(t.createdAt),
  }),
);

// --------------------------------------------------- locations & capacity ---

export const branches = pgTable("branches", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: localized("name").notNull(),
  address: localized("address").notNull(),
  hoursNote: localized("hours_note"), // the human-readable line shown on the site
  phone: text("phone"),
  lat: text("lat"),
  lng: text("lng"),
  mapImage: text("map_image"),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...stamps,
});

/** Weekly opening hours. weekday 0 = Saturday, matching the site's calendar. */
export const branchHours = pgTable(
  "branch_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    opens: time("opens").notNull(),
    closes: time("closes").notNull(),
    closed: boolean("closed").notNull().default(false),
  },
  (t) => ({ oneRowPerDay: unique("branch_hours_day_unique").on(t.branchId, t.weekday) }),
);

/** Chairs. Capacity for a time slot = count of active stations at the branch. */
export const stations = pgTable(
  "stations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    sort: integer("sort").notNull().default(0),
    active: boolean("active").notNull().default(true),
    /**
     * What the chair's QR sticker encodes: /station/<qr_token> (brief §2.7).
     *
     * Its own random value rather than the row id, because the sticker is
     * public — it sits on a table in the salon and anyone can photograph it.
     * Keeping the id out of it means a token cannot be used to address the
     * station anywhere else, and a compromised sticker is replaced by writing
     * one column.
     */
    qrToken: uuid("qr_token").notNull().defaultRandom(),
  },
  (t) => ({
    qrTokenUnique: unique("stations_qr_token_unique").on(t.qrToken),
  }),
);

/** Eid, Ramadan hours, maintenance. Null branch = all branches. */
export const closures = pgTable("closures", {
  id: uuid("id").primaryKey().defaultRandom(),
  branchId: uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  reason: localized("reason"),
  ...stamps,
});

// ------------------------------------------------------------- catalog ------

export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: localized("name").notNull(),
  description: localized("description"),
  priceHalalas: integer("price_halalas").notNull(),
  // New vs. the static site, which showed a flat "15 MIN" for everything.
  // Real durations are what make the availability engine work.
  durationMin: integer("duration_min").notNull().default(60),
  /**
   * How many days after the appointment this service can be refilled: 30 for
   * nails, 14 for lashes, 0 for services that have no refill at all.
   *
   * A column rather than a service category, because "does it have a refill and
   * for how long" is the only question anyone asks — a taxonomy would be a
   * second thing to keep in sync for no extra answer.
   */
  refillDays: integer("refill_days").notNull().default(0),
  image: text("image"),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...stamps,
});

export const addons = pgTable("addons", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: localized("name").notNull(),
  priceHalalas: integer("price_halalas").notNull(),
  durationMin: integer("duration_min").notNull().default(0),
  image: text("image"),
  // The seasonal add-on opens the designs pop-up on the public site.
  isSeasonal: boolean("is_seasonal").notNull().default(false),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...stamps,
});

export const removalTypes = pgTable("removal_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: localized("name").notNull(),
  priceHalalas: integer("price_halalas").notNull(),
  durationMin: integer("duration_min").notNull().default(0),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...stamps,
});

/** Which add-ons are offered with which service. Empty = offered with all. */
export const serviceAddons = pgTable(
  "service_addons",
  {
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    addonId: uuid("addon_id")
      .notNull()
      .references(() => addons.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.serviceId, t.addonId] }) }),
);

export const designCollections = pgTable("design_collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: localized("name").notNull(),
  activeFrom: date("active_from"),
  activeTo: date("active_to"),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...stamps,
});

export const designs = pgTable("designs", {
  id: uuid("id").primaryKey().defaultRandom(),
  collectionId: uuid("collection_id").references(() => designCollections.id, {
    onDelete: "set null",
  }),
  /**
   * The add-on whose picker shows this design.
   *
   * There is not one seasonal catalogue, there are as many as the salon cares to
   * sell — a winter set, a chrome set, an eid set — each its own add-on with its
   * own pictures. Before this the table had no owner at all and the pop-up
   * showed every design in the database whichever add-on opened it.
   *
   * Cascades: the pictures belong to the add-on, so removing it takes them.
   * Nullable for the rows that predate this, which stay visible until they are
   * given an owner.
   */
  addonId: uuid("addon_id").references(() => addons.id, { onDelete: "cascade" }),
  name: localized("name").notNull(),
  image: text("image"),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...stamps,
});

// --------------------------------------------------- customers & bookings ---

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    name: text("name"),
    email: text("email"),
    lang: langEnum("lang").notNull().default("ar"),
    notes: text("notes"),
    blocked: boolean("blocked").notNull().default(false),

    /**
     * Brief §2.8 — captured at signup, for birthday reminders and offers.
     * A `date` and not a timestamp: a birthday has no time and no timezone, and
     * storing one as an instant is how a Riyadh birthday lands on the 4th in
     * UTC and the reminder goes out a day early.
     */
    birthday: date("birthday"),

    /**
     * The account flag. Null means "we have an address for this person because
     * they typed one at checkout"; set means "they proved they own it by
     * reading a code we sent there", which is the only thing that lets them
     * sign in. There is no separate accounts table — an account *is* a customer
     * row with this stamped.
     */
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),

    ...stamps,
  },
  (t) => ({
    phoneUnique: unique("customers_phone_unique").on(t.phone),
    /**
     * Unique, but only over *verified* emails — deliberately partial.
     *
     * Checkout upserts on phone and writes whatever email was typed
     * (createBookings below), so the same address legitimately appears on two
     * rows when someone books twice from two numbers. A blanket unique index
     * would turn that into a constraint violation and fail the booking.
     *
     * Sign-in only ever resolves *verified* addresses, so uniqueness is only
     * needed there. `lower()` because an address is not case sensitive and
     * `Sara@` must not become a second account beside `sara@`.
     */
    accountEmailUnique: uniqueIndex("customers_account_email_unique")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.emailVerifiedAt} is not null`),
  }),
);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(), // short human reference, e.g. RON-4F2K
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    stationId: uuid("station_id").references(() => stations.id, { onDelete: "set null" }),
    technicianId: uuid("technician_id").references(() => staff.id, { onDelete: "set null" }),

    serviceId: uuid("service_id").references(() => services.id, { onDelete: "restrict" }),
    removalTypeId: uuid("removal_type_id").references(() => removalTypes.id, {
      onDelete: "set null",
    }),
    designId: uuid("design_id").references(() => designs.id, { onDelete: "set null" }),

    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),

    status: bookingStatus("status").notNull().default("pending"),
    source: bookingSource("source").notNull().default("web"),

    /**
     * The three moments the salon floor is measured by (brief §3.2).
     *
     * Stored as their own columns rather than read off `updated_at`, which moves
     * on every edit and would quietly corrupt a commission figure months later.
     *
     * `finished_at` is the technician saying they are done, which is *not* the
     * same as the ticket being closed — the receptionist does that, and the
     * status only reaches `completed` then. Keeping them apart means a slow
     * front desk never lands on the technician's number.
     */
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    /**
     * When the assigned technician was told about this booking.
     *
     * The dedupe marker for the reminder job, which runs every quarter hour and
     * would otherwise mail the same technician about the same customer four
     * times an hour. Check-in stamps it too, so a walk-in served before her slot
     * comes round never gets a second copy.
     */
    techNotifiedAt: timestamp("tech_notified_at", { withTimezone: true }),

    // Airline-style queue number ("K45") the salon calls out. Distinct from
    // `code`: that one is a permanent unique reference, this one restarts every
    // day per branch and is only meaningful on the day of the appointment.
    // Null until the booking is actually confirmed — an unpaid hold gets no number.
    ticketNo: text("ticket_no"),


    // Two guests booked together share one uuid. No booking_groups table: a group
    // holds no fact its members don't already carry, and the only query anyone
    // runs is "the other rows with this id".
    groupId: uuid("group_id"),

    /**
     * Who this booking was made for, as given at the time.
     *
     * Snapshotted for exactly the reason the prices below are. The customer row
     * is keyed on the phone number and its name is overwritten by every later
     * booking, so joining it live meant one person booking six times under six
     * names ended up with all six appointments — and August's — displaying
     * whichever name they typed last. History is not allowed to rewrite itself.
     *
     * Null on rows written before this column existed and on a walk-in nobody
     * named; readers fall back to the customer row, which is what they used to
     * read anyway.
     */
    customerName: text("customer_name"),

    // Snapshotted at booking time. Never joined live off the catalog — raising a
    // price must not rewrite last month's revenue.
    serviceName: localized("service_name"),
    servicePriceHalalas: integer("service_price_halalas").notNull().default(0),
    removalPriceHalalas: integer("removal_price_halalas").notNull().default(0),
    subtotalHalalas: integer("subtotal_halalas").notNull().default(0),
    /**
     * Everything taken off this guest's line: their share of the group discount
     * plus their share of any promo code, as one number.
     *
     * ponytail: the two are not stored separately, so "how much did promos cost
     * us" cannot be answered from this column alone — `promo_code_id` says only
     * that one was used. Split it into two columns when someone actually wants
     * that report.
     */
    discountHalalas: integer("discount_halalas").notNull().default(0),
    vatHalalas: integer("vat_halalas").notNull().default(0),
    totalHalalas: integer("total_halalas").notNull().default(0),

    /**
     * Set when this booking is the follow-up refill of an earlier one. Its
     * presence is also how we know that booking's window has been used up.
     */
    refillOfBookingId: uuid("refill_of_booking_id").references((): AnyPgColumn => bookings.id, {
      onDelete: "set null",
    }),

    /**
     * The discount code applied at checkout, if any (brief §2.10).
     *
     * `set null` rather than `restrict`: deleting a spent promo code must not be
     * blocked by the bookings that used it, and the amount is already recorded
     * in `discount_halalas` either way — which is the number that has to survive.
     */
    promoCodeId: uuid("promo_code_id").references((): AnyPgColumn => promoCodes.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    cancelReason: text("cancel_reason"),

    /**
     * When the sweep released this chair because nobody checked the customer in.
     *
     * Null means it was never auto-flagged — including a `no_show` a receptionist
     * set by hand, which needs no follow-up because someone was already dealing
     * with it. See sweepNoShows() in lib/bookings.ts.
     */
    noShowAt: timestamp("no_show_at", { withTimezone: true }),
    /** When staff cleared the flag. Null while it still needs someone. */
    noShowResolvedAt: timestamp("no_show_resolved_at", { withTimezone: true }),
    /**
     * Optional — whatever staff typed about what they did.
     *
     * Free text rather than a fixed list of outcomes on purpose: nobody knows yet
     * how a missed customer actually gets settled, and a dropdown guessed now is
     * a dropdown everyone sets to "Other". Once there are real notes to read, the
     * common answers become buttons and this column still holds them.
     */
    noShowNote: text("no_show_note"),
    ...stamps,
  },
  (t) => ({
    codeUnique: unique("bookings_code_unique").on(t.code),
    // Backstop against double-booking a chair. The real guarantee is the row lock
    // in reserveStations (lib/availability.ts); this catches anything that ever
    // bypasses it.
    //
    // Partial, because a cancelled or no-show booking frees its chair — the
    // availability engine has always treated it that way, and a plain unique
    // constraint did not, so cancelling a booking permanently burned that
    // chair-and-time for everyone else.
    slotUnique: uniqueIndex("bookings_station_slot_unique")
      .on(t.stationId, t.startsAt)
      .where(sql`${t.status} not in ('cancelled', 'no_show')`),
    // One refill per booking, decided by the database rather than by a read
    // that two concurrent requests could both pass. Partial for the same reason
    // as the slot index: a cancelled refill gives the window back.
    refillOnce: uniqueIndex("bookings_refill_of_unique")
      .on(t.refillOfBookingId)
      .where(sql`${t.status} not in ('cancelled', 'no_show')`),
    // The flag strip queries this on every admin bookings page load, and it is
    // looking for a handful of rows in a table of every booking ever made.
    // Partial, so the index only carries the ones still needing attention.
    unresolvedNoShow: index("bookings_unresolved_no_show_idx")
      .on(t.branchId, t.noShowAt)
      .where(sql`${t.noShowResolvedAt} is null`),
    byBranchTime: index("bookings_branch_time_idx").on(t.branchId, t.startsAt),
    byStatus: index("bookings_status_idx").on(t.status),
    byGroup: index("bookings_group_idx").on(t.groupId),
    // The two lookups the branch/time index cannot serve, because neither
    // starts from a branch: a technician's own day (/admin/my-day, the floor
    // board, the commission figures) and a customer's own history
    // (/my-bookings, the refill window). Both scan the whole table without
    // these, which is free today and is not once the salon has a year of
    // bookings behind it. See docs/PERFORMANCE.md.
    byTechnicianTime: index("bookings_technician_time_idx").on(t.technicianId, t.startsAt),
    byCustomer: index("bookings_customer_idx").on(t.customerId),
  }),
);

/**
 * Hands out the daily ticket numbers. One row per branch per service day; `next`
 * is the number the following booking will get.
 *
 * A counter table rather than `select max(ticket_no) + 1`, which is wrong under
 * READ COMMITTED — two concurrent transactions both read 44 and both become K44.
 * Incrementing this row takes a row lock, which serialises allocation, and asking
 * for N at once gives a group its consecutive pair in a single statement.
 *
 * The day is the day of the *appointment*, not of payment: someone booking three
 * weeks ahead must draw from that day's queue, or the salon's roll call is a
 * mixture of numbers issued on four different dates.
 */
export const ticketCounters = pgTable(
  "ticket_counters",
  {
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    next: integer("next").notNull().default(1),
  },
  (t) => ({ pk: primaryKey({ columns: [t.branchId, t.day] }) }),
);

/**
 * One-time codes, for two things that turn out to be the same thing.
 *
 * Originally `booking_otps`: opening a booking's private details at
 * /my-bookings, because the reference alone is a weak credential — it travels
 * in emails and gets forwarded — so anything beyond the booking's own summary
 * is gated behind a code emailed to the address on file.
 *
 * Signing in to an account (brief §2.8) needs the identical rules keyed to an
 * email instead, so the key was widened to a free-text `subject` rather than
 * copying security-critical code into a second table:
 *
 *   `booking:<uuid>`  — reference + inbox, for customers with no account
 *   `email:<address>` — the whole of the account sign-in
 *
 * `code_hash`, never the code: this row is what guards customer data, so a
 * database leak must not hand over live codes. Attempts are counted so a code
 * can be burned after a few wrong guesses rather than brute-forced — six digits
 * is only a million, and an unthrottled verify would walk it.
 *
 * Widening the key cost the old `booking_id` foreign key and its cascade
 * delete. Harmless: bookings are cancelled, never deleted, and a code is dead
 * ten minutes after it is issued either way.
 */
export const otps = pgTable(
  "otps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `booking:<uuid>` or `email:<address>`. Built by lib/otp.ts, never by hand. */
    subject: text("subject").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Set the moment it is used; a code is good for exactly one verification. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Every lookup is "the newest live code for this subject".
    bySubject: index("otps_subject_idx").on(t.subject, t.createdAt),
  }),
);

export const bookingAddons = pgTable(
  "booking_addons",
  {
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    addonId: uuid("addon_id").references(() => addons.id, { onDelete: "set null" }),
    name: localized("name"), // snapshot
    priceHalalas: integer("price_halalas").notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.bookingId, t.addonId] }) }),
);

/**
 * One row per finished appointment: the invitation, and the answer if it came
 * (brief §2.9). Written when a receptionist presses End on the ticket.
 *
 * The row exists from the moment the customer is *asked*, not from when they
 * reply — which is what makes `reviews_booking_unique` the thing that stops a
 * second email, and what makes a response rate computable at all.
 *
 * There is no `technician_id` here on purpose. Who served the appointment is
 * `bookings.technician_id`, resolved by a join when the reviews are read, so it
 * stays correct if the assignment is set or corrected after the fact. A snapshot
 * would freeze whatever was true the moment the customer happened to click.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    /**
     * What the emailed link carries.
     *
     * Its own random value rather than the booking code: that code travels in
     * forwarded email and is printed on the ticket, and this one opens a write.
     * Same reasoning as `stations.qr_token`.
     */
    token: uuid("token").notNull().defaultRandom(),
    /** 1–5. Null until the customer actually answers. */
    serviceRating: integer("service_rating"),
    /** 1–5, and skippable — some customers rate the service and not the person. */
    techRating: integer("tech_rating"),
    comment: text("comment"),
    invitedAt: timestamp("invited_at", { withTimezone: true }).defaultNow().notNull(),
    /** Null while unanswered; set once, and the form is read-only afterwards. */
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (t) => ({
    // One invitation per booking, decided by the database rather than by a read
    // that two concurrent End presses could both pass.
    oncePerBooking: unique("reviews_booking_unique").on(t.bookingId),
    tokenUnique: unique("reviews_token_unique").on(t.token),
  }),
);

// ------------------------------------------------------------ commerce ------

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
  giftCardId: uuid("gift_card_id"),
  provider: text("provider"), // moyasar | tap | manual
  providerRef: text("provider_ref"),
  method: paymentMethod("method"),
  amountHalalas: integer("amount_halalas").notNull(),
  status: paymentStatus("status").notNull().default("pending"),
  raw: jsonb("raw"),
  ...stamps,
});

export const refunds = pgTable("refunds", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id")
    .notNull()
    .references(() => payments.id, { onDelete: "cascade" }),
  amountHalalas: integer("amount_halalas").notNull(),
  reason: text("reason"),
  actorId: uuid("actor_id").references(() => staff.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const giftCardDesigns = pgTable("gift_card_designs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: localized("name").notNull(),
  image: text("image"),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...stamps,
});

export const giftCardValues = pgTable("gift_card_values", {
  id: uuid("id").primaryKey().defaultRandom(),
  amountHalalas: integer("amount_halalas").notNull(),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

export const giftCards = pgTable(
  "gift_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    designId: uuid("design_id").references(() => giftCardDesigns.id, { onDelete: "set null" }),
    initialHalalas: integer("initial_halalas").notNull(),
    balanceHalalas: integer("balance_halalas").notNull(),
    buyerName: text("buyer_name"),
    buyerEmail: text("buyer_email"),
    recipientName: text("recipient_name"),
    recipientEmail: text("recipient_email"),
    // The card is sent over WhatsApp, so a phone matters as much as an email.
    recipientPhone: text("recipient_phone"),
    message: text("message"),
    status: giftCardStatus("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...stamps,
  },
  (t) => ({ codeUnique: unique("gift_cards_code_unique").on(t.code) }),
);

/** Ledger. Balance is the running sum; never edit balance without a row here. */
export const giftCardTxns = pgTable("gift_card_txns", {
  id: uuid("id").primaryKey().defaultRandom(),
  giftCardId: uuid("gift_card_id")
    .notNull()
    .references(() => giftCards.id, { onDelete: "cascade" }),
  bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
  deltaHalalas: integer("delta_halalas").notNull(), // negative = redemption
  reason: text("reason"),
  actorId: uuid("actor_id").references(() => staff.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The loyalty wallet (brief §2.8). A ledger, like gift_card_txns above — but
 * deliberately *without* the running-balance column that table carries.
 *
 * The balance is a filtered SUM over these rows (lib/loyalty.ts), so it cannot
 * drift out of step with its own history, and more importantly so that points
 * come back on their own:
 *
 *   • a redemption row points at the booking it was spent on
 *   • the balance query ignores rows whose booking is cancelled, a no-show, or
 *     a hold that has sat unpaid past its window
 *
 * which means a cancellation, an abandoned checkout and a declined payment each
 * return the points with no compensating write anywhere. Every earn row is tied
 * to a booking too, so cancelling a paid booking revokes what it earned by the
 * same rule. If a new case appears, widen the filter — do not add a refund path.
 */
export const loyaltyTxns = pgTable(
  "loyalty_txns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /**
     * What this movement is attached to. Null only for movements that belong to
     * no booking at all; every earn and every redemption has one, and the
     * balance filter leans on it entirely.
     */
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    /** Negative is a redemption. Whole points — there are no fractional points. */
    deltaPoints: integer("delta_points").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The only query is "this customer's ledger". The join to bookings drives
    // through the bookings primary key, so booking_id needs no index of its own.
    byCustomer: index("loyalty_txns_customer_idx").on(t.customerId, t.createdAt),
  }),
);

export const promoCodes = pgTable(
  "promo_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    type: promoType("type").notNull().default("percent"),
    value: integer("value").notNull(), // percent points, or halalas when fixed
    minTotalHalalas: integer("min_total_halalas").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    active: boolean("active").notNull().default(true),
    /**
     * Set on the per-staff monthly codes of brief §3.3 — one code per employee,
     * ~90%, one use, renewed each month. Null on the ordinary occasion codes.
     *
     * A column rather than a table: a staff code *is* a promo code, with every
     * rule the engine already enforces (percent, max_uses, date window). The
     * only fact it adds is whose it is.
     */
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "cascade" }),
    ...stamps,
  },
  (t) => ({ codeUnique: unique("promo_codes_code_unique").on(t.code) }),
);

// ------------------------------------------------------------- content ------

/** dictionary.ts promoted to the DB. `key` mirrors a dictionary path. */
export const contentBlocks = pgTable(
  "content_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(), // "footer.aboutTitle", "hero.cards"
    value: jsonb("value").notNull(), // { ar, en } — string, or array/object per key
    note: text("note"), // editor hint: where this appears
    updatedBy: uuid("updated_by").references(() => staff.id, { onDelete: "set null" }),
    ...stamps,
  },
  (t) => ({ keyUnique: unique("content_blocks_key_unique").on(t.key) }),
);

/**
 * Two images, not one. The current carousel is baked artwork with Arabic text
 * burned in, so the English site shows عروض عيد الأضحى — the gap noted in
 * docs/SCREENS.md. Per-locale artwork closes it.
 */
export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: localized("title"),
  imageAr: text("image_ar"),
  imageEn: text("image_en"),
  href: text("href"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...stamps,
});

export const faqs = pgTable("faqs", {
  id: uuid("id").primaryKey().defaultRandom(),
  question: localized("question").notNull(),
  answer: localized("answer").notNull(),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...stamps,
});

export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(), // terms, privacy, careers
    title: localized("title").notNull(),
    body: localized("body").notNull(),
    published: boolean("published").notNull().default(false),
    ...stamps,
  },
  (t) => ({ slugUnique: unique("pages_slug_unique").on(t.slug) }),
);

export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    lang: langEnum("lang").notNull().default("ar"),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ emailUnique: unique("subscribers_email_unique").on(t.email) }),
);

export const media = pgTable("media", {
  id: uuid("id").primaryKey().defaultRandom(),
  path: text("path").notNull(),
  alt: localized("alt"),
  width: integer("width"),
  height: integer("height"),
  bytes: integer("bytes"),
  uploadedBy: uuid("uploaded_by").references(() => staff.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ------------------------------------------------------------ relations -----

export const branchRelations = relations(branches, ({ many }) => ({
  hours: many(branchHours),
  stations: many(stations),
  bookings: many(bookings),
}));

export const branchHoursRelations = relations(branchHours, ({ one }) => ({
  branch: one(branches, { fields: [branchHours.branchId], references: [branches.id] }),
}));

export const stationRelations = relations(stations, ({ one, many }) => ({
  branch: one(branches, { fields: [stations.branchId], references: [branches.id] }),
  bookings: many(bookings),
}));

export const staffRelations = relations(staff, ({ one, many }) => ({
  branch: one(branches, { fields: [staff.branchId], references: [branches.id] }),
  timeOff: many(staffTimeOff),
}));

export const staffTimeOffRelations = relations(staffTimeOff, ({ one }) => ({
  staff: one(staff, { fields: [staffTimeOff.staffId], references: [staff.id] }),
}));

export const bookingRelations = relations(bookings, ({ one, many }) => ({
  branch: one(branches, { fields: [bookings.branchId], references: [branches.id] }),
  customer: one(customers, { fields: [bookings.customerId], references: [customers.id] }),
  station: one(stations, { fields: [bookings.stationId], references: [stations.id] }),
  technician: one(staff, { fields: [bookings.technicianId], references: [staff.id] }),
  service: one(services, { fields: [bookings.serviceId], references: [services.id] }),
  removalType: one(removalTypes, {
    fields: [bookings.removalTypeId],
    references: [removalTypes.id],
  }),
  design: one(designs, { fields: [bookings.designId], references: [designs.id] }),
  addons: many(bookingAddons),
  payments: many(payments),
}));

export const bookingAddonRelations = relations(bookingAddons, ({ one }) => ({
  booking: one(bookings, { fields: [bookingAddons.bookingId], references: [bookings.id] }),
  addon: one(addons, { fields: [bookingAddons.addonId], references: [addons.id] }),
}));

export const customerRelations = relations(customers, ({ many }) => ({
  bookings: many(bookings),
}));

export const designRelations = relations(designs, ({ one }) => ({
  collection: one(designCollections, {
    fields: [designs.collectionId],
    references: [designCollections.id],
  }),
}));

export const giftCardRelations = relations(giftCards, ({ one, many }) => ({
  design: one(giftCardDesigns, {
    fields: [giftCards.designId],
    references: [giftCardDesigns.id],
  }),
  txns: many(giftCardTxns),
}));

export const paymentRelations = relations(payments, ({ one, many }) => ({
  booking: one(bookings, { fields: [payments.bookingId], references: [bookings.id] }),
  refunds: many(refunds),
}));

export type Staff = typeof staff.$inferSelect;
export type Branch = typeof branches.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Service = typeof services.$inferSelect;
export type StaffTimeOff = typeof staffTimeOff.$inferSelect;
export type StaffRole = (typeof staffRole.enumValues)[number];
