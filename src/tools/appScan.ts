import fg from "fast-glob";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppCrudCallSite, CrudAction } from "../types.js";

/**
 * Finds Supabase-client CRUD call sites in an app's source code:
 *
 *   supabase.from('posts').select('*')
 *   supabase.from('posts').update({ ... }).eq('id', id)
 *
 * This is regex/heuristic-based, not an AST parse — same tradeoff rls-guard's
 * `audit --no-ai` baseline checks make. It will miss dynamic table names
 * (`.from(tableVar)`) and unusual call shapes, and can misattribute a CRUD
 * method to the wrong `.from()` in rare cases (e.g. two chains very close
 * together). Treat findings as "worth reviewing," not exhaustive ground truth.
 */

const FROM_PATTERN = /\.from\(\s*['"`]([a-zA-Z0-9_.]+)['"`]\s*\)/g;

const ACTION_PATTERNS: Array<{ action: CrudAction; pattern: RegExp }> = [
  { action: "select", pattern: /\.select\(/ },
  { action: "insert", pattern: /\.insert\(/ },
  { action: "update", pattern: /\.update\(/ },
  { action: "delete", pattern: /\.delete\(/ },
];

// .upsert() is insert-or-update; treat it as touching both actions so an
// audit against either policy still surfaces it.
const UPSERT_PATTERN = /\.upsert\(/;

// How far past a `.from(...)` call we look for the CRUD method that follows
// it in the same chain. Long enough for realistic chains (.eq/.order/.limit
// in between), short enough to avoid bleeding into unrelated code.
const CHAIN_LOOKAHEAD_CHARS = 300;

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/*.test.*",
  "**/*.spec.*",
];

export async function scanAppCode(appDir: string): Promise<AppCrudCallSite[]> {
  const files = await fg(["**/*.{ts,tsx,js,jsx,mjs,cjs}"], {
    cwd: appDir,
    ignore: DEFAULT_IGNORE,
    absolute: true,
    dot: false,
  });

  const callSites: AppCrudCallSite[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const relFile = path.relative(appDir, file);

    for (const match of content.matchAll(FROM_PATTERN)) {
      const table = match[1];
      const startIdx = match.index ?? 0;
      const afterFrom = startIdx + match[0].length;
      const windowEnd = Math.min(content.length, afterFrom + CHAIN_LOOKAHEAD_CHARS);

      // Don't let the lookahead window bleed into the next .from(...) chain.
      const nextFromIdx = content.indexOf(".from(", afterFrom);
      const effectiveEnd = nextFromIdx !== -1 && nextFromIdx < windowEnd ? nextFromIdx : windowEnd;
      const window = content.slice(startIdx, effectiveEnd);

      const actions = new Set<CrudAction>();
      for (const { action, pattern } of ACTION_PATTERNS) {
        if (pattern.test(window)) actions.add(action);
      }
      if (UPSERT_PATTERN.test(window)) {
        actions.add("insert");
        actions.add("update");
      }

      // No recognized CRUD method within range — likely not a real call site
      // (e.g. `.from()` used for something other than a Supabase query), skip it.
      if (actions.size === 0) continue;

      const lineNumber = content.slice(0, startIdx).split("\n").length;
      const raw = window.slice(0, 120).replace(/\s+/g, " ").trim();

      for (const action of actions) {
        callSites.push({ file: relFile, line: lineNumber, table, action, raw });
      }
    }
  }

  return callSites;
}
