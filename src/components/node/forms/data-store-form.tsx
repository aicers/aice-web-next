"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Controller, useFormContext } from "react-hook-form";

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
  MAX_LEVEL_BASE,
  MAX_OPEN_FILES,
  MAX_SUBCOMPACTION,
  RETENTION_PERIOD,
  THREAD_COUNT,
} from "@/lib/node/services/types";

import { FieldError } from "./shared/field-error";
import { IpPortInput } from "./shared/ip-port-input";

interface DataStoreFormProps {
  namePrefix?: string;
  disabled?: boolean;
}

/**
 * Decides whether Advanced Options should be expanded by default. The
 * field catalog (`decisions/node-field-catalog.md`) defines the
 * "Advanced Options" grouping as the last five Data Store fields:
 * retention plus the four RocksDB knobs. The collapsible starts open
 * whenever any of those differs from its preset so an edited node
 * with non-default tuning surfaces its overrides; `ackTransmission`
 * is rendered outside the collapsible and is intentionally excluded
 * here so editing only Health Check Interval leaves the section
 * closed by default.
 */
function isAdvancedDirty(values: Record<string, unknown> | undefined): boolean {
  if (!values) return false;
  const retention = values.retention as
    | { value?: number; unit?: string }
    | undefined;
  if (retention) {
    if (retention.value !== undefined && retention.value !== RETENTION_PERIOD) {
      return true;
    }
    if (retention.unit !== undefined && retention.unit !== "d") return true;
  }
  if (
    values.maxMbOfLevelBase !== undefined &&
    values.maxMbOfLevelBase !== MAX_LEVEL_BASE
  ) {
    return true;
  }
  if (
    values.maxSubcompactions !== undefined &&
    values.maxSubcompactions !== MAX_SUBCOMPACTION
  ) {
    return true;
  }
  if (values.numOfThread !== undefined && values.numOfThread !== THREAD_COUNT) {
    return true;
  }
  if (
    values.maxOpenFiles !== undefined &&
    values.maxOpenFiles !== MAX_OPEN_FILES
  ) {
    return true;
  }
  return false;
}

export function DataStoreForm({
  namePrefix = "dataStore",
  disabled,
}: DataStoreFormProps) {
  const t = useTranslations("nodes.forms");
  const { control, register, getFieldState, formState, getValues } =
    useFormContext();
  // `formState.defaultValues` updates whenever the parent dialog calls
  // `form.reset(...)` (the stale-conflict replay path Phase Node-9b
  // uses). Re-deriving the disclosure from the latest defaults — not
  // just the first render — keeps the section in sync with whichever
  // draft was just loaded into the shared form context.
  const defaultsAtPrefix = (
    formState.defaultValues as Record<string, unknown> | undefined
  )?.[namePrefix] as Record<string, unknown> | undefined;
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    isAdvancedDirty(
      getValues(namePrefix) as Record<string, unknown> | undefined,
    ),
  );
  useEffect(() => {
    setAdvancedOpen(isAdvancedDirty(defaultsAtPrefix));
  }, [defaultsAtPrefix]);

  function err(name: string): string | undefined {
    return getFieldState(`${namePrefix}.${name}`, formState).error?.message;
  }

  return (
    <fieldset disabled={disabled} className="grid gap-6">
      <legend className="sr-only">{t("dataStore.legend")}</legend>

      <Controller
        control={control}
        name={`${namePrefix}.receiveIp`}
        render={({ field: ipField }) => (
          <Controller
            control={control}
            name={`${namePrefix}.receivePort`}
            render={({ field: portField }) => (
              <IpPortInput
                idPrefix={`${namePrefix}-receive`}
                ipLabel={t("dataStore.receiveIp")}
                portLabel={t("dataStore.receivePort")}
                ipValue={ipField.value ?? ""}
                portValue={portField.value ?? Number.NaN}
                onIpChange={ipField.onChange}
                onPortChange={portField.onChange}
                ipError={err("receiveIp")}
                portError={err("receivePort")}
                required
                disabled={disabled}
              />
            )}
          />
        )}
      />

      <Controller
        control={control}
        name={`${namePrefix}.sendIp`}
        render={({ field: ipField }) => (
          <Controller
            control={control}
            name={`${namePrefix}.sendPort`}
            render={({ field: portField }) => (
              <IpPortInput
                idPrefix={`${namePrefix}-send`}
                ipLabel={t("dataStore.sendIp")}
                portLabel={t("dataStore.sendPort")}
                ipValue={ipField.value ?? ""}
                portValue={portField.value ?? Number.NaN}
                onIpChange={ipField.onChange}
                onPortChange={portField.onChange}
                ipError={err("sendIp")}
                portError={err("sendPort")}
                required
                disabled={disabled}
              />
            )}
          />
        )}
      />

      <Controller
        control={control}
        name={`${namePrefix}.webIp`}
        render={({ field: ipField }) => (
          <Controller
            control={control}
            name={`${namePrefix}.webPort`}
            render={({ field: portField }) => (
              <IpPortInput
                idPrefix={`${namePrefix}-web`}
                ipLabel={t("dataStore.webIp")}
                portLabel={t("dataStore.webPort")}
                ipValue={ipField.value ?? ""}
                portValue={portField.value ?? Number.NaN}
                onIpChange={ipField.onChange}
                onPortChange={portField.onChange}
                ipError={err("webIp")}
                portError={err("webPort")}
                required
                disabled={disabled}
              />
            )}
          />
        )}
      />

      <div className="grid gap-1">
        <Label htmlFor={`${namePrefix}-ack`}>
          {t("dataStore.ackTransmission")}
        </Label>
        <Input
          id={`${namePrefix}-ack`}
          type="number"
          {...register(`${namePrefix}.ackTransmission`, {
            valueAsNumber: true,
          })}
        />
        <FieldError message={err("ackTransmission")} />
      </div>

      <details
        open={advancedOpen}
        onToggle={(event) =>
          setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)
        }
        data-slot="data-store-advanced"
        className="rounded-md border p-3"
      >
        <summary className="cursor-pointer text-sm font-medium">
          {t("dataStore.advancedOptions")}
        </summary>
        <div className="mt-3 grid gap-4">
          <div className="grid gap-1">
            <Label>{t("dataStore.retentionPeriod")}</Label>
            <div className="grid grid-cols-[1fr_8rem] gap-2">
              <Input
                aria-label={t("dataStore.retentionValue")}
                type="number"
                min={1}
                aria-invalid={!!err("retention.value") || !!err("retention")}
                {...register(`${namePrefix}.retention.value`, {
                  valueAsNumber: true,
                })}
              />
              <Controller
                control={control}
                name={`${namePrefix}.retention.unit`}
                render={({ field }) => (
                  <Select
                    value={field.value ?? "d"}
                    onValueChange={field.onChange}
                  >
                    <SelectTrigger
                      aria-label={t("dataStore.retentionUnit")}
                      aria-invalid={
                        !!err("retention.unit") || !!err("retention")
                      }
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="d">
                        {t("dataStore.retentionUnitDays")}
                      </SelectItem>
                      <SelectItem value="w">
                        {t("dataStore.retentionUnitWeeks")}
                      </SelectItem>
                      <SelectItem value="M">
                        {t("dataStore.retentionUnitMonths")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <FieldError message={err("retention.value")} />
            <FieldError message={err("retention.unit")} />
            <FieldError message={err("retention")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1">
              <Label htmlFor={`${namePrefix}-max-mb`}>
                {t("dataStore.maxLevelBase")}
              </Label>
              <Input
                id={`${namePrefix}-max-mb`}
                type="number"
                aria-invalid={!!err("maxMbOfLevelBase")}
                {...register(`${namePrefix}.maxMbOfLevelBase`, {
                  valueAsNumber: true,
                })}
              />
              <FieldError message={err("maxMbOfLevelBase")} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${namePrefix}-subc`}>
                {t("dataStore.maxSubcompactions")}
              </Label>
              <Input
                id={`${namePrefix}-subc`}
                type="number"
                aria-invalid={!!err("maxSubcompactions")}
                {...register(`${namePrefix}.maxSubcompactions`, {
                  valueAsNumber: true,
                })}
              />
              <FieldError message={err("maxSubcompactions")} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${namePrefix}-thread`}>
                {t("dataStore.parallelismLevel")}
              </Label>
              <Input
                id={`${namePrefix}-thread`}
                type="number"
                aria-invalid={!!err("numOfThread")}
                {...register(`${namePrefix}.numOfThread`, {
                  valueAsNumber: true,
                })}
              />
              <FieldError message={err("numOfThread")} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${namePrefix}-files`}>
                {t("dataStore.maxOpenFiles")}
              </Label>
              <Input
                id={`${namePrefix}-files`}
                type="number"
                aria-invalid={!!err("maxOpenFiles")}
                {...register(`${namePrefix}.maxOpenFiles`, {
                  valueAsNumber: true,
                })}
              />
              <FieldError message={err("maxOpenFiles")} />
            </div>
          </div>
        </div>
      </details>
    </fieldset>
  );
}
