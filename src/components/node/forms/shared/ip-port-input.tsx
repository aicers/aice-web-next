"use client";

import type { ChangeEvent } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { FieldError } from "./field-error";

interface IpPortInputProps {
  idPrefix: string;
  ipLabel: string;
  portLabel: string;
  ipValue: string;
  portValue: number;
  onIpChange: (next: string) => void;
  onPortChange: (next: number) => void;
  ipError?: string;
  portError?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Two-column IP + port input used across every per-service form. The
 * caller owns the form state; this primitive only renders.
 */
export function IpPortInput({
  idPrefix,
  ipLabel,
  portLabel,
  ipValue,
  portValue,
  onIpChange,
  onPortChange,
  ipError,
  portError,
  required,
  disabled,
  className,
}: IpPortInputProps) {
  const ipId = `${idPrefix}-ip`;
  const portId = `${idPrefix}-port`;

  function handlePortChange(event: ChangeEvent<HTMLInputElement>) {
    const raw = event.target.value;
    if (raw.length === 0) {
      onPortChange(Number.NaN);
      return;
    }
    const parsed = Number(raw);
    onPortChange(parsed);
  }

  return (
    <div className={cn("grid gap-2 sm:grid-cols-[1fr_8rem]", className)}>
      <div className="grid gap-1">
        <Label htmlFor={ipId}>
          {ipLabel}
          {required && (
            <span aria-hidden="true" className="text-destructive ml-0.5">
              *
            </span>
          )}
        </Label>
        <Input
          id={ipId}
          value={ipValue}
          onChange={(event) => onIpChange(event.target.value)}
          aria-invalid={!!ipError}
          aria-describedby={ipError ? `${ipId}-error` : undefined}
          disabled={disabled}
          autoComplete="off"
        />
        <FieldError id={`${ipId}-error`} message={ipError} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={portId}>
          {portLabel}
          {required && (
            <span aria-hidden="true" className="text-destructive ml-0.5">
              *
            </span>
          )}
        </Label>
        <Input
          id={portId}
          type="number"
          min={0}
          max={65535}
          value={Number.isNaN(portValue) ? "" : portValue}
          onChange={handlePortChange}
          aria-invalid={!!portError}
          aria-describedby={portError ? `${portId}-error` : undefined}
          disabled={disabled}
          inputMode="numeric"
          autoComplete="off"
        />
        <FieldError id={`${portId}-error`} message={portError} />
      </div>
    </div>
  );
}
