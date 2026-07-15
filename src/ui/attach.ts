// Raw PTY passthrough (tmux-style attach). Runs OUTSIDE Ink: Ink is unmounted
// before this is called and re-rendered after it resolves. Detach with Ctrl-b d.
import type { PtyBackend } from "../engine/ptyBackend.ts";

const DETACH_HINT = "\r\n\x1b[2m[scion] attached — press Ctrl-b then d to detach]\x1b[0m\r\n";

export async function runAttach(terminalId: string, backend: PtyBackend): Promise<void> {
	const { stdin, stdout } = process;
	const handle = await backend.attach(terminalId);

	if (!handle) {
		stdout.write("\r\n[agent session is not running]\r\n");
		return new Promise((resolve) => setTimeout(resolve, 800));
	}

	// Clear screen, size the PTY to the current terminal. Scrollback replay
	// arrives as the handle's first onData emission — registering it before
	// the hint keeps the on-screen order (replay, then hint) exactly as
	// before for the in-process backend (a synchronous emission); over the
	// daemon it's a real round trip, so the hint could in principle land a
	// beat before the replay finishes streaming in — a harmless, imperceptible
	// cosmetic quirk, not a correctness issue.
	stdout.write("\x1b[2J\x1b[3J\x1b[H");

	return new Promise<void>((resolve) => {
		let cleanedUp = false;
		let detachArmed = false; // set after Ctrl-b, awaiting 'd'

		handle.onData((chunk) => stdout.write(chunk));
		stdout.write(DETACH_HINT);
		handle.resize(stdout.columns ?? 120, stdout.rows ?? 32);
		handle.onExit(() => finish());
		const onResize = () => handle.resize(stdout.columns ?? 120, stdout.rows ?? 32);
		stdout.on("resize", onResize);

		const onInput = (data: Buffer) => {
			const s = data.toString("utf8");
			if (!detachArmed && s === "\x02") {
				detachArmed = true;
				return;
			}
			if (detachArmed) {
				detachArmed = false;
				if (s === "d" || s === "D") {
					finish();
					return;
				}
				// Not the detach key — forward the swallowed Ctrl-b plus this key.
				handle.write("\x02");
				handle.write(s);
				return;
			}
			handle.write(s);
		};

		// An arrow function expression (not a hoisted `function` declaration) —
		// TS only preserves the `handle` non-null narrowing from above into
		// closures of the former kind.
		const finish = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			handle.close();
			stdout.off("resize", onResize);
			stdin.off("data", onInput);
			if (stdin.isTTY) stdin.setRawMode(false);
			stdin.pause();
			stdout.write("\x1b[2J\x1b[3J\x1b[H");
			resolve();
		};

		if (stdin.isTTY) stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onInput);
	});
}
