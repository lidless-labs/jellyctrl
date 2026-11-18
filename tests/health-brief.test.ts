import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { JellyfinClient } from "../src/client.js";
import { parseArgs } from "../src/cli.js";
import { registerAllTools } from "../src/server.js";

const asOf = "2026-01-20T12:00:00.000Z";
const scanAt = "2026-01-20T06:00:00.000Z";
const scan = {
  Name: "Scan Media Library", Key: "RefreshLibrary",
  Triggers: [{ Type: "IntervalTrigger", IntervalTicks: 432_000_000_000 }],
  LastExecutionResult: { EndTimeUtc: scanAt, Status: "Completed" },
};
const disk = { DeviceId: "media", UsedSpace: 400_000_000_000, FreeSpace: 100_000_000_000 };
const fixture: Record<string, unknown> = {
  "/System/Info": { Version: "12.4.0", HasPendingRestart: false, HasUpdateAvailable: false },
  "/Sessions": [
    { NowPlayingItem: {}, PlayState: { PlayMethod: "Transcode" }, TranscodingInfo: {} },
    { NowPlayingItem: {}, PlayState: { PlayMethod: "DirectPlay" } },
    { NowPlayingItem: null, TranscodingInfo: {} },
  ],
  "/ScheduledTasks": [scan],
  "/System/Info/Storage": {
    CacheFolder: { ...disk, Path: "/example/cache" },
    TranscodingTempFolder: { ...disk, Path: "/example/transcodes" },
  },
  "/Plugins": [{ Name: "Example", Status: "Active" }],
  "/System/ActivityLog/Entries": {
    Items: [{ Id: 1, Date: scanAt, Severity: "Information", Type: "SessionStarted" }],
    TotalRecordCount: 1,
  },
};

type MockSource = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

async function callBrief(args = {}, mockSource?: MockSource, timeout = 5000) {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(asOf));
  const fetch = vi.fn((input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(init.method ?? "GET").toBe("GET");
    if (!(url.pathname in fixture)) throw new Error("Unexpected Jellyfin path");
    return mockSource?.(url, init) ?? Response.json(fixture[url.pathname]);
  });
  vi.stubGlobal("fetch", fetch);
  const client = new JellyfinClient({
    url: "https://jellyfin.test", apiKey: "test-key", verifySsl: true, timeout,
  });
  const tools = new Map<string, {
    schema: z.ZodRawShape;
    handler: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  }>();
  registerAllTools({
    tool(name: string, _description: string, schema: z.ZodRawShape, _annotations: unknown, handler: never) {
      tools.set(name, { schema, handler });
    },
  } as unknown as McpServer, client);
  const tool = tools.get("jellyfin_health_brief");
  expect(tool).toBeDefined();
  const result = await tool!.handler(z.object(tool!.schema).parse(args));
  expect(result.isError).toBeUndefined();
  return { brief: JSON.parse(result.content[0].text), fetch };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("jellyfin_health_brief", () => {
  it("returns a compact healthy report and the exact activity window", async () => {
    const { brief, fetch } = await callBrief();
    expect(fetch).toHaveBeenCalledTimes(6);
    const activityUrl = fetch.mock.calls.map(([input]) => new URL(input))
      .find((url) => url.pathname === "/System/ActivityLog/Entries")!;
    expect(activityUrl.searchParams.get("minDate")).toBe("2026-01-19T12:00:00.000Z");
    expect(activityUrl.searchParams.get("maxDate")).toBe(asOf);
    expect(brief).toEqual({
      asOf, windowHours: 24, complete: true, failedSources: [],
      server: { version: "12.4.0", hasPendingRestart: false, hasUpdateAvailable: false },
      sessions: { activePlayback: 2, transcoding: 1, idleClients: 1 },
      tasks: {
        byLastResult: { Completed: 1, Failed: 0, Cancelled: 0, Aborted: 0, neverRun: 0, unknown: 0 },
        exceptions: [],
      },
      storage: {
        volumeCount: 1, lowSpaceCount: 0, unknownCapacityCount: 0,
        volumes: [{ deviceId: "media", usedBytes: 400_000_000_000, freeBytes: 100_000_000_000,
          transcodeTempPath: "/example/transcodes", cachePath: "/example/cache" }],
        exceptions: [],
      },
      plugins: { byStatus: { Active: 1 }, malfunctioned: 0, notSupported: 0, restartRequired: 0, exceptions: [] },
      activity: { bySeverity: { Information: 1 }, errorClusterCount: 0, exceptions: [] },
      scanFreshness: { lastRunAt: scanAt, intervalHours: 12, overdue: false },
    });
  });

  it("keeps successful sources when the scheduled tasks fetch fails", async () => {
    const { brief } = await callBrief({ windowHours: 168 }, (url) =>
      url.pathname === "/ScheduledTasks" ? new Response(null, { status: 503 }) : undefined);
    expect(brief).toMatchObject({
      windowHours: 168, complete: false, failedSources: ["tasks"],
      tasks: "unknown", scanFreshness: "unknown", sessions: { activePlayback: 2 },
    });
  });

  it("bounds a stalled source using the client request timeout while others start", async () => {
    const started = new Set<string>();
    const { brief } = await callBrief({}, (url, init) => {
      started.add(url.pathname);
      if (url.pathname !== "/Sessions") return;
      return new Promise((_, reject) => init.signal!.addEventListener("abort", () => {
        expect(started.size).toBe(6);
        reject(init.signal!.reason);
      }, { once: true }));
    }, 50);
    expect(brief).toMatchObject({
      complete: false, failedSources: ["sessions"], sessions: "unknown",
      server: { version: "12.4.0" },
    });
  });

  it("counts cancellations and never-run tasks separately and reports the newest three failures", async () => {
    const failed = (Name: string, Status: string, day: string) => ({
      Name, LastExecutionResult: {
        Status, EndTimeUtc: `2026-01-${day}T06:00:00.000Z`,
        ErrorMessage: "Read failed\nstack line", LongErrorMessage: "Private details",
      },
    });
    const { brief } = await callBrief({}, (url) => url.pathname === "/ScheduledTasks" ? Response.json([
      { ...scan, LastExecutionResult: { ...scan.LastExecutionResult, EndTimeUtc: "2026-01-19T06:00:00.000Z" } },
      failed("One", "Failed", "17"), failed("Two", "Failed", "18"),
      failed("Three", "Aborted", "19"), failed("Four", "Failed", "20"),
      failed("Cancelled", "Cancelled", "20"), { Name: "Never", LastExecutionResult: null },
    ]) : undefined);
    expect(brief.tasks.byLastResult).toEqual({
      Completed: 1, Failed: 3, Cancelled: 1, Aborted: 1, neverRun: 1, unknown: 0,
    });
    expect(brief.tasks.exceptions.map((row: { name: string }) => row.name)).toEqual(["Four", "Three", "Two"]);
    expect(brief.tasks.exceptions[0]).toEqual({
      name: "Four", status: "Failed", endTime: scanAt, error: "Read failed",
    });
    expect(brief.scanFreshness.overdue).toBe(true);
  });

  it("flags either free-space threshold and counts a shared volume once", async () => {
    const { brief } = await callBrief({ minFreePercent: 25, minFreeGb: 60 }, (url) =>
      url.pathname === "/System/Info/Storage" ? Response.json({
        CacheFolder: { ...disk, Path: "/example/cache" },
        TranscodingTempFolder: { ...disk, Path: "/example/transcodes" },
        Libraries: [{ Folders: [
          { DeviceId: "smaller", Path: "/example/movies", UsedSpace: 50e9, FreeSpace: 50e9 },
          { DeviceId: "full", Path: "/example/full", UsedSpace: 100e9, FreeSpace: 0 },
          { Path: "/example/unmeasured", UsedSpace: 0, FreeSpace: 0 },
          { DeviceId: "other", Path: "/example/other", UsedSpace: 100e9, FreeSpace: 100e9 },
          { DeviceId: "smallest", Path: "/example/small", UsedSpace: 25e9, FreeSpace: 25e9 },
        ] }],
      }) : undefined);
    expect(brief.storage).toMatchObject({
      volumeCount: 6, lowSpaceCount: 4, unknownCapacityCount: 1,
      exceptions: ["full", "media", "smallest"],
    });
  });

  it("counts plugin statuses while limiting exceptions to broken, unsupported and restart-required", async () => {
    const { brief } = await callBrief({}, (url) => url.pathname === "/Plugins" ? Response.json([
      { Name: "Broken", Status: "Malfunctioned" }, { Name: "Disabled", Status: "Disabled" },
      { Name: "Pending", Status: "Restart" }, { Name: "Unsupported", Status: "NotSupported" },
    ]) : undefined);
    expect(brief.plugins).toEqual({
      byStatus: { Malfunctioned: 1, Disabled: 1, Restart: 1, NotSupported: 1 },
      malfunctioned: 1, notSupported: 1, restartRequired: 1,
      exceptions: [
        { name: "Broken", status: "Malfunctioned" },
        { name: "Unsupported", status: "NotSupported" },
        { name: "Pending", status: "Restart" },
      ],
    });
  });

  it("clusters playback and transcode errors across activity pages without free text", async () => {
    const { brief } = await callBrief({}, (url) => {
      if (url.pathname !== "/System/ActivityLog/Entries") return;
      const start = Number(url.searchParams.get("startIndex"));
      const entries = [
        { Id: 1, Type: "PlaybackError", ItemId: "movie", Date: scanAt, Severity: "Error", Overview: "Private" },
        { Id: 2, Type: "PlaybackError", ItemId: "movie", Date: asOf, Severity: "Critical" },
        { Id: 3, Type: "TranscodeError", ItemId: "show", Date: scanAt, Severity: "Error" },
        { Id: 4, Type: "Other", Date: scanAt, Severity: "Error" },
      ];
      return Response.json({ Items: entries.slice(start, start + 2), TotalRecordCount: entries.length });
    });
    expect(brief.activity).toEqual({
      bySeverity: { Error: 3, Critical: 1 }, errorClusterCount: 2,
      exceptions: [
        { type: "PlaybackError", itemId: "movie", count: 2, lastAt: asOf },
        { type: "TranscodeError", itemId: "show", count: 1, lastAt: scanAt },
      ],
    });
  });

  it("parses health-brief CLI options and rejects windows above 168 hours", () => {
    expect(parseArgs(["health-brief", "--window-hours", "48", "--min-free-gb", "2.5", "--json"]))
      .toMatchObject({ kind: "health-brief", options: { windowHours: 48, minFreeGb: 2.5, minFreePercent: 15 } });
    expect(() => parseArgs(["health-brief", "--window-hours", "169"])).toThrow(/window-hours/);
  });
});
