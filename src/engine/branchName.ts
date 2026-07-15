// Branch/slug name generation for new workspaces: turn a free-form prompt
// (or nothing, for a prompt-less workspace) into a valid, readable git
// branch name, and keep it collision-free against whatever branches a repo
// already has.
import friendlyWords from "friendly-words";

const SEGMENT_MAX_LENGTH = 50;
const SLUG_MAX_LENGTH = 50;
const SLUG_RANDOM_LENGTH = 4;

/**
 * Reduce one "/"-separated segment of a branch name down to characters git
 * actually allows there (see `git check-ref-format`), plus stripping a
 * couple of sequences ("..", trailing ".lock", "@{") that are valid
 * characters individually but have special git meaning in combination.
 */
function sanitizeSegment(segment: string, maxLength = SEGMENT_MAX_LENGTH): string {
	return segment
		.toLowerCase()
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9._+@-]/g, "")
		.replace(/\.{2,}/g, ".")
		.replace(/@\{/g, "@")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.replace(/\.lock$/, "")
		.slice(0, maxLength);
}

/** Sanitize every "/"-separated segment of a branch name independently, dropping empty ones. */
function sanitizeBranchName(name: string): string {
	return name
		.split("/")
		.map((segment) => sanitizeSegment(segment))
		.filter(Boolean)
		.join("/");
}

/**
 * If `candidate` isn't already in `existingBranchNames` (case-insensitive),
 * return it unchanged. Otherwise append "-1", "-2", ... to its last path
 * segment until one isn't taken.
 */
export function deduplicateBranchName(candidate: string, existingBranchNames: string[]): string {
	const trimmed = candidate.trim();
	if (!trimmed) return trimmed;

	const taken = new Set(existingBranchNames.map((name) => name.toLowerCase()));
	if (!taken.has(trimmed.toLowerCase())) return trimmed;

	const segments = trimmed.split("/");
	const prefix = segments.slice(0, -1).join("/");
	const base = (segments.at(-1) ?? trimmed).replace(/-\d+$/, "");
	const withSuffix = (n: number) => (prefix ? `${prefix}/${base}-${n}` : `${base}-${n}`);

	for (let n = 1; n < 10_000; n++) {
		const attempt = withSuffix(n);
		if (!taken.has(attempt.toLowerCase())) return attempt;
	}
	// Practically unreachable (10k collisions on one base name), but never
	// return something that collides.
	return withSuffix(Date.now());
}

function randomSlugSuffix(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < length; i++) {
		out += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return out;
}

/** "My New Feature" -> "my-new-feature-a8f3" */
export function generateSlug(
	title: string,
	maxLength = SLUG_MAX_LENGTH,
	randomLength = SLUG_RANDOM_LENGTH,
): string {
	const base =
		title
			.toLowerCase()
			.trim()
			.replace(/[\s_]+/g, "-")
			.replace(/[^a-z0-9-]/g, "")
			.replace(/-+/g, "-")
			.replace(/^-+|-+$/g, "") || "worktree";

	const budget = maxLength - randomLength - 1; // 1 for the separating hyphen
	let trimmedBase = base;
	if (trimmedBase.length > budget) {
		const cut = trimmedBase.slice(0, budget);
		// Prefer breaking on a whole word if the cut only loses a small tail.
		const lastHyphen = cut.lastIndexOf("-");
		trimmedBase = (lastHyphen > budget * 0.7 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, "");
	}

	return `${trimmedBase}-${randomSlugSuffix(randomLength)}`;
}

/** "My New Feature" + prefix "feat" -> "feat/my-new-feature-a8f3" */
export function generateBranchName(title: string, prefix?: string): string {
	const slug = generateSlug(title);
	const cleanPrefix = prefix ? sanitizeBranchName(prefix) : "";
	return cleanPrefix ? `${cleanPrefix}/${slug}` : slug;
}

/** Two random friendly words for a prompt-less workspace, e.g. "cheerful-umbrella". */
export function generateFriendlyBranchName(): string {
	const predicates = friendlyWords.predicates as string[];
	const objects = friendlyWords.objects as string[];
	const predicate = predicates[Math.floor(Math.random() * predicates.length)];
	const object = objects[Math.floor(Math.random() * objects.length)];
	return `${predicate}-${object}`;
}
