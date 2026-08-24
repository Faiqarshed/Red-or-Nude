// Send a customer a message, given only their id.
//
// Both self-service actions in brief §2.6 need the same four steps — resolve the
// customer, bail if they have no address, send, swallow anything that goes
// wrong — and neither may fail because a message did. Written once here rather
// than copied into each route, which is how the two would end up disagreeing
// about which failures are survivable.

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { notify, type NotifyTemplate } from "./index";

/**
 * Awaited but never allowed to fail its caller — the booking is already
 * cancelled or moved by the time this runs, and a messaging outage must not
 * turn a completed action into an error the customer sees.
 */
export async function notifyCustomer(
  customerId: string | null,
  template: NotifyTemplate,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    if (!customerId) return;

    const [customer] = await db
      .select({ email: customers.email, lang: customers.lang })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    // Plenty of customers give one contact, not both. Not an error.
    if (!customer?.email) return;

    await notify({
      channel: "email",
      to: customer.email,
      template,
      lang: customer.lang ?? "ar",
      data,
    });
  } catch (err) {
    console.error(`[notify] ${template} failed`, err);
  }
}
