// Which constraint a write tripped.
//
// Drizzle wraps the driver's error: `err.message` is the SQL it attempted, and
// Postgres' own error — SQLSTATE, message, constraint name — is `err.cause`.
// Matching on `err.message` never fires, which is how the promo screen came to
// report every duplicate code as a bare failure.

/** The constraint this error violated, or null if it was not that kind of error. */
export function violatedConstraint(err: unknown): string | null {
  return (err as { cause?: { constraint_name?: string } } | null)?.cause?.constraint_name || null;
}
