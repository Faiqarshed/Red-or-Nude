"use client";

import Link from "next/link";
import { Compass } from "lucide-react";
import { Button, Card, EmptyState } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";

export default function NotFoundView() {
  const { t } = useAdminI18n();
  return (
    <Card>
      <EmptyState
        title="404"
        body={t.common.comingSoon}
        icon={<Compass className="h-8 w-8" strokeWidth={1.25} />}
      />
      <div className="flex justify-center pb-6">
        <Link href="/admin">
          <Button size="sm" variant="secondary">
            {t.nav.dashboard}
          </Button>
        </Link>
      </div>
    </Card>
  );
}
