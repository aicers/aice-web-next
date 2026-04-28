"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { FieldError } from "./field-error";

interface PortChipInputProps {
  idPrefix: string;
  label: string;
  /** Pinned standard ports — always present in `value`, not removable. */
  standardPorts: readonly number[];
  /** All ports including standard + custom. */
  value: number[];
  onChange: (next: number[]) => void;
  error?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Result of {@link validatePortInput}. The rejection cases are split
 * out so the input-rendering layer can pick the right localized
 * message; this lets the validation rule itself stay pure / testable
 * without an i18n dependency.
 */
export type PortInputValidation =
  | { kind: "empty" }
  | { kind: "ok"; port: number }
  | { kind: "invalid" }
  | { kind: "duplicate" };

/**
 * Pure validator for a custom-port draft string against the existing
 * `value` list. Extracted so the rule (`integer in [0, 65535]`, no
 * duplicates against either standard or already-custom ports) is
 * exercised without needing a DOM in this repo's SSR-only test
 * harness.
 */
export function validatePortInput(
  raw: string,
  existing: readonly number[],
): PortInputValidation {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    return { kind: "invalid" };
  }
  if (existing.includes(parsed)) return { kind: "duplicate" };
  return { kind: "ok", port: parsed };
}

/**
 * Standard-pinned + custom port chip input used by Sensor's per-protocol
 * port lists. Standard ports render as locked chips with a "(standard)"
 * label; custom ports render as removable chips. New custom ports are
 * accepted via the inline input — pressing Enter or comma commits the
 * pending value if it parses as an integer in `[0, 65535]`. Rejections
 * (non-integer, out of range, or duplicate) surface inline via the
 * shared `FieldError` slot so the operator gets immediate feedback,
 * rather than the prior silent-drop behaviour that left the bad input
 * looking like a no-op.
 */
export function PortChipInput({
  idPrefix,
  label,
  standardPorts,
  value,
  onChange,
  error,
  disabled,
  className,
}: PortChipInputProps) {
  const t = useTranslations("nodes.forms.portChip");
  const [draft, setDraft] = useState("");
  // Local validation feedback for the inline custom-port input. The
  // primitive used to silently swallow `70000` / `abc` / duplicates by
  // returning early from `commit(...)` and clearing the draft on blur,
  // so the operator never saw why their input was discarded. RHF only
  // sees committed `value` updates, so the parent form's `error` slot
  // cannot surface a "you typed something invalid" diagnostic on its
  // own; that signal is intrinsically local to this draft state and
  // belongs here.
  const [draftError, setDraftError] = useState<string | null>(null);
  const inputId = `${idPrefix}-input`;

  // Pure presentation: this primitive does not mutate `value` on mount.
  // The standard-port pinning invariant (every entry in `standardPorts`
  // must appear in `value`) is owned by the per-service module's
  // `defaults()` / `deserialise()` so a hydrated draft never silently
  // dirties the form on first render. If a caller passes a `value`
  // missing a standard port, the chip simply renders without it; fix
  // the upstream defaults/deserialiser instead of papering over it
  // here.
  const standardSet = new Set(standardPorts);
  const customs = value.filter((p) => !standardSet.has(p));

  function commit(raw: string): boolean {
    const result = validatePortInput(raw, value);
    if (result.kind === "empty") {
      setDraftError(null);
      return true;
    }
    if (result.kind === "invalid") {
      setDraftError(t("errors.invalid"));
      return false;
    }
    if (result.kind === "duplicate") {
      setDraftError(t("errors.duplicate"));
      return false;
    }
    setDraftError(null);
    onChange([...value, result.port]);
    return true;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (commit(draft)) setDraft("");
    }
  }

  function removeCustom(port: number) {
    onChange(value.filter((p) => p !== port));
  }

  return (
    <div className={cn("grid gap-2", className)}>
      <Label htmlFor={inputId}>{label}</Label>
      <div className="border-input flex flex-wrap items-center gap-1 rounded-md border px-2 py-1">
        {standardPorts.map((port) => (
          <span
            key={`std-${port}`}
            data-standard="true"
            className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
          >
            <span>{port}</span>
            <span className="text-[10px] opacity-70">{t("standard")}</span>
          </span>
        ))}
        {customs.map((port) => (
          <span
            key={`custom-${port}`}
            data-standard="false"
            className="bg-secondary text-secondary-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
          >
            <span>{port}</span>
            <button
              type="button"
              aria-label={t("removePort", { port })}
              onClick={() => removeCustom(port)}
              disabled={disabled}
              className="hover:text-foreground rounded focus-visible:outline-none"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <Input
          id={inputId}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            // Clear the rejection diagnostic as soon as the operator
            // starts editing again so stale "invalid" / "duplicate"
            // text does not linger over a fresh attempt.
            if (draftError !== null) setDraftError(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (draft.trim().length === 0) {
              setDraftError(null);
              return;
            }
            // Preserve the bad draft on blur so the operator can see
            // and correct it. Previously the input was force-cleared,
            // which masked the rejection entirely.
            if (commit(draft)) setDraft("");
          }}
          aria-invalid={draftError !== null || !!error || undefined}
          aria-describedby={
            draftError !== null || error ? `${inputId}-error` : undefined
          }
          disabled={disabled}
          inputMode="numeric"
          placeholder={t("addPort")}
          className="min-w-[6rem] flex-1 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
        />
      </div>
      <FieldError id={`${inputId}-error`} message={draftError ?? error} />
    </div>
  );
}
