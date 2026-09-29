"use client";

// What the panel shows when a screen throws while rendering: a query that
// failed, a database that did not answer. Without this Next's own crash page
// replaced the whole panel, sidebar and all, and the only way on was the back
// button.
//
// Inside (shell), so the sidebar and header stay and the rest of the panel
// still works. "Try again" asks the server again (router.refresh) rather than
// only re-rendering what already failed. The digest is the id Next logs the
// error under on the server, so a receptionist can quote something findable.

import { useEffect, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { Button, Card, EmptyState } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useAdminI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    console.error("[admin] screen failed", error);
  }, [error]);

  return (
    <Card>
      <EmptyState
        title={t.common.errorTitle}
        body={t.common.errorBody}
        icon={<TriangleAlert className="h-8 w-8" strokeWidth={1.25} />}
      />
      <div className="flex flex-wrap justify-center gap-2 pb-4">
        <Button
          size="sm"
          pending={pending}
          onClick={() =>
            startTransition(() => {
              router.refresh();
              reset();
            })
          }
        >
          {t.common.tryAgain}
        </Button>
        <Link href="/admin">
          <Button size="sm" variant="secondary">
            {t.nav.dashboard}
          </Button>
        </Link>
      </div>
      {error.digest ? (
        <p className="pb-6 text-center text-[11px] text-ink/40" dir="ltr">
          {t.common.errorRef}: {error.digest}
        </p>
      ) : null}
    </Card>
  );
}
