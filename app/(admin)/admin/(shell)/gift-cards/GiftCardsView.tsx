"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Gift, Plus, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader } from "@/components/admin/ui";
import { Drawer } from "@/components/admin/overlays";
import MediaPicker from "@/components/admin/MediaPicker";
import { useAdminI18n } from "@/lib/admin/i18n";
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
  const [, startTransition] = useTransition();

  const [tab, setTab] = useState<"issued" | "setup">("issued");
  const [issuing, setIssuing] = useState(false);
  const [selected, setSelected] = useState<CardRow | null>(null);
  const [editDesign, setEditDesign] = useState<DesignRow | null>(null);
  const [newDesign, setNewDesign] = useState(false);
  const [newValue, setNewValue] = useState("");

  const run = (fn: () => Promise<{ ok: boolean }>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

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
              "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              tab === v ? "bg-red/[0.07] text-red" : "text-ink/55 hover:bg-black/[0.03]",
            )}
          >
            {v === "issued" ? t.giftCards.tabIssued : t.giftCards.tabSetup}
          </button>
        ))}
      </div>

      {tab === "issued" ? (
        <Card className="overflow-hidden">
          {cards.length === 0 ? (
            <EmptyState title={t.giftCards.empty} icon={<Gift className="h-8 w-8" strokeWidth={1.25} />} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-black/[0.06] bg-black/[0.015]">
                    {[t.giftCards.code, t.giftCards.recipient, t.giftCards.balance, t.giftCards.status, t.giftCards.issuedAt].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-start text-[11px] font-semibold uppercase tracking-wide text-ink/45">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cards.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => setSelected(c)}
                      className="cursor-pointer border-b border-black/[0.04] last:border-0 hover:bg-black/[0.015]"
                    >
                      <td className="px-4 py-3 text-start font-medium tabular-nums text-ink" dir="ltr">
                        {c.code}
                      </td>
                      <td className="px-4 py-3 text-start text-ink/70">
                        {c.recipientName || c.recipientEmail || "—"}
                      </td>
                      <td className="px-4 py-3 text-start tabular-nums">
                        <span className="font-semibold text-ink">{c.balanceSar.toLocaleString("en-US")}</span>
                        <span className="text-ink/35"> / {c.initialSar.toLocaleString("en-US")}</span>
                      </td>
                      <td className="px-4 py-3 text-start">
                        <Badge tone={STATUS_TONE[c.status]}>{t.giftCards.statuses[c.status]}</Badge>
                      </td>
                      <td className="px-4 py-3 text-start text-xs tabular-nums text-ink/50" dir="ltr">
                        {c.createdAt.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                      onClick={() => run(() => deleteGiftValue(v.id))}
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
              <div className="flex items-end gap-2 border-t border-black/[0.06] p-4">
                <Field label={t.giftCards.amount}>
                  <Input
                    type="number"
                    min={1}
                    dir="ltr"
                    className="text-left tabular-nums"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                  />
                </Field>
                <Button
                  onClick={() => {
                    const n = Number(newValue);
                    if (!n) return;
                    run(() => addGiftValue(n));
                    setNewValue("");
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

      <IssueDrawer
        open={issuing}
        designs={designs}
        values={values}
        onClose={() => setIssuing(false)}
        onDone={() => {
          setIssuing(false);
          router.refresh();
        }}
      />

      <CardDrawer
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
  const [pending, startTransition] = useTransition();

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const res = await issueCard({
        amountSar: amount,
        designId: designId || null,
        buyerName,
        recipientName,
        recipientEmail,
        message,
      });
      if (res.ok && res.code) setIssued(res.code);
      else setError(t.common.error);
    });

  return (
    <Drawer
      open={open}
      onClose={() => {
        setIssued(null);
        onClose();
      }}
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
            <Button size="sm" onClick={submit} disabled={pending || !Number(amount)}>
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
          <Field label={`${t.giftCards.amount} (${t.common.riyal})`}>
            <Input
              type="number"
              min={1}
              dir="ltr"
              className="text-left tabular-nums"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>

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

          <Field label={t.giftCards.buyer}>
            <Input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
          </Field>
          <Field label={t.giftCards.recipient}>
            <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
          </Field>
          <Field label={t.customers.email}>
            <Input
              type="email"
              dir="ltr"
              className="text-left"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
            />
          </Field>
          <Field label={t.giftCards.message}>
            <Input value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>

          {error ? (
            <p role="alert" className="rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
              {error}
            </p>
          ) : null}
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
  const [pending, startTransition] = useTransition();

  if (!card) return null;

  const apply = () =>
    startTransition(async () => {
      setError(null);
      const res = await adjustCard({ id: card.id, amountSar: amount, reason });
      if (res.ok) onChanged();
      else setError(res.error === "insufficient" ? t.giftCards.insufficient : t.common.error);
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
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.giftCards.adjustAmount}>
                <Input
                  type="number"
                  dir="ltr"
                  className="text-left tabular-nums"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field label={t.giftCards.adjustReason}>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={apply} disabled={pending || !Number(amount) || !reason.trim()}>
                {t.giftCards.adjust}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => startTransition(async () => {
                  await cancelCard(card.id);
                  onChanged();
                })}
              >
                {t.giftCards.cancelCard}
              </Button>
            </div>
            {error ? (
              <p role="alert" className="rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
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
  const { t } = useAdminI18n();
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [pending, startTransition] = useTransition();

  // Reset when the drawer opens onto a different design.
  const key = design?.id ?? "new";
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (open && loadedKey !== key) {
    setLoadedKey(key);
    setNameAr(design?.name.ar ?? "");
    setNameEn(design?.name.en ?? "");
    setImage(design?.image ?? null);
    setActive(design?.active ?? true);
  }
  if (!open && loadedKey !== null) setLoadedKey(null);

  if (!open) return null;

  return (
    <Drawer
      open
      onClose={onClose}
      title={t.giftCards.designs}
      footer={
        <>
          {design ? (
            <button
              onClick={() => startTransition(async () => {
                await deleteGiftDesign(design.id);
                onSaved();
              })}
              className="me-auto text-xs text-red hover:underline"
            >
              {t.catalog.delete}
            </button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            size="sm"
            disabled={pending || !nameAr.trim() || !nameEn.trim()}
            onClick={() => startTransition(async () => {
              await saveGiftDesign({ id: design?.id, nameAr, nameEn, image, active });
              onSaved();
            })}
          >
            {pending ? t.common.saving : t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.catalog.nameAr}>
            <Input dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
          </Field>
          <Field label={t.catalog.nameEn}>
            <Input dir="ltr" className="text-left" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </Field>
        </div>
        <MediaPicker label={t.catalog.image} value={image} onChange={setImage} />
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 accent-red"
          />
          {t.catalog.active}
        </label>
      </div>
    </Drawer>
  );
}
