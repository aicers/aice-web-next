/**
 * Integration test for the external-service GraphQL dispatch path.
 *
 * Stands up a real HTTPS + mTLS server impersonating a Giganto / Tivan
 * GraphQL endpoint, points `GIGANTO_GRAPHQL_ENDPOINT` and
 * `TIVAN_GRAPHQL_ENDPOINT` at it, and drives `gigantoClient()` /
 * `tivanClient()` end-to-end. This is the integration-level half of
 * the acceptance criterion in #308 ("verified by … an integration test
 * that drives a mocked external endpoint"), complementing the static
 * `dispatch URL provenance` checks in `external-endpoints.test.ts`.
 *
 * The mock endpoint verifies the incoming JWT using the peer
 * certificate's public key — the same shape REview, Giganto, and Tivan
 * all implement — so a regression that broke the mTLS handshake or the
 * Context JWT signing would fail this test, not merely fall back to a
 * different transport.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";

import { importSPKI, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureTestCerts, type TestCerts } from "@/test-harness/test-certs";

interface RecordedRequest {
  authorization: string | undefined;
  operationName: string | undefined;
  variables: Record<string, unknown> | undefined;
  jwt:
    | { role: unknown; customer_ids: unknown; verified: true }
    | { error: string };
}

const GIGANTO_STATUS = {
  name: "giganto-1",
  cpuUsage: 0.1,
  totalMemory: 1024,
  usedMemory: 256,
  diskUsedBytes: 4096,
  diskAvailableBytes: 8192,
};

const TIVAN_STATUS = {
  name: "tivan-1",
  cpuUsage: 0.2,
  totalMemory: 2048,
  usedMemory: 512,
  diskUsedBytes: 8192,
  diskAvailableBytes: 16384,
};

const TIVAN_CONFIG = {
  graphqlSrvAddr: "127.0.0.1:38371",
  translateMitre: "/etc/tivan/translate.json",
  excelData: null,
  originMitre: null,
};

const TIVAN_UPDATE_RESULT = {
  ...TIVAN_CONFIG,
  graphqlSrvAddr: "127.0.0.1:38372",
};

interface OperationDef {
  name: string;
  data: unknown;
}

const OPERATIONS: ReadonlyMap<string, OperationDef> = new Map([
  [
    "GigantoStatus",
    { name: "GigantoStatus", data: { status: GIGANTO_STATUS } },
  ],
  ["TivanStatus", { name: "TivanStatus", data: { status: TIVAN_STATUS } }],
  [
    "FetchTivanConfig",
    { name: "FetchTivanConfig", data: { config: TIVAN_CONFIG } },
  ],
  [
    "UpdateTivanConfig",
    { name: "UpdateTivanConfig", data: { updateConfig: TIVAN_UPDATE_RESULT } },
  ],
]);

interface MockServer {
  url: string;
  port: number;
  recorded: RecordedRequest[];
  close: () => Promise<void>;
}

async function startMockExternalServer(certs: TestCerts): Promise<MockServer> {
  const recorded: RecordedRequest[] = [];

  const server: Server = createHttpsServer(
    {
      cert: certs.serverCert,
      key: certs.serverKey,
      ca: [certs.caCert],
      requestCert: true,
      rejectUnauthorized: true,
    },
    async (req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      await new Promise((resolve) => req.on("end", resolve));

      const auth = req.headers.authorization;
      let parsed: {
        operationName?: string;
        variables?: Record<string, unknown>;
        query?: string;
      };
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            errors: [{ message: `invalid JSON: ${(err as Error).message}` }],
          }),
        );
        return;
      }

      const operationName =
        parsed.operationName ??
        // graphql-request sends `operationName` only when set on the
        // outer request; pull it from the document otherwise so the
        // dispatch test does not depend on a particular client option.
        parsed.query?.match(/(?:query|mutation)\s+(\w+)/)?.[1];

      const socket = req.socket as TLSSocket;
      const peerCert = socket.getPeerX509Certificate();
      let jwtRecord: RecordedRequest["jwt"];
      try {
        if (!auth?.startsWith("Bearer ")) {
          throw new Error("missing Bearer token");
        }
        if (!peerCert) {
          throw new Error("missing peer certificate");
        }
        const pubKeyPem = peerCert.publicKey.export({
          type: "spki",
          format: "pem",
        }) as string;
        const pubKey = await importSPKI(pubKeyPem, "ES256");
        const { payload } = await jwtVerify(auth.slice(7), pubKey);
        jwtRecord = {
          role: payload.role,
          customer_ids: payload.customer_ids,
          verified: true,
        };
      } catch (err) {
        jwtRecord = { error: err instanceof Error ? err.message : "unknown" };
      }

      recorded.push({
        authorization: auth,
        operationName,
        variables: parsed.variables,
        jwt: jwtRecord,
      });

      if ("error" in jwtRecord) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: jwtRecord.error }] }));
        return;
      }

      const op = operationName ? OPERATIONS.get(operationName) : undefined;
      if (!op) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            errors: [
              {
                message: `unsupported operation: ${operationName ?? "<none>"}`,
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: op.data }));
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || addr === null) {
    throw new Error("failed to bind mock external server");
  }
  return {
    url: `https://localhost:${addr.port}/graphql`,
    port: addr.port,
    recorded,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("external GraphQL dispatch over mTLS", () => {
  let certs: TestCerts;
  let certDir: string;
  let mockServer: MockServer;

  const previousEnv = {
    GIGANTO: process.env.GIGANTO_GRAPHQL_ENDPOINT,
    TIVAN: process.env.TIVAN_GRAPHQL_ENDPOINT,
    REVIEW: process.env.REVIEW_GRAPHQL_ENDPOINT,
    MTLS_CERT: process.env.MTLS_CERT_PATH,
    MTLS_KEY: process.env.MTLS_KEY_PATH,
    MTLS_CA: process.env.MTLS_CA_PATH,
    BYPASS: process.env.TEST_ALLOW_PLAIN_GRAPHQL,
  };

  beforeAll(async () => {
    certDir = mkdtempSync(path.join(tmpdir(), "node-external-dispatch-"));
    certs = ensureTestCerts(certDir);
    mockServer = await startMockExternalServer(certs);

    // Both external endpoints share the mock — operation name routes to
    // the right canned payload. Pointing Tivan at the same listener also
    // proves the per-service callers do not hard-code Giganto's URL.
    process.env.GIGANTO_GRAPHQL_ENDPOINT = mockServer.url;
    process.env.TIVAN_GRAPHQL_ENDPOINT = mockServer.url;

    // Set REVIEW_GRAPHQL_ENDPOINT to a port nothing is listening on so
    // any accidental relay through the manager client would fail loudly
    // — supports the assertion that external calls never traverse
    // review-web. Localhost on a high random port is fine because
    // graphqlRequest is never reached in this test; we just want a
    // plausible-looking URL the env var.
    process.env.REVIEW_GRAPHQL_ENDPOINT = "https://127.0.0.1:1/graphql";

    process.env.MTLS_CERT_PATH = certs.paths.clientCertPath;
    process.env.MTLS_KEY_PATH = certs.paths.clientKeyPath;
    process.env.MTLS_CA_PATH = certs.paths.caPath;
    delete process.env.TEST_ALLOW_PLAIN_GRAPHQL;

    const { reload } = await import("@/lib/mtls");
    await reload();
    const { resetClient } = await import("@/lib/graphql/client");
    resetClient();
  });

  afterAll(async () => {
    await mockServer.close();
    rmSync(certDir, { recursive: true, force: true });

    // Mirror the cleanup pattern in `src/__tests__/lib/mtls-e2e.test.ts`:
    // restore env vars but do NOT call `reload()`. The cached mTLS state
    // from this suite is harmless to other suites because each one sets
    // its own MTLS_* env and reloads explicitly when it needs to.
    function restore(key: string, value: string | undefined): void {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restore("GIGANTO_GRAPHQL_ENDPOINT", previousEnv.GIGANTO);
    restore("TIVAN_GRAPHQL_ENDPOINT", previousEnv.TIVAN);
    restore("REVIEW_GRAPHQL_ENDPOINT", previousEnv.REVIEW);
    restore("MTLS_CERT_PATH", previousEnv.MTLS_CERT);
    restore("MTLS_KEY_PATH", previousEnv.MTLS_KEY);
    restore("MTLS_CA_PATH", previousEnv.MTLS_CA);
    restore("TEST_ALLOW_PLAIN_GRAPHQL", previousEnv.BYPASS);
  });

  it("gigantoClient dispatches GigantoStatus over mTLS to the configured Giganto endpoint", async () => {
    const beforeCount = mockServer.recorded.length;
    const { gigantoClient } = await import("@/lib/graphql/external-client");
    const { GIGANTO_STATUS_QUERY } = await import("@/lib/node/queries");

    const data = await gigantoClient<{ status: typeof GIGANTO_STATUS }>(
      GIGANTO_STATUS_QUERY,
      undefined,
      { role: "Tenant Administrator", customerIds: [5] },
    );

    expect(data.status).toEqual(GIGANTO_STATUS);
    const recorded = mockServer.recorded.slice(beforeCount);
    expect(recorded).toHaveLength(1);
    const [call] = recorded;
    expect(call.operationName).toBe("GigantoStatus");
    expect(call.authorization?.startsWith("Bearer ")).toBe(true);
    expect("error" in call.jwt).toBe(false);
    if (!("error" in call.jwt)) {
      expect(call.jwt.role).toBe("Tenant Administrator");
      expect(call.jwt.customer_ids).toEqual([5]);
    }
  });

  it("tivanClient dispatches a mutation with variables to the configured Tivan endpoint", async () => {
    const beforeCount = mockServer.recorded.length;
    const { tivanClient } = await import("@/lib/graphql/external-client");
    const { TIVAN_UPDATE_CONFIG_MUTATION } = await import("@/lib/node/queries");

    const data = await tivanClient<
      { updateConfig: typeof TIVAN_UPDATE_RESULT },
      { old: string; new: string }
    >(
      TIVAN_UPDATE_CONFIG_MUTATION,
      { old: "old-toml", new: "new-toml" },
      { role: "System Administrator", customerIds: [] },
    );

    expect(data.updateConfig).toEqual(TIVAN_UPDATE_RESULT);
    const recorded = mockServer.recorded.slice(beforeCount);
    expect(recorded).toHaveLength(1);
    const [call] = recorded;
    expect(call.operationName).toBe("UpdateTivanConfig");
    expect(call.variables).toEqual({ old: "old-toml", new: "new-toml" });
    expect("error" in call.jwt).toBe(false);
    if (!("error" in call.jwt)) {
      expect(call.jwt.role).toBe("System Administrator");
      expect(call.jwt.customer_ids).toEqual([]);
    }
  });

  it("graphqlRequest (manager client) is not in the dispatch path for external calls", async () => {
    // Build a fresh recorder of manager-client invocations by spying on
    // the graphql-request client cache. The simpler invariant: with
    // REVIEW_GRAPHQL_ENDPOINT pointed at a closed port, any accidental
    // relay through `graphqlRequest` would surface as a connection
    // failure, not a successful response. The two passing dispatches
    // above are the proof; this test makes the contract explicit by
    // calling `graphqlRequest` directly and asserting it fails fast,
    // so a future regression that wired `gigantoClient` through it
    // would inherit the failure mode.
    const { graphqlRequest } = await import("@/lib/graphql/client");
    const { GIGANTO_STATUS_QUERY } = await import("@/lib/node/queries");
    await expect(
      graphqlRequest(GIGANTO_STATUS_QUERY, undefined, {
        role: "Tenant Administrator",
        customerIds: [5],
      }),
    ).rejects.toThrow();
  });
});
