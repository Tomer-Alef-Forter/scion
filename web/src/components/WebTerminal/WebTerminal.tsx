// Lifted from Superset's real web terminal:
// apps/web/src/app/workspaces/[workspaceId]/components/WebTerminal/WebTerminal.tsx
// See NOTICE.md for attribution. Dropped `MobileTerminalInput` (mobile-only,
// not needed for a local desktop tool); everything else — xterm setup, theme,
// fit/resize handling, connection wiring — is unchanged.
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { TerminalConnection } from "../../lib/TerminalConnection";

const TERMINAL_THEME: ITheme = {
	background: "#151110",
	foreground: "#eae8e6",
	cursor: "#e07850",
	cursorAccent: "#151110",
	selectionBackground: "rgba(224, 120, 80, 0.25)",
	black: "#151110",
	red: "#dc6b6b",
	green: "#7ec699",
	yellow: "#e5c07b",
	blue: "#61afef",
	magenta: "#c678dd",
	cyan: "#56b6c2",
	white: "#eae8e6",
	brightBlack: "#5c5856",
	brightRed: "#e88888",
	brightGreen: "#98d1a8",
	brightYellow: "#ecd08f",
	brightBlue: "#7ec0f5",
	brightMagenta: "#d494e6",
	brightCyan: "#73c7d3",
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

	useImperativeHandle(ref, () => ({
		focus: () => terminalRef.current?.focus(),
	}), []);

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
			// Scroll tuning. scrollSensitivity is a direct, uncapped multiplier
			// on scroll-pixels-per-trackpad-pixel (trackpad gestures bypass
			// animation entirely, so this is the only speed knob for that
			// path) — pushed very high (8x the prior 24/60 tuning) per request.
			// NOTE: past a point this trades control for speed — a tiny
			// gesture can blow through most of the scrollback. If it overshoots
			// or feels twitchy, say so and we'll dial back rather than revert
			// to nothing. smoothScrollDuration only affects real physical
			// mouse-wheel input (trackpad is already instant), left at the
			// sane-range ceiling.
			smoothScrollDuration: 150,
			scrollSensitivity: 192,
			fastScrollSensitivity: 480,
			theme: TERMINAL_THEME,
			allowProposedApi: true,
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
		let webglAddon: WebglAddon | null = null;
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

		const connection = new TerminalConnection(
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
							terminal.write(
								`\r\n\x1b[33m[process exited code=${message.exitCode}]\x1b[0m\r\n`,
							);
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
		connection.start();

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
						style={{ color: "#ecd08f" }}
					>
						{state === "connecting"
							? "Connecting…"
							: state === "reconnecting"
								? "Reconnecting…"
								: state === "exited"
									? "Process exited."
									: errorMessage ?? "Disconnected."}
					</div>
				)}
			</div>
		</div>
	);
});
