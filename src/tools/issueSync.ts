import type { AppScanReport } from "../types.js";
import { buildIssueTitle, buildIssueBody, buildTrackerMarker, hasOpenFindings } from "./issueBody.js";
import { findTrackerIssue, createIssue, updateIssue, reopenIssue, closeIssue, type RemoteIssue } from "./githubIssue.js";

/**
 * Decides what to do given the report's current open/clear state and any
 * existing tracker issue found via the marker — pure, no gh calls, so this
 * (the actual decision logic) is unit-testable without the GitHub API.
 *
 *   no existing issue + no open findings -> skip (nothing worth tracking yet)
 *   no existing issue + open findings     -> create
 *   existing CLOSED   + open findings     -> reopen (JSON says there's real work;
 *                                            a stale closed issue would silently
 *                                            disagree with the source of truth)
 *   existing OPEN     + no open findings  -> close (the work is actually done)
 *   otherwise                             -> just update the body/title in place
 */
export type SyncActionKind = "skip" | "create" | "update" | "update_and_close" | "update_and_reopen";

export function planIssueSync(reportHasOpenFindings: boolean, existing: RemoteIssue | null): SyncActionKind {
  if (!existing) return reportHasOpenFindings ? "create" : "skip";
  if (reportHasOpenFindings && existing.state === "CLOSED") return "update_and_reopen";
  if (!reportHasOpenFindings && existing.state === "OPEN") return "update_and_close";
  return "update";
}

export interface SyncResult {
  action: SyncActionKind;
  issueNumber?: number;
}

export async function syncScanIssue(report: AppScanReport, repo?: string): Promise<SyncResult> {
  const marker = buildTrackerMarker(report);
  const existing = await findTrackerIssue(marker, repo);
  const action = planIssueSync(hasOpenFindings(report), existing);

  const title = buildIssueTitle(report);
  const body = buildIssueBody(report);

  if (action === "skip") return { action };

  if (action === "create") {
    const issueNumber = await createIssue(title, body, repo);
    return { action, issueNumber };
  }

  const issueNumber = existing!.number;
  await updateIssue(issueNumber, title, body, repo);

  if (action === "update_and_close") {
    await closeIssue(issueNumber, "All findings resolved or no longer detected as of the latest scan — closing.", repo);
  } else if (action === "update_and_reopen") {
    await reopenIssue(issueNumber, "Reopening — unresolved findings remain as of the latest scan.", repo);
  }

  return { action, issueNumber };
}
