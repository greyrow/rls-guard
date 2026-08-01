import type { LiveSchema } from "../types.js";

/**
 * Fast, deterministic checks that don't require calling Claude at all.
 * These catch the exact failure modes behind most real-world RLS incidents
 * (RLS off, or a policy with no restricting condition) so `audit` is useful
 * even without an ANTHROPIC_API_KEY configured.
 */
export interface BaselineFinding {
  severity: "critical" | "warning";
  table: string;
  message: string;
}

export function runBaselineChecks(schema: LiveSchema): BaselineFinding[] {
  const findings: BaselineFinding[] = [];

  for (const table of schema.tables) {
    if (!table.rlsEnabled) {
      findings.push({
        severity: "critical",
        table: table.name,
        message: "Row-level security is OFF. If this table is reachable via an auto-generated API (e.g. Supabase's PostgREST layer), it is fully readable/writable by anyone with the anon key.",
      });
      continue;
    }

    if (table.policies.length === 0) {
      findings.push({
        severity: "critical",
        table: table.name,
        message: "RLS is enabled but no policies exist. Postgres defaults to denying all access in this case, but double-check the app doesn't use a service-role/bypass connection here unintentionally.",
      });
    }

    for (const policy of table.policies) {
      const usingIsUnrestricted = policy.usingExpr === "true" || policy.usingExpr === null;
      if (usingIsUnrestricted && policy.command !== "INSERT") {
        findings.push({
          severity: "warning",
          table: table.name,
          message: `Policy "${policy.policyName}" (${policy.command}) has no restricting USING clause — it allows access to every row for roles: ${policy.roles.join(", ") || "public"}.`,
        });
      }
    }

    for (const fk of table.foreignKeys) {
      if (fk.onDelete === "no_action") {
        findings.push({
          severity: "warning",
          table: table.name,
          message: `Foreign key "${fk.constraintName}" (${fk.column} -> ${fk.referencesTable}.${fk.referencesColumn}) has no ON DELETE behavior set. Deleting a referenced row will fail with a constraint error unless the app handles it explicitly — confirm that's intended.`,
        });
      }
    }
  }

  return findings;
}
