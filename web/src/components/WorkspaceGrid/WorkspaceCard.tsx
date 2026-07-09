// Layout cribbed from Superset's mock SessionCard:
// apps/web/src/app/(agents)/components/SessionList/components/SessionCard/SessionCard.tsx
// See NOTICE.md. Status icon swapped for the lifted StatusIndicator (live
// agent status instead of a static completed/running/failed enum); data
// source is our real WorkspaceWithStatus instead of MockSession.
import { StatusIndicator } from "../StatusIndicator/StatusIndicator";
import type { WorkspaceWithStatus } from "../../lib/api";
import { cn } from "../../lib/utils";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function formatTimeAgo(createdAt: number): string {
	const diff = Date.now() - createdAt;
	const minutes = Math.floor(diff / MS_PER_MINUTE);
	const hours = Math.floor(diff / MS_PER_HOUR);
	const days = Math.floor(diff / MS_PER_DAY);
	const months = Math.floor(days / 30);

	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	if (hours < 24) return `${hours}h`;
	if (days < 30) return `${days}d`;
	return `${months}mo`;
}

interface WorkspaceCardProps {
	workspace: WorkspaceWithStatus;
	selected: boolean;
	onClick: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
}

export function WorkspaceCard({
	workspace,
	selected,
	onClick,
	onContextMenu,
}: WorkspaceCardProps) {
	const diff = workspace.diff;
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
			<StatusIndicator status={workspace.status} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-sm font-medium">{workspace.name}</span>
				<span className="truncate text-xs text-muted-foreground">
					{workspace.branch}
					{diff && (diff.filesChanged > 0 || diff.uncommitted > 0) && (
						<>
							{" · "}
							{diff.insertions > 0 && (
								<span className="text-green-600 dark:text-green-500">
									+{diff.insertions}
								</span>
							)}
							{diff.insertions > 0 && diff.deletions > 0 && " "}
							{diff.deletions > 0 && (
								<span className="text-red-600 dark:text-red-500">
									-{diff.deletions}
								</span>
							)}
							{diff.uncommitted > 0 && ` · ${diff.uncommitted} uncommitted`}
						</>
					)}
					{!workspace.terminalId && " · click to resume"}
				</span>
			</div>
			<span className="shrink-0 text-xs text-muted-foreground">
				{formatTimeAgo(workspace.createdAt)}
			</span>
		</button>
	);
}
