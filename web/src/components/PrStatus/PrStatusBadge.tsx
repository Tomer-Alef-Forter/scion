// Read-only PR status for the selected workspace's branch — state, review
// decision, CI checks — fetched via `gh pr view` on the server (see
// engine/prStatus.ts). Refreshes when the workspace changes, when the window
// regains focus (a lightweight stand-in for polling: PR/CI state doesn't
// change fast enough to warrant a timer), and on a manual refresh click.
// Renders nothing at all — no error state — if there's no PR for this
// branch, or `gh` isn't installed/authenticated; this is a bonus view, never
// worth interrupting the dashboard over.
import { useCallback, useEffect, useState } from "react";
import { api, type PullRequestStatus } from "../../lib/api";
import { cn } from "../../lib/utils";

interface PrStatusBadgeProps {
	workspaceId: string;
}

const STATE_LABEL: Record<PullRequestStatus["state"], string> = {
	OPEN: "Open",
	MERGED: "Merged",
	CLOSED: "Closed",
};

const REVIEW_LABEL: Record<string, string> = {
	APPROVED: "Approved",
	CHANGES_REQUESTED: "Changes requested",
	REVIEW_REQUIRED: "Review required",
};

const CHECKS_LABEL: Record<PullRequestStatus["checks"]["state"], string> = {
	passing: "Checks passing",
	failing: "Checks failing",
	pending: "Checks running",
	none: "No checks",
};

const CHECKS_DOT: Record<PullRequestStatus["checks"]["state"], string> = {
	passing: "bg-emerald-500",
	failing: "bg-rose-500",
	pending: "bg-amber-500",
	none: "bg-muted-foreground/40",
};

const PR_STATE_CLASS: Record<PullRequestStatus["state"], string> = {
	OPEN: "border-border",
	MERGED: "border-violet-500/40 text-violet-600 dark:text-violet-400",
	CLOSED: "border-destructive/40 text-destructive",
};

export function PrStatusBadge({ workspaceId }: PrStatusBadgeProps) {
	// undefined = not loaded yet, null = loaded but nothing to show.
	const [status, setStatus] = useState<PullRequestStatus | null | undefined>(undefined);
	const [refreshing, setRefreshing] = useState(false);

	const load = useCallback(
		(force: boolean) => {
			if (force) setRefreshing(true);
			api
				.getPullRequestStatus(workspaceId, force)
				.then(setStatus)
				.catch(() => setStatus(null))
				.finally(() => setRefreshing(false));
		},
		[workspaceId],
	);

	useEffect(() => {
		setStatus(undefined);
		load(false);
	}, [load]);

	useEffect(() => {
		function onFocus() {
			load(false);
		}
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [load]);

	if (!status) return null;

	return (
		<div className="flex min-w-0 items-center gap-2 text-xs">
			<a
				href={status.url}
				target="_blank"
				rel="noreferrer"
				title={status.title}
				className={cn(
					"shrink-0 rounded-md border px-2 py-1 font-medium hover:bg-accent",
					PR_STATE_CLASS[status.state],
				)}
			>
				PR #{status.number} ·{" "}
				{status.isDraft && status.state === "OPEN" ? "Draft" : STATE_LABEL[status.state]}
			</a>
			{status.reviewDecision && (
				<span className="shrink-0 text-muted-foreground">
					{REVIEW_LABEL[status.reviewDecision] ?? status.reviewDecision}
				</span>
			)}
			<span
				className="flex shrink-0 items-center gap-1 text-muted-foreground"
				title={
					status.checks.state === "failing" && status.checks.failing.length > 0
						? `Failing: ${status.checks.failing.join(", ")}`
						: undefined
				}
			>
				<span className={cn("size-1.5 shrink-0 rounded-full", CHECKS_DOT[status.checks.state])} />
				{CHECKS_LABEL[status.checks.state]}
				{status.checks.state === "failing" &&
					status.checks.failing.length > 0 &&
					` (${status.checks.failing.slice(0, 2).join(", ")}${
						status.checks.failing.length > 2 ? `, +${status.checks.failing.length - 2}` : ""
					})`}
			</span>
			<button
				type="button"
				onClick={() => load(true)}
				disabled={refreshing}
				title="Refresh PR status"
				className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
			>
				{refreshing ? "…" : "⟳"}
			</button>
		</div>
	);
}
