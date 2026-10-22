import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { JellyfinClient } from "../src/client.js";

const fetchMock = vi.fn();

describe("JellyfinClient", () => {
  let client: JellyfinClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    client = new JellyfinClient({
      url: "http://jellyfin.test",
      apiKey: "test-key",
      verifySsl: true,
      timeout: 5000,
    });
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it.each([
    { limit: undefined, startIndex: undefined, query: "Limit=100&StartIndex=0" },
    { limit: 25, startIndex: 100, query: "Limit=25&StartIndex=100" },
  ])("fetches one playlist page with $query", async ({ limit, startIndex, query }) => {
    const payload = { TotalRecordCount: 350, StartIndex: startIndex ?? 0, Items: [] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload)));

    const result = limit === undefined
      ? await client.getPlaylistItems("pl /1", "u /1")
      : await client.getPlaylistItems("pl /1", "u /1", limit, startIndex);

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `http://jellyfin.test/Playlists/pl%20%2F1/Items?UserId=u+%2F1&${query}`,
      expect.any(Object),
    );
  });

  it.each([
    [0, 0], [101, 0], [1.5, 0], [100, -1], [100, 0.5],
  ])("rejects invalid client playlist bounds %s/%s before fetching", async (limit, startIndex) => {
    await expect(client.getPlaylistItems("pl1", "u1", limit, startIndex)).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the MediaBrowser Authorization token on requests", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ServerName: "Test", Version: "12.0.0", Id: "abc" }), {
        status: 200,
      }),
    );

    await client.getSystemInfo();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/System/Info");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe('MediaBrowser Token="test-key"');
  });

  it("surfaces 401 with a clear message", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    await expect(client.getSystemInfo()).rejects.toThrow(/Invalid API key/);
  });

  it("returns a fixed public parse error without response content or query secrets", async () => {
    fetchMock.mockResolvedValueOnce(new Response("PRIVATE_RESPONSE_MARKER", { status: 200 }));

    const error = await client.authorizeQuickConnect("PRIVATE_QUERY_MARKER", "u1")
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Jellyfin returned invalid JSON");
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).stack).not.toContain("PRIVATE_");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    new TypeError("fetch failed: http://jellyfin.test?code=PRIVATE_QUERY_MARKER", {
      cause: new Error("PRIVATE_CAUSE_MARKER"),
    }),
    "PRIVATE_TRANSPORT_MARKER",
  ])("returns a fixed public transport error for rejection %#", async (cause) => {
    fetchMock.mockRejectedValueOnce(cause);

    const error = await client.authorizeQuickConnect("PRIVATE_QUERY_MARKER", "u1")
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Unable to connect to Jellyfin");
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).stack).not.toContain("PRIVATE_");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redacts transport failures while reading a successful response body", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(new Error("PRIVATE_BODY_READ_MARKER")); },
    }));
    fetchMock.mockResolvedValueOnce(response);

    await expect(client.getSystemInfo()).rejects.toThrow("Unable to connect to Jellyfin");
  });

  it.each(["GET", "POST"])("rejects redirects at the fetch boundary for %s without retrying", async (method) => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: unexpected redirect"));

    const request = method === "GET"
      ? client.getSystemInfo()
      : client.authorizeQuickConnect("code", "u1");
    await expect(request).rejects.toBeInstanceOf(Error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.redirect).toBe("error");
    expect(init.headers["Authorization"]).toBe('MediaBrowser Token="test-key"');
    expect(init.method ?? "GET").toBe(method);
  });

  it("preserves timeout errors and releases the request timer", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(new DOMException("PRIVATE_ABORT_MARKER", "AbortError")),
          );
        }),
      );
      const error = client.getSystemInfo().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5000);

      expect((await error as Error).message).toBe("Request to /System/Info timed out after 5000ms");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([401, 403, 404, 500, 502])("keeps HTTP %s errors and stderr free of response bodies and query values", async (status) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const cancel = vi.fn();
    let chunk = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (chunk++ === 0) controller.enqueue(new TextEncoder().encode("example-response-marker"));
        else controller.close();
      },
      cancel,
    }, { highWaterMark: 0 }), { status });
    fetchMock.mockResolvedValueOnce(response);
    try {
      const error = await client.authorizeQuickConnect("example-query-marker", "user-example").catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`HTTP ${status}`);
      expect(String(error)).not.toContain("?");
      expect(String(error)).not.toContain("example-");
      expect(stderr).toHaveBeenCalledExactlyOnceWith(`jellyfin-mcp: upstream request failed (HTTP ${status})`);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { stderr.mockRestore(); }
  });

  it("scopes TLS-skip to the Jellyfin connection via a per-request dispatcher", async () => {
    const insecure = new JellyfinClient({
      url: "https://jellyfin.test",
      apiKey: "test-key",
      verifySsl: false,
      timeout: 5000,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ServerName: "Test" }), { status: 200 }),
    );

    await insecure.getSystemInfo();

    const [, opts] = fetchMock.mock.calls[0];
    // A confined undici dispatcher is passed (never the process-global
    // NODE_TLS_REJECT_UNAUTHORIZED), and the default client passes none.
    expect((opts as { dispatcher?: unknown }).dispatcher).toBeDefined();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe("0");
  });

  it("closes its private TLS-skip dispatcher only once", async () => {
    const insecure = new JellyfinClient({
      url: "https://jellyfin.test",
      apiKey: "test-key",
      verifySsl: false,
      timeout: 5000,
    });
    const close = vi.fn(async () => {});
    (insecure as unknown as { dispatcher?: { close: () => Promise<void> } }).dispatcher = { close };

    await insecure.close();
    await insecure.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it("passes no dispatcher when TLS verification is enabled (secure default)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ServerName: "Test" }), { status: 200 }),
    );
    await client.getSystemInfo();
    const [, opts] = fetchMock.mock.calls[0];
    expect((opts as { dispatcher?: unknown }).dispatcher).toBeUndefined();
  });

  it("url-encodes session IDs on playback control", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.pauseSession("abc/def 123");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Sessions/abc%2Fdef%20123/Playing/Pause");
  });

  it("handles 204 No Content from playback control endpoints", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.stopSession("session-1")).resolves.toBeUndefined();
  });

  it("passes scan libraryId as query param", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.scanLibraries("lib-abc");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Library/Refresh?libraryId=lib-abc");
  });

  it("omits libraryId when scanning all", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.scanLibraries();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Library/Refresh");
  });

  it("converts seek seconds to ticks (10M ticks/sec)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.seekSession("s1", 120);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Sessions/s1/Playing/Seek?seekPositionTicks=1200000000");
  });

  it("sends SetVolume as a stringified integer in Arguments", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.sendVolume("s1", 42);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Sessions/s1/Command");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ Name: "SetVolume", Arguments: { Volume: "42" } });
  });

  it("playOnSession joins itemIds and defaults playCommand to PlayNow", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.playOnSession("s1", ["a", "b", "c"]);
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Sessions/s1/Playing");
    expect(parsed.searchParams.get("itemIds")).toBe("a,b,c");
    expect(parsed.searchParams.get("playCommand")).toBe("PlayNow");
    expect(parsed.searchParams.get("startPositionTicks")).toBeNull();
  });

  it("playOnSession converts startPositionSec to ticks", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.playOnSession("s1", ["a"], "PlayNow", 5);
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("startPositionTicks")).toBe("50000000");
  });

  it("markPlayed POSTs the user/item path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.markPlayed("u1", "i1");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Users/u1/PlayedItems/i1");
    expect(opts.method).toBe("POST");
  });

  it("unsetFavorite DELETEs the user/item favorite path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.unsetFavorite("u1", "i1");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Users/u1/FavoriteItems/i1");
    expect(opts.method).toBe("DELETE");
  });

  it("getItemUserData reads user-scoped item data", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ PlaybackPositionTicks: 123 }), { status: 200 }),
    );
    const result = await client.getItemUserData("user/1", "item/1");
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/UserItems/item%2F1/UserData");
    expect(parsed.searchParams.get("userId")).toBe("user/1");
    expect(result.PlaybackPositionTicks).toBe(123);
  });

  it("getItemUserData falls back to the legacy user path on 404", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ PlaybackPositionTicks: 456 }), { status: 200 }),
      );
    const result = await client.getItemUserData("u1", "i1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [fallbackUrl] = fetchMock.mock.calls[1];
    expect(fallbackUrl).toBe("http://jellyfin.test/Users/u1/Items/i1/UserData");
    expect(result?.PlaybackPositionTicks).toBe(456);
  });

  it("getItemUserData keeps the modern 404 when the legacy fallback also 404s", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("modern missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("legacy missing", { status: 404 }));
    await expect(client.getItemUserData("u1", "missing")).rejects.toThrow(
      "/UserItems/missing/UserData",
    );
  });

  it("getItem reads a single item with userId as a query param", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Id: "item/1", Name: "Movie" }), { status: 200 }),
    );
    const result = await client.getItem("item/1", "user/1");
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Items/item%2F1");
    expect(parsed.searchParams.get("userId")).toBe("user/1");
    expect(result.Id).toBe("item/1");
  });

  it("getItem falls back to the legacy user path on 404", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Id: "i1", Name: "Legacy" }), { status: 200 }),
      );
    const result = await client.getItem("i1", "u1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [fallbackUrl] = fetchMock.mock.calls[1];
    expect(fallbackUrl).toBe("http://jellyfin.test/Users/u1/Items/i1");
    expect(result.Name).toBe("Legacy");
  });

  it("getItem keeps the modern 404 when the legacy fallback also 404s", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("modern missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("legacy missing", { status: 404 }));
    await expect(client.getItem("missing", "u1")).rejects.toThrow(
      "/Items/missing",
    );
  });

  it("getItem does not fall back on HTTP 400", async () => {
    fetchMock.mockResolvedValueOnce(new Response("needs user context", { status: 400 }));
    await expect(client.getItem("i1", "u1")).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("updateItemUserData POSTs the user data body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ PlaybackPositionTicks: 0 }), { status: 200 }),
    );
    await client.updateItemUserData("u1", "i1", {
      ItemId: "i1",
      PlaybackPositionTicks: 0,
      IsFavorite: true,
    });
    const [url, opts] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/UserItems/i1/UserData");
    expect(parsed.searchParams.get("userId")).toBe("u1");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({
      ItemId: "i1",
      PlaybackPositionTicks: 0,
      IsFavorite: true,
    });
  });

  it("updateItemUserData falls back to the legacy user path on 404", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.updateItemUserData("u1", "i1", {
      ItemId: "i1",
      PlaybackPositionTicks: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [fallbackUrl, opts] = fetchMock.mock.calls[1];
    expect(fallbackUrl).toBe("http://jellyfin.test/Users/u1/Items/i1/UserData");
    expect(opts.method).toBe("POST");
  });

  it("clearPlaybackPosition preserves user data while zeroing resume ticks", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ItemId: "i1",
            PlaybackPositionTicks: 9000,
            PlayedPercentage: 30,
            IsFavorite: true,
            Played: false,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ PlaybackPositionTicks: 0 }), { status: 200 }),
      );

    await client.clearPlaybackPosition("u1", "i1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, opts] = fetchMock.mock.calls[1];
    expect(JSON.parse(opts.body as string)).toEqual({
      ItemId: "i1",
      PlaybackPositionTicks: 0,
      PlayedPercentage: 0,
      IsFavorite: true,
      Played: false,
    });
  });

  it("clearPlaybackPosition tolerates an empty user data response", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client.clearPlaybackPosition("u1", "i1");

    const [, opts] = fetchMock.mock.calls[1];
    expect(JSON.parse(opts.body as string)).toEqual({
      ItemId: "i1",
      PlaybackPositionTicks: 0,
      PlayedPercentage: 0,
    });
  });

  it("setPlaybackPosition sets ticks and derives played percentage when runtime is known", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ItemId: "i1" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ PlaybackPositionTicks: 30_000_000 }), { status: 200 }),
      );

    await client.setPlaybackPosition("u1", "i1", 3, undefined, 100_000_000);

    const [, opts] = fetchMock.mock.calls[1];
    expect(JSON.parse(opts.body as string)).toEqual({
      ItemId: "i1",
      PlaybackPositionTicks: 30_000_000,
      PlayedPercentage: 30,
    });
  });

  it("setPlaybackPosition clamps positions beyond runtime to the last runtime tick", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ItemId: "i1" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ PlaybackPositionTicks: 99_999_999 }), { status: 200 }),
      );

    await client.setPlaybackPosition("u1", "i1", 20, undefined, 100_000_000);

    const [, opts] = fetchMock.mock.calls[1];
    const body = JSON.parse(opts.body as string);
    expect(body.ItemId).toBe("i1");
    expect(body.PlaybackPositionTicks).toBe(99_999_999);
    expect(body.PlayedPercentage).toBeCloseTo(99.999999);
  });

  it("createPlaylist POSTs JSON body with Name/UserId/Ids", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Id: "pl1", Name: "Mix" }), { status: 200 }),
    );
    const result = await client.createPlaylist("Mix", "u1", ["a", "b"]);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Playlists");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ Name: "Mix", UserId: "u1", Ids: ["a", "b"] });
    expect(result.Id).toBe("pl1");
  });

  it("createPlaylist includes MediaType when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Id: "pl1" }), { status: 200 }),
    );
    await client.createPlaylist("Empty", "u1", [], "Audio");
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body.MediaType).toBe("Audio");
  });

  it("removeFromPlaylist passes EntryIds (not item IDs)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.removeFromPlaylist("pl1", ["entry-1", "entry-2"]);
    const [url, opts] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Playlists/pl1/Items");
    expect(parsed.searchParams.get("EntryIds")).toBe("entry-1,entry-2");
    expect(opts.method).toBe("DELETE");
  });

  it("setAudioStream goes through /Command (general command, not playstate)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.setAudioStream("s1", 2);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Sessions/s1/Command");
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ Name: "SetAudioStreamIndex", Arguments: { Index: "2" } });
  });

  it("setSubtitleStream supports -1 to disable subtitles", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.setSubtitleStream("s1", -1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/Sessions/s1/Command");
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ Name: "SetSubtitleStreamIndex", Arguments: { Index: "-1" } });
  });

  it("createCollection omits Ids when empty", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Id: "c1" }), { status: 200 }),
    );
    await client.createCollection("Best of");
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Collections");
    expect(parsed.searchParams.get("Name")).toBe("Best of");
    expect(parsed.searchParams.get("Ids")).toBeNull();
  });

  it("getResumeItems hits per-user Resume path", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ Items: [{ Id: "i1", Name: "Ep", Type: "Episode" }], TotalRecordCount: 1 }),
        { status: 200 },
      ),
    );
    const result = await client.getResumeItems("user-42", 10);
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Users/user-42/Items/Resume");
    expect(parsed.searchParams.get("Limit")).toBe("10");
    expect(parsed.searchParams.get("StartIndex")).toBe("0");
    expect(result.Items[0].Id).toBe("i1");
  });

  it("getWatchHistory fetches played user items sorted by DatePlayed", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 }),
    );
    await client.getWatchHistory("user-42", 15, 5, "Movie,Episode");
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Users/user-42/Items");
    expect(parsed.searchParams.get("Filters")).toBe("IsPlayed");
    expect(parsed.searchParams.get("SortBy")).toBe("DatePlayed");
    expect(parsed.searchParams.get("SortOrder")).toBe("Descending");
    expect(parsed.searchParams.get("IncludeItemTypes")).toBe("Movie,Episode");
    expect(parsed.searchParams.get("Limit")).toBe("15");
    expect(parsed.searchParams.get("StartIndex")).toBe("5");
  });

  it("getFavoriteItems hits per-user Items path with IsFavorite filter", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 }),
    );
    await client.getFavoriteItems("user-42");
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Users/user-42/Items");
    expect(parsed.searchParams.get("Filters")).toBe("IsFavorite");
    expect(parsed.searchParams.get("Recursive")).toBe("true");
    expect(parsed.searchParams.get("IncludeItemTypes")).toBeNull();
    expect(parsed.searchParams.get("Limit")).toBe("20");
    expect(parsed.searchParams.get("StartIndex")).toBe("0");
    expect(parsed.searchParams.get("Fields")).toBe("SeriesName,SeriesId,ProductionYear,UserData");
  });

  it("getFavoriteItems uses the caller-supplied IncludeItemTypes when given", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 }),
    );
    await client.getFavoriteItems("user-42", 50, 10, ["Series", "Episode"]);
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("IncludeItemTypes")).toBe("Series,Episode");
    expect(parsed.searchParams.get("Limit")).toBe("50");
    expect(parsed.searchParams.get("StartIndex")).toBe("10");
  });

  it("getFavoriteItems URL-encodes the userId into the path", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 }),
    );
    await client.getFavoriteItems("user/with space", 5);
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Users/user%2Fwith%20space/Items");
  });

  it("getResumeItems accepts a start index for pagination", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 }),
    );
    await client.getResumeItems("user-42", 25, 50);
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("Limit")).toBe("25");
    expect(parsed.searchParams.get("StartIndex")).toBe("50");
  });

  it("getResumeItems URL-encodes the userId into the path", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 }),
    );
    await client.getResumeItems("user/with space", 5);
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Users/user%2Fwith%20space/Items/Resume");
  });

  it("getNextUp sends userId as a query param (not a path segment)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 }),
    );
    await client.getNextUp("user-42", 5);
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Shows/NextUp");
    expect(parsed.searchParams.get("userId")).toBe("user-42");
    expect(parsed.searchParams.get("Limit")).toBe("5");
    expect(parsed.searchParams.get("seriesId")).toBeNull();
  });

  it("getNextUp includes seriesId when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 }),
    );
    await client.getNextUp("user-42", 5, "series-abc");
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("seriesId")).toBe("series-abc");
  });

  it("getSimilarItems URL-encodes the itemId and omits userId when absent", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 }),
    );
    await client.getSimilarItems("item/with space", undefined, 15);
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/Items/item%2Fwith%20space/Similar");
    expect(parsed.searchParams.get("Limit")).toBe("15");
    expect(parsed.searchParams.get("userId")).toBeNull();
  });

  it("getSimilarItems includes userId when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Items: [], TotalRecordCount: 0 }), { status: 200 }),
    );
    await client.getSimilarItems("item1", "user-42");
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("userId")).toBe("user-42");
  });

  it("getQuickConnectEnabled parses a boolean body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("true", { status: 200 }));
    await expect(client.getQuickConnectEnabled()).resolves.toBe(true);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://jellyfin.test/QuickConnect/Enabled");
  });

  it("authorizeQuickConnect POSTs code + userId as query params", async () => {
    fetchMock.mockResolvedValueOnce(new Response("true", { status: 200 }));
    await client.authorizeQuickConnect("ABC123", "user-42");
    const [url, opts] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/QuickConnect/Authorize");
    expect(parsed.searchParams.get("code")).toBe("ABC123");
    expect(parsed.searchParams.get("userId")).toBe("user-42");
    expect(opts.method).toBe("POST");
  });

  it("authorizeQuickConnect URL-encodes code and userId (reserved chars)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("true", { status: 200 }));
    // URLSearchParams encodes with + for spaces; verify the server sees the
    // original values via .get() rather than string-matching the raw URL.
    await client.authorizeQuickConnect("A B&C=D", "user/42?x");
    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("code")).toBe("A B&C=D");
    expect(parsed.searchParams.get("userId")).toBe("user/42?x");
  });
});

describe("bounded upstream response reads", () => {
  const cap = 2 * 1024 * 1024;
  const config = { url: "http://jellyfin.example", apiKey: "example-key", verifySsl: true, timeout: 5000 };

  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("rejects oversized content-length before reading and cancels the body", async () => {
    const cancel = vi.fn();
    let chunk = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (chunk++ === 0) controller.enqueue(new TextEncoder().encode("true"));
        else controller.close();
      },
      cancel,
    }, { highWaterMark: 0 }), { headers: { "content-length": String(cap + 1) } });
    const getReader = vi.spyOn(response.body!, "getReader");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(new JellyfinClient(config).getQuickConnectEnabled()).rejects.toThrow("Jellyfin response exceeds the 2097152-byte limit");
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
  });

  it.each([undefined, "1"])("counts streamed UTF-8 bytes despite content-length %s and cancels on overflow", async (length) => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode(JSON.stringify("é".repeat(cap / 2)));
    let chunk = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (chunk === 0) controller.enqueue(bytes.subarray(0, cap));
        else if (chunk === 1) controller.enqueue(bytes.subarray(cap));
        else controller.close();
        chunk++;
      },
      cancel,
    }, { highWaterMark: 0 }), { headers: length ? { "content-length": length } : {} });
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init: RequestInit) => { signal = init.signal; return Promise.resolve(response); }));
    const result = new JellyfinClient(config).getSystemInfo().catch((error: Error) => error);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Jellyfin response exceeds the 2097152-byte limit");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });

  it("accepts JSON at the exact byte limit across UTF-8 chunk boundaries", async () => {
    const value = "é".repeat((cap - 2) / 2);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, 2));
      controller.enqueue(bytes.subarray(2, 13));
      controller.enqueue(bytes.subarray(13));
      controller.close();
    } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(new JellyfinClient(config).getSystemInfo()).resolves.toBe(value);
  });

  it("cancels unused successful write response bodies without reading", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const getReader = vi.spyOn(response.body!, "getReader");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(new JellyfinClient(config).pauseSession("session-example")).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
  });

  it("cancels a pending successful body read even when the stream ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pull = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }));
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const result = new JellyfinClient(config)
      .getPlaylistItems("playlist-example", "example-query-marker")
      .catch((error: Error) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(pull).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await result).toMatchObject({ message: "Request to /Playlists/playlist-example/Items timed out after 5000ms" });
    expect(response.body!.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the whole-body deadline active without query secrets", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init: RequestInit) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(" "));
        init.signal!.addEventListener("abort", () => controller.error(new DOMException("example-abort", "AbortError")));
      },
    })))));
    const result = new JellyfinClient(config).authorizeQuickConnect("example-query-marker", "user-example").catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ message: "Request to /QuickConnect/Authorize timed out after 5000ms" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
