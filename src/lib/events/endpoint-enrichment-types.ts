import type { IpLocationResult } from "@/lib/detection/types";

export type EndpointEnrichmentMap = Record<
  string,
  IpLocationResult["ipLocation"]
>;
