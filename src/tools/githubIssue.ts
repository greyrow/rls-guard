import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the `gh` CLI for issue create/find/update/reopen/close.
 * Uses execFile (argv arrays, no shell) so title/body content can never be
 * interpreted as shell syntax. Body content always goes through a temp file
 * via --body-file rather than a CLI argument — avoids both shell-escaping
 * and argv-length issues for a multi-KB markdown checklist.
 */

export interface RemoteIssue {
  number: number;
  state: "OPEN" | "CLOSED";
  body: string;
}

function repoArgs(repo?: string): string[] {
  return repo ? ["--repo", repo] : [];
}

async function withBodyFile<T>(body: string, fn: (bodyFilePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "rls-guard-issue-"));
  const bodyFilePath = path.join(dir, "body.md");
  try {
    await writeFile(bodyFilePath, body, "utf8");
    return await fn(bodyFilePath);
  } finally {
    await unlink(bodyFilePath).catch(() => {});
  }
}

/** Lists up to `limit` issues (open and closed) for the client-side marker search. */
export async function listAllIssues(repo?: string, limit = 100): Promise<RemoteIssue[]> {
  const { stdout } = await execFileAsync("gh", [
    "issue",
    "list",
    "--state",
    "all",
    "--limit",
    String(limit),
    "--json",
    "number,state,body",
    ...repoArgs(repo),
  ]);
  return JSON.parse(stdout) as RemoteIssue[];
}

/** Finds this app+db's tracker issue by scanning issue bodies for the embedded marker. */
export async function findTrackerIssue(marker: string, repo?: string): Promise<RemoteIssue | null> {
  const issues = await listAllIssues(repo);
  return issues.find((issue) => issue.body.includes(marker)) ?? null;
}

export async function createIssue(title: string, body: string, repo?: string): Promise<number> {
  const { stdout } = await withBodyFile(body, (bodyFilePath) =>
    execFileAsync("gh", ["issue", "create", "--title", title, "--body-file", bodyFilePath, ...repoArgs(repo)])
  );
  const match = stdout.trim().match(/\/issues\/(\d+)\s*$/);
  if (!match) throw new Error(`Couldn't parse an issue number out of "gh issue create" output: ${stdout}`);
  return Number(match[1]);
}

export async function updateIssue(number: number, title: string, body: string, repo?: string): Promise<void> {
  await withBodyFile(body, (bodyFilePath) =>
    execFileAsync("gh", ["issue", "edit", String(number), "--title", title, "--body-file", bodyFilePath, ...repoArgs(repo)])
  );
}

export async function reopenIssue(number: number, comment: string, repo?: string): Promise<void> {
  await execFileAsync("gh", ["issue", "reopen", String(number), "--comment", comment, ...repoArgs(repo)]);
}

export async function closeIssue(number: number, comment: string, repo?: string): Promise<void> {
  await execFileAsync("gh", ["issue", "close", String(number), "--comment", comment, "--reason", "completed", ...repoArgs(repo)]);
}

export async function commentOnIssue(number: number, body: string, repo?: string): Promise<void> {
  await withBodyFile(body, (bodyFilePath) =>
    execFileAsync("gh", ["issue", "comment", String(number), "--body-file", bodyFilePath, ...repoArgs(repo)])
  );
}

export interface CreatePrOptions {
  title: string;
  body: string;
  base: string;
  repo?: string;
}

/** Used by `ship start` (phase 4) after a fix is committed and pushed. Returns the PR URL. */
export async function createPr(opts: CreatePrOptions): Promise<string> {
  const { stdout } = await withBodyFile(opts.body, (bodyFilePath) =>
    execFileAsync("gh", [
      "pr",
      "create",
      "--title",
      opts.title,
      "--body-file",
      bodyFilePath,
      "--base",
      opts.base,
      ...repoArgs(opts.repo),
    ])
  );
  return stdout.trim();
}
