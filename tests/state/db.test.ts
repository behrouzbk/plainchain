import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStateDb, openStateDb, type StateDb } from "../../src/state/db.js";

describe("openStateDb", () => {
  let dir: string;
  let db: StateDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-db-test-"));
    db = openStateDb(dir);
  });

  afterEach(async () => {
    await closeStateDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes independently namespaced blocks/utxo/meta sublevels", async () => {
    await db.blocks.put("hash1", "block-payload");
    await db.utxo.put("txid:0", "utxo-payload");
    await db.meta.put("tipHash", "meta-payload");

    expect(await db.blocks.get("hash1")).toBe("block-payload");
    expect(await db.utxo.get("txid:0")).toBe("utxo-payload");
    expect(await db.meta.get("tipHash")).toBe("meta-payload");
  });

  it("does not leak keys between sublevels", async () => {
    await db.blocks.put("shared-key", "from-blocks");
    await db.utxo.put("shared-key", "from-utxo");

    expect(await db.blocks.get("shared-key")).toBe("from-blocks");
    expect(await db.utxo.get("shared-key")).toBe("from-utxo");
  });

  it("persists data across close/reopen at the same location", async () => {
    await db.meta.put("tipHeight", "5");
    await closeStateDb(db);

    const reopened = openStateDb(dir);
    expect(await reopened.meta.get("tipHeight")).toBe("5");
    await closeStateDb(reopened);
    db = openStateDb(dir); // hand back an open db for afterEach to close
  });
});
