"use client";

// What the site shows when a page throws while rendering: a query that failed,
// a database that did not answer. Without this Next's own crash page replaced
// it, in English, with no way on but the back button.
//
// The site's twin of the panel's error.tsx. "Try again" asks the server again
// (router.refresh) rather than only re-rendering what already failed.

import { useEffect, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { useI18n } from "@/lib/i18n";

export default function SiteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { c } = useI18n();
  const e = c.errorPage;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    console.error("[site] page failed", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col bg-cream">
      <SiteHeader />
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-32 text-center">
        <h1 className="font-display text-2xl font-extrabold text-ink">{e.title}</h1>
        <p className="max-w-[360px] text-sm text-ink/55">{e.body}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(() => {
                router.refresh();
                reset();
              })
            }
            className="rounded-[100px] bg-red-grad px-8 py-3 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {e.retry}
          </button>
          <Link href="/" className="rounded-[100px] bg-white px-8 py-3 text-sm font-bold text-ink ring-1 ring-black/10 hover:bg-black/[0.03]">
            {e.home}
          </Link>
        </div>
        {error.digest ? (
          <p className="mt-2 text-[11px] text-ink/35" dir="ltr">
            {error.digest}
          </p>
        ) : null}
      </div>
      <SiteFooter />
    </main>
  );
}
