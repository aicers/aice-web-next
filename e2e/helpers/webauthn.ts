import type { Page } from "@playwright/test";

// ── Common helpers ──────────────────────────────────────────────

/** Build CSRF + JSON headers from a CSRF token value. */
export function csrfHeaders(csrfValue: string) {
  return {
    "Content-Type": "application/json",
    "x-csrf-token": csrfValue,
    Origin: "http://localhost:3000",
  };
}

/** Read the CSRF cookie from the current page context. */
export async function getCsrf(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "csrf")?.value ?? "";
}

/** Change MFA policy via API. Requires a signed-in page context. */
export async function setMfaPolicyViaApi(
  page: Page,
  allowedMethods: string[],
): Promise<void> {
  const csrf = await getCsrf(page);
  const res = await page.request.patch("/api/system-settings/mfa_policy", {
    headers: csrfHeaders(csrf),
    data: { value: { allowed_methods: allowedMethods } },
  });
  if (!res.ok()) throw new Error(`setMfaPolicyViaApi failed: ${res.status()}`);
}

// ── Virtual authenticator helpers ───────────────────────────────

/**
 * Use the browser's virtual authenticator (via page.evaluate) to create
 * a WebAuthn credential from the server-provided registration options.
 * Returns a RegistrationResponseJSON-compatible object.
 */
export async function createCredentialInBrowser(
  page: Page,
  // biome-ignore lint/suspicious/noExplicitAny: dynamic server response
  options: any,
) {
  return page.evaluate(async (opts) => {
    const cred = (await navigator.credentials.create({
      publicKey: {
        ...opts,
        challenge: Uint8Array.from(
          atob(opts.challenge.replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        ),
        user: {
          ...opts.user,
          id: Uint8Array.from(
            atob(opts.user.id.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
          ),
        },
        excludeCredentials: (opts.excludeCredentials ?? []).map(
          (ec: { id: string; type: string; transports?: string[] }) => ({
            ...ec,
            id: Uint8Array.from(
              atob(ec.id.replace(/-/g, "+").replace(/_/g, "/")),
              (c) => c.charCodeAt(0),
            ),
          }),
        ),
      },
    })) as PublicKeyCredential;

    const response = cred.response as AuthenticatorAttestationResponse;

    function toBase64url(buffer: ArrayBuffer): string {
      return btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    }

    return {
      id: cred.id,
      rawId: toBase64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: toBase64url(response.clientDataJSON),
        attestationObject: toBase64url(response.attestationObject),
        transports: response.getTransports?.() ?? [],
      },
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    };
  }, options);
}

/**
 * Register a WebAuthn credential via the server API using the virtual
 * authenticator. Requires a signed-in page context with an active CDP
 * virtual authenticator.
 */
export async function registerViaApi(
  page: Page,
  csrf: string,
  displayName: string,
): Promise<void> {
  const headers = csrfHeaders(csrf);

  const optionsRes = await page.request.post(
    "/api/auth/mfa/webauthn/register/options",
    { headers },
  );
  if (!optionsRes.ok()) throw new Error("registerViaApi options failed");
  const options = await optionsRes.json();

  const credential = await createCredentialInBrowser(page, options);

  const verifyRes = await page.request.post(
    "/api/auth/mfa/webauthn/register/verify",
    {
      headers,
      data: { response: credential, displayName },
    },
  );
  if (!verifyRes.ok()) throw new Error("registerViaApi verify failed");
}
