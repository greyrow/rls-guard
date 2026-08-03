import { test } from "node:test";
import assert from "node:assert/strict";
import { nextFixableFinding, migrationFilePath } from "./shipRun.js";
import type { AppCrudFinding } from "../types.js";

function finding(overrides: Partial<AppCrudFinding>): AppCrudFinding {
  return {
    table: "posts",
    action: "select",
    riskLevel: "critical",
    urgency: "now",
    summary: "unrestricted select",
    recommendation: "tighten it",
    callSites: [],
    evidence: { rlsEnabled: true, hasPolicyForAction: true, policyUsesUnrestrictedUsing: true },
    autoFixable: true,
    status: "open",
    detectedInLastScan: true,
    ...overrides,
  };
}

test("nextFixableFinding skips non-autoFixable and non-open findings", () => {
  const findings = [
    finding({ table: "a", autoFixable: false }),
    finding({ table: "b", status: "resolved" }),
    finding({ table: "c" }),
  ];
  assert.equal(nextFixableFinding(findings, new Set())?.table, "c");
});

test("nextFixableFinding skips findings already skipped this session", () => {
  const findings = [finding({ table: "a" }), finding({ table: "b" })];
  assert.equal(nextFixableFinding(findings, new Set(["a::select"]))?.table, "b");
});

test("nextFixableFinding returns null when nothing's left", () => {
  assert.equal(nextFixableFinding([finding({ status: "resolved" })], new Set()), null);
});

test("migrationFilePath sanitizes table names and scopes by table+action", () => {
  assert.equal(migrationFilePath("migrations", finding({ table: "public.posts", action: "delete" })), "migrations/public_posts_delete.sql");
});
