/**
 * Node create / edit dialog flow.
 *
 * Discharges the Phase Node-4 acceptance: "Add an e2e test that creates
 * a node with Sensor + Data Store enabled and asserts the resulting
 * draft shape is what the server action received." We intercept the
 * dialog's `POST /api/nodes` directly via `page.route` instead of
 * stubbing the upstream `insertNode` GraphQL operation, because the
 * acceptance criterion is about *what the dialog dispatched*, not about
 * how the BFF reshapes the request before forwarding it. The route
 * stub captures the JSON body, returns the success shape the dialog
 * expects, and the test asserts on the captured payload.
 */
import type { Page, Request } from "@playwright/test";

import { expect, test } from "../fixtures";
import { resetRateLimits, signInAndWait } from "../helpers/auth";
import {
  assignCustomerToAccount,
  deleteCustomersByPrefix,
  ensureCustomerExists,
  getAccountId,
} from "../helpers/setup-db";
import { closeAdminAgent, mockServerSession } from "../mock-server-admin";

const BASE_DATA_STORE_TOML = [
  'ingest_srv_addr = "10.0.0.1:38370"',
  'publish_srv_addr = "10.0.0.1:38371"',
  'graphql_srv_addr = "10.0.0.1:8443"',
  'retention = "100d"',
  'data_dir = "/opt/clumit/var/data_store"',
  'export_dir = "/opt/clumit/var/data_store/export"',
  "max_open_files = 8000",
  "max_mb_of_level_base = 512",
  "num_of_thread = 8",
  "max_subcompactions = 2",
  "ack_transmission = 1024",
].join("\n");

function alphaDataStoreExternal() {
  return {
    node: 11,
    key: "alpha-data-store",
    kind: "DATA_STORE",
    status: "ENABLED",
    draft: null,
  };
}

async function navigateToList(page: Page): Promise<void> {
  await page.goto("/nodes/settings");
  await page.waitForFunction(() => !document.getElementById("S:0"));
}

test.describe("Node create/edit dialog", () => {
  const stubSession = mockServerSession("review");
  const gigantoSession = mockServerSession("giganto");
  const tivanSession = mockServerSession("tivan");
  let primaryCustomerId: number;
  let secondaryCustomerId: number;

  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await deleteCustomersByPrefix("e2e-create-edit-customer");
    const customerId = await ensureCustomerExists("e2e-create-edit-customer");
    primaryCustomerId = customerId;
    // Round 13 #1 needs a *second* customer in scope so the user can
    // change Customer to a different value than the seed and trip the
    // dirty marker the Keep-editing rebase reads. Without two
    // distinct DB customers, picking the same one is a no-op and the
    // dirty assertion can't be made.
    const customerId2 = await ensureCustomerExists(
      "e2e-create-edit-customer-2",
    );
    secondaryCustomerId = customerId2;
    try {
      const accountId = await getAccountId(workerUsername);
      await assignCustomerToAccount(accountId, customerId);
      try {
        await assignCustomerToAccount(accountId, customerId2);
      } catch {
        // Already linked — fine.
      }
    } catch {
      // Already linked — fine.
    }
  });

  test.afterAll(async () => {
    await stubSession.clear();
    await gigantoSession.clear();
    await tivanSession.clear();
    await closeAdminAgent();
    await deleteCustomersByPrefix("e2e-create-edit-customer");
  });

  test.beforeEach(async () => {
    await resetRateLimits();
    // The settings page reads the canonical `nodeList` and
    // `nodeStatusList` for SSR even when the test only exercises the
    // create flow. Use the empty-list fixtures so the create path is the
    // only thing the user can do.
    await stubSession.registerStub({
      operation: "nodeList",
      response: { kind: "fixture", fixture: "node/nodeList.empty.json" },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.empty.json",
      },
    });
    // The edit dialog's initial GET and stale-conflict refresh path now
    // hydrate applied external baselines from the per-service endpoints
    // when a node hosts DATA_STORE / TI_CONTAINER with `draft: null`.
    // Keep those reads deterministic so edit-mode tests continue to hit
    // their intended branch instead of failing form validation on blank
    // external defaults.
    await gigantoSession.registerStub({
      operation: "config",
      response: {
        kind: "fixture",
        fixture: "external/giganto/config.base.json",
      },
    });
    await tivanSession.registerStub({
      operation: "config",
      response: {
        kind: "fixture",
        fixture: "external/tivan/config.base.json",
      },
    });
  });

  test("create with Sensor + Data Store dispatches the documented draft shape", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    let capturedBody: unknown = null;
    let capturedRequest: Request | null = null;
    await page.route("**/api/nodes", async (route, request) => {
      if (request.method() !== "POST") return route.continue();
      capturedRequest = request;
      const raw = request.postData();
      capturedBody = raw ? JSON.parse(raw) : null;
      // Match the BFF success shape so the dialog's onSuccess fires and
      // the dialog closes (no follow-up assertion depends on the close,
      // but it keeps the test interaction realistic).
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "e2e-mock-node-id" }),
      });
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await navigateToList(page);

    await page.getByTestId("nodes-add-button").click();
    const dialog = page.getByTestId("node-edit-dialog");
    await expect(dialog).toBeVisible();

    // Fill metadata. The schema requires a customer; the worker account
    // has exactly one assigned, so the Select shows that single option.
    // Scope label lookups to the dialog because the list page also
    // exposes a "Customer" filter Select in `main`.
    await dialog.getByLabel("Name", { exact: true }).fill("e2e-mix-node");
    await dialog.getByLabel("Customer", { exact: true }).click();
    await page.getByRole("option").first().click();
    await dialog.getByLabel("Hostname", { exact: true }).fill("e2e-mix.local");

    // Enable Sensor + Data Store. The accordion auto-expands when the
    // checkbox is ticked, mounting the per-service form. The dialog's
    // `superRefine` validates every Configure-Here service before save
    // dispatches, so we have to populate each service's required fields
    // (defaults are intentionally empty for the IPs and PCI list — see
    // the Phase Node-4 Round 1 review which dropped the silent-empty
    // fallback). Only the bare-minimum required fields are filled here;
    // the per-form unit tests own exhaustive field coverage.
    await page.getByTestId("node-dialog-sensor-enable").click();
    await page.locator("#sensor-data-store-ip").fill("10.0.0.1");
    await page.locator("#sensor-hostname").fill("data-store.local");
    await page.locator("#sensor-pci").fill("0000:00:1f.6");

    await page.getByTestId("node-dialog-data-store-enable").click();
    await page.locator("#dataStore-receive-ip").fill("10.0.0.2");
    await page.locator("#dataStore-send-ip").fill("10.0.0.3");
    await page.locator("#dataStore-web-ip").fill("10.0.0.4");

    await page.getByTestId("node-dialog-save").click();

    // Wait until the dialog has dispatched the POST. The route handler
    // populates `capturedBody` synchronously, but the click → submit →
    // fetch path has its own microtask queue.
    await expect.poll(() => capturedBody, { timeout: 5_000 }).not.toBeNull();

    type CapturedAgent = {
      kind: string;
      key: string;
      status: string;
      draft: string;
    };
    type CapturedExternal = CapturedAgent;
    type CapturedBody = {
      name: string;
      customerId: string;
      description: string;
      hostname: string;
      agents: CapturedAgent[];
      externalServices: CapturedExternal[];
      modeChanges?: unknown[];
    };
    const body = capturedBody as CapturedBody;

    expect(body.name).toBe("e2e-mix-node");
    expect(body.hostname).toBe("e2e-mix.local");
    expect(body.customerId).toMatch(/^\d+$/);

    // Sensor agent and Data Store external service must each appear
    // exactly once with the canonical kind discriminators. The draft
    // strings are produced by the per-service form modules' `serialise`;
    // we only assert their structural shape here (non-empty TOML), since
    // the per-form unit tests already pin the exact byte-level output.
    const sensorAgents = body.agents.filter((a) => a.kind === "SENSOR");
    expect(sensorAgents).toHaveLength(1);
    expect(sensorAgents[0]?.status).toBe("UNKNOWN");
    expect(typeof sensorAgents[0]?.draft).toBe("string");

    const dataStoreSvcs = body.externalServices.filter(
      (s) => s.kind === "DATA_STORE",
    );
    expect(dataStoreSvcs).toHaveLength(1);
    expect(dataStoreSvcs[0]?.status).toBe("UNKNOWN");
    expect(typeof dataStoreSvcs[0]?.draft).toBe("string");

    // No services other than the two enabled ones should be in the
    // draft. The membership checkbox owns this — disabled services do
    // not contribute agents/externals to the dispatched body.
    expect(body.agents.map((a) => a.kind).sort()).toEqual(["SENSOR"]);
    expect(body.externalServices.map((s) => s.kind).sort()).toEqual([
      "DATA_STORE",
    ]);

    // CSRF header was attached (defensive — the BFF route requires it).
    const headers = capturedRequest
      ? (capturedRequest as Request).headers()
      : {};
    expect(headers["x-csrf-token"] ?? headers["X-CSRF-Token"]).toBeTruthy();
  });

  // Reviewer Round 8 #2: the stale-conflict reconciliation prompt
  // must actually do what its labels say. "Keep editing" needs to
  // refresh the canonical baseline so the next PATCH stops re-tripping
  // the same CAS check; "Discard my edits and reload" needs to
  // rehydrate the form against fresh server state instead of closing
  // the dialog. Both actions hit the new GET /api/nodes/[id] endpoint;
  // this spec asserts both call it and that the prompt clears once
  // the refresh completes.
  test("stale-conflict prompt refetches canonical node before continuing", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    // Override the per-test default with a populated list so the edit
    // dialog has a real node to seed against.
    await stubSession.registerStub({
      operation: "nodeList",
      response: { kind: "fixture", fixture: "node/nodeList.populated.json" },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "node",
      response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
    });

    let getCount = 0;
    let patchCount = 0;
    await page.route("**/api/nodes/*", async (route, request) => {
      const method = request.method();
      if (method === "GET") {
        getCount += 1;
        // Return a freshly-edited canonical node. Hostname differs
        // from the seed so the Discard branch has a visible diff to
        // assert on after the form resets.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            node: {
              id: "11",
              name: "alpha-node",
              nameDraft: null,
              profile: {
                customerId: "1",
                description: "Primary sensor cluster",
                hostname: "alpha-refreshed.lan",
              },
              profileDraft: null,
              agents: [],
              externalServices: [alphaDataStoreExternal()],
            },
            appliedExternalDrafts: {
              "data-store": BASE_DATA_STORE_TOML,
            },
          }),
        });
        return;
      }
      if (method === "PATCH") {
        patchCount += 1;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "stale conflict on retry",
            field: null,
          }),
        });
        return;
      }
      await route.continue();
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/nodes/settings?dialog=edit&id=11");
    await page.waitForFunction(() => !document.getElementById("S:0"));
    const dialog = page.getByTestId("node-edit-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Trigger the stale-conflict path with a metadata edit + Save.
    await dialog
      .getByLabel("Description", { exact: true })
      .fill("Touched description");
    await page.getByTestId("node-dialog-save").click();
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeVisible();
    expect(patchCount).toBe(1);

    // "Keep editing" must hit the GET endpoint, refresh the baseline,
    // and dismiss the prompt — keeping the user's edit intact while
    // rebasing untouched metadata fields onto the refreshed baseline.
    // The user only edited Description; Hostname is untouched, so it
    // should flip to the refreshed canonical value rather than
    // retain the pre-refresh seed (which would silently rewrite the
    // server's hostname back on the next PATCH).
    await page.getByTestId("node-dialog-stale-keep").click();
    await expect.poll(() => getCount, { timeout: 5_000 }).toBe(1);
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeHidden();
    await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
      "Touched description",
    );
    await expect(dialog.getByLabel("Hostname", { exact: true })).toHaveValue(
      "alpha-refreshed.lan",
    );

    // Re-trigger the conflict so we can drive the Discard branch.
    await page.getByTestId("node-dialog-save").click();
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeVisible();
    expect(patchCount).toBe(2);

    // "Discard my edits and reload" must rehydrate the form from the
    // refetched canonical node. The hostname in the GET response is
    // `alpha-refreshed.lan`, so the field flips to that value once
    // the form resets — proving the dialog actually reloaded rather
    // than just closing the prompt.
    await page.getByTestId("node-dialog-stale-discard").click();
    await expect.poll(() => getCount, { timeout: 5_000 }).toBe(2);
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeHidden();
    await expect(dialog.getByLabel("Hostname", { exact: true })).toHaveValue(
      "alpha-refreshed.lan",
    );
    // The user's local description edit is gone after Discard.
    await expect(dialog.getByLabel("Description", { exact: true })).toHaveValue(
      "Primary sensor cluster",
    );
  });

  // Reviewer Round 11: the membership rebase under Keep editing must
  // also refresh RHF's default baseline, not just the current value.
  // Otherwise a subsequent toggle that lands back on the *pre-refresh*
  // default (e.g. user flips Sensor mode Manually → Configure Here
  // after a concurrent flip rebased it to Manually) clears
  // `dirtyFields.membership.<kind>.configMode`,
  // `serviceTouchedByUser` returns false, and
  // `buildDraftSubmission` preserves the refreshed canonical draft
  // instead of serialising the user's new state — silently dropping
  // the user's mode change. This spec drives that exact path and
  // asserts the next Save dispatches the user-authored Sensor draft.
  test("membership change after Keep editing dispatches the user's choice, not the refreshed canonical", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await stubSession.registerStub({
      operation: "nodeList",
      response: { kind: "fixture", fixture: "node/nodeList.populated.json" },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "node",
      response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
    });

    let getCount = 0;
    let patchCount = 0;
    let capturedPatchBody: unknown = null;
    await page.route("**/api/nodes/*", async (route, request) => {
      const method = request.method();
      if (method === "GET") {
        getCount += 1;
        // Concurrent writer flipped Sensor to Manually mode
        // (`config: ""`, `draft: null`). The Keep-editing rebase must
        // surface this in the dialog: Sensor's accordion re-renders
        // into the manual-mode card, and RHF's default baseline for
        // `membership.sensor.configMode` flips to "configure-manually".
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            node: {
              id: "11",
              name: "alpha-node",
              nameDraft: null,
              profile: {
                customerId: "1",
                description: "Primary sensor cluster",
                hostname: "alpha.lan",
              },
              profileDraft: null,
              agents: [
                {
                  node: 11,
                  key: "alpha-sensor",
                  kind: "SENSOR",
                  status: "ENABLED",
                  config: "",
                  draft: null,
                },
              ],
              externalServices: [alphaDataStoreExternal()],
            },
            appliedExternalDrafts: {
              "data-store": BASE_DATA_STORE_TOML,
            },
          }),
        });
        return;
      }
      if (method === "PATCH") {
        patchCount += 1;
        if (patchCount === 1) {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ error: "stale", field: null }),
          });
          return;
        }
        const raw = request.postData();
        capturedPatchBody = raw ? JSON.parse(raw) : null;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: "11" }),
        });
        return;
      }
      await route.continue();
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/nodes/settings?dialog=edit&id=11");
    await page.waitForFunction(() => !document.getElementById("S:0"));
    const dialog = page.getByTestId("node-edit-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Pre-refresh state: Sensor opens in Configure Here mode populated
    // with the applied config (the seed fixture has `draft: null,
    // config: "<toml>"`). The mode switch reflects "Configure Here".
    await expect(page.getByTestId("node-dialog-sensor-mode")).toHaveAttribute(
      "data-state",
      "unchecked",
    );

    // Trigger the stale-conflict prompt with a metadata edit. The
    // user has *not* touched the Sensor section yet, so its membership
    // tree is fully clean and eligible for rebase.
    await dialog
      .getByLabel("Description", { exact: true })
      .fill("Keep editing test");
    await page.getByTestId("node-dialog-save").click();
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeVisible();
    expect(patchCount).toBe(1);

    // Keep editing: rebase membership and form-bag onto the refreshed
    // canonical (Sensor flipped to Manually). RHF's default baseline
    // for `membership.sensor.configMode` must now be
    // "configure-manually" — proven below by the Save reflecting the
    // user's subsequent flip back to Configure Here.
    await page.getByTestId("node-dialog-stale-keep").click();
    await expect.poll(() => getCount, { timeout: 5_000 }).toBe(1);
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeHidden();
    await expect(page.getByTestId("node-dialog-sensor-mode")).toHaveAttribute(
      "data-state",
      "checked",
    );

    // Flip Sensor mode back to Configure Here — i.e. back to the
    // *pre-refresh* default. With the buggy baseline this clears the
    // membership-dirty marker and the Save would preserve the
    // canonical empty draft. Fill the required Sensor fields so the
    // schema gate doesn't preempt the contract under test.
    await page.getByTestId("node-dialog-sensor-mode").click();
    await page.locator("#sensor-data-store-ip").fill("10.0.0.1");
    await page.locator("#sensor-hostname").fill("data-store.local");
    await page.locator("#sensor-pci").fill("0000:00:1f.6");

    await page.getByTestId("node-dialog-save").click();
    await expect
      .poll(() => capturedPatchBody, { timeout: 5_000 })
      .not.toBeNull();

    type CapturedAgent = {
      kind: string;
      status: string;
      draft: string | null;
    };
    type CapturedBody = { new: { agents: CapturedAgent[] } };
    const body = capturedPatchBody as CapturedBody;
    const sensor = body.new.agents.find((a) => a.kind === "SENSOR");
    expect(sensor).toBeDefined();
    // The user's flip back to Configure Here must take effect. With
    // the regression in place the dialog would treat Sensor as
    // untouched and forward `original.draft` from the refreshed
    // canonical (`null`); the user-authored serialised TOML proves
    // RHF's default baseline tracks the rebased state.
    expect(sensor?.draft).toEqual(expect.any(String));
    expect((sensor?.draft as string).length).toBeGreaterThan(0);
  });

  // Reviewer Round 12: external sections (Data Store / TI Container)
  // carry only `draft` on the node payload, so their applied baseline
  // lives on Giganto / Tivan and is fetched separately. The
  // stale-conflict refresh must re-project that baseline; otherwise
  // after Keep editing, a touched external section serialises the
  // whole form bag — including untouched subfields — from the
  // pre-conflict snapshot and silently overwrites the concurrent
  // writer's changes. This spec drives that path: the BFF GET
  // returns a refreshed `appliedExternalDrafts` map for `data-store`,
  // the dialog rebases the data-store form bag, the user edits only
  // `receiveIp`, and the saved draft must carry the *refreshed*
  // `graphql_srv_addr` (web IP/port) rather than the pre-conflict
  // value the SSR seed projected.
  test("Keep editing rebases external section onto refreshed applied baseline", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await stubSession.registerStub({
      operation: "nodeList",
      response: { kind: "fixture", fixture: "node/nodeList.populated.json" },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "node",
      response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
    });

    let getCount = 0;
    let patchCount = 0;
    let capturedPatchBody: unknown = null;
    // Refreshed applied baseline returned by the BFF GET on the
    // stale-conflict refresh path. The webIp here is the diagnostic
    // marker: the dispatched data-store draft after Keep editing +
    // receiveIp edit must encode this address as `graphql_srv_addr`.
    const refreshedDataStoreToml = [
      'ingest_srv_addr = "10.0.0.50:38370"',
      'publish_srv_addr = "10.0.0.50:38371"',
      'graphql_srv_addr = "10.0.0.99:8443"',
      'retention = "30d"',
      'data_dir = "/opt/clumit/var/data_store"',
      'export_dir = "/opt/clumit/var/data_store/export"',
      "max_open_files = 65535",
      "max_mb_of_level_base = 512",
      "num_of_thread = 8",
      "max_subcompactions = 2",
      "ack_transmission = 1024",
    ].join("\n");

    await page.route("**/api/nodes/*", async (route, request) => {
      const method = request.method();
      if (method === "GET") {
        getCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            node: {
              id: "11",
              name: "alpha-node",
              nameDraft: null,
              profile: {
                customerId: "1",
                description: "Primary sensor cluster",
                hostname: "alpha.lan",
              },
              profileDraft: null,
              agents: [],
              externalServices: [
                {
                  node: 11,
                  key: "alpha-data-store",
                  kind: "DATA_STORE",
                  status: "ENABLED",
                  config: null,
                  draft: null,
                },
              ],
            },
            appliedExternalDrafts: {
              "data-store": refreshedDataStoreToml,
            },
          }),
        });
        return;
      }
      if (method === "PATCH") {
        patchCount += 1;
        if (patchCount === 1) {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ error: "stale", field: null }),
          });
          return;
        }
        const raw = request.postData();
        capturedPatchBody = raw ? JSON.parse(raw) : null;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: "11" }),
        });
        return;
      }
      await route.continue();
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/nodes/settings?dialog=edit&id=11");
    await page.waitForFunction(() => !document.getElementById("S:0"));
    const dialog = page.getByTestId("node-edit-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Trigger the stale-conflict prompt with a metadata-only edit.
    // Data Store has not been touched yet, so its accordion bag is
    // eligible for full rebase under Keep editing.
    await dialog
      .getByLabel("Description", { exact: true })
      .fill("Round 12 stale-conflict test");
    await page.getByTestId("node-dialog-save").click();
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeVisible();
    expect(patchCount).toBe(1);

    // Keep editing must rebase data-store onto the refreshed applied
    // baseline. The form's web IP field flips to the refreshed value.
    await page.getByTestId("node-dialog-stale-keep").click();
    await expect.poll(() => getCount, { timeout: 5_000 }).toBe(1);
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeHidden();
    await expect(page.locator("#dataStore-web-ip")).toHaveValue("10.0.0.99");

    // Touch the data-store section by editing only `receiveIp`.
    // The whole section now serialises from the form bag — every
    // untouched subfield must therefore be the refreshed default,
    // not the pre-refresh seed (which would have been blank IPs since
    // the SSR seed sees no Giganto stub in e2e).
    await page.locator("#dataStore-receive-ip").fill("10.0.0.7");

    await page.getByTestId("node-dialog-save").click();
    await expect
      .poll(() => capturedPatchBody, { timeout: 5_000 })
      .not.toBeNull();

    type CapturedExternal = {
      kind: string;
      status: string;
      draft: string;
    };
    type CapturedBody = { new: { externalServices: CapturedExternal[] } };
    const body = capturedPatchBody as CapturedBody;
    const dataStore = body.new.externalServices.find(
      (e) => e.kind === "DATA_STORE",
    );
    expect(dataStore).toBeDefined();
    expect(typeof dataStore?.draft).toBe("string");
    const draft = dataStore?.draft ?? "";
    // The refreshed web IP marker must round-trip: the dialog rebased
    // data-store onto the refreshed defaults, the user only retouched
    // receiveIp, and serialise pulled webIp/webPort from the rebased
    // baseline. A regression on this path would surface the SSR seed
    // (blank IPs in this e2e environment, since Giganto isn't stubbed
    // at SSR), failing the assertion below.
    expect(draft).toContain('graphql_srv_addr = "10.0.0.99:8443"');
    // The retouched field also round-trips, proving the rebase
    // preserved the user's retouch rather than overwriting it.
    expect(draft).toContain('ingest_srv_addr = "10.0.0.7:38370"');
  });

  // Reviewer Round 13 #1: the Customer Select is a custom Radix Select
  // wired through `setValue`, not RHF's `register`, so it has to mark
  // the metadata.customerId path dirty explicitly. Without that,
  // `form.reset(freshDefaults, { keepDirtyValues: true })` on the
  // stale-conflict Keep-editing rebase treats a user-changed customer
  // as untouched and overwrites it with the refreshed canonical
  // baseline — silently dropping the user's selection even though the
  // prompt copy says Keep editing preserves user edits. This spec
  // changes Customer, trips a 409, picks Keep editing, and asserts
  // the next PATCH carries the user's chosen customer rather than the
  // canonical value the GET response re-projected.
  test("Customer change after Keep editing dispatches the user's selection, not the refreshed canonical", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await stubSession.registerStub({
      operation: "nodeList",
      response: { kind: "fixture", fixture: "node/nodeList.populated.json" },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "node",
      response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
    });

    let getCount = 0;
    let patchCount = 0;
    let capturedPatchBody: unknown = null;
    await page.route("**/api/nodes/*", async (route, request) => {
      const method = request.method();
      if (method === "GET") {
        getCount += 1;
        // Refreshed canonical re-asserts the seed customerId ("1").
        // With the regression in place, this value re-overrides the
        // user's selection on Keep editing because RHF's dirty
        // tracker never saw the change.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            node: {
              id: "11",
              name: "alpha-node",
              nameDraft: null,
              profile: {
                customerId: "1",
                description: "Primary sensor cluster",
                hostname: "alpha.lan",
              },
              profileDraft: null,
              agents: [],
              externalServices: [alphaDataStoreExternal()],
            },
            appliedExternalDrafts: {
              "data-store": BASE_DATA_STORE_TOML,
            },
          }),
        });
        return;
      }
      if (method === "PATCH") {
        patchCount += 1;
        if (patchCount === 1) {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ error: "stale", field: null }),
          });
          return;
        }
        const raw = request.postData();
        capturedPatchBody = raw ? JSON.parse(raw) : null;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: "11" }),
        });
        return;
      }
      await route.continue();
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/nodes/settings?dialog=edit&id=11");
    await page.waitForFunction(() => !document.getElementById("S:0"));
    const dialog = page.getByTestId("node-edit-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Pick a Customer different from the seed. The dialog enumerates
    // every customer assigned to the worker (two are seeded in
    // `beforeAll`), and the seed node's customerId ("1") almost
    // certainly does not match either DB-assigned id, so any pick
    // here changes the value. We pick the *second* listed option
    // both to make the dirty diff unambiguous and to avoid relying
    // on alphabetic ordering of the seeded customer names.
    await dialog.getByLabel("Customer", { exact: true }).click();
    const optionTexts = (await page.getByRole("option").allTextContents()).map(
      (text) => text.trim(),
    );
    expect(optionTexts).toEqual(
      expect.arrayContaining([
        "e2e-create-edit-customer",
        "e2e-create-edit-customer-2",
      ]),
    );
    const userCustomerLabel =
      optionTexts.find((text) => text === "e2e-create-edit-customer-2") ??
      optionTexts.find((text) => text === "e2e-create-edit-customer") ??
      "";
    expect(userCustomerLabel).toBeTruthy();
    await page.getByRole("option", { name: userCustomerLabel }).click();

    // Trigger the stale-conflict path.
    await page.getByTestId("node-dialog-save").click();
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeVisible();
    expect(patchCount).toBe(1);

    // Keep editing rebases via `form.reset(fresh, { keepDirtyValues:
    // true })`. With `shouldDirty: true` on the Customer Select, the
    // user's pick is marked dirty and survives the rebase.
    await page.getByTestId("node-dialog-stale-keep").click();
    await expect.poll(() => getCount, { timeout: 5_000 }).toBe(1);
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeHidden();

    // The Customer trigger still shows the user's pick after Keep
    // editing — proves the dirty marker survived the rebase, not just
    // the value at the leaf. Without the fix the trigger flips back
    // to the canonical seed (whose id "1" likely matches no option,
    // so the trigger renders empty/placeholder text).
    await expect(dialog.getByLabel("Customer", { exact: true })).toHaveText(
      userCustomerLabel,
    );

    await page.getByTestId("node-dialog-save").click();
    await expect
      .poll(() => capturedPatchBody, { timeout: 5_000 })
      .not.toBeNull();
    type CapturedProfileDraft = { customerId?: string };
    type CapturedBody = { new: { profileDraft?: CapturedProfileDraft } };
    const body = capturedPatchBody as CapturedBody;
    const submittedCustomerId = body.new?.profileDraft?.customerId;
    // The dispatched customerId must NOT be the canonical seed value
    // ("1"); it must be one of the two DB-assigned ids the user could
    // have picked. We don't pin a specific id (PostgreSQL auto-assigns
    // them), but anything other than "1" proves the user's selection
    // round-tripped instead of being silently overwritten by the
    // refreshed baseline.
    const expectedCustomerId =
      userCustomerLabel === "e2e-create-edit-customer-2"
        ? secondaryCustomerId
        : primaryCustomerId;
    expect(submittedCustomerId).toBe(String(expectedCustomerId));
  });

  // Reviewer Round 13 #2: `GET /api/nodes/[id]` fetches Giganto and
  // Tivan independently and swallows `ExternalServiceUnavailableError`
  // per service. On a node hosting both externals, a transient Tivan
  // outage produces a partial response: `{ "data-store": "..." }`
  // with `ti-container` omitted. The pre-Round-13 dialog replaced
  // `liveAppliedExternalDrafts` wholesale with that partial map, so
  // ti-container regressed to blank defaults — and a touched
  // ti-container section would re-serialise the whole form bag from
  // those blanks, silently overwriting the concurrent writer's
  // changes (the same overwrite class Round 12 closed for the both-
  // succeed path). The fix merges per kind: the response value wins
  // when present, the prior seed survives when the response omits a
  // kind hosted on the refreshed node. This spec drives the partial
  // refresh end-to-end via two conflict cycles — the first establishes
  // the per-kind seed, the second exercises the partial-response path
  // — and asserts ti-container's form fields keep their previously
  // refreshed values rather than blanking.
  test("Keep editing preserves omitted external when refresh returns a partial applied-drafts map", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await stubSession.registerStub({
      operation: "nodeList",
      response: { kind: "fixture", fixture: "node/nodeList.populated.json" },
    });
    await stubSession.registerStub({
      operation: "nodeStatusList",
      response: {
        kind: "fixture",
        fixture: "node/nodeStatusList.populated.json",
      },
    });
    await stubSession.registerStub({
      operation: "node",
      response: { kind: "fixture", fixture: "node/nodeDetail.alpha.json" },
    });

    // The first refresh seeds both kinds; the second only refreshes
    // data-store. ti-container's seed must survive cycle 2 verbatim.
    const dataStoreTomlCycle1 = [
      'ingest_srv_addr = "10.0.0.50:38370"',
      'publish_srv_addr = "10.0.0.50:38371"',
      'graphql_srv_addr = "10.0.0.99:8443"',
      'retention = "30d"',
      'data_dir = "/opt/clumit/var/data_store"',
      'export_dir = "/opt/clumit/var/data_store/export"',
      "max_open_files = 65535",
      "max_mb_of_level_base = 512",
      "num_of_thread = 8",
      "max_subcompactions = 2",
      "ack_transmission = 1024",
    ].join("\n");
    // Tivan's projected TOML only contains `graphql_srv_addr` — the
    // TI Container form's deserialise reads only that key (the rest
    // are hard-coded by the emitter). Don't invent extra keys here:
    // the form would ignore them and the assertion below relies on
    // the webIp/webPort decomposition of `graphql_srv_addr`.
    const tiContainerTomlCycle1 = 'graphql_srv_addr = "10.0.0.55:8444"\n';
    const dataStoreTomlCycle2 = [
      'ingest_srv_addr = "10.0.0.50:38370"',
      'publish_srv_addr = "10.0.0.50:38371"',
      'graphql_srv_addr = "10.0.0.111:8443"',
      'retention = "30d"',
      'data_dir = "/opt/clumit/var/data_store"',
      'export_dir = "/opt/clumit/var/data_store/export"',
      "max_open_files = 65535",
      "max_mb_of_level_base = 512",
      "num_of_thread = 8",
      "max_subcompactions = 2",
      "ack_transmission = 1024",
    ].join("\n");

    let getCount = 0;
    let patchCount = 0;
    const refreshedNode = {
      id: "11",
      name: "alpha-node",
      nameDraft: null,
      profile: {
        customerId: "1",
        description: "Primary sensor cluster",
        hostname: "alpha.lan",
      },
      profileDraft: null,
      agents: [],
      externalServices: [
        {
          node: 11,
          key: "alpha-data-store",
          kind: "DATA_STORE",
          status: "ENABLED",
          config: null,
          draft: null,
        },
        {
          node: 11,
          key: "alpha-ti-container",
          kind: "TI_CONTAINER",
          status: "ENABLED",
          config: null,
          draft: null,
        },
      ],
    };

    await page.route("**/api/nodes/*", async (route, request) => {
      const method = request.method();
      if (method === "GET") {
        getCount += 1;
        // Cycle 1: full applied baseline for both kinds, so the seed
        // covers ti-container before cycle 2's partial response.
        // Cycle 2: data-store only — ti-container omitted (Tivan
        // unavailable). The refreshed node still hosts both, so the
        // dialog must fall back to cycle 1's seed for ti-container.
        const partial = getCount >= 2;
        const appliedExternalDrafts = partial
          ? { "data-store": dataStoreTomlCycle2 }
          : {
              "data-store": dataStoreTomlCycle1,
              "ti-container": tiContainerTomlCycle1,
            };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            node: refreshedNode,
            appliedExternalDrafts,
          }),
        });
        return;
      }
      if (method === "PATCH") {
        patchCount += 1;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "stale", field: null }),
        });
        return;
      }
      await route.continue();
    });

    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/nodes/settings?dialog=edit&id=11");
    await page.waitForFunction(() => !document.getElementById("S:0"));
    const dialog = page.getByTestId("node-edit-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Cycle 1: trigger a stale conflict so the Keep-editing refresh
    // both extends the form with the ti-container section the seed
    // node lacks (alpha.json has only DATA_STORE) and seeds
    // `liveAppliedExternalDrafts` for both kinds.
    await dialog
      .getByLabel("Description", { exact: true })
      .fill("Cycle 1 edit");
    await page.getByTestId("node-dialog-save").click();
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeVisible();
    expect(patchCount).toBe(1);
    await page.getByTestId("node-dialog-stale-keep").click();
    await expect.poll(() => getCount, { timeout: 5_000 }).toBe(1);
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeHidden();
    // Both external sections now have populated IPs from the cycle 1
    // applied drafts. webIp is the diagnostic marker.
    await expect(page.locator("#dataStore-web-ip")).toHaveValue("10.0.0.99");
    await expect(page.locator("#tiContainer-web-ip")).toHaveValue("10.0.0.55");

    // Cycle 2: trigger another stale conflict and refresh with a
    // partial response. The omitted ti-container must fall back to
    // its cycle 1 seed instead of regressing to blank defaults.
    await dialog
      .getByLabel("Description", { exact: true })
      .fill("Cycle 2 edit");
    await page.getByTestId("node-dialog-save").click();
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeVisible();
    expect(patchCount).toBe(2);
    await page.getByTestId("node-dialog-stale-keep").click();
    await expect.poll(() => getCount, { timeout: 5_000 }).toBe(2);
    await expect(page.getByTestId("node-dialog-stale-conflict")).toBeHidden();

    // data-store flips to the cycle 2 webIp (response wins for the
    // present kind). ti-container retains the cycle 1 webIp because
    // the partial response omitted it and the dialog merged per kind.
    await expect(page.locator("#dataStore-web-ip")).toHaveValue("10.0.0.111");
    await expect(page.locator("#tiContainer-web-ip")).toHaveValue("10.0.0.55");
  });
});
