/**
 * The membership shelf, as the salon actually sells it.
 *
 *   npm run seed:memberships
 *
 * Replaces everything in `packs` with the list below. It exists because the
 * table filled up with fixture rows — 757 copies of "Expiry pack", left behind
 * by check scripts that used to run against a real database before
 * scripts/_test-db.ts closed that door — and a shelf nobody can read is the same
 * as no shelf at all.
 *
 * **This one writes to DATABASE_URL**, not to the test database, because a shelf
 * seeded into a throwaway is not a shelf. That makes it the one script under
 * scripts/ that can touch real data, so:
 *
 *   - it deletes `packs` and nothing else — no bookings, no customers, no money;
 *   - a purchase already made survives it. customer_packs.pack_id is
 *     `on delete set null`, and everything spending needs was snapshotted onto
 *     the purchase at the till (see lib/packs.ts buyPack), so deleting the shelf
 *     cannot take a credit off anybody;
 *   - it still refuses to run silently over a shelf people have bought from —
 *     pass `--yes` once you have read what it says.
 *
 * Prices are set below list on purpose and asserted to be: a membership that
 * saves nothing is one the admin screen already calls out as "not a saving", and
 * it is not worth a row.
 */

import { config } from "dotenv";

config({ path: ".env.local" });

import assert from "node:assert";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerPacks, packServices, packs, services } from "@/lib/db/schema";
import type { Localized } from "@/lib/db/schema";

type Line = { service: string; quantity: number };

type Membership = {
  name: Localized;
  description: Localized;
  /** What she pays, in riyals. Halalas are the column; this is the price list. */
  price: number;
  validDays: number;
  image: string;
  lines: Line[];
};

/**
 * The shelf. Services are named in English and looked up, so this list stays
 * readable and fails loudly rather than silently seeding an empty membership if
 * the catalogue is renamed.
 *
 * Windows are 90 days — three months, what the client asked for — except the
 * manicure one, which holds eight visits and needs the room to spend them.
 */
const SHELF: Membership[] = [
  {
    name: { ar: "عضوية الجل", en: "Gel Polish Membership" },
    description: {
      ar: "ست جلسات جل بوليش، تُستخدمين منها متى شئتِ خلال ثلاثة أشهر.",
      en: "Six gel polish visits, taken whenever you like across three months.",
    },
    price: 749,
    validDays: 90,
    image: "/service-nails.webp",
    lines: [{ service: "Gel Polish", quantity: 6 }],
  },
  {
    name: { ar: "عضوية المانيكير", en: "Manicure Membership" },
    description: {
      ar: "ثماني جلسات مانيكير كلاسيكي — للمواعيد المنتظمة كل أسبوعين.",
      en: "Eight classic manicures — built for a standing fortnightly visit.",
    },
    price: 599,
    validDays: 120,
    image: "/service-2.webp",
    lines: [{ service: "Classic Manicure", quantity: 8 }],
  },
  {
    name: { ar: "عضوية البيلد إن آ بوتل", en: "BIAB Membership" },
    description: {
      ar: "أربع جلسات بيلد إن آ بوتل، تكفي دورة نمو كاملة.",
      en: "Four BIAB visits — a full growth cycle, start to finish.",
    },
    price: 749,
    validDays: 90,
    image: "/service-3.webp",
    lines: [{ service: "BIAB", quantity: 4 }],
  },
  {
    name: { ar: "عضوية الأكريليك", en: "Acrylic Membership" },
    description: {
      ar: "أربع جلسات أكريليك كاملة خلال ثلاثة أشهر.",
      en: "Four full acrylic sets across three months.",
    },
    price: 949,
    validDays: 90,
    image: "/service-4.webp",
    lines: [{ service: "Acrylic", quantity: 4 }],
  },
  {
    name: { ar: "عضوية الرموش", en: "Lash Membership" },
    description: {
      ar: "ثلاث جلسات تركيب رموش — تركيبة وتعبئتان.",
      en: "Three lash appointments — a full set and two fills.",
    },
    price: 889,
    validDays: 90,
    image: "/service-1.webp",
    lines: [{ service: "Lash Extensions", quantity: 3 }],
  },
  {
    name: { ar: "العضوية المميزة", en: "Signature Membership" },
    description: {
      ar: "ثلاث جلسات جل بوليش ومانيكيران — للأظافر بين المواعيد الكبيرة.",
      en: "Three gel polish visits and two manicures, for the weeks in between.",
    },
    price: 529,
    validDays: 90,
    image: "/eid-offers.webp",
    lines: [
      { service: "Gel Polish", quantity: 3 },
      { service: "Classic Manicure", quantity: 2 },
    ],
  },
];

async function main() {
  const confirmed = process.argv.includes("--yes");

  // Every active service, by its English name. A membership naming one that does
  // not exist is a typo, and seeding it would produce a row the shelf renders as
  // an empty card — worse than the error.
  const catalogue = await db.select().from(services).where(eq(services.active, true));
  const bySlug = new Map(catalogue.map((s) => [(s.name as Localized).en, s]));

  for (const m of SHELF) {
    for (const line of m.lines) {
      assert.ok(
        bySlug.has(line.service),
        `no active service called "${line.service}" — run \`npm run db:seed\` first, ` +
          `or fix the name in this file. Catalogue: ${[...bySlug.keys()].join(", ")}`,
      );
    }

    // The whole reason a customer buys one. The admin screen says "this price is
    // not a saving" out loud, so a seeded row that earns that line is a bug.
    const list = m.lines.reduce(
      (sum, l) => sum + bySlug.get(l.service)!.priceHalalas * l.quantity,
      0,
    );
    assert.ok(
      m.price * 100 < list,
      `"${m.name.en}" costs ${m.price} SAR against a list price of ${list / 100} — that is not a membership`,
    );
  }

  const existing = await db.select({ id: packs.id }).from(packs);
  const sold = existing.length
    ? await db
        .select({ id: customerPacks.id })
        .from(customerPacks)
        .where(
          inArray(
            customerPacks.packId,
            existing.map((p) => p.id),
          ),
        )
    : [];

  if (sold.length && !confirmed) {
    console.error(
      [
        "",
        `  ${sold.length} purchase(s) were made from the shelf this would replace.`,
        "",
        "  Those purchases survive — customer_packs.pack_id is `on delete set null`",
        "  and the name, price and deadline were snapshotted at the till, so no",
        "  customer loses a credit. What is lost is the admin's link back to the",
        "  membership she bought.",
        "",
        "  Re-run with --yes if that is what you want.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  if (existing.length) {
    // pack_services goes with it on cascade; nothing else references packs.
    await db.delete(packs);
    console.log(`removed ${existing.length} old row(s) from the shelf`);
  }

  for (const [sort, m] of SHELF.entries()) {
    const [row] = await db
      .insert(packs)
      .values({
        name: m.name,
        description: m.description,
        priceHalalas: m.price * 100,
        validDays: m.validDays,
        image: m.image,
        sort,
        active: true,
      })
      .returning({ id: packs.id });

    await db.insert(packServices).values(
      m.lines.map((l) => ({
        packId: row.id,
        serviceId: bySlug.get(l.service)!.id,
        quantity: l.quantity,
      })),
    );

    const list = m.lines.reduce(
      (sum, l) => sum + bySlug.get(l.service)!.priceHalalas * l.quantity,
      0,
    );
    const uses = m.lines.reduce((sum, l) => sum + l.quantity, 0);
    console.log(
      `  ${m.name.en} — ${uses} uses, ${m.price} SAR ` +
        `(worth ${list / 100}, saves ${list / 100 - m.price}) · ${m.validDays} days`,
    );
  }

  console.log(`\nseeded ${SHELF.length} memberships`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
