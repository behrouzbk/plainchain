import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStateDb, openStateDb, retryTransientOpen, type StateDb } from "../../src/state/db.js";

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

describe("retryTransientOpen (a file briefly held by another program, e.g. an antivirus scan on Windows)", () => {
  const accessDenied = () =>
    Object.assign(new Error("IO error: RenameFile C:/tmp/db/000002.dbtmp C:/tmp/db/CURRENT: Access is denied."), {
      code: "LEVEL_IO_ERROR",
    });

  it("attack: a scanner holding a fresh database file for a moment does not fail the open", async () => {
    let calls = 0;
    const slept: number[] = [];
    await retryTransientOpen(
      async () => {
        calls++;
        if (calls < 3) throw accessDenied();
      },
      [10, 20, 40],
      async (ms) => {
        slept.push(ms);
      },
    );
    expect(calls).toBe(3);
    expect(slept).toEqual([10, 20]);
  });

  it("does not retry a real failure such as corruption: it is thrown at once", async () => {
    let calls = 0;
    const corrupt = Object.assign(new Error("Corruption: bad record length"), { code: "LEVEL_CORRUPTION" });
    await expect(
      retryTransientOpen(
        async () => {
          calls++;
          throw corrupt;
        },
        [10, 20, 40],
        async () => {},
      ),
    ).rejects.toBe(corrupt);
    expect(calls).toBe(1);
  });

  it("gives up after the last delay and throws the real error, not \"Database is not open\"", async () => {
    let calls = 0;
    const slept: number[] = [];
    let last: Error | undefined;
    const failure = retryTransientOpen(
      async () => {
        calls++;
        last = accessDenied();
        throw last;
      },
      [10, 20, 40],
      async (ms) => {
        slept.push(ms);
      },
    );
    await expect(failure).rejects.toThrow(/Access is denied/);
    await expect(failure).rejects.toBe(last);
    expect(calls).toBe(4);
    expect(slept).toEqual([10, 20, 40]);
  });
});
