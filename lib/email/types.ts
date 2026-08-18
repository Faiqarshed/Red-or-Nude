// The contract every mail transport implements.
//
// Kept in its own file so a second transport can be added beside smtp.ts without
// either importing the other, and so nothing that *sends* mail has to know which
// one is running.

export type SendMailInput = {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  /** Threads replies to the salon rather than the no-reply sender. */
  replyTo?: string | null;
  /** Shows up in the provider's reporting; one tag per kind of mail we send. */
  tags?: string[];
};

export type SendMailResult =
  | { ok: true; id: string }
  /**
   * `not-configured` — no credentials; mail is skipped, not failed.
   * `rejected`       — ours to fix: bad address, unverified domain, bad key.
   * `failed`         — theirs: an outage or a timeout. The only retryable one.
   */
  | { ok: false; reason: "not-configured" | "rejected" | "failed"; detail?: string };
