// Agent status: SQLite-backed binding store (survives restart) + in-memory
// cache + change events. Copied/adapted from superset host-service
// terminal-agents/store.ts, events/map-event-type.ts, and the renderer's
// deriveTerminalAgentStatus.ts.
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import type { Db } from "../db/db.ts";
import { terminalAgentBindings } from "../db/schema.ts";

// ---- event normalization (copied from events/map-event-type.ts) ----
export type AgentLifecycleEventType =
	| "Start"
	| "Stop"
	| "PermissionRequest"
	| "Attached"
	| "Detached";

export function mapEventType(
	eventType: string | undefined,
): AgentLifecycleEventType | null {
	if (!eventType) return null;
	if (["Attached", "attached", "SessionStart", "sessionStart", "session_start"].includes(eventType))
		return "Attached";
	if (["Detached", "detached", "SessionEnd", "sessionEnd", "session_end"].includes(eventType))
		return "Detached";
	if (
		[
			"Start", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure",
			"BeforeAgent", "AfterTool", "userPromptSubmitted", "user_prompt_submit",
			"postToolUse", "post_tool_use", "task_started",
		].includes(eventType)
	)
		return "Start";
	if (
		[
			"PermissionRequest", "Notification", "PreToolUse", "preToolUse",
			"pre_tool_use", "exec_approval_request", "apply_patch_approval_request",
			"request_user_input",
		].includes(eventType)
	)
		return "PermissionRequest";
	if (["Stop", "stop", "agent-turn-complete", "AfterAgent", "task_complete"].includes(eventType))
		return "Stop";
	return null;
}

// ---- derived UI status (copied from deriveTerminalAgentStatus.ts) ----
export type AgentStatus = "working" | "waiting" | "review" | "idle" | "gone";

export function deriveStatus(
	lastEventType: AgentLifecycleEventType | null | undefined,
	lastEventAt: number,
	lastSeenAt: number | undefined,
): AgentStatus {
	if (lastEventType === "Start") return "working";
	if (lastEventType === "PermissionRequest") return "waiting";
	if (lastEventType === "Stop")
		return lastEventAt > (lastSeenAt ?? 0) ? "review" : "idle";
	return "idle";
}

const EXIT_EVENTS: AgentLifecycleEventType[] = ["Detached"];

export interface StatusStore {
	events: EventEmitter;
	recordEvent(input: {
		terminalId: string;
		workspaceId: string;
		agentId: string;
		agentSessionId?: string;
		eventType: string;
	}): void;
	markExited(terminalId: string): void;
	markSeen(workspaceId: string): void;
	listByWorkspace(workspaceId: string): Array<{
		terminalId: string;
		lastEventType: AgentLifecycleEventType;
		lastEventAt: number;
		status: AgentStatus;
	}>;
}

export function createStatusStore(db: Db): StatusStore {
	const events = new EventEmitter();
	const lastSeen = new Map<string, number>();

	function emitChange(workspaceId: string) {
		events.emit("change", workspaceId);
	}

	return {
		events,

		recordEvent(input) {
			const lifecycle = mapEventType(input.eventType);
			if (!lifecycle) return;

			if (EXIT_EVENTS.includes(lifecycle)) {
				db.delete(terminalAgentBindings)
					.where(eq(terminalAgentBindings.terminalId, input.terminalId))
					.run();
				emitChange(input.workspaceId);
				return;
			}

			const now = Date.now();
			const existing = db
				.select()
				.from(terminalAgentBindings)
				.where(eq(terminalAgentBindings.terminalId, input.terminalId))
				.get();

			if (existing) {
				db.update(terminalAgentBindings)
					.set({ lastEventAt: now, lastEventType: lifecycle })
					.where(eq(terminalAgentBindings.terminalId, input.terminalId))
					.run();
			} else {
				db.insert(terminalAgentBindings)
					.values({
						terminalId: input.terminalId,
						workspaceId: input.workspaceId,
						agentId: input.agentId || "claude",
						agentSessionId: input.agentSessionId ?? null,
						startedAt: now,
						lastEventAt: now,
						lastEventType: lifecycle,
					})
					.run();
			}
			emitChange(input.workspaceId);
		},

		markExited(terminalId) {
			const row = db
				.select()
				.from(terminalAgentBindings)
				.where(eq(terminalAgentBindings.terminalId, terminalId))
				.get();
			db.delete(terminalAgentBindings)
				.where(eq(terminalAgentBindings.terminalId, terminalId))
				.run();
			if (row) emitChange(row.workspaceId);
		},

		markSeen(workspaceId) {
			lastSeen.set(workspaceId, Date.now());
			emitChange(workspaceId);
		},

		listByWorkspace(workspaceId) {
			const rows = db
				.select()
				.from(terminalAgentBindings)
				.where(eq(terminalAgentBindings.workspaceId, workspaceId))
				.all();
			const seen = lastSeen.get(workspaceId);
			return rows.map((r) => ({
				terminalId: r.terminalId,
				lastEventType: r.lastEventType as AgentLifecycleEventType,
				lastEventAt: r.lastEventAt,
				status: deriveStatus(
					r.lastEventType as AgentLifecycleEventType,
					r.lastEventAt,
					seen,
				),
			}));
		},
	};
}
