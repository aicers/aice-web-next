"use client";

import { useEffect, useMemo, useRef } from "react";

import { coordinatedDrain } from "@/lib/aimer/phase2/drain-coordinator.client";
import {
  createPeriodicDrain,
  type DrainOptions,
  type DrainResult,
  type PeriodicDrainController,
  type Phase2DrainKind,
} from "@/lib/aimer/phase2/transport.client";
import { mutatingFetch } from "@/lib/csrf-client";

/**
 * App-shell Phase 2 push cadence manager (#651).
 *
 * Centralizes the per-customer opportunistic-push cadence that used to
 * be mounted inside the Triage Stories / baseline screens (#493). One
 * {@link createPeriodicDrain} runs per `(customer, kind)` for the
 * streaming kinds `['baseline_event', 'story']` while the operator is
 * signed in — not just while a Triage screen happens to be open — so
 * the consent label "every 5 min while signed in" is honest.
 *
 * The cadence is opt-in (RFC 0002 Phase 2 consent): a controller starts
 * only for customers whose `cadence_enabled` flag is set. The enabled
 * set is fetched from `GET /api/aimer/phase2/cadence-config` on mount
 * and re-fetched whenever the Settings toggle dispatches
 * {@link CADENCE_CHANGED_EVENT}, so flipping the toggle takes effect
 * without a reload. Consent is **fail-closed**: an opt-out event stops
 * that customer's controllers in this tab immediately, before (and
 * regardless of) the authoritative config refetch, so withdrawn consent
 * never keeps auto-forwarding just because the refetch failed.
 *
 *   - `policy_event` is excluded — it is queue-only with no
 *     `aimer_push_state` cursor for a cadence to advance. Manual "Sync
 *     now" still drains it.
 *   - Each tick routes through {@link coordinatedDrain} so the cadence
 *     and the Settings "Sync now" button do not run concurrent drains
 *     for the same `(kind, customer)` within one tab.
 *   - A tick that actually changed server state
 *     (`totalDelivered + totalNoOp > 0`) records one
 *     `aimer_phase2.cadence_drain` audit row via the thin wrapper route;
 *     bare no-op ticks record nothing.
 *
 * Renders nothing — it is a lifecycle host mounted in the dashboard
 * shell. Gated to System Administrators by the caller (the whole Phase 2
 * surface is admin-only).
 */

const CADENCE_KINDS = [
  "baseline_event",
  "story",
] as const satisfies readonly Phase2DrainKind[];

const CADENCE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Window event the Settings cadence toggle dispatches after a successful
 * flip so this manager re-reads `cadence-config` and reconciles its
 * controllers in the same tab without waiting for a reload.
 *
 * Dispatched as a {@link CustomEvent} carrying {@link CadenceChangedDetail}
 * so an opt-out can be honored fail-closed even if the config refetch
 * fails. A plain `Event` (no detail) still triggers a refetch-driven
 * reconcile.
 */
export const CADENCE_CHANGED_EVENT = "aimer-phase2-cadence-changed";

/** `detail` payload carried by {@link CADENCE_CHANGED_EVENT}. */
export interface CadenceChangedDetail {
  customerId: number;
  enabled: boolean;
}

interface CadenceConfigEntry {
  customer_id: number;
  cadence_enabled: boolean;
}

interface CadenceConfigDto {
  customers: CadenceConfigEntry[];
}

async function recordCadenceDrain(
  customerId: number,
  kind: Phase2DrainKind,
  result: DrainResult,
): Promise<void> {
  try {
    await mutatingFetch("/api/aimer/phase2/cadence-drain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: customerId,
        kind,
        delivered: result.totalDelivered,
        no_op: result.totalNoOp,
      }),
    });
  } catch {
    // Best-effort audit — a failed POST must not disrupt the cadence.
  }
}

/**
 * Drain used by every cadence controller. Serializes against other
 * in-tab drains via the coordinator, then records the state-change-only
 * audit. The signature matches {@link drainOpportunisticPushQueue} so it
 * can be passed straight to `createPeriodicDrain`'s `drain` option.
 */
async function cadenceDrain(
  kind: Phase2DrainKind,
  customerId: number,
  options: DrainOptions,
): Promise<DrainResult> {
  const result = await coordinatedDrain(kind, customerId, options);
  if (result.totalDelivered + result.totalNoOp > 0) {
    void recordCadenceDrain(customerId, kind, result);
  }
  return result;
}

interface Props {
  /** In-scope customer ids (from the dashboard `scope.customers`). */
  customerIds: readonly number[];
}

export function AimerPhase2CadenceManager({ customerIds }: Props) {
  const controllersRef = useRef<Map<string, PeriodicDrainController>>(
    new Map(),
  );
  // Stable key so the effect only re-runs when the in-scope customer set
  // actually changes, not on every parent re-render's array rotation.
  const scopeKey = useMemo(
    () => [...customerIds].sort((a, b) => a - b).join(","),
    [customerIds],
  );

  useEffect(() => {
    const inScope = new Set<number>(
      scopeKey === "" ? [] : scopeKey.split(",").map((s) => Number(s)),
    );
    const controllers = controllersRef.current;
    let cancelled = false;

    // Stop and forget every controller for one customer. Used to honor an
    // opt-out fail-closed without waiting on the config refetch.
    const stopCustomer = (customerId: number): void => {
      for (const kind of CADENCE_KINDS) {
        const key = `${kind}:${customerId}`;
        const controller = controllers.get(key);
        if (controller) {
          controller.stop();
          controllers.delete(key);
        }
      }
    };

    const reconcile = (enabledIds: Set<number>): void => {
      const desired = new Set<string>();
      for (const customerId of enabledIds) {
        if (!inScope.has(customerId)) continue;
        for (const kind of CADENCE_KINDS) {
          desired.add(`${kind}:${customerId}`);
        }
      }
      // Stop controllers that are no longer desired (customer opted out
      // or left scope).
      for (const [key, controller] of controllers) {
        if (!desired.has(key)) {
          controller.stop();
          controllers.delete(key);
        }
      }
      // Start controllers that newly became desired.
      for (const customerId of enabledIds) {
        if (!inScope.has(customerId)) continue;
        for (const kind of CADENCE_KINDS) {
          const key = `${kind}:${customerId}`;
          if (controllers.has(key)) continue;
          const controller = createPeriodicDrain(kind, customerId, {
            intervalMs: CADENCE_INTERVAL_MS,
            drain: cadenceDrain,
          });
          controllers.set(key, controller);
          controller.start();
        }
      }
    };

    const fetchAndReconcile = async (): Promise<void> => {
      try {
        const res = await fetch("/api/aimer/phase2/cadence-config", {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const dto = (await res.json()) as CadenceConfigDto;
        if (cancelled) return;
        const enabled = new Set<number>(
          dto.customers
            .filter((c) => c.cadence_enabled)
            .map((c) => c.customer_id),
        );
        reconcile(enabled);
      } catch {
        // Swallow — a failed config fetch leaves the current controllers
        // untouched; the next change event or remount retries.
      }
    };

    void fetchAndReconcile();
    const onChanged = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<CadenceChangedDetail>>)
        .detail;
      // Fail closed: an explicit opt-out stops this customer's controllers
      // right away, so consent withdrawal halts auto-forwarding even if the
      // config refetch below returns non-OK or throws.
      if (detail?.enabled === false && typeof detail.customerId === "number") {
        stopCustomer(detail.customerId);
      }
      void fetchAndReconcile();
    };
    window.addEventListener(CADENCE_CHANGED_EVENT, onChanged);

    return () => {
      cancelled = true;
      window.removeEventListener(CADENCE_CHANGED_EVENT, onChanged);
      for (const controller of controllers.values()) controller.stop();
      controllers.clear();
    };
  }, [scopeKey]);

  return null;
}
