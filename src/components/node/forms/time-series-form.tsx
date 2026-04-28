"use client";

import { useTranslations } from "next-intl";
import { Controller, useFormContext } from "react-hook-form";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { FieldError } from "./shared/field-error";
import { IpPortInput } from "./shared/ip-port-input";

interface TimeSeriesFormProps {
  namePrefix?: string;
  disabled?: boolean;
}

/**
 * Crusher (Time Series Generator) form. Both ingest and publish addresses
 * share a single IP, collected once and duplicated by the serialiser.
 */
export function TimeSeriesForm({
  namePrefix = "timeSeries",
  disabled,
}: TimeSeriesFormProps) {
  const t = useTranslations("nodes.forms");
  const { control, getFieldState, formState, register } = useFormContext();
  const ipState = getFieldState(`${namePrefix}.dataStoreIp`, formState);
  const receiveState = getFieldState(`${namePrefix}.receivePort`, formState);
  const sendState = getFieldState(`${namePrefix}.sendPort`, formState);
  const hostnameState = getFieldState(
    `${namePrefix}.dataStoreHostname`,
    formState,
  );

  return (
    <fieldset disabled={disabled} className="grid gap-4">
      <legend className="sr-only">{t("timeSeries.legend")}</legend>
      <Controller
        control={control}
        name={`${namePrefix}.dataStoreIp`}
        render={({ field: ipField }) => (
          <Controller
            control={control}
            name={`${namePrefix}.receivePort`}
            render={({ field: receiveField }) => (
              <IpPortInput
                idPrefix={`${namePrefix}-receive`}
                ipLabel={t("timeSeries.dataStoreIp")}
                portLabel={t("timeSeries.receivePort")}
                ipValue={ipField.value ?? ""}
                portValue={receiveField.value ?? Number.NaN}
                onIpChange={ipField.onChange}
                onPortChange={receiveField.onChange}
                ipError={ipState.error?.message}
                portError={receiveState.error?.message}
                required
                disabled={disabled}
              />
            )}
          />
        )}
      />
      <div className="grid gap-1">
        <Label htmlFor={`${namePrefix}-send-port`}>
          {t("timeSeries.sendPort")}
        </Label>
        <Input
          id={`${namePrefix}-send-port`}
          type="number"
          min={0}
          max={65535}
          {...register(`${namePrefix}.sendPort`, { valueAsNumber: true })}
          aria-invalid={!!sendState.error}
        />
        <FieldError message={sendState.error?.message} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`${namePrefix}-hostname`}>
          {t("common.dataStoreHostname")}
          <span className="text-muted-foreground ml-1 text-xs">
            {t("common.optional")}
          </span>
        </Label>
        <Input
          id={`${namePrefix}-hostname`}
          {...register(`${namePrefix}.dataStoreHostname`)}
          aria-invalid={!!hostnameState.error}
        />
        <FieldError message={hostnameState.error?.message} />
      </div>
    </fieldset>
  );
}
