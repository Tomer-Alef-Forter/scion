// Copied verbatim from superset
// (~/Projects/superset/packages/shared/src/workspace-launch/{branch,slug,friendly-branch-name}.ts).
// Pure, dependency-free except `friendly-words`.
import friendlyWords from "friendly-words";

export const DEFAULT_BRANCH_SEGMENT_MAX_LENGTH = 50;
const MAX_BRANCH_LENGTH = 100;

interface SanitizeSegmentOptions {
	preserveCase?: boolean;
}

export function sanitizeSegment(
	text: string,
	maxLength = DEFAULT_BRANCH_SEGMENT_MAX_LENGTH,
	{ preserveCase = false }: SanitizeSegmentOptions = {},
): string {
	const normalized = preserveCase ? text : text.toLowerCase();
	const allowedCharacters = preserveCase
		? /[^a-zA-Z0-9._+@-]/g
		: /[^a-z0-9._+@-]/g;

	return normalized
		.trim()
		.replace(/\s+/g, "-")
		.replace(allowedCharacters, "")
		.replace(/\.{2,}/g, ".")
		.replace(/@\{/g, "@")
		.replace(/-+/g, "-")
		.replace(/^[-.]|[-.]+$/g, "")
		.replace(/\.lock$/g, "")
		.slice(0, maxLength);
}

export function sanitizeBranchName(name: string): string {
	return name
		.split("/")
		.map((segment) => sanitizeSegment(segment))
		.filter(Boolean)
		.join("/");
}

/**
 * Strips only what git forbids from a user-typed branch name.
 * Preserves case, slashes, underscores — respects user intent.
 */
export function sanitizeUserBranchName(
	name: string,
	maxLength = MAX_BRANCH_LENGTH,
): string {
	return name
		.trim()
		.replace(/\.\./g, ".")
		.replace(/[~^:?*[\]\\]/g, "")
		// biome-ignore lint: stripping control chars intentionally
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/@\{/g, "@")
		.replace(/\.lock$/g, "")
		.replace(/^-/, "")
		.replace(/\/+/g, "/")
		.replace(/^\/|\/$/g, "")
		.slice(0, maxLength)
		.replace(/[-./]+$/g, "");
}

/**
 * Returns a branch name that does not collide with existing names, appending
 * numeric suffixes (-1, -2, …) to the last path segment until free.
 */
export function deduplicateBranchName(
	candidate: string,
	existingBranchNames: string[],
): string {
	const normalizedCandidate = candidate.trim();
	if (!normalizedCandidate) return normalizedCandidate;

	const existingSet = new Set(existingBranchNames.map((b) => b.toLowerCase()));
	if (!existingSet.has(normalizedCandidate.toLowerCase()))
		return normalizedCandidate;

	const segments = normalizedCandidate.split("/");
	const lastSegment = segments.at(-1) ?? normalizedCandidate;
	const prefix = segments.slice(0, -1).join("/");
	const strippedBase = lastSegment.replace(/-\d+$/, "");
	const baseSegment = strippedBase || lastSegment;
	const append = (suffix: number) =>
		prefix ? `${prefix}/${baseSegment}-${suffix}` : `${baseSegment}-${suffix}`;

	for (let suffix = 1; suffix < 10_000; suffix++) {
		const deduplicated = append(suffix);
		if (!existingSet.has(deduplicated.toLowerCase())) return deduplicated;
	}
	return prefix
		? `${prefix}/${baseSegment}-${Date.now()}`
		: `${baseSegment}-${Date.now()}`;
}

/** "My New Feature" -> "my-new-feature-a8f3" */
export function generateSlug(title: string, maxLength = 50, randomLength = 4): string {
	let slug = title
		.toLowerCase()
		.trim()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) slug = "worktree";

	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let randomSuffix = "";
	for (let i = 0; i < randomLength; i++) {
		randomSuffix += chars.charAt(Math.floor(Math.random() * chars.length));
	}

	const availableLength = maxLength - randomLength - 1;
	if (slug.length > availableLength) {
		const truncated = slug.substring(0, availableLength);
		const lastHyphen = truncated.lastIndexOf("-");
		slug =
			lastHyphen > availableLength * 0.7
				? truncated.substring(0, lastHyphen)
				: truncated;
		slug = slug.replace(/-+$/, "");
	}
	return `${slug}-${randomSuffix}`;
}

/** "My New Feature" + prefix "feat" -> "feat/my-new-feature-a8f3" */
export function generateBranchName(title: string, prefix?: string): string {
	const slug = generateSlug(title);
	if (prefix) {
		const cleanPrefix = sanitizeBranchName(prefix);
		if (!cleanPrefix) return slug;
		return `${cleanPrefix}/${slug}`;
	}
	return slug;
}

/** Two friendly words, e.g. "cheerful-umbrella". */
export function generateFriendlyBranchName(): string {
	const predicates = friendlyWords.predicates as string[];
	const objects = friendlyWords.objects as string[];
	const predicate = predicates[Math.floor(Math.random() * predicates.length)];
	const object = objects[Math.floor(Math.random() * objects.length)];
	return `${predicate}-${object}`;
}
