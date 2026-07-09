// Lifted from Superset:
// apps/desktop/src/renderer/screens/main/components/StatusIndicator/StatusIndicator.tsx
// See NOTICE.md. The 3-state config (working/permission/review) is copied
// verbatim; idle/starting/done are ADDITIONS (our AgentStatus tracks more
// states than Superset's PaneStatus — Superset just omits the indicator for
// "idle", but the TUI shows these as meaningful labels, so we render a muted
// dot rather than nothing).
import { cn } from "../../lib/utils";
import type { AgentStatus } from "../../lib/api";

const STATUS_CONFIG = {
	waiting: {
		pingColor: "bg-red-400",
		dotColor: "bg-red-500",
		pulse: true,
		tooltip: "Needs input",
	},
	working: {
		pingColor: "bg-amber-400",
		dotColor: "bg-amber-500",
		pulse: true,
		tooltip: "Agent working",
	},
	review: {
		pingColor: "",
		dotColor: "bg-green-500",
		pulse: false,
		tooltip: "Ready for review",
	},
	// Additions beyond Superset's 3-state model:
	starting: {
		pingColor: "bg-cyan-400",
		dotColor: "bg-cyan-500",
		pulse: true,
		tooltip: "Starting…",
	},
	idle: {
		pingColor: "",
		dotColor: "bg-muted-foreground/40",
		pulse: false,
		tooltip: "Idle",
	},
	done: {
		pingColor: "",
		dotColor: "bg-muted-foreground/25",
		pulse: false,
		tooltip: "No running session",
	},
} as const satisfies Record<
	AgentStatus,
	{ pingColor: string; dotColor: string; pulse: boolean; tooltip: string }
>;

interface StatusIndicatorProps {
	status: AgentStatus;
	className?: string;
}

/**
 * Visual indicator for a workspace's agent status.
 * - Red pulsing: needs user input (waiting)
 * - Amber pulsing: agent working
 * - Cyan pulsing: starting (live process, no event yet)
 * - Green static: ready for review
 * - Muted static: idle / done
 */
export function StatusIndicator({ status, className }: StatusIndicatorProps) {
	const config = STATUS_CONFIG[status];

	return (
		<span className={cn("relative flex size-2 shrink-0", className)}>
			{config.pulse && (
				<span
					className={cn(
						"absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
						config.pingColor,
					)}
				/>
			)}
			<span
				className={cn("relative inline-flex size-2 rounded-full", config.dotColor)}
			/>
		</span>
	);
}

export function getStatusTooltip(status: AgentStatus): string {
	return STATUS_CONFIG[status].tooltip;
}
