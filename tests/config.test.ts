import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getConfig } from "../src/config.js";

const DEFAULT_TIMEOUT_MS = 30_000;

describe("getConfig JELLYFIN_TIMEOUT validation", () => {
  beforeEach(() => {
    vi.stubEnv("JELLYFIN_URL", "http://localhost:8096");
    vi.stubEnv("JELLYFIN_API_KEY", "test-key");
    // Silence the invalid-value warning so test output stays clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("defaults to 30s when JELLYFIN_TIMEOUT is unset", () => {
    expect(getConfig().timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("uses a valid numeric value, converted to milliseconds", () => {
    vi.stubEnv("JELLYFIN_TIMEOUT", "10");
    expect(getConfig().timeout).toBe(10_000);
  });

  it.each([
    ["0.001", 1],
    ["0.125", 125],
    ["2147483.647", 2_147_483_647],
  ])("accepts timer-safe fractional seconds %s", (raw, milliseconds) => {
    vi.stubEnv("JELLYFIN_TIMEOUT", raw);
    expect(getConfig().timeout).toBe(milliseconds);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(["0.000999", "2147483.648", "1e308", "Infinity", "-Infinity", "NaN"])(
    "defaults and warns for timer-unsafe seconds %s",
    (raw) => {
      vi.stubEnv("JELLYFIN_TIMEOUT", raw);
      expect(getConfig().timeout).toBe(DEFAULT_TIMEOUT_MS);
      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        `jellyfin-mcp: invalid JELLYFIN_TIMEOUT "${raw}" (expected a positive number of seconds); using default 30s`,
      );
    },
  );

  it("falls back to the default on non-numeric input instead of NaN", () => {
    vi.stubEnv("JELLYFIN_TIMEOUT", "banana");
    expect(getConfig().timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("warns on stderr when falling back", () => {
    vi.stubEnv("JELLYFIN_TIMEOUT", "banana");
    getConfig();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("invalid JELLYFIN_TIMEOUT"),
    );
  });

  it("falls back to the default on zero and negative values", () => {
    vi.stubEnv("JELLYFIN_TIMEOUT", "0");
    expect(getConfig().timeout).toBe(DEFAULT_TIMEOUT_MS);
    vi.stubEnv("JELLYFIN_TIMEOUT", "-5");
    expect(getConfig().timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("falls back to the default on empty string", () => {
    vi.stubEnv("JELLYFIN_TIMEOUT", "");
    expect(getConfig().timeout).toBe(DEFAULT_TIMEOUT_MS);
  });
});
