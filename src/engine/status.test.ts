import { describe, expect, it } from "vitest";
import { deriveStatus, mapEventType } from "./status.ts";

describe("mapEventType", () => {
	it("maps session-start aliases to Attached", () => {
		for (const e of ["SessionStart", "session_start", "Attached"]) {
			expect(mapEventType(e)).toBe("Attached");
		}
	});

	it("maps session-end aliases to Detached", () => {
		for (const e of ["SessionEnd", "session_end", "Detached"]) {
			expect(mapEventType(e)).toBe("Detached");
		}
	});

	it("maps working-signal events to Start", () => {
		for (const e of ["Start", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure"]) {
			expect(mapEventType(e)).toBe("Start");
		}
	});

	it("maps approval-request events to PermissionRequest", () => {
		for (const e of ["PermissionRequest", "Notification", "PreToolUse", "exec_approval_request"]) {
			expect(mapEventType(e)).toBe("PermissionRequest");
		}
	});

	it("maps turn-complete events to Stop", () => {
		for (const e of ["Stop", "agent-turn-complete", "task_complete"]) {
			expect(mapEventType(e)).toBe("Stop");
		}
	});

	it("returns null for unknown or missing event names", () => {
		expect(mapEventType("SomethingElse")).toBeNull();
		expect(mapEventType(undefined)).toBeNull();
	});
});

describe("deriveStatus", () => {
	it("Start -> working", () => {
		expect(deriveStatus("Start", 100, 0)).toBe("working");
	});

	it("PermissionRequest -> waiting", () => {
		expect(deriveStatus("PermissionRequest", 100, 0)).toBe("waiting");
	});

	it("Stop the user hasn't seen -> review", () => {
		// lastEventAt (200) is newer than lastSeenAt (100)
		expect(deriveStatus("Stop", 200, 100)).toBe("review");
	});

	it("Stop the user has already seen -> idle", () => {
		// lastSeenAt (300) is newer than the Stop event (200)
		expect(deriveStatus("Stop", 200, 300)).toBe("idle");
	});

	it("Stop with no seen timestamp -> review (never looked at)", () => {
		expect(deriveStatus("Stop", 200, undefined)).toBe("review");
	});

	it("Attached / Detached / null -> idle", () => {
		expect(deriveStatus("Attached", 100, 0)).toBe("idle");
		expect(deriveStatus("Detached", 100, 0)).toBe("idle");
		expect(deriveStatus(null, 100, 0)).toBe("idle");
		expect(deriveStatus(undefined, 100, 0)).toBe("idle");
	});
});
