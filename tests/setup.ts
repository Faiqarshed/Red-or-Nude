// Runs before every test file.
//
// The import order is the point: `_test-db` refuses to start unless
// TEST_DATABASE_URL is set, on this machine, and named `*_test`, and only then
// does it rewrite DATABASE_URL. Importing it here means no test file can reach
// a database without passing that gate first — the same guard the check scripts
// under scripts/ go through, and for the same reason: these suites build their
// fixtures by deleting rows.
import "../scripts/_test-db";
