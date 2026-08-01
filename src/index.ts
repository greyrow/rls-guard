#!/usr/bin/env node
import "dotenv/config";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { loadSpec } from "./tools/spec.js";
import { introspectSchema } from "./tools/schema.js";
import { generatePolicySql, auditAgainstSpec } from "./tools/claude.js";
import { runBaselineChecks } from "./tools/baselineAudit.js";
import { dryRunSql } from "./tools/validate.js";
import { scanAppCode } from "./tools/appScan.js";
import { crossReference } from "./tools/crossReference.js";
import { mergeScanReport, applyResolution, summarize } from "./tools/scanReport.js";
import { renderScanReportHtml } from "./tools/renderHtml.js";
import type { AppScanReport, FindingStatus } from "./types.js";

async function loadScanReport(reportPath: string): Promise<AppScanReport | null> {
  try {
    return JSON.parse(await readFile(reportPath, "utf8")) as AppScanReport;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function htmlPathFor(reportPath: string): string {
  const { dir, name } = path.parse(reportPath);
  return path.join(dir, `${name}.html`);
}

/**
 * Writes the JSON report, then handles the HTML tracker: if `htmlPath` is given
 * (an explicit --html value), always (re)write it there. Otherwise, if
 * `renderHtmlIfExists` is set, check the conventional default path (same name,
 * .html extension) and only re-render it if a file is already there — so the
 * HTML never goes stale silently once it exists, without forcing every command
 * to create one.
 */
async function writeScanReport(
  reportPath: string,
  report: AppScanReport,
  opts: { htmlPath?: string; renderHtmlIfExists?: boolean } = {}
) {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`Wrote ${reportPath}`);

  if (opts.htmlPath) {
    await writeFile(opts.htmlPath, renderScanReportHtml(report), "utf8");
    console.log(`Wrote ${opts.htmlPath}`);
    return;
  }

  if (!opts.renderHtmlIfExists) return;
  const defaultHtmlPath = htmlPathFor(reportPath);
  const existed = await readFile(defaultHtmlPath, "utf8").then(
    () => true,
    () => false
  );
  if (existed) {
    await writeFile(defaultHtmlPath, renderScanReportHtml(report), "utf8");
    console.log(`Re-rendered ${defaultHtmlPath} (already existed — kept it in sync).`);
  }
}

const program = new Command();

program
  .name("rls-guard")
  .description(
    "Generate and audit Postgres/Supabase row-level security policies, CRUD permissions, and cascade-delete rules from a plain-language spec."
  )
  .version("0.1.0");

program
  .command("generate")
  .description("Generate a SQL migration (RLS policies + cascade rules) from a spec file.")
  .requiredOption("-s, --spec <path>", "path to the YAML permission spec")
  .option("-d, --db <url>", "Postgres connection string to include live schema context (optional)")
  .option("-o, --out <path>", "output file for the generated SQL", "rls-guard.generated.sql")
  .action(async (opts: { spec: string; db?: string; out: string }) => {
    const spec = await loadSpec(opts.spec);
    const liveSchema = opts.db ? await introspectSchema(opts.db) : null;

    console.log(`Generating policies for ${Object.keys(spec.tables).length} table(s)...`);
    const sql = await generatePolicySql(spec, liveSchema);
    await writeFile(opts.out, sql + "\n", "utf8");
    console.log(`Wrote ${opts.out}`);

    if (opts.db) {
      console.log("\nDry-running generated SQL (BEGIN ... ROLLBACK, nothing is kept)...");
      const result = await dryRunSql(opts.db, sql);

      if (result.ok) {
        console.log(`Dry run OK against database "${result.databaseName}".`);
        console.log(
          `IMPORTANT: this only proves the SQL applies cleanly to "${result.databaseName}" right now. ` +
            `Re-run "generate --db" against your actual target before trusting this on a different environment — ` +
            `a target missing the same roles (e.g. "authenticated") or functions (e.g. auth.uid()) will fail even though this dry run passed.`
        );
      } else if (result.insufficientPrivilege) {
        console.error(
          `\nDry run FAILED (insufficient privilege, ${result.errorCode}) against database "${result.databaseName}":\n` +
            `${result.error}\n` +
            `This DB user may lack owner privileges on one or more tables — ENABLE ROW LEVEL SECURITY and CREATE POLICY ` +
            `both require table ownership. This isn't necessarily broken SQL; connect as the table owner and re-run to confirm.`
        );
        console.log(`${opts.out} was still written — review/fix before applying.`);
        process.exitCode = 1;
      } else {
        console.error(
          `\nDry run FAILED (${result.errorCode ?? "error"}) against database "${result.databaseName}":\n${result.error}`
        );
        console.log(`${opts.out} was still written — review/fix before applying.`);
        process.exitCode = 1;
      }
    } else {
      console.log("\nNo --db given — skipping SQL validation. Pass --db to dry-run this against a live database first.");
    }

    console.log("Review it before applying — this is a starting point, not a guarantee.");
  });

program
  .command("audit")
  .description("Audit a live database against a spec: RLS gaps, cascade mismatches, missing coverage.")
  .requiredOption("-d, --db <url>", "Postgres connection string")
  .option("-s, --spec <path>", "path to the YAML permission spec (optional — baseline checks run without it)")
  .option("--no-ai", "skip the Claude-powered narrative report and only run fast baseline checks")
  .action(async (opts: { db: string; spec?: string; ai: boolean }) => {
    console.log("Introspecting live schema...");
    const liveSchema = await introspectSchema(opts.db);

    const baseline = runBaselineChecks(liveSchema);
    const critical = baseline.filter((f) => f.severity === "critical");
    const warnings = baseline.filter((f) => f.severity === "warning");

    console.log(`\n== Baseline checks (no AI, deterministic) ==`);
    console.log(`${critical.length} critical, ${warnings.length} warning(s)\n`);
    for (const f of [...critical, ...warnings]) {
      console.log(`[${f.severity.toUpperCase()}] ${f.table}: ${f.message}`);
    }

    if (opts.spec && opts.ai) {
      const spec = await loadSpec(opts.spec);
      console.log(`\n== Spec comparison (Claude) ==`);
      const report = await auditAgainstSpec(spec, liveSchema);
      console.log("\n" + report);
    } else if (!opts.spec) {
      console.log(`\nPass --spec <path> to also compare against your intended permission spec.`);
    }
  });

const scanCommand = program
  .command("scan")
  .description(
    "Scan an app's codebase for Supabase CRUD call sites and cross-reference them against live RLS state — a whole-app coverage audit, not just the database."
  )
  // Not .requiredOption(): Commander enforces a parent command's mandatory
  // options for the whole command chain, even when a subcommand (scan resolve)
  // is what's actually being run — so these are validated by hand below instead.
  .option("-a, --app <path>", "path to the app directory to scan")
  .option("-d, --db <url>", "Postgres connection string")
  .option("-s, --spec <path>", "path to the YAML permission spec (optional — enables spec-mismatch findings)")
  .option("-o, --out <path>", "output file for the JSON scan report", "rls-guard.scan.json")
  .option("--html [path]", "also write a static HTML tracker (default: same name as --out with a .html extension)")
  .action(async (opts: { app?: string; db?: string; spec?: string; out: string; html?: string | boolean }) => {
    if (!opts.app || !opts.db) {
      console.error("scan requires -a/--app <path> and -d/--db <url>.");
      process.exitCode = 1;
      return;
    }

    console.log(`Scanning ${opts.app} for Supabase CRUD call sites...`);
    const callSites = await scanAppCode(opts.app);
    console.log(`Found ${callSites.length} call site(s).`);
    if (callSites.length === 0) {
      console.log(
        "No .from(...).select/insert/update/delete(...) call sites found. If this app uses Supabase, check that --app points at the right directory."
      );
    }

    console.log("Introspecting live schema...");
    const liveSchema = await introspectSchema(opts.db);

    const spec = opts.spec ? await loadSpec(opts.spec) : null;

    const freshFindings = crossReference(callSites, liveSchema, spec);

    const priorReport = await loadScanReport(opts.out);
    if (priorReport) {
      console.log(`Found an existing ${opts.out} — carrying forward resolved/wontfix status for unchanged findings.`);
    }
    const findings = mergeScanReport(freshFindings, priorReport);
    const summary = summarize(findings);

    let databaseName = "unknown";
    try {
      databaseName = new URL(opts.db).pathname.replace(/^\//, "") || "unknown";
    } catch {
      // best-effort only — a report with "unknown" here is still useful.
    }

    const report: AppScanReport = {
      generatedAt: new Date().toISOString(),
      appDir: opts.app,
      databaseName,
      findings,
      summary,
    };

    await writeScanReport(opts.out, report, {
      htmlPath: opts.html ? (typeof opts.html === "string" ? opts.html : htmlPathFor(opts.out)) : undefined,
      renderHtmlIfExists: !opts.html,
    });

    console.log(`\n== Summary ==`);
    console.log(`${summary.critical} critical, ${summary.high} high, ${summary.medium} medium, ${summary.low} informational`);

    for (const f of findings.filter((f) => f.status === "open" && (f.riskLevel === "critical" || f.riskLevel === "high"))) {
      console.log(`\n[${f.riskLevel.toUpperCase()}] ${f.table}.${f.action}`);
      console.log(`  ${f.summary}`);
      console.log(`  Fix: ${f.recommendation}`);
      console.log(`  Found at: ${f.callSites.map((c) => `${c.file}:${c.line}`).join(", ")}`);
    }

    if (!opts.spec) {
      console.log(`\nPass --spec <path> to also flag call sites that don't match your intended permission spec.`);
    }

    const openCritical = findings.filter((f) => f.status === "open" && (f.riskLevel === "critical" || f.riskLevel === "high"));
    if (openCritical.length > 0) {
      console.log(`\n${opts.out} has the full findings list, including medium/low and resolved/wontfix. Review before shipping.`);
      process.exitCode = 1;
    } else {
      console.log(`\nNo open critical or high-risk findings. ${opts.out} has the full list for reference.`);
    }
  });

scanCommand
  .command("resolve")
  .description("Mark a scan finding's status (open/resolved/wontfix) in an existing scan report, and refresh its HTML tracker if one exists.")
  .requiredOption("-t, --table <name>", "table name of the finding")
  .requiredOption("-a, --action <crud>", "CRUD action of the finding: select, insert, update, or delete")
  .requiredOption("-s, --status <status>", "new status: open, resolved, or wontfix")
  .option("-c, --comment <text>", "optional comment explaining the resolution")
  .option("-r, --report <path>", "path to the JSON scan report", "rls-guard.scan.json")
  .action(async (opts: { table: string; action: string; status: string; comment?: string; report: string }) => {
    if (!["open", "resolved", "wontfix"].includes(opts.status)) {
      console.error(`Invalid --status "${opts.status}" — must be one of: open, resolved, wontfix.`);
      process.exitCode = 1;
      return;
    }

    const report = await loadScanReport(opts.report);
    if (!report) {
      console.error(`${opts.report} doesn't exist yet — run "scan" first.`);
      process.exitCode = 1;
      return;
    }

    const { report: updated, matched } = applyResolution(report, {
      table: opts.table,
      action: opts.action,
      status: opts.status as FindingStatus,
      comment: opts.comment,
      resolvedAt: new Date().toISOString(),
    });

    if (matched === 0) {
      console.error(`No finding found for ${opts.table}.${opts.action} in ${opts.report}. Check the table/action spelling.`);
      process.exitCode = 1;
      return;
    }

    await writeScanReport(opts.report, updated, { renderHtmlIfExists: true });
    console.log(`Marked ${opts.table}.${opts.action} as "${opts.status}".`);
  });

program.parseAsync(process.argv);
