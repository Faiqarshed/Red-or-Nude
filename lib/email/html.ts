// Escaping for the mail templates.
//
// Its own file rather than living in index.ts: the templates need this and
// nothing else from lib/email, and index.ts drags the SMTP transport in behind
// it — which scripts/preview-giftcard.ts has no use for.

/** Customer and staff data lands inside an HTML document — never interpolate it raw. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
