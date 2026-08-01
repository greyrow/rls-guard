#!/usr/bin/env node
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { loadSpec } from "./tools/spec.js";
import { introspectSchema } from "./tools/schema.js";
import { generatePolicySql, auditAgainstSpec } from "./tools/claude.js";
import { runBaselineChecks } from "./tools/baselineAudit.js";
import { dryRunSql } from "./tools/validate.js";

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

program.parseAsync(process.argv);
