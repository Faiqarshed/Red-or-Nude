"use client";

import { useRef, useState } from "react";
import { HardDrive, ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { Badge, Button, Card, EmptyState, PageHeader, touchTargetSm } from "@/components/admin/ui";
import { ConfirmDialog } from "@/components/admin/overlays";
import { useAdminI18n } from "@/lib/admin/i18n";
import { usePendingAction } from "@/components/admin/use-pending-action";
import { ALLOWED_TYPES, MAX_UPLOAD_BYTES, type MediaItem } from "@/lib/media";
import { deleteMedia, uploadMedia } from "./actions";

function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MediaView({
  items,
  driver,
}: {
  items: MediaItem[];
  driver: "supabase" | "local";
}) {
  const { t } = useAdminI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { pending, run: refreshAfter } = usePendingAction();

  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    refreshAfter(async () => {
      setError(null);
      for (const file of Array.from(files)) {
        if (!ALLOWED_TYPES.includes(file.type)) {
          setError(t.media.badType);
          continue;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          setError(t.media.tooLarge);
          continue;
        }
        let dims: { width: number; height: number } | null = null;
        try {
          const bitmap = await createImageBitmap(file);
          dims = { width: bitmap.width, height: bitmap.height };
          bitmap.close();
        } catch {
          /* dimensions are optional */
        }
        const body = new FormData();
        body.set("file", file);
        if (dims) {
          body.set("width", String(dims.width));
          body.set("height", String(dims.height));
        }
        const res = await uploadMedia(body);
        if (!res.ok) setError(res.error === "storage" ? t.media.uploadFailed : t.media.badType);
      }
    });
  };

  const [doomed, setDoomed] = useState<MediaItem | null>(null);
  const { pending: deleting, run: refreshAfterDelete } = usePendingAction();

  const remove = () =>
    refreshAfterDelete(async () => {
      if (!doomed) return false;
      setError(null);
      const res = await deleteMedia(doomed.id);
      if (!res.ok) setError(t.common.error);
      setDoomed(null);
    });

  return (
    <>
      <PageHeader
        title={t.media.title}
        subtitle={t.media.subtitle}
        action={
          <Button onClick={() => inputRef.current?.click()} disabled={pending}>
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" strokeWidth={2} />
            )}
            {t.media.upload}
          </Button>
        }
      />

      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        multiple
        className="hidden"
        onChange={(e) => upload(e.target.files)}
      />

      {/* The local driver is a development convenience — uploads land in
          /public/uploads and vanish on a serverless deploy. Say so plainly. */}
      {driver === "local" ? (
        <div className="mb-4 flex items-start gap-2 rounded-xl bg-[#b7791f]/12 px-4 py-3 text-start text-xs text-[#8a5a06]">
          <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span>{t.media.localDriver}</span>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mb-4 rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
          {error}
        </p>
      ) : null}

      <Card className="p-4">
        {items.length === 0 ? (
          <EmptyState
            title={t.media.empty}
            body={t.media.hint}
            icon={<ImageIcon className="h-8 w-8" strokeWidth={1.25} />}
          />
        ) : (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {items.map((item) => (
              <li
                key={item.id}
                className="group overflow-hidden rounded-xl border border-black/[0.06] bg-white"
              >
                <div className="relative aspect-square bg-black/[0.03]">
                  {item.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.url}
                      alt={item.alt?.en ?? ""}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                  <button
                    onClick={() => setDoomed(item)}
                    className={`absolute top-2 end-2 grid h-7 w-7 place-items-center rounded-lg bg-white/90 text-ink/50 opacity-0 shadow-sm transition-all hover:text-red group-hover:opacity-100 ${touchTargetSm}`}
                    aria-label={t.media.deleteConfirm}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </div>
                <div className="p-2.5">
                  <p className="truncate text-start text-[11px] text-ink" dir="ltr">
                    {item.path.replace(/^\//, "")}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-[10px] text-ink/40">
                    <span className="tabular-nums">{formatBytes(item.bytes)}</span>
                    {item.width && item.height ? (
                      <span className="tabular-nums" dir="ltr">
                        {item.width}×{item.height}
                      </span>
                    ) : null}
                    {item.path.startsWith("/") ? <Badge tone="neutral">public</Badge> : null}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={!!doomed}
        title={t.media.deleteConfirm}
        body={t.media.deleteBody}
        cancelLabel={t.common.cancel}
        pending={deleting}
        onConfirm={remove}
        onClose={() => setDoomed(null)}
        preview={
          doomed?.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={doomed.url}
              alt=""
              className="mx-auto h-24 w-24 rounded-xl object-cover ring-1 ring-black/[0.06]"
            />
          ) : undefined
        }
      />
    </>
  );
}
