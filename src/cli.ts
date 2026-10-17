import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit } from "effect";
import { JellyfinClient } from "./client.js";
import { getConfig } from "./config.js";
import { fromPromise } from "./effect/tool-adapter.js";
import type {
  ActivityLogResponse,
  Item,
  ItemsResponse,
  Library,
  ScheduledTask,
  Session,
  SystemInfo,
  User,
  UserItemData,
} from "./types.js";

// Single source of truth for the version: read package.json at runtime, the
// same way src/index.ts does, so the CLI never drifts from the published bump.
const nodeRequire = createRequire(import.meta.url);
const pkg = nodeRequire("../package.json") as { version: string };
const VERSION = pkg.version;

const TICKS_PER_SECOND = 10_000_000;
const ticksToSeconds = (ticks: number | undefined | null): number | null =>
  typeof ticks === "number" ? Math.round(ticks / TICKS_PER_SECOND) : null;

export class UsageError extends Error {}

export type Parsed =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "mcp" }
  | { kind: "status"; json: boolean }
  | { kind: "libraries"; json: boolean }
  | { kind: "users"; json: boolean }
  | { kind: "sessions"; json: boolean; activeOnly: boolean }
  | { kind: "search"; json: boolean; query: string; types?: string; limit: number }
  | { kind: "item"; json: boolean; itemId: string; userId: string }
  | { kind: "recent"; json: boolean; userId: string; limit: number }
  | { kind: "resume"; json: boolean; userId: string; limit: number }
  | { kind: "next-up"; json: boolean; userId: string; seriesId?: string; limit: number }
  | { kind: "similar"; json: boolean; itemId: string; userId?: string; limit: number }
  | { kind: "history"; json: boolean; userId: string; types?: string; limit: number }
  | { kind: "user-data"; json: boolean; userId: string; itemId: string }
  | { kind: "activity"; json: boolean; limit: number; minDate?: string }
  | { kind: "tasks"; json: boolean }
  | { kind: "playlists"; json: boolean; userId: string }
  | { kind: "playlist"; json: boolean; playlistId: string; userId: string };

export const HELP = `jellyctrl - read-only control CLI for a Jellyfin media server

Usage:
  jellyctrl <command> [options]

Server:
  status                     Server info (name, version, OS, pending restart)  [exit 1 if unreachable]
  libraries                  List libraries (virtual folders) with paths
  tasks                      List scheduled tasks with state and last result
  activity                   Recent activity-log entries

Users & sessions:
  users                      List users with admin/disabled flags + last login
  sessions                   List connected client sessions (now-playing, progress)

Content:
  search <query>             Search the library by name
  item <itemId> --user <id>  Full metadata for one item
  recent --user <id>         Recently added items (per-user 'latest' view)

Per-user discovery & history:
  resume --user <id>         In-progress items (Continue Watching) with resume position
  next-up --user <id>        Next unwatched episode per series
  similar <itemId>           Items similar to one item (Jellyfin recommender)
  history --user <id>        Watch history, most-recent first
  user-data --user <id> --item <id>   Raw per-user data for one item (resume/played/favorite)

Playlists:
  playlists --user <id>      List playlists visible to a user
  playlist <playlistId> --user <id>   Items in a playlist, in order

Other:
  mcp                        Start the MCP server over stdio
  help                       Show this help

Global options:
  --json                     Emit raw JSON instead of human-readable text
  --version, -v              Print version
  --help, -h                 Show help

Command options:
  sessions   --active-only            Only sessions with a now-playing item
  search     --type <t,...>           Comma-separated item types (Movie,Series,Episode,...)
             --limit <n>              Max results, 1-200            (default 20)
  recent     --limit <n>              Max results, 1-100            (default 20)
  resume     --limit <n>              Max results, 1-100            (default 20)
  next-up    --series <id>            Restrict to one series
             --limit <n>              Max results, 1-100            (default 20)
  similar    --user <id>              User context for visibility/watched filtering
             --limit <n>              Max results, 1-100            (default 20)
  history    --type <t,...>           Comma-separated item types
             --limit <n>              Max results, 1-200            (default 20)
  activity   --limit <n>              Max entries, 1-200            (default 20)
             --min-date <iso>         Only entries newer than this ISO 8601 timestamp

Environment:
  JELLYFIN_URL          Base URL (e.g. http://192.0.2.10:8096)            [required]
  JELLYFIN_API_KEY      API key from Dashboard > API Keys                 [required]
  JELLYFIN_TIMEOUT      Request timeout in seconds                        (default 30)
  JELLYFIN_VERIFY_SSL   Set to false to skip TLS validation for Jellyfin  (default true)`;

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} requires a value`);
  args.splice(i, 2);
  return v;
}

function requireOption(args: string[], name: string): string {
  const v = takeOption(args, name);
  if (v === undefined) throw new UsageError(`${name} is required`);
  return v;
}

function takePositional(args: string[], name: string): string {
  const v = args.shift();
  if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} is required`);
  return v;
}

function ensureNoExtra(args: string[]): void {
  if (args.length) throw new UsageError(`Unexpected arguments: ${args.join(" ")}`);
}

function requireInt(v: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return n;
}

export function parseArgs(argv: string[]): Parsed {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) return { kind: "help" };
  if (args.includes("-v") || args.includes("--version")) return { kind: "version" };

  const cmd = args.shift();
  if (!cmd || cmd === "help") return { kind: "help" };
  if (cmd === "mcp") {
    ensureNoExtra(args);
    return { kind: "mcp" };
  }

  // Pull the global --json flag out before per-command parsing.
  const json = takeFlag(args, "--json");

  switch (cmd) {
    case "status":
      ensureNoExtra(args);
      return { kind: "status", json };
    case "libraries":
      ensureNoExtra(args);
      return { kind: "libraries", json };
    case "users":
      ensureNoExtra(args);
      return { kind: "users", json };
    case "tasks":
      ensureNoExtra(args);
      return { kind: "tasks", json };
    case "sessions": {
      const activeOnly = takeFlag(args, "--active-only");
      ensureNoExtra(args);
      return { kind: "sessions", json, activeOnly };
    }
    case "search": {
      const types = takeOption(args, "--type");
      const limit = requireInt(takeOption(args, "--limit"), "--limit", 1, 200, 20);
      const query = takePositional(args, "<query>");
      ensureNoExtra(args);
      return { kind: "search", json, query, types, limit };
    }
    case "item": {
      const userId = requireOption(args, "--user");
      const itemId = takePositional(args, "<itemId>");
      ensureNoExtra(args);
      return { kind: "item", json, itemId, userId };
    }
    case "recent": {
      const userId = requireOption(args, "--user");
      const limit = requireInt(takeOption(args, "--limit"), "--limit", 1, 100, 20);
      ensureNoExtra(args);
      return { kind: "recent", json, userId, limit };
    }
    case "resume": {
      const userId = requireOption(args, "--user");
      const limit = requireInt(takeOption(args, "--limit"), "--limit", 1, 100, 20);
      ensureNoExtra(args);
      return { kind: "resume", json, userId, limit };
    }
    case "next-up": {
      const userId = requireOption(args, "--user");
      const seriesId = takeOption(args, "--series");
      const limit = requireInt(takeOption(args, "--limit"), "--limit", 1, 100, 20);
      ensureNoExtra(args);
      return { kind: "next-up", json, userId, seriesId, limit };
    }
    case "similar": {
      const userId = takeOption(args, "--user");
      const limit = requireInt(takeOption(args, "--limit"), "--limit", 1, 100, 20);
      const itemId = takePositional(args, "<itemId>");
      ensureNoExtra(args);
      return { kind: "similar", json, itemId, userId, limit };
    }
    case "history": {
      const userId = requireOption(args, "--user");
      const types = takeOption(args, "--type");
      const limit = requireInt(takeOption(args, "--limit"), "--limit", 1, 200, 20);
      ensureNoExtra(args);
      return { kind: "history", json, userId, types, limit };
    }
    case "user-data": {
      const userId = requireOption(args, "--user");
      const itemId = requireOption(args, "--item");
      ensureNoExtra(args);
      return { kind: "user-data", json, userId, itemId };
    }
    case "activity": {
      const limit = requireInt(takeOption(args, "--limit"), "--limit", 1, 200, 20);
      const minDate = takeOption(args, "--min-date");
      ensureNoExtra(args);
      return { kind: "activity", json, limit, minDate };
    }
    case "playlists": {
      const userId = requireOption(args, "--user");
      ensureNoExtra(args);
      return { kind: "playlists", json, userId };
    }
    case "playlist": {
      const userId = requireOption(args, "--user");
      const playlistId = takePositional(args, "<playlistId>");
      ensureNoExtra(args);
      return { kind: "playlist", json, playlistId, userId };
    }
    default:
      throw new UsageError(`Unknown command: ${cmd}`);
  }
}

// ---------- renderers (concise human-readable; --json bypasses these) --------

function renderStatus(s: SystemInfo): string {
  return [
    `serverName: ${s.ServerName}`,
    `version: ${s.Version}`,
    `id: ${s.Id}`,
    `os: ${s.OperatingSystemDisplayName ?? "(unknown)"}`,
    `architecture: ${s.SystemArchitecture ?? "(unknown)"}`,
    `localAddress: ${s.LocalAddress ?? "(unknown)"}`,
    `hasPendingRestart: ${s.HasPendingRestart ?? false}`,
    `hasUpdateAvailable: ${s.HasUpdateAvailable ?? false}`,
  ].join("\n");
}

function renderLibraries(libs: Library[]): string {
  if (!libs.length) return "No libraries.";
  const lines = [`${libs.length} librar${libs.length === 1 ? "y" : "ies"}:`];
  for (const lib of libs) {
    lines.push(`  ${lib.Name}  [${lib.CollectionType ?? "mixed"}]  id=${lib.ItemId}`);
    for (const loc of lib.Locations ?? []) lines.push(`    ${loc}`);
  }
  return lines.join("\n");
}

function renderUsers(users: User[]): string {
  if (!users.length) return "No users.";
  const lines = [`${users.length} user(s):`];
  for (const u of users) {
    const flags = [
      u.Policy?.IsAdministrator ? "admin" : null,
      u.Policy?.IsDisabled ? "disabled" : null,
    ].filter(Boolean);
    const tag = flags.length ? `  [${flags.join(", ")}]` : "";
    lines.push(`  ${u.Name}${tag}  id=${u.Id}  lastLogin=${u.LastLoginDate ?? "never"}`);
  }
  return lines.join("\n");
}

function renderSessions(sessions: Session[]): string {
  if (!sessions.length) return "No sessions.";
  const lines = [`${sessions.length} session(s):`];
  for (const s of sessions) {
    const np = s.NowPlayingItem;
    const playing = np
      ? `${np.SeriesName ? `${np.SeriesName} - ` : ""}${np.Name} [${np.Type}]${s.PlayState?.IsPaused ? " (paused)" : ""}`
      : "idle";
    lines.push(`  ${s.UserName ?? "?"}  ${s.Client ?? "?"} / ${s.DeviceName ?? "?"}  ${playing}`);
    lines.push(`    sessionId=${s.Id}`);
  }
  return lines.join("\n");
}

function renderItemRows(items: Item[], total: number | undefined): string {
  if (!items.length) return "No items.";
  const header = total !== undefined ? `${items.length} of ${total} item(s):` : `${items.length} item(s):`;
  const lines = [header];
  for (const i of items) {
    const series = i.SeriesName ? `${i.SeriesName} - ` : "";
    const year = i.ProductionYear ? ` (${i.ProductionYear})` : "";
    lines.push(`  ${series}${i.Name}${year}  [${i.Type}]  id=${i.Id}`);
  }
  return lines.join("\n");
}

function renderResume(resp: ItemsResponse): string {
  if (!resp.Items.length) return "Nothing in progress.";
  const lines = [`${resp.Items.length} of ${resp.TotalRecordCount} in-progress item(s):`];
  for (const i of resp.Items) {
    const series = i.SeriesName ? `${i.SeriesName} - ` : "";
    const pos = ticksToSeconds(i.UserData?.PlaybackPositionTicks);
    const runtime = ticksToSeconds(i.RunTimeTicks);
    const pct = i.UserData?.PlayedPercentage;
    const at = pos !== null ? `${pos}s${runtime ? `/${runtime}s` : ""}${pct != null ? ` (${Math.round(pct)}%)` : ""}` : "?";
    lines.push(`  ${series}${i.Name} [${i.Type}]  @ ${at}  id=${i.Id}`);
  }
  return lines.join("\n");
}

function renderTasks(tasks: ScheduledTask[]): string {
  if (!tasks.length) return "No scheduled tasks.";
  const lines = [`${tasks.length} task(s):`];
  for (const t of tasks) {
    const last = t.LastExecutionResult?.Status ?? "?";
    const prog = t.CurrentProgressPercentage != null ? ` ${Math.round(t.CurrentProgressPercentage)}%` : "";
    lines.push(`  [${t.State}${prog}] ${t.Name}  last=${last}  id=${t.Id}`);
    if (t.LastExecutionResult?.ErrorMessage) lines.push(`    error: ${t.LastExecutionResult.ErrorMessage}`);
  }
  return lines.join("\n");
}

function renderActivity(log: ActivityLogResponse): string {
  if (!log.Items.length) return "No activity-log entries.";
  const lines = [`${log.Items.length} of ${log.TotalRecordCount} entr${log.Items.length === 1 ? "y" : "ies"}:`];
  for (const e of log.Items) {
    lines.push(`  ${e.Date}  [${e.Severity}] ${e.Type}  ${e.Name}`);
    if (e.ShortOverview) lines.push(`    ${e.ShortOverview}`);
  }
  return lines.join("\n");
}

function renderUserData(d: UserItemData): string {
  return [
    `itemId: ${d.ItemId ?? "(none)"}`,
    `played: ${d.Played ?? false}`,
    `playCount: ${d.PlayCount ?? 0}`,
    `isFavorite: ${d.IsFavorite ?? false}`,
    `playedPercentage: ${d.PlayedPercentage ?? 0}`,
    `resumePositionSeconds: ${ticksToSeconds(d.PlaybackPositionTicks) ?? 0}`,
    `lastPlayedDate: ${d.LastPlayedDate ?? "never"}`,
  ].join("\n");
}

function renderPlaylists(resp: ItemsResponse): string {
  if (!resp.Items.length) return "No playlists.";
  const lines = [`${resp.Items.length} playlist(s):`];
  for (const p of resp.Items) lines.push(`  ${p.Name}  id=${p.Id}`);
  return lines.join("\n");
}

function renderPlaylistItems(resp: ItemsResponse): string {
  if (!resp.Items.length) return "Playlist is empty.";
  const lines = [`${resp.Items.length} item(s):`];
  for (const i of resp.Items) {
    const entryId = (i as { PlaylistItemId?: string }).PlaylistItemId ?? "?";
    const series = i.SeriesName ? `${i.SeriesName} - ` : "";
    lines.push(`  ${series}${i.Name} [${i.Type}]  itemId=${i.Id}  entryId=${entryId}`);
  }
  return lines.join("\n");
}

export interface CliDeps {
  out: (s: string) => void;
  err: (s: string) => void;
  makeClient: () => JellyfinClient;
  startServer: () => Promise<void>;
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const exit = await Effect.runPromiseExit(runEffect(argv, deps));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

const runEffect = (argv: string[], deps: CliDeps): Effect.Effect<number> =>
  Effect.gen(function* () {
    const parsedResult = yield* Effect.either(
      Effect.try({
        try: () => parseArgs(argv),
        catch: (error) => error,
      }),
    );
    if (parsedResult._tag === "Left") {
      const error = parsedResult.left;
      deps.err(error instanceof Error ? error.message : String(error));
      deps.err("");
      deps.err(HELP);
      return 2;
    }
    const parsed = parsedResult.right;

    if (parsed.kind === "help") {
      deps.out(HELP);
      return 0;
    }
    if (parsed.kind === "version") {
      deps.out(VERSION);
      return 0;
    }
    if (parsed.kind === "mcp") {
      // Failures here reject run()'s Promise (same as the prior await path).
      yield* Effect.promise(() => deps.startServer());
      return 0;
    }

    const dispatched = yield* Effect.either(dispatch(parsed, deps));
    if (dispatched._tag === "Left") {
      const error = dispatched.left;
      deps.err(error instanceof Error ? error.message : String(error));
      return 1;
    }
    return dispatched.right;
  });

type DispatchKind = Exclude<Parsed["kind"], "help" | "version" | "mcp">;

function dispatch(
  parsed: Extract<Parsed, { kind: DispatchKind }>,
  deps: CliDeps,
): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    const client = yield* Effect.try({
      try: () => deps.makeClient(),
      catch: (error) => error,
    });
    const emit = (raw: unknown, render: () => string, json: boolean): number => {
      deps.out(json ? JSON.stringify(raw, null, 2) : render());
      return 0;
    };

    switch (parsed.kind) {
      case "status": {
        const r = yield* fromPromise(() => client.getSystemInfo());
        // A reachable Jellyfin always returns a version. Treat a missing/blank
        // version as "not ok" so `status` exits 1 for health-check use.
        const ok = typeof r.Version === "string" && r.Version.length > 0;
        deps.out(parsed.json ? JSON.stringify(r, null, 2) : renderStatus(r));
        return ok ? 0 : 1;
      }
      case "libraries": {
        const r = yield* fromPromise(() => client.listLibraries());
        return emit(r, () => renderLibraries(r), parsed.json);
      }
      case "users": {
        const r = yield* fromPromise(() => client.listUsers());
        return emit(r, () => renderUsers(r), parsed.json);
      }
      case "sessions": {
        const all = yield* fromPromise(() => client.listSessions());
        const r = parsed.activeOnly ? all.filter((s) => s.NowPlayingItem) : all;
        return emit(r, () => renderSessions(r), parsed.json);
      }
      case "search": {
        const r = yield* fromPromise(() =>
          client.searchItems(parsed.query, parsed.types, parsed.limit),
        );
        return emit(r, () => renderItemRows(r.Items, r.TotalRecordCount), parsed.json);
      }
      case "item": {
        const r = yield* fromPromise(() => client.getItem(parsed.itemId, parsed.userId));
        return emit(r, () => renderItemRows([r], undefined), parsed.json);
      }
      case "recent": {
        const r = yield* fromPromise(() => client.getRecentItems(parsed.userId, parsed.limit));
        return emit(r, () => renderItemRows(r, undefined), parsed.json);
      }
      case "resume": {
        const r = yield* fromPromise(() => client.getResumeItems(parsed.userId, parsed.limit));
        return emit(r, () => renderResume(r), parsed.json);
      }
      case "next-up": {
        const r = yield* fromPromise(() =>
          client.getNextUp(parsed.userId, parsed.limit, parsed.seriesId),
        );
        return emit(r, () => renderItemRows(r.Items, r.TotalRecordCount), parsed.json);
      }
      case "similar": {
        const r = yield* fromPromise(() =>
          client.getSimilarItems(parsed.itemId, parsed.userId, parsed.limit),
        );
        return emit(r, () => renderItemRows(r.Items, r.TotalRecordCount), parsed.json);
      }
      case "history": {
        const r = yield* fromPromise(() =>
          client.getWatchHistory(parsed.userId, parsed.limit, 0, parsed.types),
        );
        return emit(r, () => renderItemRows(r.Items, r.TotalRecordCount), parsed.json);
      }
      case "user-data": {
        const raw = yield* fromPromise(() =>
          client.getItemUserData(parsed.userId, parsed.itemId),
        );
        const r = raw ?? {};
        return emit(r, () => renderUserData(r), parsed.json);
      }
      case "activity": {
        const r = yield* fromPromise(() => client.getActivityLog(parsed.limit, parsed.minDate));
        return emit(r, () => renderActivity(r), parsed.json);
      }
      case "tasks": {
        const r = yield* fromPromise(() => client.listScheduledTasks());
        return emit(r, () => renderTasks(r), parsed.json);
      }
      case "playlists": {
        const r = yield* fromPromise(() => client.listPlaylists(parsed.userId));
        return emit(r, () => renderPlaylists(r), parsed.json);
      }
      case "playlist": {
        const r = yield* fromPromise(() =>
          client.getPlaylistItems(parsed.playlistId, parsed.userId),
        );
        return emit(r, () => renderPlaylistItems(r), parsed.json);
      }
    }
  });
}

// True when this module is the process entrypoint. process.argv[1] is often a
// symlink (npm installs the bin as a link); resolve it before comparing.
const isEntrypoint = (() => {
  const arg = process.argv[1];
  if (typeof arg !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  run(process.argv.slice(2), {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    makeClient: () => new JellyfinClient(getConfig()),
    startServer: async () => {
      const { startServer } = await import("./index.js");
      await startServer();
    },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
