// What the panel shows while the next screen is being rendered on the server.
//
// Every page under here is `force-dynamic`, so navigating means waiting on a
// full server render plus its queries — and until this file existed there was no
// `loading.tsx` and no `Suspense` anywhere in the repo, so that wait was spent
// on the *old* screen with nothing moving. Clicking a nav item appeared to do
// nothing for a second and then the page swapped. That is most of what the salon
// reported as "the buttons are slow": not the work, the silence.
//
// Deliberately a skeleton and not a spinner. A spinner says "something is
// happening"; bars in roughly the shape of a table say "your table is coming",
// and the shell around this file — nav, header, branch picker — stays on screen
// and interactive the whole time, so the panel never looks like it reloaded.
//
// The bar idiom is the one RescheduleDialog.tsx already uses for its slot grid.
export default function Loading() {
  return (
    <div className="space-y-4 p-4 sm:p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="h-8 w-48 animate-pulse rounded-xl bg-black/[0.05]" />
      <div className="space-y-2">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-xl bg-black/[0.05] sm:h-11" />
        ))}
      </div>
    </div>
  );
}
