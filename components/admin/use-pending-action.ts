"use client";

// One answer to "did my click do anything?", shared by every mutating button in
// the panel.
//
// The panel had the same five lines written out at 39 call sites, and they were
// all subtly wrong in the same way:
//
//     setBusy(true);
//     const res = await checkInTicket(id);
//     setBusy(false);      // ← the button re-enables HERE
//     router.refresh();    // ← but the new data arrives some time AFTER here
//
// Between those last two lines the button is live again while the screen still
// shows pre-mutation data. On a database in another region that gap is most of a
// second, and what the receptionist sees is a button that did nothing — so she
// clicks it again. Every "the buttons are too slow" report starts here.
//
// `router.refresh()` is also not awaitable, so the only way to know when the new
// render has landed is to put it in a transition and watch `isPending`.
//
// ponytail: two pieces of state rather than one because this is React 18, where
// `startTransition(async () => …)` ends the transition at the first `await`
// instead of spanning it. `running` covers the action, `refreshing` covers the
// re-render, and they are set in the same tick so React batches them and the
// spinner never blinks between the two. Collapse this into a single async
// transition when the app moves to React 19.

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type PendingAction = {
  /** True from the click until the refreshed server render is on screen. */
  pending: boolean;
  /**
   * Run a server action and then refresh.
   *
   * Return `false` from `work` to skip the refresh — for a refusal that changed
   * nothing on the server, where re-rendering the same rows is a wasted round
   * trip. Returning nothing refreshes, which is the safe default: a handler that
   * forgets to say costs a query, not a stale screen.
   */
  run: (work: () => Promise<boolean | void>) => Promise<void>;
};

export function usePendingAction(): PendingAction {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [running, setRunning] = useState(false);

  const run = useCallback(
    async (work: () => Promise<boolean | void>) => {
      setRunning(true);
      try {
        const ok = await work();
        if (ok !== false) startRefresh(() => router.refresh());
      } finally {
        // Batched with the startRefresh above, so `pending` hands straight over
        // from one flag to the other with no frame in between where it is false.
        setRunning(false);
      }
    },
    [router],
  );

  return { pending: running || refreshing, run };
}
