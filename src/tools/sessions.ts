import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import type { JellyfinClient } from "../client.js";
import { fromPromise, toolResult, toToolHandler } from "../effect/tool-adapter.js";
import type { Session } from "../types.js";
import { ok, refuseUnconfirmed, DESTRUCTIVE, NON_DESTRUCTIVE, READ_ONLY } from "./_util.js";

// 1 tick = 100 nanoseconds. 10_000 ticks per millisecond.
const TICKS_PER_MS = 10_000;
const ticksToSeconds = (ticks: number): number => Math.floor(ticks / TICKS_PER_MS / 1000);

function sessionSummary(session: Session): Record<string, unknown> {
  return {
    sessionId: session.Id,
    userId: session.UserId ?? null,
    user: session.UserName ?? null,
    client: session.Client ?? null,
    device: session.DeviceName ?? null,
    nowPlaying: session.NowPlayingItem
      ? {
          itemId: session.NowPlayingItem.Id,
          name: session.NowPlayingItem.Name,
          type: session.NowPlayingItem.Type,
          seriesName: session.NowPlayingItem.SeriesName ?? null,
        }
      : null,
  };
}

function filterSessions(
  sessions: Session[],
  userId: string | undefined,
  activeOnly: boolean,
): Session[] {
  return sessions.filter((session) => {
    if (userId && session.UserId !== userId) return false;
    if (activeOnly && !session.NowPlayingItem) return false;
    return true;
  });
}

function multiSessionPayload(
  action: string,
  sessions: Session[],
  failed: { session: Session; error: string }[],
): Record<string, unknown> {
  const failedIds = new Set(failed.map((failure) => failure.session.Id));
  return {
    action,
    partialFailure: failed.length > 0,
    targetedCount: sessions.length,
    succeededCount: sessions.length - failed.length,
    failedCount: failed.length,
    sessions: sessions
      .filter((session) => !failedIds.has(session.Id))
      .map(sessionSummary),
    failedSessions: failed.map((failure) => ({
      ...sessionSummary(failure.session),
      error: failure.error,
    })),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultWithPartialFailure(payload: Record<string, unknown>) {
  return ok(payload);
}

function runForSessions(
  sessions: Session[],
  action: (session: Session) => Promise<void>,
): Effect.Effect<{ session: Session; error: string }[], never, never> {
  return Effect.promise(() =>
    Promise.all(
      sessions.map(async (session) => {
        try {
          await action(session);
          return null;
        } catch (error) {
          return { session, error: errorMessage(error) };
        }
      }),
    ),
  ).pipe(
    Effect.map((results) =>
      results.filter((result): result is { session: Session; error: string } => result !== null),
    ),
  );
}

export function registerSessionTools(server: McpServer, client: JellyfinClient): void {
  server.tool(
    "jellyfin_list_sessions",
    "List all Jellyfin sessions (connected clients). Shows now-playing item, progress, paused state, user, device, and session ID for use with playback control tools. Set activeOnly=true to omit idle sessions.",
    {
      activeOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, only return sessions with a NowPlayingItem"),
    },
    READ_ONLY,
    toToolHandler(({ activeOnly }) =>
      toolResult(Effect.gen(function* () {
        const sessions = yield* fromPromise(() => client.listSessions());
        const filtered = activeOnly
          ? sessions.filter((s) => s.NowPlayingItem)
          : sessions;
        return ok(
          filtered.map((s) => {
            const item = s.NowPlayingItem;
            const state = s.PlayState;
            const posSec = state?.PositionTicks
              ? ticksToSeconds(state.PositionTicks)
              : 0;
            const totalSec = item?.RunTimeTicks ? ticksToSeconds(item.RunTimeTicks) : 0;
            const pct = totalSec > 0 ? Math.round((posSec / totalSec) * 100) : null;
            return {
              sessionId: s.Id,
              user: s.UserName ?? null,
              client: s.Client ?? null,
              device: s.DeviceName ?? null,
              remoteEndpoint: s.RemoteEndPoint ?? null,
              nowPlaying: item
                ? {
                    itemId: item.Id,
                    name: item.Name,
                    type: item.Type,
                    seriesName: item.SeriesName ?? null,
                    positionSec: posSec,
                    totalSec,
                    percent: pct,
                    isPaused: state?.IsPaused ?? false,
                    playMethod: state?.PlayMethod ?? null,
                  }
                : null,
            };
          }),
        );
      })),
    ),
  );

  server.tool(
    "jellyfin_pause_session",
    "Pause playback on a specific session. Get session IDs from jellyfin_list_sessions. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("pause session");
        yield* fromPromise(() => client.pauseSession(sessionId));
        return ok({ result: `paused session ${sessionId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_resume_session",
    "Resume (unpause) playback on a specific session. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("resume session");
        yield* fromPromise(() => client.resumeSession(sessionId));
        return ok({ result: `resumed session ${sessionId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_stop_session",
    "Stop playback on a specific session (disconnects from the current item). Requires confirm: true.",
    {
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
      confirm: z.boolean().optional().describe("Must be true to proceed with stopping the session."),
    },
    DESTRUCTIVE,
    toToolHandler(({ sessionId, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) {
          return refuseUnconfirmed(`stop session ${sessionId}`);
        }
        yield* fromPromise(() => client.stopSession(sessionId));
        return ok({ result: `stopped session ${sessionId}` });
      })),
    ),
  );
  server.tool(
    "jellyfin_send_message_to_session",
    "Send a text message to a Jellyfin client session. Shows as a toast/dialog on the user's device. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
      text: z.string().min(1).describe("Message body"),
      header: z.string().optional().describe("Optional header/title for the message"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .default(5000)
        .describe("How long the message stays on screen (milliseconds)"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId, text, header, timeoutMs }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("send message to session");
        yield* fromPromise(() => client.sendMessage(sessionId, text, header, timeoutMs));
        return ok({ result: `message sent to session ${sessionId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_seek_session",
    "Seek the active item on a session to a specific position in seconds. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
      positionSec: z.number().nonnegative().describe("Target position in seconds from start"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId, positionSec }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("seek session");
        yield* fromPromise(() => client.seekSession(sessionId, positionSec));
        return ok({ result: `seeked session ${sessionId} to ${positionSec}s` });
      })),
    ),
  );

  server.tool(
    "jellyfin_next_track",
    "Advance to the next track/episode in the session's queue. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("next track");
        yield* fromPromise(() => client.nextTrack(sessionId));
        return ok({ result: `next track on session ${sessionId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_previous_track",
    "Go back to the previous track/episode in the session's queue. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("previous track");
        yield* fromPromise(() => client.previousTrack(sessionId));
        return ok({ result: `previous track on session ${sessionId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_set_volume",
    "Set the playback volume on a session (0-100). Note: only supported by clients that implement the SetVolume general command (most web/desktop/mobile, not all DLNA). Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
      volume: z.number().int().min(0).max(100).describe("Volume level 0-100"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId, volume }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("set volume");
        yield* fromPromise(() => client.sendVolume(sessionId, volume));
        return ok({ result: `volume on session ${sessionId} set to ${volume}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_set_mute",
    "Mute, unmute, or toggle mute on a session. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
      action: z.enum(["mute", "unmute", "toggle"]).describe("Mute action to send"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId, action }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("set mute");
        const cmd = action === "mute" ? "Mute" : action === "unmute" ? "Unmute" : "ToggleMute";
        yield* fromPromise(() => client.sendMuteCommand(sessionId, cmd));
        return ok({ result: `${action} sent to session ${sessionId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_set_audio_stream",
    "Switch the active audio track on a session by stream index. Get valid indices from the item's MediaStreams. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
      index: z.number().int().min(0).describe("Audio stream index"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId, index }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("set audio stream");
        yield* fromPromise(() => client.setAudioStream(sessionId, index));
        return ok({ result: `audio stream set to index ${index} on session ${sessionId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_set_subtitle_stream",
    "Switch the active subtitle track on a session by stream index. Use -1 to disable subtitles. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Session ID from jellyfin_list_sessions"),
      index: z.number().int().min(-1).describe("Subtitle stream index (-1 to disable)"),
    },
    NON_DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId, index }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("set subtitle stream");
        yield* fromPromise(() => client.setSubtitleStream(sessionId, index));
        return ok({ result: `subtitle stream set to index ${index} on session ${sessionId}` });
      })),
    ),
  );

  server.tool(
    "jellyfin_play_on_session",
    "Tell a session to play one or more items (cast/remote-play). Use playCommand=PlayNow to start immediately, PlayNext to queue after current, or PlayLast to queue at the end. Requires confirm: true.",
    {
      confirm: z.boolean().optional().describe("Must be true to proceed."),
      sessionId: z.string().describe("Target session from jellyfin_list_sessions"),
      itemIds: z.array(z.string().min(1)).min(1).describe("Item IDs to play (in order)"),
      playCommand: z
        .enum(["PlayNow", "PlayNext", "PlayLast"])
        .optional()
        .default("PlayNow"),
      startPositionSec: z
        .number()
        .nonnegative()
        .optional()
        .describe("Optional start offset in seconds (only meaningful with PlayNow)"),
    },
    DESTRUCTIVE,
    toToolHandler(({ confirm, sessionId, itemIds, playCommand, startPositionSec }) =>
      toolResult(Effect.gen(function* () {
        if (confirm !== true) return refuseUnconfirmed("play on session");
        yield* fromPromise(() =>
          client.playOnSession(sessionId, itemIds, playCommand, startPositionSec),
        );
        return ok({
          result: `${playCommand} ${itemIds.length} item(s) on session ${sessionId}`,
        });
      })),
    ),
  );

  server.tool(
    "jellyfin_pause_all_sessions",
    "Pause all matching Jellyfin playback sessions. Defaults to active sessions only. Requires confirm: true.",
    {
      userId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional user ID to restrict which sessions are paused."),
      activeOnly: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true, only pause sessions with an active NowPlayingItem."),
      confirm: z.boolean().optional().describe("Must be true to proceed."),
    },
    DESTRUCTIVE,
    toToolHandler(({ userId, activeOnly, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) {
          return refuseUnconfirmed("pause all matching Jellyfin sessions");
        }

        const allSessions = yield* fromPromise(() => client.listSessions());
        const sessions = filterSessions(allSessions, userId, activeOnly);
        const failed = yield* runForSessions(sessions, (session) => client.pauseSession(session.Id));
        const payload = multiSessionPayload("pause", sessions, failed);
        return failed.length > 0 ? resultWithPartialFailure(payload) : ok(payload);
      })),
    ),
  );

  server.tool(
    "jellyfin_stop_all_sessions",
    "Stop all matching Jellyfin playback sessions. Defaults to active sessions only. Requires confirm: true.",
    {
      userId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional user ID to restrict which sessions are stopped."),
      activeOnly: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true, only stop sessions with an active NowPlayingItem."),
      confirm: z.boolean().optional().describe("Must be true to proceed."),
    },
    DESTRUCTIVE,
    toToolHandler(({ userId, activeOnly, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) {
          return refuseUnconfirmed("stop all matching Jellyfin sessions");
        }

        const allSessions = yield* fromPromise(() => client.listSessions());
        const sessions = filterSessions(allSessions, userId, activeOnly);
        const failed = yield* runForSessions(sessions, (session) => client.stopSession(session.Id));
        const payload = multiSessionPayload("stop", sessions, failed);
        return failed.length > 0 ? resultWithPartialFailure(payload) : ok(payload);
      })),
    ),
  );

  server.tool(
    "jellyfin_message_all_active_sessions",
    "Send a message to all matching active Jellyfin sessions. Requires confirm: true.",
    {
      text: z.string().min(1).describe("Message body"),
      header: z.string().optional().describe("Optional header/title for the message"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .default(5000)
        .describe("How long the message stays on screen (milliseconds)"),
      userId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional user ID to restrict which sessions receive the message."),
      confirm: z.boolean().optional().describe("Must be true to proceed."),
    },
    DESTRUCTIVE,
    toToolHandler(({ text, header, timeoutMs, userId, confirm }) =>
      toolResult(Effect.gen(function* () {
        if (!confirm) {
          return refuseUnconfirmed("message all matching active Jellyfin sessions");
        }

        const allSessions = yield* fromPromise(() => client.listSessions());
        const sessions = filterSessions(allSessions, userId, true);
        const failed = yield* runForSessions(sessions, (session) =>
          client.sendMessage(session.Id, text, header, timeoutMs),
        );
        const payload = multiSessionPayload("message", sessions, failed);
        return failed.length > 0 ? resultWithPartialFailure(payload) : ok(payload);
      })),
    ),
  );
}
