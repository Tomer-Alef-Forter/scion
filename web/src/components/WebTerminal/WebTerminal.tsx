// Renders a workspace's PTY as a real terminal in the browser via xterm.js,
// wired up to the WebSocket bridge in lib/TerminalConnection.ts. No mobile
// input handling here — this is a local desktop tool, not a responsive app.
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createTerminalConnection, type TerminalConnection } from "../../lib/TerminalConnection";

const TERMINAL_THEME: ITheme = {
	background: "#12161c",
	foreground: "#dfe6ee",
	cursor: "#5fb0e0",
	cursorAccent: "#12161c",
	selectionBackground: "rgba(95, 176, 224, 0.28)",
	black: "#12161c",
	red: "#e0666f",
	green: "#8fbf7f",
	yellow: "#e0b95f",
	blue: "#5fa8e0",
	magenta: "#b485d6",
	cyan: "#5fc2c9",
	white: "#dfe6ee",
	brightBlack: "#5a6472",
	brightRed: "#ed8891",
	brightGreen: "#aad89e",
	brightYellow: "#edd188",
	brightBlue: "#8ac3ed",
	brightMagenta: "#cba6e6",
	brightCyan: "#8adbe0",
	brightWhite: "#ffffff",
};

const TERMINAL_FONT_FAMILY =
	'"JetBrains Mono", "MesloLGS NF", "Menlo", "Monaco", "Courier New", monospace';

export interface WebTerminalHandle {
	focus(): void;
}

interface WebTerminalProps {
	workspaceId: string;
	terminalId: string;
	/** Fires when Ctrl-B d is pressed inside the terminal (see the custom key
	 * handler below) — purely informational, since blurring the terminal
	 * already moves `document.activeElement` off it, which is all the app's
	 * shortcut guard (`isTypingTarget`) needs to resume handling keys. */
	onDetach?: () => void;
	/** Focus the terminal right after it mounts — only when this mount was
	 * triggered by an explicit "enter this workspace" action (Enter key /
	 * click), never by keyboard preview-navigation between workspaces
	 * (which must never steal focus mid-browse). */
	autoFocus?: boolean;
}

type ConnectionState = "connecting" | "open" | "reconnecting" | "error" | "exited";

export const WebTerminal = forwardRef<WebTerminalHandle, WebTerminalProps>(function WebTerminal(
	{ workspaceId, terminalId, onDetach, autoFocus },
	ref,
) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const connectionRef = useRef<TerminalConnection | null>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const onDetachRef = useRef(onDetach);
	onDetachRef.current = onDetach;
	const [state, setState] = useState<ConnectionState>("connecting");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	useImperativeHandle(
		ref,
		() => ({
			focus: () => terminalRef.current?.focus(),
		}),
		[],
	);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let resizeTimer: ReturnType<typeof setTimeout> | null = null;
		const visualViewport = window.visualViewport;

		const terminal = new Terminal({
			cursorBlink: true,
			cursorStyle: "block",
			fontFamily: TERMINAL_FONT_FAMILY,
			fontSize: 14,
			scrollback: 5000,
			// Scroll tuning, aimed at a natural, native-terminal feel rather than
			// raw speed. scrollSensitivity is a multiplier on scroll delta;
			// trackpad gestures bypass the wheel animation, so this is what makes
			// a gesture track 1:1 with your fingers instead of leaping — kept at
			// the default 1 (a high value here is exactly what makes scrolling
			// feel jumpy/twitchy). fastScrollSensitivity is the alt-key boost.
			// smoothScrollDuration animates physical mouse-wheel ticks; 0 = the
			// most responsive (no per-tick animation lag). Note: xterm scrolls in
			// whole rows and has no sub-pixel/momentum rendering, so it can get
			// close to native but not identical.
			smoothScrollDuration: 0,
			scrollSensitivity: 1,
			fastScrollSensitivity: 5,
			theme: TERMINAL_THEME,
			allowProposedApi: true,
			// Hide xterm's built-in scrollbar. The fit addon permanently reserves
			// scrollbar width out of the usable columns, so hiding it lets content
			// use the full pane width (matches Superset's terminal config).
			scrollbar: {
				showScrollbar: false,
			},
		});
		terminalRef.current = terminal;
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(container);
		if (autoFocus) terminal.focus();

		// Ctrl-B then a key is the escape hatch out of the terminal back to
		// keyboard list-navigation (mirrors ui/attach.ts's Ink TUI detach
		// convention, and tmux/screen's prefix-key pattern generally) — chosen
		// specifically because it's a two-key sequence essentially no terminal
		// program binds, unlike plain Escape (used constantly by vim, prompts,
		// etc). `d` detaches; anything else forwards the swallowed Ctrl-B byte
		// then lets xterm process the second key normally.
		let detachArmed = false;
		terminal.attachCustomKeyEventHandler((e) => {
			if (e.type !== "keydown") return true;
			const noOtherModifiers = !e.shiftKey && !e.altKey && !e.metaKey;
			if (!detachArmed && e.ctrlKey && noOtherModifiers && e.key.toLowerCase() === "b") {
				detachArmed = true;
				return false; // swallow — wait to see what follows
			}
			if (detachArmed) {
				detachArmed = false;
				if (!e.ctrlKey && noOtherModifiers && e.key.toLowerCase() === "d") {
					terminal.blur();
					onDetachRef.current?.();
					return false; // swallow the 'd' too
				}
				// Not the detach key — forward the swallowed Ctrl-B byte, then
				// let xterm process this key normally.
				connectionRef.current?.send({ type: "input", data: "\x02" });
				return true;
			}
			return true;
		});

		// GPU-accelerated rendering. This is the single biggest fluidity win for
		// busy sessions (streaming agent output) — it pushes glyph rasterization
		// to the GPU instead of the DOM/canvas2d renderer. Must load AFTER
		// terminal.open() so a rendering surface exists. If the browser can't
		// give us a WebGL context (or loses it later — GPU reset, tab
		// backgrounding on some drivers), we dispose the addon and xterm falls
		// back to its default DOM renderer automatically.
		// Deferred to the next frame so it doesn't race xterm's post-open
		// viewport sync (the pattern Superset uses); loading it synchronously
		// here can fight the initial layout/fit. The disposed guard + cancel in
		// cleanup keep a fast unmount from loading WebGL into a dead terminal.
		let webglAddon: WebglAddon | null = null;
		let webglDisposed = false;
		const webglRafId = requestAnimationFrame(() => {
			if (webglDisposed) return;
			try {
				webglAddon = new WebglAddon();
				webglAddon.onContextLoss(() => {
					webglAddon?.dispose();
					webglAddon = null;
				});
				terminal.loadAddon(webglAddon);
			} catch {
				// WebGL unavailable (headless, blocklisted GPU, etc.) — DOM renderer.
				webglAddon = null;
			}
		});

		try {
			fitAddon.fit();
		} catch {
			// container may not be sized yet
		}

		const sendResize = () => {
			connectionRef.current?.send({
				type: "resize",
				cols: terminal.cols,
				rows: terminal.rows,
			});
		};

		const refit = () => {
			try {
				fitAddon.fit();
			} catch {
				return;
			}
			if (resizeTimer !== null) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(sendResize, 150);
		};

		const connection = createTerminalConnection(
			{ workspaceId, terminalId },
			{
				onBinary: (bytes) => terminal.write(bytes),
				onControl: (message) => {
					switch (message.type) {
						case "attached":
							setErrorMessage(null);
							setState("open");
							sendResize();
							return;
						case "exit":
							terminal.write(`\r\n\x1b[33m[process exited code=${message.exitCode}]\x1b[0m\r\n`);
							setState("exited");
							return;
						case "error":
							setErrorMessage(message.message);
							setState("error");
							return;
						default:
							return;
					}
				},
				onStateChange: (next) => setState(next),
			},
		);
		connectionRef.current = connection;

		terminal.onData((data) => {
			connectionRef.current?.send({ type: "input", data });
		});

		const resizeObserver = new ResizeObserver(refit);
		resizeObserver.observe(container);
		visualViewport?.addEventListener("resize", refit);
		visualViewport?.addEventListener("scroll", refit);

		return () => {
			if (resizeTimer !== null) clearTimeout(resizeTimer);
			resizeObserver.disconnect();
			visualViewport?.removeEventListener("resize", refit);
			visualViewport?.removeEventListener("scroll", refit);
			connection.dispose();
			connectionRef.current = null;
			terminalRef.current = null;
			webglDisposed = true;
			cancelAnimationFrame(webglRafId);
			webglAddon?.dispose();
			terminal.dispose();
		};
		// autoFocus is intentionally read once at mount (a new terminal/
		// workspaceId), not treated as a live/reactive prop — it must never
		// re-run this whole effect (tearing down and reconnecting the PTY
		// session) just because a later render's autoFocus value changed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workspaceId, terminalId]);

	return (
		<div className="flex h-full flex-col">
			<div className="relative flex-1 overflow-hidden">
				<div ref={containerRef} className="absolute inset-0" />
				{state !== "open" && (
					<div
						className="absolute inset-x-0 top-0 px-3 py-1 text-xs"
						style={{ color: TERMINAL_THEME.brightYellow }}
					>
						{state === "connecting"
							? "Connecting…"
							: state === "reconnecting"
								? "Reconnecting…"
								: state === "exited"
									? "Process exited."
									: (errorMessage ?? "Disconnected.")}
					</div>
				)}
			</div>
		</div>
	);
});
