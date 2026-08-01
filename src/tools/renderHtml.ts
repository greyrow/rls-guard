import type { AppCrudFinding, AppScanReport, RiskLevel } from "../types.js";

/**
 * Renders an AppScanReport as a static, self-contained HTML tracker — a pure
 * render of the JSON report, nothing more. No checkboxes, no client-side state:
 * the JSON is the source of truth, and this file goes stale the moment the JSON
 * changes underneath it. Regenerate it (via `scan` or `scan resolve`) rather
 * than editing it by hand.
 */

const RISK_LABEL: Record<RiskLevel, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low / informational",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderFinding(f: AppCrudFinding): string {
  const staleNote = f.detectedInLastScan
    ? ""
    : `<p class="stale">Not detected in the most recent scan — kept as a historical record of this decision.</p>`;
  const resolutionNote =
    f.status !== "open"
      ? `<p class="resolution"><strong>${f.resolvedAt ? escapeHtml(new Date(f.resolvedAt).toLocaleDateString()) : ""}</strong>${
          f.comment ? ` — ${escapeHtml(f.comment)}` : ""
        }</p>`
      : "";

  return `
    <div class="finding status-${f.status}">
      <div class="finding-head">
        <span class="badge badge-${f.status}">${f.status}</span>
        <span class="table-action">${escapeHtml(f.table)}.${escapeHtml(f.action)}</span>
      </div>
      <p class="summary">${escapeHtml(f.summary)}</p>
      <p class="recommendation">${escapeHtml(f.recommendation)}</p>
      ${resolutionNote}
      ${staleNote}
      <p class="call-sites">Found at: ${f.callSites.map((c) => `${escapeHtml(c.file)}:${c.line}`).join(", ") || "(no longer in source)"}</p>
    </div>`;
}

function renderRiskGroup(risk: RiskLevel, findings: AppCrudFinding[]): string {
  if (findings.length === 0) return "";
  return `
    <section class="risk-group risk-${risk}">
      <h2>${RISK_LABEL[risk]} (${findings.length})</h2>
      ${findings.map(renderFinding).join("\n")}
    </section>`;
}

export function renderScanReportHtml(report: AppScanReport): string {
  const byRisk: Record<RiskLevel, AppCrudFinding[]> = { critical: [], high: [], medium: [], low: [] };
  for (const f of report.findings) byRisk[f.riskLevel].push(f);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>rls-guard scan report — ${escapeHtml(report.databaseName)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  header { margin-bottom: 2rem; }
  header p { color: #555; font-size: 0.9rem; }
  h2 { border-bottom: 2px solid #ddd; padding-bottom: 0.25rem; }
  .risk-critical h2 { border-color: #c0392b; }
  .risk-high h2 { border-color: #e67e22; }
  .risk-medium h2 { border-color: #f1c40f; }
  .risk-low h2 { border-color: #7f8c8d; }
  .finding { border: 1px solid #ddd; border-radius: 6px; padding: 1rem; margin: 0.75rem 0; }
  .finding-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .table-action { font-family: ui-monospace, monospace; font-weight: 600; }
  .badge { font-size: 0.75rem; text-transform: uppercase; padding: 0.15rem 0.5rem; border-radius: 999px; color: white; }
  .badge-open { background: #7f8c8d; }
  .badge-resolved { background: #27ae60; }
  .badge-wontfix { background: #95a5a6; }
  .summary { margin: 0.25rem 0; }
  .recommendation { margin: 0.25rem 0; color: #555; }
  .resolution { margin: 0.25rem 0; color: #27ae60; }
  .stale { margin: 0.25rem 0; color: #b8860b; font-style: italic; }
  .call-sites { margin: 0.25rem 0 0; font-size: 0.85rem; color: #888; font-family: ui-monospace, monospace; }
  .status-resolved, .status-wontfix { opacity: 0.7; }
</style>
</head>
<body>
<header>
  <h1>rls-guard scan report</h1>
  <p>App: ${escapeHtml(report.appDir)} — DB: ${escapeHtml(report.databaseName)} — generated ${escapeHtml(new Date(report.generatedAt).toLocaleString())}</p>
  <p>${report.summary.critical} critical, ${report.summary.high} high, ${report.summary.medium} medium, ${report.summary.low} informational</p>
  <p>This is a static render of the JSON report — it does not update itself. Re-run <code>scan</code> or <code>scan resolve</code> to refresh it.</p>
</header>
${(["critical", "high", "medium", "low"] as RiskLevel[]).map((risk) => renderRiskGroup(risk, byRisk[risk])).join("\n")}
</body>
</html>
`;
}
