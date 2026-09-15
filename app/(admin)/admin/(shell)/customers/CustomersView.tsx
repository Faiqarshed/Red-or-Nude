"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Ban, Search, Users } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormErrors,
  Input,
  invalidRing,
  PageHeader,
} from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import { useAdminI18n } from "@/lib/admin/i18n";
import TextField from "@/components/admin/TextField";
import {
  checkCustomer,
  EMAIL_MAX,
  EMAIL_TEXT,
  typedPhone,
  focusFirstInvalid,
  hasErrors,
  NOTES_MAX,
  NOTES_TEXT,
  PERSON_NAME_MAX,
  PERSON_TEXT,
} from "@/lib/admin/validate";
import { cn } from "@/lib/cn";
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
  /** Verified email: she signs in with it. */
  hasAccount: boolean;
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
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (customer && loadedId !== customer.id) {
    setLoadedId(customer.id);
    setName(customer.name ?? "");
    setPhone(customer.phone);
    setEmail(customer.email ?? "");
    setNotes(customer.notes ?? "");
    setBlocked(customer.blocked);
    setTried(false);
    setError(null);
  }

  if (!customer) return null;

  const check = () => checkCustomer(t, { name, phone, email, notes });
  const emailChanged = email.trim().toLowerCase() !== (customer.email ?? "").toLowerCase();
  const errors = tried ? check() : {};

  const save = () =>
    startTransition(async () => {
      setError(null);
      setTried(true);
      if (hasErrors(check())) return focusFirstInvalid();
      // It used to close whatever came back, so a refused save looked like a
      // successful one.
      const res = await updateCustomer({
        id: customer.id,
        name: name.trim(),
        phone,
        email: email.trim(),
        notes: notes.trim(),
        blocked,
      });
      if (res.ok) onSaved();
      else
        setError(
          res.error === "phone-taken"
            ? t.customers.phoneTaken
            : res.error === "not-found"
              ? t.validation.notFound
              : t.common.error,
        );
    });

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
          <Button size="sm" disabled={pending} onClick={save}>
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
          <TextField
            label={t.customers.name}
            {...PERSON_TEXT}
            max={PERSON_NAME_MAX}
            error={errors.name}
            value={name}
            onChange={setName}
          />
          <Field label={t.customers.phone} error={errors.phone}>
            {/* Checkout finds a returning customer by this number, so it is
                saved as 05XXXXXXXX whatever shape is typed, and the server
                refuses one that already belongs to someone else. */}
            <Input
              inputMode="tel"
              dir="ltr"
              className="text-left tabular-nums"
              aria-invalid={!!errors.phone}
              value={phone}
              onChange={(e) => setPhone(typedPhone(e.target.value))}
            />
          </Field>
        </div>

        <div>
          <TextField
            label={t.customers.email}
            {...EMAIL_TEXT}
            max={EMAIL_MAX}
            error={errors.email}
            value={email}
            onChange={setEmail}
          />
          {/* Said before Save, not after: changing a sign-in address signs her out. */}
          {customer.hasAccount && emailChanged ? (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-[#b7791f]/12 px-3 py-2 text-start text-xs text-[#8a5a06]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              {t.customers.accountEmailNote}
            </p>
          ) : null}
        </div>

        <TextField
          label={t.customers.notes}
          {...NOTES_TEXT}
          rows={3}
          max={NOTES_MAX}
          error={errors.notes}
          value={notes}
          onChange={setNotes}
        />

        <FormErrors errors={errors} summary={t.validation.summary} server={error} />

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
