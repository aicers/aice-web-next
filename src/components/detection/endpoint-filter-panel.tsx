"use client";

import { ChevronDown, HelpCircle, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  createEndpointEntryId,
  type EndpointEntry,
  type EndpointEntryDirection,
  parseEndpointInput,
} from "@/lib/detection/endpoint-filter";
import { cn } from "@/lib/utils";

export interface EndpointFilterPanelLabels {
  title: string;
  description: string;
  close: string;
  savedSectionTitle: string;
  savedEmpty: string;
  savedHelp: string;
  customSectionTitle: string;
  customEmpty: string;
  inputLabel: string;
  inputPlaceholder: string;
  addEntry: string;
  invalidInput: string;
  invalidInputExamples: string;
  countBadge: string;
  directionLabel: string;
  directionBoth: string;
  directionSource: string;
  directionDestination: string;
  batchSetDirection: string;
  selectAll: string;
  removeEntry: string;
  done: string;
}

interface EndpointFilterPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: EndpointEntry[];
  onEntriesChange: (entries: EndpointEntry[]) => void;
  labels: EndpointFilterPanelLabels;
  /**
   * When true, opening the panel forces the Custom section to be
   * expanded — used when the operator activates the aggregate
   * Network chip and the spec requires Custom to be visible.
   */
  expandCustomOnOpen?: boolean;
}

/**
 * Advanced filter panel for Network/IP endpoints. Opens as a Sheet
 * from the left so the filter drawer (right) remains visible — the
 * operator can still see what context they're editing. In v1 only
 * the Custom section is functional; the Saved section renders but
 * declares itself unavailable.
 */
export function EndpointFilterPanel({
  open,
  onOpenChange,
  entries,
  onEntriesChange,
  labels,
  expandCustomOnOpen,
}: EndpointFilterPanelProps) {
  const [inputText, setInputText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [customExpanded, setCustomExpanded] = useState(true);
  const [savedExpanded, setSavedExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setInputText("");
      setInputError(null);
    } else if (expandCustomOnOpen) {
      setCustomExpanded(true);
    }
  }, [open, expandCustomOnOpen]);

  function commitInput() {
    const parsed = parseEndpointInput(inputText);
    if (!parsed) {
      setInputError(labels.invalidInput);
      return;
    }
    const entry: EndpointEntry = {
      id: createEndpointEntryId(),
      raw: inputText.trim(),
      kind: parsed.kind,
      host: parsed.host,
      network: parsed.network,
      range: parsed.range,
      direction: "BOTH",
      selected: true,
    };
    onEntriesChange([...entries, entry]);
    setInputText("");
    setInputError(null);
    // Keep focus on the input for rapid entry.
    inputRef.current?.focus();
  }

  function removeEntry(id: string) {
    onEntriesChange(entries.filter((e) => e.id !== id));
  }

  function updateEntry(id: string, patch: Partial<EndpointEntry>) {
    onEntriesChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  const selectedCount = entries.filter((e) => e.selected).length;
  const masterState: "all" | "none" | "indeterminate" =
    entries.length === 0
      ? "none"
      : selectedCount === entries.length
        ? "all"
        : selectedCount === 0
          ? "none"
          : "indeterminate";

  function toggleMaster() {
    const next = masterState !== "all";
    onEntriesChange(entries.map((e) => ({ ...e, selected: next })));
  }

  function batchSetDirection(dir: EndpointEntryDirection) {
    onEntriesChange(
      entries.map((e) => (e.selected ? { ...e, direction: dir } : e)),
    );
  }

  const customCount = entries.length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="flex flex-col sm:max-w-lg"
        aria-describedby="endpoint-filter-panel-description"
        closeLabel={labels.close}
      >
        <SheetHeader>
          <SheetTitle>{labels.title}</SheetTitle>
          <SheetDescription id="endpoint-filter-panel-description">
            {labels.description}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {/* Saved section — placeholder in v1. */}
          <CollapsibleSection
            title={labels.savedSectionTitle}
            expanded={savedExpanded}
            onToggle={() => setSavedExpanded((v) => !v)}
          >
            <div className="text-muted-foreground flex items-start gap-2 rounded-md border border-dashed border-[var(--sidebar-border)] px-3 py-4 text-sm">
              <HelpCircle
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <div className="flex flex-col gap-1">
                <p>{labels.savedEmpty}</p>
                <p className="text-xs">{labels.savedHelp}</p>
              </div>
            </div>
          </CollapsibleSection>

          {/* Custom section — fully functional. */}
          <CollapsibleSection
            title={labels.customSectionTitle}
            countBadge={
              customCount > 0
                ? labels.countBadge.replace("{count}", String(customCount))
                : undefined
            }
            expanded={customExpanded}
            onToggle={() => setCustomExpanded((v) => !v)}
          >
            <div className="flex flex-col gap-3">
              {/* Input row */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="endpoint-filter-input">
                  {labels.inputLabel}
                </Label>
                <div className="flex items-start gap-2">
                  <Input
                    ref={inputRef}
                    id="endpoint-filter-input"
                    value={inputText}
                    placeholder={labels.inputPlaceholder}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      setInputError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitInput();
                      }
                    }}
                    aria-invalid={inputError ? "true" : undefined}
                    aria-describedby={
                      inputError ? "endpoint-filter-input-error" : undefined
                    }
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={commitInput}
                    aria-label={labels.addEntry}
                  >
                    <Plus className="size-4" />
                  </Button>
                </div>
                {inputError ? (
                  <p
                    id="endpoint-filter-input-error"
                    role="alert"
                    className="text-destructive text-xs"
                  >
                    {inputError}
                    <br />
                    <span className="text-muted-foreground">
                      {labels.invalidInputExamples}
                    </span>
                  </p>
                ) : null}
              </div>

              {/* Batch controls — only meaningful when rows exist. */}
              {entries.length > 0 ? (
                <div className="flex items-center gap-2 border-b border-[var(--sidebar-border)] pb-2">
                  <Checkbox
                    id="endpoint-filter-master"
                    aria-label={labels.selectAll}
                    checked={
                      masterState === "all"
                        ? true
                        : masterState === "indeterminate"
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={toggleMaster}
                  />
                  <Label
                    htmlFor="endpoint-filter-master"
                    className="text-xs font-normal"
                  >
                    {labels.selectAll}
                  </Label>
                  <div className="ml-auto">
                    <Select
                      value=""
                      onValueChange={(v) =>
                        batchSetDirection(v as EndpointEntryDirection)
                      }
                      disabled={selectedCount === 0}
                    >
                      <SelectTrigger
                        className="h-8 w-[180px] text-xs"
                        aria-label={labels.batchSetDirection}
                      >
                        <SelectValue placeholder={labels.batchSetDirection} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="BOTH">
                          {labels.directionBoth}
                        </SelectItem>
                        <SelectItem value="SOURCE">
                          {labels.directionSource}
                        </SelectItem>
                        <SelectItem value="DESTINATION">
                          {labels.directionDestination}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : null}

              {/* Entry list */}
              {entries.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-xs">
                  {labels.customEmpty}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {entries.map((entry) => (
                    <EndpointRow
                      key={entry.id}
                      entry={entry}
                      labels={labels}
                      onToggleSelected={() =>
                        updateEntry(entry.id, { selected: !entry.selected })
                      }
                      onDirectionChange={(dir) =>
                        updateEntry(entry.id, { direction: dir })
                      }
                      onRemove={() => removeEntry(entry.id)}
                    />
                  ))}
                </ul>
              )}
            </div>
          </CollapsibleSection>
        </div>

        <div className="border-t border-[var(--sidebar-border)] p-4">
          <Button
            type="button"
            className="w-full"
            onClick={() => onOpenChange(false)}
          >
            {labels.done}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CollapsibleSection({
  title,
  countBadge,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  countBadge?: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const headingId = useMemo(
    () => `endpoint-section-${title.replace(/\s+/g, "-").toLowerCase()}`,
    [title],
  );
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="text-foreground flex items-center gap-2 text-sm font-medium"
      >
        <ChevronDown
          className={cn(
            "size-4 transition-transform",
            !expanded && "-rotate-90",
          )}
          aria-hidden="true"
        />
        <span id={headingId}>{title}</span>
        {countBadge ? (
          <Badge variant="secondary" className="text-xs font-normal">
            {countBadge}
          </Badge>
        ) : null}
      </button>
      {expanded ? <div className="pl-6">{children}</div> : null}
    </section>
  );
}

function EndpointRow({
  entry,
  labels,
  onToggleSelected,
  onDirectionChange,
  onRemove,
}: {
  entry: EndpointEntry;
  labels: EndpointFilterPanelLabels;
  onToggleSelected: () => void;
  onDirectionChange: (dir: EndpointEntryDirection) => void;
  onRemove: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md border border-[var(--sidebar-border)] px-2 py-1.5",
        !entry.selected && "opacity-50",
      )}
    >
      <Checkbox
        checked={entry.selected}
        onCheckedChange={onToggleSelected}
        aria-label={entry.raw}
      />
      <span className="font-mono text-xs">{entry.raw}</span>
      <div className="ml-auto flex items-center gap-1">
        <Select
          value={entry.direction}
          onValueChange={(v) => onDirectionChange(v as EndpointEntryDirection)}
        >
          <SelectTrigger
            className="h-7 w-[130px] text-xs"
            aria-label={labels.directionLabel}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="BOTH">{labels.directionBoth}</SelectItem>
            <SelectItem value="SOURCE">{labels.directionSource}</SelectItem>
            <SelectItem value="DESTINATION">
              {labels.directionDestination}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onRemove}
          aria-label={labels.removeEntry}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}
