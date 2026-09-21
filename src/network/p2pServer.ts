import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { Peer, type PeerDirection } from "./peer.js";
import type { Message } from "./protocol.js";
import { PeerReputation } from "./reputation.js";

const PROTOCOL_VERSION = 1;

/** WebSocket close code "Try Again Later". */
const CLOSE_TRY_AGAIN_LATER = 1013;
/** WebSocket close code "Policy Violation". */
const CLOSE_POLICY_VIOLATION = 1008;

export interface ChainIdentity {
  networkId: string;
  genesisHash: string;
  /** If set, peers must present the same value (see consensus/monetary.ts#rulesHash). */
  rulesHash?: string;
}

export interface P2PServerOptions {
  /** Inbound connection slots, counted from the moment a socket is accepted
   *  (before the handshake), so a peer can't hold slots open by staying
   *  silent -- see handshakeTimeoutMs. */
  maxInboundPeers: number;
  /** Outbound slots. Kept separate from inbound so that filling our inbound
   *  slots doesn't stop us choosing our own peers (eclipse mitigation). */
  maxOutboundPeers: number;
  /** A connection that hasn't completed its handshake by then is dropped. */
  handshakeTimeoutMs: number;
  /** Largest frame accepted; larger ones close the connection. Bounds the
   *  memory a peer can make us allocate before the message is even parsed. */
  maxMessageBytes: number;
  /** Misbehavior points at which a peer is banned. */
  banThreshold: number;
  banDurationMs: number;
  /** The reachable URL to announce in handshakes instead of
   *  `ws://localhost:<port>` (e.g. a public address behind a port-forward). */
  advertiseAddress?: string;
  /** Inbound connections accepted per remote IP; 0 = unlimited. Off by
   *  default because a single-host devnet has every peer on 127.0.0.1;
   *  set it on any deployment where peers have their own addresses. */
  maxInboundPerIp: number;
}

export const DEFAULT_P2P_OPTIONS: P2PServerOptions = {
  maxInboundPeers: 32,
  maxOutboundPeers: 8,
  handshakeTimeoutMs: 5000,
  maxMessageBytes: 4 * 1024 * 1024,
  banThreshold: 100,
  banDurationMs: 10 * 60 * 1000,
  maxInboundPerIp: 0,
};

/**
 * Transport-only gossip layer: delivers inbound peer messages via the
 * "message" event and exposes broadcast/send for outbound gossip. It does
 * NOT decide what to relay or how to react to messages -- that policy
 * (dedup, validation, mempool/chain updates) lives in the node orchestrator,
 * which is the only layer with enough context to make those calls. The
 * orchestrator reports misbehavior back via `penalize`, and this layer
 * enforces the resulting bans plus the purely transport-level limits
 * (connection slots, handshake deadline, frame size).
 *
 * Bans are keyed by the peer's self-declared nodeId and its advertised
 * listen address -- the two things this protocol knows a peer by. That
 * stops us wasting CPU on, and redialing, a peer that keeps sending bad
 * data; it is not Sybil resistance (a peer can rotate its nodeId). IP bans
 * are deliberately not used: on a single-host devnet every peer is
 * 127.0.0.1, so one bad peer would ban all of them.
 *
 * Events: "peer:connected" (nodeId, height), "peer:disconnected" (nodeId, handshaked),
 * "peer:rejected" (nodeId, reason) for handshake-level refusals,
 * "peer:banned" (nodeId, reason), "message" (message, fromNodeId), and
 * "message:sent" (message, toNodeId | undefined) for every frame we send.
 */
export class P2PServer extends EventEmitter {
  private wss: WebSocketServer | undefined;
  private readonly peers = new Map<string, Peer>();
  private readonly options: P2PServerOptions;
  private readonly reputation: PeerReputation;
  private boundPort = 0;

  /**
   * @param identity If given, peers must present the same networkId and
   * genesisHash in their handshake or they're rejected. Omit for
   * identity-agnostic transports (e.g. test injectors).
   */
  constructor(
    private readonly nodeId: string,
    private readonly requestedPort: number,
    private readonly getHeight: () => number,
    private readonly identity?: ChainIdentity,
    options: Partial<P2PServerOptions> = {},
  ) {
    super();
    this.options = { ...DEFAULT_P2P_OPTIONS, ...options };
    this.reputation = new PeerReputation({
      banThreshold: this.options.banThreshold,
      banDurationMs: this.options.banDurationMs,
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.wss = new WebSocketServer(
        { port: this.requestedPort, maxPayload: this.options.maxMessageBytes },
        () => {
          const address = this.wss!.address() as AddressInfo;
          this.boundPort = address.port;
          resolve();
        },
      );
      this.wss.on("connection", (socket, request) => {
        const ip = normalizeIp(request.socket.remoteAddress);
        if (this.countPeers("inbound") >= this.options.maxInboundPeers) {
          socket.close(CLOSE_TRY_AGAIN_LATER, "too many inbound peers");
          this.emit("peer:rejected", ip, "too many inbound peers");
          return;
        }
        if (this.options.maxInboundPerIp > 0 && this.countInboundFrom(ip) >= this.options.maxInboundPerIp) {
          socket.close(CLOSE_TRY_AGAIN_LATER, "too many connections from this address");
          this.emit("peer:rejected", ip, `too many connections from this address (limit ${this.options.maxInboundPerIp} per address)`);
          return;
        }
        const peer = this.registerPeer(socket, "inbound");
        peer.remoteIp = ip;
        this.announceHandshake(peer);
      });
    });
  }

  getBoundPort(): number {
    return this.boundPort;
  }

  /** This node's own reachable P2P URL, or undefined before start() has bound a port. */
  getListenAddress(): string | undefined {
    if (this.options.advertiseAddress) return this.options.advertiseAddress;
    return this.boundPort > 0 ? `ws://localhost:${this.boundPort}` : undefined;
  }

  async connect(url: string): Promise<void> {
    if (this.reputation.isBanned(url)) {
      throw new Error(`refusing to dial ${url}: banned`);
    }
    if (this.countPeers("outbound") >= this.options.maxOutboundPeers) {
      throw new Error(`refusing to dial ${url}: outbound peer limit (${this.options.maxOutboundPeers}) reached`);
    }

    const socket = new WebSocket(url, { maxPayload: this.options.maxMessageBytes });
    // Attach listeners synchronously, before awaiting "open": the peer on
    // the other end may reply with its own HANDSHAKE in the same event-loop
    // turn our "open" fires, so a listener attached only after awaiting
    // "open" can lose that first message to a race.
    const peer = this.registerPeer(socket, "outbound");

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        // Send our HANDSHAKE inside the "open" listener, not after awaiting
        // it: the remote's HANDSHAKE can be delivered between "open" firing
        // and this promise's continuation running, and the node reacts to
        // "peer:connected" by sending requests -- which would then reach
        // the remote before our HANDSHAKE and be dropped as pre-handshake.
        this.announceHandshake(peer);
        resolve();
      });
      socket.once("error", reject);
    });
  }

  /** Registered inbound sockets (handshaked or not) from one address. */
  private countInboundFrom(ip: string): number {
    let n = 0;
    for (const peer of this.peers.values()) {
      if (peer.direction === "inbound" && peer.remoteIp === ip) n++;
    }
    return n;
  }

  private countPeers(direction: PeerDirection): number {
    let n = 0;
    for (const peer of this.peers.values()) {
      if (peer.direction === direction) n++;
    }
    return n;
  }

  /** All registered sockets, whether or not they've completed a handshake. */
  getConnectionCount(): number {
    return this.peers.size;
  }

  /** Outbound dials still allowed (registered sockets count, handshaked or not). */
  outboundRoom(): number {
    return Math.max(0, this.options.maxOutboundPeers - this.countPeers("outbound"));
  }

  /** Handshaked peers by direction. */
  getPeerCounts(): { inbound: number; outbound: number } {
    const counts = { inbound: 0, outbound: 0 };
    for (const peer of this.peers.values()) {
      if (peer.remoteNodeId !== undefined) counts[peer.direction]++;
    }
    return counts;
  }

  private deliver(peer: Peer, message: Message): void {
    peer.send(message);
    this.emit("message:sent", message, peer.remoteNodeId);
  }

  private registerPeer(socket: WebSocket, direction: PeerDirection): Peer {
    const peer = new Peer(randomUUID(), socket, direction);
    this.peers.set(peer.id, peer);

    const drop = (reason: string): void => {
      this.forget(peer);
      peer.close(CLOSE_POLICY_VIOLATION, reason);
      this.emit("peer:rejected", peer.remoteNodeId ?? peer.id, reason);
    };

    peer.handshakeTimer = setTimeout(() => drop("handshake timeout"), this.options.handshakeTimeoutMs);
    peer.handshakeTimer.unref();

    peer.onMessage(
      (message) => {
        if (message.type === "HANDSHAKE") {
          const { nodeId: remoteNodeId, networkId, genesisHash, rulesHash } = message.payload;

          if (remoteNodeId === this.nodeId) {
            // Connected to ourselves (e.g. stale/self-reported discovery data).
            this.forget(peer);
            peer.close();
            return;
          }

          if (
            this.identity &&
            (networkId !== this.identity.networkId || genesisHash !== this.identity.genesisHash)
          ) {
            peer.remoteNodeId = remoteNodeId;
            drop(`network identity mismatch: peer is on ${networkId ?? "(none)"}/${genesisHash ?? "(none)"}`);
            return;
          }
          if (this.identity?.rulesHash !== undefined && rulesHash !== this.identity.rulesHash) {
            // Same genesis but different consensus/emission rules: the peer
            // would reject our blocks (or we theirs) at some height, so the
            // networks are incompatible even though they share history.
            peer.remoteNodeId = remoteNodeId;
            drop(`consensus rules mismatch: peer rules ${rulesHash ?? "(none)"}`);
            return;
          }

          if (this.reputation.isBanned(remoteNodeId)) {
            peer.remoteNodeId = remoteNodeId;
            drop("banned");
            return;
          }

          const existing = [...this.peers.values()].find((p) => p.remoteNodeId === remoteNodeId);
          if (existing) {
            // Redundant connection to a peer we already have a link to (can
            // happen from a simultaneous-dial race, or peer-discovery
            // re-suggesting an address we're already connected to). Keep the
            // existing link, drop this one.
            this.forget(peer);
            peer.close();
            return;
          }

          clearTimeout(peer.handshakeTimer);
          peer.handshakeTimer = undefined;
          peer.remoteNodeId = remoteNodeId;
          peer.remoteHeight = message.payload.height;
          peer.remoteListenAddress = message.payload.listenAddress;
          this.emit("peer:connected", peer.remoteNodeId, peer.remoteHeight);
          return;
        }
        if (peer.remoteNodeId === undefined) {
          // Talking before handshaking: nothing about this peer is verified
          // yet (identity, network), so don't let it reach the node.
          drop("message before handshake");
          return;
        }
        this.emit("message", message, peer.remoteNodeId);
      },
      (error) => drop(`malformed message: ${error.message}`),
    );

    peer.onClose(() => {
      this.forget(peer);
      // `handshaked` lets listeners ignore sockets that never became peers
      // (failed dials, rejected handshakes).
      this.emit("peer:disconnected", peer.remoteNodeId ?? peer.id, peer.remoteNodeId !== undefined);
    });

    return peer;
  }

  private forget(peer: Peer): void {
    clearTimeout(peer.handshakeTimer);
    peer.handshakeTimer = undefined;
    this.peers.delete(peer.id);
  }

  /**
   * Records misbehavior by a connected peer. Crossing the ban threshold
   * disconnects it, refuses it on reconnect (by nodeId), and refuses to dial
   * its advertised address, until the ban expires. Unknown nodeIds are
   * ignored: we can only judge peers we're actually talking to.
   */
  penalize(nodeId: string, points: number, reason: string): void {
    const peer = [...this.peers.values()].find((p) => p.remoteNodeId === nodeId);
    if (!peer) return;
    if (!this.reputation.penalize(nodeId, points)) return;

    if (peer.remoteListenAddress) {
      this.reputation.ban(peer.remoteListenAddress);
    }
    this.emit("peer:banned", nodeId, reason);
    peer.close(CLOSE_POLICY_VIOLATION, "banned");
  }

  private announceHandshake(peer: Peer): void {
    this.deliver(peer, {
      type: "HANDSHAKE",
      payload: {
        version: PROTOCOL_VERSION,
        nodeId: this.nodeId,
        height: this.getHeight(),
        listenAddress: this.getListenAddress(),
        networkId: this.identity?.networkId,
        genesisHash: this.identity?.genesisHash,
        rulesHash: this.identity?.rulesHash,
      },
    });
  }

  broadcast(message: Message, excludeNodeId?: string): void {
    for (const peer of this.peers.values()) {
      if (peer.remoteNodeId === undefined) continue; // not handshaked yet
      if (peer.remoteNodeId === excludeNodeId) continue;
      this.deliver(peer, message);
    }
  }

  send(nodeId: string, message: Message): void {
    for (const peer of this.peers.values()) {
      if (peer.remoteNodeId === nodeId) {
        this.deliver(peer, message);
        return;
      }
    }
  }

  getPeerIds(): string[] {
    return [...this.peers.values()]
      .map((p) => p.remoteNodeId)
      .filter((id): id is string => id !== undefined);
  }

  /** Listen addresses reported by currently connected peers, optionally
   *  excluding one nodeId (e.g. so a peer isn't told about its own address). */
  getKnownPeerAddresses(excludeNodeId?: string): string[] {
    return [...this.peers.values()]
      .filter((p) => p.remoteNodeId !== undefined && p.remoteNodeId !== excludeNodeId)
      .map((p) => p.remoteListenAddress)
      .filter((address): address is string => address !== undefined);
  }

  async stop(): Promise<void> {
    for (const peer of this.peers.values()) {
      clearTimeout(peer.handshakeTimer);
      peer.close();
    }
    this.peers.clear();

    const wss = this.wss;
    this.wss = undefined; // makes stop() idempotent
    await new Promise<void>((resolve, reject) => {
      if (!wss) {
        resolve();
        return;
      }
      wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

/** `::ffff:10.0.0.5` and `10.0.0.5` are the same peer. */
function normalizeIp(address: string | undefined): string {
  if (!address) return "unknown";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}
