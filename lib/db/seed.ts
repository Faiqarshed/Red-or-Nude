/**
 * Seed — imports everything the static site currently hardcodes so nothing is
 * lost when the DB becomes the source of truth. Safe to re-run: catalogue and
 * branch seeding is skipped once branches exist, and settings/content/owner are
 * upserted.
 *
 *   npm run db:seed
 */

import { config } from "dotenv";

config({ path: ".env.local" });

// The catalogue the static site used to hardcode in lib/booking.ts. It lives
// here now: once the database is the source of truth, this is import fixture
// data, not application code.
const SEED_SERVICES = [
  { name: "Acrylic", price: 280, img: "/service-nails.webp", durationMin: 90 },
  { name: "Classic Manicure", price: 90, img: "/service-nails.webp", durationMin: 45 },
  { name: "BIAB", price: 220, img: "/service-nails.webp", durationMin: 75 },
  { name: "Gel Polish", price: 150, img: "/service-nails.webp", durationMin: 60 },
];

const SEED_ADDONS = [
  { name: "Seasonal Catalogue", price: 50, img: "/addon-catalogue.webp", seasonal: true },
  { name: "Chrome", price: 50, img: "/addon-chrome.webp", seasonal: false },
  { name: "Cat eye", price: 50, img: "/addon-art.webp", seasonal: false },
  { name: "French Tip", price: 50, img: "/addon-art.webp", seasonal: false },
  { name: "Nail Art", price: 50, img: "/addon-catalogue.webp", seasonal: false },
];

const SEED_SERVICE_DESC = "SHAPING | BUFFING | CUTICLE CARE | SMOOTH GEL POLISH FINISH";

const SEED_DESIGN_IMGS = [
  "/addon-art.webp",
  "/addon-catalogue.webp",
  "/addon-chrome.webp",
  "/service-1.webp",
  "/service-2.webp",
  "/service-3.webp",
];

/** Flatten the dictionary into content_blocks rows: "footer.aboutTitle" → { ar, en }. */
function flattenContent(
  ar: Record<string, unknown>,
  en: Record<string, unknown>,
  prefix = "",
): { key: string; value: { ar: unknown; en: unknown } }[] {
  const out: { key: string; value: { ar: unknown; en: unknown } }[] = [];

  for (const [k, arValue] of Object.entries(ar)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const enValue = (en as Record<string, unknown>)?.[k];

    // Arrays and strings are leaves; plain objects recurse. Keeping arrays whole
    // means "hero.cards" edits as one repeatable block rather than 12 loose keys.
    if (arValue !== null && typeof arValue === "object" && !Array.isArray(arValue)) {
      out.push(
        ...flattenContent(
          arValue as Record<string, unknown>,
          (enValue ?? {}) as Record<string, unknown>,
          key,
        ),
      );
    } else {
      out.push({ key, value: { ar: arValue, en: enValue ?? arValue } });
    }
  }

  return out;
}

async function main() {
  const { hash } = await import("bcryptjs");
  const { eq, sql } = await import("drizzle-orm");
  const { db } = await import("./index");
  const s = await import("./schema");
  const { content } = await import("../dictionary");
  const { sarToHalalas } = await import("../money");

  console.log("→ settings");
  await db
    .insert(s.settings)
    .values([
      { key: "vat_percent", value: 15 },
      { key: "currency", value: "SAR" },
      { key: "timezone", value: "Asia/Riyadh" },
      { key: "slot_length_min", value: 30 }, // matches the site's 30-min grid
      { key: "booking_lead_time_min", value: 60 },
    ])
    .onConflictDoNothing();

  console.log("→ content blocks");
  const blocks = flattenContent(
    content.ar as unknown as Record<string, unknown>,
    content.en as unknown as Record<string, unknown>,
  );
  await db
    .insert(s.contentBlocks)
    .values(blocks.map((b) => ({ key: b.key, value: b.value })))
    .onConflictDoNothing();
  console.log(`   ${blocks.length} keys`);

  // ---- owner account -------------------------------------------------------
  const ownerEmail = (process.env.SEED_OWNER_EMAIL ?? "").toLowerCase().trim();
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? "";
  if (ownerEmail && ownerPassword.length >= 8) {
    console.log(`→ owner account (${ownerEmail})`);
    await db
      .insert(s.staff)
      .values({
        name: "Owner",
        email: ownerEmail,
        role: "owner",
        passwordHash: await hash(ownerPassword, 10),
      })
      .onConflictDoUpdate({
        target: s.staff.email,
        set: { passwordHash: await hash(ownerPassword, 10), role: "owner", active: true },
      });
  } else {
    console.log(
      "→ owner account SKIPPED — set SEED_OWNER_EMAIL and a SEED_OWNER_PASSWORD of 8+ chars in .env.local",
    );
  }

  // ---- media library -------------------------------------------------------
  // Register the images already committed under /public so the library isn't
  // empty on day one and the existing catalogue art is pickable. Their paths
  // keep the leading slash, which lib/storage treats as a pass-through.
  const [{ n: mediaCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.media);

  if (mediaCount === 0) {
    const { readdir, stat } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const IMAGE_EXT = /\.(webp|png|jpe?g|avif)$/i;
    const publicDir = join(process.cwd(), "public");
    const found: { path: string; bytes: number }[] = [];

    async function walk(dir: string, prefix: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "fonts" || entry.name === "uploads") continue;
          await walk(full, rel);
        } else if (IMAGE_EXT.test(entry.name)) {
          found.push({ path: rel, bytes: (await stat(full)).size });
        }
      }
    }

    await walk(publicDir, "");
    if (found.length > 0) {
      await db.insert(s.media).values(found);
    }
    console.log(`→ media library (${found.length} existing images registered)`);
  } else {
    console.log("→ media library already populated, skipping");
  }

  // ---- one-time domain data ------------------------------------------------
  const [{ n: branchCount }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.branches);

  if (branchCount > 0) {
    console.log("→ branches already seeded, skipping catalogue");
    console.log("✓ seed complete");
    return;
  }

  console.log("→ branches, hours, stations");
  const branchRows = await db
    .insert(s.branches)
    .values(
      content.ar.branch.list.map((b, i) => ({
        name: { ar: b.name, en: content.en.branch.list[i]?.name ?? b.name },
        address: { ar: b.address, en: content.en.branch.list[i]?.address ?? b.address },
        hoursNote: { ar: b.hours, en: content.en.branch.list[i]?.hours ?? b.hours },
        sort: i,
      })),
    )
    .returning({ id: s.branches.id });

  for (const branch of branchRows) {
    // 9 AM – 11 PM every day, per the hours line shown on the site.
    await db.insert(s.branchHours).values(
      Array.from({ length: 7 }, (_, weekday) => ({
        branchId: branch.id,
        weekday,
        opens: "09:00:00",
        closes: "23:00:00",
      })),
    );
    await db.insert(s.stations).values(
      Array.from({ length: 4 }, (_, i) => ({
        branchId: branch.id,
        label: `${i + 1}`,
        sort: i,
      })),
    );
  }

  console.log("→ services");
  // The static site showed a flat "15 MIN" on every card, which can't be right
  // across Acrylic and a Classic Manicure. These are realistic starting values —
  // the salon adjusts them in Catalog, and the availability engine uses them.
  await db.insert(s.services).values(
    SEED_SERVICES.map((svc, i) => ({
      // Service names existed only in English in the old code — the same string
      // rendered on the Arabic site. Seeded into both locales so nothing breaks;
      // the Catalog screen flags them for translation.
      name: { ar: svc.name, en: svc.name },
      description: { ar: SEED_SERVICE_DESC, en: SEED_SERVICE_DESC },
      priceHalalas: sarToHalalas(svc.price),
      durationMin: svc.durationMin,
      image: svc.img,
      sort: i,
    })),
  );

  console.log("→ add-ons");
  await db.insert(s.addons).values(
    SEED_ADDONS.map((a, i) => ({
      name: { ar: a.name, en: a.name },
      priceHalalas: sarToHalalas(a.price),
      durationMin: 15,
      image: a.img,
      isSeasonal: a.seasonal,
      sort: i,
    })),
  );

  console.log("→ removal types");
  await db.insert(s.removalTypes).values(
    content.ar.removals.map((r, i) => ({
      name: { ar: r.name, en: content.en.removals[i]?.name ?? r.name },
      priceHalalas: sarToHalalas(r.price),
      durationMin: 15,
      sort: i,
    })),
  );

  console.log("→ seasonal designs");
  const [collection] = await db
    .insert(s.designCollections)
    .values({ name: { ar: "التصاميم الموسمية", en: "Seasonal Designs" }, sort: 0 })
    .returning({ id: s.designCollections.id });

  await db.insert(s.designs).values(
    Array.from({ length: 12 }, (_, i) => ({
      collectionId: collection.id,
      name: { ar: `Art ${i + 1}`, en: `Art ${i + 1}` },
      image: SEED_DESIGN_IMGS[i % SEED_DESIGN_IMGS.length],
      sort: i,
    })),
  );

  console.log("→ gift cards");
  await db.insert(s.giftCardValues).values(
    [600, 500, 400, 300, 250, 150].map((amount, i) => ({
      amountHalalas: sarToHalalas(amount),
      sort: i,
    })),
  );
  await db.insert(s.giftCardDesigns).values([
    { name: { ar: "أحمر", en: "Red card" }, image: "/gift/design-red.webp", sort: 0 },
    { name: { ar: "تهانينا", en: "Congratulations" }, image: "/gift/design-congrats.webp", sort: 1 },
    { name: { ar: "عيد ميلاد", en: "Happy Birthday" }, image: "/gift/design-birthday.webp", sort: 2 },
    {
      name: { ar: "ذكرى سنوية", en: "Happy Anniversary" },
      image: "/gift/design-anniversary.webp",
      sort: 3,
    },
  ]);

  console.log("✓ seed complete");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
