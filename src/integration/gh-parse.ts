/**
 * Parsing of `gh` CLI JSON output (docs/01 §4.1, docs/08 §4.1).
 *
 * Field names below were verified against gh v2.93.0 via `gh pr list --json`
 * and `gh issue list --json` with no value, which prints the available set.
 *
 * These parsers exist to compute value-stream metrics (docs/08 §2.1): lead time
 * and, more importantly, the idle ratio that Gartner Figure 3 marks as the
 * primary improvement target.
 */

import { z } from 'zod'

/** Verified subset of `gh issue list --json` fields. */
export const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  createdAt: z.string(),
  closedAt: z.string().nullable().optional(),
  labels: z.array(z.object({ name: z.string() })).default([]),
})
export type Issue = z.infer<typeof IssueSchema>

/** Verified subset of `gh pr list --json` fields. */
export const PullRequestSchema = z.object({
  number: z.number(),
  createdAt: z.string(),
  mergedAt: z.string().nullable().optional(),
  additions: z.number().default(0),
  deletions: z.number().default(0),
})
export type PullRequest = z.infer<typeof PullRequestSchema>

export function parseIssues(json: string): Issue[] {
  return z.array(IssueSchema).parse(JSON.parse(json))
}

export function parsePullRequests(json: string): PullRequest[] {
  return z.array(PullRequestSchema).parse(JSON.parse(json))
}

/** Total changed lines, used for the automerge gate (docs/06 §4.1). */
export function changedLines(pr: PullRequest): number {
  return pr.additions + pr.deletions
}

/** Lead time in hours: creation → merge. Null while still open (docs/08 §2.1). */
export function leadTimeHours(pr: PullRequest): number | null {
  if (pr.mergedAt === null || pr.mergedAt === undefined) return null
  const ms = Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)
  return ms / 3_600_000
}

/**
 * Idle ratio = (lead time − process time) / lead time.
 *
 * This is the headline metric: Gartner Figure 3 singles out "work item is idle"
 * as the segment to attack, and docs/01 §2.3 judges review waiting to be the
 * longest idle stretch in a typical stream.
 */
export function idleRatio(leadTimeH: number, processTimeH: number): number {
  if (leadTimeH <= 0) return 0
  const ratio = (leadTimeH - processTimeH) / leadTimeH
  // Process time above lead time means bad inputs, not negative idleness.
  return Math.max(0, Math.min(1, ratio))
}

/** Whether an issue carries a given oversight label (docs/06 §5.1). */
export function hasLabel(issue: Issue, label: string): boolean {
  return issue.labels.some((l) => l.name === label)
}
