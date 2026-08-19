// Printable QR stickers, one per chair (brief §2.7).
//
// Each sticker encodes /station/<qr_token> — the page a customer already in the
// chair scans to add a service. Server-rendered as inline SVG: no image host, no
// client bundle, and nothing to go stale, since the token lives in the row and
// the QR is regenerated on every load.
//
// Deliberately a separate page rather than a column on the availability screen.
// This one exists to be sent to a printer, and a print stylesheet fighting the
// admin shell is more work than a page that was never part of it.

import { asc, eq } from "drizzle-orm";
import qrcode from "qrcode-generator";
import { db } from "@/lib/db";
import { branches, stations } from "@/lib/db/schema";
import { requirePage } from "@/lib/auth/guard";
import { siteOrigin } from "@/lib/site";
import { scopedBranchId } from "@/lib/auth/rbac";

export const dynamic = "force-dynamic";

/** Type 0 = smallest version that fits; "M" tolerates a smudged sticker. */
function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  // `false` keeps the SVG scalable rather than pinning it to a pixel size, so
  // the print size is decided by CSS below.
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export default async function StationQrPage({
  searchParams,
}: {
  searchParams: { branch?: string };
}) {
  const user = await requirePage("availability.manage");

  const branchRows = await db.select().from(branches).orderBy(asc(branches.sort));
  const pinned = scopedBranchId(user.role, user.branchId);
  const branchId =
    pinned ??
    (searchParams.branch && branchRows.some((b) => b.id === searchParams.branch)
      ? searchParams.branch
      : branchRows[0]?.id);

  const rows = branchId
    ? await db
        .select()
        .from(stations)
        .where(eq(stations.branchId, branchId))
        .orderBy(asc(stations.sort))
    : [];

  const origin = siteOrigin();
  const branchName = branchRows.find((b) => b.id === branchId)?.name;

  return (
    <div className="p-6 print:p-0">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <div>
          <h1 className="font-display text-xl font-extrabold text-ink">Station QR codes</h1>
          <p className="mt-1 text-sm text-ink/55">
            One sticker per chair. Scanning opens the add-a-service page for that table.
          </p>
        </div>
      </div>

      {/* Retired chairs are printed too, greyed: their token still exists, and a
          chair usually comes back. The page they open refuses while inactive. */}
      <div className="grid grid-cols-2 gap-6 md:grid-cols-3 print:grid-cols-3">
        {rows.map((s) => (
          <div
            key={s.id}
            className="break-inside-avoid rounded-2xl border border-black/10 bg-white p-5 text-center"
          >
            <div
              className={`mx-auto w-full max-w-[180px] ${s.active ? "" : "opacity-30"}`}
              // The SVG is built from a uuid and fixed markup — no user text
              // reaches it, which is what makes this safe to inject.
              dangerouslySetInnerHTML={{ __html: qrSvg(`${origin}/station/${s.qrToken}`) }}
            />
            <p className="mt-3 font-display text-lg font-extrabold text-ink">{s.label}</p>
            <p className="text-[11px] text-ink/45">
              {branchName?.en || branchName?.ar}
              {s.active ? "" : " · inactive"}
            </p>
          </div>
        ))}
      </div>

      {rows.length === 0 && (
        <p className="text-sm text-ink/55">No chairs on this branch yet.</p>
      )}
    </div>
  );
}
