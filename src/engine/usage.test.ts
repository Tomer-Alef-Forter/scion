import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTranscriptUsage } from "./usage.ts";

// Build a transcript JSONL from line objects, one JSON object per line — the
// shape Claude Code writes to ~/.claude/projects/<slug>/<session>.jsonl.
function transcript(lines: unknown[]): string {
	return lines.map((l) => JSON.stringify(l)).join("\n");
}

function assistantMsg(usage: Record<string, number>, model?: string, extra?: Record<string, unknown>) {
	return {
		type: "assistant",
		...extra,
		message: { model, usage },
	};
}

describe("parseTranscriptUsage", () => {
	let dir: string;
	const write = async (name: string, contents: string) => {
		const p = join(dir, name);
		await writeFile(p, contents);
		return p;
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "scion-usage-test-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("sums token fields across assistant messages and counts turns", async () => {
		const p = await write(
			"t.jsonl",
			transcript([
				assistantMsg(
					{ input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000 },
					"claude-sonnet-5",
				),
				assistantMsg(
					{ input_tokens: 20, output_tokens: 200, cache_creation_input_tokens: 7, cache_read_input_tokens: 2000 },
					"claude-sonnet-5",
				),
			]),
		);
		expect(parseTranscriptUsage(p)).toEqual({
			inputTokens: 30,
			outputTokens: 300,
			cacheCreationTokens: 12,
			cacheCreation5mTokens: 12,
			cacheCreation1hTokens: 0,
			cacheReadTokens: 3000,
			turnCount: 2,
			model: "claude-sonnet-5",
		});
	});

	it("splits cache_creation_input_tokens into 5m/1h tiers when the breakdown is present", async () => {
		const p = await write(
			"t.jsonl",
			transcript([
				{
					type: "assistant",
					message: {
						model: "claude-sonnet-5",
						usage: {
							input_tokens: 2,
							output_tokens: 248,
							cache_creation_input_tokens: 9539,
							cache_read_input_tokens: 26631,
							cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9539 },
						},
					},
				},
			]),
		);
		const r = parseTranscriptUsage(p);
		expect(r?.cacheCreationTokens).toBe(9539);
		expect(r?.cacheCreation5mTokens).toBe(0);
		expect(r?.cacheCreation1hTokens).toBe(9539);
	});

	it("falls back to the 5m tier when no cache_creation breakdown is present", async () => {
		const p = await write(
			"t.jsonl",
			transcript([
				assistantMsg(
					{ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 50 },
					"claude-sonnet-5",
				),
			]),
		);
		const r = parseTranscriptUsage(p);
		expect(r?.cacheCreation5mTokens).toBe(50);
		expect(r?.cacheCreation1hTokens).toBe(0);
	});

	it("captures the most recent model seen", async () => {
		const p = await write(
			"t.jsonl",
			transcript([
				assistantMsg({ input_tokens: 1, output_tokens: 1 }, "claude-opus-4-8"),
				assistantMsg({ input_tokens: 1, output_tokens: 1 }, "claude-sonnet-5"),
			]),
		);
		expect(parseTranscriptUsage(p)?.model).toBe("claude-sonnet-5");
	});

	it("counts isSidechain (subagent) tokens toward totals but not turnCount/model", async () => {
		const p = await write(
			"t.jsonl",
			transcript([
				assistantMsg({ input_tokens: 10, output_tokens: 10 }, "claude-sonnet-5"),
				assistantMsg({ input_tokens: 999, output_tokens: 999 }, "claude-haiku-4-5", { isSidechain: true }),
			]),
		);
		const r = parseTranscriptUsage(p);
		expect(r?.turnCount).toBe(1);
		expect(r?.inputTokens).toBe(1009);
		expect(r?.model).toBe("claude-sonnet-5"); // subagent's model doesn't override the main conversation's
	});

	it("ignores non-assistant lines and messages without a usage block", async () => {
		const p = await write(
			"t.jsonl",
			transcript([
				{ type: "user", message: { content: "hi" } },
				{ type: "assistant", message: { model: "claude-sonnet-5" } }, // no usage
				assistantMsg({ input_tokens: 5, output_tokens: 5 }, "claude-sonnet-5"),
			]),
		);
		const r = parseTranscriptUsage(p);
		expect(r?.turnCount).toBe(1);
		expect(r?.inputTokens).toBe(5);
	});

	it("skips malformed lines (transcript can be mid-write) rather than failing", async () => {
		const p = await write(
			"t.jsonl",
			[
				JSON.stringify(assistantMsg({ input_tokens: 5, output_tokens: 5 }, "claude-sonnet-5")),
				"{ this is not valid json", // partial line
				JSON.stringify(assistantMsg({ input_tokens: 5, output_tokens: 5 }, "claude-sonnet-5")),
			].join("\n"),
		);
		expect(parseTranscriptUsage(p)?.turnCount).toBe(2);
	});

	it("returns null for an empty file or a missing path", async () => {
		const empty = await write("empty.jsonl", "");
		expect(parseTranscriptUsage(empty)).toBeNull();
		expect(parseTranscriptUsage(join(dir, "does-not-exist.jsonl"))).toBeNull();
		expect(parseTranscriptUsage("")).toBeNull();
	});

	it("leaves model null when no message named one", async () => {
		const p = await write("t.jsonl", transcript([assistantMsg({ input_tokens: 1, output_tokens: 1 })]));
		expect(parseTranscriptUsage(p)?.model).toBeNull();
	});
});
