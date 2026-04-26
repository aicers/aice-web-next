"use client";

import { useEffect, useState } from "react";

import type { SavedFilterErrorCode } from "@/components/detection/use-saved-filters";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SAVED_FILTER_NAME_MAX } from "@/lib/detection/saved-filters-constants";

export interface SaveFilterDialogLabels {
  title: string;
  description: string;
  nameLabel: string;
  namePlaceholder: string;
  cancel: string;
  submit: string;
  submitting: string;
  errors: {
    empty: string;
    duplicate: string;
    tooLong: string;
    server: string;
    unauthenticated: string;
  };
}

export interface SaveFilterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-populated when the dialog opens. The user can edit before
   *  submit; an empty submission falls back to this default. */
  defaultName: string;
  onSubmit: (
    name: string,
  ) => Promise<{ ok: true } | { ok: false; code: SavedFilterErrorCode }>;
  labels: SaveFilterDialogLabels;
}

export function SaveFilterDialog({
  open,
  onOpenChange,
  defaultName,
  onSubmit,
  labels,
}: SaveFilterDialogProps) {
  const [name, setName] = useState(defaultName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the input every time the dialog opens so a stale draft
  // from the previous open does not leak into the current Save flow.
  useEffect(() => {
    if (open) {
      setName(defaultName);
      setError(null);
      setSubmitting(false);
    }
  }, [open, defaultName]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError(labels.errors.empty);
      return;
    }
    if (trimmed.length > SAVED_FILTER_NAME_MAX) {
      setError(labels.errors.tooLong);
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await onSubmit(trimmed);
    if (result.ok) {
      onOpenChange(false);
      return;
    }
    setSubmitting(false);
    setError(messageForCode(result.code, labels));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{labels.title}</DialogTitle>
            <DialogDescription>{labels.description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="save-filter-name">{labels.nameLabel}</Label>
            <Input
              id="save-filter-name"
              value={name}
              maxLength={SAVED_FILTER_NAME_MAX}
              placeholder={labels.namePlaceholder}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError(null);
              }}
              autoFocus
              aria-invalid={error !== null}
              aria-describedby={error ? "save-filter-error" : undefined}
            />
            {error ? (
              <p
                id="save-filter-error"
                role="alert"
                className="text-destructive text-xs"
              >
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {labels.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? labels.submitting : labels.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function messageForCode(
  code: SavedFilterErrorCode,
  labels: SaveFilterDialogLabels,
): string {
  switch (code) {
    case "duplicate-name":
      return labels.errors.duplicate;
    case "invalid-name":
      return labels.errors.empty;
    case "unauthenticated":
      return labels.errors.unauthenticated;
    case "not-found":
    case "unsupported-mode":
    case "server-error":
      return labels.errors.server;
  }
}
