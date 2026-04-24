"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Module-level open counter used by surrounding dismissable surfaces
// (the desktop Quick peek Escape handler and the narrow overlay
// Sheet) to suppress their own Escape-to-close behaviour while any
// `MorePopover` panel is open. Without this, a single Escape key
// event fires two listeners at once — the popover's own handler and
// the host surface's handler — and collapses both layers together.
let openMorePopoverCount = 0;

/**
 * Returns `true` when at least one `MorePopover` panel is currently
 * open anywhere in the document. Host surfaces that install their
 * own Escape-to-dismiss handlers consult this before closing, so a
 * single Escape only unwinds the topmost layer (the popover),
 * leaving the enclosing Quick peek inspector intact. A subsequent
 * Escape — with no popover open — closes the inspector.
 */
export function isMorePopoverOpen(): boolean {
  return openMorePopoverCount > 0;
}

/**
 * Compact `+N more` control that reveals the full list of hidden
 * values on activation. Uses a minimal inline popover — clicking the
 * button toggles a panel anchored beneath it; clicking outside or
 * pressing Escape closes it. Shared by the Detection result list and
 * the Quick peek inspector so both surfaces honour the same "popover
 * for the full list" acceptance contract without duplicating the
 * outside-click and Escape handling.
 *
 * Callers that want overflowed items to remain copy-able (per issue
 * #290, userId-style values must expose Copy whether inlined or
 * hidden behind the popover) pass `copyLabels`; each list item then
 * renders a small Copy button next to the value. When the displayed
 * text differs from what the operator actually wants on the
 * clipboard (e.g. the endpoint popover shows `IP[:port] (country)`
 * but Copy should yield the raw IP), callers also pass `copyValues`
 * — a parallel array whose i-th entry supplies the clipboard payload
 * for the i-th displayed value.
 */
export function MorePopover({
  count,
  values,
  moreCountSuffix,
  copyLabels,
  copyValues,
  defaultOpen = false,
}: {
  count: number;
  values: string[];
  moreCountSuffix: (count: number) => string;
  /**
   * Enables per-item Copy affordances. Omit for read-only list
   * overflows (the default) so the popover stays minimal.
   */
  copyLabels?: { copy: string; copied: string };
  /**
   * Parallel array used as the clipboard payload per item when
   * present. Falls back to the displayed `values[i]` string when
   * omitted or when an individual entry is `undefined`.
   */
  copyValues?: string[];
  /**
   * Initial open state. Defaults to `false` for normal UX; tests
   * override it so the popover's item list is visible in SSR-only
   * rendering (`renderToStaticMarkup`) without needing a click
   * simulation harness.
   */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    // Bump the shared open counter for the lifetime of this panel
    // so host surfaces (Quick peek's Escape handler, the Sheet
    // overlay's onEscapeKeyDown) can opt out of their own close
    // behaviour while a popover is live.
    openMorePopoverCount += 1;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (wrapperRef.current?.contains(target)) return;
      setOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Mark the event as handled so co-registered document-level
      // Escape listeners on the same key event skip their own
      // close logic. `stopPropagation` alone is not enough when
      // sibling listeners are attached to `document`; they run in
      // registration order on the same target.
      e.stopPropagation();
    };
    // Register in the capture phase so this handler runs before the
    // host surface's document-level keydown listener, which is
    // attached in the bubble phase when the Quick peek inspector is
    // open. Combined with `stopPropagation`, this prevents the
    // outer listener from firing for the same Escape event.
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler, true);
    return () => {
      openMorePopoverCount = Math.max(0, openMorePopoverCount - 1);
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler, true);
    };
  }, [open]);
  return (
    <span
      className="pointer-events-auto relative z-10 inline-flex"
      ref={wrapperRef}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="text-muted-foreground/80 hover:text-foreground focus-visible:ring-ring/50 rounded px-1 focus-visible:ring-2 focus-visible:outline-none"
      >
        {moreCountSuffix(count)}
      </button>
      {open ? (
        <div
          role="dialog"
          className="bg-popover text-popover-foreground absolute top-full z-20 mt-1 max-h-64 min-w-[10rem] overflow-auto rounded-md border p-2 shadow-md"
        >
          <ul className="flex flex-col gap-0.5 font-mono text-xs">
            {values.map((v, index) => {
              const copyPayload = copyValues?.[index] ?? v;
              // Two overflow entries can share the same display
              // string (e.g. textually identical endpoint tuples);
              // blending the clipboard payload into the key keeps
              // React's reconciliation stable when the copy values
              // still differ.
              const key = `${v}::${copyPayload}::${index}`;
              return (
                <li
                  key={key}
                  className={cn(
                    "truncate",
                    copyLabels
                      ? "flex items-center justify-between gap-2"
                      : undefined,
                  )}
                >
                  <span className="truncate">{v}</span>
                  {copyLabels ? (
                    <PopoverCopyButton
                      value={copyPayload}
                      labels={copyLabels}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </span>
  );
}

function PopoverCopyButton({
  value,
  labels,
}: {
  value: string;
  labels: { copy: string; copied: string };
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const handle = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(handle);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? labels.copied : labels.copy}
      className="text-muted-foreground/60 hover:text-foreground focus-visible:ring-ring/50 inline-flex size-5 shrink-0 items-center justify-center rounded-sm focus-visible:ring-2 focus-visible:outline-none"
      onClick={(e) => {
        e.stopPropagation();
        if (
          typeof navigator !== "undefined" &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === "function"
        ) {
          void navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => {},
          );
        }
      }}
    >
      {copied ? (
        <Check className="size-3" aria-hidden="true" />
      ) : (
        <Copy className="size-3" aria-hidden="true" />
      )}
    </button>
  );
}
