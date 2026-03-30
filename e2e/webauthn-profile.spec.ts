import { expect, test } from "./fixtures";
import { resetRateLimits, signInAndWait } from "./helpers/auth";
import {
  deleteMfaChallenges,
  deleteTotpCredential,
  deleteWebAuthnChallenges,
  deleteWebAuthnCredentials,
  insertWebAuthnCredential,
  resetAccountDefaults,
  resetMfaPolicy,
} from "./helpers/setup-db";
import { setMfaPolicyViaApi } from "./helpers/webauthn";

test.describe("WebAuthn profile management (#219)", () => {
  test.beforeAll(async ({ workerUsername }) => {
    await resetRateLimits();
    await resetAccountDefaults(workerUsername);
    await deleteTotpCredential(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
    await deleteWebAuthnChallenges(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await resetMfaPolicy();
  });

  test.beforeEach(async ({ workerUsername }) => {
    await resetRateLimits();
    await deleteTotpCredential(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
    await deleteWebAuthnChallenges(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await resetMfaPolicy();
  });

  test.afterAll(async ({ workerUsername }) => {
    await deleteTotpCredential(workerUsername);
    await deleteWebAuthnCredentials(workerUsername);
    await deleteWebAuthnChallenges(workerUsername);
    await deleteMfaChallenges(workerUsername);
    await resetAccountDefaults(workerUsername);
    await resetMfaPolicy();
  });

  // ── Status display ──────────────────────────────────────────

  test("shows disabled badge when no passkeys enrolled", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    // The WebAuthn card should show "Disabled" and "Register Passkey"
    await expect(
      page.getByRole("button", { name: /register passkey/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("shows enabled badge with credential list when enrolled", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await insertWebAuthnCredential(workerUsername, {
      displayName: "My Passkey",
    });
    await page.goto("/profile");

    await expect(page.getByText("My Passkey")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: /add passkey/i }),
    ).toBeVisible();
  });

  // ── Registration flow ──────────────────────────────────────

  test("register passkey via virtual authenticator", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    // Set up virtual authenticator
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      },
    );

    try {
      await page.goto("/profile");

      const registerBtn = page.getByRole("button", {
        name: /register passkey/i,
      });
      await expect(registerBtn).toBeVisible({ timeout: 5_000 });
      await registerBtn.click();

      // Fill display name
      await page.locator("#webauthn-display-name").fill("E2E Virtual Key");

      // Click register
      await page.getByRole("button", { name: /^register passkey$/i }).click();

      // Should show success message
      await expect(
        page.getByText(/passkey registered successfully/i),
      ).toBeVisible({ timeout: 20_000 });

      // Close dialog
      await page.getByRole("button", { name: /done/i }).click();

      // Credential should appear in the list
      await expect(page.getByText("E2E Virtual Key")).toBeVisible({
        timeout: 5_000,
      });

      // Should now show "Add Passkey" instead of "Register Passkey"
      await expect(
        page.getByRole("button", { name: /add passkey/i }),
      ).toBeVisible();
    } finally {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId,
      });
      await cdp.send("WebAuthn.disable");
      await cdp.detach();
    }
  });

  // ── Multiple credentials ──────────────────────────────────

  test("register second passkey after first", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    let { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      },
    );

    try {
      await page.goto("/profile");

      // Register first passkey
      await page.getByRole("button", { name: /register passkey/i }).click();
      await page.locator("#webauthn-display-name").fill("Key One");
      await page.getByRole("button", { name: /^register passkey$/i }).click();
      await expect(
        page.getByText(/passkey registered successfully/i),
      ).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: /done/i }).click();

      // Reset virtual authenticator so excludeCredentials doesn't block
      await cdp.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId,
      });
      ({ authenticatorId } = await cdp.send(
        "WebAuthn.addVirtualAuthenticator",
        {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
          },
        },
      ));

      // Register second passkey
      await page.getByRole("button", { name: /add passkey/i }).click();
      await page.locator("#webauthn-display-name").fill("Key Two");
      await page.getByRole("button", { name: /^register passkey$/i }).click();
      await expect(
        page.getByText(/passkey registered successfully/i),
      ).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: /done/i }).click();

      // Both should be listed
      await expect(page.getByText("Key One")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("Key Two")).toBeVisible();
    } finally {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId,
      });
      await cdp.send("WebAuthn.disable");
      await cdp.detach();
    }
  });

  // ── Rename credential ──────────────────────────────────────

  test("rename passkey via rename dialog", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Old Name",
    });
    await page.goto("/profile");

    await expect(page.getByText("Old Name")).toBeVisible({ timeout: 5_000 });

    // Click rename button (pencil icon)
    await page.getByRole("button", { name: /rename/i }).click();

    // Dialog should open with current name
    const input = page.locator("#webauthn-rename-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(input).toHaveValue("Old Name");

    // Clear and type new name
    await input.fill("New Name");
    await page.getByRole("button", { name: /^save$/i }).click();

    // Dialog should close, new name should appear
    await expect(page.getByText("New Name")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Old Name")).not.toBeVisible();
  });

  // ── Remove credential ──────────────────────────────────────

  test("remove passkey with password confirmation", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await insertWebAuthnCredential(workerUsername, {
      displayName: "To Remove",
    });
    await page.goto("/profile");

    await expect(page.getByText("To Remove")).toBeVisible({ timeout: 5_000 });

    // Click remove button (trash icon)
    await page.getByRole("button", { name: /remove passkey/i }).click();

    // Confirmation dialog should appear
    await expect(page.getByText(/are you sure/i)).toBeVisible({
      timeout: 5_000,
    });

    // Enter password
    await page.locator("#webauthn-remove-password").fill(workerPassword);
    await page.getByRole("button", { name: /^remove passkey$/i }).click();

    // Credential should be gone, "Register Passkey" button should appear
    await expect(
      page.getByRole("button", { name: /register passkey/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("remove passkey with wrong password shows error", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await insertWebAuthnCredential(workerUsername, {
      displayName: "Keep Me",
    });
    await page.goto("/profile");

    await expect(page.getByText("Keep Me")).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /remove passkey/i }).click();
    await page.locator("#webauthn-remove-password").fill("WrongPassword1!");
    await page.getByRole("button", { name: /^remove passkey$/i }).click();

    // Should show error
    const alert = page.locator("p[role='alert']");
    await expect(alert).toBeVisible({ timeout: 5_000 });
  });

  // ── Policy enforcement ─────────────────────────────────────

  test("shows not-available message when webauthn not allowed by policy", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    await setMfaPolicyViaApi(page, ["totp"]);

    try {
      await page.goto("/profile");

      // No register button should be visible
      await expect(
        page.getByRole("button", { name: /register passkey/i }),
      ).not.toBeVisible({ timeout: 5_000 });

      // "Passkeys are not available" message
      await expect(page.getByText(/passkeys are not available/i)).toBeVisible();
    } finally {
      await setMfaPolicyViaApi(page, ["webauthn", "totp"]);
    }
  });

  test("shows disabled-by-admin state when enrolled but policy disallows", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    await insertWebAuthnCredential(workerUsername, {
      displayName: "Admin Off",
    });
    await setMfaPolicyViaApi(page, ["totp"]);

    try {
      await page.goto("/profile");

      // Should show credential list
      await expect(page.getByText("Admin Off")).toBeVisible({ timeout: 5_000 });

      // Should show "disabled by admin" message
      await expect(
        page.getByText(/disabled by an administrator/i),
      ).toBeVisible();

      // Should NOT show "Add Passkey" button (registration not allowed)
      await expect(
        page.getByRole("button", { name: /add passkey/i }),
      ).not.toBeVisible();

      // Should NOT show rename button (remove-only in admin-disabled state)
      await expect(
        page.getByRole("button", { name: /rename/i }),
      ).not.toBeVisible();

      // Remove button should still work
      await page.getByRole("button", { name: /remove passkey/i }).click();
      await page.locator("#webauthn-remove-password").fill(workerPassword);
      await page.getByRole("button", { name: /^remove passkey$/i }).click();

      // Should show "not available" state after removal
      await expect(page.getByText(/passkeys are not available/i)).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      await setMfaPolicyViaApi(page, ["webauthn", "totp"]);
    }
  });

  test("cancel closes registration dialog without registering", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);
    await page.goto("/profile");

    await page.getByRole("button", { name: /register passkey/i }).click();

    // Wait for dialog
    await expect(
      page.getByRole("heading", { name: /register a passkey/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Cancel
    await page.getByRole("button", { name: /cancel/i }).click();

    // Dialog should close, still shows "Register Passkey"
    await expect(
      page.getByRole("button", { name: /register passkey/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("mid-registration policy change shows error gracefully", async ({
    page,
    workerUsername,
    workerPassword,
  }) => {
    await signInAndWait(page, workerUsername, workerPassword);

    // Set up virtual authenticator
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
        },
      },
    );

    try {
      await page.goto("/profile");

      // Open registration dialog
      await page.getByRole("button", { name: /register passkey/i }).click();
      await expect(
        page.getByRole("heading", { name: /register a passkey/i }),
      ).toBeVisible({ timeout: 5_000 });

      // Admin disables WebAuthn mid-registration via API
      await setMfaPolicyViaApi(page, ["totp"]);

      // Try to register — should fail gracefully
      await page.getByRole("button", { name: /^register passkey$/i }).click();

      // Should show an error (WEBAUTHN_NOT_ALLOWED handled gracefully)
      const alert = page.locator("p[role='alert']");
      await expect(alert).toBeVisible({ timeout: 20_000 });
    } finally {
      await setMfaPolicyViaApi(page, ["webauthn", "totp"]);
      await cdp.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId,
      });
      await cdp.send("WebAuthn.disable");
      await cdp.detach();
    }
  });
});
