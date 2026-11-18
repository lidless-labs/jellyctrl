import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { run } from "../src/cli.js";
import { JellyfinClient } from "../src/client.js";
import type { Item } from "../src/types.js";
import { registerAllTools } from "../src/server.js";

type Tool = {
  schema: z.ZodRawShape;
  call: (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
  }>;
};

const libraryId = "library-example";
const fetchMock = vi.fn();

function setup() {
  const tools = new Map<string, Tool>();
  const server = {
    tool(name: string, _description: string, schema: Tool["schema"], _annotations: unknown, call: Tool["call"]) {
      tools.set(name, { schema, call });
    },
  };
  registerAllTools(server as never, new JellyfinClient({
    url: "http://jellyfin.test",
    apiKey: "test-key",
    timeout: 1000,
    verifySsl: true,
  }));
  return async (name: string, input: Record<string, unknown>) => {
    const tool = tools.get(`jellyfin_${name}`);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const result = await tool.call(z.object(tool.schema).parse(input));
    return { isError: result.isError, payload: JSON.parse(result.content[0].text) };
  };
}

function json(payload: unknown) {
  return new Response(JSON.stringify(payload));
}

function movie(Id: string) {
  return { Id, Name: Id, Type: "Movie" };
}

function mockPages(items: Item[]) {
  fetchMock.mockImplementation(async (url: string) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/Library/VirtualFolders") return json([{ ItemId: libraryId }]);
    expect(pathname).toBe("/Items");
    expect(searchParams.get("parentId")).toBe(libraryId);
    const limit = Number(searchParams.get("limit"));
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(200);
    if (searchParams.get("hasOverview") === "false") {
      expect(searchParams.has("filters")).toBe(false);
      const ids = searchParams.get("ids")?.split(",") ?? [];
      const missing = ids.includes("no-overview") ? [movie("no-overview")] : [];
      return json({ Items: missing, TotalRecordCount: missing.length });
    }
    const types = searchParams.get("includeItemTypes")?.split(",");
    const filtered = types ? items.filter((item) => types.includes(item.Type)) : items;
    const offset = Number(searchParams.get("startIndex"));
    return json({ Items: filtered.slice(offset, offset + limit), TotalRecordCount: filtered.length });
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("library hygiene tools", () => {
  it("lists compact rows and rejects cursors from a different query before fetching", async () => {
    mockPages([
      { ...movie("first"), Path: "/example", Overview: "Summary", ProductionYear: 2026, ProviderIds: { Tmdb: "1" } },
      movie("second"),
    ]);
    const call = setup();
    const query = { libraryId, limit: 1, includeItemTypes: ["Movie"] };
    const { payload } = await call("list_library_items", query);
    expect(payload).toEqual({
      items: [{ id: "first", name: "first", type: "Movie", year: 2026, providerIds: { Tmdb: "1" } }],
      total: 2,
      nextCursor: expect.any(String),
    });
    const calls = fetchMock.mock.calls.length;
    for (const modified of [{ includeItemTypes: ["Episode"] }, { libraryId: "other" }, { includePath: true }, { limit: 2 }]) {
      const result = await call("list_library_items", { ...query, ...modified, cursor: payload.nextCursor });
      expect(result.isError).toBe(true);
      expect(result.payload.error).toMatch(/cursor/i);
    }
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect((await call("list_library_items", { ...query, cursor: payload.nextCursor })).payload)
      .toMatchObject({ items: [{ id: "second" }], nextCursor: null });
    expect((await call("list_library_items", { ...query, includePath: true, includeOverview: true })).payload)
      .toMatchObject({ items: [{ path: "/example", overview: "Summary" }] });
  });

  it("lists 25 items by default and rejects a limit of 201 before fetching", async () => {
    mockPages(Array.from({ length: 30 }, (_, index) => movie(String(index))));
    const call = setup();
    await expect(call("list_library_items", { libraryId, limit: 201 })).rejects.toBeInstanceOf(z.ZodError);
    expect(fetchMock).not.toHaveBeenCalled();
    const { payload } = await call("list_library_items", { libraryId });
    expect(payload.items).toHaveLength(25);
    expect(payload).toMatchObject({ total: 30, nextCursor: expect.any(String) });
  });

  it("counts each missing metadata reason independently", async () => {
    mockPages([
      { ...movie("no-overview"), ProviderIds: { imdb: "tt1" }, ImageTags: { Primary: "tag" } },
      { ...movie("no-image"), ProviderIds: { imdb: "tt2" }, ImageTags: { Backdrop: "tag" } },
      { ...movie("no-provider"), ProviderIds: {}, ImageTags: { Primary: "tag" } },
    ]);
    expect((await setup()("find_missing_metadata", { libraryId })).payload).toEqual({
      counts: { missingOverview: 1, missingPrimaryImage: 1, missingProviderIds: 1 },
      examples: {
        missingOverview: ["no-overview"],
        missingPrimaryImage: ["no-image"],
        missingProviderIds: ["no-provider"],
      },
      scanned: 3,
      complete: true,
      countsAreLowerBounds: false,
      nextCursor: null,
    });
  });

  it("caps metadata scanning and marks partial counts as lower bounds", async () => {
    mockPages(Array.from({ length: 2001 }, (_, index) => movie(String(index))));
    const call = setup();
    const { payload } = await call("find_missing_metadata", { libraryId });
    expect(payload).toMatchObject({
      counts: { missingPrimaryImage: 2000, missingProviderIds: 2000 },
      scanned: 2000,
      complete: false,
      countsAreLowerBounds: true,
      nextCursor: expect.any(String),
    });
    expect(payload.examples.missingProviderIds).toHaveLength(5);
    const calls = fetchMock.mock.calls.length;
    for (const [tool, query] of [
      ["find_duplicates", { libraryId }],
      ["find_missing_metadata", { libraryId, includeItemTypes: ["Episode"] }],
    ] as const) {
      expect(await call(tool, { ...query, cursor: payload.nextCursor })).toMatchObject({
        isError: true, payload: { error: expect.stringMatching(/cursor/i) },
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect((await call("find_missing_metadata", { libraryId, cursor: payload.nextCursor })).payload)
      .toMatchObject({ scanned: 1, complete: true, nextCursor: null });
  });

  it("defaults metadata scans to movies, series and episodes and accepts a type override", async () => {
    mockPages(["Movie", "Series", "Episode", "Season", "Folder"].map((Type) => ({ ...movie(Type), Type })));
    const call = setup();
    expect((await call("find_missing_metadata", { libraryId })).payload).toMatchObject({
      scanned: 3, examples: { missingProviderIds: ["Movie", "Series", "Episode"] },
    });
    expect((await call("find_missing_metadata", { libraryId, includeItemTypes: ["Season"] })).payload).toMatchObject({
      scanned: 1, examples: { missingProviderIds: ["Season"] },
    });
  });

  it("groups provider IDs across pages by type and case-insensitive namespace", async () => {
    mockPages([
      { ...movie("first"), ProviderIds: { Tmdb: "42", TVDB: "42" } },
      ...Array.from({ length: 200 }, (_, index) => movie(String(index))),
      { ...movie("alternate"), ProviderIds: { tmdb: "42" } },
      { ...movie("series"), Type: "Series", ProviderIds: { tmdb: "42" } },
      { ...movie("multi-version"), MediaSourceCount: 2 },
    ]);
    expect((await setup()("find_duplicates", { libraryId })).payload).toEqual({
      providerGroups: 1,
      multiVersionItems: 1,
      examples: [
        { type: "Movie", provider: "tmdb", providerId: "42", ids: ["first", "alternate"], itemCount: 2 },
        { type: "Movie", ids: ["multi-version"], mediaSourceCount: 2 },
      ],
      scanned: 204,
      complete: true,
      countsAreLowerBounds: false,
      nextCursor: null,
    });
  });

  it("groups episode IDs and keeps a multi-version example when provider groups fill the budget", async () => {
    const episodes = Array.from({ length: 6 }, (_, index) => [
      { ...movie(`episode-${index}`), Type: "Episode", ProviderIds: { Tvdb: String(index) }, MediaSourceCount: index === 0 ? 2 : 1 },
      { ...movie(`copy-${index}`), Type: "Episode", ProviderIds: { tvdb: String(index) } },
    ]).flat();
    mockPages(episodes);
    const { payload } = await setup()("find_duplicates", { libraryId });
    expect(payload).toMatchObject({ providerGroups: 6, multiVersionItems: 1 });
    expect(payload.examples).toHaveLength(5);
    expect(payload.examples).toEqual(expect.arrayContaining([
      { type: "Episode", provider: "tvdb", providerId: "0", ids: ["episode-0", "copy-0"], itemCount: 2 },
      { type: "Episode", ids: ["episode-0"], mediaSourceCount: 2 },
    ]));
  });

  it("returns a duplicate scan cursor when the 2000-item cap is reached", async () => {
    mockPages(Array.from({ length: 2001 }, (_, index) => movie(String(index))));
    const call = setup();
    const { payload } = await call("find_duplicates", { libraryId });
    expect(payload).toMatchObject({ scanned: 2000, complete: false, countsAreLowerBounds: true, nextCursor: expect.any(String) });
    expect((await call("find_duplicates", { libraryId, cursor: payload.nextCursor })).payload)
      .toMatchObject({ scanned: 1, complete: true, countsAreLowerBounds: true, nextCursor: null });
  });

  it("continues from the last emitted ID when verbose rows hit the result budget", async () => {
    mockPages(Array.from({ length: 3 }, (_, index) => ({
      ...movie(String(index)), Overview: "a".repeat(40_000),
    })));
    const call = setup();
    const query = { libraryId, includeOverview: true };
    const first = await call("list_library_items", query);
    expect(first.payload.items.map((item: { id: string }) => item.id)).toEqual(["0"]);
    const second = await call("list_library_items", { ...query, cursor: first.payload.nextCursor });
    expect(second.payload.items.map((item: { id: string }) => item.id)).toEqual(["1"]);
  });

  it.each([
    ["library-items", [], { total: 2 }],
    ["missing-metadata", ["--type", "Season"], { counts: { missingProviderIds: 1 }, scanned: 1 }],
    ["duplicates", [], { providerGroups: 0, multiVersionItems: 0 }],
  ] as const)("exposes the %s read as JSON in the CLI", async (command, flags, expected) => {
    mockPages([movie("one"), { ...movie("season"), Type: "Season" }]);
    const out = vi.fn();
    const err = vi.fn();
    expect(await run([command, libraryId, ...flags], {
      out, err,
      makeClient: () => new JellyfinClient({
        url: "http://jellyfin.test", apiKey: "test-key", timeout: 1000, verifySsl: true,
      }),
      startServer: vi.fn(),
    })).toBe(0);
    expect(err).not.toHaveBeenCalled();
    expect(JSON.parse(out.mock.calls[0][0])).toMatchObject(expected);
  });

  it("does not queue a refresh for an item that does not exist", async () => {
    fetchMock.mockResolvedValueOnce(json({ Items: [], TotalRecordCount: 0 }));
    expect(await setup()("refresh_item", { itemId: "missing", confirm: true })).toMatchObject({
      isError: true, payload: { error: expect.stringMatching(/not found/i) },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses refresh without confirmation before looking up the item", async () => {
    expect(await setup()("refresh_item", { itemId: "item-example" })).toMatchObject({
      isError: true,
      payload: { error: expect.stringContaining("confirm: true") },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates item existence and sends both replacement flags as false by default", async () => {
    fetchMock.mockImplementationOnce(async (url: string, request: RequestInit) => {
      const parsed = new URL(url);
      expect(request.method ?? "GET").toBe("GET");
      expect(parsed.pathname).toBe("/Items");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        ids: "item-example", enableUserData: "false", enableImages: "false",
      });
      return json({ Items: [movie("item-example")], TotalRecordCount: 1 });
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await setup()("refresh_item", { itemId: "item-example", confirm: true });
    const parameters = {
      metadataRefreshMode: "FullRefresh",
      imageRefreshMode: "FullRefresh",
      replaceAllMetadata: false,
      replaceAllImages: false,
    };
    expect(result.payload).toEqual({ result: "queued", itemId: "item-example", parameters });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, request] = fetchMock.mock.calls[1];
    expect(request.method).toBe("POST");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/Items/item-example/Refresh");
    expect(Object.fromEntries(parsed.searchParams)).toEqual(
      Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])),
    );
  });
});
