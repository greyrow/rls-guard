import { test } from "node:test";
import assert from "node:assert/strict";
import { runBaselineChecks } from "./baselineAudit.js";
import type { LiveSchema, LiveTable } from "../types.js";

function table(overrides: Partial<LiveTable>): LiveTable {
  return {
    name: "t",
    rlsEnabled: true,
    columns: [],
    foreignKeys: [],
    policies: [],
    ...overrides,
  };
}

test("flags RLS disabled as critical and skips further checks on that table", () => {
  const schema: LiveSchema = {
    tables: [
      table({
        name: "posts",
        rlsEnabled: false,
        foreignKeys: [{ constraintName: "fk", column: "user_id", referencesTable: "users", referencesColumn: "id", onDelete: "no_action" }],
      }),
    ],
  };

  const findings = runBaselineChecks(schema);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "critical");
  assert.equal(findings[0].table, "posts");
  assert.match(findings[0].message, /Row-level security is OFF/);
});

test("flags RLS enabled with zero policies as critical", () => {
  const schema: LiveSchema = { tables: [table({ name: "users", policies: [] })] };

  const findings = runBaselineChecks(schema);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "critical");
  assert.match(findings[0].message, /no policies exist/);
});

test("warns on a SELECT policy with a null USING clause", () => {
  const schema: LiveSchema = {
    tables: [
      table({
        name: "comments",
        policies: [{ policyName: "p1", command: "SELECT", roles: ["authenticated"], usingExpr: null, withCheckExpr: null }],
      }),
    ],
  };

  const findings = runBaselineChecks(schema);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "warning");
  assert.match(findings[0].message, /no restricting USING clause/);
});

test("warns on a policy with USING (true)", () => {
  const schema: LiveSchema = {
    tables: [
      table({
        policies: [{ policyName: "p1", command: "DELETE", roles: ["admin"], usingExpr: "true", withCheckExpr: null }],
      }),
    ],
  };

  const findings = runBaselineChecks(schema);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "warning");
});

test("does not warn on an unrestricted INSERT policy", () => {
  const schema: LiveSchema = {
    tables: [
      table({
        policies: [{ policyName: "p1", command: "INSERT", roles: ["authenticated"], usingExpr: null, withCheckExpr: "true" }],
      }),
    ],
  };

  assert.deepEqual(runBaselineChecks(schema), []);
});

test("does not warn on a restrictive USING clause", () => {
  const schema: LiveSchema = {
    tables: [
      table({
        policies: [{ policyName: "p1", command: "SELECT", roles: ["authenticated"], usingExpr: "user_id = auth.uid()", withCheckExpr: null }],
      }),
    ],
  };

  assert.deepEqual(runBaselineChecks(schema), []);
});

test("warns on a foreign key with no ON DELETE behavior", () => {
  const schema: LiveSchema = {
    tables: [
      table({
        name: "comments",
        policies: [{ policyName: "p1", command: "SELECT", roles: ["authenticated"], usingExpr: "true", withCheckExpr: null }],
        foreignKeys: [{ constraintName: "fk", column: "post_id", referencesTable: "posts", referencesColumn: "id", onDelete: "no_action" }],
      }),
    ],
  };

  const findings = runBaselineChecks(schema);

  assert.equal(findings.length, 2);
  assert.ok(findings.some((f) => f.message.includes("no ON DELETE behavior set")));
});

test("does not warn on foreign keys with cascade/restrict/set_null", () => {
  const schema: LiveSchema = {
    tables: [
      table({
        policies: [{ policyName: "p1", command: "SELECT", roles: ["authenticated"], usingExpr: "true", withCheckExpr: null }],
        foreignKeys: [
          { constraintName: "fk1", column: "a", referencesTable: "x", referencesColumn: "id", onDelete: "cascade" },
          { constraintName: "fk2", column: "b", referencesTable: "y", referencesColumn: "id", onDelete: "restrict" },
          { constraintName: "fk3", column: "c", referencesTable: "z", referencesColumn: "id", onDelete: "set_null" },
        ],
      }),
    ],
  };

  const findings = runBaselineChecks(schema);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /USING clause/);
});

test("returns no findings for an empty schema", () => {
  assert.deepEqual(runBaselineChecks({ tables: [] }), []);
});

test("aggregates findings across multiple tables in order", () => {
  const schema: LiveSchema = {
    tables: [
      table({ name: "a", rlsEnabled: false }),
      table({ name: "b", policies: [] }),
    ],
  };

  const findings = runBaselineChecks(schema);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].table, "a");
  assert.equal(findings[1].table, "b");
});
