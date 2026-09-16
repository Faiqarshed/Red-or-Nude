"use client";

// The pack shelf. Same shape as the catalog list next door — a row per pack,
// reorder, an active switch, click to edit — with one column that is this
// screen's own: what is in it, because a pack is nothing but that.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, ImageIcon, Package, Plus } from "lucide-react";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/admin/ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import type { Localized } from "@/lib/db/schema";
import PackDrawer from "./PackDrawer";
import { movePack, setPackActive } from "./actions";

export type PackLine = { serviceId: string; quantity: number };

export type PackRow = {
  id: string;
  name: Localized;
  description?: Localized | null;
  priceSar: number;
  validDays: number;
  image?: string | null;
  imageUrl?: string | null;
  active: boolean;
  sort: number;
  lines: PackLine[];
};

export type ServiceOption = {
  id: string;
  name: Localized;
  priceSar: number;
  active: boolean;
};

export default function PacksView({
  packs,
  services,
}: {
  packs: PackRow[];
  services: ServiceOption[];
}) {
  const { t, lang } = useAdminI18n();
  const router = useRouter();
  const [editing, setEditing] = useState<PackRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [, startTransition] = useTransition();

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  /** What a pack is worth at list price, so the discount is visible while pricing it. */
  const listPrice = (row: PackRow) =>
    row.lines.reduce(
      (sum, l) => sum + (services.find((s) => s.id === l.serviceId)?.priceSar ?? 0) * l.quantity,
      0,
    );

  return (
    <>
      <PageHeader
        title={t.packs.title}
        subtitle={t.packs.subtitle}
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" strokeWidth={2} />
            {t.packs.newPack}
          </Button>
        }
      />

      <Card className="overflow-hidden">
        {packs.length === 0 ? (
          <EmptyState
            title={t.packs.empty}
            icon={<Package className="h-8 w-8" strokeWidth={1.25} />}
          />
        ) : (
          <ul className="divide-y divide-black/[0.05]">
            {packs.map((row, i) => {
              const list = listPrice(row);
              const uses = row.lines.reduce((sum, l) => sum + l.quantity, 0);
              return (
                <li
                  key={row.id}
                  className={cn(
                    // Same shape as the catalogue list next door: the price and
                    // the controls take a second line on a phone, so the name is
                    // not left with fifty pixels to truncate into.
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

                  <button onClick={() => setEditing(row)} className="min-w-0 flex-1 text-start">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{row.name[lang]}</span>
                      {!row.active && <Badge tone="neutral">{t.catalog.inactive}</Badge>}
                      {row.name.ar === row.name.en && (
                        <Badge tone="warning">{t.catalog.missingAr}</Badge>
                      )}
                    </span>
                    {/* What is in it, and how long it lasts — the two facts a
                        row of packs is scanned for. */}
                    <span className="mt-0.5 block text-xs text-ink/45">
                      {t.packs.usesAndDays
                        .replace("{uses}", String(uses))
                        .replace("{days}", String(row.validDays))}
                    </span>
                  </button>

                  {/* Price, reorder and the switch travel together: on a phone
                      they are the second line, spread across it. */}
                  <div className="flex shrink-0 items-center gap-4 max-sm:w-full max-sm:justify-between">
                    <span className="shrink-0 text-end max-sm:text-start">
                      <span className="text-sm font-semibold tabular-nums text-ink">
                        {row.priceSar.toLocaleString("en-US")}
                        <span className="ms-1 text-xs font-normal text-ink/45">{t.common.riyal}</span>
                      </span>
                      {/* Only when it actually is a saving. A pack priced at or
                          above its parts is a mistake worth seeing, not hiding. */}
                      {list > row.priceSar && (
                        <span className="block text-[11px] text-ink/40 line-through tabular-nums">
                          {list.toLocaleString("en-US")}
                        </span>
                      )}
                    </span>

                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        onClick={() => run(() => movePack(row.id, "up"))}
                        disabled={i === 0}
                        title={t.common.moveUp}
                        className="grid h-7 w-7 place-items-center rounded-lg text-ink/35 transition-colors hover:bg-black/[0.05] hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent"
                      >
                        <ChevronUp className="h-4 w-4" strokeWidth={2} />
                      </button>
                      <button
                        onClick={() => run(() => movePack(row.id, "down"))}
                        disabled={i === packs.length - 1}
                        title={t.common.moveDown}
                        className="grid h-7 w-7 place-items-center rounded-lg text-ink/35 transition-colors hover:bg-black/[0.05] hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent"
                      >
                        <ChevronDown className="h-4 w-4" strokeWidth={2} />
                      </button>
                    </div>

                    <button
                      role="switch"
                      aria-checked={row.active}
                      aria-label={t.catalog.active}
                      title={t.catalog.activeHint}
                      onClick={() => run(() => setPackActive(row.id, !row.active))}
                      className={cn(
                        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky",
                        row.active ? "bg-[#1f7a4d]" : "bg-black/15",
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                          row.active ? "end-0.5" : "start-0.5",
                        )}
                      />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {(editing || creating) && (
        <PackDrawer
          row={editing}
          services={services}
          nextSort={packs.length}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
