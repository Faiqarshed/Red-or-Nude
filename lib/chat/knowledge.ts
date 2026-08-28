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
import { branchHours, branches, closures, faqs, services } from "@/lib/db/schema";
import { pick } from "@/lib/localized";
import { halalasToSar } from "@/lib/money";
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

/**
 * ponytail: cached per server instance, not shared, and rebuilt on cold start —
 * the same ceiling lib/throttle.ts documents. Five minutes is well inside how
 * often a salon edits its price list, and it saves four queries on every
 * message including the second half of a tool round trip. Move it to a shared
 * cache only if instance count ever makes the staleness visible.
 */
const CACHE = new Map<Lang, { text: string; at: number }>();
const TTL_MS = 5 * 60_000;

export async function knowledgeBlock(lang: Lang): Promise<string> {
  const hit = CACHE.get(lang);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;

  const now = new Date();
  const [faqRows, serviceRows, branchRows, hourRows, closureRows] = await Promise.all([
    db.select().from(faqs).where(eq(faqs.active, true)).orderBy(asc(faqs.sort)),
    db.select().from(services).where(eq(services.active, true)).orderBy(asc(services.sort)),
    db.select().from(branches).where(eq(branches.active, true)).orderBy(asc(branches.sort)),
    db.select().from(branchHours).orderBy(asc(branchHours.weekday)),
    db.select().from(closures).where(gte(closures.endsAt, now)).orderBy(asc(closures.startsAt)),
  ]);

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
            return (
              `- ${c.startsAt.toISOString().slice(0, 10)} to ` +
              `${c.endsAt.toISOString().slice(0, 10)}, ${where}${reason ? `: ${reason}` : ""}`
            );
          })
          .join("\n"),
    );
  }

  const text = sections.join("\n\n");
  CACHE.set(lang, { text, at: Date.now() });
  return text;
}
