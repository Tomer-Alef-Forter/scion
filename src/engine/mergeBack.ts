// Local merge-back — NEW logic (superset only merges via `gh pr merge`).
// Merges a worktree branch into its base branch in the MAIN repo checkout.
import { createUserSimpleGit } from "./gitClient.ts";
import { getBaseBranch, isClean } from "./diff.ts";

export interface MergeResult {
	ok: boolean;
	base: string;
	message: string;
}

export async function mergeBack(args: {
	repoPath: string;
	branch: string;
	worktreePath: string;
}): Promise<MergeResult> {
	const base = await getBaseBranch(args.repoPath, args.worktreePath);

	if (!(await isClean(args.worktreePath))) {
		return {
			ok: false,
			base,
			message: `Worktree has uncommitted changes — commit or discard them before merging into ${base}.`,
		};
	}

	const git = createUserSimpleGit(args.repoPath);
	const previous = (
		await git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "")
	).trim();

	try {
		await git.raw(["checkout", base]);
	} catch (err) {
		return {
			ok: false,
			base,
			message: `Could not check out ${base} in the main repo: ${errMsg(err)}`,
		};
	}

	try {
		await git.raw(["merge", "--no-ff", args.branch]);
		return { ok: true, base, message: `Merged ${args.branch} into ${base}.` };
	} catch (err) {
		// Abort so the main repo isn't left in a conflicted state.
		await git.raw(["merge", "--abort"]).catch(() => {});
		if (previous && previous !== "HEAD") {
			await git.raw(["checkout", previous]).catch(() => {});
		}
		return {
			ok: false,
			base,
			message: `Merge of ${args.branch} into ${base} hit conflicts and was aborted. Resolve manually. (${errMsg(err)})`,
		};
	}
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message.split("\n")[0] ?? err.message : String(err);
}
