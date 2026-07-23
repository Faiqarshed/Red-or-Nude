"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { Dialog } from "./overlays";
import { Button, EmptyState } from "./ui";
import { useAdminI18n } from "@/lib/admin/i18n";
import { cn } from "@/lib/cn";
import { ALLOWED_TYPES, MAX_UPLOAD_BYTES, type MediaItem } from "@/lib/media";
import { listMedia, uploadMedia } from "@/app/(admin)/admin/(shell)/media/actions";

/** Read pixel dimensions in the browser so the server doesn't need an image lib. */
async function measure(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  } catch {
    return null;
  }
}

export function useMediaLibrary() {
  const [items, setItems] = useState<MediaItem[] | null>(null);

  const refresh = useCallback(async () => {
    setItems(await listMedia());
  }, []);

  return { items, setItems, refresh };
}

export default function MediaPicker({
  value,
  onChange,
  label,
}: {
  value: string | null;
  onChange: (path: string | null) => void;
  label?: string;
}) {
  const { t } = useAdminI18n();
  const [open, setOpen] = useState(false);

  // Resolve the stored path for preview. Legacy "/foo.webp" values render as-is;
  // uploaded keys are resolved by the library lookup once it loads.
  const [preview, setPreview] = useState<string | null>(
    value && value.startsWith("/") ? value : null,
  );
  const { items, refresh } = useMediaLibrary();

  useEffect(() => {
    if (!value) return setPreview(null);
    if (value.startsWith("/") || value.startsWith("http")) return setPreview(value);
    const hit = items?.find((i) => i.path === value);
    if (hit?.url) setPreview(hit.url);
  }, [value, items]);

  useEffect(() => {
    if (open && !items) void refresh();
  }, [open, items, refresh]);

  return (
    <div className="text-start">
      {label ? (
        <span className="mb-1.5 block text-xs font-medium text-ink/70">{label}</span>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl border border-black/10 bg-white transition-colors hover:border-sky"
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="h-6 w-6 text-ink/25" strokeWidth={1.5} />
          )}
        </button>

        <div className="flex flex-col gap-1.5">
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {value ? t.media.change : t.media.choose}
          </Button>
          {value ? (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="text-start text-xs text-ink/45 transition-colors hover:text-red"
            >
              {t.media.remove}
            </button>
          ) : null}
        </div>
      </div>

      <MediaLibraryDialog
        open={open}
        onClose={() => setOpen(false)}
        onPick={(item) => {
          onChange(item.path);
          setPreview(item.url);
          setOpen(false);
        }}
      />
    </div>
  );
}

export function MediaLibraryDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (item: MediaItem) => void;
}) {
  const { t } = useAdminI18n();
  const { items, setItems, refresh } = useMediaLibrary();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && !items) void refresh();
  }, [open, items, refresh]);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
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

      const dims = await measure(file);
      const body = new FormData();
      body.set("file", file);
      if (dims) {
        body.set("width", String(dims.width));
        body.set("height", String(dims.height));
      }

      const res = await uploadMedia(body);
      if (res.ok) {
        setItems((prev) => [res.item, ...(prev ?? [])]);
      } else {
        setError(res.error === "storage" ? t.media.uploadFailed : t.media.badType);
      }
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.media.title}>
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        multiple
        className="hidden"
        onChange={(e) => startTransition(() => void handleFiles(e.target.files))}
      />

      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-start text-xs text-ink/50">{t.media.hint}</p>
        <Button size="sm" onClick={() => inputRef.current?.click()} disabled={pending}>
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" strokeWidth={2} />
          )}
          {t.media.upload}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mb-3 rounded-xl bg-red/[0.07] px-3 py-2 text-start text-xs text-red">
          {error}
        </p>
      ) : null}

      {items === null ? (
        <p className="py-10 text-center text-xs text-ink/40">{t.common.loading}</p>
      ) : items.length === 0 ? (
        <EmptyState
          title={t.media.empty}
          body={t.media.hint}
          icon={<ImageIcon className="h-8 w-8" strokeWidth={1.25} />}
        />
      ) : (
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onPick(item)}
                className={cn(
                  "group block w-full overflow-hidden rounded-xl border border-black/[0.06] bg-white",
                  "transition-all hover:border-sky hover:shadow-md",
                )}
              >
                <span className="block aspect-square overflow-hidden bg-black/[0.03]">
                  {item.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.url}
                      alt={item.alt?.en ?? ""}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </span>
                <span className="block truncate px-2 py-1.5 text-start text-[10px] text-ink/45" dir="ltr">
                  {item.path.replace(/^\//, "")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
