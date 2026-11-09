/**
 * Bearer-token authentication: HS256 JWTs (primary) and a static token table (demo/secondary).
 *
 * The caller's role is only ever taken from a credential the gateway can verify, never from a
 * plain request header, because any client can set any header it likes. JWTs are verified with
 * `node:crypto` alone: the header must say `alg: "HS256"` (so `none` and algorithm-confusion
 * tricks are rejected before any signature work), the signature is recomputed with HMAC-SHA256
 * and compared with `timingSafeEqual`, `exp` is required and checked, `nbf` is checked when
 * present, and the `role` claim must be one of the known roles. Static tokens are stored as
 * SHA-256 digests so the lookup does not compare secrets byte by byte. Tokens are never logged;
 * failures carry only a coarse reason code.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ROLES = ["admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export interface Principal {
  role: Role;
  subject: string;
  method: "jwt" | "static";
}

export type AuthFailureReason =
  | "missing_token"
  | "malformed_token"
  | "unsupported_alg"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "invalid_claims"
  | "unknown_token";

export interface AuthSuccess extends Principal {
  ok: true;
}

export interface AuthError {
  ok: false;
  reason: AuthFailureReason;
}

export type AuthResult = AuthSuccess | AuthError;

export interface StaticTokenEntry {
  role: Role;
  subject: string;
}

/** Static tokens keyed by the SHA-256 hex digest of the token. */
export type StaticTokenTable = ReadonlyMap<string, StaticTokenEntry>;

export interface AuthOptions {
  jwtSecret?: string;
  staticTokens?: StaticTokenTable;
  /** Clock in milliseconds since the epoch; injectable for deterministic tests. */
  now?: () => number;
  /** Allowed clock skew for `exp`/`nbf`, in seconds. Default 0. */
  clockToleranceSec?: number;
}

export type Authenticator = (authorizationHeader: string | undefined) => AuthResult;

// RFC 6750 b64token syntax.
const BEARER_RE = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(reason: AuthFailureReason): AuthError {
  return { ok: false, reason };
}

/** Extracts the token from an `Authorization: Bearer <token>` header, or null. */
export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = BEARER_RE.exec(header);
  return match?.[1] ?? null;
}

/**
 * Parses `STATIC_TOKENS` (`token1:admin,token2:viewer`). Throws on any malformed entry so a
 * typo in configuration fails at startup instead of silently granting or denying access.
 */
export function parseStaticTokens(spec: string): Map<string, StaticTokenEntry> {
  const table = new Map<string, StaticTokenEntry>();
  const entries = spec.split(",").map((e) => e.trim()).filter((e) => e.length > 0);
  entries.forEach((entry, index) => {
    const sep = entry.lastIndexOf(":");
    const token = sep > 0 ? entry.slice(0, sep) : "";
    const role = sep > 0 ? entry.slice(sep + 1) : "";
    if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
      throw new Error(`STATIC_TOKENS entry ${index + 1} has an empty or invalid token`);
    }
    if (!isRole(role)) {
      throw new Error(`STATIC_TOKENS entry ${index + 1} has unknown role (expected ${ROLES.join(" or ")})`);
    }
    table.set(sha256Hex(token), { role, subject: `static-token-${index + 1}` });
  });
  return table;
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  if (!B64URL_RE.test(segment)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Verifies an HS256 JWT and maps its claims to a Principal. */
export function verifyJwt(token: string, secret: string, nowMs: number, clockToleranceSec = 0): AuthResult {
  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed_token");
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];

  const header = decodeJsonSegment(headerSeg);
  if (header === null) return fail("malformed_token");
  // Checked before anything else: rejects `none`, RS256/HS256 confusion, and unknown algorithms.
  if (header.alg !== "HS256") return fail("unsupported_alg");
  if (Object.hasOwn(header, "crit")) return fail("unsupported_alg");

  if (!B64URL_RE.test(signatureSeg)) return fail("bad_signature");
  const provided = Buffer.from(signatureSeg, "base64url");
  const expected = createHmac("sha256", secret).update(`${headerSeg}.${payloadSeg}`).digest();
  // Reject non-canonical encodings too, so one signature has exactly one accepted spelling.
  if (provided.length !== expected.length || provided.toString("base64url") !== signatureSeg) {
    return fail("bad_signature");
  }
  if (!timingSafeEqual(provided, expected)) return fail("bad_signature");

  const claims = decodeJsonSegment(payloadSeg);
  if (claims === null) return fail("malformed_token");

  const nowSec = nowMs / 1000;
  // Fail closed: a token without an expiry is not accepted.
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return fail("invalid_claims");
  if (nowSec >= claims.exp + clockToleranceSec) return fail("expired");
  if (Object.hasOwn(claims, "nbf")) {
    if (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf)) return fail("invalid_claims");
    if (nowSec + clockToleranceSec < claims.nbf) return fail("not_yet_valid");
  }
  if (!isRole(claims.role)) return fail("invalid_claims");
  if (Object.hasOwn(claims, "sub") && typeof claims.sub !== "string") return fail("invalid_claims");

  const subject = typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : "unknown";
  return { ok: true, role: claims.role, subject, method: "jwt" };
}

/** Builds the `authenticate(authorizationHeader)` function used by the gateway. */
export function createAuthenticator(options: AuthOptions): Authenticator {
  const now = options.now ?? Date.now;
  const tolerance = options.clockToleranceSec ?? 0;
  const { jwtSecret, staticTokens } = options;

  return (authorizationHeader) => {
    const token = extractBearerToken(authorizationHeader);
    if (token === null) {
      return fail(authorizationHeader === undefined || authorizationHeader.trim() === "" ? "missing_token" : "malformed_token");
    }
    const staticEntry = staticTokens?.get(sha256Hex(token));
    if (staticEntry !== undefined) {
      return { ok: true, role: staticEntry.role, subject: staticEntry.subject, method: "static" };
    }
    if (jwtSecret !== undefined) return verifyJwt(token, jwtSecret, now(), tolerance);
    return fail("unknown_token");
  };
}

export interface TokenClaims {
  role: Role;
  sub?: string;
  /** Lifetime in seconds from `now`. Default 3600. */
  ttlSec?: number;
  /** Optional not-before, in seconds since the epoch. */
  nbf?: number;
  /** Extra claims (tests use this to build edge cases). */
  extra?: Record<string, unknown>;
}

/** Signs an HS256 JWT. Used by tests and by the `--mint-token` CLI. */
export function signToken(claims: TokenClaims, secret: string, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: Record<string, unknown> = {
    sub: claims.sub ?? `demo-${claims.role}`,
    role: claims.role,
    iat,
    exp: iat + (claims.ttlSec ?? 3600),
    ...(claims.nbf !== undefined ? { nbf: claims.nbf } : {}),
    ...claims.extra,
  };
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}
