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
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { streampayIds } from "@/lib/db/schema";
import { toNationalDigits } from "@/lib/phone";
import { alertOwner } from "./alert";
import type { Discount, GatewayPayment, Line, Payer, PaymentDriver, PaymentMethod, Verdict } from "./index";

// ---------------------------------------------------------------- transport --

function base(): string {
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
  if (!res.ok) throw new Error(`[streampay] ${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : {}) as T;
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
 */
const scoped = (key: string) => `${createHash("sha256").update(apiKey()).digest("hex").slice(0, 8)}:${key}`;

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

// ------------------------------------------------------------------ products --

type ProductDto = { id: string; prices?: { id: string; is_active: boolean }[] };

/**
 * Make StreamPay's copy of one of our catalogue items match, and return its id.
 *
 * Called when the admin saves an item (best effort) and again for every line at
 * checkout, so a product that is missing — never synced, or StreamPay was down
 * during the save — is created on first use. Only calls out when the name,
 * price or VAT flag differ from what was last pushed.
 *
 * A price edit archives the old StreamPay price and makes a new one; links
 * already created keep the price they were made with.
 */
export async function syncProduct(
  key: string,
  p: { name: string; priceHalalas: number; vatExempt?: boolean },
): Promise<string> {
  const name = p.name.slice(0, 160);
  const exempt = Boolean(p.vatExempt);
  const signature = JSON.stringify([name, p.priceHalalas, exempt]);
  const have = await lookup(key);
  if (have?.signature === signature) return have.streampayId;

  // is_price_inclusive_of_vat is deprecated but still defaults to true, and
  // StreamPay refuses an exempt price that is also "inclusive" (422).
  const vat = { is_price_exempt_from_vat: exempt, is_price_inclusive_of_vat: !exempt };
  const price = { currency: "SAR", amount: sar(p.priceHalalas), ...vat };

  if (!have) {
    const made = await api<ProductDto>("POST", "/products", {
      name,
      type: "ONE_OFF",
      prices: [price],
      is_price_exempt_from_vat: exempt,
    });
    const priceId = made.prices?.find((x) => x.is_active)?.id ?? made.prices?.[0]?.id ?? null;
    return remember(key, made.id, priceId, signature);
  }

  const [oldName, oldPrice, oldExempt] = have.signature ? JSON.parse(have.signature) : [];
  // Always set when we created the product (the create below stores it).
  let priceId = have.priceId!;

  if (oldName !== name || oldExempt !== exempt) {
    await api("PUT", `/products/${have.streampayId}`, { name, is_price_exempt_from_vat: exempt });
  }
  if (oldPrice !== p.priceHalalas || oldExempt !== exempt) {
    const next = await api<{ id: string }>("PUT", `/products/${have.streampayId}/prices/${priceId}`, {
      amount: price.amount,
      ...vat,
    });
    priceId = next.id;
  }

  await db
    .update(streampayIds)
    .set({ priceId, signature, updatedAt: new Date() })
    .where(eq(streampayIds.key, scoped(key)));
  return have.streampayId;
}

/**
 * Archive or restore a product when the admin does the same to the item.
 * No-op if never synced, or not on StreamPay; never throws — an admin action
 * must not fail because StreamPay is down.
 */
export async function setProductActive(key: string, active: boolean): Promise<void> {
  if (process.env.PAYMENT_DRIVER !== "streampay") return;
  try {
    const have = await lookup(key);
    if (have) await api("PUT", `/products/${have.streampayId}`, { is_active: active });
  } catch (err) {
    console.error(`[streampay] could not set ${key} active=${active}`, err);
  }
}

/**
 * The admin-side hook: sync, and never let StreamPay being down fail a save.
 * Checkout syncs again anyway, so a miss here heals itself on first use.
 */
export async function syncProductQuietly(
  key: string,
  p: { name: string; priceHalalas: number; active: boolean },
): Promise<void> {
  if (process.env.PAYMENT_DRIVER !== "streampay") return;
  try {
    // A zero-priced item never reaches a payment link (products must be ≥ 1 SAR).
    if (p.priceHalalas > 0) await syncProduct(key, p);
  } catch (err) {
    console.error(`[streampay] could not sync ${key}; checkout will retry`, err);
  }
  await setProductActive(key, p.active);
}

// ------------------------------------------------------------------- coupons --

/**
 * A fixed amount off, named for where it came from. Created the first time
 * this exact label and amount is seen, then reused forever — so after the
 * first few weeks most checkouts create nothing new.
 */
async function ensureCoupon(d: Discount): Promise<string> {
  const key = `coupon:${d.label}:${d.halalas}`;
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
async function ensureConsumer(payer: Payer): Promise<string | null> {
  const phone = payer.phone ? `+966${toNationalDigits(payer.phone)}` : null;
  const email = payer.email?.trim().toLowerCase() || null;
  const key = phone ? `consumer:${phone}` : email ? `consumer:${email}` : null;
  if (!key) return null;

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

    // Sequential, not Promise.all: small counts, and it keeps the StreamPay
    // rate limit and the lookup table's first-insert-wins out of each other's way.
    const linkItems: { product_id: string; quantity: number }[] = [];
    for (const l of items) linkItems.push({ product_id: await syncProduct(l.key, l), quantity: l.qty });
    const coupons: string[] = [];
    for (const d of discounts) coupons.push(await ensureCoupon(d));
    const consumer = await ensureConsumer(input.payer);

    const link = await api<PaymentLink>("POST", "/payment_links", {
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
    if ((await refundedSoFar(paymentId)) >= input.amountHalalas) {
      return { status: "refunded", raw: { alreadyRefunded: true } };
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
