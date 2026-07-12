// Shared guard for every global (document-level) keyboard shortcut listener.
// A shortcut must never fire while the user is typing into a real input, or
// while the terminal (a real xterm.js instance forwarding every keystroke to
// the agent process) has focus — otherwise e.g. Ctrl+K would steal bash's
// default "kill to end of line" readline binding right out of a live agent
// session.
export function isTypingTarget(e: KeyboardEvent): boolean {
	const el = e.target;
	if (!(el instanceof HTMLElement)) return false;
	if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) {
		return true;
	}
	// xterm.js wraps everything it renders in a root `.xterm` container —
	// true regardless of which specific inner node (helper textarea, viewport,
	// a row span) actually received the event.
	return el.closest(".xterm") !== null;
}
