#!/usr/bin/env node
// Production dependency audit gate (issue #12).
//
// A blanket `npm audit --omit=dev` stays red on advisories that live in
// transitive dependencies of @modelcontextprotocol/sdk (hono, express, qs,
// proxy-addr, ...), which this repo cannot fix directly. So the gate only
// fails on high or critical advisories filed against a direct runtime
// dependency itself, the class of finding that a version bump here fixes
// (for example the undici advisory in #9).
//
// Transitive findings are still printed as warnings so they stay visible.
// When the SDK ships a release that clears them, bump it like any other
// direct dependency.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
export const DEFAULT_LEVEL = "high";

/**
 * Split an `npm audit --json` report into blocking and warning findings.
 * Blocking: an advisory at or above `level` filed against a direct dependency.
 * Everything else at or above `level` is a warning.
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
      if (vuln.isDirect) {
        blocking.push(finding);
      } else {
        warnings.push(finding);
      }
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
  const { blocking, warnings } = classifyAudit(report, level);

  if (warnings.length > 0) {
    console.log(`Transitive ${level}+ advisories (not gated, see #12):`);
    for (const f of warnings) console.log(formatFinding(f));
  }
  // Everything goes to stdout so CI logs keep the two lists in order.
  if (blocking.length > 0) {
    console.log(`Direct runtime dependencies with ${level}+ advisories:`);
    for (const f of blocking) console.log(formatFinding(f));
    process.exitCode = 1;
    return;
  }
  console.log(`No ${level}+ advisories on direct runtime dependencies.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
