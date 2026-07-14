import type { SessionUsage } from "../../lib/api";

/** "12.3k" / "1.2M" / "842" — compact token-count formatting. */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

/**
 * Prominent per-session token usage for the detail-panel header — real
 * cumulative input+output token counts read from Claude Code's own transcript
 * (see src/engine/usage.ts). Hidden until a turn has completed and only present
 * for Claude sessions. No cost is shown: there is no price field in the source
 * data, and we don't estimate one.
 */
export function TokenUsageBadge({ usage }: { usage: SessionUsage | null }) {
	if (!usage || usage.turnCount === 0) return null;
	const total = usage.totalInputTokens + usage.totalOutputTokens;
	return (
		<span
			title={
				`Input ${usage.totalInputTokens.toLocaleString()} · ` +
				`Output ${usage.totalOutputTokens.toLocaleString()} · ` +
				`Cache read ${usage.totalCacheReadTokens.toLocaleString()} · ` +
				`${usage.turnCount} turns`
			}
			className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium"
		>
			<span className="text-muted-foreground">Tokens</span>
			<span className="tabular-nums">{formatTokens(total)}</span>
			<span className="text-muted-foreground">· {usage.turnCount} turns</span>
		</span>
	);
}
