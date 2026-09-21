import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";

describe("loadConfig", () => {
  it("loads config/default.json with the expected shape", () => {
    const config = loadConfig();
    expect(config.networkId).toBe("plainchain-devnet");
    expect(config.genesis.difficultyTarget).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof config.genesis.reward).toBe("string");
    expect(config.consensus.difficultyRetargetInterval).toBeGreaterThan(0);
    expect(config.network.defaultPort).toBeGreaterThan(0);
  });
});

describe("loadConfig(path): a chain's own config file", () => {
  it("overrides sections of the defaults (deep-merging one level) and reports a missing file clearly", () => {
    const dir = mkdtempSync(join(tmpdir(), "l1-config-test-"));
    try {
      const path = join(dir, "chain.json");
      writeFileSync(path, JSON.stringify({ networkId: "consortium", consensus: { mode: "poa", authorities: ["aa", "bb"] }, genesis: { timestamp: 1 } }));
      const config = loadConfig(path);
      expect(config.networkId).toBe("consortium");
      expect(config.consensus.mode).toBe("poa");
      expect(config.consensus.authorities).toEqual(["aa", "bb"]);
      expect(config.consensus.coinbaseMaturity).toBe(loadConfig().consensus.coinbaseMaturity); // untouched sibling
      expect(config.genesis.timestamp).toBe(1);
      expect(config.genesis.difficultyTarget).toBe(loadConfig().genesis.difficultyTarget);
      expect(config.rpc).toEqual(loadConfig().rpc);
      expect(() => loadConfig(join(dir, "missing.json"))).toThrow(/cannot load config .*missing\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
