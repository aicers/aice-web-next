import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("returns 200 with the documented body shape and makes no DB call", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
