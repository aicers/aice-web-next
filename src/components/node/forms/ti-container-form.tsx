"use client";

import { useTranslations } from "next-intl";
import { Controller, useFormContext } from "react-hook-form";

import { IpPortInput } from "./shared/ip-port-input";

interface TiContainerFormProps {
  /** Form-state path under which TI-container fields live. */
  namePrefix?: string;
  disabled?: boolean;
}

/**
 * Tivan (TI Container) form. Exposes a single "Web IP + Port" pair —
 * the rest of the wire fields are hardcoded server-side constants.
 */
export function TiContainerForm({
  namePrefix = "tiContainer",
  disabled,
}: TiContainerFormProps) {
  const t = useTranslations("nodes.forms");
  const { control, getFieldState, formState } = useFormContext();
  const ipState = getFieldState(`${namePrefix}.webIp`, formState);
  const portState = getFieldState(`${namePrefix}.webPort`, formState);

  return (
    <fieldset disabled={disabled} className="grid gap-4">
      <legend className="sr-only">{t("tiContainer.legend")}</legend>
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
                ipLabel={t("tiContainer.webIp")}
                portLabel={t("tiContainer.webPort")}
                ipValue={ipField.value ?? ""}
                portValue={portField.value ?? Number.NaN}
                onIpChange={ipField.onChange}
                onPortChange={portField.onChange}
                ipError={ipState.error?.message}
                portError={portState.error?.message}
                required
                disabled={disabled}
              />
            )}
          />
        )}
      />
    </fieldset>
  );
}
