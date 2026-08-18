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
  "owner",
  "manager",
  "receptionist",
  "technician",
]);

export const bookingStatus = pgEnum("booking_status", [
  "pending",
  "confirmed",
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
export const stations = pgTable("stations", {
  id: uuid("id").primaryKey().defaultRandom(),
  branchId: uuid("branch_id")
    .notNull()
    .references(() => branches.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

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
    ...stamps,
  },
  (t) => ({ phoneUnique: unique("customers_phone_unique").on(t.phone) }),
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

    // Airline-style queue number ("K45") the salon calls out. Distinct from
    // `code`: that one is a permanent unique reference, this one restarts every
    // day per branch and is only meaningful on the day of the appointment.
    // Null until the booking is actually confirmed — an unpaid hold gets no number.
    ticketNo: text("ticket_no"),

    // Two guests booked together share one uuid. No booking_groups table: a group
    // holds no fact its members don't already carry, and the only query anyone
    // runs is "the other rows with this id".
    groupId: uuid("group_id"),

    // Snapshotted at booking time. Never joined live off the catalog — raising a
    // price must not rewrite last month's revenue.
    serviceName: localized("service_name"),
    servicePriceHalalas: integer("service_price_halalas").notNull().default(0),
    removalPriceHalalas: integer("removal_price_halalas").notNull().default(0),
    subtotalHalalas: integer("subtotal_halalas").notNull().default(0),
    discountHalalas: integer("discount_halalas").notNull().default(0),
    vatHalalas: integer("vat_halalas").notNull().default(0),
    totalHalalas: integer("total_halalas").notNull().default(0),

    promoCodeId: uuid("promo_code_id"),
    notes: text("notes"),
    cancelReason: text("cancel_reason"),
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
    byBranchTime: index("bookings_branch_time_idx").on(t.branchId, t.startsAt),
    byStatus: index("bookings_status_idx").on(t.status),
    byGroup: index("bookings_group_idx").on(t.groupId),
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

export const staffRelations = relations(staff, ({ one }) => ({
  branch: one(branches, { fields: [staff.branchId], references: [branches.id] }),
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
export type StaffRole = (typeof staffRole.enumValues)[number];
