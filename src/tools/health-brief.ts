import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toToolHandler } from "../effect/tool-adapter.js";
import type { FolderStorage, PluginInfo, ScheduledTask, Session, SystemStorage } from "../types.js";
import { ok, READ_ONLY } from "./_util.js";

const EXCEPTION_LIMIT = 3;
const MS_PER_HOUR = 3_600_000;
const TICKS_PER_HOUR = MS_PER_HOUR * 10_000;
const BYTES_PER_GB = 1_000_000_000;
const UNKNOWN = "unknown" as const;

const healthBriefArgs = {
  windowHours: z.number().int().min(1).max(168).default(24).describe("Activity window in hours."),
  minFreePercent: z.number().min(0).max(100).default(15).describe("Warn below this free-space percentage."),
  minFreeGb: z.number().min(0).max(Number.MAX_SAFE_INTEGER / BYTES_PER_GB).default(50)
    .describe("Warn below this free space in decimal GB."),
};
export const healthBriefSchema = z.object(healthBriefArgs);
export type HealthBriefOptions = z.output<typeof healthBriefSchema>;

function shortText(value?: string | null, maxLength = 120) {
  const line = value?.split(/[\r\n]/, 1)[0]?.trim();
  return line ? line.slice(0, maxLength) : null;
}

function timestamp(value?: string | null) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function summarizeSessions(sessions: Session[]) {
  const playing = sessions.filter((session) => session.NowPlayingItem);
  return {
    activePlayback: playing.length,
    transcoding: playing.filter((session) =>
      session.PlayState?.PlayMethod === "Transcode" ||
      (session.PlayState?.PlayMethod == null && session.TranscodingInfo != null),
    ).length,
    idleClients: sessions.length - playing.length,
  };
}

function summarizeTasks(tasks: ScheduledTask[]) {
  const byLastResult = { Completed: 0, Failed: 0, Cancelled: 0, Aborted: 0, neverRun: 0, unknown: 0 };
  const failures = [];
  for (const task of tasks) {
    const result = task.LastExecutionResult;
    switch (result?.Status) {
      case "Failed":
      case "Aborted":
        failures.push({
          name: shortText(task.Name),
          status: result.Status,
          endTime: result.EndTimeUtc ?? null,
          error: shortText(result.ErrorMessage),
        });
        byLastResult[result.Status]++;
        break;
      case "Completed":
      case "Cancelled":
        byLastResult[result.Status]++;
        break;
      default:
        byLastResult[result == null ? "neverRun" : "unknown"]++;
    }
  }
  failures.sort((a, b) => (timestamp(b.endTime) ?? -Infinity) - (timestamp(a.endTime) ?? -Infinity));
  return { byLastResult, exceptions: failures.slice(0, EXCEPTION_LIMIT) };
}

function summarizeScan(tasks: ScheduledTask[], now: number) {
  const scan = tasks.find((task) => task.Key === "RefreshLibrary");
  if (!scan) return UNKNOWN;

  // Use the shortest recurring cadence when the task has multiple triggers.
  const intervals = (scan.Triggers ?? []).map((trigger) => {
    switch (trigger.Type) {
      case "IntervalTrigger": return (trigger.IntervalTicks ?? 0) / TICKS_PER_HOUR;
      case "DailyTrigger": return 24;
      case "WeeklyTrigger": return 168;
      default: return 0;
    }
  }).filter((hours) => Number.isFinite(hours) && hours > 0);
  const intervalHours = intervals.length ? Math.min(...intervals) : null;
  const lastResult = scan.LastExecutionResult;
  const lastRunAt = lastResult?.EndTimeUtc ?? null;
  const lastRun = timestamp(lastRunAt);
  const overdueByInterval = lastRun === null || intervalHours === null
    ? null
    : now - lastRun > intervalHours * MS_PER_HOUR;
  return {
    lastRunAt,
    intervalHours,
    overdue: lastResult != null && lastResult.Status !== "Completed" ? true : overdueByInterval,
  };
}

const storagePathFields = {
  TranscodingTempFolder: "transcodeTempPath",
  CacheFolder: "cachePath",
  ImageCacheFolder: "imageCachePath",
} as const;
type StoragePathField = typeof storagePathFields[keyof typeof storagePathFields];
type Volume = {
  deviceId: string | null;
  path?: string;
  usedBytes: number | null;
  freeBytes: number | null;
} & Partial<Record<StoragePathField, string>>;

function summarizeStorage(storage: SystemStorage, { minFreePercent, minFreeGb }: HealthBriefOptions) {
  const grouped = new Map<string, Volume>();
  const addFolder = (folder?: FolderStorage, role?: StoragePathField) => {
    if (!folder?.Path) return;
    const deviceId = folder.DeviceId || null;
    const key = deviceId === null ? `path:${folder.Path}` : `device:${deviceId}`;
    const volume = grouped.get(key) ?? {
      deviceId,
      ...(deviceId === null ? { path: folder.Path } : {}),
      usedBytes: null,
      freeBytes: null,
    };
    const { UsedSpace, FreeSpace } = folder;
    if (UsedSpace >= 0 && FreeSpace >= 0 && UsedSpace + FreeSpace > 0 &&
        (volume.freeBytes === null || FreeSpace < volume.freeBytes)) {
      volume.usedBytes = UsedSpace;
      volume.freeBytes = FreeSpace;
    }
    if (role) volume[role] = folder.Path;
    grouped.set(key, volume);
  };

  for (const field of ["ProgramDataFolder", "WebFolder", "LogFolder", "InternalMetadataFolder"] as const) {
    addFolder(storage[field]);
  }
  for (const field of Object.keys(storagePathFields) as Array<keyof typeof storagePathFields>) {
    addFolder(storage[field], storagePathFields[field]);
  }
  for (const library of storage.Libraries ?? []) {
    for (const folder of library.Folders) addFolder(folder);
  }

  const volumes = [...grouped.values()];
  let unknownCapacityCount = 0;
  const lowSpace = [];
  for (const { deviceId, path, usedBytes, freeBytes } of volumes) {
    if (usedBytes === null || freeBytes === null) {
      unknownCapacityCount++;
      continue;
    }
    const freePercent = freeBytes / (usedBytes + freeBytes) * 100;
    if (freePercent < minFreePercent || freeBytes < minFreeGb * BYTES_PER_GB) {
      lowSpace.push({ volume: deviceId ?? path, freePercent, freeBytes });
    }
  }
  lowSpace.sort((a, b) => a.freePercent - b.freePercent || a.freeBytes - b.freeBytes);
  return {
    volumeCount: volumes.length,
    lowSpaceCount: lowSpace.length,
    unknownCapacityCount,
    volumes,
    exceptions: lowSpace.slice(0, EXCEPTION_LIMIT).map(({ volume }) => volume),
  };
}

function increment(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function summarizePlugins(plugins: PluginInfo[]) {
  const counts = new Map<string, number>();
  for (const plugin of plugins) increment(counts, plugin.Status ?? UNKNOWN);
  const exceptionStatuses = ["Malfunctioned", "NotSupported", "Restart"];
  const exceptions = exceptionStatuses.flatMap((status) =>
    plugins.filter((plugin) => plugin.Status === status)
      .map((plugin) => ({ name: shortText(plugin.Name), status })),
  ).slice(0, EXCEPTION_LIMIT);
  return {
    byStatus: Object.fromEntries(counts),
    malfunctioned: counts.get("Malfunctioned") ?? 0,
    notSupported: counts.get("NotSupported") ?? 0,
    restartRequired: counts.get("Restart") ?? 0,
    exceptions,
  };
}

async function summarizeActivity(client: JellyfinClient, minDate: string, maxDate: string) {
  const counts = new Map<string, number>();
  const clusters = new Map<string, { type: string; itemId: string | null; count: number; lastAt: string }>();
  let startIndex = 0;
  let total: number;
  do {
    const page = await client.getActivityLog({ startIndex, limit: 200, minDate, maxDate });
    total = page.TotalRecordCount;
    if (!Number.isSafeInteger(total) || total < 0 || (startIndex < total && !page.Items.length)) {
      throw new Error("Incomplete Jellyfin activity log");
    }
    for (const entry of page.Items) {
      increment(counts, entry.Severity ?? UNKNOWN);
      if ((entry.Severity !== "Error" && entry.Severity !== "Critical") ||
          !/playback|transcod/i.test(entry.Type) || timestamp(entry.Date) === null) continue;
      const itemId = entry.ItemId || null;
      const key = JSON.stringify([entry.Type, itemId]);
      const cluster = clusters.get(key) ?? { type: entry.Type, itemId, count: 0, lastAt: entry.Date };
      cluster.count++;
      if (Date.parse(entry.Date) > Date.parse(cluster.lastAt)) cluster.lastAt = entry.Date;
      clusters.set(key, cluster);
    }
    startIndex += page.Items.length;
  } while (startIndex < total);

  const exceptions = [...clusters.values()]
    .sort((a, b) => b.count - a.count || Date.parse(b.lastAt) - Date.parse(a.lastAt))
    .slice(0, EXCEPTION_LIMIT);
  return { bySeverity: Object.fromEntries(counts), errorClusterCount: clusters.size, exceptions };
}

async function readSource<T>(read: () => Promise<T>): Promise<T | typeof UNKNOWN> {
  try {
    return await read();
  } catch {
    return UNKNOWN;
  }
}

export async function getHealthBrief(client: JellyfinClient, options: HealthBriefOptions) {
  const now = Date.now();
  const asOf = new Date(now).toISOString();
  const minDate = new Date(now - options.windowHours * MS_PER_HOUR).toISOString();
  const [server, sessions, scheduled, storage, plugins, activity] = await Promise.all([
    readSource(async () => {
      const info = await client.getSystemInfo();
      return {
        version: info.Version ?? null,
        hasPendingRestart: info.HasPendingRestart ?? null,
        hasUpdateAvailable: info.HasUpdateAvailable ?? null,
      };
    }),
    readSource(async () => summarizeSessions(await client.listSessions())),
    readSource(async () => {
      const tasks = await client.listScheduledTasks();
      return { tasks: summarizeTasks(tasks), scanFreshness: summarizeScan(tasks, now) };
    }),
    readSource(async () => summarizeStorage(await client.getSystemStorage(), options)),
    readSource(async () => summarizePlugins(await client.listPlugins())),
    readSource(() => summarizeActivity(client, minDate, asOf)),
  ]);
  const sources = { server, sessions, tasks: scheduled, storage, plugins, activity };
  const failedSources = Object.keys(sources).filter((source) => sources[source as keyof typeof sources] === UNKNOWN);
  return {
    asOf,
    windowHours: options.windowHours,
    complete: failedSources.length === 0,
    failedSources,
    server,
    sessions,
    tasks: scheduled === UNKNOWN ? UNKNOWN : scheduled.tasks,
    storage,
    plugins,
    activity,
    scanFreshness: scheduled === UNKNOWN ? UNKNOWN : scheduled.scanFreshness,
  };
}

export function registerHealthBriefTool(server: McpServer, client: JellyfinClient): void {
  server.tool(
    "jellyfin_health_brief",
    "Get a compact daily Jellyfin health brief with counts, up to three exceptions per section, and unknown sections for failed sources.",
    healthBriefArgs,
    READ_ONLY,
    toToolHandler((options) => Effect.map(fromPromise(() => getHealthBrief(client, options)), ok)),
  );
}
