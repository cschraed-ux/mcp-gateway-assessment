import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAuthenticator, extractBearerToken, parseStaticTokens, signToken, verifyJwt } from "../src/auth.js";

const SECRET = "test-secret-0123456789abcdef";
const NOW = 1_800_000_000_000; // fixed clock, ms
const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const sign = (input: string, secret = SECRET) => createHmac("sha256", secret).update(input).digest("base64url");

describe("extractBearerToken", () => {
  it("accepts the Bearer scheme case-insensitively and rejects other schemes", () => {
    expect(extractBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer a b")).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });
});

describe("verifyJwt", () => {
  it("accepts a valid HS256 token and returns role and subject", () => {
    const token = signToken({ role: "admin", sub: "alice" }, SECRET, NOW);
    expect(verifyJwt(token, SECRET, NOW)).toEqual({ ok: true, role: "admin", subject: "alice", method: "jwt" });
  });

  it("rejects a token signed with another secret", () => {
    const token = signToken({ role: "admin" }, "another-secret-0123456789", NOW);
    expect(verifyJwt(token, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token whose payload was edited after signing", () => {
    const token = signToken({ role: "viewer" }, SECRET, NOW);
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64({ role: "admin", exp: NOW / 1000 + 60 })}.${s}`;
    expect(verifyJwt(forged, SECRET, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects alg none, even with an empty signature", () => {
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ role: "admin", exp: NOW / 1000 + 60 })}.`;
    expect(verifyJwt(unsigned, SECRET, NOW)).toEqual({ ok: false, reason: "unsupported_alg" });
  });

  it("rejects other algorithms such as HS512 and RS256", () => {
    for (const alg of ["HS512", "RS256", "hs256"]) {
      const input = `${b64({ alg })}.${b64({ role: "admin", exp: NOW / 1000 + 60 })}`;
      expect(verifyJwt(`${input}.${sign(input)}`, SECRET, NOW).ok).toBe(false);
    }
  });

  it("rejects expired tokens and honours clock tolerance", () => {
    const token = signToken({ role: "viewer", ttlSec: 60 }, SECRET, NOW);
    expect(verifyJwt(token, SECRET, NOW + 59_000).ok).toBe(true);
    expect(verifyJwt(token, SECRET, NOW + 60_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyJwt(token, SECRET, NOW + 60_000, 30).ok).toBe(true);
  });

  it("rejects tokens before nbf", () => {
    const token = signToken({ role: "viewer", nbf: NOW / 1000 + 100 }, SECRET, NOW);
    expect(verifyJwt(token, SECRET, NOW)).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(verifyJwt(token, SECRET, NOW + 100_000).ok).toBe(true);
  });

  it("rejects tokens without exp, with unknown roles or with a non-string sub", () => {
    const cases = [
      { role: "admin" },
      { role: "superuser", exp: NOW / 1000 + 60 },
      { exp: NOW / 1000 + 60 },
      { role: "admin", exp: NOW / 1000 + 60, sub: 42 },
    ];
    for (const payload of cases) {
      const input = `${b64({ alg: "HS256" })}.${b64(payload)}`;
      expect(verifyJwt(`${input}.${sign(input)}`, SECRET, NOW)).toEqual({ ok: false, reason: "invalid_claims" });
    }
  });

  it("rejects malformed tokens", () => {
    for (const token of ["abc", "a.b", "a.b.c.d", "!!.??.**", `${b64("str")}.${b64({})}.sig`]) {
      expect(verifyJwt(token, SECRET, NOW).ok).toBe(false);
    }
  });
});

describe("parseStaticTokens", () => {
  it("parses token:role pairs", () => {
    const table = parseStaticTokens("tok-a:admin, tok-b:viewer");
    expect(table.size).toBe(2);
  });

  it("throws on unknown roles or empty tokens", () => {
    expect(() => parseStaticTokens("tok:root")).toThrow(/unknown role/);
    expect(() => parseStaticTokens(":admin")).toThrow(/invalid token/);
    expect(() => parseStaticTokens("noseparator")).toThrow();
  });
});

describe("createAuthenticator", () => {
  const authenticate = createAuthenticator({
    jwtSecret: SECRET,
    staticTokens: parseStaticTokens("demo-admin-token:admin,demo-viewer-token:viewer"),
    now: () => NOW,
  });

  it("reports a missing header distinctly from a malformed one", () => {
    expect(authenticate(undefined)).toEqual({ ok: false, reason: "missing_token" });
    expect(authenticate("")).toEqual({ ok: false, reason: "missing_token" });
    expect(authenticate("Token abc")).toEqual({ ok: false, reason: "malformed_token" });
  });

  it("accepts static tokens", () => {
    expect(authenticate("Bearer demo-viewer-token")).toEqual({
      ok: true,
      role: "viewer",
      subject: "static-token-2",
      method: "static",
    });
  });

  it("accepts JWTs", () => {
    const result = authenticate(`Bearer ${signToken({ role: "viewer", sub: "bob" }, SECRET, NOW)}`);
    expect(result).toMatchObject({ ok: true, role: "viewer", subject: "bob" });
  });

  it("rejects unknown opaque tokens when only static tokens are configured", () => {
    const staticOnly = createAuthenticator({ staticTokens: parseStaticTokens("x:admin") });
    expect(staticOnly("Bearer y")).toEqual({ ok: false, reason: "unknown_token" });
  });
});
