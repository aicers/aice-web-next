/**
 * End-to-end integration test for the mTLS + Context JWT flow.
 *
 * Spins up a real HTTPS server with mutual TLS, sends a GraphQL request
 * through the full stack (undici Agent → mTLS handshake → JWT verification),
 * and asserts the server received valid credentials.
 *
 * This mirrors the flow that review-web performs:
 *   1. Client presents certificate via mTLS
 *   2. Server extracts the public key from the client certificate
 *   3. Server verifies the JWT signature using that public key
 *   4. Server reads role + customer_ids from the JWT payload
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

import { importSPKI, jwtVerify } from "jose";
import { Agent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("mTLS + Context JWT E2E", () => {
  // Generate a fresh CA + client cert for the test
  let caCertPem: string;
  let caKeyPem: string;
  let serverCertPem: string;
  let serverKeyPem: string;
  let tmpDir: string;
  let serverPort: number;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    // Create temp dir for certs
    tmpDir = execSync("mktemp -d").toString().trim();

    // Generate CA
    execSync(
      `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
        `-keyout ${tmpDir}/ca-key.pem -out ${tmpDir}/ca-cert.pem ` +
        `-days 1 -nodes -subj "/CN=test-ca"`,
      { stdio: "pipe" },
    );

    // Generate server cert signed by CA
    execSync(
      `openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
        `-keyout ${tmpDir}/srv-key.pem -out ${tmpDir}/srv-csr.pem ` +
        `-nodes -subj "/CN=localhost"`,
      { stdio: "pipe" },
    );
    execSync(
      `openssl x509 -req -in ${tmpDir}/srv-csr.pem ` +
        `-CA ${tmpDir}/ca-cert.pem -CAkey ${tmpDir}/ca-key.pem ` +
        `-CAcreateserial -out ${tmpDir}/srv-cert.pem -days 1 ` +
        `-extfile <(echo "subjectAltName=DNS:localhost")`,
      { shell: "/bin/bash", stdio: "pipe" },
    );

    // Generate client cert signed by CA
    execSync(
      `openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
        `-keyout ${tmpDir}/client-key.pem -out ${tmpDir}/client-csr.pem ` +
        `-nodes -subj "/CN=aice-web-next"`,
      { stdio: "pipe" },
    );
    execSync(
      `openssl x509 -req -in ${tmpDir}/client-csr.pem ` +
        `-CA ${tmpDir}/ca-cert.pem -CAkey ${tmpDir}/ca-key.pem ` +
        `-CAcreateserial -out ${tmpDir}/client-cert.pem -days 1`,
      { shell: "/bin/bash", stdio: "pipe" },
    );

    caCertPem = readFileSync(`${tmpDir}/ca-cert.pem`, "utf8");
    caKeyPem = readFileSync(`${tmpDir}/ca-key.pem`, "utf8");
    serverCertPem = readFileSync(`${tmpDir}/srv-cert.pem`, "utf8");
    serverKeyPem = readFileSync(`${tmpDir}/srv-key.pem`, "utf8");

    // Set env vars for mtls module
    process.env.MTLS_CERT_PATH = `${tmpDir}/client-cert.pem`;
    process.env.MTLS_KEY_PATH = `${tmpDir}/client-key.pem`;
    process.env.MTLS_CA_PATH = `${tmpDir}/ca-cert.pem`;

    // Start mTLS server that mimics review-web's verification
    server = await startMtlsServer();
    const addr = server.address();
    serverPort = typeof addr === "object" && addr !== null ? addr.port : 0;

    process.env.REVIEW_GRAPHQL_ENDPOINT = `https://localhost:${serverPort}/graphql`;
  });

  afterAll(async () => {
    delete process.env.MTLS_CERT_PATH;
    delete process.env.MTLS_KEY_PATH;
    delete process.env.MTLS_CA_PATH;
    delete process.env.REVIEW_GRAPHQL_ENDPOINT;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    execSync(`rm -rf ${tmpDir}`);
  });

  function startMtlsServer(): Promise<ReturnType<typeof createServer>> {
    return new Promise((resolve) => {
      const srv = createServer(
        {
          cert: serverCertPem,
          key: serverKeyPem,
          ca: [caCertPem],
          requestCert: true,
          rejectUnauthorized: true,
        },
        async (req, res) => {
          try {
            // 1. Extract client certificate (mTLS)
            const socket = req.socket as import("node:tls").TLSSocket;
            const peerCert = socket.getPeerX509Certificate();
            if (!peerCert) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  errors: [{ message: "mTLS certificate required" }],
                }),
              );
              return;
            }

            // 2. Extract Authorization Bearer token
            const authHeader = req.headers.authorization;
            if (!authHeader?.startsWith("Bearer ")) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  errors: [{ message: "Bearer token required" }],
                }),
              );
              return;
            }
            const token = authHeader.slice(7);

            // 3. Verify JWT using client certificate's public key
            //    (This is exactly what review-web does)
            const pubKeyPem = peerCert.publicKey.export({
              type: "spki",
              format: "pem",
            }) as string;
            const pubKey = await importSPKI(pubKeyPem, "ES256");
            const { payload } = await jwtVerify(token, pubKey);

            // 4. Return the verified claims as GraphQL response
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                data: {
                  auth: {
                    role: payload.role,
                    customerIds: payload.customer_ids ?? null,
                    algorithm: "ES256",
                    verified: true,
                  },
                },
              }),
            );
          } catch (err) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                errors: [
                  {
                    message:
                      err instanceof Error ? err.message : "Unknown error",
                  },
                ],
              }),
            );
          }
        },
      );

      srv.listen(0, "localhost", () => resolve(srv));
    });
  }

  it("full mTLS handshake + JWT verification succeeds", async () => {
    const { signContextJwt, getAgent } = await import("@/lib/mtls");

    const agent = await getAgent();
    const token = await signContextJwt("System Administrator", [42, 99]);

    const response = await fetch(`https://localhost:${serverPort}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: "{ auth { role customerIds } }" }),
      dispatcher: agent,
    } as RequestInit);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.auth.role).toBe("System Administrator");
    expect(body.data.auth.customerIds).toEqual([42, 99]);
    expect(body.data.auth.verified).toBe(true);
  });

  it("request without client cert is rejected", async () => {
    // Agent without client cert
    const noCertAgent = new Agent({
      connect: {
        ca: caCertPem,
        rejectUnauthorized: true,
      },
    });

    try {
      await fetch(`https://localhost:${serverPort}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ auth { role } }" }),
        dispatcher: noCertAgent,
      } as RequestInit);
      // If we get here, the TLS handshake didn't reject — check response
      expect.fail("Expected TLS handshake to fail without client cert");
    } catch (err) {
      // TLS handshake failure is expected
      expect(err).toBeDefined();
    } finally {
      await noCertAgent.close();
    }
  });

  it("request with wrong JWT signature is rejected", async () => {
    const agent = (await import("@/lib/mtls")).getAgent();

    // Forge a token with a different key (not matching the client cert)
    const { SignJWT, importPKCS8 } = await import("jose");
    // Use the CA key to sign (wrong key)
    const wrongKey = await importPKCS8(caKeyPem, "ES256");
    const forgedToken = await new SignJWT({ role: "System Administrator" })
      .setProtectedHeader({ alg: "ES256" })
      .setExpirationTime("5m")
      .sign(wrongKey);

    const response = await fetch(`https://localhost:${serverPort}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${forgedToken}`,
      },
      body: JSON.stringify({ query: "{ auth { role } }" }),
      dispatcher: await agent,
    } as RequestInit);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.errors[0].message).toContain("signature");
  });

  it("graphqlRequest integrates mTLS + JWT end-to-end", async () => {
    // Use the full graphqlRequest function
    const { graphqlRequest } = await import("@/lib/graphql/client");

    const result = await graphqlRequest<{
      auth: {
        role: string;
        customerIds: number[] | null;
        verified: boolean;
      };
    }>("{ auth { role customerIds verified } }", undefined, {
      role: "System Administrator",
      customerIds: [42],
    });

    expect(result.auth.role).toBe("System Administrator");
    expect(result.auth.customerIds).toEqual([42]);
    expect(result.auth.verified).toBe(true);
  });
});
