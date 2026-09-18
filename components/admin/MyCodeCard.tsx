"use client";

// A staff member's own discount code, on her own home screen.
//
// Rendered once, above whichever view /admin gives her role — the technician's
// day, the front desk or the dashboard — so every portal shows it without each
// view carrying its own copy. She sees her code and nobody else's: the page
// loads it by her session id, never by anything in the request.

import { Ticket } from "lucide-react";
import { Badge, Card } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import type { StaffCodeView } from "@/lib/staff-codes";

export default function MyCodeCard({ code }: { code: StaffCodeView }) {
  const { t } = useAdminI18n();
  const s = t.staff;

  const [tone, label] = !code.active
    ? (["danger", s.myCodeOff] as const)
    : code.used
      ? (["neutral", s.discountCodeUsed] as const)
      : (["success", s.myCodeReady] as const);

  return (
    <Card className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
      <Ticket className="h-5 w-5 shrink-0 text-red" strokeWidth={1.75} />
      <div className="min-w-0 flex-1 text-start">
        <p className="text-xs font-medium text-ink/55">{s.myCodeTitle}</p>
        <p className="font-mono text-lg font-bold tracking-wider text-ink" dir="ltr">
          {code.code}
        </p>
        <p className="text-[11px] text-ink/45">
          {s.myCodeHint.replace("{percent}", String(code.percent))}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <Badge tone={tone}>{label}</Badge>
        <span className="text-[11px] text-ink/40">
          {s.myCodeRenews.replace("{date}", code.renewsOn)}
        </span>
      </div>
    </Card>
  );
}
