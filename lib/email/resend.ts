// Resend — real delivery for the invoice email.
//
// Not the only outbound path: lib/notify/ is a separate, still log-only seam
// for WhatsApp and email templates. The two overlap and should probably become
// one — see docs/INVOICE-EMAIL.md §7.
//
// Plain `fetch` against POST /emails rather than the `resend` SDK: one endpoint
// is used, the SDK is a thin wrapper over the same fetch call, and doing it by
// hand keeps this file honest about exactly what leaves the server. Swapping in
// the package later would touch nothing outside this file.
//
// Nothing here throws. Mail is a side effect of a payment that has already been
// taken — a rejected recipient or a provider outage must never turn a confirmed
// booking into an error, so every failure is logged and reported in the result.

import "server-only";

const ENDPOINT = "https://api.resend.com/emails";

/** Mail is skipped rather than failed when the key is absent (local dev, CI). */
const apiKey = () => process.env.RESEND_API_KEY?.trim() || null;

export type SendMailInput = {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  /** Threads replies to the salon rather than the no-reply sender. */
  replyTo?: string | null;
  /** Shows up in Resend's dashboard; one tag per kind of mail we send. */
  tags?: string[];
};

export type SendMailResult =
  | { ok: true; id: string }
  | { ok: false; reason: "not-configured" | "rejected" | "failed"; detail?: string };

/** `Sara <sara@example.com>` — Resend's address format. */
function address(email: string, name?: string | null): string {
  const clean = name?.trim();
  // A display name containing a quote or angle bracket would break the header.
  return clean ? `${clean.replace(/["<>\\]/g, "")} <${email}>` : email;
}

/**
 * Resend answers 200 with `{ id }` on success, and 4xx/5xx with
 * `{ statusCode, name, message }` on failure — unlike Mandrill it does not hide
 * a refusal inside a 200, so the status code is the outcome.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const key = apiKey();
  if (!key) {
    console.warn("[mail] RESEND_API_KEY is not set — skipping", input.subject);
    return { ok: false, reason: "not-configured" };
  }

  const fromEmail = process.env.MAIL_FROM_EMAIL?.trim() || "onboarding@resend.dev";
  const fromName = process.env.MAIL_FROM_NAME?.trim() || "Red or Nude";

  // Resend's shared test domain delivers only to the account owner's own
  // address, and it compares that address as a bare string: `Sara <sara@x.com>`
  // is refused even when the address itself matches. A display name on the
  // recipient is correct and wanted in production, so it is dropped only while
  // sending from the test domain — otherwise every test send fails for a reason
  // that has nothing to do with the code being tested.
  const testDomain = fromEmail.endsWith("@resend.dev");

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      // The customer is waiting on the payment response behind this call; a
      // hung provider must not hold the checkout open indefinitely.
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: address(fromEmail, fromName),
        to: [testDomain ? input.to : address(input.to, input.toName)],
        subject: input.subject,
        html: input.html,
        // An invoice is a record of what was charged, so the text part is the
        // one written in lib/invoice/template.ts — never auto-generated.
        text: input.text,
        reply_to: input.replyTo || undefined,
        // Resend restricts tag names and values to letters, numbers, underscores
        // and dashes, and rejects the whole send if one doesn't match.
        tags: input.tags?.map((value) => ({
          name: "category",
          value: value.replace(/[^A-Za-z0-9_-]/g, "_"),
        })),
      }),
    });
  } catch (err) {
    console.error("[mail] request to Resend failed", err);
    return { ok: false, reason: "failed", detail: String(err) };
  }

  const body: unknown = await response.json().catch(() => null);
  const field = (key: string): string | null => {
    if (body && typeof body === "object" && key in body) {
      const value = (body as Record<string, unknown>)[key];
      return typeof value === "string" ? value : null;
    }
    return null;
  };

  if (!response.ok) {
    const detail = field("message") ?? `HTTP ${response.status}`;
    console.error(`[mail] Resend rejected the send to ${input.to}:`, detail);
    // 4xx is us — an unverified sending domain, a malformed address, a bad key.
    // 5xx is them. Worth separating: only one of the two is worth retrying.
    const reason = response.status >= 400 && response.status < 500 ? "rejected" : "failed";
    return { ok: false, reason, detail };
  }

  const id = field("id");
  if (!id) {
    console.error("[mail] Resend returned 200 with no id — treating as failed");
    return { ok: false, reason: "failed", detail: "no-id" };
  }

  return { ok: true, id };
}
