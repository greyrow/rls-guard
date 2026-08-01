# PLAN.md — handoff notes for Claude Code

This project was scaffolded in a Cowork session as a v0.1 starting point. Everything
below is what's already built, and what to do next when you continue this in Claude Code.

## What's already built

- `src/types.ts` — spec format (roles, per-table CRUD rules, cascade rules) and the
  shape of a live-introspected schema.
- `src/tools/spec.ts` — loads and lightly validates a YAML spec.
- `src/tools/schema.ts` — introspects a live Postgres DB: tables, columns, RLS status,
  existing policies (`pg_policies`), and foreign key `ON DELETE` behavior (`pg_constraint`).
- `src/tools/claude.ts` — two Claude calls: `generatePolicySql` (spec [+ live schema] →
  SQL migration) and `auditAgainstSpec` (spec + live schema → Markdown findings report).
- `src/tools/baselineAudit.ts` — fast, deterministic checks that don't need the Claude
  API at all (RLS disabled, unrestricted `USING (true)` policies, FKs with no `ON DELETE`
  behavior set). This is what makes `audit` useful even with zero API cost.
- `src/index.ts` — CLI with `generate` and `audit` commands (commander).
- `spec/example.spec.yaml` — a worked example spec (posts/comments/audit_logs).

## First things to do in Claude Code

1. `npm install`, copy `.env.example` to `.env`, fill in `ANTHROPIC_API_KEY`.
2. Spin up a throwaway local Postgres (or a free Supabase project) with 3-4 tables
   resembling `spec/example.spec.yaml`, and run `audit --db ... ` against it with RLS
   intentionally left off on one table — confirm the baseline check catches it.
3. Run `generate --spec spec/example.spec.yaml` and manually check the SQL it produces
   is actually valid (`psql` it against the throwaway DB) — this is the riskiest part
   of the tool and needs real eyes on it before anyone else touches it.
4. Write a handful of unit tests around `runBaselineChecks` (`src/tools/baselineAudit.ts`)
   — it's pure and deterministic, cheapest place to get test coverage first.

## Known gaps / decisions still open

- No test suite yet at all.
- `generate` doesn't currently validate the SQL it gets back from Claude before writing
  it to disk (no dry-run / EXPLAIN check). Worth adding before this goes near a real DB.
- Only reads live schema via direct Postgres connection — no Prisma/Drizzle schema file
  reader yet (mentioned in README roadmap).
- The "owner" role resolution assumes a single `owner_column` per table; doesn't yet
  handle multi-owner or team-based ownership (e.g. `organization_id` + membership table).
- No CI/GitHub Action yet — that's the planned paid-tier hook, intentionally not built
  as part of the free core so the free/paid boundary stays clean from the start.

## v2: whole-app scan feature (phase 1 done, phases 2-5 next)

Extends rls-guard from "audit the database" to "audit CRUD+RLS coverage across the
whole app," ending in a single HTML tracker + an interactive Claude Code remediation
loop. Built in phases so each one ships independently:

**Phase 1 — done (this session).** App-code CRUD scanner + cross-reference:
- `src/tools/appScan.ts` — regex-based scan (via `fast-glob`) for Supabase-client CRUD
  call sites (`.from('table').select/insert/update/delete/upsert(...)`) in an app's
  `.ts/.tsx/.js/.jsx` files. Same heuristic tradeoff as the existing baseline audit —
  no AST, will miss dynamic table names (`.from(tableVar)`).
- `src/tools/crossReference.ts` — cross-references call sites against `LiveSchema`
  (RLS on/off, policy exists for the action, policy is unrestricted) and, if `--spec`
  is given, against the intended `AppSpec`. Produces `AppCrudFinding[]`: risk level
  (critical/high/medium/low), urgency (now/this_week/backlog), plain-English summary +
  recommendation, and the call sites that triggered it.
- `src/types.ts` — added `AppCrudCallSite`, `AppCrudFinding`, `AppScanReport`,
  `RiskLevel`, `Urgency`.
- `src/index.ts` — new `scan --app <dir> --db <url> [--spec <path>] [--out <path>]`
  command. Writes `rls-guard.scan.json` (the full findings list) and prints a console
  summary + critical/high findings inline. Exits non-zero if any critical/high finding.

**First things to do in Claude Code for phase 1:**
1. `npm install` — this adds `fast-glob` as a new dependency, not yet installed/verified
   (this code was written in a sandbox with no npm registry access — build/typecheck it
   first).
2. Run `scan` against a real or throwaway Supabase app directory and sanity-check the
   findings against what you know is actually true about that app's RLS setup.
3. Write unit tests for `crossReference` (pure function, easiest coverage) covering each
   risk-level branch — RLS off, no policy for action, unrestricted policy, spec mismatch,
   clean/low.
4. Known gap: call-site → CRUD-method attribution is a fixed-size lookahead window
   (300 chars) from each `.from(...)`, not a real parse — long chains or unusual
   formatting could misattribute. Worth a few adversarial test fixtures.

**Phase 2 — done.** HTML tracker report, built on the "JSON is truth, HTML is a pure
render of it" decision (not `localStorage` — phase 3's GitHub issue and phase 4's
`ship start` both need to read/write the same status, so a per-browser state store
would fork into silently-disagreeing copies):
- `src/types.ts` — `AppCrudFinding` gained `status: "open" | "resolved" | "wontfix"`,
  `resolvedAt?`, `comment?`, and `detectedInLastScan` (false only for a resolved/wontfix
  finding kept as a historical record after a re-scan no longer detects it at all).
- `src/tools/scanReport.ts` — `mergeScanReport(freshFindings, priorReport)`: re-running
  `scan` no longer blows away prior resolved/wontfix status. A finding carries its status
  forward only if it's the *same issue* (same table+action **and** same risk level **and**
  same summary) — if the risk level or summary changed, it resets to "open" even though
  the table+action key matches (e.g. RLS got re-enabled, or the specific problem changed).
  A resolved/wontfix finding that's no longer detected at all is kept with
  `detectedInLastScan: false` rather than silently dropped (a human's recorded decision is
  worth more than one stale entry); an "open" finding that disappears is just dropped, since
  nobody made a decision on it worth preserving. Also has `applyResolution` for the
  `resolve` command and `summarize` for recomputing risk counts.
- `src/tools/renderHtml.ts` — `renderScanReportHtml`: static, self-contained HTML,
  findings grouped by risk with status badges. No checkboxes, no JS, no client-side state.
- `src/index.ts` — `scan --html [path]` writes the HTML alongside the JSON; a bare `scan`
  (no `--html`) still re-renders an existing HTML file at the default path if one's
  already there, so it can't silently go stale. New `scan resolve --table <t> --action <a>
  --status <open|resolved|wontfix> [--comment <text>] [--report <path>]` edits the JSON in
  place and re-renders the HTML the same way — this is also the exact primitive phase 4's
  `ship start` loop will call once a fix is committed.
- Found and fixed along the way: Commander enforces a *parent* command's
  `.requiredOption()`s across its whole command chain, even when a child subcommand
  (`scan resolve`) is what's actually being invoked — `scan`'s own `--app`/`--db` had to
  become plain `.option()` with manual validation in the action, instead of
  `.requiredOption()`, so `scan resolve` isn't blocked by `scan`'s unrelated requirements.

**Phase 3 — `--create-issue`.** New flag/command that takes an `AppScanReport` and opens
a GitHub issue via `gh issue create` with a markdown checklist mirroring the findings
(one checkbox per finding, grouped by risk level, linking back to file:line call sites).

**Phase 4 — `ship start` remediation loop (deferred, hardest/most novel).** Interactive
Claude Code command: pick the next unchecked item from the issue, explain it in plain
English, take user approval/adjustments/rejection, implement the fix, commit + push +
open a PR, then mark the issue checkbox and the JSON/HTML tracker done with a comment
explaining what changed. All git/GitHub operations via explicit `gh`/`git` script
commands (no ambient auto-commit). Still open: whether this ships as a `gh extension`
(installable in any repo) or a command inside this same TypeScript CLI — leaning CLI
command for now, since it needs to share types/logic with `scan` directly.

**Phase 5 — branch/merge automation (deferred, lowest risk).** If the repo has a
`develop` branch, target PRs there instead of `main`, then a separate explicit
`gh`-scripted merge-to-main step; archive the remediation session once merged.

## Before pushing to GitHub

- Double check `.env` is gitignored (it is) and never commit a real `DATABASE_URL` or key.
- Decide the actual repo visibility/license stance again once there's more code — MIT
  is set in `package.json`/`LICENSE` for now per the open-core plan discussed.
- Turn on GitHub Sponsors on the repo once it's public, even before v0.2.
