// Pushes a workspace's branch and opens a GitHub PR via `gh` — the missing
// other half of mergeBack.ts's LOCAL merge (superset does this via `gh pr
// merge` instead). Adds just PR creation, not a full in-app PR review system.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createUserSimpleGit } from "./gitClient.ts";

const execFileAsync = promisify(execFile);

export interface CreatePullRequestResult {
	url: string;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
}

export async function createPullRequest(args: {
	worktreePath: string;
	branch: string;
}): Promise<CreatePullRequestResult> {
	const git = createUserSimpleGit(args.worktreePath);
	try {
		await git.raw(["push", "-u", "origin", args.branch]);
	} catch (err) {
		throw new Error(`git push failed: ${errMsg(err)}`);
	}

	try {
		await execFileAsync("gh", ["--version"]);
	} catch {
		throw new Error("GitHub CLI (gh) is not installed — see https://cli.github.com/");
	}

	try {
		const { stdout } = await execFileAsync(
			"gh",
			["pr", "create", "--fill", "--head", args.branch],
			{ cwd: args.worktreePath },
		);
		const url = stdout.match(/https:\/\/github\.com\/\S+/)?.[0];
		if (!url) throw new Error(`gh pr create didn't return a URL: ${stdout.trim()}`);
		return { url };
	} catch (err) {
		// A PR for this branch may already exist (e.g. a repeat click after
		// pushing more commits) — fall back to the existing PR's URL instead
		// of erroring.
		try {
			const { stdout } = await execFileAsync(
				"gh",
				["pr", "view", "--json", "url", "--jq", ".url"],
				{ cwd: args.worktreePath },
			);
			const url = stdout.trim();
			if (url) return { url };
		} catch {
			// Fall through to the original error below.
		}
		throw new Error(`gh pr create failed: ${errMsg(err)}`);
	}
}
