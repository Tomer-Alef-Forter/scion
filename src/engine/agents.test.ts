import { describe, expect, it } from "vitest";
import { buildAgentArgv, buildClaudeArgv, sanitizePrompt } from "./agents.ts";

describe("sanitizePrompt", () => {
	it("strips ANSI/CSI escape sequences", () => {
		expect(sanitizePrompt("[31mred[0m text")).toBe("red text");
	});

	it("normalizes CRLF and lone CR to LF", () => {
		expect(sanitizePrompt("line1\r\nline2\rline3")).toBe("line1\nline2\nline3");
	});

	it("strips control characters but keeps newlines", () => {
		const withControls = "hello\x00\x01\x07world\nline2";
		expect(sanitizePrompt(withControls)).toBe("helloworld\nline2");
	});

	it("expands tabs to four spaces", () => {
		expect(sanitizePrompt("a\tb")).toBe("a    b");
	});
});

describe("buildAgentArgv: claude", () => {
	it("always passes --permission-mode auto", () => {
		expect(buildAgentArgv("claude", {})).toEqual(["--permission-mode", "auto"]);
	});

	it("appends the sanitized, trimmed prompt as a trailing positional", () => {
		expect(buildAgentArgv("claude", { prompt: "  fix the bug  " })).toEqual([
			"--permission-mode",
			"auto",
			"fix the bug",
		]);
	});

	it("inserts --resume before the prompt when resuming a session", () => {
		expect(
			buildAgentArgv("claude", { prompt: "continue", resumeSessionId: "sess-123" }),
		).toEqual(["--permission-mode", "auto", "--resume", "sess-123", "continue"]);
	});

	it("omits --resume when resumeSessionId is null/absent", () => {
		expect(buildAgentArgv("claude", { resumeSessionId: null })).toEqual([
			"--permission-mode",
			"auto",
		]);
	});

	it("does not append a trailing positional for an empty/whitespace-only prompt", () => {
		expect(buildAgentArgv("claude", { prompt: "   " })).toEqual([
			"--permission-mode",
			"auto",
		]);
	});

	it("buildClaudeArgv is equivalent to buildAgentArgv('claude', ...)", () => {
		const args = { prompt: "hi", resumeSessionId: "abc" };
		expect(buildClaudeArgv(args)).toEqual(buildAgentArgv("claude", args));
	});
});

describe("buildAgentArgv: gemini", () => {
	it("always passes --approval-mode=yolo", () => {
		expect(buildAgentArgv("gemini", {})).toEqual(["--approval-mode=yolo"]);
	});

	it("passes the prompt via -i", () => {
		expect(buildAgentArgv("gemini", { prompt: "do the thing" })).toEqual([
			"--approval-mode=yolo",
			"-i",
			"do the thing",
		]);
	});

	it("ignores resumeSessionId (no resume support)", () => {
		expect(buildAgentArgv("gemini", { prompt: "x", resumeSessionId: "sess" })).toEqual([
			"--approval-mode=yolo",
			"-i",
			"x",
		]);
	});
});

describe("buildAgentArgv: codex", () => {
	it("bypasses approvals/sandbox and appends the prompt directly", () => {
		expect(buildAgentArgv("codex", { prompt: "go" })).toEqual([
			"--dangerously-bypass-approvals-and-sandbox",
			"go",
		]);
	});

	it("omits the trailing positional with no prompt", () => {
		expect(buildAgentArgv("codex", {})).toEqual([
			"--dangerously-bypass-approvals-and-sandbox",
		]);
	});
});

describe("buildAgentArgv: cursor-agent / droid", () => {
	it("cursor-agent passes auto-approval flags then the prompt", () => {
		expect(buildAgentArgv("cursor-agent", { prompt: "hello" })).toEqual([
			"--force",
			"--trust",
			"hello",
		]);
	});

	it("cursor-agent returns just the flags with no prompt", () => {
		expect(buildAgentArgv("cursor-agent", {})).toEqual(["--force", "--trust"]);
	});

	it("droid passes just the prompt with no flags (autonomy set via settings file)", () => {
		expect(buildAgentArgv("droid", { prompt: "hello" })).toEqual(["hello"]);
	});
});

describe("buildAgentArgv: opencode", () => {
	it("passes --auto then the prompt via --prompt", () => {
		expect(buildAgentArgv("opencode", { prompt: "hello" })).toEqual([
			"--auto",
			"--prompt",
			"hello",
		]);
	});

	it("returns just --auto with no prompt", () => {
		expect(buildAgentArgv("opencode", {})).toEqual(["--auto"]);
	});
});

describe("buildAgentArgv: copilot", () => {
	it("always passes --allow-all", () => {
		expect(buildAgentArgv("copilot", {})).toEqual(["--allow-all"]);
	});

	it("passes the prompt via -i", () => {
		expect(buildAgentArgv("copilot", { prompt: "hello" })).toEqual([
			"--allow-all",
			"-i",
			"hello",
		]);
	});
});

describe("buildAgentArgv: prompt sanitization end-to-end", () => {
	it("strips escape sequences and trims before building argv", () => {
		expect(buildAgentArgv("claude", { prompt: "[1m  hi there  [0m" })).toEqual([
			"--permission-mode",
			"auto",
			"hi there",
		]);
	});
});
