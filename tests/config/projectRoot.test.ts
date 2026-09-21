import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, packageVersion, projectRoot } from "../../src/config/index.js";

describe("project root resolution", () => {
  it("finds the directory holding package.json, wherever the module is loaded from (src/ or dist/)", () => {
    const root = projectRoot();
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "config", "default.json"))).toBe(true);
    expect(projectRoot(join(root, "dist", "src", "config"))).toBe(root);
    expect(projectRoot(join(root, "src", "config"))).toBe(root);
  });

  it("throws a clear error when no package.json is above the start directory", () => {
    expect(() => projectRoot("/")).toThrow(/package\.json/);
  });

  it("loads config and version from that root", () => {
    expect(loadConfig().networkId).toBe("plainchain-devnet");
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
