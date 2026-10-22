import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
// @ts-expect-error plain ESM script without type declarations
import { classifyAudit } from "../scripts/audit-prod.mjs";

const advisory = (name: string, severity: string) => ({
  source: 1,
  name,
  dependency: name,
  title: `${name} advisory`,
  url: `https://github.com/advisories/${name}`,
  severity,
  range: "<1.0.0",
});

describe("classifyAudit", () => {
  it.each(["high", "critical"])("blocks a %s advisory filed against a direct dependency", (severity) => {
    const report = {
      vulnerabilities: {
        undici: { isDirect: true, via: [advisory("undici", severity)] },
      },
    };
    const { blocking, warnings } = classifyAudit(report);
    expect(blocking.map((f: { name: string }) => f.name)).toEqual(["undici"]);
    expect(warnings).toEqual([]);
  });

  it.each(["high", "critical"])("blocks a %s advisory filed against a transitive dependency", (severity) => {
    const report = {
      vulnerabilities: {
        "proxy-addr": { isDirect: false, via: [advisory("proxy-addr", severity)] },
      },
    };
    const { blocking, warnings } = classifyAudit(report);
    expect(blocking.map((f: { name: string }) => f.name)).toEqual(["proxy-addr"]);
    expect(warnings).toEqual([]);
  });

  it.each([true, false])("ignores low and moderate advisories by default (isDirect=%s)", (isDirect) => {
    const report = {
      vulnerabilities: {
        zod: { isDirect, via: [advisory("zod", "low"), advisory("zod", "moderate")] },
      },
    };
    expect(classifyAudit(report)).toEqual({ blocking: [], warnings: [] });
  });

  it.each([true, false])("respects a moderate threshold (isDirect=%s)", (isDirect) => {
    const report = {
      vulnerabilities: {
        zod: { isDirect, via: [advisory("zod", "low"), advisory("zod", "moderate")] },
      },
    };
    const { blocking, warnings } = classifyAudit(report, "moderate");
    expect(blocking).toEqual([expect.objectContaining({ name: "zod", severity: "moderate" })]);
    expect(warnings).toEqual([]);
  });

  it("counts advisory objects once when other packages reference them by name", () => {
    const report = {
      vulnerabilities: {
        "proxy-addr": { isDirect: false, via: [advisory("proxy-addr", "high")] },
        express: { isDirect: false, via: ["proxy-addr"] },
        "@modelcontextprotocol/sdk": { isDirect: true, via: ["express", "proxy-addr"] },
      },
    };
    const { blocking, warnings } = classifyAudit(report);
    expect(blocking).toEqual([expect.objectContaining({ name: "proxy-addr", severity: "high" })]);
    expect(warnings).toEqual([]);
  });

  it("rejects an unknown level", () => {
    expect(() => classifyAudit({ vulnerabilities: {} }, "severe")).toThrow(/Unknown audit level/);
  });
});

describe("resolved dependency floors", () => {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };

  it.each([
    ["proxy-addr", [2, 0, 8]],
    ["fast-uri", [3, 1, 8]],
  ] as const)("keeps every resolved %s version at or above its patched floor", (name, minimum) => {
    const entries = Object.entries(lock.packages).filter(([path]) =>
      path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, entry] of entries) {
      expect(entry.version, path).toMatch(/^\d+\.\d+\.\d+$/);
      const actual = entry.version!.split(".").map(Number);
      const difference = actual[0] - minimum[0] || actual[1] - minimum[1] || actual[2] - minimum[2];
      expect(difference, `${path}@${entry.version} must be >=${minimum.join(".")}`).toBeGreaterThanOrEqual(0);
    }
  });
});
