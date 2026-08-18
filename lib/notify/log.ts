// Stand-in messenger: prints instead of sending.
//
// Same bargain as lib/payments/fake.ts — the call sites are real, the delivery
// is not. Running with this driver means customers receive nothing, so
// NOTIFY_DRIVER has to point at a real provider before launch. See
// docs/REFILL-AND-GIFT-CARDS.md for how to write one.

import type { NotifyDriver, NotifyMessage, NotifyResult } from "./index";

export const logDriver: NotifyDriver = {
  name: "log",

  async send(message: NotifyMessage): Promise<NotifyResult> {
    console.log(
      `[notify:log] ${message.template} → ${message.channel} ${message.to} (${message.lang})`,
      message.data,
    );
    return { ok: true };
  },
};
