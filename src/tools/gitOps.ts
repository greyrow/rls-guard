import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin `git` CLI wrapper for `ship start` (phase 4). Uses execFile (argv arrays, no
 * shell) same as githubIssue.ts's `gh` wrapper. Assumes it's run with cwd inside the
 * target app's own repo — same convention `scan create-issue` already relies on for
 * `gh` to find the right remote.
 */

/** Always branches from `main` (phase 4 never targets a develop/staging branch — see PLAN.md). */
export async function createBranch(name: string): Promise<void> {
  await execFileAsync("git", ["checkout", "main"]);
  await execFileAsync("git", ["checkout", "-b", name]);
}

export async function stageAndCommit(files: string[], message: string): Promise<void> {
  await execFileAsync("git", ["add", ...files]);
  await execFileAsync("git", ["commit", "-m", message]);
}

export async function push(branch: string): Promise<void> {
  await execFileAsync("git", ["push", "-u", "origin", branch]);
}

export async function checkout(branch: string): Promise<void> {
  await execFileAsync("git", ["checkout", branch]);
}
