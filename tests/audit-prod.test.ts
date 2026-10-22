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
  it("blocks a high advisory filed against a direct dependency", () => {
    const report = {
      vulnerabilities: {
        undici: { isDirect: true, via: [advisory("undici", "high")] },
      },
    };
    const { blocking, warnings } = classifyAudit(report);
    expect(blocking.map((f: { name: string }) => f.name)).toEqual(["undici"]);
    expect(warnings).toEqual([]);
  });

  it("only warns on transitive advisories, even critical ones", () => {
    const report = {
      vulnerabilities: {
        "proxy-addr": { isDirect: false, via: [advisory("proxy-addr", "critical")] },
        "@modelcontextprotocol/sdk": { isDirect: true, via: ["express", "hono"] },
      },
    };
    const { blocking, warnings } = classifyAudit(report);
    expect(blocking).toEqual([]);
    expect(warnings.map((f: { name: string }) => f.name)).toEqual(["proxy-addr"]);
  });

  it("ignores direct advisories below the level", () => {
    const report = {
      vulnerabilities: {
        zod: { isDirect: true, via: [advisory("zod", "moderate")] },
      },
    };
    expect(classifyAudit(report).blocking).toEqual([]);
    expect(classifyAudit(report, "moderate").blocking).toHaveLength(1);
  });

  it("rejects an unknown level", () => {
    expect(() => classifyAudit({ vulnerabilities: {} }, "severe")).toThrow(/Unknown audit level/);
  });
});
