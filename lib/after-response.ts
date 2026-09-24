// Work the customer should not wait for: the receipt email, which may wait up
// to 20 s for StreamPay's invoice PDF (lib/payments/invoice-pdf.ts), while her
// tickets are ready now.
//
// On a long-lived Node server (`next start`: Azure App Service, Container Apps)
// it runs after the response has gone. A serverless host freezes the function
// the moment the response is returned, so there, and in tests (which check
// what it did), it is awaited as before.
//
// ponytail: fire-and-forget, so a server restarted mid-send loses that email.
// Move to an outbox table if that is ever seen.

const serverless = () =>
  Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.FUNCTIONS_WORKER_RUNTIME);

/** Never throws: what runs here must not be able to unsay what came before it. */
export async function afterResponse(what: string, work: () => Promise<unknown>): Promise<void> {
  const run = work().catch((err) => console.error(`[after-response] ${what} failed`, err));
  if (serverless() || process.env.NODE_ENV === "test") await run;
}
