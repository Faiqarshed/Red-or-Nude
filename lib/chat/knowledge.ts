// Everything the chat assistant is allowed to know, as one block of text.
//
// There is no retrieval here and no vector store, because there is nothing to
// retrieve from: the whole corpus is a few dozen rows and fits in the prompt
// several times over. Embeddings would be a search engine built to search
// twenty FAQs. If this ever outgrows the context window, that is the day to
// reach for one — not before.
//
// The block is assembled from the same tables the public site reads, so the
// assistant cannot quote a price the booking page would disagree with. Only
// `active` rows: a service the salon switched off must not be sold by the bot.
//
// What is NOT here is the point of it. No customer rows, no bookings, no
// contact details, no notes. A customer's own booking reaches the model only
// through the tool in app/api/chat/route.ts, which is scoped to the session
// that asked. scripts/check-chat.ts asserts this block stays clean.

import "server-only";
import { asc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { addons, branchHours, branches, closures, faqs, removalTypes, services } from "@/lib/db/schema";
import { pick } from "@/lib/localized";
import { halalasToSar } from "@/lib/money";
import { closureDays } from "@/lib/time";
import type { Localized } from "@/lib/db/schema";
import type { Lang } from "@/lib/i18n";

/** weekday 0 = Saturday, matching branch_hours and the site's calendar. */
const DAYS = [
  "Saturday",
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
] as const;

export async function knowledgeBlock(lang: Lang): Promise<string> {
  const now = new Date();
  const [faqRows, serviceRows, addonRows, removalRows, branchRows, hourRows, closureRows] =
    await Promise.all([
      db.select().from(faqs).where(eq(faqs.active, true)).orderBy(asc(faqs.sort)),
      db.select().from(services).where(eq(services.active, true)).orderBy(asc(services.sort)),
      db.select().from(addons).where(eq(addons.active, true)).orderBy(asc(addons.sort)),
      db
        .select()
        .from(removalTypes)
        .where(eq(removalTypes.active, true))
        .orderBy(asc(removalTypes.sort)),
      db.select().from(branches).where(eq(branches.active, true)).orderBy(asc(branches.sort)),
      db.select().from(branchHours).orderBy(asc(branchHours.weekday)),
      db.select().from(closures).where(gte(closures.endsAt, now)).orderBy(asc(closures.startsAt)),
    ]);

  /** Add-ons and removals differ from a service only in what they are called. */
  const priced = (rows: { name: Localized; priceHalalas: number; durationMin: number }[]) =>
    rows
      .map(
        (r) =>
          `- ${pick(r.name, lang)} — ${halalasToSar(r.priceHalalas)} SAR` +
          (r.durationMin ? `, ${r.durationMin} min` : ""),
      )
      .join("\n");

  const sections: string[] = [];

  // Omitted rather than left as an empty heading: a bare "## FAQ" invites the
  // model to fill it in.
  if (faqRows.length) {
    sections.push(
      "## FAQ\n" +
        faqRows
          .map((r) => `Q: ${pick(r.question, lang)}\nA: ${pick(r.answer, lang)}`)
          .join("\n\n"),
    );
  }

  if (serviceRows.length) {
    sections.push(
      "## Services (price in SAR, duration in minutes)\n" +
        serviceRows
          .map((r) => {
            const refill = r.refillDays ? `, refillable within ${r.refillDays} days` : "";
            const desc = pick(r.description, lang);
            return (
              `- ${pick(r.name, lang)} — ${halalasToSar(r.priceHalalas)} SAR, ` +
              `${r.durationMin} min${refill}` +
              (desc ? `\n  ${desc}` : "")
            );
          })
          .join("\n"),
    );
  }

  // Priced exactly like a service, and asked about just as often: "how much is
  // removal?" used to get "I do not have that information" while the price sat
  // one table over. Designs stay out — they carry an image and no price, so
  // there is nothing a text answer can usefully say about one.
  if (addonRows.length) {
    sections.push("## Add-ons (can be added to any service)\n" + priced(addonRows));
  }

  if (removalRows.length) {
    sections.push("## Removal of existing nails\n" + priced(removalRows));
  }

  if (branchRows.length) {
    sections.push(
      "## Branches and opening hours\n" +
        branchRows
          .map((b) => {
            const head = `### ${pick(b.name, lang)}\nAddress: ${pick(b.address, lang)}${
              b.phone ? `\nPhone: ${b.phone}` : ""
            }`;
            const hours = hourRows
              .filter((h) => h.branchId === b.id)
              .map(
                (h) =>
                  `  ${DAYS[h.weekday] ?? `day ${h.weekday}`}: ` +
                  // `time` comes back as HH:MM:SS; the seconds are noise in a prompt.
                  (h.closed ? "closed" : `${h.opens.slice(0, 5)}–${h.closes.slice(0, 5)}`),
              )
              .join("\n");
            return hours ? `${head}\n${hours}` : `${head}\n  (hours not published)`;
          })
          .join("\n\n"),
    );
  }

  // Without this the assistant cheerfully says the salon is open on Eid.
  if (closureRows.length) {
    const byId = new Map(branchRows.map((b) => [b.id, pick(b.name, lang)]));
    sections.push(
      "## Upcoming closures\n" +
        closureRows
          .map((c) => {
            const where = c.branchId ? (byId.get(c.branchId) ?? "one branch") : "all branches";
            const reason = pick(c.reason, lang);
            // Riyadh days, not UTC ones. A closure the salon entered as 20–22
            // March is stored from 19 March 21:00 UTC, and an assistant reading
            // that back raw tells a customer the salon shuts on the 19th.
            const { from, to } = closureDays(c.startsAt, c.endsAt);
            return `- ${from} to ${to}, ${where}${reason ? `: ${reason}` : ""}`;
          })
          .join("\n"),
    );
  }

  return sections.join("\n\n");
}
