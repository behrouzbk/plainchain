import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

/** PEM-encoded certificate + matching PKCS#8 private key. */
export interface TlsCredentials {
  cert: string;
  key: string;
}

/** A TLS/exposure setting that would leave the node unusable or unsafe. */
export class TlsConfigError extends Error {}

// ---------------------------------------------------------------------------
// Self-signed certificate generation
//
// Operators need a certificate to turn TLS on, and there's no guarantee
// `openssl` is installed (it isn't on stock Windows). Node has no X.509
// *writer*, only a parser, so a minimal DER encoder for one certificate
// shape lives here: X.509 v3, ECDSA P-256 / SHA-256, self-signed, with a
// subjectAltName listing the hosts the node is reachable at. Node's own TLS
// stack (OpenSSL) is what validates the result -- see tests/rpc/tls.test.ts.
// ---------------------------------------------------------------------------

export interface SelfSignedCertificateOptions {
  /** DNS names and/or IP addresses clients will connect with (subjectAltName). */
  hosts: string[];
  /** Subject/issuer common name. Informational; hostname checks use SAN. */
  commonName?: string;
  validDays?: number;
  /** Start of the validity window (defaults to the current time). */
  now?: Date;
}

const DER_SEQUENCE = 0x30;
const DER_SET = 0x31;
const DER_BOOLEAN = 0x01;
const DER_INTEGER = 0x02;
const DER_BIT_STRING = 0x03;
const DER_OCTET_STRING = 0x04;
const DER_OID = 0x06;
const DER_UTF8_STRING = 0x0c;
const DER_UTC_TIME = 0x17;
const DER_GENERALIZED_TIME = 0x18;
/** Context-specific, constructed [n] (EXPLICIT tagging). */
const derExplicit = (n: number): number => 0xa0 | n;
/** Context-specific, primitive [n] (IMPLICIT tagging of a primitive). */
const derImplicit = (n: number): number => 0x80 | n;

const OID_ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const OID_COMMON_NAME = "2.5.4.3";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_EXTENDED_KEY_USAGE = "2.5.29.37";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) bytes.unshift(remaining % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derOid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift(0x80 | (rest & 0x7f));
    bytes.push(...chunk);
  }
  return der(DER_OID, Buffer.from(bytes));
}

/** Unsigned big-endian magnitude -> DER INTEGER (positive: pad if the high bit is set). */
function derPositiveInteger(magnitude: Buffer): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  const trimmed = magnitude.subarray(start);
  return der(DER_INTEGER, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function derTime(date: Date): Buffer {
  const year = date.getUTCFullYear();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  // RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050 on.
  return year < 2050
    ? der(DER_UTC_TIME, Buffer.from(`${pad(year % 100)}${rest}`, "ascii"))
    : der(DER_GENERALIZED_TIME, Buffer.from(`${year}${rest}`, "ascii"));
}

function derName(commonName: string): Buffer {
  const attribute = der(DER_SEQUENCE, derOid(OID_COMMON_NAME), der(DER_UTF8_STRING, Buffer.from(commonName, "utf8")));
  return der(DER_SEQUENCE, der(DER_SET, attribute));
}

function derExtension(oid: string, critical: boolean, value: Buffer): Buffer {
  // DER forbids encoding a DEFAULT value, so `critical` appears only when true.
  const flag = critical ? [der(DER_BOOLEAN, Buffer.from([0xff]))] : [];
  return der(DER_SEQUENCE, derOid(oid), ...flag, der(DER_OCTET_STRING, value));
}

function ipToBytes(host: string): Buffer {
  if (isIP(host) === 4) return Buffer.from(host.split(".").map(Number));
  // IPv6: expand "::" then parse the 8 hextets.
  const [head, tail = ""] = host.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const hextets = [...headParts, ...Array<string>(host.includes("::") ? missing : 0).fill("0"), ...tailParts];
  const out = Buffer.alloc(16);
  hextets.forEach((h, i) => out.writeUInt16BE(parseInt(h, 16), i * 2));
  return out;
}

const DNS_NAME = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;

function derGeneralName(host: string): Buffer {
  if (isIP(host)) return der(derImplicit(7), ipToBytes(host));
  if (DNS_NAME.test(host)) return der(derImplicit(2), Buffer.from(host, "ascii"));
  throw new TlsConfigError(`"${host}" is not a valid DNS name or IP address`);
}

function pem(label: string, derBytes: Buffer): string {
  const lines = derBytes.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export function generateSelfSignedCertificate(options: SelfSignedCertificateOptions): TlsCredentials {
  if (options.hosts.length === 0) throw new TlsConfigError("at least one host is required for the certificate");
  const commonName = options.commonName ?? "plainchain rpc";
  const notBefore = new Date(options.now ?? Date.now());
  notBefore.setUTCMilliseconds(0); // X.509 times have second resolution
  const notAfter = new Date(notBefore.getTime() + (options.validDays ?? 3650) * 24 * 60 * 60 * 1000);

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signatureAlgorithm = der(DER_SEQUENCE, derOid(OID_ECDSA_WITH_SHA256));
  const name = derName(commonName);

  const extensions = der(
    DER_SEQUENCE,
    // CA:TRUE so the certificate can serve as its own trust anchor when a
    // client pins it via --ca.
    derExtension(OID_BASIC_CONSTRAINTS, true, der(DER_SEQUENCE, der(DER_BOOLEAN, Buffer.from([0xff])))),
    derExtension(OID_EXTENDED_KEY_USAGE, false, der(DER_SEQUENCE, derOid(OID_SERVER_AUTH))),
    derExtension(OID_SUBJECT_ALT_NAME, false, der(DER_SEQUENCE, ...options.hosts.map(derGeneralName))),
  );

  const tbsCertificate = der(
    DER_SEQUENCE,
    der(derExplicit(0), der(DER_INTEGER, Buffer.from([2]))), // version v3
    derPositiveInteger(randomBytes(16)), // serialNumber
    signatureAlgorithm,
    name, // issuer
    der(DER_SEQUENCE, derTime(notBefore), derTime(notAfter)), // validity
    name, // subject (self-signed: same as issuer)
    publicKey.export({ type: "spki", format: "der" }), // subjectPublicKeyInfo
    der(derExplicit(3), extensions),
  );

  // ECDSA signatures from `sign` are DER-encoded (r, s) by default, which is
  // exactly what ecdsa-with-SHA256 expects inside the BIT STRING.
  const signature = sign("sha256", tbsCertificate, privateKey);
  const certificate = der(DER_SEQUENCE, tbsCertificate, signatureAlgorithm, der(DER_BIT_STRING, Buffer.from([0]), signature));

  return {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

// ---------------------------------------------------------------------------
// Loading operator-supplied credentials
// ---------------------------------------------------------------------------

export interface TlsCredentialPaths {
  certPath: string;
  keyPath: string;
}

/**
 * Reads and sanity-checks a cert/key pair so a misconfiguration fails at
 * startup with a pointed message instead of as a handshake error on every
 * client. Anything `openssl req -x509` or `npm run gen-cert` produces works.
 */
export function loadTlsCredentials(paths: TlsCredentialPaths, now: Date = new Date()): TlsCredentials {
  const cert = readPem(paths.certPath, "certificate");
  const key = readPem(paths.keyPath, "private key");

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch (err) {
    throw new TlsConfigError(`${paths.certPath} is not a PEM certificate: ${errorMessage(err)}`);
  }
  let keyObject: KeyObject;
  try {
    keyObject = createPrivateKey(key);
  } catch (err) {
    throw new TlsConfigError(`${paths.keyPath} is not a PEM private key: ${errorMessage(err)}`);
  }
  if (!x509.checkPrivateKey(keyObject)) {
    throw new TlsConfigError(`private key ${paths.keyPath} does not match certificate ${paths.certPath}`);
  }
  if (new Date(x509.validTo).getTime() < now.getTime()) {
    throw new TlsConfigError(`certificate ${paths.certPath} expired on ${x509.validTo}`);
  }
  return { cert, key };
}

function readPem(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new TlsConfigError(`cannot read TLS ${what} ${path}: ${errorMessage(err)}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Exposure policy
// ---------------------------------------------------------------------------

/** True for names/addresses that never leave this host. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  if (bare.startsWith("::ffff:")) return isLoopbackHost(bare.slice("::ffff:".length));
  return isIP(bare) === 4 && bare.startsWith("127.");
}

export interface RpcExposure {
  bind: string;
  tls: boolean;
  allowInsecure: boolean;
}

/**
 * Cleartext RPC is fine on loopback (the devnet default). Binding beyond
 * the host without TLS would put the bearer token, and every wallet's view
 * of its balance, on the wire in the clear, so it has to be opted into.
 */
export function checkRpcExposure(exposure: RpcExposure): void {
  if (exposure.tls || exposure.allowInsecure || isLoopbackHost(exposure.bind)) return;
  throw new TlsConfigError(
    `refusing to serve cleartext RPC on ${exposure.bind}: pass --rpc-tls-cert/--rpc-tls-key (see "npm run gen-cert"), ` +
      `bind to 127.0.0.1, or pass --rpc-allow-insecure if a TLS-terminating proxy is in front of this node`,
  );
}
