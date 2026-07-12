// One row in the workspace list: status dot + name on top, branch + change
// counts underneath, age badge on the right. Memoized below since the parent
// grid re-renders on every status/diff refresh.
import { memo } from "react";
import { StatusIndicator } from "../StatusIndicator/StatusIndicator";
import type { DiffSummary, WorkspaceWithStatus } from "../../lib/api";
import { cn } from "../../lib/utils";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

function formatTimeAgo(createdAt: number): string {
	const elapsed = Date.now() - createdAt;
	if (elapsed < MINUTE_MS) return "now";
	if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
	if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
	if (elapsed < MONTH_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
	return `${Math.floor(elapsed / MONTH_MS)}mo`;
}

/** " · +12 -3 · 2 uncommitted" — nothing at all if the worktree is clean. */
function DiffStats({ diff }: { diff: DiffSummary | null }) {
	if (!diff || (diff.filesChanged === 0 && diff.uncommitted === 0)) return null;
	return (
		<>
			{" · "}
			{diff.insertions > 0 && (
				<span className="text-green-600 dark:text-green-500">+{diff.insertions}</span>
			)}
			{diff.insertions > 0 && diff.deletions > 0 && " "}
			{diff.deletions > 0 && (
				<span className="text-red-600 dark:text-red-500">-{diff.deletions}</span>
			)}
			{diff.uncommitted > 0 && ` · ${diff.uncommitted} uncommitted`}
		</>
	);
}

interface WorkspaceCardProps {
	workspace: WorkspaceWithStatus;
	selected: boolean;
	onClick: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
}

function WorkspaceCardImpl({
	workspace,
	selected,
	onClick,
	onContextMenu,
}: WorkspaceCardProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			onContextMenu={onContextMenu}
			className={cn(
				"flex min-h-[52px] w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
				selected ? "bg-accent" : "hover:bg-muted/50",
			)}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex min-w-0 items-center gap-2">
					<StatusIndicator status={workspace.status} />
					<span className="truncate text-sm font-medium">{workspace.name}</span>
				</div>
				<span className="truncate pl-4 text-xs text-muted-foreground">
					{workspace.branch}
					<DiffStats diff={workspace.diff} />
					{!workspace.terminalId && " · click to resume"}
				</span>
			</div>
			<span className="shrink-0 text-xs text-muted-foreground">
				{formatTimeAgo(workspace.createdAt)}
			</span>
		</button>
	);
}

// The parent list re-renders on every status/diff refresh, and its inline
// onClick/onContextMenu closures are recreated each time regardless — so the
// default shallow-prop comparator would never skip a re-render. Compare only
// `workspace` (by reference — App patches a single workspace immutably, so
// unrelated rows keep the SAME object) and `selected`; a fresh onClick
// closure still calls through correctly even when the card itself doesn't
// re-render, so ignoring its identity here is safe.
export const WorkspaceCard = memo(
	WorkspaceCardImpl,
	(prev, next) => prev.workspace === next.workspace && prev.selected === next.selected,
);
