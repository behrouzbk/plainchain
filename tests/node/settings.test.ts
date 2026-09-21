import { describe, expect, it } from "vitest";
import { encodeAddress } from "../../src/ledger/address.js";
import { resolveNodeSettings, SettingsError } from "../../src/node/settings.js";

const defaults = { defaultPort: 8001, rpcBind: "127.0.0.1" };
const ADDRESS = "a".repeat(64);

describe("resolveNodeSettings", () => {
  it("falls back to defaults when neither flags nor env are set", () => {
    const s = resolveNodeSettings({}, {}, defaults);
    expect(s.port).toBe(8001);
    expect(s.rpcPort).toBe(9001);
    expect(s.nodeId).toMatch(/^node-/);
    expect(s.dataDir).toBe(`data/${s.nodeId}`);
    expect(s.peers).toEqual([]);
    expect(s.rpcBind).toBe("127.0.0.1");
    expect(s.rpcAllowInsecure).toBe(false);
    expect(s.rpcTls).toBeUndefined();
    expect(s.minerAddress).toBeUndefined();
    expect(s.logFormat).toBe("text");
    expect(s.logLevel).toBe("info");
    expect(s.maxInboundPerIp).toBeUndefined();
  });

  it("reads --rpc-trust-proxy / L1_RPC_TRUST_PROXY as a proxy hop count", () => {
    expect(resolveNodeSettings({}, {}, defaults).rpcTrustProxy).toBeUndefined();
    expect(resolveNodeSettings({}, { L1_RPC_TRUST_PROXY: "1" }, defaults).rpcTrustProxy).toBe(1);
    expect(resolveNodeSettings({ "rpc-trust-proxy": "2" }, {}, defaults).rpcTrustProxy).toBe(2);
    expect(() => resolveNodeSettings({}, { L1_RPC_TRUST_PROXY: "yes" }, defaults)).toThrow(/L1_RPC_TRUST_PROXY/);
  });

  it("reads --max-inbound-per-ip / L1_MAX_INBOUND_PER_IP as a non-negative integer", () => {
    expect(resolveNodeSettings({}, { L1_MAX_INBOUND_PER_IP: "4" }, defaults).maxInboundPerIp).toBe(4);
    expect(resolveNodeSettings({ "max-inbound-per-ip": "0" }, {}, defaults).maxInboundPerIp).toBe(0);
    expect(() => resolveNodeSettings({}, { L1_MAX_INBOUND_PER_IP: "-1" }, defaults)).toThrow(/L1_MAX_INBOUND_PER_IP/);
  });

  it("reads --signer-key / L1_SIGNER_KEY as the proof-of-authority key file path", () => {
    expect(resolveNodeSettings({}, {}, defaults).signerKeyPath).toBeUndefined();
    expect(resolveNodeSettings({ "signer-key": "data/n1/authority.key" }, {}, defaults).signerKeyPath).toBe("data/n1/authority.key");
    expect(resolveNodeSettings({}, { L1_SIGNER_KEY: "/keys/a.key" }, defaults).signerKeyPath).toBe("/keys/a.key");
  });

  it("reads --addrindex-depth / L1_ADDRINDEX_DEPTH and --no-addrindex / L1_NO_ADDRINDEX", () => {
    expect(resolveNodeSettings({}, {}, defaults).addrIndexDepth).toBeUndefined();
    expect(resolveNodeSettings({}, {}, defaults).noAddrIndex).toBe(false);
    expect(resolveNodeSettings({}, { L1_ADDRINDEX_DEPTH: "1000" }, defaults).addrIndexDepth).toBe(1000);
    expect(resolveNodeSettings({ "addrindex-depth": "0" }, {}, defaults).addrIndexDepth).toBe(0);
    expect(() => resolveNodeSettings({}, { L1_ADDRINDEX_DEPTH: "-5" }, defaults)).toThrow(/L1_ADDRINDEX_DEPTH/);
    expect(resolveNodeSettings({ "no-addrindex": "true" }, {}, defaults).noAddrIndex).toBe(true);
    expect(resolveNodeSettings({}, { L1_NO_ADDRINDEX: "true" }, defaults).noAddrIndex).toBe(true);
    expect(resolveNodeSettings({}, { L1_NO_ADDRINDEX: "false" }, defaults).noAddrIndex).toBe(false);
  });

  it("reads every setting from L1_* environment variables (how containers are configured)", () => {
    const env = {
      L1_NODE_ID: "node1",
      L1_PORT: "8101",
      L1_RPC_PORT: "9101",
      L1_DATA_DIR: "/data",
      L1_PEERS: "ws://node2:8001, ws://node3:8001,",
      L1_ADVERTISE_URL: "ws://node1:8101",
      L1_MINER_ADDRESS: ADDRESS,
      L1_RPC_TOKEN: "tok",
      L1_RPC_BIND: "0.0.0.0",
      L1_RPC_TLS_CERT: "/tls/cert.pem",
      L1_RPC_TLS_KEY: "/tls/key.pem",
      L1_LOG_FORMAT: "json",
      L1_LOG_LEVEL: "warn",
    };
    const s = resolveNodeSettings({}, env, defaults);
    expect(s).toMatchObject({
      nodeId: "node1",
      port: 8101,
      rpcPort: 9101,
      dataDir: "/data",
      peers: ["ws://node2:8001", "ws://node3:8001"],
      advertiseUrl: "ws://node1:8101",
      minerAddress: ADDRESS,
      rpcToken: "tok",
      rpcBind: "0.0.0.0",
      rpcTls: { certPath: "/tls/cert.pem", keyPath: "/tls/key.pem" },
      logFormat: "json",
      logLevel: "warn",
    });
  });

  it("flags beat environment variables", () => {
    const s = resolveNodeSettings({ port: "8500", "node-id": "flag" }, { L1_PORT: "8101", L1_NODE_ID: "env" }, defaults);
    expect(s.port).toBe(8500);
    expect(s.nodeId).toBe("flag");
    expect(s.rpcPort).toBe(9500); // derived from the effective port
  });

  it("parses booleans leniently for env (true/1/yes) and as a bare flag", () => {
    expect(resolveNodeSettings({ "rpc-allow-insecure": "true" }, {}, defaults).rpcAllowInsecure).toBe(true);
    for (const v of ["true", "1", "yes", "TRUE"]) {
      expect(resolveNodeSettings({}, { L1_RPC_ALLOW_INSECURE: v }, defaults).rpcAllowInsecure, v).toBe(true);
    }
    for (const v of ["false", "0", "no", ""]) {
      expect(resolveNodeSettings({}, { L1_RPC_ALLOW_INSECURE: v }, defaults).rpcAllowInsecure, v).toBe(false);
    }
  });

  it("rejects malformed values with a pointed message", () => {
    expect(() => resolveNodeSettings({ port: "eighty" }, {}, defaults)).toThrow(SettingsError);
    expect(() => resolveNodeSettings({ port: "eighty" }, {}, defaults)).toThrow(/--port/);
    expect(() => resolveNodeSettings({}, { L1_RPC_PORT: "70000" }, defaults)).toThrow(/L1_RPC_PORT/);
    expect(() => resolveNodeSettings({ "miner-address": "nope" }, {}, defaults)).toThrow(/miner-address/);
    expect(resolveNodeSettings({ "miner-address": encodeAddress(ADDRESS) }, {}, defaults).minerAddress).toBe(ADDRESS);
    expect(() => resolveNodeSettings({}, { L1_RPC_TLS_CERT: "/c.pem" }, defaults)).toThrow(/together/);
    expect(() => resolveNodeSettings({}, { L1_LOG_LEVEL: "loud" }, defaults)).toThrow(/log level/);
    expect(() => resolveNodeSettings({ "rpc-token": "" }, {}, defaults)).toThrow(/empty/);
  });

  it("treats an empty env var as unset (compose interpolates blank .env values to empty strings)", () => {
    const s = resolveNodeSettings({}, { L1_MINER_ADDRESS: "", L1_RPC_TOKEN: "", L1_PEERS: "", L1_LOG_LEVEL: "" }, defaults);
    expect(s.minerAddress).toBeUndefined();
    expect(s.rpcToken).toBeUndefined();
    expect(s.peers).toEqual([]);
    expect(s.logLevel).toBe("info");
  });
});
