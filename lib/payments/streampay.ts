import "server-only";

// StreamPay (docs/PAYMENTS-STREAMPAY.md). Everything that talks to their API
// lives in this one file: the catalogue mirror, the coupons, the customer
// record, the driver, and the webhook signature check.
//
// The rule the whole integration rests on: **we price, StreamPay collects.**
// Every discount is worked out by our own engine (lib/bookings.ts) and sent as
// a fixed amount, so the checkout can only ever show the number our screen
// showed. charge() checks that before handing the link back, and refuses if not.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, like, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { streampayIds } from "@/lib/db/schema";
import { toNationalDigits } from "@/lib/phone";
import { alertOwner } from "./alert";
import type { Discount, GatewayPayment, Line, Payer, PaymentDriver, PaymentMethod, Verdict } from "./index";

// ---------------------------------------------------------------- transport --

export function base(): string {
  return (process.env.STREAMPAY_BASE_URL?.trim() || "https://stream-app-service.streampay.sa").replace(
    /\/+$/,
    "",
  );
}

/** `x-api-key` is base64("key:secret"), per their authentication guide. */
function apiKey(): string {
  const key = process.env.STREAMPAY_API_KEY?.trim();
  const secret = process.env.STREAMPAY_API_SECRET?.trim();
  if (!key || !secret) throw new Error("[streampay] STREAMPAY_API_KEY / STREAMPAY_API_SECRET are not set");
  return Buffer.from(`${key}:${secret}`).toString("base64");
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${base()}/api/v2${path}`, {
      method,
      headers: { "x-api-key": apiKey(), "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      // Short: a checkout makes several calls in a row, and a server killed
      // halfway through them leaves her stuck on "in progress".
      signal: AbortSignal.timeout(10_000),
    });
    text = await res.text();
  } catch (err) {
    noteFailure();
    throw err;
  }
  if (res.status >= 500) noteFailure();
  else noteSuccess();
  // STREAMPAY_DEBUG=1 prints every call both ways. Never in production: bodies
  // carry the customer's name, phone and email.
  if (process.env.STREAMPAY_DEBUG === "1" && process.env.NODE_ENV !== "production") {
    console.log(`[streampay:debug] ${method} ${path}`, body === undefined ? "" : JSON.stringify(body, null, 2));
    console.log(`[streampay:debug] ← ${res.status}`, text.slice(0, 4000));
  }
  if (!res.ok) throw new StreamPayError(`[streampay] ${method} ${path} → ${res.status}: ${text.slice(0, 600)}`, res.status);
  return (text ? JSON.parse(text) : {}) as T;
}

/** StreamPay answered, with an error. `status` says whose: 4xx ours, 5xx theirs. */
class StreamPayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * StreamPay not answering, counted across calls. Five in a row tell the owner
 * once, and the first answer after that says it is back — so the front desk
 * knows why paid customers are waiting, instead of finding out from them.
 * ponytail: per server instance.
 */
let failures = 0;

function noteFailure() {
  if (++failures === 5) {
    void alertOwner(
      "streampay-down",
      "StreamPay is not answering",
      "Five calls to StreamPay in a row failed. Payments are still taken, and each is confirmed once StreamPay answers again. Customers are told not to pay twice.",
    );
  }
}

function noteSuccess() {
  if (failures >= 5) void alertOwner("streampay-back", "StreamPay is answering again", "Waiting payments are being confirmed.");
  failures = 0;
}

/** How much of a payment has gone back, however it was refunded (us, or their dashboard). */
async function refundedSoFar(paymentId: string): Promise<number> {
  const p = await api<{ amount_refunded?: string | null }>("GET", `/payments/${paymentId}`);
  return Math.round(Number(p.amount_refunded ?? 0) * 100);
}

/** 12345 halalas → "123.45". Their amounts are decimal SAR strings. */
const sar = (halalas: number) => (halalas / 100).toFixed(2);

// ------------------------------------------------------------ id lookup table --

/**
 * Ids belong to one StreamPay account. Keyed by it, a database moved from
 * sandbox to live keys (or to another account) recreates its products instead
 * of sending checkouts to ids the new account has never seen.
 *
 * The key alone, not the secret: rotating the secret is the same account, and
 * must not orphan every product and customer we already made there.
 */
const scoped = (key: string) => {
  const account = process.env.STREAMPAY_API_KEY?.trim();
  if (!account) throw new Error("[streampay] STREAMPAY_API_KEY is not set");
  return `${createHash("sha256").update(account).digest("hex").slice(0, 8)}:${key}`;
};

async function lookup(key: string) {
  const [row] = await db.select().from(streampayIds).where(eq(streampayIds.key, scoped(key))).limit(1);
  return row ?? null;
}

/**
 * Record a StreamPay id under our key. Two checkouts creating the same coupon
 * at the same moment both succeed at StreamPay; the first insert wins here and
 * the loser's object is left unused, which costs nothing.
 */
async function remember(key: string, streampayId: string, priceId: string | null, signature: string | null) {
  await db.insert(streampayIds).values({ key: scoped(key), streampayId, priceId, signature }).onConflictDoNothing();
  return (await lookup(key))!.streampayId;
}

/**
 * After StreamPay refused a checkout: which of the ids it used no longer work
 * there? A product, coupon or customer deleted in their dashboard (404), or a
 * product or coupon switched off (`is_active: false`). Those are forgotten, so
 * the next use makes them again, and true is returned. Asked of StreamPay
 * rather than read from the refusal, whose wording their docs do not give.
 * An id it cannot answer about is left alone.
 */
async function forgetBroken(used: { key: string; path: string }[]): Promise<boolean> {
  let forgot = false;
  for (const { key, path } of used) {
    const have = await lookup(key);
    if (!have) continue;
    let gone: boolean;
    try {
      gone = (await api<{ is_active?: boolean }>("GET", `/${path}/${have.streampayId}`)).is_active === false;
    } catch (err) {
      if (!(err instanceof StreamPayError && err.status === 404)) continue;
      gone = true;
    }
    if (!gone) continue;
    console.error(`[streampay] ${key} (${have.streampayId}) no longer works at StreamPay; making it again`);
    await db.delete(streampayIds).where(eq(streampayIds.key, scoped(key)));
    forgot = true;
  }
  return forgot;
}

// ------------------------------------------------------------------ products --

type ProductDto = { id: string; prices?: { id: string; is_active: boolean }[] };

type ProductVersion = { name: string; priceHalalas: number; vatExempt?: boolean };

/**
 * How long a replaced or switched-off product stays payable before it is
 * archived: longer than any checkout already open on it (a hold, then its pay
 * window). Archiving never touches an invoice already issued for it.
 */
export const RETIRE_AFTER_MIN = 60;

const signatureOf = (p: ProductVersion) => JSON.stringify([p.name.slice(0, 160), p.priceHalalas, Boolean(p.vatExempt)]);

/**
 * One StreamPay product per version of an item — its name, price and VAT flag.
 *
 * A payment link names a product, not a price, so changing a product under a
 * link that is still open changes what she is charged, and StreamPay refuses
 * to change a product already on an issued invoice anyway. So a product is never
 * edited: a new version is a new product, and the old one is archived after
 * RETIRE_AFTER_MIN. Each tax invoice keeps the name and price she paid.
 */
const versionKey = (key: string, p: ProductVersion) =>
  `${key}@${createHash("sha256").update(signatureOf(p)).digest("hex").slice(0, 12)}`;

/**
 * StreamPay's product for this version of one of our catalogue items, made the
 * first time it is needed. Called for every line at checkout, and when the
 * admin saves an item (best effort), so nothing has to be synced by hand.
 */
export async function syncProduct(key: string, p: ProductVersion): Promise<string> {
  const vkey = versionKey(key, p);
  const have = await lookup(vkey);
  if (have) return have.streampayId;

  // is_price_inclusive_of_vat is deprecated but still defaults to true, and
  // StreamPay refuses an exempt price that is also "inclusive" (422).
  const exempt = Boolean(p.vatExempt);
  const made = await api<ProductDto>("POST", "/products", {
    name: p.name.slice(0, 160),
    type: "ONE_OFF",
    prices: [{ currency: "SAR", amount: sar(p.priceHalalas), is_price_exempt_from_vat: exempt, is_price_inclusive_of_vat: !exempt }],
    is_price_exempt_from_vat: exempt,
  });
  const priceId = made.prices?.find((x) => x.is_active)?.id ?? made.prices?.[0]?.id ?? null;
  const id = await remember(vkey, made.id, priceId, signatureOf(p));
  // Two checkouts made the same version at once and the other was recorded:
  // this one is unused, and archived like any replaced product.
  if (id !== made.id) await retireLater(made.id);
  return id;
}

/** Archive this product once RETIRE_AFTER_MIN has passed (archiveRetiredProducts). */
async function retireLater(productId: string): Promise<void> {
  await db.insert(streampayIds).values({ key: scoped(`retire:${productId}`), streampayId: productId }).onConflictDoNothing();
}

/** Every version of an item we hold a product for, but `keep`. Old keys (no version) included. */
async function versionsOf(key: string, keep: string | null) {
  const rows = await db
    .select()
    .from(streampayIds)
    .where(or(eq(streampayIds.key, scoped(key)), like(streampayIds.key, `${scoped(key)}@%`)));
  return rows.filter((r) => !keep || r.key !== scoped(keep));
}

/**
 * The item was switched off or deleted: new checkouts already refuse it, and
 * its products are archived after RETIRE_AFTER_MIN, so a checkout already open
 * can still be paid. Never throws: an admin action must not fail over this.
 */
export async function retireProduct(key: string): Promise<void> {
  if (process.env.PAYMENT_DRIVER !== "streampay") return;
  try {
    for (const r of await versionsOf(key, null)) await retireLater(r.streampayId);
  } catch (err) {
    console.error(`[streampay] could not schedule ${key} for archiving`, err);
  }
}

/**
 * The admin-side hook, on every save. Versions other than the one just saved
 * are retired, the saved one is made (or kept, if it was about to be archived
 * after being switched off), and StreamPay being down never fails a save:
 * checkout makes a missing product on first use.
 */
export async function syncProductQuietly(
  key: string,
  p: { name: string; priceHalalas: number; active: boolean },
): Promise<void> {
  if (process.env.PAYMENT_DRIVER !== "streampay") return;
  try {
    // A zero-priced item never reaches a payment link (products must be ≥ 1 SAR).
    const keep = p.active && p.priceHalalas > 0 ? versionKey(key, p) : null;
    for (const r of await versionsOf(key, keep)) await retireLater(r.streampayId);
    if (!keep) return;
    const current = await lookup(keep);
    if (current) await db.delete(streampayIds).where(eq(streampayIds.key, scoped(`retire:${current.streampayId}`)));
    await syncProduct(key, p);
  } catch (err) {
    console.error(`[streampay] could not sync ${key}; checkout will retry`, err);
  }
}

/**
 * Archive the products retired over RETIRE_AFTER_MIN ago, from the settle job.
 * Archived, not deleted: past invoices still name them. Its rows go too, so the
 * item switched on again later gets a fresh product. StreamPay not answering
 * leaves it for the next run; a product it refuses to archive is left active
 * and unused, which costs nothing.
 */
export async function archiveRetiredProducts(): Promise<number> {
  if (process.env.PAYMENT_DRIVER !== "streampay") return 0;
  const due = await db
    .select()
    .from(streampayIds)
    .where(
      and(
        like(streampayIds.key, `${scoped("retire:")}%`),
        lt(streampayIds.createdAt, new Date(Date.now() - RETIRE_AFTER_MIN * 60_000)),
      ),
    )
    .limit(50);
  let archived = 0;
  for (const r of due) {
    try {
      await api("PUT", `/products/${r.streampayId}`, { is_active: false });
      archived++;
    } catch (err) {
      if (!(err instanceof StreamPayError) || err.status >= 500) {
        console.error(`[streampay] could not archive product ${r.streampayId}; next run`, err);
        continue;
      }
      if (err.status !== 404) console.error(`[streampay] StreamPay refused to archive product ${r.streampayId}; left as it is`, err);
    }
    await db.delete(streampayIds).where(eq(streampayIds.streampayId, r.streampayId));
  }
  return archived;
}

// ------------------------------------------------------------------- coupons --

/**
 * A fixed amount off, named for where it came from. Created the first time
 * this exact label and amount is seen, then reused forever — so after the
 * first few weeks most checkouts create nothing new.
 */
const couponKey = (d: Discount) => `coupon:${d.label}:${d.halalas}`;

async function ensureCoupon(d: Discount): Promise<string> {
  const key = couponKey(d);
  const have = await lookup(key);
  if (have) return have.streampayId;
  const made = await api<{ id: string }>("POST", "/coupons", {
    name: `${d.label} −${sar(d.halalas)}`.slice(0, 80),
    discount_value: sar(d.halalas),
    currency: "SAR",
    is_percentage: false,
    is_active: true,
  });
  return remember(key, made.id, null, null);
}

// ----------------------------------------------------------------- customers --

/**
 * Her StreamPay customer record, so the checkout does not ask for her details
 * again and the invoice is addressed to her. Keyed by phone, else email.
 *
 * Null when there is nothing to key on or StreamPay refuses (say, the number is
 * already a customer they hold under another record) — the link then collects
 * her details itself, which is a worse form and not a failed payment.
 */
function consumerKey(payer: Payer): string | null {
  const phone = payer.phone ? `+966${toNationalDigits(payer.phone)}` : null;
  const email = payer.email?.trim().toLowerCase() || null;
  return phone ? `consumer:${phone}` : email ? `consumer:${email}` : null;
}

async function ensureConsumer(payer: Payer): Promise<string | null> {
  const key = consumerKey(payer);
  if (!key) return null;
  const phone = payer.phone ? `+966${toNationalDigits(payer.phone)}` : null;
  const email = payer.email?.trim().toLowerCase() || null;

  const have = await lookup(key);
  if (have) return have.streampayId;
  try {
    const made = await api<{ id: string }>("POST", "/consumers", {
      name: payer.name?.trim() || phone || email,
      phone_number: phone ?? undefined,
      email: email ?? undefined,
      external_id: payer.customerId ?? undefined,
    });
    return remember(key, made.id, null, null);
  } catch (err) {
    console.error(`[streampay] could not create consumer ${key}; checkout will ask for details`, err);
    return null;
  }
}

// -------------------------------------------------------------------- driver --

type PaymentLink = {
  id: string;
  url: string;
  status: "INACTIVE" | "ACTIVE" | "COMPLETED";
  valid_until?: string | null;
  amount_in_smallest_unit: number;
};

type StreamPayment = {
  id: string;
  current_status: string;
  payment_method?: string | null;
  amount_in_smallest_unit: number;
};

/** What our `payments.raw` holds while a checkout is open. */
type Pending = { linkId: string; url: string; expiresAt?: string };

const METHOD: Record<string, PaymentMethod> = { MADA: "mada", APPLE_PAY: "apple" };

/**
 * Every payment status StreamPay has (`PaymentStatusEnum` in their OpenAPI
 * spec), sorted by what it means for us. Anything else is new to us and is
 * treated as still processing, with an alert, never as failed: a payment we
 * wrongly write off is money taken with nothing given for it.
 *
 * Fully refunded counts as over: confirming a booking the money has already
 * gone back for would be giving it away. Partly refunded still counts as paid —
 * our own refunds are always whole, so a partial one was a goodwill credit
 * from their dashboard, and failing the booking over it would keep the rest of
 * her money for nothing.
 */
const PAID = ["SUCCEEDED", "SETTLED", "PARTIALLY_REFUNDED"];
const WAITING = ["PENDING", "PROCESSING", "UNDER_REVIEW"];
const OVER = ["FAILED", "FAILED_INITIATION", "CANCELED", "EXPIRED", "REFUNDED"];

/**
 * Same product twice (two guests, same service) is one item with a quantity.
 * A key at two different prices would make that quantity a lie, so it throws.
 */
function itemsOf(lines: Line[]): Line[] {
  const byKey = new Map<string, Line>();
  for (const l of lines) {
    if (l.priceHalalas <= 0 || l.qty <= 0) continue;
    const had = byKey.get(l.key);
    if (had && had.priceHalalas !== l.priceHalalas) {
      throw new Error(`[streampay] ${l.key} appears at two prices in one checkout`);
    }
    byKey.set(l.key, had ? { ...had, qty: had.qty + l.qty } : { ...l });
  }
  return [...byKey.values()];
}

export const streampayDriver: PaymentDriver = {
  name: "streampay",

  async charge(input) {
    const items = itemsOf(input.lines);
    const discounts = input.discounts.filter((d) => d.halalas > 0);

    // Our own arithmetic first: a builder bug should never reach a customer.
    const gross = items.reduce((s, l) => s + l.priceHalalas * l.qty, 0);
    const off = discounts.reduce((s, d) => s + d.halalas, 0);
    if (gross - off !== input.amountHalalas) {
      throw new Error(
        `[streampay] ${input.ref}: lines ${gross} − discounts ${off} ≠ total ${input.amountHalalas}`,
      );
    }

    const createLink = async () => {
      // Sequential, not Promise.all: small counts, and it keeps the StreamPay
      // rate limit and the lookup table's first-insert-wins out of each other's way.
      const linkItems: { product_id: string; quantity: number }[] = [];
      for (const l of items) linkItems.push({ product_id: await syncProduct(l.key, l), quantity: l.qty });
      const coupons: string[] = [];
      for (const d of discounts) coupons.push(await ensureCoupon(d));
      const consumer = await ensureConsumer(input.payer);

      return api<PaymentLink>("POST", "/payment_links", {
        name: input.title.slice(0, 512),
        currency: "SAR",
        items: linkItems,
        coupons,
        max_number_of_payments: 1,
        valid_until: input.expiresAt.toISOString(),
        success_redirect_url: input.returnUrl,
        failure_redirect_url: input.returnUrl,
        ...(consumer ? { organization_consumer_id: consumer } : { contact_information_type: "PHONE" }),
        custom_metadata: { ref: input.ref },
      });
    };

    let link: PaymentLink;
    try {
      link = await createLink();
    } catch (err) {
      // Refused (4xx): maybe for an id of ours that no longer works there. Once,
      // with those forgotten and made again; anything else is a real refusal.
      const used = [
        ...items.map((l) => ({ key: versionKey(l.key, l), path: "products" })),
        ...discounts.map((d) => ({ key: couponKey(d), path: "coupons" })),
        ...[consumerKey(input.payer)].filter((k): k is string => k !== null).map((key) => ({ key, path: "consumers" })),
      ];
      if (!(err instanceof StreamPayError) || err.status >= 500 || !(await forgetBroken(used))) throw err;
      link = await createLink();
    }

    // The safety check the whole design is built around: StreamPay's total must
    // be ours to the halala, or nobody pays on this link.
    if (link.amount_in_smallest_unit !== input.amountHalalas) {
      await streampayDriver.cancel({ linkId: link.id, url: link.url } satisfies Pending);
      throw new Error(
        `[streampay] ${input.ref}: link ${link.id} totals ${link.amount_in_smallest_unit}, we charge ${input.amountHalalas}`,
      );
    }

    return {
      status: "pending",
      checkoutUrl: link.url,
      raw: { linkId: link.id, url: link.url, expiresAt: input.expiresAt.toISOString() } satisfies Pending,
    };
  },

  async verify(raw): Promise<Verdict> {
    const { linkId } = (raw ?? {}) as Partial<Pending>;
    if (!linkId) return { status: "failed" };

    const invoices = await api<{ data: { id: string; payments?: StreamPayment[] | null }[] }>(
      "GET",
      `/invoices?payment_link_id=${encodeURIComponent(linkId)}&include_payments=true`,
    );
    const all = invoices.data.flatMap((i) => (i.payments ?? []).map((p) => ({ ...p, invoiceId: i.id })));

    const paid = all.find((p) => PAID.includes(p.current_status));
    if (paid) {
      // Their invoice is the tax invoice (ours is a booking confirmation that
      // links to it). A failed read costs only the link, never the payment.
      const doc = await api<{ url?: string | null; org_invoice_number?: number | null }>(
        "GET",
        `/invoices/${paid.invoiceId}`,
      ).catch(() => null);
      return {
        status: "paid",
        amountHalalas: paid.amount_in_smallest_unit,
        method: METHOD[paid.payment_method ?? ""] ?? "card",
        raw: {
          paymentId: paid.id,
          invoiceId: paid.invoiceId,
          invoiceNo: doc?.org_invoice_number ?? null,
          invoiceUrl: doc?.url ?? null,
          paymentMethod: paid.payment_method ?? null,
        },
      };
    }
    const unknown = all.filter((p) => ![...PAID, ...WAITING, ...OVER].includes(p.current_status));
    if (unknown.length > 0) {
      await alertOwner(
        `status:${linkId}`,
        "A payment has a status we don't know",
        `Payment link ${linkId}: ${unknown.map((p) => `${p.id} is ${p.current_status}`).join(", ")}. ` +
          "It is treated as still processing. Check it in StreamPay's dashboard.",
      );
      return { status: "pending" };
    }
    if (all.some((p) => WAITING.includes(p.current_status))) return { status: "pending" };
    if (all.some((p) => p.current_status === "REFUNDED")) return { status: "failed" };

    const link = await api<PaymentLink>("GET", `/payment_links/${linkId}`);
    // COMPLETED means the link took its one payment, even if the invoice does
    // not show it yet. Never written off: the next check will find it.
    if (link.status === "COMPLETED") return { status: "pending" };
    const open =
      link.status === "ACTIVE" && (!link.valid_until || new Date(link.valid_until).getTime() > Date.now());
    return open ? { status: "pending" } : { status: "failed" };
  },

  async cancel(raw) {
    const { linkId } = (raw ?? {}) as Partial<Pending>;
    if (!linkId) return;
    try {
      await api("PATCH", `/payment_links/${linkId}/status`, { status: "INACTIVE" });
    } catch (err) {
      // Already completed or expired links refuse this; either way nobody can pay on it.
      console.error(`[streampay] could not deactivate link ${linkId}`, err);
    }
  },

  async listPayments(from, to) {
    const out: GatewayPayment[] = [];
    // 100 a page, their maximum. ponytail: 30 pages is 3,000 payments a month;
    // raise it, or narrow the window, if the salon ever takes more.
    for (let page = 1; page <= 30; page++) {
      const q = new URLSearchParams({ from_date: from.toISOString(), to_date: to.toISOString(), limit: "100", page: String(page) });
      const res = await api<{
        data: { id: string; current_status: string; amount?: string; amount_in_smallest_unit?: number }[];
        pagination?: { has_next_page?: boolean };
      }>("GET", `/payments?${q}`);
      for (const p of res.data) {
        out.push({
          id: p.id,
          state: PAID.includes(p.current_status) && p.current_status !== "PARTIALLY_REFUNDED"
            ? "paid"
            : p.current_status === "REFUNDED"
              ? "refunded"
              : p.current_status === "PARTIALLY_REFUNDED"
                ? "partly-refunded"
                : "other",
          amountHalalas: p.amount_in_smallest_unit ?? Math.round(Number(p.amount ?? 0) * 100),
        });
      }
      if (!res.pagination?.has_next_page) break;
    }
    return out;
  },

  async refundedHalalas(raw) {
    const { paymentId } = (raw ?? {}) as { paymentId?: string };
    return paymentId ? refundedSoFar(paymentId) : 0;
  },

  /**
   * Safe to call again for the same payment: it first asks how much has gone
   * back already, so a retry after a lost answer, or a refund someone made in
   * their dashboard, is recorded rather than sent twice.
   */
  async refund(input) {
    const { paymentId } = (input.raw ?? {}) as { paymentId?: string };
    if (!paymentId) {
      console.error("[streampay] refund: no StreamPay payment id on the row");
      return { status: "failed" };
    }
    const before = await refundedSoFar(paymentId);
    if (before >= input.amountHalalas) {
      return { status: "refunded", raw: { alreadyRefunded: true } };
    }
    // Part of it already went back from their dashboard. Our refunds are whole,
    // never "the rest": what she is still owed is a person's call.
    if (before > 0) {
      console.error(`[streampay] refund of ${paymentId}: ${before} of ${input.amountHalalas} already refunded outside the app; not sending`);
      return { status: "failed" };
    }
    try {
      // The reply is the refund row itself, with no status: a 2xx means it went.
      const res = await api<unknown>("POST", `/payments/${paymentId}/refund`, {
        amount: sar(input.amountHalalas),
        refund_reason: "OTHER",
        refund_note: input.reason?.slice(0, 512) ?? null,
      });
      return { status: "refunded", raw: res };
    } catch (err) {
      // A timeout can hide a refund that went through. Ask before calling it failed.
      console.error(`[streampay] refund of ${paymentId} errored; checking whether it went through`, err);
      const done = await refundedSoFar(paymentId).catch(() => 0);
      return done >= input.amountHalalas ? { status: "refunded", raw: { confirmedAfterError: true } } : { status: "failed" };
    }
  },
};

// ------------------------------------------------------------------- webhook --

/**
 * `X-Webhook-Signature: t=<timestamp>,v1=<hmac>`, the HMAC being SHA-256 over
 * `${t}.${rawBody}` with the webhook secret. Five minutes of clock skew either
 * way, so a captured delivery cannot be replayed next week.
 *
 * Their docs do not say whether the digest is hex or base64, or whether `t` is
 * seconds or milliseconds; both of each are accepted — neither weakens the
 * check, which is still an HMAC under a secret only we and they hold.
 */
export function verifyWebhookSignature(rawBody: string, header: string | null, now = Date.now()): boolean {
  const secret = process.env.STREAMPAY_WEBHOOK_SECRET?.trim();
  if (!secret || !header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const at = kv.indexOf("=");
      return [kv.slice(0, at).trim(), kv.slice(at + 1).trim()];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1 || !/^\d+$/.test(t)) return false;

  const ms = t.length > 11 ? Number(t) : Number(t) * 1000;
  if (Math.abs(now - ms) > 5 * 60_000) return false;

  const mac = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, /^[0-9a-f]+$/i.test(v1) && v1.length === 64 ? "hex" : "base64");
  return given.length === mac.length && timingSafeEqual(given, mac);
}
