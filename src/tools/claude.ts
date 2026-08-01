import Anthropic from "@anthropic-ai/sdk";
import type { AppSpec, LiveSchema } from "../types.js";

const MODEL = "claude-sonnet-4-5";

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.");
  }
  return new Anthropic({ apiKey });
}

/**
 * Pulls plain text out of a Messages API response. Written defensively (rather than
 * importing the SDK's content-block union types by name) since those type names have
 * moved between SDK versions — this only assumes each block has a "type" and, for text
 * blocks, a "text" field, which has been stable.
 */
function extractText(content: unknown[]): string {
  return content
    .filter((block): block is { type: string; text: string } => {
      const b = block as { type?: unknown; text?: unknown };
      return b.type === "text" && typeof b.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

const GENERATE_SYSTEM_PROMPT = `You are rls-guard, an expert Postgres/Supabase database security engineer.
Given a plain-language permission spec (roles, per-table CRUD rules, cascade-delete rules) and,
optionally, the live schema of a database, produce a single SQL migration that:

1. Enables row-level security on every table in the spec (ALTER TABLE ... ENABLE ROW LEVEL SECURITY).
2. Creates one CREATE POLICY statement per role/action combination in the spec. Use
   "(select auth.uid())" style checks for Supabase-style owner columns (wrap auth.uid() in a
   sub-select to avoid the common per-row re-evaluation performance trap). For a generic Postgres
   setup without Supabase auth, use a "current_setting('app.current_user_id')::uuid" style check
   and say so in a comment.
3. Adds or alters foreign key constraints to match the declared cascade rules
   (ON DELETE CASCADE / RESTRICT / SET NULL / NO ACTION).
4. Adds a short SQL comment above each policy explaining, in one line, what it does and why.

Output ONLY the SQL migration in a single \`\`\`sql code block. Do not include prose outside the
code block. Prefer explicit, readable policies over clever ones.`;

const AUDIT_SYSTEM_PROMPT = `You are rls-guard, an expert Postgres/Supabase database security auditor.
You are given (a) a plain-language permission spec describing the INTENDED access rules, and
(b) the ACTUAL live schema introspected from the database (RLS status, existing policies, foreign
key cascade behavior). Compare intent vs. reality and produce a findings report in Markdown with
these sections:

## Critical (data exposure risk)
Tables where RLS is disabled entirely, or a policy is broader than the spec allows (e.g. permits a role
the spec didn't grant, or has no USING clause restricting rows).

## Cascade mismatches
Foreign keys whose ON DELETE behavior doesn't match the spec's cascade rule for that table.

## Missing coverage
Tables or CRUD actions mentioned in the spec that have no corresponding policy in the live database at all.

## Notes
Anything else worth flagging (e.g. a table with no owner_column but an "owner" rule referenced,
which is impossible to enforce; overly permissive USING (true) policies).

Be concise and specific — name the exact table, policy, or constraint for every finding. If there
are no findings for a section, write "None found." under it.`;

export async function generatePolicySql(spec: AppSpec, liveSchema: LiveSchema | null): Promise<string> {
  const anthropic = client();

  const userContent = [
    "## Permission spec (YAML)",
    "```yaml",
    JSON.stringify(spec, null, 2),
    "```",
    liveSchema
      ? ["## Live schema (JSON)", "```json", JSON.stringify(liveSchema, null, 2), "```"].join("\n")
      : "## Live schema\nNo live database connected — generate policies from the spec alone, assuming standard Postgres/Supabase conventions.",
  ].join("\n\n");

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: GENERATE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const text = extractText(message.content);

  const match = text.match(/```sql\s*([\s\S]*?)```/);
  return match ? match[1].trim() : text.trim();
}

export async function auditAgainstSpec(spec: AppSpec, liveSchema: LiveSchema): Promise<string> {
  const anthropic = client();

  const userContent = [
    "## Permission spec (YAML)",
    "```yaml",
    JSON.stringify(spec, null, 2),
    "```",
    "## Live schema (JSON)",
    "```json",
    JSON.stringify(liveSchema, null, 2),
    "```",
  ].join("\n\n");

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: AUDIT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  return extractText(message.content).trim();
}
