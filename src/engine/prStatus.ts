// Read-only PR status lookups via `gh pr view` — surfaces review/CI state for
// a workspace's branch in the dashboard. A sibling to pullRequest.ts (which
// only pushes + creates a PR, a one-shot mutation); this is polled
// repeatedly by the UI, so it's kept separate and cached.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PrState = "OPEN" | "CLOSED" | "MERGED";
export type PrCheckState = "passing" | "failing" | "pending" | "none";

export interface PullRequestStatus {
	url: string;
	number: number;
	title: string;
	state: PrState;
	isDraft: boolean;
	// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED, or null if gh reports
	// nothing (no reviewers requested/no reviews yet).
	reviewDecision: string | null;
	checks: {
		state: PrCheckState;
		total: number;
		// Names of failing/erroring checks — capped, just enough for a tooltip.
		failing: string[];
	};
}

// `gh pr view --json statusCheckRollup` mixes two shapes depending on
// whether a given check is a GitHub Actions "check run" or a legacy/external
// "commit status" — see gh's GraphQL-backed JSON output.
interface CheckRollupItem {
	name?: string;
	context?: string;
	status?: string; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED
	conclusion?: string | null; // CheckRun (once COMPLETED): SUCCESS | FAILURE | ...
	state?: string; // StatusContext: SUCCESS | PENDING | ERROR | FAILURE | EXPECTED
}

const FAILING_CHECKRUN_CONCLUSIONS = new Set([
	"FAILURE",
	"TIMED_OUT",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
]);
const FAILING_STATUS_STATES = new Set(["ERROR", "FAILURE"]);

function summarizeChecks(
	rollup: CheckRollupItem[] | null | undefined,
): PullRequestStatus["checks"] {
	if (!rollup || rollup.length === 0) return { state: "none", total: 0, failing: [] };

	const failing: string[] = [];
	let pending = false;
	for (const item of rollup) {
		const name = item.name || item.context || "check";
		if (item.status !== undefined) {
			// CheckRun shape.
			if (item.status !== "COMPLETED") {
				pending = true;
				continue;
			}
			if (item.conclusion && FAILING_CHECKRUN_CONCLUSIONS.has(item.conclusion)) {
				failing.push(name);
			}
		} else if (item.state !== undefined) {
			// Legacy commit-status shape.
			if (item.state === "PENDING" || item.state === "EXPECTED") {
				pending = true;
				continue;
			}
			if (FAILING_STATUS_STATES.has(item.state)) failing.push(name);
		}
	}
	const state: PrCheckState = failing.length > 0 ? "failing" : pending ? "pending" : "passing";
	return { state, total: rollup.length, failing: failing.slice(0, 10) };
}

async function fetchPullRequestStatus(worktreePath: string): Promise<PullRequestStatus | null> {
	try {
		const { stdout } = await execFileAsync(
			"gh",
			["pr", "view", "--json", "url,number,title,state,isDraft,reviewDecision,statusCheckRollup"],
			{ cwd: worktreePath },
		);
		const data = JSON.parse(stdout) as {
			url: string;
			number: number;
			title: string;
			state: PrState;
			isDraft: boolean;
			reviewDecision: string | null;
			statusCheckRollup: CheckRollupItem[] | null;
		};
		return {
			url: data.url,
			number: data.number,
			title: data.title,
			state: data.state,
			isDraft: data.isDraft,
			reviewDecision: data.reviewDecision || null,
			checks: summarizeChecks(data.statusCheckRollup),
		};
	} catch {
		// No PR for this branch, `gh` not installed, not authenticated, no
		// network, private-repo access denied, etc. — all treated the same:
		// nothing to show, not an error worth surfacing (the caller just omits
		// the panel).
		return null;
	}
}

interface CacheEntry {
	promise: Promise<PullRequestStatus | null>;
	computedAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

/**
 * Same coalescing pattern as getCachedDiffSummary in diff.ts — the dashboard
 * refetches on selection change and on window focus; without a cache that's
 * a fresh `gh pr view` (a real GitHub API round trip) every time. Repeat
 * calls for the same worktree within `ttlMs` share one in-flight/cached
 * result instead.
 */
export function getCachedPullRequestStatus(
	worktreePath: string,
	ttlMs = DEFAULT_TTL_MS,
): Promise<PullRequestStatus | null> {
	const cached = cache.get(worktreePath);
	if (cached && Date.now() - cached.computedAt < ttlMs) return cached.promise;

	const promise = fetchPullRequestStatus(worktreePath);
	cache.set(worktreePath, { promise, computedAt: Date.now() });
	return promise;
}

/** Force the next getCachedPullRequestStatus call for this worktree to bypass the cache — used by the manual refresh button. */
export function invalidatePullRequestStatusCache(worktreePath: string): void {
	cache.delete(worktreePath);
}
