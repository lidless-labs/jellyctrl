import { describe, expect, it, vi } from "vitest";
import { UsageError, parseArgs, run, type CliDeps } from "../src/cli.js";
import type { JellyfinClient } from "../src/client.js";

function capture(
  client: Partial<JellyfinClient> = {},
  startServer = vi.fn().mockResolvedValue(undefined),
) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    makeClient: () => client as JellyfinClient,
    startServer,
  };
  return { out, err, deps, startServer };
}

describe("parseArgs", () => {
  it("routes simple read commands with defaults", () => {
    expect(parseArgs(["status"])).toEqual({ kind: "status", json: false });
    expect(parseArgs(["libraries", "--json"])).toEqual({ kind: "libraries", json: true });
    expect(parseArgs(["users"])).toEqual({ kind: "users", json: false });
    expect(parseArgs(["tasks"])).toEqual({ kind: "tasks", json: false });
  });

  it("parses sessions with --active-only", () => {
    expect(parseArgs(["sessions"])).toEqual({ kind: "sessions", json: false, activeOnly: false });
    expect(parseArgs(["sessions", "--active-only", "--json"])).toEqual({
      kind: "sessions",
      json: true,
      activeOnly: true,
    });
  });

  it("parses search with positional query and options", () => {
    expect(parseArgs(["search", "blade runner", "--type", "Movie", "--limit", "5"])).toEqual({
      kind: "search",
      json: false,
      query: "blade runner",
      types: "Movie",
      limit: 5,
    });
    expect(parseArgs(["search", "dune"])).toEqual({
      kind: "search",
      json: false,
      query: "dune",
      types: undefined,
      limit: 20,
    });
  });

  it("parses item and similar positionals", () => {
    expect(parseArgs(["item", "abc123", "--user", "u1"])).toEqual({
      kind: "item",
      json: false,
      itemId: "abc123",
      userId: "u1",
    });
    expect(parseArgs(["similar", "abc123", "--user", "u1", "--limit", "3"])).toEqual({
      kind: "similar",
      json: false,
      itemId: "abc123",
      userId: "u1",
      limit: 3,
    });
  });

  it("parses per-user discovery and history commands", () => {
    expect(parseArgs(["recent", "--user", "u1"])).toEqual({ kind: "recent", json: false, userId: "u1", limit: 20 });
    expect(parseArgs(["resume", "--user", "u1", "--limit", "10"])).toEqual({
      kind: "resume",
      json: false,
      userId: "u1",
      limit: 10,
    });
    expect(parseArgs(["next-up", "--user", "u1", "--series", "s1"])).toEqual({
      kind: "next-up",
      json: false,
      userId: "u1",
      seriesId: "s1",
      limit: 20,
    });
    expect(parseArgs(["history", "--user", "u1", "--type", "Movie,Episode"])).toEqual({
      kind: "history",
      json: false,
      userId: "u1",
      types: "Movie,Episode",
      limit: 20,
    });
    expect(parseArgs(["user-data", "--user", "u1", "--item", "i1"])).toEqual({
      kind: "user-data",
      json: false,
      userId: "u1",
      itemId: "i1",
    });
  });

  it("parses activity and playlist commands", () => {
    expect(parseArgs(["activity", "--limit", "50", "--min-date", "2026-01-01T00:00:00Z"])).toEqual({
      kind: "activity",
      json: false,
      limit: 50,
      minDate: "2026-01-01T00:00:00Z",
    });
    expect(parseArgs(["playlists", "--user", "u1"])).toEqual({ kind: "playlists", json: false, userId: "u1" });
    expect(parseArgs(["playlist", "pl1", "--user", "u1"])).toEqual({
      kind: "playlist",
      json: false,
      playlistId: "pl1",
      userId: "u1",
    });
  });

  it("routes help, version, and mcp", () => {
    expect(parseArgs([])).toEqual({ kind: "help" });
    expect(parseArgs(["help"])).toEqual({ kind: "help" });
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseArgs(["mcp"])).toEqual({ kind: "mcp" });
  });

  it("rejects bad input with UsageError", () => {
    expect(() => parseArgs(["bogus"])).toThrow(UsageError);
    expect(() => parseArgs(["status", "extra"])).toThrow(UsageError);
    expect(() => parseArgs(["search"])).toThrow(UsageError); // missing query
    expect(() => parseArgs(["item"])).toThrow(UsageError); // missing itemId
    expect(() => parseArgs(["item", "abc123"])).toThrow(UsageError); // missing --user
    expect(() => parseArgs(["recent"])).toThrow(UsageError); // missing --user
    expect(() => parseArgs(["resume", "--user"])).toThrow(UsageError); // flag without value
    expect(() => parseArgs(["search", "x", "--limit", "9999"])).toThrow(UsageError); // out of range
    expect(() => parseArgs(["playlist", "pl1"])).toThrow(UsageError); // missing --user
  });

  it("does not expose any write/playback command", () => {
    for (const w of [
      "play",
      "pause",
      "stop",
      "seek",
      "scan",
      "create-user",
      "delete-user",
      "mark-played",
      "favorite",
      "run-task",
      "restart",
      "shutdown",
      "message",
    ]) {
      expect(() => parseArgs([w])).toThrow(UsageError);
    }
  });
});

describe("run", () => {
  it("prints human status output and exits 0", async () => {
    const client = {
      getSystemInfo: vi.fn().mockResolvedValue({ ServerName: "Home", Version: "10.9.11", Id: "abc" }),
    };
    const { out, deps } = capture(client);
    expect(await run(["status"], deps)).toBe(0);
    expect(client.getSystemInfo).toHaveBeenCalledOnce();
    const text = out.join("\n");
    expect(text).toContain("serverName: Home");
    expect(text).toContain("version: 10.9.11");
  });

  it("exits 1 when status reports no version (unhealthy)", async () => {
    const client = { getSystemInfo: vi.fn().mockResolvedValue({ ServerName: "Home", Version: "", Id: "abc" }) };
    const { deps } = capture(client);
    expect(await run(["status"], deps)).toBe(1);
  });

  it("emits raw JSON with --json", async () => {
    const payload = { ServerName: "Home", Version: "10.9.11", Id: "abc" };
    const client = { getSystemInfo: vi.fn().mockResolvedValue(payload) };
    const { out, deps } = capture(client);
    expect(await run(["status", "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual(payload);
  });

  it("passes item user context through to the client", async () => {
    const client = { getItem: vi.fn().mockResolvedValue({ Id: "i1", Name: "Movie", Type: "Movie" }) };
    const { deps } = capture(client);
    expect(await run(["item", "i1", "--user", "u1"], deps)).toBe(0);
    expect(client.getItem).toHaveBeenCalledWith("i1", "u1");
  });

  it("passes search options through to the client", async () => {
    const client = { searchItems: vi.fn().mockResolvedValue({ Items: [], TotalRecordCount: 0 }) };
    const { deps } = capture(client);
    expect(await run(["search", "the wire", "--type", "Series", "--limit", "7"], deps)).toBe(0);
    expect(client.searchItems).toHaveBeenCalledWith("the wire", "Series", 7);
  });

  it("passes existing activity flags through the options signature", async () => {
    const client = { getActivityLog: vi.fn().mockResolvedValue({ Items: [], TotalRecordCount: 0 }) };
    const { out, deps } = capture(client);
    expect(await run(["activity", "--limit", "50", "--min-date", "2026-01-01T00:00:00Z", "--json"], deps)).toBe(0);
    expect(client.getActivityLog).toHaveBeenCalledWith({ limit: 50, minDate: "2026-01-01T00:00:00Z" });
    expect(JSON.parse(out.join("\n"))).toEqual({ Items: [], TotalRecordCount: 0 });
  });

  it("filters sessions to active-only without touching the server", async () => {
    const sessions = [
      { Id: "s1", NowPlayingItem: { Id: "i1", Name: "X", Type: "Movie" } },
      { Id: "s2" },
    ];
    const client = { listSessions: vi.fn().mockResolvedValue(sessions) };
    const { out, deps } = capture(client);
    expect(await run(["sessions", "--active-only", "--json"], deps)).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].Id).toBe("s1");
  });

  it("renders resume positions in seconds", async () => {
    const client = {
      getResumeItems: vi.fn().mockResolvedValue({
        TotalRecordCount: 1,
        Items: [{ Id: "i1", Name: "Movie", Type: "Movie", RunTimeTicks: 36_000_000_000, UserData: { PlaybackPositionTicks: 6_000_000_000, PlayedPercentage: 16.6 } }],
      }),
    };
    const { out, deps } = capture(client);
    expect(await run(["resume", "--user", "u1"], deps)).toBe(0);
    expect(client.getResumeItems).toHaveBeenCalledWith("u1", 20);
    const text = out.join("\n");
    expect(text).toContain("@ 600s/3600s");
  });

  it("returns {} for user-data when none exists", async () => {
    const client = { getItemUserData: vi.fn().mockResolvedValue(undefined) };
    const { out, deps } = capture(client);
    expect(await run(["user-data", "--user", "u1", "--item", "i1", "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({});
  });

  it("returns exit 1 and prints the error on client failure", async () => {
    const client = { listLibraries: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")) };
    const { err, deps } = capture(client);
    expect(await run(["libraries"], deps)).toBe(1);
    expect(err.join("\n")).toContain("ECONNREFUSED");
  });

  it("returns exit 1 and prints the error when makeClient throws synchronously", async () => {
    const error = new Error("missing JELLYFIN_API_KEY");
    const err: string[] = [];
    const deps: CliDeps = {
      out: () => {},
      err: (s) => err.push(s),
      makeClient: () => {
        throw error;
      },
      startServer: vi.fn().mockResolvedValue(undefined),
    };

    await expect(run(["libraries"], deps)).resolves.toBe(1);
    expect(err).toEqual(["missing JELLYFIN_API_KEY"]);
  });

  it("returns exit 2 and prints help on usage error", async () => {
    const { err, deps } = capture();
    expect(await run(["bogus"], deps)).toBe(2);
    expect(err.join("\n")).toContain("Usage:");
  });

  it("prints version without constructing a client", async () => {
    const make = vi.fn();
    const deps: CliDeps = {
      out: () => {},
      err: () => {},
      makeClient: make,
      startServer: vi.fn().mockResolvedValue(undefined),
    };
    expect(await run(["--version"], deps)).toBe(0);
    expect(make).not.toHaveBeenCalled();
  });

  it("delegates `mcp` to startServer()", async () => {
    const { deps, startServer } = capture();
    expect(await run(["mcp"], deps)).toBe(0);
    expect(startServer).toHaveBeenCalledOnce();
  });

  it("preserves the original mcp startup rejection identity", async () => {
    const startupError = new Error("stdio unavailable");
    const { deps } = capture({}, vi.fn().mockRejectedValue(startupError));

    await expect(run(["mcp"], deps)).rejects.toBe(startupError);
  });
});
