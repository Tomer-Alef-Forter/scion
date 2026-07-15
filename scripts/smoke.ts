// Headless end-to-end smoke test for the engine + hook pipeline.
// Exercises: project + worktree create, diff summary, PTY spawn, hook server →
// status mapping, and local merge-back — WITHOUT launching real claude
// (a `bash sleep` stands in for the agent process). Run: `bun run smoke`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { NOTIFY_SCRIPT_PATH, WORKTREES_ROOT } from "../src/config.ts";
import { createDb } from "../src/db/db.ts";
import { terminalSessions, workspaces } from "../src/db/schema.ts";
import { getHookUrl } from "../src/hookAddr.ts";
import { buildAgentArgv, buildClaudeArgv } from "../src/engine/agents.ts";
import {
	deduplicateBranchName,
	generateBranchName,
	generateFriendlyBranchName,
	generateSlug,
} from "../src/engine/branchName.ts";
import { getCachedDiffSummary, getDiffSummary, invalidateDiffCache } from "../src/engine/diff.ts";
import { listFiles, readWorktreeFile } from "../src/engine/files.ts";
import { mergeBack } from "../src/engine/mergeBack.ts";
import { getSession, killAll, spawnSession } from "../src/engine/pty.ts";
import { inProcessPtyBackend } from "../src/engine/ptyBackend.ts";
import { createStatusStore } from "../src/engine/status.ts";
import { addWorktree, removeWorktree } from "../src/engine/worktrees.ts";
import { startHookServer } from "../src/hookServer.ts";
import { installClaudeHooks, uninstallClaudeHooks } from "../src/setup/installClaudeHooks.ts";
import { createStore } from "../src/store/projects.ts";

// This script does real filesystem writes/deletes under config.ts's
// DATA_DIR/WORKTREES_ROOT, which resolve from $HOME — refuse to run unless
// scripts/run-isolated.ts (see package.json's "smoke" script) has already
// pointed $HOME at a throwaway directory. Without this, an isolated test
// database checked against the real, shared WORKTREES_ROOT once caused a
// test to delete real, in-use workspace directories.
if (!process.env.SL_ISOLATED_HOME) {
	console.error(
		"refusing to run: this script must be invoked via `bun run smoke` " +
			"(scripts/run-isolated.ts), not `tsx scripts/smoke.ts` directly — " +
			"it does real filesystem writes/deletes under $HOME/.scion.",
	);
	process.exit(1);
}

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
	const store = createStore(db, status, inProcessPtyBackend);
	const server = await startHookServer(status);

	let wt: Awaited<ReturnType<typeof addWorktree>> | undefined;
	try {
		const project = await store.addProject(repo);
		check(
			"addProject registers repo",
			store.listProjects().some((p) => p.id === project.id),
		);

		wt = await addWorktree({
			projectId: project.id,
			repoPath: repo,
			branch: "feat/smoke",
		});
		check("worktree dir exists", existsSync(wt.worktreePath));
		check(
			"branch created",
			git(repo, ["branch", "--format=%(refname:short)"]).split("\n").includes("feat/smoke"),
		);
		check("base branch resolved to main", wt.baseBranch === "main");

		writeFileSync(join(wt.worktreePath, "feature.txt"), "hello from agent\n");
		git(wt.worktreePath, ["add", "-A"]);
		git(wt.worktreePath, ["commit", "-q", "-m", "add feature"]);
		const summary = await getDiffSummary(repo, wt.worktreePath);
		check("diff summary sees 1 changed file", summary.filesChanged === 1);
		check("diff summary counts insertions", summary.insertions >= 1);

		// ---- getCachedDiffSummary: coalesces repeat calls, invalidate forces a
		// fresh recompute ----

		const cachedBefore = await getCachedDiffSummary(repo, wt.worktreePath);
		check("cached diff summary matches an uncached call", cachedBefore.filesChanged === 1);

		writeFileSync(join(wt.worktreePath, "feature2.txt"), "a second change\n");
		git(wt.worktreePath, ["add", "-A"]);
		git(wt.worktreePath, ["commit", "-q", "-m", "add feature2"]);

		const cachedAfterChange = await getCachedDiffSummary(repo, wt.worktreePath);
		check(
			"cached diff summary ignores a change made within the TTL window",
			cachedAfterChange.filesChanged === 1,
		);

		invalidateDiffCache(wt.worktreePath);
		const freshAfterInvalidate = await getCachedDiffSummary(repo, wt.worktreePath);
		check(
			"invalidateDiffCache forces the next call to recompute",
			freshAfterInvalidate.filesChanged === 2,
		);

		// ---- engine/files.ts: read-only file browser ----

		writeFileSync(join(wt.worktreePath, "untracked.txt"), "not yet added\n");
		writeFileSync(join(wt.worktreePath, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(wt.worktreePath, "ignored.txt"), "should not appear\n");

		const fileList = await listFiles(wt.worktreePath);
		const filePaths = fileList.map((f) => f.path);
		check("listFiles includes tracked committed file", filePaths.includes("feature.txt"));
		check("listFiles includes untracked-but-not-ignored file", filePaths.includes("untracked.txt"));
		check("listFiles excludes gitignored file", !filePaths.includes("ignored.txt"));

		const readBack = await readWorktreeFile(wt.worktreePath, "feature.txt");
		check("readWorktreeFile returns correct contents", readBack === "hello from agent\n");

		let rejectedTraversal = false;
		try {
			await readWorktreeFile(wt.worktreePath, "../../../etc/passwd");
		} catch {
			rejectedTraversal = true;
		}
		check("readWorktreeFile rejects path traversal (..)", rejectedTraversal);

		let rejectedAbsolute = false;
		try {
			await readWorktreeFile(wt.worktreePath, "/etc/passwd");
		} catch {
			rejectedAbsolute = true;
		}
		check("readWorktreeFile rejects absolute paths", rejectedAbsolute);

		// mergeBack (below) requires a clean worktree — these were scratch files
		// for the listFiles checks above, never meant to be committed.
		execFileSync("rm", [
			"-f",
			join(wt.worktreePath, "untracked.txt"),
			join(wt.worktreePath, ".gitignore"),
			join(wt.worktreePath, "ignored.txt"),
		]);

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
		check("Stop → review (unseen)", status.listByWorkspace("ws-smoke-1")[0]?.status === "review");

		status.markSeen("ws-smoke-1");
		check("markSeen → idle", status.listByWorkspace("ws-smoke-1")[0]?.status === "idle");

		await postHook("SessionEnd");
		await sleep(60);
		check("SessionEnd removes binding", status.listByWorkspace("ws-smoke-1").length === 0);

		// ---- notify.sh: run the real installed script as a subprocess (not the
		// direct fetch() above) — proves the shell script itself still parses
		// stdin JSON and posts the right shape after its rewrite. ----

		const notifyScript = fileURLToPath(new URL("../src/setup/notify.sh", import.meta.url));
		execFileSync("bash", [notifyScript], {
			input: JSON.stringify({ session_id: "s2", hook_event_name: "UserPromptSubmit" }),
			env: {
				...process.env,
				SCION_HOST_AGENT_HOOK_URL: getHookUrl(),
				SCION_TERMINAL_ID: terminalId,
				SCION_AGENT_ID: "claude",
			},
		});
		await sleep(60);
		check(
			"notify.sh subprocess: UserPromptSubmit → working",
			status.listByWorkspace("ws-smoke-1")[0]?.status === "working",
		);
		check(
			"notify.sh subprocess: forwards session_id as agentSessionId",
			status.listByWorkspace("ws-smoke-1")[0]?.agentSessionId === "s2",
		);

		const merge = await mergeBack({
			repoPath: repo,
			branch: "feat/smoke",
			worktreePath: wt.worktreePath,
		});
		check("mergeBack ok", merge.ok === true);
		check("feature.txt merged into main", existsSync(join(repo, "feature.txt")));

		// ---- buildClaudeArgv (pure, no spawn) — the --resume flag logic ----

		check(
			"buildClaudeArgv: no prompt/no resume",
			JSON.stringify(buildClaudeArgv({})) === JSON.stringify(["--permission-mode", "auto"]),
		);
		check(
			"buildClaudeArgv: prompt only",
			JSON.stringify(buildClaudeArgv({ prompt: "fix bug" })) ===
				JSON.stringify(["--permission-mode", "auto", "fix bug"]),
		);
		check(
			"buildClaudeArgv: resume only",
			JSON.stringify(buildClaudeArgv({ resumeSessionId: "sess-123" })) ===
				JSON.stringify(["--permission-mode", "auto", "--resume", "sess-123"]),
		);
		check(
			"buildClaudeArgv: resume + prompt (resume flag precedes prompt)",
			JSON.stringify(buildClaudeArgv({ prompt: "fix bug", resumeSessionId: "sess-123" })) ===
				JSON.stringify(["--permission-mode", "auto", "--resume", "sess-123", "fix bug"]),
		);

		// ---- buildAgentArgv: gemini/codex flag handling (pure, no spawn) ----

		check(
			"buildAgentArgv(gemini): --approval-mode=yolo, prompt via -i",
			JSON.stringify(buildAgentArgv("gemini", { prompt: "fix bug" })) ===
				JSON.stringify(["--approval-mode=yolo", "-i", "fix bug"]),
		);
		check(
			"buildAgentArgv(gemini): no prompt omits -i",
			JSON.stringify(buildAgentArgv("gemini", {})) === JSON.stringify(["--approval-mode=yolo"]),
		);
		check(
			"buildAgentArgv(codex): bypass flag + prompt positional",
			JSON.stringify(buildAgentArgv("codex", { prompt: "fix bug" })) ===
				JSON.stringify(["--dangerously-bypass-approvals-and-sandbox", "fix bug"]),
		);

		// ---- buildAgentArgv: newer agent presets (see agents.ts's comment on
		// how confident each one's flags are) ----

		check(
			"buildAgentArgv(cursor-agent): auto-approval flags then prompt",
			JSON.stringify(buildAgentArgv("cursor-agent", { prompt: "fix bug" })) ===
				JSON.stringify(["--force", "--trust", "fix bug"]),
		);
		check(
			"buildAgentArgv(cursor-agent): no prompt -> flags only",
			JSON.stringify(buildAgentArgv("cursor-agent", {})) === JSON.stringify(["--force", "--trust"]),
		);
		check(
			"buildAgentArgv(droid): prompt as bare positional",
			JSON.stringify(buildAgentArgv("droid", { prompt: "fix bug" })) ===
				JSON.stringify(["fix bug"]),
		);
		check(
			"buildAgentArgv(opencode): --auto then --prompt flag",
			JSON.stringify(buildAgentArgv("opencode", { prompt: "fix bug" })) ===
				JSON.stringify(["--auto", "--prompt", "fix bug"]),
		);
		check(
			"buildAgentArgv(opencode): no prompt -> --auto only",
			JSON.stringify(buildAgentArgv("opencode", {})) === JSON.stringify(["--auto"]),
		);
		check(
			"buildAgentArgv(copilot): --allow-all, prompt via -i",
			JSON.stringify(buildAgentArgv("copilot", { prompt: "fix bug" })) ===
				JSON.stringify(["--allow-all", "-i", "fix bug"]),
		);
		check(
			"buildAgentArgv(copilot): no prompt omits -i",
			JSON.stringify(buildAgentArgv("copilot", {})) === JSON.stringify(["--allow-all"]),
		);

		// ---- branchName: slug shape, prefix handling, friendly names, dedup ----

		const slug = generateSlug("My New Feature!!");
		check(
			"generateSlug: lowercased, spaces->hyphens, 4-char random suffix",
			/^my-new-feature-[a-z0-9]{4}$/.test(slug),
		);
		check(
			"generateSlug: empty/symbols-only title falls back to 'worktree-<suffix>'",
			/^worktree-[a-z0-9]{4}$/.test(generateSlug("!!!")),
		);

		const branchName = generateBranchName("Fix the login bug", "feat");
		check(
			"generateBranchName: sanitized prefix + slug joined with '/'",
			/^feat\/fix-the-login-bug-[a-z0-9]{4}$/.test(branchName),
		);
		check(
			"generateBranchName: no prefix -> bare slug",
			/^some-title-[a-z0-9]{4}$/.test(generateBranchName("Some title")),
		);

		check(
			"generateFriendlyBranchName: two hyphen-joined words",
			/^[a-z]+-[a-z]+$/.test(generateFriendlyBranchName()),
		);

		check(
			"deduplicateBranchName: returns candidate unchanged when free",
			deduplicateBranchName("feat/foo", ["feat/bar"]) === "feat/foo",
		);
		check(
			"deduplicateBranchName: appends -1 on first collision",
			deduplicateBranchName("feat/foo", ["feat/foo"]) === "feat/foo-1",
		);
		check(
			"deduplicateBranchName: skips past existing numeric suffixes",
			deduplicateBranchName("feat/foo", ["feat/foo", "feat/foo-1", "feat/foo-2"]) === "feat/foo-3",
		);
		check(
			"deduplicateBranchName: collision check is case-insensitive",
			deduplicateBranchName("Feat/Foo", ["feat/foo"]) === "Feat/Foo-1",
		);

		// ---- installClaudeHooks: merges into ~/.claude/settings.json without
		// clobbering a hook the user already configured themselves ----

		const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
		mkdirSync(dirname(claudeSettingsPath), { recursive: true });
		writeFileSync(
			claudeSettingsPath,
			JSON.stringify(
				{
					hooks: {
						Stop: [{ hooks: [{ type: "command", command: "echo user-configured-hook" }] }],
					},
				},
				null,
				2,
			),
		);

		installClaudeHooks();
		const afterInstall = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
		const stopHooksAfterInstall: Array<{ hooks?: Array<{ command: string }> }> =
			afterInstall.hooks.Stop;
		const allStopCommands = stopHooksAfterInstall.flatMap(
			(d) => d.hooks?.map((h) => h.command) ?? [],
		);
		check(
			"installClaudeHooks: preserves the user's own pre-existing hook",
			allStopCommands.includes("echo user-configured-hook"),
		);
		check(
			"installClaudeHooks: adds our own managed hook alongside it",
			allStopCommands.some((c) => c.includes("hooks/notify.sh")),
		);
		check("installClaudeHooks: writes an executable notify.sh", existsSync(NOTIFY_SCRIPT_PATH));

		installClaudeHooks(); // run again — must not duplicate our own entry
		const afterReinstall = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
		const stopCommandsAfterReinstall: string[] = afterReinstall.hooks.Stop.flatMap(
			(d: { hooks?: Array<{ command: string }> }) => d.hooks?.map((h) => h.command) ?? [],
		);
		check(
			"installClaudeHooks: re-running doesn't duplicate our managed hook",
			stopCommandsAfterReinstall.filter((c) => c.includes("hooks/notify.sh")).length === 1,
		);
		check(
			"installClaudeHooks: re-running still preserves the user's hook",
			stopCommandsAfterReinstall.includes("echo user-configured-hook"),
		);

		// ---- uninstallClaudeHooks: removes exactly our own entries, leaves the
		// user's hook and notify.sh's install untouched otherwise ----

		uninstallClaudeHooks();
		const afterUninstall = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
		const stopCommandsAfterUninstall: string[] = (afterUninstall.hooks?.Stop ?? []).flatMap(
			(d: { hooks?: Array<{ command: string }> }) => d.hooks?.map((h) => h.command) ?? [],
		);
		check(
			"uninstallClaudeHooks: removes our managed hook",
			!stopCommandsAfterUninstall.some((c) => c.includes("hooks/notify.sh")),
		);
		check(
			"uninstallClaudeHooks: preserves the user's own hook",
			stopCommandsAfterUninstall.includes("echo user-configured-hook"),
		);
		check(
			"uninstallClaudeHooks: only our other managed events are gone (no empty leftovers)",
			afterUninstall.hooks.SessionStart === undefined &&
				afterUninstall.hooks.PostToolUse === undefined,
		);
		check("uninstallClaudeHooks: deletes notify.sh", !existsSync(NOTIFY_SCRIPT_PATH));

		uninstallClaudeHooks(); // run again on an already-clean state — must not throw
		const afterSecondUninstall = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
		check(
			"uninstallClaudeHooks: idempotent — re-running on a clean settings.json is a no-op",
			JSON.stringify(afterSecondUninstall) === JSON.stringify(afterUninstall),
		);

		installClaudeHooks(); // must reinstall cleanly after an uninstall
		const afterReinstallPostUninstall = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
		const stopCommandsAfterReinstall2: string[] = afterReinstallPostUninstall.hooks.Stop.flatMap(
			(d: { hooks?: Array<{ command: string }> }) => d.hooks?.map((h) => h.command) ?? [],
		);
		check(
			"installClaudeHooks: reinstalls cleanly after an uninstall",
			stopCommandsAfterReinstall2.some((c) => c.includes("hooks/notify.sh")) &&
				stopCommandsAfterReinstall2.includes("echo user-configured-hook") &&
				existsSync(NOTIFY_SCRIPT_PATH),
		);

		// ---- host settings: default agent is captured onto the workspace ----

		const defaultSettings = store.getSettings();
		check(
			"getSettings defaults to claude/vscode",
			defaultSettings.defaultAgent === "claude" && defaultSettings.defaultEditor === "vscode",
		);
		check(
			"getSettings defaults lastOpenedWorkspaceId to null",
			defaultSettings.lastOpenedWorkspaceId === null,
		);
		const updated = store.updateSettings({ defaultAgent: "gemini" });
		check("updateSettings persists defaultAgent", updated.defaultAgent === "gemini");
		check(
			"updateSettings leaves defaultEditor untouched by a partial patch",
			updated.defaultEditor === "vscode",
		);

		// ---- trustWorktree: new worktrees are pre-approved in ~/.claude.json,
		// without clobbering any other project entries already there ----

		const claudeConfigPath = join(homedir(), ".claude.json");
		writeFileSync(
			claudeConfigPath,
			JSON.stringify(
				{ projects: { "/some/other/repo": { hasTrustDialogAccepted: true, foo: "bar" } } },
				null,
				2,
			),
		);

		const geminiWorkspace = await store.createWorkspace({
			projectId: project.id,
			prompt: "smoke test gemini workspace",
		});
		check(
			"createWorkspace captures the current default agent onto the workspace",
			geminiWorkspace.workspace.agentType === "gemini",
		);
		const claudeConfigAfterCreate = JSON.parse(readFileSync(claudeConfigPath, "utf-8"));
		check(
			"trustWorktree: marks the new worktree trusted in ~/.claude.json",
			claudeConfigAfterCreate.projects[geminiWorkspace.workspace.worktreePath]
				?.hasTrustDialogAccepted === true,
		);
		check(
			"trustWorktree: leaves other projects' entries untouched",
			claudeConfigAfterCreate.projects["/some/other/repo"]?.foo === "bar",
		);
		getSession(geminiWorkspace.terminalId)?.kill();
		await store.deleteWorkspace({
			workspaceId: geminiWorkspace.workspace.id,
			deleteBranch: true,
		});
		store.updateSettings({ defaultAgent: "claude" }); // restore for later checks

		// ---- boot-time reconcile: a stale 'active' session from a previous run
		// gets marked 'ended' the moment the app restarts (PTYs never survive a
		// restart, so it's definitionally dead) ----

		const reconcileWsId = "ws-reconcile-smoke";
		const reconcileTerminalId = "term-reconcile-smoke";
		db.insert(workspaces)
			.values({
				id: reconcileWsId,
				projectId: project.id,
				worktreePath: wt.worktreePath,
				branch: "feat/smoke",
				baseBranch: "main",
				name: "reconcile-smoke-workspace",
				type: "worktree",
				createdAt: Date.now(),
			})
			.run();
		db.insert(terminalSessions)
			.values({
				id: reconcileTerminalId,
				workspaceId: reconcileWsId,
				status: "active",
				createdAt: Date.now(),
				endedAt: null,
			})
			.run();
		// Simulate a DAEMON restart (the only process that opts into reconcile
		// now — see db.ts): open a fresh connection to the SAME db file with
		// reconcile:true and confirm the stale row gets fixed.
		const dbAfterRestart = createDb(join(base, "host.db"), { reconcile: true });
		const reconciledRow = dbAfterRestart
			.select()
			.from(terminalSessions)
			.where(eq(terminalSessions.id, reconcileTerminalId))
			.get();
		check(
			"boot reconcile marks a stale 'active' session 'ended' on restart",
			reconciledRow?.status === "ended" && reconciledRow?.endedAt != null,
		);

		// ---- deleteWorkspace refuses on uncommitted changes unless forced ----

		const dirtyWs = await store.createWorkspace({
			projectId: project.id,
			prompt: "smoke test dirty workspace",
		});
		getSession(dirtyWs.terminalId)?.kill();
		writeFileSync(join(dirtyWs.workspace.worktreePath, "uncommitted.txt"), "oops\n");

		let deleteWithoutForceThrew = false;
		try {
			await store.deleteWorkspace({ workspaceId: dirtyWs.workspace.id, deleteBranch: true });
		} catch {
			deleteWithoutForceThrew = true;
		}
		check(
			"deleteWorkspace refuses when the worktree has uncommitted changes",
			deleteWithoutForceThrew && existsSync(dirtyWs.workspace.worktreePath),
		);

		await store.deleteWorkspace({
			workspaceId: dirtyWs.workspace.id,
			deleteBranch: true,
			force: true,
		});
		check(
			"deleteWorkspace with force:true removes it anyway",
			!existsSync(dirtyWs.workspace.worktreePath),
		);

		// ---- lastOpenedWorkspaceId: round-trips, and gets cleared once the
		// workspace it names is deleted (rather than pointing at nothing) ----

		const reopenWs = await store.createWorkspace({
			projectId: project.id,
			prompt: "smoke test reopen workspace",
		});
		getSession(reopenWs.terminalId)?.kill();
		store.updateSettings({ lastOpenedWorkspaceId: reopenWs.workspace.id });
		check(
			"updateSettings persists lastOpenedWorkspaceId",
			store.getSettings().lastOpenedWorkspaceId === reopenWs.workspace.id,
		);
		await store.deleteWorkspace({
			workspaceId: reopenWs.workspace.id,
			deleteBranch: true,
			force: true,
		});
		check(
			"deleteWorkspace clears lastOpenedWorkspaceId when it named the deleted workspace",
			store.getSettings().lastOpenedWorkspaceId === null,
		);

		// ---- per-project setup command: runs standalone alongside the agent
		// launch, non-blocking on failure (see engine/setupCommand.ts) ----

		store.updateProject(project.id, { setupCommand: "touch setup-ran.txt" });
		const setupOkWs = await store.createWorkspace({
			projectId: project.id,
			prompt: "setup command smoke test",
		});
		getSession(setupOkWs.terminalId)?.kill();
		check(
			"setupCommand runs in the new worktree alongside the agent launch",
			existsSync(join(setupOkWs.workspace.worktreePath, "setup-ran.txt")) &&
				setupOkWs.setupWarning === undefined,
		);
		await store.deleteWorkspace({
			workspaceId: setupOkWs.workspace.id,
			deleteBranch: true,
			force: true,
		});

		store.updateProject(project.id, { setupCommand: "exit 1" });
		const setupFailWs = await store.createWorkspace({
			projectId: project.id,
			prompt: "setup command failure smoke test",
		});
		getSession(setupFailWs.terminalId)?.kill();
		check(
			"a failing setupCommand doesn't block workspace creation, just warns",
			existsSync(setupFailWs.workspace.worktreePath) &&
				!!setupFailWs.setupWarning?.includes("Setup command failed"),
		);
		await store.deleteWorkspace({
			workspaceId: setupFailWs.workspace.id,
			deleteBranch: true,
			force: true,
		});
		store.updateProject(project.id, { setupCommand: null });

		// ---- createWorkspaces: batch fan-out of one prompt across N worktrees,
		// with collision-free branches and per-target success/failure reporting ----

		const batch = await store.createWorkspaces({
			projectId: project.id,
			prompt: "batch fan-out smoke test",
			agents: ["claude", "gemini", "claude"],
		});
		check(
			"createWorkspaces creates one workspace per target agent",
			batch.succeeded.length === 3 && batch.failed.length === 0,
		);
		check(
			"createWorkspaces preserves each target's agent preset",
			JSON.stringify(batch.succeeded.map((s) => s.agentType)) ===
				JSON.stringify(["claude", "gemini", "claude"]),
		);
		const batchBranches = batch.succeeded.map((s) => s.workspace.branch);
		check(
			"createWorkspaces assigns collision-free (distinct) branches",
			new Set(batchBranches).size === batchBranches.length,
		);
		check(
			"createWorkspaces actually creates each worktree on disk",
			batch.succeeded.every((s) => existsSync(s.workspace.worktreePath)),
		);
		for (const s of batch.succeeded) {
			getSession(s.terminalId)?.kill();
			await store.deleteWorkspace({
				workspaceId: s.workspace.id,
				deleteBranch: true,
				force: true,
			});
		}

		// ---- orphaned worktrees: detection walks nested branch dirs correctly
		// (a slash in the branch name nests the worktree deeper than a naive
		// fixed-depth scan assumes — this exact repo's own "feat/smoke" branch
		// above is an example) and cleanup removes the leftover empty parent.
		// Uses a distinct top segment ("orphan-parent") so pruning it doesn't
		// interfere with "feat/smoke", which is still alive at this point. ----

		const orphanWt = await addWorktree({
			projectId: project.id,
			repoPath: repo,
			branch: "orphan-parent/orphan-test",
		});
		// No workspace row was ever created for this one — it's orphaned by
		// construction, same as if its row had been wiped after the fact.
		const orphanParentDir = join(WORKTREES_ROOT, project.id, "orphan-parent");
		const orphansFound = store.listOrphanedWorktrees();
		check(
			"listOrphanedWorktrees finds a nested-branch orphan (not the false positive of its parent dir)",
			orphansFound.some((o) => o.path === orphanWt.worktreePath) &&
				!orphansFound.some((o) => o.path === orphanParentDir),
		);

		const cleanupResult = await store.cleanupOrphanedWorktrees();
		check(
			"cleanupOrphanedWorktrees removes it and the now-empty parent dir",
			cleanupResult.removed >= 1 &&
				!existsSync(orphanWt.worktreePath) &&
				!existsSync(orphanParentDir),
		);
		check(
			"listOrphanedWorktrees is empty after cleanup",
			store.listOrphanedWorktrees().length === 0,
		);

		// ---- resumeWorkspace: already-live short-circuit (no real claude spawn) ----

		const resumeWorkspaceId = "ws-resume-smoke-1";
		const resumeTerminalId = "term-resume-smoke-1";
		db.insert(workspaces)
			.values({
				id: resumeWorkspaceId,
				projectId: project.id,
				worktreePath: wt.worktreePath,
				branch: "feat/smoke",
				baseBranch: "main",
				name: "resume-smoke-workspace",
				type: "worktree",
				createdAt: Date.now(),
			})
			.run();
		db.insert(terminalSessions)
			.values({
				id: resumeTerminalId,
				workspaceId: resumeWorkspaceId,
				status: "active",
				createdAt: Date.now(),
				endedAt: null,
			})
			.run();
		spawnSession({
			id: resumeTerminalId,
			workspaceId: resumeWorkspaceId,
			file: "bash",
			args: ["-c", "sleep 3"],
			cwd: wt.worktreePath,
		});
		const resumeResult = await store.resumeWorkspace({
			workspaceId: resumeWorkspaceId,
		});
		check(
			"resumeWorkspace returns the EXISTING live terminal (no real claude spawned)",
			resumeResult.terminalId === resumeTerminalId,
		);
	} finally {
		killAll();
		server.close();
		// Belt-and-suspenders cleanup even though run-isolated.ts (which this
		// script must be run through — see package.json) tears down the whole
		// isolated $HOME afterward regardless.
		if (wt) {
			await removeWorktree({
				repoPath: repo,
				worktreePath: wt.worktreePath,
				deleteBranch: "feat/smoke",
			}).catch(() => {});
		}
		execFileSync("rm", ["-rf", base]);
	}

	console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
