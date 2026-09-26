import { parseArgs } from "../config/args.js";
import { genesisConfigFrom, loadConfig, monetaryPolicyFrom, packageVersion } from "../config/index.js";
import { generateKeyPair } from "../crypto/keypair.js";
import { deriveAddress, encodeAddress } from "../ledger/address.js";
import { resolveRpcToken } from "../rpc/auth.js";
import { createRpcServer, listenRpc } from "../rpc/server.js";
import { checkRpcExposure, loadTlsCredentials, TlsConfigError } from "../rpc/tls.js";
import { createLogger } from "./logger.js";
import { Node } from "./node.js";
import { resolveNodeSettings, SettingsError } from "./settings.js";
import { readSignerKey } from "./signerKey.js";

async function main(): Promise<void> {
  // Every setting is `--flag`, else `L1_FLAG` env var, else default (see
  // settings.ts); docker-compose.yml configures nodes purely through env.
  const { flags } = parseArgs(process.argv.slice(2));
  // --config / L1_CONFIG is resolved by hand: the other settings need the
  // config's defaults, so it cannot go through resolveNodeSettings.
  const config = loadConfig(flags.config ?? (process.env.L1_CONFIG || undefined));
  const settings = resolveNodeSettings(flags, process.env, { defaultPort: config.network.defaultPort, rpcBind: config.rpc.bind });
  const { nodeId, port, rpcPort, dataDir, peers, rpcBind } = settings;

  const log = createLogger({ format: settings.logFormat, level: settings.logLevel, nodeId });

  // TLS credentials are loaded before anything else starts so a bad path
  // fails fast; cleartext is only allowed on loopback unless
  // --rpc-allow-insecure says a TLS-terminating proxy (or a port mapping
  // to the host's loopback, as in docker-compose.yml) is in front.
  const rpcTls = settings.rpcTls ? loadTlsCredentials(settings.rpcTls) : undefined;
  checkRpcExposure({ bind: rpcBind, tls: rpcTls !== undefined, allowInsecure: settings.rpcAllowInsecure });

  // Without --miner-address, rewards go to a throwaway key generated here
  // -- fine for a relay node, useless for a miner.
  const minerAddress = settings.minerAddress ?? deriveAddress(generateKeyPair().publicKey);

  // Proof of authority: the signer key makes this node a block producer;
  // a key outside the configured set is refused by the Node constructor.
  const signerKey = settings.signerKeyPath !== undefined ? readSignerKey(settings.signerKeyPath) : undefined;
  if (signerKey && config.consensus.mode !== "poa") {
    throw new Error("--signer-key is only meaningful with consensus.mode \"poa\" (this config runs proof of work)");
  }

  // Record anchoring paid by this node (anchorRecord): a hot key the
  // operator funds; any Ed25519 key file in the gen-authority format.
  const anchorKey = settings.anchorKeyPath !== undefined ? readSignerKey(settings.anchorKeyPath) : undefined;

  const node = new Node({
    nodeId,
    networkId: config.networkId,
    dataDir,
    port,
    genesis: genesisConfigFrom(config),
    consensus: config.consensus,
    mempool: { maxSize: config.mempool.maxSize, minFee: BigInt(config.mempool.minFee), maxReplacements: config.mempool.maxReplacements },
    minerAddress,
    blockReward: BigInt(config.monetary.initialReward),
    monetary: monetaryPolicyFrom(config),
    logger: log,
    network: {
      maxInboundPeers: config.network.maxInboundPeers,
      maxOutboundPeers: config.network.maxOutboundPeers,
      handshakeTimeoutMs: config.network.handshakeTimeoutMs,
      maxMessageBytes: config.network.maxMessageBytes,
      banThreshold: config.network.banThreshold,
      banDurationMs: config.network.banDurationMs,
      maxBlocksPerResponse: config.network.maxBlocksPerResponse,
      maxHeadersPerResponse: config.network.maxHeadersPerResponse,
      peerMaintenanceIntervalMs: config.network.peerMaintenanceIntervalMs,
      maxDialsPerTick: config.network.maxDialsPerTick,
      maxAddressBookSize: config.network.maxAddressBookSize,
      peerDialBackoffMs: config.network.peerDialBackoffMs,
      maxInboundPerIp: settings.maxInboundPerIp ?? config.network.maxInboundPerIp,
      // --advertise-url: the URL other nodes should dial to reach this one
      // (e.g. behind a port-forward). Defaults to ws://localhost:<port>.
      advertiseAddress: settings.advertiseUrl,
    },
    addressIndex: {
      enabled: !settings.noAddrIndex && config.index.addressIndex,
      depth: settings.addrIndexDepth ?? config.index.addressIndexDepth,
    },
    signerKey,
    anchorKey,
  });

  await node.start();
  log.info("node started", { version: packageVersion(), networkId: config.networkId, dataDir, height: (await node.getTip())?.height ?? 0 });
  log.info(`p2p listening on ws://localhost:${node.getBoundPort()}`, { port: node.getBoundPort() });
  if (config.consensus.mode === "poa") {
    log.info(
      signerKey
        ? `proof of authority: this node signs blocks as authority ${config.consensus.authorities.indexOf(signerKey.publicKey)} of ${config.consensus.authorities.length}`
        : `proof of authority: validating only (no --signer-key); ${config.consensus.authorities.length} authorities configured`,
      { mode: "poa", authorities: config.consensus.authorities.length, signer: signerKey?.publicKey },
    );
  }
  if (anchorKey) {
    const anchorAddress = deriveAddress(anchorKey.publicKey);
    log.info(`anchoring: anchorRecord fees are paid from ${encodeAddress(anchorAddress)}`, { anchorAddress });
  }
  log.info(`mining rewards go to ${minerAddress}`, {
    minerAddress,
    ...(settings.minerAddress ? {} : { note: "throwaway key: pass --miner-address to keep rewards" }),
  });

  for (const peerUrl of peers) {
    try {
      await node.connectToPeer(peerUrl);
      log.info(`connected to peer ${peerUrl}`, { peer: peerUrl });
    } catch (err) {
      // Unreachable, banned, or over the outbound limit: keep going with
      // the peers we can reach rather than refusing to start.
      log.warn(`could not connect to peer ${peerUrl}: ${err instanceof Error ? err.message : String(err)}`, { peer: peerUrl });
    }
  }

  // --rpc-token / L1_RPC_TOKEN sets the bearer token explicitly; otherwise
  // one is generated and written to <dataDir>/rpc-token (cookie auth).
  const rpcToken = resolveRpcToken({ explicitToken: settings.rpcToken, dataDir });
  const rpcApp = createRpcServer(node, {
    authToken: rpcToken.token,
    rateLimit: config.rpc.rateLimit,
    trustProxy: settings.rpcTrustProxy ?? config.rpc.trustProxy,
  });
  const rpc = await listenRpc(rpcApp, { port: rpcPort, bind: rpcBind, tls: rpcTls });
  log.info(`rpc listening on ${rpc.url}${rpcTls ? " (TLS)" : ""}`, { url: rpc.url, tls: rpcTls !== undefined });
  log.info(
    rpcToken.source === "cookie"
      ? `rpc auth token written to ${rpcToken.cookiePath} (protected methods need "Authorization: Bearer <token>")`
      : "rpc auth token provided explicitly",
    { tokenSource: rpcToken.source },
  );
  log.info(`operator endpoints: ${rpc.url}/health and ${rpc.url}/metrics`);

  const shutdown = async (): Promise<void> => {
    log.info("shutting down");
    await rpc.close();
    await node.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  // Configuration mistakes get one line, not a stack trace.
  console.error(err instanceof TlsConfigError || err instanceof SettingsError ? `error: ${err.message}` : err);
  process.exit(1);
});
