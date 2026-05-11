/**
 * End-to-end render coverage for #278's forbidden-sensor-scope banner.
 * Pairs with `detection-shell-forbidden-sensor.test.ts` (pure helper
 * branches) by exercising the actual JSX path the shell renders into
 * the result region — the labels-driven branch selection, the cached
 * name resolution against the page-session sensor cache, and the
 * recovery button's click dispatch.
 *
 * Covers both trigger scenarios called out in the issue's acceptance:
 *   - mid-session scope change: every offending id is still in the
 *     cache, so the banner names each one (the "cached-name" path);
 *   - URL-tampered / stale-share-link: no offending id is in the
 *     cache, so the banner falls back to a count (the "uncached-id"
 *     path).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// `detection-shell.tsx` transitively imports next-intl + next/navigation;
// the test environment cannot resolve them without these mocks, even
// though the banner itself does not touch them.
vi.mock("next/navigation", () => ({
  usePathname: () => "/detection",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const { ForbiddenSensorBanner } = await import(
  "@/components/detection/detection-shell"
);

const LABELS = {
  title: "Sensor selection no longer accessible",
  descriptionNamed: "Named: {names}.",
  descriptionUnresolved: "Unresolved: {count}.",
  descriptionMixed: "Named: {names}, plus {count} unresolved.",
  recoveryAction: "Drop unavailable sensors and re-apply",
  recoveryConfirmation: "Dropped unavailable sensors.",
};

describe("ForbiddenSensorBanner (#278) — shell render", () => {
  it("renders nothing when ids is null (no forbidden state)", () => {
    const { container } = render(
      <ForbiddenSensorBanner
        ids={null}
        sensorOptions={[]}
        labels={LABELS}
        onRecover={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when ids is empty (defensive guard)", () => {
    const { container } = render(
      <ForbiddenSensorBanner
        ids={[]}
        sensorOptions={[]}
        labels={LABELS}
        onRecover={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  // Mid-session scope change: the operator picked sensors from the
  // drawer (so they are still in the page-session cache), then the
  // admin revoked their customer scope. The banner must use the
  // cached-name copy and render the resolved hostFqdn list.
  it("renders the named branch when every offending id resolves from cache", () => {
    render(
      <ForbiddenSensorBanner
        ids={["s1", "s2"]}
        sensorOptions={[
          { id: "s1", name: "alpha.example" },
          { id: "s2", name: "beta.example" },
          { id: "s3", name: "gamma.example" },
        ]}
        labels={LABELS}
        onRecover={() => {}}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.getByText("Named: alpha.example, beta.example."),
    ).toBeTruthy();
    expect(screen.queryByText(/Unresolved:/)).toBeNull();
  });

  // URL-tampered / stale-share-link path: no offending id was ever in
  // the cache, so name lookup is impossible without an extra fetch
  // (out of scope). The banner falls back to the count copy.
  it("renders the unresolved branch when no id resolves from cache", () => {
    render(
      <ForbiddenSensorBanner
        ids={["tampered-1", "tampered-2", "tampered-3"]}
        sensorOptions={[{ id: "s1", name: "alpha.example" }]}
        labels={LABELS}
        onRecover={() => {}}
      />,
    );
    expect(screen.getByText("Unresolved: 3.")).toBeTruthy();
    expect(screen.queryByText(/Named:/)).toBeNull();
  });

  // Mixed path: operator-selected ids are still cached, URL-injected
  // ids are not. The banner combines both so the operator still sees
  // every resolved name plus the count of the rest.
  it("renders the mixed branch when some ids resolve and others do not", () => {
    render(
      <ForbiddenSensorBanner
        ids={["s1", "tampered", "s2", "stale"]}
        sensorOptions={[
          { id: "s1", name: "alpha.example" },
          { id: "s2", name: "beta.example" },
        ]}
        labels={LABELS}
        onRecover={() => {}}
      />,
    );
    expect(
      screen.getByText(
        "Named: alpha.example, beta.example, plus 2 unresolved.",
      ),
    ).toBeTruthy();
  });

  // The recovery action is the only path back for the operator —
  // clicking it must invoke the shell-supplied handler that drops
  // sensor ids, refreshes the cache, and re-applies. The handler
  // itself is exercised in `detection-shell-apply.test.ts`; here we
  // verify the wire-up so a future banner refactor that orphans the
  // button gets caught.
  it("invokes onRecover exactly once when the recovery button is clicked", () => {
    const onRecover = vi.fn();
    render(
      <ForbiddenSensorBanner
        ids={["s1"]}
        sensorOptions={[{ id: "s1", name: "alpha.example" }]}
        labels={LABELS}
        onRecover={onRecover}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Drop unavailable sensors and re-apply",
      }),
    );
    expect(onRecover).toHaveBeenCalledTimes(1);
  });
});
