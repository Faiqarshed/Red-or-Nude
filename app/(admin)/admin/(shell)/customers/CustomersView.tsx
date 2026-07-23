"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Search, Users } from "lucide-react";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import { useAdminI18n } from "@/lib/admin/i18n";
import { pick } from "@/lib/localized";
import type { Localized } from "@/lib/db/schema";
import { STATUS_TONE, type BookingStatus } from "../bookings/BookingsView";
import { updateCustomer } from "./actions";

type HistoryRow = {
  id: string;
  code: string;
  startsAt: string;
  status: BookingStatus;
  serviceName: Localized | null;
  totalSar: number;
};

export type CustomerRow = {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  notes: string | null;
  blocked: boolean;
  bookingsCount: number;
  lifetimeSar: number;
  noShows: number;
  lastVisit: string | null;
  history: HistoryRow[];
};

export default function CustomersView({
  customers,
  query,
}: {
  customers: CustomerRow[];
  query: string;
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const [q, setQ] = useState(query);
  const [selected, setSelected] = useState<CustomerRow | null>(null);
  const [, startTransition] = useTransition();

  const search = (value: string) => {
    setQ(value);
    startTransition(() =>
      router.push(value.trim() ? `/admin/customers?q=${encodeURIComponent(value.trim())}` : "/admin/customers"),
    );
  };

  return (
    <>
      <PageHeader title={t.customers.title} subtitle={t.customers.subtitle} />

      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-ink/30" strokeWidth={1.75} />
        <Input
          value={q}
          onChange={(e) => search(e.target.value)}
          placeholder={t.customers.search}
          className="ps-9"
        />
      </div>

      <Card className="overflow-hidden">
        {customers.length === 0 ? (
          <EmptyState title={t.customers.empty} icon={<Users className="h-8 w-8" strokeWidth={1.25} />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-black/[0.06] bg-black/[0.015]">
                  {[
                    t.customers.name,
                    t.customers.phone,
                    t.customers.bookingsCount,
                    t.customers.lifetime,
                    t.customers.lastVisit,
                  ].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-start text-[11px] font-semibold uppercase tracking-wide text-ink/45">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelected(c)}
                    className="cursor-pointer border-b border-black/[0.04] last:border-0 hover:bg-black/[0.015]"
                  >
                    <td className="px-4 py-3 text-start">
                      <span className="flex items-center gap-2">
                        <span className="text-ink">{c.name || "—"}</span>
                        {c.blocked && <Badge tone="danger">{t.customers.blocked}</Badge>}
                        {/* Repeat no-shows are the thing a receptionist most
                            wants to spot before confirming another booking. */}
                        {c.noShows > 0 && (
                          <Badge tone="warning">
                            {c.noShows} {t.customers.noShows}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-start tabular-nums text-ink/70" dir="ltr">
                      {c.phone}
                    </td>
                    <td className="px-4 py-3 text-start tabular-nums text-ink/70">{c.bookingsCount}</td>
                    <td className="px-4 py-3 text-start font-semibold tabular-nums text-ink">
                      {c.lifetimeSar.toLocaleString("en-US")}
                      <span className="ms-1 text-xs font-normal text-ink/45">{t.common.riyal}</span>
                    </td>
                    <td className="px-4 py-3 text-start text-xs tabular-nums text-ink/50" dir="ltr">
                      {c.lastVisit ? c.lastVisit.slice(0, 10) : t.customers.never}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CustomerDrawer
        customer={selected}
        onClose={() => setSelected(null)}
        onSaved={() => {
          setSelected(null);
          router.refresh();
        }}
      />
    </>
  );
}

function CustomerDrawer({
  customer,
  onClose,
  onSaved,
}: {
  customer: CustomerRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useAdminI18n();
  const [pending, startTransition] = useTransition();
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [blocked, setBlocked] = useState(false);

  if (customer && loadedId !== customer.id) {
    setLoadedId(customer.id);
    setName(customer.name ?? "");
    setEmail(customer.email ?? "");
    setNotes(customer.notes ?? "");
    setBlocked(customer.blocked);
  }

  if (!customer) return null;

  return (
    <Drawer
      open
      onClose={onClose}
      wide
      title={customer.name || customer.phone}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
            {t.common.cancel}
          </Button>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await updateCustomer({ id: customer.id, name, email, notes, blocked });
                onSaved();
              })
            }
          >
            {pending ? t.common.saving : t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-3 gap-3">
          {[
            [t.customers.bookingsCount, String(customer.bookingsCount)],
            [t.customers.lifetime, customer.lifetimeSar.toLocaleString("en-US")],
            [t.customers.noShows, String(customer.noShows)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-black/[0.06] bg-white p-3 text-start">
              <p className="text-[10px] text-ink/45">{label}</p>
              <p className="mt-1 font-display text-lg font-bold tabular-nums text-ink">{value}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.customers.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t.customers.phone}>
            {/* The phone is the customer's identity key — changing it here would
                silently split their history. */}
            <Input value={customer.phone} dir="ltr" className="text-left" disabled />
          </Field>
        </div>

        <Field label={t.customers.email}>
          <Input type="email" dir="ltr" className="text-left" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>

        <Field label={t.customers.notes}>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full resize-none rounded-xl border border-black/10 bg-white px-3 py-2 text-start text-sm text-ink outline-none focus:border-sky focus:ring-2 focus:ring-sky/20"
          />
        </Field>

        <label className="flex items-start justify-between gap-4 rounded-xl border border-black/[0.06] bg-white px-4 py-3">
          <span className="text-start">
            <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
              <Ban className="h-3.5 w-3.5 text-red" strokeWidth={1.75} />
              {t.customers.blocked}
            </span>
            <span className="mt-0.5 block text-[11px] text-ink/45">{t.customers.blockedHint}</span>
          </span>
          <input
            type="checkbox"
            checked={blocked}
            onChange={(e) => setBlocked(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-red"
          />
        </label>

        <div>
          <p className="mb-2 text-start text-xs font-medium text-ink/60">{t.customers.history}</p>
          {customer.history.length === 0 ? (
            <p className="rounded-xl bg-black/[0.02] py-4 text-center text-xs text-ink/40">
              {t.customers.noHistory}
            </p>
          ) : (
            <ul className="divide-y divide-black/[0.05] rounded-xl border border-black/[0.06] bg-white px-4">
              {customer.history.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0 text-start">
                    <p className="truncate text-xs text-ink">{pick(h.serviceName, lang) || h.code}</p>
                    <p className="text-[10px] tabular-nums text-ink/40" dir="ltr">
                      {h.startsAt.slice(0, 10)}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[h.status]}>{t.bookings.statuses[h.status]}</Badge>
                  <span className="shrink-0 text-xs font-semibold tabular-nums text-ink">
                    {h.totalSar.toLocaleString("en-US")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Drawer>
  );
}
