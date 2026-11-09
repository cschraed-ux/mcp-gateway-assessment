import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const SECRET = "config-test-secret-0123456789";

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    const config = loadConfig({ JWT_SECRET: SECRET });
    expect(config).toMatchObject({
      port: 8080,
      host: "127.0.0.1",
      path: "/mcp",
      downstreamUrl: "http://127.0.0.1:8081/mcp",
      upstreamTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 10_000,
      maxBodyBytes: 1024 * 1024,
      corsAllowedOrigins: [],
    });
    expect(config.downstreamAuthHeader).toBeUndefined();
  });

  it("requires JWT_SECRET or STATIC_TOKENS", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(loadConfig({ STATIC_TOKENS: "a:admin" }).staticTokens?.size).toBe(1);
  });

  it("rejects short secrets, bad numbers, bad URLs and bad token tables without echoing secrets", () => {
    expect(() => loadConfig({ JWT_SECRET: "short" })).toThrow(/at least 16/);
    expect(() => loadConfig({ JWT_SECRET: SECRET, PORT: "http" })).toThrow(/PORT/);
    expect(() => loadConfig({ JWT_SECRET: SECRET, UPSTREAM_TIMEOUT_MS: "0" })).toThrow(/UPSTREAM_TIMEOUT_MS/);
    expect(() => loadConfig({ JWT_SECRET: SECRET, DOWNSTREAM_URL: "ftp://x" })).toThrow(/DOWNSTREAM_URL/);
    expect(() => loadConfig({ JWT_SECRET: SECRET, HEADERS_TIMEOUT_MS: "40000" })).toThrow(/HEADERS_TIMEOUT_MS/);
    expect(() => loadConfig({ STATIC_TOKENS: "supersecret:root" })).toThrow(/unknown role/);
    try {
      loadConfig({ STATIC_TOKENS: "supersecret:root" });
    } catch (err) {
      expect(String(err)).not.toContain("supersecret");
    }
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      JWT_SECRET: SECRET,
      PORT: "9090",
      DOWNSTREAM_URL: "https://mcp.internal/mcp",
      MAX_BODY_BYTES: "2048",
      DOWNSTREAM_AUTH_HEADER: "Bearer svc",
      CORS_ALLOWED_ORIGINS: "https://a.example, https://b.example",
    });
    expect(config).toMatchObject({
      port: 9090,
      downstreamUrl: "https://mcp.internal/mcp",
      maxBodyBytes: 2048,
      downstreamAuthHeader: "Bearer svc",
      corsAllowedOrigins: ["https://a.example", "https://b.example"],
    });
  });
});
