import { test } from "node:test";
import assert from "node:assert/strict";
import { renderScanReportHtml } from "./renderHtml.js";
import type { AppScanReport } from "../types.js";

test("renders findings grouped by risk, escapes HTML, and shows resolution/stale notes", () => {
  const report: AppScanReport = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    appDir: "./src",
    databaseName: "<script>db</script>",
    findings: [
      {
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
      },
      {
        table: "comments",
        action: "delete",
        riskLevel: "high",
        urgency: "this_week",
        summary: "no policy",
        recommendation: "add one",
        callSites: [],
        evidence: { rlsEnabled: true, hasPolicyForAction: false, policyUsesUnrestrictedUsing: false },
        autoFixable: true,
        status: "resolved",
        resolvedAt: "2026-01-02T00:00:00.000Z",
        comment: "<b>fixed</b> it",
        detectedInLastScan: false,
      },
    ],
    summary: { critical: 1, high: 1, medium: 0, low: 0 },
  };

  const html = renderScanReportHtml(report);

  assert.match(html, /<!doctype html>/);
  assert.doesNotMatch(html, /<script>db<\/script>/, "databaseName must be escaped, not injected raw");
  assert.match(html, /&lt;script&gt;db&lt;\/script&gt;/);
  assert.match(html, /posts\.select/);
  assert.match(html, /comments\.delete/);
  assert.match(html, /badge-open/);
  assert.match(html, /badge-resolved/);
  assert.doesNotMatch(html, /<b>fixed<\/b> it/, "comment must be escaped, not injected raw");
  assert.match(html, /Not detected in the most recent scan/);
});
