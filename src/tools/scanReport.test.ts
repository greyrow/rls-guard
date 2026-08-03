import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeScanReport, applyResolution } from "./scanReport.js";
import type { AppCrudFinding, AppScanReport } from "../types.js";

function finding(overrides: Partial<AppCrudFinding>): AppCrudFinding {
  return {
    table: "posts",
    action: "select",
    riskLevel: "critical",
    urgency: "now",
    summary: "unrestricted select",
    recommendation: "tighten it",
    callSites: [{ file: "a.ts", line: 1, table: "posts", action: "select", raw: "..." }],
    evidence: { rlsEnabled: true, hasPolicyForAction: true, policyUsesUnrestrictedUsing: true },
    autoFixable: true,
    status: "open",
    detectedInLastScan: true,
    ...overrides,
  };
}

function report(findings: AppCrudFinding[]): AppScanReport {
  return { generatedAt: "2026-01-01T00:00:00.000Z", appDir: "./src", databaseName: "db", findings, summary: { critical: 0, high: 0, medium: 0, low: 0 } };
}

test("no prior report: fresh findings pass through unchanged, all open", () => {
  const fresh = [finding({})];
  const merged = mergeScanReport(fresh, null);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "open");
  assert.equal(merged[0].detectedInLastScan, true);
});

test("resolved finding still present unchanged (same risk + summary) stays resolved", () => {
  const prior = report([finding({ status: "resolved", resolvedAt: "2026-01-01T00:00:00.000Z", comment: "fixed the policy" })]);
  const fresh = [finding({ status: "open" })]; // fresh scan always starts a finding as "open"

  const merged = mergeScanReport(fresh, prior);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "resolved");
  assert.equal(merged[0].comment, "fixed the policy");
  assert.equal(merged[0].detectedInLastScan, true);
});

test("resolved finding whose risk level changed reopens (not the same issue anymore)", () => {
  const prior = report([finding({ status: "resolved", riskLevel: "critical", comment: "fixed the policy" })]);
  // same table+action, but now shows up as "high" instead of "critical" — e.g. the
  // policy exists but a different problem was introduced.
  const fresh = [finding({ status: "open", riskLevel: "high", summary: "no policy at all now" })];

  const merged = mergeScanReport(fresh, prior);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "open");
  assert.equal(merged[0].comment, undefined);
});

test("resolved finding whose summary changed (same risk level) also reopens", () => {
  const prior = report([finding({ status: "resolved", summary: "unrestricted select" })]);
  const fresh = [finding({ status: "open", summary: "a differently-worded finding at the same risk level" })];

  const merged = mergeScanReport(fresh, prior);

  assert.equal(merged[0].status, "open");
});

test("resolved finding no longer detected at all is kept as a historical record", () => {
  const prior = report([finding({ status: "resolved", comment: "removed the dead endpoint" })]);
  const fresh: AppCrudFinding[] = []; // nothing detected this scan

  const merged = mergeScanReport(fresh, prior);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "resolved");
  assert.equal(merged[0].detectedInLastScan, false);
  assert.equal(merged[0].comment, "removed the dead endpoint");
});

test("wontfix finding no longer detected at all is also kept as a historical record", () => {
  const prior = report([finding({ status: "wontfix" })]);
  const merged = mergeScanReport([], prior);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "wontfix");
  assert.equal(merged[0].detectedInLastScan, false);
});

test("open finding no longer detected at all is dropped — nothing to preserve", () => {
  const prior = report([finding({ status: "open" })]);
  const merged = mergeScanReport([], prior);

  assert.equal(merged.length, 0);
});

test("mixes correctly: one carried-forward resolved, one fresh open, one dropped-open, one kept-gone-resolved", () => {
  const prior = report([
    finding({ table: "posts", action: "select", status: "resolved", comment: "keep me" }),
    finding({ table: "posts", action: "update", status: "open" }), // will vanish -> dropped
    finding({ table: "comments", action: "delete", status: "resolved", comment: "gone but keep" }), // will vanish -> kept
  ]);
  const fresh = [
    finding({ table: "posts", action: "select", status: "open" }), // matches resolved -> carries forward
    finding({ table: "users", action: "insert", status: "open", riskLevel: "high", summary: "brand new" }), // new finding
  ];

  const merged = mergeScanReport(fresh, prior);
  const byKey = Object.fromEntries(merged.map((f) => [`${f.table}::${f.action}`, f]));

  assert.equal(Object.keys(byKey).length, 3);
  assert.equal(byKey["posts::select"].status, "resolved");
  assert.equal(byKey["posts::update"], undefined);
  assert.equal(byKey["comments::delete"].status, "resolved");
  assert.equal(byKey["comments::delete"].detectedInLastScan, false);
  assert.equal(byKey["users::insert"].status, "open");
});

test("applyResolution marks a finding resolved with a comment and timestamp", () => {
  const rep = report([finding({ table: "posts", action: "select", status: "open" })]);

  const { report: updated, matched } = applyResolution(rep, {
    table: "posts",
    action: "select",
    status: "resolved",
    comment: "tightened the policy",
    resolvedAt: "2026-02-01T00:00:00.000Z",
  });

  assert.equal(matched, 1);
  assert.equal(updated.findings[0].status, "resolved");
  assert.equal(updated.findings[0].comment, "tightened the policy");
  assert.equal(updated.findings[0].resolvedAt, "2026-02-01T00:00:00.000Z");
  // resolving doesn't change risk level — still counted in the summary by risk.
  assert.equal(updated.summary.critical, 1);
});

test("applyResolution back to open clears resolvedAt", () => {
  const rep = report([finding({ table: "posts", action: "select", status: "resolved", resolvedAt: "2026-01-01T00:00:00.000Z", comment: "x" })]);

  const { report: updated } = applyResolution(rep, { table: "posts", action: "select", status: "open", resolvedAt: "2026-02-01T00:00:00.000Z" });

  assert.equal(updated.findings[0].status, "open");
  assert.equal(updated.findings[0].resolvedAt, undefined);
});

test("applyResolution with no match returns matched: 0 and leaves the report untouched", () => {
  const rep = report([finding({ table: "posts", action: "select" })]);

  const { report: updated, matched } = applyResolution(rep, { table: "nonexistent", action: "select", status: "resolved", resolvedAt: "x" });

  assert.equal(matched, 0);
  assert.deepEqual(updated.findings, rep.findings);
});
