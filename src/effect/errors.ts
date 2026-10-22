import { Data } from "effect";

/**
 * Jellyfin-specific tagged errors. Kit `OperatorError` uses different tags and
 * field shapes (method/path vs path/summary); client and request contracts pin
 * these classes, so they stay repo-local rather than aliasing kit errors.
 */
export class MissingConfigError extends Data.TaggedError("MissingConfigError")<{
  readonly variable: string;
  readonly message: string;
}> {}

export class InvalidTimeoutError extends Data.TaggedError("InvalidTimeoutError")<{
  readonly raw: string;
  readonly fallbackSeconds: number;
}> {}

export class JellyfinHttpError extends Data.TaggedError("JellyfinHttpError")<{
  readonly path: string;
  readonly status: number;
  readonly summary: string;
}> {}

export class JellyfinTimeoutError extends Data.TaggedError("JellyfinTimeoutError")<{
  readonly path: string;
  readonly timeout: number;
}> {}

export class JellyfinTransportError extends Data.TaggedError("JellyfinTransportError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class JellyfinParseError extends Data.TaggedError("JellyfinParseError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export class JellyfinResponseSizeError extends Data.TaggedError("JellyfinResponseSizeError")<{
  readonly limit: number;
}> {}

export type ConfigEffectError = MissingConfigError | InvalidTimeoutError;

export type JellyfinRequestError =
  | JellyfinHttpError
  | JellyfinTimeoutError
  | JellyfinTransportError
  | JellyfinParseError
  | JellyfinResponseSizeError;
