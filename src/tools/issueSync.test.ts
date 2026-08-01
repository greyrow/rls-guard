import { test } from "node:test";
import assert from "node:assert/strict";
import { planIssueSync } from "./issueSync.js";
import type { RemoteIssue } from "./githubIssue.js";

function issue(state: "OPEN" | "CLOSED"): RemoteIssue {
  return { number: 42, state, body: "" };
}

test("no existing issue, no open findings -> skip (nothing worth tracking yet)", () => {
  assert.equal(planIssueSync(false, null), "skip");
});

test("no existing issue, open findings -> create", () => {
  assert.equal(planIssueSync(true, null), "create");
});

test("existing OPEN issue, still open findings -> just update", () => {
  assert.equal(planIssueSync(true, issue("OPEN")), "update");
});

test("existing OPEN issue, no more open findings -> update and close", () => {
  assert.equal(planIssueSync(false, issue("OPEN")), "update_and_close");
});

test("existing CLOSED issue, open findings again -> update and reopen", () => {
  assert.equal(planIssueSync(true, issue("CLOSED")), "update_and_reopen");
});

test("existing CLOSED issue, still no open findings -> just update (not reopen, not re-close)", () => {
  assert.equal(planIssueSync(false, issue("CLOSED")), "update");
});
