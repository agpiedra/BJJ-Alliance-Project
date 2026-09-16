"use client";

import { useEffect, useState } from "react";
import { cn } from "cn";

// REDESIGN_BRIEF.md Phase 6 §6.3's "toast on success, revert on failure" for
// Pagos' inline "Marcar pagado" — no toast library is already a dependency
// (checked package.json: no sonner/react-hot-toast/etc.) and this app has
// exactly one use case for it, so a hand-rolled, module-level pub/sub is the
// lazy-correct choice over pulling in a new dependency for one feature.
// ponytail: if a second unrelated feature needs toasts later, this is
// already the shared primitive to extend — not a reason to add a library now.

type ToastVariant = "success" | "error";
type ToastItem = { id: number; message: string; variant: ToastVariant };

let idCounter = 0;
let items: ToastItem[] = [];
let listeners: Array<(items: ToastItem[]) => void> = [];

function emit() {
  for (const listener of listeners) listener(items);
}

export function showToast(message: string, variant: ToastVariant = "success") {
  const id = ++idCounter;
  items = [...items, { id, message, variant }];
  emit();
  setTimeout(() => {
    items = items.filter((item) => item.id !== id);
    emit();
  }, 3500);
}

/** Render once per page that calls `showToast` — a fixed-position,
 * auto-dismissing status region using existing tokens only. */
export function Toaster() {
  const [current, setCurrent] = useState<ToastItem[]>(items);

  useEffect(() => {
    listeners.push(setCurrent);
    return () => {
      listeners = listeners.filter((listener) => listener !== setCurrent);
    };
  }, []);

  return (
    // Rendered unconditionally (even empty) rather than `return null` when
    // there's nothing to show — an `aria-live` region that unmounts and
    // remounts on every toast can break a screen reader's announcement
    // timing for the very first toast after a page load, since some
    // assistive tech only starts watching a live region once it has been
    // present in the accessibility tree for a moment.
    <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2" aria-live="polite">
      {current.map((item) => (
        <div
          key={item.id}
          role="status"
          className={cn(
            "rounded-lg border px-4 py-2.5 text-sm shadow-lg",
            item.variant === "success" ? "border-ok-line bg-ok-soft text-ok" : "border-bad-line bg-bad-soft text-bad",
          )}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
