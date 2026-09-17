"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, ImageIcon, Plus, Sparkles } from "lucide-react";
import { Badge, Button, Card, EmptyState, PageHeader, tabItem, tabTone, touchTargetSwitch } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import type { Localized } from "@/lib/db/schema";
import { usePendingAction } from "@/components/admin/use-pending-action";
import CatalogDrawer from "./CatalogDrawer";
import { moveCatalogItem, setCatalogActive, type CatalogKind } from "./actions";

/** One picture in an add-on's design picker. */
export type DesignRow = {
  id?: string;
  name: Localized;
  image?: string | null;
  imageUrl?: string | null;
};

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
  /** Add-ons: does this one open a picker instead of being a plain extra? */
  isSeasonal?: boolean;
  /** Add-ons: the pictures in that picker, in order. */
  designs?: DesignRow[];
  active: boolean;
  sort: number;
};

const TABS: {
  kind: CatalogKind;
  labelKey: "tabServices" | "tabAddons" | "tabUpsells" | "tabRemovals";
}[] = [
  { kind: "service", labelKey: "tabServices" },
  { kind: "addon", labelKey: "tabAddons" },
  { kind: "upsell", labelKey: "tabUpsells" },
  { kind: "removal", labelKey: "tabRemovals" },
];

export default function CatalogView({
  services,
  addons,
  upsells,
  removals,
}: {
  services: CatalogRow[];
  addons: CatalogRow[];
  /** Offered at checkout only — the coffee and cookie. Never beside a service. */
  upsells: CatalogRow[];
  removals: CatalogRow[];
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const [tab, setTab] = useState<CatalogKind>("service");
  const [editing, setEditing] = useState<CatalogRow | null>(null);
  const [creating, setCreating] = useState(false);
  const { run: refreshAfter } = usePendingAction();
  /** Why the last switch refused. Cleared by the next attempt. */
  const [toggleError, setToggleError] = useState<string | null>(null);

  const rows =
    tab === "service" ? services : tab === "addon" ? addons : tab === "upsell" ? upsells : removals;

  const newLabel =
    tab === "service"
      ? t.catalog.newService
      : tab === "addon"
        ? t.catalog.newAddon
        : tab === "upsell"
          ? t.catalog.newUpsell
          : t.catalog.newRemoval;

  // Holds through the refresh, not just the action — see
  // components/admin/use-pending-action for why startTransition could not.
  const run = (fn: () => Promise<unknown>) =>
    refreshAfter(async () => {
      await fn();
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

      {/* Two-by-two on a phone. Four across leaves about sixty pixels of text
          per tab, which breaks the longer labels over two lines and drags the
          whole strip out of square with them. */}
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-black/[0.06] bg-white p-1 sm:flex">
        {TABS.map(({ kind, labelKey }) => (
          <button
            key={kind}
            onClick={() => setTab(kind)}
            className={cn(
              tabItem,
              "flex-1 py-2 text-sm",
              tabTone(tab === kind),
            )}
          >
            {t.catalog[labelKey]}
          </button>
        ))}
      </div>

      {toggleError && (
        <p
          role="alert"
          className="mb-4 rounded-xl bg-red/[0.06] px-4 py-3 text-sm font-medium text-red"
        >
          {toggleError}
        </p>
      )}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState title={t.catalog.empty} icon={<Sparkles className="h-8 w-8" strokeWidth={1.25} />} />
        ) : (
          <ul className="divide-y divide-black/[0.05]">
            {rows.map((row, i) => (
              <li
                key={row.id}
                className={cn(
                  // Five things on one row leave the name about fifty pixels on
                  // a phone — enough to cut "Classic manicure" down to
                  // "Classic" and to stand the "same as English" warning on its
                  // end, one word per line. Below `sm` the price and the
                  // controls drop to a second line and give the name the row.
                  "flex flex-wrap items-center gap-4 px-4 py-3 transition-colors hover:bg-black/[0.015]",
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
                  <span className="mt-0.5 block text-xs text-ink/45">
                    {row.durationMin} {t.catalog.minutes}
                  </span>
                </button>

                {/* Price, reorder and the switch travel together: on a phone
                    they are the second line, spread across it. */}
                <div className="flex shrink-0 items-center gap-4 max-sm:w-full max-sm:justify-between">
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                    {row.priceSar.toLocaleString("en-US")}
                    <span className="ms-1 text-xs font-normal text-ink/45">{t.common.riyal}</span>
                  </span>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      onClick={() => run(() => moveCatalogItem(tab, row.id, "up"))}
                      disabled={i === 0}
                      title={t.common.moveUp}
                      className="grid h-10 w-10 place-items-center rounded-lg text-ink/35 transition-colors hover:bg-black/[0.05] hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent sm:h-7 sm:w-7"
                    >
                      <ChevronUp className="h-4 w-4" strokeWidth={2} />
                    </button>
                    <button
                      onClick={() => run(() => moveCatalogItem(tab, row.id, "down"))}
                      disabled={i === rows.length - 1}
                      title={t.common.moveDown}
                      className="grid h-10 w-10 place-items-center rounded-lg text-ink/35 transition-colors hover:bg-black/[0.05] hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent sm:h-7 sm:w-7"
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
                    onClick={() =>
                      refreshAfter(async () => {
                        setToggleError(null);
                        const res = await setCatalogActive(tab, row.id, !row.active);
                        if (res.ok) return;
                        // Switching a second row on under a name that is taken.
                        // Nothing changed, so there is nothing to refresh for.
                        setToggleError(
                          res.error === "duplicate-name"
                            ? t.catalog.duplicateName
                            : t.common.error,
                        );
                        return false;
                      })
                    }
                    className={cn(
                      "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                      touchTargetSwitch,
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
                </div>
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
