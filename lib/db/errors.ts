// Which constraint a write tripped.
//
// Every "that name is taken" message in the admin depends on reading this, and
// reading it is not obvious: drizzle wraps the driver's error, so `err.message`
// is the SQL it tried to run and the interesting part — Postgres' own message,
// its SQLSTATE and the constraint name — hangs off `err.cause`. Code that
// matched on `err.message` never fired, and the screen fell back to a bare
// "something went wrong" for the one failure the user could actually fix.
//
// The chain is walked rather than read one level down, so a future drizzle or
// driver that wraps twice does not quietly break this again.

/**
 * The name of the unique/check/foreign-key constraint this error violated, or
 * null if it was not that kind of error.
 */
export function violatedConstraint(err: unknown): string | null {
  let current: unknown = err;
  // Five is well past anything real and stops a cause cycle dead.
  for (let depth = 0; current && depth < 5; depth++) {
    const name = (current as { constraint_name?: unknown }).constraint_name;
    if (typeof name === "string" && name.length > 0) return name;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
