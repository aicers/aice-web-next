"use client";

import { useTranslations } from "next-intl";

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
import { computePeriodRange, PERIOD_KEYS } from "@/lib/detection/period";
import {
  STATISTICS_PROTOCOLS,
  type StatisticsFilter,
  type StatisticsProtocol,
} from "@/lib/event";

const QUICK_RANGE_NONE = "none";

/** Convert an ISO-8601 UTC string to a `datetime-local` input value. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

/** Convert a `datetime-local` input value to an ISO-8601 UTC string. */
function localInputToIso(local: string): string | null {
  if (!local) return null;
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Add or remove `item` from `list`, preserving order. */
function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item)
    ? list.filter((value) => value !== item)
    : [...list, item];
}

/**
 * The Statistics-view filter form. A controlled component over the
 * draft {@link StatisticsFilter}.
 *
 * Unlike the Conn event search, `statistics` takes a multi-sensor list,
 * so the sensor control is a dedicated multi-select (checkboxes).
 * Apply is blocked until at least one sensor is chosen, because Giganto
 * rejects an empty required `sensors` list. The protocol picker is
 * constrained to the 0.27.0 allowed `RawEventKind` keys; leaving it
 * empty means "all protocols the API returns".
 */
export function StatisticsFilterForm({
  draft,
  sensors,
  pending,
  onChange,
  onApply,
  onReset,
}: {
  draft: StatisticsFilter;
  sensors: string[] | null;
  pending: boolean;
  onChange: (next: StatisticsFilter) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  const t = useTranslations("event.statistics");
  const tf = useTranslations("event.filters");
  const tp = useTranslations("event.periods");
  const tpr = useTranslations("event.protocols");

  const set = (patch: Partial<StatisticsFilter>): void =>
    onChange({ ...draft, ...patch });

  const applyQuickRange = (key: string): void => {
    if (key === QUICK_RANGE_NONE) return;
    const range = computePeriodRange(key as (typeof PERIOD_KEYS)[number]);
    set({ start: range.start, end: range.end });
  };

  const noSensors = draft.sensors.length === 0;
  const sensorList = sensors ?? [];

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (noSensors) return;
        onApply();
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("sensors")}</legend>
        {sensorList.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("noSensorsAvailable")}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {sensorList.map((sensor) => {
              const id = `stat-sensor-${sensor}`;
              return (
                <label
                  key={sensor}
                  htmlFor={id}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    id={id}
                    checked={draft.sensors.includes(sensor)}
                    onCheckedChange={() =>
                      set({ sensors: toggle(draft.sensors, sensor) })
                    }
                  />
                  <span className="truncate">{sensor}</span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="stat-quick-range">{tf("quickRange")}</Label>
          <Select
            defaultValue={QUICK_RANGE_NONE}
            onValueChange={applyQuickRange}
          >
            <SelectTrigger id="stat-quick-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={QUICK_RANGE_NONE}>
                {tf("quickRangeNone")}
              </SelectItem>
              {PERIOD_KEYS.map((key) => (
                <SelectItem key={key} value={key}>
                  {tp(key)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="stat-start">{tf("start")}</Label>
          <Input
            id="stat-start"
            type="datetime-local"
            value={isoToLocalInput(draft.start)}
            onChange={(e) => set({ start: localInputToIso(e.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="stat-end">{tf("end")}</Label>
          <Input
            id="stat-end"
            type="datetime-local"
            value={isoToLocalInput(draft.end)}
            onChange={(e) => set({ end: localInputToIso(e.target.value) })}
          />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("protocols")}</legend>
        <p className="text-muted-foreground text-xs">{t("protocolsHint")}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {STATISTICS_PROTOCOLS.map((protocol) => {
            const id = `stat-protocol-${protocol}`;
            return (
              <label
                key={protocol}
                htmlFor={id}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  id={id}
                  checked={draft.protocols.includes(protocol)}
                  onCheckedChange={() =>
                    set({
                      protocols: toggle<StatisticsProtocol>(
                        draft.protocols,
                        protocol,
                      ),
                    })
                  }
                />
                <span className="truncate">{tpr(protocol)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {noSensors ? (
        <p className="text-muted-foreground text-sm" role="note">
          {t("sensorRequired")}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || noSensors}>
          {tf("apply")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onReset}
          disabled={pending}
        >
          {tf("reset")}
        </Button>
      </div>
    </form>
  );
}
