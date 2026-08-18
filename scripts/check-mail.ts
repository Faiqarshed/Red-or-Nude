// Does the configured mail transport actually work?
//
//   npm run check:mail                        # connect and authenticate only
//   npm run check:mail -- --send you@you.com  # also send a plain test message
//
// Without --send nothing is delivered: for SMTP this opens the connection, runs
// STARTTLS and authenticates, then hangs up. That turns "wrong password" or
// "port blocked" into a clear answer in two seconds, rather than a failed
// invoice discovered after a customer has already been charged.

import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { activeTransport, sendMail } = await import("@/lib/email");
  const transport = activeTransport();

  console.log(`transport: ${transport}`);

  if (transport === "none") {
    console.error(
      "\nNothing configured. Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD in .env.local.",
    );
    process.exit(1);
  }

  console.log(`host:      ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`);
  console.log(`user:      ${process.env.SMTP_USER}`);

  const nodemailer = (await import("nodemailer")).default;
  const port = Number(process.env.SMTP_PORT) || 587;
  const probe = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });

  try {
    await probe.verify();
    console.log("\nconnected and authenticated ✓");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nfailed: ${message}`);

    // The three failures worth naming, because each has a different fix.
    if (/invalid login|535|authentication/i.test(message)) {
      console.error(
        "  → credentials refused. Gmail needs an App Password, not the account password;\n" +
          "    other relays want the SMTP key they generated, not your dashboard password.",
      );
    } else if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(message)) {
      console.error(
        `  → nothing answered on port ${port}. Try 465 instead of 587 (or vice versa);\n` +
          "    some networks and serverless hosts block outbound SMTP entirely.",
      );
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
      console.error("  → SMTP_HOST does not resolve. Check the hostname.");
    }
    process.exit(1);
  } finally {
    probe.close();
  }

  const i = process.argv.indexOf("--send");
  if (i === -1) return;

  const to = process.argv[i + 1];
  if (!to || to.startsWith("--")) {
    console.error("--send needs an address: npm run check:mail -- --send you@example.com");
    process.exit(1);
  }

  const result = await sendMail({
    to,
    subject: "Red or Nude — mail transport test",
    html: "<p>If you can read this, the transport works.</p>",
    text: "If you can read this, the transport works.",
    tags: ["transport-test"],
  });

  if (!result.ok) {
    console.error(`\nnot sent (${result.reason}): ${result.detail ?? ""}`);
    process.exit(1);
  }
  console.log(`\nsent to ${to} — id ${result.id}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
