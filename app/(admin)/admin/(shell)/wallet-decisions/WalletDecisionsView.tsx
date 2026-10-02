"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Scale } from "lucide-react";
import { Badge, Button, Card, EmptyState, FormErrors, PageHeader, tabItem, tabTone } from "@/components/admin/ui";
import { Dialog } from "@/components/admin/overlays";
import { AdminTable } from "@/components/admin/Table";
import TextField, { NumberField } from "@/components/admin/TextField";
import { usePendingAction } from "@/components/admin/use-pending-action";
import { useAdminI18n } from "@/lib/admin/i18n";
import {
  ADJUST_MAX,
  ADJUST_REASON_MAX,
  ADJUST_TEXT,
  collect,
  EMAIL_MAX,
  EMAIL_TEXT,
  focusFirstInvalid,
  hasErrors,
  rules,
} from "@/lib/admin/validate";
import { formatSAR, sarToHalalas } from "@/lib/money";
import { riyadhDateKey } from "@/lib/time";
import { cn } from "@/lib/cn";
import { decideWallet } from "./actions";

export type DecisionRow = {
  id: string;
  kind: string;
  amountHalalas: number;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  bookingCode: string | null;
  customerName: string | null;
  ownerEmail: string | null;
};

export default function WalletDecisionsView({ tab, rows }: { tab: "open" | "resolved"; rows: DecisionRow[] }) {
  const { t } = useAdminI18n();
  const w = t.walletDecisions;
  const router = useRouter();
  const [chosen, setChosen] = useState<DecisionRow | null>(null);

  return (
    <>
      <PageHeader title={w.title} subtitle={w.subtitle} />

      <div className="mb-4 flex">
        <div className="flex gap-1 rounded-xl border border-black/[0.06] bg-white p-1">
          {(["open", "resolved"] as const).map((k) => (
            <Link
              key={k}
              href={k === "resolved" ? "/admin/wallet-decisions?tab=resolved" : "/admin/wallet-decisions"}
              className={cn(tabItem, tabTone(tab === k))}
            >
              {k === "open" ? w.tabOpen : w.tabResolved}
            </Link>
          ))}
        </div>
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={tab === "resolved" ? w.emptyResolved : w.empty}
            icon={<Scale className="h-8 w-8" strokeWidth={1.25} />}
          />
        ) : (
          <AdminTable
            rows={rows}
            rowKey={(r) => r.id}
            minWidth="min-w-[720px]"
            rowClassName="border-b border-black/[0.04] last:border-0"
            columns={[
              {
                key: "when",
                header: w.when,
                className: "whitespace-nowrap align-top tabular-nums text-ink",
                dir: "ltr",
                cell: (r) => riyadhDateKey(new Date(r.createdAt)),
              },
              {
                key: "what",
                header: w.what,
                primary: true,
                className: "align-top",
                cell: (r) => (
                  <>
                    <span className="block text-ink">{w.kinds[r.kind] ?? r.kind}</span>
                    {r.bookingCode ? (
                      <span className="block text-[11px] text-ink/45">{w.booking(r.bookingCode)}</span>
                    ) : null}
                  </>
                ),
              },
              {
                key: "who",
                header: w.who,
                className: "align-top",
                cell: (r) => (
                  <>
                    <span className="block text-ink">{r.customerName || "—"}</span>
                    <span className="block text-[11px] text-ink/45" dir="ltr">
                      {r.ownerEmail ?? ""}
                    </span>
                  </>
                ),
              },
              {
                key: "amount",
                header: w.amount,
                className: "whitespace-nowrap align-top tabular-nums text-ink",
                dir: "ltr",
                cell: (r) => `${formatSAR(r.amountHalalas, { decimals: true })} ${t.common.riyal}`,
              },
              {
                key: "settle",
                header: "",
                className: "align-top",
                cell: (r) =>
                  r.resolvedAt ? (
                    <>
                      <Badge tone="success">{w.tabResolved}</Badge>
                      {r.resolutionNote ? (
                        <span className="mt-1.5 block max-w-sm text-xs leading-relaxed text-ink/70">
                          {r.resolutionNote}
                        </span>
                      ) : null}
                      <span className="mt-1 block text-[11px] tabular-nums text-ink/40" dir="ltr">
                        {w.resolvedOn} {riyadhDateKey(new Date(r.resolvedAt))}
                      </span>
                    </>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setChosen(r)}>
                      {w.settle}
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </Card>

      {chosen ? (
        <SettleDialog
          row={chosen}
          onClose={() => setChosen(null)}
          onDone={() => {
            setChosen(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** Settle one case: correct a wallet, or close it without, a reason either way. */
function SettleDialog({ row, onClose, onDone }: { row: DecisionRow; onClose: () => void; onDone: () => void }) {
  const { t } = useAdminI18n();
  const w = t.walletDecisions;
  const [email, setEmail] = useState(row.ownerEmail ?? "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState<"correct" | "close" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = usePendingAction();

  const r = rules(t.validation);
  const check = (how: "correct" | "close") =>
    collect({
      reason: r.text(w.reason, reason, { min: 3, max: ADJUST_REASON_MAX, script: "any" }),
      ...(how === "correct"
        ? {
            email: r.email(w.email, email),
            amount:
              r.number(w.correction, amount, { min: -ADJUST_MAX, max: ADJUST_MAX, decimals: 2 }) ||
              (Number(amount) === 0 && t.validation.nonZero(w.correction)),
          }
        : {}),
    });
  const errors = tried ? check(tried) : {};

  const submit = (how: "correct" | "close") =>
    run(async () => {
      setError(null);
      setTried(how);
      if (hasErrors(check(how))) {
        focusFirstInvalid();
        return false;
      }
      const res = await decideWallet({
        id: row.id,
        note: reason.trim(),
        correction: how === "correct" ? { ownerEmail: email.trim(), halalas: sarToHalalas(Number(amount)) } : undefined,
      });
      if (res.ok) onDone();
      else setError(w.errors[res.error] ?? t.common.error);
      return false;
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={w.settleTitle}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={() => submit("close")} disabled={pending}>
            {w.closeOnly}
          </Button>
          <Button onClick={() => submit("correct")} disabled={pending}>
            {w.correct}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-start text-sm text-ink">{w.kinds[row.kind] ?? row.kind}</p>
        <TextField
          label={w.email}
          {...EMAIL_TEXT}
          max={EMAIL_MAX}
          error={errors.email}
          value={email}
          onChange={setEmail}
        />
        <NumberField
          label={w.correction}
          error={errors.amount}
          maxDigits={5}
          decimals={2}
          signed
          value={amount}
          onChange={setAmount}
        />
        <TextField
          label={w.reason}
          {...ADJUST_TEXT}
          max={ADJUST_REASON_MAX}
          error={errors.reason}
          value={reason}
          onChange={setReason}
        />
        <FormErrors errors={errors} summary={t.validation.summary} server={error} />
      </div>
    </Dialog>
  );
}
