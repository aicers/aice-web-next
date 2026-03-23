import { beforeAll, describe, expect, it } from "vitest";

import { resetRateLimits } from "../helpers/auth";
import { SERVER_ORIGIN } from "../setup";

describe("Rate limiting API", () => {
  beforeAll(async () => {
    await resetRateLimits();
  });

  it("per-IP: 429 after exhausting per-IP bucket", async () => {
    await resetRateLimits();

    // The per-IP limit is 20 per 5 minutes.
    // Use different fake usernames (5 attempts each) to stay under
    // the per-account+IP limit of 5 while building up the per-IP count.
    for (let batch = 0; batch < 4; batch++) {
      const user = `ratelimit-ip-test-${batch}`;
      for (let i = 0; i < 5; i++) {
        await fetch(`${SERVER_ORIGIN}/api/auth/sign-in`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: user, password: "wrong" }),
        });
      }
    }

    // per-IP count is now 20. The next request should be rate-limited.
    const response = await fetch(`${SERVER_ORIGIN}/api/auth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "ratelimit-ip-final",
        password: "wrong",
      }),
    });

    expect(response.status).toBe(429);
  });
});
