// Raw PTY passthrough (tmux-style attach). Runs OUTSIDE Ink: Ink is unmounted
// before this is called and re-rendered after it resolves. Detach with Ctrl-b d.
import { getSession } from "../engine/pty.ts";

const DETACH_HINT =
	"\r\n\x1b[2m[scion] attached — press Ctrl-b then d to detach]\x1b[0m\r\n";

export function runAttach(terminalId: string): Promise<void> {
	const session = getSession(terminalId);
	const { stdin, stdout } = process;

	if (!session || session.exited) {
		stdout.write("\r\n[agent session is not running]\r\n");
		return new Promise((resolve) => setTimeout(resolve, 800));
	}

	// Clear screen, replay scrollback, size the PTY to the current terminal.
	stdout.write("\x1b[2J\x1b[3J\x1b[H");
	stdout.write(session.getBuffer());
	stdout.write(DETACH_HINT);
	session.resize(stdout.columns ?? 120, stdout.rows ?? 32);

	return new Promise<void>((resolve) => {
		let cleanedUp = false;
		let detachArmed = false; // set after Ctrl-b, awaiting 'd'

		const offData = session.onData((chunk) => stdout.write(chunk));
		const offExit = session.onExit(() => finish());
		const onResize = () =>
			session.resize(stdout.columns ?? 120, stdout.rows ?? 32);
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
				session.write("\x02");
				session.write(s);
				return;
			}
			session.write(s);
		};

		function finish() {
			if (cleanedUp) return;
			cleanedUp = true;
			offData();
			offExit();
			stdout.off("resize", onResize);
			stdin.off("data", onInput);
			if (stdin.isTTY) stdin.setRawMode(false);
			stdin.pause();
			stdout.write("\x1b[2J\x1b[3J\x1b[H");
			resolve();
		}

		if (stdin.isTTY) stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onInput);
	});
}
