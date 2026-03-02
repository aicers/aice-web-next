import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getDataDir", () => {
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.DATA_DIR;
  });

  afterEach(() => {
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
  });

  it("returns DATA_DIR env when set", async () => {
    process.env.DATA_DIR = "/custom/data";
    const { getDataDir } = await import("@/lib/auth/data-dir");

    expect(getDataDir()).toBe("/custom/data");
  });

  it("defaults to cwd()/data when DATA_DIR is not set", async () => {
    const { getDataDir } = await import("@/lib/auth/data-dir");

    expect(getDataDir()).toBe(path.resolve(process.cwd(), "data"));
  });

  it("resolves relative paths", async () => {
    process.env.DATA_DIR = "./relative/data";
    const { getDataDir } = await import("@/lib/auth/data-dir");

    expect(path.isAbsolute(getDataDir())).toBe(true);
    expect(getDataDir()).toBe(path.resolve("./relative/data"));
  });
});
