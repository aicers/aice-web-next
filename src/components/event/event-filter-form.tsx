"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
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
import { type EventFilter, isPortString, RECORD_TYPE_IDS } from "@/lib/event";

const QUICK_RANGE_NONE = "none";

/** The four `EventFilter` keys backed by a port `<input>`. */
type PortKey =
  | "origPortStart"
  | "origPortEnd"
  | "respPortStart"
  | "respPortEnd";

/** Render a committed port number as its `<input>` text. */
function portToRaw(value: number | null): string {
  return value === null ? "" : String(value);
}

/** Convert an ISO-8601 UTC string to a `datetime-local` input value. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // Shift into the local zone, then trim the seconds/zone suffix so the
  // value matches the `YYYY-MM-DDTHH:mm` shape datetime-local expects.
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

/**
 * The Event-menu filter form. A controlled component over the draft
 * {@link EventFilter}: every field edit raises `onChange`, and the
 * parent commits the draft to the URL on `onApply`.
 *
 * Giganto's `NetworkFilter.sensor` is a single `String!`, so the sensor
 * picker is a single-select. `sensors === null` means the sensor list
 * could not be loaded from Giganto; the picker is disabled and the
 * parent surfaces the unavailable notice.
 */
export function EventFilterForm({
  draft,
  sensors,
  pending,
  onChange,
  onApply,
  onReset,
}: {
  draft: EventFilter;
  sensors: string[] | null;
  pending: boolean;
  onChange: (next: EventFilter) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  const t = useTranslations("event");
  const tf = useTranslations("event.filters");
  const tp = useTranslations("event.periods");

  const set = (patch: Partial<EventFilter>): void =>
    onChange({ ...draft, ...patch });

  const applyQuickRange = (key: string): void => {
    if (key === QUICK_RANGE_NONE) return;
    const range = computePeriodRange(key as (typeof PERIOD_KEYS)[number]);
    set({ start: range.start, end: range.end });
  };

  // Port inputs keep their raw text locally so an invalid entry
  // (decimal, exponent, or out-of-range) stays on screen and blocks
  // Apply, instead of being coerced into a different port. The
  // committed numeric draft only ever holds a valid port or null.
  // `key` on this component (bumped by the parent on Reset) re-seeds
  // this state from the cleared draft.
  const [rawPorts, setRawPorts] = useState<Record<PortKey, string>>(() => ({
    origPortStart: portToRaw(draft.origPortStart),
    origPortEnd: portToRaw(draft.origPortEnd),
    respPortStart: portToRaw(draft.respPortStart),
    respPortEnd: portToRaw(draft.respPortEnd),
  }));

  const setPort = (key: PortKey, raw: string): void => {
    setRawPorts((prev) => ({ ...prev, [key]: raw }));
    const trimmed = raw.trim();
    const value = isPortString(trimmed) ? Number.parseInt(trimmed, 10) : null;
    set({ [key]: value } as Partial<EventFilter>);
  };

  // Icmp records have no ports, so port bounds are not applied for them
  // (mirrored server-side in `toNetworkFilter`). Disable the port inputs
  // and ignore their validity so a leftover entry never blocks Apply
  // after switching to Icmp.
  const portsDisabled = draft.recordType === "icmp";

  // A port input is invalid when non-empty but not an accepted port
  // string. The server drops such values when parsing the URL, so the
  // form blocks Apply rather than let the query silently widen past
  // what the operator sees (`70000` and `443.5` alike). Shares
  // {@link isPortString} with the URL parser so the two agree.
  const portRawInvalid = (raw: string): boolean =>
    raw.trim() !== "" && !isPortString(raw.trim());
  const anyPortInvalid =
    !portsDisabled &&
    (portRawInvalid(rawPorts.origPortStart) ||
      portRawInvalid(rawPorts.origPortEnd) ||
      portRawInvalid(rawPorts.respPortStart) ||
      portRawInvalid(rawPorts.respPortEnd));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (anyPortInvalid) return;
        onApply();
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/*
          Record type is the "record-type/protocol selector" from the
          issue scope: it picks which Giganto event kind to browse.
          There is no separate protocol filter because Giganto's
          `NetworkFilter` has no protocol field — the IP protocol is a
          per-record value shown as a results column, not a query input.
        */}
        <div className="space-y-1.5">
          <Label htmlFor="event-record-type">{t("recordType")}</Label>
          <Select
            value={draft.recordType}
            onValueChange={(value) =>
              set({ recordType: value as EventFilter["recordType"] })
            }
          >
            <SelectTrigger id="event-record-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RECORD_TYPE_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {t(`recordTypes.${id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="event-sensor">{tf("sensor")}</Label>
          <Select
            value={draft.sensor ?? ""}
            onValueChange={(value) => set({ sensor: value })}
            disabled={sensors === null || sensors.length === 0}
          >
            <SelectTrigger id="event-sensor">
              <SelectValue placeholder={tf("sensorPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {(sensors ?? []).map((sensor) => (
                <SelectItem key={sensor} value={sensor}>
                  {sensor}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="event-quick-range">{tf("quickRange")}</Label>
          <Select
            defaultValue={QUICK_RANGE_NONE}
            onValueChange={applyQuickRange}
          >
            <SelectTrigger id="event-quick-range">
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
          <Label htmlFor="event-start">{tf("start")}</Label>
          <Input
            id="event-start"
            type="datetime-local"
            value={isoToLocalInput(draft.start)}
            onChange={(e) => set({ start: localInputToIso(e.target.value) })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="event-end">{tf("end")}</Label>
          <Input
            id="event-end"
            type="datetime-local"
            value={isoToLocalInput(draft.end)}
            onChange={(e) => set({ end: localInputToIso(e.target.value) })}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <RangeField
          label={tf("origAddr")}
          startLabel={tf("rangeStart")}
          endLabel={tf("rangeEnd")}
          idPrefix="event-orig-addr"
          startValue={draft.origAddrStart ?? ""}
          endValue={draft.origAddrEnd ?? ""}
          onStart={(v) => set({ origAddrStart: v || null })}
          onEnd={(v) => set({ origAddrEnd: v || null })}
        />
        <RangeField
          label={tf("respAddr")}
          startLabel={tf("rangeStart")}
          endLabel={tf("rangeEnd")}
          idPrefix="event-resp-addr"
          startValue={draft.respAddrStart ?? ""}
          endValue={draft.respAddrEnd ?? ""}
          onStart={(v) => set({ respAddrStart: v || null })}
          onEnd={(v) => set({ respAddrEnd: v || null })}
        />
        <RangeField
          label={tf("origPort")}
          startLabel={tf("rangeStart")}
          endLabel={tf("rangeEnd")}
          idPrefix="event-orig-port"
          type="number"
          disabled={portsDisabled}
          startValue={rawPorts.origPortStart}
          endValue={rawPorts.origPortEnd}
          startInvalid={
            !portsDisabled && portRawInvalid(rawPorts.origPortStart)
          }
          endInvalid={!portsDisabled && portRawInvalid(rawPorts.origPortEnd)}
          onStart={(v) => setPort("origPortStart", v)}
          onEnd={(v) => setPort("origPortEnd", v)}
        />
        <RangeField
          label={tf("respPort")}
          startLabel={tf("rangeStart")}
          endLabel={tf("rangeEnd")}
          idPrefix="event-resp-port"
          type="number"
          disabled={portsDisabled}
          startValue={rawPorts.respPortStart}
          endValue={rawPorts.respPortEnd}
          startInvalid={
            !portsDisabled && portRawInvalid(rawPorts.respPortStart)
          }
          endInvalid={!portsDisabled && portRawInvalid(rawPorts.respPortEnd)}
          onStart={(v) => setPort("respPortStart", v)}
          onEnd={(v) => setPort("respPortEnd", v)}
        />
      </div>

      {portsDisabled ? (
        <p className="text-muted-foreground text-sm">
          {tf("portsNotApplicable")}
        </p>
      ) : null}

      {anyPortInvalid ? (
        <p className="text-destructive text-sm" role="alert">
          {tf("portRangeInvalid")}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || anyPortInvalid}>
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

function RangeField({
  label,
  startLabel,
  endLabel,
  idPrefix,
  type = "text",
  disabled = false,
  startValue,
  endValue,
  startInvalid = false,
  endInvalid = false,
  onStart,
  onEnd,
}: {
  label: string;
  startLabel: string;
  endLabel: string;
  idPrefix: string;
  type?: "text" | "number";
  disabled?: boolean;
  startValue: string;
  endValue: string;
  startInvalid?: boolean;
  endInvalid?: boolean;
  onStart: (value: string) => void;
  onEnd: (value: string) => void;
}) {
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex items-center gap-2">
        <Input
          id={`${idPrefix}-start`}
          type={type}
          aria-label={`${label} ${startLabel}`}
          aria-invalid={startInvalid || undefined}
          placeholder={startLabel}
          value={startValue}
          onChange={(e) => onStart(e.target.value)}
        />
        <span className="text-muted-foreground">–</span>
        <Input
          id={`${idPrefix}-end`}
          type={type}
          aria-label={`${label} ${endLabel}`}
          aria-invalid={endInvalid || undefined}
          placeholder={endLabel}
          value={endValue}
          onChange={(e) => onEnd(e.target.value)}
        />
      </div>
    </fieldset>
  );
}
