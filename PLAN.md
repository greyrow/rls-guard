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

## Before pushing to GitHub

- Double check `.env` is gitignored (it is) and never commit a real `DATABASE_URL` or key.
- Decide the actual repo visibility/license stance again once there's more code — MIT
  is set in `package.json`/`LICENSE` for now per the open-core plan discussed.
- Turn on GitHub Sponsors on the repo once it's public, even before v0.2.
