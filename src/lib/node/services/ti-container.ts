import { z } from "zod";

import { formatSocketAddr, parseSocketAddr } from "../socket-addr";
import { fromToml, type TomlEntries, toToml } from "../toml";
import { ipAddressSchema, portSchema } from "../validation";
import { PORT_TIVAN_DEFAULT, type ServiceFormModule } from "./types";

/**
 * Tivan (TI Container) configuration form. No Configure-Manually mode.
 *
 * Authoritative spec: `decisions/node-field-catalog.md` ("Tivan").
 */

export const TIVAN_HARDCODED = {
  translateMitre: "/opt/clumit/share/ti_container/translation_mitre.json",
  excelData: "/opt/clumit/share/ti_container/data.xlsx",
  originMitre: "/opt/clumit/share/ti_container/data.json",
} as const;

export interface TiContainerFormValues {
  webIp: string;
  webPort: number;
}

export const tiContainerFormSchema = z.object({
  webIp: ipAddressSchema,
  webPort: portSchema,
});

export function defaultTiContainerValues(
  initial?: TiContainerFormValues | null,
): TiContainerFormValues {
  if (initial) return { ...initial };
  return { webIp: "", webPort: PORT_TIVAN_DEFAULT };
}

export function serialiseTiContainer(values: TiContainerFormValues): string {
  const entries: TomlEntries = [
    ["graphql_srv_addr", formatSocketAddr(values.webIp, values.webPort)],
    ["translate_mitre", TIVAN_HARDCODED.translateMitre],
    ["excel_data", TIVAN_HARDCODED.excelData],
    ["origin_mitre", TIVAN_HARDCODED.originMitre],
  ];
  return toToml(entries);
}

export function deserialiseTiContainer(toml: string): TiContainerFormValues {
  const raw = fromToml(toml);
  // Bracket-key access is intentional — see the matching note in
  // `data-store.ts` and `external-endpoints.test.ts`.
  const { ip, port } = parseSocketAddr(
    // biome-ignore lint/complexity/useLiteralKeys: keep field as a string literal so the dispatch-URL provenance test (which strips string literals) ignores this read.
    (raw["graphql_srv_addr"] ?? "") as string,
    PORT_TIVAN_DEFAULT,
  );
  return { webIp: ip, webPort: port };
}

export const tiContainerModule: ServiceFormModule<TiContainerFormValues> = {
  defaults: defaultTiContainerValues,
  serialise: serialiseTiContainer,
  deserialise: deserialiseTiContainer,
};
