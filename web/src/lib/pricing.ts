import type { SessionUsage } from "./api";

// Per-model token pricing, USD per 1 MILLION tokens. Source: Anthropic pricing
// as of 2026-07. This is a hardcoded table and WILL drift as pricing changes —
// the cost it produces is an ESTIMATE, always labelled "~$… est." in the UI,
// never presented as an authoritative charge (Claude Code's real cost is not
// exposed to Scion). Cache tokens are billed off the input rate: writes at
// 1.25× for the default 5-minute TTL, 2× for the (pricier) 1-hour TTL; reads
// at 0.1× regardless of which TTL tier wrote them.
interface ModelRate {
	/** USD per 1M input tokens. */
	input: number;
	/** USD per 1M output tokens. */
	output: number;
}

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;
const CACHE_READ_MULTIPLIER = 0.1;

// Sonnet 5 has promotional intro pricing ($2/$10 per MTok) through 2026-08-31,
// reverting to standard ($3/$15) after. Resolved at render time so the estimate
// tracks the change on its own, without a code edit.
function sonnet5Rate(now: Date): ModelRate {
	const introEnds = Date.UTC(2026, 8, 1); // 2026-09-01 UTC (month is 0-indexed)
	return now.getTime() < introEnds ? { input: 2.0, output: 10.0 } : { input: 3.0, output: 15.0 };
}

/** Match a transcript model id to a rate row. Ids look like "claude-sonnet-5",
 * "claude-opus-4-8", "claude-haiku-4-5-20251001" — match on family substring so
 * dated snapshots resolve too. Unknown models fall back to Sonnet (the common
 * case) so we still show something, rather than dropping the estimate. */
function rateFor(model: string | null, now: Date): ModelRate {
	const id = (model ?? "").toLowerCase();
	if (id.includes("opus")) return { input: 5.0, output: 25.0 };
	if (id.includes("haiku")) return { input: 1.0, output: 5.0 };
	return sonnet5Rate(now); // sonnet, or unknown → sonnet fallback
}

/**
 * Estimate the USD cost of a session's cumulative token usage. Returns null
 * when there's nothing to price yet (no completed turn). This is an estimate,
 * not a billed amount — see the price-table note above.
 */
export function estimateCostUsd(usage: SessionUsage, now: Date = new Date()): number | null {
	if (usage.turnCount === 0) return null;
	const { input, output } = rateFor(usage.model, now);
	const perMillion =
		usage.totalInputTokens * input +
		usage.totalOutputTokens * output +
		usage.totalCacheCreation5mTokens * input * CACHE_WRITE_5M_MULTIPLIER +
		usage.totalCacheCreation1hTokens * input * CACHE_WRITE_1H_MULTIPLIER +
		usage.totalCacheReadTokens * input * CACHE_READ_MULTIPLIER;
	return perMillion / 1_000_000;
}

/** "~$1.23" / "~$0.04" / "~$12" — compact estimated-cost formatting. */
export function formatCostUsd(usd: number): string {
	if (usd >= 100) return `~$${Math.round(usd)}`;
	if (usd >= 1) return `~$${usd.toFixed(2)}`;
	return `~$${usd.toFixed(2)}`; // sub-$1 still gets cents, e.g. ~$0.04
}
