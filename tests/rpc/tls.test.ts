import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkRpcExposure,
  generateSelfSignedCertificate,
  isLoopbackHost,
  loadTlsCredentials,
  TlsConfigError,
} from "../../src/rpc/tls.js";

describe("generateSelfSignedCertificate", () => {
  it("produces a PEM certificate + key that Node's X.509 parser accepts and that match each other", () => {
    const { cert, key } = generateSelfSignedCertificate({ hosts: ["localhost", "127.0.0.1"] });
    expect(cert).toMatch(/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n$/);
    expect(key).toMatch(/^-----BEGIN PRIVATE KEY-----/);

    const x509 = new X509Certificate(cert);
    expect(x509.checkPrivateKey(createPrivateKey(key))).toBe(true);
    // Self-signed: the certificate's own public key verifies its signature.
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.issuer).toBe(x509.subject);
  });

  it("puts every requested host into subjectAltName as DNS or IP entries", () => {
    const { cert } = generateSelfSignedCertificate({ hosts: ["localhost", "node1.example", "127.0.0.1", "::1", "10.0.0.5"] });
    const x509 = new X509Certificate(cert);
    expect(x509.subjectAltName).toBe("DNS:localhost, DNS:node1.example, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, IP Address:10.0.0.5");
    expect(x509.checkHost("localhost")).toBe("localhost");
    expect(x509.checkHost("node1.example")).toBe("node1.example");
    expect(x509.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(x509.checkIP("::1")).toBe("::1");
    expect(x509.checkIP("10.0.0.5")).toBe("10.0.0.5");
    // A host that wasn't requested must not verify -- that's the whole point of SAN.
    expect(x509.checkHost("evil.example")).toBeUndefined();
    expect(x509.checkIP("10.0.0.6")).toBeUndefined();
  });

  it("honours commonName and validity window", () => {
    const now = new Date("2026-09-20T12:00:00Z");
    const { cert } = generateSelfSignedCertificate({ hosts: ["localhost"], commonName: "my-node", validDays: 30, now });
    const x509 = new X509Certificate(cert);
    expect(x509.subject).toBe("CN=my-node");
    expect(new Date(x509.validFrom).getTime()).toBe(now.getTime());
    expect(new Date(x509.validTo).getTime()).toBe(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(x509.ca).toBe(true);
  });

  it("encodes dates beyond 2049 as GeneralizedTime (UTCTime can't represent them)", () => {
    const now = new Date("2049-12-31T00:00:00Z");
    const { cert } = generateSelfSignedCertificate({ hosts: ["localhost"], validDays: 400, now });
    const x509 = new X509Certificate(cert);
    expect(new Date(x509.validFrom).getTime()).toBe(now.getTime());
    expect(new Date(x509.validTo).getTime()).toBe(now.getTime() + 400 * 24 * 60 * 60 * 1000);
  });

  it("generates a fresh key and serial each time", () => {
    const a = generateSelfSignedCertificate({ hosts: ["localhost"] });
    const b = generateSelfSignedCertificate({ hosts: ["localhost"] });
    expect(a.key).not.toBe(b.key);
    expect(new X509Certificate(a.cert).serialNumber).not.toBe(new X509Certificate(b.cert).serialNumber);
  });

  it("rejects an empty host list and non-hostname garbage", () => {
    expect(() => generateSelfSignedCertificate({ hosts: [] })).toThrow(/at least one host/i);
    expect(() => generateSelfSignedCertificate({ hosts: ["not a host name"] })).toThrow(/not a valid DNS name or IP/i);
  });
});

describe("loadTlsCredentials", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l1-node-tls-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it("loads a matching cert/key pair", () => {
    const generated = generateSelfSignedCertificate({ hosts: ["localhost"] });
    const creds = loadTlsCredentials({ certPath: write("cert.pem", generated.cert), keyPath: write("key.pem", generated.key) });
    expect(creds.cert).toBe(generated.cert);
    expect(creds.key).toBe(generated.key);
  });

  it("names the missing file", () => {
    const generated = generateSelfSignedCertificate({ hosts: ["localhost"] });
    const keyPath = write("key.pem", generated.key);
    expect(() => loadTlsCredentials({ certPath: join(dir, "nope.pem"), keyPath })).toThrow(TlsConfigError);
    expect(() => loadTlsCredentials({ certPath: join(dir, "nope.pem"), keyPath })).toThrow(/nope\.pem/);
  });

  it("rejects a key that does not belong to the certificate (a swapped key file would fail every handshake)", () => {
    const a = generateSelfSignedCertificate({ hosts: ["localhost"] });
    const b = generateSelfSignedCertificate({ hosts: ["localhost"] });
    expect(() => loadTlsCredentials({ certPath: write("cert.pem", a.cert), keyPath: write("key.pem", b.key) })).toThrow(
      /does not match/i,
    );
  });

  it("rejects unparsable PEM", () => {
    const a = generateSelfSignedCertificate({ hosts: ["localhost"] });
    expect(() => loadTlsCredentials({ certPath: write("cert.pem", "garbage"), keyPath: write("key.pem", a.key) })).toThrow(
      /certificate/i,
    );
    expect(() => loadTlsCredentials({ certPath: write("cert.pem", a.cert), keyPath: write("key.pem", "garbage") })).toThrow(
      /private key/i,
    );
  });

  it("rejects an expired certificate up front rather than letting every client fail", () => {
    const expired = generateSelfSignedCertificate({ hosts: ["localhost"], validDays: 1, now: new Date("2020-01-01T00:00:00Z") });
    expect(() => loadTlsCredentials({ certPath: write("cert.pem", expired.cert), keyPath: write("key.pem", expired.key) })).toThrow(
      /expired/i,
    );
  });
});

describe("isLoopbackHost", () => {
  it("recognises loopback names and addresses", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("treats everything else as remote", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.com", "localhost.evil.com", ""]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("checkRpcExposure", () => {
  it("allows cleartext on loopback", () => {
    expect(() => checkRpcExposure({ bind: "127.0.0.1", tls: false, allowInsecure: false })).not.toThrow();
  });

  it("allows any bind when TLS is on", () => {
    expect(() => checkRpcExposure({ bind: "0.0.0.0", tls: true, allowInsecure: false })).not.toThrow();
  });

  it("refuses to expose cleartext RPC (and its bearer token) beyond the host unless explicitly overridden", () => {
    expect(() => checkRpcExposure({ bind: "0.0.0.0", tls: false, allowInsecure: false })).toThrow(TlsConfigError);
    expect(() => checkRpcExposure({ bind: "192.168.1.10", tls: false, allowInsecure: false })).toThrow(/--rpc-allow-insecure/);
    expect(() => checkRpcExposure({ bind: "0.0.0.0", tls: false, allowInsecure: true })).not.toThrow();
  });
});
