import type { AppCrudFinding, AppScanReport, FindingStatus, RiskLevel } from "../types.js";

const RISK_ORDER: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function findingKey(f: { table: string; action: string }): string {
  return `${f.table}::${f.action}`;
}

export function summarize(findings: AppCrudFinding[]): Record<RiskLevel, number> {
  const summary: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) summary[f.riskLevel]++;
  return summary;
}

function sortFindings(findings: AppCrudFinding[]): AppCrudFinding[] {
  return [...findings].sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel] || a.table.localeCompare(b.table));
}

/**
 * Merges freshly-detected findings with a prior scan report so human-recorded
 * status (resolved/wontfix + comment) survives a re-scan instead of resetting
 * every finding to "open".
 *
 * A finding carries its status forward only if it's still the "same issue":
 * same table+action AND the same risk level AND the same summary. If either
 * changed shape (e.g. RLS got re-enabled, or the risk level shifted), it's not
 * the same issue anymore even though the table+action key matches, so it resets
 * to "open".
 *
 * A prior finding that was resolved/wontfix but is no longer detected at all
 * (call site removed, or the underlying condition changed enough that no new
 * finding matches it) is kept as a historical record, flagged via
 * detectedInLastScan: false — dropping a human's recorded decision silently is
 * worse than one stale-but-labeled entry in the tracker. A prior finding that
 * was still "open" (nobody made a decision on it) and disappears is just
 * dropped; there's nothing worth preserving.
 */
export function mergeScanReport(newFindings: AppCrudFinding[], prior: AppScanReport | null): AppCrudFinding[] {
  const priorByKey = new Map<string, AppCrudFinding>();
  for (const f of prior?.findings ?? []) {
    priorByKey.set(findingKey(f), f);
  }

  const merged: AppCrudFinding[] = [];
  const seenKeys = new Set<string>();

  for (const f of newFindings) {
    const key = findingKey(f);
    seenKeys.add(key);
    const priorFinding = priorByKey.get(key);
    const sameIssue = priorFinding && priorFinding.riskLevel === f.riskLevel && priorFinding.summary === f.summary;

    merged.push(
      sameIssue
        ? { ...f, status: priorFinding.status, resolvedAt: priorFinding.resolvedAt, comment: priorFinding.comment }
        : f
    );
  }

  for (const [key, priorFinding] of priorByKey) {
    if (seenKeys.has(key)) continue;
    if (priorFinding.status === "open") continue; // no human decision recorded — nothing worth preserving
    merged.push({ ...priorFinding, detectedInLastScan: false });
  }

  return sortFindings(merged);
}

export interface ResolveOptions {
  table: string;
  action: string;
  status: FindingStatus;
  comment?: string;
  resolvedAt: string;
}

export function applyResolution(report: AppScanReport, opts: ResolveOptions): { report: AppScanReport; matched: number } {
  let matched = 0;
  const findings = report.findings.map((f) => {
    if (f.table !== opts.table || f.action !== opts.action) return f;
    matched++;
    return {
      ...f,
      status: opts.status,
      resolvedAt: opts.status === "open" ? undefined : opts.resolvedAt,
      comment: opts.comment ?? f.comment,
    };
  });

  return { report: { ...report, findings: sortFindings(findings), summary: summarize(findings) }, matched };
}
