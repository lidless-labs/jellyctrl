import { Effect } from "effect";
import { fromProcessEnv } from "@lidless-labs/effect-operator-kit";
import { InvalidTimeoutError, MissingConfigError } from "./errors.js";

export const DEFAULT_TIMEOUT_SECONDS = 30;

export interface ConfigInput {
  readonly env: NodeJS.ProcessEnv;
  readonly warn: (message: string) => void;
}

/**
 * Kit `requiredString` trims values and uses `${key} is required`. Jellyfin env
 * parsing keeps raw values (including trailing spaces) and repo-specific messages.
 */
export const readRequiredEnv = (
  env: NodeJS.ProcessEnv,
  variable: string,
  message: string,
) => {
  const reader = fromProcessEnv(env);
  return Effect.sync(() => reader.get(variable)).pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(new MissingConfigError({ variable, message })),
    ),
  );
};

/**
 * Kit `parseTimeoutEnv` fails on invalid values. Jellyfin warns on stderr and
 * returns DEFAULT_TIMEOUT_SECONDS instead.
 */
export const parseTimeoutSeconds = (
  raw: string | undefined,
  warn: (message: string) => void,
) =>
  Effect.gen(function* () {
    if (raw === undefined || raw.trim() === "") {
      return DEFAULT_TIMEOUT_SECONDS;
    }

    const parsed = Number(raw);
    const milliseconds = parsed * 1000;
    if (Number.isFinite(milliseconds) && milliseconds >= 1 && milliseconds <= 2_147_483_647) {
      return parsed;
    }

    const error = new InvalidTimeoutError({
      raw,
      fallbackSeconds: DEFAULT_TIMEOUT_SECONDS,
    });
    warn(formatInvalidTimeoutWarning(error));
    return DEFAULT_TIMEOUT_SECONDS;
  });

/**
 * Kit `normalizeBaseUrl` returns a URL object with pathname merging. Jellyfin
 * only strips trailing slashes on the configured base URL string.
 */
export const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, "");

export const formatInvalidTimeoutWarning = (error: InvalidTimeoutError): string =>
  `jellyfin-mcp: invalid JELLYFIN_TIMEOUT "${error.raw}" (expected a positive number of seconds); using default ${error.fallbackSeconds}s`;
