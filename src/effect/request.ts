import { Effect } from "effect";
import {
  JellyfinHttpError,
  JellyfinParseError,
  JellyfinTimeoutError,
  JellyfinTransportError,
} from "./errors.js";

export interface FetchRequestInput {
  readonly url: string;
  readonly path: string;
  readonly init: RequestInit;
  readonly timeout: number;
  readonly fetchImpl?: typeof fetch;
}

export const fetchWithTimeout = ({
  url,
  path,
  init,
  timeout,
  fetchImpl = fetch,
}: FetchRequestInput) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      return { controller, timeoutId };
    }),
    ({ controller }) =>
      Effect.tryPromise({
        try: () => fetchImpl(url, { ...init, signal: controller.signal }),
        catch: (cause) =>
          cause instanceof Error && cause.name === "AbortError"
            ? new JellyfinTimeoutError({ path, timeout })
            : new JellyfinTransportError({ path, cause }),
      }),
    ({ timeoutId }) => Effect.sync(() => clearTimeout(timeoutId)),
  );

export const mapHttpError = (requestPath: string, response: Response) => {
  const path = requestPath.split("?")[0];
  const messages: Record<number, string> = {
    401: "Invalid API key or unauthorized access",
    403: "Forbidden - API key lacks permission for this operation",
    404: `Resource not found: ${path}`,
    500: "Jellyfin server error",
  };
  const summary = messages[response.status] ?? `HTTP ${response.status}`;
  return new JellyfinHttpError({
    path,
    status: response.status,
    summary,
  });
};

export const parseJsonResponse = <T>(path: string, text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as T,
    catch: (cause) => new JellyfinParseError({ path, cause }),
  });
