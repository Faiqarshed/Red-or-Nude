"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, ImageIcon, Plus, Sparkles } from "lucide-react";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import type { Localized } from "@/lib/db/schema";
import CatalogDrawer from "./CatalogDrawer";
import { moveCatalogItem, setCatalogActive, type CatalogKind } from "./actions";

export type CatalogRow = {
  id: string;
  name: Localized;
  description?: Localized | null;
  priceSar: number;
  durationMin: number;
  /** Services only: length of the follow-up refill window, 0 = none. */
  refillDays?: number;
  image?: string | null;
  imageUrl?: string | null;
  isSeasonal?: boolean;
  active: boolean;
  sort: number;
};

const TABS: {
  kind: CatalogKind;
  labelKey: "tabServices" | "tabAddons" | "tabRemovals" | "tabDesigns";
}[] = [
  { kind: "service", labelKey: "tabServices" },
  { kind: "addon", labelKey: "tabAddons" },
  { kind: "removal", labelKey: "tabRemovals" },
  { kind: "design", labelKey: "tabDesigns" },
];

export default function CatalogView({
  services,
  addons,
  removals,
  designs,
}: {
  services: CatalogRow[];
  addons: CatalogRow[];
  removals: CatalogRow[];
  /** The seasonal pop-up, one row per picture. */
  designs: CatalogRow[];
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const [tab, setTab] = useState<CatalogKind>("service");
  const [editing, setEditing] = useState<CatalogRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [, startTransition] = useTransition();

  const rows =
    tab === "service"
      ? services
      : tab === "addon"
        ? addons
        : tab === "removal"
          ? removals
          : designs;

  const newLabel =
    tab === "service"
      ? t.catalog.newService
      : tab === "addon"
        ? t.catalog.newAddon
        : tab === "removal"
          ? t.catalog.newRemoval
          : t.catalog.newDesign;

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  return (
    <>
      <PageHeader
        title={t.catalog.title}
        subtitle={t.catalog.subtitle}
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" strokeWidth={2} />
            {newLabel}
          </Button>
        }
      />

      <div className="mb-4 flex gap-1 rounded-xl border border-black/[0.06] bg-white p-1">
        {TABS.map(({ kind, labelKey }) => (
          <button
            key={kind}
            onClick={() => setTab(kind)}
            className={cn(
              "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              tab === kind ? "bg-red/[0.07] text-red" : "text-ink/55 hover:bg-black/[0.03]",
            )}
          >
            {t.catalog[labelKey]}
          </button>
        ))}
      </div>

      {/* The one tab whose rows are not something a customer buys, so it says
          where they actually turn up. */}
      {tab === "design" ? (
        <p className="mb-4 text-start text-xs text-ink/55">{t.catalog.designsHint}</p>
      ) : null}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState title={t.catalog.empty} icon={<Sparkles className="h-8 w-8" strokeWidth={1.25} />} />
        ) : (
          <ul className="divide-y divide-black/[0.05]">
            {rows.map((row, i) => (
              <li
                key={row.id}
                className={cn(
                  "flex items-center gap-4 px-4 py-3 transition-colors hover:bg-black/[0.015]",
                  !row.active && "opacity-55",
                )}
              >
                <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-black/[0.04]">
                  {row.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={row.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <ImageIcon className="h-4 w-4 text-ink/20" strokeWidth={1.5} />
                  )}
                </div>

                <button
                  onClick={() => setEditing(row)}
                  className="min-w-0 flex-1 text-start"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{row.name[lang]}</span>
                    {row.isSeasonal && <Badge tone="info">{t.catalog.seasonal}</Badge>}
                    {!row.active && <Badge tone="neutral">{t.catalog.inactive}</Badge>}
                    {/* The seed copied English into the Arabic column where no
                        Arabic name existed — surface that instead of hiding it. */}
                    {row.name.ar === row.name.en && (
                      <Badge tone="warning">{t.catalog.missingAr}</Badge>
                    )}
                  </span>
                  {tab === "design" ? null : (
                    <span className="mt-0.5 block text-xs text-ink/45">
                      {row.durationMin} {t.catalog.minutes}
                    </span>
                  )}
                </button>

                {tab === "design" ? null : (
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                    {row.priceSar.toLocaleString("en-US")}
                    <span className="ms-1 text-xs font-normal text-ink/45">{t.common.riyal}</span>
                  </span>
                )}

                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    onClick={() => run(() => moveCatalogItem(tab, row.id, "up"))}
                    disabled={i === 0}
                    title={t.common.moveUp}
                    className="grid h-7 w-7 place-items-center rounded-lg text-ink/35 transition-colors hover:bg-black/[0.05] hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent"
                  >
                    <ChevronUp className="h-4 w-4" strokeWidth={2} />
                  </button>
                  <button
                    onClick={() => run(() => moveCatalogItem(tab, row.id, "down"))}
                    disabled={i === rows.length - 1}
                    title={t.common.moveDown}
                    className="grid h-7 w-7 place-items-center rounded-lg text-ink/35 transition-colors hover:bg-black/[0.05] hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent"
                  >
                    <ChevronDown className="h-4 w-4" strokeWidth={2} />
                  </button>
                </div>

                {/* Plain stateful button rather than a peer-styled checkbox:
                    `peer-checked:` only matches siblings, so it can't drive a
                    knob nested inside the track. */}
                <button
                  role="switch"
                  aria-checked={row.active}
                  aria-label={t.catalog.active}
                  title={t.catalog.activeHint}
                  onClick={() => run(() => setCatalogActive(tab, row.id, !row.active))}
                  className={cn(
                    "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky",
                    row.active ? "bg-[#1f7a4d]" : "bg-black/15",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                      // Logical positioning so the knob slides the right way in RTL.
                      row.active ? "end-0.5" : "start-0.5",
                    )}
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CatalogDrawer
        kind={tab}
        row={editing}
        open={creating || editing !== null}
        nextSort={rows.length}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          router.refresh();
        }}
      />
    </>
  );
}
