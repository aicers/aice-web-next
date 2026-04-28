"use client";

import { useTranslations } from "next-intl";
import { Controller, useFormContext } from "react-hook-form";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ACTIVE_MODELS } from "@/lib/node/active-models";
import type { SensorNodeOption } from "@/lib/node/sensor-list";
import { PROTOCOLS_FOR_HOG } from "@/lib/node/services/semi-supervised";

import { FieldError } from "./shared/field-error";
import { IpPortInput } from "./shared/ip-port-input";

interface SemiSupervisedFormProps {
  namePrefix?: string;
  disabled?: boolean;
  /** Source for the dynamic sensors list. */
  sensorOptions: readonly SensorNodeOption[];
}

/**
 * Hog (Semi-supervised Engine) form. The `models` checkbox set is
 * driven by `ACTIVE_MODELS` (which itself reads `NEXT_PUBLIC_GS_MODE`
 * at module load); the form never branches on the flag directly. The
 * `sensors` checkbox set is driven by the `sensorOptions` prop, which
 * the dialog populates from `listSensorNodes()`.
 */
export function SemiSupervisedForm({
  namePrefix = "semiSupervised",
  disabled,
  sensorOptions,
}: SemiSupervisedFormProps) {
  const t = useTranslations("nodes.forms");
  const { control, register, getFieldState, formState } = useFormContext();

  function err(name: string): string | undefined {
    return getFieldState(`${namePrefix}.${name}`, formState).error?.message;
  }

  return (
    <fieldset disabled={disabled} className="grid gap-6">
      <legend className="sr-only">{t("semiSupervised.legend")}</legend>

      <Controller
        control={control}
        name={`${namePrefix}.dataStoreIp`}
        render={({ field: ipField }) => (
          <Controller
            control={control}
            name={`${namePrefix}.dataStorePort`}
            render={({ field: portField }) => (
              <IpPortInput
                idPrefix={`${namePrefix}-data-store`}
                ipLabel={t("common.dataStoreIp")}
                portLabel={t("common.dataStorePort")}
                ipValue={ipField.value ?? ""}
                portValue={portField.value ?? Number.NaN}
                onIpChange={ipField.onChange}
                onPortChange={portField.onChange}
                ipError={err("dataStoreIp")}
                portError={err("dataStorePort")}
                required
                disabled={disabled}
              />
            )}
          />
        )}
      />

      <div className="grid gap-1">
        <Label htmlFor={`${namePrefix}-hostname`}>
          {t("common.dataStoreHostname")}
        </Label>
        <Input
          id={`${namePrefix}-hostname`}
          {...register(`${namePrefix}.dataStoreHostname`)}
        />
        <FieldError message={err("dataStoreHostname")} />
      </div>

      <fieldset>
        <legend className="text-sm font-medium">
          {t("semiSupervised.protocols")}
        </legend>
        <p className="text-muted-foreground text-xs">
          {t("common.emptyListHint")}
        </p>
        <Controller
          control={control}
          name={`${namePrefix}.protocols`}
          render={({ field }) => {
            const selected = new Set((field.value ?? []) as readonly string[]);
            function toggle(value: string) {
              const next = new Set(selected);
              if (next.has(value)) next.delete(value);
              else next.add(value);
              field.onChange(PROTOCOLS_FOR_HOG.filter((p) => next.has(p)));
            }
            return (
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PROTOCOLS_FOR_HOG.map((proto) => {
                  const id = `${namePrefix}-proto-${proto}`;
                  return (
                    <div
                      key={proto}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={id}
                        checked={selected.has(proto)}
                        onCheckedChange={() => toggle(proto)}
                        disabled={disabled}
                        data-protocol={proto}
                      />
                      <label htmlFor={id} className="cursor-pointer">
                        {t(`semiSupervised.protocolLabels.${proto}`)}
                      </label>
                    </div>
                  );
                })}
              </div>
            );
          }}
        />
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">
          {t("semiSupervised.models")}
        </legend>
        <p className="text-muted-foreground text-xs">
          {t("common.emptyListHint")}
        </p>
        <Controller
          control={control}
          name={`${namePrefix}.models`}
          render={({ field }) => {
            const selected = new Set((field.value ?? []) as readonly string[]);
            function toggle(value: string) {
              const next = new Set(selected);
              if (next.has(value)) next.delete(value);
              else next.add(value);
              field.onChange(
                ACTIVE_MODELS.map((m) => m.wire).filter((w) => next.has(w)),
              );
            }
            return (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {ACTIVE_MODELS.map((model) => {
                  const id = `${namePrefix}-model-${model.id}`;
                  return (
                    <div
                      key={model.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={id}
                        checked={selected.has(model.wire)}
                        onCheckedChange={() => toggle(model.wire)}
                        disabled={disabled}
                        data-model={model.id}
                      />
                      <label htmlFor={id} className="cursor-pointer">
                        {t(`activeModels.${model.id}`)}
                      </label>
                    </div>
                  );
                })}
              </div>
            );
          }}
        />
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium">
          {t("semiSupervised.sensors")}
        </legend>
        <p className="text-muted-foreground text-xs">
          {t("common.emptyListHint")}
        </p>
        {sensorOptions.length === 0 ? (
          <p className="text-muted-foreground mt-1 text-xs">
            {t("semiSupervised.noSensors")}
          </p>
        ) : (
          <Controller
            control={control}
            name={`${namePrefix}.sensors`}
            render={({ field }) => {
              const selected = new Set(
                (field.value ?? []) as readonly string[],
              );
              function toggle(value: string) {
                const next = new Set(selected);
                if (next.has(value)) next.delete(value);
                else next.add(value);
                field.onChange(
                  sensorOptions
                    .map((option) => option.id)
                    .filter((id) => next.has(id)),
                );
              }
              return (
                <div className="mt-2 grid gap-2">
                  {sensorOptions.map((option) => {
                    const id = `${namePrefix}-sensor-${option.id}`;
                    return (
                      <div
                        key={option.id}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          id={id}
                          checked={selected.has(option.id)}
                          onCheckedChange={() => toggle(option.id)}
                          disabled={disabled}
                          data-sensor={option.id}
                        />
                        <label htmlFor={id} className="cursor-pointer">
                          {option.name}
                          {option.hostname && (
                            <span className="text-muted-foreground ml-1">
                              ({option.hostname})
                            </span>
                          )}
                        </label>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
        )}
      </fieldset>
    </fieldset>
  );
}
