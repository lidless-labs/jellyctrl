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

export const MIN_HTTP_TOKEN_LENGTH = 32;

export interface HttpConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  token?: string;
  remoteMode: RemoteMode;
  scopedTokens?: Partial<Record<RemoteMode, string>>;
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

function readHttpToken(name: string): string | undefined {
  // Header values arrive trimmed, so compare against the trimmed secret.
  const token = process.env[name]?.trim();
  if (token !== undefined && token.length < MIN_HTTP_TOKEN_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_HTTP_TOKEN_LENGTH} characters (e.g. openssl rand -hex 32)`);
  }
  return token;
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
  const token = readHttpToken("JELLYFIN_MCP_HTTP_TOKEN");
  const scopedTokens = {
    observe: readHttpToken("JELLYFIN_MCP_HTTP_TOKEN_READ"),
    managed: readHttpToken("JELLYFIN_MCP_HTTP_TOKEN_ROUTINE"),
    full: readHttpToken("JELLYFIN_MCP_HTTP_TOKEN_HIGH_IMPACT"),
  };
  if (token === undefined && Object.values(scopedTokens).every((value) => value === undefined)) {
    throw new Error("At least one JELLYFIN_MCP_HTTP_TOKEN or scoped HTTP token is required");
  }
  const remoteMode = process.env.JELLYFIN_MCP_REMOTE_MODE ?? "observe";
  if (remoteMode !== "observe" && remoteMode !== "managed" && remoteMode !== "full") {
    throw new Error("JELLYFIN_MCP_REMOTE_MODE must be observe, managed, or full");
  }
  return { host, port, token, remoteMode, scopedTokens };
}
