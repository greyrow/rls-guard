import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIssueTitle, buildIssueBody, buildTrackerMarker, buildFindingMarker, hasOpenFindings } from "./issueBody.js";
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
    status: "open",
    detectedInLastScan: true,
    ...overrides,
  };
}

function report(findings: AppCrudFinding[]): AppScanReport {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    appDir: "./src",
    databaseName: "mydb",
    findings,
    summary: { critical: 0, high: 0, medium: 0, low: 0 },
  };
}

test("hasOpenFindings is true only when at least one finding is status: open", () => {
  assert.equal(hasOpenFindings(report([finding({ status: "open" })])), true);
  assert.equal(hasOpenFindings(report([finding({ status: "resolved" })])), false);
  assert.equal(hasOpenFindings(report([])), false);
});

test("title says all clear when there are no open findings", () => {
  const title = buildIssueTitle(report([finding({ status: "resolved" })]));
  assert.match(title, /all clear/i);
});

test("title includes the open-finding count", () => {
  const title = buildIssueTitle(report([finding({ status: "open" }), finding({ table: "comments", status: "open" })]));
  assert.match(title, /2 open finding/i);
});

test("body includes only open findings as checkboxes, grouped under their risk heading", () => {
  const r = report([
    finding({ table: "posts", action: "select", riskLevel: "critical", status: "open" }),
    finding({ table: "users", action: "insert", riskLevel: "high", status: "open" }),
    finding({ table: "comments", action: "delete", riskLevel: "critical", status: "resolved" }),
  ]);
  const body = buildIssueBody(r);

  assert.match(body, /### Critical \(1\)/);
  assert.match(body, /### High \(1\)/);
  assert.doesNotMatch(body, /### Medium/);
  assert.match(body, /- \[ \] \*\*posts\.select\*\*/);
  assert.match(body, /- \[ \] \*\*users\.insert\*\*/);
  assert.doesNotMatch(body, /- \[ \] \*\*comments\.delete\*\*/, "resolved findings must not appear as unchecked boxes");
});

test("resolved/wontfix findings go into a collapsed details section, not checkboxes", () => {
  const r = report([
    finding({ table: "comments", action: "delete", status: "resolved", comment: "fixed it", resolvedAt: "2026-01-05T00:00:00.000Z" }),
  ]);
  const body = buildIssueBody(r);

  assert.match(body, /<details>/);
  assert.match(body, /comments\.delete/);
  assert.match(body, /fixed it/);
  assert.doesNotMatch(body, /- \[ \]/, "no unchecked boxes when everything is resolved");
});

test("a resolved finding no longer detected notes that in the history section", () => {
  const r = report([finding({ status: "wontfix", detectedInLastScan: false })]);
  const body = buildIssueBody(r);

  assert.match(body, /no longer detected/i);
});

test("all-clear body has no details section when there's no history either", () => {
  const body = buildIssueBody(report([]));
  assert.match(body, /All clear/);
  assert.doesNotMatch(body, /<details>/);
});

test("tracker marker embeds appDir and databaseName", () => {
  const marker = buildTrackerMarker({ appDir: "./src", databaseName: "mydb" });
  assert.match(marker, /app=.\/src/);
  assert.match(marker, /db=mydb/);
});

test("marker sanitizes hyphens so appDir/db values can't break the HTML comment", () => {
  const marker = buildTrackerMarker({ appDir: "my-app--evil", databaseName: "db" });
  // Strip the comment's own <!-- / --> delimiters (which legitimately contain "--")
  // and check only the interpolated value portion for a stray "--".
  const inner = marker.replace(/^<!--/, "").replace(/-->$/, "");
  assert.doesNotMatch(inner, /--/, "a literal -- in an interpolated value would end the HTML comment early");
});

test("per-finding marker is embedded right after each checklist line", () => {
  const r = report([finding({ table: "posts", action: "select", status: "open" })]);
  const body = buildIssueBody(r);
  const findingMarker = buildFindingMarker("posts", "select");
  assert.ok(body.includes(findingMarker));

  const checklistLineIdx = body.indexOf("- [ ] **posts.select**");
  const markerIdx = body.indexOf(findingMarker);
  assert.ok(markerIdx > checklistLineIdx && markerIdx < checklistLineIdx + 200, "marker should immediately follow its checklist line");
});

test("body always includes the tracker marker so re-runs can find it", () => {
  const body = buildIssueBody(report([finding({ status: "open" })]));
  assert.ok(body.startsWith(buildTrackerMarker({ appDir: "./src", databaseName: "mydb" })));
});
