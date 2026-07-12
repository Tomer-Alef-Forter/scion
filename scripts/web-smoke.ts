// Headless end-to-end smoke test for the web backend (src/server/*).
// Exercises: REST CRUD over the Hono app (in-process, no port needed) and the
// PTY<->WebSocket terminal bridge over a REAL socket (buffer replay, input,
// resize, multi-client fan-out) — using node's built-in WebSocket client.
// Run: `bun run web:smoke`.
import { serve } from "@hono/node-server";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/db.ts";
import { createStatusStore } from "../src/engine/status.ts";
import { getSession, killAll, spawnSession } from "../src/engine/pty.ts";
import { inProcessPtyBackend } from "../src/engine/ptyBackend.ts";
import { addWorktree } from "../src/engine/worktrees.ts";
import { createStore } from "../src/store/projects.ts";
import { createServerApp } from "../src/server/app.ts";
import { terminalSessions, workspaces } from "../src/db/schema.ts";

// This script does real filesystem writes/deletes under config.ts's
// DATA_DIR/WORKTREES_ROOT, which resolve from $HOME — refuse to run unless
// scripts/run-isolated.ts (see package.json's "web:smoke" script) has
// already pointed $HOME at a throwaway directory. Without this, an isolated
// test database checked against the real, shared WORKTREES_ROOT once caused
// a test to delete real, in-use workspace directories.
if (!process.env.SL_ISOLATED_HOME) {
	console.error(
		"refusing to run: this script must be invoked via `bun run web:smoke` " +
			"(scripts/run-isolated.ts), not `tsx scripts/web-smoke.ts` directly " +
			"— it does real filesystem writes/deletes under $HOME/.scion.",
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
	const base = mkdtempSync(join(tmpdir(), "sl-web-smoke-"));
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
	const { app, injectWebSocket } = createServerApp({ store, status, backend: inProcessPtyBackend });

	// ---- REST, in-process (no port needed — app.request() drives fetch directly) ----

	const health = await app.request("/api/health");
	check("GET /api/health -> 200", health.status === 200);

	// ---- settings ----

	const getSettingsRes = await app.request("/api/settings");
	const initialSettings = await getSettingsRes.json();
	check(
		"GET /api/settings defaults to claude/vscode",
		getSettingsRes.status === 200 &&
			initialSettings.defaultAgent === "claude" &&
			initialSettings.defaultEditor === "vscode",
	);

	const putSettingsRes = await app.request("/api/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ defaultAgent: "gemini", defaultEditor: "cursor" }),
	});
	const putSettings = await putSettingsRes.json();
	check(
		"PUT /api/settings persists valid values",
		putSettings.defaultAgent === "gemini" && putSettings.defaultEditor === "cursor",
	);

	const invalidSettingsRes = await app.request("/api/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ defaultAgent: "not-a-real-agent" }),
	});
	const invalidSettings = await invalidSettingsRes.json();
	check(
		"PUT /api/settings ignores an invalid agent value",
		invalidSettings.defaultAgent === "gemini",
	);

	// Restore claude before the rest of the suite (which assumes claude-based
	// status derivation, e.g. the stale-binding regression check below).
	await app.request("/api/settings", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ defaultAgent: "claude", defaultEditor: "vscode" }),
	});

	// Production (`bun run web`) serves the built frontend from this same
	// server — requires `web/dist` to exist (run `bun run --cwd web build`
	// first). serveStatic's `root` is relative to process.cwd(), which must be
	// the repo root (matches how `tsx src/server/index.ts` is always run).
	const indexRes = await app.request("/");
	const indexHtml = await indexRes.text();
	check(
		"GET / serves the built frontend (web/dist/index.html)",
		indexRes.status === 200 && indexHtml.includes('<div id="root">'),
	);

	const createProjectRes = await app.request("/api/projects", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ repoPath: repo }),
	});
	check("POST /api/projects -> 201", createProjectRes.status === 201);
	const project = await createProjectRes.json();
	// addProject canonicalizes via `git rev-parse --show-toplevel`, which
	// resolves symlinks (e.g. macOS /var -> /private/var) — compare realpaths.
	check(
		"created project has id + repoPath",
		!!project.id && project.repoPath === realpathSync(repo),
	);

	const listProjectsRes = await app.request("/api/projects");
	const projectList = await listProjectsRes.json();
	check(
		"GET /api/projects includes created project",
		Array.isArray(projectList) && projectList.some((p: { id: string }) => p.id === project.id),
	);

	const createWsRes = await app.request(`/api/projects/${project.id}/workspaces`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt: "smoke test task" }),
	});
	check("POST /api/projects/:id/workspaces -> 201", createWsRes.status === 201);
	const created = await createWsRes.json();
	check("created workspace + terminalId", !!created.workspace?.id && !!created.terminalId);
	check(
		"workspace name defaults from the prompt when name is omitted",
		created.workspace.name === "smoke test task",
	);

	const namedWsRes = await app.request(`/api/projects/${project.id}/workspaces`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt: "smoke test task", name: "my custom name" }),
	});
	const namedCreated = await namedWsRes.json();
	check(
		"POST /api/projects/:id/workspaces honors an explicit name",
		namedCreated.workspace?.name === "my custom name",
	);
	getSession(namedCreated.terminalId)?.kill();
	// Downstream checks assume a single workspace under this project.
	await store.deleteWorkspace({ workspaceId: namedCreated.workspace.id, deleteBranch: true });

	const emptyWsRes = await app.request(`/api/projects/${project.id}/workspaces`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	const emptyCreated = await emptyWsRes.json();
	check(
		"POST /api/projects/:id/workspaces works with no prompt or name",
		emptyWsRes.status === 201 && !!emptyCreated.workspace?.name && !!emptyCreated.workspace?.branch,
	);
	getSession(emptyCreated.terminalId)?.kill();
	await store.deleteWorkspace({ workspaceId: emptyCreated.workspace.id, deleteBranch: true });

	// ---- non-Claude agents: no hook events ever arrive, so status derivation
	// falls back to a generic "working" instead of getting stuck on "starting" ----
	await store.updateSettings({ defaultAgent: "gemini" });
	const geminiWsRes = await app.request(`/api/projects/${project.id}/workspaces`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt: "smoke test gemini workspace" }),
	});
	const geminiCreated = await geminiWsRes.json();
	const listWithGeminiRes = await app.request(`/api/projects/${project.id}/workspaces`);
	const listWithGemini = await listWithGeminiRes.json();
	const geminiRow = listWithGemini.find(
		(w: { id: string }) => w.id === geminiCreated.workspace.id,
	);
	check(
		"non-Claude agent with a live session reports 'working', not 'starting'",
		geminiRow?.status === "working",
	);
	getSession(geminiCreated.terminalId)?.kill();
	await store.deleteWorkspace({ workspaceId: geminiCreated.workspace.id, deleteBranch: true });
	await store.updateSettings({ defaultAgent: "claude" });

	// Real claude was launched by createWorkspace; kill it immediately — this
	// test only needs the workspace row, not a live claude process.
	killAll();

	const listWsRes = await app.request(`/api/projects/${project.id}/workspaces`);
	const wsList = await listWsRes.json();
	check(
		"GET /api/projects/:id/workspaces includes diff summary",
		Array.isArray(wsList) && wsList.length === 1 && wsList[0].diff !== undefined,
	);

	const diffRes = await app.request(`/api/workspaces/${created.workspace.id}/diff`);
	check("GET /api/workspaces/:id/diff -> 200", diffRes.status === 200);

	const singleWsRes = await app.request(`/api/workspaces/${created.workspace.id}`);
	const singleWs = await singleWsRes.json();
	check(
		"GET /api/workspaces/:id returns the same enriched shape as the list route",
		singleWsRes.status === 200 &&
			singleWs.id === created.workspace.id &&
			singleWs.diff !== undefined &&
			typeof singleWs.status === "string",
	);

	const missingWsRes = await app.request(`/api/workspaces/does-not-exist`);
	check("GET /api/workspaces/:id -> 404 for an unknown id", missingWsRes.status === 404);

	const treeRes = await app.request(`/api/workspaces/${created.workspace.id}/tree`);
	const tree = await treeRes.json();
	check(
		"GET /api/workspaces/:id/tree includes README.md",
		treeRes.status === 200 &&
			Array.isArray(tree) &&
			tree.some((f: { path: string }) => f.path === "README.md"),
	);

	const fileRes = await app.request(
		`/api/workspaces/${created.workspace.id}/file?path=README.md`,
	);
	const fileContents = await fileRes.text();
	check(
		"GET /api/workspaces/:id/file returns README.md contents",
		fileRes.status === 200 && fileContents === "# repo\n",
	);

	const traversalRes = await app.request(
		`/api/workspaces/${created.workspace.id}/file?path=${encodeURIComponent("../../../etc/passwd")}`,
	);
	check("GET /api/workspaces/:id/file rejects path traversal", traversalRes.status === 400);

	const mergeRes = await app.request(`/api/workspaces/${created.workspace.id}/merge`, {
		method: "POST",
	});
	const mergeResult = await mergeRes.json();
	check("POST /api/workspaces/:id/merge succeeds", mergeResult.ok === true);

	const renameRes = await app.request(`/api/workspaces/${created.workspace.id}/rename`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "renamed-workspace" }),
	});
	const workspacesAfterRename = await (
		await app.request(`/api/projects/${project.id}/workspaces`)
	).json();
	check(
		"POST /api/workspaces/:id/rename updates the name",
		renameRes.status === 200 &&
			workspacesAfterRename.find((w: { id: string }) => w.id === created.workspace.id)
				?.name === "renamed-workspace",
	);

	const renameEmptyRes = await app.request(`/api/workspaces/${created.workspace.id}/rename`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "   " }),
	});
	check("POST /api/workspaces/:id/rename rejects an empty name", renameEmptyRes.status === 400);

	// ---- status-gating regression: a stale binding must not outlive its PTY ----
	// killAll() (used above) kills a PTY without waiting for node-pty's async
	// onExit — which is what calls status.markExited — to fire, so a binding
	// row can be left behind pointing at a session that no longer exists.
	// The workspaces list must report "done" for that workspace regardless,
	// never the stale binding's last-known status.
	{
		const staleWorkspaceId = "ws-stale-binding-smoke";
		const staleTerminalId = "term-stale-binding-smoke";
		db.insert(workspaces)
			.values({
				id: staleWorkspaceId,
				projectId: project.id,
				worktreePath: repo,
				branch: "main",
				baseBranch: "main",
				name: "stale-binding-workspace",
				type: "worktree",
				createdAt: Date.now(),
			})
			.run();
		db.insert(terminalSessions)
			.values({
				id: staleTerminalId,
				workspaceId: staleWorkspaceId,
				status: "active",
				createdAt: Date.now(),
				endedAt: null,
			})
			.run();
		spawnSession({
			id: staleTerminalId,
			workspaceId: staleWorkspaceId,
			file: "bash",
			args: ["-c", "sleep 5"],
			cwd: repo,
		});
		// Record a real "working" event — no onExit->markExited wiring is
		// attached (this session wasn't created via store.createWorkspace),
		// so killing it below leaves the binding row stale on purpose.
		status.recordEvent({
			terminalId: staleTerminalId,
			workspaceId: staleWorkspaceId,
			agentId: "claude",
			eventType: "UserPromptSubmit",
		});
		check(
			"stale-binding setup: status is 'working' before kill",
			status.listByWorkspace(staleWorkspaceId)[0]?.status === "working",
		);
		getSession(staleTerminalId)?.kill();
		// node-pty's onExit (which flips `.exited`) fires asynchronously —
		// poll rather than trust a fixed delay.
		for (let i = 0; i < 20 && !getSession(staleTerminalId)?.exited; i++) {
			await sleep(100);
		}
		check(
			"pty actually exited after kill (test precondition)",
			getSession(staleTerminalId)?.exited === true,
		);
		check(
			"stale-binding setup: binding row itself is still 'working' (proves it's stale, not cleaned up)",
			status.listByWorkspace(staleWorkspaceId)[0]?.status === "working",
		);

		const staleListRes = await app.request(`/api/projects/${project.id}/workspaces`);
		const staleList = await staleListRes.json();
		const staleEntry = staleList.find((w: { id: string }) => w.id === staleWorkspaceId);
		check(
			"REST API reports 'done' for a dead session despite the stale binding",
			staleEntry?.status === "done",
		);
	}

	const deleteRes = await app.request(
		`/api/workspaces/${created.workspace.id}?deleteBranch=true`,
		{ method: "DELETE" },
	);
	check("DELETE /api/workspaces/:id -> ok", deleteRes.status === 200);

	// ---- orphaned worktrees (run-isolated.ts gives this process its own
	// $HOME, so WORKTREES_ROOT here is a throwaway dir, never the real one) ----

	const orphanWt = await addWorktree({
		projectId: project.id,
		repoPath: repo,
		branch: "orphan-parent/orphan-test",
	});
	const listOrphansRes = await app.request("/api/orphaned-worktrees");
	const orphansListed = await listOrphansRes.json();
	check(
		"GET /api/orphaned-worktrees finds the untracked worktree",
		listOrphansRes.status === 200 &&
			orphansListed.some((o: { path: string }) => o.path === orphanWt.worktreePath),
	);

	const cleanupOrphansRes = await app.request("/api/orphaned-worktrees/cleanup", {
		method: "POST",
	});
	const cleanupOrphansResult = await cleanupOrphansRes.json();
	check(
		"POST /api/orphaned-worktrees/cleanup removes it",
		cleanupOrphansRes.status === 200 &&
			cleanupOrphansResult.removed >= 1 &&
			!existsSync(orphanWt.worktreePath),
	);

	// ---- daemon status/shutdown (this process uses inProcessPtyBackend, so
	// shutdown is a safe no-op here — the real daemon process is exercised by
	// scripts/daemon-smoke.ts) ----

	const daemonStatusRes = await app.request("/api/daemon/status");
	const daemonStatus = await daemonStatusRes.json();
	check(
		"GET /api/daemon/status reports a live session count",
		daemonStatusRes.status === 200 && typeof daemonStatus.liveSessionCount === "number",
	);

	const daemonShutdownRes = await app.request("/api/daemon/shutdown", { method: "POST" });
	check("POST /api/daemon/shutdown -> ok", daemonShutdownRes.status === 200);

	// ---- WS terminal bridge, over a REAL socket ----

	let httpServer!: ReturnType<typeof serve>;
	const port = await new Promise<number>((resolve) => {
		httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
	});
	injectWebSocket(httpServer);

	const terminalId = "term-web-smoke-1";
	// Deterministic echo command — avoids relying on PTY local-echo semantics.
	// (The WS bridge only reads pty.ts's in-memory session map, no DB row needed.)
	spawnSession({
		id: terminalId,
		workspaceId: "ws-web-smoke-1",
		file: "bash",
		args: ["-c", 'while read line; do echo "GOT:$line"; done'],
		cwd: repo,
	});

	function collectBinaryText(ws: WebSocket, ms: number): Promise<string> {
		let text = "";
		return new Promise((resolve) => {
			ws.addEventListener("message", (evt: MessageEvent) => {
				if (typeof evt.data === "string") return; // control frame, ignore for this collector
				const buf = evt.data instanceof ArrayBuffer ? evt.data : null;
				if (buf) text += Buffer.from(buf).toString("utf8");
			});
			setTimeout(() => resolve(text), ms);
		});
	}

	const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${terminalId}`);
	// Default binaryType is "blob" per spec — Superset's real TerminalConnection
	// sets "arraybuffer" explicitly; mirror that here so binary frames arrive
	// as ArrayBuffer instead of Blob.
	ws1.binaryType = "arraybuffer";
	const attachedPromise = new Promise<Record<string, unknown> | null>((resolve) => {
		ws1.addEventListener("message", function onFirst(evt: MessageEvent) {
			if (typeof evt.data === "string") {
				ws1.removeEventListener("message", onFirst);
				resolve(JSON.parse(evt.data));
			}
		});
		setTimeout(() => resolve(null), 1000);
	});
	await new Promise<void>((resolve, reject) => {
		ws1.addEventListener("open", () => resolve());
		ws1.addEventListener("error", () => reject(new Error("ws1 failed to open")));
	});
	const attachedMsg = await attachedPromise;
	check(
		"connect sends {type:'attached',terminalId} (real client requires this to flip to 'open')",
		attachedMsg?.type === "attached" && attachedMsg.terminalId === terminalId,
	);

	const collector1 = collectBinaryText(ws1, 1200);
	ws1.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
	await sleep(100);
	ws1.send(JSON.stringify({ type: "input", data: "hello\n" }));
	const output1 = await collector1;
	check("input round-trips through the PTY (GOT:hello)", output1.includes("GOT:hello"));

	// Second client on the SAME terminal should immediately get scrollback
	// replay (buffer includes everything sent so far, incl. "GOT:hello").
	const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${terminalId}`);
	ws2.binaryType = "arraybuffer";
	const collector2 = collectBinaryText(ws2, 800);
	await new Promise<void>((resolve, reject) => {
		ws2.addEventListener("open", () => resolve());
		ws2.addEventListener("error", () => reject(new Error("ws2 failed to open")));
	});
	const replay = await collector2;
	check("second client gets buffer replay on connect", replay.includes("GOT:hello"));

	// A fresh input from client 2 should be visible to BOTH clients (fan-out).
	const collectorBoth1 = collectBinaryText(ws1, 800);
	const collectorBoth2 = collectBinaryText(ws2, 800);
	ws2.send(JSON.stringify({ type: "input", data: "again\n" }));
	const [fanout1, fanout2] = await Promise.all([collectorBoth1, collectorBoth2]);
	check("multi-client fan-out: client1 sees client2's input result", fanout1.includes("GOT:again"));
	check("multi-client fan-out: client2 sees its own input result", fanout2.includes("GOT:again"));

	// Closing a socket must NOT kill the session (mirrors attach.ts detach).
	ws1.close();
	await sleep(200);
	const sessionStillAlive = getSession(terminalId);
	check("closing a WS does not kill the PTY session", !!sessionStillAlive && !sessionStillAlive.exited);
	ws2.close();

	// ---- exit message shape: real client reads `exitCode`, not `code` ----

	const exitTerminalId = "term-web-smoke-exit";
	spawnSession({
		id: exitTerminalId,
		workspaceId: "ws-web-smoke-1",
		file: "bash",
		args: ["-c", "exit 3"],
		cwd: repo,
	});
	const wsExit = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${exitTerminalId}`);
	const exitMsgPromise = new Promise<Record<string, unknown> | null>((resolve) => {
		wsExit.addEventListener("message", (evt: MessageEvent) => {
			if (typeof evt.data !== "string") return;
			const parsed = JSON.parse(evt.data);
			if (parsed.type === "exit") resolve(parsed);
		});
		setTimeout(() => resolve(null), 1500);
	});
	const exitMsg = await exitMsgPromise;
	check(
		"exit message uses `exitCode` field (matches real client's type)",
		exitMsg?.type === "exit" && exitMsg.exitCode === 3,
	);
	wsExit.close();

	// ---- /ws/terminal/:id error path: unknown terminal ----

	const wsBad = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/does-not-exist`);
	const badMessage = await new Promise<string | null>((resolve) => {
		wsBad.addEventListener("message", (evt: MessageEvent) => {
			if (typeof evt.data === "string") resolve(evt.data);
		});
		wsBad.addEventListener("close", () => resolve(null));
		setTimeout(() => resolve(null), 1000);
	});
	check(
		"unknown terminal id -> error message + close",
		!!badMessage && JSON.parse(badMessage).type === "error",
	);

	// ---- /ws/events: status changes are pushed to subscribers ----

	const wsEvents = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
	await new Promise<void>((resolve, reject) => {
		wsEvents.addEventListener("open", () => resolve());
		wsEvents.addEventListener("error", () => reject(new Error("wsEvents failed to open")));
	});
	const eventPromise = new Promise<{ type: string; workspaceId: string } | null>(
		(resolve) => {
			wsEvents.addEventListener("message", (evt: MessageEvent) => {
				if (typeof evt.data === "string") resolve(JSON.parse(evt.data));
			});
			setTimeout(() => resolve(null), 1000);
		},
	);
	// recordEvent's binding insert has a FK on terminalSessions.id — seed one,
	// matching how store.createWorkspace does it for real terminals.
	db.insert(terminalSessions)
		.values({
			id: "term-events-smoke",
			workspaceId: null,
			status: "active",
			createdAt: Date.now(),
			endedAt: null,
		})
		.run();
	// Trigger a real status change the same way the Claude hook does.
	status.recordEvent({
		terminalId: "term-events-smoke",
		workspaceId: "ws-events-smoke",
		agentId: "claude",
		eventType: "UserPromptSubmit",
	});
	const eventMsg = await eventPromise;
	check(
		"/ws/events pushes status change to subscribers",
		eventMsg?.type === "status" && eventMsg.workspaceId === "ws-events-smoke",
	);
	wsEvents.close();
	wsBad.close();

	killAll();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	execFileSync("rm", ["-rf", base]);

	console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
