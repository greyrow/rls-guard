import { test } from "node:test";
import assert from "node:assert/strict";
import { crossReference } from "./crossReference.js";
import type { AppCrudCallSite, AppSpec, LiveSchema, LiveTable } from "../types.js";

function callSite(overrides: Partial<AppCrudCallSite>): AppCrudCallSite {
  return { file: "app.ts", line: 1, table: "posts", action: "select", raw: "supabase.from('posts').select()", ...overrides };
}

function table(overrides: Partial<LiveTable>): LiveTable {
  return { name: "posts", rlsEnabled: true, columns: [], foreignKeys: [], policies: [], ...overrides };
}

function spec(tables: AppSpec["tables"]): AppSpec {
  return { roles: [], tables };
}

test("RLS disabled is critical regardless of policies", () => {
  const findings = crossReference(
    [callSite({})],
    { tables: [table({ rlsEnabled: false })] },
    null
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].riskLevel, "critical");
  assert.match(findings[0].summary, /row level security is OFF/);
  assert.equal(findings[0].autoFixable, true);
});

test("RLS on but no matching policy is high", () => {
  const findings = crossReference(
    [callSite({ action: "delete" })],
    { tables: [table({ policies: [] })] },
    null
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].riskLevel, "high");
  assert.match(findings[0].summary, /no DELETE \(or ALL\) policy/);
});

test("unrestricted USING policy (SELECT) is critical", () => {
  const findings = crossReference(
    [callSite({ action: "select" })],
    {
      tables: [
        table({
          policies: [{ policyName: "p", command: "SELECT", roles: ["authenticated"], usingExpr: "true", withCheckExpr: null }],
        }),
      ],
    },
    null
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].riskLevel, "critical");
  assert.match(findings[0].summary, /no real restriction/);
});

test("INSERT policy restricted only via WITH CHECK is NOT flagged unrestricted", () => {
  // Postgres never populates USING for a pure INSERT policy — regression test
  // for the bug where every INSERT-only policy was flagged critical.
  const findings = crossReference(
    [callSite({ action: "insert" })],
    {
      tables: [
        table({
          policies: [
            { policyName: "p", command: "INSERT", roles: ["authenticated"], usingExpr: null, withCheckExpr: "user_id = auth.uid()" },
          ],
        }),
      ],
    },
    null
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].riskLevel, "low");
});

test("INSERT policy with no WITH CHECK at all is still flagged unrestricted", () => {
  const findings = crossReference(
    [callSite({ action: "insert" })],
    {
      tables: [
        table({
          policies: [{ policyName: "p", command: "INSERT", roles: ["authenticated"], usingExpr: null, withCheckExpr: null }],
        }),
      ],
    },
    null
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].riskLevel, "critical");
});

test("spec says action isn't granted anywhere is medium", () => {
  const findings = crossReference(
    [callSite({ table: "posts", action: "update" })],
    {
      tables: [
        table({
          name: "posts",
          policies: [
            { policyName: "p", command: "UPDATE", roles: ["authenticated"], usingExpr: "user_id = auth.uid()", withCheckExpr: null },
          ],
        }),
      ],
    },
    spec({ posts: { rules: { update: [] } } })
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].riskLevel, "medium");
  assert.match(findings[0].summary, /doesn't grant update/);
  assert.equal(findings[0].autoFixable, false);
});

test("clean case: restricted policy and spec allows it is low, and says so", () => {
  const findings = crossReference(
    [callSite({ table: "posts", action: "select" })],
    {
      tables: [
        table({
          name: "posts",
          policies: [
            { policyName: "p", command: "SELECT", roles: ["authenticated"], usingExpr: "true = false OR owner_id = auth.uid()", withCheckExpr: null },
          ],
        }),
      ],
    },
    spec({ posts: { rules: { select: ["authenticated"] } } })
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].riskLevel, "low");
  assert.match(findings[0].summary, /Matches the permission spec/);
});

test("clean case: table not covered by the spec at all does not falsely claim a spec match", () => {
  // Regression test: table isn't in the spec (specAllows === undefined), so the
  // summary must not say "Matches the permission spec."
  const findings = crossReference(
    [callSite({ table: "users", action: "select" })],
    {
      tables: [
        table({
          name: "users",
          policies: [{ policyName: "p", command: "SELECT", roles: ["authenticated"], usingExpr: "id = auth.uid()", withCheckExpr: null }],
        }),
      ],
    },
    spec({ posts: { rules: { select: ["authenticated"] } } })
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].riskLevel, "low");
  assert.doesNotMatch(findings[0].summary, /Matches the permission spec/);
  assert.match(findings[0].summary, /isn't covered by the permission spec/);
});

test("table not found in live schema is medium", () => {
  const findings = crossReference([callSite({ table: "typo_table" })], { tables: [] }, null);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].riskLevel, "medium");
  assert.match(findings[0].summary, /no table named "typo_table" was found/);
  assert.equal(findings[0].autoFixable, false);
});

test("missing policy and unrestricted policy are both auto-fixable", () => {
  const missingPolicy = crossReference([callSite({ action: "delete" })], { tables: [table({ policies: [] })] }, null);
  assert.equal(missingPolicy[0].autoFixable, true);

  const unrestricted = crossReference(
    [callSite({ action: "select" })],
    {
      tables: [
        table({ policies: [{ policyName: "p", command: "SELECT", roles: ["authenticated"], usingExpr: "true", withCheckExpr: null }] }),
      ],
    },
    null
  );
  assert.equal(unrestricted[0].autoFixable, true);
});

test("clean/low-risk finding is not auto-fixable — nothing to fix", () => {
  const findings = crossReference(
    [callSite({ table: "posts", action: "select" })],
    {
      tables: [
        table({
          name: "posts",
          policies: [{ policyName: "p", command: "SELECT", roles: ["authenticated"], usingExpr: "owner_id = auth.uid()", withCheckExpr: null }],
        }),
      ],
    },
    null
  );
  assert.equal(findings[0].autoFixable, false);
});

test("groups repeated call sites for the same table+action into one finding", () => {
  const findings = crossReference(
    [callSite({ file: "a.ts", line: 1 }), callSite({ file: "b.ts", line: 5 })],
    {
      tables: [
        table({
          policies: [{ policyName: "p", command: "SELECT", roles: ["authenticated"], usingExpr: "true", withCheckExpr: null }],
        }),
      ],
    },
    null
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].callSites.length, 2);
});

test("sorts findings by risk severity, then table name", () => {
  const findings = crossReference(
    [callSite({ table: "z_table", action: "select" }), callSite({ table: "a_table", action: "delete" })],
    {
      tables: [
        table({ name: "z_table", rlsEnabled: false }),
        table({ name: "a_table", policies: [] }),
      ],
    },
    null
  );

  assert.equal(findings[0].riskLevel, "critical");
  assert.equal(findings[0].table, "z_table");
  assert.equal(findings[1].riskLevel, "high");
  assert.equal(findings[1].table, "a_table");
});
