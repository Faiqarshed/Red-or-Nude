// The public site's equivalent of the panel's loading.tsx — see the reasoning
// there. Same problem, same fix: every page is `force-dynamic`, so a navigation
// is a full server render, and without this the customer waits on the previous
// page with nothing to say a new one is coming.
//
// Quieter than the panel's. A customer is not reading a table, so this is a
// single column of bars at page width rather than a header plus rows, and the
// site header and footer stay put around it.
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-10" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="h-8 w-56 animate-pulse rounded-xl bg-black/[0.05]" />
      <div className="h-64 animate-pulse rounded-2xl bg-black/[0.05]" />
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-black/[0.05]" />
        ))}
      </div>
    </div>
  );
}
