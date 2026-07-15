import { describe, expect, it } from "vitest";
import type { SessionUsage } from "./api";
import { estimateCostUsd, formatCostUsd } from "./pricing";

function usage(over: Partial<SessionUsage>): SessionUsage {
	return {
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheCreationTokens: 0,
		totalCacheReadTokens: 0,
		turnCount: 1,
		usageUpdatedAt: Date.now(),
		model: "claude-sonnet-5",
		...over,
	};
}

const DURING_INTRO = new Date("2026-07-15T00:00:00Z"); // before 2026-08-31
const AFTER_INTRO = new Date("2026-10-01T00:00:00Z");

describe("estimateCostUsd", () => {
	it("returns null before any turn has completed", () => {
		expect(estimateCostUsd(usage({ turnCount: 0, totalOutputTokens: 1_000_000 }))).toBeNull();
	});

	it("prices output tokens at the model's output rate (sonnet intro = $10/M)", () => {
		const c = estimateCostUsd(usage({ totalOutputTokens: 1_000_000 }), DURING_INTRO);
		expect(c).toBeCloseTo(10, 6);
	});

	it("uses Sonnet 5 standard pricing ($15/M output) after the intro window", () => {
		const c = estimateCostUsd(usage({ totalOutputTokens: 1_000_000 }), AFTER_INTRO);
		expect(c).toBeCloseTo(15, 6);
	});

	it("prices cache reads at 0.1x input and cache writes at 1.25x input", () => {
		// Sonnet intro input rate = $2/M.
		const reads = estimateCostUsd(usage({ totalCacheReadTokens: 1_000_000 }), DURING_INTRO);
		expect(reads).toBeCloseTo(2 * 0.1, 6); // $0.20
		const writes = estimateCostUsd(usage({ totalCacheCreationTokens: 1_000_000 }), DURING_INTRO);
		expect(writes).toBeCloseTo(2 * 1.25, 6); // $2.50
	});

	it("applies Opus rates for an opus model id ($25/M output)", () => {
		const c = estimateCostUsd(
			usage({ model: "claude-opus-4-8", totalOutputTokens: 1_000_000 }),
			DURING_INTRO,
		);
		expect(c).toBeCloseTo(25, 6);
	});

	it("applies Haiku rates for a dated haiku snapshot id ($5/M output)", () => {
		const c = estimateCostUsd(
			usage({ model: "claude-haiku-4-5-20251001", totalOutputTokens: 1_000_000 }),
			DURING_INTRO,
		);
		expect(c).toBeCloseTo(5, 6);
	});

	it("falls back to Sonnet rates for an unknown or null model", () => {
		const unknown = estimateCostUsd(
			usage({ model: "who-knows", totalOutputTokens: 1_000_000 }),
			DURING_INTRO,
		);
		const nul = estimateCostUsd(usage({ model: null, totalOutputTokens: 1_000_000 }), DURING_INTRO);
		expect(unknown).toBeCloseTo(10, 6);
		expect(nul).toBeCloseTo(10, 6);
	});
});

describe("formatCostUsd", () => {
	it("shows cents under $100 and rounds above", () => {
		expect(formatCostUsd(0.04)).toBe("~$0.04");
		expect(formatCostUsd(1.234)).toBe("~$1.23");
		expect(formatCostUsd(25.1675)).toBe("~$25.17");
		expect(formatCostUsd(137.9)).toBe("~$138");
	});
});
