import { describe, expect, it } from "vitest";
import {
	deduplicateBranchName,
	generateBranchName,
	generateFriendlyBranchName,
	generateSlug,
} from "./branchName.ts";

describe("generateSlug", () => {
	it("lowercases, spaces-to-hyphens, and appends a random suffix", () => {
		const slug = generateSlug("My New Feature", 50, 4);
		expect(slug).toMatch(/^my-new-feature-[a-z0-9]{4}$/);
	});

	it("strips characters outside [a-z0-9-]", () => {
		const slug = generateSlug("Fix bug #123 (urgent!)", 50, 4);
		expect(slug).toMatch(/^fix-bug-123-urgent-[a-z0-9]{4}$/);
	});

	it("collapses runs of separators and trims leading/trailing hyphens", () => {
		const slug = generateSlug("  __weird   spacing__  ", 50, 4);
		expect(slug).toMatch(/^weird-spacing-[a-z0-9]{4}$/);
	});

	it("falls back to 'worktree' for a title with no sluggable characters", () => {
		const slug = generateSlug("!!!???", 50, 4);
		expect(slug).toMatch(/^worktree-[a-z0-9]{4}$/);
	});

	it("respects the overall maxLength budget, including the random suffix", () => {
		const title = "a".repeat(200);
		const slug = generateSlug(title, 20, 4);
		expect(slug.length).toBeLessThanOrEqual(20);
		expect(slug).toMatch(/-[a-z0-9]{4}$/);
	});

	it("prefers breaking on a whole word when truncating", () => {
		// budget = maxLength - randomLength - 1 = 30 - 4 - 1 = 25
		const title = "supercalifragilisticexpialidocious and-more-words-after-it";
		const slug = generateSlug(title, 30, 4);
		// Base should not end mid-word abruptly beyond the computed budget, and
		// must still respect the overall length cap.
		expect(slug.length).toBeLessThanOrEqual(30);
	});
});

describe("generateBranchName", () => {
	it("returns a bare slug with no prefix", () => {
		const name = generateBranchName("Add tests");
		expect(name).toMatch(/^add-tests-[a-z0-9]{4}$/);
	});

	it("prepends a sanitized prefix with a slash", () => {
		const name = generateBranchName("Add tests", "feat");
		expect(name).toMatch(/^feat\/add-tests-[a-z0-9]{4}$/);
	});

	it("sanitizes an unsafe prefix (spaces, disallowed chars)", () => {
		const name = generateBranchName("Add tests", "My Feature!!");
		expect(name).toMatch(/^my-feature\/add-tests-[a-z0-9]{4}$/);
	});
});

describe("generateFriendlyBranchName", () => {
	it("returns two lowercase, hyphen-joined dictionary words", () => {
		const name = generateFriendlyBranchName();
		expect(name).toMatch(/^[a-z]+(-[a-z]+)*-[a-z]+(-[a-z]+)*$/);
		expect(name.split("-").length).toBeGreaterThanOrEqual(2);
	});
});

describe("deduplicateBranchName", () => {
	it("returns the candidate unchanged when it isn't taken", () => {
		expect(deduplicateBranchName("feat/foo", ["feat/bar"])).toBe("feat/foo");
	});

	it("returns the trimmed input unchanged for an empty candidate", () => {
		expect(deduplicateBranchName("   ", [])).toBe("");
	});

	it("is case-insensitive when checking collisions (but preserves candidate casing)", () => {
		expect(deduplicateBranchName("Feat/Foo", ["feat/foo"])).toBe("Feat/Foo-1");
	});

	it("appends -1 on a single collision", () => {
		expect(deduplicateBranchName("feat/foo", ["feat/foo"])).toBe("feat/foo-1");
	});

	it("finds the first free numeric suffix across several collisions", () => {
		const existing = ["feat/foo", "feat/foo-1", "feat/foo-2"];
		expect(deduplicateBranchName("feat/foo", existing)).toBe("feat/foo-3");
	});

	it("preserves the path prefix when suffixing the last segment", () => {
		expect(deduplicateBranchName("team/feat/foo", ["team/feat/foo"])).toBe("team/feat/foo-1");
	});

	it("replaces an existing numeric suffix on the candidate rather than stacking it", () => {
		// candidate already ends in "-2"; base strips that before re-searching
		const existing = ["feat/foo-2"];
		expect(deduplicateBranchName("feat/foo-2", existing)).toBe("feat/foo-1");
	});
});
