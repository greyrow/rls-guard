# rls-guard

Design-time and audit agent for Postgres/Supabase **row-level security, CRUD permissions,
and cascade-delete rules**. Write down who can select/insert/update/delete what, in plain
YAML — rls-guard turns it into real SQL, and checks your live database against it.

## Why

Misconfigured Row Level Security is currently one of the most common real-world data
exposure bugs in Postgres/Supabase-backed apps. In one 2025 disclosure (CVE-2025-48757),
303 endpoints across 170 apps were found fully readable by anyone holding the public
anon key, because RLS was off or misconfigured. This happens because RLS policies are
easy to get subtly wrong and easy to forget entirely as a schema grows — especially in
fast-moving, AI-assisted app builds.

rls-guard exists so that:
- You describe your permission model once, in a format a non-DBA can read and review.
- `rls-guard generate` turns that into an actual SQL migration (policies + cascade rules).
- `rls-guard audit` checks a live database against the spec and flags drift — RLS
  disabled, overly permissive policies, cascade behavior that doesn't match intent.

## Status

**v0.1 — early scaffold.** The core loop (spec → generate SQL, live DB → audit) works.
Not yet battle-tested; review generated SQL before applying it to anything real. See
`PLAN.md` for what's next.

## Install (local dev, not yet published)

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY and DATABASE_URL
npm run build
```

## Usage

Generate a migration from a spec (works with or without a live DB connection):

```bash
npx tsx src/index.ts generate --spec spec/example.spec.yaml --out rls-guard.generated.sql
npx tsx src/index.ts generate --spec spec/example.spec.yaml --db $DATABASE_URL --out rls-guard.generated.sql
```

Audit a live database — fast deterministic checks always run; add `--spec` to also get a
Claude-written comparison against your intended permission model:

```bash
npx tsx src/index.ts audit --db $DATABASE_URL
npx tsx src/index.ts audit --db $DATABASE_URL --spec spec/example.spec.yaml
```

See `spec/example.spec.yaml` for the spec format: roles, per-table CRUD rules, and
cascade-delete behavior (`cascade` / `restrict` / `set_null`).

Scan an app's codebase for every Supabase CRUD call site (`.from('table').select/insert/
update/delete(...)`) and cross-reference each one against live RLS state — catches gaps
`audit` alone can't see, like app code that calls `.update()` on a table with no UPDATE
policy at all (which fails at runtime), or writes that quietly hit an unrestricted policy:

```bash
npx tsx src/index.ts scan --app ./src --db $DATABASE_URL
npx tsx src/index.ts scan --app ./src --db $DATABASE_URL --spec spec/example.spec.yaml
```

Writes a JSON report (`rls-guard.scan.json` by default) with every finding, risk level
(`critical`/`high`/`medium`/`low`), urgency, and a plain-English recommendation — the
source data for the HTML tracker report and `--create-issue` GitHub checklist planned
next (see `PLAN.md`). Same heuristic tradeoff as `audit --no-ai`: regex-based call-site
detection, not an AST parse — treat findings as "worth reviewing," not exhaustive.

## How it's different

Most existing tools here are either general-purpose policy engines you write yourself
(Open Policy Agent), heavyweight enterprise DB-access platforms, or external scanners
that probe a *live* app from outside without knowing what access was actually supposed
to look like. rls-guard starts from your intended design (the spec) and both generates
the implementation and checks reality against that intent — closer to a linter + codegen
tool than a black-box scanner.

## Roadmap / where this is going

- CI mode: fail a PR/build when a new table has no RLS policy or a cascade rule drifts
  from spec (this is the planned paid tier — see below).
- Prisma/Drizzle schema readers, not just live Postgres introspection.
- Generated test suite (not just SQL) that proves unauthorized access actually fails.
- Policy diffing between spec versions for change review.

## License / monetization model

Core CLI is MIT-licensed and will stay free. The plan is an open-core model: a hosted
CI gate + PR bot + compliance report generation as a paid tier on top of this free,
inspectable core. GitHub Sponsors is on from day one regardless.

## Contributing

Early days — open an issue before a large PR. See `PLAN.md` for the current build plan.
