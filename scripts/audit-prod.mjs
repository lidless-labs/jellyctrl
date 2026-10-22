#!/usr/bin/env node
// Production dependency audit gate for direct and transitive dependencies.
// Blocks advisory objects at or above AUDIT_LEVEL (high by default).
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
export const DEFAULT_LEVEL = "high";

/**
 * Classify an `npm audit --omit=dev --json` report at the requested level.
 * Every advisory at or above `level` blocks, regardless of dependency depth.
 * Lower severities are ignored. The warnings array is retained for callers.
 */
export function classifyAudit(report, level = DEFAULT_LEVEL) {
  const threshold = SEVERITY_RANK[level];
  if (threshold === undefined) {
    throw new Error(`Unknown audit level: ${level}`);
  }
  const blocking = [];
  const warnings = [];
  for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      // String entries point at another package in the report; that package
      // carries its own advisory objects and is classified on its own.
      if (typeof via !== "object" || via === null) continue;
      if ((SEVERITY_RANK[via.severity] ?? 0) < threshold) continue;
      const finding = {
        name,
        severity: via.severity,
        title: via.title,
        url: via.url,
        range: via.range,
      };
      blocking.push(finding);
    }
  }
  return { blocking, warnings };
}

function runAudit() {
  try {
    return execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (error) {
    // npm audit exits non-zero whenever it finds anything; the JSON report
    // is still on stdout.
    if (typeof error.stdout === "string" && error.stdout.length > 0) {
      return error.stdout;
    }
    throw error;
  }
}

function formatFinding(f) {
  return `  ${f.name} (${f.severity}) ${f.title} ${f.url}`;
}

function main() {
  const level = process.env.AUDIT_LEVEL ?? DEFAULT_LEVEL;
  const report = JSON.parse(runAudit());
  if (report.error) {
    console.error(`npm audit failed: ${report.error.summary ?? report.error.code}`);
    process.exit(2);
  }
  const { blocking } = classifyAudit(report, level);

  if (blocking.length > 0) {
    console.log(`Runtime dependencies with ${level}+ advisories:`);
    for (const f of blocking) console.log(formatFinding(f));
    process.exitCode = 1;
    return;
  }
  console.log(`No ${level}+ advisories on runtime dependencies.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
