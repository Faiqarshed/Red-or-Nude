"use client";

// One table, two shapes.
//
// Seven admin screens each hand-rolled the same `<table>` with the same header,
// row and cell classes, and the same `min-w-[NNNpx]` that makes them scroll
// sideways rather than squash. That is right on a desk and wrong in a hand: at
// 375px a 760px table is eight hundred pixels of dragging to read one row.
//
// So a column is declared once and rendered twice — as a table from `sm` up,
// byte for byte what these screens rendered before, and as a stacked card below
// it, where each row becomes a title line plus its fields as labelled pairs.
// Declaring the columns rather than writing the markup is what keeps the two
// from drifting: there is no way to add a column to one and forget the other.

import { cn } from "@/lib/cn";

export type Column<T> = {
  /** React key, and the `<dt>` fallback when `header` is empty. */
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  /**
   * Extra `<td>` classes. Desktop only — the card lays itself out. Takes a
   * function where the cell is styled by its own row, such as the rail the
   * bookings list draws down the edge of a party.
   */
  className?: string | ((row: T) => string | false | undefined);
  /**
   * Set on the cell itself, not on something inside it. Phone numbers, codes
   * and dates are `ltr` in both languages, and `text-start` has to resolve
   * against the same direction the digits run in or the column aligns away
   * from its own header in Arabic.
   */
  dir?: "ltr" | "rtl";
  /**
   * The card's title line, shown on its own above the pairs. Exactly one column
   * should carry it: the field someone scans the list looking for.
   */
  primary?: boolean;
};

const HEAD_CELL =
  "px-4 py-2.5 text-start text-[11px] font-semibold uppercase tracking-wide text-ink/45";
const ROW = "border-b border-black/[0.04] last:border-0 hover:bg-black/[0.015]";

export function AdminTable<T>({
  rows,
  columns,
  rowKey,
  minWidth,
  onRowClick,
  rowClassName = ROW,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** The Tailwind class, e.g. `"min-w-[840px]"` — desktop only. */
  minWidth: string;
  onRowClick?: (row: T) => void;
  /**
   * Replaces the default row classes — a screen that wants no hover, or one
   * that tints and rules rows by what they are.
   */
  rowClassName?: string | ((row: T) => string | false | undefined);
}) {
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const rest = columns.filter((c) => c !== primary);
  const resolve = (v: string | ((row: T) => string | false | undefined) | undefined, row: T) =>
    typeof v === "function" ? v(row) : v;

  return (
    <>
      {/* Tables can exceed the viewport in either direction — scroll the
          container, never the page body. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className={cn("w-full text-sm", minWidth)}>
          <thead>
            <tr className="border-b border-black/[0.06] bg-black/[0.015]">
              {columns.map((c) => (
                <th key={c.key} className={HEAD_CELL}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(resolve(rowClassName, row), onRowClick && "cursor-pointer")}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    dir={c.dir}
                    className={cn("px-4 py-3 text-start", resolve(c.className, row))}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-black/[0.04] sm:hidden">
        {rows.map((row) => {
          const body = (
            <>
              <div className="text-sm text-ink">{primary.cell(row)}</div>
              {rest.length > 0 && (
                // `auto_1fr`: labels take the width of the longest one and the
                // values line up against it, which is the column the table gave
                // for free and a stack of loose pairs does not.
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  {rest.map((c) =>
                    // An unlabelled column is an action column — it takes the
                    // full width rather than sitting in the value track behind
                    // an empty label.
                    c.header ? (
                      <div key={c.key} className="contents">
                        <dt className="text-ink/45">{c.header}</dt>
                        <dd dir={c.dir} className="min-w-0 text-start text-ink/80">
                          {c.cell(row)}
                        </dd>
                      </div>
                    ) : (
                      <dd key={c.key} dir={c.dir} className="col-span-2 mt-1 text-start">
                        {c.cell(row)}
                      </dd>
                    ),
                  )}
                </dl>
              )}
            </>
          );

          return (
            <li key={rowKey(row)}>
              {onRowClick ? (
                <button
                  type="button"
                  onClick={() => onRowClick(row)}
                  className="w-full px-4 py-3 text-start"
                >
                  {body}
                </button>
              ) : (
                <div className="px-4 py-3 text-start">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
