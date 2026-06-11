"use client";

import { useTranslations } from "next-intl";

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
import {
  computeEventPeriodRange,
  type EventPeriodKey,
  type SamplingPolicy,
  type TimeSeriesFilter,
} from "@/lib/event";

import { EventPeriodPills } from "./event-period-pills";

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

/**
 * The Periodic Time Series filter form. A controlled component over the
 * draft {@link TimeSeriesFilter}.
 *
 * The `id` selector is backed by REview's `samplingPolicyList`: each
 * option's value is the policy `id`, labelled by its `name`. Apply is
 * blocked until a policy is chosen, because Giganto's
 * `TimeSeriesFilter.id` is required. The time window reuses the same
 * quick-range + start/end controls as the other Event views.
 */
export function TimeSeriesFilterForm({
  draft,
  policies,
  pending,
  onChange,
  onApply,
  onReset,
}: {
  draft: TimeSeriesFilter;
  policies: SamplingPolicy[] | null;
  pending: boolean;
  onChange: (next: TimeSeriesFilter) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  const t = useTranslations("event.timeSeries");
  const tf = useTranslations("event.filters");

  const set = (patch: Partial<TimeSeriesFilter>): void =>
    onChange({ ...draft, ...patch });

  const onSelectPeriod = (key: EventPeriodKey): void => {
    const range = computeEventPeriodRange(key);
    set({ period: key, start: range.start, end: range.end });
  };

  const policyList = policies ?? [];
  const noPolicy = !draft.id;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (noPolicy) return;
        onApply();
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ts-policy">{t("policy")}</Label>
          {policyList.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("noPoliciesAvailable")}
            </p>
          ) : (
            <Select
              value={draft.id ?? undefined}
              onValueChange={(value) => set({ id: value })}
            >
              <SelectTrigger id="ts-policy">
                <SelectValue placeholder={t("policyPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {policyList.map((policy) => (
                  <SelectItem key={policy.id} value={policy.id}>
                    {policy.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <EventPeriodPills selected={draft.period} onSelect={onSelectPeriod} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ts-start">{tf("start")}</Label>
          <Input
            id="ts-start"
            type="datetime-local"
            value={isoToLocalInput(draft.start)}
            onChange={(e) =>
              set({ period: null, start: localInputToIso(e.target.value) })
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ts-end">{tf("end")}</Label>
          <Input
            id="ts-end"
            type="datetime-local"
            value={isoToLocalInput(draft.end)}
            onChange={(e) =>
              set({ period: null, end: localInputToIso(e.target.value) })
            }
          />
        </div>
      </div>

      {noPolicy ? (
        <p className="text-muted-foreground text-sm" role="note">
          {t("policyRequired")}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending || noPolicy}>
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
