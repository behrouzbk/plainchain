import { describe, expect, it } from "vitest";
import { validateHeader } from "../../src/consensus/blockValidator.js";
import { createEngine, PoaEngine, PowEngine, POA_IN_TURN_WORK, POA_OUT_OF_TURN_WORK } from "../../src/consensus/engine.js";
import { workForTarget } from "../../src/consensus/forkChoice.js";
import { rulesHash } from "../../src/consensus/monetary.js";
import { generateKeyPair } from "../../src/crypto/keypair.js";
import { sign } from "../../src/crypto/signature.js";
import { computeBlockHash, computeSealHash, createGenesisBlock } from "../../src/ledger/block.js";
import type { BlockHeader } from "../../src/ledger/types.js";

const TARGET = "0000ffff" + "f".repeat(56);
const NOW = 1700000100000;
const genesis = createGenesisBlock({ timestamp: 1700000000000, difficultyTarget: TARGET, reward: 1n, genesisAddress: "g" });

const keys = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
const authorities = keys.map((k) => k.publicKey);
const outsider = generateKeyPair();

function template(parent: { header: BlockHeader; hash: string }, height = parent.header.height + 1): BlockHeader {
  return {
    version: 1,
    previousHash: parent.hash,
    merkleRoot: "ab".repeat(32),
    timestamp: parent.header.timestamp + 1000,
    difficultyTarget: TARGET,
    nonce: 0,
    height,
  };
}

async function sealWith(key: { publicKey: string; privateKey: string }, header: BlockHeader): Promise<{ header: BlockHeader; hash: string }> {
  return new PoaEngine({ authorities, signerKey: key }).seal(header);
}

describe("PoaEngine (proof of authority)", () => {
  it("seals a header with the signer's key: the signer is in the hash, the signature is over the hash and outside it", async () => {
    const sealed = await sealWith(keys[1]!, template(genesis));
    expect(sealed.header.signer).toBe(authorities[1]);
    expect(sealed.hash).toBe(computeBlockHash(sealed.header));
    // The hash commits to the signer and the signature; the signature is over the seal hash (hash without it).
    expect(computeBlockHash({ ...sealed.header, signature: undefined })).toBe(computeSealHash(sealed.header));
    expect(computeSealHash(sealed.header)).not.toBe(sealed.hash);
    expect(computeBlockHash({ ...sealed.header, signature: "00" })).not.toBe(sealed.hash);
    expect(computeBlockHash({ ...sealed.header, signer: authorities[0] })).not.toBe(sealed.hash);
    const engine = new PoaEngine({ authorities });
    expect(engine.verifySeal(sealed.header, sealed.hash, { recentSigners: [] })).toEqual({ valid: true });
  });

  it("attack: a block signed by a key outside the authority set is rejected", async () => {
    const sealed = await new PoaEngine({ authorities: [...authorities, outsider.publicKey], signerKey: outsider }).seal(template(genesis));
    const verdict = new PoaEngine({ authorities }).verifySeal(sealed.header, sealed.hash, { recentSigners: [] });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/not an authority/);
  });

  it("attack: a tampered header, a missing or forged signature, and a signature by another authority's key are rejected", async () => {
    const engine = new PoaEngine({ authorities });
    const sealed = await sealWith(keys[0]!, template(genesis));
    // Same signer and signature, but the body changed: the hash changed, so the signature no longer covers it.
    const tampered = { ...sealed.header, timestamp: sealed.header.timestamp + 1 };
    expect(engine.verifySeal(tampered, computeBlockHash(tampered), { recentSigners: [] }).reason).toMatch(/signature/);
    // Claims authority 0 but was signed by authority 1's key.
    const forged = { ...sealed.header, signature: sign(keys[1]!.privateKey, sealed.hash) };
    expect(engine.verifySeal(forged, sealed.hash, { recentSigners: [] }).reason).toMatch(/signature/);
    const unsigned = { ...sealed.header, signature: undefined };
    expect(engine.verifySeal(unsigned, sealed.hash, { recentSigners: [] }).valid).toBe(false);
    const garbage = { ...sealed.header, signature: "zz", signer: 42 as unknown as string };
    expect(engine.verifySeal(garbage, computeBlockHash(garbage), { recentSigners: [] }).valid).toBe(false);
  });

  it("attack: one authority cannot monopolize the chain -- a signer may sign once per floor(n/2)+1 blocks", async () => {
    const engine = new PoaEngine({ authorities }); // n = 3: window of 1 recent signer
    expect(engine.recentSignerWindow()).toBe(1);
    const b1 = await sealWith(keys[0]!, template(genesis));
    const b2 = await sealWith(keys[0]!, template(b1));
    expect(engine.verifySeal(b2.header, b2.hash, { recentSigners: [authorities[0]!] }).reason).toMatch(/signed too recently/);
    const b2other = await sealWith(keys[2]!, template(b1));
    expect(engine.verifySeal(b2other.header, b2other.hash, { recentSigners: [authorities[0]!] })).toEqual({ valid: true });
    // With five authorities the window is two: the last two signers are excluded.
    const five = new PoaEngine({ authorities: [...authorities, generateKeyPair().publicKey, generateKeyPair().publicKey] });
    expect(five.recentSignerWindow()).toBe(2);
    expect(five.verifySeal(b1.header, b1.hash, { recentSigners: [authorities[1]!, authorities[0]!] }).valid).toBe(false);
    expect(five.verifySeal(b1.header, b1.hash, { recentSigners: [authorities[1]!, authorities[2]!] }).valid).toBe(true);
    // A lone authority (n = 1) may sign every block.
    expect(new PoaEngine({ authorities: [authorities[0]!] }).recentSignerWindow()).toBe(0);
  });

  it("fork choice: an in-turn block (height mod n) weighs more than an out-of-turn one, so the scheduled chain wins ties", async () => {
    const engine = new PoaEngine({ authorities });
    const inTurn = await sealWith(keys[1]!, template(genesis)); // height 1 -> authority 1
    const outOfTurn = await sealWith(keys[2]!, template(genesis));
    expect(engine.blockWork(inTurn.header, inTurn.hash)).toBe(POA_IN_TURN_WORK);
    expect(engine.blockWork(outOfTurn.header, outOfTurn.hash)).toBe(POA_OUT_OF_TURN_WORK);
    expect(POA_IN_TURN_WORK).toBeGreaterThan(POA_OUT_OF_TURN_WORK);
    expect(engine.blockWork(genesis.header, genesis.hash)).toBe(POA_OUT_OF_TURN_WORK); // unsigned genesis
    expect(engine.inTurnAuthority(4)).toBe(authorities[1]);
  });

  it("does not retarget: the difficulty target stays whatever genesis set, and no hash threshold is checked", async () => {
    const engine = new PoaEngine({ authorities });
    expect(engine.retargets).toBe(false);
    const sealed = await sealWith(keys[1]!, template(genesis)); // hash will not be below 0000ffff...
    expect(BigInt(`0x${sealed.hash}`) > BigInt(`0x${TARGET}`)).toBe(true);
    const verdict = validateHeader(sealed.header, sealed.hash, {
      parent: genesis,
      expectedTarget: TARGET,
      now: NOW,
      maxFutureDriftMs: 60 * 60 * 1000,
      engine,
      recentSigners: [],
    });
    expect(verdict).toEqual({ valid: true });
    // The same header without a seal engine is judged as proof of work and fails.
    expect(validateHeader(sealed.header, sealed.hash, { parent: genesis, expectedTarget: TARGET, now: NOW, maxFutureDriftMs: 60 * 60 * 1000 }).reason).toMatch(/difficulty target/);
  });

  it("refuses to seal without a key, or with a key that is not an authority", async () => {
    await expect(new PoaEngine({ authorities }).seal(template(genesis))).rejects.toThrow(/no signer key/);
    expect(() => new PoaEngine({ authorities, signerKey: outsider })).toThrow(/not in the authority set/);
    expect(() => new PoaEngine({ authorities: [] })).toThrow(/at least one authority/);
    expect(() => new PoaEngine({ authorities: [authorities[0]!, authorities[0]!] })).toThrow(/duplicate/);
  });
});

describe("PowEngine and createEngine", () => {
  it("PowEngine keeps the proof-of-work rules: hash below target, work from the target, retargets on", () => {
    const engine = new PowEngine();
    expect(engine.retargets).toBe(true);
    expect(engine.recentSignerWindow()).toBe(0);
    const header = template(genesis);
    expect(engine.verifySeal(header, "00".repeat(32), { recentSigners: [] }).valid).toBe(true);
    expect(engine.verifySeal(header, "ff".repeat(32), { recentSigners: [] }).reason).toMatch(/difficulty target/);
    expect(engine.blockWork(header, "00".repeat(32))).toBe(workForTarget(TARGET));
  });

  it("createEngine picks the mode from the consensus rules, defaulting to proof of work", () => {
    expect(createEngine({})).toBeInstanceOf(PowEngine);
    expect(createEngine({ mode: "pow" })).toBeInstanceOf(PowEngine);
    expect(createEngine({ mode: "poa", authorities })).toBeInstanceOf(PoaEngine);
    expect(() => createEngine({ mode: "poa" })).toThrow(/authorit/);
    expect(() => createEngine({ mode: "dpos" as "pow" })).toThrow(/mode/);
  });

  it("rulesHash covers the mode and the ordered authority set, so mixed-mode or differently governed peers refuse each other", () => {
    const base = { targetBlockTimeMs: 10_000, difficultyRetargetInterval: 10, maxDifficultyAdjustmentFactor: 4, coinbaseMaturity: 10 };
    const policy = { initialReward: 1n, halvingInterval: 0, tailEmission: 0n };
    const pow = rulesHash(base, policy);
    expect(rulesHash({ ...base, mode: "pow", authorities: [] }, policy)).toBe(pow);
    const poa = rulesHash({ ...base, mode: "poa", authorities }, policy);
    expect(poa).not.toBe(pow);
    expect(rulesHash({ ...base, mode: "poa", authorities: authorities.slice(0, 2) }, policy)).not.toBe(poa);
    expect(rulesHash({ ...base, mode: "poa", authorities: [...authorities].reverse() }, policy)).not.toBe(poa); // order = turn schedule
  });
});
