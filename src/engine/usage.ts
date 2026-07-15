// Real token-usage accounting, sourced from Claude Code's own transcript
// file — NOT from hook payloads directly.
//
// Claude Code's lifecycle hooks (Stop, SubagentStop, SessionEnd, ...) do not
// carry token counts, cost, or turn counts in their JSON payload — we
// verified this against the current hooks reference and by inspecting real
// payloads. What every hook payload DOES carry is `transcript_path`: the
// path to that session's `~/.claude/projects/<slug>/<session_id>.jsonl`
// transcript. Each assistant message logged there includes a `usage` block
// shaped like the Anthropic API's response usage (input_tokens,
// output_tokens, cache_creation_input_tokens, cache_read_input_tokens) — real
// numbers Claude Code itself recorded, not an estimate.
//
// There is no cost/price field anywhere in the transcript — only token counts
// and the model that produced each message. To show a dollar figure we capture
// the model here and let the web UI apply a per-model price table (see
// web/src/lib/pricing.ts): keeping the rates on the client means updating them
// is a UI change, not a daemon restart, and the displayed number is clearly an
// estimate — Claude Code's own authoritative cost is not exposed to us.
import { readFileSync, statSync } from "node:fs";

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	/** Total cache-write tokens (cacheCreation5mTokens + cacheCreation1hTokens);
	 * kept for display purposes (e.g. total token counts). Use the two fields
	 * below for pricing — the two TTL tiers cost different multiples. */
	cacheCreationTokens: number;
	/** Cache writes billed at the default 5-minute TTL rate. */
	cacheCreation5mTokens: number;
	/** Cache writes billed at the (pricier) 1-hour TTL rate. */
	cacheCreation1hTokens: number;
	cacheReadTokens: number;
	/** Count of top-level (non-subagent) assistant messages — a proxy for
	 * "turns": one user prompt can still produce several of these across a
	 * tool-use loop, so treat this as relative, not exact. */
	turnCount: number;
	/** Model id from the most recent top-level (non-subagent) assistant
	 * message (e.g. "claude-sonnet-5"). Drives the cost estimate in the UI;
	 * null if the transcript never named one. Subagents can run a different
	 * model than the main conversation, but we price every token (including
	 * subagent tokens counted below) at this single rate — a session is
	 * treated as effectively single-model for estimation purposes. */
	model: string | null;
}

// Recomputing usage means re-reading the whole transcript on every Stop
// event, which is O(session length) each time. Fine for the sizes a local
// coding session produces; past this many bytes we skip rather than risk
// blocking the daemon's event loop on a pathological transcript.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

interface TranscriptUsageBlock {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	/** TTL breakdown of cache_creation_input_tokens, present on current
	 * transcripts. Falls back to treating it all as 5-minute-TTL writes when
	 * absent (older transcripts predate this field). */
	cache_creation?: {
		ephemeral_5m_input_tokens?: number;
		ephemeral_1h_input_tokens?: number;
	};
}

interface TranscriptLine {
	type?: string;
	isSidechain?: boolean;
	message?: { usage?: TranscriptUsageBlock; model?: string };
}

/**
 * Parse a Claude Code transcript JSONL file and sum token usage across every
 * assistant message, including `isSidechain` entries (subagent turns embedded
 * inline) — Claude Code's own session cost accounting includes subagent
 * usage, so excluding it here made the estimate undercount whenever a Task/
 * Agent tool ran. Sidechain entries still don't count toward `turnCount` or
 * `model` (those describe the main conversation). Returns null if the file
 * can't be read or parsed at all; malformed individual lines (the file is
 * written async and can be mid-write when a hook fires) are skipped rather
 * than failing the whole parse.
 */
export function parseTranscriptUsage(transcriptPath: string): UsageTotals | null {
	if (!transcriptPath) return null;
	try {
		const size = statSync(transcriptPath).size;
		if (size === 0 || size > MAX_TRANSCRIPT_BYTES) return null;
	} catch {
		return null;
	}

	let raw: string;
	try {
		raw = readFileSync(transcriptPath, "utf-8");
	} catch {
		return null;
	}

	const totals: UsageTotals = {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
		cacheReadTokens: 0,
		turnCount: 0,
		model: null,
	};

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: TranscriptLine;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue; // partial/corrupt line (e.g. transcript mid-write) — skip it
		}
		if (entry.type !== "assistant") continue;
		const usage = entry.message?.usage;
		if (!usage) continue;

		totals.inputTokens += usage.input_tokens ?? 0;
		totals.outputTokens += usage.output_tokens ?? 0;
		totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;

		const cacheCreation = usage.cache_creation_input_tokens ?? 0;
		totals.cacheCreationTokens += cacheCreation;
		if (usage.cache_creation) {
			totals.cacheCreation5mTokens += usage.cache_creation.ephemeral_5m_input_tokens ?? 0;
			totals.cacheCreation1hTokens += usage.cache_creation.ephemeral_1h_input_tokens ?? 0;
		} else {
			totals.cacheCreation5mTokens += cacheCreation; // no TTL breakdown: assume default 5m tier
		}

		if (entry.isSidechain === true) continue; // subagent turn: tokens above count toward cost, but not toward turnCount/model
		totals.turnCount += 1;
		if (entry.message?.model) totals.model = entry.message.model;
	}

	return totals;
}
