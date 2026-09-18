"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IdCard, Plus, Trash2 } from "lucide-react";
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
  touchTargetSm,
  touchTargetSwitch,
} from "@/components/admin/ui";
import { ConfirmDialog, Drawer } from "@/components/admin/overlays";
import { usePendingAction } from "@/components/admin/use-pending-action";
import { useAdminI18n } from "@/lib/admin/i18n";
import TextField from "@/components/admin/TextField";
import { dayRange, formatDateKey, riyadhDateKey } from "@/lib/time";
import {
  checkStaff,
  checkTimeOff,
  collect,
  EMAIL_MAX,
  EMAIL_TEXT,
  focusFirstInvalid,
  hasErrors,
  PASSWORD_MAX,
  PERSON_NAME_MAX,
  PERSON_TEXT,
  typedPhone,
} from "@/lib/admin/validate";
import { mustHaveBranch, ROLE_LABELS } from "@/lib/auth/rbac";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import type { Localized, StaffRole } from "@/lib/db/schema";
import { addTimeOff, deleteStaff, removeTimeOff, saveStaff, setStaffActive } from "./actions";

type TimeOffRow = { id: string; startsOn: string; endsOn: string };

type StaffRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: StaffRole;
  branchId: string | null;
  active: boolean;
  lastLoginAt: string | null;
  hasPassword: boolean;
  timeOff: TimeOffRow[];
  /** Her own monthly discount code, or null before the first one is issued. */
  discount: StaffRowDiscount | null;
};

export type StaffRowDiscount = { id: string; code: string; percent: number; active: boolean; used: boolean };

const RANK: Record<StaffRole, number> = {
  technician: 1,
  receptionist: 2,
  admin: 3,
  ceo: 4,
};

export default function StaffView({
  staff,
  branches,
  currentUserId,
  currentRole,
}: {
  staff: StaffRow[];
  branches: { id: string; name: Localized }[];
  currentUserId: string;
  currentRole: StaffRole;
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { act } = usePendingAction();
  const [doomed, setDoomed] = useState<StaffRow | null>(null);

  const messageFor = (code: string) =>
    code === "cannot-escalate"
      ? t.staff.cannotEscalate
      : code === "last-ceo"
        ? t.staff.lastCeo
        : code === "email-taken"
          ? t.staff.emailTaken
          : code === "password-required"
            ? t.staff.passwordRequired
            : code === "bad-range"
              ? t.staff.badRange
              : code === "past-date"
                ? t.staff.dayOffPast(t.staff.from, riyadhDateKey())
              : code === "branch-required"
                ? t.staff.branchRequired
                : t.common.error;

  // Holds through the refresh, not just the action — see
  // components/admin/use-pending-action.
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    return act(fn, (code) => setError(messageFor(code)));
  };

  return (
    <>
      <PageHeader
        title={t.staff.title}
        subtitle={t.staff.subtitle}
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" strokeWidth={2} />
            {t.staff.invite}
          </Button>
        }
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
          {error}
        </p>
      ) : null}

      <Card className="overflow-hidden">
        {staff.length === 0 ? (
          <EmptyState title={t.staff.empty} icon={<IdCard className="h-8 w-8" strokeWidth={1.25} />} />
        ) : (
          <ul className="divide-y divide-black/[0.05]">
            {staff.map((s) => {
              // Anyone senior to you is read-only, matching the server guard.
              const locked = RANK[s.role] > RANK[currentRole];
              return (
                <li
                  key={s.id}
                  className={cn("flex flex-wrap items-center gap-3 px-4 py-3", !s.active && "opacity-55")}
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-red-grad text-xs font-bold text-white">
                    {s.name.charAt(0).toUpperCase()}
                  </span>

                  <button
                    disabled={locked}
                    onClick={() => setEditing(s)}
                    className="min-w-0 flex-1 text-start disabled:cursor-not-allowed"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{s.name}</span>
                      {s.id === currentUserId && <Badge tone="info">{t.staff.self}</Badge>}
                      {!s.active && <Badge tone="neutral">{t.catalog.inactive}</Badge>}
                    </span>
                    <span className="block truncate text-xs text-ink/45" dir="ltr">
                      {s.email}
                    </span>
                  </button>

                  <Badge tone={s.role === "ceo" ? "danger" : "neutral"}>
                    {ROLE_LABELS[s.role][lang]}
                  </Badge>

                  {/* Her code, on her row. It used to sit on the marketing
                      screen among the Eid and National Day campaigns, where it
                      read as one of them and could be edited like one. */}
                  <span
                    className="hidden w-32 shrink-0 text-start sm:block"
                    title={
                      s.discount
                        ? t.staff.discountCodeHint.replace("{percent}", String(s.discount.percent))
                        : undefined
                    }
                  >
                    {s.discount ? (
                      <>
                        <span
                          className={cn(
                            "block truncate font-mono text-xs font-semibold",
                            s.discount.active && !s.discount.used ? "text-ink" : "text-ink/35 line-through",
                          )}
                          dir="ltr"
                        >
                          {s.discount.code}
                        </span>
                        <span className="block truncate text-[10px] text-ink/40">
                          {s.discount.used ? t.staff.discountCodeUsed : `${s.discount.percent}%`}
                        </span>
                      </>
                    ) : (
                      <span className="text-[11px] text-ink/30">{t.staff.discountCodeNone}</span>
                    )}
                  </span>

                  <span className="hidden w-28 shrink-0 text-start text-[11px] text-ink/40 sm:block">
                    {s.lastLoginAt ? s.lastLoginAt.slice(0, 10) : t.staff.never}
                  </span>

                  <button
                    role="switch"
                    aria-checked={s.active}
                    aria-label={t.staff.active}
                    disabled={locked || s.id === currentUserId}
                    onClick={() => run(() => setStaffActive(s.id, !s.active))}
                    className={cn(
                      "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-30",
                      touchTargetSwitch,
                      s.active ? "bg-[#1f7a4d]" : "bg-black/15",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                        s.active ? "end-0.5" : "start-0.5",
                      )}
                    />
                  </button>

                  <button
                    disabled={locked || s.id === currentUserId}
                    onClick={() => setDoomed(s)}
                    className={`relative grid h-7 w-7 place-items-center rounded-lg text-ink/30 transition-colors hover:bg-red/[0.06] hover:text-red disabled:opacity-25 disabled:hover:bg-transparent ${touchTargetSm}`}
                    aria-label={t.catalog.delete}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={!!doomed}
        title={t.staff.deleteConfirm}
        body={doomed ? `${doomed.name}, ${doomed.email}. ${t.common.cannotUndo}` : undefined}
        cancelLabel={t.common.cancel}
        onConfirm={() => {
          if (doomed) run(() => deleteStaff(doomed.id));
          setDoomed(null);
        }}
        onClose={() => setDoomed(null)}
      />

      <StaffDrawer
        member={editing}
        open={creating || editing !== null}
        branches={branches}
        currentRole={currentRole}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          router.refresh();
        }}
        messageFor={messageFor}
      />
    </>
  );
}

function StaffDrawer({
  member,
  open,
  branches,
  currentRole,
  onClose,
  onSaved,
  messageFor,
}: {
  member: StaffRow | null;
  open: boolean;
  branches: { id: string; name: Localized }[];
  currentRole: StaffRole;
  onClose: () => void;
  onSaved: () => void;
  /** Server refusal code → sentence. Shown inside the drawer, not behind it. */
  messageFor: (code: string) => string;
}) {
  const { t, lang } = useAdminI18n();
  // Not a bare useTransition: on React 18 that ends at the first `await`, so
  // Save re-enabled itself while the staff record was still being written —
  // one impatient second click away from two saves.
  const { pending, run } = usePendingAction();
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<StaffRole>("receptionist");
  const [branchId, setBranchId] = useState("");
  const [password, setPassword] = useState("");
  const [active, setActive] = useState(true);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = member?.id ?? "new";
  if (open && loadedKey !== key) {
    setLoadedKey(key);
    setName(member?.name ?? "");
    setEmail(member?.email ?? "");
    setPhone(member?.phone ?? "");
    setRole(member?.role ?? "receptionist");
    setBranchId(member?.branchId ?? "");
    setPassword("");
    setActive(member?.active ?? true);
    setTried(false);
    setError(null);
  }
  if (!open && loadedKey !== null) setLoadedKey(null);

  if (!open) return null;

  // Only roles at or below your own — mirrors the server-side escalation guard.
  const assignable = (["ceo", "admin", "receptionist", "technician"] as StaffRole[]).filter(
    (r) => RANK[r] <= RANK[currentRole],
  );

  // Same rule the server refuses on — see mustHaveBranch.
  const needsBranch = mustHaveBranch(role);

  const check = () => ({
    ...checkStaff(t, { name, email, phone, password, isNew: !member }),
    ...collect({ branchId: needsBranch && !branchId && t.staff.branchRequired }),
  });
  const errors = tried ? check() : {};

  const submit = () =>
    run(async () => {
      setError(null);
      setTried(true);
      if (hasErrors(check())) {
        focusFirstInvalid();
        return false;
      }
      const res = await saveStaff({
        id: member?.id,
        name: name.trim(),
        email: email.trim(),
        phone,
        role,
        branchId: branchId || null,
        password: password || "",
        active,
      });
      // onSaved() closes the drawer and refreshes the list itself, so this
      // does not ask for a second one.
      if (res.ok) onSaved();
      else setError(messageFor(res.error));
      return false;
    });

  return (
    <Drawer
      open
      onClose={onClose}
      title={member ? t.staff.edit : t.staff.invite}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
            {t.common.cancel}
          </Button>
          <Button size="sm" disabled={pending} onClick={submit}>
            {pending ? t.common.saving : t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <TextField
          label={t.staff.name}
          {...PERSON_TEXT}
          max={PERSON_NAME_MAX}
          error={errors.name}
          value={name}
          onChange={setName}
        />

        <TextField
          label={t.staff.email}
          {...EMAIL_TEXT}
          max={EMAIL_MAX}
          error={errors.email}
          value={email}
          onChange={setEmail}
        />

        <Field label={t.staff.phone} error={errors.phone}>
          <Input
            inputMode="tel"
            dir="ltr"
            className="text-left tabular-nums"
            placeholder="05XXXXXXXX"
            aria-invalid={!!errors.phone}
            value={phone}
            onChange={(e) => setPhone(typedPhone(e.target.value))}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.staff.role}>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as StaffRole)}
              className="h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm text-ink outline-none focus:border-sky"
            >
              {assignable.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r][lang]}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t.staff.branch} error={errors.branchId}>
            <select
              value={branchId}
              aria-invalid={!!errors.branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className={cn(
                "h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm text-ink outline-none focus:border-sky",
                invalidRing,
              )}
            >
              <option value="" disabled={needsBranch}>
                {needsBranch ? t.staff.pickBranch : t.staff.allBranches}
              </option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {pick(b.name, lang)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label={t.staff.password}
          hint={member ? t.staff.passwordHint : t.staff.passwordRule}
          error={errors.password}
        >
          <Input
            type="password"
            dir="ltr"
            className="text-left"
            maxLength={PASSWORD_MAX}
            aria-invalid={!!errors.password}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 accent-red"
          />
          {t.staff.active}
        </label>

        {/* Only for the people the assignment run actually deals work to.
            A receptionist's day off changes nothing any code reads. */}
        {member && role === "technician" && (
          <DaysOff member={member} onError={(code) => setError(messageFor(code))} />
        )}

        <FormErrors errors={errors} summary={t.validation.summary} server={error} />
      </div>
    </Drawer>
  );
}

/**
 * When a technician is not in.
 *
 * Native date inputs rather than a picker component: the browser already knows
 * how to render a calendar, in the user's own locale, and it hands back exactly
 * the `YYYY-MM-DD` the column stores.
 *
 * Saves immediately rather than waiting for the drawer's Save button — the ranges
 * are their own rows, and half-applying them alongside a cancelled name change
 * would be the confusing behaviour.
 */
function DaysOff({ member, onError }: { member: StaffRow; onError: (code: string) => void }) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const { pending, run: refreshAfter } = usePendingAction();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tried, setTried] = useState(false);

  const today = riyadhDateKey();
  const check = () => checkTimeOff(t, { from, to }, today, (k) => formatDateKey(k, lang));
  const errors = tried ? check() : {};

  const add = () =>
    refreshAfter(async () => {
      setTried(true);
      if (hasErrors(check())) {
        focusFirstInvalid();
        // Nothing was sent, so there is nothing to re-read.
        return false;
      }
      // An empty end means a single day, which is the common case — typing the
      // same date twice to book one day off is a small daily annoyance.
      const res = await addTimeOff({ staffId: member.id, startsOn: from, endsOn: to || from });
      if (!res.ok) {
        onError(res.error);
        return false;
      }
      setFrom("");
      setTo("");
      setTried(false);
    });

  const [doomed, setDoomed] = useState<TimeOffRow | null>(null);
  const drop = () =>
    refreshAfter(async () => {
      if (!doomed) return false;
      const res = await removeTimeOff(doomed.id);
      setDoomed(null);
      if (!res.ok) {
        onError(res.error);
        return false;
      }
    });

  return (
    <div className="border-t border-black/[0.06] pt-5">
      <ConfirmDialog
        open={!!doomed}
        title={t.common.deleteNamed(doomed ? dayRange(doomed.startsOn, doomed.endsOn) : "")}
        body={t.common.dayOffDeleteBody}
        pending={pending}
        onClose={() => setDoomed(null)}
        onConfirm={drop}
      />
      <p className="text-sm font-semibold text-ink">{t.staff.daysOff}</p>
      <p className="mt-1 text-xs text-ink/50">{t.staff.daysOffHint}</p>

      {member.timeOff.length === 0 ? (
        <p className="mt-3 text-xs text-ink/40">{t.staff.noDaysOff}</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {member.timeOff.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between rounded-xl bg-black/[0.03] px-3 py-2 text-sm text-ink"
            >
              <span dir="ltr">
                {r.startsOn === r.endsOn ? r.startsOn : `${r.startsOn} → ${r.endsOn}`}
              </span>
              <button
                type="button"
                onClick={() => setDoomed(r)}
                disabled={pending}
                className="text-ink/40 transition-colors hover:text-red disabled:opacity-40"
                aria-label={t.staff.removeDayOff}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Two native date inputs and a button will not share one row inside a
          448px drawer: the inputs have a wide intrinsic size and the button,
          last and shrinkable, is the one that gives — down to its min-content
          width, which broke "Add days off" across three lines. The dates keep
          the row; the button takes the one below and the full width of it. */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Field label={t.staff.from} error={errors.from}>
          <Input
            type="date"
            dir="ltr"
            min={today}
            aria-invalid={!!errors.from}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label={t.staff.to} error={errors.to}>
          <Input
            type="date"
            dir="ltr"
            aria-invalid={!!errors.to}
            min={from || today}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="mt-2 w-full"
        disabled={pending}
        onClick={add}
      >
        {t.staff.addDayOff}
      </Button>
    </div>
  );
}
