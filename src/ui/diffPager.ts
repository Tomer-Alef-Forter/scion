// View a worktree's colored diff in `less -R`. Runs OUTSIDE Ink (same pattern
// as attach): Ink is unmounted first, re-rendered after less exits.
import { spawn } from "node:child_process";
import { getColoredDiff } from "../engine/diff.ts";

export async function runDiffPager(
	repoPath: string,
	worktreePath: string,
): Promise<void> {
	const diff = await getColoredDiff(repoPath, worktreePath);
	await new Promise<void>((resolve) => {
		const less = spawn("less", ["-R"], {
			stdio: ["pipe", "inherit", "inherit"],
		});
		less.on("close", () => resolve());
		less.on("error", () => {
			// less missing — just print and continue.
			process.stdout.write(diff);
			resolve();
		});
		less.stdin.write(diff);
		less.stdin.end();
	});
}
