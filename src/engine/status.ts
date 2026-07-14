// Agent status: a SQLite-backed terminal↔workspace binding (survives a
// daemon restart) plus an in-memory "last seen" timestamp and a change
// event emitter the UI subscribes to.
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import type { Db } from "../db/db.ts";
import { terminalAgentBindings } from "../db/schema.ts";
import { parseTranscriptUsage } from "./usage.ts";

// ---- event normalization ----
//
// Every agent CLI (Claude Code, Codex, Gemini, ...) names its own lifecycle
// hooks differently, and Claude Code itself has renamed a couple of these
// over time — so we fold all the raw event names we've seen in the wild
// into a small, fixed set of lifecycle buckets everything else works with.
export type AgentLifecycleEventType =
	| "Start"
	| "Stop"
	| "PermissionRequest"
	| "Attached"
	| "Detached";

const EVENT_LIFECYCLE: Record<string, AgentLifecycleEventType> = {
	// A terminal came alive / a session resumed.
	SessionStart: "Attached",
	sessionStart: "Attached",
	session_start: "Attached",
	Attached: "Attached",
	attached: "Attached",

	// The terminal process ended — drop the binding entirely.
	SessionEnd: "Detached",
	sessionEnd: "Detached",
	session_end: "Detached",
	Detached: "Detached",
	detached: "Detached",

	// The agent is actively working on something.
	Start: "Start",
	UserPromptSubmit: "Start",
	userPromptSubmitted: "Start",
	user_prompt_submit: "Start",
	PostToolUse: "Start",
	postToolUse: "Start",
	post_tool_use: "Start",
	PostToolUseFailure: "Start",
	BeforeAgent: "Start",
	AfterTool: "Start",
	task_started: "Start",

	// The agent is blocked on the user for input/approval.
	PermissionRequest: "PermissionRequest",
	Notification: "PermissionRequest",
	PreToolUse: "PermissionRequest",
	preToolUse: "PermissionRequest",
	pre_tool_use: "PermissionRequest",
	exec_approval_request: "PermissionRequest",
	apply_patch_approval_request: "PermissionRequest",
	request_user_input: "PermissionRequest",

	// The agent finished its turn and is waiting for the next prompt.
	Stop: "Stop",
	stop: "Stop",
	"agent-turn-complete": "Stop",
	AfterAgent: "Stop",
	task_complete: "Stop",
};

export function mapEventType(
	eventType: string | undefined,
): AgentLifecycleEventType | null {
	if (!eventType) return null;
	return EVENT_LIFECYCLE[eventType] ?? null;
}

// ---- derived UI status ----
export type AgentStatus = "working" | "waiting" | "review" | "idle" | "gone";

/**
 * What the UI should show for a terminal, given its last lifecycle event and
 * whether the user has looked at this workspace since. A finished turn
 * ("Stop") the user hasn't seen yet is a "review" (needs attention); once
 * seen (or if it never needed review) it settles to "idle".
 */
export function deriveStatus(
	lastEventType: AgentLifecycleEventType | null | undefined,
	lastEventAt: number,
	lastSeenAt: number | undefined,
): AgentStatus {
	switch (lastEventType) {
		case "Start":
			return "working";
		case "PermissionRequest":
			return "waiting";
		case "Stop":
			return lastEventAt > (lastSeenAt ?? 0) ? "review" : "idle";
		default:
			return "idle";
	}
}

/** Cumulative token usage for a session — see engine/usage.ts for how it's
 * derived (real transcript data, no cost field — none exists to read). */
export interface SessionUsage {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheCreationTokens: number;
	totalCacheReadTokens: number;
	turnCount: number;
	usageUpdatedAt: number | null;
}

export interface StatusStore {
	events: EventEmitter;
	recordEvent(input: {
		terminalId: string;
		workspaceId: string;
		agentId: string;
		agentSessionId?: string;
		eventType: string;
		/** Path to the Claude Code transcript JSONL for this session, taken
		 * verbatim from the hook payload's `transcript_path` field. Only used
		 * on a "Stop" event, to (re)compute cumulative token usage. */
		transcriptPath?: string;
	}): void;
	markExited(terminalId: string): void;
	markSeen(workspaceId: string): void;
	listByWorkspace(workspaceId: string): Array<{
		terminalId: string;
		lastEventType: AgentLifecycleEventType;
		lastEventAt: number;
		status: AgentStatus;
		agentSessionId: string | null;
		usage: SessionUsage;
	}>;
}

export function createStatusStore(db: Db): StatusStore {
	const events = new EventEmitter();
	const lastSeenAt = new Map<string, number>();

	const notify = (workspaceId: string) => events.emit("change", workspaceId);

	function upsertBinding(input: {
		terminalId: string;
		workspaceId: string;
		agentId: string;
		agentSessionId?: string;
		lifecycle: AgentLifecycleEventType;
		transcriptPath?: string;
	}): void {
		const now = Date.now();
		const row = db
			.select()
			.from(terminalAgentBindings)
			.where(eq(terminalAgentBindings.terminalId, input.terminalId))
			.get();

		// Only a "Stop" (turn finished) means the transcript has a new,
		// complete assistant message to count — re-derive cumulative totals
		// from scratch each time so this stays correct even if we miss an
		// event (e.g. daemon restart) rather than trying to track deltas.
		const usage =
			input.lifecycle === "Stop" && input.transcriptPath
				? parseTranscriptUsage(input.transcriptPath)
				: null;
		const usageFields = usage
			? {
					totalInputTokens: usage.inputTokens,
					totalOutputTokens: usage.outputTokens,
					totalCacheCreationTokens: usage.cacheCreationTokens,
					totalCacheReadTokens: usage.cacheReadTokens,
					turnCount: usage.turnCount,
					usageUpdatedAt: now,
				}
			: {};

		if (row) {
			db.update(terminalAgentBindings)
				.set({ lastEventAt: now, lastEventType: input.lifecycle, ...usageFields })
				.where(eq(terminalAgentBindings.terminalId, input.terminalId))
				.run();
			return;
		}

		db.insert(terminalAgentBindings)
			.values({
				terminalId: input.terminalId,
				workspaceId: input.workspaceId,
				agentId: input.agentId || "claude",
				agentSessionId: input.agentSessionId ?? null,
				startedAt: now,
				lastEventAt: now,
				lastEventType: input.lifecycle,
				...usageFields,
			})
			.run();
	}

	return {
		events,

		recordEvent(input) {
			const lifecycle = mapEventType(input.eventType);
			if (!lifecycle) return;

			if (lifecycle === "Detached") {
				db.delete(terminalAgentBindings)
					.where(eq(terminalAgentBindings.terminalId, input.terminalId))
					.run();
				notify(input.workspaceId);
				return;
			}

			upsertBinding({ ...input, lifecycle });
			notify(input.workspaceId);
		},

		markExited(terminalId) {
			const row = db
				.select()
				.from(terminalAgentBindings)
				.where(eq(terminalAgentBindings.terminalId, terminalId))
				.get();
			if (!row) return;
			db.delete(terminalAgentBindings)
				.where(eq(terminalAgentBindings.terminalId, terminalId))
				.run();
			notify(row.workspaceId);
		},

		markSeen(workspaceId) {
			lastSeenAt.set(workspaceId, Date.now());
			notify(workspaceId);
		},

		listByWorkspace(workspaceId) {
			const seenAt = lastSeenAt.get(workspaceId);
			const rows = db
				.select()
				.from(terminalAgentBindings)
				.where(eq(terminalAgentBindings.workspaceId, workspaceId))
				.all();
			return rows.map((row) => {
				const lastEventType = row.lastEventType as AgentLifecycleEventType;
				return {
					terminalId: row.terminalId,
					lastEventType,
					lastEventAt: row.lastEventAt,
					status: deriveStatus(lastEventType, row.lastEventAt, seenAt),
					agentSessionId: row.agentSessionId,
					usage: {
						totalInputTokens: row.totalInputTokens,
						totalOutputTokens: row.totalOutputTokens,
						totalCacheCreationTokens: row.totalCacheCreationTokens,
						totalCacheReadTokens: row.totalCacheReadTokens,
						turnCount: row.turnCount,
						usageUpdatedAt: row.usageUpdatedAt,
					},
				};
			});
		},
	};
}
