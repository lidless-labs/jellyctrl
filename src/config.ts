import { Effect } from "effect";
import {
  normalizeBaseUrl,
  parseTimeoutSeconds,
  readRequiredEnv,
} from "./effect/config.js";
import { MissingConfigError } from "./effect/errors.js";

export interface JellyfinConfig {
  url: string;
  apiKey: string;
  verifySsl: boolean;
  timeout: number;
}

export type RemoteMode = "observe" | "managed" | "full";

export interface HttpConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  token: string;
  remoteMode: RemoteMode;
}

const requireUrlMessage =
  "JELLYFIN_URL environment variable is required (e.g. http://localhost:8096)";
const requireApiKeyMessage =
  "JELLYFIN_API_KEY environment variable is required. Generate one in Jellyfin: Dashboard > API Keys.";

export function getConfig(): JellyfinConfig {
  const configEffect = Effect.gen(function* () {
    const url = yield* readRequiredEnv(process.env, "JELLYFIN_URL", requireUrlMessage);
    const apiKey = yield* readRequiredEnv(
      process.env,
      "JELLYFIN_API_KEY",
      requireApiKeyMessage,
    );
    const timeoutSeconds = yield* parseTimeoutSeconds(
      process.env.JELLYFIN_TIMEOUT,
      console.error,
    );

    return {
      url: normalizeBaseUrl(url),
      apiKey,
      verifySsl: process.env.JELLYFIN_VERIFY_SSL !== "false",
      timeout: timeoutSeconds * 1000,
    };
  });

  const result = Effect.runSync(Effect.either(configEffect));
  if (result._tag === "Left") {
    const error = result.left;
    if (error instanceof MissingConfigError) {
      throw new Error(error.message);
    }
    throw error;
  }

  return result.right;
}

export function getHttpConfig(): HttpConfig {
  const host = process.env.JELLYFIN_MCP_HTTP_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("JELLYFIN_MCP_HTTP_HOST must be 127.0.0.1 or ::1");
  }
  const rawPort = process.env.JELLYFIN_MCP_HTTP_PORT ?? "3000";
  if (!/^[1-9]\d{0,4}$/.test(rawPort)) {
    throw new Error("JELLYFIN_MCP_HTTP_PORT must be an integer from 1 to 65535");
  }
  const port = Number(rawPort);
  if (port > 65535) throw new Error("JELLYFIN_MCP_HTTP_PORT must be an integer from 1 to 65535");
  // Header values arrive trimmed, so compare against the trimmed secret.
  const token = (process.env.JELLYFIN_MCP_HTTP_TOKEN ?? "").trim();
  if (!token) {
    throw new Error("JELLYFIN_MCP_HTTP_TOKEN environment variable is required");
  }
  if (token.length < 32) throw new Error("JELLYFIN_MCP_HTTP_TOKEN must be at least 32 characters (e.g. openssl rand -hex 32)");
  const remoteMode = process.env.JELLYFIN_MCP_REMOTE_MODE ?? "observe";
  if (remoteMode !== "observe" && remoteMode !== "managed" && remoteMode !== "full") {
    throw new Error("JELLYFIN_MCP_REMOTE_MODE must be observe, managed, or full");
  }
  return { host, port, token, remoteMode };
}
