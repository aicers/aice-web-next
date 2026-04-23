"use client";

import { X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useState } from "react";

import { cn } from "@/lib/utils";

interface TagInputProps {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  removeLabel: (tag: string) => string;
  ariaDescribedBy?: string;
}

/**
 * Multi-value tag input. Committed tags render as inline chips; the
 * editable `<input>` sits inline after them and grows to fill the
 * remaining width. Enter or comma commits the current draft; paste
 * splits on commas/newlines for bulk-add; Backspace on an empty input
 * removes the last tag so operators can undo without reaching for the
 * mouse. Values are trimmed and deduped so invisible whitespace can't
 * create apparently-duplicate tags.
 */
export function TagInput({
  id,
  value,
  onChange,
  placeholder,
  removeLabel,
  ariaDescribedBy,
}: TagInputProps) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const parts = splitTagTokens(raw);
    if (parts.length === 0) return;
    const merged = [...value];
    for (const p of parts) {
      if (!merged.includes(p)) merged.push(p);
    }
    if (merged.length !== value.length) onChange(merged);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const action = tagKeyAction(e.key, draft, value.length, {
      isComposing: e.nativeEvent.isComposing,
    });
    if (action.preventDefault) e.preventDefault();
    if (action.kind === "commit") {
      commit(draft);
      setDraft("");
    } else if (action.kind === "removeLast") {
      onChange(value.slice(0, -1));
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    if (!/[,\n]/.test(pasted)) return;
    e.preventDefault();
    commit(mergeDraftWithPaste(draft, pasted));
    setDraft("");
  }

  function handleBlur() {
    if (draft.trim().length > 0) {
      commit(draft);
      setDraft("");
    }
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  return (
    <div
      className={cn(
        "border-input bg-transparent dark:bg-input/30",
        "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
        "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border px-2 py-1 text-sm shadow-xs transition-[color,box-shadow]",
      )}
    >
      {value.map((tag, index) => (
        <span
          // Tag values are deduped so the value itself is stable as a key.
          key={tag}
          className="bg-secondary text-secondary-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
        >
          <span>{tag}</span>
          <button
            type="button"
            aria-label={removeLabel(tag)}
            onClick={() => removeAt(index)}
            className="hover:text-foreground focus-visible:ring-ring/50 rounded focus-visible:ring-2 focus-visible:outline-none"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={handleBlur}
        placeholder={value.length === 0 ? placeholder : undefined}
        aria-describedby={ariaDescribedBy}
        className="placeholder:text-muted-foreground min-w-[6rem] flex-1 border-0 bg-transparent p-0 text-sm outline-none"
      />
    </div>
  );
}

/**
 * Pure decision logic for {@link TagInput}'s keydown handler. Exposed
 * so the non-browser vitest runner can verify it — in particular the
 * IME guard: pressing Enter to confirm a Hangul / kana / Hanzi
 * composition must be treated as a no-op so the composition commits
 * to the draft instead of creating a half-composed tag or submitting
 * the parent form.
 */
export interface TagKeyContext {
  isComposing: boolean;
}

export type TagKeyAction =
  | { kind: "noop"; preventDefault: boolean }
  | { kind: "commit"; preventDefault: true }
  | { kind: "removeLast"; preventDefault: true };

export function tagKeyAction(
  key: string,
  draft: string,
  valueCount: number,
  { isComposing }: TagKeyContext,
): TagKeyAction {
  // An IME composition session uses Enter (and sometimes `,` on JP
  // kana keyboards) to confirm candidates — never to commit a tag.
  if (isComposing) return { kind: "noop", preventDefault: false };
  if (key === "Enter" || key === ",") {
    if (draft.trim().length === 0) {
      // Bare Enter with an empty draft stays uncaught so the drawer's
      // form-level Enter-to-Apply still works. Bare comma is swallowed
      // so a literal comma can't land as the first character of a tag.
      return { kind: "noop", preventDefault: key === "," };
    }
    return { kind: "commit", preventDefault: true };
  }
  if (key === "Backspace" && draft.length === 0 && valueCount > 0) {
    return { kind: "removeLast", preventDefault: true };
  }
  return { kind: "noop", preventDefault: false };
}

/**
 * Split a raw string into tag tokens: break on commas and newlines,
 * trim, and drop empties. Shared between the keydown-commit and paste
 * paths so both normalize the same way.
 */
export function splitTagTokens(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Combine the uncommitted draft with pasted clipboard text. A comma is
 * injected between the two so the first pasted token can't get
 * concatenated onto the draft (e.g. draft "alpha" + paste "beta,gamma"
 * must yield three tokens, not "alphabeta" + "gamma"). An empty draft
 * produces a leading empty segment that `splitTagTokens` drops.
 */
export function mergeDraftWithPaste(draft: string, pasted: string): string {
  return `${draft},${pasted}`;
}

/**
 * Canonicalize a tag array the way {@link TagInput} does: trim each
 * entry, drop empties, and dedupe preserving first-seen order. Export
 * so the drawer/shell can normalize values before submit without
 * reinventing the rule.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (t.length === 0) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
