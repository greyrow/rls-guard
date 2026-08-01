import type {
  AppCrudCallSite,
  AppCrudFinding,
  AppSpec,
  CrudAction,
  LiveSchema,
  LiveTable,
  RiskLevel,
  Urgency,
} from "../types.js";

function bareTableName(tableName: string): string {
  return tableName.includes(".") ? tableName.split(".").pop()! : tableName;
}

function findLiveTable(schema: LiveSchema, tableName: string): LiveTable | undefined {
  const bare = bareTableName(tableName);
  return schema.tables.find((t) => t.name === bare);
}

function policyCoversAction(table: LiveTable, action: CrudAction): boolean {
  const command = action.toUpperCase();
  return table.policies.some((p) => p.command === command || p.command === "ALL");
}

function hasUnrestrictedPolicy(table: LiveTable, action: CrudAction): boolean {
  const command = action.toUpperCase();
  return table.policies.some(
    (p) =>
      (p.command === command || p.command === "ALL") &&
      (p.usingExpr === null || p.usingExpr.trim().toLowerCase() === "true")
  );
}

/** undefined = no spec given, or the table isn't covered by the spec at all. */
function specAllowsAction(spec: AppSpec | null, tableName: string, action: CrudAction): boolean | undefined {
  if (!spec) return undefined;
  const tableSpec = spec.tables[bareTableName(tableName)];
  if (!tableSpec) return undefined;
  const rolesForAction = tableSpec.rules[action];
  return Boolean(rolesForAction && rolesForAction.length > 0);
}

const RISK_ORDER: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Cross-references app-code CRUD call sites against live RLS state (and,
 * optionally, the intended permission spec) to produce risk-rated,
 * plain-English findings — the source data for the HTML tracker report.
 */
export function crossReference(
  callSites: AppCrudCallSite[],
  schema: LiveSchema,
  spec: AppSpec | null
): AppCrudFinding[] {
  // Collapse repeated call sites for the same table+action into one finding.
  const groups = new Map<string, AppCrudCallSite[]>();
  for (const site of callSites) {
    const key = `${site.table}::${site.action}`;
    const list = groups.get(key) ?? [];
    list.push(site);
    groups.set(key, list);
  }

  const findings: AppCrudFinding[] = [];

  for (const [key, sites] of groups) {
    const [table, actionRaw] = key.split("::");
    const action = actionRaw as CrudAction;
    const liveTable = findLiveTable(schema, table);
    const specAllows = specAllowsAction(spec, table, action);

    if (!liveTable) {
      findings.push({
        table,
        action,
        riskLevel: "medium",
        urgency: "this_week",
        summary: `App code calls .${action}() on "${table}", but no table named "${table}" was found in the live database.`,
        recommendation: `Confirm "${table}" is the right table name (check for typos, or a non-"public" schema) and re-run the scan with --db pointed at the right database.`,
        callSites: sites,
        evidence: { rlsEnabled: false, hasPolicyForAction: false, policyUsesUnrestrictedUsing: false, specAllowsAction: specAllows },
      });
      continue;
    }

    const rlsEnabled = liveTable.rlsEnabled;
    const hasPolicy = policyCoversAction(liveTable, action);
    const unrestricted = hasUnrestrictedPolicy(liveTable, action);

    let riskLevel: RiskLevel;
    let urgency: Urgency;
    let summary: string;
    let recommendation: string;

    if (!rlsEnabled) {
      riskLevel = "critical";
      urgency = "now";
      summary = `App code calls .${action}() on "${table}", but row level security is OFF for this table — any request with table access can ${action} any row, regardless of who owns it.`;
      recommendation = `Enable RLS on "${table}" (ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;) and add a policy that scopes ${action} to the right rows before relying on this in production.`;
    } else if (!hasPolicy) {
      riskLevel = "high";
      urgency = "this_week";
      summary = `App code calls .${action}() on "${table}", but there's no ${action.toUpperCase()} (or ALL) policy on the table — this call will fail with a permission error for any non-superuser role.`;
      recommendation = `Add a ${action.toUpperCase()} policy for "${table}" that matches how the app actually uses it, or remove the call if it's dead code.`;
    } else if (unrestricted) {
      riskLevel = "critical";
      urgency = "now";
      summary = `App code calls .${action}() on "${table}", and the matching policy has no real restriction (USING is empty or "true") — any authenticated caller can ${action} every row in the table.`;
      recommendation = `Tighten the policy's USING clause to scope it (e.g. to the row's owner column, or a role check) instead of leaving it unrestricted.`;
    } else if (spec && specAllows === false) {
      riskLevel = "medium";
      urgency = "backlog";
      summary = `App code calls .${action}() on "${table}", but the permission spec doesn't grant ${action} to any role for this table — the live policy may be more permissive than intended.`;
      recommendation = `Reconcile the spec with the live policy: update the spec to reflect the intended ${action} access, or tighten the live policy to match the spec.`;
    } else {
      riskLevel = "low";
      urgency = "backlog";
      summary = `App code calls .${action}() on "${table}" — RLS is on and a scoped ${action.toUpperCase()} policy covers it.${spec ? " Matches the permission spec." : ""}`;
      recommendation = `No action needed — keep this as documented coverage in the tracker.`;
    }

    findings.push({
      table,
      action,
      riskLevel,
      urgency,
      summary,
      recommendation,
      callSites: sites,
      evidence: { rlsEnabled, hasPolicyForAction: hasPolicy, policyUsesUnrestrictedUsing: unrestricted, specAllowsAction: specAllows },
    });
  }

  findings.sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel] || a.table.localeCompare(b.table));
  return findings;
}
