"use client";

import { useTranslations } from "next-intl";
import { Controller, useFormContext } from "react-hook-form";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DUMP_HTTP_CONTENT_TYPES,
  DUMP_ITEMS,
  PROTOCOLS_FOR_PIGLET,
} from "@/lib/node/services/sensor";
import { STANDARD_PORTS } from "@/lib/node/services/types";

import { FieldError } from "./shared/field-error";
import { IpPortInput } from "./shared/ip-port-input";
import { PortChipInput } from "./shared/port-chip-input";

interface SensorFormProps {
  namePrefix?: string;
  disabled?: boolean;
}

/**
 * Piglet (Sensor) form. Mirrors the catalog field-by-field; the
 * serialiser drives the on-the-wire ordering.
 */
export function SensorForm({
  namePrefix = "sensor",
  disabled,
}: SensorFormProps) {
  const t = useTranslations("nodes.forms");
  const { control, register, getFieldState, formState, watch } =
    useFormContext();

  function err(name: string): string | undefined {
    return getFieldState(`${namePrefix}.${name}`, formState).error?.message;
  }

  const dumpItems = (watch(`${namePrefix}.dumpItems`) ?? []) as string[];
  const showHttpContentTypes = dumpItems.includes("http");

  return (
    <fieldset disabled={disabled} className="grid gap-6">
      <legend className="sr-only">{t("sensor.legend")}</legend>

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

      <Controller
        control={control}
        name={`${namePrefix}.pciBusAddresses`}
        render={({ field }) => (
          <div className="grid gap-1">
            <Label htmlFor={`${namePrefix}-pci`}>
              {t("sensor.pciBusAddresses")}
            </Label>
            <Input
              id={`${namePrefix}-pci`}
              value={(field.value ?? []).join(",")}
              onChange={(event) =>
                field.onChange(
                  event.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0),
                )
              }
              placeholder={t("sensor.pciBusAddressesPlaceholder")}
            />
            <FieldError message={err("pciBusAddresses")} />
          </div>
        )}
      />

      <fieldset>
        <legend className="text-sm font-medium">{t("sensor.protocols")}</legend>
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
              field.onChange(PROTOCOLS_FOR_PIGLET.filter((p) => next.has(p)));
            }
            return (
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PROTOCOLS_FOR_PIGLET.map((proto) => {
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
                        {t(`sensor.protocolLabels.${proto}`)}
                      </label>
                    </div>
                  );
                })}
              </div>
            );
          }}
        />
      </fieldset>

      <Controller
        control={control}
        name={`${namePrefix}.ftpPorts`}
        render={({ field }) => (
          <PortChipInput
            idPrefix={`${namePrefix}-ftp-ports`}
            label={t("sensor.ftpPorts")}
            standardPorts={STANDARD_PORTS.ftp}
            value={(field.value ?? []) as number[]}
            onChange={field.onChange}
            error={err("ftpPorts")}
            disabled={disabled}
          />
        )}
      />
      <Controller
        control={control}
        name={`${namePrefix}.httpPorts`}
        render={({ field }) => (
          <PortChipInput
            idPrefix={`${namePrefix}-http-ports`}
            label={t("sensor.httpPorts")}
            standardPorts={STANDARD_PORTS.http}
            value={(field.value ?? []) as number[]}
            onChange={field.onChange}
            error={err("httpPorts")}
            disabled={disabled}
          />
        )}
      />
      <Controller
        control={control}
        name={`${namePrefix}.httpsPorts`}
        render={({ field }) => (
          <PortChipInput
            idPrefix={`${namePrefix}-https-ports`}
            label={t("sensor.httpsPorts")}
            standardPorts={STANDARD_PORTS.https}
            value={(field.value ?? []) as number[]}
            onChange={field.onChange}
            error={err("httpsPorts")}
            disabled={disabled}
          />
        )}
      />
      <Controller
        control={control}
        name={`${namePrefix}.sshPorts`}
        render={({ field }) => (
          <PortChipInput
            idPrefix={`${namePrefix}-ssh-ports`}
            label={t("sensor.sshPorts")}
            standardPorts={STANDARD_PORTS.ssh}
            value={(field.value ?? []) as number[]}
            onChange={field.onChange}
            error={err("sshPorts")}
            disabled={disabled}
          />
        )}
      />

      <fieldset>
        <legend className="text-sm font-medium">{t("sensor.dumpItems")}</legend>
        <p className="text-muted-foreground text-xs">
          {t("common.emptyListHint")}
        </p>
        <Controller
          control={control}
          name={`${namePrefix}.dumpItems`}
          render={({ field }) => {
            const selected = new Set((field.value ?? []) as readonly string[]);
            function toggle(value: string) {
              const next = new Set(selected);
              if (next.has(value)) next.delete(value);
              else next.add(value);
              field.onChange(DUMP_ITEMS.filter((p) => next.has(p)));
            }
            return (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {DUMP_ITEMS.map((item) => {
                  const id = `${namePrefix}-dump-${item}`;
                  return (
                    <div key={item} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        id={id}
                        checked={selected.has(item)}
                        onCheckedChange={() => toggle(item)}
                        disabled={disabled}
                        data-dump-item={item}
                      />
                      <label htmlFor={id} className="cursor-pointer">
                        {t(`sensor.dumpItemLabels.${item}`)}
                      </label>
                    </div>
                  );
                })}
              </div>
            );
          }}
        />
      </fieldset>

      {showHttpContentTypes && (
        <fieldset>
          <legend className="text-sm font-medium">
            {t("sensor.dumpHttpContentTypes")}
          </legend>
          <p className="text-muted-foreground text-xs">
            {t("common.emptyListHint")}
          </p>
          <Controller
            control={control}
            name={`${namePrefix}.dumpHttpContentTypes`}
            render={({ field }) => {
              const selected = new Set(
                (field.value ?? []) as readonly string[],
              );
              function toggle(value: string) {
                const next = new Set(selected);
                if (next.has(value)) next.delete(value);
                else next.add(value);
                field.onChange(
                  DUMP_HTTP_CONTENT_TYPES.filter((p) => next.has(p)),
                );
              }
              return (
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {DUMP_HTTP_CONTENT_TYPES.map((item) => {
                    const id = `${namePrefix}-dump-http-${item}`;
                    return (
                      <div
                        key={item}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          id={id}
                          checked={selected.has(item)}
                          onCheckedChange={() => toggle(item)}
                          disabled={disabled}
                          data-dump-http-content={item}
                        />
                        <label htmlFor={id} className="cursor-pointer">
                          {t(`sensor.dumpHttpLabels.${item}`)}
                        </label>
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
        </fieldset>
      )}

      <div className="grid gap-1">
        <Label htmlFor={`${namePrefix}-pcap-max`}>
          {t("sensor.pcapMaxSize")}
        </Label>
        <Input
          id={`${namePrefix}-pcap-max`}
          type="number"
          min={0}
          max={65535}
          {...register(`${namePrefix}.pcapMaxSize`, { valueAsNumber: true })}
        />
        <FieldError message={err("pcapMaxSize")} />
      </div>
    </fieldset>
  );
}
