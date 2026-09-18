"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Gift, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  FormErrors,
  PageHeader, tabItem, tabTone} from "@/components/admin/ui";
import { ConfirmDialog, Drawer } from "@/components/admin/overlays";
import { usePendingAction } from "@/components/admin/use-pending-action";
import { AdminTable } from "@/components/admin/Table";
import MediaPicker from "@/components/admin/MediaPicker";
import TextField, { NumberField, TextPair } from "@/components/admin/TextField";
import { useAdminI18n } from "@/lib/admin/i18n";
import {
  ADJUST_MAX,
  ADJUST_REASON_MAX,
  ADJUST_TEXT,
  arScript,
  checkNote,
  checkPersonName,
  collect,
  EMAIL_MAX,
  EMAIL_TEXT,
  focusFirstInvalid,
  GIFT_MESSAGE_MAX,
  hasErrors,
  NAME_MAX,
  NOTES_TEXT,
  PERSON_NAME_MAX,
  PERSON_TEXT,
  rules,
} from "@/lib/admin/validate";
import { pick } from "@/lib/localized";
import { cn } from "@/lib/cn";
import type { Localized } from "@/lib/db/schema";
import {
  addGiftValue,
  adjustCard,
  cancelCard,
  deleteGiftDesign,
  deleteGiftValue,
  issueCard,
  saveGiftDesign,
} from "./actions";

type Txn = { id: string; deltaSar: number; reason: string | null; createdAt: string };
type CardRow = {
  id: string;
  code: string;
  initialSar: number;
  balanceSar: number;
  status: "active" | "redeemed" | "expired" | "cancelled";
  buyerName: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  message: string | null;
  expiresAt: string | null;
  createdAt: string;
  txns: Txn[];
};
type DesignRow = {
  id: string;
  name: Localized;
  image: string | null;
  imageUrl: string | null;
  active: boolean;
};

const STATUS_TONE = {
  active: "success",
  redeemed: "neutral",
  expired: "warning",
  cancelled: "danger",
} as const;

export default function GiftCardsView({
  cards,
  values,
  designs,
  canAdjust,
}: {
  cards: CardRow[];
  values: { id: string; amountSar: number }[];
  designs: DesignRow[];
  canAdjust: boolean;
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const { act } = usePendingAction();

  const [tab, setTab] = useState<"issued" | "setup">("issued");
  const [issuing, setIssuing] = useState(false);
  const [selected, setSelected] = useState<CardRow | null>(null);
  const [editDesign, setEditDesign] = useState<DesignRow | null>(null);
  const [newDesign, setNewDesign] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [valueTried, setValueTried] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [doomedValue, setDoomedValue] = useState<{ id: string; amountSar: number } | null>(null);
  const { pending: deletingValue, run: refreshAfterDelete } = usePendingAction();
  const [valueDeleteError, setValueDeleteError] = useState<string | null>(null);

  // Holds through the refresh, not just the action — see
  // components/admin/use-pending-action.
  const run = (fn: () => Promise<{ ok: boolean }>) => {
    setSetupError(null);
    return act(fn, () => setSetupError(t.common.error));
  };

  const deleteValue = () =>
    refreshAfterDelete(async () => {
      if (!doomedValue) return false;
      setValueDeleteError(null);
      const res = await deleteGiftValue(doomedValue.id);
      if (!res.ok) return setValueDeleteError(t.common.error);
      setDoomedValue(null);
      router.refresh();
    });

  // Same ceiling a card can be issued at — a value nobody can buy is no use.
  // Whole riyals: these are the buttons on the public page, and a duplicate
  // would show the same amount twice.
  const valueCheck =
    rules(t.validation).number(t.giftCards.amount, newValue, { int: true, positive: true, max: ADJUST_MAX }) ??
    (values.some((v) => v.amountSar === Number(newValue))
      ? t.giftCards.valueTaken(Number(newValue).toLocaleString("en-US"))
      : undefined);
  const valueError = valueTried ? valueCheck : undefined;

  return (
    <>
      <PageHeader
        title={t.giftCards.title}
        subtitle={t.giftCards.subtitle}
        action={
          <Button onClick={() => setIssuing(true)}>
            <Plus className="h-4 w-4" strokeWidth={2} />
            {t.giftCards.issue}
          </Button>
        }
      />

      <div className="mb-4 flex gap-1 rounded-xl border border-black/[0.06] bg-white p-1">
        {(["issued", "setup"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            className={cn(
              tabItem,
              "flex-1 py-2 text-sm",
              tabTone(tab === v),
            )}
          >
            {v === "issued" ? t.giftCards.tabIssued : t.giftCards.tabSetup}
          </button>
        ))}
      </div>

      {setupError ? (
        <p role="alert" className="mb-4 rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
          {setupError}
        </p>
      ) : null}

      {tab === "issued" ? (
        <Card className="overflow-hidden">
          {cards.length === 0 ? (
            <EmptyState title={t.giftCards.empty} icon={<Gift className="h-8 w-8" strokeWidth={1.25} />} />
          ) : (
            <AdminTable
              rows={cards}
              rowKey={(c) => c.id}
              minWidth="min-w-[720px]"
              onRowClick={(c) => setSelected(c)}
              columns={[
                {
                  key: "code",
                  header: t.giftCards.code,
                  primary: true,
                  className: "font-medium tabular-nums text-ink",
                  dir: "ltr",
                  cell: (c) => c.code,
                },
                {
                  key: "recipient",
                  header: t.giftCards.recipient,
                  className: "text-ink/70",
                  cell: (c) => c.recipientName || c.recipientEmail || "—",
                },
                {
                  key: "balance",
                  header: t.giftCards.balance,
                  className: "tabular-nums",
                  cell: (c) => (
                    <>
                      <span className="font-semibold text-ink">
                        {c.balanceSar.toLocaleString("en-US")}
                      </span>
                      <span className="text-ink/35"> / {c.initialSar.toLocaleString("en-US")}</span>
                    </>
                  ),
                },
                {
                  key: "status",
                  header: t.giftCards.status,
                  cell: (c) => (
                    <Badge tone={STATUS_TONE[c.status]}>{t.giftCards.statuses[c.status]}</Badge>
                  ),
                },
                {
                  key: "issuedAt",
                  header: t.giftCards.issuedAt,
                  className: "text-xs tabular-nums text-ink/50",
                  dir: "ltr",
                  cell: (c) => c.createdAt.slice(0, 10),
                },
              ]}
            />
          )}
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title={t.giftCards.values} />
            <ul className="flex flex-wrap gap-2 p-4">
              {values.map((v) => (
                <li
                  key={v.id}
                  className="flex items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-3 py-2"
                >
                  <span className="text-sm font-semibold tabular-nums text-ink">
                    {v.amountSar.toLocaleString("en-US")}
                  </span>
                  {canAdjust && (
                    <button
                      onClick={() => {
                        setValueDeleteError(null);
                        setDoomedValue(v);
                      }}
                      className="text-ink/30 transition-colors hover:text-red"
                      aria-label={t.catalog.delete}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {canAdjust && (
              <div className="flex items-start gap-2 border-t border-black/[0.06] p-4">
                <div className="flex-1">
                  <NumberField
                    label={`${t.giftCards.amount} (${t.common.riyal})`}
                    error={valueError}
                    maxDigits={5}
                    value={newValue}
                    onChange={setNewValue}
                  />
                </div>
                <Button
                  className="mt-6"
                  onClick={() => {
                    setValueTried(true);
                    if (valueCheck) return focusFirstInvalid();
                    run(() => addGiftValue(Number(newValue)));
                    setNewValue("");
                    setValueTried(false);
                  }}
                >
                  <Plus className="h-4 w-4" strokeWidth={2} />
                  {t.giftCards.addValue}
                </Button>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title={t.giftCards.designs}
              action={
                canAdjust ? (
                  <Button size="sm" variant="secondary" onClick={() => setNewDesign(true)}>
                    <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                    {t.common.add}
                  </Button>
                ) : null
              }
            />
            <ul className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
              {designs.map((d) => (
                <li key={d.id}>
                  <button
                    onClick={() => canAdjust && setEditDesign(d)}
                    className={cn(
                      "block w-full overflow-hidden rounded-xl border border-black/[0.06] bg-white text-start transition-colors hover:border-sky",
                      !d.active && "opacity-50",
                    )}
                  >
                    <span className="block aspect-[3/2] bg-black/[0.03]">
                      {d.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={d.imageUrl} alt="" className="h-full w-full object-cover" />
                      ) : null}
                    </span>
                    <span className="block truncate px-2 py-1.5 text-[11px] text-ink">
                      {pick(d.name, lang)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={!!doomedValue}
        title={t.common.deleteNamed(doomedValue ? `${doomedValue.amountSar.toLocaleString("en-US")} ${t.common.riyal}` : "")}
        body={t.common.valueDeleteBody}
        pending={deletingValue}
        error={valueDeleteError}
        onClose={() => setDoomedValue(null)}
        onConfirm={deleteValue}
      />

      {/* Mounted only while open, so every card starts from a blank form. */}
      {issuing && (
        <IssueDrawer
          open
          designs={designs}
          values={values}
          onClose={() => setIssuing(false)}
          onDone={() => {
            setIssuing(false);
            router.refresh();
          }}
        />
      )}

      <CardDrawer
        key={selected?.id ?? "none"}
        card={selected}
        canAdjust={canAdjust}
        onClose={() => setSelected(null)}
        onChanged={() => {
          setSelected(null);
          router.refresh();
        }}
      />

      <DesignDrawer
        design={editDesign}
        open={newDesign || editDesign !== null}
        onClose={() => {
          setNewDesign(false);
          setEditDesign(null);
        }}
        onSaved={() => {
          setNewDesign(false);
          setEditDesign(null);
          router.refresh();
        }}
      />
    </>
  );
}

function IssueDrawer({
  open,
  designs,
  values,
  onClose,
  onDone,
}: {
  open: boolean;
  designs: DesignRow[];
  values: { id: string; amountSar: number }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, lang } = useAdminI18n();
  const [amount, setAmount] = useState("");
  const [designId, setDesignId] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [message, setMessage] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const { pending, run } = usePendingAction();

  const amountLabel = `${t.giftCards.amount} (${t.common.riyal})`;
  const r = rules(t.validation);
  const check = () =>
    collect({
      amount: r.number(amountLabel, amount, { int: true, min: 1, max: ADJUST_MAX }),
      buyerName: checkPersonName(t.validation, t.giftCards.buyer, buyerName, { required: false }),
      recipientName: checkPersonName(t.validation, t.giftCards.recipient, recipientName, { required: false }),
      recipientEmail: r.email(t.customers.email, recipientEmail, { max: EMAIL_MAX }),
      message: checkNote(t.validation, t.giftCards.message, message, { required: false, max: GIFT_MESSAGE_MAX }),
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
      const res = await issueCard({
        amountSar: amount,
        designId: designId || null,
        buyerName: buyerName.trim(),
        recipientName: recipientName.trim(),
        recipientEmail: recipientEmail.trim(),
        message: message.trim(),
      });
      if (res.ok && res.code) setIssued(res.code);
      else setError(t.common.error);
    });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t.giftCards.issue}
      footer={
        issued ? (
          <Button size="sm" onClick={onDone}>
            {t.common.save}
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
              {t.common.cancel}
            </Button>
            <Button size="sm" onClick={submit} disabled={pending}>
              {pending ? t.common.saving : t.giftCards.issue}
            </Button>
          </>
        )
      }
    >
      {issued ? (
        <div className="py-8 text-center">
          <p className="mb-3 text-sm text-ink/55">{t.giftCards.code}</p>
          <p className="font-display text-2xl font-bold tracking-wider text-red" dir="ltr">
            {issued}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          <NumberField label={amountLabel} error={errors.amount} maxDigits={5} value={amount} onChange={setAmount} />

          {values.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {values.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setAmount(String(v.amountSar))}
                  className="rounded-lg border border-black/10 px-3 py-1.5 text-xs tabular-nums text-ink/70 transition-colors hover:border-red hover:text-red"
                >
                  {v.amountSar.toLocaleString("en-US")}
                </button>
              ))}
            </div>
          )}

          <Field label={t.giftCards.designs}>
            <select
              value={designId}
              onChange={(e) => setDesignId(e.target.value)}
              className="h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-sm text-ink outline-none focus:border-sky"
            >
              <option value="">—</option>
              {designs.filter((d) => d.active).map((d) => (
                <option key={d.id} value={d.id}>
                  {pick(d.name, lang)}
                </option>
              ))}
            </select>
          </Field>

          <TextField
            label={t.giftCards.buyer}
            {...PERSON_TEXT}
            max={PERSON_NAME_MAX}
            error={errors.buyerName}
            value={buyerName}
            onChange={setBuyerName}
          />
          <TextField
            label={t.giftCards.recipient}
            {...PERSON_TEXT}
            max={PERSON_NAME_MAX}
            error={errors.recipientName}
            value={recipientName}
            onChange={setRecipientName}
          />
          <TextField
            label={t.customers.email}
            {...EMAIL_TEXT}
            max={EMAIL_MAX}
            error={errors.recipientEmail}
            value={recipientEmail}
            onChange={setRecipientEmail}
          />
          <TextField
            label={t.giftCards.message}
            {...NOTES_TEXT}
            rows={3}
            max={GIFT_MESSAGE_MAX}
            error={errors.message}
            value={message}
            onChange={setMessage}
          />

          <FormErrors errors={errors} summary={t.validation.summary} server={error} />
        </div>
      )}
    </Drawer>
  );
}

function CardDrawer({
  card,
  canAdjust,
  onClose,
  onChanged,
}: {
  card: CardRow | null;
  canAdjust: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useAdminI18n();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const { pending, run } = usePendingAction();
  const [confirmCancel, setConfirmCancel] = useState(false);

  if (!card) return null;

  const r = rules(t.validation);
  const sar = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const delta = Number(amount);
  const check = () =>
    collect({
      amount:
        r.number(t.giftCards.adjustAmount, amount, { min: -ADJUST_MAX, max: ADJUST_MAX, decimals: 2 }) ||
        (delta === 0 && t.validation.nonZero(t.giftCards.adjustAmount)) ||
        // The server refuses this too ("insufficient"); saying it here names the number.
        (card.balanceSar + delta < 0 && t.giftCards.deductTooMuch(sar(card.balanceSar))),
      reason: r.text(t.giftCards.adjustReason, reason, { min: 3, max: ADJUST_REASON_MAX, script: "any" }),
    });
  const errors = tried ? check() : {};
  // What the balance becomes, while she types, once the amount is a real one.
  const preview =
    amount && amount !== "-" && Number.isFinite(delta) && delta !== 0 && card.balanceSar + delta >= 0
      ? t.giftCards.newBalance(sar(card.balanceSar + delta))
      : undefined;

  const apply = () =>
    run(async () => {
      setError(null);
      setTried(true);
      if (hasErrors(check())) {
        focusFirstInvalid();
        return false;
      }
      const res = await adjustCard({ id: card.id, amountSar: amount, reason: reason.trim() });
      if (res.ok) onChanged();
      else
        setError(
          res.error === "insufficient"
            ? t.giftCards.insufficient
            : res.error === "not-found"
              ? t.validation.notFound
              : t.common.error,
        );
      // onChanged() closes this drawer and refreshes the list itself.
      return false;
    });

  return (
    <Drawer open onClose={onClose} title={card.code} wide>
      <div className="space-y-5">
        <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3">
          <Badge tone={STATUS_TONE[card.status]}>{t.giftCards.statuses[card.status]}</Badge>
          <span className="font-display text-2xl font-bold tabular-nums text-ink">
            {card.balanceSar.toLocaleString("en-US")}
            <span className="ms-1 text-xs font-normal text-ink/45">{t.common.riyal}</span>
          </span>
        </div>

        <dl className="divide-y divide-black/[0.05] rounded-xl border border-black/[0.06] bg-white px-4">
          {[
            [t.giftCards.initial, card.initialSar.toLocaleString("en-US")],
            [t.giftCards.buyer, card.buyerName || "—"],
            [t.giftCards.recipient, card.recipientName || card.recipientEmail || "—"],
            [t.giftCards.expires, card.expiresAt?.slice(0, 10) ?? "—"],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-4 py-3">
              <dt className="text-xs text-ink/50">{label}</dt>
              <dd className="text-end text-sm font-medium text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        {card.message ? (
          <p className="rounded-xl bg-black/[0.03] px-4 py-3 text-start text-xs text-ink/60">
            {card.message}
          </p>
        ) : null}

        {/* The ledger is the source of truth; the balance above is its running total. */}
        <div>
          <p className="mb-2 text-start text-xs font-medium text-ink/60">{t.giftCards.ledger}</p>
          {card.txns.length === 0 ? (
            <p className="rounded-xl bg-black/[0.02] py-4 text-center text-xs text-ink/40">
              {t.giftCards.noTxns}
            </p>
          ) : (
            <ul className="divide-y divide-black/[0.05] rounded-xl border border-black/[0.06] bg-white px-4">
              {card.txns.map((tx) => (
                <li key={tx.id} className="flex items-center justify-between gap-4 py-2.5">
                  <div className="text-start">
                    <p className="text-xs text-ink">{tx.reason ?? "—"}</p>
                    <p className="text-[10px] tabular-nums text-ink/40" dir="ltr">
                      {tx.createdAt.slice(0, 16).replace("T", " ")}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      tx.deltaSar < 0 ? "text-red" : "text-[#1f7a4d]",
                    )}
                    dir="ltr"
                  >
                    {tx.deltaSar > 0 ? "+" : ""}
                    {tx.deltaSar.toLocaleString("en-US")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {canAdjust && card.status !== "cancelled" ? (
          <div className="space-y-3 border-t border-black/[0.06] pt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <NumberField
                label={t.giftCards.adjustAmount}
                hint={preview}
                error={errors.amount}
                maxDigits={5}
                decimals={2}
                signed
                value={amount}
                onChange={setAmount}
              />
              <TextField
                label={t.giftCards.adjustReason}
                {...ADJUST_TEXT}
                max={ADJUST_REASON_MAX}
                error={errors.reason}
                value={reason}
                onChange={setReason}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={apply} disabled={pending}>
                {t.giftCards.adjust}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => setConfirmCancel(true)}
              >
                {t.giftCards.cancelCard}
              </Button>
            </div>
            <FormErrors errors={errors} summary={t.validation.summary} server={error} />
          </div>
        ) : null}

        {/* Cancelling strands whatever is left on the card, and nothing in the
            panel undoes it, so it gets asked once, with the amount named. */}
        <ConfirmDialog
          open={confirmCancel}
          title={t.giftCards.cancelTitle}
          body={t.giftCards.cancelBody(card.code, sar(card.balanceSar))}
          confirmLabel={t.giftCards.cancelCard}
          cancelLabel={t.giftCards.keepCard}
          pending={pending}
          onClose={() => setConfirmCancel(false)}
          onConfirm={() =>
            run(async () => {
              const res = await cancelCard(card.id);
              setConfirmCancel(false);
              if (res.ok) onChanged();
              else setError(t.common.error);
              return false;
            })
          }
        />
      </div>
    </Drawer>
  );
}

function DesignDrawer({
  design,
  open,
  onClose,
  onSaved,
}: {
  design: DesignRow | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useAdminI18n();
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { pending, run } = usePendingAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Reset when the drawer opens onto a different design.
  const key = design?.id ?? "new";
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (open && loadedKey !== key) {
    setLoadedKey(key);
    setNameAr(design?.name.ar ?? "");
    setNameEn(design?.name.en ?? "");
    setImage(design?.image ?? null);
    setActive(design?.active ?? true);
    setTried(false);
    setError(null);
    setConfirmDelete(false);
  }
  if (!open && loadedKey !== null) setLoadedKey(null);

  if (!open) return null;

  const r = rules(t.validation);
  const check = () =>
    collect({
      nameAr: r.text(t.catalog.nameAr, nameAr, { min: 2, max: NAME_MAX, script: arScript(nameAr, nameEn) }),
      nameEn: r.text(t.catalog.nameEn, nameEn, { min: 2, max: NAME_MAX, script: "en" }),
      // A design is its picture; without one the public page shows an empty tile.
      image: !image && t.giftCards.imageRequired,
    });
  const errors = tried ? check() : {};

  const save = () =>
    run(async () => {
      setError(null);
      setTried(true);
      if (hasErrors(check()) || !image) {
        focusFirstInvalid();
        return false;
      }
      const res = await saveGiftDesign({ id: design?.id, nameAr: nameAr.trim(), nameEn: nameEn.trim(), image, active });
      if (res.ok) onSaved();
      else setError(res.error === "bad-image" ? t.giftCards.imageRequired : t.common.error);
      return false;
    });

  const remove = () =>
    run(async () => {
      if (!design) return false;
      setDeleteError(null);
      const res = await deleteGiftDesign(design.id);
      if (res.ok) onSaved();
      else setDeleteError(res.error === "in-use" ? t.giftCards.designInUse : t.common.error);
      return false;
    });

  return (
    <Drawer
      open
      onClose={onClose}
      title={t.giftCards.designs}
      footer={
        <>
          {design ? (
            <button
              onClick={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
              disabled={pending}
              className="me-auto text-xs text-red hover:underline disabled:opacity-50"
            >
              {t.catalog.delete}
            </button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button size="sm" disabled={pending} onClick={save}>
            {pending ? t.common.saving : t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <TextPair
          labels={[t.catalog.nameAr, t.catalog.nameEn]}
          max={NAME_MAX}
          errors={[errors.nameAr, errors.nameEn]}
          values={[nameAr, nameEn]}
          onChange={[setNameAr, setNameEn]}
        />
        <div>
          <MediaPicker label={t.catalog.image} value={image} onChange={setImage} />
          {errors.image ? <p className="mt-1 text-start text-xs text-red">{errors.image}</p> : null}
        </div>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 accent-red"
          />
          {t.catalog.active}
        </label>

        <FormErrors errors={errors} summary={t.validation.summary} server={error} />

        <ConfirmDialog
          open={confirmDelete}
          title={t.common.deleteNamed(design ? pick(design.name, lang) : "")}
          body={t.common.designDeleteBody}
          pending={pending}
          error={deleteError}
          onClose={() => setConfirmDelete(false)}
          onConfirm={remove}
        />
      </div>
    </Drawer>
  );
}
