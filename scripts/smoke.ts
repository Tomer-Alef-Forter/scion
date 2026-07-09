// Headless end-to-end smoke test for the engine + hook pipeline.
// Exercises: project + worktree create, diff summary, PTY spawn, hook server →
// status mapping, and local merge-back — WITHOUT launching real claude
// (a `bash sleep` stands in for the agent process). Run: `bun run smoke`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/db.ts";
import { terminalSessions } from "../src/db/schema.ts";
import { getHookUrl } from "../src/hookAddr.ts";
import { getDiffSummary } from "../src/engine/diff.ts";
import { mergeBack } from "../src/engine/mergeBack.ts";
import { getSession, killAll, spawnSession } from "../src/engine/pty.ts";
import { createStatusStore } from "../src/engine/status.ts";
import { addWorktree } from "../src/engine/worktrees.ts";
import { startHookServer } from "../src/hookServer.ts";
import { createStore } from "../src/store/projects.ts";

let failures = 0;
function check(label: string, cond: boolean) {
	console.log(`${cond ? "✅" : "❌"} ${label}`);
	if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function main() {
	const base = mkdtempSync(join(tmpdir(), "sl-smoke-"));
	const repo = join(base, "repo");
	execFileSync("git", ["init", "-q", "-b", "main", repo]);
	git(repo, ["config", "user.email", "smoke@test.local"]);
	git(repo, ["config", "user.name", "Smoke Test"]);
	writeFileSync(join(repo, "README.md"), "# repo\n");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-q", "-m", "init"]);

	const db = createDb(join(base, "host.db"));
	const status = createStatusStore(db);
	const store = createStore(db, status);
	const server = await startHookServer(status);

	try {
		const project = await store.addProject(repo);
		check(
			"addProject registers repo",
			store.listProjects().some((p) => p.id === project.id),
		);

		const wt = await addWorktree({
			projectId: project.id,
			repoPath: repo,
			branch: "feat/smoke",
		});
		check("worktree dir exists", existsSync(wt.worktreePath));
		check(
			"branch created",
			git(repo, ["branch", "--format=%(refname:short)"])
				.split("\n")
				.includes("feat/smoke"),
		);
		check("base branch resolved to main", wt.baseBranch === "main");

		writeFileSync(join(wt.worktreePath, "feature.txt"), "hello from agent\n");
		git(wt.worktreePath, ["add", "-A"]);
		git(wt.worktreePath, ["commit", "-q", "-m", "add feature"]);
		const summary = await getDiffSummary(repo, wt.worktreePath);
		check("diff summary sees 1 changed file", summary.filesChanged === 1);
		check("diff summary counts insertions", summary.insertions >= 1);

		const terminalId = "term-smoke-1";
		// Real flow (store.createWorkspace) inserts a terminal_sessions row before
		// launching; the agent-binding FK depends on it. Mirror that here.
		db.insert(terminalSessions)
			.values({
				id: terminalId,
				workspaceId: null,
				status: "active",
				createdAt: Date.now(),
				endedAt: null,
			})
			.run();
		spawnSession({
			id: terminalId,
			workspaceId: "ws-smoke-1",
			file: "bash",
			args: ["-c", "sleep 3"],
			cwd: wt.worktreePath,
		});
		check("pty session registered", !!getSession(terminalId));

		const postHook = async (eventType: string) => {
			const res = await fetch(getHookUrl(), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					json: {
						terminalId,
						eventType,
						agent: { agentId: "claude", sessionId: "s1" },
					},
				}),
			});
			return res.status;
		};

		const c1 = await postHook("UserPromptSubmit");
		await sleep(60);
		check("hook POST accepted (200)", c1 === 200);
		check(
			"UserPromptSubmit → working",
			status.listByWorkspace("ws-smoke-1")[0]?.status === "working",
		);

		await postHook("Stop");
		await sleep(60);
		check(
			"Stop → review (unseen)",
			status.listByWorkspace("ws-smoke-1")[0]?.status === "review",
		);

		status.markSeen("ws-smoke-1");
		check(
			"markSeen → idle",
			status.listByWorkspace("ws-smoke-1")[0]?.status === "idle",
		);

		await postHook("SessionEnd");
		await sleep(60);
		check(
			"SessionEnd removes binding",
			status.listByWorkspace("ws-smoke-1").length === 0,
		);

		const merge = await mergeBack({
			repoPath: repo,
			branch: "feat/smoke",
			worktreePath: wt.worktreePath,
		});
		check("mergeBack ok", merge.ok === true);
		check("feature.txt merged into main", existsSync(join(repo, "feature.txt")));
	} finally {
		killAll();
		server.close();
		execFileSync("rm", ["-rf", base]);
	}

	console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
