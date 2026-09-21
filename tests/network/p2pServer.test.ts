import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { P2PServer, type P2PServerOptions } from "../../src/network/p2pServer.js";
import type { Message } from "../../src/network/protocol.js";

describe("P2PServer", () => {
  const servers: P2PServer[] = [];

  function makeServer(nodeId: string, height = 0): P2PServer {
    const server = new P2PServer(nodeId, 0, () => height);
    servers.push(server);
    return server;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  it("performs a handshake and both sides learn the other's nodeId/height on connect", async () => {
    const a = makeServer("node-a", 3);
    const b = makeServer("node-b", 7);
    await a.start();
    await b.start();

    const [aConnected, bConnected] = await Promise.all([
      once(a, "peer:connected"),
      once(b, "peer:connected"),
      a.connect(`ws://localhost:${b.getBoundPort()}`),
    ]);

    expect(aConnected).toEqual(["node-b", 7]);
    expect(bConnected).toEqual(["node-a", 3]);
    expect(a.getPeerIds()).toEqual(["node-b"]);
    expect(b.getPeerIds()).toEqual(["node-a"]);
  });

  it("delivers a broadcast message from one node to a connected peer", async () => {
    const a = makeServer("node-a");
    const b = makeServer("node-b");
    await a.start();
    await b.start();
    await Promise.all([once(a, "peer:connected"), a.connect(`ws://localhost:${b.getBoundPort()}`)]);

    const message: Message = {
      type: "NEW_TX",
      payload: {
        transaction: {
          id: "11".repeat(32),
          inputs: [],
          outputs: [{ address: "alice", amount: 10n }],
          timestamp: 1,
          fee: 1n,
        },
      },
    };

    const [received] = await Promise.all([
      once(b, "message"),
      Promise.resolve(a.broadcast(message)),
    ]);

    expect(received[0]).toEqual(message);
    expect(received[1]).toBe("node-a");
  });

  it("does not broadcast to the excluded nodeId", async () => {
    const a = makeServer("node-a");
    const b = makeServer("node-b");
    const c = makeServer("node-c");
    await a.start();
    await b.start();
    await c.start();

    await Promise.all([once(a, "peer:connected"), a.connect(`ws://localhost:${b.getBoundPort()}`)]);
    await Promise.all([once(a, "peer:connected"), a.connect(`ws://localhost:${c.getBoundPort()}`)]);

    let bReceived = false;
    let cReceived = false;
    b.on("message", () => (bReceived = true));
    c.on("message", () => (cReceived = true));

    const message: Message = { type: "GET_BLOCKS", payload: { fromHeight: 0 } };
    const bMessagePromise = once(b, "message");
    a.broadcast(message, "node-c");
    await bMessagePromise;

    expect(bReceived).toBe(true);
    expect(cReceived).toBe(false);
  });

  it("sends a direct unicast message to a specific peer by nodeId", async () => {
    const a = makeServer("node-a");
    const b = makeServer("node-b");
    await a.start();
    await b.start();
    await Promise.all([once(b, "peer:connected"), a.connect(`ws://localhost:${b.getBoundPort()}`)]);

    const message: Message = { type: "GET_BLOCKS", payload: { fromHeight: 2 } };
    const [received] = await Promise.all([once(a, "message"), Promise.resolve(b.send("node-a", message))]);

    expect(received[0]).toEqual(message);
  });

  it("emits peer:disconnected when a peer closes the connection", async () => {
    const a = makeServer("node-a");
    const b = makeServer("node-b");
    await a.start();
    await b.start();
    await Promise.all([once(b, "peer:connected"), a.connect(`ws://localhost:${b.getBoundPort()}`)]);

    const disconnected = once(b, "peer:disconnected");
    await a.stop();
    servers.splice(servers.indexOf(a), 1);

    expect(await disconnected).toEqual(["node-a", true]); // handshaked peer
  });

  it("advertises its own listen address in the handshake once started", async () => {
    const a = makeServer("node-a");
    const b = makeServer("node-b");
    await a.start();
    await b.start();

    await Promise.all([
      once(a, "peer:connected"),
      once(b, "peer:connected"),
      a.connect(`ws://localhost:${b.getBoundPort()}`),
    ]);

    expect(b.getKnownPeerAddresses()).toEqual([`ws://localhost:${a.getBoundPort()}`]);
    expect(a.getKnownPeerAddresses()).toEqual([`ws://localhost:${b.getBoundPort()}`]);
  });

  it("getKnownPeerAddresses excludes the given nodeId's own address", async () => {
    const a = makeServer("node-a");
    const b = makeServer("node-b");
    const c = makeServer("node-c");
    await a.start();
    await b.start();
    await c.start();

    await Promise.all([once(a, "peer:connected"), a.connect(`ws://localhost:${b.getBoundPort()}`)]);
    await Promise.all([once(a, "peer:connected"), a.connect(`ws://localhost:${c.getBoundPort()}`)]);

    expect(a.getKnownPeerAddresses("node-b")).toEqual([`ws://localhost:${c.getBoundPort()}`]);
    expect(a.getKnownPeerAddresses("node-c")).toEqual([`ws://localhost:${b.getBoundPort()}`]);
  });

  it("collapses a redundant second connection to a peer it's already connected to", async () => {
    const a = makeServer("node-a");
    const b = makeServer("node-b");
    await a.start();
    await b.start();

    await Promise.all([
      once(a, "peer:connected"),
      once(b, "peer:connected"),
      a.connect(`ws://localhost:${b.getBoundPort()}`),
    ]);
    expect(a.getPeerIds()).toEqual(["node-b"]);
    expect(b.getPeerIds()).toEqual(["node-a"]);

    // A second, redundant connection attempt between the same two nodeIds.
    await a.connect(`ws://localhost:${b.getBoundPort()}`);
    // Give both sides a moment to exchange the second handshake and self-close it.
    await new Promise((r) => setTimeout(r, 200));

    expect(a.getPeerIds()).toEqual(["node-b"]);
    expect(b.getPeerIds()).toEqual(["node-a"]);
  });

  it("rejects a connection to itself", async () => {
    const a = makeServer("node-a");
    await a.start();

    await a.connect(`ws://localhost:${a.getBoundPort()}`);
    await new Promise((r) => setTimeout(r, 200));

    expect(a.getPeerIds()).toEqual([]);
  });
});

describe("P2PServer robustness", () => {
  const servers: P2PServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  async function rawClient(server: P2PServer): Promise<WebSocket> {
    const socket = new WebSocket(`ws://localhost:${server.getBoundPort()}`);
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }

  it("drops a peer that sends malformed data instead of crashing, and keeps serving others", async () => {
    const a = new P2PServer("node-a", 0, () => 0);
    servers.push(a);
    await a.start();

    const bad = await rawClient(a);
    const closed = once(bad, "close");
    bad.send("this is not json");
    await closed; // server closed the connection on us

    // Server is still alive and functional.
    const b = new P2PServer("node-b", 0, () => 0);
    servers.push(b);
    await b.start();
    await Promise.all([once(a, "peer:connected"), b.connect(`ws://localhost:${a.getBoundPort()}`)]);
    expect(a.getPeerIds()).toEqual(["node-b"]);
  });

  it("drops a peer that sends valid JSON that is not a message envelope", async () => {
    const a = new P2PServer("node-a", 0, () => 0);
    servers.push(a);
    await a.start();

    const bad = await rawClient(a);
    const closed = once(bad, "close");
    bad.send(JSON.stringify(42));
    await closed;
    expect(a.getPeerIds()).toEqual([]);
  });

  it("rejects a peer on a different network (networkId/genesis mismatch)", async () => {
    const a = new P2PServer("node-a", 0, () => 0, { networkId: "net-1", genesisHash: "g1" });
    const b = new P2PServer("node-b", 0, () => 0, { networkId: "net-2", genesisHash: "g2" });
    servers.push(a, b);
    await a.start();
    await b.start();

    // Whichever side sees the other's handshake first does the rejecting.
    const rejected = Promise.race([once(a, "peer:rejected"), once(b, "peer:rejected")]);
    await b.connect(`ws://localhost:${a.getBoundPort()}`);
    const [rejectedNodeId, reason] = await rejected;

    expect(["node-a", "node-b"]).toContain(rejectedNodeId);
    expect(reason).toMatch(/network/i);
    await new Promise((r) => setTimeout(r, 200));
    expect(a.getPeerIds()).toEqual([]);
    expect(b.getPeerIds()).toEqual([]);
  });

  it("rejects a peer that declares no identity when this node has one", async () => {
    const a = new P2PServer("node-a", 0, () => 0, { networkId: "net-1", genesisHash: "g1" });
    const anonymous = new P2PServer("node-b", 0, () => 0);
    servers.push(a, anonymous);
    await a.start();
    await anonymous.start();

    const rejected = once(a, "peer:rejected");
    await anonymous.connect(`ws://localhost:${a.getBoundPort()}`);
    await rejected;
    await new Promise((r) => setTimeout(r, 200));
    expect(a.getPeerIds()).toEqual([]);
  });

  it("accepts a peer with a matching identity", async () => {
    const identity = { networkId: "net-1", genesisHash: "g1" };
    const a = new P2PServer("node-a", 0, () => 0, identity);
    const b = new P2PServer("node-b", 0, () => 0, { ...identity });
    servers.push(a, b);
    await a.start();
    await b.start();

    await Promise.all([
      once(a, "peer:connected"),
      once(b, "peer:connected"),
      b.connect(`ws://localhost:${a.getBoundPort()}`),
    ]);
    expect(a.getPeerIds()).toEqual(["node-b"]);
    expect(b.getPeerIds()).toEqual(["node-a"]);
  });
});

describe("P2PServer hardening", () => {
  const servers: P2PServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  function makeServer(nodeId: string, options: Partial<P2PServerOptions> = {}): P2PServer {
    const server = new P2PServer(nodeId, 0, () => 0, undefined, options);
    servers.push(server);
    return server;
  }

  /** A bare socket that never sends a handshake. */
  async function rawClient(server: P2PServer): Promise<WebSocket> {
    const socket = new WebSocket(`ws://localhost:${server.getBoundPort()}`);
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }

  function settle(ms = 150): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  it("closes inbound connections beyond maxInboundPeers, counting slots held by peers that haven't handshaked yet", async () => {
    const a = makeServer("node-a", { maxInboundPeers: 2, handshakeTimeoutMs: 60_000 });
    await a.start();

    // Two silent sockets fill the inbound slots without ever handshaking:
    // a flooder must not get more slots by simply not talking.
    await rawClient(a);
    await rawClient(a);

    const third = await rawClient(a);
    const [code] = (await once(third, "close")) as [number];
    expect(code).toBe(1013); // "try again later"
    expect(a.getConnectionCount()).toBe(2);
  });

  it("frees an inbound slot when a peer never completes the handshake in time", async () => {
    const a = makeServer("node-a", { maxInboundPeers: 1, handshakeTimeoutMs: 100 });
    await a.start();

    const silent = await rawClient(a);
    const silentClosed = once(silent, "close");
    await silentClosed;
    expect(a.getConnectionCount()).toBe(0);

    // Slot is usable again by a well-behaved peer.
    const b = makeServer("node-b");
    await b.start();
    await Promise.all([once(a, "peer:connected"), b.connect(`ws://localhost:${a.getBoundPort()}`)]);
    expect(a.getPeerIds()).toEqual(["node-b"]);
  });

  it("attack: caps inbound connections per remote address when maxInboundPerIp is set, and frees them on close", async () => {
    const a = makeServer("node-a", { maxInboundPerIp: 2, maxInboundPeers: 32 });
    await a.start();
    const rejected: string[] = [];
    a.on("peer:rejected", (_id: string, reason: string) => rejected.push(reason));

    // Two from localhost are fine; the third is refused at accept, before any handshake.
    const first = await rawClient(a);
    const second = await rawClient(a);
    const third = await rawClient(a);
    const [code] = (await once(third, "close")) as [number];
    expect(code).toBe(1013);
    expect(rejected.some((r) => /per address|from this address/i.test(r))).toBe(true);
    expect(a.getConnectionCount()).toBe(2);

    // Closing one frees the slot for the same address.
    first.close();
    await settle();
    const fourth = await rawClient(a);
    await settle(50);
    expect(fourth.readyState).toBe(WebSocket.OPEN);
    expect(a.getConnectionCount()).toBe(2);
    second.close();
    fourth.close();
  });

  it("does not limit connections per address unless configured (single-host devnets share 127.0.0.1)", async () => {
    const a = makeServer("node-a", { maxInboundPeers: 32 });
    await a.start();
    const clients = await Promise.all([rawClient(a), rawClient(a), rawClient(a), rawClient(a)]);
    await settle(50);
    expect(clients.every((c) => c.readyState === WebSocket.OPEN)).toBe(true);
    expect(a.getConnectionCount()).toBe(4);
    for (const c of clients) c.close();
  });

  it("per-address limit does not count outbound connections to that address", async () => {
    const a = makeServer("node-a", { maxInboundPerIp: 1 });
    const b = makeServer("node-b", { maxInboundPerIp: 1 });
    await a.start();
    await b.start();
    // a dials b (outbound for a): a's own inbound budget for 127.0.0.1 is untouched.
    await Promise.all([once(a, "peer:connected"), a.connect(`ws://localhost:${b.getBoundPort()}`)]);
    const inbound = await rawClient(a);
    await settle(50);
    expect(inbound.readyState).toBe(WebSocket.OPEN);
    inbound.close();
  });

  it("refuses to dial out beyond maxOutboundPeers", async () => {
    const a = makeServer("node-a", { maxOutboundPeers: 1 });
    const b = makeServer("node-b");
    const c = makeServer("node-c");
    await a.start();
    await b.start();
    await c.start();

    await Promise.all([once(a, "peer:connected"), a.connect(`ws://localhost:${b.getBoundPort()}`)]);
    await expect(a.connect(`ws://localhost:${c.getBoundPort()}`)).rejects.toThrow(/outbound/i);
    await settle();
    expect(a.getPeerIds()).toEqual(["node-b"]);
    expect(c.getPeerIds()).toEqual([]);
  });

  it("inbound slots are separate from outbound slots, so an inbound flood can't stop us dialing out", async () => {
    const a = makeServer("node-a", { maxInboundPeers: 1, maxOutboundPeers: 1, handshakeTimeoutMs: 60_000 });
    const b = makeServer("node-b");
    await a.start();
    await b.start();

    await rawClient(a); // fills the only inbound slot
    await Promise.all([once(a, "peer:connected"), a.connect(`ws://localhost:${b.getBoundPort()}`)]);
    expect(a.getPeerIds()).toEqual(["node-b"]);
  });

  it("drops a peer that sends a frame larger than maxMessageBytes without crashing", async () => {
    const a = makeServer("node-a", { maxMessageBytes: 1024 });
    await a.start();

    const flooder = await rawClient(a);
    const closed = once(flooder, "close");
    flooder.send(JSON.stringify({ type: "NEW_TX", payload: { junk: "x".repeat(4096) } }));
    await closed;

    const b = makeServer("node-b");
    await b.start();
    await Promise.all([once(a, "peer:connected"), b.connect(`ws://localhost:${a.getBoundPort()}`)]);
    expect(a.getPeerIds()).toEqual(["node-b"]);
  });

  it("bans a peer whose penalties reach the threshold: disconnects it and refuses it on reconnect", async () => {
    const a = makeServer("node-a", { banThreshold: 100, banDurationMs: 60_000 });
    const b = makeServer("node-b");
    await a.start();
    await b.start();
    await Promise.all([once(a, "peer:connected"), b.connect(`ws://localhost:${a.getBoundPort()}`)]);

    const banned = once(a, "peer:banned");
    const disconnected = once(a, "peer:disconnected");
    a.penalize("node-b", 60, "first offense");
    expect(a.getPeerIds()).toEqual(["node-b"]); // below threshold: still connected
    a.penalize("node-b", 40, "second offense");
    expect(await banned).toEqual(["node-b", "second offense"]);
    await disconnected;
    expect(a.getPeerIds()).toEqual([]);

    // Reconnect from the banned identity is refused at handshake...
    const rejected = once(a, "peer:rejected");
    await b.connect(`ws://localhost:${a.getBoundPort()}`);
    expect(await rejected).toEqual(["node-b", "banned"]);
    await settle();
    expect(a.getPeerIds()).toEqual([]);

    // ...and we won't dial it either.
    await expect(a.connect(`ws://localhost:${b.getBoundPort()}`)).rejects.toThrow(/banned/i);
  });

  it("lets a banned peer back in once the ban expires", async () => {
    const a = makeServer("node-a", { banThreshold: 100, banDurationMs: 200 });
    const b = makeServer("node-b");
    await a.start();
    await b.start();
    await Promise.all([once(a, "peer:connected"), b.connect(`ws://localhost:${a.getBoundPort()}`)]);

    const disconnected = once(a, "peer:disconnected");
    a.penalize("node-b", 100, "offense");
    await disconnected;

    await settle(250);
    await Promise.all([once(a, "peer:connected"), b.connect(`ws://localhost:${a.getBoundPort()}`)]);
    expect(a.getPeerIds()).toEqual(["node-b"]);
  });

  it("drops a peer that sends a protocol message before handshaking, so unverified peers never reach the node", async () => {
    const a = makeServer("node-a");
    await a.start();
    const delivered: Message[] = [];
    a.on("message", (m: Message) => delivered.push(m));

    const sneaky = await rawClient(a);
    const closed = once(sneaky, "close");
    sneaky.send(JSON.stringify({ type: "GET_BLOCKS", payload: { fromHeight: 0 } }));
    await closed;

    expect(delivered).toEqual([]);
    expect(a.getConnectionCount()).toBe(0);
  });

  it("penalizing an unknown nodeId is a no-op", () => {
    const a = makeServer("node-a");
    expect(() => a.penalize("ghost", 100, "x")).not.toThrow();
  });

  it("advertises an explicit advertise address instead of localhost when configured", async () => {
    const a = makeServer("node-a", { advertiseAddress: "ws://203.0.113.5:8001" });
    const b = makeServer("node-b");
    await a.start();
    await b.start();
    await Promise.all([once(b, "peer:connected"), a.connect(`ws://localhost:${b.getBoundPort()}`)]);
    expect(b.getKnownPeerAddresses()).toEqual(["ws://203.0.113.5:8001"]);
  });
});
