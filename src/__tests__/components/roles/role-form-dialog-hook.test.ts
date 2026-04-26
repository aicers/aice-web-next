/**
 * Role-form interaction contract for the new node/service
 * permissions (#307).
 *
 * Reviewer Round 1 (#354) flagged that the previous SSR-only test
 * could not catch a regression that dropped `nodes:*` / `services:*`
 * from the PATCH/POST payload — `renderToStaticMarkup` does not
 * dispatch checkbox toggles or run submit handlers. This test pins
 * down the click-to-fetch path by exercising the extracted
 * `useRoleForm` hook with the same React-stub pattern used by
 * `use-csv-export.test.ts` (the project deliberately does not ship
 * `@testing-library/react`).
 *
 * The hook is the unit under test because it owns every line of
 * client-side behaviour the dialog wires into JSX:
 *   - initial selected-permissions seeded from `role` / `cloneSource`
 *   - `togglePermission` add/remove
 *   - `handleSubmit` building the JSON payload and calling `fetch`
 *   - error / success branching off the response
 *
 * If any of those drop the new permissions, the assertions below
 * fail. The dialog component itself is a thin renderer over this
 * hook (verified separately by `role-form-dialog.test.tsx`'s SSR
 * checks for the rendered checkbox grid and pre-checked state).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/session/session-extension-dialog", () => ({
  readCsrfToken: () => "test-csrf",
}));

// ── React hook stub ────────────────────────────────

type StateEntry<T> = { value: T; setter: (v: T | ((p: T) => T)) => void };
const stateEntries: Array<StateEntry<unknown>> = [];

function pushState<T>(initial: T): StateEntry<T> {
  const entry: StateEntry<T> = {
    value: initial,
    setter: (v) => {
      entry.value =
        typeof v === "function" ? (v as (p: T) => T)(entry.value) : v;
    },
  };
  stateEntries.push(entry as StateEntry<unknown>);
  return entry;
}

function resetStateEntries() {
  stateEntries.length = 0;
}

type EffectCleanup = () => void;
const effectCallbacks: Array<() => undefined | EffectCleanup> = [];

vi.mock("react", () => {
  let stateIdx = 0;
  return {
    useCallback: (fn: unknown) => fn,
    useEffect: (cb: () => undefined | EffectCleanup, _deps?: unknown) => {
      effectCallbacks.push(cb);
    },
    useState: (initial: unknown) => {
      const idx = stateIdx++;
      let entry = stateEntries[idx];
      if (!entry) {
        const resolved =
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial;
        entry = pushState(resolved);
      }
      return [entry.value, entry.setter];
    },
    __resetReact: () => {
      stateIdx = 0;
    },
  };
});

async function loadHook() {
  const mod = await import("@/components/roles/role-form-dialog");
  const reactMod = (await import("react")) as unknown as {
    __resetReact: () => void;
  };
  reactMod.__resetReact();
  effectCallbacks.length = 0;
  return mod.useRoleForm;
}

// React rebuilds `useCallback` closures each render, so the production
// component always submits with the latest state. The lightweight stub
// returns the original callback verbatim, so a test that mutates state
// after the first hook call re-invokes `loadHook()` (which resets the
// state-index cursor while leaving `stateEntries` intact) and then
// calls the hook again. Same trick `use-csv-export.test.ts` uses
// around its confirmAndContinue / cancelConfirmation paths.

function setup() {
  resetStateEntries();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

function selectedPermissionsValue(): Set<string> {
  // Layout: 0=name, 1=description, 2=selectedPermissions, 3=submitting, 4=error
  return stateEntries[2].value as Set<string>;
}

function nameValue(): string {
  return stateEntries[0].value as string;
}

describe("useRoleForm — node/service permission round-trip", () => {
  it("seeds selected permissions from the role being edited so the new groups land pre-checked", async () => {
    setup();
    const useRoleForm = await loadHook();
    const role = {
      id: 42,
      name: "Custom Node Operator",
      description: "Edits nodes",
      permissions: ["nodes:read", "services:write"],
    };

    const result = useRoleForm({
      open: true,
      role,
      onOpenChange: () => {},
      onSuccess: () => {},
      errorFallback: "failed",
    });

    expect(result.isEdit).toBe(true);
    expect(result.name).toBe("Custom Node Operator");
    expect(result.selectedPermissions.has("nodes:read")).toBe(true);
    expect(result.selectedPermissions.has("services:write")).toBe(true);
    // Permissions the role does not hold are not selected.
    expect(result.selectedPermissions.has("nodes:write")).toBe(false);
    expect(result.selectedPermissions.has("nodes:delete")).toBe(false);
    expect(result.selectedPermissions.has("services:read")).toBe(false);
  });

  it("seeds selected permissions from cloneSource on a clone open", async () => {
    setup();
    const useRoleForm = await loadHook();
    const cloneSource = {
      id: 7,
      name: "Source",
      description: "src",
      permissions: ["nodes:read", "nodes:write", "services:read"],
    };

    const result = useRoleForm({
      open: true,
      cloneSource,
      onOpenChange: () => {},
      onSuccess: () => {},
      errorFallback: "failed",
    });

    // Clone reuses the description but starts with an empty name so
    // the operator must pick a fresh one.
    expect(result.isEdit).toBe(false);
    expect(result.name).toBe("");
    expect(result.description).toBe("src");
    expect([...result.selectedPermissions].sort()).toEqual(
      ["nodes:read", "nodes:write", "services:read"].sort(),
    );
  });

  it("togglePermission adds a new node/service permission to the selection", async () => {
    setup();
    const useRoleForm = await loadHook();
    const result = useRoleForm({
      open: true,
      onOpenChange: () => {},
      onSuccess: () => {},
      errorFallback: "failed",
    });

    expect(result.selectedPermissions.has("nodes:read")).toBe(false);

    result.togglePermission("nodes:read");
    result.togglePermission("services:write");

    expect(selectedPermissionsValue().has("nodes:read")).toBe(true);
    expect(selectedPermissionsValue().has("services:write")).toBe(true);

    // Toggling again removes — covers the un-check path.
    result.togglePermission("nodes:read");
    expect(selectedPermissionsValue().has("nodes:read")).toBe(false);
    expect(selectedPermissionsValue().has("services:write")).toBe(true);
  });

  it("handleSubmit POSTs a create payload that includes toggled-on node/service permissions", async () => {
    const { fetchMock } = setup();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    const args = {
      open: true,
      onOpenChange,
      onSuccess,
      errorFallback: "failed",
    };
    const useRoleForm = await loadHook();
    const result = useRoleForm(args);

    // Operator types a name and ticks the new permission boxes.
    result.setName("Node Operator");
    result.setDescription("Manages nodes & services");
    result.togglePermission("nodes:read");
    result.togglePermission("nodes:write");
    result.togglePermission("services:write");

    // Re-invoke the hook so handleSubmit's closure observes the
    // latest state. Same trick `use-csv-export.test.ts` uses around
    // its confirmAndContinue / cancelConfirmation paths.
    const useRoleFormAfterToggle = await loadHook();
    const next = useRoleFormAfterToggle(args);
    await next.handleSubmit({ preventDefault: () => {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("/api/roles");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["X-CSRF-Token"]).toBe("test-csrf");

    const payload = JSON.parse(init.body) as {
      name: string;
      description: string | null;
      permissions: string[];
    };
    expect(payload.name).toBe("Node Operator");
    expect(payload.description).toBe("Manages nodes & services");
    expect(payload.permissions.sort()).toEqual(
      ["nodes:read", "nodes:write", "services:write"].sort(),
    );

    // Successful submit closes the dialog and refreshes the table.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("handleSubmit PATCHes an edit payload preserving pre-selected node/service permissions plus user toggles", async () => {
    const { fetchMock } = setup();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    const useRoleForm = await loadHook();
    const role = {
      id: 99,
      name: "Custom Node Operator",
      description: "Existing",
      // Pre-existing permissions on the role.
      permissions: ["nodes:read", "services:read"],
    };

    const args = {
      open: true,
      role,
      onOpenChange,
      onSuccess,
      errorFallback: "failed",
    };
    const result = useRoleForm(args);

    // Operator adds `services:write` and removes `services:read`.
    result.togglePermission("services:write");
    result.togglePermission("services:read");

    const useRoleFormAfterToggle = await loadHook();
    const next = useRoleFormAfterToggle(args);
    await next.handleSubmit({ preventDefault: () => {} });

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("/api/roles/99");
    expect(init.method).toBe("PATCH");
    const payload = JSON.parse(init.body) as { permissions: string[] };
    expect(payload.permissions.sort()).toEqual(
      ["nodes:read", "services:write"].sort(),
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("handleSubmit surfaces the server error message and leaves the dialog open", async () => {
    const { fetchMock } = setup();
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "permission denied" }),
    } as Response);

    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    const args = {
      open: true,
      onOpenChange,
      onSuccess,
      errorFallback: "fallback message",
    };
    const useRoleForm = await loadHook();
    const result = useRoleForm(args);
    result.setName("Custom");
    result.togglePermission("nodes:read");

    const useRoleFormAfterToggle = await loadHook();
    const next = useRoleFormAfterToggle(args);
    await next.handleSubmit({ preventDefault: () => {} });

    // Layout: 0=name, 1=description, 2=selectedPermissions, 3=submitting, 4=error
    expect(stateEntries[4].value).toBe("permission denied");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    // Selection is preserved so the operator can retry.
    expect(selectedPermissionsValue().has("nodes:read")).toBe(true);
    expect(nameValue()).toBe("Custom");
  });
});
