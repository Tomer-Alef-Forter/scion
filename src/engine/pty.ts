// In-process PTY layer — wraps node-pty and exposes the env keys the
// installed Claude hooks (see setup/notify.sh) read to report back here.
// This module runs inside the daemon (src/daemon/*); front-ends talk to it
// only through engine/ptyBackend.ts.
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as nodePty from "node-pty";
import { DATA_DIR } from "../config.ts";
import { getHookUrl } from "../hookAddr.ts";

const OUTPUT_CAP = 256 * 1024; // bytes of scrollback retained for attach replay

// node-pty ships a prebuilt `spawn-helper` binary that must be executable for
// posix_spawnp to run it. Package managers (notably Bun's extractor) sometimes
// drop the exec bit on extraction, which makes spawn fail with
// "posix_spawnp failed". Restore it once at startup — self-healing across
// fresh installs, no postinstall/trust step required.
function ensureSpawnHelperExecutable(): void {
	try {
		const require = createRequire(import.meta.url);
		const pkg = require.resolve("node-pty/package.json");
		const prebuilds = join(dirname(pkg), "prebuilds");
		const platformDir = `${process.platform}-${process.arch}`;
		const helper = join(prebuilds, platformDir, "spawn-helper");
		if (existsSync(helper)) {
			const mode = statSync(helper).mode;
			if (!(mode & 0o111)) chmodSync(helper, 0o755);
		}
	} catch {
		// Best-effort: on platforms without a spawn-helper (Windows) or odd
		// layouts this is a no-op; a real failure surfaces at spawn time.
	}
}

ensureSpawnHelperExecutable();

type DataListener = (chunk: string) => void;
type ExitListener = (code: number) => void;

export interface PtySession {
	id: string;
	workspaceId: string;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	onData(fn: DataListener): () => void;
	onExit(fn: ExitListener): () => void;
	getBuffer(): string;
	kill(): void;
	exited: boolean;
	exitCode: number | null;
	cols: number;
	rows: number;
}

const sessions = new Map<string, PtySession>();

export function getSession(id: string): PtySession | undefined {
	return sessions.get(id);
}

export function listSessions(workspaceId?: string): PtySession[] {
	const all = [...sessions.values()];
	return workspaceId ? all.filter((s) => s.workspaceId === workspaceId) : all;
}

/** Env injected into every launched PTY so Claude's hooks report back to us. */
function buildTerminalEnv(terminalId: string, workspaceId: string): Record<string, string> {
	const base: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string") base[k] = v;
	}
	base.TERM = "xterm-256color";
	base.COLORTERM = "truecolor";
	// claude-code parses kitty CSI-u only for certain TERM_PROGRAMs.
	base.TERM_PROGRAM = "kitty";
	base.SCION_TERMINAL_ID = terminalId;
	base.SCION_WORKSPACE_ID = workspaceId;
	base.SCION_HOME_DIR = DATA_DIR;
	base.SCION_HOST_AGENT_HOOK_URL = getHookUrl();
	// Run Claude Code in its classic (main-screen) renderer instead of the
	// default fullscreen TUI, which uses the alternate screen + mouse capture
	// and turns the wheel into arrow keys. Classic mode streams the transcript
	// into the terminal's normal buffer, so xterm's native scrollback drives
	// the mouse wheel — smooth scrolling like a plain shell — and it's lighter
	// to render in the browser terminal. Only Claude reads this var; other
	// agents ignore it.
	base.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
	return base;
}

export function spawnSession(args: {
	id: string;
	workspaceId: string;
	file: string;
	args: string[];
	cwd: string;
	cols?: number;
	rows?: number;
}): PtySession {
	const cols = args.cols ?? 120;
	const rows = args.rows ?? 32;

	const term = nodePty.spawn(args.file, args.args, {
		name: "xterm-256color",
		cols,
		rows,
		cwd: args.cwd,
		env: buildTerminalEnv(args.id, args.workspaceId),
	});

	let buffer = "";
	const dataListeners = new Set<DataListener>();
	const exitListeners = new Set<ExitListener>();

	const session: PtySession = {
		id: args.id,
		workspaceId: args.workspaceId,
		exited: false,
		exitCode: null,
		cols,
		rows,
		write: (data) => {
			if (!session.exited) term.write(data);
		},
		resize: (c, r) => {
			session.cols = c;
			session.rows = r;
			if (!session.exited) {
				try {
					term.resize(c, r);
				} catch {
					// ignore resize on a dying pty
				}
			}
		},
		onData: (fn) => {
			dataListeners.add(fn);
			return () => dataListeners.delete(fn);
		},
		onExit: (fn) => {
			exitListeners.add(fn);
			return () => exitListeners.delete(fn);
		},
		getBuffer: () => buffer,
		kill: () => {
			if (!session.exited) {
				try {
					term.kill();
				} catch {
					// already dead
				}
			}
		},
	};

	term.onData((chunk: string) => {
		buffer += chunk;
		if (buffer.length > OUTPUT_CAP) buffer = buffer.slice(-OUTPUT_CAP);
		for (const fn of dataListeners) fn(chunk);
	});

	term.onExit(({ exitCode }: { exitCode: number }) => {
		session.exited = true;
		session.exitCode = exitCode;
		for (const fn of exitListeners) fn(exitCode);
	});

	sessions.set(args.id, session);
	return session;
}

/** Kill every live PTY (used on app shutdown). */
export function killAll(): void {
	for (const s of sessions.values()) s.kill();
}
