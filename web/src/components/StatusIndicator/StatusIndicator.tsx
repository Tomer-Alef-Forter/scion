// A small colored dot summarizing a workspace's agent status at a glance —
// used in the workspace grid and anywhere else a status needs to fit in a
// tight space. Six states: three "something's actively happening" states
// that pulse, three settled/quiet states that don't.
import { cn } from "../../lib/utils";
import type { AgentStatus } from "../../lib/api";

interface StatusVisual {
	dot: string;
	ring: string | null;
	label: string;
}

const STATUS_VISUALS: Record<AgentStatus, StatusVisual> = {
	// Actively happening — these pulse.
	starting: { dot: "bg-violet-500", ring: "bg-violet-400", label: "Starting…" },
	working: { dot: "bg-sky-500", ring: "bg-sky-400", label: "Agent working" },
	waiting: { dot: "bg-rose-500", ring: "bg-rose-400", label: "Needs input" },
	// Settled — static dot, no ring.
	review: { dot: "bg-emerald-500", ring: null, label: "Ready for review" },
	idle: { dot: "bg-muted-foreground/40", ring: null, label: "Idle" },
	done: { dot: "bg-muted-foreground/25", ring: null, label: "No running session" },
};

interface StatusIndicatorProps {
	status: AgentStatus;
	className?: string;
}

/** A dot (pulsing ring for starting/working/waiting, static otherwise) for the given agent status. */
export function StatusIndicator({ status, className }: StatusIndicatorProps) {
	const visual = STATUS_VISUALS[status];

	return (
		<span className={cn("relative flex size-2 shrink-0", className)}>
			{visual.ring && (
				<span
					className={cn(
						"absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
						visual.ring,
					)}
				/>
			)}
			<span className={cn("relative inline-flex size-2 rounded-full", visual.dot)} />
		</span>
	);
}

export function getStatusTooltip(status: AgentStatus): string {
	return STATUS_VISUALS[status].label;
}
