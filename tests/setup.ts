// Runs before every test file.
//
// The import order is the point: `_test-db` refuses to start unless
// TEST_DATABASE_URL is set, on this machine, and named `*_test`, and only then
// does it rewrite DATABASE_URL. Importing it here means no test file can reach
// a database without passing that gate first — the same guard the check scripts
// under scripts/ go through, and for the same reason: these suites build their
// fixtures by deleting rows.
import "../scripts/_test-db";

// No network from a test. SITE_URL in .env.local can be a tunnel to a dev
// server (ngrok), and the gift card email fetches its picture from it: a test
// run then waited on whatever was running there. A local port nothing listens
// on refuses at once, and the email falls back to its remote image.
process.env.SITE_URL = "http://127.0.0.1:9";

// And no real mail. .env.local holds working SMTP credentials, so a test that
// delivers a gift card or a receipt sent it, through that account, to the
// fixtures' made-up addresses: seconds per send, and bounces in a real inbox.
// Empty rather than deleted, so a later load of .env.local cannot put it back;
// lib/email then reports "not-configured" and sends nothing.
process.env.SMTP_HOST = "";
