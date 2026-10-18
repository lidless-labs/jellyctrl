import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { close, createServer } = vi.hoisted(() => {
  const close = vi.fn((callback: (error?: Error) => void) => callback());
  const fakeServer = {
    once: vi.fn(() => fakeServer),
    off: vi.fn(() => fakeServer),
    listen: vi.fn((_port: number, _host: string, callback: () => void) => callback()),
    address: vi.fn(() => ({ port: 3000 })),
    close,
  };
  return { close, createServer: vi.fn(() => fakeServer) };
});

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, createServer };
});

import { createHttpServer } from "../src/http.js";

describe("HTTP transport lifecycle", () => {
  beforeEach(() => {
    vi.stubEnv("JELLYFIN_URL", "http://jellyfin.invalid:8096");
    vi.stubEnv("JELLYFIN_API_KEY", "test-key");
    vi.stubEnv("JELLYFIN_MCP_HTTP_TOKEN", "test-http-token-".repeat(3));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("closes the HTTP listener cleanly", async () => {
    const server = await createHttpServer();
    await server.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
